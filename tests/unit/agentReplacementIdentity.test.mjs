import test from 'node:test';
import assert from 'node:assert/strict';

import { signPrivateRouterAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { authorizePrivateRoutePlan } from '../../cli/server/privateRouter.js';
import {
    resolveReplacementRuntimeIdentity,
} from '../../cli/sandbox/docker/agentServiceManager.js';
import { derivePrivateAgentRequestSecret } from '../../cli/utils/security/masterKey.js';

const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_MASTER_KEY = '9'.repeat(64);
test.after(() => {
    if (previousMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousMasterKey;
});

const containerName = 'fixture-runtime';
const oldIdentity = Object.freeze({
    agentId: 'agent:fixtures/caller',
    instanceId: 'instance-old',
    enableGeneration: 'enable-old',
    routeKey: 'caller',
});

function existingRecord() {
    return {
        type: 'agent',
        repoName: 'fixtures',
        agentName: 'caller',
        profile: 'qa-profile',
        instanceId: oldIdentity.instanceId,
        enableGeneration: oldIdentity.enableGeneration,
        config: { ports: [] },
    };
}

function rotationHarness(reason, request = {}) {
    let registry = { [containerName]: existingRecord() };
    let preparedRegistry = null;
    let preparedRouting = null;
    const events = [];
    const networkLifecycleCapability = Object.freeze({ fixture: 'network-capability' });
    const minted = [`instance-new-${reason}`, `enable-new-${reason}`];
    const dependencies = {
        assertNetworkCapability: (received) => {
            assert.equal(received, networkLifecycleCapability);
            events.push('network-capability');
        },
        withApplyLock: (callback) => callback(Object.freeze({})),
        loadRegistry: () => {
            events.push('load');
            return structuredClone(registry);
        },
        loadRouting: () => ({ routes: { caller: { container: containerName } } }),
        prepare: ({ agents, routing, reason: preparedReason }) => {
            events.push(`prepare:${preparedReason}`);
            preparedRegistry = structuredClone(agents);
            preparedRouting = structuredClone(routing);
            return {
                selector: { state: 'active', generation: 'active-predecessor' },
                preparationLease: {
                    mode: 'additive',
                    transactionId: `lease-${reason}`,
                    predecessorGeneration: 'active-predecessor',
                    preparedGeneration: `candidate-${reason}`,
                },
                generation: { agents: structuredClone(agents) },
            };
        },
        uuid: () => minted.shift(),
    };
    const runtimeIdentity = resolveReplacementRuntimeIdentity({
        containerName,
        existingRecord: existingRecord(),
        existingRuntime: true,
        recreateReason: reason,
        networkLifecycleCapability,
        stageAlongsidePredecessor: true,
        ...request,
    }, dependencies);
    return { dependencies, events, registry, preparedRegistry, preparedRouting, runtimeIdentity };
}

test('every ordinary existing-container recreate stages a fresh additive identity while its predecessor remains active', () => {
    for (const reason of [
        'forceRecreate',
        'envHashChanged',
        'networkContractDrift',
        'serviceTargetMappingChanged',
    ]) {
        const { events, registry, preparedRegistry, preparedRouting, runtimeIdentity } = rotationHarness(reason);
        const candidateName = runtimeIdentity.candidateContainerName;
        assert.notEqual(runtimeIdentity.instanceId, oldIdentity.instanceId, reason);
        assert.notEqual(runtimeIdentity.enableGeneration, oldIdentity.enableGeneration, reason);
        assert.equal(runtimeIdentity.preparationLease.mode, 'additive', reason);
        assert.notEqual(candidateName, containerName, reason);
        assert.equal(runtimeIdentity.predecessorContainerName, containerName, reason);
        assert.equal(registry[containerName].instanceId, oldIdentity.instanceId, reason);
        assert.equal(registry[containerName].enableGeneration, oldIdentity.enableGeneration, reason);
        assert.equal(preparedRegistry[containerName], undefined, reason);
        assert.equal(preparedRegistry[candidateName].instanceId, runtimeIdentity.instanceId, reason);
        assert.equal(preparedRegistry[candidateName].enableGeneration, runtimeIdentity.enableGeneration, reason);
        assert.equal(preparedRouting.routes.caller.container, candidateName, reason);
        assert.deepEqual(runtimeIdentity.preparedRegistryRecord, preparedRegistry[candidateName], reason);
        assert.deepEqual(events.map((entry) => entry.split(':')[0]), [
            'network-capability',
            'load',
            'prepare',
        ], reason);
    }
});

test('replacement paths that cannot stage a second physical runtime retain the inactive same-name contract', () => {
    let registry = { [containerName]: existingRecord() };
    const events = [];
    const networkLifecycleCapability = Object.freeze({ fixture: 'network-capability' });
    const values = ['instance-unmanaged-candidate', 'enable-unmanaged-candidate'];
    const runtimeIdentity = resolveReplacementRuntimeIdentity({
        containerName,
        existingRecord: existingRecord(),
        existingRuntime: true,
        recreateReason: 'sandboxRuntimeStopped',
        networkLifecycleCapability,
        stageAlongsidePredecessor: false,
    }, {
        assertNetworkCapability: (received) => {
            assert.equal(received, networkLifecycleCapability);
            events.push('network-capability');
        },
        withApplyLock: (callback) => callback(Object.freeze({})),
        inactivate: () => events.push('inactivate'),
        loadRegistry: () => {
            events.push('load');
            return structuredClone(registry);
        },
        saveRegistry: (next) => {
            events.push('save');
            registry = structuredClone(next);
        },
        prepareReplacement: () => {
            events.push('prepare-replacement');
            return {
                selector: { state: 'inactive' },
                preparationLease: { mode: 'replacement', transactionId: 'unmanaged-lease' },
                generation: { agents: structuredClone(registry) },
            };
        },
        prepare: () => assert.fail('same-name replacement must not use additive preparation'),
        loadRouting: () => assert.fail('same-name replacement must not rewrite routes additively'),
        uuid: () => values.shift(),
    });

    assert.equal(runtimeIdentity.candidateContainerName, containerName);
    assert.equal(runtimeIdentity.predecessorContainerName, containerName);
    assert.equal(runtimeIdentity.instanceId, 'instance-unmanaged-candidate');
    assert.equal(runtimeIdentity.enableGeneration, 'enable-unmanaged-candidate');
    assert.equal(registry[containerName].instanceId, runtimeIdentity.instanceId);
    assert.equal(registry[containerName].enableGeneration, runtimeIdentity.enableGeneration);
    assert.deepEqual(runtimeIdentity.preparedRegistryRecord, registry[containerName]);
    assert.deepEqual(events, [
        'network-capability',
        'inactivate',
        'load',
        'save',
        'prepare-replacement',
    ]);
});

test('inactive health recovery stages a distinct successor without requiring active authorization', () => {
    let registry = { [containerName]: existingRecord() };
    let routing = { routes: { caller: { container: containerName } } };
    const events = [];
    const networkLifecycleCapability = Object.freeze({ fixture: 'network-capability' });
    const values = ['instance-health-candidate', 'enable-health-candidate'];
    const runtimeIdentity = resolveReplacementRuntimeIdentity({
        containerName,
        existingRecord: existingRecord(),
        existingRuntime: true,
        recreateReason: 'semantic_probe_failed',
        networkLifecycleCapability,
        stageAlongsidePredecessor: true,
        preserveActiveAuthorization: false,
    }, {
        assertNetworkCapability: (received) => {
            assert.equal(received, networkLifecycleCapability);
            events.push('network-capability');
        },
        withApplyLock: (callback) => callback(Object.freeze({})),
        inactivate: () => events.push('inactivate'),
        loadRegistry: () => {
            events.push('load');
            return structuredClone(registry);
        },
        loadRouting: () => structuredClone(routing),
        saveRegistry: (next) => {
            events.push('save-registry');
            registry = structuredClone(next);
        },
        saveRouting: (next) => {
            events.push('save-routing');
            routing = structuredClone(next);
        },
        prepareReplacement: () => {
            events.push('prepare-replacement');
            return {
                selector: { state: 'inactive' },
                preparationLease: { mode: 'replacement', transactionId: 'health-lease' },
                generation: { agents: structuredClone(registry) },
            };
        },
        prepare: () => assert.fail('inactive recovery must not require additive preparation'),
        uuid: () => values.shift(),
    });

    const candidateName = runtimeIdentity.candidateContainerName;
    assert.notEqual(candidateName, containerName);
    assert.equal(runtimeIdentity.predecessorContainerName, containerName);
    assert.equal(runtimeIdentity.preparationLease.mode, 'replacement');
    assert.equal(registry[containerName], undefined);
    assert.equal(registry[candidateName].instanceId, 'instance-health-candidate');
    assert.equal(registry[candidateName].enableGeneration, 'enable-health-candidate');
    assert.equal(routing.routes.caller.container, candidateName);
    assert.deepEqual(runtimeIdentity.preparedRegistryRecord, registry[candidateName]);
    assert.deepEqual(events, [
        'network-capability',
        'inactivate',
        'load',
        'save-registry',
        'save-routing',
        'prepare-replacement',
    ]);
});

test('ordinary exact runtime reuse preserves the registered tuple without coordination or minting', () => {
    const staged = existingRecord();
    assert.deepEqual(resolveReplacementRuntimeIdentity({
        containerName,
        existingRecord: staged,
        existingRuntime: true,
        recreateReason: null,
    }, {
        inactivate: () => assert.fail('exact reuse must not inactivate'),
        loadRegistry: () => assert.fail('exact reuse must not reload registry state'),
        saveRegistry: () => assert.fail('exact reuse must not rewrite registry state'),
        prepare: () => assert.fail('exact reuse must not prepare a replacement'),
        uuid: () => assert.fail('exact reuse must not mint a new tuple'),
    }), {
        instanceId: oldIdentity.instanceId,
        enableGeneration: oldIdentity.enableGeneration,
    });
});

test('an assertion from the predecessor tuple is stale after coordinated replacement rotation', () => {
    const { preparedRegistry } = rotationHarness('envHashChanged');
    const body = Buffer.from('{"room":"fixture"}');
    const pathname = '/base-agent-additional-server/private-owner/7000/private/rooms';
    const token = signPrivateRouterAssertion({
        method: 'POST',
        path: pathname,
        body,
        env: {
            PLOINKY_AGENT_ID: oldIdentity.agentId,
            PLOINKY_AGENT_INSTANCE_ID: oldIdentity.instanceId,
            PLOINKY_AGENT_ENABLE_GENERATION: oldIdentity.enableGeneration,
            PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(
                oldIdentity.agentId,
                oldIdentity.instanceId,
                oldIdentity.enableGeneration,
            ),
        },
    });
    const plan = {
        ok: true,
        listener: 'private',
        kind: 'agent-port',
        routeKey: 'private-owner',
        pathname,
        parsedUrl: new URL(`http://host.containers.internal${pathname}`),
        access: { access: 'authenticated' },
        snapshot: {
            agents: preparedRegistry,
            compiled: { security: {} },
        },
    };

    assert.throws(() => authorizePrivateRoutePlan({
        req: { method: 'POST', headers: { 'ploinky-agent-assertion': token } },
        plan,
        body,
        assertionCache: createMemoryReplayCache(),
    }), (error) => error.code === 'PRIVATE_ASSERTION_REJECTED' && /stale/.test(error.message));
});

test('an exact prepared launch retains its staged tuple whether or not the predecessor process still exists', () => {
    const staged = existingRecord();
    const noCoordination = {
        inactivate: () => assert.fail('fresh prepared launch must not coordinate a replacement'),
        loadRegistry: () => assert.fail('fresh prepared launch must not load replacement state'),
        saveRegistry: () => assert.fail('fresh prepared launch must not persist a replacement tuple'),
        prepare: () => assert.fail('fresh prepared launch must not prepare a replacement generation'),
        uuid: () => assert.fail('fresh prepared launch must retain its staged tuple'),
    };
    assert.deepEqual(resolveReplacementRuntimeIdentity({
        containerName,
        existingRecord: staged,
        existingRuntime: false,
        recreateReason: 'forceRecreate',
        preservePreparedRegistryRecord: true,
        requestedInstanceId: staged.instanceId,
        requestedEnableGeneration: staged.enableGeneration,
    }, noCoordination), {
        instanceId: staged.instanceId,
        enableGeneration: staged.enableGeneration,
    });

    assert.deepEqual(resolveReplacementRuntimeIdentity({
        containerName,
        existingRecord: staged,
        existingRuntime: true,
        recreateReason: 'forceRecreate',
        preservePreparedRegistryRecord: true,
        requestedInstanceId: staged.instanceId,
        requestedEnableGeneration: staged.enableGeneration,
    }, noCoordination), {
        instanceId: staged.instanceId,
        enableGeneration: staged.enableGeneration,
    });
});

test('an unprepared first launch cannot inject a caller-selected runtime tuple', () => {
    const values = ['instance-runtime-minted', 'enable-runtime-minted'];
    assert.deepEqual(resolveReplacementRuntimeIdentity({
        containerName,
        existingRecord: {},
        existingRuntime: false,
        requestedInstanceId: 'caller-selected-instance',
        requestedEnableGeneration: 'caller-selected-generation',
    }, {
        uuid: () => values.shift(),
    }), {
        instanceId: 'instance-runtime-minted',
        enableGeneration: 'enable-runtime-minted',
    });
});

test('the explicit targeted restart contract preserves its captured tuple', () => {
    const staged = existingRecord();
    const noCoordination = {
        inactivate: () => assert.fail('targeted restart is already coordinated by its selected generation'),
        loadRegistry: () => assert.fail('targeted restart must not rotate registry identity'),
        saveRegistry: () => assert.fail('targeted restart must not rotate registry identity'),
        prepare: () => assert.fail('targeted restart must not install a second generation'),
        uuid: () => assert.fail('targeted restart must retain its exact owner tuple'),
    };
    assert.deepEqual(resolveReplacementRuntimeIdentity({
        containerName,
        existingRecord: staged,
        existingRuntime: true,
        recreateReason: 'targetedRestart',
        targetedRestart: true,
        requestedInstanceId: staged.instanceId,
        requestedEnableGeneration: staged.enableGeneration,
    }, noCoordination), {
        instanceId: staged.instanceId,
        enableGeneration: staged.enableGeneration,
    });
});

test('failed coordinated prepare leaves the active predecessor registry untouched', () => {
    const registry = { [containerName]: existingRecord() };
    const networkLifecycleCapability = Object.freeze({ fixture: 'network-capability' });
    assert.throws(() => resolveReplacementRuntimeIdentity({
        containerName,
        existingRecord: existingRecord(),
        existingRuntime: true,
        recreateReason: 'networkContractDrift',
        networkLifecycleCapability,
        stageAlongsidePredecessor: true,
    }, {
        assertNetworkCapability: (received) => assert.equal(received, networkLifecycleCapability),
        withApplyLock: (callback) => callback(Object.freeze({})),
        loadRegistry: () => structuredClone(registry),
        loadRouting: () => ({ routes: { caller: { container: containerName } } }),
        prepare: () => { throw new Error('candidate rejected'); },
        uuid: (() => {
            const values = ['instance-failed-candidate', 'enable-failed-candidate'];
            return () => values.shift();
        })(),
    }), /candidate rejected/);
    assert.equal(registry[containerName].instanceId, oldIdentity.instanceId);
    assert.equal(registry[containerName].enableGeneration, oldIdentity.enableGeneration);
});

test('coordinated replacement rejects a missing network capability before mutation', () => {
    assert.throws(() => resolveReplacementRuntimeIdentity({
        containerName,
        existingRecord: existingRecord(),
        existingRuntime: true,
        recreateReason: 'envHashChanged',
    }, {
        assertNetworkCapability: (received) => {
            assert.equal(received, undefined);
            throw new Error('network lifecycle capability required');
        },
        inactivate: () => assert.fail('must reject before edge mutation'),
        loadRegistry: () => assert.fail('must reject before registry access'),
        saveRegistry: () => assert.fail('must reject before registry mutation'),
        prepare: () => assert.fail('must reject before generation preparation'),
    }), /network lifecycle capability required/);
});
