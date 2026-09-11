import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRuntimeCandidate, retireRuntimeCandidate, writeRuntimeCandidate } from '../../cli/sandbox/runtimeCandidateStore.js';

import {
    cleanupFailedTargetedAgentRestart,
    commitTargetedAgentRestart,
    prepareTargetedAgentRestart,
} from '../../cli/commands/targetedAgentRestart.js';

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
        routing = await mutator(candidate) || candidate;
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
