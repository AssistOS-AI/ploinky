import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    removeExactContainerAndDescriptor,
} from '../../cli/sandbox/docker/containerFleet.js';
import { NETWORK_LABELS } from '../../cli/sandbox/networkLifecycle.js';
import { NETWORK_SCHEMA_VERSION } from '../../cli/sandbox/networkContract.js';
import { PLOINKY_DIR } from '../../cli/utils/config.js';

const CONTAINER_ID = 'a'.repeat(64);
const NAME = 'ploinky_exact_agent';
const WORKSPACE_HASH = 'workspace-identity';
const MISSING_DESCRIPTOR = path.join(
    PLOINKY_DIR,
    'run',
    'router-descriptors',
    '00000000-0000-4000-8000-000000000000.json',
);

function recordWithMissingDescriptor() {
    return registryRecord({
        config: {
            binds: [{
                source: MISSING_DESCRIPTOR,
                target: '/run/ploinky/router-descriptor.json',
                generatedRouterDescriptor: true,
                ro: true,
            }],
        },
    });
}

function registryRecord(overrides = {}) {
    return {
        type: 'agent',
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
    });
    assert.deepEqual(absent, { found: false, stopped: false, removed: false });
    assert.equal(controls, 0);

    for (const invalid of [
        registryRecord({ containerId: NAME }),
        registryRecord({ type: 'agentCore' }),
        registryRecord({ instanceId: '' }),
        registryRecord({ enableGeneration: '' }),
    ]) {
        assert.throws(
            () => removeExactContainerAndDescriptor(NAME, invalid, 'podman'),
            /immutable registry container ID|complete managed-agent registry identity/,
        );
    }
});

test('absent immutable container preserves a dangling recorded descriptor without inspecting it', () => {
    assert.equal(fs.existsSync(MISSING_DESCRIPTOR), false);
    let controls = 0;
    const result = removeExactContainerAndDescriptor(
        NAME,
        recordWithMissingDescriptor(),
        'podman',
        {
            inspect: () => null,
            control: () => { controls += 1; return { status: 0 }; },
            withLock: (callback) => callback(),
            workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
        },
    );
    assert.deepEqual(result, { found: false, stopped: false, removed: false });
    assert.equal(controls, 0);
});

test('present immutable container with a missing recorded descriptor fails before control', () => {
    assert.equal(fs.existsSync(MISSING_DESCRIPTOR), false);
    let controls = 0;
    assert.throws(
        () => removeExactContainerAndDescriptor(
            NAME,
            recordWithMissingDescriptor(),
            'podman',
            {
                inspect: () => inspectedRecord(),
                control: () => { controls += 1; return { status: 0 }; },
                withLock: (callback) => callback(),
                workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
            },
        ),
        /ENOENT/,
    );
    assert.equal(controls, 0);
});

test('rm failure is successful when immutable-ID reinspection proves the container absent', () => {
    let current = inspectedRecord({ State: { Running: false } });
    const controls = [];
    const result = removeExactContainerAndDescriptor(NAME, registryRecord(), 'podman', {
        fast: true,
        inspect: () => current,
        control(runtime, args) {
            assert.equal(runtime, 'podman');
            controls.push(args);
            assert.equal(args.at(-1), CONTAINER_ID);
            assert.equal(args[0], 'rm');
            current = null;
            return { status: 1, stderr: 'container disappeared during rm' };
        },
        withLock: (callback) => callback(),
        pause() {},
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
    });
    assert.deepEqual(result, { found: true, stopped: true, removed: true });
    assert.deepEqual(controls, [['rm', '-f', CONTAINER_ID]]);
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
    assert.match(bulk, /removeExactContainerAndDescriptor\(name, record, runtime/);
});

test('configured stop opts into exact removal only for its internal transition mode', () => {
    const source = fs.readFileSync(
        new URL('../../cli/sandbox/docker/containerFleet.js', import.meta.url),
        'utf8',
    );
    const configuredStop = source.slice(
        source.indexOf('function stopConfiguredAgents('),
        source.indexOf('function stopAndRemoveMany(', source.indexOf('function stopConfiguredAgents(')),
    );
    assert.match(
        configuredStop,
        /function stopConfiguredAgents\(\{ fast = false, strict = false, remove = false \} = \{\}\)/,
    );
    assert.match(configuredStop, /removeExactContainerAndDescriptor\(name, rec, runtime, \{\s*fast,\s*remove,/);
    assert.doesNotMatch(configuredStop, /\['rm', '-f', name\]/);
    assert.doesNotMatch(configuredStop, /execSync\(/);
});
