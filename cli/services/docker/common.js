import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { REPOS_DIR, PLOINKY_DIR, WORKSPACE_ROOT } from '../config.js';
import { getAgentWorkDir } from '../workspaceStructure.js';
import { buildEnvFlags, buildEnvMap } from '../secretVars.js';
import { loadAgents, saveAgents } from '../workspace.js';
import { debugLog } from '../utils.js';
import { isHostSandboxDisabled } from '../sandboxRuntime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isPathUnderRoot(candidate) {
    if (!candidate) return false;
    const root = path.resolve(WORKSPACE_ROOT);
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
        return WORKSPACE_ROOT;
    }
    try {
        const map = loadAgentsMap();
        const staticAgent = typeof map?._config?.static?.agent === 'string'
            ? map._config.static.agent.trim()
            : '';
        if (staticAgent && staticAgent === agentName) {
            return WORKSPACE_ROOT;
        }
        if (alias) {
            const aliasRec = Object.values(map || {}).find(r => r && r.type === 'agent' && r.alias === alias);
            if (aliasRec && aliasRec.projectPath && typeof aliasRec.projectPath === 'string') {
                const normalized = normalizeProjectPath(aliasRec.projectPath, aliasRec.runMode);
                if (normalized) return normalized;
            }
        }
        const rec = Object.values(map || {}).find(r => r && r.type === 'agent' && r.agentName === agentName && r.repoName === repoName);
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
        console.error('Neither podman nor docker found in PATH. Please install one of them.');
        process.exit(1);
    }
    return rt;
}

const DEFAULT_IMAGE_PULL_TIMEOUT_MS = 30 * 60 * 1000;

function imagePullTimeoutMs() {
    const raw = Number(process.env.PLOINKY_IMAGE_PULL_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IMAGE_PULL_TIMEOUT_MS;
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

// Ensure an image is present locally, pulling it (with streamed progress) only
// when missing. Returns true if a pull happened, false if it was already cached.
function ensureImagePresent(image, options = {}) {
    const rt = options.runtime || getRuntime();
    const img = String(image || '').trim();
    if (!img) throw new Error('ensureImagePresent: image is required');
    if (imageExists(img, rt)) return false;
    const log = typeof options.log === 'function' ? options.log : ((msg) => console.log(msg));
    log(`[pull] image '${img}' not present locally — pulling before runtime probe...`);
    pullImage(img, { runtime: rt, log, timeoutMs: options.pullTimeoutMs });
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
        .update(WORKSPACE_ROOT)
        .digest('hex')
        .substring(0, 8);
    const projectDir = path.basename(WORKSPACE_ROOT).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const containerName = `ploinky_${safeRepoName}_${safeAgentName}_${projectDir}_${cwdHash}`;
    debugLog(`Calculated container name: ${containerName} (for path: ${WORKSPACE_ROOT})`);
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

function syncAgentMcpConfig(_containerName, agentPath, agentName) {
    try {
        const source = getAgentMcpConfigPath(agentPath);
        if (!source) return false;
        const resolvedAgentName = agentName || path.basename(agentPath || '');
        if (!resolvedAgentName) return false;
        const workDir = getAgentWorkDir(resolvedAgentName);
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

function parseManifestPorts(manifest, profileConfig = null) {
    // Ports must be defined in profile configuration
    const ports = profileConfig?.ports;
    if (!ports) return { publishArgs: [], portMappings: [] };

    const portArray = Array.isArray(ports) ? ports : [ports];
    const publishArgs = [];
    const portMappings = [];

    for (const p of portArray) {
        if (!p) continue;
        const portSpec = String(p).trim();
        if (!portSpec) continue;

        const parts = portSpec.split(':');
        let hostIp = '127.0.0.1';  // Default to localhost for security
        let hostPortSpec;
        let containerPortSpec;
        if (parts.length === 1) {
            hostPortSpec = containerPortSpec = parts[0];
        } else if (parts.length === 2) {
            hostPortSpec = parts[0];
            containerPortSpec = parts[1];
        } else if (parts.length === 3) {
            hostIp = parts[0];  // Respect the specified IP address
            hostPortSpec = parts[1];
            containerPortSpec = parts[2];
        }
        const parsed = parsePortPublishSpec(hostPortSpec, containerPortSpec);
        if (parsed) {
            const normalized = `${hostIp}:${parsed.hostPortSpec}:${parsed.containerPortSpec}${parsed.protocolSuffix}`;
            publishArgs.push(normalized);
            for (const mapping of parsed.portMappings) {
                portMappings.push({ ...mapping, hostIp, protocol: parsed.protocol });
            }
        }
    }

    return { publishArgs, portMappings };
}

function parsePortPublishSpec(hostPortSpec, containerPortSpec) {
    if (hostPortSpec === undefined || hostPortSpec === null || containerPortSpec === undefined || containerPortSpec === null) {
        return null;
    }
    const container = splitPortProtocol(containerPortSpec);
    const host = splitPortProtocol(hostPortSpec);
    const protocol = container.protocol || host.protocol || 'tcp';
    if ((container.protocol && host.protocol && container.protocol !== host.protocol) || !['tcp', 'udp'].includes(protocol)) {
        return null;
    }
    const hostRange = parsePortRange(host.portSpec, { allowEphemeral: true });
    const containerRange = parsePortRange(container.portSpec);
    if (!hostRange || !containerRange || hostRange.length !== containerRange.length) {
        return null;
    }
    if (hostRange.ephemeral && containerRange.length !== 1) {
        return null;
    }
    const portMappings = [];
    for (let offset = 0; offset < hostRange.length; offset += 1) {
        portMappings.push({
            hostPort: hostRange.start + offset,
            containerPort: containerRange.start + offset
        });
    }
    return {
        hostPortSpec: hostRange.ephemeral ? '' : formatPortRange(hostRange),
        containerPortSpec: formatPortRange(containerRange),
        protocol,
        protocolSuffix: protocol === 'tcp' ? '' : `/${protocol}`,
        portMappings
    };
}

function splitPortProtocol(portSpec) {
    const raw = String(portSpec || '').trim();
    const match = raw.match(/^(.+?)(?:\/([a-zA-Z]+))?$/);
    return {
        portSpec: String(match?.[1] || '').trim(),
        protocol: String(match?.[2] || '').trim().toLowerCase()
    };
}

function parsePortRange(portSpec, options = {}) {
    const raw = String(portSpec || '').trim();
    if (options.allowEphemeral && raw === '') {
        return { start: 0, end: 0, length: 1, ephemeral: true };
    }
    const match = raw.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) return null;
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : start;
    if (options.allowEphemeral && start === 0 && end === 0 && !match[2]) {
        return { start: 0, end: 0, length: 1, ephemeral: true };
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0 || end < start) {
        return null;
    }
    return { start, end, length: end - start + 1 };
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
    PLOINKY_DIR,
    REPOS_DIR,
    containerRuntime,
    containerExists,
    ensureImagePresent,
    imageExists,
    pullImage,
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
    getRuntimeForAgent
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
