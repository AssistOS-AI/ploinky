import test from 'node:test';
import assert from 'node:assert/strict';

import {
    enableMarketplaceAgent,
    handleMarketplaceRoutes,
} from '../../cli/server/authHandlers/marketplaceRoutes.js';

test('Marketplace publication denial precedes enable registry/filesystem mutation', async () => {
    let enableCalls = 0;
    const denial = new Error('Run this one-shot command from the host: ploinky enable agent demo/agent');
    denial.code = 'PLOINKY_OUTER_PUBLICATION_REQUIRED';

    await assert.rejects(
        () => enableMarketplaceAgent({ agentRef: 'demo/agent', mode: 'global' }, {
            async preflight() { throw denial; },
            enable() { enableCalls += 1; },
        }),
        (error) => error === denial && error.code === 'PLOINKY_OUTER_PUBLICATION_REQUIRED',
    );
    assert.equal(enableCalls, 0);
});

test('Marketplace enable runs only after publication preflight succeeds', async () => {
    const calls = [];
    const output = await enableMarketplaceAgent({ agentRef: 'demo/agent', mode: 'devel' }, {
        async preflight(command, args) { calls.push(['preflight', command, ...args]); },
        enable(...args) { calls.push(['enable', ...args]); return { containerName: 'demo' }; },
    });
    assert.deepEqual(calls, [
        ['preflight', 'enable', 'agent', 'demo/agent'],
        ['enable', 'demo/agent', 'devel', 'demo'],
    ]);
    assert.equal(output.result.containerName, 'demo');
});

test('Marketplace HTTP enable maps outer publication denial to an actionable 409', async () => {
    const denial = new Error('Run this one-shot command from the host: ploinky enable agent demo/agent');
    denial.code = 'PLOINKY_OUTER_PUBLICATION_REQUIRED';
    let enableCalls = 0;
    const response = {
        status: 0,
        headers: null,
        body: '',
        writeHead(status, headers) {
            this.status = status;
            this.headers = headers;
        },
        end(body = '') {
            this.body += String(body);
        },
    };
    const request = { method: 'POST', user: null };

    const handled = await handleMarketplaceRoutes(
        request,
        response,
        new URL('http://localhost/api/marketplace'),
        {
            async ensureAdmin(req) {
                req.user = { id: 'admin', roles: ['admin'] };
                return true;
            },
            async readBody() {
                return { action: 'enable_agent', agentRef: 'demo/agent', mode: 'global' };
            },
            async enableAgentAction() {
                enableCalls += 1;
                throw denial;
            },
        },
    );

    assert.equal(handled, true);
    assert.equal(enableCalls, 1);
    assert.equal(response.status, 409);
    assert.equal(response.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(response.body), {
        ok: false,
        error: 'outer_publication_required',
        message: denial.message,
    });
});
