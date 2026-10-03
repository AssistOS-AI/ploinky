// The exact registered runtime a hardware-limits reconcile replaces is handed to the service launch as its expected predecessor
// (cli/sandbox/hardwareLimits/reconcile.mjs), so a native sandbox slot is only ever stopped for that exact occupant. The reconcile
// runs with the product's real locks in a temporary workspace; the plan, the launch, readiness and activation are injected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-predecessor-')));
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
const { captureExactHardwareInstances, reconcileExactHardwareInstance } = await import('../../cli/sandbox/hardwareLimits/reconcile.mjs');
const { registeredRuntimeTuple } = await import('../../cli/sandbox/bwrap/bwrapFleet.js');

const token = { epoch: 'e'.repeat(32), revision: 1 };
const baseRecord = { type: 'agent', repoName: 'demo', agentName: 'worker', alias: '', instanceId: 'instance-1', enableGeneration: 'generation-1', containerId: 'a'.repeat(64) };
const planFor = runtime => ({ runtime, profileResolution: { resolvedProfileName: 'default' }, manifest: {}, agentPath: '/fixture', routerEndpoint: null, runtimeAdmission: { descriptor: { hardwareGpu: null } } });

async function reconcileWith(record, runtime) {
    const registry = { exact: record };
    const launches = [];
    await reconcileExactHardwareInstance(captureExactHardwareInstances(registry, ['exact'])[0], { origin: 'cli' }, {
        loadRegistry: () => registry, loadRouting: () => ({ routes: {} }), readPolicy: () => ({ token }), policyCheck: () => ({ token }), loadPlan: () => planFor(runtime),
        ensure: (agent, _manifest, _path, options) => { launches.push(options); return { containerName: 'exact', containerId: 'd'.repeat(64), registryRecord: record }; },
        readiness: async () => {}, activate: async () => {},
    });
    assert.equal(launches.length, 1, `${runtime}: one launch`);
    return launches[0];
}

test('R20.reconcile-passes-the-exact-registered-runtime-tuple-as-the-expected-predecessor', async () => {
    for (const runtime of ['bwrap', 'seatbelt', 'podman']) {
        const options = await reconcileWith({ ...baseRecord, runtime }, runtime);
        assert.deepEqual(options.expectedPredecessor, { instanceId: 'instance-1', enableGeneration: 'generation-1' }, runtime);
        assert.deepEqual(options.expectedPredecessor, registeredRuntimeTuple({ ...baseRecord, runtime }), runtime);
        assert.equal(options.forceRecreate, true);
        assert.equal(options.hardwareInstanceKey, 'exact');
    }
});

test('R20.reconcile-never-launches-with-a-tuple-the-record-does-not-name', async () => {
    // An incomplete identity is refused by the exact-instance capture before any launch.
    for (const record of [{ ...baseRecord, instanceId: '' }, { ...baseRecord, enableGeneration: undefined }]) {
        await assert.rejects(reconcileWith(record, 'bwrap'), error => error.code === 'identity_changed' && /incomplete/.test(error.message), JSON.stringify(record));
    }
    // An identity with surrounding whitespace is not an exact tuple: the launch gets no predecessor, never a trimmed guess.
    for (const record of [{ ...baseRecord, instanceId: ' instance-1' }, { ...baseRecord, enableGeneration: 'generation-1 ' }]) {
        const options = await reconcileWith(record, 'bwrap');
        assert.equal(options.expectedPredecessor, null, JSON.stringify(record));
    }
});
