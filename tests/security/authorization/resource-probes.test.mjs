import test from 'node:test';
import assert from 'node:assert/strict';
import { assertResourceDenied, createResourceMcp, decodeResourceMcp } from './resource-probes.mjs';

const textBlock = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) });
const rpcResponse = (result, overrides = {}) => ({ status: 200, json: { jsonrpc: '2.0', id: 'mock', result }, ...overrides });

for (const failure of [{ ok: false, error: 'forbidden' }, { isError: true, error: 'forbidden' }]) {
    test(`structuredContent ${JSON.stringify(failure)} overrides successful stdout`, () => {
        const decoded = decodeResourceMcp(rpcResponse({ structuredContent: failure, content: [textBlock({ ok: true })] }));
        assert.equal(decoded.failed, true);
        assert.equal(decoded.value, failure);
        assert.match(decoded.error, /forbidden/);
    });
}

test('first JSON stdout is parsed when AgentServer also emits stderr', () => {
    const decoded = decodeResourceMcp(rpcResponse({ content: [textBlock({ ok: true, object: { id: 'owned' } }), textBlock('stderr:\nlocal diagnostic')] }));
    assert.equal(decoded.failed, false);
    assert.equal(decoded.value.object.id, 'owned');
});

test('stderr does not hide a JSON stdout authorization failure', () => {
    const decoded = decodeResourceMcp(rpcResponse({ content: [textBlock({ ok: false, error: 'forbidden' }), textBlock('stderr:\nlocal diagnostic')] }));
    assert.equal(decoded.failed, true);
    assertResourceDenied(decoded, 'mock');
});

test('raw file stdout is preserved when stderr follows', () => {
    const decoded = decodeResourceMcp(rpcResponse({ content: [textBlock('authz-fixture-content'), textBlock('stderr:\nlocal diagnostic')] }));
    assert.equal(decoded.failed, false);
    assert.deepEqual(decoded.value, { rawText: 'authz-fixture-content' });
});

test('every result projection participates in failure detection', () => {
    for (const result of [
        { ok: false, error: 'forbidden', content: [textBlock({ ok: true })] },
        { isError: true, content: [textBlock('forbidden')] },
        { structuredContent: { ok: true }, content: [textBlock({ ok: false, error: 'forbidden' })] },
        { structuredContent: { ok: true }, content: [{ type: 'json', json: { isError: true, error: 'forbidden' } }] },
        { content: [{ type: 'json', json: { ok: true } }, { type: 'json', json: { ok: false, error: 'forbidden' } }] },
    ]) {
        const decoded = decodeResourceMcp(rpcResponse(result));
        assert.equal(decoded.failed, true);
        assertResourceDenied(decoded, 'mock');
    }
});

test('absent or malformed MCP results cannot establish success', () => {
    for (const result of [undefined, null, false, [], 'success', {}]) {
        assert.equal(decodeResourceMcp(rpcResponse(result)).failed, true);
    }
    assert.equal(decodeResourceMcp({ status: 200, json: { jsonrpc: '2.0', error: { message: 'forbidden' } } }).failed, true);
});

test('marker checks include all wire projections, including ignored stdout and raw response', () => {
    for (const response of [
        rpcResponse({ structuredContent: { ok: false, error: 'forbidden' }, content: [textBlock('private-fixture-marker')] }),
        rpcResponse({ content: [textBlock({ ok: false, error: 'forbidden' })], metadata: { leaked: 'private-fixture-marker' } }),
        rpcResponse({ content: [textBlock({ ok: false, error: 'forbidden' })] }, { text: 'private-fixture-marker' }),
    ]) assert.throws(() => assertResourceDenied(decodeResourceMcp(response), 'mock', 'private-fixture-marker'), /protected fixture content leaked/);
});

function mockContext(handler) {
    const calls = [];
    const cleanups = [];
    const events = [];
    const ctx = {
        secrets: new Set(),
        cleanup: (fn) => cleanups.push(fn),
        guard: async () => { events.push('guard'); },
        request: async (principal, request) => {
            calls.push({ principal, ...request });
            events.push(`${request.method} ${request.path}`);
            return handler(principal, request);
        },
    };
    return { ctx, calls, cleanups, events };
}

function normalResponse(_principal, request) {
    if (request.method === 'GET') return { status: 200, json: { browserMutation: { routeKey: new URL(request.path, 'http://unused.invalid').searchParams.get('agent'), csrfToken: 'mock-csrf-secret' } } };
    if (request.method === 'DELETE') return { status: 204 };
    if (request.body?.method === 'initialize') return rpcResponse({ protocolVersion: '2025-06-18' }, { headers: { 'mcp-session-id': 'mock-session-secret' } });
    return rpcResponse({ content: [textBlock({ ok: true, object: { id: 'owned' } })] });
}

test('anonymous probe initializes the actual agent route without fetching auth proof', async () => {
    const { ctx, calls } = mockContext(() => ({ status: 401, json: { error: 'authentication_required' } }));
    const result = await createResourceMcp(ctx)('anonymous', 'dpuAgent', 'dpu_confidential_get', { id: 'owned' });
    assertResourceDenied(result, 'anonymous actual route');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/dpuAgent/mcp');
    assert.equal(calls[0].body.method, 'initialize');
    assert.equal(calls[0].headers['x-ploinky-browser-csrf-token'], undefined);
});

test('an exposed anonymous route proceeds to tools/call and exposes authorization success', async () => {
    const { ctx, calls } = mockContext(normalResponse);
    const result = await createResourceMcp(ctx)('anonymous', 'dpuAgent', 'dpu_confidential_get', { id: 'owned' });
    assert.equal(result.failed, false);
    assert.throws(() => assertResourceDenied(result, 'anonymous exposed route'), /forbidden operation succeeded/);
    assert.deepEqual(calls.map((call) => call.body.method), ['initialize', 'tools/call']);
    assert.deepEqual(calls[1].body.params, { name: 'dpu_confidential_get', arguments: { id: 'owned' } });
});

test('authenticated proof bootstrap failure is a setup failure, never an agent denial', async () => {
    const { ctx, calls } = mockContext(() => ({ status: 403, json: { error: 'forbidden' } }));
    await assert.rejects(() => createResourceMcp(ctx)('selfRegistered', 'dpuAgent', 'dpu_whoami'), /browser proof bootstrap failed/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/auth/token?agent=dpuAgent');
});

test('authenticated proof requires a token bound to the selected route', async () => {
    for (const proof of [{ routeKey: 'other', csrfToken: 'mock' }, { routeKey: 'dpuAgent' }]) {
        const { ctx, calls } = mockContext(() => ({ status: 200, json: { browserMutation: proof } }));
        await assert.rejects(() => createResourceMcp(ctx)('userA', 'dpuAgent', 'dpu_whoami'), /browser proof/);
        assert.equal(calls.length, 1);
    }
});

test('cached sessions and proof tokens are secret registered and close after resource fixtures', async () => {
    const { ctx, calls, cleanups, events } = mockContext(normalResponse);
    const mcp = createResourceMcp(ctx);
    await mcp('userA', 'dpuAgent', 'dpu_whoami');
    ctx.cleanup(async () => { events.push('fixture cleanup'); await mcp('userA', 'dpuAgent', 'dpu_confidential_delete', { id: 'owned' }); });
    await mcp('userA', 'dpuAgent', 'dpu_whoami');
    assert.equal(calls.filter((call) => call.body?.method === 'initialize').length, 1);
    assert.equal(ctx.secrets.has('mock-session-secret'), true);
    assert.equal(ctx.secrets.has('mock-csrf-secret'), true);
    for (const cleanup of [...cleanups].reverse()) await cleanup();
    assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
    const closed = calls.at(-1);
    assert.equal(closed.path, '/dpuAgent/mcp');
    assert.equal(closed.headers['mcp-session-id'], 'mock-session-secret');
    assert.equal(closed.headers['x-ploinky-browser-csrf-token'], 'mock-csrf-secret');
    assert.equal(closed.headers['mcp-protocol-version'], '2025-06-18');
    assert.ok(events.indexOf('fixture cleanup') < events.indexOf('DELETE /dpuAgent/mcp'));
    assert.equal(events.at(-2), 'guard');
});

test('all initialized sessions receive cleanup even if one close fails', async () => {
    const { ctx, calls, cleanups } = mockContext((principal, request) => request.method === 'DELETE'
        ? { status: principal === 'userA' ? 500 : 204 } : normalResponse(principal, request));
    const mcp = createResourceMcp(ctx);
    await mcp('userA', 'dpuAgent', 'dpu_whoami');
    await mcp('userB', 'explorer', 'list_allowed_directories');
    await assert.rejects(cleanups[0], /1 resource MCP session cleanup/);
    assert.deepEqual(calls.filter((call) => call.method === 'DELETE').map((call) => call.principal), ['userA', 'userB']);
});

test('session cleanup accepts only successful close or exact already-closed response', async () => {
    for (const [response, valid] of [
        [{ status: 404, json: { error: { code: -32001, message: 'Session not found' } } }, true],
        [{ status: 404, json: { error: 'route not found' } }, false],
        [{ status: 200, json: { error: { message: 'forbidden' } } }, false],
        [{ status: 403, json: { error: 'forbidden' } }, false],
    ]) {
        const { ctx, cleanups } = mockContext((principal, request) => request.method === 'DELETE' ? response : normalResponse(principal, request));
        await createResourceMcp(ctx)('userA', 'dpuAgent', 'dpu_whoami');
        if (valid) await cleanups[0]();
        else await assert.rejects(cleanups[0], /resource MCP session cleanup/);
    }
});
