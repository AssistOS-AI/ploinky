// A targeted restart that fails after its successor is ready keeps that
// successor when the restart still owns the route and registry identity
// (cli/sandbox/hardwareLimits/reconcile.mjs): the predecessor is already gone,
// so removing the successor would leave the agent with no runtime. Ownership is
// read from the current routing and registry, never from the error text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'targeted-restart-preservation-')));
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
const SUCCESSOR_ID = 'd'.repeat(64);
const SUCCESSOR_PORT = 41012;
const record = { type: 'agent', repoName: 'demo', agentName: 'worker', alias: '', runtime: 'podman', instanceId: 'instance-1', enableGeneration: 'generation-1', containerId: PREDECESSOR_ID };
const plan = { runtime: 'podman', profileResolution: { resolvedProfileName: 'default' }, manifest: {}, agentPath: '/fixture', routerEndpoint: null, runtimeAdmission: { descriptor: { hardwareGpu: null } } };

// One targeted CLI restart of `exact` through the real reconcile. Routing and
// registry are live objects that the injected steps may change; `deps`
// replace the engine-side steps.
function restart({ deps = {}, options = {} } = {}) {
    const state = {
        registry: { exact: structuredClone(record) },
        routing: { routes: { worker: { container: 'exact', repo: 'demo', agent: 'worker', draining: true } } },
    };
    const calls = { cleanupTargeted: 0, cleanupPrepared: 0, commit: 0 };
    const run = reconcileExactHardwareInstance(captureExactHardwareInstances(state.registry, ['exact'])[0], { origin: 'cli', ...options }, {
        loadRegistry: () => state.registry, loadRouting: () => state.routing, readPolicy: () => ({ token }), policyCheck: () => ({ token }), loadPlan: () => plan,
        prepare: async () => ({
            containerName: 'exact',
            routeKey: 'worker',
            repoName: 'demo',
            shortAgentName: 'worker',
            identity: { instanceId: record.instanceId, enableGeneration: record.enableGeneration },
            targetedRestart: { acknowledgement: TARGETED_DRAIN_ACKNOWLEDGEMENT, affectedSelectors: ['agent-root:worker'], assertSelectorsInactive: () => true },
        }),
        ensure: () => ({
            containerName: 'exact', containerId: SUCCESSOR_ID, hostPort: SUCCESSOR_PORT,
            registryRecord: { ...record, containerId: SUCCESSOR_ID }, cleanupReceipt: { state: 'retryable-exact-id' }, createdByThisLaunch: true,
        }),
        readiness: async () => {},
        commit: async () => { calls.commit += 1; },
        activate: async () => assert.fail('a targeted restart publishes through its own commit'),
        cleanupTargeted: () => { calls.cleanupTargeted += 1; },
        cleanupPrepared: () => { calls.cleanupPrepared += 1; },
        ...(typeof deps === 'function' ? deps(state, calls) : deps),
    });
    return { run, calls, state };
}

async function failure(run) {
    let caught = null;
    await assert.rejects(run, (error) => { caught = error; return true; });
    return caught;
}

function edgeError(message, code) {
    return Object.assign(new Error(message), { code });
}

// The commit publishes the successor into the mutable sources the way the
// reopen does: registry record and an open route at the successor's port.
function publish(state, { hostPort = SUCCESSOR_PORT } = {}) {
    state.registry.exact = { ...state.registry.exact, containerId: SUCCESSOR_ID };
    state.routing.routes.worker = { container: 'exact', repo: 'demo', agent: 'worker', hostPort };
}

test('a publication failure after readiness keeps the ready successor', async () => {
    const { run, calls } = restart({ deps: { commit: async () => { throw edgeError('edge generation apply is already in progress', 'EDGE_GENERATION_BUSY'); } } });
    const error = await failure(run);
    assert.equal(error.code, 'EDGE_GENERATION_BUSY');
    assert.equal(calls.cleanupTargeted, 0);
    assert.equal(error.preservedTargetedSuccessor.containerId, SUCCESSOR_ID);
    assert.equal(error.preservedTargetedSuccessor.containerName, 'exact');
    assert.equal(error.preservedTargetedSuccessor.published, false);
    assert.equal(Object.keys(error).includes('preservedTargetedSuccessor'), false, 'the annotation is not enumerable');
    assert.match(error.message, /ready successor dddddddddddd was kept running with its route withdrawn; rerun ploinky restart worker to replace it/);
    assert.equal(error.applyStep, 'activation');
});

test('a failure inside commit after publication keeps the published successor', async () => {
    const { run, calls } = restart({ deps: (state) => ({
        commit: async () => {
            publish(state);
            throw new Error('targeted agent restart successor was not published exactly');
        },
    }) });
    const error = await failure(run);
    assert.equal(calls.cleanupTargeted, 0);
    assert.equal(error.preservedTargetedSuccessor.published, true);
    assert.match(error.message, /ready successor dddddddddddd was kept running and is published/);

    // The same failure before anything was published keeps the successor
    // with its route withdrawn.
    const control = restart({ deps: { commit: async () => { throw new Error('targeted agent restart successor was not published exactly'); } } });
    const controlError = await failure(control.run);
    assert.equal(control.calls.cleanupTargeted, 0);
    assert.equal(controlError.preservedTargetedSuccessor.published, false);
    assert.match(controlError.message, /with its route withdrawn/);

    // An open route at another port, or a registry naming another container,
    // is not this publication.
    for (const [label, change] of [
        ['another port', (state) => publish(state, { hostPort: 49999 })],
        ['another registered container', (state) => { publish(state); state.registry.exact.containerId = 'f'.repeat(64); }],
    ]) {
        const partial = restart({ deps: (state) => ({ commit: async () => { change(state); throw new Error('publication failed'); } }) });
        const partialError = await failure(partial.run);
        assert.equal(partial.calls.cleanupTargeted, 0, label);
        assert.equal(partialError.preservedTargetedSuccessor.published, false, label);
    }
});

test('ownership lost (route owner changed by another writer) removes the successor', async () => {
    for (const [label, change] of [
        ['route owner', (state) => { state.routing.routes.worker.container = 'other-container'; }],
        ['route removed', (state) => { delete state.routing.routes.worker; }],
        ['registry identity', (state) => { state.registry.exact = { ...state.registry.exact, instanceId: 'other-instance' }; }],
        ['registry record removed', (state) => { delete state.registry.exact; }],
    ]) {
        const { run, calls } = restart({ deps: (state) => ({ commit: async () => { change(state); throw new Error('targeted agent restart route changed before successor commit'); } }) });
        const error = await failure(run);
        assert.equal(calls.cleanupTargeted, 1, label);
        assert.equal(error.preservedTargetedSuccessor, undefined, label);
        assert.doesNotMatch(error.message, /kept running/, label);
    }
});

test('ownership loss during activation removes the successor', async () => {
    for (const code of ['TARGETED_RESTART_OWNERSHIP_LOST', 'TARGETED_RESTART_SUPERSEDED']) {
        const { run, calls } = restart({ deps: { commit: async () => { throw edgeError('targeted agent restart refused', code); } } });
        const error = await failure(run);
        assert.equal(error.code, code);
        assert.equal(calls.cleanupTargeted, 1, code);
        assert.equal(error.preservedTargetedSuccessor, undefined, code);
    }
});

test('an unreadable routing or registry during the failure counts as lost ownership', async () => {
    for (const source of ['loadRouting', 'loadRegistry']) {
        const { run, calls } = restart({ deps: (state) => {
            let failing = false;
            const readers = { loadRouting: () => state.routing, loadRegistry: () => state.registry };
            const reader = readers[source];
            return {
                [source]: () => { if (failing) throw new Error(`${source} unreadable`); return reader(); },
                commit: async () => { failing = true; throw edgeError('edge generation apply is already in progress', 'EDGE_GENERATION_BUSY'); },
            };
        } });
        await failure(run);
        assert.equal(calls.cleanupTargeted, 1, source);
    }
});

test('a readiness failure still removes the not-ready successor', async () => {
    const { run, calls } = restart({ deps: { readiness: async () => { throw new Error('Readiness deadline expired.'); } } });
    const error = await failure(run);
    assert.equal(calls.cleanupTargeted, 1);
    assert.equal(calls.commit, 0);
    assert.equal(error.preservedTargetedSuccessor, undefined);
});

test('a hardware policy refusal after readiness still removes the successor', async () => {
    let ready = false;
    const { run, calls } = restart({ deps: {
        readiness: async () => { ready = true; },
        policyCheck: () => { if (ready) throw Object.assign(new Error('The policy store changed during Apply'), { code: 'revision_conflict' }); return { token }; },
    } });
    const error = await failure(run);
    assert.equal(error.code, 'revision_conflict');
    assert.equal(calls.cleanupTargeted, 1);
    assert.equal(calls.commit, 0);
});

test('a GPU/MPS launch keeps its cleanup when publication fails', async () => {
    const { run, calls } = restart({
        options: { mpsLaunch: Object.freeze({ fixture: 'mps' }) },
        deps: (_state, calls) => ({
            commit: async () => {
                calls.commit += 1;
                throw edgeError('edge generation apply is already in progress', 'EDGE_GENERATION_BUSY');
            },
        }),
    });
    const error = await failure(run);
    // The failure is the publication itself, not an earlier step.
    assert.equal(calls.commit, 1);
    assert.equal(error.applyStep, 'activation');
    assert.equal(error.code, 'EDGE_GENERATION_BUSY');
    assert.equal(calls.cleanupTargeted, 1);
    assert.equal(error.preservedTargetedSuccessor, undefined);
});

test('a frozen error keeps the successor without an annotation', async () => {
    const frozen = Object.freeze(edgeError('edge generation apply is already in progress', 'EDGE_GENERATION_BUSY'));
    const { run, calls } = restart({ deps: { commit: async () => { throw frozen; } } });
    const error = await failure(run);
    assert.equal(error, frozen);
    assert.equal(calls.cleanupTargeted, 0);
    assert.equal(error.message, 'edge generation apply is already in progress');
});
