import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

// Every workspace-relative write (the generated master key behind CSRF
// tokens, the workspace lease under .ploinky/running) goes to this test's own
// temporary workspace, never to the checkout the suite runs from. The
// workspace root is read when the modules load, so it is set first.
const priorWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const testWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-routes-workspace-')));
process.env.PLOINKY_WORKSPACE_ROOT = testWorkspace;
test.after(() => {
    if (priorWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = priorWorkspaceRoot;
    fs.rmSync(testWorkspace, { recursive: true, force: true });
});
const { handleHardwareLimitsRoutes, buildHardwareLimitsState, hardwareHttpError } = await import('../../cli/server/authHandlers/hardwareLimitsRoutes.mjs');
const { hardwareStorePaths, initializeStore, readStoreSnapshot, beginDowngradeBarrier, setAgentLimits: setAgentLimitsForTest } = await import('../../cli/sandbox/hardwareLimits/store.mjs');
const { buildWorkspaceIdentity } = await import('../../ploinky-box/identity.mjs');
const { mintAdminCsrfToken, verifyAdminMutationRequest } = await import('../../cli/server/adminControlSecurity.js');
const { captureExactHardwareInstances, assertExactHardwareInstance, applyHardwareLimits, assertHardwareApplyInputs, reconcileExactHardwareInstance, hardwareApplyIsUnchanged } = await import('../../cli/sandbox/hardwareLimits/reconcile.mjs');
const { runHardwareLimitsApplyWorker, hardwareApplyFlight } = await import('../../cli/server/hardwareLimitsApplyWorker.mjs');
const { withWorkspaceMutationLease, inspectWorkspaceStartLock } = await import('../../cli/utils/runtime/maintenanceLocks.js');
const { HardwareLimitsError, serializeHardwareAwareError } = await import('../../cli/sandbox/hardwareLimits/errors.mjs');
const { buildDirectRefusal } = await import('../../cli/sandbox/hardwareLimits/requestedLimits.mjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-api-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const paths = hardwareStorePaths({ identity, homeDirectory: path.join(root, 'home') });
    initializeStore({ paths, identity });
    const getContext = () => { const snapshot = readStoreSnapshot({ paths, identity }); return { gate: 'on', prepared: true, backendReady: true, controllers: ['cpu', 'memory', 'pids'], storeState: 'valid', storeToken: snapshot.token, overrides: snapshot.agents, envelope: { cpus: 8, memoryBytes: 8 * 1024 ** 3 }, paths, identity }; };
    const record = (alias = '') => ({ type: 'agent', repoName: 'demo', agentName: 'worker', alias, instanceId: `instance-${alias}`, enableGeneration: `generation-${alias}`, containerId: 'a'.repeat(64) });
    const registry = { canonical: record(), alias1: record('one'), alias2: record('router') };
    const dependencies = {
        ensureAdmin: async (req, res) => {
            if (req.user?.roles?.includes('admin')) return true;
            res.writeHead(req.user ? 403 : 401); res.end(JSON.stringify({ ok: false, error: req.user ? 'admin_required' : 'not_authenticated' })); return false;
        },
        verifyMutation: verifyAdminMutationRequest, getContext,
        getInstalled: () => [{ ref: 'demo/worker', manifestPath: '/fixture/manifest.json' }],
        getRegistry: () => registry, getRouting: () => ({ routes: {} }), getMetrics: () => null,
        // An Apply waits for a fresh metrics reconcile before it answers; these tests have no engine to read.
        refreshMetrics: async () => ({ fresh: true }),
        admit: () => ({ descriptor: { runtimePolicy: { resources: {} }, hardwarePlacement: { limitsHash: 'b'.repeat(64), expected: { cpus: 1 } } } }),
        apply: async (input) => applyHardwareLimits(input, {
            lease: async (_options, callback) => callback(), loadRegistry: () => registry, loadRouting: () => ({ routes: {} }),
            readPolicy: () => ({ paths, token: getContext().storeToken }),
            loadPlan: () => ({}), isUnchanged: () => false,
            reconcile: async (captured) => ({ key: captured.key, state: 'applied', problem: null }),
        }),
    };
    return { root, paths, identity, registry, record, getContext, dependencies, token: getContext().storeToken };
}

async function request(f, { method = 'GET', body = null, rawBody, user = { id: 'fixture-admin', roles: ['admin'] }, headers = {}, rawHeaders = [], proof = true, dependencies = {} } = {}) {
    const req = Readable.from([rawBody ?? (body === null ? '' : JSON.stringify(body))]);
    Object.assign(req, { method, headers: { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080', ...headers }, rawHeaders, socket: {}, user, sessionId: 'fixture-session' });
    if (proof && method === 'POST' && !Object.hasOwn(headers, 'x-ploinky-csrf-token')) req.headers['x-ploinky-csrf-token'] = mintAdminCsrfToken({ req, sessionId: req.sessionId });
    let status;
    let response;
    const res = { writeHead(value) { status = value; }, end(value) { response = JSON.parse(value); } };
    await handleHardwareLimitsRoutes(req, res, new URL('http://127.0.0.1:8080/api/marketplace/hardware-limits'), { ...f.dependencies, ...dependencies });
    return { status, body: response };
}

const setBody = (f, extra = {}) => ({ action: 'set_agent_limits', expectedToken: f.token, agentRef: 'demo/worker', limits: { cpus: 1 }, ...extra });
for (const [name, user, status] of [['anonymous', null, 401], ['nonadmin', { roles: ['user'] }, 403], ['guest', { roles: ['guest'] }, 403]]) {
    test(`R.${name}`, async (t) => { const result = await request(fixture(t), { user }); assert.equal(result.status, status); });
}
test('R.admin', async (t) => { const result = await request(fixture(t)); assert.equal(result.status, 200); assert.equal(result.body.agents[0].containers.length, 3); assert.match(result.body.help.authority, /master key/); });
test('R.origin', async (t) => { const f = fixture(t); assert.equal((await request(f, { method: 'POST', body: setBody(f), headers: { origin: 'http://foreign.test' } })).status, 403); });
test('R.csrf', async (t) => { const f = fixture(t); for (const headers of [{}, { 'x-ploinky-csrf-token': 'invalid' }]) assert.equal((await request(f, { method: 'POST', body: setBody(f), headers, proof: false })).status, 403); });
test('R.cross-session-csrf', async (t) => { const f = fixture(t); const req = { headers: { host: '127.0.0.1:8080' }, socket: {}, sessionId: 'other-fixture-session' }; assert.equal((await request(f, { method: 'POST', body: setBody(f), headers: { 'x-ploinky-csrf-token': mintAdminCsrfToken({ req, sessionId: req.sessionId }) } })).status, 403); });
for (const [name, action] of [['get', null], ['set', 'set_agent_limits'], ['clear', 'clear_agent_limits'], ['apply', 'apply']]) {
    test(`R.bearer-${name}`, async (t) => { const f = fixture(t); const result = await request(f, { method: action ? 'POST' : 'GET', rawBody: 'not JSON', headers: { authorization: 'Bearer agent' }, dependencies: { ensureAdmin() { assert.fail('Bearer must reject before sessions or body'); } } }); assert.equal(result.status, 403); assert.equal(result.body.error, 'agent_forbidden'); });
}
test('R.duplicate-authorization', async (t) => { const f = fixture(t); for (const options of [{ headers: { authorization: ['Basic user', 'Bearer agent'] } }, { rawHeaders: ['Authorization', 'Basic user', 'authorization', 'Bearer agent'] }, { headers: { authorization: 'Basic user, Bearer agent' } }]) assert.equal((await request(f, options)).status, 403); });
test('R.invalid-json', async (t) => { const f = fixture(t); assert.equal((await request(f, { method: 'POST', rawBody: '{bad' })).body.error, 'invalid_json'); });
test('R.body-bound', async (t) => { const f = fixture(t); assert.equal((await request(f, { method: 'POST', rawBody: ' '.repeat(16 * 1024 + 1) })).status, 400); });
test('R.unknown-action', async (t) => { const f = fixture(t); for (const action of ['unknown', '__proto__']) assert.equal((await request(f, { method: 'POST', body: setBody(f, { action }) })).body.error, 'unknown_action'); });
test('R.unknown-target', async (t) => { const f = fixture(t); assert.equal((await request(f, { method: 'POST', body: setBody(f, { agentRef: 'demo/absent' }) })).status, 404); });
test('R.pool-rejected', async (t) => { const f = fixture(t); for (const body of [setBody(f, { pool: {} }), setBody(f, { limits: { pool: {} } }), { action: 'set_pool', expectedToken: f.token }]) assert.equal((await request(f, { method: 'POST', body })).status, 400); });
test('R.cas-conflict', async (t) => { const f = fixture(t); assert.equal((await request(f, { method: 'POST', body: setBody(f) })).status, 200); assert.equal((await request(f, { method: 'POST', body: setBody(f) })).status, 409); });
for (const [name, keys] of [['alias-canonical', ['canonical', 'alias1']], ['two-aliases', ['alias1', 'alias2']], ['alias-router', ['alias2']]]) {
    test(`R.${name}`, async (t) => { const f = fixture(t); const result = await request(f, { method: 'POST', body: { action: 'apply', expectedToken: f.token, containers: keys } }); assert.equal(result.status, 200); assert.deepEqual(result.body.results.map((item) => item.key), [...keys].sort()); });
}
test('R.exact-key-only', async (t) => { const f = fixture(t); for (const key of ['demo/worker', 'one', 'router']) assert.equal((await request(f, { method: 'POST', body: { action: 'apply', expectedToken: f.token, containers: [key] } })).status, 404); });
test('R.stale-identity', (t) => { const f = fixture(t); const captured = captureExactHardwareInstances(f.registry, ['canonical'])[0]; f.registry.canonical = { ...f.registry.canonical, enableGeneration: 'replacement' }; assert.throws(() => assertExactHardwareInstance(captured, f.registry), { code: 'identity_changed' }); });
test('R.no-op', async (t) => { const f = fixture(t); let mutations = 0; const result = await applyHardwareLimits({ expectedToken: f.token, containers: ['canonical'] }, { lease: (_options, callback) => callback(), loadRegistry: () => f.registry, loadRouting: () => ({}), readPolicy: () => ({ paths: f.paths, token: f.token }), loadPlan: () => ({}), isUnchanged: () => true, reconcile: () => { mutations++; } }); assert.equal(mutations, 0); assert.equal(result.results[0].state, 'unchanged'); });
test('R.dedup', async (t) => { const f = fixture(t); const result = await request(f, { method: 'POST', body: { action: 'apply', expectedToken: f.token, containers: ['canonical', 'canonical'] } }); assert.equal(result.body.results.length, 1); });
test('R.partial-apply', async (t) => { const f = fixture(t); let calls = 0; const result = await applyHardwareLimits({ expectedToken: f.token, containers: ['canonical', 'alias1', 'alias2'] }, { lease: (_options, callback) => callback(), loadRegistry: () => f.registry, loadRouting: () => ({}), readPolicy: () => ({ paths: f.paths, token: f.token }), loadPlan: () => ({}), isUnchanged: () => false, reconcile: async (captured) => { if (++calls === 2) throw Object.assign(new Error('new token'), { code: 'revision_conflict', status: 409 }); return { key: captured.key, state: 'applied' }; } }); assert.equal(result.status, 409); assert.equal(result.results[0].state, 'applied'); assert.equal(result.results[1].state, 'pending'); assert.equal(result.pendingContainers.length, 1); });
test('R.barrier-apply-only', async (t) => { const f = fixture(t); beginDowngradeBarrier({ paths: f.paths, identity: f.identity, operationId: 'c'.repeat(32), expectedEmptyToken: f.token }); assert.equal((await request(f)).status, 200); assert.equal((await request(f, { method: 'POST', body: { action: 'apply', expectedToken: f.token, containers: [] } })).body.error, 'hardware_limits_transition'); assert.doesNotThrow(() => assertHardwareApplyInputs(f.token, { origin: 'monitor', readPolicy: () => ({ paths: f.paths, token: f.token }) })); });

test('R.concurrent-entry-order', async (t) => {
    const f = fixture(t);
    const events = [];
    const captured = captureExactHardwareInstances(f.registry, ['canonical'])[0];
    const result = await reconcileExactHardwareInstance(captured, {}, {
        loadRegistry: () => f.registry, loadRouting: () => ({}),
        loadPlan: () => ({ runtime: 'podman', profileResolution: {}, manifest: {}, agentPath: '/fixture', routerEndpoint: null }),
        maintenance: async (_key, _options, callback) => { events.push('maintenance'); return callback(); },
        network: async (callback) => { events.push('network'); return callback({}); },
        ensure: () => { events.push('create'); return { containerName: 'canonical', containerId: 'd'.repeat(64), registryRecord: f.registry.canonical }; },
        readiness: async () => events.push('readiness'), activate: async () => events.push('publish'),
    });
    assert.equal(result.state, 'applied');
    assert.deepEqual(events, ['maintenance', 'network', 'create', 'readiness', 'publish']);
});

function refusal() {
    return new HardwareLimitsError(buildDirectRefusal({ key: 'canonical', ref: 'demo/worker', inputFingerprint: 'a'.repeat(64), refusalParts: { reasonCode: 'controller_unavailable', reason: 'Memory delegation is missing.', fix: 'Repair delegation then restart.', requested: [{ field: 'memory', value: '64m', source: 'manifest' }] } }));
}
test('E.http-cause', () => { const response = hardwareHttpError(new Error('wrapper', { cause: refusal() })); assert.equal(response.status, 422); assert.equal(response.body.hardwareOutcome.requested[0].source, 'manifest'); assert.equal(JSON.stringify(response).includes('stack'), false); });
test('E.apply-outbound', async () => {
    let sent;
    class FixtureWorker extends EventEmitter { constructor(_url, options) { super(); sent = options.workerData; queueMicrotask(() => this.emit('message', { ok: true, cleanupComplete: true, result: { ok: true, results: [] } })); } }
    const input = { expectedToken: { epoch: 'a'.repeat(32), revision: 1 }, containers: ['exact-key'] };
    await runHardwareLimitsApplyWorker(input, { WorkerClass: FixtureWorker });
    assert.deepEqual({ expectedToken: sent.expectedToken, containers: sent.containers }, input);
    assert.ok(sent.operationControl.buffer instanceof SharedArrayBuffer);
});
test('E.apply-inbound', async () => {
    class FixtureWorker extends EventEmitter { constructor() { super(); queueMicrotask(() => this.emit('message', { ok: false, cleanupComplete: true, error: serializeHardwareAwareError(refusal()) })); } }
    await assert.rejects(runHardwareLimitsApplyWorker({ expectedToken: { epoch: 'a'.repeat(32), revision: 1 }, containers: ['canonical'] }, { WorkerClass: FixtureWorker }), (error) => { assert.equal(error.hardwareOutcome.rootCause.key, 'canonical'); assert.equal(error.hardwareOutcome.fix, 'Repair delegation then restart.'); return true; });
});

test('R.unlimited-and-stopped-no-op', (t) => {
    const f = fixture(t);
    const captured = captureExactHardwareInstances(f.registry, ['canonical'])[0];
    const plan = { runtimeAdmission: { descriptor: { hardwareRequest: [] } }, profileResolution: { network: { mode: 'host' } } };
    const collaborators = { loadRouting: () => ({}), readLabel: () => '', inspect: () => ({ state: 'exact', id: captured.record.containerId, running: true }) };
    assert.equal(hardwareApplyIsUnchanged(captured, plan, collaborators), true);
    assert.equal(hardwareApplyIsUnchanged(captured, plan, { ...collaborators, inspect: () => ({ state: 'exact', id: captured.record.containerId, running: false }) }), false);
    assert.equal(hardwareApplyIsUnchanged(captured, plan, { ...collaborators, inspect: () => ({ state: 'exact', id: 'b'.repeat(64), running: true }) }), false);
    assert.equal(hardwareApplyIsUnchanged(captured, plan, { ...collaborators, loadRouting: () => ({ routes: { worker: { container: captured.key, hardwareAvailability: {} } } }) }), false);
});

test('R.authority-under-store-lock', async (t) => {
    const f = fixture(t);
    let valid = true;
    const result = await request(f, { method: 'POST', body: setBody(f), dependencies: {
        verifyLease: () => valid,
        set: (options) => { valid = false; return setAgentLimitsForTest(options); },
    } });
    assert.equal(result.status, 409);
    assert.equal(readStoreSnapshot({ paths: f.paths, identity: f.identity }).token.revision, f.token.revision);
});

test('R.cooperative-timeout-releases-real-lease', async (t) => {
    const f = fixture(t);
    let acquired;
    const ready = new Promise((resolve) => { acquired = resolve; });
    class FixtureWorker extends EventEmitter {
        constructor(_url, options) {
            super();
            const control = new Int32Array(options.workerData.operationControl.buffer);
            void withWorkspaceMutationLease({ operation: 'test-cooperative-apply', waitTimeoutMs: 0 }, async () => {
                acquired();
                while (!Atomics.load(control, 0)) await new Promise((resolve) => setTimeout(resolve, 2));
                assert.ok(hardwareApplyFlight(), 'flight remains owned until cleanup completes');
                await assert.rejects(runHardwareLimitsApplyWorker({ expectedToken: f.token, containers: [] }, { WorkerClass: FixtureWorker }), { code: 'apply_in_progress' });
            }).then(() => this.emit('message', { ok: false, cleanupComplete: true, error: { code: 'apply_timeout', status: 504, message: 'Cancelled after lease release.' } }));
        }
        terminate() { assert.fail('a live lease must never be terminated'); }
    }
    const pending = runHardwareLimitsApplyWorker({ expectedToken: f.token, containers: [] }, { WorkerClass: FixtureWorker, timeoutMs: 30 });
    await ready;
    const result = await pending;
    assert.equal(result.status, 504);
    assert.equal(hardwareApplyFlight(), null);
    assert.equal(inspectWorkspaceStartLock().active, false);
    await withWorkspaceMutationLease({ operation: 'next-after-cancel', waitTimeoutMs: 0 }, async () => {});
});

test('R.cli-token-recheck-before-create', async (t) => {
    const f = fixture(t);
    const captured = captureExactHardwareInstances(f.registry, ['canonical'])[0];
    let currentToken = f.token;
    let reads = 0;
    let creates = 0;
    await assert.rejects(reconcileExactHardwareInstance(captured, { origin: 'cli' }, {
        loadRegistry: () => f.registry, loadRouting: () => ({}), readPolicy: () => { reads++; return { paths: f.paths, token: currentToken }; },
        loadPlan: () => ({ runtime: 'podman', profileResolution: {}, manifest: {}, agentPath: '/fixture', routerEndpoint: null }),
        maintenance: (_key, _options, callback) => callback(), network: (callback) => callback({}),
        ensure: (_name, _manifest, _path, options) => { currentToken = { ...f.token, revision: f.token.revision + 1 }; options.beforeHardwareMutation(); creates++; },
        cleanupPrepared: () => {},
    }), { code: 'revision_conflict' });
    assert.ok(reads >= 3);
    assert.equal(creates, 0);
});

test('R.authorization-after-lock-wait', async (t) => {
    const f = fixture(t);
    let valid = true;
    let mutations = 0;
    await assert.rejects(applyHardwareLimits({ expectedToken: f.token, containers: ['canonical'] }, {
        lease: (_options, callback) => { valid = false; return callback(); }, authorize: () => valid,
        loadRegistry: () => f.registry, readPolicy: () => ({ paths: f.paths, token: f.token }),
        reconcile: () => { mutations++; },
    }), { code: 'identity_changed' });
    assert.equal(mutations, 0);
});

test('R.limits-state-unplaced-instance-matches-apply', (t) => {
    const f = fixture(t);
    const context = { ...f.getContext(), prepared: false, backendReady: false, controllers: [] };
    const metrics = { runtimes: Object.keys(f.registry).map((containerName) => ({ containerName, state: { running: true, ready: true }, metrics: { available: true, cpuPercent: 1, memoryBytes: 1 } })) };
    const stateFor = (descriptor, readApplied = () => null) => buildHardwareLimitsState({ context, installed: [{ ref: 'demo/worker', manifestPath: '/fixture/manifest.json' }], registry: { canonical: f.registry.canonical }, metrics, admit: () => ({ descriptor }), readApplied }).agents[0].containers[0].limitsState;
    // Unlimited instance without hardware placement (unprepared Box, D4 or a
    // sandbox): Apply calls it unchanged, so GET must not invent pending.
    const unlimited = { runtimePolicy: { resources: {} } };
    const captured = captureExactHardwareInstances(f.registry, ['canonical'])[0];
    const exact = { loadRouting: () => ({}), readLabel: () => '', inspect: () => ({ state: 'exact', id: captured.record.containerId, running: true }) };
    assert.equal(hardwareApplyIsUnchanged(captured, { runtimeAdmission: { descriptor: unlimited } }, exact), true);
    assert.equal(stateFor(unlimited), 'applied');
    // A request that cannot be placed, or a recorded refusal, is unavailable.
    const requested = { runtimePolicy: { resources: { cpus: 1 } }, hardwareRequest: [{ field: 'cpus', value: '1', source: 'settings' }] };
    assert.equal(hardwareApplyIsUnchanged(captured, { runtimeAdmission: { descriptor: requested } }, exact), false);
    assert.equal(stateFor(requested), 'unavailable');
    assert.equal(buildHardwareLimitsState({ context, installed: [{ ref: 'demo/worker', manifestPath: '/x' }], registry: { canonical: f.registry.canonical }, metrics, admit: () => ({ descriptor: unlimited, hardwareEligibility: { state: 'refused', refusal: {} } }) }).agents[0].containers[0].limitsState, 'unavailable');
    // A runtime that still carries an earlier placement is what Apply changes.
    const placed = (key, containerId) => ({ key, containerId, instanceId: f.registry.canonical.instanceId, enableGeneration: f.registry.canonical.enableGeneration, limitsHash: 'c'.repeat(64) });
    assert.equal(hardwareApplyIsUnchanged(captured, { runtimeAdmission: { descriptor: unlimited } }, { ...exact, readLabel: () => 'c'.repeat(64) }), false);
    assert.equal(stateFor(unlimited, placed), 'pending');
    // A stopped instance stays unavailable either way.
    assert.equal(buildHardwareLimitsState({ context, installed: [{ ref: 'demo/worker', manifestPath: '/x' }], registry: { canonical: f.registry.canonical }, metrics: null, admit: () => ({ descriptor: unlimited }) }).agents[0].containers[0].limitsState, 'unavailable');
});

test('R.apply-demoted-while-waiting-for-lock', async (t) => {
    const f = fixture(t);
    // The production check re-resolves the session's user on every call.
    const sessions = new Map([['fixture-session', { id: 'fixture-admin', roles: ['admin'] }]]);
    const ensureAdmin = async (req, res) => {
        req.user = sessions.get(req.sessionId);
        if (req.user?.roles?.includes('admin')) return true;
        res.writeHead(req.user ? 403 : 401); res.end(JSON.stringify({ ok: false, error: 'admin_required' })); return false;
    };
    for (const demote of [false, true]) {
        sessions.set('fixture-session', { id: 'fixture-admin', roles: ['admin'] });
        let mutations = 0;
        const result = await request(f, { method: 'POST', body: { action: 'apply', expectedToken: f.token, containers: ['canonical'] }, dependencies: {
            ensureAdmin,
            // The real worker thread holds the workspace lease, then asks the
            // Router to authorize (its blocking round trip is the bridge
            // below). The demotion lands while Apply waits for that lock.
            apply: async (input, options) => {
                if (demote) sessions.set('fixture-session', { id: 'fixture-admin', roles: ['user'] });
                const allowed = await options.authorize();
                return applyHardwareLimits(input, {
                    lease: async (_options, callback) => callback(), authorize: () => allowed,
                    loadRegistry: () => f.registry, loadRouting: () => ({ routes: {} }),
                    readPolicy: () => ({ paths: f.paths, token: f.getContext().storeToken }),
                    loadPlan: () => ({}), isUnchanged: () => false,
                    reconcile: async (captured) => { mutations++; return { key: captured.key, state: 'applied', problem: null }; },
                });
            },
        } });
        if (demote) {
            assert.equal(mutations, 0, 'a demoted administrator mutates nothing');
            assert.equal(result.status, 409, JSON.stringify(result.body));
            assert.equal(result.body.error, 'identity_changed');
        } else {
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.equal(mutations, 1);
        }
    }
});

test('R.coordinated-client-pending-is-partial', async (t) => {
    const f = fixture(t);
    const result = await applyHardwareLimits({ expectedToken: f.token, containers: ['canonical'] }, {
        lease: (_options, callback) => callback(), loadRegistry: () => f.registry, loadRouting: () => ({}), readPolicy: () => ({ paths: f.paths, token: f.token }),
        loadPlan: () => ({}), isUnchanged: () => false,
        reconcile: async (captured, options) => {
            options.onMpsPlan({ expandedKeys: ['alias1'] });
            options.onMpsResult({ key: 'alias1', state: 'pending', problem: null, error: 'mps_client_failed' });
            return { key: captured.key, state: 'applied', problem: null };
        },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 207);
    assert.deepEqual(result.pendingContainers, ['alias1']);
    assert.deepEqual(result.results.map((value) => [value.key, value.state]), [['alias1', 'pending'], ['canonical', 'applied']]);
});

// Importing the routes (and through them the metrics monitor) starts no
// engine query or timer; the Router starts the monitor at boot.
test('R.metrics-monitor-not-started-on-import', async () => {
    const { workspaceMetricsMonitor } = await import('../../cli/server/workspaceMetrics.js');
    assert.equal(workspaceMetricsMonitor.started, false);
    assert.equal(workspaceMetricsMonitor.latest, null);
    const router = fs.readFileSync(new URL('../../cli/server/RoutingServer.js', import.meta.url), 'utf8');
    assert.match(router, /workspaceMetricsMonitor\.start\(\);/);
});

// --- P1S: a snapshot is a statement about the container it read, and a successful Apply leaves the next status read fresh -----
const { workspaceMetricsMonitor } = await import('../../cli/server/workspaceMetrics.js');
const Monitor = workspaceMetricsMonitor.constructor;
const OLD_ID = 'a'.repeat(64);
const NEW_ID = 'b'.repeat(64);
const LIMITS_HASH = 'b'.repeat(64);
const placementAdmit = () => ({ descriptor: { runtimePolicy: { resources: {} }, hardwarePlacement: { limitsHash: LIMITS_HASH, expected: { cpus: 1 } } } });
const engineEntry = (extra = {}) => ({ containerName: 'canonical', containerId: OLD_ID, agentName: 'worker', repoName: 'demo', runtime: 'container', enabled: true, state: { status: 'exited', running: false, pid: 0 }, ...extra });
// A record whose CURRENT container is NEW_ID, and the applied observation written when that container was created.
function recreated(f, observedAt) {
    const record = { ...f.registry.canonical, containerId: NEW_ID };
    const observation = { key: 'canonical', containerId: NEW_ID, instanceId: record.instanceId, enableGeneration: record.enableGeneration, limitsHash: LIMITS_HASH, mpsGeneration: null, observedAt };
    return { record, observation, readApplied: (key, id) => (key === 'canonical' && id === NEW_ID ? observation : null) };
}
// The real monitor publishing the states the engine reader returned; only that reader's output is injected.
function snapshotOf(states) { const monitor = new Monitor(); monitor.states = states; monitor.statesReadStartedAt = Date.now(); monitor.publish(); return monitor.latest; }
function statusOf(f, states, observedOffsetMs) {
    const metrics = snapshotOf(states);
    const { record, readApplied } = recreated(f, new Date(Date.parse(metrics.readStartedAt) + observedOffsetMs).toISOString());
    const state = buildHardwareLimitsState({ context: f.getContext(), installed: [{ ref: 'demo/worker', manifestPath: '/fixture/manifest.json' }], registry: { canonical: record }, metrics, admit: placementAdmit, readApplied });
    const container = state.agents[0].containers[0];
    return { availability: container.availability, limitsState: container.limitsState, limits: container.limits ?? null };
}

test('S1.a-stale-snapshot-never-reports-a-just-recreated-instance-as-stopped-or-unavailable', (t) => {
    const f = fixture(t);
    const stale = 60_000; const fresh = -60_000;
    const starting = { availability: 'starting', limitsState: 'applied' };
    const stopped = { availability: 'stopped', limitsState: 'unavailable' };
    for (const [label, states, offset, expected] of [
        ['an entry of the earlier container (it was stopped by the drain)', [engineEntry()], stale, starting],
        ['no entry for the instance at all', [], stale, starting],
        ['an entry without a container id that predates the instance', [engineEntry({ containerId: undefined })], stale, starting],
        ['a fresh entry of the CURRENT container that is not running', [engineEntry({ containerId: NEW_ID })], fresh, stopped],
        ['a fresh entry without a container id that is not running (a real stop)', [engineEntry({ containerId: undefined })], fresh, stopped],
        ['a fresh entry of the current container, running and ready', [engineEntry({ containerId: NEW_ID, state: { status: 'running', running: true, ready: true, pid: 5 } })], fresh, { availability: 'ready', limitsState: 'applied' }],
        ['the engine runs it and no route is active yet', [engineEntry({ containerId: NEW_ID, engineRunning: true, state: { status: 'starting', running: false, pid: 5 } })], fresh, starting],
        ['marked starting but the engine does not run it', [engineEntry({ containerId: NEW_ID, engineRunning: false, state: { status: 'starting', running: false, pid: 0 } })], fresh, stopped],
    ]) {
        const { availability, limitsState } = statusOf(f, states, offset);
        assert.deepEqual({ availability, limitsState }, expected, label);
    }
    // The stale entry's own limits belong to the earlier container and are not shown for the new one.
    assert.equal(statusOf(f, [engineEntry({ limits: { cpus: 9 } })], stale).limits, null);
});

// S2: the real monitor and the real route; only the engine's container list (and the registry it is read against) is injected.
function appliedWorld(t, { gate = null, boundMs = 4000 } = {}) {
    const f = fixture(t);
    const record = { ...f.registry.canonical, containerId: NEW_ID };
    const { observation, readApplied } = recreated(f, new Date(0).toISOString());
    // The engine at first: the earlier container, stopped by the drain. The Apply (below) leaves the new container running.
    const engine = { containers: [engineEntry()], listings: 0 };
    const newRunning = engineEntry({ containerId: NEW_ID, state: { status: 'running', running: true, pid: 7 } });
    const monitor = new Monitor({
        readRegistry: () => ({ canonical: record }), runtimeStateOptions: { activeGeneration: null, routes: { worker: { container: 'canonical', repo: 'demo', agent: 'worker', hostPort: 4100 } } },
        readHardwareContext: () => ({ gate: 'off' }), readRouting: () => ({ routes: {} }), containerStats: false,
        collectContainers: async () => { const listing = engine.containers; engine.listings += 1; if (gate && engine.listings === 2) await gate.promise; return listing; },
    });
    const applied = () => { engine.containers = [newRunning]; observation.observedAt = new Date().toISOString(); };
    const deps = (extra = {}) => ({
        getRegistry: () => ({ canonical: record }), getMetrics: () => monitor.latest, readApplied, admit: placementAdmit,
        refreshMetrics: (since) => monitor.reconcileAfter(since, boundMs), ...extra,
    });
    return { f, monitor, engine, applied, deps, record };
}
const applyBody = f => ({ action: 'apply', expectedToken: f.token, containers: ['canonical'] });
const containerOf = response => response.body.agents[0].containers[0];

test('S2.a-status-read-right-after-an-apply-response-sees-the-new-container-running', async (t) => {
    const w = appliedWorld(t);
    await w.monitor.reconcile();                      // the snapshot of before the Apply
    assert.deepEqual([containerOf(await request(w.f, { dependencies: w.deps() })).availability], ['starting'], 'the earlier snapshot only says the instance is starting');
    const response = await request(w.f, { method: 'POST', body: applyBody(w.f), dependencies: w.deps({ apply: async () => { w.applied(); return { ok: true, status: 200, results: [{ key: 'canonical', state: 'applied' }] }; } }) });
    assert.equal(response.status, 200); assert.equal(response.body.statusFresh, true); assert.equal(response.body.statusNote, undefined);
    // The very next read: the new container, running and ready, with its limits applied.
    const after = containerOf(await request(w.f, { dependencies: w.deps() }));
    assert.deepEqual({ availability: after.availability, limitsState: after.limitsState }, { availability: 'ready', limitsState: 'applied' });
});

test('S2.a-reconcile-already-in-flight-when-the-apply-ends-does-not-count-and-a-later-one-is-awaited', async (t) => {
    let release; const gate = { promise: new Promise((resolve) => { release = resolve; }) };
    const w = appliedWorld(t, { gate });
    await w.monitor.reconcile();                      // listing 1: the earlier container
    const inFlight = w.monitor.reconcile();           // listing 2: started before the Apply, holds the earlier list until released
    await new Promise((resolve) => setImmediate(resolve));
    const started = w.monitor.reconcileInFlight;
    assert.equal(started, true);
    const response = await request(w.f, { method: 'POST', body: applyBody(w.f), dependencies: w.deps({ apply: async () => { w.applied(); setTimeout(release, 5); return { ok: true, status: 200, results: [] }; } }) });
    await inFlight;
    assert.equal(response.body.statusFresh, true);
    assert.equal(w.engine.listings, 3, 'a reconcile that started after the Apply ran');
    assert.equal(containerOf(await request(w.f, { dependencies: w.deps() })).availability, 'ready');
});

test('S2.when-the-bound-expires-the-response-still-goes-out-and-says-the-status-may-lag', async (t) => {
    const w = appliedWorld(t, { boundMs: 30 });
    await w.monitor.reconcile();
    // The next engine listing never answers, so no fresh reconcile can complete inside the bound.
    w.monitor.collectContainers = () => new Promise(() => {});
    const response = await request(w.f, { method: 'POST', body: applyBody(w.f), dependencies: w.deps({ apply: async () => { w.applied(); return { ok: true, status: 200, results: [] }; } }) });
    assert.equal(response.status, 200); assert.equal(response.body.ok, true);
    assert.equal(response.body.statusFresh, false); assert.match(response.body.statusNote, /may lag this Apply/);
});

test('S2.a-failed-apply-does-not-wait-for-a-metrics-reconcile', async (t) => {
    const w = appliedWorld(t);
    let waits = 0;
    const response = await request(w.f, { method: 'POST', body: applyBody(w.f), dependencies: w.deps({ refreshMetrics: async () => { waits += 1; return { fresh: true }; }, apply: async () => ({ ok: false, status: 409, error: 'apply_failed' }) }) });
    assert.equal(response.status, 409); assert.equal(waits, 0); assert.equal(response.body.statusFresh, undefined);
});

// S4: freshness is judged by when the engine read STARTED. A listing begun before the Apply can publish after it.
test('S4.an-old-listing-published-after-the-apply-never-proves-the-new-container-stopped', async (t) => {
    let release; const gate = { promise: new Promise((resolve) => { release = resolve; }) };
    const f = fixture(t);
    const record = { ...f.registry.canonical, containerId: NEW_ID };
    const { observation, readApplied } = recreated(f, new Date(0).toISOString());
    const engine = { containers: [], calls: 0 };
    const newRunning = engineEntry({ containerId: NEW_ID, state: { status: 'running', running: true, pid: 7 } });
    const monitor = new Monitor({
        readRegistry: () => ({ canonical: record }), runtimeStateOptions: { activeGeneration: null, routes: { worker: { container: 'canonical', repo: 'demo', agent: 'worker', hostPort: 4100 } } },
        readHardwareContext: () => ({ gate: 'off' }), readRouting: () => ({ routes: {} }), containerStats: false,
        collectContainers: async () => { engine.calls += 1; const listing = engine.containers; if (engine.calls === 1) await gate.promise; return listing; },
    });
    const deps = (extra = {}) => ({ getRegistry: () => ({ canonical: record }), getMetrics: () => monitor.latest, readApplied, admit: placementAdmit, refreshMetrics: (since) => monitor.reconcileAfter(since, 30), ...extra });
    // 1. An engine listing starts BEFORE the Apply, sees no container, and is held.
    const held = monitor.reconcile();
    await new Promise((resolve) => setImmediate(resolve));
    // 2. The Apply creates the new running container; the bounded refresh cannot start a newer reconcile and expires.
    const response = await request(f, { method: 'POST', body: applyBody(f), dependencies: deps({ apply: async () => { engine.containers = [newRunning]; observation.observedAt = new Date().toISOString(); return { ok: true, status: 200, results: [] }; } }) });
    assert.equal(response.body.statusFresh, false);
    // 3. The old listing is released and publishes now, with a publication time later than the Apply.
    release(); await held;
    assert.ok(Date.parse(monitor.latest.sampledAt) >= Date.parse(observation.observedAt), 'it was published after the Apply');
    assert.ok(Date.parse(monitor.latest.readStartedAt) < Date.parse(observation.observedAt), 'but its read began before it');
    // The new container is running: the status must not call it stopped.
    const lagging = containerOf(await request(f, { dependencies: deps() }));
    assert.deepEqual({ availability: lagging.availability, limitsState: lagging.limitsState }, { availability: 'starting', limitsState: 'applied' });
    // (b) A reconcile that really started afterwards sees it running and ready.
    await monitor.reconcile();
    const fresh = containerOf(await request(f, { dependencies: deps() }));
    assert.deepEqual({ availability: fresh.availability, limitsState: fresh.limitsState }, { availability: 'ready', limitsState: 'applied' });
    // (c) A genuine stop of the CURRENT container, read after the Apply, still reads stopped.
    engine.containers = [engineEntry({ containerId: NEW_ID, state: { status: 'exited', running: false, pid: 0 } })];
    await monitor.reconcile();
    const stopped = containerOf(await request(f, { dependencies: deps() }));
    assert.deepEqual({ availability: stopped.availability, limitsState: stopped.limitsState }, { availability: 'stopped', limitsState: 'unavailable' });
    // (c2) The same with no container at all, in a read that started after the observation was written.
    observation.observedAt = new Date(Date.now() - 60_000).toISOString();
    engine.containers = [];
    await monitor.reconcile();
    const gone = containerOf(await request(f, { dependencies: deps() }));
    assert.deepEqual({ availability: gone.availability, limitsState: gone.limitsState }, { availability: 'stopped', limitsState: 'unavailable' });
});

// T1: the real collector and the real no-wait projection; only the marker IO is injected (as tests/unit/agentRuntimeState.test.mjs does).
const { collectAgentRuntimeStates } = await import('../../cli/sandbox/agentRuntimeState.js');
const { applyCurrentNoWaitReadiness } = await import('../../cli/utils/noWaitReadiness.js');
test('T1.the-no-wait-projection-never-masks-a-container-the-engine-does-not-run-as-starting', (t) => {
    const f = fixture(t);
    const registry = { canonical: { ...f.registry.canonical, containerId: NEW_ID, runtime: 'podman' } };
    const project = (liveContainers, observation) => {
        const [entry] = collectAgentRuntimeStates({ registry, liveContainers, routes: {} });
        return observation === null ? entry : applyCurrentNoWaitReadiness(entry, registry, { readMarker: () => ({}), createBinding: () => ({}), observeRun: () => ({ state: observation }) });
    };
    const live = { containerName: 'canonical', containerId: NEW_ID, agentName: 'worker', repoName: 'demo', state: { status: 'running', running: true, pid: 7 } };
    for (const observation of ['pending', 'starting']) {
        // The container exited: `ps` lists no running container, the collector yields its stopped entry, the projection says `starting`.
        const exited = project([], observation);
        assert.deepEqual([exited.state.status, exited.engineRunning], ['starting', false], observation);
        assert.deepEqual(((({ availability, limitsState }) => ({ availability, limitsState }))(statusOf(f, [exited], -60_000))), { availability: 'stopped', limitsState: 'unavailable' }, `exited, no-wait ${observation}`);
        // The container runs and no route is active yet: that is starting.
        const running = project([live], observation);
        assert.equal(running.engineRunning, true);
        assert.deepEqual(((({ availability, limitsState }) => ({ availability, limitsState }))(statusOf(f, [running], -60_000))), { availability: 'starting', limitsState: 'applied' }, `running, no-wait ${observation}`);
    }
    // Without a no-wait marker an exited container is plainly stopped.
    assert.deepEqual(statusOf(f, [project([], null)], -60_000).availability, 'stopped');
});
