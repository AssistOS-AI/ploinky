import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-retry-identity-'));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const {
    createContainerMonitor,
    monitorTick,
    performContainerRestart,
    stopContainerMonitor,
    syncManagedContainers,
} = await import('../../cli/server/containerMonitor.js');
const {
    coordinateReplacementRuntimeIdentity,
    getFailedRuntimeIdentityRotation,
} = await import('../../cli/sandbox/docker/agentServiceManager.js');

test.after(() => {
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

let fixtureCount = 0;

function fixture(t, { additive = false, distinct = true, launchFailure = false } = {}) {
    const agentName = 'health' + (++fixtureCount);
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
        abortError: null, cleanupError: null, retireError: null,
        consumedCleanupReceipts: new WeakSet(),
        launchErrorCode: null,
        rotationFailure: null,
        rotationError: new Error('coordinated replacement failed before physical launch'),
        onReadiness: null, onCleanup: null,
    };
    const capability = Object.freeze({ fixture: agentName });
    let networkHeld = false;
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
    monitor.withNetworkLifecycleLock = async (callback) => {
        assert.equal(networkHeld, false);
        networkHeld = true;
        try { return await callback(capability); }
        finally { networkHeld = false; }
    };
    monitor.resolveRouterEndpoint = () => distinct
        ? { mode: 'default', host: '127.0.0.1', port: 8080, url: 'http://127.0.0.1:8080' }
        : null;
    monitor.ensureAgentService = (_agent, _manifest, _dir, options) => {
        assert.equal(networkHeld, true);
        assert.equal(options.networkLifecycleCapability, capability);
        assert.equal(options.preserveActiveAuthorization, additive);
        const predecessorName = options.containerName;
        const predecessorRecord = structuredClone(state.registry[predecessorName]);
        state.attempts += 1;
        const identities = [agentName + '-instance-' + state.attempts, agentName + '-enable-' + state.attempts];
        const identity = coordinateReplacementRuntimeIdentity({
            containerName: predecessorName,
            existingRecord: predecessorRecord,
            stageAlongsidePredecessor: distinct,
            preserveActiveAuthorization: options.preserveActiveAuthorization,
            networkLifecycleCapability: capability,
            runtimeNetwork: { mode: distinct ? 'default' : 'none' },
            predecessorContainerId: predecessorRecord.containerId,
        }, {
            assertNetworkCapability: received => assert.equal(received, capability),
            withApplyLock: callback => callback(Object.freeze({ fixture: 'apply' })),
            inactivate: () => { state.selector.state = 'inactive'; },
            loadRegistry: () => structuredClone(state.registry),
            loadRouting: () => structuredClone(state.routing),
            saveRegistry: next => {
                if (state.rotationFailure === 'registry-before-save') throw state.rotationError;
                state.registry = structuredClone(next);
                if (state.rotationFailure === 'registry-save') throw state.rotationError;
            },
            saveRouting: next => {
                if (state.rotationFailure === 'route-save') throw state.rotationError;
                state.routing = structuredClone(next);
            },
            prepare: ({ agents }) => {
                if (state.rotationFailure === 'additive-prepare') throw state.rotationError;
                return {
                    selector: state.selector,
                    preparationLease: Object.freeze({ mode: 'additive', transactionId: agentName + '-' + state.attempts }),
                    generation: { agents: structuredClone(agents) },
                };
            },
            prepareReplacement: () => {
                if (state.rotationFailure === 'prepare') throw state.rotationError;
                if (state.rotationFailure === 'validation') return { selector: state.selector, generation: { agents: {} } };
                return {
                    selector: state.selector,
                    preparationLease: Object.freeze({ mode: 'replacement', transactionId: agentName + '-' + state.attempts }),
                    generation: { agents: structuredClone(state.registry) },
                };
            },
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
        state.events.push({ event: 'ensure', data: { container: candidateName } });
        if (launchFailure) {
            const error = new Error('candidate launch failed before runtime creation');
            if (state.launchErrorCode) error.code = state.launchErrorCode;
            error.ploinkyRestartCandidate = { ...state.result, exactCleanupPerformed: true };
            throw error;
        }
        state.physical.set(candidateName, structuredClone(registryRecord));
        return state.result;
    };
    monitor.runContainerScriptReadiness = async () => {
        if (state.onReadiness) await state.onReadiness();
        return { status: 'failed', reason: 'exit 1', detail: 'not ready' };
    };
    monitor.abortEdgeRoutingPreparation = lease => {
        assert.equal(networkHeld, true);
        assert.equal(lease, state.result.preparationLease);
        state.events.push({ event: 'abort' });
        if (state.abortError) throw state.abortError;
    };
    monitor.cleanupExactAgentRuntimeCandidate = async candidate => {
        assert.equal(networkHeld, true);
        assert.equal(candidate.containerName, state.result.containerName);
        assert.equal(candidate.cleanupReceipt, state.result.cleanupReceipt, 'cleanup must retain the original opaque receipt');
        assert.equal(state.consumedCleanupReceipts.has(candidate.cleanupReceipt), false, 'cleanup receipt is single-use');
        state.consumedCleanupReceipts.add(candidate.cleanupReceipt);
        state.events.push({ event: 'cleanup' });
        if (state.onCleanup) await state.onCleanup();
        if (state.cleanupError) throw state.cleanupError;
        const physical = state.physical.get(candidate.containerName);
        if (physical) {
            assert.equal(physical.containerId, candidate.containerId);
            assert.equal(physical.instanceId, candidate.registryRecord.instanceId);
            assert.equal(physical.enableGeneration, candidate.registryRecord.enableGeneration);
            state.physical.delete(candidate.containerName);
        }
    };
    monitor.retireExactAgentRuntimePredecessor = (predecessor, options) => {
        assert.equal(networkHeld, true);
        assert.equal(options.networkLifecycleCapability, capability);
        assert.equal(state.registry[predecessor.containerName], undefined);
        state.events.push({ event: 'retire', data: structuredClone(predecessor) });
        if (state.retireError) throw state.retireError;
        const physical = state.physical.get(predecessor.containerName);
        if (physical) {
            assert.equal(physical.containerId, predecessor.containerId);
            assert.equal(physical.instanceId, predecessor.registryRecord.instanceId);
            assert.equal(physical.enableGeneration, predecessor.registryRecord.enableGeneration);
            state.physical.delete(predecessor.containerName);
        }
    };
    monitor.listRunningContainerNames = () => [...state.physical.keys()];
    monitor.startProbeWorker = () => assert.fail('a failed replacement must not start another probe');
    monitor.withEdgeGenerationApplyLock = callback => callback(capability);
    monitor.saveAgents = next => { state.registry = structuredClone(next); };
    monitor.mergeRoutingConfig = async mutator => { state.routing = await mutator(structuredClone(state.routing)); };
    monitor.applyEdgeRoutingGeneration = options => {
        options.testHooks.beforeSelectorCommit();
        state.selector.state = 'active';
        state.events.push({ event: 'activate' });
    };
    monitor.commitAdditiveEdgeRoutingGeneration = (_lease, options) => {
        state.registry = structuredClone(options.agents);
        state.routing = structuredClone(options.routing);
        state.events.push({ event: 'activate' });
    };
    syncManagedContainers(monitor);
    const target = monitor.targets.get(originalName);
    assert.ok(target);
    return { state, monitor, target, originalName, originalRecord, manifestPath };
}

function attemptFor(target) {
    target.isRestarting = true;
    target.attemptEpoch += 1;
    return Object.freeze({
        target, epoch: target.attemptEpoch,
        digest: target.restartInputDigest, snapshot: target.restartSnapshot,
    });
}

function seedBudget(target) {
    target.restartHistory = [Date.now() - 2, Date.now() - 1];
    target.totalRestarts = 2;
    target.currentBackoff = 8000;
}

function assertBudget(target) {
    assert.equal(target.restartHistory.length, 2);
    assert.equal(target.totalRestarts, 2);
    assert.equal(target.currentBackoff, 8000);
}

for (const distinct of [true, false]) {
    test('failed ' + (distinct ? 'distinct' : 'same-name') + ' replacement preserves its exact logical retry budget', async t => {
        const { state, monitor, target, originalName } = fixture(t, { distinct });
        seedBudget(target);
        await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), /readiness script failed/);
        syncManagedContainers(monitor);
        assert.equal(monitor.targets.size, 1);
        assert.equal(monitor.targets.get(state.result.containerName), target);
        assertBudget(target);
        assert.equal(target.instanceId, state.result.stagedRegistryRecord.instanceId);
        assert.equal(target.enableGeneration, state.result.stagedRegistryRecord.enableGeneration);
        assert.deepEqual(target.restartSnapshot.registryRecord, state.registry[target.containerName]);
        assert.equal(state.selector.state, 'inactive');
        assert.equal(state.physical.size, 0);
        assert.equal(state.events.filter(({ event }) => event === 'retire').length, distinct ? 1 : 0);
        if (distinct) assert.equal(state.registry[originalName], undefined);
    });
}

test('sync during distinct replacement readiness and cleanup cannot create a second target or discard the active attempt', async t => {
    const { state, monitor, target } = fixture(t);
    seedBudget(target);
    const attempt = attemptFor(target);
    const assertInFlight = () => {
        syncManagedContainers(monitor);
        assert.equal(monitor.targets.size, 1);
        assert.equal(monitor.targets.get(state.result.containerName), target);
        assert.equal(target.attemptEpoch, attempt.epoch);
        assert.equal(target.restartInputDigest, attempt.digest);
        assert.equal(target.isRestarting, true);
        assertBudget(target);
    };
    state.onReadiness = assertInFlight;
    state.onCleanup = assertInFlight;
    await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attempt), /readiness script failed/);
    syncManagedContainers(monitor);
    assertBudget(target);
});

test('successive failed replacements reach the circuit breaker instead of resetting at each runtime name', async t => {
    const { state, monitor, target, originalName } = fixture(t);
    const timers = [];
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', timer => {
        const index = timers.indexOf(timer);
        if (index !== -1) timers.splice(index, 1);
    });
    state.physical.delete(originalName);
    state.onReadiness = () => syncManagedContainers(monitor);
    monitorTick(monitor);
    const backoffs = [];
    for (let iteration = 0; iteration < 3; iteration += 1) {
        assert.equal(timers.length, 1);
        const timer = timers.shift();
        backoffs.push(timer.delay);
        timer.callback();
        await new Promise(resolve => setImmediate(resolve));
        syncManagedContainers(monitor);
    }
    assert.equal(monitor.targets.size, 1);
    assert.equal(monitor.targets.get(state.result.containerName), target);
    assert.equal(state.attempts, 3);
    assert.equal(target.restartHistory.length, 3);
    assert.equal(target.totalRestarts, 3);
    assert.equal(target.circuitBreakerTripped, true);
    assert.deepEqual(backoffs, [1000, 2000, 4000]);
    assert.deepEqual(timers, []);
    assert.equal(state.physical.size, 0);
});

test('failed additive replacement retains its authorized predecessor without retiring it', async t => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t, { additive: true });
    seedBudget(target);
    await assert.rejects(performContainerRestart(monitor, target, 'not_running', attemptFor(target)), /readiness script failed/);
    syncManagedContainers(monitor);
    assert.equal(monitor.targets.get(originalName), target);
    assertBudget(target);
    assert.deepEqual(state.registry, { [originalName]: originalRecord });
    assert.deepEqual([...state.physical.keys()], [originalName]);
    assert.equal(state.selector.state, 'active');
    assert.equal(state.events.some(({ event }) => event === 'retire'), false);
});

test('abort failure preserves both exact runtimes and the logical retry budget', async t => {
    const { state, monitor, target, originalName } = fixture(t);
    seedBudget(target);
    state.abortError = new Error('preparation is still selected');
    await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
        code: 'PLOINKY_RECOVERY_ABORT_FAILED',
    });
    syncManagedContainers(monitor);
    assert.equal(monitor.targets.get(state.result.containerName), target);
    assertBudget(target);
    assert.deepEqual([...state.physical.keys()], [originalName, state.result.containerName]);
    assert.equal(state.events.some(({ event }) => ['cleanup', 'retire'].includes(event)), false);
    assert.equal(target.pendingRestartPreparation.result.preparationLease, state.result.preparationLease);
    assert.equal(target.pendingRestartPreparation.result.cleanupReceipt, state.result.cleanupReceipt);
    assert.equal(target.pendingRestartPreparation.restartInputDigest, target.restartInputDigest);
});

for (const additive of [false, true]) {
    test('a retried ' + (additive ? 'additive' : 'replacement') + ' abort resolves its original exact preparation before another launch', async t => {
        const { state, monitor, target, originalName } = fixture(t, { additive });
        seedBudget(target);
        state.abortError = new Error('exact preparation could not be aborted yet');
        await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
            code: 'PLOINKY_RECOVERY_ABORT_FAILED',
        });
        const failedResult = state.result;
        const retained = target.pendingRestartPreparation;
        assert.equal(retained.result.preparationLease, failedResult.preparationLease);
        assert.equal(retained.result.cleanupReceipt, failedResult.cleanupReceipt);
        assert.notEqual(retained.result.registryRecord, failedResult.registryRecord);
        assert.equal(Object.isFrozen(retained.result.registryRecord), true);
        assert.equal(Object.isFrozen(retained.result.replacementPredecessor.registryRecord), true);
        const beforeRetry = state.events.length;
        state.abortError = null;
        state.onCleanup = () => {
            syncManagedContainers(monitor);
            assert.equal(monitor.targets.size, 1);
            assert.equal(monitor.targets.get(target.containerName), target);
            assert.equal(target.isRestarting, true);
            assertBudget(target);
        };
        await assert.rejects(performContainerRestart(monitor, target, 'restart_failed', attemptFor(target)), /readiness script failed/);
        const retryEvents = state.events.slice(beforeRetry).map(({ event }) => event);
        assert.deepEqual(retryEvents.slice(0, additive ? 3 : 4), additive
            ? ['abort', 'cleanup', 'ensure']
            : ['abort', 'cleanup', 'retire', 'ensure']);
        assert.equal(state.consumedCleanupReceipts.has(failedResult.cleanupReceipt), true);
        assert.equal(state.attempts, 2);
        assert.equal(target.pendingRestartPreparation, null);
        assert.equal(target.pendingPredecessorRetirement, null);
        assertBudget(target);
        assert.deepEqual([...state.physical.keys()], additive ? [originalName] : []);
        assert.equal(state.selector.state, additive ? 'active' : 'inactive');
    });
}

for (const distinct of [false, true]) {
    for (const failurePhase of ['registry-save', 'route-save', 'prepare', 'validation']) {
        if (!distinct && failurePhase === 'route-save') continue;
        test('pre-launch ' + failurePhase + ' failure quarantines the exact ' + (distinct ? 'distinct' : 'same-name') + ' staged identity without losing predecessor evidence', async t => {
            const { state, monitor, target, originalName, originalRecord } = fixture(t, { distinct });
            state.registry[originalName].auth = { channelKey: 'preparation-credential-must-not-persist' };
            syncManagedContainers(monitor);
            seedBudget(target);
            state.rotationFailure = failurePhase;
            await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
                code: 'PLOINKY_RUNTIME_PREPARATION_REQUIRED',
            });
            assertBudget(target);
            assert.equal(target.circuitBreakerTripped, true);
            assert.equal(monitor.targets.get(target.containerName), target);
            assert.deepEqual(target.restartSnapshot.registryRecord, state.registry[target.containerName]);
            assert.equal(state.attempts, 1);
            assert.equal(state.result, null, 'no candidate was physically launched');
            assert.deepEqual([...state.physical.keys()], [originalName]);
            assert.equal(state.selector.state, 'inactive');
            assert.equal(state.events.some(({ event }) => ['abort', 'cleanup', 'retire'].includes(event)), false);
            const entry = monitor.terminalLedger.get(target.containerName);
            assert.equal(entry.code, 'PLOINKY_RUNTIME_PREPARATION_REQUIRED');
            assert.equal(entry.restartInputDigest, target.restartInputDigest);
            assert.equal(entry.cleanupEvidence.launchAttempted, false);
            assert.equal(entry.cleanupEvidence.predecessor.containerName, originalName);
            assert.equal(entry.cleanupEvidence.predecessor.containerId, originalRecord.containerId);
            assert.equal(entry.cleanupEvidence.predecessor.identity.instanceId, originalRecord.instanceId);
            assert.deepEqual(entry.cleanupEvidence.predecessor.runtimeNetwork, { mode: distinct ? 'default' : 'none' });
            assert.equal(entry.cleanupEvidence.candidate.containerName, target.containerName);
            assert.equal(entry.cleanupEvidence.candidate.containerId, null, 'inherited registry containerId is not a newly launched candidate ID');
            assert.equal(fs.readFileSync(monitor.terminalLedgerFile, 'utf8').includes('preparation-credential-must-not-persist'), false);
            syncManagedContainers(monitor);
            assert.equal(monitor.targets.size, 0);
            const respawned = createContainerMonitor({ terminalLedgerFile: monitor.terminalLedgerFile });
            respawned.loadAgents = monitor.loadAgents;
            respawned.readRoutingConfig = monitor.readRoutingConfig;
            syncManagedContainers(respawned);
            assert.equal(respawned.targets.size, 0);
            assert.deepEqual(respawned.terminalLedger.get(target.containerName).cleanupEvidence, entry.cleanupEvidence);
        });
    }
}

test('failed additive preparation does not claim a mutable registry rotation or terminalize its active predecessor', async t => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t, { additive: true });
    seedBudget(target);
    state.rotationFailure = 'additive-prepare';
    await assert.rejects(performContainerRestart(monitor, target, 'not_running', attemptFor(target)), state.rotationError);
    assert.equal(getFailedRuntimeIdentityRotation(state.rotationError), null);
    assert.deepEqual(state.registry, { [originalName]: originalRecord });
    assert.deepEqual([...state.physical.keys()], [originalName]);
    assert.equal(monitor.terminalLedger.size, 0);
    assert.equal(state.selector.state, 'active');
    assertBudget(target);
});

test('a registry write that failed before persistence cannot claim the intended rotated identity', async t => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t);
    seedBudget(target);
    state.rotationFailure = 'registry-before-save';
    await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
        code: 'PLOINKY_RESTART_ATTEMPT_STALE',
    });
    assert.deepEqual(state.registry, { [originalName]: originalRecord });
    assert.equal(monitor.terminalLedger.size, 0);
    assertBudget(target);
    assert.equal(state.physical.has(originalName), true);
});

test('field-identical rotation failure metadata cannot mint coordinator ownership', async t => {
    const { state, monitor, target } = fixture(t);
    state.rotationFailure = 'prepare';
    const originalEnsure = monitor.ensureAgentService;
    monitor.ensureAgentService = (...args) => {
        try { return originalEnsure(...args); }
        catch (error) {
            const issued = getFailedRuntimeIdentityRotation(error);
            assert.ok(issued);
            assert.equal(Object.isFrozen(issued.stagedRegistryRecord), true);
            const lookalike = new Error('unrelated failure with copied metadata');
            lookalike.ploinkyFailedRuntimeIdentityRotation = structuredClone(issued);
            assert.equal(getFailedRuntimeIdentityRotation(lookalike), null);
            throw lookalike;
        }
    };
    await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
        code: 'PLOINKY_RESTART_ATTEMPT_STALE',
    });
    assert.equal(monitor.terminalLedger.size, 0);
    assert.equal(state.events.some(({ event }) => ['abort', 'cleanup', 'retire'].includes(event)), false);
});

test('the actual sandbox catch preserves a pre-launch rotation failure before generic predecessor cleanup', async t => {
    const { state, monitor, target } = fixture(t, { distinct: false });
    state.rotationFailure = 'prepare';
    let coordinatorFailure;
    const originalEnsure = monitor.ensureAgentService;
    monitor.ensureAgentService = (...args) => {
        try { return originalEnsure(...args); }
        catch (error) { coordinatorFailure = error; throw error; }
    };
    await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
        code: 'PLOINKY_RUNTIME_PREPARATION_REQUIRED',
    });
    assert.ok(getFailedRuntimeIdentityRotation(coordinatorFailure));
    const source = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
    const sandboxStart = source.indexOf('        let sandboxRuntimeIdentity = null;');
    const catchStart = source.indexOf('        } catch (err) {', sandboxStart);
    const catchEnd = source.indexOf('\n    }\n\n    const runtime = getRuntime();', catchStart);
    assert.ok(sandboxStart >= 0 && catchStart > sandboxStart && catchEnd > catchStart);
    const run = new Function(
        'suppliedError', 'getFailedRuntimeIdentityRotation', 'createHostSandboxStartupError', 'agentName', 'agentRuntime',
        'try { throw suppliedError;\n' + source.slice(catchStart, catchEnd),
    );
    for (const runtime of ['bwrap', 'seatbelt']) {
        assert.throws(() => run(
            coordinatorFailure, getFailedRuntimeIdentityRotation,
            () => assert.fail('an unlaunched candidate must not enter generic sandbox cleanup'), 'sample', runtime,
        ), error => error === coordinatorFailure);
        const wrapped = new Error('normal sandbox launch cleanup remains reachable');
        assert.throws(() => run(
            new Error('unrelated launch failure'), getFailedRuntimeIdentityRotation,
            () => { throw wrapped; }, 'sample', runtime,
        ), error => error === wrapped);
    }
});

for (const drift of ['registry', 'identity', 'manifest']) {
    test('external ' + drift + ' drift after failed pre-launch preparation cannot acquire the staged failure quarantine', async t => {
        const { state, monitor, target, manifestPath, originalName } = fixture(t);
        seedBudget(target);
        state.rotationFailure = 'prepare';
        const originalEnsure = monitor.ensureAgentService;
        monitor.ensureAgentService = (...args) => {
            try { return originalEnsure(...args); }
            catch (error) {
                const currentName = Object.keys(state.registry)[0];
                if (drift === 'manifest') fs.appendFileSync(manifestPath, '\n');
                else if (drift === 'identity') state.registry[currentName].instanceId = 'external-prepared-instance';
                else state.registry[currentName].imageDigest = 'sha256:external-prepared-image';
                throw error;
            }
        };
        await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
            code: 'PLOINKY_RESTART_ATTEMPT_STALE',
        });
        assert.equal(monitor.terminalLedger.size, 0);
        target.isRestarting = false;
        syncManagedContainers(monitor);
        const current = [...monitor.targets.values()][0];
        assert.equal(current.restartHistory.length, 0);
        assert.equal(current.circuitBreakerTripped, false);
        assert.equal(state.physical.has(originalName), true);
        assert.equal(state.events.some(({ event }) => ['abort', 'cleanup', 'retire'].includes(event)), false);
    });
}

test('repeated abort failure never creates another candidate and exhausts the same circuit-breaker budget', async t => {
    const { state, monitor, target, originalName } = fixture(t);
    const timers = [];
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', () => {});
    state.abortError = new Error('exact preparation remains selected');
    state.physical.delete(originalName);
    monitorTick(monitor);
    const backoffs = [];
    for (let iteration = 0; iteration < 3; iteration += 1) {
        assert.equal(timers.length, 1);
        const timer = timers.shift();
        backoffs.push(timer.delay);
        timer.callback();
        await new Promise(resolve => setImmediate(resolve));
        syncManagedContainers(monitor);
    }
    assert.equal(state.attempts, 1);
    assert.equal(state.events.filter(({ event }) => event === 'abort').length, 3);
    assert.equal(state.events.some(({ event }) => ['cleanup', 'retire'].includes(event)), false);
    assert.deepEqual([...state.physical.keys()], [state.result.containerName]);
    assert.equal(target.circuitBreakerTripped, true);
    assert.equal(target.restartHistory.length, 3);
    assert.equal(target.totalRestarts, 3);
    assert.equal(target.pendingRestartPreparation.result.cleanupReceipt, state.result.cleanupReceipt);
    assert.deepEqual(backoffs, [1000, 2000, 4000]);
    assert.deepEqual(timers, []);
});

test('a retained abort preserves already-completed launch cleanup and never consumes its receipt again', async t => {
    const { state, monitor, target } = fixture(t, { launchFailure: true });
    state.abortError = new Error('exact preparation could not be aborted yet');
    await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
        code: 'PLOINKY_RECOVERY_ABORT_FAILED',
    });
    assert.equal(target.pendingRestartPreparation.result.exactCleanupPerformed, true);
    state.abortError = null;
    await assert.rejects(performContainerRestart(monitor, target, 'restart_failed', attemptFor(target)), /launch failed before runtime creation/);
    assert.equal(state.events.some(({ event }) => event === 'cleanup'), false);
    assert.equal(state.physical.size, 0);
    assert.equal(state.attempts, 2);
    assert.equal(target.pendingRestartPreparation, null);
});

test('external identity drift cannot inherit a retained failed preparation or its retry budget', async t => {
    const { state, monitor, target, originalName } = fixture(t);
    seedBudget(target);
    state.abortError = new Error('exact preparation could not be aborted yet');
    await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
        code: 'PLOINKY_RECOVERY_ABORT_FAILED',
    });
    const pending = target.pendingRestartPreparation;
    state.registry[target.containerName].instanceId = 'external-instance';
    syncManagedContainers(monitor);
    assert.notEqual(target.restartInputDigest, pending.restartInputDigest);
    assert.equal(target.restartHistory.length, 0);
    const beforeRetry = state.events.length;
    state.abortError = null;
    monitor.ensureAgentService = () => { throw new Error('unrelated replacement attempt'); };
    await assert.rejects(performContainerRestart(monitor, target, 'not_running', attemptFor(target)), /unrelated replacement attempt/);
    assert.equal(state.events.slice(beforeRetry).some(({ event }) => ['abort', 'cleanup', 'retire'].includes(event)), false);
    assert.equal(target.pendingRestartPreparation, pending);
    assert.deepEqual([...state.physical.keys()], [originalName, state.result.containerName]);
});

test('early candidate launch failure keeps its retry budget and cleans the exact revoked predecessor', async t => {
    const { state, monitor, target } = fixture(t, { launchFailure: true });
    seedBudget(target);
    await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), /launch failed before runtime creation/);
    syncManagedContainers(monitor);
    assert.equal(monitor.targets.get(state.result.containerName), target);
    assertBudget(target);
    assert.equal(state.physical.size, 0);
    assert.equal(state.events.filter(({ event }) => event === 'retire').length, 1);
});

test('a terminal launch failure binds its persisted blocker to the owned successor across sync and monitor respawn', async t => {
    const { state, monitor, target, originalName } = fixture(t, { launchFailure: true });
    state.launchErrorCode = 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS';
    state.physical.delete(originalName);
    const timers = [];
    t.mock.method(globalThis, 'setTimeout', callback => {
        const timer = { callback };
        timers.push(timer);
        return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', () => {});
    monitorTick(monitor);
    assert.equal(timers.length, 1);
    timers.shift().callback();
    await new Promise(resolve => setImmediate(resolve));
    const entry = monitor.terminalLedger.get(target.containerName);
    assert.equal(entry.code, state.launchErrorCode);
    assert.equal(entry.restartInputDigest, target.restartInputDigest);
    syncManagedContainers(monitor);
    assert.equal(monitor.targets.size, 0);
    assert.equal(monitor.terminalLedger.get(target.containerName).code, state.launchErrorCode);
    const respawned = createContainerMonitor({ terminalLedgerFile: monitor.terminalLedgerFile });
    respawned.loadAgents = monitor.loadAgents;
    respawned.readRoutingConfig = monitor.readRoutingConfig;
    syncManagedContainers(respawned);
    assert.equal(respawned.targets.size, 0);
    assert.equal(respawned.terminalLedger.get(target.containerName).code, state.launchErrorCode);
    assert.equal(state.attempts, 1);
    assert.deepEqual(timers, []);
});

test('a failed predecessor retirement keeps its exact receipt and retries before launching another candidate', async t => {
    const { state, monitor, target, originalName, originalRecord } = fixture(t);
    seedBudget(target);
    state.retireError = new Error('runtime control plane unavailable');
    await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
        code: 'PLOINKY_RECOVERY_PREDECESSOR_RETIREMENT_FAILED',
        cause: state.retireError,
    });
    syncManagedContainers(monitor);
    assertBudget(target);
    assert.deepEqual([...state.physical.keys()], [originalName]);
    const pending = target.pendingPredecessorRetirement;
    assert.equal(pending.predecessor.containerId, originalRecord.containerId);
    assert.equal(pending.restartInputDigest, target.restartInputDigest);
    assert.equal(Object.isFrozen(pending.predecessor.registryRecord), true);
    const failure = state.events.find(({ event }) => event === 'container_restart_predecessor_retirement_failed');
    assert.equal(failure.data.containerId, originalRecord.containerId);
    assert.equal(failure.data.identity.instanceId, originalRecord.instanceId);
    assert.equal(failure.data.identity.enableGeneration, originalRecord.enableGeneration);
    assert.deepEqual(failure.data.runtimeNetwork, { mode: 'default' });

    const beforeRetry = state.events.length;
    state.retireError = null;
    await assert.rejects(performContainerRestart(monitor, target, 'restart_failed', attemptFor(target)), /readiness script failed/);
    const retryEvents = state.events.slice(beforeRetry).map(({ event }) => event);
    assert.equal(retryEvents[0], 'retire');
    assert.ok(retryEvents.indexOf('retire') < retryEvents.indexOf('ensure'));
    assert.equal(state.attempts, 2);
    assert.equal(state.physical.size, 0);
    assert.equal(target.pendingPredecessorRetirement, null);
    assertBudget(target);
});

test('repeated predecessor retirement failure cannot create more candidates and still exhausts the retry budget', async t => {
    const { state, monitor, target } = fixture(t);
    seedBudget(target);
    state.retireError = new Error('exact predecessor could not be removed');
    await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
        code: 'PLOINKY_RECOVERY_PREDECESSOR_RETIREMENT_FAILED',
    });
    const timers = [];
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', () => {});
    monitorTick(monitor);
    assert.equal(timers.length, 1);
    timers.shift().callback();
    await new Promise(resolve => setImmediate(resolve));
    syncManagedContainers(monitor);
    assert.equal(state.attempts, 1, 'unresolved retirement must fail before ensure');
    assert.equal(target.circuitBreakerTripped, true);
    assert.equal(target.restartHistory.length, 3);
    assert.equal(target.totalRestarts, 3);
    assert.ok(target.pendingPredecessorRetirement);
    assert.deepEqual(timers, []);
});

for (const drift of ['predecessor-reappeared', 'authorization-reactivated']) {
    test(drift + ' prevents retirement of the captured predecessor', async t => {
        const { state, monitor, target, originalName, originalRecord } = fixture(t);
        seedBudget(target);
        state.onCleanup = () => {
            if (drift === 'predecessor-reappeared') {
                state.registry[originalName] = { ...originalRecord, instanceId: 'external-predecessor' };
            } else {
                state.selector.state = 'active';
            }
        };
        await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
            code: 'PLOINKY_RESTART_ATTEMPT_STALE',
        });
        assert.equal(state.events.some(({ event }) => event === 'retire'), false);
        assert.equal(state.physical.has(originalName), true);
        assert.ok(target.pendingPredecessorRetirement);
    });
}

test('candidate cleanup ambiguity retains exact evidence and cannot reuse its consumed receipt or launch again', async t => {
    const { state, monitor, target, originalName } = fixture(t);
    seedBudget(target);
    state.cleanupError = new Error('candidate immutable ID changed');
    await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
        code: 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS',
        cause: state.cleanupError,
    });
    syncManagedContainers(monitor);
    assertBudget(target);
    assert.equal(state.physical.has(originalName), true);
    assert.equal(state.physical.has(state.result.containerName), true);
    assert.equal(state.events.some(({ event }) => event === 'container_restart_candidate_cleanup_failed'), true);
    const retained = target.pendingRestartPreparation;
    assert.equal(retained.result.cleanupReceipt, state.result.cleanupReceipt);
    assert.equal(retained.result.candidateCleanupFailed, true);
    assert.equal(retained.result.replacementPredecessor.containerName, originalName);
    state.cleanupError = null;
    await assert.rejects(performContainerRestart(monitor, target, 'restart_failed', attemptFor(target)), {
        code: 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS',
    });
    assert.equal(state.attempts, 1);
    assert.equal(state.events.filter(({ event }) => event === 'cleanup').length, 1);
    assert.equal(state.events.filter(({ event }) => event === 'abort').length, 1);
    assert.equal(state.events.some(({ event }) => event === 'retire'), false);
    const evidence = state.events.find(({ event }) => event === 'container_restart_preparation_retained');
    assert.equal(evidence.data.containerId, state.result.containerId);
    assert.equal(evidence.data.predecessor.containerName, originalName);
    assert.equal(evidence.data.predecessor.containerId, retained.result.replacementPredecessor.containerId);
});

test('candidate cleanup ambiguity persists its terminal blocker across sync and monitor respawn', async t => {
    const { state, monitor, target, originalName } = fixture(t);
    state.cleanupError = new Error('candidate cleanup could not prove removal');
    state.physical.delete(originalName);
    const timers = [];
    t.mock.method(globalThis, 'setTimeout', callback => {
        const timer = { callback };
        timers.push(timer);
        return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', () => {});
    monitorTick(monitor);
    assert.equal(timers.length, 1);
    timers.shift().callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(monitor.terminalLedger.get(target.containerName).code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS');
    assert.equal(monitor.terminalLedger.get(target.containerName).restartInputDigest, target.restartInputDigest);
    syncManagedContainers(monitor);
    assert.equal(monitor.targets.size, 0);
    const respawned = createContainerMonitor({ terminalLedgerFile: monitor.terminalLedgerFile });
    respawned.loadAgents = monitor.loadAgents;
    respawned.readRoutingConfig = monitor.readRoutingConfig;
    syncManagedContainers(respawned);
    assert.equal(respawned.targets.size, 0);
    assert.equal(respawned.terminalLedger.get(target.containerName).code, 'PLOINKY_RUNTIME_OWNERSHIP_AMBIGUOUS');
    assert.equal(state.attempts, 1);
    assert.deepEqual(timers, []);
});

test('a later external identity cannot acquire a retained predecessor cleanup receipt', async t => {
    const { state, monitor, target, originalName } = fixture(t);
    state.retireError = new Error('preserve exact predecessor for retry');
    await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
        code: 'PLOINKY_RECOVERY_PREDECESSOR_RETIREMENT_FAILED',
    });
    const pending = target.pendingPredecessorRetirement;
    const candidateName = target.containerName;
    state.registry[candidateName].instanceId = 'external-instance';
    syncManagedContainers(monitor);
    assert.equal(target.restartHistory.length, 0);
    assert.notEqual(target.restartInputDigest, pending.restartInputDigest);
    state.retireError = null;
    const beforeRetry = state.events.length;
    await assert.rejects(performContainerRestart(monitor, target, 'not_running', attemptFor(target)), /readiness script failed/);
    assert.equal(state.events.slice(beforeRetry).some(({ event, data }) => (
        event === 'retire' && data.containerName === originalName
    )), false);
    assert.equal(state.physical.has(originalName), true);
});

test('an occupied successor target cannot be overwritten by another restart attempt', async t => {
    const { state, monitor, target } = fixture(t);
    const originalEnsure = monitor.ensureAgentService;
    const unrelated = { containerName: 'unrelated', restartHistory: [1, 2, 3] };
    monitor.ensureAgentService = (...args) => {
        const result = originalEnsure(...args);
        monitor.targets.set(result.containerName, unrelated);
        return result;
    };
    await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
        code: 'PLOINKY_RESTART_ATTEMPT_STALE',
    });
    assert.equal(monitor.targets.get(state.result.containerName), unrelated);
    assert.deepEqual(unrelated.restartHistory, [1, 2, 3]);
    assert.equal(state.events.some(({ event }) => event === 'retire'), false);
});

test('the recursive service launch failure carries the actual staged authority and immutable predecessor receipt', () => {
    const source = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
    const attachStart = source.indexOf('function attachRestartCandidate(');
    const attachEnd = source.indexOf('\nfunction runtimeCandidateContractHash(', attachStart);
    assert.ok(attachStart >= 0 && attachEnd > attachStart);
    const attach = new Function(source.slice(attachStart, attachEnd) + '\nreturn attachRestartCandidate;')();
    const branchStart = source.indexOf('    if (runtimeIdentity.candidateContainerName\n        && runtimeIdentity.candidateContainerName !== containerName) {');
    const branchEnd = source.indexOf('\n    let started = null;', branchStart);
    assert.ok(branchStart >= 0 && branchEnd > branchStart);
    const run = new Function(
        'runtimeIdentity', 'containerName', 'inspectedContainerId', 'existingRecord',
        'manifestNetwork', 'runtime', 'ensureAgentService', 'agentName', 'manifest',
        'agentPath', 'options', 'attachRestartCandidate',
        source.slice(branchStart, branchEnd),
    );
    const original = {
        type: 'agent', repoName: 'demo', agentName: 'sample',
        instanceId: 'old-instance', enableGeneration: 'old-enable', containerId: 'old-id',
    };
    const staged = { ...original, instanceId: 'new-instance', enableGeneration: 'new-enable' };
    const lease = Object.freeze({ mode: 'replacement', transactionId: 'exact-lease' });
    const identity = {
        candidateContainerName: 'successor',
        instanceId: staged.instanceId,
        enableGeneration: staged.enableGeneration,
        preparedRegistryRecord: staged,
        preparationLease: lease,
    };
    const failure = new Error('pre-launch validation failed');
    const cleanupReceipt = Object.freeze({ fixture: 'exact-receipt' });
    failure.ploinkyRestartCandidate = { cleanupReceipt, exactCleanupPerformed: true };
    assert.throws(() => run(
        identity, 'predecessor', original.containerId, original, { mode: 'default' }, 'podman',
        () => { throw failure; }, 'sample', {}, '/fixture/sample', {}, attach,
    ), error => {
        assert.equal(error, failure);
        const candidate = error.ploinkyRestartCandidate;
        assert.equal(candidate.requiresEdgeActivation, true);
        assert.equal(candidate.containerName, 'successor');
        assert.equal(candidate.preparationLease, lease);
        assert.deepEqual(candidate.stagedRegistryRecord, staged);
        assert.equal(candidate.cleanupReceipt, cleanupReceipt);
        assert.equal(candidate.exactCleanupPerformed, true);
        assert.deepEqual(candidate.replacementPredecessor, {
            containerName: 'predecessor',
            containerId: 'old-id',
            runtimeNetwork: { mode: 'default' },
            registryRecord: { ...original, runtime: 'podman' },
        });
        return true;
    });
});

for (const drift of ['registry', 'identity', 'manifest']) {
    test('external ' + drift + ' drift cannot inherit a failed replacement budget or authorize predecessor cleanup', async t => {
        const { state, monitor, target, manifestPath, originalName } = fixture(t);
        seedBudget(target);
        state.onReadiness = () => {
            if (drift === 'manifest') fs.appendFileSync(manifestPath, '\n');
            else if (drift === 'identity') state.registry[state.result.containerName].instanceId = 'external-instance';
            else state.registry[state.result.containerName].imageDigest = 'sha256:external-image';
        };
        await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
            code: 'PLOINKY_RESTART_ATTEMPT_STALE',
        });
        // The scheduler clears this flag after a stale failure; run that same
        // completion boundary before the next registry synchronization.
        target.isRestarting = false;
        syncManagedContainers(monitor);
        const current = monitor.targets.get(state.result.containerName);
        assert.equal(current.restartHistory.length, 0);
        assert.equal(current.currentBackoff, 1000);
        assert.equal(state.events.some(({ event }) => event === 'retire'), false);
        assert.equal(state.physical.has(originalName), true);
    });
}

test('successful distinct replacement retains readiness and publication order across in-flight sync', async t => {
    const { state, monitor, target, originalName } = fixture(t);
    seedBudget(target);
    monitor.runContainerScriptReadiness = () => {
        syncManagedContainers(monitor);
        assert.equal(monitor.targets.size, 1);
        assert.equal(monitor.targets.get(state.result.containerName), target);
        assert.equal(state.selector.state, 'inactive');
        return { status: 'success' };
    };
    await performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target));
    syncManagedContainers(monitor);
    assert.equal(monitor.targets.get(state.result.containerName), target);
    assert.equal(state.selector.state, 'active');
    assert.deepEqual(state.registry[target.containerName], state.result.registryRecord);
    assert.equal(state.routing.routes[target.agentName].container, target.containerName);
    assert.equal(target.isRestarting, false);
    assert.equal(target.currentBackoff, 1000);
    assert.equal(target.circuitBreakerTripped, false);
    assert.equal(state.physical.has(originalName), false);
    assert.deepEqual([...state.physical.keys()], [state.result.containerName]);
    const events = state.events.map(({ event }) => event);
    assert.ok(events.indexOf('activate') < events.indexOf('retire'));
    assert.equal(events.includes('abort'), false);
    assert.equal(events.includes('cleanup'), false);
});

for (const additive of [false, true]) {
    test('published ' + (additive ? 'additive' : 'replacement') + ' cleanup failure preserves its active successor and durable exact predecessor evidence', async t => {
        const { state, monitor, target, originalName, originalRecord } = fixture(t, { additive });
        state.registry[originalName].auth = { channelKey: 'must-not-persist-this-credential' };
        syncManagedContainers(monitor);
        state.retireError = new Error('exact predecessor removal unavailable after activation');
        monitor.runContainerScriptReadiness = () => ({ status: 'success' });
        await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attemptFor(target)), {
            code: 'PLOINKY_PREDECESSOR_CLEANUP_REQUIRED',
            cause: state.retireError,
        });
        assert.equal(state.selector.state, 'active');
        assert.deepEqual(state.registry[target.containerName], state.result.registryRecord);
        assert.deepEqual([...state.physical.keys()], [originalName, state.result.containerName]);
        assert.equal(state.events.some(({ event }) => ['abort', 'cleanup', 'container_restart_success'].includes(event)), false);
        assert.equal(target.pendingPredecessorRetirement.publicationCommitted, true);
        assert.equal(target.pendingPredecessorRetirement.predecessor.containerId, originalRecord.containerId);
        assert.equal(target.pendingPredecessorRetirement.predecessor.registryRecord.auth, undefined);
        assert.equal(target.pendingPredecessorRetirement.restartInputDigest, target.restartInputDigest);
        assert.equal(target.circuitBreakerTripped, true);
        const entry = monitor.terminalLedger.get(target.containerName);
        assert.equal(entry.code, 'PLOINKY_PREDECESSOR_CLEANUP_REQUIRED');
        assert.equal(entry.restartInputDigest, target.restartInputDigest);
        assert.equal(entry.cleanupEvidence.publicationCommitted, true);
        assert.equal(entry.cleanupEvidence.predecessor.containerName, originalName);
        assert.equal(entry.cleanupEvidence.predecessor.containerId, originalRecord.containerId);
        assert.deepEqual(entry.cleanupEvidence.predecessor.runtimeNetwork, { mode: 'default' });
        assert.equal(entry.cleanupEvidence.predecessor.identity.instanceId, originalRecord.instanceId);
        assert.equal(entry.cleanupEvidence.predecessor.identity.enableGeneration, originalRecord.enableGeneration);
        assert.equal(entry.cleanupEvidence.candidate.containerName, target.containerName);
        assert.equal(entry.cleanupEvidence.candidate.containerId, state.result.containerId);
        assert.equal(fs.readFileSync(monitor.terminalLedgerFile, 'utf8').includes('must-not-persist-this-credential'), false);
        assert.equal(JSON.stringify(state.events.filter(({ level }) => level)).includes('must-not-persist-this-credential'), false);

        state.retireError = null;
        await assert.rejects(performContainerRestart(monitor, target, 'restart_failed', attemptFor(target)), {
            code: 'PLOINKY_PREDECESSOR_CLEANUP_REQUIRED',
        });
        assert.equal(state.attempts, 1);
        assert.equal(state.events.filter(({ event }) => event === 'retire').length, 1);
        assert.equal(state.selector.state, 'active');
        syncManagedContainers(monitor);
        assert.equal(monitor.targets.size, 0);
        const respawned = createContainerMonitor({ terminalLedgerFile: monitor.terminalLedgerFile });
        respawned.loadAgents = monitor.loadAgents;
        respawned.readRoutingConfig = monitor.readRoutingConfig;
        syncManagedContainers(respawned);
        assert.equal(respawned.targets.size, 0);
        assert.deepEqual(respawned.terminalLedger.get(target.containerName).cleanupEvidence, entry.cleanupEvidence);
    });

    test('published ' + (additive ? 'additive' : 'replacement') + ' cleanup evidence cannot terminalize an externally changed successor', async t => {
        const { state, monitor, target } = fixture(t, { additive });
        const attempt = attemptFor(target);
        state.retireError = new Error('exact predecessor removal unavailable after activation');
        monitor.runContainerScriptReadiness = () => ({ status: 'success' });
        const originalRetire = monitor.retireExactAgentRuntimePredecessor;
        monitor.retireExactAgentRuntimePredecessor = (...args) => {
            state.registry[state.result.containerName].instanceId = 'external-successor';
            return originalRetire(...args);
        };
        await assert.rejects(performContainerRestart(monitor, target, 'semantic_probe_failed', attempt), {
            code: 'PLOINKY_RESTART_ATTEMPT_STALE',
        });
        assert.equal(monitor.terminalLedger.size, 0);
        assert.equal(target.pendingPredecessorRetirement.restartInputDigest, attempt.digest);
        target.isRestarting = false;
        syncManagedContainers(monitor);
        assert.notEqual(target.restartInputDigest, target.pendingPredecessorRetirement.restartInputDigest);
        assert.equal(target.instanceId, 'external-successor');
        assert.equal(target.restartHistory.length, 0);
        assert.equal(target.circuitBreakerTripped, false);
        assert.equal(state.selector.state, 'active');
        assert.equal(state.events.some(({ event }) => ['abort', 'cleanup'].includes(event)), false);
        assert.equal(state.events.some(({ event, data }) => (
            event === 'container_restart_predecessor_retirement_failed'
            && data.cleanupEvidence?.predecessor.containerId
        )), true);
    });
}
