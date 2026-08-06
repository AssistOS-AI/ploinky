import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    createOuterJournalStore,
    normalizeOuterJournalRecord,
} from '../../ploinky-box/lifecycle/outerJournal.mjs';

const CANDIDATE_ID = 'a'.repeat(64);
const PREDECESSOR_ID = 'b'.repeat(64);
const GENERATION = 'c'.repeat(64);
const ENGINE_ID = 'd'.repeat(64);
const PREDECESSOR_GENERATION = 'e'.repeat(64);
const REPLACEMENT_ID = '9'.repeat(64);

function fixture(t) {
    const workspaceRoot = fs.realpathSync(fs.mkdtempSync(
        path.join(os.tmpdir(), 'ploinky-outer-journal-'),
    ));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    const identity = buildWorkspaceIdentity(workspaceRoot, { markerFound: false });
    const store = createOuterJournalStore({ workspaceRoot });
    const labels = {
        'io.assistos.ploinky-box.image-ref': CANDIDATE_ID,
        'io.assistos.ploinky-box.media-host-port': '17882',
        'io.assistos.ploinky-box.path-hash': identity.pathHash,
        'io.assistos.ploinky-box.release-descriptor': '{"release":"phase10x"}',
        'io.assistos.ploinky-box.release-generation': GENERATION,
        'io.assistos.ploinky-box.role': 'box',
        'io.assistos.ploinky-box.router-host-port': '18080',
    };
    const intent = {
        schemaVersion: 1,
        engine: {
            name: 'podman',
            identity: ENGINE_ID,
            apiVersion: 'v6.0.1',
            hostKind: 'podman-machine',
            connection: {
                name: 'podman-machine-default',
                identity: 'podman-machine-default',
                uri: 'unix:///private/tmp/podman-machine.sock',
                socketPath: '/private/tmp/podman-machine.sock',
            },
        },
        workspace: {
            root: workspaceRoot,
            owner: identity.instance,
            pathHash: identity.pathHash,
        },
        transaction: {
            id: 'phase10x-transaction-0001',
            generation: GENERATION,
        },
        container: {
            name: `${identity.instance}-g-${GENERATION.slice(0, 16)}`,
            id: null,
            labels,
            image: {
                rawId: CANDIDATE_ID,
                reference: CANDIDATE_ID,
                releaseIdentity: {
                    generation: GENERATION,
                    descriptor: labels['io.assistos.ploinky-box.release-descriptor'],
                },
            },
            creation: {
                ports: [
                    {
                        containerPort: '8080', protocol: 'tcp',
                        hostIp: '127.0.0.1', hostPort: '18080',
                    },
                    {
                        containerPort: '7882', protocol: 'udp',
                        hostIp: '0.0.0.0', hostPort: '17882',
                    },
                ],
                network: { mode: 'podman', networks: ['podman'] },
                mounts: [
                    {
                        type: 'bind', source: workspaceRoot, name: '',
                        destination: '/opt/ploinky', rw: false,
                    },
                    {
                        type: 'volume', source: '', name: identity.volumes.workspace,
                        destination: '/workspace', rw: true,
                    },
                    {
                        type: 'volume', source: '', name: identity.volumes.containers,
                        destination: '/home/podman/.local/share/containers', rw: true,
                    },
                    {
                        type: 'volume', source: '', name: identity.volumes.dependencies,
                        destination: '/opt/ploinky/node_modules', rw: true,
                    },
                ],
                volumes: Object.values(identity.volumes),
                devices: [
                    { hostPath: '/dev/fuse', containerPath: '/dev/fuse', permissions: 'rwm' },
                    { hostPath: '/dev/net/tun', containerPath: '/dev/net/tun', permissions: 'rwm' },
                ],
                tmpfs: { '/tmp': 'rw,nosuid,nodev,mode=1777,rprivate,tmpcopyup' },
                env: {
                    PLOINKY_PRIVATE_BIND: '0.0.0.0',
                    PLOINKY_PUBLIC_AUTHORITY: '127.0.0.1:18080',
                    PLOINKY_PUBLIC_BIND: '0.0.0.0',
                },
                security: {
                    user: 'podman', init: true, privileged: false,
                    securityOptions: ['label=disable', 'unmask=all'],
                },
                command: ['/usr/local/bin/ploinky-box-entrypoint'],
                dependencies: [],
                autoRemove: false,
            },
        },
        predecessor: {
            id: PREDECESSOR_ID,
            state: 'stopped',
            transaction: {
                id: 'phase10x-predecessor-0000',
                generation: PREDECESSOR_GENERATION,
            },
            revision: 7,
            createdResources: { container: true, volumes: [] },
        },
        createdResources: { container: false, volumes: [] },
        phase: 'intent',
        revision: 0,
    };
    intent.predecessor.container = structuredClone({
        name: intent.container.name,
        labels: intent.container.labels,
        image: intent.container.image,
        creation: intent.container.creation,
    });
    intent.predecessor.container.name = `${identity.instance}-g-${PREDECESSOR_GENERATION.slice(0, 16)}`;
    intent.predecessor.container.labels['io.assistos.ploinky-box.release-generation']
        = PREDECESSOR_GENERATION;
    intent.predecessor.container.image.releaseIdentity.generation = PREDECESSOR_GENERATION;
    return { workspaceRoot, identity, store, intent };
}

function cas(record) {
    return {
        generation: record.transaction.generation,
        containerId: record.container.id,
        revision: record.revision,
    };
}

function containerDefinitionForTest(record) {
    return {
        name: record.container.name,
        labels: record.container.labels,
        image: record.container.image,
        creation: record.container.creation,
    };
}

test('outer journal persists a private atomic complete intent before ID publication', (t) => {
    const { store, intent, workspaceRoot } = fixture(t);
    const created = store.create(intent);

    assert.deepEqual(created, normalizeOuterJournalRecord(intent, { workspaceRoot }));
    assert.deepEqual(store.read(), created);
    assert.equal(fs.statSync(store.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(store.path)).mode & 0o777, 0o700);
    assert.deepEqual(
        fs.readdirSync(path.dirname(store.path)).filter((name) => /\.tmp$|\.claim$/.test(name)),
        [],
    );
    assert.equal(created.container.id, null);
    assert.deepEqual(created.container.creation.dependencies, []);
    assert.equal(created.container.creation.autoRemove, false);
    assert.deepEqual(created.createdResources, { container: false, volumes: [] });
});

test('outer journal retains a loopback machine connection URI and its forwarded Unix socket separately', (t) => {
    const { store, intent } = fixture(t);
    intent.engine.connection.uri = 'ssh://core@127.0.0.1:53333/run/user/501/podman/podman.sock';
    const created = store.create(intent);
    assert.equal(created.engine.connection.uri, intent.engine.connection.uri);
    assert.equal(created.engine.connection.socketPath, '/private/tmp/podman-machine.sock');
    assert.equal(created.engine.connection.identity, 'podman-machine-default');
});

test('full container ID publication and every later write use generation, ID, and revision CAS', (t) => {
    const { store, intent } = fixture(t);
    const initial = store.create(intent);

    assert.throws(
        () => store.publishContainerId(cas(initial), CANDIDATE_ID.slice(0, 12)),
        /full 64-hex/i,
    );
    assert.deepEqual(store.read(), initial);

    const published = store.publishContainerId(cas(initial), CANDIDATE_ID);
    assert.equal(published.container.id, CANDIDATE_ID);
    assert.equal(published.phase, 'candidate-created');
    assert.equal(published.createdResources.container, true);
    assert.equal(published.revision, 1);

    for (const expected of [
        cas(initial),
        { ...cas(published), generation: 'f'.repeat(64) },
        { ...cas(published), containerId: PREDECESSOR_ID },
        { ...cas(published), revision: published.revision + 1 },
    ]) {
        assert.throws(() => store.update(expected, { phase: 'candidate-started' }), /CAS|stale/i);
        assert.deepEqual(store.read(), published);
    }

    const started = store.update(cas(published), { phase: 'candidate-started' });
    assert.equal(started.revision, 2);
    assert.equal(started.phase, 'candidate-started');
});

test('missing, corrupt, duplicate, short, mismatched, and stale journal state fails closed', (t) => {
    const { store, intent, workspaceRoot } = fixture(t);
    assert.throws(() => store.read(), /missing/i);
    assert.throws(() => store.update({
        generation: GENERATION, containerId: null, revision: 0,
    }, { phase: 'resources-created' }), /missing/i);
    assert.equal(fs.existsSync(path.dirname(store.path)), false);

    fs.mkdirSync(path.dirname(store.path), { recursive: true, mode: 0o700 });
    fs.writeFileSync(store.path, '{broken', { mode: 0o600 });
    assert.throws(() => store.read(), /corrupt/i);
    assert.equal(fs.readFileSync(store.path, 'utf8'), '{broken');

    fs.unlinkSync(store.path);
    const duplicate = structuredClone(intent);
    duplicate.container.creation.volumes.push(duplicate.container.creation.volumes[0]);
    assert.throws(() => store.create(duplicate), /duplicate/i);
    assert.equal(fs.existsSync(store.path), false);

    const short = structuredClone(intent);
    short.predecessor.id = PREDECESSOR_ID.slice(0, 12);
    assert.throws(() => store.create(short), /full 64-hex/i);
    assert.equal(fs.existsSync(store.path), false);

    const created = store.create(intent);
    assert.throws(() => store.read({
        expected: { owner: 'another-owner' },
    }), /mismatch/i);
    assert.throws(() => store.read({
        expected: { workspaceRoot: path.join(workspaceRoot, 'other') },
    }), /mismatch/i);
    assert.deepEqual(store.read(), created);
});

test('retirement is exact-generation and full-ID CAS guarded and preserves ambiguity', (t) => {
    const { store, intent } = fixture(t);
    const initial = store.create(intent);
    const published = store.publishContainerId(cas(initial), CANDIDATE_ID);

    assert.throws(() => store.retire({ ...cas(published), containerId: PREDECESSOR_ID }), /CAS|stale/i);
    assert.deepEqual(store.read(), published);
    assert.throws(() => store.retire({ ...cas(published), generation: 'f'.repeat(64) }), /CAS|stale/i);
    assert.deepEqual(store.read(), published);

    assert.equal(store.retire(cas(published)), true);
    assert.equal(fs.existsSync(store.path), false);
    assert.throws(() => store.retire(cas(published)), /missing/i);
});

test('intent abandonment is CAS guarded and requires rollback with zero created resources', (t) => {
    const state = fixture(t);
    let current = state.store.create(state.intent);
    current = state.store.update(cas(current), {
        phase: 'resources-created',
        createdResources: {
            container: false,
            volumes: [state.intent.container.creation.volumes[0]],
        },
    });
    current = state.store.update(cas(current), { phase: 'rolling-back' });

    assert.throws(() => state.store.abandonIntent({
        ...cas(current), revision: current.revision - 1,
    }), /CAS|stale/i);
    assert.deepEqual(state.store.read(), current);
    assert.throws(() => state.store.abandonIntent(cas(current)), /created resources/i);
    assert.deepEqual(state.store.read(), current);

    current = state.store.update(cas(current), {
        createdResources: { container: false, volumes: [] },
    });
    assert.equal(state.store.abandonIntent(cas(current)), true);
    assert.throws(() => state.store.read(), /missing/i);

    const candidateState = fixture(t);
    let candidate = candidateState.store.create(candidateState.intent);
    candidate = candidateState.store.publishContainerId(cas(candidate), CANDIDATE_ID);
    candidate = candidateState.store.update(cas(candidate), { phase: 'rolling-back' });
    assert.throws(
        () => candidateState.store.abandonIntent(cas(candidate)),
        /unpublished|created resources/i,
    );
    assert.deepEqual(candidateState.store.read(), candidate);
});

test('replacement intent atomically CAS-swaps generation and preserves the full predecessor tuple', (t) => {
    const { store, intent } = fixture(t);
    let current = store.create(intent);
    current = store.publishContainerId(cas(current), CANDIDATE_ID);
    for (const phase of [
        'candidate-started',
        'dependencies-installed',
        'edge-staged',
        'core-started',
        'health-verified',
    ]) current = store.update(cas(current), { phase });
    current = store.update(cas(current), { phase: 'predecessor-deleting' });
    current = store.markPredecessorDeleted(cas(current));
    current = store.commitCandidate(cas(current));

    const nextGeneration = 'f'.repeat(64);
    const replacement = structuredClone(intent);
    replacement.transaction = { id: 'phase10x-replacement-0002', generation: nextGeneration };
    replacement.container.name = `${replacement.workspace.owner}-g-${nextGeneration.slice(0, 16)}`;
    replacement.container.id = null;
    replacement.container.labels['io.assistos.ploinky-box.release-generation'] = nextGeneration;
    replacement.container.image.releaseIdentity.generation = nextGeneration;
    replacement.predecessor = {
        id: current.container.id,
        state: 'running',
        transaction: structuredClone(current.transaction),
        revision: current.revision,
        container: structuredClone({
            name: current.container.name,
            labels: current.container.labels,
            image: current.container.image,
            creation: current.container.creation,
        }),
        createdResources: structuredClone(current.createdResources),
    };
    replacement.createdResources = { container: false, volumes: [] };
    replacement.phase = 'intent';
    replacement.revision = 0;

    assert.throws(
        () => store.replaceIntent({ ...cas(current), generation: '0'.repeat(64) }, replacement),
        /CAS|stale/i,
    );
    assert.deepEqual(store.read(), current);

    const drifted = structuredClone(replacement);
    drifted.predecessor.container.creation.command = ['/bin/false'];
    assert.throws(() => store.replaceIntent(cas(current), drifted), /predecessor/i);
    assert.deepEqual(store.read(), current);

    const replaced = store.replaceIntent(cas(current), replacement);
    assert.equal(replaced.transaction.generation, nextGeneration);
    assert.equal(replaced.container.id, null);
    assert.equal(replaced.predecessor.id, CANDIDATE_ID);
    assert.deepEqual(replaced.predecessor.container, {
        name: current.container.name,
        labels: current.container.labels,
        image: current.container.image,
        creation: current.container.creation,
    });
    assert.deepEqual(replaced.predecessor.transaction, current.transaction);
    assert.equal(replaced.predecessor.revision, current.revision);
    assert.deepEqual(replaced.predecessor.createdResources, current.createdResources);
});

test('rollback restoration is exact candidate CAS and atomically republishes the predecessor', (t) => {
    const { store, intent } = fixture(t);
    let predecessor = store.create({ ...intent, predecessor: null });
    predecessor = store.publishContainerId(cas(predecessor), CANDIDATE_ID);
    for (const phase of [
        'candidate-started',
        'dependencies-installed',
        'edge-staged',
        'core-started',
        'health-verified',
        'committed',
    ]) predecessor = store.update(cas(predecessor), { phase });

    const predecessorCas = cas(predecessor);
    const nextGeneration = 'f'.repeat(64);
    const replacement = structuredClone(intent);
    replacement.transaction = { id: 'phase10x-replacement-0002', generation: nextGeneration };
    replacement.container.name = `${replacement.workspace.owner}-g-${nextGeneration.slice(0, 16)}`;
    replacement.container.id = null;
    replacement.container.labels['io.assistos.ploinky-box.release-generation'] = nextGeneration;
    replacement.container.image.releaseIdentity.generation = nextGeneration;
    replacement.predecessor = {
        id: predecessor.container.id,
        state: 'stopped',
        transaction: structuredClone(predecessor.transaction),
        revision: predecessor.revision,
        container: structuredClone(containerDefinitionForTest(predecessor)),
        createdResources: structuredClone(predecessor.createdResources),
    };
    replacement.createdResources = { container: false, volumes: [] };
    replacement.phase = 'intent';
    replacement.revision = 0;

    let candidate = store.replaceIntent(predecessorCas, replacement);
    candidate = store.publishContainerId(cas(candidate), REPLACEMENT_ID);
    candidate = store.update(cas(candidate), { phase: 'rolling-back' });

    for (const stale of [
        { ...cas(candidate), generation: GENERATION },
        { ...cas(candidate), containerId: CANDIDATE_ID },
        { ...cas(candidate), revision: candidate.revision - 1 },
    ]) {
        assert.throws(() => store.restorePredecessor(stale), /CAS|stale/i);
        assert.deepEqual(store.read(), candidate);
    }

    const restored = store.restorePredecessor(cas(candidate));
    assert.equal(restored.phase, 'committed');
    assert.equal(restored.container.id, predecessor.container.id);
    assert.deepEqual(restored.transaction, predecessor.transaction);
    assert.deepEqual(containerDefinitionForTest(restored), containerDefinitionForTest(predecessor));
    assert.deepEqual(restored.createdResources, predecessor.createdResources);
    assert.equal(restored.predecessor, null);
    assert.ok(restored.revision > candidate.revision);
    assert.ok(restored.revision > predecessor.revision);

    assert.throws(
        () => store.update(predecessorCas, { phase: 'destroying' }),
        /CAS|stale/i,
    );
    assert.deepEqual(store.read(), restored);
});

test('journal phase ordering and dependency/auto-remove contract fail closed', (t) => {
    const { store, intent } = fixture(t);
    const initial = store.create(intent);
    assert.throws(() => store.update(cas(initial), { phase: 'candidate-started' }), /phase/i);
    assert.deepEqual(store.read(), initial);

    for (const mutate of [
        (value) => value.container.creation.dependencies.push(PREDECESSOR_ID),
        (value) => { value.container.creation.autoRemove = true; },
        (value) => { value.container.creation.ports = []; },
        (value) => { value.container.labels['io.assistos.ploinky-box.path-hash'] = 'bad'; },
    ]) {
        const invalid = structuredClone(intent);
        mutate(invalid);
        assert.throws(() => normalizeOuterJournalRecord(invalid, {
            workspaceRoot: intent.workspace.root,
        }), /dependencies|auto-remove|ports|labels/i);
    }
});
