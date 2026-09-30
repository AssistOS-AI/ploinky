// A Watchdog replacement of a no-wait agent retires the current-run marker of
// the tuple it replaces. The replacement must then be bound to the same
// deployment run under its own tuple, or every run-bound observer (the start
// harness, `ploinky status`, a deployment checker that requires one run) sees a
// live agent with no current binding forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-no-wait-rebind-')));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const {
    createContainerMonitor,
    performContainerRestart,
    readNoWaitStatus,
    stopContainerMonitor,
    syncManagedContainers,
} = await import('../../cli/server/containerMonitor.js');
const { coordinateReplacementRuntimeIdentity } = await import('../../cli/sandbox/docker/agentServiceManager.js');
const { RUNNING_DIR } = await import('../../cli/utils/config.js');
const {
    createNoWaitRunBinding,
    observeBoundNoWaitRun,
    readNoWaitRunMarker,
} = await import('../../cli/commands/noWaitLogObserver.js');
const { exactNoWaitImmutableIdentity } = await import('../../cli/commands/noWaitWorkerArgs.js');
const {
    publishNoWaitRunMarker,
    retireNoWaitRunMarker,
    retireNoWaitRunMarkers,
} = await import('../../cli/commands/noWaitMarkerLifecycle.js');
const { applyCurrentNoWaitReadiness } = await import('../../cli/utils/noWaitReadiness.js');
const { disableAgentContainers } = await import('../../cli/utils/agents.js');

const NO_WAIT_DIR = path.join(RUNNING_DIR, 'no-wait');
const RUN_FIELDS = ['runId', 'runStartedAtMs', 'waveIndex'];

test.after(() => {
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePrivateJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(file), 0o700);
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function newRun() {
    return Object.freeze({ runId: randomUUID(), runStartedAtMs: Date.now() - 60_000 });
}

function identityFor(containerName, record, run, waveIndex) {
    const alias = record.alias || '';
    return exactNoWaitImmutableIdentity({
        containerName,
        instanceId: record.instanceId,
        enableGeneration: record.enableGeneration,
        repoName: record.repoName,
        shortAgent: record.agentName,
        alias,
        routeKey: alias || record.agentName,
        runId: run.runId,
        runStartedAtMs: run.runStartedAtMs,
        waveIndex,
        statusFile: `${containerName}.${run.runId}.json`,
    });
}

// The exact files a no-wait worker leaves after a terminal `running`.
function seedRunningRun(containerName, record, run, { waveIndex = 1, pid = 424242 } = {}) {
    const identity = identityFor(containerName, record, run, waveIndex);
    const finishedAtMs = run.runStartedAtMs + 30_000;
    const status = {
        containerName,
        shortAgent: record.agentName,
        repoName: record.repoName,
        alias: identity.alias,
        routeKey: identity.routeKey,
        pid,
        startedAt: new Date(run.runStartedAtMs).toISOString(),
        startedAtMs: run.runStartedAtMs,
        sequencePhase: 'active',
        sequencePhaseStartedAt: new Date(run.runStartedAtMs).toISOString(),
        sequencePhaseStartedAtMs: run.runStartedAtMs,
        state: 'running',
        finishedAt: new Date(finishedAtMs).toISOString(),
        finishedAtMs,
        container: containerName,
        hostPort: 7000,
        ...identity,
    };
    writePrivateJson(path.join(NO_WAIT_DIR, `${containerName}.json`), status);
    writePrivateJson(path.join(NO_WAIT_DIR, identity.statusFile), status);
    writePrivateJson(path.join(NO_WAIT_DIR, `${containerName}.current.json`), {
        createdAt: new Date(run.runStartedAtMs).toISOString(),
        ...identity,
    });
    return identity;
}

// A second no-wait agent of the same deployment run, outside the Watchdog.
function seedSibling(run) {
    const record = {
        type: 'agent', repoName: 'demo', agentName: 'sibling',
        instanceId: 'sibling-instance', enableGeneration: 'sibling-generation',
    };
    return seedRunningRun('sibling_runtime', record, run, { waveIndex: 0 });
}

function currentMarkers() {
    return fs.readdirSync(NO_WAIT_DIR).filter((name) => name.endsWith('.current.json')).sort();
}

// The invariants the deployment no-wait checker enforces: exactly the expected
// number of current markers, all from one run and one run start, each bound to
// a terminal `running` run-scoped status of the same identity.
function assertOneDeploymentRun(expectedCount) {
    const markers = currentMarkers().map((name) => readJson(path.join(NO_WAIT_DIR, name)));
    assert.equal(markers.length, expectedCount);
    assert.equal(new Set(markers.map((marker) => marker.runId)).size, 1, 'one deployment run');
    assert.equal(new Set(markers.map((marker) => marker.runStartedAtMs)).size, 1, 'one run start');
    for (const marker of markers) {
        const status = readJson(path.join(NO_WAIT_DIR, marker.statusFile));
        assert.equal(status.state, 'running');
        for (const field of ['containerName', 'instanceId', 'enableGeneration', ...RUN_FIELDS]) {
            assert.equal(status[field], marker[field], field);
        }
    }
}

function observeLikeHarness(name, registry) {
    const marker = readNoWaitRunMarker(name, { runningDir: RUNNING_DIR });
    const binding = createNoWaitRunBinding(name, registry[name], marker);
    return observeBoundNoWaitRun(binding, {
        runningDir: RUNNING_DIR,
        readRegistrySnapshot: () => registry,
    });
}

function projected(name, registry) {
    return applyCurrentNoWaitReadiness({
        containerName: name,
        state: { status: 'running', running: true },
    }, registry, { runningDir: RUNNING_DIR });
}

function staleWorker() {
    const error = new Error('worker process is not running');
    error.code = 'PROCESS_IDENTITY_STALE';
    throw error;
}

let fixtureCount = 0;

function fixture(t, { additive = false, distinct = false, readinessOk = true } = {}) {
    fs.rmSync(NO_WAIT_DIR, { recursive: true, force: true });
    const agentName = 'rebind' + (++fixtureCount);
    const originalName = agentName + '_runtime';
    const agentDir = path.join(workspace, '.ploinky', 'repos', 'demo', agentName);
    const manifestPath = path.join(agentDir, 'manifest.json');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
        container: 'node:20-alpine',
        start: 'sleep infinity',
        network: { mode: distinct ? 'default' : 'none' },
        health: { readiness: { script: 'ready.sh' } },
    }));
    const originalRecord = {
        type: 'agent', runtime: 'container', repoName: 'demo', agentName,
        instanceId: agentName + '-original-instance',
        enableGeneration: agentName + '-original-enable',
        containerId: agentName + '-original-id',
    };
    const state = {
        registry: { [originalName]: structuredClone(originalRecord) },
        routing: { routes: { [agentName]: { container: originalName, repo: 'demo', agent: agentName } } },
        selector: { state: additive ? 'active' : 'inactive' },
        physical: new Map([[originalName, structuredClone(originalRecord)]]),
        events: [], attempts: 0, result: null,
        readinessOk,
        afterSelectorCommit: null,
    };
    const capability = Object.freeze({ fixture: agentName });
    const monitor = createContainerMonitor({
        config: { MAX_RESTARTS_IN_WINDOW: 3 },
        terminalLedgerFile: path.join(workspace, agentName + '-terminal.json'),
        log: (level, event, data) => state.events.push({ level, event, data }),
    });
    t.after(() => stopContainerMonitor(monitor));
    monitor.loadAgents = () => structuredClone(state.registry);
    monitor.readRoutingConfig = () => structuredClone(state.routing);
    monitor.readEdgeRoutingSelection = () => structuredClone({ selector: state.selector });
    monitor.createWorkspaceMutationLease = () => Object.freeze({ fixture: 'workspace' });
    monitor.releaseWorkspaceMutationLease = () => {};
    monitor.withNetworkLifecycleLock = async (callback) => callback(capability);
    monitor.resolveRouterEndpoint = () => distinct
        ? { mode: 'default', host: '127.0.0.1', port: 8080, url: 'http://127.0.0.1:8080' }
        : null;
    monitor.proveNoWaitWorkerProcess = staleWorker;
    monitor.noWaitWorkerExitWaitMs = 30;
    monitor.ensureAgentService = (_agent, _manifest, _dir, options) => {
        const predecessorName = options.containerName;
        const predecessorRecord = structuredClone(state.registry[predecessorName]);
        state.attempts += 1;
        const identities = [agentName + '-instance-' + state.attempts, agentName + '-enable-' + state.attempts];
        // The real coordinator: it retires the predecessor marker exactly as
        // production does on the non-staged branch.
        const identity = coordinateReplacementRuntimeIdentity({
            containerName: predecessorName,
            existingRecord: predecessorRecord,
            stageAlongsidePredecessor: distinct,
            preserveActiveAuthorization: options.preserveActiveAuthorization,
            networkLifecycleCapability: capability,
            runtimeNetwork: { mode: distinct ? 'default' : 'none' },
            predecessorContainerId: predecessorRecord.containerId,
        }, {
            assertNetworkCapability: (received) => assert.equal(received, capability),
            withApplyLock: (callback) => callback(Object.freeze({ fixture: 'apply' })),
            inactivate: () => { state.selector.state = 'inactive'; },
            loadRegistry: () => structuredClone(state.registry),
            loadRouting: () => structuredClone(state.routing),
            saveRegistry: (next) => { state.registry = structuredClone(next); },
            saveRouting: (next) => { state.routing = structuredClone(next); },
            prepare: ({ agents }) => ({
                selector: state.selector,
                preparationLease: Object.freeze({ mode: 'additive', transactionId: agentName + '-' + state.attempts }),
                generation: { agents: structuredClone(agents) },
            }),
            prepareReplacement: () => ({
                selector: state.selector,
                preparationLease: Object.freeze({ mode: 'replacement', transactionId: agentName + '-' + state.attempts }),
                generation: { agents: structuredClone(state.registry) },
            }),
            uuid: () => identities.shift(),
        });
        const candidateName = identity.candidateContainerName;
        const registryRecord = {
            ...identity.preparedRegistryRecord,
            containerId: agentName + '-candidate-id-' + state.attempts,
        };
        state.result = {
            containerName: candidateName,
            containerId: registryRecord.containerId,
            runtimeNetwork: { mode: distinct ? 'default' : 'none' },
            hostPort: 7000,
            registryRecord,
            stagedRegistryRecord: identity.preparedRegistryRecord,
            requiresEdgeActivation: true,
            preparationLease: identity.preparationLease,
            cleanupReceipt: Object.freeze({ fixture: agentName + '-cleanup-' + state.attempts }),
            ...(distinct ? { replacementPredecessor: {
                containerName: predecessorName,
                containerId: predecessorRecord.containerId,
                registryRecord: predecessorRecord,
                runtimeNetwork: { mode: 'default' },
            } } : {}),
        };
        state.physical.set(candidateName, structuredClone(registryRecord));
        return state.result;
    };
    monitor.runContainerScriptReadiness = async () => (state.readinessOk
        ? { status: 'success' }
        : { status: 'failed', reason: 'exit 1', detail: 'not ready' });
    monitor.abortEdgeRoutingPreparation = () => {};
    monitor.cleanupExactAgentRuntimeCandidate = async (candidate) => {
        state.physical.delete(candidate.containerName);
    };
    monitor.retireExactAgentRuntimePredecessor = (predecessor) => {
        state.physical.delete(predecessor.containerName);
    };
    monitor.listRunningContainerNames = () => [...state.physical.keys()];
    monitor.startProbeWorker = () => {};
    monitor.withEdgeGenerationApplyLock = (callback) => callback(capability);
    monitor.saveAgents = (next) => { state.registry = structuredClone(next); };
    monitor.mergeRoutingConfig = async (mutator) => { state.routing = await mutator(structuredClone(state.routing)); };
    monitor.applyEdgeRoutingGeneration = (options) => {
        options.testHooks.beforeSelectorCommit();
        state.selector.state = 'active';
        if (state.afterSelectorCommit) state.afterSelectorCommit();
    };
    monitor.commitAdditiveEdgeRoutingGeneration = (_lease, options) => {
        state.registry = structuredClone(options.agents);
        state.routing = structuredClone(options.routing);
        if (state.afterSelectorCommit) state.afterSelectorCommit();
    };
    syncManagedContainers(monitor);
    const target = monitor.targets.get(originalName);
    assert.ok(target);
    return { state, monitor, target, originalName, originalRecord };
}

function attemptFor(target) {
    target.isRestarting = true;
    target.attemptEpoch += 1;
    return Object.freeze({
        target, epoch: target.attemptEpoch,
        digest: target.restartInputDigest, snapshot: target.restartSnapshot,
    });
}

function eventNames(state) {
    return state.events.map((entry) => entry.event);
}

for (const [label, options] of [
    ['same-name', { distinct: false }],
    ['distinct non-staged', { distinct: true, additive: false }],
    ['staged (additive)', { distinct: true, additive: true }],
]) {
    test(`${label} Watchdog replacement rebinds the no-wait run to the new tuple within the same run`, async (t) => {
        const { state, monitor, target, originalName, originalRecord } = fixture(t, options);
        const run = newRun();
        seedSibling(run);
        const predecessor = seedRunningRun(originalName, originalRecord, run, { waveIndex: 1 });

        await performContainerRestart(monitor, target, 'not_running', attemptFor(target));

        const name = state.result.containerName;
        const record = state.registry[name];
        assert.ok(record, 'the replacement is registered');
        assert.notEqual(record.instanceId, originalRecord.instanceId);
        if (name !== originalName) {
            assert.equal(fs.existsSync(path.join(NO_WAIT_DIR, `${originalName}.current.json`)), false,
                'no orphan marker may stay bound to the predecessor name');
            // A later candidate can cycle back to the predecessor name; the
            // superseded run's documents must not wait for it there.
            for (const file of [`${originalName}.json`, predecessor.statusFile]) {
                assert.equal(fs.existsSync(path.join(NO_WAIT_DIR, file)), false, `superseded ${file}`);
            }
        }
        const marker = readNoWaitRunMarker(name, { runningDir: RUNNING_DIR });
        assert.ok(marker, 'the replacement tuple must be bound to a current no-wait marker');
        for (const field of RUN_FIELDS) assert.equal(marker[field], predecessor[field], field);
        assert.equal(marker.statusFile, `${name}.${run.runId}.json`);
        assert.equal(marker.instanceId, record.instanceId);
        assert.equal(marker.enableGeneration, record.enableGeneration);

        for (const file of [`${name}.json`, marker.statusFile]) {
            const status = readJson(path.join(NO_WAIT_DIR, file));
            assert.equal(status.state, 'running', file);
            assert.equal(status.sequencePhase, 'active', file);
            assert.equal(status.instanceId, record.instanceId, file);
            assert.equal(status.enableGeneration, record.enableGeneration, file);
            assert.equal(status.runId, run.runId, file);
            assert.equal(Object.hasOwn(status, 'pid'), false, 'no worker process is claimed');
        }
        assert.equal(observeLikeHarness(name, state.registry).state, 'running');
        assert.equal(readNoWaitStatus(name, { runningDir: RUNNING_DIR }).state, 'running');
        const projection = projected(name, state.registry);
        assert.equal(projection.state.ready, true);
        assert.equal(projection.state.noWaitState, 'running');
        assertOneDeploymentRun(2);
        assert.ok(eventNames(state).includes('container_no_wait_run_rebound'));

        // A later start, enable or disable retires the rebound marker against
        // the replacement's exact registry record.
        const retired = retireNoWaitRunMarker(name, { expectedRecord: record });
        assert.equal(retired.retired, true);
        assert.equal(retired.identity.instanceId, record.instanceId);
        assert.equal(retired.identity.runId, run.runId);
    });
}

test('a failed replacement publishes nothing and leaves the Watchdog able to retry', async (t) => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t, { readinessOk: false });
    const run = newRun();
    const predecessor = seedRunningRun(originalName, originalRecord, run);

    await assert.rejects(performContainerRestart(monitor, target, 'not_running', attemptFor(target)),
        /readiness script failed/);

    assert.equal(fs.existsSync(path.join(NO_WAIT_DIR, `${originalName}.current.json`)), false,
        'the predecessor marker was retired by the replacement coordinator');
    const canonical = readJson(path.join(NO_WAIT_DIR, `${originalName}.json`));
    assert.equal(canonical.instanceId, predecessor.instanceId, 'nothing was published for the failed tuple');
    assert.equal(readNoWaitStatus(originalName, { runningDir: RUNNING_DIR }).state, 'running',
        'the Watchdog must not be deferred by the failed attempt');
    for (const file of fs.readdirSync(NO_WAIT_DIR).filter((entry) => entry.endsWith('.json'))) {
        assert.notEqual(readJson(path.join(NO_WAIT_DIR, file)).state, 'starting', file);
    }
    assert.throws(() => observeLikeHarness(originalName, state.registry), { code: 'NO_WAIT_OBSERVATION_INVALID' });
    // Nothing runs after the failed same-name replacement, and the stale
    // predecessor status adds no no-wait claim to that runtime state.
    assert.equal(state.physical.has(originalName), false);
    const runtime = { containerName: originalName, state: { status: 'exited', running: false } };
    assert.equal(applyCurrentNoWaitReadiness(runtime, state.registry, { runningDir: RUNNING_DIR }), runtime);
    assert.equal(eventNames(state).includes('container_no_wait_run_rebound'), false);
});

test('a retry after a failed replacement rebinds the run the first attempt retired', async (t) => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t, { readinessOk: false });
    const run = newRun();
    const predecessor = seedRunningRun(originalName, originalRecord, run);
    await assert.rejects(performContainerRestart(monitor, target, 'not_running', attemptFor(target)),
        /readiness script failed/);
    state.readinessOk = true;

    await performContainerRestart(monitor, target, 'not_running', attemptFor(target));

    const name = state.result.containerName;
    const marker = readNoWaitRunMarker(name, { runningDir: RUNNING_DIR });
    assert.ok(marker, 'the retry rebinds the run retired by the failed attempt');
    for (const field of RUN_FIELDS) assert.equal(marker[field], predecessor[field], field);
    assert.equal(marker.instanceId, state.registry[name].instanceId);
    assert.equal(observeLikeHarness(name, state.registry).state, 'running');
});

test('a registry change after activation stops the rebind before anything is published', async (t) => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t);
    const run = newRun();
    const predecessor = seedRunningRun(originalName, originalRecord, run);
    state.afterSelectorCommit = () => {
        const name = state.result.containerName;
        state.registry[name] = { ...state.registry[name], enableGeneration: 'moved-by-another-writer' };
    };

    await performContainerRestart(monitor, target, 'not_running', attemptFor(target));

    const name = state.result.containerName;
    assert.equal(fs.existsSync(path.join(NO_WAIT_DIR, `${name}.current.json`)), false);
    assert.equal(readJson(path.join(NO_WAIT_DIR, `${name}.json`)).instanceId, predecessor.instanceId);
    assert.equal(eventNames(state).includes('container_no_wait_run_rebound'), false);
    assert.ok(eventNames(state).includes('container_no_wait_rebind_refused'));
});

test('a newer marker that appears before publication is never overwritten', async (t) => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t);
    const run = newRun();
    seedRunningRun(originalName, originalRecord, run);
    const newer = newRun();
    let newerBytes = null;
    state.afterSelectorCommit = () => {
        const name = state.result.containerName;
        seedRunningRun(name, state.registry[name], newer, { waveIndex: 0 });
        newerBytes = fs.readFileSync(path.join(NO_WAIT_DIR, `${name}.current.json`));
    };

    await performContainerRestart(monitor, target, 'not_running', attemptFor(target));

    const name = state.result.containerName;
    assert.deepEqual(fs.readFileSync(path.join(NO_WAIT_DIR, `${name}.current.json`)), newerBytes);
    assert.equal(readJson(path.join(NO_WAIT_DIR, `${name}.json`)).runId, newer.runId);
    assert.equal(eventNames(state).includes('container_no_wait_run_rebound'), false);
    assert.ok(eventNames(state).includes('container_no_wait_rebind_refused'));
});

test('a fault after the statuses and before the marker fails closed without deferring the Watchdog', async (t) => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t);
    const run = newRun();
    seedRunningRun(originalName, originalRecord, run);
    monitor.publishNoWaitRunMarker = () => { throw new Error('injected marker publication fault'); };

    await performContainerRestart(monitor, target, 'not_running', attemptFor(target));

    const name = state.result.containerName;
    const record = state.registry[name];
    assert.equal(fs.existsSync(path.join(NO_WAIT_DIR, `${name}.current.json`)), false);
    assert.equal(readJson(path.join(NO_WAIT_DIR, `${name}.json`)).instanceId, record.instanceId);
    assert.equal(readNoWaitStatus(name, { runningDir: RUNNING_DIR }).state, 'running',
        'the Watchdog is not deferred');
    assert.throws(() => observeLikeHarness(name, state.registry), { code: 'NO_WAIT_OBSERVATION_INVALID' });
    assert.equal(projected(name, state.registry).state.ready, false);
    assert.ok(eventNames(state).includes('container_no_wait_rebind_failed'));
    // The next start, enable or disable still retires cleanly.
    assert.equal(retireNoWaitRunMarker(name, { expectedRecord: record }).retired, false);
});

test('the rebind waits for the predecessor worker to be provably gone without blocking the event loop', async (t) => {
    for (const outcome of ['stays alive', 'exits', 'pid reused by a foreign process']) {
        const { state, monitor, target, originalName, originalRecord } = fixture(t);
        const run = newRun();
        seedRunningRun(originalName, originalRecord, run, { pid: 434343 });
        let proofs = 0;
        let livenessChecks = 0;
        monitor.proveNoWaitWorkerProcess = ({ pid, identity }) => {
            proofs += 1;
            assert.equal(pid, 434343);
            assert.equal(identity.instanceId, originalRecord.instanceId);
            if (outcome === 'pid reused by a foreign process') {
                const error = new Error('worker process 434343 does not match the bound no-wait run');
                error.code = 'PROCESS_IDENTITY_UNPROVEN';
                error.foreign = true;
                throw error;
            }
            return Object.freeze({ proof: 'structured-argv' });
        };
        // After one structured proof, only a cheap liveness check is polled.
        // The exiting worker is still alive at the first poll.
        if (outcome === 'exits') monitor.noWaitWorkerExitWaitMs = 1000;
        monitor.isNoWaitWorkerAlive = (pid) => {
            livenessChecks += 1;
            assert.equal(pid, 434343);
            return !(outcome === 'exits' && livenessChecks > 1);
        };
        let ticks = 0;
        const ticker = setInterval(() => { ticks += 1; }, 2);

        try {
            await performContainerRestart(monitor, target, 'not_running', attemptFor(target));
        } finally {
            clearInterval(ticker);
        }

        const name = state.result.containerName;
        const bound = fs.existsSync(path.join(NO_WAIT_DIR, `${name}.current.json`));
        assert.equal(proofs, 1, `${outcome}: one structured proof`);
        assert.equal(bound, outcome !== 'stays alive', outcome === 'stays alive'
            ? 'a live predecessor worker could still write; the rebind must not interleave with it'
            : `${outcome}: the rebind proceeds once the predecessor worker is gone`);
        if (outcome === 'stays alive') {
            assert.ok(livenessChecks >= 1);
            assert.ok(ticks > 0, 'the bounded wait yields to the event loop');
            assert.equal(readJson(path.join(NO_WAIT_DIR, `${name}.json`)).instanceId, originalRecord.instanceId);
            assert.ok(eventNames(state).includes('container_no_wait_rebind_refused'));
        }
        if (outcome === 'pid reused by a foreign process') assert.equal(livenessChecks, 0);
    }
});

test('the rebind refuses when the canonical status no longer names the captured run', async (t) => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t);
    const run = newRun();
    seedRunningRun(originalName, originalRecord, run);
    const other = newRun();
    let otherBytes = null;
    state.afterSelectorCommit = () => {
        const identity = identityFor(originalName, originalRecord, other, 0);
        writePrivateJson(path.join(NO_WAIT_DIR, `${originalName}.json`), {
            containerName: originalName, state: 'running', sequencePhase: 'active', ...identity,
        });
        otherBytes = fs.readFileSync(path.join(NO_WAIT_DIR, `${originalName}.json`));
    };

    await performContainerRestart(monitor, target, 'not_running', attemptFor(target));

    const name = state.result.containerName;
    assert.equal(name, originalName);
    assert.equal(fs.existsSync(path.join(NO_WAIT_DIR, `${name}.current.json`)), false);
    assert.deepEqual(fs.readFileSync(path.join(NO_WAIT_DIR, `${name}.json`)), otherBytes);
    assert.equal(eventNames(state).includes('container_no_wait_run_rebound'), false);
    assert.ok(eventNames(state).includes('container_no_wait_rebind_refused'));
});

// Between a failed attempt and its retry the workspace locks are released, so
// a start, enable or disable can launch, retire or replace the run.
test('a retained failed-attempt run is never resurrected after an intervening change', async (t) => {
    const interventions = {
        'a no-wait start of a newer run': ({ state, monitor, name }) => {
            const record = { ...state.registry[name], instanceId: 'started-instance', enableGeneration: 'started-enable' };
            state.registry[name] = record;
            state.physical.set(name, structuredClone(record));
            const newer = newRun();
            seedRunningRun(name, record, newer, { waveIndex: 0 });
            syncManagedContainers(monitor);
            return newer;
        },
        'a blocking start': ({ state, monitor, name }) => {
            const record = { ...state.registry[name], instanceId: 'started-instance', enableGeneration: 'started-enable' };
            state.registry[name] = record;
            state.physical.set(name, structuredClone(record));
            syncManagedContainers(monitor);
            return null;
        },
        'a start interrupted after removing the canonical status': ({ name }) => {
            fs.unlinkSync(path.join(NO_WAIT_DIR, `${name}.json`));
            return null;
        },
        'a canonical status of another run': ({ state, name }) => {
            const identity = identityFor(name, state.registry[name], newRun(), 0);
            writePrivateJson(path.join(NO_WAIT_DIR, `${name}.json`), {
                containerName: name, state: 'running', sequencePhase: 'active', ...identity,
            });
            return null;
        },
    };
    for (const [label, intervene] of Object.entries(interventions)) {
        const { state, monitor, target, originalName, originalRecord } = fixture(t, { readinessOk: false });
        const run = newRun();
        seedRunningRun(originalName, originalRecord, run);
        await assert.rejects(performContainerRestart(monitor, target, 'not_running', attemptFor(target)),
            /readiness script failed/);
        state.readinessOk = true;
        const newer = intervene({ state, monitor, name: target.containerName });
        const eventsBeforeRetry = state.events.length;
        let proofs = 0;
        monitor.proveNoWaitWorkerProcess = (...args) => { proofs += 1; return staleWorker(...args); };

        await performContainerRestart(monitor, target, 'not_running', attemptFor(target));

        const name = state.result.containerName;
        const marker = readNoWaitRunMarker(name, { runningDir: RUNNING_DIR });
        if (newer) {
            assert.ok(marker, label);
            assert.equal(marker.runId, newer.runId, `${label}: the newer run is the one rebound`);
            assert.equal(marker.instanceId, state.registry[name].instanceId, label);
        } else {
            assert.equal(marker, null, `${label}: nothing binds the replacement`);
            // The retained run is invalidated when captured, not carried to
            // publication and refused there.
            const retryEvents = state.events.slice(eventsBeforeRetry).map((entry) => entry.event);
            assert.deepEqual(retryEvents.filter((event) => event.startsWith('container_no_wait_')), [], label);
            assert.equal(proofs, 0, `${label}: no predecessor worker is probed for an invalidated run`);
        }
        for (const file of fs.readdirSync(NO_WAIT_DIR).filter((entry) => entry.endsWith('.json'))) {
            const document = readJson(path.join(NO_WAIT_DIR, file));
            assert.equal(document.runId === run.runId && document.instanceId === state.registry[name].instanceId,
                false, `${label}: ${file} resurrects the retired run`);
        }
    }
});

test('a retry after a failed distinct replacement rebinds the retired run under the new candidate', async (t) => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t, { distinct: true, readinessOk: false });
    const run = newRun();
    seedSibling(run);
    const predecessor = seedRunningRun(originalName, originalRecord, run);
    await assert.rejects(performContainerRestart(monitor, target, 'not_running', attemptFor(target)),
        /readiness script failed/);
    state.readinessOk = true;

    await performContainerRestart(monitor, target, 'not_running', attemptFor(target));

    const name = state.result.containerName;
    const marker = readNoWaitRunMarker(name, { runningDir: RUNNING_DIR });
    assert.ok(marker, 'the retry rebinds the run retired by the failed distinct attempt');
    for (const field of RUN_FIELDS) assert.equal(marker[field], predecessor[field], field);
    assert.equal(marker.instanceId, state.registry[name].instanceId);
    assert.equal(observeLikeHarness(name, state.registry).state, 'running');
    assertOneDeploymentRun(2);
});

test('superseded predecessor statuses are removed only while they still name the retired run', async (t) => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t, { distinct: true });
    const run = newRun();
    const predecessor = seedRunningRun(originalName, originalRecord, run);
    const foreign = { containerName: originalName, state: 'running', instanceId: 'foreign', enableGeneration: 'foreign' };
    let foreignBytes = null;
    monitor.publishNoWaitRunMarker = (identity, options) => {
        const published = publishNoWaitRunMarker(identity, options);
        writePrivateJson(path.join(NO_WAIT_DIR, `${originalName}.json`), foreign);
        foreignBytes = fs.readFileSync(path.join(NO_WAIT_DIR, `${originalName}.json`));
        return published;
    };

    await performContainerRestart(monitor, target, 'not_running', attemptFor(target));

    const name = state.result.containerName;
    assert.notEqual(name, originalName);
    assert.ok(readNoWaitRunMarker(name, { runningDir: RUNNING_DIR }));
    assert.equal(fs.existsSync(path.join(NO_WAIT_DIR, predecessor.statusFile)), false);
    assert.deepEqual(fs.readFileSync(path.join(NO_WAIT_DIR, `${originalName}.json`)), foreignBytes,
        'a document that no longer names the retired run is not this rebind\'s to remove');
    assert.ok(eventNames(state).includes('container_no_wait_run_rebound'));
});

test('a later disable retires the rebound marker, and a re-enable reports only the runtime state', async (t) => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t);
    const run = newRun();
    seedRunningRun(originalName, originalRecord, run);
    await performContainerRestart(monitor, target, 'not_running', attemptFor(target));
    const name = state.result.containerName;
    const record = structuredClone(state.registry[name]);
    assert.ok(readNoWaitRunMarker(name, { runningDir: RUNNING_DIR }));

    // The real disable, with its real marker retirement against the registry
    // record it removes.
    const lease = { transactionId: 'disable', preparedGeneration: 'generation' };
    const disabled = await disableAgentContainers([name], {
        loadAgentsImpl: () => state.registry,
        saveAgentsImpl: (next) => { state.registry = structuredClone(next); },
        readRoutingImpl: () => structuredClone(state.routing),
        writeRoutingImpl: (next) => { state.routing = structuredClone(next); },
        inactivateGeneration() {},
        withApplyLock: (callback) => callback({ fixture: true }),
        prepareGeneration: () => ({ selector: { state: 'inactive' }, preparationLease: lease }),
        applyGeneration: () => ({ selector: { state: 'active' } }),
        abortPreparation() {},
        isSandboxRuntimeImpl: () => false,
        stopAndRemoveImpl: (container) => { state.physical.delete(container); },
        stopAndRemoveManyImpl: (containers) => { for (const container of containers) state.physical.delete(container); },
        containerExistsImpl: (container) => state.physical.has(container),
    });
    assert.equal(disabled[0].status, 'removed');
    assert.equal(readNoWaitRunMarker(name, { runningDir: RUNNING_DIR }), null);
    assert.equal(state.registry[name], undefined);

    // A re-enable mints a new generation; the rebound status is now stale.
    const reenabled = { ...record, enableGeneration: 're-enabled-generation' };
    const runtime = { containerName: name, state: { status: 'running', running: true } };
    assert.equal(applyCurrentNoWaitReadiness(runtime, { [name]: reenabled }, { runningDir: RUNNING_DIR }), runtime);
});

test('a later start or enable retires a rebound marker against its exact record', async (t) => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t, { distinct: true, additive: true });
    const run = newRun();
    seedRunningRun(originalName, originalRecord, run);
    await performContainerRestart(monitor, target, 'not_running', attemptFor(target));
    const name = state.result.containerName;
    const record = state.registry[name];

    // Start and enable both pass `{ containerName, record }`, where `record`
    // is the exact current registry record.
    const [retired] = retireNoWaitRunMarkers([{ containerName: name, record }]);
    assert.equal(retired.retired, true);
    assert.equal(retired.identity.instanceId, record.instanceId);
    assert.equal(retired.identity.runId, run.runId);
    assert.equal(readNoWaitRunMarker(name, { runningDir: RUNNING_DIR }), null);
});

test('a Watchdog replacement of a blocking agent creates no no-wait state', async (t) => {
    const { state, monitor, target } = fixture(t);

    await performContainerRestart(monitor, target, 'not_running', attemptFor(target));

    assert.ok(state.registry[state.result.containerName]);
    const entries = fs.existsSync(NO_WAIT_DIR) ? fs.readdirSync(NO_WAIT_DIR) : [];
    assert.deepEqual(entries, []);
    assert.equal(eventNames(state).includes('container_no_wait_run_rebound'), false);
});
