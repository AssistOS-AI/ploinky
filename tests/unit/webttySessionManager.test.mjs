import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebttySessionManager } from '../../cli/server/webtty/sessionManager.mjs';

const LEASE = Object.freeze({
    mode: 'local',
    sessionId: 'jwt-current',
    sessionBindingId: 'sess-stable',
    sessionFingerprint: 'auth-fingerprint',
    userId: 'local:admin',
});

function routePlan() {
    return {
        host: 'localhost',
        hostSelection: { host: 'localhost', record: { routeKey: 'control' } },
        lease: {
            id: 'generation-a',
            activationId: 'activation-a',
            commit: () => true,
            isCurrent: () => true,
        },
    };
}

function authAdapter({ validate = async () => ({ ok: true }) } = {}) {
    return {
        createLease: () => LEASE,
        requestMatchesLease: () => true,
        subscribeInvalidation: (_lease, listener) => {
            authAdapter.listener = listener;
            return () => { authAdapter.listener = null; };
        },
        validateLease: validate,
    };
}

function requestAuthAdapter() {
    return {
        createLease: (req) => req.lease,
        requestMatchesLease: (req, lease) => Boolean(req.lease
            && req.lease.userId === lease.userId
            && req.lease.sessionFingerprint === lease.sessionFingerprint),
        subscribeInvalidation: () => () => {},
        validateLease: async () => ({ ok: true }),
    };
}

function lease(name, userId = 'local:admin') {
    return {
        ...LEASE,
        sessionId: `jwt-${name}`,
        sessionBindingId: `sid-${name}`,
        sessionFingerprint: `fingerprint-${name}`,
        userId,
    };
}

class FakeWorker extends EventEmitter {
    constructor({ failStart = false, startPromise = null, waitForExitResult = null } = {}) {
        super();
        this.failStart = failStart;
        this.startPromise = startPromise;
        this.waitForExitResult = waitForExitResult;
        this.exited = false;
        this.closed = 0;
        this.inputs = [];
        this.resizes = [];
    }

    async spawn() {
        return { pid: 201, startToken: 'linux-proc:1001', uid: 0 };
    }

    async start(fields) {
        this.startFields = fields;
        if (this.failStart) throw new Error('startup failed');
        if (this.startPromise) await this.startPromise;
        return {
            processIdentity: {
                pid: 301,
                startToken: 'linux-proc:2002',
                processGroupId: 301,
                sessionId: 301,
                foregroundProcessGroupId: 301,
                ttyNumber: 7,
            },
        };
    }

    async input(data) { this.inputs.push(data); }
    async resize(cols, rows) { this.resizes.push([cols, rows]); }

    async close() {
        this.closed += 1;
        this.exited = true;
        queueMicrotask(() => {
            this.emit('terminal-exit', { category: 'requested' });
            this.emit('process-exit', { category: 'requested' });
        });
    }

    async waitForExit() {
        return this.waitForExitResult === null ? this.exited : this.waitForExitResult;
    }
}

function recordStore() {
    const calls = { created: 0, updated: 0, removed: 0, marked: 0 };
    return {
        calls,
        async recover() { return { ok: true, evidence: [] }; },
        async create(value) {
            calls.created += 1;
            return { fileName: 'record.json', record: { ...value } };
        },
        async update(handle, value) {
            calls.updated += 1;
            handle.record = value;
            return value;
        },
        async remove() { calls.removed += 1; return true; },
        async markPtyStarting(handle) {
            handle.record.ptyState = 'pty-starting';
            return true;
        },
        async markCleanupUnproven(handle) {
            calls.marked += 1;
            handle.record.cleanupState = 'unproven';
            return true;
        },
    };
}

async function createManager(t, options = {}) {
    const manager = new WebttySessionManager({
        limits: {
            authenticationIntervalMs: 60_000,
            streamDetachGraceMs: 1_000,
            ...options.limits,
        },
        auth: options.auth || authAdapter(),
        recordStore: options.recordStore || recordStore(),
        workerFactory: options.workerFactory || (() => new FakeWorker()),
    });
    await manager.initialize();
    t.after(() => manager.closeAll('test_cleanup'));
    return manager;
}

test('create-time authentication loss fails before quota reservation or worker allocation', async (t) => {
    let workerAllocations = 0;
    const manager = await createManager(t, {
        auth: authAdapter({ validate: async () => ({ ok: false, reason: 'administrator_revoked' }) }),
        workerFactory: () => { workerAllocations += 1; return new FakeWorker(); },
    });

    await assert.rejects(
        manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 }),
        { code: 'WEBTTY_ADMIN_REQUIRED' },
    );
    assert.equal(workerAllocations, 0);
    assert.equal(manager.activeCount(), 0);
    assert.deepEqual([...manager.userCounts], []);
    assert.deepEqual([...manager.authCounts], []);
});

test('throwing worker factory rolls back reserved quotas exactly once', async (t) => {
    const manager = await createManager(t, {
        workerFactory: () => { throw new Error('factory failed'); },
    });
    await assert.rejects(
        manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 }),
        /factory failed/,
    );
    assert.equal(manager.activeCount(), 0);
    assert.deepEqual([...manager.userCounts], []);
    assert.deepEqual([...manager.authCounts], []);
});

test('per-auth-session, per-user, global, and creation-rate quotas fail before extra workers', async (t) => {
    await t.test('auth, user, and global quotas', async (t2) => {
        let allocations = 0;
        const manager = await createManager(t2, {
            auth: requestAuthAdapter(),
            limits: { global: 2, perUser: 2, perAuthSession: 1, createsPerWindow: 10 },
            workerFactory: () => { allocations += 1; return new FakeWorker(); },
        });
        await manager.create({ req: { lease: lease('a') }, routePlan: routePlan(), cwdRelative: '' });
        await assert.rejects(
            manager.create({ req: { lease: lease('a') }, routePlan: routePlan(), cwdRelative: '' }),
            { code: 'WEBTTY_SESSION_QUOTA' },
        );
        await manager.create({ req: { lease: lease('b') }, routePlan: routePlan(), cwdRelative: '' });
        await assert.rejects(
            manager.create({ req: { lease: lease('c', 'local:other-admin') }, routePlan: routePlan(), cwdRelative: '' }),
            { code: 'WEBTTY_GLOBAL_QUOTA' },
        );
        assert.equal(allocations, 2);
    });

    await t.test('user quota', async (t2) => {
        const manager = await createManager(t2, {
            auth: requestAuthAdapter(),
            limits: { global: 4, perUser: 1, perAuthSession: 2, createsPerWindow: 10 },
        });
        await manager.create({ req: { lease: lease('a') }, routePlan: routePlan(), cwdRelative: '' });
        await assert.rejects(
            manager.create({ req: { lease: lease('b') }, routePlan: routePlan(), cwdRelative: '' }),
            { code: 'WEBTTY_USER_QUOTA' },
        );
    });

    await t.test('creation rate', async (t2) => {
        const manager = await createManager(t2, {
            limits: { createsPerWindow: 1 },
        });
        const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
        await manager.closeSession(created.id, 'test');
        await assert.rejects(
            manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' }),
            { code: 'WEBTTY_CREATION_RATE' },
        );
    });
});

test('input byte rate overflow closes the terminal', async (t) => {
    const worker = new FakeWorker();
    const manager = await createManager(t, {
        limits: { inputBytesPerWindow: 3 },
        workerFactory: () => worker,
    });
    const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    const session = manager.sessions.get(created.id);
    await manager.input(session, 'abc');
    await assert.rejects(manager.input(session, 'd'), { code: 'WEBTTY_INPUT_RATE' });
    assert.equal(manager.activeCount(), 0);
    assert.deepEqual(worker.inputs, ['abc']);
});

test('worker initialization forwards only cwd, dimensions, and the fixed shell environment', async (t) => {
    const worker = new FakeWorker();
    const manager = await createManager(t, { workerFactory: () => worker });
    await manager.create({
        req: { headers: { authorization: 'Bearer secret', cookie: 'private=session' } },
        routePlan: routePlan(),
        cwdRelative: 'Projects',
        cols: 90,
        rows: 30,
    });
    assert.deepEqual(Object.keys(worker.startFields).sort(), ['cols', 'cwdRelative', 'rows', 'shellEnv']);
    assert.equal(worker.startFields.cwdRelative, 'Projects');
    assert.equal(worker.startFields.cols, 90);
    assert.equal(worker.startFields.rows, 30);
    assert.equal(JSON.stringify(worker.startFields).includes('Bearer secret'), false);
    assert.equal(JSON.stringify(worker.startFields).includes('private=session'), false);
});

test('detached-stream timeout is armed only after worker readiness is durable', async (t) => {
    let resolveStart;
    const startPromise = new Promise((resolve) => { resolveStart = resolve; });
    const worker = new FakeWorker({ startPromise });
    const manager = await createManager(t, {
        workerFactory: () => worker,
        limits: { streamDetachGraceMs: 10 },
    });
    const creation = manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(manager.activeCount(), 1);
    assert.equal(worker.closed, 0);
    resolveStart();
    await creation;
});

test('browser stream close reclaims the terminal within the bounded reconnect grace', async (t) => {
    const store = recordStore();
    const worker = new FakeWorker();
    const manager = await createManager(t, {
        recordStore: store,
        workerFactory: () => worker,
        limits: { streamDetachGraceMs: 15 },
    });
    const plan = routePlan();
    const created = await manager.create({ req: {}, routePlan: plan, cwdRelative: '', cols: 80, rows: 24 });
    const session = await manager.validateOwnership({}, plan, created.id);
    const request = new EventEmitter();
    const response = {
        writableEnded: false,
        destroyed: false,
        writableLength: 0,
        write() { return true; },
        end() { this.writableEnded = true; },
    };
    assert.equal(manager.attachStream(session, request, response), true);
    request.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(manager.activeCount(), 0);
    assert.equal(worker.closed, 1);
    assert.equal(store.calls.removed, 1);
    assert.deepEqual([...manager.userCounts], []);
    assert.deepEqual([...manager.authCounts], []);
});

test('cleanup-unproven disables WebTTY and preserves durable recovery evidence', async (t) => {
    const store = recordStore();
    const worker = new FakeWorker();
    const manager = await createManager(t, {
        recordStore: store,
        workerFactory: () => worker,
    });
    await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 });
    worker.emit('terminal-error', { category: 'cleanup-unproven' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(manager.availability(), { ok: false, category: 'cleanup-unproven' });
    assert.equal(store.calls.marked, 1);
    assert.equal(store.calls.removed, 0);
    assert.equal(manager.activeCount(), 0);
});

test('abrupt worker exit without terminal cleanup proof preserves evidence and disables WebTTY', async (t) => {
    const store = recordStore();
    const worker = new FakeWorker();
    const manager = await createManager(t, {
        recordStore: store,
        workerFactory: () => worker,
    });
    await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 });
    worker.emit('process-exit', { category: 'worker_process_exit' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(manager.activeCount(), 0);
    assert.equal(manager.availability().ok, false);
    assert.equal(manager.availability().category, 'terminal_cleanup_unproven');
    assert.equal(store.calls.removed, 0);
});

test('unconfirmed worker exit and recovery-record removal failures fail WebTTY closed', async (t) => {
    const cases = [
        {
            name: 'wait timeout',
            worker: new FakeWorker({ waitForExitResult: false }),
            mutateStore: () => {},
            category: 'worker_exit_unconfirmed',
        },
        {
            name: 'remove false',
            worker: new FakeWorker(),
            mutateStore: (store) => { store.remove = async () => false; },
            category: 'recovery_record_remove_unconfirmed',
        },
        {
            name: 'remove throws',
            worker: new FakeWorker(),
            mutateStore: (store) => { store.remove = async () => { throw new Error('disk failure'); }; },
            category: 'recovery_record_remove_failed',
        },
    ];
    for (const entry of cases) {
        await t.test(entry.name, async (t2) => {
            const store = recordStore();
            entry.mutateStore(store);
            const manager = await createManager(t2, {
                recordStore: store,
                workerFactory: () => entry.worker,
            });
            const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 });
            await manager.closeSession(created.id, 'test');
            assert.equal(manager.availability().ok, false);
            assert.equal(manager.availability().category, entry.category);
        });
    }
});

test('one unproven cleanup quiesces every other live WebTTY session', async (t) => {
    const store = recordStore();
    const workers = [new FakeWorker(), new FakeWorker()];
    const manager = await createManager(t, {
        recordStore: store,
        workerFactory: () => workers.shift(),
    });
    await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 });
    await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 });
    const first = [...manager.sessions.values()][0].worker;
    const second = [...manager.sessions.values()][1].worker;
    first.emit('process-exit', { category: 'worker_process_exit' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(manager.availability().ok, false);
    assert.equal(manager.activeCount(), 0);
    assert.equal(second.closed, 1);
});

test('idle and absolute lifetimes reclaim sessions at their configured bounds', async (t) => {
    await t.test('idle', async (t2) => {
        let now = 1_000;
        const worker = new FakeWorker();
        const manager = new WebttySessionManager({
            now: () => now,
            limits: { authenticationIntervalMs: 60_000, idleLifetimeMs: 10, absoluteLifetimeMs: 100 },
            auth: authAdapter(),
            recordStore: recordStore(),
            workerFactory: () => worker,
        });
        await manager.initialize();
        t2.after(() => manager.closeAll('test_cleanup'));
        await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
        now = 1_011;
        await manager.validateLiveSessions();
        assert.equal(manager.activeCount(), 0);
    });
    await t.test('absolute', async (t2) => {
        let now = 2_000;
        const manager = new WebttySessionManager({
            now: () => now,
            limits: { authenticationIntervalMs: 60_000, idleLifetimeMs: 100, absoluteLifetimeMs: 10 },
            auth: authAdapter(),
            recordStore: recordStore(),
            workerFactory: () => new FakeWorker(),
        });
        await manager.initialize();
        t2.after(() => manager.closeAll('test_cleanup'));
        await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
        now = 2_011;
        await manager.validateLiveSessions();
        assert.equal(manager.activeCount(), 0);
    });
});

test('output sequence, replay gap, and SSE high-water limits fail closed', async (t) => {
    await t.test('sequence', async (t2) => {
        const worker = new FakeWorker();
        const manager = await createManager(t2, { workerFactory: () => worker });
        await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
        worker.emit('output', { sequence: 2, data: 'out of order' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(manager.activeCount(), 0);
    });
    await t.test('replay gap reset', async (t2) => {
        const worker = new FakeWorker();
        const manager = await createManager(t2, {
            workerFactory: () => worker,
            limits: { outputReplayEvents: 2 },
        });
        const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
        const session = manager.sessions.get(created.id);
        worker.emit('output', { sequence: 1, data: 'one' });
        worker.emit('output', { sequence: 2, data: 'two' });
        worker.emit('output', { sequence: 3, data: 'three' });
        const response = {
            body: '',
            writableEnded: false,
            destroyed: false,
            writableLength: 0,
            write(value) { this.body += value; return true; },
            end() { this.writableEnded = true; },
        };
        assert.equal(manager.attachStream(session, new EventEmitter(), response, '0'), false);
        assert.match(response.body, /event: reset/);
        assert.equal(response.writableEnded, true);
    });
    await t.test('SSE high water', async (t2) => {
        const worker = new FakeWorker();
        const manager = await createManager(t2, {
            workerFactory: () => worker,
            limits: { sseWritableBytes: 16 },
        });
        const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
        const session = manager.sessions.get(created.id);
        const request = new EventEmitter();
        const response = {
            writableEnded: false,
            destroyed: false,
            writableLength: 0,
            write() { return true; },
            end() { this.writableEnded = true; },
        };
        manager.attachStream(session, request, response);
        worker.emit('output', { sequence: 1, data: 'this output exceeds the writable bound' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(manager.activeCount(), 0);
    });
});

test('ownership binds auth login, user, host route, generation, and supports same-owner DELETE replay', async (t) => {
    const manager = await createManager(t, {
        auth: requestAuthAdapter(),
        workerFactory: () => new FakeWorker(),
    });
    const ownerLease = lease('owner');
    const ownerRequest = { lease: ownerLease };
    const ownerPlan = routePlan();
    const created = await manager.create({ req: ownerRequest, routePlan: ownerPlan, cwdRelative: '' });

    assert.equal(await manager.validateOwnership({ lease: lease('other-login') }, ownerPlan, created.id), null);
    assert.equal(await manager.validateOwnership({ lease: lease('owner', 'local:other') }, ownerPlan, created.id), null);
    const otherHost = routePlan();
    otherHost.host = 'other.example.test';
    otherHost.hostSelection.host = 'other.example.test';
    assert.equal(await manager.validateOwnership(ownerRequest, otherHost, created.id), null);
    const otherGeneration = routePlan();
    otherGeneration.lease.id = 'generation-b';
    assert.equal(await manager.validateOwnership(ownerRequest, otherGeneration, created.id), null);
    assert.ok(await manager.validateOwnership(ownerRequest, ownerPlan, created.id));

    assert.equal(await manager.closeOwned(ownerRequest, ownerPlan, created.id), true);
    assert.equal(await manager.closeOwned(ownerRequest, ownerPlan, created.id), true);
    assert.equal(await manager.closeOwned({ lease: lease('other-login') }, ownerPlan, created.id), false);
});

test('periodic SSO administrator demotion closes the terminal and releases ownership', async (t) => {
    let administrator = true;
    const worker = new FakeWorker();
    const store = recordStore();
    const manager = await createManager(t, {
        auth: authAdapter({
            validate: async () => administrator
                ? { ok: true }
                : { ok: false, reason: 'administrator_revoked' },
        }),
        recordStore: store,
        workerFactory: () => worker,
    });
    await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 });
    administrator = false;
    await manager.validateLiveSessions();

    assert.equal(manager.activeCount(), 0);
    assert.equal(worker.closed, 1);
    assert.equal(store.calls.removed, 1);
    assert.deepEqual([...manager.userCounts], []);
});

test('startup failure releases each quota exactly once', async (t) => {
    const store = recordStore();
    const worker = new FakeWorker({ failStart: true });
    const manager = await createManager(t, {
        recordStore: store,
        workerFactory: () => worker,
    });
    await assert.rejects(
        manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 }),
        /startup failed/,
    );
    assert.equal(manager.activeCount(), 0);
    assert.deepEqual([...manager.userCounts], []);
    assert.deepEqual([...manager.authCounts], []);
    assert.equal(store.calls.removed, 1);
});
