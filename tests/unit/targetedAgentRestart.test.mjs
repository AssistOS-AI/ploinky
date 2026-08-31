import assert from 'node:assert/strict';
import test from 'node:test';

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
