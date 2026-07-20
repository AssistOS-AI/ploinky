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
        instanceId: oldIdentity.instanceId,
        enableGeneration: oldIdentity.enableGeneration,
        config: { ports: [] },
    };
}

function rotationHarness(reason, request = {}) {
    let registry = { [containerName]: existingRecord() };
    const events = [];
    const minted = [`instance-new-${reason}`, `enable-new-${reason}`];
    const dependencies = {
        withApplyLock: (callback) => callback(Object.freeze({})),
        inactivate: (value) => {
            events.push(`inactivate:${value}`);
        },
        loadRegistry: () => {
            events.push('load');
            return structuredClone(registry);
        },
        saveRegistry: (value) => {
            events.push('save');
            registry = structuredClone(value);
        },
        prepare: ({ reason: preparedReason }) => {
            events.push(`prepare:${preparedReason}`);
            return {
                selector: { state: 'inactive' },
                generation: { agents: structuredClone(registry) },
            };
        },
        uuid: () => minted.shift(),
    };
    const runtimeIdentity = resolveReplacementRuntimeIdentity({
        containerName,
        existingRecord: existingRecord(),
        existingRuntime: true,
        recreateReason: reason,
        ...request,
    }, dependencies);
    return { dependencies, events, registry, runtimeIdentity };
}

test('every ordinary existing-container recreate rotates both identities before physical replacement', () => {
    for (const reason of [
        'forceRecreate',
        'envHashChanged',
        'networkContractDrift',
        'serviceTargetMappingChanged',
    ]) {
        const { events, registry, runtimeIdentity } = rotationHarness(reason);
        assert.notEqual(runtimeIdentity.instanceId, oldIdentity.instanceId, reason);
        assert.notEqual(runtimeIdentity.enableGeneration, oldIdentity.enableGeneration, reason);
        assert.equal(registry[containerName].instanceId, runtimeIdentity.instanceId, reason);
        assert.equal(registry[containerName].enableGeneration, runtimeIdentity.enableGeneration, reason);
        assert.deepEqual(events.map((entry) => entry.split(':')[0]), [
            'inactivate',
            'load',
            'save',
            'prepare',
        ], reason);
    }
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
    const { registry, runtimeIdentity } = rotationHarness('envHashChanged');
    const body = Buffer.from('{"room":"fixture"}');
    const pathname = '/services/private-api/rooms';
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
    const currentCaller = {
        ...oldIdentity,
        instanceId: runtimeIdentity.instanceId,
        enableGeneration: runtimeIdentity.enableGeneration,
    };
    const plan = {
        ok: true,
        listener: 'private',
        kind: 'service',
        pathname,
        parsedUrl: new URL(`http://host.containers.internal${pathname}`),
        definition: { routeKey: 'private-owner', slug: 'private-api' },
        decision: { access: 'authenticated' },
        snapshot: {
            agents: registry,
            compiled: {
                security: {
                    internalServiceConsumers: [{
                        routeKey: 'private-owner',
                        slug: 'private-api',
                        canonicalPrefix: '/services/private-api/',
                        callers: [currentCaller],
                    }],
                },
            },
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

test('failed coordinated prepare retains the new candidate tuple and leaves the selector inactive', () => {
    let registry = { [containerName]: existingRecord() };
    const inactivations = [];
    assert.throws(() => resolveReplacementRuntimeIdentity({
        containerName,
        existingRecord: existingRecord(),
        existingRuntime: true,
        recreateReason: 'networkContractDrift',
    }, {
        inactivate: (reason) => inactivations.push(reason),
        loadRegistry: () => structuredClone(registry),
        saveRegistry: (value) => { registry = structuredClone(value); },
        prepare: () => { throw new Error('candidate rejected'); },
        uuid: (() => {
            const values = ['instance-failed-candidate', 'enable-failed-candidate'];
            return () => values.shift();
        })(),
    }), /candidate rejected/);
    assert.equal(registry[containerName].instanceId, 'instance-failed-candidate');
    assert.equal(registry[containerName].enableGeneration, 'enable-failed-candidate');
    assert.equal(inactivations.length, 2);
    assert.match(inactivations[1], /prepare-failed/);
});
