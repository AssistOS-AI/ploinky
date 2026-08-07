import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    ensureWorkspaceDataPaths,
    inspectWorkspaceDataPaths,
    removeWorkspaceDataPaths,
    revalidateWorkspaceDataPaths,
    workspaceDataMountArgs,
} from '../../ploinky-box/workspace-data.mjs';

function setup(t, { anchor = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plnky-wsdata-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    if (anchor) fs.mkdirSync(path.join(workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(workspace, { markerFound: anchor });
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); } };
    // Any engine call at all would be a hard-cut regression: workspace-backed
    // persistence must never touch Podman or Docker.
    const runner = {
        query() { throw new Error('workspace data must not query an engine'); },
        run() { throw new Error('workspace data must not run an engine command'); },
    };
    return { workspace, identity, lock, runner };
}

test('mount arguments bind the exact workspace paths without engine involvement', (t) => {
    const { workspace, identity } = setup(t);

    assert.deepEqual(workspaceDataMountArgs(identity), [
        '--volume',
        `${path.join(workspace, '.ploinky', 'box', 'dependencies')}:/opt/ploinky/node_modules`,
        '--volume',
        `${path.join(workspace, '.ploinky', 'box', 'images')}:/home/podman/.local/share/ploinky-images`,
    ]);
    for (const argument of workspaceDataMountArgs(identity).filter((value) => value !== '--volume')) {
        const [source] = argument.split(':');
        assert.doesNotMatch(argument, /:U$/);
        assert.equal(path.isAbsolute(source), true);
        assert.equal(path.dirname(source), identity.boxDataRoot);
        assert.equal(source.includes(identity.instance), false);
    }
});

test('first creation materializes the exact layout and is idempotent afterwards', (t) => {
    const { workspace, identity, lock } = setup(t);

    const first = ensureWorkspaceDataPaths({ identity, lock });
    assert.deepEqual(first.created, [
        path.join(workspace, '.ploinky', 'box'),
        path.join(workspace, '.ploinky', 'box', 'dependencies'),
        path.join(workspace, '.ploinky', 'box', 'images'),
    ]);
    assert.deepEqual(first.paths, {
        dependencies: path.join(workspace, '.ploinky', 'box', 'dependencies'),
        images: path.join(workspace, '.ploinky', 'box', 'images'),
    });
    for (const value of Object.values(first.fingerprints)) {
        assert.match(value, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(
        fs.readdirSync(path.join(workspace, '.ploinky', 'box')).sort(),
        ['dependencies', 'images'],
    );

    fs.writeFileSync(path.join(workspace, '.ploinky', 'box', 'images', 'canary'), 'kept');
    const second = ensureWorkspaceDataPaths({ identity, lock });
    assert.deepEqual(second.created, []);
    assert.equal(
        fs.readFileSync(path.join(workspace, '.ploinky', 'box', 'images', 'canary'), 'utf8'),
        'kept',
    );
});

test('partial pre-existence creates only the missing directory', (t) => {
    const { workspace, identity, lock } = setup(t);
    fs.mkdirSync(path.join(workspace, '.ploinky', 'box'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.ploinky', 'box', 'dependencies'));

    const result = ensureWorkspaceDataPaths({ identity, lock });

    assert.deepEqual(result.created, [path.join(workspace, '.ploinky', 'box', 'images')]);
});

test('files and symlinks where directories are required fail closed', (t) => {
    const { workspace, identity, lock } = setup(t);
    fs.mkdirSync(path.join(workspace, '.ploinky', 'box'));
    fs.writeFileSync(path.join(workspace, '.ploinky', 'box', 'dependencies'), 'not a directory');

    assert.throws(
        () => ensureWorkspaceDataPaths({ identity, lock }),
        /Box data path is not a real directory/,
    );
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky', 'box', 'images')), false);

    fs.rmSync(path.join(workspace, '.ploinky', 'box', 'dependencies'));
    const elsewhere = path.join(workspace, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(workspace, '.ploinky', 'box', 'dependencies'), 'dir');
    assert.throws(
        () => ensureWorkspaceDataPaths({ identity, lock }),
        /Box data path is not a real directory/,
    );
});

test('a missing workspace anchor fails closed before any directory is created', (t) => {
    const { workspace, identity, lock } = setup(t, { anchor: false });

    assert.throws(
        () => ensureWorkspaceDataPaths({ identity, lock }),
        /Workspace identity anchor is missing/,
    );
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky')), false);
});

test('a non-writable data directory is rejected rather than silently reused', (t) => {
    const { workspace, identity, lock } = setup(t);
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        t.skip('root bypasses directory permission bits');
        return;
    }
    ensureWorkspaceDataPaths({ identity, lock });
    const images = path.join(workspace, '.ploinky', 'box', 'images');
    fs.chmodSync(images, 0o500);
    try {
        assert.throws(
            () => ensureWorkspaceDataPaths({ identity, lock }),
            /is not writable by this process/,
        );
        assert.throws(
            () => revalidateWorkspaceDataPaths({ identity, lock }),
            /is not writable by this process/,
        );
    } finally {
        fs.chmodSync(images, 0o700);
    }
});

test('every workspace data operation requires the exact mutation lock', (t) => {
    const { identity, lock } = setup(t);
    const foreign = { assertHeld() { throw new Error('lock is held for another workspace'); } };

    for (const operation of [
        ensureWorkspaceDataPaths,
        revalidateWorkspaceDataPaths,
        removeWorkspaceDataPaths,
    ]) {
        assert.throws(
            () => operation({ identity, lock: null }),
            /requires the Box mutation lock/,
        );
        assert.throws(
            () => operation({ identity, lock: {} }),
            /requires the Box mutation lock/,
        );
        assert.throws(
            () => operation({ identity, lock: foreign }),
            /lock is held for another workspace/,
        );
    }
    ensureWorkspaceDataPaths({ identity, lock });
});

test('revalidation detects a data directory that disappeared or changed type', (t) => {
    const { workspace, identity, lock } = setup(t);
    ensureWorkspaceDataPaths({ identity, lock });

    const revalidated = revalidateWorkspaceDataPaths({ identity, lock });
    assert.deepEqual(revalidated.paths, {
        dependencies: path.join(workspace, '.ploinky', 'box', 'dependencies'),
        images: path.join(workspace, '.ploinky', 'box', 'images'),
    });
    assert.deepEqual(revalidated.fingerprints, inspectWorkspaceDataPaths({ identity }).fingerprints);

    fs.rmSync(path.join(workspace, '.ploinky', 'box', 'images'), { recursive: true });
    assert.throws(
        () => revalidateWorkspaceDataPaths({ identity, lock }),
        (error) => error.code === 'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
    );

    fs.writeFileSync(path.join(workspace, '.ploinky', 'box', 'images'), 'replaced');
    assert.throws(
        () => revalidateWorkspaceDataPaths({ identity, lock }),
        (error) => error.code === 'PLOINKY_BOX_WORKSPACE_DATA_CHANGED',
    );
});

test('cache deletion removes exactly the two Box directories and nothing else', (t) => {
    const { workspace, identity, lock } = setup(t);
    ensureWorkspaceDataPaths({ identity, lock });
    fs.writeFileSync(path.join(workspace, '.ploinky', 'box', 'images', 'layer'), 'image data');
    fs.writeFileSync(path.join(workspace, '.ploinky', 'box', 'dependencies', 'marker.json'), '{}');
    fs.writeFileSync(path.join(workspace, '.ploinky', 'master-key'), 'secret');
    fs.mkdirSync(path.join(workspace, '.ploinky', 'repos'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.ploinky', 'agents.json'), '{}');
    fs.writeFileSync(path.join(workspace, 'workspace-file.txt'), 'user data');

    const removed = removeWorkspaceDataPaths({ identity, lock });

    assert.deepEqual(removed, [
        path.join(workspace, '.ploinky', 'box', 'dependencies'),
        path.join(workspace, '.ploinky', 'box', 'images'),
    ]);
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky', 'box')), false);
    assert.deepEqual(
        fs.readdirSync(path.join(workspace, '.ploinky')).sort(),
        ['agents.json', 'master-key', 'repos'],
    );
    assert.equal(fs.readFileSync(path.join(workspace, '.ploinky', 'master-key'), 'utf8'), 'secret');
    assert.equal(fs.readFileSync(path.join(workspace, 'workspace-file.txt'), 'utf8'), 'user data');
});

test('parent symlink substitution is rejected by inspection, revalidation, and deletion', (t) => {
    const { workspace, identity, lock } = setup(t);
    ensureWorkspaceDataPaths({ identity, lock });
    const originalRoot = path.join(workspace, 'displaced-box-root');
    fs.renameSync(identity.boxDataRoot, originalRoot);
    fs.writeFileSync(path.join(originalRoot, 'dependencies', 'sentinel'), 'keep');
    fs.writeFileSync(path.join(originalRoot, 'images', 'sentinel'), 'keep');
    fs.symlinkSync(originalRoot, identity.boxDataRoot, 'dir');

    for (const operation of [
        () => inspectWorkspaceDataPaths({ identity }),
        () => revalidateWorkspaceDataPaths({ identity, lock }),
        () => removeWorkspaceDataPaths({ identity, lock }),
    ]) {
        assert.throws(operation, /Box data root is not a real directory/);
    }
    assert.equal(
        fs.readFileSync(path.join(originalRoot, 'dependencies', 'sentinel'), 'utf8'),
        'keep',
    );
    assert.equal(fs.readFileSync(path.join(originalRoot, 'images', 'sentinel'), 'utf8'), 'keep');
});

test('cache deletion preflights every target before removing the first one', (t) => {
    const { identity, lock } = setup(t);
    ensureWorkspaceDataPaths({ identity, lock });
    const dependencyCanary = path.join(identity.dataPaths.dependencies, 'sentinel');
    fs.writeFileSync(dependencyCanary, 'keep');
    fs.rmSync(identity.dataPaths.images, { recursive: true });
    fs.writeFileSync(identity.dataPaths.images, 'invalid');

    assert.throws(
        () => removeWorkspaceDataPaths({ identity, lock }),
        /not a real directory/,
    );
    assert.equal(fs.readFileSync(dependencyCanary, 'utf8'), 'keep');
    assert.equal(fs.readFileSync(identity.dataPaths.images, 'utf8'), 'invalid');
});

test('directory fingerprints change when a canonical bind source is replaced', (t) => {
    const { workspace, identity, lock } = setup(t);
    const before = ensureWorkspaceDataPaths({ identity, lock });
    const displaced = path.join(workspace, 'displaced-dependencies');
    fs.renameSync(identity.dataPaths.dependencies, displaced);
    fs.mkdirSync(identity.dataPaths.dependencies);

    const after = inspectWorkspaceDataPaths({ identity });
    assert.notEqual(after.fingerprints.dependencies, before.fingerprints.dependencies);
    assert.equal(after.fingerprints.images, before.fingerprints.images);
});

test('cache deletion is idempotent and retains unrelated Box-root content', (t) => {
    const { workspace, identity, lock } = setup(t);

    assert.deepEqual(removeWorkspaceDataPaths({ identity, lock }), []);

    ensureWorkspaceDataPaths({ identity, lock });
    fs.writeFileSync(path.join(workspace, '.ploinky', 'box', 'unexpected.txt'), 'kept');
    const removed = removeWorkspaceDataPaths({ identity, lock });

    assert.equal(removed.length, 2);
    assert.deepEqual(fs.readdirSync(path.join(workspace, '.ploinky', 'box')), ['unexpected.txt']);
    assert.deepEqual(removeWorkspaceDataPaths({ identity, lock }), []);
});

test('workspace data management never reaches an engine runner', (t) => {
    const { identity, lock, runner } = setup(t);

    ensureWorkspaceDataPaths({ identity, lock, runner });
    revalidateWorkspaceDataPaths({ identity, lock, runner });
    removeWorkspaceDataPaths({ identity, lock, runner });

    const source = fs.readFileSync(
        path.resolve(import.meta.dirname, '../../ploinky-box/workspace-data.mjs'),
        'utf8',
    );
    assert.doesNotMatch(source, /podman|docker|volume create|volume rm|volume inspect/i);
});
