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

test('Marketplace enable keeps explicit isolated and leaves a missing mode to the manifest default', async () => {
    const calls = [];
    const runEnableWorker = async (input) => { calls.push(input); return {}; };
    await enableMarketplaceAgent({ agentRef: 'repo/explicit', mode: 'isolated' }, { runEnableWorker });
    await enableMarketplaceAgent({ agentRef: 'repo/implicit' }, { runEnableWorker });
    await enableMarketplaceAgent({ agentRef: 'repo/default', mode: 'default' }, { runEnableWorker });
    assert.deepEqual(calls, [
        { agentRef: 'repo/explicit', mode: 'isolated' },
        { agentRef: 'repo/implicit', mode: '' },
        { agentRef: 'repo/default', mode: '' },
    ]);

    const direct = [];
    await enableMarketplaceAgent({ agentRef: 'repo/direct', mode: 'isolated' }, {
        enable: async (...args) => { direct.push(args); return {}; },
    });
    assert.deepEqual(direct, [['repo/direct', 'isolated', undefined]]);
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

test('an abnormal enable worker retains its exact workspace lease; normal completion releases its own', async () => {
    class LeasingWorker extends EventEmitter {
        constructor() { super(); LeasingWorker.last = this; }
        terminate() { setImmediate(() => this.emit('exit', 1)); return Promise.resolve(1); }
    }
    const retained = new Set();
    const retainLease = lease => { retained.add(lease.token); return true; };

    const stuck = runMarketplaceEnableWorker({ agentRef: 'repo/stuck', mode: 'global' },
        { WorkerClass: LeasingWorker, timeoutMs: 20, retainLease });
    LeasingWorker.last.emit('message', { type: 'workspace-lease', token: 'lease-token-1' });
    await assert.rejects(stuck, { code: 'PLOINKY_MARKETPLACE_ENABLE_TIMEOUT', recoveryRequired: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual([...retained], ['lease-token-1'], 'thread termination never proves descendant quiescence');

    const finished = runMarketplaceEnableWorker({ agentRef: 'repo/agent', mode: 'global' },
        { WorkerClass: LeasingWorker, timeoutMs: 10_000, retainLease });
    const worker = LeasingWorker.last;
    worker.emit('message', { type: 'workspace-lease', token: 'lease-token-2' });
    worker.emit('message', { ok: true, result: { ready: true } });
    worker.emit('exit', 0);
    assert.deepEqual(await finished, { ready: true });
    assert.deepEqual([...retained], ['lease-token-1'], 'the successful worker already released its own lease');
});

test('a timed-out real Worker retains ownership while its spawned child still lives', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-child-recovery-'));
    const pidFile = path.join(root, 'child.pid');
    const retained = [];
    let pid;
    try {
        await assert.rejects(runMarketplaceEnableWorker({ agentRef: pidFile, mode: 'global' }, {
            workerUrl: new URL('../fixtures/marketplace-enable-child-worker.mjs', import.meta.url),
            timeoutMs: 750,
            retainLease: lease => { if (lease.token) retained.push(lease.token); return true; },
        }), error => error.code === 'PLOINKY_MARKETPLACE_ENABLE_TIMEOUT'
            && error.recoveryRequired === true && /Stop the exact Box/.test(error.message));
        pid = Number(fs.readFileSync(pidFile, 'utf8'));
        process.kill(pid, 0);
        assert.ok(retained.includes('child-worker-lease'));
    } finally {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
