import * as workspaceSvc from './workspace.js';
import fs from 'fs';

const ENV_DISABLE_HOST_SANDBOX = 'PLOINKY_DISABLE_HOST_SANDBOX';
const BOX_MARKER_PATH = '/etc/ploinky-box';

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
    // Sandbox is disabled by default; an explicit `false` opts into host sandboxes.
    const sandbox = readRawSandboxConfig();
    return {
        disableHostRuntimes: sandbox.disableHostRuntimes !== false,
    };
}

function setHostSandboxDisabled(disabled) {
    if (isForcedBoxSandboxPolicy()) {
        if (disabled) return getSandboxStatus();
        const error = new Error('Host sandbox runtimes cannot be enabled inside the Ploinky box; all agents are forced through nested Podman.');
        error.code = 'PLOINKY_BOX_SANDBOX_FORCED';
        throw error;
    }
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
    if (isForcedBoxSandboxPolicy()) return true;
    if (parseBooleanEnv(process.env[ENV_DISABLE_HOST_SANDBOX])) {
        return true;
    }
    return getSandboxConfig().disableHostRuntimes;
}

function getSandboxStatus() {
    if (isForcedBoxSandboxPolicy()) {
        return {
            disabled: true,
            forced: true,
            source: 'ploinky-box',
            effectiveRuntime: 'podman',
            envVar: ENV_DISABLE_HOST_SANDBOX,
        };
    }
    const envDisabled = parseBooleanEnv(process.env[ENV_DISABLE_HOST_SANDBOX]);
    const sandbox = readRawSandboxConfig();
    const explicit = typeof sandbox.disableHostRuntimes === 'boolean';
    const config = getSandboxConfig();
    return {
        disabled: envDisabled || config.disableHostRuntimes,
        source: envDisabled ? 'environment' : (explicit ? 'workspace' : 'default'),
        envVar: ENV_DISABLE_HOST_SANDBOX,
    };
}

function isForcedBoxSandboxPolicy(markerPath = process.env.PLOINKY_BOX_MARKER_PATH || BOX_MARKER_PATH) {
    try {
        return fs.statSync(markerPath).isFile();
    } catch (_) {
        return false;
    }
}

export {
    ENV_DISABLE_HOST_SANDBOX,
    getSandboxConfig,
    getSandboxStatus,
    isHostSandboxDisabled,
    isForcedBoxSandboxPolicy,
    setHostSandboxDisabled,
};
