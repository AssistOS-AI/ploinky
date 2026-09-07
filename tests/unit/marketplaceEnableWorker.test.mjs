import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';

import { enableMarketplaceAgent } from '../../cli/server/authHandlers/marketplaceRoutes.js';
import { MARKETPLACE_ENABLE_TIMEOUT_MS, runMarketplaceEnableWorker } from '../../cli/server/marketplaceEnableWorker.js';

test('Marketplace cold activation survives a four-minute image pull and still has a finite deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let worker;
    class ColdWorker extends EventEmitter {
        constructor() {
            super();
            worker = this;
            this.terminated = false;
        }
        terminate() { this.terminated = true; return Promise.resolve(1); }
    }
    const activation = runMarketplaceEnableWorker({ agentRef: 'repo/agent', mode: 'global' }, { WorkerClass: ColdWorker });
    let settled = false;
    activation.then(() => { settled = true; }, () => { settled = true; });
    t.mock.timers.tick(4 * 60 * 1000);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(worker.terminated, false);
    worker.emit('message', { ok: true, result: { ready: true } });
    assert.deepEqual(await activation, { ready: true });

    const stuck = runMarketplaceEnableWorker({ agentRef: 'repo/stuck', mode: 'global' }, { WorkerClass: ColdWorker });
    const rejection = assert.rejects(stuck, { code: 'PLOINKY_MARKETPLACE_ENABLE_TIMEOUT', status: 504 });
    assert.ok(Number.isSafeInteger(MARKETPLACE_ENABLE_TIMEOUT_MS));
    t.mock.timers.tick(MARKETPLACE_ENABLE_TIMEOUT_MS);
    await rejection;
    assert.equal(worker.terminated, true);
});

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

test('Marketplace probe progress cannot complete activation or consume its final result', async () => {
    let worker;
    class ProbeWorker extends EventEmitter {
        constructor() { super(); worker = this; }
    }
    const activation = runMarketplaceEnableWorker({ agentRef: 'repo/probed', mode: 'global' }, { WorkerClass: ProbeWorker });
    let settled = false;
    activation.then(() => { settled = true; }, () => { settled = true; });
    worker.emit('message', { type: 'log', level: 'info', message: 'readiness probe starting' });
    worker.emit('message', { type: 'log', level: 'warn', message: 'probe still waiting' });
    await Promise.resolve();
    assert.equal(settled, false);
    worker.emit('message', { ok: true, result: { containerName: 'ready-runtime' } });
    assert.deepEqual(await activation, { containerName: 'ready-runtime' });
});

test('Marketplace malformed terminal messages still fail closed', async () => {
    class InvalidWorker extends EventEmitter {
        constructor() {
            super();
            queueMicrotask(() => this.emit('message', { unexpected: true }));
        }
    }
    await assert.rejects(runMarketplaceEnableWorker({ agentRef: 'repo/agent', mode: 'global' }, { WorkerClass: InvalidWorker }), {
        code: 'PLOINKY_MARKETPLACE_ENABLE_WORKER_FAILED',
    });
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

        on(event, listener) {
            this.addEventListener(event, (entry) => listener(event === 'message' ? entry.data : entry));
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
