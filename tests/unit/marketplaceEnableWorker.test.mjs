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

// ---------------------------------------------------------------------------
// Typed hardware outcomes across CLI causes and the Marketplace worker

async function hardwareTransport() {
    const errors = await import('../../cli/sandbox/hardwareLimits/errors.mjs');
    const limits = await import('../../cli/sandbox/hardwareLimits/requestedLimits.mjs');
    const thread = await import('../../cli/server/marketplaceEnableWorkerThread.js');
    const parent = await import('../../cli/server/marketplaceEnableWorker.js');
    const refusal = (key, ref = 'demo/agent') => limits.buildDirectRefusal({
        key,
        ref,
        refusalParts: {
            reasonCode: 'controller_unavailable',
            reason: 'The host does not delegate memory to rootless Podman.',
            fix: 'Apply the delegation commands, then run ploinky restart.',
            requested: [{ field: 'memory', value: '64m', source: 'settings' }],
        },
        inputFingerprint: 'e'.repeat(64),
    });
    return { errors, limits, thread, parent, refusal };
}

test('E.cli-cause', async () => {
    const { errors, refusal } = await hardwareTransport();
    const root = new errors.HardwareLimitsError(refusal('ploinky_demo_agent'));
    const managed = errors.wrapPreservingHardwareCause(`managed restart failed: ${root.message}`, root);
    const outer = errors.wrapPreservingHardwareCause('Failed to restart container ploinky_demo_agent', managed);
    assert.equal(outer.code, errors.HARDWARE_UNENFORCEABLE);
    assert.equal(outer.status, 422);
    assert.deepEqual(errors.findHardwareOutcome(outer), root.hardwareOutcome);
    const roundtrip = errors.deserializeHardwareAwareError(JSON.parse(JSON.stringify(errors.serializeHardwareAwareError(outer))));
    assert.deepEqual(roundtrip.hardwareOutcome, root.hardwareOutcome);
});

test('E.marketplace-outbound', async () => {
    const { errors, thread, refusal } = await hardwareTransport();
    const wrapped = errors.wrapPreservingHardwareCause('activation failed', new errors.HardwareLimitsError(refusal('ploinky_demo_agent')));
    const serialized = thread.serializeError(wrapped);
    assert.equal(serialized.code, errors.HARDWARE_UNENFORCEABLE);
    assert.deepEqual(serialized.hardwareOutcome, refusal('ploinky_demo_agent'));
    assert.deepEqual(errors.validateHardwareOutcome(JSON.parse(JSON.stringify(serialized.hardwareOutcome))), serialized.hardwareOutcome);
});

test('E.marketplace-inbound', async () => {
    const { errors, parent, refusal } = await hardwareTransport();
    const { EventEmitter } = await import('node:events');
    let worker;
    class TypedWorker extends EventEmitter {
        constructor() { super(); worker = this; }
        terminate() { return Promise.resolve(0); }
    }
    const pending = parent.runMarketplaceEnableWorker({ agentRef: 'demo/agent', mode: 'global' }, { WorkerClass: TypedWorker, timeoutMs: 5_000 });
    worker.emit('message', { ok: false, error: { message: 'refused', code: errors.HARDWARE_UNENFORCEABLE, hardwareOutcome: refusal('ploinky_demo_agent') } });
    await assert.rejects(pending, (error) => error.code === errors.HARDWARE_UNENFORCEABLE
        && error.status === 422 && error.hardwareOutcome.key === 'ploinky_demo_agent');
    const invalid = parent.deserializeWorkerError({ message: 'x', hardwareOutcome: { state: 'refused', extra: 1 } });
    assert.equal(invalid.code, 'PLOINKY_MARKETPLACE_ENABLE_WORKER_FAILED', 'an invalid typed outcome is rejected, not parsed from text');
    assert.equal(invalid.hardwareOutcome, undefined);
});

test('E.bounded-secret-free', async () => {
    const { errors, thread, refusal } = await hardwareTransport();
    const cause = Object.assign(new Error(`Cookie: ploinky_session=secret-cookie ${'x'.repeat(5000)}`), {
        env: { PLOINKY_MASTER_KEY: 'k'.repeat(64) }, body: '{"password":"p"}',
    });
    const error = errors.wrapPreservingHardwareCause('activation failed', Object.assign(
        new errors.HardwareLimitsError(refusal('ploinky_demo_agent')), { cause },
    ));
    const serialized = thread.serializeError(error);
    const text = JSON.stringify(serialized);
    assert.equal(text.includes('k'.repeat(64)), false);
    assert.equal(text.includes('password'), false);
    assert.equal(text.includes('stack'), false);
    assert.ok(serialized.message.length <= 512);
    assert.ok(Buffer.byteLength(text) < 32 * 1024, 'the serialized error stays bounded');
    const shared = JSON.stringify(errors.serializeHardwareAwareError(error));
    assert.equal(shared.includes('k'.repeat(64)), false);
    assert.equal(shared.includes('"stack"'), false);
});

test('E.max-ref-roundtrip', async () => {
    const { errors, thread, parent, refusal } = await hardwareTransport();
    const ref = `${'r'.repeat(128)}/${'a'.repeat(128)}`;
    assert.equal(Buffer.byteLength(ref), 257);
    const outcome = refusal('ploinky_max_ref', ref);
    const roundtrip = parent.deserializeWorkerError(JSON.parse(JSON.stringify(thread.serializeError(new errors.HardwareLimitsError(outcome)))));
    assert.equal(roundtrip.hardwareOutcome.ref, ref);
    assert.match(errors.formatHardwareOutcome(roundtrip.hardwareOutcome), new RegExp(`^Refused \\(hardware limits\\): ${ref} `));
    assert.throws(() => refusal('ploinky_max_ref', `${'r'.repeat(129)}/a`), /exact REPO\/AGENT reference/);
});

test('E.long-key-roundtrip', async () => {
    const { errors, thread, parent, refusal } = await hardwareTransport();
    const key = `ploinky_${'k'.repeat(1016)}`;
    assert.equal(Buffer.byteLength(key), 1024);
    const roundtrip = parent.deserializeWorkerError(JSON.parse(JSON.stringify(thread.serializeError(new errors.HardwareLimitsError(refusal(key))))));
    assert.equal(roundtrip.hardwareOutcome.key, key, 'an exact long key is never truncated');
    const tooLong = `${key}x`;
    assert.throws(() => refusal(tooLong), /exceeds 1024 bytes/);
    assert.throws(() => errors.assertRepresentableIdentity({ key: tooLong, ref: 'demo/agent' }), (error) => (
        error.code === 'identity_unrepresentable' && /^sha256:[0-9a-f]{64}$/.test(error.identityDigest)
    ));
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
