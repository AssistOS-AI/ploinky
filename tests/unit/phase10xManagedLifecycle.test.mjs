import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS, BOX_ROLES } from '../../ploinky-box/constants.mjs';
import { runtimeFromOuterJournal } from '../../ploinky-box/contract/container.mjs';
import {
    REQUIRED_RELEASE_AGENTLIB_SHA,
    createReleaseDescriptor,
} from '../../ploinky-box/contract/release.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    buildOuterContainerDefinition,
    directContainerCreateSpec,
} from '../../ploinky-box/lifecycle/container.mjs';
import { createOuterJournalStore } from '../../ploinky-box/lifecycle/outerJournal.mjs';
import { reconcileBoxContainer } from '../../ploinky-box/lifecycle/transactions.mjs';
import {
    checkBoxHealth,
    createBoxSupervisor,
} from '../../ploinky-box/supervisor.mjs';
import { createPhase10xRemoteClient } from '../helpers/phase10xRemoteClient.mjs';

const CANDIDATE_ID = 'a'.repeat(64);
const PREDECESSOR_ID = 'b'.repeat(64);
const PROTECTED_ID = '8'.repeat(64);
const UNRELATED_ID = '9'.repeat(64);
const ENGINE_ID = '1'.repeat(64);

function exactRelease(seed = 0) {
    const digit = (seed + 2).toString(16);
    const next = (seed + 8).toString(16);
    return createReleaseDescriptor({
        schema: 'ploinky-release-v1',
        boxImageId: digit.repeat(64),
        boxImageDigest: `sha256:${next.repeat(64)}`,
        nodeImageId: (seed + 4).toString(16).repeat(64),
        nodeImageDigest: `sha256:${(seed + 6).toString(16).repeat(64)}`,
        artifactSourceSha: (seed + 1).toString(16).repeat(40),
        controllerSourceSha: (seed + 3).toString(16).repeat(40),
        agentlibSha: REQUIRED_RELEASE_AGENTLIB_SHA,
        routerHostPort: 18080,
        mediaHostPort: 17882,
    });
}

function protectedRecord(id, name) {
    return {
        Id: id,
        Names: [name],
        Image: '7'.repeat(64),
        ImageID: '7'.repeat(64),
        State: 'running',
        Status: 'running',
        Pid: 700,
        AutoRemove: false,
        Dependencies: [],
        Labels: { protected: 'true' },
    };
}

function exactSelectedDefinition(journal, id) {
    if (journal?.container?.id === id) return journal.container;
    if (journal?.predecessor?.id === id) return journal.predecessor.container;
    throw new Error('managed fake received no exact journal proof for selected actor');
}

function volumeRole(key) {
    return {
        workspace: BOX_ROLES.workspace,
        containers: BOX_ROLES.containers,
        dependencies: BOX_ROLES.dependencies,
    }[key];
}

function volumeLabels(identity, key) {
    return {
        [BOX_LABELS.pathHash]: identity.pathHash,
        [BOX_LABELS.role]: volumeRole(key),
    };
}

function volumeHandle(engine, identity, key) {
    return Object.freeze({
        kind: 'volume',
        engine: engine.name,
        engineIdentity: engine.identity,
        name: identity.volumes[key],
        role: volumeRole(key),
        labels: Object.freeze(volumeLabels(identity, key)),
        fingerprint: Object.freeze({ driver: 'local', mountCount: 0 }),
        pathHash: identity.pathHash,
    });
}

function fakeLockManager(root, events) {
    let sequence = 0;
    return {
        async acquire(instance) {
            sequence += 1;
            events.push('lock');
            let released = false;
            return {
                path: path.join(root, `temporary-test-lock-${sequence}`),
                assertHeld(expected) {
                    assert.equal(released, false);
                    assert.equal(expected, instance);
                },
                release() {
                    assert.equal(released, false);
                    released = true;
                    events.push('release');
                },
            };
        },
    };
}

function makeManagedClient({ candidateId = CANDIDATE_ID } = {}) {
    const client = createPhase10xRemoteClient({
        containers: [
            protectedRecord(PROTECTED_ID, 'protected'),
            protectedRecord(UNRELATED_ID, 'unrelated'),
        ],
        generatedIds: [candidateId],
    });
    client.lifecycleEvents = [];
    client.startProofs = [];
    client.failDependencyInstall = false;
    client.failDelete = false;
    client.ambiguousVolumeName = null;
    client.ambiguousDeleteVolumeName = null;
    client.volumeDeleteAttempts = [];

    const originalCreate = client.createContainer.bind(client);
    client.createContainer = async (spec) => {
        client.lifecycleEvents.push('create');
        return originalCreate(spec);
    };
    const originalStart = client.startContainer.bind(client);
    client.startContainer = async ({ id, journal }) => {
        client.startProofs.push({
            id,
            journalId: journal?.container?.id,
            predecessorId: journal?.predecessor?.id || null,
            phase: journal?.phase,
        });
        client.lifecycleEvents.push(`start:${id}`);
        return originalStart({ id, journal });
    };
    const originalStop = client.stopContainer.bind(client);
    client.stopContainer = async (options) => {
        client.lifecycleEvents.push(`stop:${options.id}`);
        return originalStop(options);
    };
    const originalDelete = client.deleteContainer.bind(client);
    client.deleteContainer = async (options) => {
        client.lifecycleEvents.push(`delete:${options.id}`);
        if (client.failDelete) throw new Error('selected exact-ID deletion result is ambiguous');
        return originalDelete(options);
    };

    client.execContainer = async ({ id, argv, journal }) => {
        const target = String(id);
        const definition = exactSelectedDefinition(journal, target);
        assert.deepEqual(definition.creation.dependencies, []);
        assert.equal(definition.creation.autoRemove, false);
        assert.equal(client.ownedIds.has(target), true);
        const command = argv.map(String);
        client.requestJournal.push({
            transport: 'direct', method: 'POST', operation: 'exec', id: target, argv: command,
        });
        if (command.includes('/opt/ploinky/bin/ploinky-install-deps')) {
            client.lifecycleEvents.push(`dependencies:${target}`);
            return client.failDependencyInstall
                ? { exitCode: 17, stdout: '', stderr: 'dependency failure' }
                : { exitCode: 0, stdout: '', stderr: '' };
        }
        if (command.includes('/opt/ploinky/bin/ploinky-local') && command.includes('stop')) {
            client.lifecycleEvents.push(`inner-stop:${target}`);
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (command.includes('/opt/ploinky/ploinky-box/inbox/readStatus.mjs')) {
            client.lifecycleEvents.push(`inbox:${target}`);
            return {
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify({
                    state: 'initialized',
                    initialized: true,
                    routingConfigured: true,
                    trackedAgents: 0,
                    runningAgents: 0,
                    runtimes: [],
                    warnings: [],
                }),
            };
        }
        client.lifecycleEvents.push(`capabilities:${target}`);
        return { exitCode: 0, stdout: '', stderr: '' };
    };

    client.findVolume = async ({ name, labels }) => {
        client.requestJournal.push({
            transport: 'direct', method: 'GET', operation: 'find-volume', name,
        });
        const selected = client.volumes.get(String(name));
        if (!selected) return null;
        const expected = Object.fromEntries(Object.entries(labels).sort());
        const observed = Object.fromEntries(Object.entries(selected.Labels || {}).sort());
        assert.deepEqual(observed, expected);
        return structuredClone(selected);
    };
    client.createVolume = async ({ name, labels }) => {
        client.requestJournal.push({
            transport: 'direct', method: 'POST', operation: 'create-volume', name,
        });
        assert.equal(client.volumes.has(name), false);
        client.volumes.set(name, {
            Name: name, Labels: structuredClone(labels), Driver: 'local', MountCount: 0,
        });
        client.event(name, 'create-volume');
        if (name === client.ambiguousVolumeName) {
            throw new Error('volume create response was lost');
        }
        return { name };
    };
    client.deleteVolume = async ({ name, labels, transactionOwned, knownUnused }) => {
        client.volumeDeleteAttempts.push(name);
        client.requestJournal.push({
            transport: 'direct', method: 'DELETE', operation: 'delete-volume', name,
        });
        assert.equal(transactionOwned, true);
        assert.equal(knownUnused, true);
        const selected = client.volumes.get(name);
        assert.ok(selected);
        assert.deepEqual(
            Object.fromEntries(Object.entries(selected.Labels).sort()),
            Object.fromEntries(Object.entries(labels).sort()),
        );
        client.volumes.delete(name);
        client.event(name, 'remove-volume');
        if (name === client.ambiguousDeleteVolumeName) {
            throw new Error('selected exact-volume deletion result is ambiguous');
        }
        return { removed: true };
    };
    return client;
}

function fixture(t, { candidateId = CANDIDATE_ID } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(
        path.join(os.tmpdir(), 'ploinky-phase10x-managed-'),
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
    const store = createOuterJournalStore({ workspaceRoot: workspace });
    const client = makeManagedClient({ candidateId });
    const events = [];
    client.lifecycleEvents = events;
    const state = {
        root,
        workspace,
        repositoryRoot,
        identity,
        engine,
        store,
        client,
        events,
        failAt: null,
        healthMutation: null,
        predecessorStates: [],
        expectSupervisorRestore: false,
        restoreCalls: [],
    };

    state.volumeHandles = () => Object.fromEntries(
        Object.keys(identity.volumes)
            .filter((key) => client.volumes.has(identity.volumes[key]))
            .map((key) => [key, volumeHandle(engine, identity, key)]),
    );
    state.ownership = () => {
        const journal = store.read({ allowMissing: true });
        if (!journal) {
            return {
                state: 'absent', engine, hostClient: client,
                handles: { container: null, volumes: state.volumeHandles() },
                journal: null,
            };
        }
        if (!journal.createdResources.container
            && ['container-deleted', 'retaining-resources'].includes(journal.phase)) {
            return {
                state: 'owned',
                engine,
                hostClient: client,
                handles: { container: null, volumes: state.volumeHandles() },
                journal,
            };
        }
        const record = client.containers.get(journal.container.id);
        assert.ok(record, `journaled container ${journal.container.id} must exist in fake host`);
        return {
            state: 'owned',
            engine,
            hostClient: client,
            handles: {
                container: {
                    id: journal.container.id,
                    labels: structuredClone(journal.container.labels),
                    runtime: runtimeFromOuterJournal(record, journal),
                },
                volumes: state.volumeHandles(),
            },
            journal,
        };
    };
    state.reconcile = (options) => reconcileBoxContainer(options, {
        discover: () => state.ownership(),
        preflight: async ({ hostPort, mediaHostPort }) => {
            assert.equal(hostPort, 18080);
            assert.equal(mediaHostPort, 17882);
            events.push('preflight');
        },
        validateImage: async (_hostClient, kind) => { events.push(`image:${kind}`); },
        waitReady: async (_hostClient, id, journal) => {
            const candidate = journal.container.id === id;
            const predecessor = journal.predecessor?.id === id;
            assert.equal(candidate || predecessor, true);
            assert.equal(
                candidate
                    ? journal.phase === 'candidate-started' || journal.phase === 'committed'
                    : journal.phase === 'rolling-back',
                true,
            );
            events.push(`ready:${id}`);
        },
    });
    const reconcile = state.reconcile;
    state.reconcile = (options) => {
        if (!state.expectSupervisorRestore) return reconcile(options);
        assert.equal(
            typeof options.afterRestore,
            'function',
            'the supervisor must supply the bounded predecessor service-restore callback',
        );
        const restoreServices = options.afterRestore;
        return reconcile({
            ...options,
            afterRestore: async (context) => {
                state.restoreCalls.push({
                    action: context.action,
                    containerId: context.containerId,
                    journalContainerId: context.journal?.container?.id,
                    predecessorId: context.journal?.predecessor?.id || null,
                });
                state.failAt = null;
                state.healthMutation = null;
                state.events.push(`restore-services:${context.containerId}`);
                return restoreServices(context);
            },
        });
    };
    state.supervisor = createBoxSupervisor({
        hostClient: client,
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(root, events),
        discover: () => state.ownership(),
        repositoryRoot,
        reconcile: state.reconcile,
        validateReleaseAdmission: () => undefined,
        admitNodeImage: async (_hostClient, id, _descriptor, journal) => {
            assert.equal(journal.container.id === id || journal.predecessor?.id === id, true);
            events.push(`node:${id}`);
        },
        readEdgeDesired: () => ({ schemaVersion: 1, generation: 'test-edge' }),
        stageEdgeDesired: async ({ containerId, journal }) => {
            const restoring = journal.predecessor?.id === containerId;
            assert.equal(journal.container.id === containerId || restoring, true);
            assert.equal(
                restoring
                    ? journal.phase === 'rolling-back'
                    : journal.phase === 'dependencies-installed' || journal.phase === 'committed',
                true,
            );
            events.push(`edge:${containerId}`);
            if (state.failAt === 'edge') throw new Error('edge staging failed');
        },
        startCore: async (_hostClient, id, coreArgs, hostPort, journal) => {
            assert.deepEqual(coreArgs, ['start']);
            assert.equal(hostPort, 18080);
            const restoring = journal.predecessor?.id === id;
            assert.equal(journal.container.id === id || restoring, true);
            assert.equal(
                restoring
                    ? journal.phase === 'rolling-back'
                    : journal.phase === 'edge-staged' || journal.phase === 'committed',
                true,
            );
            events.push(`core:${id}`);
            if (state.failAt === 'core') throw new Error('core start failed');
        },
        healthCheck: async (hostPort) => {
            assert.equal(hostPort, 18080);
            const journal = store.read();
            assert.equal(
                ['core-started', 'committed', 'rolling-back'].includes(journal.phase),
                true,
            );
            events.push('health');
            state.healthMutation?.();
            if (state.failAt === 'health') throw new Error('health verification failed');
        },
        stdout: { write() {} },
        stderr: { write() {} },
    });
    return state;
}

function seedVolumes(state) {
    for (const key of Object.keys(state.identity.volumes)) {
        const name = state.identity.volumes[key];
        state.client.volumes.set(name, {
            Name: name,
            Labels: volumeLabels(state.identity, key),
            Driver: 'local',
            MountCount: 0,
        });
    }
}

function journalCas(record) {
    return {
        generation: record.transaction.generation,
        containerId: record.container.id,
        revision: record.revision,
    };
}

function seedCommitted(state, release, { id = PREDECESSOR_ID, running = true } = {}) {
    seedVolumes(state);
    const definition = buildOuterContainerDefinition({
        identity: state.identity,
        imageId: release.boxImageId,
        imageRef: release.boxImageId,
        hostPort: release.routerHostPort,
        mediaHostPort: release.mediaHostPort,
        repositoryRoot: state.repositoryRoot,
        hostKind: state.engine.hostKind,
        releaseDescriptor: release,
        containerName: `${state.identity.instance}-g-${release.releaseGeneration.slice(0, 16)}`,
    });
    let journal = state.store.create({
        schemaVersion: 1,
        engine: state.engine,
        workspace: {
            root: state.identity.workspaceRoot,
            owner: state.identity.instance,
            pathHash: state.identity.pathHash,
        },
        transaction: {
            id: `phase10x-seed-${release.releaseGeneration.slice(0, 16)}`,
            generation: release.releaseGeneration,
        },
        container: { ...definition, id: null },
        predecessor: null,
        createdResources: { container: false, volumes: [] },
        phase: 'intent',
        revision: 0,
    });
    journal = state.store.update(journalCas(journal), {
        createdResources: { container: false, volumes: Object.values(state.identity.volumes) },
        phase: 'resources-created',
    });
    journal = state.store.publishContainerId(journalCas(journal), id);
    for (const phase of [
        'candidate-started',
        'dependencies-installed',
        'edge-staged',
        'core-started',
        'health-verified',
        'committed',
    ]) {
        journal = state.store.update(journalCas(journal), { phase });
    }
    const spec = directContainerCreateSpec(definition);
    state.client.containers.set(id, {
        Id: id,
        Names: [spec.name],
        Image: spec.image,
        ImageID: spec.image,
        State: running ? 'running' : 'exited',
        Status: running ? 'running' : 'exited',
        Pid: running ? 42 : 0,
        AutoRemove: false,
        Dependencies: [],
        Labels: structuredClone(spec.labels),
    });
    state.client.ownedIds.add(id);
    state.client.clearJournals();
    state.client.lifecycleEvents.length = 0;
    state.client.startProofs.length = 0;
    state.events.length = 0;
    return journal;
}

function seedPersistedReplacement(state, oldRelease, nextRelease, {
    phase,
} = {}) {
    const predecessorJournal = seedCommitted(state, oldRelease, { running: true });
    const definition = buildOuterContainerDefinition({
        identity: state.identity,
        imageId: nextRelease.boxImageId,
        imageRef: nextRelease.boxImageId,
        hostPort: nextRelease.routerHostPort,
        mediaHostPort: nextRelease.mediaHostPort,
        repositoryRoot: state.repositoryRoot,
        hostKind: state.engine.hostKind,
        releaseDescriptor: nextRelease,
        containerName: `${state.identity.instance}-g-${nextRelease.releaseGeneration.slice(0, 16)}`,
    });
    let journal = state.store.replaceIntent(journalCas(predecessorJournal), {
        schemaVersion: 1,
        engine: predecessorJournal.engine,
        workspace: predecessorJournal.workspace,
        transaction: {
            id: `phase10x-recovery-${nextRelease.releaseGeneration.slice(0, 16)}`,
            generation: nextRelease.releaseGeneration,
        },
        container: { ...definition, id: null },
        predecessor: {
            id: PREDECESSOR_ID,
            state: 'running',
            transaction: predecessorJournal.transaction,
            revision: predecessorJournal.revision,
            container: {
                name: predecessorJournal.container.name,
                labels: predecessorJournal.container.labels,
                image: predecessorJournal.container.image,
                creation: predecessorJournal.container.creation,
            },
            createdResources: predecessorJournal.createdResources,
        },
        createdResources: { container: false, volumes: [] },
        phase: 'intent',
        revision: 0,
    });
    journal = state.store.update(journalCas(journal), {
        createdResources: {
            container: false,
            volumes: Object.values(state.identity.volumes),
        },
        phase: 'resources-created',
    });
    journal = state.store.publishContainerId(journalCas(journal), CANDIDATE_ID);
    for (const nextPhase of [
        'predecessor-quiescing',
        'predecessor-quiesced',
        'candidate-started',
        'dependencies-installed',
        'edge-staged',
        'core-started',
        'health-verified',
        'predecessor-deleting',
    ]) {
        journal = state.store.update(journalCas(journal), { phase: nextPhase });
    }

    const predecessor = state.client.containers.get(PREDECESSOR_ID);
    predecessor.State = 'exited';
    predecessor.Status = 'exited';
    predecessor.Pid = 0;
    const spec = directContainerCreateSpec(definition);
    state.client.containers.set(CANDIDATE_ID, {
        Id: CANDIDATE_ID,
        Names: [spec.name],
        Image: spec.image,
        ImageID: spec.image,
        State: 'running',
        Status: 'running',
        Pid: 73,
        AutoRemove: false,
        Dependencies: [],
        Labels: structuredClone(spec.labels),
    });
    state.client.ownedIds.add(CANDIDATE_ID);

    if (phase === 'predecessor-deleted') {
        state.client.containers.delete(PREDECESSOR_ID);
        state.client.ownedIds.delete(PREDECESSOR_ID);
        journal = state.store.markPredecessorDeleted(journalCas(journal));
    } else {
        assert.equal(phase, 'predecessor-deleting');
    }
    state.client.clearJournals();
    state.client.lifecycleEvents.length = 0;
    state.client.startProofs.length = 0;
    state.events.length = 0;
    return journal;
}

function assertProtectedUntouched(state, before) {
    assert.deepEqual(state.client.containers.get(PROTECTED_ID), before.protected);
    assert.deepEqual(state.client.containers.get(UNRELATED_ID), before.unrelated);
    assert.equal(
        state.client.eventJournal.some(({ actor }) => [PROTECTED_ID, UNRELATED_ID].includes(actor)),
        false,
    );
    assert.equal(
        state.client.requestJournal.some(({ id }) => [PROTECTED_ID, UNRELATED_ID].includes(id)),
        false,
    );
    assert.equal(state.client.requestJournal.some(({ transport }) => transport === 'cli'), false);
}

function protectedSnapshot(state) {
    return {
        protected: structuredClone(state.client.containers.get(PROTECTED_ID)),
        unrelated: structuredClone(state.client.containers.get(UNRELATED_ID)),
    };
}

test('managed create publishes the full ID before start and reaches dependency, edge, core, health, and commit', async (t) => {
    const state = fixture(t);
    const untouched = protectedSnapshot(state);
    const release = exactRelease(0);

    const result = await state.supervisor.runStartTransaction(
        ['start'], { releaseDescriptor: release },
    );

    assert.equal(result.action, 'created');
    assert.equal(result.containerId, CANDIDATE_ID);
    assert.equal(state.client.containers.get(CANDIDATE_ID).State, 'running');
    assert.equal(state.store.read().phase, 'committed');
    assert.deepEqual(state.client.startProofs, [{
        id: CANDIDATE_ID,
        journalId: CANDIDATE_ID,
        predecessorId: null,
        phase: 'candidate-created',
    }]);
    const order = [
        'create',
        `start:${CANDIDATE_ID}`,
        `capabilities:${CANDIDATE_ID}`,
        `dependencies:${CANDIDATE_ID}`,
        `edge:${CANDIDATE_ID}`,
        `core:${CANDIDATE_ID}`,
        'health',
    ];
    const combined = state.events;
    for (let index = 1; index < order.length; index += 1) {
        assert.ok(
            combined.indexOf(order[index - 1]) < combined.indexOf(order[index]),
            `${order[index - 1]} must precede ${order[index]}`,
        );
    }
    assert.deepEqual(
        [...state.client.volumes.keys()].filter((name) => Object.values(state.identity.volumes).includes(name)).sort(),
        Object.values(state.identity.volumes).sort(),
    );
    assertProtectedUntouched(state, untouched);
});

test('managed reuse starts one stopped committed generation without creating or replacing it', async (t) => {
    const state = fixture(t);
    const release = exactRelease(0);
    seedCommitted(state, release, { running: false });
    const untouched = protectedSnapshot(state);

    const result = await state.supervisor.runStartTransaction(
        ['start'], { releaseDescriptor: release },
    );

    assert.equal(result.action, 'reused');
    assert.equal(result.containerId, PREDECESSOR_ID);
    assert.equal(state.client.containers.get(PREDECESSOR_ID).State, 'running');
    assert.equal(state.store.read().phase, 'committed');
    assert.deepEqual(state.client.startProofs, [{
        id: PREDECESSOR_ID,
        journalId: PREDECESSOR_ID,
        predecessorId: null,
        phase: 'committed',
    }]);
    assert.equal(state.client.lifecycleEvents.includes('create'), false);
    assert.equal(
        state.client.lifecycleEvents.includes(`dependencies:${PREDECESSOR_ID}`),
        true,
    );
    assertProtectedUntouched(state, untouched);
});

test('managed replacement records and honors a running or stopped predecessor', async (t) => {
    for (const running of [true, false]) {
        await t.test(running ? 'running predecessor' : 'stopped predecessor', async (subtest) => {
            const state = fixture(subtest);
            const oldRelease = exactRelease(0);
            const nextRelease = exactRelease(1);
            seedCommitted(state, oldRelease, { running });
            const untouched = protectedSnapshot(state);

            const result = await state.supervisor.runStartTransaction(
                ['start'], { releaseDescriptor: nextRelease },
            );

            assert.equal(result.action, 'replaced');
            assert.equal(result.containerId, CANDIDATE_ID);
            assert.equal(state.client.containers.has(PREDECESSOR_ID), false);
            assert.equal(state.client.containers.get(CANDIDATE_ID).State, 'running');
            assert.equal(state.store.read().predecessor, null);
            assert.equal(state.store.read().phase, 'committed');
            assert.equal(
                state.client.lifecycleEvents.includes(`inner-stop:${PREDECESSOR_ID}`),
                running,
            );
            assert.equal(
                state.client.lifecycleEvents.includes(`stop:${PREDECESSOR_ID}`),
                running,
            );
            assert.equal(
                state.client.lifecycleEvents.includes(`delete:${PREDECESSOR_ID}`),
                true,
            );
            if (running) {
                const innerStop = state.client.lifecycleEvents.indexOf(
                    `inner-stop:${PREDECESSOR_ID}`,
                );
                const outerStop = state.client.lifecycleEvents.indexOf(
                    `stop:${PREDECESSOR_ID}`,
                );
                const candidateStart = state.client.lifecycleEvents.indexOf(
                    `start:${CANDIDATE_ID}`,
                );
                assert.ok(innerStop >= 0 && innerStop < outerStop);
                assert.ok(
                    outerStop < candidateStart,
                    'the running predecessor must be inner-stopped and outer-stopped before candidate start',
                );
            }
            assertProtectedUntouched(state, untouched);
        });
    }
});

test('late replacement failure restores the predecessor outer runtime and its bounded services', async (t) => {
    const state = fixture(t);
    seedCommitted(state, exactRelease(0), { running: true });
    const untouched = protectedSnapshot(state);
    state.expectSupervisorRestore = true;
    state.failAt = 'health';

    await assert.rejects(
        () => state.supervisor.runStartTransaction(
            ['start'], { releaseDescriptor: exactRelease(1) },
        ),
        /transaction failed/i,
    );

    assert.deepEqual(state.restoreCalls, [{
        action: 'restored-predecessor',
        containerId: PREDECESSOR_ID,
        journalContainerId: CANDIDATE_ID,
        predecessorId: PREDECESSOR_ID,
    }]);
    assert.equal(state.client.containers.get(PREDECESSOR_ID).State, 'running');
    assert.equal(state.client.containers.has(CANDIDATE_ID), false);
    assert.equal(state.store.read().container.id, PREDECESSOR_ID);
    assert.equal(state.store.read().phase, 'committed');
    const outerStart = state.events.lastIndexOf(`start:${PREDECESSOR_ID}`);
    const ready = state.events.lastIndexOf(`ready:${PREDECESSOR_ID}`);
    const restore = state.events.lastIndexOf(`restore-services:${PREDECESSOR_ID}`);
    assert.ok(outerStart >= 0 && outerStart < ready);
    assert.ok(ready < restore, 'service restoration must begin only after outer readiness');
    assert.ok(state.events.includes(`core:${PREDECESSOR_ID}`));
    assertProtectedUntouched(state, untouched);
});

test('persisted predecessor retirement phases recover by committing only the exact healthy candidate', async (t) => {
    for (const phase of ['predecessor-deleting', 'predecessor-deleted']) {
        await t.test(phase, async (subtest) => {
            const state = fixture(subtest);
            const untouched = protectedSnapshot(state);
            const nextRelease = exactRelease(1);
            seedPersistedReplacement(state, exactRelease(0), nextRelease, { phase });

            const result = await state.supervisor.runStartTransaction(
                ['start'], { releaseDescriptor: nextRelease },
            );

            assert.equal(result.containerId, CANDIDATE_ID);
            assert.equal(state.store.read().phase, 'committed');
            assert.equal(state.store.read().container.id, CANDIDATE_ID);
            assert.equal(state.store.read().predecessor, null);
            assert.equal(state.client.containers.get(CANDIDATE_ID).State, 'running');
            assert.equal(state.client.containers.has(PREDECESSOR_ID), false);
            assert.equal(state.client.lifecycleEvents.includes('create'), false);
            assert.equal(
                state.client.lifecycleEvents.includes(`start:${CANDIDATE_ID}`),
                false,
            );
            assertProtectedUntouched(state, untouched);
        });
    }
});

test('stop and destroy target one exact committed Box and retain its data volumes by default', async (t) => {
    const state = fixture(t);
    const release = exactRelease(0);
    seedCommitted(state, release, { running: true });
    const untouched = protectedSnapshot(state);

    const stopped = await state.supervisor.runStopTransaction();
    assert.equal(stopped.action, 'stopped');
    assert.equal(state.client.containers.get(PREDECESSOR_ID).State, 'exited');
    assert.deepEqual(
        state.client.lifecycleEvents.filter((entry) => entry.includes(PREDECESSOR_ID)),
        [
            `inner-stop:${PREDECESSOR_ID}`,
            `inbox:${PREDECESSOR_ID}`,
            `stop:${PREDECESSOR_ID}`,
        ],
    );

    const destroyed = await state.supervisor.runDestroyTransaction(PREDECESSOR_ID);
    assert.equal(destroyed.action, 'destroyed-retained-volumes');
    assert.equal(state.client.containers.has(PREDECESSOR_ID), false);
    assert.equal(state.store.read().phase, 'container-deleted');
    assert.equal(state.store.read().createdResources.container, false);
    assert.deepEqual(
        [...state.client.volumes.keys()].filter((name) => Object.values(state.identity.volumes).includes(name)).sort(),
        Object.values(state.identity.volumes).sort(),
    );
    assertProtectedUntouched(state, untouched);
});

test('a deleted-generation journal safely supports recreation and later explicit volume deletion', async (t) => {
    await t.test('recreate with retained volumes', async (subtest) => {
        const state = fixture(subtest);
        const release = exactRelease(0);
        seedCommitted(state, release, { running: true });
        await state.supervisor.runDestroyTransaction(PREDECESSOR_ID);

        const recreated = await state.supervisor.runStartTransaction(
            ['start'], { releaseDescriptor: release },
        );
        assert.equal(recreated.action, 'created');
        assert.equal(state.client.containers.get(CANDIDATE_ID).State, 'running');
        assert.equal(state.store.read().phase, 'committed');
        assert.equal(state.store.read().predecessor, null);
        assert.deepEqual(
            state.store.read().createdResources.volumes.slice().sort(),
            Object.values(state.identity.volumes).sort(),
        );
    });

    await t.test('delete retained volumes', async (subtest) => {
        const state = fixture(subtest);
        const release = exactRelease(0);
        seedCommitted(state, release, { running: false });
        await state.supervisor.runDestroyTransaction(PREDECESSOR_ID);

        const deleted = await state.supervisor.runDestroyTransaction(null, {
            deleteVolumes: true,
        });
        assert.equal(deleted.action, 'deleted-retained-volumes');
        assert.equal(state.store.read({ allowMissing: true }), null);
        assert.deepEqual(
            [...state.client.volumes.keys()].filter((name) => (
                Object.values(state.identity.volumes).includes(name)
            )),
            [],
        );
    });

    await t.test('failed recreation restores the deleted generation', async (subtest) => {
        const state = fixture(subtest);
        const release = exactRelease(0);
        seedCommitted(state, release, { running: false });
        await state.supervisor.runDestroyTransaction(PREDECESSOR_ID);
        state.failAt = 'health';

        await assert.rejects(
            state.supervisor.runStartTransaction(['start'], { releaseDescriptor: release }),
            /transaction failed/i,
        );
        const restored = state.store.read();
        assert.equal(restored.phase, 'container-deleted');
        assert.equal(restored.container.id, PREDECESSOR_ID);
        assert.equal(restored.createdResources.container, false);
        assert.equal(state.client.containers.has(CANDIDATE_ID), false);
        assert.deepEqual(
            restored.createdResources.volumes.slice().sort(),
            Object.values(state.identity.volumes).sort(),
        );
    });
});

test('retained-volume retry journals only proven absence and never re-mutates an absent name', async (t) => {
    const state = fixture(t);
    seedCommitted(state, exactRelease(0), { running: false });
    await state.supervisor.runDestroyTransaction(PREDECESSOR_ID);
    const beforeDeletion = state.store.read();
    const firstDeleted = state.identity.volumes.dependencies;
    const ambiguousDeleted = state.identity.volumes.containers;
    const lastRemaining = state.identity.volumes.workspace;
    state.client.ambiguousDeleteVolumeName = ambiguousDeleted;

    await assert.rejects(
        state.supervisor.runDestroyTransaction(null, { deleteVolumes: true }),
        /deletion result is ambiguous/i,
    );

    const retained = state.store.read();
    assert.equal(retained.phase, 'retaining-resources');
    assert.equal(retained.revision, beforeDeletion.revision + 2);
    assert.deepEqual(
        retained.createdResources.volumes,
        [lastRemaining, ambiguousDeleted],
        'CAS publication must remove only the first proven-absent volume',
    );
    assert.equal(state.client.volumes.has(firstDeleted), false);
    assert.equal(state.client.volumes.has(ambiguousDeleted), false);
    assert.equal(state.client.volumes.has(lastRemaining), true);
    assert.deepEqual(
        state.client.volumeDeleteAttempts,
        [firstDeleted, ambiguousDeleted],
    );

    state.client.ambiguousDeleteVolumeName = null;
    const recovered = await state.supervisor.runDestroyTransaction(null, {
        deleteVolumes: true,
    });

    assert.equal(recovered.action, 'deleted-retained-volumes');
    assert.equal(state.store.read({ allowMissing: true }), null);
    assert.deepEqual(state.client.volumeDeleteAttempts, [
        firstDeleted,
        ambiguousDeleted,
        lastRemaining,
    ]);
    assert.equal(
        state.client.volumeDeleteAttempts.filter((name) => name === firstDeleted).length,
        1,
        'retry must not mutate the already journal-dropped volume',
    );
    assert.equal(
        state.client.volumeDeleteAttempts.filter((name) => name === ambiguousDeleted).length,
        1,
        'retry must journal recovered absence without repeating an ambiguous delete',
    );
    assert.deepEqual(
        Object.values(state.identity.volumes).filter((name) => state.client.volumes.has(name)),
        [],
    );
});

test('dependency, edge, core, and health failures roll back only the candidate and its newly created volumes', async (t) => {
    for (const failure of ['dependencies', 'edge', 'core', 'health']) {
        await t.test(failure, async (subtest) => {
            const state = fixture(subtest);
            const untouched = protectedSnapshot(state);
            if (failure === 'dependencies') state.client.failDependencyInstall = true;
            else state.failAt = failure;

            await assert.rejects(
                () => state.supervisor.runStartTransaction(
                    ['start'], { releaseDescriptor: exactRelease(0) },
                ),
                /transaction failed/i,
            );

            assert.equal(state.client.containers.has(CANDIDATE_ID), false);
            assert.equal(state.store.read({ allowMissing: true }), null);
            assert.deepEqual(
                [...state.client.volumes.keys()].filter((name) => Object.values(state.identity.volumes).includes(name)),
                [],
            );
            assert.equal(
                state.client.lifecycleEvents.includes(`stop:${CANDIDATE_ID}`),
                true,
            );
            assert.equal(
                state.client.lifecycleEvents.includes(`delete:${CANDIDATE_ID}`),
                true,
            );
            assertProtectedUntouched(state, untouched);
        });
    }
});

test('ambiguous candidate deletion retains its exact journal and every possibly attached volume', async (t) => {
    const state = fixture(t);
    const untouched = protectedSnapshot(state);
    state.failAt = 'health';
    state.client.failDelete = true;

    await assert.rejects(
        () => state.supervisor.runStartTransaction(
            ['start'], { releaseDescriptor: exactRelease(0) },
        ),
        /rollback failures|deletion ambiguity/i,
    );

    const retained = state.store.read();
    assert.equal(retained.phase, 'deletion-ambiguous');
    assert.equal(retained.container.id, CANDIDATE_ID);
    assert.equal(state.client.containers.get(CANDIDATE_ID).State, 'exited');
    assert.deepEqual(
        retained.createdResources.volumes.slice().sort(),
        Object.values(state.identity.volumes).sort(),
    );
    assert.deepEqual(
        [...state.client.volumes.keys()].filter((name) => Object.values(state.identity.volumes).includes(name)).sort(),
        Object.values(state.identity.volumes).sort(),
    );
    assertProtectedUntouched(state, untouched);
});

test('ambiguous volume creation retains the intent journal and does not guess that the volume is safe to delete', async (t) => {
    const state = fixture(t);
    const untouched = protectedSnapshot(state);
    const ambiguousName = state.identity.volumes.workspace;
    state.client.ambiguousVolumeName = ambiguousName;

    await assert.rejects(
        () => state.supervisor.runStartTransaction(
            ['start'], { releaseDescriptor: exactRelease(0) },
        ),
        /ambiguous volume creation|retained resources/i,
    );

    const retained = state.store.read();
    assert.equal(retained.phase, 'retaining-resources');
    assert.equal(retained.container.id, null);
    assert.deepEqual(retained.createdResources.volumes, [ambiguousName]);
    assert.equal(state.client.volumes.has(ambiguousName), true);
    assert.equal(state.client.containers.has(CANDIDATE_ID), false);
    assert.equal(state.client.lifecycleEvents.includes('create'), false);
    assertProtectedUntouched(state, untouched);
});

test('replacement rollback restores the journaled running or stopped predecessor state exactly', async (t) => {
    for (const originallyRunning of [true, false]) {
        await t.test(originallyRunning ? 'restore running' : 'restore stopped', async (subtest) => {
            const state = fixture(subtest);
            const oldRelease = exactRelease(0);
            seedCommitted(state, oldRelease, { running: originallyRunning });
            const untouched = protectedSnapshot(state);
            state.failAt = 'health';
            state.expectSupervisorRestore = originallyRunning;
            state.healthMutation = () => {
                const predecessor = state.client.containers.get(PREDECESSOR_ID);
                predecessor.State = originallyRunning ? 'exited' : 'running';
                predecessor.Status = predecessor.State;
                predecessor.Pid = originallyRunning ? 0 : 84;
            };

            await assert.rejects(
                () => state.supervisor.runStartTransaction(
                    ['start'], { releaseDescriptor: exactRelease(1) },
                ),
                /transaction failed/i,
            );

            const restored = state.store.read();
            assert.equal(restored.container.id, PREDECESSOR_ID);
            assert.equal(restored.phase, 'committed');
            assert.equal(restored.predecessor, null);
            assert.equal(
                state.client.containers.get(PREDECESSOR_ID).State,
                originallyRunning ? 'running' : 'exited',
            );
            assert.equal(state.client.containers.has(CANDIDATE_ID), false);
            assert.equal(
                state.client.lifecycleEvents.includes(
                    `${originallyRunning ? 'start' : 'stop'}:${PREDECESSOR_ID}`,
                ),
                true,
            );
            assertProtectedUntouched(state, untouched);
        });
    }
});

function fakeHealthRequest({ statusCode = 200, body, headers = {} }) {
    const configuredTimeouts = [];
    const httpGet = (_options, onResponse) => {
        const request = new EventEmitter();
        request.setTimeout = (milliseconds, onTimeout) => {
            configuredTimeouts.push(milliseconds);
            request.timeoutHandler = onTimeout;
            return request;
        };
        request.destroy = (error) => {
            if (error) queueMicrotask(() => request.emit('error', error));
        };

        const response = new EventEmitter();
        response.statusCode = statusCode;
        response.headers = headers;
        response.setEncoding = () => response;
        response.destroyed = false;
        response.destroy = (error) => {
            response.destroyed = true;
            if (error) queueMicrotask(() => response.emit('error', error));
        };
        queueMicrotask(() => {
            onResponse(response);
            response.emit('data', body);
            if (!response.destroyed) response.emit('end');
        });
        return request;
    };
    return { httpGet, configuredTimeouts };
}

test('public health requests inherit the remaining readiness deadline', async () => {
    const readinessTimeoutMs = 40;
    const fake = fakeHealthRequest({
        statusCode: 500,
        body: JSON.stringify({ status: 'unhealthy' }),
    });

    await assert.rejects(
        checkBoxHealth(18080, {
            httpGet: fake.httpGet,
            timeoutMs: 5_000,
            readinessTimeoutMs,
        }),
        /unhealthy/i,
    );

    assert.equal(fake.configuredTimeouts.length, 1);
    assert.ok(fake.configuredTimeouts[0] > 0);
    assert.ok(
        fake.configuredTimeouts[0] <= readinessTimeoutMs,
        'one health request must never outlive the overall readiness deadline',
    );
});

test('public health rejects a response beyond its explicit byte cap', async () => {
    const maxResponseBytes = 64;
    const fake = fakeHealthRequest({
        body: JSON.stringify({ status: 'healthy', padding: 'x'.repeat(maxResponseBytes) }),
    });

    await assert.rejects(
        checkBoxHealth(18080, {
            httpGet: fake.httpGet,
            timeoutMs: 100,
            readinessTimeoutMs: 100,
            maxResponseBytes,
        }),
        /health response exceeded|response limit|too large/i,
    );
});
