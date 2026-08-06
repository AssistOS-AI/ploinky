import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import {
    runtimeFromOuterJournal,
    validateContainerConfiguration,
} from '../../ploinky-box/contract/container.mjs';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import {
    REQUIRED_RELEASE_AGENTLIB_SHA,
    createReleaseDescriptor,
} from '../../ploinky-box/contract/release.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    buildOuterContainerDefinition,
    directContainerCreateSpec,
    waitForReadySignal,
} from '../../ploinky-box/lifecycle/container.mjs';
import { createOuterJournalStore } from '../../ploinky-box/lifecycle/outerJournal.mjs';
import { reconcileBoxContainer } from '../../ploinky-box/lifecycle/transactions.mjs';
import { createPhase10xRemoteClient } from '../helpers/phase10xRemoteClient.mjs';

const CANDIDATE_ID = 'a'.repeat(64);
const PROTECTED_ID = '9'.repeat(64);
const ENGINE_ID = '1'.repeat(64);

function releaseDescriptor(seed = 0) {
    return createReleaseDescriptor({
        schema: 'ploinky-release-v1',
        boxImageId: (seed + 2).toString(16).repeat(64),
        boxImageDigest: `sha256:${(seed + 3).toString(16).repeat(64)}`,
        nodeImageId: (seed + 4).toString(16).repeat(64),
        nodeImageDigest: `sha256:${(seed + 5).toString(16).repeat(64)}`,
        artifactSourceSha: (seed + 6).toString(16).repeat(40),
        controllerSourceSha: (seed + 7).toString(16).repeat(40),
        agentlibSha: REQUIRED_RELEASE_AGENTLIB_SHA,
        routerHostPort: 18080,
        mediaHostPort: 17882,
    });
}

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(
        path.join(os.tmpdir(), 'ploinky-box-transaction-'),
    ));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const repositoryRoot = path.join(root, 'source');
    fs.mkdirSync(workspace);
    fs.mkdirSync(repositoryRoot);
    fs.mkdirSync(path.join(workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const engine = Object.freeze({
        name: 'podman',
        identity: ENGINE_ID,
        apiVersion: 'v6.0.1',
        hostKind: 'podman-machine',
        connection: Object.freeze({
            name: 'phase10x-test-machine',
            identity: 'phase10x-test-machine',
            uri: `unix://${path.join(root, 'podman.sock')}`,
            socketPath: path.join(root, 'podman.sock'),
        }),
    });
    const lock = {
        path: path.join(root, 'lock'),
        assertHeld(instance) { assert.equal(instance, identity.instance); },
    };
    return { root, workspace, repositoryRoot, identity, engine, lock };
}

function definition(state, descriptor = releaseDescriptor()) {
    return buildOuterContainerDefinition({
        identity: state.identity,
        imageId: descriptor.boxImageId,
        imageRef: descriptor.boxImageId,
        hostPort: descriptor.routerHostPort,
        mediaHostPort: descriptor.mediaHostPort,
        repositoryRoot: state.repositoryRoot,
        hostKind: state.engine.hostKind,
        releaseDescriptor: descriptor,
        containerName: `${state.identity.instance}-g-${descriptor.releaseGeneration.slice(0, 16)}`,
    });
}

function journalFor(state, selectedDefinition, id = CANDIDATE_ID) {
    return {
        schemaVersion: 1,
        engine: state.engine,
        workspace: {
            root: state.workspace,
            owner: state.identity.instance,
            pathHash: state.identity.pathHash,
        },
        transaction: {
            id: 'phase10x-transaction-test',
            generation: selectedDefinition.image.releaseIdentity.generation,
        },
        container: { ...selectedDefinition, id },
        predecessor: null,
        createdResources: { container: true, volumes: [] },
        phase: 'candidate-created',
        revision: 1,
    };
}

function listedRecord(selectedDefinition, id = CANDIDATE_ID, state = 'running') {
    return {
        Id: id,
        Names: [selectedDefinition.name],
        Image: selectedDefinition.image.rawId,
        ImageID: selectedDefinition.image.rawId,
        Labels: structuredClone(selectedDefinition.labels),
        State: state,
        Status: state,
        Pid: state === 'running' ? 42 : 0,
        AutoRemove: false,
        Dependencies: [],
    };
}

function handleFromDefinition(state, selectedDefinition, overrides = {}) {
    const journal = journalFor(state, selectedDefinition);
    const record = listedRecord(selectedDefinition);
    return {
        id: CANDIDATE_ID,
        labels: { ...selectedDefinition.labels, ...(overrides.labels || {}) },
        runtime: {
            ...runtimeFromOuterJournal(record, journal),
            ...(overrides.runtime || {}),
        },
    };
}

test('direct create spec is immutable, standalone, unprivileged, and preserves the fixed publication boundary', (t) => {
    const state = fixture(t);
    const descriptor = releaseDescriptor();
    const spec = directContainerCreateSpec(definition(state, descriptor));

    assert.equal(spec.image, descriptor.boxImageId);
    assert.equal(spec.raw_image_name, descriptor.boxImageId);
    assert.equal(spec.user, 'podman');
    assert.equal(spec.work_dir, '/workspace');
    assert.equal(spec.init, true);
    assert.equal(spec.privileged, false);
    assert.equal(spec.remove, false);
    assert.equal(spec.removeImage, false);
    assert.deepEqual(spec.dependencyContainers, []);
    assert.equal(spec.pod, '');
    assert.deepEqual(spec.netns, { nsmode: 'bridge' });
    assert.deepEqual(spec.unmask, ['ALL']);
    assert.deepEqual(spec.selinux_opts, ['disable']);
    assert.deepEqual(spec.portmappings, [
        {
            host_ip: '0.0.0.0', host_port: descriptor.mediaHostPort,
            container_port: 7882, range: 1, protocol: 'udp',
        },
        {
            host_ip: '127.0.0.1', host_port: descriptor.routerHostPort,
            container_port: 8080, range: 1, protocol: 'tcp',
        },
    ]);
    assert.equal(
        JSON.stringify(spec).includes('docker.sock')
            || JSON.stringify(spec).includes('podman.sock'),
        false,
    );
});

test('direct definition makes /tmp private and mounts only exact workspace-owned volumes', (t) => {
    const state = fixture(t);
    const spec = directContainerCreateSpec(definition(state));

    assert.deepEqual(spec.mounts.find((entry) => entry.destination === '/tmp'), {
        destination: '/tmp',
        type: 'tmpfs',
        source: 'tmpfs',
      options: ['rw', 'nosuid', 'nodev', 'mode=1777', 'rprivate', 'tmpcopyup'],
    });
    assert.deepEqual(
        spec.volumes.map(({ Name, Dest, IsAnonymous }) => ({ Name, Dest, IsAnonymous })),
        [
            {
                Name: state.identity.volumes.containers,
                Dest: '/home/podman/.local/share/containers',
                IsAnonymous: false,
            },
            {
                Name: state.identity.volumes.dependencies,
                Dest: '/opt/ploinky/node_modules',
                IsAnonymous: false,
            },
            {
                Name: state.identity.volumes.workspace,
                Dest: '/workspace',
                IsAnonymous: false,
            },
        ],
    );
});

test('SELinux label disabling is confined to Podman Machine definitions', (t) => {
    const state = fixture(t);
    const descriptor = releaseDescriptor();
    const machine = directContainerCreateSpec(definition(state, descriptor));
    const native = directContainerCreateSpec(buildOuterContainerDefinition({
        identity: state.identity,
        imageId: descriptor.boxImageId,
        imageRef: descriptor.boxImageId,
        hostPort: descriptor.routerHostPort,
        mediaHostPort: descriptor.mediaHostPort,
        repositoryRoot: state.repositoryRoot,
        hostKind: 'native-linux',
        releaseDescriptor: descriptor,
    }));
    assert.deepEqual(machine.selinux_opts, ['disable']);
    assert.deepEqual(native.selinux_opts, []);
});

test('container validation accepts the journal-derived runtime and rejects ownership or init drift', (t) => {
    const state = fixture(t);
    const descriptor = releaseDescriptor();
    const selected = definition(state, descriptor);
    const desired = {
        identity: state.identity,
        hostPort: descriptor.routerHostPort,
        mediaHostPort: descriptor.mediaHostPort,
        imageId: descriptor.boxImageId,
        imageRef: descriptor.boxImageId,
        repositoryRoot: state.repositoryRoot,
        hostKind: state.engine.hostKind,
        releaseDescriptor: descriptor,
    };
    assert.doesNotThrow(() => validateContainerConfiguration(
        handleFromDefinition(state, selected),
        desired,
    ));
    assert.throws(() => validateContainerConfiguration(
        handleFromDefinition(state, selected, {
            labels: { 'io.assistos.ploinky-box.unexpected': '1' },
        }),
        desired,
    ), /label set is incompatible/i);
    assert.throws(() => validateContainerConfiguration(
        handleFromDefinition(state, selected, { runtime: { init: false } }),
        desired,
    ), /user, privilege, or init/i);
});

test('functional structured transport mutates only the exact journal-owned actor', async (t) => {
    const state = fixture(t);
    const selected = definition(state);
    const protectedRecord = {
        ...listedRecord(selected, PROTECTED_ID),
        Names: ['protected-unrelated'],
        Labels: { protected: 'true' },
    };
    const client = createPhase10xRemoteClient({
        containers: [protectedRecord],
        generatedIds: [CANDIDATE_ID],
    });
    const before = structuredClone(client.containers.get(PROTECTED_ID));
    const created = await client.createContainer(directContainerCreateSpec(selected));
    const journal = journalFor(state, selected, created.id);

    await client.startContainer({ id: created.id, journal });
    await client.stopContainer({ id: created.id, timeout: 30, journal });
    await client.deleteContainer({ id: created.id, timeout: 30, journal });

    assert.equal(client.containers.has(CANDIDATE_ID), false);
    assert.deepEqual(client.containers.get(PROTECTED_ID), before);
    assert.equal(client.eventJournal.some(({ actor }) => actor === PROTECTED_ID), false);
    assert.equal(client.requestJournal.some(({ transport }) => transport === 'cli'), false);
});

test('legacy fake run --rm is rejection characterization, never functional acceptance', async (t) => {
    const state = fixture(t);
    const selected = definition(state);
    const protectedRecord = listedRecord(selected, PROTECTED_ID);
    const client = createPhase10xRemoteClient({ containers: [protectedRecord] });
    const before = structuredClone([...client.containers.values()]);

    await assert.rejects(
        () => client.cliContainer('run', PROTECTED_ID),
        /ordinary remote CLI run.*forbidden/i,
    );

  assert.deepEqual([...client.containers.values()], before);
  assert.deepEqual(client.eventJournal, [
    { actor: '0'.repeat(64), status: 'create', transport: 'cli' },
    { actor: '0'.repeat(64), status: 'start', transport: 'cli' },
    { actor: '0'.repeat(64), status: 'wait', transport: 'cli' },
    { actor: '0'.repeat(64), status: 'remove', transport: 'cli' },
  ]);
  assert.equal(client.stateJournal.length, 1);
  assert.equal(client.stateJournal[0].reason, 'cli-run-remove');
  assert.deepEqual(client.stateJournal[0].containers, before);
  assert.deepEqual(client.stateJournal[0].volumes, []);
    assert.deepEqual(client.requestJournal, [{
        transport: 'cli', operation: 'run', id: PROTECTED_ID,
    }]);
});

test('outer transaction sources contain no temporary run --rm or ordinary container CLI lifecycle', () => {
    const transactionSource = fs.readFileSync(path.join(
        import.meta.dirname, '../../ploinky-box/lifecycle/transactions.mjs',
    ), 'utf8');
    const containerSource = fs.readFileSync(path.join(
        import.meta.dirname, '../../ploinky-box/lifecycle/container.mjs',
    ), 'utf8');
    const imageSource = fs.readFileSync(path.join(
        import.meta.dirname, '../../ploinky-box/contract/image.mjs',
    ), 'utf8');
    const combined = `${transactionSource}\n${containerSource}\n${imageSource}`;

    assert.doesNotMatch(combined, /['"]run['"]\s*,\s*['"]--rm['"]/);
    assert.doesNotMatch(
        combined,
        /runner\.(?:run|query|stream)\s*\([^\n]*(?:container|image)\s+(?:create|run|start|stop|rm|inspect)/,
    );
    assert.match(imageSource, /implicit temporary-container lifecycle is forbidden/);
});

test('exact-ID ready signal uses only structured list and exec operations', async (t) => {
    const state = fixture(t);
    const selected = definition(state);
    const record = listedRecord(selected);
    const client = createPhase10xRemoteClient({
        containers: [record],
        ownedIds: [CANDIDATE_ID],
    });
    const journal = journalFor(state, selected);
    client.execContainer = async (request) => {
        assert.equal(request.id, CANDIDATE_ID);
        assert.equal(request.journal, journal);
        assert.deepEqual(request.argv.slice(0, 2), ['/bin/bash', '-ceu']);
        client.requestJournal.push({
            transport: 'direct', method: 'POST', operation: 'exec', id: request.id,
        });
        return { exitCode: 0, stdout: '', stderr: '' };
    };

    await waitForReadySignal(client, CANDIDATE_ID, journal, {
        timeoutMs: 10,
        intervalMs: 0,
        delay: async () => undefined,
    });

    assert.deepEqual(client.requestJournal.map(({ transport, operation }) => ({
        transport, operation: operation || 'list',
    })), [
        { transport: 'direct', operation: 'list' },
        { transport: 'direct', operation: 'exec' },
    ]);
});

test('ready signal fails closed when the exact candidate disappears among unrelated actors', async (t) => {
    const state = fixture(t);
    const selected = definition(state);
    const client = createPhase10xRemoteClient({
        containers: [listedRecord(selected, PROTECTED_ID)],
    });
    await assert.rejects(
        () => waitForReadySignal(client, CANDIDATE_ID, journalFor(state, selected), {
            timeoutMs: 10,
            intervalMs: 0,
            delay: async () => undefined,
        }),
        /disappeared/i,
    );
    assert.deepEqual(client.eventJournal, []);
});

test('transaction validates exact release images before publication and volume mutation', async (t) => {
    const state = fixture(t);
    const events = [];
    const store = createOuterJournalStore({ workspaceRoot: state.workspace });
    const hostClient = {
        async createContainer() { events.push('create'); throw new Error('must not create'); },
    };

    await assert.rejects(
        () => reconcileBoxContainer({
            identity: state.identity,
            ownership: {
                state: 'absent',
                engine: state.engine,
                handles: { container: null, volumes: {} },
            },
            engine: state.engine,
            runner: {},
            hostClient,
            lock: state.lock,
            repositoryRoot: state.repositoryRoot,
            releaseDescriptor: releaseDescriptor(),
            outerJournal: store,
            afterStart: async () => undefined,
        }, {
            validateImage: async (_client, kind) => {
                events.push(`image:${kind}`);
                if (kind === 'node') throw new Error('exact Node image is stale');
            },
            preflight: async () => { events.push('preflight'); },
            ensureVolumes: async () => { events.push('volumes'); },
        }),
        /exact Node image is stale/i,
    );

    assert.deepEqual(events, ['image:box', 'image:node']);
    assert.equal(store.read({ allowMissing: true }), null);
});

test('preflight precedes journaled volume work, and a volume failure abandons its empty intent', async (t) => {
    const state = fixture(t);
    const events = [];
    const store = createOuterJournalStore({ workspaceRoot: state.workspace });
    const hostClient = {
        async createContainer() { events.push('create'); throw new Error('must not create'); },
    };

    await assert.rejects(
        () => reconcileBoxContainer({
            identity: state.identity,
            ownership: {
                state: 'absent',
                engine: state.engine,
                handles: { container: null, volumes: {} },
            },
            engine: state.engine,
            runner: {},
            hostClient,
            lock: state.lock,
            repositoryRoot: state.repositoryRoot,
            releaseDescriptor: releaseDescriptor(),
            outerJournal: store,
            afterStart: async () => undefined,
        }, {
            validateImage: async (_client, kind) => { events.push(`image:${kind}`); },
            preflight: async () => { events.push('preflight'); },
            ensureVolumes: async () => {
                events.push('volumes');
                throw new Error('volume admission failed before creation');
            },
        }),
        /volume admission failed/i,
    );

    assert.deepEqual(events, ['image:box', 'image:node', 'preflight', 'volumes']);
    assert.equal(store.read({ allowMissing: true }), null);
});

test('retired loose image and media inputs fail before any structured host request', async (t) => {
    const state = fixture(t);
    for (const retired of [
        { localBoxImageId: 'f'.repeat(64) },
        { explicitMediaPort: 17883 },
    ]) {
        const requests = [];
        await assert.rejects(
            () => reconcileBoxContainer({
                identity: state.identity,
                ownership: {
                    state: 'absent',
                    engine: state.engine,
                    handles: { container: null, volumes: {} },
                },
                engine: state.engine,
                runner: {},
                hostClient: new Proxy({}, {
                    get(_target, key) {
                        requests.push(String(key));
                        return async () => undefined;
                    },
                }),
                lock: state.lock,
                repositoryRoot: state.repositoryRoot,
                releaseDescriptor: releaseDescriptor(),
                ...retired,
            }),
            /loose local Box image\/media inputs are retired/i,
        );
        assert.deepEqual(requests, []);
    }
});

test('missing structured transport fails closed without consulting an ordinary engine runner', async (t) => {
    const state = fixture(t);
    let runnerCalls = 0;
    await assert.rejects(
        () => reconcileBoxContainer({
            identity: state.identity,
            ownership: {
                state: 'absent',
                engine: state.engine,
                handles: { container: null, volumes: {} },
            },
            engine: state.engine,
            runner: new Proxy({}, {
                get() { runnerCalls += 1; throw new Error('ordinary engine fallback forbidden'); },
            }),
            hostClient: null,
            lock: state.lock,
            repositoryRoot: state.repositoryRoot,
            releaseDescriptor: releaseDescriptor(),
        }),
        /structured Podman host transport is unavailable/i,
    );
    assert.equal(runnerCalls, 0);
});

test('definition environment is exact and contains no independent release or credential side channel', (t) => {
    const state = fixture(t);
    const descriptor = releaseDescriptor();
    const selected = definition(state, descriptor);
    assert.deepEqual(selected.creation.env, {
        ...IMAGE_CONTRACT.environment,
        PLOINKY_PRIVATE_BIND: '0.0.0.0',
        PLOINKY_PUBLIC_AUTHORITY: `127.0.0.1:${descriptor.routerHostPort}`,
        PLOINKY_PUBLIC_BIND: '0.0.0.0',
        PLOINKY_RELEASE_DESCRIPTOR: JSON.stringify(descriptor),
    });
    assert.equal(Object.hasOwn(selected.creation.env, 'PLOINKY_RELEASE_GENERATION'), false);
    assert.equal(Object.hasOwn(selected.creation.env, 'PLOINKY_AGENTLIB_REF'), false);
    assert.equal(Object.hasOwn(selected.creation.env, 'PLOINKY_MASTER_KEY'), false);
    assert.equal(
        selected.labels[BOX_LABELS.releaseGeneration],
        descriptor.releaseGeneration,
    );
});
