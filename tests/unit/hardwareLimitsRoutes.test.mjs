import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { handleHardwareLimitsRoutes, buildHardwareLimitsState, hardwareHttpError } from '../../cli/server/authHandlers/hardwareLimitsRoutes.mjs';
import { hardwareStorePaths, initializeStore, readStoreSnapshot, beginDowngradeBarrier, setAgentLimits as setAgentLimitsForTest } from '../../cli/sandbox/hardwareLimits/store.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { mintAdminCsrfToken, verifyAdminMutationRequest } from '../../cli/server/adminControlSecurity.js';
import { captureExactHardwareInstances, assertExactHardwareInstance, applyHardwareLimits, assertHardwareApplyInputs, reconcileExactHardwareInstance, hardwareApplyIsUnchanged } from '../../cli/sandbox/hardwareLimits/reconcile.mjs';
import { runHardwareLimitsApplyWorker, hardwareApplyFlight } from '../../cli/server/hardwareLimitsApplyWorker.mjs';
import { withWorkspaceMutationLease, inspectWorkspaceStartLock } from '../../cli/utils/runtime/maintenanceLocks.js';
import { HardwareLimitsError, serializeHardwareAwareError } from '../../cli/sandbox/hardwareLimits/errors.mjs';
import { buildDirectRefusal } from '../../cli/sandbox/hardwareLimits/requestedLimits.mjs';

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
