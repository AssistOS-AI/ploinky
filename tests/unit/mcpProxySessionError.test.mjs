// The webchat slash provider (a browser module) re-initializes its MCP session
// only when it recognizes the Router's "session invalid" answer. It cannot
// import the Router's constant, so this test keeps the copies from drifting
// and checks what the real proxy sends.
import '../helpers/isolatedWorkspaceRoot.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { MCP_SESSION_INVALID_ERROR } from '../../cli/server/mcp-proxy/sessionErrors.js';
import { ROUTER_MCP_SESSION_INVALID_ERROR } from '../../cli/server/webchat/autocompleteProviders/slashCommands.js';

class MockResponse {
    constructor() {
        this.statusCode = 0;
        this.headers = {};
        this.body = '';
    }

    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = { ...headers };
    }

    end(body = '') {
        this.body += body === undefined ? '' : String(body);
    }
}

test('the browser copy of the Router session error equals the Router constant', () => {
    assert.deepEqual({ ...ROUTER_MCP_SESSION_INVALID_ERROR }, { ...MCP_SESSION_INVALID_ERROR });
});

test('the agent MCP proxy answers an unknown session with HTTP 200 and exactly that error', async () => {
    const proxy = await import('../../cli/server/mcp-proxy/index.js');
    for (const [label, headers] of [
        ['no session header', {}],
        ['unknown session', { 'mcp-session-id': 'expired-or-lost-session' }],
    ]) {
        for (const method of ['tools/list', 'tools/call']) {
            const res = new MockResponse();
            const req = { method: 'POST', headers, url: '/achilles-cli/mcp' };
            await proxy.handleAgentJsonRpc(req, res, { hostPort: 1 }, 'achilles-cli',
                { jsonrpc: '2.0', id: 'probe', method, params: method === 'tools/call' ? { name: 'x', arguments: {} } : undefined });
            assert.equal(res.statusCode, 200, `${label} ${method}`);
            const body = JSON.parse(res.body);
            assert.deepEqual(body, { jsonrpc: '2.0', id: 'probe', error: { ...ROUTER_MCP_SESSION_INVALID_ERROR } }, `${label} ${method}`);
            assert.equal(res.headers['mcp-session-id'], undefined);
        }
    }
});

test('the aggregate Router MCP handler sends the same session error text', () => {
    const source = fs.readFileSync(new URL('../../cli/server/routerHandlers.js', import.meta.url), 'utf8');
    assert.ok(source.includes(`error: { code: ${MCP_SESSION_INVALID_ERROR.code}, message: '${MCP_SESSION_INVALID_ERROR.message}' }`),
        'routerHandlers.js no longer sends the shared session error');
});
