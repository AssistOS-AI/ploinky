// Agent/server/mcpToolBridge.mjs
//
// Bridges an agent's own MCP tools (config.tools) into the tool map shape the
// achillesAgentLib loop expects: { [name]: { description, handler } }.
// Tools run IN-PROCESS against the local commandSpec via the injected runTool
// (AgentServer's executeShell). This is the agent invoking its OWN tools, so the
// external secure-wire check (requireVerifiedInvocation) does not apply here.

function coerceInput(promptText) {
    if (typeof promptText !== 'string') {
        return promptText && typeof promptText === 'object' ? promptText : { prompt: String(promptText ?? '') };
    }
    const trimmed = promptText.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { return JSON.parse(trimmed); } catch { /* fall through */ }
    }
    return { prompt: promptText };
}

export function buildLoopToolsFromMcp({ tools, defaultCwd, buildCommandSpec, runTool, logger = null }) {
    const loopTools = {};
    if (!Array.isArray(tools)) return loopTools;
    for (const tool of tools) {
        if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string') continue;
        const commandSpec = buildCommandSpec(tool, defaultCwd);
        if (!commandSpec) {
            logger?.warn?.(`[mcpToolBridge] skipping tool '${tool.name}' - no command`);
            continue;
        }
        const description = typeof tool.description === 'string' ? tool.description : tool.name;
        loopTools[tool.name] = {
            description,
            handler: async (_agent, promptText) => {
                const payload = { tool: tool.name, input: coerceInput(promptText), metadata: {} };
                const result = await runTool(commandSpec, payload);
                if (result.code !== 0) {
                    return `Tool '${tool.name}' failed: ${result.stderr || result.stdout || 'unknown error'}`;
                }
                return result.stdout?.length ? result.stdout : '(no output)';
            },
        };
    }
    return loopTools;
}

export default { buildLoopToolsFromMcp };
