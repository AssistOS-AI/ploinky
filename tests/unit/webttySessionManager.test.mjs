import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { buildShellEnvironment } from '../../core-services/webtty/environment.mjs';
import { WebttySessionManager } from '../../cli/server/webtty/sessionManager.mjs';
import { TerminalTargetResolver, terminalTargetRouteBinding } from '../../cli/server/webtty/terminalTargetResolver.mjs';
import { mintSessionJwt } from '../../cli/server/auth/localService.js';
import { sessionTokenService } from '../../cli/server/authHandlers/shared.js';
import { browserPrincipal, createBrowserSessionLease, validateBrowserSessionLease } from '../../cli/server/webtty/authLease.mjs';
import { onAuthenticatedRequestDecision, publishAuthenticatedRequestDecision } from '../../cli/server/auth/authenticatedRequestEvents.mjs';

// The Router's workspace root is the host-selected path mounted at itself.
const WORKSPACE_ROOT = '/home/user/work space/proiect';

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

function streamResponse() {
    return Object.assign(new EventEmitter(), {
        body: '', writableEnded: false, destroyed: false, writableLength: 0,
        write(value) { this.body += value; return true; },
        end() { this.writableEnded = true; },
    });
}

async function createAgentSession(manager, req = {}) {
    const plan = routePlan();
    const selectedLease = req.lease || LEASE;
    const discovery = manager.launchStore.createDiscovery({
        owner: { userId: selectedLease.userId, sessionFingerprint: selectedLease.sessionFingerprint },
        routeBinding: terminalTargetRouteBinding(plan), targets: terminalTargets(),
    });
    const created = await manager.create({ req, routePlan: plan, launch: discovery.targets[1].launch });
    return manager.sessions.get(created.id);
}

// Every stream binds to a server-issued view of its own principal (plan r3
// 3.4 hard cut); these direct manager streams open one view per stream.
function attachViewStream(manager, session, req, res, cursor = '', plan = session?.routePlan) {
    const streamLease = manager.auth.createLease(req);
    const view = manager.createView(session, browserPrincipal(streamLease.mode, streamLease.userId));
    return manager.attachStream(session, req, res, cursor, plan, view.id);
}

async function settleTarget(session) {
    await session.targetValidation?.promise;
    await new Promise(resolve => setImmediate(resolve));
}

function terminalTargets(relativePath = 'Projects') {
    const directory = Object.freeze({
        relativePath,
        absolutePath: `${WORKSPACE_ROOT}/${relativePath}`,
        identity: Object.freeze({ dev: '1', ino: '2' }),
    });
    return Object.freeze([
        Object.freeze({
            kind: 'box',
            directory,
            label: 'Ploinky Box',
            detail: 'Workspace runtime',
            access: 'rw',
            cwdDisplay: `${WORKSPACE_ROOT}/${relativePath}`,
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
        workspaceRoot: WORKSPACE_ROOT,
        limits: {
            authenticationIntervalMs: 60_000,
            streamDetachGraceMs: 1_000,
            ...options.limits,
        },
        auth: options.auth || authAdapter(),
        recordStore: options.recordStore || recordStore(),
        workerFactory: options.workerFactory || (() => new FakeWorker()),
        agentWorkerFactory: options.agentWorkerFactory || (() => new FakeWorker()),
        launchStore: options.launchStore,
        targetResolver: options.targetResolver,
        homeProfiles: options.homeProfiles,
        agentProviderAvailable: options.agentProviderAvailable,
        audit: options.audit,
        now: options.now,
        capturePlan: options.capturePlan,
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

test('lease rejection audits contain only fixed startup phases and allowlisted reasons', async (t) => {
    const audits = [];
    let validation = { ok: true };
    const manager = await createManager(t, {
        auth: authAdapter({ validate: async () => validation }),
        audit: (event, fields) => audits.push({ event, ...fields }),
    });
    const unknownObject = { toString() { throw new Error('reason must not be coerced'); } };
    const cases = [
        ...['invalid_lease', 'validation_failed', 'missing_or_expired', 'expired',
            'user_changed', 'session_changed', 'administrator_revoked'].map(reason => [reason, reason]),
        ['Bearer synthetic-secret jwt-current sess-stable auth-fingerprint', 'unknown'],
        [unknownObject, 'unknown'],
        [undefined, 'unknown'],
        [null, 'unknown'],
        ['', 'unknown'],
    ];
    for (const phase of ['before_agent_prepare', 'after_agent_ready']) {
        for (const [reason, expectedReason] of cases) {
            audits.length = 0;
            validation = { ok: false, reason };
            const code = reason === 'administrator_revoked' ? 'WEBTTY_ADMIN_REQUIRED' : 'WEBTTY_AUTH_INVALID';
            await assert.rejects(manager.revalidateLease(LEASE, phase), { code, message: code });
            assert.deepEqual(audits, [{ event: 'webtty_auth_lease_rejected', phase, reason: expectedReason }]);
        }
    }
    audits.length = 0;
    validation = { ok: true, session: { credential: 'must-not-be-audited' } };
    await manager.revalidateLease(LEASE, 'before_agent_prepare');
    await manager.revalidateLease(LEASE, 'after_agent_ready');
    validation = { ok: false, reason: 'expired' };
    await assert.rejects(manager.revalidateLease(LEASE), { code: 'WEBTTY_AUTH_INVALID' });
    await assert.rejects(manager.revalidateLease(LEASE, 'raw-private-phase'), { code: 'WEBTTY_AUTH_INVALID' });
    assert.deepEqual(audits, []);
});

test('agent startup rejection auditing preserves exact failure, worker cleanup, and quota release', async (t) => {
    for (const [failAt, phase] of [[3, 'before_agent_prepare'], [4, 'after_agent_ready']]) {
        for (const auditFailure of ['none', 'throws', 'rejects']) {
            await t.test(`${phase} with audit sink ${auditFailure}`, async (t2) => {
                let validations = 0;
                let preparations = 0;
                let starts = 0;
                const audits = [];
                const store = recordStore();
                const worker = new FakeWorker();
                const originalPrepare = worker.prepare.bind(worker);
                const originalStart = worker.start.bind(worker);
                worker.prepare = async (...args) => { preparations += 1; return originalPrepare(...args); };
                worker.start = async (...args) => { starts += 1; return originalStart(...args); };
                const manager = await createManager(t2, {
                    recordStore: store,
                    agentProviderAvailable: true,
                    agentWorkerFactory: () => worker,
                    targetResolver: { async revalidate({ target }) { return target; } },
                    auth: authAdapter({ validate: async () => (++validations === failAt
                        ? { ok: false, reason: 'session_changed' }
                        : { ok: true }) }),
                    audit: (event, fields) => {
                        audits.push({ event, ...fields });
                        if (event !== 'webtty_auth_lease_rejected') return;
                        if (auditFailure === 'throws') throw new Error('synthetic audit failure');
                        if (auditFailure === 'rejects') return Promise.reject(new Error('synthetic audit rejection'));
                    },
                });
                const plan = routePlan();
                const discovery = manager.launchStore.createDiscovery({
                    owner: { userId: LEASE.userId, sessionFingerprint: LEASE.sessionFingerprint },
                    routeBinding: terminalTargetRouteBinding(plan),
                    targets: terminalTargets(),
                    agentTargetsAvailable: true,
                });
                await assert.rejects(manager.create({
                    req: {}, routePlan: plan, launch: discovery.targets[1].launch,
                }), { code: 'WEBTTY_AUTH_INVALID', message: 'WEBTTY_AUTH_INVALID' });
                assert.deepEqual(audits.filter(row => row.event === 'webtty_auth_lease_rejected'), [{
                    event: 'webtty_auth_lease_rejected', phase, reason: 'session_changed',
                }]);
                assert.deepEqual(audits.filter(row => row.event === 'webtty_session_closed').map(row => row.reason), ['create_failed']);
                assert.equal(audits.some(row => row.event === 'webtty_session_created'), false);
                assert.equal(validations, failAt);
                assert.equal(preparations, failAt === 3 ? 0 : 1);
                assert.equal(starts, failAt === 3 ? 0 : 1);
                assert.equal(worker.closed, 1);
                assert.equal(store.calls.created, 1);
                assert.equal(store.calls.removed, 1);
                assert.equal(store.calls.confirmed, failAt === 3 ? 1 : 0);
                assert.equal(store.calls.recovered, failAt === 3 ? 0 : 1);
                assert.equal(manager.activeCount(), 0);
                assert.deepEqual([...manager.userCounts], []);
                assert.deepEqual([...manager.ownerIndex], []);
                assert.deepEqual([...manager.agentStartLocks], []);
                assert.deepEqual(manager.availability(), { ok: true });
            });
        }
    }
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
    assert.deepEqual([...manager.ownerIndex], []);
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
    assert.deepEqual([...manager.ownerIndex], []);
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
    assert.deepEqual([...manager.ownerIndex], []);
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
                        cwdDisplay: `${WORKSPACE_ROOT}/Projects`,
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
    assert.deepEqual([...manager.ownerIndex], []);
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
    assert.deepEqual([...manager.ownerIndex], []);
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

test('principal, global, and creation-rate quotas fail before extra workers', async (t) => {
    await t.test('multiple logins share principal quota and global quota', async (t2) => {
        let allocations = 0;
        const manager = await createManager(t2, {
            auth: requestAuthAdapter(),
            limits: { global: 2, perUser: 2, createsPerWindow: 10 },
            workerFactory: () => { allocations += 1; return new FakeWorker(); },
        });
        await manager.create({ req: { lease: lease('a') }, routePlan: routePlan(), cwdRelative: '' });
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
    assert.deepEqual(worker.startFields.shellEnv, buildShellEnvironment({}, { workspaceRoot: WORKSPACE_ROOT }));
    assert.equal(worker.startFields.shellEnv.PLOINKY_WORKSPACE_ROOT, WORKSPACE_ROOT);
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

test('browser stream close detaches without reclaiming the terminal', async (t) => {
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
    assert.equal(attachViewStream(manager, session, request, response), true);
    request.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(manager.activeCount(), 1);
    assert.equal(session.viewers.size, 0);
    assert.equal(worker.closed, 0);
    assert.equal(store.calls.removed, 0);
    await manager.closeSession(session, 'test_cleanup');
    assert.equal(worker.closed, 1);
    assert.equal(store.calls.removed, 1);
    assert.deepEqual([...manager.userCounts], []);
    assert.deepEqual([...manager.ownerIndex], []);
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
    attachViewStream(manager, session, new EventEmitter(), streamResponse());
    session.viewers.values().next().value.unsubscribeAuth = () => { throw new Error('unsubscribe broke'); };
    assert.equal(await manager.closeSession(session, 'test'), true);
    assert.equal(worker.closed, 1);
    assert.equal(store.calls.removed, 1);
    assert.equal(session.closed, true);
    assert.equal(session.released, true);
    assert.deepEqual([...manager.userCounts], []);
    assert.deepEqual([...manager.ownerIndex], []);
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
            assert.equal(attachViewStream(manager, session, request, response), false);
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

test('reclamation exceptions retain a bounded reason without weakening failed cleanup', async (t) => {
    const sensitive = 'private-token-and-workspace-path';
    const cases = [
        [{ code: 'WEBTTY_PROCESS_IDENTITY_UNPROVEN', category: 'proc-scan-timeout' }, 'proc-scan-timeout'],
        [{ code: 'WEBTTY_PROCESS_IDENTITY_UNPROVEN', category: 'proc-scan-limit' }, 'proc-scan-limit'],
        [{ code: 'WEBTTY_PROCESS_IDENTITY_UNPROVEN', category: 'proc-file-limit' }, 'proc-file-limit'],
        [{ code: 'EACCES' }, 'EACCES'],
        [{ code: 'EPERM' }, 'EPERM'],
        [{ code: 'EIO' }, 'EIO'],
        [{ code: 'EMFILE' }, 'EMFILE'],
        [{ code: 'ENFILE' }, 'ENFILE'],
        [{ message: 'invalid proc stat' }, 'invalid-proc-stat'],
        [{ message: 'incomplete proc stat' }, 'incomplete-proc-stat'],
        [{ message: 'incomplete proc identity' }, 'incomplete-proc-identity'],
        [{ message: 'proc identity changed while reading' }, 'process-changed'],
        [{ message: 'proc identity changed while enumerating session' }, 'session-member-changed'],
        [{ message: 'session membership evidence is invalid' }, 'invalid-session-membership'],
        [{ code: sensitive, category: sensitive, message: sensitive }, 'unknown'],
        [{ code: 'WEBTTY_PROCESS_IDENTITY_UNPROVEN', category: sensitive }, 'unknown'],
        [{ code: { toString() { throw new Error(sensitive); } }, message: Symbol(sensitive) }, 'unknown'],
    ];
    for (const [fields, reason] of cases) {
        await t.test(reason, async (t2) => {
            const store = recordStore();
            store.confirmReclaimed = async () => { throw Object.assign(new Error(sensitive), fields); };
            const events = [];
            const manager = await createManager(t2, {
                recordStore: store,
                audit: (event, details) => events.push({ event, details }),
            });
            const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 });
            await manager.closeSession(created.id, 'requested');
            await manager.closeSession(created.id, 'requested');
            assert.deepEqual(events.filter(entry => entry.event === 'webtty_reclamation_check_failed'), [{
                event: 'webtty_reclamation_check_failed',
                details: { targetKind: 'box', reason },
            }]);
            assert.equal(JSON.stringify(events).includes(sensitive), false);
            assert.equal(manager.activeCount(), 0);
            assert.deepEqual(manager.availability(), { ok: false, category: 'terminal_reclamation_check_failed' });
            assert.equal(store.calls.removed, 0);
            await assert.rejects(manager.discoverTargets({ req: {}, routePlan: routePlan(), directory: '' }), {
                code: 'WEBTTY_UNAVAILABLE',
            });
        });
    }
});

test('reclamation auditing cannot throw, reject, or delay failed cleanup and quota release', async (t) => {
    for (const mode of ['throw', 'reject', 'pending']) {
        await t.test(mode, async (t2) => {
            const store = recordStore();
            store.confirmReclaimed = async () => { throw new Error('incomplete proc stat'); };
            const manager = await createManager(t2, {
                recordStore: store,
                audit: (event) => {
                    if (event !== 'webtty_reclamation_check_failed') return;
                    if (mode === 'throw') throw new Error('audit unavailable');
                    if (mode === 'reject') return Promise.reject(new Error('audit unavailable'));
                    return new Promise(() => {});
                },
            });
            const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 });
            await manager.closeSession(created.id, 'requested');
            assert.deepEqual(manager.availability(), { ok: false, category: 'terminal_reclamation_check_failed' });
            assert.equal(manager.activeCount(), 0);
            assert.equal(manager.userCounts.size, 0);
            assert.equal(manager.ownerIndex.size, 0);
            assert.equal(store.calls.removed, 0);
        });
    }
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
            workspaceRoot: WORKSPACE_ROOT,
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
            workspaceRoot: WORKSPACE_ROOT,
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
        workspaceRoot: WORKSPACE_ROOT,
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
    await t.test('old cursor resyncs and replays retained output', async (t2) => {
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
        assert.equal(attachViewStream(manager, session, new EventEmitter(), response, '0'), true);
        assert.match(response.body, /event: resync/);
        assert.match(response.body, /id: 2/);
        assert.match(response.body, /id: 3/);
        assert.equal(response.writableEnded, false);
    });
    await t.test('SSE high water', async (t2) => {
        const worker = new FakeWorker();
        const manager = await createManager(t2, {
            workerFactory: () => worker,
            limits: { viewerQueueBytes: 16 },
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
        attachViewStream(manager, session, request, response);
        worker.emit('output', { sequence: 1, data: 'this output exceeds the writable bound' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(manager.activeCount(), 1);
        assert.equal(session.viewers.size, 0);
        assert.equal(worker.closed, 0);
    });
});

test('ownership binds principal and host route; any administrator can stop and replay DELETE', async (t) => {
    const manager = await createManager(t, {
        auth: requestAuthAdapter(),
        workerFactory: () => new FakeWorker(),
    });
    const ownerLease = lease('owner');
    const ownerRequest = { lease: ownerLease };
    const ownerPlan = routePlan();
    const created = await manager.create({ req: ownerRequest, routePlan: ownerPlan, cwdRelative: '' });

    assert.ok(await manager.validateOwnership({ lease: lease('other-login') }, ownerPlan, created.id));
    await assert.rejects(manager.validateOwnership({ lease: lease('owner', 'local:other') }, ownerPlan, created.id),
        { code: 'WEBTTY_OWNER_REQUIRED' });
    const otherHost = routePlan();
    otherHost.host = 'other.example.test';
    otherHost.hostSelection.host = 'other.example.test';
    assert.equal(await manager.validateOwnership(ownerRequest, otherHost, created.id), null);
    const otherGeneration = routePlan();
    otherGeneration.lease.id = 'generation-b';
    assert.ok(await manager.validateOwnership(ownerRequest, otherGeneration, created.id));
    assert.ok(await manager.validateOwnership(ownerRequest, ownerPlan, created.id));

    assert.equal(await manager.closeOwned(ownerRequest, ownerPlan, created.id), true);
    assert.equal(await manager.closeOwned(ownerRequest, ownerPlan, created.id), true);
    assert.equal(await manager.closeOwned({ lease: lease('other-login') }, ownerPlan, created.id), true);
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

    await assert.rejects(ownership, { code: 'WEBTTY_GENERATION_CHANGED' });
    assert.equal(worker.closed, 0);
    assert.equal(manager.activeCount(), 1);
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
    const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '', cols: 80, rows: 24 });
    attachViewStream(manager, manager.sessions.get(created.id), new EventEmitter(), streamResponse());
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
    assert.deepEqual([...manager.ownerIndex], []);
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

test('the session manager requires an explicit clean workspace root', () => {
    for (const workspaceRoot of [undefined, '', 'relative', '/home/user/project/', '/home/user/../project']) {
        assert.throws(() => new WebttySessionManager({
            workspaceRoot,
            recordStore: recordStore(),
            workerFactory: () => new FakeWorker(),
        }), { code: 'WEBTTY_CWD_INVALID' });
    }
});

test('multiple viewers share ordered output and only the owner can write or resize', async (t) => {
    const worker = new FakeWorker();
    const manager = await createManager(t, { auth: requestAuthAdapter(), workerFactory: () => worker });
    const plan = routePlan();
    const owner = { lease: lease('owner') };
    const watcher = { lease: lease('watcher', 'other-admin') };
    const created = await manager.create({ req: owner, routePlan: plan, cwdRelative: '' });
    const session = manager.sessions.get(created.id);
    const responses = [streamResponse(), streamResponse()];
    const requests = [Object.assign(new EventEmitter(), owner), Object.assign(new EventEmitter(), watcher)];
    requests.forEach((req, index) => attachViewStream(manager, session, req, responses[index]));
    worker.emit('output', { sequence: 1, data: 'shared' });
    responses.forEach(res => assert.match(res.body, /id: 1\nevent: output/));
    for (const need of ['input', 'resize']) {
        await assert.rejects(manager.authorize(watcher, plan, created.id, need), { code: 'WEBTTY_OWNER_REQUIRED' });
    }
    const secondOwner = await manager.authorize({ lease: lease('other-device') }, plan, created.id, 'input');
    await Promise.all([manager.input(secondOwner, 'first'), manager.input(session, 'second')]);
    assert.deepEqual(worker.inputs, ['first', 'second']);
    assert.equal(await manager.closeAuthorized(watcher, plan, created.id), true);
    assert.equal(await manager.closeAuthorized(watcher, plan, created.id), true);
    assert.equal(manager.viewerCount, 0);
});

test('a near-1 MiB replay is paced across drains and remains ahead of live output', async (t) => {
    const worker = new FakeWorker();
    const manager = await createManager(t, { workerFactory: () => worker });
    const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    const session = manager.sessions.get(created.id);
    for (let sequence = 1; sequence <= 63; sequence += 1) worker.emit('output', { sequence, data: 'x'.repeat(16_000) });
    const response = streamResponse();
    response.write = function write(value) {
        this.body += value;
        this.writableLength += Buffer.byteLength(value);
        return this.writableLength < 32_000;
    };
    assert.equal(attachViewStream(manager, session, new EventEmitter(), response), true);
    const viewer = session.viewers.values().next().value;
    assert.ok(viewer.queuedBytes > 900_000);
    worker.emit('output', { sequence: 64, data: 'live' });
    let drains = 0;
    while (viewer.waitingDrain || viewer.queue.length) {
        assert.ok(++drains < 100);
        response.writableLength = 0;
        response.emit('drain');
    }
    assert.equal((response.body.match(/event: output/g) || []).length, 64);
    assert.ok(response.body.indexOf('id: 63\n') < response.body.indexOf('id: 64\n'));
    assert.doesNotMatch(response.body, /slow_viewer/);
    assert.equal(worker.closed, 0);
});

test('never-draining viewer detaches at 30 seconds while another viewer and worker survive', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const worker = new FakeWorker();
    const manager = await createManager(t, { workerFactory: () => worker });
    const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    const session = manager.sessions.get(created.id);
    const slow = streamResponse();
    slow.write = function write(value) { this.body += value; return false; };
    const fast = streamResponse();
    attachViewStream(manager, session, new EventEmitter(), slow);
    attachViewStream(manager, session, new EventEmitter(), fast);
    worker.emit('output', { sequence: 1, data: 'still live' });
    t.mock.timers.tick(29_999);
    assert.equal(session.viewers.size, 2);
    t.mock.timers.tick(1);
    assert.equal(session.viewers.size, 1);
    assert.match(slow.body, /slow_viewer/);
    assert.match(fast.body, /still live/);
    assert.equal(worker.closed, 0);
});

test('byte and event rollover allow fresh replay, old-cursor resync and reject malformed/future cursors', async (t) => {
    for (const limits of [{ outputReplayBytes: 130 }, { outputReplayEvents: 2 }]) {
        const worker = new FakeWorker();
        const manager = await createManager(t, { workerFactory: () => worker, limits });
        const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
        const session = manager.sessions.get(created.id);
        for (let sequence = 1; sequence <= 3; sequence += 1) worker.emit('output', { sequence, data: 'x'.repeat(25) });
        for (const [cursor, event] of [['', 'replay-truncated'], ['0', 'resync']]) {
            const response = streamResponse();
            const request = new EventEmitter();
            assert.equal(attachViewStream(manager, session, request, response, cursor), true);
            assert.ok(response.body.indexOf(`event: ${event}`) < response.body.indexOf('event: output'));
            assert.match(response.body, /id: 3/);
            request.emit('close');
        }
        for (const cursor of ['4', 'nope', '1e0', '-1']) {
            const response = streamResponse();
            assert.equal(attachViewStream(manager, session, new EventEmitter(), response, cursor), false);
            assert.match(response.body, /event: reset/);
        }
    }
});

test('logout detaches just its viewer; detached shells are not auth checked; owner demotion closes all owner shells', async (t) => {
    const listeners = new Map();
    let checks = 0;
    const manager = await createManager(t, {
        auth: { ...requestAuthAdapter(),
            validateLease: async () => { checks += 1; return { ok: true }; },
            subscribeInvalidation: (value, listener) => {
                listeners.set(value.sessionFingerprint, listener);
                return () => listeners.delete(value.sessionFingerprint);
            },
        },
    });
    const plan = routePlan();
    const owner = { lease: lease('owner') };
    const a = await manager.create({ req: owner, routePlan: plan, cwdRelative: '' });
    const b = await manager.create({ req: owner, routePlan: plan, cwdRelative: '' });
    const session = manager.sessions.get(a.id);
    const response = streamResponse();
    attachViewStream(manager, session, Object.assign(new EventEmitter(), owner), response);
    listeners.get(owner.lease.sessionFingerprint)('logout');
    assert.match(response.body, /auth_logout/);
    assert.equal(session.viewers.size, 0);
    const previousChecks = checks;
    await manager.validateLiveSessions();
    assert.equal(checks, previousChecks);
    assert.equal(manager.activeCount(), 2);
    attachViewStream(manager, session, Object.assign(new EventEmitter(), owner), streamResponse());
    listeners.get(owner.lease.sessionFingerprint)('administrator_revoked');
    await Promise.allSettled([...manager.inFlightCloses]);
    assert.equal(manager.sessions.has(a.id), false);
    assert.equal(manager.sessions.has(b.id), false);
    assert.equal(manager.ownerIndex.size, 0);
});

test('production principal quota spans logins and viewer quotas release reusable slots', async (t) => {
    let allocations = 0;
    const manager = await createManager(t, {
        auth: requestAuthAdapter(),
        workerFactory: () => { allocations += 1; return new FakeWorker(); },
    });
    const plan = routePlan();
    const sessions = [];
    const requests = [];
    for (let index = 0; index < 8; index += 1) {
        const req = { lease: lease(index % 2 ? 'a' : 'b') };
        const created = await manager.create({ req, routePlan: plan, cwdRelative: '' });
        const session = manager.sessions.get(created.id);
        sessions.push(session);
        for (let viewer = 0; viewer < 8; viewer += 1) {
            const request = Object.assign(new EventEmitter(), req);
            requests.push(request);
            attachViewStream(manager, session, request, streamResponse());
        }
    }
    assert.equal(manager.viewerCount, 64);
    await assert.rejects(manager.create({ req: { lease: lease('c') }, routePlan: plan, cwdRelative: '' }),
        { code: 'WEBTTY_USER_QUOTA' });
    assert.equal(allocations, 8);
    assert.throws(() => attachViewStream(manager, sessions[0], Object.assign(new EventEmitter(), { lease: lease('a') }), streamResponse()),
        { code: 'WEBTTY_VIEWER_QUOTA' });
    const other = await manager.create({ req: { lease: lease('other', 'other-admin') }, routePlan: plan, cwdRelative: '' });
    assert.throws(() => attachViewStream(manager, manager.sessions.get(other.id), Object.assign(new EventEmitter(), { lease: lease('a') }), streamResponse()),
        { code: 'WEBTTY_VIEWER_QUOTA' });
    requests[0].emit('close');
    assert.equal(manager.viewerCount, 63);
    assert.equal(attachViewStream(manager, manager.sessions.get(other.id), Object.assign(new EventEmitter(), { lease: lease('a') }), streamResponse()), true);
    assert.equal(manager.viewerCount, 64);
});

test('production idle and absolute bounds and never-attached grace remain exact', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 1_000;
    const manager = await createManager(t, { now: () => now, limits: { streamDetachGraceMs: 15_000 } });
    const orphan = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    t.mock.timers.tick(14_999);
    assert.equal(manager.sessions.has(orphan.id), true);
    t.mock.timers.tick(1);
    await Promise.allSettled([...manager.inFlightCloses]);
    assert.equal(manager.tombstones.get(orphan.id).row.exitReason, 'stream_never_attached');
    const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    const session = manager.sessions.get(created.id);
    const request = new EventEmitter();
    attachViewStream(manager, session, request, streamResponse());
    request.emit('close');
    now += 60_000;
    await manager.validateLiveSessions();
    assert.equal(manager.sessions.has(created.id), true);
    now = session.createdAt + 24 * 60 * 60_000 - 1;
    await manager.validateLiveSessions();
    assert.equal(manager.sessions.has(created.id), true);
    now += 1;
    await manager.validateLiveSessions();
    assert.equal(session.closeReason, 'idle_timeout');
    const absolute = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    const longSession = manager.sessions.get(absolute.id);
    now = longSession.createdAt + 7 * 24 * 60 * 60_000;
    manager.touch(longSession);
    await manager.validateLiveSessions();
    assert.equal(longSession.closeReason, 'absolute_timeout');
});

test('list projection, cross-login attach, watcher dimensions and single-use session-bound tokens', async (t) => {
    const worker = new FakeWorker();
    const manager = await createManager(t, { auth: requestAuthAdapter(), workerFactory: () => worker });
    const plan = routePlan();
    const owner = { lease: lease('owner'), user: { displayName: '\n😀'.repeat(100) } };
    const watcher = { lease: lease('watcher', 'other-admin') };
    const created = await manager.create({ req: owner, routePlan: plan, cwdRelative: 'Projects' });
    const rows = await manager.listSessions({ req: watcher, routePlan: plan });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].isOwner, false);
    assert.equal(rows[0].capabilities.input, false);
    assert.equal(rows[0].status, 'detached');
    assert.ok(Buffer.byteLength(rows[0].ownerLabel) <= 128);
    assert.doesNotMatch(rows[0].ownerLabel, /[\u0000-\u001f\u007f]/);
    assert.doesNotMatch(JSON.stringify(rows), /principal|containerId|sessionFingerprint|translatedCwd|pid/i);
    const token = await manager.createAttachToken({ req: watcher, routePlan: plan, id: created.id });
    await assert.rejects(manager.attach({ req: { lease: lease('other-device', 'other-admin') }, routePlan: plan,
        attach: token.attach, cols: 90, rows: 30 }), { code: 'WEBTTY_ATTACH_NOT_FOUND' });
    const view = await manager.attach({ req: watcher, routePlan: plan, attach: token.attach, cols: 90, rows: 30 });
    assert.equal(view.role, 'watcher');
    assert.equal(view.cols, 80);
    assert.deepEqual(worker.resizes, []);
    await assert.rejects(manager.attach({ req: watcher, routePlan: plan, attach: token.attach, cols: 90, rows: 30 }),
        { code: 'WEBTTY_ATTACH_NOT_FOUND' });
    const newLogin = { lease: lease('new-login') };
    const ownToken = await manager.createAttachToken({ req: newLogin, routePlan: plan, id: created.id });
    const ownView = await manager.attach({ req: newLogin, routePlan: plan, attach: ownToken.attach, cols: 100, rows: 35 });
    assert.equal(ownView.role, 'owner');
    assert.deepEqual(worker.resizes, [[100, 35]]);
    const killedToken = await manager.createAttachToken({ req: newLogin, routePlan: plan, id: created.id });
    await manager.closeAuthorized(watcher, plan, created.id);
    await assert.rejects(manager.attach({ req: newLogin, routePlan: plan, attach: killedToken.attach, cols: 80, rows: 24 }),
        { code: 'WEBTTY_SESSION_NOT_FOUND' });
    assert.equal((await manager.listSessions({ req: newLogin, routePlan: plan }))[0].status, 'exited');
    await assert.rejects(manager.createAttachToken({ req: owner, routePlan: plan, id: 'z'.repeat(32) }),
        { code: 'WEBTTY_SESSION_NOT_FOUND' });
    assert.equal(await manager.authorize(owner, plan, 'z'.repeat(32)), null);
    assert.equal(await manager.closeAuthorized(owner, plan, 'z'.repeat(32)), false);
});

test('Kill during asynchronous attach authorization refuses attachment and never resizes the worker', async (t) => {
    let release;
    let entered;
    let blocked = false;
    const barrier = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const worker = new FakeWorker();
    const manager = await createManager(t, { workerFactory: () => worker,
        auth: { ...requestAuthAdapter(), validateLease: async () => {
            if (blocked) { entered(); await barrier; }
            return { ok: true };
        } },
    });
    const req = { lease: lease('owner') };
    const plan = routePlan();
    const created = await manager.create({ req, routePlan: plan, cwdRelative: '' });
    const token = await manager.createAttachToken({ req, routePlan: plan, id: created.id });
    blocked = true;
    const attachment = manager.attach({ req, routePlan: plan, attach: token.attach, cols: 90, rows: 30 });
    await started;
    await manager.closeSession(created.id, 'requested');
    release();
    await assert.rejects(attachment, { code: 'WEBTTY_SESSION_NOT_FOUND' });
    assert.deepEqual(worker.resizes, []);
});

test('generation lease ends only its viewer, then a current stream delta-replays and accepts owner input', async (t) => {
    let current = true;
    const worker = new FakeWorker();
    const manager = await createManager(t, { workerFactory: () => worker });
    const oldPlan = routePlan();
    oldPlan.lease.isCurrent = oldPlan.lease.commit = () => current;
    const created = await manager.create({ req: {}, routePlan: oldPlan, cwdRelative: '' });
    const session = manager.sessions.get(created.id);
    const oldResponse = streamResponse();
    attachViewStream(manager, session, new EventEmitter(), oldResponse, '', oldPlan);
    worker.emit('output', { sequence: 1, data: 'one' });
    current = false;
    await manager.validateLiveSessions();
    assert.equal(oldResponse.writableEnded, true);
    assert.match(oldResponse.body, /retry: 1000/);
    assert.doesNotMatch(oldResponse.body, /event: detached/);
    assert.equal(manager.activeCount(), 1);
    await assert.rejects(manager.authorize({}, oldPlan, created.id, 'input'), { code: 'WEBTTY_GENERATION_CHANGED' });
    assert.equal(worker.closed, 0);
    worker.emit('output', { sequence: 2, data: 'two' });
    const newPlan = routePlan();
    newPlan.lease.id = 'generation-b';
    assert.ok(await manager.authorize({}, newPlan, created.id, 'input'));
    const nextResponse = streamResponse();
    attachViewStream(manager, session, new EventEmitter(), nextResponse, '1', newPlan);
    assert.doesNotMatch(nextResponse.body, /id: 1\n/);
    assert.match(nextResponse.body, /id: 2\n/);
});

test('Box shell tick never resolves its directory again, including after a rename', async (t) => {
    let resolutions = 0;
    const manager = await createManager(t, { targetResolver: {
        async revalidate({ target }) { resolutions += 1; return target; },
        async revalidateRunningAgent() { assert.fail('Box must not enter agent validation'); },
    } });
    const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    manager.targetResolver.revalidate = () => { throw new Error('directory renamed'); };
    const before = resolutions;
    await manager.validateLiveSessions();
    assert.equal(manager.sessions.has(created.id), true);
    assert.equal(resolutions, before);
});

test('agent generation changes during deferred inspection recapture; proven identity replacement closes', async (t) => {
    let plan = routePlan();
    let release;
    let attempts = 0;
    const manager = await createManager(t, { agentProviderAvailable: true, capturePlan: () => plan,
        targetResolver: {
            async revalidate({ target }) { return target; },
            async revalidateRunningAgent({ routePlan: admitted }) {
                attempts += 1;
                if (attempts === 1) {
                    await new Promise(resolve => { release = resolve; });
                    assert.notEqual(admitted, plan);
                    throw Object.assign(new Error(), { code: 'WEBTTY_TARGET_GENERATION_STALE' });
                }
            },
        },
    });
    const session = await createAgentSession(manager);
    await manager.validateLiveSessions();
    plan = routePlan();
    release();
    await settleTarget(session);
    assert.equal(attempts, 2);
    assert.equal(manager.activeCount(), 1);
    manager.targetResolver.revalidateRunningAgent = async () => {
        throw Object.assign(new Error(), { code: 'WEBTTY_TARGET_IDENTITY_STALE' });
    };
    await manager.validateLiveSessions();
    await settleTarget(session);
    assert.equal(session.closeReason, 'target_identity_changed');
});

test('transient inspect failures, deadline aborts and inactive/churning generations are undecided for 120 seconds', async (t) => {
    for (const code of ['WEBTTY_TARGET_INSPECT_FAILED', 'WEBTTY_TARGET_INSPECT_ABORTED',
        'EDGE_GENERATION_INACTIVE', 'WEBTTY_TARGET_GENERATION_STALE']) {
        let now = 1_000;
        let attempts = 0;
        const manager = await createManager(t, { now: () => now, agentProviderAvailable: true,
            capturePlan: () => {
                if (code === 'EDGE_GENERATION_INACTIVE') throw Object.assign(new Error(), { code });
                return routePlan();
            },
            targetResolver: {
                async revalidate({ target }) { return target; },
                async revalidateRunningAgent() { attempts += 1; throw Object.assign(new Error(), { code }); },
            },
        });
        const session = await createAgentSession(manager);
        await manager.validateLiveSessions();
        await settleTarget(session);
        if (code === 'WEBTTY_TARGET_GENERATION_STALE') assert.equal(attempts, 3);
        assert.equal(session.targetUndecidedSince, 1_000);
        now += 100_000;
        await manager.validateLiveSessions();
        await settleTarget(session);
        assert.equal(manager.sessions.has(session.id), true, code);
        assert.equal(manager.providerAvailability().agentAvailable, true, code);
        now += 21_000;
        await manager.validateLiveSessions();
        assert.equal(session.closeReason, 'target_unverifiable', code);
        assert.equal(manager.providerAvailability().agentAvailable, true, code);
    }
});

test('24 saturated agent validations stay bounded, enforce deadlines and keep viewer checks running every tick', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 1_000;
    let active = 0;
    let maximum = 0;
    let completed = 0;
    const targetResolver = new TerminalTargetResolver({
        workspaceRoot: WORKSPACE_ROOT,
        inspectContainer: (_runtime, _id, { signal }) => new Promise((resolve, reject) => {
            active += 1;
            maximum = Math.max(maximum, active);
            const onAbort = () => {
                clearTimeout(timer);
                active -= 1;
                reject(Object.assign(new Error(), { code: 'WEBTTY_TARGET_INSPECT_ABORTED' }));
            };
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                active -= 1;
                completed += 1;
                resolve();
            }, 2_000);
            signal.addEventListener('abort', onAbort, { once: true });
        }),
    });
    targetResolver.revalidate = async ({ target }) => target;
    const validationsInFlight = new Map();
    const sessionByTarget = new Map();
    targetResolver.revalidateRunningAgent = async ({ target, signal }) => {
        const id = sessionByTarget.get(target);
        validationsInFlight.set(id, (validationsInFlight.get(id) || 0) + 1);
        try {
            return await targetResolver.inspectWithGate(target.runtime, target.containerId, { signal });
        } finally {
            validationsInFlight.set(id, validationsInFlight.get(id) - 1);
        }
    };
    const manager = await createManager(t, { targetResolver, now: () => now, agentProviderAvailable: true,
        limits: { createsPerWindow: 100, perUser: 24 }, capturePlan: routePlan });
    const sessions = [];
    for (let index = 0; index < 24; index += 1) sessions.push(await createAgentSession(manager));
    for (const session of sessions) sessionByTarget.set(session.target, session.id);
    assert.equal(sessionByTarget.size, 24, 'each session must carry its own target object');
    for (let tick = 0; tick < 10; tick += 1) {
        const responses = [];
        for (const session of sessions) {
            if (!manager.sessions.has(session.id)) continue;
            const response = streamResponse();
            const admitted = routePlan();
            admitted.lease.isCurrent = () => false;
            attachViewStream(manager, session, new EventEmitter(), response, '', admitted);
            responses.push(response);
        }
        await manager.validateLiveSessions();
        responses.forEach(response => assert.equal(response.writableEnded, true));
        for (const session of sessions) {
            assert.ok(validationsInFlight.get(session.id) <= 1, `session ${session.id} has overlapping validations`);
        }
        for (let second = 0; second < 5; second += 1) {
            now += 1_000;
            t.mock.timers.tick(1_000);
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.ok(targetResolver.inspectionGate.queue.length <= 24);
    }
    assert.ok(maximum <= 4);
    assert.ok(completed > 0);
    assert.ok(sessions.some(session => Number.isFinite(session.targetUndecidedSince)));
    assert.equal(manager.activeCount(), 24);
});

test('agent validation start order rotates each tick behind a single inspection slot', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const count = 4;
    const targetResolver = new TerminalTargetResolver({
        workspaceRoot: WORKSPACE_ROOT,
        limits: { concurrency: 1 },
        inspectContainer: async () => { await new Promise(resolve => setImmediate(resolve)); },
    });
    assert.equal(targetResolver.inspectionGate.limit, 1);
    targetResolver.revalidate = async ({ target }) => target;
    const sessionByTarget = new Map();
    const inFlight = new Map();
    let tickStarts = [];
    let overlap = 0;
    targetResolver.revalidateRunningAgent = async ({ target, signal }) => {
        const id = sessionByTarget.get(target);
        tickStarts.push(id);
        inFlight.set(id, (inFlight.get(id) || 0) + 1);
        overlap = Math.max(overlap, inFlight.get(id));
        try {
            return await targetResolver.inspectWithGate(target.runtime, target.containerId, { signal });
        } finally {
            inFlight.set(id, inFlight.get(id) - 1);
        }
    };
    const manager = await createManager(t, { targetResolver, now: () => 1_000, agentProviderAvailable: true,
        limits: { createsPerWindow: 100, perUser: 24 }, capturePlan: routePlan });
    const sessions = [];
    for (let index = 0; index < count; index += 1) sessions.push(await createAgentSession(manager));
    for (const session of sessions) sessionByTarget.set(session.target, session.id);
    assert.equal(sessionByTarget.size, count);
    const firsts = [];
    for (let tick = 0; tick < count * 2; tick += 1) {
        tickStarts = [];
        await manager.validateLiveSessions();
        assert.equal(tickStarts.length, count, 'every idle agent session is enqueued each tick');
        firsts.push(tickStarts[0]);
        await Promise.all(sessions.map(settleTarget));
        assert.ok(sessions.every(session => !session.targetValidation));
    }
    for (let tick = 1; tick < firsts.length; tick += 1) {
        assert.notEqual(firsts[tick], firsts[tick - 1], `first-enqueued session repeated on tick ${tick}`);
    }
    assert.equal(new Set(firsts.slice(0, count)).size, count, 'every session leads once per rotation');
    assert.equal(overlap, 1, 'a session never has overlapping validations');
});

test('deadline ignores late results and synchronous cutoff closes by the following tick', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 1_000;
    let resolveLate;
    let calls = 0;
    const manager = await createManager(t, { now: () => now, agentProviderAvailable: true, capturePlan: routePlan,
        targetResolver: {
            async revalidate({ target }) { return target; },
            revalidateRunningAgent() { calls += 1; return new Promise(resolve => { resolveLate = resolve; }); },
        },
    });
    const session = await createAgentSession(manager);
    const request = new EventEmitter();
    attachViewStream(manager, session, request, streamResponse());
    request.emit('close');
    await manager.validateLiveSessions();
    now += 10_000;
    t.mock.timers.tick(10_000);
    assert.equal(session.targetUndecidedSince, 11_000);
    for (let tick = 0; tick < 10; tick += 1) await manager.validateLiveSessions();
    assert.equal(calls, 1);
    resolveLate();
    await settleTarget(session);
    assert.equal(session.targetUndecidedSince, 11_000);
    now += 125_000;
    await manager.validateLiveSessions();
    assert.equal(session.closeReason, 'target_unverifiable');
});

test('viewer subscription rollback and a failed later attach preserve the correct shell lifetime', async (t) => {
    let rejectSubscription = false;
    const manager = await createManager(t, { auth: {
        ...authAdapter(),
        subscribeInvalidation: () => {
            if (rejectSubscription) throw new Error('viewer subscription refused');
            return () => {};
        },
    } });
    const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    const session = manager.sessions.get(created.id);
    rejectSubscription = true;
    assert.throws(() => attachViewStream(manager, session, new EventEmitter(), streamResponse()), /subscription refused/);
    assert.equal(session.everAttached, false);
    assert.ok(session.detachTimer);
    assert.equal(manager.viewerCount, 0);
    rejectSubscription = false;
    const req = new EventEmitter();
    attachViewStream(manager, session, req, streamResponse());
    req.emit('close');
    const broken = streamResponse();
    broken.write = () => { throw new Error('connection gone'); };
    assert.equal(attachViewStream(manager, session, new EventEmitter(), broken), false);
    assert.equal(session.everAttached, true);
    assert.equal(session.detachTimer, null);
    assert.equal(manager.activeCount(), 1);
    assert.equal(manager.viewerCount, 0);
});

test('queue overflow removes only the slow viewer; 70-second detached provider outage preserves shells', async (t) => {
    let now = 1_000;
    let unavailable = false;
    const worker = new FakeWorker();
    const manager = await createManager(t, { now: () => now, workerFactory: () => worker,
        auth: authAdapter({ validate: async () => unavailable ? { ok: false, reason: 'provider_unavailable' } : { ok: true } }),
    });
    const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    const session = manager.sessions.get(created.id);
    const slow = streamResponse();
    slow.write = function write(value) { this.body += value; return false; };
    const fast = streamResponse();
    const fastReq = new EventEmitter();
    attachViewStream(manager, session, new EventEmitter(), slow);
    attachViewStream(manager, session, fastReq, fast);
    for (let sequence = 1; sequence <= 90; sequence += 1) worker.emit('output', { sequence, data: 'x'.repeat(16_000) });
    assert.match(slow.body, /slow_viewer/);
    assert.equal(session.viewers.size, 1);
    assert.equal((fast.body.match(/event: output/g) || []).length, 90);
    fastReq.emit('close');
    unavailable = true;
    now += 70_000;
    await manager.validateLiveSessions();
    assert.equal(manager.activeCount(), 1);
    assert.equal(worker.closed, 0);
});

test('per-viewer provider outage resets on a decided result and detaches only at the 60-second bound', async (t) => {
    let now = 1_000;
    let unavailable = false;
    const manager = await createManager(t, { now: () => now,
        auth: authAdapter({ validate: async () => unavailable ? { ok: false, reason: 'provider_unavailable' } : { ok: true } }),
    });
    const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    const session = manager.sessions.get(created.id);
    const response = streamResponse();
    attachViewStream(manager, session, new EventEmitter(), response);
    unavailable = true;
    await manager.validateLiveSessions();
    now += 59_999;
    await manager.validateLiveSessions();
    assert.equal(session.viewers.size, 1);
    unavailable = false;
    await manager.validateLiveSessions();
    unavailable = true;
    now += 1;
    await manager.validateLiveSessions();
    now += 60_000;
    await manager.validateLiveSessions();
    assert.equal(session.viewers.size, 0);
    assert.match(response.body, /auth_provider_unavailable/);
    assert.equal(manager.activeCount(), 1);
});

test('owner admission time only moves forward across devices', async (t) => {
    const manager = await createManager(t, { auth: requestAuthAdapter() });
    const plan = routePlan();
    const req = { lease: { ...lease('new'), createdAt: 5000 } };
    const created = await manager.create({ req, routePlan: plan, cwdRelative: '' });
    const session = manager.sessions.get(created.id);
    await manager.authorize({ lease: { ...lease('old'), createdAt: 1000 } }, plan, created.id, 'input');
    attachViewStream(manager, session, Object.assign(new EventEmitter(), { lease: { ...lease('old'), createdAt: 1000 } }), streamResponse());
    assert.equal(session.owner.adminAdmittedAt, 5000);
    await manager.authorize({ lease: { ...lease('newer'), createdAt: 6000 } }, plan, created.id, 'input');
    assert.equal(session.owner.adminAdmittedAt, 6000);
});

test('fresh non-admin decisions close every owner shell only when strictly newer and isolate identities', async (t) => {
    const workers = [];
    const manager = await createManager(t, { auth: requestAuthAdapter(),
        workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    });
    const plan = routePlan();
    const owner = { lease: { ...lease('owner'), createdAt: 5000 } };
    const a = await manager.create({ req: owner, routePlan: plan, cwdRelative: '' });
    const b = await manager.create({ req: owner, routePlan: plan, cwdRelative: '' });
    const other = await manager.create({ req: { lease: lease('other', 'other-admin') }, routePlan: plan, cwdRelative: '' });
    const otherMode = await manager.create({ req: { lease: { ...lease('sso'), mode: 'sso' } }, routePlan: plan, cwdRelative: '' });
    const decision = { authMode: 'local', userId: owner.lease.userId, roles: ['user'], decidedAt: 6000 };
    for (const invalid of [
        { ...decision, decidedAt: 1000 }, { ...decision, decidedAt: 5000 }, { ...decision, decidedAt: NaN },
        { ...decision, roles: [' Admin '] }, { ...decision, roles: ['guest'] }, { ...decision, roles: null },
        { ...decision, authMode: 'none' }, { ...decision, userId: 'unknown' },
    ]) manager.observeAuthenticatedRequest(invalid);
    assert.equal(manager.activeCount(), 4);
    manager.observeAuthenticatedRequest(decision);
    manager.observeAuthenticatedRequest(decision);
    assert.equal(manager.sessions.has(a.id), false);
    assert.equal(manager.sessions.has(b.id), false);
    assert.equal(manager.sessions.has(other.id), true);
    assert.equal(manager.sessions.has(otherMode.id), true);
    await Promise.allSettled([...manager.inFlightCloses]);
    assert.equal(workers[0].closed, 1);
    assert.equal(workers[1].closed, 1);
    assert.equal(workers[2].closed, 0);
    assert.equal(workers[3].closed, 0);
    assert.equal(manager.tombstones.get(a.id).row.exitReason, 'owner_admin_revoked');
    await manager.closeAll();
    assert.doesNotThrow(() => manager.observeAuthenticatedRequest(new Proxy({}, { get() { throw new Error('must return immediately'); } })));
});

test('owner demotion during creation cancels synchronously and joins durable cleanup', async (t) => {
    let release;
    let enter;
    const started = new Promise(resolve => { enter = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const store = recordStore();
    const createRecord = store.create.bind(store);
    store.create = async (value) => { enter(); await barrier; return createRecord(value); };
    const worker = new FakeWorker();
    const manager = await createManager(t, { recordStore: store, workerFactory: () => worker });
    const creating = manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    const rejected = assert.rejects(creating, { code: 'WEBTTY_AUTH_INVALID' });
    await started;
    manager.observeAuthenticatedRequest({ authMode: LEASE.mode, userId: LEASE.userId, roles: [], decidedAt: 1000 });
    const session = [...manager.sessions.values()][0];
    assert.equal(session.startupCancellation, 'owner_admin_revoked');
    release();
    await rejected;
    await Promise.allSettled([...manager.inFlightCloses]);
    assert.equal(manager.activeCount(), 0);
    assert.equal(manager.ownerIndex.size, 0);
    assert.equal(worker.closed, 1);
    assert.equal(store.calls.removed, 1);
});

test('demotion racing input authorization, attachment and explicit Kill never writes after close', async (t) => {
    for (const operation of ['input', 'attach']) {
        let blocked = false;
        let release;
        let enter;
        const barrier = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { enter = resolve; });
        const worker = new FakeWorker();
        const manager = await createManager(t, { workerFactory: () => worker, auth: {
            ...authAdapter(), validateLease: async () => {
                if (blocked) { enter(); await barrier; }
                return { ok: true };
            },
        } });
        const plan = routePlan();
        const created = await manager.create({ req: {}, routePlan: plan, cwdRelative: '' });
        const token = await manager.createAttachToken({ req: {}, routePlan: plan, id: created.id });
        blocked = true;
        const pending = operation === 'input'
            ? manager.authorize({}, plan, created.id, 'input').then(session => manager.input(session, 'forbidden'))
            : manager.attach({ req: {}, routePlan: plan, attach: token.attach, cols: 100, rows: 30 });
        const rejected = assert.rejects(pending, { code: 'WEBTTY_SESSION_NOT_FOUND' });
        await started;
        manager.observeAuthenticatedRequest({ authMode: LEASE.mode, userId: LEASE.userId, roles: [], decidedAt: 1000 });
        await manager.closeSession(created.id, 'requested');
        release();
        await rejected;
        await Promise.allSettled([...manager.inFlightCloses]);
        assert.deepEqual(worker.inputs, []);
        assert.deepEqual(worker.resizes, []);
        assert.equal(worker.closed, 1);
    }
});

test('real signed local demotion cancels creation during its first auth or target await before worker allocation', async (t) => {
    for (const phase of ['auth', 'target']) {
        await t.test(phase, async (subtest) => {
            let now = Date.now();
            subtest.mock.method(Date, 'now', () => now);
            const sessionId = mintSessionJwt({ id: 'local:admin', roles: ['admin'] }, 1, { channel: 'cli' });
            const session = await sessionTokenService.getUserSession(sessionId);
            const req = { authMode: 'local', sessionId, session, user: session.user };
            req.lease = createBrowserSessionLease(req);
            let release;
            let enter;
            const started = new Promise(resolve => { enter = resolve; });
            const barrier = new Promise(resolve => { release = resolve; });
            let blocked = false;
            let allocations = 0;
            const manager = await createManager(subtest, {
                auth: { validateLease: async (value, options) => {
                    if (phase === 'auth' && !blocked) { blocked = true; enter(); await barrier; }
                    return validateBrowserSessionLease(value, options);
                }, createLease: createBrowserSessionLease },
                workerFactory: () => { allocations += 1; return new FakeWorker(); },
            });
            if (phase === 'target') manager.targetResolver.revalidate = async ({ target }) => {
                if (!blocked) { blocked = true; enter(); await barrier; }
                return target;
            };
            const stop = onAuthenticatedRequestDecision(decision => manager.observeAuthenticatedRequest(decision));
            subtest.after(stop);
            const creating = manager.create({ req, routePlan: routePlan(), cwdRelative: '' });
            const rejected = assert.rejects(creating, { code: 'WEBTTY_AUTH_INVALID' });
            await started;
            assert.equal(manager.pendingCreations.size, 1);
            assert.equal(manager.ownerIndex.size, 1);
            assert.equal(manager.userCounts.size, 0);
            assert.equal(allocations, 0);
            now += 2000;
            const demotedId = mintSessionJwt({ id: 'local:admin', roles: [] }, 1, { channel: 'cli' });
            const demoted = await sessionTokenService.getUserSession(demotedId);
            const decisionRequest = { authMode: 'local', sessionId: demotedId, session: demoted, user: demoted.user };
            assert.equal(publishAuthenticatedRequestDecision(decisionRequest), true);
            assert.equal(publishAuthenticatedRequestDecision(decisionRequest), true);
            assert.equal((await validateBrowserSessionLease(req.lease)).ok, true, 'older signed administrator token remains cryptographically valid');
            release();
            await rejected;
            assert.equal(manager.pendingCreations.size, 0);
            assert.equal(manager.ownerIndex.size, 0);
            assert.equal(manager.userCounts.size, 0);
            assert.equal(manager.activeCount(), 0);
            assert.equal(allocations, 0);
        });
    }
});

test('pending creation ignores older/equal or foreign decisions and transfers its owner index without a gap', async (t) => {
    let release;
    let enter;
    const started = new Promise(resolve => { enter = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const manager = await createManager(t, { auth: requestAuthAdapter() });
    let blocked = false;
    manager.targetResolver.revalidate = async ({ target }) => {
        if (!blocked) { blocked = true; enter(); await barrier; }
        return target;
    };
    const req = { lease: { ...lease('owner'), createdAt: 5000 } };
    const creating = manager.create({ req, routePlan: routePlan(), cwdRelative: '' });
    await started;
    const pending = [...manager.pendingCreations.values()][0];
    for (const decision of [
        { authMode: 'local', userId: req.lease.userId, roles: [], decidedAt: 1000 },
        { authMode: 'local', userId: req.lease.userId, roles: [], decidedAt: 5000 },
        { authMode: 'local', userId: 'foreign', roles: [], decidedAt: 6000 },
        { authMode: 'sso', userId: req.lease.userId, roles: [], decidedAt: 6000 },
    ]) manager.observeAuthenticatedRequest(decision);
    assert.equal(pending.cancellation, '');
    release();
    const created = await creating;
    assert.equal(created.id, pending.id);
    assert.equal(manager.pendingCreations.size, 0);
    assert.deepEqual([...manager.ownerIndex.get(pending.owner.principal)], [created.id]);
    await manager.closeSession(created.id);
    assert.equal(manager.ownerIndex.size, 0);
});

test('pre-registration auth, target, quota, factory and shutdown failures remove pending owner membership', async (t) => {
    for (const phase of ['auth', 'target', 'quota', 'factory', 'shutdown']) {
        await t.test(phase, async (subtest) => {
            let release;
            let enter;
            const started = new Promise(resolve => { enter = resolve; });
            const barrier = new Promise(resolve => { release = resolve; });
            const manager = await createManager(subtest, {
                auth: authAdapter({ validate: async () => phase === 'auth'
                    ? { ok: false, reason: 'missing_or_expired' } : { ok: true } }),
                limits: phase === 'quota' ? { global: 0 } : {},
                workerFactory: () => {
                    if (phase === 'factory') throw new Error('factory failed');
                    return new FakeWorker();
                },
            });
            manager.targetResolver.revalidate = async ({ target }) => {
                if (phase === 'target') throw new Error('target failed');
                if (phase === 'shutdown') { enter(); await barrier; }
                return target;
            };
            const creating = manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
            const rejected = assert.rejects(creating);
            if (phase === 'shutdown') {
                await started;
                await manager.closeAll();
                assert.equal([...manager.pendingCreations.values()][0].cancellation, 'router_shutdown');
                release();
            }
            await rejected;
            assert.equal(manager.pendingCreations.size, 0);
            assert.equal(manager.ownerIndex.size, 0);
            assert.equal(manager.userCounts.size, 0);
            assert.equal(manager.activeCount(), 0);
        });
    }
});

test('post-discovery decided demotion closes detached siblings; provider outage never revokes ownership', async (t) => {
    for (const reason of ['administrator_revoked', 'provider_unavailable']) {
        let refused = false;
        const manager = await createManager(t, {
            auth: authAdapter({ validate: async () => refused ? { ok: false, reason } : { ok: true } }),
        });
        const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
        const session = manager.sessions.get(created.id);
        const request = new EventEmitter();
        attachViewStream(manager, session, request, streamResponse());
        request.emit('close');
        manager.targetResolver.discover = async () => {
            refused = true;
            return { targets: terminalTargets(), agentTargetsAvailable: true };
        };
        await assert.rejects(manager.discoverTargets({ req: {}, routePlan: routePlan(), directory: '' }),
            { code: reason === 'administrator_revoked' ? 'WEBTTY_ADMIN_REQUIRED' : 'WEBTTY_UNAVAILABLE' });
        await Promise.allSettled([...manager.inFlightCloses]);
        assert.equal(manager.activeCount(), reason === 'administrator_revoked' ? 0 : 1);
        assert.equal(session.worker.closed, reason === 'administrator_revoked' ? 1 : 0);
    }
});

test('decided startup demotion reclaims the new shell and detached siblings without awaiting its own startup barrier', async (t) => {
    let demoted = false;
    const workers = [];
    const manager = await createManager(t, {
        auth: authAdapter({ validate: async () => demoted ? { ok: false, reason: 'administrator_revoked' } : { ok: true } }),
        workerFactory: () => {
            const worker = new FakeWorker();
            if (workers.length) {
                const start = worker.start.bind(worker);
                worker.start = async fields => { const result = await start(fields); demoted = true; return result; };
            }
            workers.push(worker);
            return worker;
        },
    });
    const first = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    const session = manager.sessions.get(first.id);
    const request = new EventEmitter();
    attachViewStream(manager, session, request, streamResponse());
    request.emit('close');
    await assert.rejects(manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' }), { code: 'WEBTTY_ADMIN_REQUIRED' });
    await Promise.allSettled([...manager.inFlightCloses]);
    assert.equal(manager.activeCount(), 0);
    assert.equal(manager.pendingCreations.size, 0);
    assert.equal(manager.ownerIndex.size, 0);
    assert.equal(manager.userCounts.size, 0);
    assert.deepEqual(workers.map(worker => worker.closed), [1, 1]);
});

const PROFILE = Object.freeze({ provider: 'provider', id: 'p-1', label: 'Profile One' });
const PROFILE_HOME = Object.freeze({
    relativePath: '.data/provider/profiles/p-1/home',
    absolutePath: `${WORKSPACE_ROOT}/.data/provider/profiles/p-1/home`,
    identity: Object.freeze({ dev: '11', ino: '12' }),
});

function profileTargets() {
    const [box, agent] = terminalTargets();
    return Object.freeze([
        Object.freeze({ ...box, home: Object.freeze({ ...PROFILE_HOME, translatedHome: PROFILE_HOME.absolutePath }) }),
        Object.freeze({ ...agent, access: 'rw', home: Object.freeze({ ...PROFILE_HOME, translatedHome: '/data/profiles/p-1/home' }) }),
        Object.freeze({ ...agent, containerName: 'ploinky-agent-isolated', unavailable: 'home-unreachable' }),
    ]);
}

function homeProfiles(answers = []) {
    const calls = [];
    return {
        calls,
        async resolve(args) {
            calls.push(args);
            const answer = answers.length ? answers.shift() : null;
            if (answer instanceof Error) throw answer;
            return answer || { profile: PROFILE, home: PROFILE_HOME };
        },
    };
}

function profileResolver() {
    const discoveries = [];
    return {
        discoveries,
        async discover(args) {
            discoveries.push(args);
            return { agentTargetsAvailable: true, targets: 'home' in args ? profileTargets() : terminalTargets() };
        },
        async revalidate({ target }) { return target; },
    };
}

test('a profile discovery resolves the provider after admission and binds only eligible launches', async (t) => {
    const order = [];
    const profiles = homeProfiles();
    const resolve = profiles.resolve;
    profiles.resolve = async (args) => { order.push('provider'); return resolve(args); };
    const targetResolver = profileResolver();
    const manager = await createManager(t, {
        agentProviderAvailable: true,
        targetResolver,
        homeProfiles: profiles,
        auth: authAdapter({ validate: async () => { order.push('admission'); return { ok: true }; } }),
    });
    const req = { user: { id: 'local:admin', roles: ['admin'] } };
    const discovery = await manager.discoverTargets({
        req, routePlan: routePlan(), directory: 'Projects', profile: { provider: 'provider', id: 'p-1' },
    });
    assert.deepEqual(order.slice(0, 2), ['admission', 'provider']);
    assert.equal(profiles.calls.length, 1);
    assert.equal(profiles.calls[0].req, req);
    assert.deepEqual(profiles.calls[0].profile, { provider: 'provider', id: 'p-1' });
    assert.deepEqual(targetResolver.discoveries[0].home, PROFILE_HOME);
    assert.deepEqual(discovery.profile, PROFILE);
    assert.deepEqual(discovery.targets.map((row) => [row.kind, Boolean(row.launch), row.unavailable]), [
        ['box', true, undefined], ['agent', true, undefined], ['agent', false, 'home-unreachable'],
    ]);
    assert.doesNotMatch(JSON.stringify(discovery), /profiles\/p-1\/home/);

    // Without a profile the provider is never consulted and nothing changes.
    const plain = await manager.discoverTargets({ req, routePlan: routePlan(), directory: 'Projects' });
    assert.equal(profiles.calls.length, 1);
    assert.equal('home' in targetResolver.discoveries[1], false);
    assert.deepEqual(Object.keys(plain), ['id', 'directory', 'expiresAt', 'agentTargetsAvailable', 'targets']);
    assert.deepEqual(plain.targets.map((row) => Object.keys(row)), [
        ['launch', 'kind', 'label', 'detail', 'access', 'cwdDisplay'],
        ['launch', 'kind', 'label', 'detail', 'access', 'cwdDisplay'],
    ]);
});

test('a refused profile creates no discovery record and no launch', async (t) => {
    const refusal = Object.assign(new Error('refused'), { code: 'WEBTTY_PROFILE_UNAVAILABLE' });
    const targetResolver = profileResolver();
    const manager = await createManager(t, {
        targetResolver, homeProfiles: homeProfiles([refusal]),
    });
    const before = manager.launchStore.counts();
    await assert.rejects(
        manager.discoverTargets({
            req: {}, routePlan: routePlan(), directory: 'Projects', profile: { provider: 'provider', id: 'p-1' },
        }),
        { code: 'WEBTTY_PROFILE_UNAVAILABLE' },
    );
    assert.equal(targetResolver.discoveries.length, 0);
    assert.deepEqual(manager.launchStore.counts(), before);
    // A manager without a provider refuses every profile the same way.
    const bare = await createManager(t, { targetResolver: profileResolver() });
    await assert.rejects(
        bare.discoverTargets({
            req: {}, routePlan: routePlan(), directory: 'Projects', profile: { provider: 'provider', id: 'p-1' },
        }),
        { code: 'WEBTTY_PROFILE_UNAVAILABLE' },
    );
});

test('a Box profile session re-resolves the provider and changes HOME only in the shell environment', async (t) => {
    const worker = new FakeWorker();
    const profiles = homeProfiles();
    const manager = await createManager(t, {
        workerFactory: (options) => { worker.factoryOptions = options; return worker; },
        targetResolver: profileResolver(),
        homeProfiles: profiles,
    });
    const discovery = await manager.discoverTargets({
        req: {}, routePlan: routePlan(), directory: 'Projects', profile: { provider: 'provider', id: 'p-1' },
    });
    const created = await manager.create({
        req: {}, routePlan: routePlan(), launch: discovery.targets[0].launch, cols: 90, rows: 30,
    });
    assert.equal(profiles.calls.length, 2);
    assert.deepEqual(profiles.calls[1].profile, { provider: 'provider', id: 'p-1' });
    assert.deepEqual(Object.keys(worker.startFields).sort(),
        ['cols', 'cwdRelative', 'homeIdentity', 'homeRelative', 'rows', 'shellEnv']);
    assert.equal(worker.startFields.homeRelative, PROFILE_HOME.relativePath);
    assert.deepEqual(worker.startFields.homeIdentity, { dev: '11', ino: '12' });
    assert.deepEqual(worker.startFields.shellEnv, buildShellEnvironment({}, {
        workspaceRoot: WORKSPACE_ROOT, profile: { ...PROFILE, home: PROFILE_HOME.absolutePath },
    }));
    assert.equal(worker.startFields.shellEnv.HOME, PROFILE_HOME.absolutePath);
    assert.equal(worker.startFields.shellEnv.INPUTRC, '/etc/inputrc');
    assert.equal(worker.startFields.shellEnv.PLOINKY_WEBTTY_PROFILE_PROVIDER, 'provider');
    assert.equal(worker.startFields.shellEnv.PLOINKY_WEBTTY_PROFILE_ID, 'p-1');
    assert.equal(worker.startFields.shellEnv.PLOINKY_WEBTTY_PROFILE_LABEL, 'Profile One');
    // The worker process itself is created exactly as before.
    assert.deepEqual(Object.keys(worker.factoryOptions).sort(), ['marker', 'terminalId', 'workspaceRoot']);
    assert.deepEqual(manager.sessions.get(created.id).profile, PROFILE);
});

test('an agent profile session sends the translated HOME and profile to the agent worker only', async (t) => {
    const agentWorker = new FakeWorker();
    agentWorker.start = async function start() { return { recoveryEvidence: { exact: true } }; };
    const manager = await createManager(t, {
        agentProviderAvailable: true,
        agentWorkerFactory: (options) => { agentWorker.factoryOptions = options; return agentWorker; },
        targetResolver: profileResolver(),
        homeProfiles: homeProfiles(),
    });
    const discovery = await manager.discoverTargets({
        req: {}, routePlan: routePlan(), directory: 'Projects', profile: { provider: 'provider', id: 'p-1' },
    });
    const created = await manager.create({
        req: {}, routePlan: routePlan(), launch: discovery.targets[1].launch, cols: 92, rows: 31,
    });
    assert.deepEqual(agentWorker.startFields, {
        runtime: 'podman',
        containerId: 'a'.repeat(64),
        targetUser: '1000:1000',
        translatedCwd: '/code/Projects',
        marker: manager.sessions.get(created.id).marker,
        cols: 92,
        rows: 31,
        translatedHome: '/data/profiles/p-1/home',
        profile: PROFILE,
    });
    assert.deepEqual(agentWorker.factoryOptions, { terminalId: created.id });
});

test('creation fails as target-stale when the provider answer or home identity changed', async (t) => {
    const refusal = Object.assign(new Error('refused'), { code: 'WEBTTY_PROFILE_UNAVAILABLE' });
    for (const [name, answer] of [
        ['replaced home', { profile: PROFILE, home: { ...PROFILE_HOME, identity: { dev: '11', ino: '13' } } }],
        ['moved home', { profile: PROFILE, home: { ...PROFILE_HOME, relativePath: '.data/provider/p-2', absolutePath: `${WORKSPACE_ROOT}/.data/provider/p-2` } }],
        ['relabelled', { profile: { ...PROFILE, label: 'Other' }, home: PROFILE_HOME }],
        ['refused', refusal],
    ]) {
        const worker = new FakeWorker();
        let workers = 0;
        const manager = await createManager(t, {
            workerFactory: () => { workers += 1; return worker; },
            targetResolver: profileResolver(),
            homeProfiles: homeProfiles([null, answer]),
        });
        const discovery = await manager.discoverTargets({
            req: {}, routePlan: routePlan(), directory: 'Projects', profile: { provider: 'provider', id: 'p-1' },
        });
        await assert.rejects(
            manager.create({ req: {}, routePlan: routePlan(), launch: discovery.targets[0].launch, cols: 80, rows: 24 }),
            { code: 'WEBTTY_TARGET_STALE' },
            name,
        );
        assert.equal(workers, 0, name);
        assert.equal(manager.activeCount(), 0, name);
    }
});

// ---- Close outcome, retention and listing (plan r3 3.4, A7) ----

const SHELL_ROW_KEYS = [
    'id', 'source', 'kind', 'title', 'detail', 'cwdDisplay', 'access', 'status',
    'isOwner', 'ownerLabel', 'viewerCount', 'startedAt', 'lastActivityAt', 'capabilities', 'attach',
];
const SHELL_OPTIONAL_KEYS = [
    'endedAt', 'exitReason', 'closePolicy', 'pendingStopUntil', 'ownerViewOpen', 'profileLabel',
    'closure', 'closureScope', 'recordCleanup',
];

// The Explorer row constraints recorded in the implementation checkpoint:
// optional keys are omitted rather than null, closure only on exited rows,
// a scope only with an unconfirmed stop, and a positive integer deadline.
function assertExplorerShellRow(row) {
    for (const key of SHELL_ROW_KEYS) assert.ok(Object.hasOwn(row, key), `missing ${key}`);
    for (const key of Object.keys(row)) {
        assert.ok(SHELL_ROW_KEYS.includes(key) || SHELL_OPTIONAL_KEYS.includes(key), `unexpected ${key}`);
    }
    assert.ok(['keep', 'stop'].includes(row.closePolicy));
    assert.ok(row.pendingStopUntil === null
        || (Number.isSafeInteger(row.pendingStopUntil) && row.pendingStopUntil > 0));
    assert.equal(typeof row.ownerViewOpen, 'boolean');
    assert.ok(row.profileLabel === null || (typeof row.profileLabel === 'string' && row.profileLabel.length > 0));
    if (Object.hasOwn(row, 'closure')) {
        assert.equal(row.status, 'exited');
        assert.ok(['pending', 'proven', 'unconfirmed'].includes(row.closure));
    }
    if (Object.hasOwn(row, 'closureScope')) {
        assert.equal(row.closure, 'unconfirmed');
        assert.ok(['global', 'provider', 'target'].includes(row.closureScope));
    }
    if (Object.hasOwn(row, 'recordCleanup')) {
        assert.equal(row.status, 'exited');
        assert.equal(row.recordCleanup, 'failed');
    }
    for (const value of Object.values(row)) assert.notEqual(value, undefined);
}

async function tombstoneRow(manager, id, req = {}) {
    const { sessions } = await manager.listLiveSessions({ req, routePlan: routePlan() });
    const row = sessions.find(entry => entry.id === id);
    if (row) assertExplorerShellRow(row);
    return row;
}

test('a successful close is pending while cleanup runs and proven only after exit and reclamation', async (t) => {
    let releaseClose;
    const barrier = new Promise((resolve) => { releaseClose = resolve; });
    const store = recordStore();
    const worker = new FakeWorker();
    const baseClose = worker.close.bind(worker);
    worker.close = async () => { await barrier; return baseClose(); };
    const manager = await createManager(t, { recordStore: store, workerFactory: () => worker });
    const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
    const closing = manager.closeSession(created.id, 'requested');
    await new Promise((resolve) => setImmediate(resolve));
    const pending = await tombstoneRow(manager, created.id);
    assert.equal(pending.status, 'exited');
    assert.equal(pending.closure, 'pending');
    assert.equal(Object.hasOwn(pending, 'closureScope'), false);
    assert.equal(manager.tombstones.get(created.id).expiresAt, Infinity, 'pending outcomes are retained');
    assert.equal(store.calls.removed, 0);
    releaseClose();
    assert.equal(await closing, true);
    const proven = await tombstoneRow(manager, created.id);
    assert.equal(proven.closure, 'proven');
    assert.equal(Object.hasOwn(proven, 'closureScope'), false);
    assert.equal(Object.hasOwn(proven, 'recordCleanup'), false);
    assert.equal(store.calls.confirmed, 1);
    assert.equal(store.calls.removed, 1);
    assert.ok(Number.isFinite(manager.tombstones.get(created.id).expiresAt), 'proven outcomes keep the short lifetime');
});

test('unconfirmed exit, thrown wait and unproven reclamation report unconfirmed with the disabled scope', async (t) => {
    for (const entry of [
        { name: 'wait false', worker: () => new FakeWorker({ waitForExitResult: false }), category: 'worker_exit_unconfirmed' },
        {
            name: 'wait throws',
            worker: () => Object.assign(new FakeWorker(), { async waitForExit() { throw new Error('wait failed'); } }),
            category: 'worker_exit_unconfirmed',
        },
        { name: 'reclamation false', mutate: (store) => { store.confirmReclaimed = async () => false; }, category: 'terminal_cleanup_unproven' },
        {
            name: 'reclamation throws',
            mutate: (store) => { store.confirmReclaimed = async () => { throw new Error('incomplete proc stat'); }; },
            category: 'terminal_reclamation_check_failed',
        },
    ]) {
        await t.test(entry.name, async (t2) => {
            const store = recordStore();
            entry.mutate?.(store);
            const worker = entry.worker ? entry.worker() : new FakeWorker();
            const manager = await createManager(t2, { recordStore: store, workerFactory: () => worker });
            const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
            assert.equal(await manager.closeSession(created.id, 'requested'), true);
            assert.deepEqual(manager.availability(), { ok: false, category: entry.category });
            assert.equal(store.calls.removed, 0);
            const row = await tombstoneRow(manager, created.id);
            assert.equal(row.closure, 'unconfirmed');
            assert.equal(row.closureScope, 'global');
            assert.equal(manager.tombstones.get(created.id).expiresAt, Infinity);
        });
    }
});

test('agent recovery failures report the provider or target scope that was actually disabled', async (t) => {
    for (const [name, recoverHandle, scope] of [
        ['target refusal', async () => ({ recovered: false, category: 'agent_startup_marker_survived', scope: 'target' }), 'target'],
        ['provider refusal', async () => ({ recovered: false, category: 'agent_record_remove_unconfirmed', scope: 'provider' }), 'provider'],
        ['thrown target-local evidence', async () => { throw Object.assign(new Error('x'), { code: 'WEBTTY_AGENT_PODMAN_FAILURE', category: 'exec-not-drained' }); }, 'target'],
        ['thrown systemic evidence', async () => { throw Object.assign(new Error('x'), { code: 'WEBTTY_PROCESS_IDENTITY_UNPROVEN' }); }, 'provider'],
        ['wait false', null, 'provider'],
    ]) {
        await t.test(name, async (t2) => {
            const targets = terminalTargets();
            const agentWorker = new FakeWorker(recoverHandle ? {} : { waitForExitResult: false });
            agentWorker.start = async () => ({ recoveryEvidence: { exact: true } });
            const store = recordStore();
            if (recoverHandle) store.recoverHandle = recoverHandle;
            const manager = await createManager(t2, {
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
            const created = await manager.create({ req: {}, routePlan: plan, launch: discovery.targets[1].launch });
            assert.equal(await manager.closeSession(created.id, 'requested'), true);
            const row = await tombstoneRow(manager, created.id);
            assert.equal(row.closure, 'unconfirmed');
            assert.equal(row.closureScope, scope);
            assert.equal(manager.providerAvailability().boxAvailable, true, 'Box terminals stay available');
            assert.equal(manager.providerAvailability().agentAvailable, scope !== 'provider');
            assert.equal(manager.isAgentTargetQuarantined(targets[1]), scope === 'target');
        });
    }
});

test('a record-removal failure after proven exit stays proven and flags only the record cleanup', async (t) => {
    for (const [name, remove] of [
        ['remove false', async () => false],
        ['remove throws', async () => { throw new Error('disk failure'); }],
    ]) {
        await t.test(name, async (t2) => {
            const store = recordStore();
            store.remove = remove;
            const manager = await createManager(t2, { recordStore: store });
            const created = await manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' });
            assert.equal(await manager.closeSession(created.id, 'requested'), true);
            assert.equal(manager.availability().ok, false, 'the existing fail-closed handling is unchanged');
            const row = await tombstoneRow(manager, created.id);
            assert.equal(row.closure, 'proven');
            assert.equal(row.recordCleanup, 'failed');
            assert.equal(Object.hasOwn(row, 'closureScope'), false);
        });
    }
});

test('a worker cleanup-unproven report keeps a recordless close unconfirmed', async (t) => {
    let createEntered;
    let releaseCreate;
    const entered = new Promise((resolve) => { createEntered = resolve; });
    const barrier = new Promise((resolve) => { releaseCreate = resolve; });
    const worker = new FakeWorker();
    const store = recordStore();
    const manager = await createManager(t, { recordStore: store, workerFactory: () => worker });
    // No durable record ever exists for this shell.
    store.create = async () => { createEntered(); await barrier; throw new Error('record store unavailable'); };
    const outcome = manager.create({ req: {}, routePlan: routePlan(), cwdRelative: '' })
        .then(() => null, (error) => error);
    await entered;
    const id = [...manager.sessions.keys()][0];
    worker.emit('terminal-error', { category: 'cleanup-unproven' });
    releaseCreate();
    assert.ok(await outcome instanceof Error);
    await Promise.allSettled([...manager.inFlightCloses]);
    assert.deepEqual(manager.availability(), { ok: false, category: 'cleanup-unproven' });
    const row = await tombstoneRow(manager, id);
    assert.equal(row.closure, 'unconfirmed');
    assert.equal(row.closureScope, 'global');
});

test('a global-scope outcome stays listed through the handler while WebTTY is disabled', async (t) => {
    process.env.PLOINKY_MASTER_KEY ||= 'b'.repeat(64);
    const { handleWebtty } = await import('../../cli/server/handlers/webtty.js');
    const store = recordStore();
    store.confirmReclaimed = async () => false;
    const workers = [new FakeWorker(), new FakeWorker()];
    const manager = await createManager(t, { recordStore: store, workerFactory: () => workers.shift() });
    const plan = routePlan();
    const failed = await manager.create({ req: {}, routePlan: plan, cwdRelative: '' });
    const quiesced = await manager.create({ req: {}, routePlan: plan, cwdRelative: '' });
    async function get(url) {
        const res = {
            statusCode: 0, headers: {}, body: '',
            writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
            write(value) { this.body += String(value); return true; },
            end(value = '') { this.body += String(value); this.writableEnded = true; },
        };
        await handleWebtty({ method: 'GET', headers: {}, user: { id: 'local:admin', roles: ['admin'] } },
            res, new URL(url, 'http://localhost'), { manager, routePlan: plan });
        return res;
    }
    const before = await get('/webtty/live-sessions');
    assert.equal(before.statusCode, 200);
    assert.equal(Object.hasOwn(JSON.parse(before.body), 'available'), false, 'available appears only while disabled');
    assert.equal(await manager.closeSession(failed.id, 'requested'), true);
    await Promise.allSettled([...manager.inFlightCloses]);
    assert.equal(manager.availability().ok, false);
    const listed = await get('/webtty/live-sessions');
    assert.equal(listed.statusCode, 200);
    const payload = JSON.parse(listed.body);
    assert.deepEqual(Object.keys(payload).sort(), ['available', 'ok', 'sessions', 'version']);
    assert.equal(payload.available, false);
    const row = payload.sessions.find(entry => entry.id === failed.id);
    assertExplorerShellRow(row);
    assert.equal(row.closure, 'unconfirmed');
    assert.equal(row.closureScope, 'global');
    assert.ok(payload.sessions.every(entry => entry.status === 'exited'), 'only retained outcomes are listed');
    assert.ok(payload.sessions.some(entry => entry.id === quiesced.id), 'the quiesced shell is listed as an outcome');
    // No other route opens while disabled.
    const stream = await get(`/webtty/sessions/${quiesced.id}/stream?view=${'v'.repeat(32)}`);
    assert.equal(stream.statusCode, 503);
});

test('a concurrent explicit Kill and tab-close deadline run cleanup exactly once', async (t) => {
    for (const order of ['kill-first', 'deadline-first']) {
        await t.test(order, async (t2) => {
            t2.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
            const audits = [];
            const store = recordStore();
            const worker = new FakeWorker();
            const manager = await createManager(t2, {
                auth: requestAuthAdapter(), recordStore: store, workerFactory: () => worker,
                audit: (event, details) => audits.push({ event, details }),
            });
            const plan = routePlan();
            const owner = { lease: lease('owner') };
            const created = await manager.create({ req: owner, routePlan: plan, cwdRelative: '', closePolicy: 'stop' });
            const session = manager.sessions.get(created.id);
            manager.attachStream(session, Object.assign(new EventEmitter(), owner), streamResponse(), '', plan, created.view.id);
            assert.deepEqual(await manager.closeIntent({ req: owner, routePlan: plan, id: created.id, view: created.view.id, policy: 'stop' }),
                { pending: true, until: 1_030_000 });
            t2.mock.timers.tick(29_999);
            let kill;
            if (order === 'kill-first') {
                kill = manager.closeAuthorized(owner, plan, created.id);
                await new Promise((resolve) => setImmediate(resolve));
                t2.mock.timers.tick(1);
            } else {
                t2.mock.timers.tick(1);
                kill = manager.closeAuthorized(owner, plan, created.id);
            }
            assert.equal(await kill, true);
            await Promise.allSettled([...manager.inFlightCloses]);
            assert.equal(worker.closed, 1);
            assert.equal(store.calls.confirmed, 1);
            assert.equal(store.calls.removed, 1);
            assert.equal(audits.filter(entry => entry.event === 'webtty_session_closed').length, 1);
            assert.equal(session.closeReason, order === 'kill-first' ? 'requested' : 'tab_closed');
            assert.equal(audits.filter(entry => entry.event === 'webtty_closed_on_tab_close').length,
                order === 'kill-first' ? 0 : 1);
        });
    }
});

test('tombstone eviction under the cap removes proven outcomes first and audits a non-proven eviction', async (t) => {
    const { WEBTTY_SESSION_LIMITS } = await import('../../cli/server/webtty/sessionManager.mjs');
    assert.equal(WEBTTY_SESSION_LIMITS.maxTombstones, 256);
    const audits = [];
    const store = recordStore();
    let failReclaim = false;
    store.confirmReclaimed = async () => { store.calls.confirmed += 1; return !failReclaim; };
    const manager = await createManager(t, {
        auth: requestAuthAdapter(),
        recordStore: store,
        limits: { maxTombstones: 3 },
        audit: (event, details) => audits.push({ event, details }),
    });
    let logins = 0;
    // Separate logins keep the per-login creation rate out of the way.
    const req = () => ({ lease: lease(`login-${logins += 1}`) });
    // Unproven outcomes disable WebTTY, so keep creating by re-enabling the
    // surface directly; only retention is under test here.
    const created = [];
    for (const proven of [false, true, false, true]) {
        manager.ready = true;
        failReclaim = !proven;
        const entry = await manager.create({ req: req(), routePlan: routePlan(), cwdRelative: '' });
        await manager.closeSession(entry.id, 'requested');
        created.push(entry.id);
    }
    // Four outcomes under a cap of three: the oldest proven one is evicted,
    // although an older unconfirmed outcome exists.
    assert.deepEqual([...manager.tombstones.keys()], [created[0], created[2], created[3]]);
    assert.deepEqual(audits.filter(entry => entry.event === 'webtty_tombstone_evicted'), []);
    manager.ready = true;
    failReclaim = true;
    const fifth = await manager.create({ req: req(), routePlan: routePlan(), cwdRelative: '' });
    await manager.closeSession(fifth.id, 'requested');
    assert.deepEqual([...manager.tombstones.keys()], [created[0], created[2], fifth.id]);
    manager.ready = true;
    const sixth = await manager.create({ req: req(), routePlan: routePlan(), cwdRelative: '' });
    await manager.closeSession(sixth.id, 'requested');
    // No proven outcome is left: the oldest non-proven one goes, with an audit.
    assert.deepEqual([...manager.tombstones.keys()], [created[2], fifth.id, sixth.id]);
    const evicted = audits.filter(entry => entry.event === 'webtty_tombstone_evicted');
    assert.equal(evicted.length, 1);
    assert.equal(evicted[0].details.closure, 'unconfirmed');
});

// ---- Close policy, views and tab-close ordering (plan r3 3.4, A8) ----
// Deterministic: setTimeout and Date are mocked, so deadlines fire only on tick.

async function closePolicyFixture(t, { closePolicy = 'stop', limits = {} } = {}) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const audits = [];
    const store = recordStore();
    const worker = new FakeWorker();
    const manager = await createManager(t, {
        auth: requestAuthAdapter(), recordStore: store, workerFactory: () => worker,
        audit: (event, details) => audits.push({ event, details }), limits,
    });
    const plan = routePlan();
    const owner = { lease: lease('owner') };
    const created = await manager.create({ req: owner, routePlan: plan, cwdRelative: '', closePolicy });
    const session = manager.sessions.get(created.id);
    const fixture = {
        manager, store, worker, plan, owner, created, session, audits,
        // A stream bound to a view; `drop` is a signal-free disconnect.
        open(viewId, req = owner, streamPlan = plan) {
            const request = Object.assign(new EventEmitter(), req);
            const response = streamResponse();
            assert.equal(manager.attachStream(session, request, response, '', streamPlan, viewId), true);
            return { request, response, drop: () => request.emit('close') };
        },
        // `supersedes` is an explicit recovery claim (reload, back/forward or embedded restore).
        async attach(req = owner, supersedes = null) {
            const token = await manager.createAttachToken({
                req, routePlan: plan, id: created.id, ...(supersedes ? { supersedes } : {}),
            });
            return manager.attach({ req, routePlan: plan, attach: token.attach, cols: 80, rows: 24 });
        },
        view: (id) => session.views.get(id),
        intent(view, policy = 'stop', req = owner) {
            return manager.closeIntent({ req, routePlan: plan, id: created.id, view, policy });
        },
        async tick(ms) {
            t.mock.timers.tick(ms);
            await Promise.allSettled([...manager.inFlightCloses]);
        },
        alive: () => manager.sessions.get(created.id) === session && !session.closed,
        events: (name) => audits.filter(entry => entry.event === name),
    };
    return fixture;
}

test('A8: a keep intent arms nothing and a stop intent with no other owner view stops after 30 seconds', async (t) => {
    await t.test('session keep, body stop', async (t2) => {
        const f = await closePolicyFixture(t2, { closePolicy: 'keep' });
        f.open(f.created.view.id);
        assert.deepEqual(await f.intent(f.created.view.id, 'stop'), { pending: false });
        assert.equal(f.session.pendingStop, null);
        await f.tick(10 * 60_000);
        assert.equal(f.alive(), true);
    });
    await t.test('session stop, body keep', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id);
        assert.deepEqual(await f.intent(f.created.view.id, 'keep'), { pending: false });
        assert.equal(f.session.pendingStop, null);
        await f.tick(10 * 60_000);
        assert.equal(f.alive(), true);
    });
    await t.test('stop', async (t2) => {
        const f = await closePolicyFixture(t2);
        const stream = f.open(f.created.view.id);
        assert.deepEqual(await f.intent(f.created.view.id), { pending: true, until: 1_030_000 });
        // The ended view's stream is released at once, so it cannot count as open.
        assert.match(stream.response.body, /view_ended/);
        assert.equal(f.session.viewers.size, 0);
        const [row] = await f.manager.listSessions({ req: f.owner, routePlan: f.plan });
        assertExplorerShellRow(row);
        assert.deepEqual([row.closePolicy, row.pendingStopUntil, row.ownerViewOpen], ['stop', 1_030_000, false]);
        await f.tick(29_999);
        assert.equal(f.alive(), true);
        await f.tick(1);
        assert.equal(f.alive(), false);
        assert.equal(f.session.closeReason, 'tab_closed');
        assert.deepEqual(f.events('webtty_closed_on_tab_close').map(entry => entry.details.closure), ['proven']);
        assert.equal(f.worker.closed, 1);
        assert.equal(f.store.calls.removed, 1);
    });
});

test('A8: only an explicit recovery claim cancels or supersedes an earlier close signal, and nothing revives it', async (t) => {
    // Addendum A1 r2: rewritten from "the new view cancels".
    await t.test('close before attach: a recovery claim of the arming view cancels with reopened', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id);
        await f.intent(f.created.view.id);
        await f.tick(10_000);
        const reload = await f.attach(f.owner, f.created.view.id);
        assert.equal(f.session.pendingStop, null);
        assert.deepEqual(f.events('webtty_close_intent_cancelled').map(entry => entry.details.reason), ['reopened']);
        assert.equal(f.view(f.created.view.id).state, 'superseded');
        assert.equal(f.view(f.created.view.id).supersededBy, reload.view.id);
        await f.tick(60_000);
        assert.equal(f.alive(), true);
        // After recovery a signal-free disconnect (panel detach, session switch) never revives it.
        f.open(reload.view.id).drop();
        await f.tick(10 * 60_000);
        assert.equal(f.alive(), true);
        assert.equal(f.session.pendingStop, null);
    });
    // Addendum A1 r2: rewritten from "the old intent is superseded".
    await t.test('attach before a delayed close: 409 with a claim, armed without one', async (t2) => {
        const claimed = await closePolicyFixture(t2);
        claimed.open(claimed.created.view.id).drop();
        const reload = await claimed.attach(claimed.owner, claimed.created.view.id);
        await assert.rejects(claimed.intent(claimed.created.view.id), { code: 'WEBTTY_VIEW_STALE' });
        assert.equal(claimed.session.pendingStop, null);
        await claimed.tick(10 * 60_000);
        assert.equal(claimed.alive(), true);
        // The recovering view's own intent still stops it.
        assert.equal((await claimed.intent(reload.view.id)).pending, true);
        await claimed.tick(30_000);
        assert.equal(claimed.alive(), false);
    });
    await t.test('attach before a delayed close without a claim: the earlier signal still arms', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id).drop();
        await f.attach();
        assert.deepEqual(await f.intent(f.created.view.id), { pending: true, until: 1_030_000 });
        await f.tick(30_000);
        assert.equal(f.alive(), false, 'the unclaimed view was created at the same time and is abandoned at the deadline');
    });
    await t.test('a duplicate or foreign intent is stale and has no effect', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id);
        await f.intent(f.created.view.id);
        const armed = f.session.pendingStop;
        await assert.rejects(f.intent(f.created.view.id), { code: 'WEBTTY_VIEW_STALE' });
        await assert.rejects(f.intent('x'.repeat(32)), { code: 'WEBTTY_VIEW_STALE' });
        assert.equal(f.session.pendingStop, armed, 'a stale repeat neither re-arms nor cancels');
        assert.equal(f.session.pendingStop.deadline, 1_030_000);
    });
});

test('A8: another device keeps the shell open until its own signal, and a reconnect gap re-arms', async (t) => {
    await t.test('open elsewhere cancels; that device can later stop it', async (t2) => {
        const f = await closePolicyFixture(t2);
        const deviceB = f.open(f.created.view.id);
        const deviceA = await f.attach({ lease: lease('device-a') });
        f.open(deviceA.view.id, { lease: lease('device-a') });
        assert.equal((await f.intent(deviceA.view.id, 'stop', { lease: lease('device-a') })).pending, true);
        await f.tick(30_000);
        assert.equal(f.alive(), true);
        assert.deepEqual(f.events('webtty_close_intent_cancelled').map(entry => entry.details.reason), ['open-elsewhere']);
        assert.equal(deviceB.response.writableEnded, false);
        assert.equal((await f.intent(f.created.view.id)).pending, true);
        await f.tick(29_999);
        assert.equal(f.alive(), true);
        await f.tick(1);
        assert.equal(f.alive(), false);
    });
    await t.test('a view that dropped at T-5 s re-arms; the stop follows 30 s without reattach', async (t2) => {
        const f = await closePolicyFixture(t2);
        const deviceX = f.open(f.created.view.id);
        const deviceY = await f.attach({ lease: lease('device-y') });
        f.open(deviceY.view.id, { lease: lease('device-y') });
        await f.intent(deviceY.view.id, 'stop', { lease: lease('device-y') });
        await f.tick(25_000);
        deviceX.drop();
        await f.tick(5_000);
        assert.equal(f.alive(), true);
        assert.equal(f.session.pendingStop.deadline, 1_055_000);
        const [row] = await f.manager.listSessions({ req: f.owner, routePlan: f.plan });
        assert.equal(row.pendingStopUntil, 1_055_000);
        await f.tick(24_999);
        assert.equal(f.alive(), true);
        await f.tick(1);
        assert.equal(f.alive(), false);
        assert.equal(f.session.closeReason, 'tab_closed');
    });
    // Addendum A1 r2: an owner stream no longer cancels; the deadline does (open-elsewhere).
    await t.test('a view that dropped at T-5 s and reattaches keeps the shell', async (t2) => {
        const f = await closePolicyFixture(t2);
        const deviceX = f.open(f.created.view.id);
        const deviceY = await f.attach({ lease: lease('device-y') });
        f.open(deviceY.view.id, { lease: lease('device-y') });
        await f.intent(deviceY.view.id, 'stop', { lease: lease('device-y') });
        await f.tick(25_000);
        deviceX.drop();
        await f.tick(15_000);
        f.open(f.created.view.id);
        assert.equal(f.session.pendingStop.deadline, 1_055_000, 'the reattach itself cancels nothing');
        await f.tick(14_999);
        assert.equal(f.events('webtty_close_intent_cancelled').length, 0);
        await f.tick(1);
        assert.equal(f.session.pendingStop, null);
        assert.deepEqual(f.events('webtty_close_intent_cancelled').map(entry => entry.details.reason), ['open-elsewhere']);
        await f.tick(10 * 60_000);
        assert.equal(f.alive(), true);
    });
    await t.test('a view detached for 60 s reconnects, counts as open, and its own intent can stop', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id).drop();
        const deviceY = await f.attach({ lease: lease('device-y') });
        f.open(deviceY.view.id, { lease: lease('device-y') });
        await f.tick(60_000);
        f.open(f.created.view.id);
        assert.equal((await f.manager.listSessions({ req: f.owner, routePlan: f.plan }))[0].ownerViewOpen, true);
        await f.intent(deviceY.view.id, 'stop', { lease: lease('device-y') });
        await f.tick(30_000);
        assert.equal(f.alive(), true);
        assert.deepEqual(f.events('webtty_close_intent_cancelled').map(entry => entry.details.reason), ['open-elsewhere']);
        assert.equal((await f.intent(f.created.view.id)).pending, true);
        await f.tick(30_000);
        assert.equal(f.alive(), false);
    });
    await t.test('a generation change during the grace behaves like a reconnect gap', async (t2) => {
        const f = await closePolicyFixture(t2);
        let current = true;
        const oldPlan = routePlan();
        oldPlan.lease.isCurrent = () => current;
        const deviceX = f.open(f.created.view.id, f.owner, oldPlan);
        const deviceY = await f.attach({ lease: lease('device-y') });
        f.open(deviceY.view.id, { lease: lease('device-y') });
        await f.intent(deviceY.view.id, 'stop', { lease: lease('device-y') });
        await f.tick(20_000);
        current = false;
        await f.manager.validateLiveSessions();
        assert.match(deviceX.response.body, /retry: 1000/);
        await f.tick(10_000);
        assert.equal(f.alive(), true);
        assert.equal(f.session.pendingStop.deadline, 1_050_000);
        await f.tick(5_000);
        f.open(f.created.view.id);
        // Addendum A1 r2: the stop stays armed until its deadline cancels it as open-elsewhere.
        assert.equal(f.session.pendingStop.deadline, 1_050_000);
        await f.tick(15_000);
        assert.equal(f.session.pendingStop, null);
        assert.deepEqual(f.events('webtty_close_intent_cancelled').map(entry => entry.details.reason), ['open-elsewhere']);
        await f.tick(10 * 60_000);
        assert.equal(f.alive(), true);
    });
});

test('A8: watchers neither signal nor cancel, and the toggle race arms only with a stop body', async (t) => {
    await t.test('watcher', async (t2) => {
        const f = await closePolicyFixture(t2);
        const watcher = { lease: lease('watcher', 'other-admin') };
        f.open(f.created.view.id);
        await f.intent(f.created.view.id);
        const watched = await f.attach(watcher);
        assert.equal(watched.role, 'watcher');
        f.open(watched.view.id, watcher);
        assert.ok(f.session.pendingStop, 'a watcher view and stream cancel nothing');
        await assert.rejects(f.intent(watched.view.id, 'stop', watcher), { code: 'WEBTTY_OWNER_REQUIRED' });
        await assert.rejects(f.manager.setClosePolicy({ req: watcher, routePlan: f.plan, id: f.created.id, policy: 'keep' }),
            { code: 'WEBTTY_OWNER_REQUIRED' });
        // An owner cannot use a watcher's view either.
        await assert.rejects(f.intent(watched.view.id), { code: 'WEBTTY_VIEW_STALE' });
        await f.tick(30_000);
        assert.equal(f.alive(), false);
    });
    for (const [body, arms] of [['stop', true], ['keep', false]]) {
        await t.test(`intent body ${body} before the policy change to stop`, async (t2) => {
            const f = await closePolicyFixture(t2, { closePolicy: 'keep' });
            f.open(f.created.view.id);
            assert.deepEqual(await f.intent(f.created.view.id, body), { pending: false });
            const result = await f.manager.setClosePolicy({ req: f.owner, routePlan: f.plan, id: f.created.id, policy: 'stop' });
            assert.deepEqual(result, { closePolicy: 'stop', pendingStopUntil: arms ? 1_030_000 : null });
            await f.tick(30_000);
            assert.equal(f.alive(), !arms);
        });
    }
    await t.test('policy keep cancels a pending stop', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id);
        await f.intent(f.created.view.id);
        assert.deepEqual(await f.manager.setClosePolicy({ req: f.owner, routePlan: f.plan, id: f.created.id, policy: 'keep' }),
            { closePolicy: 'keep', pendingStopUntil: null });
        assert.deepEqual(f.events('webtty_close_intent_cancelled').map(entry => entry.details.reason), ['policy_keep']);
        await f.tick(10 * 60_000);
        assert.equal(f.alive(), true);
    });
});

test('A8: a missing signal never closes; only the never-attached, idle and absolute rules do', async (t) => {
    await t.test('stop policy without a signal stays alive', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id).drop();
        await f.tick(60 * 60_000);
        assert.equal(f.alive(), true);
        const [row] = await f.manager.listSessions({ req: f.owner, routePlan: f.plan });
        assert.deepEqual([row.closePolicy, row.pendingStopUntil, row.ownerViewOpen], ['stop', null, false]);
        assert.equal(f.events('webtty_close_intent_armed').length, 0);
    });
    await t.test('the never-attached rule still applies with a stop policy', async (t2) => {
        const f = await closePolicyFixture(t2, { limits: { streamDetachGraceMs: 15_000 } });
        await f.tick(14_999);
        assert.equal(f.alive(), true);
        await f.tick(1);
        assert.equal(f.session.closeReason, 'stream_never_attached');
    });
    await t.test('closeAll clears the pending timer', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id);
        await f.intent(f.created.view.id);
        assert.ok(f.session.pendingStop);
        await f.manager.closeAll('router_shutdown');
        assert.equal(f.session.pendingStop, null);
        assert.equal(f.session.closeReason, 'router_shutdown');
        await f.tick(60_000);
        assert.equal(f.events('webtty_closed_on_tab_close').length, 0);
        assert.equal(f.worker.closed, 1);
    });
});

test('A8: each session keeps at most 32 views and refuses a 33rd non-ended view', async (t) => {
    const f = await closePolicyFixture(t, { closePolicy: 'keep' });
    // The creator's view is the first of 32.
    const views = [f.created.view.id];
    for (let index = 1; index < 32; index += 1) views.push((await f.attach()).view.id);
    assert.equal(f.session.views.size, 32);
    await assert.rejects(f.attach(), { code: 'WEBTTY_VIEW_LIMIT' });
    // An ended view is evicted first.
    await f.intent(views[5], 'keep');
    const next = await f.attach();
    assert.equal(f.session.views.has(views[5]), false);
    assert.equal(f.session.views.has(next.view.id), true);
    await assert.rejects(f.attach(), { code: 'WEBTTY_VIEW_LIMIT' });
    // Then the oldest abandoned one; open views are never evicted.
    f.open(views[0]);
    await f.tick(30_000);
    const later = await f.attach();
    assert.equal(f.session.views.has(views[0]), true);
    assert.equal(f.session.views.has(views[1]), false);
    assert.equal(f.session.views.has(later.view.id), true);
    assert.equal(f.session.views.size, 32);
});

test('a watcher cannot stream on an owner view: stale, view unchanged, pending stop still armed', async (t) => {
    const f = await closePolicyFixture(t);
    const watcher = { lease: lease('watcher', 'other-admin') };
    // The owner's first view is detached but not ended; a second owner view signals stop.
    f.open(f.created.view.id).drop();
    const second = await f.attach();
    await f.intent(second.view.id);
    const armed = f.session.pendingStop;
    assert.ok(armed);
    const ownerView = f.session.views.get(f.created.view.id);
    const before = { ...ownerView };
    const request = Object.assign(new EventEmitter(), watcher);
    const response = streamResponse();
    assert.throws(() => f.manager.attachStream(f.session, request, response, '', f.plan, f.created.view.id),
        { code: 'WEBTTY_VIEW_STALE' });
    assert.deepEqual({ ...ownerView }, before);
    assert.equal(f.session.viewers.size, 0);
    assert.equal(response.body, '');
    assert.equal(f.session.pendingStop, armed);
    assert.equal(f.session.pendingStop.deadline, 1_030_000);
    await f.tick(30_000);
    assert.equal(f.alive(), false, 'the watcher attempt neither reopened the view nor held back the stop');
});

// ---- Explicit recovery supersession (plan r3 addendum A1 r2, A8-S1..S8) ----

test('A8-S1: an incidental panel view never vetoes an explicit stop', async (t) => {
    await t.test('the panel detaches during the grace: re-armed in its window, stopped once abandoned', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id);
        const panel = await f.attach();
        const panelStream = f.open(panel.view.id);
        assert.deepEqual(await f.intent(f.created.view.id), { pending: true, until: 1_030_000 });
        await f.tick(10_000);
        panelStream.drop();
        await f.tick(20_000);
        assert.equal(f.alive(), true);
        assert.equal(f.session.pendingStop.deadline, 1_040_000);
        await f.tick(9_999);
        assert.equal(f.alive(), true);
        await f.tick(1);
        assert.equal(f.alive(), false);
        assert.equal(f.session.closeReason, 'tab_closed');
    });
    for (const before of [31_000, 5_000]) {
        await t.test(`the panel detached ${before / 1000} s before the close`, async (t2) => {
            const f = await closePolicyFixture(t2);
            f.open(f.created.view.id);
            const panel = await f.attach();
            f.open(panel.view.id).drop();
            await f.tick(before);
            assert.equal((await f.intent(f.created.view.id)).pending, true);
            await f.tick(29_999);
            assert.equal(f.alive(), true);
            await f.tick(1);
            assert.equal(f.alive(), false);
        });
    }
});

test('A8-S2: a panel still open at the deadline cancels as open-elsewhere and can stop it itself', async (t) => {
    const f = await closePolicyFixture(t);
    f.open(f.created.view.id);
    const panel = await f.attach();
    f.open(panel.view.id);
    assert.equal((await f.intent(f.created.view.id)).pending, true);
    await f.tick(30_000);
    assert.equal(f.alive(), true);
    assert.deepEqual(f.events('webtty_close_intent_cancelled').map(entry => entry.details.reason), ['open-elsewhere']);
    assert.equal((await f.intent(panel.view.id)).pending, true);
    await f.tick(30_000);
    assert.equal(f.alive(), false);
});

test('A8-S3: a panel-only detach arms nothing, and a keep policy never arms', async (t) => {
    await t.test('stop policy, panel detach only', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id);
        const panel = await f.attach();
        f.open(panel.view.id).drop();
        await f.tick(10 * 60_000);
        assert.equal(f.session.pendingStop, null);
        assert.equal(f.alive(), true);
    });
    await t.test('keep policy', async (t2) => {
        const f = await closePolicyFixture(t2, { closePolicy: 'keep' });
        f.open(f.created.view.id);
        const panel = await f.attach();
        f.open(panel.view.id).drop();
        assert.deepEqual(await f.intent(f.created.view.id, 'stop'), { pending: false });
        await f.tick(10 * 60_000);
        assert.equal(f.alive(), true);
    });
});

test('A8-S4: top-level and embedded recovery in both orders never revive the old stop', async (t) => {
    for (const [name, recoverer] of [['top-level', null], ['embedded', { lease: lease('explorer-tab') }]]) {
        await t.test(`${name}: close before attach`, async (t2) => {
            const f = await closePolicyFixture(t2);
            f.open(f.created.view.id);
            await f.intent(f.created.view.id);
            const recovered = await f.attach(recoverer || f.owner, f.created.view.id);
            assert.equal(recovered.role, 'owner');
            assert.equal(f.session.pendingStop, null);
            assert.deepEqual(f.events('webtty_close_intent_cancelled').map(entry => entry.details.reason), ['reopened']);
            f.open(recovered.view.id, recoverer || f.owner).drop();
            await f.tick(10 * 60_000);
            assert.equal(f.alive(), true);
        });
        await t.test(`${name}: attach before a delayed close`, async (t2) => {
            const f = await closePolicyFixture(t2);
            f.open(f.created.view.id).drop();
            const recovered = await f.attach(recoverer || f.owner, f.created.view.id);
            await assert.rejects(f.intent(f.created.view.id), { code: 'WEBTTY_VIEW_STALE' });
            assert.equal(f.session.pendingStop, null);
            // A delayed signal from the superseded view stays invalid after the recovered view disconnects.
            f.open(recovered.view.id, recoverer || f.owner).drop();
            await assert.rejects(f.intent(f.created.view.id), { code: 'WEBTTY_VIEW_STALE' });
            await f.tick(10 * 60_000);
            assert.equal(f.alive(), true);
        });
    }
});

test('A8-S5: invalid recovery claims change nothing', async (t) => {
    async function armed(t2) {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id);
        await f.intent(f.created.view.id);
        return f;
    }
    function unchanged(f, view, before, label) {
        assert.ok(f.session.pendingStop, `${label}: the stop stays armed`);
        assert.equal(f.session.pendingStop.deadline, 1_030_000, label);
        assert.deepEqual({ ...view }, before, `${label}: the claimed view is unchanged`);
    }
    const watcher = { lease: lease('watcher', 'other-admin') };
    await t.test('watcher claim', async (t2) => {
        const f = await armed(t2);
        const before = { ...f.view(f.created.view.id) };
        const attached = await f.attach(watcher, f.created.view.id);
        assert.equal(attached.role, 'watcher', 'the attach itself proceeds');
        unchanged(f, f.view(f.created.view.id), before, 'watcher');
        assert.deepEqual(f.events('webtty_view_supersede_ignored').map(entry => entry.details.reason), ['not_owner']);
    });
    await t.test('foreign, unknown and other-session ids', async (t2) => {
        const f = await armed(t2);
        const watched = await f.attach(watcher);
        const other = await f.manager.create({ req: f.owner, routePlan: f.plan, cwdRelative: '', closePolicy: 'stop' });
        const foreignBefore = { ...f.view(watched.view.id) };
        const armedBefore = { ...f.view(f.created.view.id) };
        await f.attach(f.owner, watched.view.id);
        await f.attach(f.owner, 'u'.repeat(32));
        await f.attach(f.owner, other.view.id);
        unchanged(f, f.view(watched.view.id), foreignBefore, 'foreign');
        assert.deepEqual({ ...f.view(f.created.view.id) }, armedBefore);
        assert.equal(f.manager.sessions.get(other.id).views.get(other.view.id).state, 'detached');
        assert.deepEqual(f.events('webtty_view_supersede_ignored').map(entry => entry.details.reason),
            ['foreign_view', 'unknown_view', 'unknown_view']);
        // Audits never carry raw view ids.
        assert.doesNotMatch(JSON.stringify(f.audits), new RegExp(`${watched.view.id}|${other.view.id}|${'u'.repeat(32)}`));
    });
    await t.test('already superseded and duplicate claims', async (t2) => {
        const f = await armed(t2);
        const panel = await f.attach();
        await f.attach(f.owner, panel.view.id);
        assert.equal(f.view(panel.view.id).state, 'superseded');
        assert.ok(f.session.pendingStop, 'superseding a view that did not arm the stop cancels nothing');
        const before = { ...f.view(panel.view.id) };
        await f.attach(f.owner, panel.view.id);
        unchanged(f, f.view(panel.view.id), before, 'duplicate');
        assert.deepEqual(f.events('webtty_view_supersede_ignored').map(entry => entry.details.reason), ['already_superseded']);
    });
    await t.test('a claim on a failed attach', async (t2) => {
        const f = await armed(t2);
        // Fill the cap with views inside their reconnect window; the ended arming view is evicted first.
        const views = [];
        for (let index = 0; index < 32; index += 1) views.push((await f.attach()).view.id);
        assert.equal(f.session.views.has(f.created.view.id), false);
        const before = { ...f.view(views[0]) };
        await assert.rejects(f.attach(f.owner, views[0]), { code: 'WEBTTY_VIEW_LIMIT' });
        unchanged(f, f.view(views[0]), before, 'failed attach');
        assert.equal(f.events('webtty_view_superseded').length, 0);
    });
    await t.test('malformed supersedes at mint', async (t2) => {
        const f = await armed(t2);
        for (const supersedes of ['short', 'x'.repeat(33), 'bad id'.padEnd(32, 'x'), 42]) {
            await assert.rejects(f.manager.createAttachToken({ req: f.owner, routePlan: f.plan, id: f.created.id, supersedes }),
                { code: 'WEBTTY_ATTACH_CLAIM_INVALID' });
        }
    });
});

test('A8-S6: repeated recoveries leave every replaced view stale and the latest view in charge', async (t) => {
    const f = await closePolicyFixture(t);
    f.open(f.created.view.id).drop();
    const second = await f.attach(f.owner, f.created.view.id);
    f.open(second.view.id).drop();
    const third = await f.attach(f.owner, second.view.id);
    await assert.rejects(f.intent(f.created.view.id), { code: 'WEBTTY_VIEW_STALE' });
    await assert.rejects(f.intent(second.view.id), { code: 'WEBTTY_VIEW_STALE' });
    assert.equal(f.session.pendingStop, null);
    assert.equal((await f.intent(third.view.id)).pending, true);
    await f.tick(30_000);
    assert.equal(f.alive(), false);
});

test('A8-S7: a claim on a still-open view suppresses its signal only while the claimant lives', async (t) => {
    await t.test('reload while the original stream is still open', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id);
        const recovered = await f.attach(f.owner, f.created.view.id);
        assert.equal(f.view(f.created.view.id).state, 'open', 'an open view is not ended by a claim');
        assert.equal(f.view(f.created.view.id).claimedBy, recovered.view.id);
        assert.deepEqual(await f.intent(f.created.view.id), { pending: false, reason: 'superseded' });
        assert.equal(f.view(f.created.view.id).state, 'superseded');
        assert.equal(f.session.pendingStop, null);
        f.open(recovered.view.id).drop();
        await f.tick(10 * 60_000);
        assert.equal(f.alive(), true);
    });
    await t.test('duplicated tab: the duplicate can stop; the original counts again once the duplicate ended', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id);
        const duplicate = await f.attach(f.owner, f.created.view.id);
        f.open(duplicate.view.id);
        // The duplicate's own signal arms; the original (open) cancels it at the deadline.
        assert.equal((await f.intent(duplicate.view.id)).pending, true);
        await f.tick(30_000);
        assert.equal(f.alive(), true);
        // The duplicate has ended, so the original's signal is processed normally.
        assert.equal((await f.intent(f.created.view.id)).pending, true);
        await f.tick(30_000);
        assert.equal(f.alive(), false);
    });
    await t.test('duplicated tab: the original is suppressed while the duplicate is alive', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id);
        const duplicate = await f.attach(f.owner, f.created.view.id);
        f.open(duplicate.view.id);
        assert.deepEqual(await f.intent(f.created.view.id), { pending: false, reason: 'superseded' });
        assert.equal((await f.intent(duplicate.view.id)).pending, true);
        await f.tick(30_000);
        assert.equal(f.alive(), false);
    });
});

test('A8-S8: switching to stop arms only for the most recent non-superseded owner intent', async (t) => {
    async function keepFixture(t2) {
        return closePolicyFixture(t2, { closePolicy: 'keep' });
    }
    const toStop = (f) => f.manager.setClosePolicy({ req: f.owner, routePlan: f.plan, id: f.created.id, policy: 'stop' });
    await t.test('latest intent stop arms with its sequence', async (t2) => {
        const f = await keepFixture(t2);
        const second = await f.attach();
        await f.intent(f.created.view.id, 'keep');
        await f.intent(second.view.id, 'stop');
        assert.equal((await toStop(f)).pendingStopUntil, 1_030_000);
        assert.equal(f.session.pendingStop.viewSeq, f.view(second.view.id).seq);
    });
    await t.test('latest intent keep does not arm', async (t2) => {
        const f = await keepFixture(t2);
        const second = await f.attach();
        await f.intent(f.created.view.id, 'stop');
        await f.intent(second.view.id, 'keep');
        assert.equal((await toStop(f)).pendingStopUntil, null);
    });
    await t.test('an abandoned non-consenting view does not block', async (t2) => {
        const f = await keepFixture(t2);
        f.open(f.created.view.id);
        const panel = await f.attach();
        await f.tick(31_000);
        await f.intent(f.created.view.id, 'stop');
        assert.equal(f.view(panel.view.id).state, 'detached');
        assert.equal((await toStop(f)).pendingStopUntil, 1_061_000);
    });
    await t.test('an open owner view blocks, and so does one still in its reconnect window', async (t2) => {
        const f = await keepFixture(t2);
        f.open(f.created.view.id);
        const live = await f.attach();
        const stream = f.open(live.view.id);
        await f.intent(f.created.view.id, 'stop');
        assert.equal((await toStop(f)).pendingStopUntil, null);
        stream.drop();
        await f.manager.setClosePolicy({ req: f.owner, routePlan: f.plan, id: f.created.id, policy: 'keep' });
        assert.equal((await toStop(f)).pendingStopUntil, null);
    });
});

test('A8-S4 at the view cap: the claimed view is never evicted by its own recovery attach', async (t) => {
    const f = await closePolicyFixture(t);
    f.open(f.created.view.id);
    for (let index = 0; index < 31; index += 1) await f.attach();
    await f.tick(31_000);
    assert.equal(f.session.views.size, 32);
    assert.equal((await f.intent(f.created.view.id)).pending, true);
    const recovered = await f.attach(f.owner, f.created.view.id);
    assert.equal(f.session.views.size, 32);
    assert.equal(f.view(f.created.view.id)?.state, 'superseded', 'the claimed view was retained and superseded');
    assert.equal(f.session.pendingStop, null);
    assert.deepEqual(f.events('webtty_close_intent_cancelled').map(entry => entry.details.reason), ['reopened']);
    assert.equal(f.events('webtty_view_supersede_ignored').length, 0);
    f.open(recovered.view.id).drop();
    await f.tick(10 * 60_000);
    assert.equal(f.alive(), true);
});

test('a superseded view cannot stream and its delayed close intent stays stale', async (t) => {
    const f = await closePolicyFixture(t);
    f.open(f.created.view.id).drop();
    await f.attach(f.owner, f.created.view.id);
    const response = streamResponse();
    assert.throws(() => f.manager.attachStream(f.session, Object.assign(new EventEmitter(), f.owner), response, '', f.plan,
        f.created.view.id), { code: 'WEBTTY_VIEW_STALE' });
    assert.equal(response.body, '');
    assert.equal(f.view(f.created.view.id).state, 'superseded');
    assert.equal(f.view(f.created.view.id).streams, 0);
    await assert.rejects(f.intent(f.created.view.id), { code: 'WEBTTY_VIEW_STALE' });
    assert.equal(f.session.pendingStop, null);
});

test('a claim on an open view follows the chain of later recoveries', async (t) => {
    await t.test('the latest successor is alive: the original signal is superseded', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id);
        const second = await f.attach(f.owner, f.created.view.id);
        assert.equal(f.view(f.created.view.id).claimedBy, second.view.id);
        const third = await f.attach(f.owner, second.view.id);
        assert.equal(f.view(second.view.id).state, 'superseded');
        assert.deepEqual(await f.intent(f.created.view.id), { pending: false, reason: 'superseded' });
        assert.equal(f.session.pendingStop, null);
        f.open(third.view.id).drop();
        await f.tick(10 * 60_000);
        assert.equal(f.alive(), true);
    });
    await t.test('the chain ends in an intent-ended view: the original signal is processed normally', async (t2) => {
        const f = await closePolicyFixture(t2);
        f.open(f.created.view.id);
        const second = await f.attach(f.owner, f.created.view.id);
        const third = await f.attach(f.owner, second.view.id);
        assert.equal((await f.intent(third.view.id)).pending, true);
        await f.tick(10_000);
        assert.deepEqual(await f.intent(f.created.view.id), { pending: true, until: 1_040_000 });
        await f.tick(30_000);
        assert.equal(f.alive(), false);
    });
    await t.test('a cyclic or missing chain counts as ended', async (t2) => {
        const f = await closePolicyFixture(t2);
        const [a, b] = [await f.attach(), await f.attach()];
        Object.assign(f.view(a.view.id), { state: 'superseded', supersededBy: b.view.id });
        Object.assign(f.view(b.view.id), { state: 'superseded', supersededBy: a.view.id });
        assert.equal(f.manager.recoveryClaimLive(f.session, f.view(a.view.id)), false);
        Object.assign(f.view(b.view.id), { supersededBy: 'm'.repeat(32) });
        assert.equal(f.manager.recoveryClaimLive(f.session, f.view(a.view.id)), false);
    });
});

test('a watcher claim never pins a view against eviction at the cap', async (t) => {
    const f = await closePolicyFixture(t);
    f.open(f.created.view.id);
    await f.intent(f.created.view.id);
    for (let index = 0; index < 31; index += 1) await f.attach();
    assert.equal(f.session.views.size, 32);
    const watcher = { lease: lease('watcher', 'other-admin') };
    // The only evictable view is the ended one the watcher names; the attach still succeeds.
    const watched = await f.attach(watcher, f.created.view.id);
    assert.equal(watched.role, 'watcher');
    assert.equal(f.session.views.has(f.created.view.id), false);
    assert.ok(f.session.pendingStop, 'the ignored claim leaves the stop armed');
});

// ---- Retired streams: a view that missed its shell's exit notification ----
// Generation invalidation drops an old-generation viewer for reconnect
// (`retry: 1000`) before deferred target validation retires the shell, so the
// dropped viewer never receives the exit event that went to attached viewers.

function sseResponse() {
    return Object.assign(streamResponse(), {
        statusCode: 0,
        headers: {},
        writeHead(status, headers = {}) { this.statusCode = status; this.headers = { ...headers }; },
        // JSON refusals pass their body to end().
        end(value = '') { this.body += String(value); this.writableEnded = true; },
    });
}

function adminStreamRequest(selectedLease) {
    return Object.assign(new EventEmitter(), {
        method: 'GET',
        headers: {},
        lease: selectedLease,
        user: { id: selectedLease.userId, roles: ['admin'] },
    });
}

async function streamThroughHandler(manager, plan, id, viewId, selectedLease, res = sseResponse()) {
    process.env.PLOINKY_MASTER_KEY ||= 'b'.repeat(64);
    const { handleWebtty } = await import('../../cli/server/handlers/webtty.js');
    const req = adminStreamRequest(selectedLease);
    await handleWebtty(req, res, new URL(`/webtty/sessions/${id}/stream?view=${viewId}`, 'http://localhost'),
        { manager, routePlan: plan });
    return { req, res, status: res.statusCode, body: res.body };
}

function currentGenerationPlan() {
    const plan = routePlan();
    plan.lease.id = 'generation-b';
    return plan;
}

async function missedExitFixture(t, { auth = requestAuthAdapter(), worker = new FakeWorker(), ...options } = {}) {
    let releaseValidation = null;
    let generationCurrent = true;
    const manager = await createManager(t, {
        auth,
        agentProviderAvailable: true,
        agentWorkerFactory: () => worker,
        ...options,
        targetResolver: {
            async revalidate({ target }) { return target; },
            async revalidateRunningAgent() {
                await new Promise((resolve) => { releaseValidation = resolve; });
                throw Object.assign(new Error('replaced'), { code: 'WEBTTY_TARGET_IDENTITY_STALE' });
            },
        },
    });
    const owner = lease('owner');
    const oldPlan = routePlan();
    oldPlan.lease.isCurrent = oldPlan.lease.commit = () => generationCurrent;
    const session = await createAgentSession(manager, { lease: owner });
    const [viewId] = session.views.keys();
    return {
        manager, worker, session, owner, oldPlan, viewId,
        open: (selectedLease = owner, selectedView = viewId, plan = oldPlan) => (
            streamThroughHandler(manager, plan, session.id, selectedView, selectedLease)
        ),
        stream: (selectedLease = owner, selectedView = viewId, plan = currentGenerationPlan()) => (
            streamThroughHandler(manager, plan, session.id, selectedView, selectedLease)
        ),
        // The validateLiveSessions route-lease path: retry, then end.
        async dropOldGeneration() {
            generationCurrent = false;
            await manager.validateLiveSessions();
        },
        // Deferred target validation proves the identity replaced.
        async startRetirement() {
            assert.equal(typeof releaseValidation, 'function', 'target validation must be in flight');
            releaseValidation();
            await settleTarget(session);
            assert.ok(session.closePromise, 'retirement started');
        },
        async retire() {
            await this.startRetirement();
            await session.closePromise;
        },
    };
}

test('a viewer dropped for reconnect before target retirement receives one finite exit on its next stream', async (t) => {
    const f = await missedExitFixture(t);
    const first = await f.open();
    assert.equal(first.res.statusCode, 200);
    f.worker.emit('output', { sequence: 1, data: 'one' });
    assert.match(first.res.body, /event: output/);
    await f.dropOldGeneration();
    assert.equal(first.res.writableEnded, true);
    assert.match(first.res.body, /retry: 1000\n\n$/);
    assert.equal(f.session.views.get(f.viewId).state, 'detached');
    assert.equal(f.manager.activeCount(), 1, 'generation loss alone never closes the shell');
    await f.retire();
    assert.equal(f.session.closeReason, 'target_identity_changed');
    assert.ok(f.manager.tombstones.has(f.session.id));
    assert.doesNotMatch(first.res.body, /event: exit/, 'the dropped viewer missed the exit notification');
    const again = await f.stream();
    t.diagnostic(`same-view reconnect after retirement: ${JSON.stringify({ status: again.status, body: again.body })}`);
    assert.equal(again.status, 200);
    assert.match(again.res.headers['Content-Type'], /^text\/event-stream/);
    assert.equal(again.body, `event: exit\ndata: ${JSON.stringify({ reason: 'target_identity_changed' })}\n\n`);
    assert.equal(again.res.writableEnded, true);
    assert.equal(f.manager.viewerCount, 0);
});

const RETAINED_NOT_FOUND = { status: 404, body: JSON.stringify({ ok: false, error: 'not_found' }) };

function exitBody(reason = 'target_identity_changed') {
    return `event: exit\ndata: ${JSON.stringify({ reason })}\n\n`;
}

function assertRetainedExit(read, reason, message) {
    assert.equal(read.status, 200, message);
    assert.match(read.res.headers['Content-Type'], /^text\/event-stream/, message);
    assert.equal(read.body, exitBody(reason), message);
    assert.equal(read.res.writableEnded, true, message);
    assert.equal(read.req.listenerCount('close'), 0, `${message}: no viewer binds the request`);
}

function assertRetainedRefusal(read, expected, message) {
    assert.deepEqual({ status: read.status, body: read.body }, expected, message);
    assert.doesNotMatch(String(read.res.headers['Content-Type'] || ''), /event-stream/, message);
}

// One-shot pause of the next lease validation, released by the test.
function validationGate() {
    let release;
    let entered;
    const gate = {
        armed: false,
        entered: new Promise((resolve) => { entered = resolve; }),
        released: new Promise((resolve) => { release = resolve; }),
        release: () => release(),
        // Waits until `pending` is paused at the gate; fails instead of
        // hanging if it settled without authenticating.
        async reached(pending) {
            const skipped = Symbol('skipped');
            const first = await Promise.race([gate.entered, pending.then(() => skipped, () => skipped)]);
            if (first === skipped) assert.fail('the request settled without reaching lease validation');
        },
        async pass() {
            if (!gate.armed) return;
            gate.armed = false;
            entered();
            await gate.released;
        },
    };
    return gate;
}

// Counts timers armed while `operation` runs.
async function countTimers(operation) {
    const { setTimeout: originalTimeout, setInterval: originalInterval } = globalThis;
    let armed = 0;
    globalThis.setTimeout = (...args) => { armed += 1; return originalTimeout(...args); };
    globalThis.setInterval = (...args) => { armed += 1; return originalInterval(...args); };
    try {
        return { result: await operation(), armed };
    } finally {
        globalThis.setTimeout = originalTimeout;
        globalThis.setInterval = originalInterval;
    }
}

test('retained exits authorize only the principal recorded for each view eligible at retirement', async (t) => {
    const f = await missedExitFixture(t);
    const plan = routePlan();
    const watcher = lease('watcher', 'other-admin');
    const attachView = async (req, supersedes = null) => {
        const token = await f.manager.createAttachToken({ req, routePlan: plan, id: f.session.id,
            ...(supersedes ? { supersedes } : {}) });
        return (await f.manager.attach({ req, routePlan: plan, attach: token.attach, cols: 80, rows: 24 })).view.id;
    };
    const watcherView = await attachView({ lease: watcher });
    const endedView = await attachView({ lease: f.owner });
    await f.manager.closeIntent({ req: { lease: f.owner }, routePlan: plan, id: f.session.id, view: endedView, policy: 'keep' });
    const replacedView = await attachView({ lease: f.owner });
    const recoveryView = await attachView({ lease: f.owner }, replacedView);
    assert.equal(f.session.views.get(endedView).state, 'ended');
    assert.equal(f.session.views.get(replacedView).state, 'superseded');
    await f.open();
    await f.dropOldGeneration();
    await f.retire();
    const record = f.manager.tombstones.get(f.session.id);
    assert.deepEqual([...record.retiredViews.keys()].sort(), [f.viewId, watcherView, recoveryView].sort());
    // Each exact view, as its recorded principal (any current login of that principal).
    assertRetainedExit(await f.stream(f.owner, f.viewId), 'target_identity_changed', 'owner view');
    assertRetainedExit(await f.stream(lease('new-login'), f.viewId), 'target_identity_changed', 'owner view, new login');
    assertRetainedExit(await f.stream(watcher, watcherView), 'target_identity_changed', 'watcher view');
    assertRetainedExit(await f.stream(f.owner, recoveryView), 'target_identity_changed', 'recovery view');
    for (const [name, selectedLease, view] of [
        ['foreign administrator on the owner view', lease('intruder', 'third-admin'), f.viewId],
        ['watcher on the owner view', watcher, f.viewId],
        ['owner on the watcher view', f.owner, watcherView],
        ['intent-ended view', f.owner, endedView],
        ['superseded view', f.owner, replacedView],
        ['unknown valid view', f.owner, 'u'.repeat(32)],
    ]) {
        assertRetainedRefusal(await f.stream(selectedLease, view), RETAINED_NOT_FOUND, name);
    }
    // View identities never reach the Live Sessions projection.
    const listed = JSON.stringify(await f.manager.listLiveSessions({ req: { lease: f.owner }, routePlan: plan }));
    for (const view of [f.viewId, watcherView, endedView, replacedView, recoveryView]) assert.equal(listed.includes(view), false);
    assertExplorerShellRow(await tombstoneRow(f.manager, f.session.id, { lease: f.owner }));
});

test('expired, evicted and fresh-manager retained outcomes answer 404 without SSE', async (t) => {
    await t.test('expired', async (t2) => {
        let now = 1_000_000;
        const f = await missedExitFixture(t2, { now: () => now });
        await f.open();
        await f.dropOldGeneration();
        await f.retire();
        const record = f.manager.tombstones.get(f.session.id);
        assert.equal(record.closure, 'proven');
        now = record.expiresAt - 1;
        assertRetainedExit(await f.stream(), 'target_identity_changed', 'before expiry');
        now = record.expiresAt;
        assertRetainedRefusal(await f.stream(), RETAINED_NOT_FOUND, 'at expiry');
    });
    await t.test('evicted', async (t2) => {
        const f = await missedExitFixture(t2, { limits: { maxTombstones: 1 } });
        await f.open();
        await f.dropOldGeneration();
        await f.retire();
        const other = await f.manager.create({ req: { lease: f.owner }, routePlan: routePlan(), cwdRelative: '' });
        await f.manager.closeSession(other.id, 'requested');
        assert.deepEqual([...f.manager.tombstones.keys()], [other.id]);
        assertRetainedRefusal(await f.stream(), RETAINED_NOT_FOUND, 'evicted');
    });
    await t.test('fresh manager', async (t2) => {
        const f = await missedExitFixture(t2);
        await f.open();
        await f.dropOldGeneration();
        await f.retire();
        const fresh = await createManager(t2, { auth: requestAuthAdapter() });
        assertRetainedRefusal(
            await streamThroughHandler(fresh, currentGenerationPlan(), f.session.id, f.viewId, f.owner),
            RETAINED_NOT_FOUND, 'fresh manager');
    });
});

test('repeated retained reads each end with one exit and grow no worker, viewer, index, record or subscription', async (t) => {
    const store = recordStore();
    const auth = requestAuthAdapter();
    let subscriptions = 0;
    auth.subscribeInvalidation = () => { subscriptions += 1; return () => {}; };
    let factories = 0;
    const worker = new FakeWorker();
    const f = await missedExitFixture(t, { auth, recordStore: store, worker });
    f.manager.workerFactory = f.manager.agentWorkerFactory = () => { factories += 1; throw new Error('no worker may start'); };
    const first = await f.open();
    worker.emit('output', { sequence: 1, data: 'one' });
    await f.dropOldGeneration();
    await f.retire();
    assert.doesNotMatch(first.body, /event: exit/);
    const record = f.manager.tombstones.get(f.session.id);
    const snapshot = () => JSON.stringify({
        viewers: f.manager.viewerCount, sessions: f.manager.sessions.size, owners: f.manager.ownerIndex.size,
        pending: f.manager.pendingCreations.size, closes: f.manager.inFlightCloses.size,
        launches: f.manager.launchAuthSubscriptions.size, tombstones: f.manager.tombstones.size,
        retained: [...record.retiredViews], closure: record.closure, scope: record.closureScope,
        expiresAt: record.expiresAt, store: store.calls, workerClosed: worker.closed, subscriptions, factories,
        sessionViewers: f.session.viewers.size, views: f.session.views.size, replay: f.session.replay.length,
        available: f.manager.availability(),
    });
    const before = snapshot();
    for (let read = 0; read < 5; read += 1) {
        const { result: retained, armed } = await countTimers(() => f.stream());
        assert.equal(armed, 0, `read ${read}: no timer`);
        assertRetainedExit(retained, 'target_identity_changed', `read ${read}`);
        assert.doesNotMatch(retained.body, /event: output|one/, `read ${read}: no replay`);
        assert.equal(snapshot(), before, `read ${read}`);
    }
    assert.equal(f.manager.tombstones.get(f.session.id), record, 'the same retained record');
});

test('retirement during live authentication falls back to the retained exit without a dead viewer', async (t) => {
    const gate = validationGate();
    const auth = requestAuthAdapter();
    let validations = 0;
    auth.validateLease = async () => { validations += 1; await gate.pass(); return { ok: true }; };
    const f = await missedExitFixture(t, { auth });
    await f.open();
    await f.dropOldGeneration();
    const before = validations;
    gate.armed = true;
    const reconnect = f.stream();
    await gate.reached(reconnect);
    assert.equal(f.manager.sessions.has(f.session.id), true, 'live authorization is in flight on a live shell');
    await f.retire();
    gate.release();
    const read = await reconnect;
    assertRetainedExit(read, 'target_identity_changed', 'fallback after live authorization');
    assert.equal(validations - before, 2, 'live and retained authorization each validated');
    assert.equal(f.manager.viewerCount, 0);
    assert.equal(f.session.viewers.size, 0);
});

test('eviction or expiry during retained authentication never answers a stale exit', async (t) => {
    await t.test('expiry', async (t2) => {
        let now = 1_000_000;
        const gate = validationGate();
        const auth = requestAuthAdapter();
        auth.validateLease = async () => { await gate.pass(); return { ok: true }; };
        const f = await missedExitFixture(t2, { auth, now: () => now });
        await f.open();
        await f.dropOldGeneration();
        await f.retire();
        const record = f.manager.tombstones.get(f.session.id);
        gate.armed = true;
        const reconnect = f.stream();
        await gate.reached(reconnect);
        now = record.expiresAt;
        gate.release();
        assertRetainedRefusal(await reconnect, RETAINED_NOT_FOUND, 'expired during authentication');
    });
    await t.test('eviction', async (t2) => {
        const gate = validationGate();
        const auth = requestAuthAdapter();
        auth.validateLease = async () => { await gate.pass(); return { ok: true }; };
        const f = await missedExitFixture(t2, { auth, limits: { maxTombstones: 1 } });
        await f.open();
        await f.dropOldGeneration();
        await f.retire();
        gate.armed = true;
        const reconnect = f.stream();
        await gate.reached(reconnect);
        const other = await f.manager.create({ req: { lease: f.owner }, routePlan: routePlan(), cwdRelative: '' });
        await f.manager.closeSession(other.id, 'requested');
        assert.equal(f.manager.tombstones.has(f.session.id), false);
        gate.release();
        assertRetainedRefusal(await reconnect, RETAINED_NOT_FOUND, 'evicted during authentication');
    });
});

test('retirement queued after live authorization resolves gives one empty finite stream, then one exit', async (t) => {
    const f = await missedExitFixture(t);
    const first = await f.open();
    f.worker.emit('output', { sequence: 1, data: 'one' });
    await f.dropOldGeneration();
    const authorize = f.manager.authorize.bind(f.manager);
    let retiredAfterAuthorize = false;
    f.manager.authorize = async (...args) => {
        const session = await authorize(...args);
        if (session && !retiredAfterAuthorize) {
            retiredAfterAuthorize = true;
            // Synchronously closing, removed and retained before the handler resumes.
            void f.manager.closeSession(session, 'target_identity_changed');
        }
        return session;
    };
    const empty = await f.stream();
    assert.equal(retiredAfterAuthorize, true);
    assert.equal(empty.status, 200);
    assert.match(empty.res.headers['Content-Type'], /^text\/event-stream/);
    assert.equal(empty.body, '', 'no attachment, replay or exit on the first response');
    assert.equal(empty.res.writableEnded, true);
    assert.equal(empty.req.listenerCount('close'), 0);
    assert.equal(f.manager.viewerCount, 0);
    assert.equal(f.session.viewers.size, 0);
    assert.equal(f.manager.sessions.size, 0);
    await f.session.closePromise;
    assert.equal(f.worker.closed, 1, 'only the retirement closed the worker');
    assertRetainedExit(await f.stream(), 'target_identity_changed', 'next same-view reconnect');
    assert.doesNotMatch(first.body, /event: exit/);
});

test('retained exits leave pending and unconfirmed cleanup outcomes unchanged', async (t) => {
    await t.test('pending', async (t2) => {
        let releaseClose;
        const barrier = new Promise((resolve) => { releaseClose = resolve; });
        const worker = new FakeWorker();
        const baseClose = worker.close.bind(worker);
        worker.close = async () => { await barrier; return baseClose(); };
        const f = await missedExitFixture(t2, { worker });
        await f.open();
        await f.dropOldGeneration();
        await f.startRetirement();
        const record = f.manager.tombstones.get(f.session.id);
        assert.deepEqual([record.closure, record.expiresAt], ['pending', Infinity]);
        assertRetainedExit(await f.stream(), 'target_identity_changed', 'pending cleanup');
        assert.deepEqual([record.closure, record.expiresAt], ['pending', Infinity], 'exit asserts no cleanup');
        assert.equal((await tombstoneRow(f.manager, f.session.id, { lease: f.owner })).closure, 'pending');
        releaseClose();
        await f.session.closePromise;
        assert.equal(record.closure, 'proven');
    });
    await t.test('unconfirmed', async (t2) => {
        const store = recordStore();
        store.recoverHandle = async () => ({ recovered: false, category: 'agent_startup_marker_survived', scope: 'target' });
        const f = await missedExitFixture(t2, { recordStore: store });
        await f.open();
        await f.dropOldGeneration();
        await f.retire();
        const record = f.manager.tombstones.get(f.session.id);
        const outcome = () => [record.closure, record.closureScope, record.expiresAt,
            f.manager.isAgentTargetQuarantined(f.session.target), f.manager.availability().ok];
        assert.deepEqual(outcome(), ['unconfirmed', 'target', Infinity, true, true]);
        assertRetainedExit(await f.stream(), 'target_identity_changed', 'unconfirmed cleanup');
        assertRetainedExit(await f.stream(), 'target_identity_changed', 'unconfirmed cleanup, again');
        assert.deepEqual(outcome(), ['unconfirmed', 'target', Infinity, true, true]);
        const row = await tombstoneRow(f.manager, f.session.id, { lease: f.owner });
        assert.deepEqual([row.closure, row.closureScope], ['unconfirmed', 'target']);
    });
});

test('retained reads keep authentication refusals and survive failed writes without allocating', async (t) => {
    let validate = async () => ({ ok: true });
    let createLease = (req) => req.lease;
    let subscriptions = 0;
    const auth = {
        ...requestAuthAdapter(),
        createLease: (req) => createLease(req),
        validateLease: (...args) => validate(...args),
        subscribeInvalidation: () => { subscriptions += 1; return () => {}; },
    };
    const f = await missedExitFixture(t, { auth });
    await f.open();
    await f.dropOldGeneration();
    await f.retire();
    const record = f.manager.tombstones.get(f.session.id);
    const snapshot = () => JSON.stringify({
        viewers: f.manager.viewerCount, sessions: f.manager.sessions.size, owners: f.manager.ownerIndex.size,
        launches: f.manager.launchAuthSubscriptions.size, tombstones: f.manager.tombstones.size,
        retained: [...record.retiredViews], closure: record.closure, workerClosed: f.worker.closed, subscriptions,
    });
    const before = snapshot();
    const json = (status, error) => ({ status, body: JSON.stringify({ ok: false, error }) });
    for (const [name, reason, expected] of [
        ['expired login', 'expired', json(401, 'authentication_required')],
        ['missing login', 'missing_or_expired', json(401, 'authentication_required')],
        ['revoked administrator', 'administrator_revoked', json(403, 'administrator_required')],
        ['provider outage', 'provider_unavailable', json(503, 'webtty_unavailable')],
    ]) {
        validate = async () => ({ ok: false, reason });
        const { result: refused, armed } = await countTimers(() => f.stream());
        assertRetainedRefusal(refused, expected, name);
        assert.equal(armed, 0, `${name}: no timer`);
        assert.equal(snapshot(), before, name);
    }
    validate = async () => { throw new Error('private provider failure'); };
    assertRetainedRefusal(await f.stream(), json(503, 'terminal_runtime_failure'), 'validation throws');
    validate = async () => ({ ok: true });
    createLease = () => { throw Object.assign(new Error('no login'), { code: 'WEBTTY_AUTH_SESSION_REQUIRED' }); };
    assertRetainedRefusal(await f.stream(), json(401, 'authentication_required'), 'lease creation throws');
    createLease = (req) => req.lease;
    assert.equal(snapshot(), before);
    for (const failing of ['write', 'end']) {
        const res = sseResponse();
        res[failing] = () => { throw new Error('socket reset'); };
        const { result: read, armed } = await countTimers(() => (
            streamThroughHandler(f.manager, currentGenerationPlan(), f.session.id, f.viewId, f.owner, res)));
        assert.equal(armed, 0, `${failing}: no timer`);
        assert.equal(read.status, 200, failing);
        assert.equal(read.req.listenerCount('close'), 0, failing);
        assert.equal(snapshot(), before, failing);
    }
    assertRetainedExit(await f.stream(), 'target_identity_changed', 'the record still answers');
});
