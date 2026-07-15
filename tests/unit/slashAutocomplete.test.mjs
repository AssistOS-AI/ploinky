import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applySlashSelectionToValue,
    buildSuggestions,
    createSlashCommandsProvider,
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
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
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
                result: { tools: [{ name: 'list_achilles_cli_commands' }] },
            });
        }
        if (payload.method === 'tools/call') {
            const catalog = {
                type: 'achilles-slash-command-catalog',
                commands: [{
                    name: '/model',
                    description: 'Select a model',
                    argMatchMode: 'fragment',
                    argCompletions: [{
                        value: 'anthropic/claude-sonnet-4-6',
                        label: 'anthropic/claude-sonnet-4-6',
                        description: 'Anthropic Sonnet',
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

    try {
        const provider = createSlashCommandsProvider({ agentName: 'achilles-cli' });
        await provider.refresh();

        assert.ok(requests.length >= 4);
        assert.ok(requests.every(({ headers }) =>
            headers.get('accept') === 'application/json, text/event-stream'
        ));
        assert.deepEqual(
            provider.getSuggestions('/model anthropic/claude', '/model anthropic/claude'.length)
                .map((suggestion) => suggestion.insertText),
            ['/model anthropic/claude-sonnet-4-6 ']
        );
        assert.deepEqual(provider.getSuggestions('text /model anthropic', 21), []);
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
