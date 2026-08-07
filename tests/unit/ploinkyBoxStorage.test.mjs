import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    configureBoxStorage,
    parsePodmanStorageInfo,
    renderStorageConf,
    validatePodmanStorage,
    writeStorageConf,
} from '../../ploinky-box/entrypoint/storage.mjs';

const CAPTURED_5_8_2 = JSON.parse(fs.readFileSync(
    path.join(import.meta.dirname, '../fixtures/ploinky-box/podman-info-storage-5.8.2.json'),
    'utf8',
));

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-storage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = {
        storageConf: path.join(root, 'config/containers/storage.conf'),
        graphRoot: path.join(root, 'share/containers/storage'),
        storageRunRoot: path.join(root, 'run/storage-run-1000'),
        imageStore: path.join(root, 'share/ploinky-images'),
    };
    fs.mkdirSync(paths.graphRoot, { recursive: true });
    fs.mkdirSync(paths.imageStore, { recursive: true });
    return { root, paths };
}

function infoStore(paths, overrides = {}) {
    return JSON.stringify({
        store: {
            configFile: paths.storageConf,
            graphDriverName: 'overlay',
            graphRoot: paths.graphRoot,
            runRoot: paths.storageRunRoot,
            volumePath: path.join(paths.graphRoot, 'volumes'),
            imageStore: { number: 0 },
            transientStore: true,
            ...overrides,
        },
    });
}

function runnerFor(paths, { overrides = {}, ok = true, initializeStore = true } = {}) {
    const calls = [];
    return {
        calls,
        query(command, args) {
            calls.push([command, ...args]);
            if (!ok) return { ok: false, stdout: '', stderr: 'podman unavailable' };
            if (initializeStore) {
                fs.mkdirSync(path.join(paths.imageStore, 'overlay-images'), { recursive: true });
            }
            return { ok: true, stdout: infoStore(paths, overrides), stderr: '' };
        },
    };
}

test('the rendered storage configuration is the exact intended TOML', () => {
    assert.equal(renderStorageConf({
        graphRoot: '/home/podman/.local/share/containers/storage',
        runRoot: '/tmp/storage-run-1000',
        imageStore: '/home/podman/.local/share/ploinky-images',
    }), [
        '[storage]',
        'driver = "overlay"',
        'graphroot = "/home/podman/.local/share/containers/storage"',
        'runroot = "/tmp/storage-run-1000"',
        'imagestore = "/home/podman/.local/share/ploinky-images"',
        'transient_store = true',
        '',
        '[storage.options.overlay]',
        'mount_program = "/usr/bin/fuse-overlayfs"',
        // Required by the workspace-backed image store: unpacking a layer onto
        // the macOS Podman Machine host bind (virtiofs) otherwise fails with
        // "setting up pivot dir: mkdir ./.pivot_root…: permission denied".
        'force_mask = "0700"',
        '',
    ].join('\n'));

    for (const bad of ['relative/path', '/quote"injection', '/new\nline', '']) {
        assert.throws(() => renderStorageConf({
            graphRoot: bad, runRoot: '/tmp/r', imageStore: '/images',
        }), /absolute clean graphRoot path/);
    }
});

test('the configuration is written atomically as a private regular file', (t) => {
    const { paths } = fixture(t);
    const contents = renderStorageConf({
        graphRoot: paths.graphRoot,
        runRoot: paths.storageRunRoot,
        imageStore: paths.imageStore,
    });
    writeStorageConf({ target: paths.storageConf, contents });

    assert.equal(fs.readFileSync(paths.storageConf, 'utf8'), contents);
    assert.equal(fs.statSync(paths.storageConf).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(paths.storageConf)).mode & 0o777, 0o700);
    // No staged temporary file survives a successful commit.
    assert.deepEqual(fs.readdirSync(path.dirname(paths.storageConf)), ['storage.conf']);

    // Rewriting replaces the file in place and stays private.
    writeStorageConf({ target: paths.storageConf, contents });
    assert.equal(fs.statSync(paths.storageConf).mode & 0o777, 0o600);
});

test('symlinked and irregular configuration targets fail closed', (t) => {
    const { root, paths } = fixture(t);
    const contents = renderStorageConf({
        graphRoot: paths.graphRoot,
        runRoot: paths.storageRunRoot,
        imageStore: paths.imageStore,
    });
    const decoy = path.join(root, 'decoy');
    fs.writeFileSync(decoy, 'attacker-owned');
    fs.mkdirSync(path.dirname(paths.storageConf), { recursive: true });
    fs.symlinkSync(decoy, paths.storageConf);
    assert.throws(
        () => writeStorageConf({ target: paths.storageConf, contents }),
        /not a private regular file/,
    );
    assert.equal(fs.readFileSync(decoy, 'utf8'), 'attacker-owned');

    fs.unlinkSync(paths.storageConf);
    fs.mkdirSync(paths.storageConf);
    assert.throws(
        () => writeStorageConf({ target: paths.storageConf, contents }),
        /not a private regular file/,
    );
});

test('a failed atomic commit leaves no staged file behind', (t) => {
    const { paths } = fixture(t);
    fs.mkdirSync(path.dirname(paths.storageConf), { recursive: true });
    const fsApi = {
        ...fs,
        renameSync() { throw new Error('rename refused'); },
    };
    assert.throws(() => writeStorageConf({
        target: paths.storageConf,
        contents: 'x',
        fsApi,
    }), /Unable to commit storage configuration/);
    assert.deepEqual(fs.readdirSync(path.dirname(paths.storageConf)), []);
});

test('the captured Podman 5.8.2 store record parses to the intended effective values', () => {
    const observed = parsePodmanStorageInfo(JSON.stringify(CAPTURED_5_8_2));
    assert.equal(CAPTURED_5_8_2.version.Version, '5.8.2');
    assert.deepEqual({ ...observed }, {
        configFile: '/home/podman/.config/containers/storage.conf',
        driver: 'overlay',
        graphRoot: '/home/podman/.local/share/containers/storage',
        runRoot: '/tmp/storage-run-1000',
        volumePath: '/home/podman/.local/share/containers/storage/volumes',
        transientStore: true,
        imageStoreShapeVerified: true,
    });
    // Inner named volumes must ride the disposable graphroot, never the cache.
    assert.equal(
        observed.volumePath.startsWith('/home/podman/.local/share/containers/storage/'),
        true,
    );
    // store.imageStore is an image count on this release, never the path.
    assert.equal(typeof CAPTURED_5_8_2.store.imageStore.number, 'number');
    assert.equal(CAPTURED_5_8_2.store.graphOptions['overlay.imagestore'], undefined);
});

test('validation accepts the intended effective storage and proves the image cache on disk', (t) => {
    const { paths } = fixture(t);
    const runner = runnerFor(paths);
    const observed = validatePodmanStorage({
        runner,
        storageConf: paths.storageConf,
        graphRoot: paths.graphRoot,
        runRoot: paths.storageRunRoot,
        imageStore: paths.imageStore,
    });
    assert.deepEqual(runner.calls, [['podman', 'info', '--format', 'json']]);
    assert.equal(observed.transientStore, true);
    assert.equal(fs.existsSync(path.join(paths.imageStore, 'overlay-images')), true);
});

test('every effective storage mismatch fails closed', (t) => {
    const cases = [
        ['configFile', { configFile: '/etc/containers/storage.conf' }, /configFile=/],
        ['driver', { graphDriverName: 'vfs' }, /driver=vfs/],
        ['graphRoot', { graphRoot: '/somewhere/else' }, /graphRoot=/],
        ['runRoot', { runRoot: '/somewhere/else' }, /runRoot=/],
        ['transientStore', { transientStore: false }, /transientStore=false/],
    ];
    for (const [label, overrides, pattern] of cases) {
        const { paths } = fixture(t);
        assert.throws(() => validatePodmanStorage({
            runner: runnerFor(paths, { overrides }),
            storageConf: paths.storageConf,
            graphRoot: paths.graphRoot,
            runRoot: paths.storageRunRoot,
            imageStore: paths.imageStore,
        }), pattern, `expected ${label} mismatch to fail closed`);
    }
});

test('an inner volume path outside the disposable graphroot fails closed', (t) => {
    const { paths } = fixture(t);
    assert.throws(() => validatePodmanStorage({
        runner: runnerFor(paths, {
            overrides: { volumePath: path.join(paths.imageStore, 'volumes') },
        }),
        storageConf: paths.storageConf,
        graphRoot: paths.graphRoot,
        runRoot: paths.storageRunRoot,
        imageStore: paths.imageStore,
    }), /volumePath=/);
});

test('a Podman release that changes the imageStore shape is not silently trusted', (t) => {
    // Every shape other than the verified image-count object must fail closed,
    // including one that starts carrying the effective path.
    for (const imageStore of [
        undefined,
        {},
        '/home/podman/.local/share/ploinky-images',
        { number: '1' },
        { number: null },
        { number: -1 },
        { number: 1.5 },
        { number: 1, path: '/home/podman/.local/share/ploinky-images' },
        { Path: '/home/podman/.local/share/ploinky-images' },
        ['/home/podman/.local/share/ploinky-images'],
        null,
    ]) {
        const { paths } = fixture(t);
        assert.throws(() => validatePodmanStorage({
            runner: runnerFor(paths, { overrides: { imageStore } }),
            storageConf: paths.storageConf,
            graphRoot: paths.graphRoot,
            runRoot: paths.storageRunRoot,
            imageStore: paths.imageStore,
        }), /must be revalidated before it is trusted/, `shape ${JSON.stringify(imageStore)}`);
    }
    // Only the exact verified nonnegative integer-count shape is acceptable.
    for (const imageStore of [{ number: 0 }, { number: 42 }]) {
        const { paths } = fixture(t);
        assert.equal(validatePodmanStorage({
            runner: runnerFor(paths, { overrides: { imageStore } }),
            storageConf: paths.storageConf,
            graphRoot: paths.graphRoot,
            runRoot: paths.storageRunRoot,
            imageStore: paths.imageStore,
        }).imageStoreShapeVerified, true);
    }
});

test('an image cache Podman never adopted fails closed', (t) => {
    const { paths } = fixture(t);
    assert.throws(() => validatePodmanStorage({
        runner: runnerFor(paths, { initializeStore: false }),
        storageConf: paths.storageConf,
        graphRoot: paths.graphRoot,
        runRoot: paths.storageRunRoot,
        imageStore: paths.imageStore,
    }), /was not adopted by Podman/);
});

test('unreachable or malformed Podman storage information fails closed', (t) => {
    const { paths } = fixture(t);
    assert.throws(() => validatePodmanStorage({
        runner: runnerFor(paths, { ok: false }),
        storageConf: paths.storageConf,
        graphRoot: paths.graphRoot,
        runRoot: paths.storageRunRoot,
        imageStore: paths.imageStore,
    }), /Unable to inspect Podman storage/);
    assert.throws(() => parsePodmanStorageInfo('not json'), /not valid JSON/);
    assert.throws(() => parsePodmanStorageInfo('{}'), /no store record/);
});

test('configuration is written before Podman storage is ever queried', (t) => {
    const { paths } = fixture(t);
    const order = [];
    const runner = {
        query(command, args) {
            order.push('query');
            assert.equal(fs.existsSync(paths.storageConf), true,
                'podman must never be consulted before its configuration exists');
            fs.mkdirSync(path.join(paths.imageStore, 'overlay-images'), { recursive: true });
            return { ok: true, stdout: infoStore(paths), stderr: '' };
        },
    };
    const result = configureBoxStorage({
        runner,
        storageConf: paths.storageConf,
        graphRoot: paths.graphRoot,
        runRoot: paths.storageRunRoot,
        imageStore: paths.imageStore,
    });
    assert.deepEqual(order, ['query']);
    assert.equal(result.storageConf, path.resolve(paths.storageConf));
    assert.equal(result.transientStore, true);
});

test('a missing image cache or graphroot mount fails before any configuration write', (t) => {
    const { paths } = fixture(t);
    for (const missing of [paths.imageStore, paths.graphRoot]) {
        fs.rmSync(missing, { recursive: true, force: true });
        assert.throws(() => configureBoxStorage({
            runner: { query() { throw new Error('must not query podman'); } },
            storageConf: paths.storageConf,
            graphRoot: paths.graphRoot,
            runRoot: paths.storageRunRoot,
            imageStore: paths.imageStore,
        }), /is missing/);
        assert.equal(fs.existsSync(paths.storageConf), false);
        fs.mkdirSync(missing, { recursive: true });
    }
});
