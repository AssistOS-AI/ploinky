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
