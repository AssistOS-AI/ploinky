import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS, BOX_ROLES } from '../../ploinky-box/constants.mjs';
import { inspectOwnedVolumeHandle } from '../../ploinky-box/engine/discovery.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    ensureNamedVolumes,
    removeOwnedNamedVolumes,
    revalidateVolumeHandle,
    rollbackCreatedVolumes,
    volumeCreateArgs,
    volumeMountArgs,
} from '../../ploinky-box/volumes.mjs';

function setup(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-volumes-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = buildWorkspaceIdentity(root, { markerFound: true });
    const records = new Map();
    const calls = [];
    const failRemovals = new Set();
    let counter = 0;
    const roles = {
        images: BOX_ROLES.images,
        dependencies: BOX_ROLES.dependencies,
    };
    const runner = {
        query(command, args) {
            calls.push(['query', command, ...args]);
            const record = records.get(args[2]);
            return record
                ? { ok: true, stdout: JSON.stringify([record]), stderr: '' }
                : { ok: false, stdout: '', stderr: 'no such volume', error: null };
        },
        run(command, args) {
            calls.push(['run', command, ...args]);
            if (args[0] === 'volume' && args[1] === 'create') {
                const name = args.at(-1);
                const key = Object.entries(identity.volumes).find(([, value]) => value === name)[0];
                counter += 1;
                records.set(name, {
                    Name: name,
                    Driver: 'local',
                    Scope: 'local',
                    Options: {},
                    CreatedAt: `2026-07-21T00:00:0${counter}Z`,
                    Mountpoint: `/private/${counter}`,
                    Labels: {
                        [BOX_LABELS.pathHash]: identity.pathHash,
                        [BOX_LABELS.role]: roles[key],
                    },
                });
            } else if (args[0] === 'volume' && args[1] === 'rm') {
                if (failRemovals.has(args[2])) {
                    throw new Error(`injected removal failure for ${args[2]}`);
                }
                records.delete(args[2]);
            }
        },
    };
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); } };
    return { identity, records, calls, failRemovals, runner, lock };
}

test('volume create and mount arguments cover only the image cache and dependencies', (t) => {
    const { identity } = setup(t);
    const args = volumeCreateArgs(identity, 'images');
    assert.deepEqual(args, [
        'volume', 'create',
        '--label', `${BOX_LABELS.pathHash}=${identity.pathHash}`,
        '--label', `${BOX_LABELS.role}=images`,
        identity.volumes.images,
    ]);
    assert.equal(args.some((value) => value.includes('image-ref') || value.includes('host-port')), false);
    const mounts = volumeMountArgs(identity);
    assert.deepEqual(mounts, [
        '--volume', `${identity.volumes.images}:/home/podman/.local/share/ploinky-images:U`,
        '--volume', `${identity.volumes.dependencies}:/opt/ploinky/node_modules:U`,
    ]);
    // The broad inner Podman store must never be a named volume again.
    assert.equal(
        mounts.some((value) => /:\/home\/podman\/\.local\/share\/containers:/.test(value)),
        false,
    );
    for (const retired of ['containers', 'workspace']) {
        assert.throws(() => volumeCreateArgs(identity, retired), /Unknown Box volume key/);
    }
});

test('exactly two volumes are created before the caller can create a container', (t) => {
    const state = setup(t);
    const result = ensureNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
    });
    assert.equal(result.created.length, 2);
    assert.deepEqual(result.created.map(({ key }) => key), ['images', 'dependencies']);
    assert.equal(state.calls.some((call) => call.includes('container')), false);
});

test('pre-existing handles are re-inspected and never relabeled', (t) => {
    const state = setup(t);
    const first = ensureNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
    });
    state.calls.length = 0;
    const second = ensureNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
        knownHandles: first.handles,
    });
    assert.equal(second.created.length, 0);
    assert.equal(state.calls.some((call) => call[0] === 'run'), false);
});

test('same-name recreation is caught before attach or removal', (t) => {
    const state = setup(t);
    const first = ensureNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
    });
    const images = state.records.get(state.identity.volumes.images);
    state.records.set(state.identity.volumes.images, {
        ...images,
        CreatedAt: '2026-07-22T00:00:00Z',
        Mountpoint: '/private/recreated',
    });
    assert.throws(() => revalidateVolumeHandle(first.handles.images, {
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        key: 'images',
        runner: state.runner,
        lock: state.lock,
    }), /changed before mutation/);
    const runCount = state.calls.filter((call) => call[0] === 'run').length;
    assert.throws(() => rollbackCreatedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
        created: first.created,
    }), /rollback failed/);
    assert.equal(state.calls.filter((call) => call[0] === 'run').length, runCount + 1);
    assert.equal(state.records.has(state.identity.volumes.images), true);
});

test('foreign exact-name volumes cause zero volume mutation', (t) => {
    const state = setup(t);
    state.records.set(state.identity.volumes.images, {
        Name: state.identity.volumes.images,
        Driver: 'local', Scope: 'local', Options: {},
        CreatedAt: '2026-07-21T00:00:00Z', Mountpoint: '/secret/mount', Labels: {},
    });
    assert.throws(() => ensureNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
    }), /not owned/);
    assert.equal(state.calls.some((call) => call[0] === 'run'), false);
    assert.equal(JSON.stringify(state.calls).includes('/secret/mount'), false);
});

test('owned named volumes are revalidated as a complete set before exact-name deletion', (t) => {
    const state = setup(t);
    const created = ensureNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
    });
    state.calls.length = 0;
    const deleted = removeOwnedNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
        knownHandles: created.handles,
    });
    assert.deepEqual(deleted, Object.values(state.identity.volumes));
    assert.equal(state.records.size, 0);
    assert.deepEqual(
        state.calls.filter((call) => call[0] === 'run').map((call) => call.slice(-1)[0]),
        Object.values(state.identity.volumes),
    );
});

test('changed named-volume handles fail before any deletion', (t) => {
    const state = setup(t);
    const created = ensureNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
    });
    state.calls.length = 0;
    const images = state.records.get(state.identity.volumes.images);
    state.records.set(state.identity.volumes.images, {
        ...images,
        CreatedAt: '2026-07-22T00:00:00Z',
    });
    assert.throws(() => removeOwnedNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
        knownHandles: created.handles,
    }), /changed before mutation/);
    assert.equal(state.calls.some((call) => call[0] === 'run'), false);

});

test('an explicit reset removes an exactly owned partial volume set', (t) => {
    const state = setup(t);
    const created = ensureNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
    });
    state.records.delete(state.identity.volumes.images);
    state.calls.length = 0;

    const deleted = removeOwnedNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
        knownHandles: { dependencies: created.handles.dependencies },
    });

    assert.deepEqual(deleted, [state.identity.volumes.dependencies]);
    assert.equal(state.records.size, 0);
});

test('a failed multi-volume reset can be retried with the remaining owned volume', (t) => {
    const state = setup(t);
    const created = ensureNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
    });
    state.failRemovals.add(state.identity.volumes.dependencies);

    assert.throws(() => removeOwnedNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
        knownHandles: created.handles,
    }), /injected removal failure/);
    assert.equal(state.records.has(state.identity.volumes.images), false);
    assert.equal(state.records.has(state.identity.volumes.dependencies), true);

    state.failRemovals.clear();
    const deleted = removeOwnedNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
        knownHandles: { dependencies: created.handles.dependencies },
    });
    assert.deepEqual(deleted, [state.identity.volumes.dependencies]);
    assert.equal(state.records.size, 0);
});

test('an explicitly requested reset removes exactly the owned cache volumes', (t) => {
    const state = setup(t);
    const created = ensureNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
    });
    state.calls.length = 0;

    const deleted = removeOwnedNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
        knownHandles: created.handles,
    });

    assert.deepEqual(deleted, Object.values(state.identity.volumes));
    assert.equal(state.records.size, 0);
});

test('retired storage and workspace volumes are no longer inspectable roles', (t) => {
    const state = setup(t);
    for (const retired of ['containers', 'workspace']) {
        assert.throws(() => inspectOwnedVolumeHandle(
            { name: 'podman', identity: 'engine-one' },
            state.identity,
            retired,
            state.runner,
        ), /Unknown Box volume role/);
    }
    assert.equal(state.identity.legacyVolumes, undefined);
});
