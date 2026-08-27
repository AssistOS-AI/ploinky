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

export {
    readManifestAgentCommand,
    readManifestReadinessScript,
    readManifestStartCommand,
    resolveAgentExecutionMode,
    resolveAgentReadinessPort,
    resolveAgentReadinessProtocol
};
