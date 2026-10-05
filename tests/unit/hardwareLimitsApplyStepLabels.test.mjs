// The step an untyped Apply failure reports (applyCause.mjs), driven through the product's exact-instance reconcile and
// the MPS lifecycle: the MPS coordination has its own step, a check between two steps is not credited to the step that just
// finished, and the plan loads and the published-route preparation and activation are labelled. The reconcile runs with the
// product's real locks in a temporary workspace; the engine, readiness and the route publication are injected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-labels-')));
const priorRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const priorCwd = process.cwd();
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
process.chdir(workspace);
test.after(() => {
    process.chdir(priorCwd);
    if (priorRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = priorRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});
const { applyHardwareLimits, reconcileExactHardwareInstance, captureExactHardwareInstances } = await import('../../cli/sandbox/hardwareLimits/reconcile.mjs');
const { coordinateMpsLifecycle, ensureMpsGraphAgentService } = await import('../../cli/sandbox/hardwareLimits/mpsLifecycle.mjs');
const { readMpsLaunch } = await import('../../cli/sandbox/hardwareLimits/mpsLaunch.mjs');
const { HardwareStoreError } = await import('../../cli/sandbox/hardwareLimits/store.mjs');

const token = { epoch: 'e'.repeat(32), revision: 1 };
const share = { smPercent: 25, vramPercent: 17, vramMiB: 1024, memoryMiB: 1024, memoryBytes: 1024 ** 3, deviceUuid: 'GPU-fixture', driverVersion: '550.1', wiringFingerprint: 'wiring' };
const clone = value => structuredClone(value);
const record = { type: 'agent', repoName: 'demo', agentName: 'worker', alias: '', instanceId: 'instance-1', enableGeneration: 'generation-1', containerId: 'a'.repeat(64) };
const registry = { exact: record };
const gpuPlan = { runtime: 'podman', profileResolution: {}, manifest: {}, agentPath: '/fixture', routerEndpoint: null, runtimeAdmission: { descriptor: { hardwareGpu: share } } };
const cpuPlan = { ...gpuPlan, runtimeAdmission: { descriptor: { hardwareGpu: null } } };
const policyFailure = () => new HardwareStoreError('The policy store changed during Apply', { code: 'revision_conflict', status: 409 });

// One Apply of the exact instance through the real reconcile; `deps` replace the engine-side boundaries.
function apply({ plan = cpuPlan, options = {}, deps = {} } = {}) {
    return applyHardwareLimits({ expectedToken: token, containers: ['exact'] }, {
        lease: (_options, callback) => callback(), loadRegistry: () => registry, loadRouting: () => ({ routes: {} }), readPolicy: () => ({ token }), policyCheck: () => {},
        loadPlan: () => ({}), isUnchanged: () => false,
        reconcile: (instance, launch) => reconcileExactHardwareInstance(captureExactHardwareInstances(registry, [instance.key])[0], { ...launch, origin: 'cli', ...options }, {
            loadRegistry: () => registry, loadRouting: () => ({ routes: {} }), readPolicy: () => ({ token }), policyCheck: () => ({ token }), loadPlan: () => plan,
            ensure: () => ({ containerName: 'exact', containerId: 'd'.repeat(64), registryRecord: record }), readiness: async () => {}, activate: async () => {},
            ...deps,
        }),
    });
}

test('W7.a-failure-inside-the-mps-coordination-is-the-coordination-step-not-planning', async () => {
    // The routing authority changes inside the coordination's own check (the first check, the reconcile's, passed).
    let calls = 0;
    const result = await apply({ plan: gpuPlan, options: { authorize: () => calls++ < 1 } });
    assert.equal(result.status, 409, JSON.stringify(result));
    assert.equal(result.results[0].error, 'identity_changed');
    assert.equal(result.results[0].cause.step, 'mps-coordination', JSON.stringify(result.results[0]));
    assert.match(result.results[0].message, /^Apply stopped at mps-coordination: /);
    assert.notEqual(result.cause.step, 'planning');
});

test('W7.a-check-between-two-steps-is-not-credited-to-the-step-that-just-finished', async () => {
    for (const [label, arm, expected] of [
        ['after the plan, before the launch', 'plan', 'apply'],
        ['after readiness, before the verification', 'readiness', 'apply'],
    ]) {
        let armed = false;
        const deps = {
            loadPlan: () => { if (arm === 'plan') armed = true; return cpuPlan; },
            readiness: async () => { if (arm === 'readiness') armed = true; },
            policyCheck: () => { if (armed) throw policyFailure(); return { token }; },
        };
        const result = await apply({ deps });
        assert.equal(result.results[0].error, 'revision_conflict', label);
        assert.equal(result.results[0].cause.step, expected, `${label}: ${JSON.stringify(result.results[0].cause)}`);
    }
    // The steps themselves are still named.
    for (const [label, deps, step] of [
        ['the launch', { ensure: () => { throw new TypeError('create failed'); } }, 'runtime-launch'],
        ['readiness', { readiness: async () => { throw new Error('Readiness deadline expired.'); } }, 'readiness'],
        ['the plan', { loadPlan: () => { throw new Error('manifest unreadable'); } }, 'planning'],
    ]) assert.equal((await apply({ deps })).results[0].cause.step, step, label);
});

test('W8.prepare-and-commit-on-a-published-route-report-restart-preparation-and-activation', async () => {
    const routing = { routes: { worker: { container: 'exact' } } };
    const published = { loadRouting: () => routing };
    const prepared = { identity: { instanceId: 'next', enableGeneration: 'next' }, targetedRestart: {} };
    const prepareFails = await apply({ deps: { ...published, prepare: async () => { throw new Error('drain refused by the engine'); } } });
    assert.equal(prepareFails.results[0].cause.step, 'restart-preparation', JSON.stringify(prepareFails.results[0]));
    const commitFails = await apply({ deps: { ...published, prepare: async () => prepared, commit: async () => { throw new Error('route publication failed'); }, cleanupTargeted: () => {} } });
    assert.equal(commitFails.results[0].cause.step, 'activation', JSON.stringify(commitFails.results[0]));
    // The same flow with both steps working reaches readiness first: the order is prepare, launch, readiness, commit.
    const order = [];
    await apply({ deps: { ...published, prepare: async () => { order.push('prepare'); return prepared; }, ensure: () => { order.push('ensure'); return { containerName: 'exact', containerId: 'd'.repeat(64), registryRecord: record }; },
        readiness: async () => { order.push('readiness'); }, commit: async () => { order.push('commit'); } } });
    assert.deepEqual(order, ['prepare', 'ensure', 'readiness', 'commit']);
});

// The MPS lifecycle's own plan loads, through the real coordination and the real graph launch.
const coordinationWorld = ({ loadPlan, oldClients = [] } = {}) => {
    const target = { type: 'agent', repoName: 'demo', agentName: 'a', instanceId: 'i-a', enableGeneration: 'g-a', containerId: 'b'.repeat(64) };
    const peer = { type: 'agent', repoName: 'demo', agentName: 'c', instanceId: 'i-c', enableGeneration: 'g-c', containerId: 'c'.repeat(64) };
    const reg = { a: target, c: peer };
    const defaults = { smPercent: 25, memoryMiB: 1024, deviceUuid: share.deviceUuid, driverVersion: share.driverVersion, wiringFingerprint: share.wiringFingerprint };
    let state = oldClients.length ? { schema: 1, status: 'ready', daemon: { pid: 1 }, daemonGeneration: 'd0', configurationGeneration: 'c0', pipeDirectory: `/run/ploinky/mps/pipe-${'a'.repeat(32)}`, serverDefault: defaults, pendingClients: [], oldClients, drainedClients: [] } : null;
    const dependencies = {
        observeClients: () => [], readContext: () => ({ storeToken: token, overrides: new Map([['demo/a', { gpu: { ...share, smPercent: 50 } }]]), gpu: { eligible: true, grant: { mps: {} } } }),
        loadRegistry: () => reg, readApplied: () => null, loadPlan, prepareImage: () => {}, inspectImage: () => ({ Id: 'a'.repeat(64), Config: { User: '1000:1000' } }),
        resolveShare: policy => policy, policyCheck: () => {}, store: { read: () => clone(state), write: value => { state = clone(value); } },
        backend: { observe: () => ({ state: state?.daemon ? 'owned' : 'gone', daemon: state?.daemon }), verify: () => true, stop() {}, cleanup() {}, start: () => ({ ...state, status: 'ready' }) },
        network: async fn => fn({}), assertCapability: () => {},
    };
    const run = () => applyHardwareLimits({ expectedToken: token, containers: ['a'] }, {
        lease: (_options, callback) => callback(), loadRegistry: () => clone(reg), loadRouting: () => ({ routes: {} }), readPolicy: () => ({ token }), policyCheck: () => {}, loadPlan: () => ({}), isUnchanged: () => false,
        reconcile: (instance, options) => coordinateMpsLifecycle({ target: { key: instance.key, record: clone(reg[instance.key]) }, options: { onMpsPlan: options.onMpsPlan, onMpsResult: options.onMpsResult },
            launchTarget: async next => { readMpsLaunch(next.mpsLaunch, 'a', { ...share, smPercent: 50 }); return { containerName: 'a', containerId: 'e'.repeat(64) }; } }, dependencies),
    });
    return { run };
};

test('W8.a-plan-failure-of-the-target-through-the-coordination-is-planning', async () => {
    const world = coordinationWorld({ loadPlan: () => { throw new Error('manifest of the target is unreadable'); } });
    const result = await world.run();
    assert.equal(result.error, 'apply_failed'); assert.equal(result.results[0].cause.step, 'planning', JSON.stringify(result.results[0]));
    assert.match(result.results[0].cause.message, /manifest of the target is unreadable/);
});

test('W8.a-plan-failure-of-a-client-being-drained-is-the-drain-step', async () => {
    // A journaled share client of another agent that the cohort drains; its plan cannot be loaded (its manifest is gone).
    const peerClient = { key: 'c', ref: 'demo/c', alias: '', instanceId: 'i-c', enableGeneration: 'g-c', containerId: 'c'.repeat(64), share, mpsGeneration: 'd0:c0' };
    const world = coordinationWorld({ oldClients: [peerClient], loadPlan: ref => { if (ref === 'demo/c') throw new Error('manifest of the peer is unreadable'); return { runtime: 'podman', manifest: {}, profile: { network: { mode: 'default' } }, image: 'prepared:tag' }; } });
    const result = await world.run();
    const entry = result.results.find(value => value.cause || value.error === 'apply_failed') ?? result.results[0];
    assert.equal(entry.cause?.step, 'drain', JSON.stringify(result));
    assert.match(entry.cause.message, /manifest of the peer is unreadable/);
});

test('W8.a-plan-failure-in-the-graph-launch-is-planning', async () => {
    const options = { networkLifecycleCapability: {}, preparedRegistryRecord: record, hardwareInstanceKey: 'exact' };
    await assert.rejects(ensureMpsGraphAgentService('worker', {}, '/ws/.ploinky/repos/demo/worker', options, {
        assertCapability: () => {}, readContext: () => ({ storeToken: token, overrides: new Map([['demo/worker', { gpu: share }]]), gpu: { eligible: true } }), policyCheck: () => {},
        resolveShare: policy => policy, loadPlan: () => { throw new Error('graph plan unreadable'); },
    }), error => error.applyStep === 'planning' && /graph plan unreadable/.test(error.message));
});
