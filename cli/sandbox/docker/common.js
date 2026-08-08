import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { REPOS_DIR, PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import { getAgentWorkDir } from '../../utils/workspaceStructure.js';
import { buildEnvFlags, buildEnvMap } from '../../utils/security/secretVars.js';
import { loadAgents, saveAgents } from '../../utils/workspace.js';
import { debugLog } from '../../utils/utils.js';
import { isHostSandboxDisabled } from '../../utils/runtime/sandboxRuntime.js';
import { intervalsOverlap, parseManifestOpenPortSpec } from '../../../container/publish-spec.mjs';
import { isInsideBox } from '../../../ploinky-box/lib/boxMarker.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLOINKY_BOX_MARKER_PATH = '/etc/ploinky-box';
const PLOINKY_MANAGED_LABEL = 'io.assistos.ploinky.managed=1';
const CONTAINER_CONTROL_PLANE_TIMEOUT_MS = 5_000;

function isPloinkyBoxRuntime(markerPath = PLOINKY_BOX_MARKER_PATH) {
    return isInsideBox({ markerPath });
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
        if (staticAgent && (
            staticAgent === agentName
            || staticAgent === `${repoName}/${agentName}`
            || Boolean(alias && staticAgent === alias)
        )) {
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

function probeContainerRuntime(boxMarkerPath) {
    if (isPloinkyBoxRuntime(boxMarkerPath)) {
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

function requireContainerRuntime(boxMarkerPath) {
    const rt = probeContainerRuntime(boxMarkerPath);
    if (!rt) {
        if (isPloinkyBoxRuntime(boxMarkerPath)) {
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
const LOCAL_IMAGE_BUILD_DEFINITIONS = Object.freeze({});

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
        // A local build is far more expensive than a pull and is not safe to
        // run concurrently for one tag. Callers that resolve images outside the
        // serializing lock opt out and leave the build to the locked path.
        if (options.allowLocalBuild === false) throw pullError;
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

function saveAgentsMap(map, options = {}) {
    return saveAgents(map, options);
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

function isContainerRunning(containerName, options = {}) {
    const runtime = options.runtime || probeContainerRuntime();
    if (!runtime) return false;
    debugLog(`Checking if container '${containerName}' is running via ${runtime}.`);
    try {
        const running = listRunningContainerNames({
            ...options,
            runtime,
        }).has(containerName);
        debugLog(`Container '${containerName}' is running: ${running}`);
        return running;
    } catch (error) {
        debugLog(`Unable to prove container '${containerName}' is running: ${error?.message || error}`);
        return false;
    }
}

function listRunningContainerNames(options = {}) {
    const runtime = options.runtime || probeContainerRuntime();
    if (!runtime) return new Set();
    const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
    const result = spawnSyncImpl(
        runtime,
        ['ps', '--format', '{{.Names}}'],
        {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: options.timeoutMs || CONTAINER_CONTROL_PLANE_TIMEOUT_MS,
            killSignal: 'SIGKILL',
        },
    );
    if (result.error || result.status !== 0) {
        const detail = String(
            result.error?.message
            || result.stderr
            || result.stdout
            || `exit ${result.status ?? 'unknown'}`,
        ).trim();
        throw new Error(`cannot list running containers: ${detail}`);
    }
    return new Set(
        String(result.stdout || '')
            .split(/\r?\n/)
            .map((name) => name.trim().replace(/^\//, ''))
            .filter(Boolean),
    );
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
        const reserved = parsed.protocol === 'tcp'
            ? [
                { port: 8080, owner: 'public/control Router' },
                { port: 8081, owner: 'box-private Router' },
            ]
            : [{ port: 7882, owner: 'fixed media UDP mux capability' }];
        const conflict = reserved.find(({ port }) => intervalsOverlap(
            parsed.boxSide,
            { start: port, end: port },
        ));
        if (conflict) {
            const error = new Error(
                `openPorts ${parsed.protocol} box-side range ${formatPortRange(parsed.boxSide)} overlaps reserved port ${conflict.port} (${conflict.owner})`,
            );
            error.code = 'PLOINKY_RESERVED_BOX_PORT';
            throw error;
        }
        const publishHostIp = parsed.hostIp;
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

function waitForContainerRunning(containerName, maxAttempts = 20, delayMs = 250, options = {}) {
    const runtime = options.runtime || requireContainerRuntime();
    const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
    const sleepMsImpl = options.sleepMsImpl || sleepMs;
    const totalTimeoutMs = options.totalTimeoutMs
        || Math.max(1, maxAttempts * Math.max(1, delayMs));
    const deadline = Date.now() + totalTimeoutMs;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        try {
            const result = spawnSyncImpl(
                runtime,
                ['inspect', containerName, '--format', '{{ .State.Status }}'],
                {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: Math.max(1, Math.min(
                        options.timeoutMs || CONTAINER_CONTROL_PLANE_TIMEOUT_MS,
                        remainingMs,
                    )),
                    killSignal: 'SIGKILL',
                },
            );
            const status = String(result.stdout || '')
                .trim()
                .toLowerCase();
            if (!result.error && result.status === 0 && status === 'running') {
                return true;
            }
        } catch (_) {}
        const remainingAfterInspectMs = deadline - Date.now();
        if (attempt + 1 < maxAttempts && remainingAfterInspectMs > 0) {
            sleepMsImpl(Math.min(delayMs, remainingAfterInspectMs));
        }
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
    listRunningContainerNames,
    isPloinkyBoxRuntime,
    isSandboxRuntime,
    probeContainerRuntime,
    runtimeFamilyName,
    loadAgentsMap,
    parseHostPort,
    parseManifestPorts,
    saveAgentsMap,
    syncAgentMcpConfig,
    waitForContainerRunning,
    flagsToArgs,
    sleepMs,
    createHostSandboxError,
    createHostSandboxStartupError,
    getRuntimeForAgent,
    managedContainerLabelArgs,
};

function getRuntime(boxMarkerPath) {
    return requireContainerRuntime(boxMarkerPath);
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

function getRuntimeForAgent(manifest, { boxMarkerPath } = {}) {
    if (isPloinkyBoxRuntime(boxMarkerPath)) {
        return requireContainerRuntime(boxMarkerPath);
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
