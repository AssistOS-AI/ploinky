const ACHILLES_COMMAND_CATALOG_TOOL = 'list_achilles_cli_commands';

export function applySlashSelectionToValue(value, cmd) {
    const inputValue = typeof value === 'string' ? value : '';
    const slashIdx = inputValue.lastIndexOf('/');
    if (slashIdx === -1 || !cmd) {
        return null;
    }

    const afterSlash = inputValue.slice(slashIdx + 1);
    const spaceIdx = afterSlash.indexOf(' ');
    const hasSubToken = spaceIdx !== -1;

    let insertText;
    if (hasSubToken && cmd.subCommands && cmd.subCommands.length) {
        const cmdName = cmd.name.replace('/', '');
        const subToken = afterSlash.slice(spaceIdx + 1).trim().toLowerCase();
        const matchingSub = cmd.subCommands.find((sub) =>
            getSubCommandName(sub).toLowerCase().includes(subToken)
        ) || cmd.subCommands[0];
        insertText = `/${cmdName} ${getSubCommandName(matchingSub)} `;
    } else {
        insertText = cmd.name + ' ';
    }

    const replaceEnd = slashIdx + 1 + afterSlash.length;
    const nextValue = inputValue.slice(0, slashIdx) + insertText + (hasSubToken ? '' : inputValue.slice(replaceEnd));
    return {
        value: nextValue,
        cursor: slashIdx + insertText.length
    };
}

function getSubCommandName(subCommand) {
    if (typeof subCommand === 'string') {
        return subCommand.trim();
    }
    if (subCommand && typeof subCommand.name === 'string') {
        return subCommand.name.trim();
    }
    return '';
}

export function applySlashInsertTextToValue(value, insertText) {
    const inputValue = typeof value === 'string' ? value : '';
    const safeInsertText = typeof insertText === 'string' ? insertText : '';
    const slashIdx = inputValue.lastIndexOf('/');
    if (slashIdx === -1 || !safeInsertText) {
        return null;
    }

    const afterSlash = inputValue.slice(slashIdx + 1);
    const replaceEnd = slashIdx + 1 + afterSlash.length;
    return {
        value: inputValue.slice(0, slashIdx) + safeInsertText + inputValue.slice(replaceEnd),
        cursor: slashIdx + safeInsertText.length
    };
}

function buildCatalogArguments() {
    const query = globalThis.document?.body?.dataset?.agentQuery || '';
    const args = {};
    if (!query) {
        return args;
    }
    try {
        const params = new URLSearchParams(query);
        const dir = params.get('dir');
        if (dir) {
            args.dir = dir;
        }
    } catch (_) {
        // Ignore malformed query strings; catalog tools should remain optional.
    }
    return args;
}

function normalizeArgCompletions(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => {
            if (typeof entry === 'string') {
                const text = entry.trim();
                return text ? { value: text, label: text, description: '' } : null;
            }
            if (!entry || typeof entry !== 'object') {
                return null;
            }
            const rawValue = typeof entry.value === 'string'
                ? entry.value.trim()
                : (typeof entry.name === 'string' ? entry.name.trim() : '');
            if (!rawValue) {
                return null;
            }
            return {
                value: rawValue,
                label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : rawValue,
                description: typeof entry.description === 'string' ? entry.description : ''
            };
        })
        .filter(Boolean);
}

function normalizeSubCommands(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((subCommand) => {
            const name = getSubCommandName(subCommand);
            if (!name) {
                return null;
            }
            if (typeof subCommand === 'string') {
                return {
                    name,
                    description: '',
                    argCompletions: []
                };
            }
            return {
                name,
                description: typeof subCommand.description === 'string' ? subCommand.description : '',
                argCompletions: normalizeArgCompletions(subCommand.argCompletions)
            };
        })
        .filter(Boolean);
}

function getFirstToken(value) {
    return String(value || '').trim().split(/\s+/)[0] || '';
}

function getRemainingAfterFirstToken(value) {
    const text = String(value || '');
    const match = text.match(/^\s*\S+\s+(.*)$/);
    return match ? match[1] : '';
}

function isCompletedKnownToken(rawToken, completions) {
    const text = String(rawToken || '');
    if (!/\s$/.test(text)) return false;
    const token = text.trim().toLowerCase();
    if (!token) return false;
    return normalizeArgCompletions(completions).some((completion) =>
        completion.value.toLowerCase() === token
        || completion.label.toLowerCase() === token
    );
}

function appendArgCompletionSuggestions(suggestions, { cmdName, cmd, argCompletions, argToken, prefixText = '' }) {
    const normalizedArgToken = String(argToken || '').trim().toLowerCase();
    const matchingArgs = argCompletions.filter((completion) =>
        completion.value.toLowerCase().startsWith(normalizedArgToken)
        || completion.label.toLowerCase().startsWith(normalizedArgToken)
    );
    for (const completion of matchingArgs) {
        suggestions.push({
            label: `/${cmdName} ${prefixText}${completion.label}`,
            description: completion.description || cmd.description || '',
            command: cmd,
            insertText: `/${cmdName} ${prefixText}${completion.value} `,
            keepMenuOpen: false
        });
    }
}

function extractSubCommands(tool) {
    const subs = [];
    const schema = tool.inputSchema;
    if (!schema || !schema.properties) return subs;

    const props = Object.keys(schema.properties);
    if (props.length <= 2) return subs;

    for (const prop of props) {
        if (!['input', 'prompt', 'text', 'message', 'query'].includes(prop.toLowerCase())) {
            subs.push(prop);
        }
    }
    return subs.slice(0, 6);
}

export function buildSuggestions(commands, {
    currentToken,
    hasSubToken,
    subToken
}) {
    const normalizedToken = currentToken.trim().toLowerCase();
    const suggestions = [];

    for (const cmd of commands) {
        const suggestionCountBeforeCommand = suggestions.length;
        const cmdName = cmd.name.replace('/', '');
        const normalizedCmdName = cmdName.toLowerCase();
        const subCommands = normalizeSubCommands(cmd.subCommands);
        const argCompletions = normalizeArgCompletions(cmd.argCompletions);

        if (hasSubToken && normalizedCmdName.startsWith(normalizedToken)) {
            const rawSubToken = String(subToken || '');
            const firstSubToken = getFirstToken(rawSubToken).toLowerCase();
            const matchedSub = firstSubToken
                ? subCommands.find((sub) => sub.name.toLowerCase() === firstSubToken)
                : null;
            const isAfterMatchedSub = Boolean(matchedSub)
                && (/\s$/.test(rawSubToken) || getRemainingAfterFirstToken(rawSubToken).length > 0);

            if (isAfterMatchedSub && matchedSub.argCompletions.length > 0) {
                appendArgCompletionSuggestions(suggestions, {
                    cmdName,
                    cmd,
                    argCompletions: matchedSub.argCompletions,
                    argToken: getRemainingAfterFirstToken(rawSubToken),
                    prefixText: `${matchedSub.name} `
                });
                continue;
            }
            if (isAfterMatchedSub) {
                continue;
            }

            if (subCommands.length > 0 && !isAfterMatchedSub) {
                const normalizedSubToken = rawSubToken.trim().toLowerCase();
                const matchingSubs = subCommands.filter((sub) =>
                    sub.name.toLowerCase().includes(normalizedSubToken)
                );
                for (const sub of matchingSubs) {
                    suggestions.push({
                        label: `/${cmdName} ${sub.name}`,
                        description: sub.description || cmd.description || '',
                        command: {
                            ...cmd,
                            subCommands: [sub]
                        },
                        insertText: `/${cmdName} ${sub.name} `,
                        keepMenuOpen: sub.argCompletions.length > 0
                    });
                }
            }

            const isCompletingFirstArg = !rawSubToken.trim().includes(' ')
                && !isCompletedKnownToken(rawSubToken, argCompletions);
            if (argCompletions.length > 0 && isCompletingFirstArg) {
                appendArgCompletionSuggestions(suggestions, {
                    cmdName,
                    cmd,
                    argCompletions,
                    argToken: rawSubToken
                });
            }

            continue;
        }

        if (normalizedCmdName.includes(normalizedToken)) {
            suggestions.push({
                label: cmd.name,
                description: cmd.description || '',
                command: cmd,
                insertText: `${cmd.name} `,
                keepMenuOpen: subCommands.length > 0 || argCompletions.length > 0
            });
        }
    }

    return suggestions;
}

async function callMcpInitialize(mcpEndpoint) {
    const initRes = await fetch(mcpEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'wc-init-1',
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'webchat', version: '1.0.0' }
            }
        })
    });
    if (!initRes.ok) return null;
    const initBody = await initRes.json().catch(() => null);
    if (!initBody || !initBody.result) return null;
    const sessionId = initRes.headers.get('mcp-session-id') || initBody.result?.meta?.sessionId;
    await fetch(mcpEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(sessionId ? { 'mcp-session-id': sessionId } : {})
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    });
    return sessionId;
}

async function fetchStructuredCatalog(mcpEndpoint, sessionId, tools, catalogArguments = {}) {
    const catalogTool = tools.find((tool) => tool?.name === ACHILLES_COMMAND_CATALOG_TOOL);
    if (!catalogTool) return [];

    const callRes = await fetch(mcpEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(sessionId ? { 'mcp-session-id': sessionId } : {})
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'wc-tool-call-commands-1',
            method: 'tools/call',
            params: {
                name: catalogTool.name,
                arguments: catalogArguments && typeof catalogArguments === 'object' ? catalogArguments : {}
            }
        })
    });
    if (!callRes.ok) return [];
    const callBody = await callRes.json().catch(() => null);
    const content = callBody?.result?.content || callBody?.result?.result?.content;
    if (!Array.isArray(content)) return [];

    const textPart = content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string');
    if (!textPart) return [];

    const parsed = JSON.parse(textPart.text);
    if (!parsed || parsed.type !== 'achilles-slash-command-catalog' || !Array.isArray(parsed.commands)) {
        return [];
    }

    return parsed.commands
        .map((command) => {
            const rawName = typeof command?.name === 'string' ? command.name.trim() : '';
            if (!rawName) return null;
            const normalizedName = rawName.startsWith('/') ? rawName : `/${rawName}`;
            const subCommands = Array.isArray(command.subCommands)
                ? command.subCommands
                    .map((subCommand) => {
                        const name = getSubCommandName(subCommand);
                        if (!name) return null;
                        if (typeof subCommand === 'string') {
                            return name;
                        }
                        return {
                            name,
                            description: typeof subCommand.description === 'string' ? subCommand.description : '',
                            argCompletions: normalizeArgCompletions(subCommand.argCompletions)
                        };
                    })
                    .filter(Boolean)
                : [];
            const argCompletions = normalizeArgCompletions(command.argCompletions);
            return {
                name: normalizedName,
                description: typeof command.description === 'string' ? command.description : '',
                subCommands,
                argCompletions
            };
        })
        .filter(Boolean);
}

async function fetchCommandsFromAgent(agentName, dlog) {
    if (!agentName) return [];
    try {
        const mcpEndpoint = `/mcps/${agentName}/mcp`;
        const sessionId = await callMcpInitialize(mcpEndpoint);
        if (sessionId === null) return [];

        const toolsRes = await fetch(mcpEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(sessionId ? { 'mcp-session-id': sessionId } : {})
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'wc-tools-1', method: 'tools/list' })
        });
        if (!toolsRes.ok) return [];

        const toolsBody = await toolsRes.json().catch(() => null);
        if (!toolsBody || !toolsBody.result || !Array.isArray(toolsBody.result.tools)) return [];

        const tools = toolsBody.result.tools;
        try {
            const structured = await fetchStructuredCatalog(mcpEndpoint, sessionId, tools, buildCatalogArguments());
            if (structured.length > 0) {
                return structured.sort((a, b) => a.name.localeCompare(b.name));
            }
        } catch (err) {
            dlog?.('SlashCommandsProvider: structured catalog parse failed, falling back', err?.message || err);
        }

        const fallback = [];
        for (const tool of tools) {
            const toolName = tool.name || '';
            if (!toolName.startsWith('execute_')) continue;
            const skillName = toolName.replace('execute_', '').replace(/_/g, '-');
            fallback.push({
                name: `/${skillName}`,
                description: tool.description || '',
                inputSchema: tool.inputSchema || null,
                subCommands: extractSubCommands(tool)
            });
        }
        return fallback.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
        dlog?.('SlashCommandsProvider: MCP catalog fetch failed (silent)', err?.message || err);
        return [];
    }
}

export function createSlashCommandsProvider({ agentName, dlog } = {}) {
    let commands = [];

    function detectTrigger(value, caretIndex) {
        const inputValue = typeof value === 'string' ? value : '';
        const slashIdx = inputValue.lastIndexOf('/', Math.max(0, caretIndex - 1));
        if (slashIdx === -1) return null;
        const afterSlash = inputValue.slice(slashIdx + 1, caretIndex);
        if (afterSlash.includes(' ') === false && /\s/.test(afterSlash)) {
            return null;
        }
        return { triggerIndex: slashIdx, token: afterSlash };
    }

    function getSuggestions(value, caretIndex) {
        const inputValue = typeof value === 'string' ? value : '';
        const slashIdx = inputValue.lastIndexOf('/');
        if (slashIdx === -1) return [];
        const afterSlash = inputValue.slice(slashIdx + 1);
        const firstChar = afterSlash.charAt(0);
        if (firstChar === ' ' || firstChar === '\n') return [];
        const spaceIdx = afterSlash.indexOf(' ');
        const currentToken = spaceIdx === -1 ? afterSlash : afterSlash.slice(0, spaceIdx);
        const hasSubToken = spaceIdx !== -1;
        const subToken = hasSubToken ? afterSlash.slice(spaceIdx + 1) : '';

        return buildSuggestions(commands, { currentToken, hasSubToken, subToken })
            .map((suggestion) => ({
                ...suggestion,
                trigger: '/',
                group: 'Commands'
            }));
    }

    function applySelection(value, suggestion) {
        if (!suggestion) return null;
        if (suggestion.insertText) {
            return applySlashInsertTextToValue(value, suggestion.insertText);
        }
        if (suggestion.command) {
            return applySlashSelectionToValue(value, suggestion.command);
        }
        return null;
    }

    async function refresh() {
        commands = await fetchCommandsFromAgent(agentName, dlog);
        dlog?.('SlashCommandsProvider: loaded', commands.length, 'commands');
    }

    return {
        trigger: '/',
        groupLabel: 'Commands',
        detectTrigger,
        getSuggestions,
        applySelection,
        refresh
    };
}
