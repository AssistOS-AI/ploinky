import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { startRepositorySupervisor } from '../../cli/server/marketplaceRepositorySupervisor.mjs';
import { REPOSITORY_OPERATION_MARKER } from '../../cli/server/marketplaceRepositoryProcessGroup.mjs';

const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
const operationId = '01234567-89ab-cdef-0123-456789abcdef';

function harness(t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const previous = process.env[REPOSITORY_OPERATION_MARKER];
    process.env[REPOSITORY_OPERATION_MARKER] = operationId;
    const listeners = ['SIGTERM', 'SIGINT'].map(name => [name, new Set(process.listeners(name))]);
    const trace = [];
    const channel = Object.assign(new EventEmitter(), {
        connected: true, send(message, callback) { trace.push(message); callback?.(); },
        disconnect() { this.connected = false; },
    });
    const own = { pid: process.pid, birth: '1', namespace: 'pid:[1]', uids: '1000:1000:1000:1000',
        group: process.pid, session: process.pid, exe: '/node', argv: ['/node', '/supervisor'] };
    const observer = {
        async read() { return own; },
        async scan() { return { complete: true, records: [own], members: [], writers: [] }; },
        async signal() { return false; },
    };
    let worker;
    class FakeWorker extends EventEmitter {
        constructor() { super(); worker = this; }
        postMessage() {}
        async terminate() { this.emit('exit', 1); }
    }
    const supervisor = startRepositorySupervisor({ channel, observer, WorkerClass: FakeWorker,
        retain: () => { trace.push({ retained: true }); return true; } });
    t.after(async () => {
        await supervisor.cancel();
        for (const [name, original] of listeners) for (const listener of process.listeners(name)) {
            if (!original.has(listener)) process.removeListener(name, listener);
        }
        if (previous === undefined) delete process.env[REPOSITORY_OPERATION_MARKER];
        else process.env[REPOSITORY_OPERATION_MARKER] = previous;
    });
    const send = async (target, type, details = {}) => { target.emit('message', { type, operationId, ...details }); await flush(); };
    return { trace, channel, observer, own, supervisor, send, worker: () => worker,
        start: () => send(channel, 'ownership', { coordinator: own, router: own, baseline: [own],
            deadline: Date.now() + 600000, operation: { action: 'install_repo', url: 'SECRET_CANARY' } }) };
}

test('release failure retains the lease before sending a safe, specific diagnostic and unchanged recovery frame', async (t) => {
    const h = harness(t);
    await h.start();
    await h.send(h.worker(), 'lease', { token: 'SECRET_CANARY' });
    await h.send(h.worker(), 'authorize');
    await h.send(h.channel, 'authorization', { ok: true });
    const barrier = h.send(h.worker(), 'barrier');
    await flush(); t.mock.timers.tick(25); await barrier; await flush();
    assert.equal(h.supervisor.state(), 'release-granted');
    await h.send(h.worker(), 'terminal', { ok: false, error: { code: 'workspace_mutation_lock_release_failed', message: 'SECRET_CANARY' } });
    const diagnostic = h.trace.find(entry => entry.type === 'diagnostic');
    assert.equal(diagnostic.payload.phase, 'release');
    assert.equal(diagnostic.payload.reason, 'release-failed');
    assert.ok(h.trace.findIndex(entry => entry.retained) < h.trace.indexOf(diagnostic));
    assert.equal(h.trace.find(entry => entry.type === 'recovery').code, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET_CANARY/);
    assert.equal(h.supervisor.state(), 'cancelling');
});

test('incomplete settlement carries safe unknown categories and diagnostic sink errors cannot prevent recovery', async (t) => {
    const h = harness(t);
    await h.start();
    h.observer.scan = async () => ({ complete: false, records: [], members: [], writers: [],
        diagnostic: { unknowns: [{ category: 'permission', field: 'environment', errno: 'EPERM', count: 1 }] } });
    await h.send(h.worker(), 'barrier');
    const diagnostic = h.trace.find(entry => entry.type === 'diagnostic');
    assert.equal(diagnostic.payload.reason, 'incomplete');
    assert.equal(diagnostic.payload.unknowns[0].field, 'environment');
    assert.equal(h.supervisor.state(), 'cancelling');
});

test('throwing diagnostic transport preserves the original recovery cancellation', async (t) => {
    const h = harness(t);
    const send = h.channel.send;
    h.channel.send = (message, callback) => {
        if (message.type === 'diagnostic') throw new Error('SECRET_CANARY');
        send(message, callback);
    };
    await h.send(h.channel, 'invalid-control');
    assert.equal(h.supervisor.state(), 'cancelling');
    assert.ok(h.trace.some(entry => entry.retained));
    assert.ok(h.trace.some(entry => entry.type === 'recovery'));
});

test('prior subject passes diagnostic IPC while settlement keeps its recovery and lease behavior', async (t) => {
    const h = harness(t);
    await h.start();
    await h.send(h.worker(), 'lease', { token: 'SECRET_CANARY' });
    const firstUnknownSubject = { category: 'permission', field: 'environment', errno: 'EACCES',
        basis: 'prior-stable-identity', subjectFingerprint: 'a'.repeat(64) };
    h.observer.scan = async () => ({ complete: false, records: [], members: [], writers: [],
        diagnostic: { unknowns: [{ category: 'permission', field: 'environment', errno: 'EACCES', count: 1 }], firstUnknownSubject } });
    await h.send(h.worker(), 'barrier');
    const diagnostic = h.trace.find(entry => entry.type === 'diagnostic');
    assert.deepEqual(diagnostic?.payload.firstUnknownSubject, firstUnknownSubject);
    assert.equal(diagnostic.payload.complete, false);
    assert.ok(h.trace.findIndex(entry => entry.retained) < h.trace.indexOf(diagnostic));
    assert.equal(h.trace.find(entry => entry.type === 'recovery').code, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    assert.equal(h.trace.some(entry => entry.type === 'release'), false);
    assert.equal(h.supervisor.state(), 'cancelling');
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET_CANARY/);
});
