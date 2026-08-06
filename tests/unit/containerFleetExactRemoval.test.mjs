import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    reconcileConfiguredProviderTaskOwnership,
    removeExactStoppedRegistryRecord,
    removeExactContainerAndDescriptor,
} from '../../cli/sandbox/docker/containerFleet.js';
import { NETWORK_LABELS } from '../../cli/sandbox/networkLifecycle.js';
import { NETWORK_SCHEMA_VERSION } from '../../cli/sandbox/networkContract.js';

const CONTAINER_ID = 'a'.repeat(64);
const NAME = 'ploinky_exact_agent';
const WORKSPACE_HASH = 'workspace-identity';

function registryRecord(overrides = {}) {
    return {
        type: 'agent',
        runtime: 'podman',
        containerId: CONTAINER_ID,
        instanceId: 'instance-exact',
        enableGeneration: 'generation-exact',
        config: { binds: [] },
        ...overrides,
    };
}

function inspectedRecord(overrides = {}) {
    return {
        Id: CONTAINER_ID,
        Name: `/${NAME}`,
        Config: {
            Labels: {
                [NETWORK_LABELS.managed]: '1',
                [NETWORK_LABELS.resource]: 'agent',
                [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
                [NETWORK_LABELS.workspace]: WORKSPACE_HASH,
                [NETWORK_LABELS.contract]: 'b'.repeat(64),
                [NETWORK_LABELS.instanceId]: 'instance-exact',
                [NETWORK_LABELS.enableGeneration]: 'generation-exact',
            },
        },
        HostConfig: { Init: true },
        Mounts: [],
        State: { Running: true },
        ...overrides,
    };
}

function runExact(record = registryRecord(), initial = inspectedRecord()) {
    let current = initial;
    const controls = [];
    let lockHeld = false;
    const result = removeExactContainerAndDescriptor(NAME, record, 'podman', {
        fast: true,
        inspect(runtime, identifier) {
            assert.equal(lockHeld, true);
            assert.equal(runtime, 'podman');
            assert.equal(identifier, CONTAINER_ID);
            return current;
        },
        control(runtime, args) {
            assert.equal(lockHeld, true);
            assert.equal(runtime, 'podman');
            controls.push(args);
            assert.equal(args.at(-1), CONTAINER_ID);
            if (args[0] === 'kill') current = { ...current, State: { Running: false } };
            if (args[0] === 'rm') current = null;
            return { status: 0 };
        },
        withLock(callback) {
            assert.equal(lockHeld, false);
            lockHeld = true;
            try { return callback(); } finally { lockHeld = false; }
        },
        pause() {},
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
        listProviderOwners: () => [],
    });
    return { result, controls };
}

test('fleet removal signals and removes only a revalidated immutable container ID under lock', () => {
    const { result, controls } = runExact();
    assert.deepEqual(result, { found: true, stopped: true, removed: true });
    assert.deepEqual(controls, [
        ['kill', '--signal', 'SIGTERM', CONTAINER_ID],
        ['rm', '-f', CONTAINER_ID],
    ]);
});

test('fleet removal refuses identity, ownership, init, and descriptor provenance drift before control', () => {
    const mutations = [
        { Id: 'c'.repeat(64) },
        { Name: '/foreign-same-name-replacement' },
        {
            Config: {
                Labels: {
                    ...inspectedRecord().Config.Labels,
                    [NETWORK_LABELS.workspace]: 'foreign-workspace',
                },
            },
        },
        {
            Config: {
                Labels: {
                    ...inspectedRecord().Config.Labels,
                    [NETWORK_LABELS.instanceId]: 'replacement-instance',
                },
            },
        },
        { HostConfig: { Init: false } },
        {
            Mounts: [{
                Source: '/tmp/unrecorded.json',
                Destination: '/run/ploinky/router-descriptor.json',
                RW: false,
            }],
        },
    ];
    for (const mutation of mutations) {
        let controls = 0;
        assert.throws(
            () => removeExactContainerAndDescriptor(
                NAME,
                registryRecord(),
                'podman',
                {
                    inspect: () => inspectedRecord(mutation),
                    control: () => { controls += 1; return { status: 0 }; },
                    withLock: (callback) => callback(),
                    workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
                    listProviderOwners: () => [],
                },
            ),
            /could not prove|unrecorded generated Router descriptor mount/,
        );
        assert.equal(controls, 0);
    }
});

test('fleet removal preserves absent, incomplete, and legacy registry targets', () => {
    let controls = 0;
    const absent = removeExactContainerAndDescriptor(NAME, registryRecord(), 'podman', {
        inspect: () => null,
        control: () => { controls += 1; return { status: 0 }; },
        withLock: (callback) => callback(),
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
        listProviderOwners: () => [],
    });
    assert.deepEqual(absent, { found: false, stopped: false, removed: false });
    assert.equal(controls, 0);

    for (const invalid of [
        registryRecord({ runtime: 'docker' }),
        registryRecord({ runtime: ' podman' }),
        registryRecord({ containerId: NAME }),
        registryRecord({ containerId: ` ${CONTAINER_ID}` }),
        registryRecord({ type: 'agentCore' }),
        registryRecord({ instanceId: '' }),
        registryRecord({ instanceId: ' instance-exact' }),
        registryRecord({ enableGeneration: '' }),
        registryRecord({ enableGeneration: 'generation-exact ' }),
    ]) {
        assert.throws(
            () => removeExactContainerAndDescriptor(NAME, invalid, 'podman'),
            /runtime must be exactly 'podman'|immutable registry container ID|complete managed-agent registry identity|current managed-agent registry record/,
        );
    }

    for (const runtime of ['docker', ' podman', 'podman ', '', undefined]) {
        assert.throws(
            () => removeExactContainerAndDescriptor(NAME, registryRecord(), runtime),
            /runtime must be exactly 'podman'/,
        );
    }
});

test('fleet bulk lifecycle contains no mutable-name signal/removal fallback', () => {
    const source = fs.readFileSync(
        new URL('../../cli/sandbox/docker/containerFleet.js', import.meta.url),
        'utf8',
    );
    const bulk = source.slice(
        source.indexOf('function stopAndRemoveMany('),
        source.indexOf('function stopAndRemove(', source.indexOf('function stopAndRemoveMany(')),
    );
    assert.doesNotMatch(bulk, /execSync\(/);
    assert.doesNotMatch(bulk, /\['rm', '-f', name\]/);
    assert.match(bulk, /removeExactContainerAndDescriptor\(name, record, 'podman'/);
    assert.doesNotMatch(bulk, /getRuntime\(|probeContainerRuntime\(/);
});

test('container task owners are removed only after immutable containment and before descriptors', () => {
    const source = fs.readFileSync(
        new URL('../../cli/sandbox/docker/containerFleet.js', import.meta.url),
        'utf8',
    );
    const start = source.indexOf('function removeExactContainerAndDescriptor(');
    const end = source.indexOf('\nfunction removeExactRegisteredContainer(', start);
    const lifecycle = source.slice(start, end);
    assert.ok(lifecycle.indexOf("control(runtime, ['kill', '--signal', 'SIGTERM', expectedId])")
        < lifecycle.indexOf('clearContainedProviderOwners();'));
    assert.ok(lifecycle.indexOf('clearContainedProviderOwners();')
        < lifecycle.indexOf("control(runtime, ['rm', '-f', expectedId])"));
    assert.doesNotMatch(lifecycle, /process\.kill\s*\(/);
});

test('Box stop removes only the exact stopped nested-container registry record', () => {
    const record = registryRecord();
    const registry = { [NAME]: record, unrelated: { type: 'agent', runtime: 'bwrap' } };
    let saved;
    assert.equal(removeExactStoppedRegistryRecord(NAME, record, {
        loadRegistry: () => structuredClone(registry),
        saveRegistry(next, options) { saved = { next, options }; },
    }), true);
    assert.deepEqual(saved, {
        next: { unrelated: { type: 'agent', runtime: 'bwrap' } },
        options: { coordinate: false },
    });
    assert.throws(() => removeExactStoppedRegistryRecord(NAME, record, {
        loadRegistry: () => ({ [NAME]: { ...record, enableGeneration: 'replacement' } }),
        saveRegistry() { assert.fail('drifted registry must not be written'); },
    }), /identity changed/);
});

test('production reconciliation fails closed for durable corrupt, mixed, PID-reused, stale, and uncontained evidence', () => {
    const owner = { ownerKey: 'provider-owner' };
    const run = (classification, overrides = {}) => reconcileConfiguredProviderTaskOwnership({
        registry: {},
        collectProviderOwners: () => [owner],
        collectRuntimeStates: () => [],
        reconcileProviderOwners: () => [{ classification }],
        ...overrides,
    });
    assert.deepEqual(run('live'), [{ classification: 'live' }]);
    let removedTerminal = null;
    assert.deepEqual(run('terminal', {
        removeTerminalOwner(entry) { removedTerminal = entry; },
    }), [{ classification: 'terminal' }]);
    assert.deepEqual(removedTerminal, { classification: 'terminal' });
    for (const classification of [
        'mixed-generation', 'pid-reused', 'stale', 'parent-contained',
    ]) {
        assert.throws(
            () => run(classification),
            (error) => error?.code === 'PLOINKY_PROVIDER_TASK_LIFECYCLE_UNRECONCILED'
                && error.classifications.includes(classification),
        );
    }
    assert.throws(
        () => run('live', {
            collectProviderOwners() { throw new Error('secret corrupt path'); },
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_TASK_LIFECYCLE_UNRECONCILED'
            && error.classifications.includes('corrupt')
            && !error.message.includes('secret corrupt path'),
    );
});
