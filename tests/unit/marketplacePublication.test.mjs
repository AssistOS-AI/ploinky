import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

test('Marketplace in-box preflight receives the persisted non-default router port', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-marketplace-port-'));
    try {
        const ploinkyDir = path.join(root, '.ploinky');
        fs.mkdirSync(ploinkyDir, { recursive: true });
        fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
            port: 49123,
            routes: {},
        }));
        const marker = path.join(root, 'ploinky-box');
        fs.writeFileSync(marker, '1\n');
        const routesUrl = pathToFileURL(path.resolve(
            new URL('../..', import.meta.url).pathname,
            'cli/server/authHandlers/marketplaceRoutes.js',
        )).href;
        const script = `
const { enableMarketplaceAgent } = await import(${JSON.stringify(routesUrl)});
let observed = null;
const output = await enableMarketplaceAgent({ agentRef: 'demo/agent', mode: 'global' }, {
  async preflight(command, args, options) { observed = { command, args, options }; },
  enable() { return { containerName: 'demo' }; },
});
process.stdout.write(JSON.stringify({ observed, result: output.result }));`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: root,
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: root,
                PLOINKY_BOX_MARKER_PATH: marker,
                PLOINKY_MASTER_KEY: '6'.repeat(64),
            },
            encoding: 'utf8',
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = JSON.parse(result.stdout);
        assert.deepEqual(output.observed, {
            command: 'enable',
            args: ['agent', 'demo/agent'],
            options: {
                commandHint: 'ploinky enable agent demo/agent global',
                routerPort: 49123,
            },
        });
        assert.deepEqual(output.result, { containerName: 'demo' });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
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
