import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applySlashSelectionToValue,
    buildSuggestions,
    createSlashCommandsProvider,
    loadSlashCommandsWithRetry,
} from '../../cli/server/webchat/slashAutocomplete.js';

test('applySlashSelectionToValue replaces a bare slash without leaving a trailing slash', () => {
    const result = applySlashSelectionToValue('/', {
        name: '/build',
        subCommands: []
    });

    assert.deepEqual(result, {
        value: '/build ',
        cursor: '/build '.length
    });
});

test('applySlashSelectionToValue replaces a partial command token', () => {
    const result = applySlashSelectionToValue('/bu', {
        name: '/build',
        subCommands: []
    });

    assert.deepEqual(result, {
        value: '/build ',
        cursor: '/build '.length
    });
});

test('applySlashSelectionToValue ignores slashes that are not at the start', () => {
    const result = applySlashSelectionToValue('please run /bu', {
        name: '/build',
        subCommands: []
    });

    assert.equal(result, null);
});

test('slash provider loads MCP catalog with streamable HTTP headers and preserves slashes in arguments', async () => {
    const originalFetch = globalThis.fetch;
    const originalLocation = globalThis.location;
    const originalDocument = globalThis.document;
    const requests = [];
    globalThis.document = {
        body: {
            dataset: {
                agentQuery: 'robot=analyst&sessionId=stale-url-session&unrelated=not-forwarded',
                workdir: '/workspace/project',
            },
        },
    };
    globalThis.fetch = async (url, options = {}) => {
        const parsedUrl = new URL(url, 'http://localhost');
        if (parsedUrl.pathname === '/auth/token') {
            return Response.json({
                browserMutation: {
                    csrfToken: 'browser-proof',
                    routeKey: 'achilles-cli',
                    origin: 'http://localhost',
                },
            });
        }
        const headers = new Headers(options.headers);
        const payload = JSON.parse(options.body || '{}');
        requests.push({ url, headers, payload });

        if (payload.method === 'initialize') {
            return new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: payload.id,
                result: { protocolVersion: '2024-11-05', capabilities: {} },
            }), {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                    'mcp-session-id': 'test-session',
                },
            });
        }
        if (payload.method === 'notifications/initialized') {
            return new Response(null, { status: 202 });
        }
        if (payload.method === 'tools/list') {
            return Response.json({
                jsonrpc: '2.0',
                id: payload.id,
                result: { tools: [{ name: 'list_achilles_cli_commands', inputSchema: {
                    type: 'object', properties: { robot: { type: 'string' }, dir: { type: 'string' }, sessionId: { type: 'string' } },
                } }] },
            });
        }
        if (payload.method === 'tools/call') {
            const catalog = {
                type: 'achilles-slash-command-catalog',
                commands: [{
                    name: '/model',
                    description: 'Select a model',
                    argMatchMode: 'fragment',
                    subCommands: [{
                        name: 'anthropic/claude-sonnet-4-6',
                        description: 'Anthropic Sonnet',
                        argCompletions: ['default', 'low', 'high'],
                    }],
                }],
            };
            return Response.json({
                jsonrpc: '2.0',
                id: payload.id,
                result: { content: [{ type: 'text', text: JSON.stringify(catalog) }] },
            });
        }
        throw new Error(`Unexpected MCP method: ${payload.method}`);
    };
    globalThis.location = new URL('http://localhost/');

    try {
        const logs = [];
        const provider = createSlashCommandsProvider({
            agentName: 'achilles-cli',
            getCatalogArguments: () => ({ sessionId: 'active-conversation' }),
            dlog: (...args) => logs.push(args),
        });
        await provider.refresh();

        assert.ok(requests.length >= 4, JSON.stringify({ requests: requests.map(({ payload }) => payload.method), logs }));
        assert.ok(requests.every(({ headers }) =>
            headers.get('accept') === 'application/json, text/event-stream'
        ));
        const catalogRequest = requests.find(({ payload }) => payload.method === 'tools/call');
        assert.equal(catalogRequest.payload.params.arguments.dir, '/workspace/project');
        assert.equal(catalogRequest.payload.params.arguments.robot, 'analyst');
        assert.equal(catalogRequest.payload.params.arguments.sessionId, 'active-conversation');
        assert.equal(catalogRequest.payload.params.arguments.unrelated, undefined);
        assert.deepEqual(
            provider.getSuggestions('/model anthropic/claude', '/model anthropic/claude'.length)
                .map((suggestion) => suggestion.insertText),
            ['/model anthropic/claude-sonnet-4-6 ']
        );
        assert.deepEqual(provider.getSuggestions('text /model anthropic', 21), []);
        const modelInput = '/model anthropic/claude';
        const model = provider.getSuggestions(modelInput, modelInput.length)[0];
        assert.equal(model.keepMenuOpen, true);
        const efforts = provider.getSuggestions(model.insertText, model.insertText.length);
        assert.deepEqual(efforts.map((suggestion) => suggestion.insertText), [
            '/model anthropic/claude-sonnet-4-6 default ',
            '/model anthropic/claude-sonnet-4-6 low ',
            '/model anthropic/claude-sonnet-4-6 high ',
        ]);
        assert.ok(efforts.every((suggestion) => suggestion.keepMenuOpen === false));
        const effortInput = '/model anthropic/claude-sonnet-4-6 hi';
        assert.deepEqual(provider.getSuggestions(effortInput, effortInput.length)
            .map((suggestion) => suggestion.insertText), ['/model anthropic/claude-sonnet-4-6 high ']);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalLocation === undefined) delete globalThis.location;
        else globalThis.location = originalLocation;
        globalThis.document = originalDocument;
    }
});

test('slash catalog loading retries transient startup failures with the configured backoff', async () => {
    const waits = [];
    let attempts = 0;
    const commands = await loadSlashCommandsWithRetry(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('Agent is still starting.');
        return [{ name: '/model' }];
    }, {
        retryDelays: [250, 500, 1000],
        wait: async (delayMs) => waits.push(delayMs),
    });

    assert.equal(attempts, 3);
    assert.deepEqual(waits, [250, 500]);
    assert.deepEqual(commands, [{ name: '/model' }]);
});

test('slash catalog loading stops after exhausting the retry window', async () => {
    const waits = [];
    let attempts = 0;
    const commands = await loadSlashCommandsWithRetry(async () => {
        attempts += 1;
        throw new Error('Agent is still starting.');
    }, {
        retryDelays: [250, 500],
        wait: async (delayMs) => waits.push(delayMs),
    });

    assert.equal(attempts, 3);
    assert.deepEqual(waits, [250, 500]);
    assert.deepEqual(commands, []);
});

test('slash catalog loading uses the bounded default startup retry window', async () => {
    const waits = [];
    let attempts = 0;
    const commands = await loadSlashCommandsWithRetry(async () => {
        attempts += 1;
        throw new Error('Agent is still starting.');
    }, {
        wait: async (delayMs) => waits.push(delayMs),
    });

    assert.equal(attempts, 18);
    assert.deepEqual(waits.slice(0, 3), [250, 500, 1000]);
    assert.deepEqual(waits.slice(3), Array(14).fill(2000));
    assert.equal(waits.reduce((total, delayMs) => total + delayMs, 0), 29_750);
    assert.deepEqual(commands, []);
});

test('slash catalog loading does not retry a valid empty catalog or access denial', async () => {
    let validAttempts = 0;
    const validCommands = await loadSlashCommandsWithRetry(async () => {
        validAttempts += 1;
        return [];
    }, {
        retryDelays: [250],
        wait: async () => assert.fail('valid empty catalogs must not wait'),
    });

    let deniedAttempts = 0;
    const deniedCommands = await loadSlashCommandsWithRetry(async () => {
        deniedAttempts += 1;
        const error = new Error('Access denied.');
        error.retryable = false;
        throw error;
    }, {
        retryDelays: [250],
        wait: async () => assert.fail('access denials must not wait'),
    });

    assert.equal(validAttempts, 1);
    assert.deepEqual(validCommands, []);
    assert.equal(deniedAttempts, 1);
    assert.deepEqual(deniedCommands, []);
});

test('slash provider deduplicates concurrent initial catalog refreshes', async () => {
    let fetchCount = 0;
    let releaseInitialize;
    const initializeGate = new Promise((resolve) => {
        releaseInitialize = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options = {}) => {
        const payload = JSON.parse(options.body || '{}');
        if (payload.method === 'initialize') {
            fetchCount += 1;
            await initializeGate;
            return new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: payload.id,
                result: { protocolVersion: '2024-11-05', capabilities: {} },
            }), {
                status: 200,
                headers: { 'mcp-session-id': 'deduplicated-session' },
            });
        }
        if (payload.method === 'notifications/initialized') {
            return new Response(null, { status: 204 });
        }
        if (payload.method === 'tools/list') {
            return Response.json({
                jsonrpc: '2.0',
                id: payload.id,
                result: { tools: [] },
            });
        }
        throw new Error(`Unexpected MCP method: ${payload.method}`);
    };

    try {
        const provider = createSlashCommandsProvider({ agentName: 'achilles-cli' });
        const first = provider.refresh();
        const second = provider.refresh();
        releaseInitialize();
        await Promise.all([first, second]);
        assert.equal(fetchCount, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('slash provider retries an MCP initialization response while the agent is starting', async () => {
    const originalFetch = globalThis.fetch;
    const waits = [];
    let initializeAttempts = 0;
    globalThis.fetch = async (_url, options = {}) => {
        const payload = JSON.parse(options.body || '{}');
        if (payload.method === 'initialize') {
            initializeAttempts += 1;
            if (initializeAttempts === 1) {
                return Response.json({
                    jsonrpc: '2.0',
                    id: payload.id,
                    error: { code: -32000, message: 'Agent is still starting.' },
                });
            }
            return new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: payload.id,
                result: { protocolVersion: '2024-11-05', capabilities: {} },
            }), {
                status: 200,
                headers: { 'mcp-session-id': 'ready-session' },
            });
        }
        if (payload.method === 'notifications/initialized') {
            return new Response(null, { status: 204 });
        }
        if (payload.method === 'tools/list') {
            return Response.json({
                jsonrpc: '2.0',
                id: payload.id,
                result: { tools: [] },
            });
        }
        throw new Error(`Unexpected MCP method: ${payload.method}`);
    };

    try {
        const provider = createSlashCommandsProvider({
            agentName: 'achilles-cli',
            retryDelays: [250],
            wait: async (delayMs) => waits.push(delayMs),
        });
        await provider.refresh();
        assert.equal(initializeAttempts, 2);
        assert.deepEqual(waits, [250]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('slash provider does not retry an MCP access denial', async () => {
    const originalFetch = globalThis.fetch;
    let initializeAttempts = 0;
    globalThis.fetch = async () => {
        initializeAttempts += 1;
        return Response.json({ error: 'forbidden' }, { status: 403 });
    };

    try {
        const provider = createSlashCommandsProvider({
            agentName: 'achilles-cli',
            retryDelays: [250],
            wait: async () => assert.fail('access denials must not wait'),
        });
        await provider.refresh();
        assert.equal(initializeAttempts, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('buildSuggestions uses generic argument completions for first command argument', () => {
    const suggestions = buildSuggestions([{
        name: '/exec',
        description: 'Execute any skill directly',
        subCommands: [],
        argCompletions: [
            { value: 'admin-flow', label: 'admin-flow', description: 'Admin flow' },
            { value: 'load-admin-context', label: 'load-admin-context', description: '' }
        ]
    }], {
        currentToken: 'exec',
        hasSubToken: true,
        subToken: 'adm'
    });

    assert.deepEqual(suggestions.map((suggestion) => ({
        label: suggestion.label,
        insertText: suggestion.insertText,
        description: suggestion.description
    })), [{
        label: '/exec admin-flow',
        insertText: '/exec admin-flow ',
        description: 'Admin flow'
    }]);
});

test('buildSuggestions keeps every model accessible while ranking inner-fragment matches', () => {
    const modelCompletions = Array.from({ length: 12 }, (_, index) => ({
        value: `provider/model-${index}`,
        label: `provider/model-${index}`,
        description: index === 10 ? 'Anthropic Sonnet' : 'Provider model',
    }));
    modelCompletions.unshift({
        value: 'anthropic/claude-sonnet-4-6',
        label: 'anthropic/claude-sonnet-4-6',
        description: 'Anthropic · reasoning',
    });

    const recommendations = buildSuggestions([{
        name: '/model',
        description: 'Select a model',
        argMatchMode: 'fragment',
        subCommands: [],
        argCompletions: modelCompletions,
    }], {
        currentToken: 'model',
        hasSubToken: true,
        subToken: '',
    });
    assert.equal(recommendations.length, 13);

    const search = buildSuggestions([{
        name: '/model',
        description: 'Select a model',
        argMatchMode: 'fragment',
        subCommands: [],
        argCompletions: modelCompletions,
    }], {
        currentToken: 'model',
        hasSubToken: true,
        subToken: 'sonnet',
    });
    assert.equal(search[0].insertText, '/model anthropic/claude-sonnet-4-6 ');
    assert.equal(search.length, 2);
});

test('buildSuggestions stops suggesting an exact first argument after trailing space', () => {
    const commands = [{
        name: '/exec',
        description: 'Execute any skill directly',
        subCommands: [],
        argCompletions: [
            { value: 'chat-completion', label: 'chat-completion', description: '' },
            { value: 'get-capabilities', label: 'get-capabilities', description: '' }
        ]
    }];

    assert.deepEqual(buildSuggestions(commands, {
        currentToken: 'exec',
        hasSubToken: true,
        subToken: 'chat-completion '
    }), []);
    assert.deepEqual(buildSuggestions(commands, {
        currentToken: 'exec',
        hasSubToken: true,
        subToken: 'chat-completion h'
    }), []);
});

test('buildSuggestions keeps multiline skill help ahead of the command description', () => {
    const help = [
        'Use this for WebAdmin requests.',
        'Example: /exec admin-flow change admin email to user@example.com'
    ].join('\n');
    const suggestions = buildSuggestions([{
        name: '/exec',
        description: 'Execute any skill directly',
        subCommands: [],
        argCompletions: [
            { value: 'admin-flow', label: 'admin-flow', description: help }
        ]
    }], {
        currentToken: 'exec',
        hasSubToken: true,
        subToken: 'admin'
    });

    assert.equal(suggestions[0].description, help);
});

test('buildSuggestions keeps subcommand completions ahead of generic argument completions', () => {
    const suggestions = buildSuggestions([{
        name: '/list',
        description: 'List items',
        subCommands: ['skills', 'repos'],
        argCompletions: [{ value: 'something', label: 'something', description: '' }]
    }], {
        currentToken: 'list',
        hasSubToken: true,
        subToken: 'sk'
    });

    assert.deepEqual(suggestions.map((suggestion) => suggestion.insertText), ['/list skills ']);
});

test('buildSuggestions keeps menu open after selecting a command with argument completions', () => {
    const suggestions = buildSuggestions([{
        name: '/exec',
        description: 'Execute any skill directly',
        subCommands: [],
        argCompletions: [{ value: 'admin-flow', label: 'admin-flow', description: '' }]
    }], {
        currentToken: 'ex',
        hasSubToken: false,
        subToken: ''
    });

    assert.equal(suggestions[0].insertText, '/exec ');
    assert.equal(suggestions[0].keepMenuOpen, true);
});

test('buildSuggestions supports subcommand argument completions', () => {
    const suggestions = buildSuggestions([{
        name: '/remove',
        description: 'Remove items',
        subCommands: [{
            name: 'skill',
            description: 'Delete a skill directory',
            argCompletions: [
                { value: 'admin-flow', label: 'admin-flow', description: 'Admin flow' },
                { value: 'load-admin-context', label: 'load-admin-context', description: '' }
            ]
        }]
    }], {
        currentToken: 'remove',
        hasSubToken: true,
        subToken: 'skill adm'
    });

    assert.deepEqual(suggestions.map((suggestion) => ({
        label: suggestion.label,
        insertText: suggestion.insertText,
        description: suggestion.description
    })), [{
        label: '/remove skill admin-flow',
        insertText: '/remove skill admin-flow ',
        description: 'Admin flow'
    }]);
});

test('model subcommands offer only the selected model efforts and keep default terminal', () => {
    const commands = [{ name: '/model', subCommands: [
        { name: 'default', argCompletions: [] },
        { name: 'provider/first', argCompletions: ['default', 'low', 'high'] },
        { name: 'provider/second', argCompletions: ['default', 'medium'] },
        { name: 'legacy', argCompletions: [] },
    ] }];
    const suggest = (subToken) => buildSuggestions(commands, {
        currentToken: 'model', hasSubToken: true, subToken,
    });
    assert.deepEqual(suggest('').map((entry) => entry.insertText), [
        '/model default ', '/model provider/first ', '/model provider/second ', '/model legacy ',
    ]);
    assert.deepEqual(suggest('').map((entry) => entry.keepMenuOpen), [false, true, true, false]);
    assert.deepEqual(suggest('provider/second ').map((entry) => entry.insertText), [
        '/model provider/second default ', '/model provider/second medium ',
    ]);
    assert.deepEqual(suggest('default '), []);
    assert.deepEqual(suggest('legacy '), []);
});

test('buildSuggestions displays session names while inserting resume session ids', () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const suggestions = buildSuggestions([{
        name: '/session',
        description: 'Select a conversation session',
        subCommands: [{
            name: 'resume',
            description: 'Resume a saved session',
            argCompletions: [{
                value: sessionId,
                label: 'Review authentication flow',
                description: `${sessionId} · 2 hours ago`,
            }],
        }],
    }], {
        currentToken: 'session',
        hasSubToken: true,
        subToken: 'resume ',
    });

    assert.deepEqual(suggestions.map((suggestion) => ({
        label: suggestion.label,
        insertText: suggestion.insertText,
        description: suggestion.description,
    })), [{
        label: '/session resume Review authentication flow',
        insertText: `/session resume ${sessionId} `,
        description: `${sessionId} · 2 hours ago`,
    }]);
});

test('buildSuggestions keeps menu open after selecting a subcommand with argument completions', () => {
    const suggestions = buildSuggestions([{
        name: '/remove',
        description: 'Remove items',
        subCommands: [{
            name: 'skill',
            description: 'Delete a skill directory',
            argCompletions: [{ value: 'admin-flow', label: 'admin-flow', description: '' }]
        }]
    }], {
        currentToken: 'remove',
        hasSubToken: true,
        subToken: 'sk'
    });

    assert.equal(suggestions[0].insertText, '/remove skill ');
    assert.equal(suggestions[0].keepMenuOpen, true);
});

test('buildSuggestions supports commands that have both subcommands and argument completions', () => {
    const suggestions = buildSuggestions([{
        name: '/update',
        description: 'Update items',
        subCommands: [{ name: 'repos', description: 'Pull all cloned repositories', argCompletions: [] }],
        argCompletions: [{ value: 'admin-flow', label: 'admin-flow', description: 'Admin flow' }]
    }], {
        currentToken: 'update',
        hasSubToken: true,
        subToken: ''
    });

    assert.deepEqual(suggestions.map((suggestion) => suggestion.insertText), [
        '/update repos ',
        '/update admin-flow '
    ]);
});

function mcpHarness({ onToolsCall, onToolsList } = {}) {
    const calls = [];
    let sessions = 0;
    const fetchImpl = async (url, options = {}) => {
        const parsedUrl = new URL(url, 'http://localhost');
        if (parsedUrl.pathname === '/auth/token') {
            return Response.json({
                browserMutation: { csrfToken: 'proof', routeKey: 'achilles-cli', origin: 'http://localhost' },
            });
        }
        const payload = JSON.parse(options.body || '{}');
        const sessionHeader = new Headers(options.headers).get('mcp-session-id');
        calls.push({ method: payload.method, session: sessionHeader });
        if (payload.method === 'initialize') {
            sessions += 1;
            return new Response(JSON.stringify({
                jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2024-11-05', capabilities: {} },
            }), { status: 200, headers: { 'mcp-session-id': `session-${sessions}` } });
        }
        if (payload.method === 'notifications/initialized') return new Response(null, { status: 202 });
        if (payload.method === 'tools/list') {
            if (onToolsList) { const r = onToolsList({ sessionHeader, calls }); if (r) return r; }
            return Response.json({ jsonrpc: '2.0', id: payload.id, result: { tools: [{ name: 'list_achilles_cli_commands' }] } });
        }
        if (payload.method === 'tools/call') return onToolsCall({ payload, sessionHeader, calls });
        throw new Error(`Unexpected MCP method: ${payload.method}`);
    };
    return { calls, fetchImpl };
}

async function withMcp(harness, fn) {
    const originalFetch = globalThis.fetch;
    const originalLocation = globalThis.location;
    globalThis.fetch = harness.fetchImpl;
    globalThis.location = new URL('http://localhost/');
    try {
        return await fn();
    } finally {
        globalThis.fetch = originalFetch;
        if (originalLocation === undefined) delete globalThis.location;
        else globalThis.location = originalLocation;
    }
}

const catalogResult = (payload) => Response.json({
    jsonrpc: '2.0', id: payload.id,
    result: { content: [{ type: 'text', text: JSON.stringify({
        type: 'achilles-slash-command-catalog', commands: [{ name: '/model' }],
    }) }] },
});

test('slash provider stops after two attempts when the catalog tool reports isError', async () => {
    const harness = mcpHarness({
        onToolsCall: ({ payload }) => Response.json({
            jsonrpc: '2.0', id: payload.id,
            result: { isError: true, content: [{ type: 'text', text: 'Error: catalog backend not ready' }] },
        }),
    });
    const waits = [];
    await withMcp(harness, async () => {
        const provider = createSlashCommandsProvider({ agentName: 'achilles-cli', wait: async (ms) => waits.push(ms) });
        await provider.refresh();
    });
    const count = (method) => harness.calls.filter((call) => call.method === method).length;
    assert.equal(count('tools/call'), 2);
    assert.equal(count('initialize'), 1, 'the MCP session is reused across attempts');
    assert.equal(count('notifications/initialized'), 1);
    assert.deepEqual(waits, [250]);
});

test('slash provider stops after two attempts on an unparsable catalog text', async () => {
    const harness = mcpHarness({
        onToolsCall: ({ payload }) => Response.json({
            jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: '<html>oops' }] },
        }),
    });
    await withMcp(harness, async () => {
        const provider = createSlashCommandsProvider({ agentName: 'achilles-cli', wait: async () => {} });
        assert.deepEqual(await provider.refresh(), []);
    });
    assert.equal(harness.calls.filter((call) => call.method === 'tools/call').length, 2);
});

test('slash provider recovers from one isError and keeps the session', async () => {
    let n = 0;
    const harness = mcpHarness({
        onToolsCall: ({ payload }) => (++n === 1
            ? Response.json({ jsonrpc: '2.0', id: payload.id, result: { isError: true, content: [{ type: 'text', text: 'warming up' }] } })
            : catalogResult(payload)),
    });
    await withMcp(harness, async () => {
        const provider = createSlashCommandsProvider({ agentName: 'achilles-cli', wait: async () => {} });
        const commands = await provider.refresh();
        assert.deepEqual(commands.map((c) => c.name), ['/model']);
    });
    assert.equal(harness.calls.filter((call) => call.method === 'initialize').length, 1);
});

test('slash provider keeps the full retry schedule for transport failures while reusing the session', async () => {
    let n = 0;
    const harness = mcpHarness({
        onToolsCall: ({ payload }) => (++n < 4
            ? new Response('bad gateway', { status: 502 })
            : catalogResult(payload)),
    });
    const waits = [];
    await withMcp(harness, async () => {
        const provider = createSlashCommandsProvider({ agentName: 'achilles-cli', wait: async (ms) => waits.push(ms) });
        const commands = await provider.refresh();
        assert.deepEqual(commands.map((c) => c.name), ['/model']);
    });
    assert.deepEqual(waits, [250, 500, 1000]);
    assert.equal(harness.calls.filter((call) => call.method === 'initialize').length, 1);
});

test('slash provider re-initializes only when the MCP session is reported invalid', async () => {
    const harness = mcpHarness({
        onToolsList: ({ sessionHeader }) => (sessionHeader === 'session-1'
            ? Response.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } }, { status: 404 })
            : null),
        onToolsCall: ({ payload }) => catalogResult(payload),
    });
    await withMcp(harness, async () => {
        const provider = createSlashCommandsProvider({ agentName: 'achilles-cli', wait: async () => {} });
        const commands = await provider.refresh();
        assert.deepEqual(commands.map((c) => c.name), ['/model']);
    });
    assert.equal(harness.calls.filter((call) => call.method === 'initialize').length, 2);
    const toolsCall = harness.calls.find((call) => call.method === 'tools/call');
    assert.equal(toolsCall.session, 'session-2');
});

// The browser talks to the Router's MCP proxy, which answers an unknown or
// expired session (for example after a Router restart) with HTTP 200 and
// JSON-RPC -32000 'Missing or invalid MCP session' instead of the agent's 404.
const ROUTER_SESSION_ERROR = (payload) => Response.json({
    jsonrpc: '2.0', id: payload?.id ?? null, error: { code: -32000, message: 'Missing or invalid MCP session' },
});

test('slash provider re-initializes when the Router proxy reports the session invalid at tools/list', async () => {
    const harness = mcpHarness({
        onToolsList: ({ sessionHeader }) => (sessionHeader === 'session-1' ? ROUTER_SESSION_ERROR({ id: 'wc-tools-1' }) : null),
        onToolsCall: ({ payload }) => catalogResult(payload),
    });
    await withMcp(harness, async () => {
        const provider = createSlashCommandsProvider({ agentName: 'achilles-cli', retryDelays: [0, 0], wait: async () => {} });
        const commands = await provider.refresh();
        assert.deepEqual(commands.map((c) => c.name), ['/model']);
    });
    assert.equal(harness.calls.filter((call) => call.method === 'initialize').length, 2);
    assert.deepEqual(harness.calls.filter((call) => call.method === 'tools/list').map((call) => call.session), ['session-1', 'session-2']);
    assert.equal(harness.calls.find((call) => call.method === 'tools/call').session, 'session-2');
});

test('slash provider re-initializes when the Router proxy reports the session invalid at tools/call', async () => {
    const harness = mcpHarness({
        onToolsCall: ({ payload, sessionHeader }) => (sessionHeader === 'session-1' ? ROUTER_SESSION_ERROR(payload) : catalogResult(payload)),
    });
    await withMcp(harness, async () => {
        const provider = createSlashCommandsProvider({ agentName: 'achilles-cli', retryDelays: [0, 0], wait: async () => {} });
        const commands = await provider.refresh();
        assert.deepEqual(commands.map((c) => c.name), ['/model']);
    });
    assert.equal(harness.calls.filter((call) => call.method === 'initialize').length, 2);
    assert.deepEqual(harness.calls.filter((call) => call.method === 'tools/call').map((call) => call.session), ['session-1', 'session-2']);
});

test('a Router -32000 that is not the session error keeps the session and retries', async () => {
    let n = 0;
    const harness = mcpHarness({
        onToolsCall: ({ payload }) => (++n === 1
            ? Response.json({ jsonrpc: '2.0', id: payload.id, error: { code: -32000, message: 'upstream agent unavailable' } })
            : catalogResult(payload)),
    });
    await withMcp(harness, async () => {
        const provider = createSlashCommandsProvider({ agentName: 'achilles-cli', retryDelays: [0, 0], wait: async () => {} });
        const commands = await provider.refresh();
        assert.deepEqual(commands.map((c) => c.name), ['/model']);
    });
    assert.equal(harness.calls.filter((call) => call.method === 'initialize').length, 1);
    assert.equal(harness.calls.filter((call) => call.method === 'tools/call').length, 2);
});
