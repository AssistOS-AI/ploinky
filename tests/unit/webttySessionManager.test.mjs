import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebttySessionManager } from '../../cli/server/webtty/sessionManager.mjs';
import { terminalTargetRouteBinding } from '../../cli/server/webtty/terminalTargetResolver.mjs';

const LEASE = Object.freeze({
    mode: 'local',
    sessionId: 'jwt-current',
    sessionBindingId: 'sess-stable',
    sessionFingerprint: 'auth-fingerprint',
    userId: 'local:admin',
});

function routePlan() {
    const snapshot = Object.freeze({ generation: 'generation-a' });
    return {
        host: 'localhost',
        snapshot,
        hostSelection: { host: 'localhost', record: { routeKey: 'control' } },
        lease: {
            snapshot,
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

function terminalTargets(relativePath = 'Projects') {
    const directory = Object.freeze({
        relativePath,
        absolutePath: `/workspace/${relativePath}`,
        identity: Object.freeze({ dev: '1', ino: '2' }),
    });
    return Object.freeze([
        Object.freeze({
            kind: 'box',
            directory,
            label: 'Ploinky Box',
            detail: 'Workspace runtime',
            access: 'rw',
            cwdDisplay: `/workspace/${relativePath}`,
        }),
        Object.freeze({
            kind: 'agent',
            directory,
            runtime: 'podman',
            containerId: 'a'.repeat(64),
            containerName: 'ploinky-agent-demo',
            instanceId: 'instance-demo',
            enableGeneration: 'enable-generation-demo',
            repoName: 'demo',
            agentName: 'builder',
            targetUser: '1000:1000',
            translatedCwd: '/code/Projects',
            label: 'builder',
            detail: 'demo/builder',
            access: 'ro',
            cwdDisplay: '/code/Projects',
        }),
    ]);
}

function installBoxLaunchTestHelper(manager) {
    const productionRevalidate = manager.targetResolver.revalidate?.bind(manager.targetResolver);
    manager.targetResolver.revalidate = (options) => (
        options.target?.kind === 'box'
            ? Promise.resolve(options.target)
            : productionRevalidate(options)
    );
    const productionCreate = manager.create.bind(manager);
    manager.productionCreate = productionCreate;
    manager.create = (args) => {
        if (args.launch !== undefined) return productionCreate(args);
        const selectedLease = args.req?.lease || LEASE;
        const discovery = manager.launchStore.createDiscovery({
            owner: {
                userId: selectedLease.userId,
                sessionFingerprint: selectedLease.sessionFingerprint,
            },
            routeBinding: terminalTargetRouteBinding(args.routePlan),
            targets: [terminalTargets(args.cwdRelative || '')[0]],
            agentTargetsAvailable: false,
        });
        const { cwdRelative: _discarded, ...productionArgs } = args;
        return productionCreate({
            ...productionArgs,
            launch: discovery.targets[0].launch,
        });
    };
    return manager;
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

    async prepare(fields) {
        this.startFields = fields;
        return {
            startupEvidence: {
                backend: 'persistent-podman-exec-under-box-node-pty/v1',
                runtime: 'podman',
                containerId: fields.containerId,
                targetUser: fields.targetUser,
                translatedCwd: fields.translatedCwd,
                marker: fields.marker,
                baselineExecIds: [],
                containerInitProcess: {
                    pid: 4199,
                    startToken: 'linux-proc:41990',
                    pidNamespace: 'pid:[9001]',
                },
            },
        };
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
        if (this.closed) return;
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
    const calls = {
        created: 0, updated: 0, removed: 0, marked: 0, confirmed: 0, recovered: 0,
    };
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
        async markAgentPtyStarting(handle, startupEvidence) {
            handle.record.agentStartup = startupEvidence;
            handle.record.ptyState = 'pty-starting';
            return true;
        },
        async markCleanupUnproven(handle) {
            calls.marked += 1;
            handle.record.cleanupState = 'unproven';
            return true;
        },
        async confirmReclaimed() {
            calls.confirmed += 1;
            return true;
        },
        async recoverHandle(handle) {
            calls.recovered += 1;
            try {
                if (await this.remove(handle) !== true) {
                    return {
                        recovered: false,
                        category: 'agent_record_remove_unconfirmed',
                        scope: 'provider',
                        target: handle.record.target,
                    };
                }
            } catch (_) {
                return {
                    recovered: false,
                    category: 'agent_record_remove_failed',
                    scope: 'provider',
                    target: handle.record.target,
                };
            }
            return { recovered: true, category: 'verified_agent_reclaimed', handle };
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
        agentWorkerFactory: options.agentWorkerFactory,
        launchStore: options.launchStore,
        targetResolver: options.targetResolver,
        agentProviderAvailable: options.agentProviderAvailable,
    });
    await manager.initialize();
    installBoxLaunchTestHelper(manager);
    t.after(() => manager.closeAll('test_cleanup'));
    return manager;
}

test('production create rejects the removed Box compatibility path', async (t) => {
    const manager = await createManager(t);
    await assert.rejects(
        manager.productionCreate({ req: {}, routePlan: routePlan(), cwdRelative: '' }),
        { code: 'WEBTTY_LAUNCH_NOT_FOUND' },
    );
    assert.equal(manager.activeCount(), 0);
});

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

test('throwing auth invalidation subscription rolls back admission before session registration', async (t) => {
    let workerAllocations = 0;
    const manager = await createManager(t, {
        auth: {
            ...authAdapter(),
            subscribeInvalidation: () => { throw new Error('subscription failed'); },
        },
        workerFactory: () => { workerAllocations += 1; return new FakeWorker(); },
    });
    await assert.rejects(
        manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 }),
        /subscription failed/,
    );
    assert.equal(workerAllocations, 1);
    assert.equal(manager.activeCount(), 0);
    assert.deepEqual([...manager.userCounts], []);
    assert.deepEqual([...manager.authCounts], []);
});

test('synchronous auth invalidation rejects discovery and session admission without leaving authority', async (t) => {
    let unsubscribes = 0;
    let allocations = 0;
    const auth = {
        ...authAdapter(),
        subscribeInvalidation: (_lease, listener) => {
            listener('revoked');
            return () => { unsubscribes += 1; };
        },
    };
    const manager = await createManager(t, {
        auth,
        workerFactory: () => { allocations += 1; return new FakeWorker(); },
        targetResolver: {
            async discover() {
                return {
                    agentTargetsAvailable: false,
                    targets: [{
                        kind: 'box',
                        directory: { relativePath: 'Projects' },
                        label: 'Ploinky Box',
                        detail: 'Workspace runtime',
                        access: 'rw',
                        cwdDisplay: '/workspace/Projects',
                    }],
                };
            },
        },
    });

    await assert.rejects(
        manager.discoverTargets({ req: {}, routePlan: routePlan(), directory: 'Projects' }),
        { code: 'WEBTTY_AUTH_INVALID' },
    );
    assert.deepEqual(manager.launchStore.counts(), { batches: 0, launches: 0 });
    await assert.rejects(
        manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' }),
        { code: 'WEBTTY_AUTH_INVALID' },
    );
    assert.equal(allocations, 1);
    assert.equal(manager.activeCount(), 0);
    assert.deepEqual([...manager.userCounts], []);
    assert.deepEqual([...manager.authCounts], []);
    assert.equal(unsubscribes, 2);
});

test('auth invalidation during asynchronous startup waits for cleanup and removes late durable evidence', async (t) => {
    let listener = null;
    let resolveCreate;
    let createEntered;
    const entered = new Promise((resolve) => { createEntered = resolve; });
    const store = recordStore();
    store.create = async (value) => {
        store.calls.created += 1;
        createEntered();
        await new Promise((resolve) => { resolveCreate = resolve; });
        return { fileName: 'record.json', record: { ...value } };
    };
    const worker = new FakeWorker();
    const manager = await createManager(t, {
        auth: {
            ...authAdapter(),
            subscribeInvalidation: (_lease, callback) => {
                listener = callback;
                return () => { listener = null; };
            },
        },
        recordStore: store,
        workerFactory: () => worker,
    });

    const creation = manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    await entered;
    const invalidation = manager.closeAll('auth_revoked');
    resolveCreate();
    await assert.rejects(creation, { code: 'WEBTTY_AUTH_INVALID' });
    await invalidation;

    assert.equal(listener, null);
    assert.equal(manager.activeCount(), 0);
    assert.equal(worker.closed, 1);
    assert.equal(store.calls.removed, 1);
    assert.deepEqual([...manager.userCounts], []);
    assert.deepEqual([...manager.authCounts], []);
});

test('externally cancelled create does not reject before its post-startup cleanup finishes', async (t) => {
    let resolveCreate;
    let createEntered;
    const entered = new Promise((resolve) => { createEntered = resolve; });
    let releaseRemoval;
    const removalBarrier = new Promise((resolve) => { releaseRemoval = resolve; });
    const store = recordStore();
    store.create = async (value) => {
        createEntered();
        await new Promise((resolve) => { resolveCreate = resolve; });
        return { fileName: 'record.json', record: { ...value } };
    };
    store.remove = async () => {
        await removalBarrier;
        store.calls.removed += 1;
        return true;
    };
    const manager = await createManager(t, {
        recordStore: store,
        workerFactory: () => new FakeWorker(),
    });
    const creation = manager.create({
        req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24,
    });
    await entered;
    const shutdown = manager.closeAll('router_shutdown');
    resolveCreate();
    let creationSettled = false;
    void creation.catch(() => {}).then(() => { creationSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(creationSettled, false);
    releaseRemoval();
    await assert.rejects(creation, { code: 'WEBTTY_AUTH_INVALID' });
    await shutdown;
    assert.equal(store.calls.removed, 1);
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

test('router shutdown joins cleanup that already removed its session from the live map', async (t) => {
    let releaseCleanup;
    const cleanupBarrier = new Promise((resolve) => { releaseCleanup = resolve; });
    const worker = new FakeWorker();
    worker.close = async function close() {
        if (this.closed) return;
        this.closed += 1;
        await cleanupBarrier;
        this.exited = true;
    };
    const manager = await createManager(t, { workerFactory: () => worker });
    const created = await manager.create({
        req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24,
    });
    const firstClose = manager.closeSession(created.id, 'first_close');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.activeCount(), 0);
    let shutdownResolved = false;
    const shutdown = manager.closeAll('router_shutdown').then(() => { shutdownResolved = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownResolved, false);
    releaseCleanup();
    await Promise.all([firstClose, shutdown]);
    assert.equal(shutdownResolved, true);
});

test('throwing auth unsubscribe cannot bypass worker cleanup or quota release', async (t) => {
    const store = recordStore();
    const worker = new FakeWorker();
    const manager = await createManager(t, {
        recordStore: store,
        workerFactory: () => worker,
    });
    const created = await manager.create({
        req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24,
    });
    const session = manager.sessions.get(created.id);
    session.unsubscribeAuth = () => { throw new Error('unsubscribe broke'); };
    assert.equal(await manager.closeSession(session, 'test'), true);
    assert.equal(worker.closed, 1);
    assert.equal(store.calls.removed, 1);
    assert.equal(session.closed, true);
    assert.equal(session.released, true);
    assert.deepEqual([...manager.userCounts], []);
    assert.deepEqual([...manager.authCounts], []);
});

test('already-closed and throwing SSE attachments preserve bounded detach cleanup', async (t) => {
    for (const scenario of ['already-closed', 'initial-write', 'replay-write']) {
        await t.test(scenario, async (t2) => {
            const store = recordStore();
            const worker = new FakeWorker();
            const manager = await createManager(t2, {
                recordStore: store,
                workerFactory: () => worker,
                limits: { streamDetachGraceMs: 10 },
            });
            const plan = routePlan();
            const created = await manager.create({
                req: {}, routePlan: plan, cwdRelative: '', cols: 80, rows: 24,
            });
            const session = await manager.validateOwnership({}, plan, created.id);
            if (scenario === 'replay-write') {
                worker.emit('output', { sequence: 1, data: 'replay me' });
            }
            const request = new EventEmitter();
            request.destroyed = scenario === 'already-closed';
            let writes = 0;
            const response = {
                writableEnded: false,
                destroyed: false,
                writableLength: 0,
                write() {
                    writes += 1;
                    if (scenario === 'initial-write'
                        || (scenario === 'replay-write' && writes === 2)) {
                        throw new Error('socket closed during write');
                    }
                    return true;
                },
                end() { this.writableEnded = true; },
            };
            assert.equal(manager.attachStream(session, request, response), false);
            await new Promise((resolve) => setTimeout(resolve, 35));
            assert.equal(manager.activeCount(), 0);
            assert.equal(worker.closed, 1);
            assert.equal(store.calls.removed, 1);
        });
    }
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

test('cleanup evidence write is serialized ahead of an adjacent worker exit', async (t) => {
    const store = recordStore();
    const order = [];
    let markEntered;
    let releaseMark;
    const entered = new Promise((resolve) => { markEntered = resolve; });
    const barrier = new Promise((resolve) => { releaseMark = resolve; });
    store.markCleanupUnproven = async (handle) => {
        store.calls.marked += 1;
        order.push('mark-start');
        markEntered();
        await barrier;
        handle.record.cleanupState = 'unproven';
        order.push('mark-finish');
        return true;
    };
    store.confirmReclaimed = async () => {
        store.calls.confirmed += 1;
        order.push('confirm');
        return true;
    };
    const worker = new FakeWorker();
    const manager = await createManager(t, {
        recordStore: store,
        workerFactory: () => worker,
    });
    await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 });
    worker.emit('terminal-error', { category: 'cleanup-unproven' });
    await entered;
    worker.emit('process-exit', { category: 'worker_process_exit' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['mark-start']);
    assert.equal(store.calls.confirmed, 0);

    releaseMark();
    await Promise.allSettled([...manager.inFlightCloses]);
    assert.deepEqual(order, ['mark-start', 'mark-finish', 'confirm']);
    assert.equal(store.calls.removed, 0);
});

test('a delayed ready write cannot overwrite adjacent cleanup-unproven evidence', async (t) => {
    const store = recordStore();
    const baseCreate = store.create;
    const baseUpdate = store.update;
    let recordHandle;
    let readyEntered;
    let releaseReady;
    const entered = new Promise((resolve) => { readyEntered = resolve; });
    const barrier = new Promise((resolve) => { releaseReady = resolve; });
    store.create = async (value) => {
        recordHandle = await baseCreate(value);
        return recordHandle;
    };
    store.update = async (handle, value) => {
        if (value.ptyState === 'pty-ready') {
            readyEntered();
            await barrier;
        }
        return baseUpdate(handle, value);
    };
    const worker = new FakeWorker();
    const manager = await createManager(t, {
        recordStore: store,
        workerFactory: () => worker,
    });
    const creation = manager.create({
        req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24,
    });
    await entered;
    worker.emit('terminal-error', { category: 'cleanup-unproven' });
    worker.emit('process-exit', { category: 'worker_process_exit' });
    releaseReady();

    await assert.rejects(creation, { code: 'WEBTTY_AUTH_INVALID' });
    await Promise.allSettled([...manager.inFlightCloses]);
    assert.equal(recordHandle.record.ptyState, 'pty-ready');
    assert.equal(recordHandle.record.cleanupState, 'unproven');
    assert.equal(store.calls.marked, 1);
    assert.equal(store.calls.removed, 0);
});

test('Box terminal-exit never proves cleanup for a durable pty-starting record', async (t) => {
    for (const lateCleanupError of [false, true]) {
        await t.test(lateCleanupError ? 'late cleanup error' : 'missing cleanup error', async (t2) => {
            const store = recordStore();
            let releaseStart;
            const startBarrier = new Promise((resolve) => { releaseStart = resolve; });
            const worker = new FakeWorker({ startPromise: startBarrier });
            const manager = await createManager(t2, {
                recordStore: store,
                workerFactory: () => worker,
            });
            const creation = manager.create({
                req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24,
            });
            while (![...manager.sessions.values()][0]?.recordHandle
                || [...manager.sessions.values()][0].recordHandle.record.ptyState !== 'pty-starting') {
                await new Promise((resolve) => setImmediate(resolve));
            }

            worker.emit('terminal-exit', { category: 'worker-error' });
            worker.emit('process-exit', { category: 'worker_process_exit' });
            await new Promise((resolve) => setImmediate(resolve));
            if (lateCleanupError) {
                worker.emit('terminal-error', { category: 'cleanup-unproven' });
            }
            releaseStart();

            await assert.rejects(creation, { code: 'WEBTTY_AUTH_INVALID' });
            await Promise.allSettled([...manager.inFlightCloses]);
            assert.equal(store.calls.removed, 0);
            assert.equal(store.calls.confirmed, 0);
            assert.equal(store.calls.marked, lateCleanupError ? 1 : 0);
            assert.deepEqual(manager.availability(), {
                ok: false,
                category: lateCleanupError ? 'cleanup-unproven' : 'terminal_cleanup_unproven',
            });
        });
    }
});

test('agent pty-starting close routes claimed worker cleanup through durable marker recovery', async (t) => {
    const targets = terminalTargets();
    const store = recordStore();
    store.recoverHandle = async () => {
        store.calls.recovered += 1;
        return {
            recovered: false,
            category: 'agent_startup_marker_survived',
            scope: 'target',
            target: targets[1],
        };
    };
    let releaseStart;
    const startBarrier = new Promise((resolve) => { releaseStart = resolve; });
    const worker = new FakeWorker({ startPromise: startBarrier });
    const manager = await createManager(t, {
        recordStore: store,
        agentProviderAvailable: true,
        agentWorkerFactory: () => worker,
        targetResolver: {
            async discover() { return { agentTargetsAvailable: true, targets }; },
            async revalidate({ target }) { return target; },
        },
    });
    const plan = routePlan();
    const discovery = await manager.discoverTargets({
        req: {}, routePlan: plan, directory: 'Projects',
    });
    const creation = manager.create({
        req: {}, routePlan: plan, launch: discovery.targets[1].launch,
    });
    while (![...manager.sessions.values()][0]?.recordHandle
        || [...manager.sessions.values()][0].recordHandle.record.ptyState !== 'pty-starting') {
        await new Promise((resolve) => setImmediate(resolve));
    }

    worker.emit('terminal-exit', { category: 'requested', cleanupProven: true });
    worker.emit('process-exit', { category: 'requested' });
    releaseStart();

    await assert.rejects(creation, { code: 'WEBTTY_AUTH_INVALID' });
    await Promise.allSettled([...manager.inFlightCloses]);
    assert.equal(store.calls.recovered, 1);
    assert.equal(store.calls.removed, 0);
    assert.equal(manager.isAgentTargetQuarantined(targets[1]), true);
    assert.equal(manager.providerAvailability().boxAvailable, true);
    assert.equal(manager.providerAvailability().agentAvailable, true);
});

test('abrupt worker exit is contained when the recorded terminal session is proven reclaimed', async (t) => {
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
    assert.deepEqual(manager.availability(), { ok: true });
    assert.equal(store.calls.confirmed, 1);
    assert.equal(store.calls.removed, 1);
});

test('abrupt worker exit preserves evidence and disables WebTTY when session cleanup is unproven', async (t) => {
    const store = recordStore();
    store.confirmReclaimed = async () => false;
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
    store.confirmReclaimed = async () => false;
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
        installBoxLaunchTestHelper(manager);
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
        installBoxLaunchTestHelper(manager);
        t2.after(() => manager.closeAll('test_cleanup'));
        await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
        now = 2_011;
        await manager.validateLiveSessions();
        assert.equal(manager.activeCount(), 0);
    });
});

test('validated PTY output refreshes idle activity while absolute lifetime remains authoritative', async (t) => {
    let now = 3_000;
    const worker = new FakeWorker();
    const manager = new WebttySessionManager({
        now: () => now,
        limits: {
            authenticationIntervalMs: 60_000,
            streamDetachGraceMs: 60_000,
            idleLifetimeMs: 10,
            absoluteLifetimeMs: 100,
        },
        auth: authAdapter(),
        recordStore: recordStore(),
        workerFactory: () => worker,
    });
    await manager.initialize();
    installBoxLaunchTestHelper(manager);
    t.after(() => manager.closeAll('test_cleanup'));
    await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });

    now = 3_009;
    worker.emit('output', { sequence: 1, data: 'still running' });
    now = 3_018;
    await manager.validateLiveSessions();
    assert.equal(manager.activeCount(), 1);

    now = 3_020;
    await manager.validateLiveSessions();
    assert.equal(manager.activeCount(), 0);
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

test('ownership rejects a route replaced during asynchronous authentication validation', async (t) => {
    let blockValidation = false;
    let enterValidation;
    let releaseValidation;
    const validationEntered = new Promise((resolve) => { enterValidation = resolve; });
    const validationGate = new Promise((resolve) => { releaseValidation = resolve; });
    const auth = authAdapter({
        validate: async () => {
            if (!blockValidation) return { ok: true };
            enterValidation();
            await validationGate;
            return { ok: true };
        },
    });
    const worker = new FakeWorker();
    const manager = await createManager(t, {
        auth,
        workerFactory: () => worker,
    });
    let current = true;
    const plan = routePlan();
    plan.lease.isCurrent = () => current;
    plan.lease.commit = () => current;
    const created = await manager.create({ req: {}, routePlan: plan, cwdRelative: '' });

    blockValidation = true;
    const ownership = manager.validateOwnership({}, plan, created.id);
    await validationEntered;
    current = false;
    releaseValidation();

    assert.equal(await ownership, null);
    assert.equal(worker.closed, 1);
    assert.equal(manager.activeCount(), 0);
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

test('startup failure releases each quota and preserves ambiguous pty-starting evidence', async (t) => {
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
    assert.equal(store.calls.removed, 0);
    assert.deepEqual(manager.availability(), { ok: false, category: 'terminal_cleanup_unproven' });
});

test('server-side launch consumption selects the separate agent provider exactly once', async (t) => {
    const targets = terminalTargets();
    const agentWorker = new FakeWorker();
    agentWorker.start = async function start() {
        return { recoveryEvidence: { exact: true } };
    };
    const revalidations = [];
    const manager = await createManager(t, {
        agentProviderAvailable: true,
        agentWorkerFactory: () => agentWorker,
        targetResolver: {
            async discover() {
                return { agentTargetsAvailable: true, targets };
            },
            async revalidate({ target }) {
                revalidations.push(target);
                return target;
            },
        },
    });
    const plan = routePlan();
    const discovery = await manager.discoverTargets({
        req: {}, routePlan: plan, directory: 'Projects',
    });
    assert.deepEqual(discovery.targets.map((target) => target.kind), ['box', 'agent']);
    assert.equal(JSON.stringify(discovery).includes(targets[1].containerId), false);
    assert.equal(JSON.stringify(discovery).includes(targets[1].translatedCwd), true);

    const selected = discovery.targets[1];
    const created = await manager.create({
        req: {}, routePlan: plan, launch: selected.launch, cols: 92, rows: 31,
    });
    assert.equal(created.target.kind, 'agent');
    assert.equal(created.target.cwdDisplay, '/code/Projects');
    assert.equal(revalidations.length, 3);
    assert.deepEqual(agentWorker.startFields, {
        runtime: 'podman',
        containerId: 'a'.repeat(64),
        targetUser: '1000:1000',
        translatedCwd: '/code/Projects',
        marker: manager.sessions.get(created.id).marker,
        cols: 92,
        rows: 31,
    });
    assert.equal(Object.hasOwn(agentWorker.startFields, 'argv'), false);
    assert.equal(Object.hasOwn(agentWorker.startFields, 'env'), false);

    await assert.rejects(
        manager.create({
            req: {}, routePlan: plan, launch: discovery.targets[0].launch, cols: 80, rows: 24,
        }),
        { code: 'WEBTTY_LAUNCH_NOT_FOUND' },
    );
});

test('an agent cleanup failure quarantines only the exact target and leaves Box terminals available', async (t) => {
    const targets = terminalTargets();
    const agentWorker = new FakeWorker();
    agentWorker.start = async () => ({ recoveryEvidence: { exact: true } });
    const store = recordStore();
    const manager = await createManager(t, {
        recordStore: store,
        agentProviderAvailable: true,
        agentWorkerFactory: () => agentWorker,
        targetResolver: {
            async discover() { return { agentTargetsAvailable: true, targets }; },
            async revalidate({ target }) { return target; },
        },
    });
    const plan = routePlan();
    const discovery = await manager.discoverTargets({ req: {}, routePlan: plan, directory: 'Projects' });
    await manager.create({ req: {}, routePlan: plan, launch: discovery.targets[1].launch });
    agentWorker.emit('terminal-error', { category: 'cleanup-unproven' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(manager.availability(), { ok: true });
    assert.equal(manager.providerAvailability().boxAvailable, true);
    assert.equal(manager.providerAvailability().agentAvailable, true);
    assert.equal(manager.isAgentTargetQuarantined(targets[1]), true);
    assert.equal(store.calls.marked, 1);
    assert.equal(store.calls.removed, 0);

    const box = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: 'Projects' });
    assert.equal(box.target.kind, 'box');
});

test('agent quarantine follows immutable container identity across enable generations until recovery proves it clear', async (t) => {
    const oldTarget = terminalTargets()[1];
    const sameContainerNewGeneration = Object.freeze({
        ...oldTarget,
        enableGeneration: 'enable-generation-replacement',
    });
    const replacementContainer = Object.freeze({
        ...sameContainerNewGeneration,
        containerId: 'c'.repeat(64),
        containerName: 'ploinky-agent-replacement',
    });
    const quarantinedStore = recordStore();
    quarantinedStore.recover = async () => ({
        ok: true,
        evidence: ['agent_cleanup_unconfirmed'],
        agentAvailable: true,
        quarantinedTargets: [{
            target: oldTarget,
            category: 'agent_cleanup_unconfirmed',
        }],
    });
    const quarantinedManager = await createManager(t, {
        recordStore: quarantinedStore,
        agentProviderAvailable: true,
    });

    assert.equal(quarantinedManager.isAgentTargetQuarantined(oldTarget), true);
    assert.equal(quarantinedManager.quarantinedAgentTargets.has(
        `podman:${oldTarget.containerId}:${oldTarget.enableGeneration}`,
    ), true);
    assert.equal(quarantinedManager.isAgentTargetQuarantined(sameContainerNewGeneration), true);
    assert.equal(quarantinedManager.isAgentTargetQuarantined(replacementContainer), false);

    const recoveredStore = recordStore();
    recoveredStore.recover = async () => ({
        ok: true,
        evidence: ['dead_unproven_record_removed'],
        agentAvailable: true,
        quarantinedTargets: [],
    });
    const recoveredManager = await createManager(t, {
        recordStore: recoveredStore,
        agentProviderAvailable: true,
    });
    assert.equal(recoveredManager.isAgentTargetQuarantined(sameContainerNewGeneration), false);
});

test('agent recovery-record removal failures disable agents only and preserve an active Box terminal', async (t) => {
    for (const mode of ['false', 'throw']) {
        await t.test(mode, async (t2) => {
            const targets = terminalTargets();
            const store = recordStore();
            store.remove = async (handle) => {
                store.calls.removed += 1;
                if (handle.record.targetKind !== 'agent') return true;
                if (mode === 'throw') throw new Error('agent record removal failed');
                return false;
            };
            const boxWorker = new FakeWorker();
            const agentWorker = new FakeWorker();
            agentWorker.start = async () => ({ recoveryEvidence: { exact: true } });
            const manager = await createManager(t2, {
                recordStore: store,
                workerFactory: () => boxWorker,
                agentProviderAvailable: true,
                agentWorkerFactory: () => agentWorker,
                targetResolver: {
                    async discover() { return { agentTargetsAvailable: true, targets }; },
                    async revalidate({ target }) { return target; },
                },
            });
            const box = await manager.create({
                req: {}, routePlan: routePlan(), cwdRelative: 'Projects',
            });
            const plan = routePlan();
            const discovery = await manager.discoverTargets({
                req: {}, routePlan: plan, directory: 'Projects',
            });
            const agent = await manager.create({
                req: {}, routePlan: plan, launch: discovery.targets[1].launch,
            });

            await manager.closeSession(agent.id, 'test_agent_close');
            await new Promise((resolve) => setImmediate(resolve));

            assert.deepEqual(manager.availability(), { ok: true });
            assert.deepEqual(manager.providerAvailability(), {
                ok: true,
                boxAvailable: true,
                agentAvailable: false,
            });
            assert.equal(manager.sessions.has(box.id), true);
            assert.equal(boxWorker.closed, 0);
            assert.equal(agentWorker.closed, 1);
            assert.equal(store.calls.removed, 1);
        });
    }
});

test('an unscoped agent recovery record removal failure remains globally fail-closed', async (t) => {
    const targets = terminalTargets();
    const store = recordStore();
    store.remove = async (handle) => {
        store.calls.removed += 1;
        return handle.record.targetKind === 'box';
    };
    const boxWorker = new FakeWorker();
    const agentWorker = new FakeWorker();
    agentWorker.start = async () => ({ recoveryEvidence: { exact: true } });
    const manager = await createManager(t, {
        recordStore: store,
        workerFactory: () => boxWorker,
        agentProviderAvailable: true,
        agentWorkerFactory: () => agentWorker,
        targetResolver: {
            async discover() { return { agentTargetsAvailable: true, targets }; },
            async revalidate({ target }) { return target; },
        },
    });
    const box = await manager.create({
        req: {}, routePlan: routePlan(), cwdRelative: 'Projects',
    });
    const plan = routePlan();
    const discovery = await manager.discoverTargets({
        req: {}, routePlan: plan, directory: 'Projects',
    });
    const agent = await manager.create({
        req: {}, routePlan: plan, launch: discovery.targets[1].launch,
    });
    const session = manager.sessions.get(agent.id);
    session.recordHandle.record.target = {
        ...session.recordHandle.record.target,
        containerName: '',
    };

    await manager.closeSession(agent.id, 'test_agent_close');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(manager.availability(), {
        ok: false,
        category: 'recovery_record_remove_unconfirmed',
    });
    assert.equal(manager.sessions.has(box.id), false);
    assert.equal(boxWorker.closed, 1);
});

test('target-local process evidence quarantines one agent without poisoning unrelated providers', async (t) => {
    const targets = [...terminalTargets()];
    const unrelated = Object.freeze({
        ...targets[1],
        containerId: 'c'.repeat(64),
        containerName: 'ploinky-agent-unrelated',
        instanceId: 'instance-unrelated',
        enableGeneration: 'enable-generation-unrelated',
        agentName: 'unrelated',
        label: 'unrelated',
        detail: 'demo/unrelated',
    });
    targets.push(unrelated);
    const agentWorker = new FakeWorker();
    agentWorker.start = async () => ({ recoveryEvidence: { exact: true } });
    const manager = await createManager(t, {
        agentProviderAvailable: true,
        agentWorkerFactory: () => agentWorker,
        targetResolver: {
            async discover() { return { agentTargetsAvailable: true, targets }; },
            async revalidate({ target }) { return target; },
        },
    });
    const plan = routePlan();
    const discovery = await manager.discoverTargets({
        req: {}, routePlan: plan, directory: 'Projects',
    });
    await manager.create({ req: {}, routePlan: plan, launch: discovery.targets[1].launch });
    agentWorker.emit('terminal-error', { category: 'target-evidence' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(manager.providerAvailability().boxAvailable, true);
    assert.equal(manager.providerAvailability().agentAvailable, true);
    assert.equal(manager.isAgentTargetQuarantined(targets[1]), true);
    assert.equal(manager.isAgentTargetQuarantined(unrelated), false);
    const box = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: 'Projects' });
    assert.equal(box.target.kind, 'box');
});

test('a systemic agent cleanup evidence failure disables all agents while Box remains available', async (t) => {
    const targets = terminalTargets();
    const agentWorker = new FakeWorker();
    agentWorker.start = async () => ({ recoveryEvidence: { exact: true } });
    const store = recordStore();
    const manager = await createManager(t, {
        recordStore: store,
        agentProviderAvailable: true,
        agentWorkerFactory: () => agentWorker,
        targetResolver: {
            async discover() { return { agentTargetsAvailable: true, targets }; },
            async revalidate({ target }) { return target; },
        },
    });
    const plan = routePlan();
    const discovery = await manager.discoverTargets({ req: {}, routePlan: plan, directory: 'Projects' });
    await manager.create({ req: {}, routePlan: plan, launch: discovery.targets[1].launch });
    agentWorker.emit('terminal-error', { category: 'cleanup-provider-unproven' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(manager.availability(), { ok: true });
    assert.deepEqual(manager.providerAvailability(), {
        ok: true,
        boxAvailable: true,
        agentAvailable: false,
    });
    assert.equal(store.calls.marked, 1);
    assert.equal(store.calls.removed, 0);
    const box = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: 'Projects' });
    assert.equal(box.target.kind, 'box');
});

test('an agent protocol failure disables only the agent provider and quiesces its sessions', async (t) => {
    const targets = terminalTargets();
    const agentWorker = new FakeWorker();
    agentWorker.start = async () => ({ recoveryEvidence: { exact: true } });
    const manager = await createManager(t, {
        agentProviderAvailable: true,
        agentWorkerFactory: () => agentWorker,
        targetResolver: {
            async discover() { return { agentTargetsAvailable: true, targets }; },
            async revalidate({ target }) { return target; },
        },
    });
    const plan = routePlan();
    const discovery = await manager.discoverTargets({ req: {}, routePlan: plan, directory: 'Projects' });
    await manager.create({ req: {}, routePlan: plan, launch: discovery.targets[1].launch });
    agentWorker.emit('error-category', { category: 'protocol_error' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(manager.availability(), { ok: true });
    assert.deepEqual(manager.providerAvailability(), {
        ok: true,
        boxAvailable: true,
        agentAvailable: false,
    });
    assert.equal(manager.activeCount(), 0);
    const box = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    assert.equal(box.target.kind, 'box');
});

test('systemic agent worker identity failure rolls back startup and disables only agents', async (t) => {
    const targets = terminalTargets();
    const store = recordStore();
    const agentWorker = new FakeWorker();
    agentWorker.spawn = async () => {
        const error = new Error('proc evidence failed');
        error.code = 'WEBTTY_AGENT_WORKER_IDENTITY_UNPROVEN';
        throw error;
    };
    const manager = await createManager(t, {
        recordStore: store,
        agentProviderAvailable: true,
        agentWorkerFactory: () => agentWorker,
        targetResolver: {
            async discover() { return { agentTargetsAvailable: true, targets }; },
            async revalidate({ target }) { return target; },
        },
    });
    const discovery = await manager.discoverTargets({
        req: {}, routePlan: routePlan(), directory: 'Projects',
    });
    await assert.rejects(manager.create({
        req: {}, routePlan: routePlan(), launch: discovery.targets[1].launch,
    }), { code: 'WEBTTY_AGENT_WORKER_IDENTITY_UNPROVEN' });
    assert.deepEqual(manager.providerAvailability(), {
        ok: true,
        boxAvailable: true,
        agentAvailable: false,
    });
    assert.equal(manager.activeCount(), 0);
    assert.equal(store.calls.created, 0);
});

test('dynamic discovery provider failure disables future agent probes while preserving Box', async (t) => {
    let discoveries = 0;
    const manager = await createManager(t, {
        agentProviderAvailable: true,
        targetResolver: {
            async discover() {
                discoveries += 1;
                return {
                    agentTargetsAvailable: false,
                    targets: [terminalTargets('Projects')[0]],
                };
            },
            async revalidate({ target }) { return target; },
        },
    });
    const result = await manager.discoverTargets({
        req: {}, routePlan: routePlan(), directory: 'Projects',
    });
    assert.equal(result.agentTargetsAvailable, false);
    assert.deepEqual(manager.providerAvailability(), {
        ok: true,
        boxAvailable: true,
        agentAvailable: false,
    });
    assert.equal(discoveries, 1);
    const box = await manager.create({ req: {}, routePlan: routePlan(), launch: result.targets[0].launch });
    assert.equal(box.target.kind, 'box');
});

test('abrupt ready agent-worker exit runs immediate exact recovery before closing', async (t) => {
    const targets = terminalTargets();
    const agentWorker = new FakeWorker();
    agentWorker.start = async () => ({ recoveryEvidence: { exact: true } });
    const store = recordStore();
    const manager = await createManager(t, {
        recordStore: store,
        agentProviderAvailable: true,
        agentWorkerFactory: () => agentWorker,
        targetResolver: {
            async discover() { return { agentTargetsAvailable: true, targets }; },
            async revalidate({ target }) { return target; },
        },
    });
    const plan = routePlan();
    const discovery = await manager.discoverTargets({ req: {}, routePlan: plan, directory: 'Projects' });
    await manager.create({ req: {}, routePlan: plan, launch: discovery.targets[1].launch });
    agentWorker.emit('process-exit', { category: 'worker_process_exit' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(store.calls.recovered, 1);
    assert.equal(store.calls.confirmed, 0);
    assert.equal(manager.activeCount(), 0);
    assert.equal(manager.isAgentTargetQuarantined(targets[1]), false);
    assert.equal(manager.providerAvailability().agentAvailable, true);
});

test('same-agent starts are serialized around exact ExecID discovery', async (t) => {
    const targets = terminalTargets();
    let releaseFirst;
    let firstEntered;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const entered = new Promise((resolve) => { firstEntered = resolve; });
    let starts = 0;
    const workers = [new FakeWorker(), new FakeWorker()];
    for (const worker of workers) {
        worker.start = async function start() {
            starts += 1;
            if (starts === 1) {
                firstEntered();
                await firstGate;
            }
            return { recoveryEvidence: { exact: true, ordinal: starts } };
        };
    }
    const manager = await createManager(t, {
        agentProviderAvailable: true,
        agentWorkerFactory: () => workers.shift(),
        targetResolver: {
            async discover() { return { agentTargetsAvailable: true, targets }; },
            async revalidate({ target }) { return target; },
        },
    });
    const plan = routePlan();
    const firstDiscovery = await manager.discoverTargets({ req: {}, routePlan: plan, directory: 'Projects' });
    const secondDiscovery = await manager.discoverTargets({ req: {}, routePlan: plan, directory: 'Projects' });
    const first = manager.create({ req: {}, routePlan: plan, launch: firstDiscovery.targets[1].launch });
    await entered;
    const second = manager.create({ req: {}, routePlan: plan, launch: secondDiscovery.targets[1].launch });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(starts, 2);
});

test('same-agent start stays queued until a failed pty-starting attempt finishes exact recovery', async (t) => {
    const targets = terminalTargets();
    const events = [];
    let releaseRecovery;
    let enterRecovery;
    const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
    const recoveryEntered = new Promise((resolve) => { enterRecovery = resolve; });
    const store = recordStore();
    let recoveryCalls = 0;
    store.recoverHandle = async function recoverHandle(handle) {
        recoveryCalls += 1;
        events.push(`recover-${recoveryCalls}-begin`);
        if (recoveryCalls === 1) {
            enterRecovery();
            await recoveryGate;
        }
        assert.equal(await this.remove(handle), true);
        events.push(`recover-${recoveryCalls}-end`);
        return { recovered: true, category: 'verified_agent_startup_reclaimed' };
    };
    const firstWorker = new FakeWorker();
    firstWorker.start = async () => {
        events.push('first-start');
        throw new Error('first agent start failed after durable pty-starting');
    };
    const secondWorker = new FakeWorker();
    secondWorker.start = async () => {
        events.push('second-start');
        return { recoveryEvidence: { exact: true, ordinal: 2 } };
    };
    const workers = [firstWorker, secondWorker];
    const manager = await createManager(t, {
        recordStore: store,
        agentProviderAvailable: true,
        agentWorkerFactory: () => workers.shift(),
        targetResolver: {
            async discover() { return { agentTargetsAvailable: true, targets }; },
            async revalidate({ target }) { return target; },
        },
    });
    const plan = routePlan();
    const firstDiscovery = await manager.discoverTargets({
        req: {}, routePlan: plan, directory: 'Projects',
    });
    const secondDiscovery = await manager.discoverTargets({
        req: {}, routePlan: plan, directory: 'Projects',
    });
    const first = manager.create({
        req: {}, routePlan: plan, launch: firstDiscovery.targets[1].launch,
    });
    await recoveryEntered;
    const second = manager.create({
        req: {}, routePlan: plan, launch: secondDiscovery.targets[1].launch,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['first-start', 'recover-1-begin']);

    releaseRecovery();
    await assert.rejects(first, /first agent start failed/);
    const admitted = await second;
    assert.equal(admitted.target.kind, 'agent');
    assert.deepEqual(events.slice(0, 4), [
        'first-start',
        'recover-1-begin',
        'recover-1-end',
        'second-start',
    ]);
});

test('route replacement during asynchronous startup rejects and reclaims the terminal', async (t) => {
    let current = true;
    let releaseStart;
    let startEntered;
    const startGate = new Promise((resolve) => { releaseStart = resolve; });
    const entered = new Promise((resolve) => { startEntered = resolve; });
    const worker = new FakeWorker();
    worker.start = async function start(fields) {
        this.startFields = fields;
        startEntered();
        await startGate;
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
    };
    const manager = await createManager(t, { workerFactory: () => worker });
    const plan = routePlan();
    plan.lease.isCurrent = () => current;
    const creation = manager.create({ req: {}, routePlan: plan, cwdRelative: '' });
    await entered;
    current = false;
    releaseStart();
    await assert.rejects(creation, { code: 'WEBTTY_GENERATION_CHANGED' });
    assert.equal(worker.closed, 1);
    assert.equal(manager.activeCount(), 0);
});

test('final authentication revalidation rejects a terminal that lost authority during startup', async (t) => {
    let validations = 0;
    const worker = new FakeWorker();
    const manager = await createManager(t, {
        auth: authAdapter({
            validate: async () => {
                validations += 1;
                return validations < 3
                    ? { ok: true }
                    : { ok: false, reason: 'administrator_revoked' };
            },
        }),
        workerFactory: () => worker,
    });
    await assert.rejects(
        manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' }),
        { code: 'WEBTTY_ADMIN_REQUIRED' },
    );
    assert.equal(worker.closed, 1);
    assert.equal(manager.activeCount(), 0);
});
