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

function positiveWaitOption(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveManifestStartupTimeoutMs(manifest) {
    const value = manifest?.readiness?.timeoutSeconds;
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value) || value <= 0 || value > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
        throw new Error('readiness.timeoutSeconds must be a positive integer number of seconds');
    }
    return value * 1000;
}

function resolveHealthProbeWaitOptions(manifest) {
    const probe = manifest?.health?.readiness && typeof manifest.health.readiness === 'object'
        ? manifest.health.readiness
        : null;
    if (!probe) return null;

    const intervalSeconds = Number.parseInt(probe.interval ?? '1', 10);
    const timeoutSeconds = Number.parseInt(probe.timeout ?? '1', 10);
    const failureThreshold = Number.parseInt(probe.failureThreshold ?? '120', 10);
    const intervalMs = Math.max(1, Number.isFinite(intervalSeconds) ? intervalSeconds : 1) * 1000;
    const probeTimeoutMs = Math.max(1, Number.isFinite(timeoutSeconds) ? timeoutSeconds : 1) * 1000;
    const attempts = Math.max(1, Number.isFinite(failureThreshold) ? failureThreshold : 120);
    return {
        timeoutMs: attempts * (intervalMs + probeTimeoutMs),
        intervalMs,
        probeTimeoutMs,
    };
}

/**
 * Resolve one MCP/TCP startup wait contract for every lifecycle caller.
 *
 * Callers retain their existing operational fallback (for example 15 seconds
 * for an ordinary targeted restart and 120 seconds for a graph/no-wait
 * launch). A manifest may raise that floor when its serving process has a
 * known minimum startup budget, but it cannot silently shorten a caller's
 * broader safety window.
 */
function resolveAgentReadinessWaitOptions(manifest, {
    timeoutMs = 120000,
    intervalMs = 250,
    probeTimeoutMs = 1000,
    includeHealthProbeTiming = false,
} = {}) {
    const fallbackTimeoutMs = positiveWaitOption(timeoutMs, 120000);
    const manifestTimeoutMs = resolveManifestStartupTimeoutMs(manifest);
    const healthProbeOptions = includeHealthProbeTiming
        ? resolveHealthProbeWaitOptions(manifest)
        : null;
    return {
        timeoutMs: Math.max(
            fallbackTimeoutMs,
            manifestTimeoutMs ?? 0,
            healthProbeOptions?.timeoutMs ?? 0,
        ),
        intervalMs: healthProbeOptions?.intervalMs ?? positiveWaitOption(intervalMs, 250),
        probeTimeoutMs: healthProbeOptions?.probeTimeoutMs ?? positiveWaitOption(probeTimeoutMs, 1000),
    };
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

export {
    readManifestAgentCommand,
    readManifestReadinessScript,
    readManifestStartCommand,
    resolveAgentExecutionMode,
    resolveAgentReadinessPort,
    resolveAgentReadinessProtocol,
    resolveAgentReadinessWaitOptions,
};
