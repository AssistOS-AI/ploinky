import { randomUUID } from 'node:crypto';

// Default OpenAI Chat Completions capability/listability responder.
//
// This module is intentionally inert: it never invokes MCP tools, never spawns a
// child process, and performs no I/O. It produces an OpenAI-compatible
// `chat.completion` object describing the agent identity and the MCP tools it
// exposes, so every enabled Ploinky agent can appear in Soul Gateway's
// provider/model catalog and participate in traceability. Real conversational
// behavior remains the responsibility of a manifest-specific
// `endpoints.chatCompletions` handler.

const STREAM_NOT_SUPPORTED_MESSAGE =
    'Streaming is not supported by the default OpenAI responder for this agent';

function normalizeToolNames(toolNames) {
    if (!Array.isArray(toolNames)) return [];
    const seen = new Set();
    const names = [];
    for (const entry of toolNames) {
        if (typeof entry !== 'string') continue;
        const trimmed = entry.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        names.push(trimmed);
    }
    return names;
}

function resolveModelName(requestBody, agentId) {
    const requested = requestBody && typeof requestBody === 'object' ? requestBody.model : null;
    if (typeof requested === 'string' && requested.trim()) {
        return requested.trim();
    }
    if (typeof agentId === 'string' && agentId.trim()) {
        return agentId.trim();
    }
    return 'ploinky-agent';
}

function collectManifestCapabilities(manifest) {
    const capabilities = [];
    if (!manifest || typeof manifest !== 'object') return capabilities;
    const declared = manifest.capabilities;
    if (declared && typeof declared === 'object') {
        if (Array.isArray(declared.tags)) {
            for (const tag of declared.tags) {
                if (typeof tag === 'string' && tag.trim()) {
                    capabilities.push(tag.trim());
                }
            }
        }
        for (const field of ['summary', 'description', 'whenToUse']) {
            const value = declared[field];
            if (typeof value === 'string' && value.trim()) {
                capabilities.push(value.trim());
            }
        }
    }
    return capabilities;
}

function buildContent({ modelName, toolNames, manifest }) {
    const lines = [`Ploinky agent ${modelName} is available.`];
    if (toolNames.length) {
        lines.push(`Exposed MCP tools: ${toolNames.join(', ')}.`);
    } else {
        const capabilities = collectManifestCapabilities(manifest);
        if (capabilities.length) {
            lines.push('Exposed MCP tools: none.');
            lines.push(`Declared capabilities: ${capabilities.join('; ')}.`);
        } else {
            lines.push('Exposed MCP tools: none.');
        }
    }
    lines.push(
        'This is a capability/listability response; it does not invoke any tool. '
        + 'Configure endpoints.chatCompletions in the manifest for conversational behavior.'
    );
    return lines.join(' ');
}

// Pure builder: returns an OpenAI-compatible chat.completion object describing the
// agent and its exposed tools. Has no side effects and never executes a tool.
export function buildDefaultOpenAiChatResponse({ requestBody = {}, manifest = null, toolNames = [], agentId } = {}) {
    const normalizedTools = normalizeToolNames(toolNames);
    const modelName = resolveModelName(requestBody, agentId);
    const content = buildContent({ modelName, toolNames: normalizedTools, manifest });
    return {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content
                },
                finish_reason: 'stop'
            }
        ],
        usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }
    };
}

// Helper describing the OpenAI-compatible error the caller should return when a
// `stream: true` request hits the default responder. Returns the status code,
// message, and type so AgentServer can forward them through `sendOpenAiError`.
export function buildDefaultStreamRejection() {
    return {
        statusCode: 400,
        message: STREAM_NOT_SUPPORTED_MESSAGE,
        type: 'invalid_request_error'
    };
}

export { STREAM_NOT_SUPPORTED_MESSAGE };
