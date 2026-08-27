import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    removeExactContainerAndDescriptor,
    stopCoordinatedConfiguredAgents,
} from '../../cli/sandbox/docker/containerFleet.js';
import { NETWORK_LABELS } from '../../cli/sandbox/networkLifecycle.js';
import { NETWORK_SCHEMA_VERSION } from '../../cli/sandbox/networkContract.js';
import { getAgentContainerName } from '../../cli/sandbox/docker/common.js';
import { PLOINKY_DIR } from '../../cli/utils/config.js';

const CONTAINER_ID = 'a'.repeat(64);
const NAME = 'ploinky_exact_agent';
const STAGED_NAME = getAgentContainerName('explorer', 'AchillesIDE');
const STAGED_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const STAGED_ENABLE_GENERATION = '22222222-2222-4222-8222-222222222222';
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

function stagedRecord(overrides = {}) {
    const record = registryRecord({
        agentName: 'explorer',
        repoName: 'AchillesIDE',
        containerImage: 'node:24-bookworm-slim',
        createdAt: '2026-08-24T00:00:00.000Z',
        projectPath: '/workspace',
        runMode: 'isolated',
        profile: 'default',
        instanceId: STAGED_INSTANCE_ID,
        enableGeneration: STAGED_ENABLE_GENERATION,
        config: { binds: [], env: [], ports: [] },
        ...overrides,
    });
    delete record.containerId;
    return record;
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
        stagedRecord(),
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

test('coordinated Box shutdown skips only a complete staged runtime proven absent', () => {
    const calls = [];
    let lockHeld = false;
    let loadObservedLock = false;
    const result = stopCoordinatedConfiguredAgents({ strict: true, remove: true }, {
        load: () => {
            loadObservedLock = lockHeld;
            return { [STAGED_NAME]: stagedRecord() };
        },
        resolveRuntime: () => 'podman',
        insideBox: () => true,
        withLock(callback) {
            lockHeld = true;
            try { return callback(); } finally { lockHeld = false; }
        },
        control(runtime, args) {
            assert.equal(lockHeld, true);
            assert.equal(runtime, 'podman');
            calls.push(args);
            return { status: 0, stdout: '' };
        },
        inspect: () => assert.fail('an empty inventory has no immutable IDs to inspect'),
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
        sandboxPidRecordExists: () => false,
    });

    assert.deepEqual(result, []);
    assert.equal(loadObservedLock, true);
    assert.deepEqual(calls, [['ps', '--all', '--quiet', '--no-trunc']]);
});

test('reported partial start removes exact blocking runtimes and skips absent staged workers', () => {
    const exactName = NAME;
    const exactRecord = registryRecord({
        agentName: 'dpuAgent',
        repoName: 'AchillesIDE',
    });
    const registry = {
        [exactName]: exactRecord,
        [STAGED_NAME]: stagedRecord(),
    };
    const inventoryControls = [];
    const removed = [];
    let lockHeld = false;

    const result = stopCoordinatedConfiguredAgents({ strict: true, remove: true }, {
        load: () => {
            assert.equal(lockHeld, true);
            return registry;
        },
        resolveRuntime: () => 'podman',
        insideBox: () => true,
        withLock(callback) {
            assert.equal(lockHeld, false);
            lockHeld = true;
            try { return callback(); } finally { lockHeld = false; }
        },
        control(runtime, args) {
            assert.equal(lockHeld, true);
            assert.equal(runtime, 'podman');
            inventoryControls.push(args);
            return { status: 0, stdout: `${CONTAINER_ID}\n` };
        },
        inspect(runtime, id) {
            assert.equal(lockHeld, true);
            assert.equal(runtime, 'podman');
            assert.equal(id, CONTAINER_ID);
            return inspectedRecord({ Id: CONTAINER_ID, Name: `/${exactName}` });
        },
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
        sandboxPidRecordExists: () => false,
        removeExact(name, record, runtime, options) {
            assert.equal(lockHeld, true);
            assert.equal(name, exactName);
            assert.equal(record, exactRecord);
            assert.equal(record.containerId, CONTAINER_ID);
            assert.equal(runtime, 'podman');
            assert.deepEqual(options, { fast: false, remove: true });
            removed.push(record.containerId);
            return { found: true, stopped: true, removed: true };
        },
        listRunningNames: () => new Set(),
    });

    assert.deepEqual(result, [exactName]);
    assert.deepEqual(inventoryControls, [['ps', '--all', '--quiet', '--no-trunc']]);
    assert.deepEqual(removed, [CONTAINER_ID]);
    assert.equal(removed.includes(STAGED_NAME), false);
});

test('coordinated staged recovery fails closed for runtime, identity, or inventory ambiguity', () => {
    const id = 'c'.repeat(64);
    const cases = [
        {
            name: 'same name',
            inspected: { ...inspectedRecord(), Id: id, Name: `/${STAGED_NAME}` },
            message: /same-name staged runtime/,
        },
        {
            name: 'renamed matching tuple',
            inspected: {
                ...inspectedRecord(),
                Id: id,
                Name: '/renamed-runtime',
                Config: {
                    Labels: {
                        [NETWORK_LABELS.workspace]: WORKSPACE_HASH,
                        [NETWORK_LABELS.instanceId]: STAGED_INSTANCE_ID,
                        [NETWORK_LABELS.enableGeneration]: STAGED_ENABLE_GENERATION,
                    },
                },
            },
            message: /staged identity under another container name/,
        },
    ];

    for (const scenario of cases) {
        assert.throws(() => stopCoordinatedConfiguredAgents({ strict: true, remove: true }, {
            load: () => ({ [STAGED_NAME]: stagedRecord() }),
            resolveRuntime: () => 'podman',
            insideBox: () => true,
            withLock: (callback) => callback(),
            control: () => ({ status: 0, stdout: `${id}\n` }),
            inspect: () => scenario.inspected,
            workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
            sandboxPidRecordExists: () => false,
        }), scenario.message, scenario.name);
    }

    assert.throws(() => stopCoordinatedConfiguredAgents({ strict: true }, {
        load: () => ({ [STAGED_NAME]: stagedRecord() }),
        resolveRuntime: () => 'podman',
        insideBox: () => true,
        withLock: (callback) => callback(),
        control: () => ({ status: 1, stderr: 'inventory refused' }),
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
        sandboxPidRecordExists: () => false,
    }), /cannot inventory all configured runtimes/);

    assert.throws(() => stopCoordinatedConfiguredAgents({ strict: true }, {
        load: () => ({ [STAGED_NAME]: stagedRecord() }),
        resolveRuntime: () => 'podman',
        insideBox: () => true,
        withLock: (callback) => callback(),
        control: () => ({ status: 0, stdout: 'not-an-id\n' }),
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
        sandboxPidRecordExists: () => false,
    }), /malformed or duplicate immutable IDs/);

    assert.throws(() => stopCoordinatedConfiguredAgents({ strict: true }, {
        load: () => ({ [STAGED_NAME]: stagedRecord() }),
        insideBox: () => false,
        withLock: (callback) => callback(),
    }), /only inside a managed Ploinky Box/);

    assert.throws(() => stopCoordinatedConfiguredAgents({ strict: true }, {
        load: () => ({ [STAGED_NAME]: stagedRecord() }),
        resolveRuntime: () => 'podman',
        insideBox: () => true,
        withLock: (callback) => callback(),
        control: () => ({ status: 0, stdout: '' }),
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
        sandboxPidRecordExists: () => true,
    }), /sandbox PID authority/);
});

test('coordinated staged recovery rejects noncanonical prepared records before inventory', () => {
    const invalidCases = [
        ['noncanonical runtime name', 'ploinky_wrong_name', stagedRecord()],
        ['missing agent name', STAGED_NAME, stagedRecord({ agentName: '' })],
        ['missing repository name', STAGED_NAME, stagedRecord({ repoName: '' })],
        ['alias and registry name mismatch', STAGED_NAME, stagedRecord({ alias: 'preview' })],
        ['invalid instance UUID', STAGED_NAME, stagedRecord({ instanceId: 'instance-exact' })],
        ['invalid generation UUID', STAGED_NAME, stagedRecord({ enableGeneration: 'generation-exact' })],
        ['equal prepared identities', STAGED_NAME, stagedRecord({
            enableGeneration: STAGED_INSTANCE_ID,
        })],
        ['missing image', STAGED_NAME, stagedRecord({ containerImage: ' ' })],
        ['invalid creation time', STAGED_NAME, stagedRecord({ createdAt: 'not-a-date' })],
        ['missing run mode', STAGED_NAME, stagedRecord({ runMode: ' ' })],
        ['missing profile', STAGED_NAME, stagedRecord({ profile: ' ' })],
        ['missing prepared configuration', STAGED_NAME, stagedRecord({ config: null })],
        ['non-array binds', STAGED_NAME, stagedRecord({ config: { binds: {}, env: [], ports: [] } })],
        ['non-array environment', STAGED_NAME, stagedRecord({ config: { binds: [], env: {}, ports: [] } })],
        ['non-array ports', STAGED_NAME, stagedRecord({ config: { binds: [], env: [], ports: {} } })],
        ['relative project path', STAGED_NAME, stagedRecord({ projectPath: 'workspace' })],
    ];
    for (const [label, registryName, record] of invalidCases) {
        let controls = 0;
        assert.throws(() => stopCoordinatedConfiguredAgents({ strict: true, remove: true }, {
            load: () => ({ [registryName]: record }),
            resolveRuntime: () => 'podman',
            insideBox: () => true,
            withLock: (callback) => callback(),
            control: () => { controls += 1; return { status: 0, stdout: '' }; },
            workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
            sandboxPidRecordExists: () => false,
        }), /complete canonical prepared-agent record/, label);
        assert.equal(controls, 0, label);
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

test('configured stop keeps exact removal and adds a separate coordinated staged-absence path', () => {
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
        /function stopConfiguredAgents\(\{ fast = false, strict = false, remove = false \} = \{\},/,
    );
    assert.match(configuredStop, /removeExact = removeExactContainerAndDescriptor/);
    assert.match(configuredStop, /removeExact\(name, rec, runtime, \{\s*fast,\s*remove,/);
    assert.doesNotMatch(configuredStop, /\['rm', '-f', name\]/);
    assert.doesNotMatch(configuredStop, /execSync\(/);
    assert.match(source, /function stopCoordinatedConfiguredAgents\(/);
    assert.match(source, /preflightProvenStagedAbsence\(entries, runtime/);
});
