import * as workspaceSvc from '../workspace.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { BOX_MARKER_PATH } from '../../../ploinky-box/constants.mjs';
import { IMAGE_CONTRACT } from '../../../ploinky-box/contract/image.mjs';
import { isInsideBox } from '../../../ploinky-box/lib/boxMarker.mjs';
import { REPOS_DIR } from '../config.js';

const ENV_DISABLE_HOST_SANDBOX = 'PLOINKY_DISABLE_HOST_SANDBOX';
const RUNTIME_PROBE_TIMEOUT_MS = 5_000;
const REQUIRED_BWRAP_HELPER_CAPABILITIES = Object.freeze([
    'protocol=1 descriptor-fd=3',
    'path-resolution=openat2-beneath-no-magiclinks-no-symlinks',
    'bwrap-fd-options=bind-fd,ro-bind-fd,ro-bind-data,perms',
]);

function parseBooleanEnv(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function readRawSandboxConfig() {
    const cfg = workspaceSvc.getConfig() || {};
    return cfg.sandbox && typeof cfg.sandbox === 'object' && !Array.isArray(cfg.sandbox)
        ? cfg.sandbox
        : {};
}

function getSandboxConfig() {
    const sandbox = readRawSandboxConfig();
    return {
        disableHostRuntimes: sandbox.disableHostRuntimes === true,
    };
}

function setHostSandboxDisabled(disabled) {
    const cfg = workspaceSvc.getConfig() || {};
    const sandbox = cfg.sandbox && typeof cfg.sandbox === 'object' && !Array.isArray(cfg.sandbox)
        ? { ...cfg.sandbox }
        : {};

    sandbox.disableHostRuntimes = Boolean(disabled);
    cfg.sandbox = sandbox;
    workspaceSvc.setConfig(cfg);
    return getSandboxStatus();
}

function isHostSandboxDisabled() {
    if (parseBooleanEnv(process.env[ENV_DISABLE_HOST_SANDBOX])) {
        return true;
    }
    return getSandboxConfig().disableHostRuntimes;
}

function probeExecutable(name, args = ['--version']) {
    try {
        const executable = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'ploinky-probe', name], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: RUNTIME_PROBE_TIMEOUT_MS,
        }).trim();
        if (!executable) return Object.freeze({ available: false, version: '' });
        const version = execFileSync(executable, args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: RUNTIME_PROBE_TIMEOUT_MS,
        }).trim().split(/\r?\n/, 1)[0];
        return Object.freeze({ available: true, executable, version });
    } catch (_) {
        return Object.freeze({ available: false, executable: '', version: '' });
    }
}

function probeBwrapHelper(helperPath = IMAGE_CONTRACT.bwrapHelper) {
    try {
        const capabilities = execFileSync(helperPath, ['--capabilities'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: RUNTIME_PROBE_TIMEOUT_MS,
        }).trim();
        const missingCapabilities = REQUIRED_BWRAP_HELPER_CAPABILITIES
            .filter((capability) => !capabilities.includes(capability));
        let version = '';
        try {
            version = execFileSync(helperPath, ['--version'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: RUNTIME_PROBE_TIMEOUT_MS,
            }).trim().split(/\r?\n/, 1)[0];
        } catch (_) {
            // Capability admission is authoritative; version is diagnostic.
        }
        return Object.freeze({
            available: missingCapabilities.length === 0,
            path: helperPath,
            version,
            missingCapabilities: Object.freeze(missingCapabilities),
        });
    } catch (_) {
        return Object.freeze({
            available: false,
            path: helperPath,
            version: '',
            missingCapabilities: REQUIRED_BWRAP_HELPER_CAPABILITIES,
        });
    }
}

function manifestPathForAgent(record, reposRoot = REPOS_DIR) {
    const root = path.resolve(reposRoot);
    const candidate = path.resolve(
        root,
        String(record?.repoName || ''),
        String(record?.agentName || ''),
        'manifest.json',
    );
    const relative = path.relative(root, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        const error = new Error('enabled-agent manifest path escapes the managed repository root');
        error.code = 'PLOINKY_AGENT_MANIFEST_INVALID';
        throw error;
    }
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    const realRelative = path.relative(realRoot, realCandidate);
    if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        const error = new Error('enabled-agent manifest resolves outside the managed repository root');
        error.code = 'PLOINKY_AGENT_MANIFEST_INVALID';
        throw error;
    }
    return realCandidate;
}

function selectAgentRuntime(manifest, status, platform) {
    if (typeof manifest?.runtime === 'string') {
        return {
            selectedRuntime: 'invalid',
            available: false,
            errorCode: 'PLOINKY_LEGACY_RUNTIME_SELECTOR',
        };
    }

    if (manifest?.['lite-sandbox'] === true) {
        if (Object.prototype.hasOwnProperty.call(manifest, 'container')) {
            return {
                selectedRuntime: 'invalid',
                available: false,
                errorCode: 'PLOINKY_SANDBOX_CONTAINER_CONFLICT',
            };
        }
        const selectedRuntime = status.insideBox || platform === 'linux'
            ? 'bwrap'
            : (platform === 'darwin' ? 'seatbelt' : 'unsupported');
        if (status.disabled) {
            return {
                selectedRuntime,
                available: false,
                errorCode: 'PLOINKY_SANDBOX_POLICY_CONFLICT',
            };
        }
        if (selectedRuntime === 'bwrap') {
            const available = status.bwrap.available
                && (!status.insideBox || status.helper.available);
            return {
                selectedRuntime,
                available,
                errorCode: available ? '' : 'PLOINKY_HOST_SANDBOX_UNAVAILABLE',
            };
        }
        if (selectedRuntime === 'seatbelt') {
            return {
                selectedRuntime,
                available: status.seatbelt.available,
                errorCode: status.seatbelt.available ? '' : 'PLOINKY_HOST_SANDBOX_UNAVAILABLE',
            };
        }
        return {
            selectedRuntime,
            available: false,
            errorCode: 'PLOINKY_HOST_SANDBOX_UNAVAILABLE',
        };
    }

    if (status.insideBox) {
        return {
            selectedRuntime: 'podman',
            available: status.podman.available,
            errorCode: status.podman.available ? '' : 'PLOINKY_BOX_PODMAN_REQUIRED',
        };
    }
    const selectedRuntime = status.podman.available
        ? 'podman'
        : (status.docker.available ? 'docker' : 'container');
    return {
        selectedRuntime,
        available: selectedRuntime !== 'container',
        errorCode: selectedRuntime === 'container' ? 'PLOINKY_CONTAINER_RUNTIME_UNAVAILABLE' : '',
    };
}

function collectAgentRuntimeSelections(status, {
    agents = workspaceSvc.loadAgents(),
    platform = process.platform,
    reposRoot = REPOS_DIR,
} = {}) {
    return Object.entries(agents || {})
        .filter(([runtimeKey, record]) => runtimeKey !== '_config' && record?.type === 'agent')
        .map(([runtimeKey, record]) => {
            const identity = `${String(record.repoName || '-')}/${String(record.agentName || '-')}`;
            const instance = String(record.alias || record.agentName || runtimeKey);
            const base = {
                runtimeKey,
                agent: identity,
                instance,
                recordedRuntime: String(record.runtime || ''),
            };
            try {
                const manifestPath = manifestPathForAgent(record, reposRoot);
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
                    const error = new Error('enabled-agent manifest must be a JSON object');
                    error.code = 'PLOINKY_AGENT_MANIFEST_INVALID';
                    throw error;
                }
                return Object.freeze({
                    ...base,
                    ...selectAgentRuntime(manifest, status, platform),
                });
            } catch (error) {
                return Object.freeze({
                    ...base,
                    selectedRuntime: 'unknown',
                    available: false,
                    errorCode: error?.code || 'PLOINKY_AGENT_MANIFEST_UNAVAILABLE',
                });
            }
        })
        .sort((left, right) => left.runtimeKey.localeCompare(right.runtimeKey));
}

function getSandboxStatus({
    boxMarkerPath = BOX_MARKER_PATH,
    bwrapHelperPath = IMAGE_CONTRACT.bwrapHelper,
    platform = process.platform,
    agents,
    reposRoot = REPOS_DIR,
} = {}) {
    const insideBox = isInsideBox({ markerPath: boxMarkerPath });
    const envDisabled = parseBooleanEnv(process.env[ENV_DISABLE_HOST_SANDBOX]);
    const sandbox = readRawSandboxConfig();
    const explicit = typeof sandbox.disableHostRuntimes === 'boolean';
    const config = getSandboxConfig();
    const helper = insideBox
        ? { required: true, ...probeBwrapHelper(bwrapHelperPath) }
        : {
            required: false,
            available: false,
            path: bwrapHelperPath,
            version: '',
            missingCapabilities: Object.freeze([]),
        };
    const status = {
        disabled: envDisabled || config.disableHostRuntimes,
        source: envDisabled ? 'environment' : (explicit ? 'workspace' : 'default'),
        envVar: ENV_DISABLE_HOST_SANDBOX,
        selection: 'manifest',
        insideBox,
        hybrid: insideBox,
        bwrap: probeExecutable('bwrap'),
        seatbelt: probeExecutable('sandbox-exec', ['-h']),
        podman: probeExecutable('podman'),
        docker: probeExecutable('docker'),
        helper: Object.freeze(helper),
    };
    return Object.freeze({
        ...status,
        agents: Object.freeze(collectAgentRuntimeSelections(status, {
            agents,
            platform,
            reposRoot,
        })),
    });
}

export {
    ENV_DISABLE_HOST_SANDBOX,
    getSandboxConfig,
    getSandboxStatus,
    isHostSandboxDisabled,
    setHostSandboxDisabled,
};
