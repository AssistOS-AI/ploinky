import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { enableMarketplaceAgent } from '../../cli/server/authHandlers/marketplaceRoutes.js';
import { runMarketplaceEnableWorker } from '../../cli/server/marketplaceEnableWorker.js';

test('Marketplace enable offloads blocking activation so Router callbacks remain responsive', async (t) => {
    const server = http.createServer((_request, response) => response.end('router-responsive'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());

    const address = server.address();
    const callbackUrl = `http://127.0.0.1:${address.port}/authority-attestations`;
    const result = await runMarketplaceEnableWorker({ agentRef: callbackUrl, mode: 'global' }, {
        workerUrl: new URL('../fixtures/marketplace-enable-callback-worker.mjs', import.meta.url),
        timeoutMs: 3_000,
    });

    assert.deepEqual(result, { callback: 'router-responsive', mode: 'global' });
});

test('Marketplace enable uses the worker path and preserves normalized arguments', async () => {
    const calls = [];
    const result = await enableMarketplaceAgent({
        agentRef: 'AchillesCLI/codexAgent',
        mode: 'global',
    }, {
        runEnableWorker: async (input) => {
            calls.push(input);
            return { containerName: 'codex-runtime' };
        },
    });

    assert.deepEqual(calls, [{ agentRef: 'AchillesCLI/codexAgent', mode: 'global' }]);
    assert.deepEqual(result, {
        ref: 'AchillesCLI/codexAgent',
        mode: 'global',
        result: { containerName: 'codex-runtime' },
    });
});

test('Marketplace enable serializes different workspace mutations', async () => {
    let releaseFirst;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
    const calls = [];
    const runEnableWorker = async ({ agentRef }) => {
        calls.push(agentRef);
        if (agentRef.endsWith('/first')) await firstBlocked;
        return { agentRef };
    };

    const first = enableMarketplaceAgent({ agentRef: 'repo/first', mode: 'global' }, { runEnableWorker });
    const second = enableMarketplaceAgent({ agentRef: 'repo/second', mode: 'global' }, { runEnableWorker });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['repo/first']);

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(calls, ['repo/first', 'repo/second']);
});

test('Marketplace enable worker preserves safe nested lifecycle codes', async () => {
    class FailedWorker extends EventTarget {
        constructor() {
            super();
            this.stdout = { resume() {} };
            this.stderr = { resume() {} };
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
                data: {
                    ok: false,
                    error: {
                        code: 'PLOINKY_RUNTIME_INPUT_CHANGED',
                        status: 409,
                        message: 'runtime changed',
                        cause: {
                            code: 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED',
                            message: 'unsupported',
                        },
                    },
                },
            })));
        }

        once(event, listener) {
            this.addEventListener(event, (entry) => listener(event === 'message' ? entry.data : entry), { once: true });
        }
    }

    await assert.rejects(
        runMarketplaceEnableWorker({ agentRef: 'repo/agent', mode: 'global' }, {
            WorkerClass: FailedWorker,
            timeoutMs: 1_000,
        }),
        (error) => error.code === 'PLOINKY_RUNTIME_INPUT_CHANGED'
            && error.status === 409
            && error.cause?.code === 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED',
    );
});
