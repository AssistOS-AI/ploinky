export const PROVIDER_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const PROVIDER_MODES = new Set(['task', 'operation']);
const PROVIDER_EXPORT_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

function providerConfigError(message) {
    const error = new Error(message);
    error.code = 'PLOINKY_PROVIDER_CONFIG_INVALID';
    return error;
}

function executionEntries(config) {
    const entries = [];
    for (const collection of [config?.tools, config?.resources]) {
        if (Array.isArray(collection)) entries.push(...collection);
    }
    const endpoints = config?.endpoints;
    if (endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints)) {
        entries.push(...Object.values(endpoints));
    }
    return entries.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}

function validateProviderExecution(execution, provider) {
    if (!execution || typeof execution !== 'object' || Array.isArray(execution)
        || Object.keys(execution).some((key) => !['provider', 'mode', 'module', 'export'].includes(key))
        || execution.provider !== provider
        || !PROVIDER_MODES.has(execution.mode)
        || typeof execution.module !== 'string'
        || !execution.module.startsWith('/code/')
        || !execution.module.endsWith('.mjs')
        || execution.module.includes('/../')
        || !PROVIDER_EXPORT_RE.test(String(execution.export || ''))) {
        throw providerConfigError('providerExecution does not match the admitted provider capability');
    }
}

export function normalizeProviderSandboxConfig(config) {
    const entries = executionEntries(config);
    const providerEntries = entries.filter((entry) => entry.providerExecution !== undefined);
    const value = config?.providerSandbox;
    if (value === undefined) {
        if (providerEntries.length > 0) {
            throw providerConfigError('providerExecution requires an exact providerSandbox capability');
        }
        return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw providerConfigError('providerSandbox config must be an object');
    }
    const keys = Object.keys(value);
    if (keys.some((key) => !['provider', 'readiness'].includes(key))
        || !PROVIDER_NAME_RE.test(String(value.provider || ''))
        || value.readiness !== true) {
        throw providerConfigError(
            'providerSandbox config is not the exact provider/readiness contract',
        );
    }
    for (const entry of entries) {
        if (entry.command !== undefined || entry.args !== undefined
            || entry.cwd !== undefined || entry.env !== undefined) {
            throw providerConfigError('provider capability cannot execute a generic shell command');
        }
        if (entry.providerExecution !== undefined) {
            validateProviderExecution(entry.providerExecution, value.provider);
        }
    }
    return Object.freeze({ provider: value.provider, readiness: true });
}
