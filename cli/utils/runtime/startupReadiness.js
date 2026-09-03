function normalizeProtocol(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'tcp' || normalized === 'mcp' || normalized === 'none') {
        return normalized;
    }
    return '';
}

function resolveAgentReadinessPort(manifest) {
    const value = manifest?.readiness?.port;
    if (value === undefined || value === null || value === '') return null;
    const text = String(value).trim();
    if (!/^[1-9][0-9]{0,4}$/.test(text)) {
        throw new Error(`readiness.port must be an integer from 1 through 65535, got '${text}'`);
    }
    const port = Number(text);
    if (!Number.isSafeInteger(port) || port > 65535) {
        throw new Error(`readiness.port must be an integer from 1 through 65535, got '${text}'`);
    }
    return port;
}

function readManifestStartCommand(manifest) {
    if (!manifest || typeof manifest !== 'object') return '';
    const value = manifest.start;
    if (typeof value !== 'string') return '';
    return value.trim();
}

function readManifestAgentCommand(manifest) {
    if (!manifest || typeof manifest !== 'object') return '';
    const value = (manifest.agent && String(manifest.agent))
        || (manifest.commands && manifest.commands.run)
        || '';
    return String(value || '').trim();
}

function readManifestReadinessScript(manifest) {
    const value = manifest?.health?.readiness?.script;
    return typeof value === 'string' ? value.trim() : '';
}

function resolveAgentExecutionMode(manifest) {
    const startCmd = readManifestStartCommand(manifest);
    const explicitAgentCmd = readManifestAgentCommand(manifest);

    if (startCmd && explicitAgentCmd) {
        return {
            type: 'start_and_agent',
            startCmd,
            explicitAgentCmd,
            usesImplicitAgentServer: false
        };
    }
    if (startCmd) {
        return {
            type: 'start_only',
            startCmd,
            explicitAgentCmd: '',
            usesImplicitAgentServer: false
        };
    }
    if (explicitAgentCmd) {
        return {
            type: 'agent_only',
            startCmd: '',
            explicitAgentCmd,
            usesImplicitAgentServer: false
        };
    }
    return {
        type: 'implicit_agent_server',
        startCmd: '',
        explicitAgentCmd: '',
        usesImplicitAgentServer: true
    };
}

function resolveAgentReadinessProtocol(manifest, context = {}) {
    const explicit = normalizeProtocol(manifest?.readiness?.protocol);
    if (explicit) {
        return explicit;
    }

    if (readManifestReadinessScript(manifest)) {
        return 'script';
    }

    const executionMode = resolveAgentExecutionMode(manifest);
    if (executionMode.type === 'start_only') {
        return 'tcp';
    }

    return 'mcp';
}

const MAX_READINESS_TIMER_MS = 2 ** 31 - 1;

function readinessInteger(value, fallback, label, maximum = MAX_READINESS_TIMER_MS) {
    if (value === undefined || value === null || value === '') return fallback;
    const number = typeof value === 'number' || typeof value === 'string'
        ? Number(value)
        : NaN;
    if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
        throw new Error(`${label} must be a finite positive integer no greater than ${maximum}`);
    }
    return number;
}

// The declared health attempts include both the probe and the delay between
// attempts. Startup still has to pass its selected MCP/TCP protocol; this only
// gives a cold service the same finite budget already used by reinstall.
function resolveManifestReadinessWaitOptions(manifest, fallbackTimeoutMs = 120000, overrides = {}) {
    const fallback = readinessInteger(fallbackTimeoutMs, 120000, 'readiness timeout');
    const probe = manifest?.health?.readiness;
    let timeoutMs = fallback;
    let intervalMs = 250;
    let probeTimeoutMs = 1000;
    if (probe !== undefined && probe !== null) {
        if (typeof probe !== 'object' || Array.isArray(probe)) {
            throw new Error('health.readiness must be an object');
        }
        intervalMs = readinessInteger(probe.interval, 1, 'health.readiness.interval') * 1000;
        probeTimeoutMs = readinessInteger(probe.timeout, 1, 'health.readiness.timeout') * 1000;
        const attempts = readinessInteger(probe.failureThreshold, 120, 'health.readiness.failureThreshold');
        timeoutMs = Math.max(fallback, attempts * (intervalMs + probeTimeoutMs));
    }
    // Validate derived values before overrides too: malformed declarations must
    // not silently become an unbounded deadline or an overflowing Node timer.
    readinessInteger(timeoutMs, fallback, 'manifest readiness timeout');
    readinessInteger(intervalMs, 250, 'manifest readiness interval');
    readinessInteger(probeTimeoutMs, 1000, 'manifest readiness probe timeout', Math.floor(MAX_READINESS_TIMER_MS / 2));
    return {
        timeoutMs: readinessInteger(overrides.timeoutMs, timeoutMs, 'readiness timeout override'),
        intervalMs: readinessInteger(overrides.intervalMs, intervalMs, 'readiness interval override'),
        probeTimeoutMs: readinessInteger(overrides.probeTimeoutMs, probeTimeoutMs, 'readiness probe timeout override', Math.floor(MAX_READINESS_TIMER_MS / 2)),
    };
}

export {
    readManifestAgentCommand,
    readManifestReadinessScript,
    readManifestStartCommand,
    resolveAgentExecutionMode,
    resolveAgentReadinessPort,
    resolveAgentReadinessProtocol,
    resolveManifestReadinessWaitOptions
};
