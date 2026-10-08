import test from 'node:test';
import assert from 'node:assert/strict';

import { createStartupCatalogRefresh } from '../../cli/server/webchat/startupCatalogRefresh.js';
import { createSlashCommandsProvider } from '../../cli/server/webchat/slashAutocomplete.js';

function fakeTimers() {
    const pending = new Map();
    let next = 1;
    return {
        setTimer: (fn) => { pending.set(next, fn); return next++; },
        clearTimer: (id) => pending.delete(id),
        fire: () => { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
        size: () => pending.size,
    };
}

// Mirrors the wiring in webchat/index.js: bootstrap schedules the first load,
// a selected session cancels it and refreshes with the session id.
function pageHarness() {
    const timers = fakeTimers();
    const toolCalls = [];
    let sessionId = '';
    const originalFetch = globalThis.fetch;
    const originalLocation = globalThis.location;
    globalThis.location = new URL('http://localhost/');
    globalThis.fetch = async (url, options = {}) => {
        if (new URL(url, 'http://localhost').pathname === '/auth/token') {
            return Response.json({ browserMutation: { csrfToken: 'p', routeKey: 'achilles-cli', origin: 'http://localhost' } });
        }
        const payload = JSON.parse(options.body || '{}');
        if (payload.method === 'initialize') {
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: {} }),
                { status: 200, headers: { 'mcp-session-id': 's' } });
        }
        if (payload.method === 'notifications/initialized') return new Response(null, { status: 202 });
        if (payload.method === 'tools/list') {
            return Response.json({ jsonrpc: '2.0', id: payload.id, result: { tools: [{
                name: 'list_achilles_cli_commands',
                inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } } },
            }] } });
        }
        toolCalls.push(payload.params.arguments);
        return Response.json({ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: JSON.stringify({
            type: 'achilles-slash-command-catalog', commands: [{ name: '/model' }],
        }) }] } });
    };
    const provider = createSlashCommandsProvider({
        agentName: 'achilles-cli',
        getCatalogArguments: () => (sessionId ? { sessionId } : {}),
    });
    const startup = createStartupCatalogRefresh({
        refresh: () => provider.refresh(),
        getSessionId: () => sessionId,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
    });
    let modelKey = '';
    const onSessionState = async (id) => {
        sessionId = id;
        if (id !== modelKey) {
            modelKey = id;
            startup.cancel();
            await provider.refresh();
        }
    };
    return {
        timers, toolCalls, startup, onSessionState, provider,
        restore() {
            globalThis.fetch = originalFetch;
            if (originalLocation === undefined) delete globalThis.location;
            else globalThis.location = originalLocation;
        },
    };
}

test('bootstrap followed by a session state loads the catalog once, with the session id', async () => {
    const page = pageHarness();
    try {
        page.startup.schedule();
        assert.equal(page.toolCalls.length, 0, 'bootstrap does not start a sessionless load');
        await page.onSessionState('session-1');
        assert.equal(page.timers.size(), 0, 'the fallback timer is cancelled');
        page.timers.fire();
        assert.deepEqual(page.toolCalls, [{ sessionId: 'session-1' }]);
    } finally { page.restore(); }
});

test('a page with no session still loads the catalog exactly once', async () => {
    const page = pageHarness();
    try {
        page.startup.schedule();
        assert.equal(page.toolCalls.length, 0);
        page.timers.fire();
        await page.provider.refresh();
        assert.deepEqual(page.toolCalls, [{}]);
    } finally { page.restore(); }
});

test('a later session change still refreshes the catalog', async () => {
    const page = pageHarness();
    try {
        page.startup.schedule();
        await page.onSessionState('session-1');
        await page.onSessionState('session-2');
        assert.deepEqual(page.toolCalls, [{ sessionId: 'session-1' }, { sessionId: 'session-2' }]);
    } finally { page.restore(); }
});

test('a session already known at bootstrap loads immediately without a timer', async () => {
    let calls = 0;
    const timers = fakeTimers();
    const startup = createStartupCatalogRefresh({
        refresh: () => { calls += 1; }, getSessionId: () => 'known',
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    startup.schedule();
    assert.equal(calls, 1);
    assert.equal(timers.size(), 0);
});
