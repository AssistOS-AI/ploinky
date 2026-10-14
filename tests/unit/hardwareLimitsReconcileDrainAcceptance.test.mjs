// An operator's acceptance of one refused targeted drain reaches the targeted
// preparation only through the CLI restart of that exact instance
// (cli/sandbox/hardwareLimits/reconcile.mjs). Hardware Apply, the GPU/MPS
// cohort and runtimes without a targeted drain refuse it before any launch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-drain-acceptance-')));
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
const { TARGETED_DRAIN_ACKNOWLEDGEMENT } = await import('../../cli/sandbox/docker/targetedContainerLifecycle.js');

const token = { epoch: 'e'.repeat(32), revision: 1 };
const PREDECESSOR_ID = 'a'.repeat(64);
const record = { type: 'agent', repoName: 'demo', agentName: 'worker', alias: '', runtime: 'podman', instanceId: 'instance-1', enableGeneration: 'generation-1', containerId: PREDECESSOR_ID };
const accepted = Object.freeze({ containerId: PREDECESSOR_ID });

function planFor({ runtime = 'podman', hardwareGpu = null } = {}) {
    return { runtime, profileResolution: { resolvedProfileName: 'default' }, manifest: {}, agentPath: '/fixture', routerEndpoint: null, runtimeAdmission: { descriptor: { hardwareGpu } } };
}

async function reconcileWith({ origin = 'cli', acceptedFailedDrain = accepted, plan = planFor(), routes = { worker: { container: 'exact', repo: 'demo', agent: 'worker', draining: true } } } = {}) {
    const registry = { exact: record };
    const calls = { prepare: [], ensure: [], commit: 0 };
    const run = reconcileExactHardwareInstance(captureExactHardwareInstances(registry, ['exact'])[0], { origin, acceptedFailedDrain }, {
        loadRegistry: () => registry, loadRouting: () => ({ routes }), readPolicy: () => ({ token }), policyCheck: () => ({ token }), loadPlan: () => plan,
        prepare: async (input) => {
            calls.prepare.push(input);
            return {
                identity: { instanceId: record.instanceId, enableGeneration: record.enableGeneration },
                targetedRestart: {
                    acknowledgement: TARGETED_DRAIN_ACKNOWLEDGEMENT,
                    affectedSelectors: ['agent-root:worker'],
                    assertSelectorsInactive: () => true,
                    ...(input.acceptedFailedDrain ? { acceptedFailedDrain: input.acceptedFailedDrain } : {}),
                },
            };
        },
        ensure: (_agent, _manifest, _path, options) => {
            calls.ensure.push(options);
            return { containerName: 'exact', containerId: 'd'.repeat(64), registryRecord: { ...record, containerId: 'd'.repeat(64) } };
        },
        readiness: async () => {},
        commit: async () => { calls.commit += 1; },
        activate: async () => assert.fail('a targeted restart publishes through its own commit'),
    });
    return { run, calls };
}

test('the CLI restart hands the accepted predecessor to the targeted preparation and its drain', async () => {
    const { run, calls } = await reconcileWith();
    await run;
    assert.equal(calls.prepare.length, 1);
    assert.deepEqual(calls.prepare[0].acceptedFailedDrain, accepted);
    assert.equal(calls.ensure.length, 1);
    assert.deepEqual(calls.ensure[0].targetedRestart.acceptedFailedDrain, accepted);
    assert.equal(calls.commit, 1);
});

test('an ordinary CLI restart carries no acceptance', async () => {
    const { run, calls } = await reconcileWith({ acceptedFailedDrain: null });
    await run;
    assert.equal(Object.hasOwn(calls.prepare[0], 'acceptedFailedDrain'), false);
    assert.equal(Object.hasOwn(calls.ensure[0].targetedRestart, 'acceptedFailedDrain'), false);
});

test('hardware Apply can never accept a refused targeted drain', async () => {
    const { run, calls } = await reconcileWith({ origin: 'apply' });
    await assert.rejects(run, { code: 'TARGETED_DRAIN_ACCEPTANCE_REFUSED' });
    assert.deepEqual(calls, { prepare: [], ensure: [], commit: 0 });
});

test('a GPU/MPS client, a sandbox runtime or an unrouted instance refuses the acceptance before any launch', async () => {
    for (const scenario of [
        { plan: planFor({ hardwareGpu: { share: 'mps' } }) },
        { plan: planFor({ runtime: 'bwrap' }) },
        { routes: {} },
        { routes: { worker: { container: 'exact', repo: 'demo', agent: 'worker', hardwareAvailability: { state: 'unavailable' } } } },
    ]) {
        const { run, calls } = await reconcileWith(scenario);
        await assert.rejects(run, { code: 'TARGETED_DRAIN_ACCEPTANCE_REFUSED' }, JSON.stringify(scenario));
        assert.deepEqual(calls, { prepare: [], ensure: [], commit: 0 }, JSON.stringify(scenario));
    }
});

test('an acceptance must name the full immutable predecessor container ID', async () => {
    const { run, calls } = await reconcileWith({ acceptedFailedDrain: { containerId: PREDECESSOR_ID.slice(0, 12) } });
    await assert.rejects(run, { code: 'TARGETED_DRAIN_INVALID' });
    assert.deepEqual(calls, { prepare: [], ensure: [], commit: 0 });
});
