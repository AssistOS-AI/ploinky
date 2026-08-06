import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS, BOX_ROLES, BOX_VOLUME_KEYS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    BOX_VOLUME_MOUNTS,
    ensureNamedVolumes,
    removeOwnedNamedVolumes,
    revalidateVolumeHandle,
    rollbackCreatedVolumes,
} from '../../ploinky-box/volumes.mjs';

function setup(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-volumes-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = buildWorkspaceIdentity(root, { markerFound: true });
    const records = new Map();
    const calls = [];
    const roles = {
        workspace: BOX_ROLES.workspace,
        containers: BOX_ROLES.containers,
        dependencies: BOX_ROLES.dependencies,
    };
    const hostClient = {
        async findVolume({ name, labels }) {
            calls.push({ operation: 'find', name, labels: { ...labels } });
            return records.get(name) || null;
        },
        async createVolume({ name, labels }) {
            calls.push({ operation: 'create', name, labels: { ...labels } });
            if (records.has(name)) throw new Error(`exact-name conflict for ${name}`);
            const record = {
                Name: name,
                Driver: 'local',
                MountCount: 0,
                Labels: { ...labels },
            };
            records.set(name, record);
            return structuredClone(record);
        },
        async deleteVolume(request) {
            calls.push({ operation: 'delete', ...request, labels: { ...request.labels } });
            if (request.transactionOwned !== true || request.knownUnused !== true) {
                throw new Error('fake deletion requires exact transaction-owned unused proof');
            }
            const record = records.get(request.name);
            if (!record || Number(record.MountCount) !== 0) {
                throw new Error('fake deletion target is absent or mounted');
            }
            records.delete(request.name);
            return { removed: true, name: request.name, absent: true };
        },
    };
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); } };
    const engine = { name: 'podman', identity: 'engine-one' };
    function seed(key, overrides = {}) {
        records.set(identity.volumes[key], {
            Name: identity.volumes[key],
            Driver: 'local',
            MountCount: 0,
            Labels: {
                [BOX_LABELS.pathHash]: identity.pathHash,
                [BOX_LABELS.role]: roles[key],
            },
            ...overrides,
        });
    }
    return { identity, records, calls, hostClient, lock, engine, seed };
}

function ensure(state, overrides = {}) {
    return ensureNamedVolumes({
        engine: state.engine,
        identity: state.identity,
        hostClient: state.hostClient,
        lock: state.lock,
        ...overrides,
    });
}

test('the mount contract remains exactly three writable named-volume destinations', () => {
    assert.deepEqual(BOX_VOLUME_KEYS, ['workspace', 'containers', 'dependencies']);
    assert.deepEqual(BOX_VOLUME_MOUNTS, {
        workspace: '/workspace',
        containers: '/home/podman/.local/share/containers',
        dependencies: '/opt/ploinky/node_modules',
    });
});

test('structured preparation creates exactly three labeled volumes and re-inspects each', async (t) => {
    const state = setup(t);
    const result = await ensure(state);

    assert.deepEqual(result.created.map(({ key }) => key), BOX_VOLUME_KEYS);
    assert.deepEqual(Object.keys(result.handles), BOX_VOLUME_KEYS);
    assert.deepEqual(state.calls.filter(({ operation }) => operation === 'create').map((call) => ({
        name: call.name,
        labels: call.labels,
    })), BOX_VOLUME_KEYS.map((key) => ({
        name: state.identity.volumes[key],
        labels: {
            [BOX_LABELS.pathHash]: state.identity.pathHash,
            [BOX_LABELS.role]: BOX_ROLES[key],
        },
    })));
    for (const key of BOX_VOLUME_KEYS) {
        assert.equal(result.handles[key].engineIdentity, state.engine.identity);
        assert.deepEqual(result.handles[key].fingerprint, {
            driver: 'local', mountCount: 0,
        });
    }
});

test('pre-existing exact handles are awaited and never recreated or relabeled', async (t) => {
    const state = setup(t);
    const first = await ensure(state);
    state.calls.length = 0;
    const second = await ensure(state, { knownHandles: first.handles });

    assert.equal(second.created.length, 0);
    assert.equal(state.calls.some(({ operation }) => operation === 'create'), false);
    assert.equal(state.calls.some(({ operation }) => operation === 'delete'), false);
    assert.equal(state.calls.filter(({ operation }) => operation === 'find').length, 6);
});

test('handle identity drift fails closed before any structured lookup or mutation', async (t) => {
    const state = setup(t);
    const created = await ensure(state);
    state.calls.length = 0;
    await assert.rejects(revalidateVolumeHandle({
        ...created.handles.workspace,
        engineIdentity: 'other-engine',
    }, {
        engine: state.engine,
        identity: state.identity,
        key: 'workspace',
        hostClient: state.hostClient,
        lock: state.lock,
    }), /changed before mutation/);
    assert.deepEqual(state.calls, []);
});

test('foreign exact-name conflict is never relabeled or deleted', async (t) => {
    const state = setup(t);
    state.records.set(state.identity.volumes.workspace, {
        Name: state.identity.volumes.workspace,
        Driver: 'local',
        MountCount: 0,
        Labels: {},
        Mountpoint: '/must-not-cross',
    });
    await assert.rejects(ensure(state), /not exactly owned/);
    assert.equal(state.calls.some(({ operation }) => operation === 'create'), false);
    assert.equal(state.calls.some(({ operation }) => operation === 'delete'), false);
    assert.equal(JSON.stringify(state.calls).includes('/must-not-cross'), false);
});

test('partial creation failure reports exact rollback evidence without guessing cleanup', async (t) => {
    const state = setup(t);
    const originalCreate = state.hostClient.createVolume;
    state.hostClient.createVolume = async (request) => {
        if (request.name === state.identity.volumes.containers) {
            throw new Error('structured create failed');
        }
        return originalCreate(request);
    };

    let failure;
    try {
        await ensure(state);
    } catch (error) {
        failure = error;
    }
    assert.match(failure?.message || '', /structured create failed/);
    assert.deepEqual(failure.createdVolumes.map(({ key }) => key), ['workspace']);
    assert.deepEqual(failure.ambiguousVolumeNames, [state.identity.volumes.containers]);
    assert.equal(state.calls.some(({ operation }) => operation === 'delete'), false);
});

test('rollback revalidates and removes only transaction-created unused volumes in reverse order', async (t) => {
    const state = setup(t);
    const created = await ensure(state);
    state.calls.length = 0;
    await rollbackCreatedVolumes({
        engine: state.engine,
        identity: state.identity,
        hostClient: state.hostClient,
        lock: state.lock,
        created: created.created,
    });

    assert.deepEqual(state.calls.filter(({ operation }) => operation === 'delete')
        .map(({ name }) => name), [...Object.values(state.identity.volumes)].reverse());
    assert.equal(state.calls.filter(({ operation }) => operation === 'delete')
        .every(({ transactionOwned, knownUnused }) => transactionOwned && knownUnused), true);
    assert.equal(state.records.size, 0);
});

test('mounted rollback targets are retained and reported as rollback failures', async (t) => {
    const state = setup(t);
    const created = await ensure(state);
    state.records.get(state.identity.volumes.workspace).MountCount = 1;
    await assert.rejects(rollbackCreatedVolumes({
        engine: state.engine,
        identity: state.identity,
        hostClient: state.hostClient,
        lock: state.lock,
        created: created.created,
    }), /rollback failed.*workspace.*not proven unused/);
    assert.equal(state.records.has(state.identity.volumes.workspace), true);
});

test('complete owned deletion validates the entire set before reverse-order removal', async (t) => {
    const state = setup(t);
    const created = await ensure(state);
    state.calls.length = 0;
    const deleted = await removeOwnedNamedVolumes({
        engine: state.engine,
        identity: state.identity,
        hostClient: state.hostClient,
        lock: state.lock,
        knownHandles: created.handles,
    });

    assert.deepEqual(deleted, Object.values(state.identity.volumes));
    assert.deepEqual(state.calls.filter(({ operation }) => operation === 'delete')
        .map(({ name }) => name), [...Object.values(state.identity.volumes)].reverse());
    assert.equal(state.records.size, 0);
});

test('changed or incomplete sets fail before the first deletion', async (t) => {
    const state = setup(t);
    const created = await ensure(state);
    state.records.delete(state.identity.volumes.containers);
    state.calls.length = 0;
    await assert.rejects(removeOwnedNamedVolumes({
        engine: state.engine,
        identity: state.identity,
        hostClient: state.hostClient,
        lock: state.lock,
        knownHandles: created.handles,
    }), /is missing/);
    assert.equal(state.calls.some(({ operation }) => operation === 'delete'), false);

    state.calls.length = 0;
    await assert.rejects(removeOwnedNamedVolumes({
        engine: state.engine,
        identity: state.identity,
        hostClient: state.hostClient,
        lock: state.lock,
        knownHandles: { workspace: created.handles.workspace },
    }), /incomplete named-volume set/);
    assert.equal(state.calls.some(({ operation }) => operation === 'delete'), false);
});
