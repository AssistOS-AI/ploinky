import * as workspaceSvc from '../workspace.js';

const ENV_DISABLE_HOST_SANDBOX = 'PLOINKY_DISABLE_HOST_SANDBOX';

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

function getSandboxStatus() {
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

export {
    ENV_DISABLE_HOST_SANDBOX,
    getSandboxConfig,
    getSandboxStatus,
    isHostSandboxDisabled,
    setHostSandboxDisabled,
};
