function normalizeProtocol(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'tcp' || normalized === 'mcp' || normalized === 'none') {
        return normalized;
    }
    return '';
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

function resolveAgentReadinessProtocol(manifest) {
    const explicit = normalizeProtocol(manifest?.readiness?.protocol);
    if (explicit) {
        return explicit;
    }

    const executionMode = resolveAgentExecutionMode(manifest);
    if (executionMode.type === 'start_only') {
        return 'tcp';
    }

    return 'mcp';
}

export {
    readManifestAgentCommand,
    readManifestStartCommand,
    resolveAgentExecutionMode,
    resolveAgentReadinessProtocol
};
