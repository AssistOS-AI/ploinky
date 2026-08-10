import assert from 'node:assert/strict';
import test from 'node:test';

import {
    inspectExactContainerById,
    proveExactOciLogSource,
} from '../../cli/sandbox/docker/containerOwnership.js';
import { NETWORK_LABELS } from '../../cli/sandbox/networkLifecycle.js';
import { NETWORK_SCHEMA_VERSION } from '../../cli/sandbox/networkContract.js';

const CONTAINER_NAME = 'ploinky_demo_shared';
const CONTAINER_ID = 'a'.repeat(64);
const CONTRACT_HASH = 'b'.repeat(64);
const WORKSPACE_HASH = 'c1d2e3f40506';
const INSTANCE_ID = 'instance-0001';
const ENABLE_GENERATION = 'generation-0001';

function record(overrides = {}) {
    return {
        type: 'agent',
        runtime: 'podman',
        containerId: CONTAINER_ID,
        instanceId: INSTANCE_ID,
        enableGeneration: ENABLE_GENERATION,
        agentName: 'shared',
        repoName: 'demo',
        ...overrides,
    };
}

function inspected({ labels = {}, running = true, ...overrides } = {}) {
    return {
        Id: CONTAINER_ID,
        Name: `/${CONTAINER_NAME}`,
        State: { Running: running },
        HostConfig: { Init: true },
        Config: {
            Labels: {
                [NETWORK_LABELS.managed]: '1',
                [NETWORK_LABELS.resource]: 'agent',
                [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
                [NETWORK_LABELS.workspace]: WORKSPACE_HASH,
                [NETWORK_LABELS.contract]: CONTRACT_HASH,
                [NETWORK_LABELS.instanceId]: INSTANCE_ID,
                [NETWORK_LABELS.enableGeneration]: ENABLE_GENERATION,
                ...labels,
            },
        },
        ...overrides,
    };
}

function prove(agentRecord, inspectResult, { calls = [] } = {}) {
    return proveExactOciLogSource(CONTAINER_NAME, agentRecord, {
        inspect: (runtime, identifier) => {
            calls.push([runtime, identifier]);
            return typeof inspectResult === 'function' ? inspectResult(runtime, identifier) : inspectResult;
        },
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH, canonical: '/workspace' }),
    });
}

test('a proved running container is inspected only by its immutable id', () => {
    const calls = [];
    const source = prove(record(), inspected({ running: true }), { calls });
    assert.deepEqual(source, { runtime: 'podman', containerId: CONTAINER_ID, running: true });
    // Exactly one inspection, addressed by the recorded runtime and id -- never
    // by name and never a discovery sweep.
    assert.deepEqual(calls, [['podman', CONTAINER_ID]]);
});

test('a proved stopped container remains retrievable', () => {
    const source = prove(record({ runtime: 'docker' }), inspected({ running: false }));
    assert.deepEqual(source, { runtime: 'docker', containerId: CONTAINER_ID, running: false });
});

test('a missing container is not retrievable and is not repaired', () => {
    const calls = [];
    assert.throws(
        () => prove(record(), null, { calls }),
        (error) => error.code === 'CONTAINER_OWNERSHIP_UNPROVEN'
            && /no longer exists/.test(error.message),
    );
    assert.deepEqual(calls, [['podman', CONTAINER_ID]]);
});

test('an unsupported or malformed registry identity fails before any inspection', () => {
    const cases = [
        ['not an agent record', record({ type: 'skill' })],
        ['unsupported runtime bwrap', record({ runtime: 'bwrap' })],
        ['unsupported runtime seatbelt', record({ runtime: 'seatbelt' })],
        ['absent runtime', record({ runtime: '' })],
        ['uppercase runtime', record({ runtime: 'Podman' })],
        ['short container id', record({ containerId: 'a'.repeat(63) })],
        ['uppercase container id', record({ containerId: 'A'.repeat(64) })],
        ['name instead of id', record({ containerId: CONTAINER_NAME })],
        ['absent container id', record({ containerId: '' })],
        ['absent instance id', record({ instanceId: '   ' })],
        ['numeric instance id', record({ instanceId: 123 })],
        ['padded instance id', record({ instanceId: ` ${INSTANCE_ID}` })],
        ['absent enable generation', record({ enableGeneration: '' })],
        ['numeric enable generation', record({ enableGeneration: 123 })],
    ];
    for (const [label, candidate] of cases) {
        const calls = [];
        assert.throws(
            () => prove(candidate, inspected(), { calls }),
            (error) => error.code === 'CONTAINER_OWNERSHIP_UNPROVEN',
            label,
        );
        // Nothing is spawned until the registry identity itself is exact.
        assert.deepEqual(calls, [], `${label} must not inspect`);
    }
});

test('a foreign id, name, or workspace fails the ownership proof', () => {
    const cases = [
        ['foreign inspected id', inspected({ Id: 'd'.repeat(64) })],
        ['foreign container name', inspected({ Name: '/ploinky_other_agent' })],
        ['foreign workspace label', inspected({ labels: { [NETWORK_LABELS.workspace]: 'ffffffffffff' } })],
    ];
    for (const [label, result] of cases) {
        assert.throws(
            () => prove(record(), result),
            (error) => error.code === 'CONTAINER_OWNERSHIP_UNPROVEN',
            label,
        );
    }
});

test('every managed ownership label and the init setting are required', () => {
    const cases = [
        ['unmanaged', inspected({ labels: { [NETWORK_LABELS.managed]: '0' } })],
        ['wrong resource', inspected({ labels: { [NETWORK_LABELS.resource]: 'network' } })],
        ['wrong schema', inspected({ labels: { [NETWORK_LABELS.schema]: 'v0-unsupported' } })],
        ['malformed contract', inspected({ labels: { [NETWORK_LABELS.contract]: 'not-a-hash' } })],
        ['absent contract', inspected({ labels: { [NETWORK_LABELS.contract]: '' } })],
        ['missing init', inspected({ HostConfig: { Init: false } })],
        ['absent host config', inspected({ HostConfig: undefined })],
    ];
    for (const [label, result] of cases) {
        assert.throws(
            () => prove(record(), result),
            (error) => error.code === 'CONTAINER_OWNERSHIP_UNPROVEN'
                && /managed ownership labels/.test(error.message),
            label,
        );
    }
});

test('a staged predecessor cannot pass as the new generation', () => {
    // Staging spreads the predecessor record and rotates only the tuple, so the
    // container still carries the predecessor's instance and generation labels.
    const staged = record({ instanceId: 'instance-0002', enableGeneration: 'generation-0002' });
    assert.throws(
        () => prove(staged, inspected()),
        (error) => error.code === 'CONTAINER_OWNERSHIP_UNPROVEN'
            && /managed ownership labels/.test(error.message),
    );

    // The reverse mismatch -- a rotated container under an old record -- fails too.
    assert.throws(
        () => prove(record(), inspected({
            labels: {
                [NETWORK_LABELS.instanceId]: 'instance-0002',
                [NETWORK_LABELS.enableGeneration]: 'generation-0002',
            },
        })),
        (error) => error.code === 'CONTAINER_OWNERSHIP_UNPROVEN',
    );
});

test('an unresolvable workspace identity fails closed', () => {
    assert.throws(
        () => proveExactOciLogSource(CONTAINER_NAME, record(), {
            inspect: () => inspected(),
            workspaceIdentity: () => ({ hash: '' }),
        }),
        (error) => error.code === 'CONTAINER_OWNERSHIP_UNPROVEN'
            && /workspace identity/.test(error.message),
    );
});

test('inspection is a fixed argument array and tolerates a nonzero engine status', () => {
    const spawned = [];
    const absent = inspectExactContainerById('podman', CONTAINER_ID, {
        spawnSyncImpl: (command, args, options) => {
            spawned.push({ command, args, options });
            return { status: 1, stdout: '', stderr: 'no such container' };
        },
    });
    assert.equal(absent, null);
    assert.equal(spawned[0].command, 'podman');
    assert.deepEqual(spawned[0].args, ['container', 'inspect', CONTAINER_ID]);

    const parsed = inspectExactContainerById('docker', CONTAINER_ID, {
        spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify([inspected()]) }),
    });
    assert.equal(parsed.Id, CONTAINER_ID);

    assert.throws(
        () => inspectExactContainerById('docker', CONTAINER_ID, {
            spawnSyncImpl: () => ({
                status: 0,
                stdout: '{"Config":{"Env":["TOKEN=must-not-leak"]}',
            }),
        }),
        (error) => error.code === 'CONTAINER_OWNERSHIP_UNPROVEN'
            && /malformed JSON/.test(error.message)
            && !error.message.includes('must-not-leak'),
    );
});
