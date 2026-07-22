import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS, BOX_ROLES, BOX_SCHEMA_VERSION } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    ensureNamedVolumes,
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
    let counter = 0;
    const roles = {
        workspace: BOX_ROLES.workspace,
        containers: BOX_ROLES.containers,
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
                        [BOX_LABELS.schema]: BOX_SCHEMA_VERSION,
                        [BOX_LABELS.pathHash]: identity.pathHash,
                        [BOX_LABELS.role]: roles[key],
                    },
                });
            } else if (args[0] === 'volume' && args[1] === 'rm') {
                records.delete(args[2]);
            }
        },
    };
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); } };
    return { identity, records, calls, runner, lock };
}

test('volume create and mount arguments contain immutable labels and :U only', (t) => {
    const { identity } = setup(t);
    const args = volumeCreateArgs(identity, 'workspace');
    assert.deepEqual(args, [
        'volume', 'create',
        '--label', `${BOX_LABELS.schema}=1`,
        '--label', `${BOX_LABELS.pathHash}=${identity.pathHash}`,
        '--label', `${BOX_LABELS.role}=workspace`,
        identity.volumes.workspace,
    ]);
    assert.equal(args.some((value) => value.includes('image-ref') || value.includes('host-port')), false);
    assert.deepEqual(volumeMountArgs(identity), [
        '--volume', `${identity.volumes.workspace}:/workspace:U`,
        '--volume', `${identity.volumes.containers}:/home/podman/.local/share/containers:U`,
        '--volume', `${identity.volumes.dependencies}:/opt/ploinky/node_modules:U`,
    ]);
});

test('exactly three volumes are created before the caller can create a container', (t) => {
    const state = setup(t);
    const result = ensureNamedVolumes({
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        runner: state.runner,
        lock: state.lock,
    });
    assert.equal(result.created.length, 3);
    assert.deepEqual(result.created.map(({ key }) => key), ['workspace', 'containers', 'dependencies']);
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
    const workspace = state.records.get(state.identity.volumes.workspace);
    state.records.set(state.identity.volumes.workspace, {
        ...workspace,
        CreatedAt: '2026-07-22T00:00:00Z',
        Mountpoint: '/private/recreated',
    });
    assert.throws(() => revalidateVolumeHandle(first.handles.workspace, {
        engine: { name: 'podman', identity: 'engine-one' },
        identity: state.identity,
        key: 'workspace',
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
    assert.equal(state.calls.filter((call) => call[0] === 'run').length, runCount + 2);
    assert.equal(state.records.has(state.identity.volumes.workspace), true);
});

test('foreign exact-name volumes cause zero volume mutation', (t) => {
    const state = setup(t);
    state.records.set(state.identity.volumes.workspace, {
        Name: state.identity.volumes.workspace,
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
