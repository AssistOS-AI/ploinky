import assert from 'node:assert/strict';
import test from 'node:test';

import { createSlashCommandsProvider } from '../../cli/server/webchat/autocompleteProviders/slashCommands.js';

test('WebChat slash-command MCP discovery sends an exact route-scoped browser proof', async () => {
    const originalFetch = globalThis.fetch;
    const originalLocation = globalThis.location;
    const calls = [];
    globalThis.location = {
        href: 'http://127.0.0.1:8080/webchat?agent=achilles-cli',
        origin: 'http://127.0.0.1:8080',
    };
    globalThis.fetch = async (input, options = {}) => {
        const url = new URL(input, globalThis.location.href);
        if (url.pathname === '/auth/token') {
            calls.push({
                path: url.pathname,
                mutationRoute: url.searchParams.get('mutationRoute'),
                agent: url.searchParams.get('agent'),
            });
            return new Response(JSON.stringify({
                ok: true,
                browserMutation: {
                    origin: globalThis.location.origin,
                    csrfToken: 'v1.webchat-route-proof',
                    generation: 'generation-a',
                    routeKey: 'achilles-cli',
                },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        const headers = new Headers(options.headers || {});
        const body = JSON.parse(String(options.body || '{}'));
        calls.push({
            path: url.pathname,
            method: body.method,
            csrf: headers.get('x-ploinky-browser-csrf-token'),
            credentials: options.credentials,
        });
        if (body.method === 'initialize') {
            return new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: { protocolVersion: '2024-11-05', capabilities: {} },
            }), {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                    'mcp-session-id': 'session-webchat',
                },
            });
        }
        if (body.method === 'notifications/initialized') {
            return new Response(null, { status: 204 });
        }
        if (body.method === 'tools/list') {
            return new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: {
                    tools: [{ name: 'execute_demo', description: 'Run demo' }],
                },
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        return new Response('unexpected request', { status: 500 });
    };

    try {
        const provider = createSlashCommandsProvider({ agentName: 'achilles-cli' });
        await provider.refresh();
        assert.equal(provider.getSuggestions('/d', 2)[0]?.insertText, '/demo ');
    } finally {
        globalThis.fetch = originalFetch;
        if (originalLocation === undefined) delete globalThis.location;
        else globalThis.location = originalLocation;
    }

    assert.deepEqual(calls[0], {
        path: '/auth/token',
        mutationRoute: 'achilles-cli',
        agent: null,
    });
    const mcpCalls = calls.slice(1);
    assert.equal(mcpCalls.length, 3);
    assert.ok(mcpCalls.every((call) => (
        call.path === '/achilles-cli/mcp'
        && call.csrf === 'v1.webchat-route-proof'
        && call.credentials === 'include'
    )));
});
