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

function faultRequest(fixture) {
    return {
        containerName: fixture.containerName,
        routeKey: 'onlyOffice',
        repoName: 'AssistOSExplorer',
        shortAgentName: 'onlyOffice',
        record: fixture.registry[fixture.containerName],
        networkLifecycleCapability: Object.freeze({ fixture: true }),
    };
}

test('test fault hooks: an inert hook leaves the real fallback merge options untouched', async () => {
    const fixture = restartFixture();
    const mergeOptions = [];
    let withdrawCalls = 0;
    let reopenCalls = 0;
    const dependencies = {
        ...fixture.dependencies,
        mergeRouting: async (mutator, options) => { mergeOptions.push(options); return fixture.dependencies.mergeRouting(mutator, options); },
        withdrawRoute: async () => { withdrawCalls += 1; throw new Error('unprovable'); },
        reopenRoute: async () => { reopenCalls += 1; throw new Error('unprovable'); },
        faultHooks: () => null,
    };
    const request = faultRequest(fixture);
    const transition = await prepareTargetedAgentRestart(request, dependencies);
    assert.equal(withdrawCalls, 1);
    assert.equal(mergeOptions.length, 1);
    assert.equal('holdInactiveMs' in mergeOptions[0], false);
    await commitTargetedAgentRestart({
        transition,
        result: { containerName: fixture.containerName, hostPort: 1, registryRecord: { ...request.record } },
        agentPath: '/workspace/agent',
        networkLifecycleCapability: request.networkLifecycleCapability,
    }, { ...dependencies, retireEntriesAfterApply: async () => {} });
    assert.equal(reopenCalls, 1);
    assert.equal(mergeOptions.length, 2);
    assert.equal('holdInactiveMs' in mergeOptions[1], false);
});

test('test fault hooks: forced unprovable withdrawal and reopen take the merge fallback with the hold', async () => {
    const fixture = restartFixture();
    const mergeOptions = [];
    let withdrawCalls = 0;
    let reopenCalls = 0;
    const stillActive = () => true;
    const hooks = { forceUnprovableWithdrawal: true, forceUnprovableReopen: true, holdInactiveMs: 1234 };
    Object.defineProperty(hooks, 'stillActive', { value: stillActive, enumerable: false });
    const dependencies = {
        ...fixture.dependencies,
        mergeRouting: async (mutator, options) => { mergeOptions.push(options); return fixture.dependencies.mergeRouting(mutator, options); },
        withdrawRoute: async () => { withdrawCalls += 1; return {}; },
        reopenRoute: async () => { reopenCalls += 1; return {}; },
        retireEntriesAfterApply: async () => {},
        faultHooks: () => hooks,
    };
    const request = faultRequest(fixture);
    const transition = await prepareTargetedAgentRestart(request, dependencies);
    assert.equal(withdrawCalls, 0);
    assert.equal(fixture.routing.routes.onlyOffice.draining, true);
    assert.equal(mergeOptions[0].holdInactiveMs, 1234);
    await commitTargetedAgentRestart({
        transition,
        result: { containerName: fixture.containerName, hostPort: 1, registryRecord: { ...request.record } },
        agentPath: '/workspace/agent',
        networkLifecycleCapability: request.networkLifecycleCapability,
    }, dependencies);
    assert.equal(reopenCalls, 0);
    assert.equal(mergeOptions.length, 2);
    assert.equal(mergeOptions[1].holdInactiveMs, 1234);
    assert.strictEqual(mergeOptions[0].holdContinues, stillActive);
    assert.strictEqual(mergeOptions[1].holdContinues, stillActive);
    assert.equal(fixture.routing.routes.onlyOffice.draining, undefined);
});
