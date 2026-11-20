import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRuntimeCandidate, retireRuntimeCandidate, writeRuntimeCandidate } from '../../cli/sandbox/runtimeCandidateStore.js';

import {
    ACCEPT_FAILED_DRAIN_FLAG,
    cleanupFailedTargetedAgentRestart,
    commitTargetedAgentRestart,
    parseTargetedRestartArguments,
    prepareTargetedAgentRestart,
} from '../../cli/commands/targetedAgentRestart.js';
import { assertAgentServiceNotDraining } from '../../cli/sandbox/docker/agentServiceManager.js';
import { drainAndRemoveTargetedContainer } from '../../cli/sandbox/docker/targetedContainerLifecycle.js';

function restartFixture() {
    const containerName = 'onlyoffice-container';
    let registry = {
        [containerName]: {
            type: 'agent',
            repoName: 'AssistOSExplorer',
            agentName: 'onlyOffice',
            alias: 'onlyOffice',
            runtime: 'podman',
            containerId: 'a'.repeat(64),
            instanceId: 'onlyoffice-instance',
            enableGeneration: 'onlyoffice-enable-generation',
        },
    };
    let routing = {
        routes: {
            onlyOffice: {
                repo: 'AssistOSExplorer',
                agent: 'onlyOffice',
                container: containerName,
                hostPath: '/workspace/.ploinky/repos/AssistOSExplorer/onlyOffice',
                hostPort: 43101,
            },
        },
    };
    let sequence = 0;
    let selector = null;
    const select = () => {
        sequence += 1;
        selector = {
            state: 'active',
            generation: `sha256:generation-${sequence}`,
            activationId: `activation-${sequence}`,
            selectorDigest: `sha256:selector-${sequence}`,
        };
    };
    select();

    const loadActive = () => ({
        selector: structuredClone(selector),
        generation: {
            routing: structuredClone(routing),
            agents: structuredClone(registry),
            compiled: {
                hosts: {
                    'explorer.example.test': { routeKey: 'onlyOffice' },
                },
            },
        },
    });
    const mergeRouting = async (mutator, options) => {
        const candidate = structuredClone(routing);
        routing = await mutator(candidate, { applyLockCapability: Object.freeze({ fixture: 'apply' }), networkLifecycleCapability: options?.networkLifecycleCapability }) || candidate;
        select();
        return routing;
    };
    const dependencies = {
        mergeRouting,
        loadActive,
        // The commit's error-path inspection reads the same fixture state.
        inspectActive: loadActive,
        loadAgents: () => structuredClone(registry),
        saveAgents: (value) => { registry = structuredClone(value); },
    };
    return {
        containerName,
        dependencies,
        get registry() { return structuredClone(registry); },
        get routing() { return structuredClone(routing); },
    };
}

test('targeted restart withdraws only new route traffic while preserving the exact caller identity', async () => {
    const fixture = restartFixture();
    const record = fixture.registry[fixture.containerName];
    const transition = await prepareTargetedAgentRestart({
        containerName: fixture.containerName,
        routeKey: 'onlyOffice',
        repoName: 'AssistOSExplorer',
        shortAgentName: 'onlyOffice',
        record,
        networkLifecycleCapability: Object.freeze({ fixture: true }),
    }, fixture.dependencies);

    assert.equal(fixture.routing.routes.onlyOffice.draining, true);
    assert.equal(fixture.registry[fixture.containerName].containerId, record.containerId);
    assert.deepEqual(transition.identity, {
        instanceId: record.instanceId,
        enableGeneration: record.enableGeneration,
    });
    assert.deepEqual(transition.targetedRestart.affectedSelectors, [
        'agent-port:onlyOffice',
        'agent-root:onlyOffice',
        'host:explorer.example.test',
    ]);
    assert.equal(transition.targetedRestart.assertSelectorsInactive({
        containerName: fixture.containerName,
        affectedSelectors: transition.targetedRestart.affectedSelectors,
    }), true);
    assert.equal(transition.targetedRestart.assertSelectorsInactive({
        containerName: 'another-container',
        affectedSelectors: transition.targetedRestart.affectedSelectors,
    }), false);
});

test('a failed draining restart is retryable and commits the ready successor under the same tuple', async () => {
    const fixture = restartFixture();
    const request = {
        containerName: fixture.containerName,
        routeKey: 'onlyOffice',
        repoName: 'AssistOSExplorer',
        shortAgentName: 'onlyOffice',
        record: fixture.registry[fixture.containerName],
        networkLifecycleCapability: Object.freeze({ fixture: true }),
    };
    const failedTransition = await prepareTargetedAgentRestart(request, fixture.dependencies);
    const retryTransition = await prepareTargetedAgentRestart(request, fixture.dependencies);

    assert.equal(failedTransition.targetedRestart.assertSelectorsInactive({
        containerName: fixture.containerName,
        affectedSelectors: failedTransition.targetedRestart.affectedSelectors,
    }), false);
    assert.equal(retryTransition.predecessorRoute.draining, undefined);
    assert.equal(retryTransition.targetedRestart.assertSelectorsInactive({
        containerName: fixture.containerName,
        affectedSelectors: retryTransition.targetedRestart.affectedSelectors,
    }), true);

    const registryRecord = {
        ...fixture.registry[fixture.containerName],
        containerId: 'b'.repeat(64),
        agentLib: { source: 'workspace' },
    };
    await commitTargetedAgentRestart({
        transition: retryTransition,
        result: {
            containerName: fixture.containerName,
            hostPort: 53201,
            registryRecord,
        },
        agentPath: '/workspace/.ploinky/repos/AssistOSExplorer/onlyOffice',
        alias: 'onlyOffice',
        networkLifecycleCapability: request.networkLifecycleCapability,
    }, fixture.dependencies);

    assert.equal(fixture.routing.routes.onlyOffice.draining, undefined);
    assert.equal(fixture.routing.routes.onlyOffice.hostPort, 53201);
    assert.equal(fixture.registry[fixture.containerName].containerId, registryRecord.containerId);
    assert.equal(fixture.registry[fixture.containerName].instanceId, request.record.instanceId);
    assert.equal(fixture.registry[fixture.containerName].enableGeneration, request.record.enableGeneration);
});

test('failed successor cleanup is exact and idempotent', () => {
    const removals = [];
    const result = {
        containerName: 'onlyoffice-container',
        containerId: 'c'.repeat(64),
        registryRecord: { type: 'agent' },
        cleanupReceipt: { state: 'retryable-exact-id' },
        createdByThisLaunch: true,
        exactCleanupPerformed: false,
    };
    const dependencies = {
        cleanupCandidate: (candidate) => { removals.push(candidate.containerId); },
    };

    assert.equal(cleanupFailedTargetedAgentRestart(result, new Error('readiness failed'), dependencies), true);
    assert.equal(cleanupFailedTargetedAgentRestart(result, new Error('readiness failed'), dependencies), false);
    assert.deepEqual(removals, [result.containerId]);
});

function durableRestartFixture(t) {
    const fixture = restartFixture();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ploinky-targeted-receipt-'));
    t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    const receiptOptions = { workspaceRoot };
    const dependencies = {
        ...fixture.dependencies,
        retireCandidate: candidate => retireRuntimeCandidate(candidate, receiptOptions),
    };
    async function launch(containerId) {
        const predecessor = fixture.registry[fixture.containerName];
        const transition = await prepareTargetedAgentRestart({
            containerName: fixture.containerName,
            routeKey: 'onlyOffice',
            repoName: predecessor.repoName,
            shortAgentName: predecessor.agentName,
            record: predecessor,
        }, dependencies);
        const registryRecord = { ...predecessor, containerId };
        const durableCandidate = writeRuntimeCandidate({
            operationId: randomUUID(),
            containerName: fixture.containerName,
            containerId,
            predecessorContainerId: predecessor.containerId,
            runtime: 'podman',
            runtimeNetwork: { mode: 'default' },
            registryRecord,
        }, receiptOptions);
        return { transition, result: { containerName: fixture.containerName, containerId, registryRecord, durableCandidate, hostPort: 53201 } };
    }
    return { fixture, dependencies, launch, readReceipt: () => readRuntimeCandidate(fixture.containerName, fixture.registry[fixture.containerName], receiptOptions) };
}

test('two successive targeted restarts retire each published receipt before reusing the runtime tuple', async t => {
    const state = durableRestartFixture(t);
    for (const containerId of ['b'.repeat(64), 'c'.repeat(64)]) {
        const launch = await state.launch(containerId);
        assert.equal(state.readReceipt().containerId, containerId);
        await commitTargetedAgentRestart({ ...launch, agentPath: '/workspace/agent' }, state.dependencies);
        assert.equal(state.fixture.registry[state.fixture.containerName].containerId, containerId);
        assert.equal(state.fixture.routing.routes.onlyOffice.draining, undefined);
        assert.equal(state.readReceipt(), null);
    }
});

test('failed targeted publication retains its receipt for exact candidate recovery', async t => {
    const state = durableRestartFixture(t);
    const launch = await state.launch('b'.repeat(64));
    await assert.rejects(commitTargetedAgentRestart({ ...launch, agentPath: '/workspace/agent' }, {
        ...state.dependencies,
        mergeRouting: async () => { throw new Error('publication failed'); },
    }), /publication failed/);
    assert.equal(state.fixture.registry[state.fixture.containerName].containerId, 'a'.repeat(64));
    assert.equal(state.readReceipt().operationId, launch.result.durableCandidate.operationId);
});

test('receipt retirement failure cannot fail an already-published targeted successor', async t => {
    const state = durableRestartFixture(t);
    const launch = await state.launch('b'.repeat(64));
    const failures = [];
    await commitTargetedAgentRestart({ ...launch, agentPath: '/workspace/agent' }, {
        ...state.dependencies,
        retireCandidate: () => { throw new Error('receipt unavailable'); },
        reportRetirementFailure: error => { failures.push(error.message); throw new Error('report failed'); },
    });
    assert.equal(state.fixture.registry[state.fixture.containerName].containerId, launch.result.containerId);
    assert.equal(state.fixture.routing.routes.onlyOffice.draining, undefined);
    assert.deepEqual(failures, ['receipt unavailable']);
    assert.equal(state.readReceipt().containerId, launch.result.containerId);
});

function restartRequest(fixture, acceptedFailedDrain = null) {
    return {
        containerName: fixture.containerName,
        routeKey: 'onlyOffice',
        repoName: 'AssistOSExplorer',
        shortAgentName: 'onlyOffice',
        record: fixture.registry[fixture.containerName],
        networkLifecycleCapability: Object.freeze({ fixture: true }),
        ...(acceptedFailedDrain ? { acceptedFailedDrain } : {}),
    };
}

// The engine as the predecessor left it: stopped after SIGTERM with exit 143.
function exitedPredecessorEngine(containerId) {
    const events = [];
    let exists = true;
    return {
        events,
        options: (targetedRestart) => ({
            runtime: 'podman',
            acknowledgement: targetedRestart.acknowledgement,
            affectedSelectors: targetedRestart.affectedSelectors,
            assertSelectorsInactive: targetedRestart.assertSelectorsInactive,
            ...(targetedRestart.acceptedFailedDrain ? { acceptedFailedDrain: targetedRestart.acceptedFailedDrain } : {}),
            exists: () => exists,
            isRunning: () => false,
            signal: () => { events.push('signal'); return { status: 0 }; },
            inspect: () => ({ Id: containerId, State: { Running: false, ExitCode: 143, OOMKilled: false, Error: '' } }),
            remove: () => { events.push('remove'); exists = false; return { status: 0 }; },
        }),
    };
}

test('restart arguments accept only a named agent with the full ID of the predecessor whose drain was refused', () => {
    const id = 'a'.repeat(64);
    assert.deepEqual(parseTargetedRestartArguments([]), { target: '', acceptedFailedDrain: null });
    assert.deepEqual(parseTargetedRestartArguments(['router']), { target: 'router', acceptedFailedDrain: null });
    assert.deepEqual(parseTargetedRestartArguments(['onlyOffice']), { target: 'onlyOffice', acceptedFailedDrain: null });
    assert.deepEqual(parseTargetedRestartArguments(['onlyOffice', ACCEPT_FAILED_DRAIN_FLAG, id]), {
        target: 'onlyOffice',
        acceptedFailedDrain: { containerId: id },
    });
    for (const options of [
        [ACCEPT_FAILED_DRAIN_FLAG, id],
        [ACCEPT_FAILED_DRAIN_FLAG, id, 'onlyOffice'],
        ['onlyOffice', ACCEPT_FAILED_DRAIN_FLAG],
        ['onlyOffice', ACCEPT_FAILED_DRAIN_FLAG, id.slice(0, 12)],
        ['onlyOffice', ACCEPT_FAILED_DRAIN_FLAG, id.toUpperCase()],
        ['onlyOffice', ACCEPT_FAILED_DRAIN_FLAG, id, ACCEPT_FAILED_DRAIN_FLAG, id],
        ['router', ACCEPT_FAILED_DRAIN_FLAG, id],
    ]) {
        assert.throws(() => parseTargetedRestartArguments(options), /accept-failed-drain|Usage: restart/, JSON.stringify(options));
    }
});

test('acceptance answers only an earlier refused drain of the exact registered predecessor', async () => {
    const fixture = restartFixture();
    const predecessorId = fixture.registry[fixture.containerName].containerId;
    await assert.rejects(
        prepareTargetedAgentRestart(restartRequest(fixture, { containerId: predecessorId }), fixture.dependencies),
        /has no refused targeted drain to accept/,
    );
    assert.equal(fixture.routing.routes.onlyOffice.draining, undefined, 'acceptance never starts a new drain');

    await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
    await assert.rejects(
        prepareTargetedAgentRestart(restartRequest(fixture, { containerId: 'f'.repeat(64) }), fixture.dependencies),
        /is not the registered predecessor/,
    );
    await assert.rejects(
        prepareTargetedAgentRestart(restartRequest(fixture, { containerId: predecessorId.slice(0, 12) }), fixture.dependencies),
        (error) => error?.code === 'TARGETED_DRAIN_INVALID',
    );
    assert.equal(fixture.routing.routes.onlyOffice.draining, true);

    const accepted = await prepareTargetedAgentRestart(restartRequest(fixture, { containerId: predecessorId }), fixture.dependencies);
    assert.deepEqual(accepted.targetedRestart.acceptedFailedDrain, { containerId: predecessorId });
    assert.equal(accepted.predecessorRoute.draining, undefined);
});

test('a refused drain blocks admission until the operator accepts that exact predecessor and its successor is published', async () => {
    const fixture = restartFixture();
    const predecessorId = fixture.registry[fixture.containerName].containerId;
    const loadRouting = () => fixture.routing;
    const engine = exitedPredecessorEngine(predecessorId);

    // The refused drain and an ordinary retry both leave the route draining.
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const transition = await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
        assert.throws(
            () => drainAndRemoveTargetedContainer(fixture.containerName, engine.options(transition.targetedRestart)),
            (error) => error?.code === 'TARGETED_DRAIN_FAILED' && /exit=143/.test(error.message),
        );
        assert.equal(fixture.routing.routes.onlyOffice.draining, true);
        assert.throws(() => assertAgentServiceNotDraining(fixture.containerName, { loadRouting }), {
            code: 'PLOINKY_AGENT_DRAINING',
        });
    }
    assert.deepEqual(engine.events, []);

    const accepted = await prepareTargetedAgentRestart(restartRequest(fixture, { containerId: predecessorId }), fixture.dependencies);
    const drained = drainAndRemoveTargetedContainer(fixture.containerName, engine.options(accepted.targetedRestart));
    assert.equal(drained.state, 'accepted-failed-drain');
    assert.equal(drained.exitCode, 143);
    assert.deepEqual(engine.events, ['remove'], 'the stopped predecessor is removed without any signal');

    const registryRecord = { ...fixture.registry[fixture.containerName], containerId: 'b'.repeat(64) };
    await commitTargetedAgentRestart({
        transition: accepted,
        result: { containerName: fixture.containerName, hostPort: 53201, registryRecord },
        agentPath: '/workspace/.ploinky/repos/AssistOSExplorer/onlyOffice',
        alias: 'onlyOffice',
        networkLifecycleCapability: Object.freeze({ fixture: true }),
    }, fixture.dependencies);
    assert.equal(fixture.routing.routes.onlyOffice.draining, undefined);
    assert.equal(fixture.registry[fixture.containerName].containerId, registryRecord.containerId);
    assert.equal(fixture.registry[fixture.containerName].instanceId, 'onlyoffice-instance');
    assert.doesNotThrow(() => assertAgentServiceNotDraining(fixture.containerName, { loadRouting }));
});

const AGENT_PATH = '/workspace/.ploinky/repos/AssistOSExplorer/onlyOffice';

// The active-to-active reopen is not modelled by the mock fixture: a plain
// refusal takes the coordinated inactive merge (D7) through `mergeRouting`.
function noReopen() {
    throw new Error('the mock fixture has no active-to-active reopen');
}

function successor(fixture, containerId = 'b'.repeat(64), hostPort = 53201) {
    return {
        containerName: fixture.containerName,
        containerId,
        hostPort,
        registryRecord: { ...fixture.registry[fixture.containerName], containerId },
    };
}

function commitRequest(fixture, transition, result = successor(fixture)) {
    return { transition, result, agentPath: AGENT_PATH, alias: 'onlyOffice', networkLifecycleCapability: Object.freeze({ fixture: true }) };
}

function drainProof(fixture, transition) {
    return transition.targetedRestart.assertSelectorsInactive({
        containerName: fixture.containerName,
        affectedSelectors: transition.targetedRestart.affectedSelectors,
    });
}

test('an unrelated selector change between drain and commit keeps the transition valid', async () => {
    const fixture = restartFixture();
    const transition = await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
    // Another writer commits an unrelated route change: a new selector.
    await fixture.dependencies.mergeRouting((routing) => {
        routing.routes.unrelated = { repo: 'AssistOSExplorer', agent: 'unrelated', container: 'unrelated-container', hostPort: 43102 };
        return routing;
    });
    const proof = drainProof(fixture, transition);

    await commitTargetedAgentRestart(commitRequest(fixture, transition), { ...fixture.dependencies, reopenRoute: noReopen });
    assert.equal(fixture.routing.routes.onlyOffice.draining, undefined);
    assert.equal(fixture.routing.routes.onlyOffice.hostPort, 53201);
    assert.equal(fixture.registry[fixture.containerName].containerId, 'b'.repeat(64));
    assert.equal(fixture.routing.routes.unrelated.hostPort, 43102);
    assert.equal(proof, true, 'the drain proof holds after an unrelated selector change');
});

test('a superseded or already committed transition is refused', async () => {
    const fixture = restartFixture();
    const failedTransition = await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
    const retryTransition = await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
    assert.equal(drainProof(fixture, failedTransition), false);
    const dependencies = { ...fixture.dependencies, reopenRoute: noReopen };

    await assert.rejects(commitTargetedAgentRestart(commitRequest(fixture, failedTransition), dependencies), { code: 'TARGETED_RESTART_SUPERSEDED' });
    assert.equal(fixture.routing.routes.onlyOffice.draining, true);
    assert.equal(fixture.registry[fixture.containerName].containerId, 'a'.repeat(64));

    await commitTargetedAgentRestart(commitRequest(fixture, retryTransition), dependencies);
    const routing = JSON.stringify(fixture.routing);
    const registry = JSON.stringify(fixture.registry);
    await assert.rejects(
        commitTargetedAgentRestart(commitRequest(fixture, retryTransition, successor(fixture, 'c'.repeat(64), 53202)), dependencies),
        { code: 'TARGETED_RESTART_SUPERSEDED' },
    );
    assert.equal(JSON.stringify(fixture.routing), routing, 'a replay leaves routing byte-equal');
    assert.equal(JSON.stringify(fixture.registry), registry, 'a replay leaves the registry byte-equal');
});

// Counts the injected reopen and the inactive fallback merge of one commit.
function countingCommitDependencies(fixture, reopenRoute) {
    const calls = { reopen: 0, fallback: 0, delays: [] };
    return {
        calls,
        dependencies: {
            ...fixture.dependencies,
            reopenRoute: (...args) => { calls.reopen += 1; return reopenRoute(...args); },
            mergeRouting: (...args) => { calls.fallback += 1; return fixture.dependencies.mergeRouting(...args); },
            sleep: async (ms) => { calls.delays.push(ms); },
        },
    };
}

// Publishes the successor the way the active-to-active reopen does.
function publishThroughFixture(fixture) {
    return async (transition, buildRoute, result) => {
        fixture.dependencies.saveAgents({ ...fixture.registry, [transition.containerName]: structuredClone(result.registryRecord) });
        return fixture.dependencies.mergeRouting((routing) => {
            routing.routes[transition.routeKey] = buildRoute();
            return routing;
        });
    };
}

function edgeError(code) {
    return Object.assign(new Error(`fixture ${code}`), { code });
}

test('a transition whose route changed owner or identity is refused without publication', async () => {
    for (const [label, change] of [
        ['route owner', (fixture) => fixture.dependencies.mergeRouting((routing) => {
            routing.routes.onlyOffice.container = 'other-container';
            return routing;
        })],
        ['registry identity', (fixture) => fixture.dependencies.saveAgents({
            ...fixture.registry,
            [fixture.containerName]: { ...fixture.registry[fixture.containerName], instanceId: 'other-instance' },
        })],
        ['route drain cleared', (fixture) => fixture.dependencies.mergeRouting((routing) => {
            delete routing.routes.onlyOffice.draining;
            return routing;
        })],
    ]) {
        const fixture = restartFixture();
        const transition = await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
        const result = successor(fixture);
        await change(fixture);
        assert.equal(drainProof(fixture, transition), false, label);
        const { calls, dependencies } = countingCommitDependencies(fixture, publishThroughFixture(fixture));
        await assert.rejects(commitTargetedAgentRestart(commitRequest(fixture, transition, result), dependencies), { code: 'TARGETED_RESTART_OWNERSHIP_LOST' }, label);
        assert.equal(calls.reopen, 0, label);
        assert.equal(calls.fallback, 0, label);
        assert.equal(fixture.registry[fixture.containerName].containerId, 'a'.repeat(64), label);
    }
});

test('a transition whose predecessor left the active registry is refused as an orphan', async () => {
    const fixture = restartFixture();
    const transition = await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
    const result = successor(fixture);
    fixture.dependencies.saveAgents({});
    assert.equal(drainProof(fixture, transition), false);
    const { calls, dependencies } = countingCommitDependencies(fixture, publishThroughFixture(fixture));
    await assert.rejects(commitTargetedAgentRestart(commitRequest(fixture, transition, result), dependencies), { code: 'TARGETED_RESTART_OWNERSHIP_LOST' });
    assert.deepEqual([calls.reopen, calls.fallback], [0, 0]);
});

test('the drain proof refuses an empty or foreign selector payload and a changed host selector', async () => {
    const fixture = restartFixture();
    const transition = await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
    const proof = (payload) => transition.targetedRestart.assertSelectorsInactive(payload);
    assert.equal(proof({ containerName: fixture.containerName, affectedSelectors: [] }), false);
    assert.equal(proof({ containerName: fixture.containerName }), false);
    assert.equal(proof({ containerName: 'another-container', affectedSelectors: transition.targetedRestart.affectedSelectors }), false);
    assert.equal(drainProof(fixture, transition), true);
    // A host selector added to the route after the drain is not proven inactive.
    const loadActive = fixture.dependencies.loadActive;
    const withExtraHost = () => {
        const active = loadActive();
        active.generation.compiled.hosts['late.example.test'] = { routeKey: 'onlyOffice' };
        return active;
    };
    const late = await prepareTargetedAgentRestart(restartRequest(fixture), { ...fixture.dependencies, loadActive: (() => {
        let calls = 0;
        return () => (++calls <= 2 ? loadActive() : withExtraHost());
    })() });
    assert.equal(drainProof(fixture, late), false);
});

test('reopen contention is retried with bounded backoff and then published', async () => {
    for (const [label, failures, expectedDelays] of [['two busy attempts', 2, [100, 250]], ['first attempt', 0, []]]) {
        const fixture = restartFixture();
        const transition = await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
        let remaining = failures;
        const publish = publishThroughFixture(fixture);
        const { calls, dependencies } = countingCommitDependencies(fixture, (...args) => {
            if (remaining > 0) { remaining -= 1; throw edgeError('EDGE_GENERATION_BUSY'); }
            return publish(...args);
        });
        await commitTargetedAgentRestart(commitRequest(fixture, transition), dependencies);
        assert.deepEqual(calls.delays, expectedDelays, label);
        assert.equal(calls.reopen, failures + 1, label);
        assert.equal(calls.fallback, 0, label);
        assert.equal(fixture.routing.routes.onlyOffice.draining, undefined, label);
        assert.equal(fixture.routing.routes.onlyOffice.hostPort, 53201, label);
        assert.equal(fixture.registry[fixture.containerName].containerId, 'b'.repeat(64), label);
    }
});

test('exhausted reopen contention fails without the inactive fallback', async () => {
    const fixture = restartFixture();
    const transition = await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
    const { calls, dependencies } = countingCommitDependencies(fixture, () => { throw edgeError('EDGE_GENERATION_BUSY'); });
    await assert.rejects(commitTargetedAgentRestart(commitRequest(fixture, transition), dependencies), { code: 'EDGE_GENERATION_BUSY' });
    assert.equal(calls.reopen, 6);
    assert.deepEqual(calls.delays, [100, 250, 500, 1000, 2000]);
    assert.equal(calls.fallback, 0);
    assert.equal(fixture.routing.routes.onlyOffice.draining, true);
    assert.equal(fixture.registry[fixture.containerName].containerId, 'a'.repeat(64));
});

test('exhausted reopen races that are not contention take the single inactive fallback', async () => {
    const fixture = restartFixture();
    const transition = await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
    const { calls, dependencies } = countingCommitDependencies(fixture, () => { throw edgeError('EDGE_GENERATION_RACE'); });
    await commitTargetedAgentRestart(commitRequest(fixture, transition), dependencies);
    assert.equal(calls.reopen, 6);
    assert.deepEqual(calls.delays, [100, 250, 500, 1000, 2000]);
    assert.equal(calls.fallback, 1);
    assert.equal(fixture.routing.routes.onlyOffice.hostPort, 53201);
});

test('a reopen refusal that is not contention takes exactly one inactive fallback without a retry', async () => {
    for (const error of [new Error('boom'), edgeError('EDGE_WITHDRAWAL_NOT_SUBSET'), edgeError('EDGE_WITHDRAWAL_NOT_DRAINED')]) {
        const fixture = restartFixture();
        const transition = await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
        const { calls, dependencies } = countingCommitDependencies(fixture, () => { throw error; });
        await commitTargetedAgentRestart(commitRequest(fixture, transition), dependencies);
        const label = error.code || error.message;
        assert.equal(calls.reopen, 1, label);
        assert.deepEqual(calls.delays, [], label);
        assert.equal(calls.fallback, 1, label);
        assert.equal(fixture.routing.routes.onlyOffice.draining, undefined, label);
        assert.equal(fixture.registry[fixture.containerName].containerId, 'b'.repeat(64), label);
    }
});

test('a reopen that selected the successor before failing is not retried or merged again', async () => {
    const fixture = restartFixture();
    const transition = await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
    const publish = publishThroughFixture(fixture);
    const { calls, dependencies } = countingCommitDependencies(fixture, async (...args) => {
        await publish(...args);
        throw edgeError('EDGE_PREPARATION_RACE');
    });
    await commitTargetedAgentRestart(commitRequest(fixture, transition), dependencies);
    assert.deepEqual([calls.reopen, calls.fallback, calls.delays.length], [1, 0, 0]);
    assert.equal(fixture.routing.routes.onlyOffice.hostPort, 53201);
    // A different port in the selected generation is not this publication.
    const other = restartFixture();
    const otherTransition = await prepareTargetedAgentRestart(restartRequest(other), other.dependencies);
    const otherPublish = publishThroughFixture(other);
    let published = false;
    const counted = countingCommitDependencies(other, async (transitionArg, buildRoute, result) => {
        // The real reopen refuses a route that is no longer draining.
        if (published) throw new Error('targeted agent restart route changed before successor commit');
        published = true;
        await otherPublish(transitionArg, () => ({ ...buildRoute(), hostPort: 59999 }), result);
        throw edgeError('EDGE_PREPARATION_RACE');
    });
    await assert.rejects(commitTargetedAgentRestart(commitRequest(other, otherTransition), counted.dependencies), /route changed before successor commit/);
    assert.equal(counted.calls.reopen, 2);
    assert.equal(counted.calls.fallback, 1);
});

test('ownership or supersession refused inside the reopen is terminal', async () => {
    for (const code of ['TARGETED_RESTART_OWNERSHIP_LOST', 'TARGETED_RESTART_SUPERSEDED']) {
        const fixture = restartFixture();
        const transition = await prepareTargetedAgentRestart(restartRequest(fixture), fixture.dependencies);
        const { calls, dependencies } = countingCommitDependencies(fixture, () => { throw edgeError(code); });
        await assert.rejects(commitTargetedAgentRestart(commitRequest(fixture, transition), dependencies), { code });
        assert.deepEqual([calls.reopen, calls.fallback, calls.delays.length], [1, 0, 0], code);
    }
});

test('the drain proof refuses a reopened or newly served route of the predecessor container', async () => {
    const secondary = (draining) => ({ repo: 'AssistOSExplorer', agent: 'onlyOffice', container: 'onlyoffice-container', hostPort: 43103, ...(draining ? { draining: true } : {}) });
    const addRoute = (fixture, route) => fixture.dependencies.mergeRouting((routing) => {
        routing.routes.secondary = route;
        return routing;
    });
    // A route of the container that was already served before the drain is
    // not a change: the proof holds as before.
    const served = restartFixture();
    await addRoute(served, secondary(false));
    const servedTransition = await prepareTargetedAgentRestart(restartRequest(served), served.dependencies);
    assert.equal(drainProof(served, servedTransition), true);

    // A served route attached to the container after the drain is refused.
    const added = restartFixture();
    const addedTransition = await prepareTargetedAgentRestart(restartRequest(added), added.dependencies);
    assert.equal(drainProof(added, addedTransition), true);
    await addRoute(added, secondary(false));
    assert.equal(drainProof(added, addedTransition), false);
    // A draining route attached to it is not a served one.
    await addRoute(added, secondary(true));
    assert.equal(drainProof(added, addedTransition), true);

    // A route of the container that was draining at the drain and reopens is refused.
    const reopened = restartFixture();
    await addRoute(reopened, secondary(true));
    const reopenedTransition = await prepareTargetedAgentRestart(restartRequest(reopened), reopened.dependencies);
    assert.equal(drainProof(reopened, reopenedTransition), true);
    await addRoute(reopened, secondary(false));
    assert.equal(drainProof(reopened, reopenedTransition), false);
});
