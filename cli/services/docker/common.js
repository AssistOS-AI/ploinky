import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { REPOS_DIR, PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from '../config.js';
import { getAgentWorkDir } from '../workspaceStructure.js';
import { buildEnvFlags, buildEnvMap } from '../secretVars.js';
import { loadAgents, saveAgents } from '../workspace.js';
import { debugLog } from '../utils.js';
import { isHostSandboxDisabled } from '../sandboxRuntime.js';
import { parseManifestOpenPortSpec } from '../../../container/publish-spec.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLOINKY_BOX_MARKER_PATH = '/etc/ploinky-box';
const OUTER_PUBLICATION_CONTRACT_ENV = 'PLOINKY_OUTER_PUBLICATION_CONTRACT';
const OUTER_PUBLICATION_CONTRACT_SCHEMA_VERSION = 2;
const MAX_OUTER_PUBLICATION_CONTRACT_BYTES = 256 * 1024;
const PLOINKY_MANAGED_LABEL = 'io.assistos.ploinky.managed=1';

function isPloinkyBoxRuntime(markerPath = process.env.PLOINKY_BOX_MARKER_PATH || PLOINKY_BOX_MARKER_PATH) {
    try {
        return fs.statSync(markerPath).isFile();
    } catch (_) {
        return false;
    }
}

function isLoopbackBindHost(hostIp) {
    const normalized = String(hostIp || '').trim().toLowerCase();
    return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function runtimePublishHostIp(hostIp, options = {}) {
    const markerPath = options.boxMarkerPath || PLOINKY_BOX_MARKER_PATH;
    const inBoxRuntime = options.boxRuntime === true || isPloinkyBoxRuntime(markerPath);
    if (inBoxRuntime && isLoopbackBindHost(hostIp)) {
        return '0.0.0.0';
    }
    return hostIp;
}

function isPathUnderRoot(candidate) {
    if (!candidate) return false;
    const root = path.resolve(PLOINKY_WORKSPACE_ROOT);
    const resolved = path.resolve(candidate);
    const relative = path.relative(root, resolved);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeProjectPath(candidate, runMode) {
    if (!candidate || typeof candidate !== 'string') return '';
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved)) return '';
    if (runMode === 'isolated' && !isPathUnderRoot(resolved)) {
        return '';
    }
    return resolved;
}

function getConfiguredProjectPath(agentName, repoName, alias) {
    if (!agentName || agentName === '.') {
        return PLOINKY_WORKSPACE_ROOT;
    }
    try {
        const map = loadAgentsMap();
        const staticAgent = typeof map?._config?.static?.agent === 'string'
            ? map._config.static.agent.trim()
            : '';
        if (staticAgent && staticAgent === agentName) {
            return PLOINKY_WORKSPACE_ROOT;
        }
        if (alias) {
            const aliasRec = Object.values(map || {}).find(r => r && r.type === 'agent' && r.alias === alias);
            if (aliasRec && (aliasRec.runMode || 'isolated') === 'isolated') {
                const isolatedPath = getAgentWorkDir(alias);
                try { fs.mkdirSync(isolatedPath, { recursive: true }); } catch (_) {}
                return isolatedPath;
            }
            if (aliasRec && aliasRec.projectPath && typeof aliasRec.projectPath === 'string') {
                const normalized = normalizeProjectPath(aliasRec.projectPath, aliasRec.runMode);
                if (normalized) return normalized;
            }
        }
        const rec = Object.values(map || {}).find(r => r && r.type === 'agent' && r.agentName === agentName && r.repoName === repoName);
        if (rec && (rec.runMode || 'isolated') === 'isolated') {
            const isolatedPath = getAgentWorkDir(rec.alias || agentName);
            try { fs.mkdirSync(isolatedPath, { recursive: true }); } catch (_) {}
            return isolatedPath;
        }
        if (rec && rec.projectPath && typeof rec.projectPath === 'string') {
            const normalized = normalizeProjectPath(rec.projectPath, rec.runMode);
            if (normalized) return normalized;
        }
    } catch (_) {}
    const fallback = getAgentWorkDir(agentName);
    try { fs.mkdirSync(fallback, { recursive: true }); } catch (_) {}
    return fallback;
}

function isRuntimeInstalled(runtime) {
    try {
        execSync(`command -v ${runtime}`, { stdio: 'ignore' });
        return true;
    } catch (_) {
        return false;
    }
}

let containerRuntime = null;

function probeContainerRuntime() {
    if (isPloinkyBoxRuntime()) {
        if (isRuntimeInstalled('podman')) {
            containerRuntime = 'podman';
            return containerRuntime;
        }
        containerRuntime = null;
        return null;
    }
    if (containerRuntime) return containerRuntime;
    for (const candidate of ['podman', 'docker']) {
        if (isRuntimeInstalled(candidate)) {
            debugLog(`Using ${candidate} as container runtime.`);
            containerRuntime = candidate;
            return candidate;
        }
    }
    return null;
}

function requireContainerRuntime() {
    const rt = probeContainerRuntime();
    if (!rt) {
        if (isPloinkyBoxRuntime()) {
            const error = new Error('Ploinky box requires nested Podman, but podman was not found in PATH. Docker fallback is not permitted inside the box.');
            error.code = 'PLOINKY_BOX_PODMAN_REQUIRED';
            throw error;
        }
        console.error('Neither podman nor docker found in PATH. Please install one of them.');
        process.exit(1);
    }
    return rt;
}

const DEFAULT_IMAGE_PULL_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_IMAGE_BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const LOCAL_IMAGE_BUILD_DEFINITIONS = {
    'docker.io/assistos/web-publishing-agent:node24-nginx-cloudflared': {
        repoName: 'container-image-builds',
        context: 'images/web-publishing-agent',
    },
};

function imagePullTimeoutMs() {
    const raw = Number(process.env.PLOINKY_IMAGE_PULL_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IMAGE_PULL_TIMEOUT_MS;
}

function imageBuildTimeoutMs() {
    const raw = Number(process.env.PLOINKY_IMAGE_BUILD_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IMAGE_BUILD_TIMEOUT_MS;
}

function imageExists(image, runtime) {
    const rt = runtime || getRuntime();
    const img = String(image || '').trim();
    if (!img) return false;
    const res = spawnSync(rt, ['image', 'inspect', img], { stdio: 'ignore' });
    return res.status === 0;
}

function getImageSizeBytes(image, runtime) {
    const rt = runtime || getRuntime();
    const res = spawnSync(rt, ['image', 'inspect', image, '--format', '{{.Size}}'], {
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status !== 0) return 0;
    const n = Number(String(res.stdout || '').trim());
    return Number.isFinite(n) ? n : 0;
}

// Pull a container image as an explicit step, streaming the runtime's native
// progress (per-layer bars + download rate) straight to the terminal. Uses a
// generous, env-overridable timeout (PLOINKY_IMAGE_PULL_TIMEOUT_MS) because a
// large image on a throttled link can legitimately take many minutes — the live
// progress keeps the wait visible instead of looking frozen.
function pullImage(image, options = {}) {
    const rt = options.runtime || getRuntime();
    const img = String(image || '').trim();
    if (!img) throw new Error('pullImage: image is required');
    const log = typeof options.log === 'function' ? options.log : ((msg) => console.log(msg));
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : imagePullTimeoutMs();
    log(`[pull] ${rt} pull ${img} (timeout ${Math.round(timeoutMs / 1000)}s)`);
    const startedAt = Date.now();
    const res = spawnSync(rt, ['pull', img], { stdio: ['ignore', 'inherit', 'inherit'], timeout: timeoutMs });
    const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    if (res.error) {
        if (res.error.code === 'ETIMEDOUT') {
            throw new Error(`Image pull for '${img}' timed out after ${Math.round(timeoutMs / 1000)}s. `
                + `Increase PLOINKY_IMAGE_PULL_TIMEOUT_MS or pre-pull it: '${rt} pull ${img}'.`);
        }
        throw new Error(`Image pull for '${img}' failed: ${res.error.message}`);
    }
    if (res.status !== 0) {
        throw new Error(`Image pull for '${img}' exited with code ${res.status}.`);
    }
    const bytes = getImageSizeBytes(img, rt);
    if (bytes > 0) {
        const mb = bytes / (1024 * 1024);
        log(`[pull] ${img} ready — ${(mb / 1024).toFixed(2)} GB unpacked in ${elapsedSec}s `
            + `(avg ${(mb / elapsedSec).toFixed(1)} MB/s)`);
    } else {
        log(`[pull] ${img} ready in ${elapsedSec}s`);
    }
}

function resolveLocalImageBuildSource(image, options = {}) {
    const img = String(image || '').trim();
    const definition = LOCAL_IMAGE_BUILD_DEFINITIONS[img];
    if (!definition) return null;
    const reposDir = options.reposDir || REPOS_DIR;
    const contextPath = path.join(reposDir, definition.repoName, definition.context);
    const dockerfilePath = path.join(contextPath, definition.dockerfile || 'Dockerfile');
    if (!fs.existsSync(dockerfilePath)) return null;
    return {
        ...definition,
        image: img,
        contextPath,
        dockerfilePath,
    };
}

function buildLocalImage(image, options = {}) {
    const rt = options.runtime || getRuntime();
    const img = String(image || '').trim();
    if (!img) throw new Error('buildLocalImage: image is required');
    const source = options.source || resolveLocalImageBuildSource(img, options);
    if (!source) return false;
    const log = typeof options.log === 'function' ? options.log : ((msg) => console.log(msg));
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : imageBuildTimeoutMs();
    log(`[build] ${rt} build -t ${img} ${source.contextPath} (timeout ${Math.round(timeoutMs / 1000)}s)`);
    const startedAt = Date.now();
    const res = spawnSync(rt, ['build', '-t', img, source.contextPath], {
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: timeoutMs,
    });
    const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    if (res.error) {
        if (res.error.code === 'ETIMEDOUT') {
            throw new Error(`Image build for '${img}' timed out after ${Math.round(timeoutMs / 1000)}s. `
                + 'Increase PLOINKY_IMAGE_BUILD_TIMEOUT_MS or pre-build it.');
        }
        throw new Error(`Image build for '${img}' failed: ${res.error.message}`);
    }
    if (res.status !== 0) {
        throw new Error(`Image build for '${img}' exited with code ${res.status}.`);
    }
    log(`[build] ${img} ready from ${source.repoName}/${source.context} in ${elapsedSec}s`);
    return true;
}

// Ensure an image is present locally, pulling it (with streamed progress) only
// when missing. Returns true if a pull happened, false if it was already cached.
function ensureImagePresent(image, options = {}) {
    const rt = options.runtime || getRuntime();
    const img = String(image || '').trim();
    if (!img) throw new Error('ensureImagePresent: image is required');
    if (imageExists(img, rt)) return false;
    const log = typeof options.log === 'function' ? options.log : ((msg) => console.log(msg));
    log(`[pull] image '${img}' not present locally — pulling before runtime probe...`);
    try {
        pullImage(img, { runtime: rt, log, timeoutMs: options.pullTimeoutMs });
    } catch (pullError) {
        const source = resolveLocalImageBuildSource(img, options);
        if (!source) throw pullError;
        log(`[pull] ${img} could not be pulled (${pullError.message}); building from ${source.repoName}/${source.context}...`);
        try {
            buildLocalImage(img, {
                ...options,
                runtime: rt,
                log,
                source,
                timeoutMs: options.buildTimeoutMs,
            });
        } catch (buildError) {
            throw new Error(
                `Image pull for '${img}' failed and local build fallback failed: ${buildError.message} `
                + `Original pull error: ${pullError.message}`
            );
        }
    }
    return true;
}

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const CONTAINER_CONFIG_DIR = '/code';
const CONTAINER_CONFIG_PATH = `${CONTAINER_CONFIG_DIR}/mcp-config.json`;

function loadAgentsMap() {
    return loadAgents();
}

function saveAgentsMap(map) {
    return saveAgents(map);
}

function getAgentContainerName(agentName, repoName) {
    const safeAgentName = String(agentName || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const safeRepoName = String(repoName || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const cwdHash = crypto.createHash('sha256')
        .update(PLOINKY_WORKSPACE_ROOT)
        .digest('hex')
        .substring(0, 8);
    const projectDir = path.basename(PLOINKY_WORKSPACE_ROOT).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const containerName = `ploinky_${safeRepoName}_${safeAgentName}_${projectDir}_${cwdHash}`;
    debugLog(`Calculated container name: ${containerName} (for path: ${PLOINKY_WORKSPACE_ROOT})`);
    return containerName;
}

function isContainerRunning(containerName) {
    const runtime = probeContainerRuntime();
    if (!runtime) return false;
    const command = `${runtime} ps --format "{{.Names}}" | grep -x "${containerName}"`;
    debugLog(`Checking if container is running with command: ${command}`);
    try {
        const result = execSync(command, { stdio: 'pipe' }).toString();
        const running = result.trim().length > 0;
        debugLog(`Container '${containerName}' is running: ${running}`);
        return running;
    } catch (error) {
        debugLog(`Container '${containerName}' is not running (grep failed)`);
        return false;
    }
}

function containerExists(containerName) {
    // Use inspect instead of grep - more reliable and avoids race conditions
    const runtime = probeContainerRuntime();
    if (!runtime) return false;
    const command = `${runtime} inspect --format "{{.Name}}" "${containerName}"`;
    debugLog(`Checking if container exists with command: ${command}`);
    try {
        execSync(command, { stdio: 'pipe' });
        debugLog(`Container '${containerName}' exists: true`);
        return true;
    } catch (error) {
        debugLog(`Container '${containerName}' does not exist`);
        return false;
    }
}

function getSecretsForAgent(manifest, options = {}) {
    const vars = buildEnvFlags(manifest, null, {
        agentName: options.agentName,
        repoName: options.repoName,
        forRuntime: true,
    });
    debugLog(`Formatted env vars for ${probeContainerRuntime() || 'container'} command: ${vars.join(' ')}`);
    return vars;
}

function getAgentMcpConfigPath(agentPath) {
    const candidate = path.join(agentPath, 'mcp-config.json');
    try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    } catch (_) {}
    return null;
}

function syncAgentMcpConfig(_containerName, agentPath, agentName, options = {}) {
    try {
        const source = getAgentMcpConfigPath(agentPath);
        if (!source) return false;
        const resolvedAgentName = agentName || path.basename(agentPath || '');
        if (!resolvedAgentName) return false;
        const workDir = options.workDir || getAgentWorkDir(resolvedAgentName);
        if (!fs.existsSync(workDir)) {
            fs.mkdirSync(workDir, { recursive: true });
        }
        const target = path.join(workDir, 'mcp-config.json');
        fs.copyFileSync(source, target);
        return true;
    } catch (_) {
        return false;
    }
}

function flagsToArgs(flags) {
    const out = [];
    for (const flag of flags || []) {
        if (!flag) continue;
        const str = String(flag);
        let current = '';
        let quote = null;
        for (let i = 0; i < str.length; i += 1) {
            const ch = str[i];
            if (quote) {
                if (ch === quote) {
                    quote = null;
                    continue;
                }
                if (ch === '\\' && quote === '"' && i + 1 < str.length) {
                    const next = str[i + 1];
                    if (next === 'n') {
                        current += '\n';
                        i += 1;
                        continue;
                    }
                    if (/["\\$`]/.test(next)) {
                        current += next;
                        i += 1;
                        continue;
                    }
                }
                current += ch;
                continue;
            }
            if (ch === '"' || ch === '\'') {
                quote = ch;
                continue;
            }
            if (/\s/.test(ch)) {
                if (current) {
                    out.push(current);
                    current = '';
                }
                continue;
            }
            current += ch;
        }
        if (current) {
            out.push(current);
        }
    }
    return out;
}

function sleepMs(ms) {
    Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function parseManifestPorts(manifest, profileConfig = null, options = {}) {
    if (manifest && Object.prototype.hasOwnProperty.call(manifest, 'ports')) {
        throw new Error("manifest field 'ports' was renamed to profile field 'openPorts'");
    }
    if (profileConfig && Object.prototype.hasOwnProperty.call(profileConfig, 'ports')) {
        throw new Error("profile field 'ports' is unsupported; use 'openPorts'");
    }
    // Open ports must be defined in profile configuration.
    const ports = profileConfig?.openPorts;
    if (!ports) return { publishArgs: [], portMappings: [] };

    const portArray = Array.isArray(ports) ? ports : [ports];
    const publishArgs = [];
    const portMappings = [];

    for (const p of portArray) {
        if (!p) continue;
        const portSpec = String(p).trim();
        if (!portSpec) continue;

        const parsed = parseManifestOpenPortSpec(portSpec);
        const publishHostIp = runtimePublishHostIp(parsed.hostIp, options);
        const protocolSuffix = parsed.protocol === 'tcp' ? '' : `/${parsed.protocol}`;
        const normalized = `${publishHostIp}:${formatPortRange(parsed.boxSide)}:${formatPortRange(parsed.privateContainer)}${protocolSuffix}`;
        publishArgs.push(normalized);
        for (let offset = 0; offset < parsed.boxSide.length; offset += 1) {
            portMappings.push({
                hostPort: parsed.boxSide.start + offset,
                containerPort: parsed.privateContainer.start + offset,
                hostIp: publishHostIp,
                protocol: parsed.protocol,
            });
        }
    }

    return { publishArgs, portMappings };
}

function managedContainerLabelArgs() {
    return ['--label', PLOINKY_MANAGED_LABEL];
}

function parseOuterPublicationContract(rawContract = process.env[OUTER_PUBLICATION_CONTRACT_ENV]) {
    if (rawContract && typeof rawContract === 'object' && !Array.isArray(rawContract)) {
        return validateOuterPublicationContract(rawContract);
    }
    const raw = String(rawContract || '');
    if (!raw) {
        throw outerPublicationError(`missing ${OUTER_PUBLICATION_CONTRACT_ENV}`);
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_OUTER_PUBLICATION_CONTRACT_BYTES) {
        throw outerPublicationError(`${OUTER_PUBLICATION_CONTRACT_ENV} exceeds ${MAX_OUTER_PUBLICATION_CONTRACT_BYTES} bytes`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw outerPublicationError(`${OUTER_PUBLICATION_CONTRACT_ENV} is not valid JSON: ${error.message}`);
    }
    return validateOuterPublicationContract(parsed);
}

function validateOuterPublicationContract(contract) {
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
        throw outerPublicationError('outer publication contract must be an object');
    }
    const allowed = new Set(['schemaVersion', 'targets', 'publishes']);
    for (const key of Object.keys(contract)) {
        if (!allowed.has(key)) throw outerPublicationError(`unsupported outer publication contract field '${key}'`);
    }
    if (contract.schemaVersion !== OUTER_PUBLICATION_CONTRACT_SCHEMA_VERSION) {
        throw outerPublicationError(`unsupported outer publication contract schemaVersion '${contract.schemaVersion}'`);
    }
    if (!Array.isArray(contract.targets) || contract.targets.length > 4096) {
        throw outerPublicationError('outer publication contract targets must be an array with at most 4096 entries');
    }
    if (contract.publishes !== undefined && (
        !Array.isArray(contract.publishes)
        || contract.publishes.length > 4096
        || contract.publishes.some((entry) => typeof entry !== 'string')
    )) {
        throw outerPublicationError('outer publication contract publishes must be an array of strings');
    }
    const byProtocol = { tcp: [], udp: [] };
    for (let index = 0; index < contract.targets.length; index += 1) {
        const target = contract.targets[index];
        if (!target || typeof target !== 'object' || Array.isArray(target)) {
            throw outerPublicationError(`outer publication target ${index} must be an object`);
        }
        const keys = Object.keys(target);
        if (keys.some((key) => !['start', 'end', 'protocol'].includes(key))) {
            throw outerPublicationError(`outer publication target ${index} has unsupported fields`);
        }
        const start = Number(target.start);
        const end = Number(target.end);
        const protocol = String(target.protocol || '').trim().toLowerCase();
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > 65535) {
            throw outerPublicationError(`outer publication target ${index} has an invalid interval`);
        }
        if (!['tcp', 'udp'].includes(protocol)) {
            throw outerPublicationError(`outer publication target ${index} has unsupported protocol '${target.protocol}'`);
        }
        byProtocol[protocol].push({ start, end });
    }
    return {
        schemaVersion: OUTER_PUBLICATION_CONTRACT_SCHEMA_VERSION,
        targets: [
            ...mergeCoverageIntervals(byProtocol.tcp).map((entry) => ({ ...entry, protocol: 'tcp' })),
            ...mergeCoverageIntervals(byProtocol.udp).map((entry) => ({ ...entry, protocol: 'udp' })),
        ],
        publishes: (contract.publishes || []).map((entry) => String(entry)),
    };
}

function assertOuterPublicationCoverageForClaims(claims, options = {}) {
    const inBox = options.boxRuntime === true
        || (options.boxRuntime !== false && isPloinkyBoxRuntime(options.markerPath));
    if (!inBox) return { enforced: false, covered: true, targets: [] };
    const contract = parseOuterPublicationContract(options.contract);
    const missing = [];
    for (const claim of claims || []) {
        const interval = claim?.boxSide || claim?.targetInterval;
        const protocol = String(claim?.protocol || '').trim().toLowerCase();
        if (!interval || !['tcp', 'udp'].includes(protocol)) {
            throw outerPublicationError('required publication claim is malformed');
        }
        const available = contract.targets.filter((target) => target.protocol === protocol);
        if (!intervalCovered(interval, available)) {
            missing.push({
                start: interval.start,
                end: interval.end,
                protocol,
                ownerRef: claim.ownerRef || claim.agentRef || '',
                raw: claim.raw || '',
            });
        }
    }
    if (missing.length) {
        const targets = missing.map((entry) => `${formatPortRange(entry)}/${entry.protocol}`).join(', ');
        const hint = String(options.commandHint || 'ploinky start').trim();
        const error = outerPublicationError(
            `outer Ploinky box does not publish required socket coverage: ${targets}. `
            + `Run this one-shot command from the host so the box can be reconciled first: ${hint}`,
        );
        error.missingTargets = missing;
        error.contract = contract;
        throw error;
    }
    return { enforced: true, covered: true, targets: contract.targets };
}

function assertOuterPublicationCoverageForManifest(manifest, profileConfig = null, options = {}) {
    const ports = profileConfig?.openPorts;
    const values = ports === undefined || ports === null ? [] : (Array.isArray(ports) ? ports : [ports]);
    const claims = values.map((entry) => {
        const parsed = parseManifestOpenPortSpec(entry);
        return {
            ...parsed,
            boxSide: options.networkMode === 'host'
                ? { ...parsed.privateContainer }
                : parsed.boxSide,
            networkMode: options.networkMode || 'default',
            ownerRef: options.ownerRef || '',
        };
    });
    return assertOuterPublicationCoverageForClaims(claims, options);
}

function intervalCovered(interval, available) {
    const merged = mergeCoverageIntervals(available);
    return merged.some((entry) => entry.start <= interval.start && entry.end >= interval.end);
}

function mergeCoverageIntervals(intervals) {
    const sorted = intervals
        .map((entry) => ({ start: entry.start, end: entry.end }))
        .sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const interval of sorted) {
        const previous = merged.at(-1);
        if (!previous || interval.start > previous.end + 1) merged.push({ ...interval });
        else previous.end = Math.max(previous.end, interval.end);
    }
    return merged;
}

function outerPublicationError(message) {
    const error = new Error(message);
    error.code = 'PLOINKY_OUTER_PUBLICATION_REQUIRED';
    return error;
}

function formatPortRange(range) {
    if (!range) return '';
    return range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
}

function parseHostPort(output) {
    try {
        if (!output) return 0;
        const firstLine = String(output).split(/\n+/)[0].trim();
        const match = firstLine.match(/(\d+)\s*$/);
        return match ? parseInt(match[1], 10) : 0;
    } catch (_) {
        return 0;
    }
}

function hasOwnObject(target, key) {
    return Boolean(
        target
        && Object.prototype.hasOwnProperty.call(target, key)
        && target[key]
        && typeof target[key] === 'object'
        && !Array.isArray(target[key])
    );
}

function normalizeHashValue(value) {
    if (typeof value === 'string') {
        return value.trim();
    }
    if (Array.isArray(value)) {
        return value.map((entry) => normalizeHashValue(entry));
    }
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((acc, key) => {
            acc[key] = normalizeHashValue(value[key]);
            return acc;
        }, {});
    }
    return value;
}

function resolveNetworkConfigForHash(manifest, profileConfig) {
    if (hasOwnObject(profileConfig, 'network')) {
        return normalizeHashValue(profileConfig.network);
    }
    if (hasOwnObject(manifest, 'network')) {
        return normalizeHashValue(manifest.network);
    }
    return null;
}

function computeEnvHash(manifest, profileConfig, extraEnv = {}, options = {}) {
    try {
        const map = {
            ...buildEnvMap(manifest, profileConfig || null, {
                agentName: options.agentName,
                repoName: options.repoName,
            }),
            ...(extraEnv && typeof extraEnv === 'object' && !Array.isArray(extraEnv) ? extraEnv : {}),
        };
        const network = resolveNetworkConfigForHash(manifest, profileConfig || null);
        const sorted = Object.keys(map).sort().reduce((acc, key) => {
            acc[key] = map[key];
            return acc;
        }, {});
        const data = network === null
            ? JSON.stringify(sorted)
            : JSON.stringify({ env: sorted, network });
        return crypto.createHash('sha256').update(data).digest('hex');
    } catch (_) {
        return '';
    }
}

function getContainerLabel(containerName, key) {
    try {
        const runtime = probeContainerRuntime();
        if (!runtime) return '';
        const out = execSync(`${runtime} inspect ${containerName} --format '{{ json .Config.Labels }}'`, { stdio: 'pipe' }).toString();
        const labels = JSON.parse(out || '{}') || {};
        return labels[key] || '';
    } catch (_) {
        return '';
    }
}

function waitForContainerRunning(containerName, maxAttempts = 20, delayMs = 250) {
    const runtime = requireContainerRuntime();
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            const status = execSync(`${runtime} inspect ${containerName} --format '{{ .State.Status }}'`, { stdio: 'pipe' })
                .toString()
                .trim()
                .toLowerCase();
            if (status === 'running') {
                return true;
            }
        } catch (_) {}
        sleepMs(delayMs);
    }
    return false;
}

function isSandboxRuntime(runtime) {
    return runtime === 'bwrap' || runtime === 'seatbelt';
}

function runtimeFamilyName(runtime) {
    if (runtime === 'bwrap' || runtime === 'seatbelt') return runtime;
    if (runtime === 'docker' || runtime === 'podman') return 'container';
    return runtime || 'unknown';
}

export {
    CONTAINER_CONFIG_DIR,
    CONTAINER_CONFIG_PATH,
    MAX_OUTER_PUBLICATION_CONTRACT_BYTES,
    OUTER_PUBLICATION_CONTRACT_ENV,
    OUTER_PUBLICATION_CONTRACT_SCHEMA_VERSION,
    PLOINKY_MANAGED_LABEL,
    PLOINKY_DIR,
    REPOS_DIR,
    containerRuntime,
    containerExists,
    buildLocalImage,
    ensureImagePresent,
    imageExists,
    pullImage,
    resolveLocalImageBuildSource,
    computeEnvHash,
    getAgentContainerName,
    getAgentMcpConfigPath,
    getConfiguredProjectPath,
    getContainerLabel,
    getRuntime,
    getSecretsForAgent,
    getHostSandboxDisableHint,
    getHostSandboxInstallHint,
    isContainerRunning,
    isPloinkyBoxRuntime,
    isSandboxRuntime,
    probeContainerRuntime,
    runtimeFamilyName,
    loadAgentsMap,
    parseHostPort,
    parseManifestPorts,
    parseOuterPublicationContract,
    saveAgentsMap,
    syncAgentMcpConfig,
    waitForContainerRunning,
    flagsToArgs,
    sleepMs,
    createHostSandboxError,
    createHostSandboxStartupError,
    getRuntimeForAgent,
    managedContainerLabelArgs,
    assertOuterPublicationCoverageForClaims,
    assertOuterPublicationCoverageForManifest,
    validateOuterPublicationContract,
};

function getRuntime() {
    return requireContainerRuntime();
}

function getHostSandboxInstallHint() {
    if (process.platform === 'darwin') {
        return 'macOS lite sandbox requires Seatbelt via sandbox-exec. Check `command -v sandbox-exec`.';
    }
    if (process.platform === 'linux') {
        return 'Linux lite sandbox requires bubblewrap. Install the `bwrap`/`bubblewrap` package and check `command -v bwrap`.';
    }
    return `Host lite sandbox only supports macOS Seatbelt and Linux bubblewrap; current platform is ${process.platform}.`;
}

function getHostSandboxDisableHint() {
    return 'To test the same agent with podman/docker instead, run `ploinky sandbox disable`, then restart or reinstall the running agents.';
}

function createHostSandboxError(reason) {
    const message = [
        `lite-sandbox: true requested, but ${reason}.`,
        getHostSandboxInstallHint(),
        getHostSandboxDisableHint(),
    ].join('\n');
    const error = new Error(message);
    error.code = 'PLOINKY_HOST_SANDBOX_UNAVAILABLE';
    return error;
}

function createHostSandboxStartupError(agentName, runtime, cause) {
    const detail = cause?.message || String(cause || 'unknown error');
    const message = [
        `[${runtime}] ${agentName}: lite-sandbox startup failed: ${detail}`,
        getHostSandboxInstallHint(),
        getHostSandboxDisableHint(),
    ].join('\n');
    const error = new Error(message);
    error.code = 'PLOINKY_HOST_SANDBOX_START_FAILED';
    error.cause = cause;
    return error;
}

function createLegacyRuntimeStringError(runtimeValue) {
    const message = [
        `manifest.runtime: ${JSON.stringify(runtimeValue)} is no longer supported as an execution backend selector.`,
        'Use `lite-sandbox: true` to request the host sandbox for macOS/Linux.',
        getHostSandboxDisableHint(),
    ].join('\n');
    const error = new Error(message);
    error.code = 'PLOINKY_LEGACY_RUNTIME_SELECTOR';
    return error;
}

function getRuntimeForAgent(manifest) {
    if (isPloinkyBoxRuntime()) {
        return requireContainerRuntime();
    }
    if (typeof manifest?.runtime === 'string') {
        throw createLegacyRuntimeStringError(manifest.runtime);
    }
    if (manifest?.['lite-sandbox'] === true) {
        if (isHostSandboxDisabled()) {
            return requireContainerRuntime();
        }

        // lite-sandbox: true — auto-detect platform.
        if (process.platform === 'darwin') {
            try {
                execSync('command -v sandbox-exec', { stdio: 'ignore' });
                return 'seatbelt';
            } catch {
                throw createHostSandboxError('sandbox-exec was not found or is not executable');
            }
        }
        if (process.platform === 'linux') {
            try {
                execSync('command -v bwrap', { stdio: 'ignore' });
                return 'bwrap';
            } catch {
                throw createHostSandboxError('bwrap was not found or is not executable');
            }
        }
        throw createHostSandboxError(`platform ${process.platform} is not supported`);
    }
    return requireContainerRuntime();
}
