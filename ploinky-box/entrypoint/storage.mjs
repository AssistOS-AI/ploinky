import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PloinkyBoxError } from '../errors.mjs';

const OVERLAY_MOUNT_PROGRAM = '/usr/bin/fuse-overlayfs';

// The image store is a host bind now, so on macOS it is virtiofs. Unpacking a
// layer there fails without this ("setting up pivot dir: mkdir ./.pivot_root…:
// permission denied"): containers/storage cannot create the layer's pivot
// directory with the permissions it wants. force_mask makes it create private
// entries and record the real mode in an xattr, which fuse-overlayfs restores
// when the layer is mounted, so in-container file modes are unchanged.
const OVERLAY_FORCE_MASK = '0700';

// containers/storage lays this directory out under the configured imagestore as
// soon as the first Podman command initializes the store.
const IMAGE_STORE_MARKER = 'overlay-images';

function storageError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_STORAGE_FAILED',
        cause,
    });
}

function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function currentGid() {
    return typeof process.getgid === 'function' ? process.getgid() : null;
}

/**
 * Only reusable image content is meant to outlive one outer Box, so the
 * graphroot stays on the Box writable layer, the runroot is a per-boot
 * tmpfs path, and only the imagestore is the workspace-backed image store
 * bound from `.ploinky/box/images` on the host.
 */
export function renderStorageConf({ graphRoot, runRoot, imageStore }) {
    for (const [name, value] of Object.entries({ graphRoot, runRoot, imageStore })) {
        if (typeof value !== 'string' || !value.startsWith('/') || /["\n\\]/.test(value)) {
            throw storageError(`Storage configuration requires an absolute clean ${name} path`);
        }
    }
    return [
        '[storage]',
        'driver = "overlay"',
        `graphroot = "${graphRoot}"`,
        `runroot = "${runRoot}"`,
        `imagestore = "${imageStore}"`,
        'transient_store = true',
        '',
        '[storage.options.overlay]',
        `mount_program = "${OVERLAY_MOUNT_PROGRAM}"`,
        `force_mask = "${OVERLAY_FORCE_MASK}"`,
        '',
    ].join('\n');
}

function assertPrivateDirectory(directory, fsApi, uid) {
    try {
        fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
        throw storageError(`Unable to create storage configuration parent ${directory}`, error);
    }
    const stat = fsApi.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw storageError(`Storage configuration parent is not a real directory: ${directory}`);
    }
    if (uid !== null && stat.uid !== uid) {
        throw storageError(`Storage configuration parent is not owned by the Box user: ${directory}`);
    }
}

function assertReplaceableTarget(target, fsApi, uid) {
    let stat;
    try {
        stat = fsApi.lstatSync(target);
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        throw storageError(`Storage configuration target is not a private regular file: ${target}`);
    }
    if (uid !== null && stat.uid !== uid) {
        throw storageError(`Storage configuration target is not owned by the Box user: ${target}`);
    }
}

function fsyncDirectory(directory, fsApi) {
    const descriptor = fsApi.openSync(directory, fsApi.constants.O_RDONLY);
    try {
        try {
            fsApi.fsyncSync(descriptor);
        } catch (error) {
            if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error;
        }
    } finally {
        fsApi.closeSync(descriptor);
    }
}

/**
 * Written independently of the atomic box-transport.json / containers.conf
 * pair: storage configuration is not part of transport rollback.
 */
export function writeStorageConf({
    target,
    contents,
    fsApi = fs,
    uid = currentUid(),
    gid = currentGid(),
    token = crypto.randomBytes(10).toString('hex'),
} = {}) {
    if (typeof contents !== 'string' || !contents) {
        throw storageError('Storage configuration requires rendered contents');
    }
    const resolved = path.resolve(target);
    const directory = path.dirname(resolved);
    assertPrivateDirectory(directory, fsApi, uid);
    assertReplaceableTarget(resolved, fsApi, uid);

    const staged = path.join(directory, `.${path.basename(resolved)}.${token}.tmp`);
    const flags = fsApi.constants.O_WRONLY
        | fsApi.constants.O_CREAT
        | fsApi.constants.O_EXCL
        | (fsApi.constants.O_NOFOLLOW || 0);
    const descriptor = fsApi.openSync(staged, flags, 0o600);
    try {
        fsApi.writeFileSync(descriptor, Buffer.from(contents));
        fsApi.fchmodSync(descriptor, 0o600);
        if (uid !== null && gid !== null) fsApi.fchownSync(descriptor, uid, gid);
        fsApi.fsyncSync(descriptor);
    } catch (error) {
        try { fsApi.closeSync(descriptor); } catch {}
        try { fsApi.unlinkSync(staged); } catch {}
        throw storageError(`Unable to stage storage configuration ${resolved}`, error);
    }
    fsApi.closeSync(descriptor);
    try {
        fsApi.renameSync(staged, resolved);
    } catch (error) {
        try { fsApi.unlinkSync(staged); } catch {}
        throw storageError(`Unable to commit storage configuration ${resolved}`, error);
    }
    fsyncDirectory(directory, fsApi);
    return resolved;
}

function storeRecord(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(String(stdout || ''));
    } catch (error) {
        throw storageError('Podman storage information is not valid JSON', error);
    }
    const store = parsed?.store;
    if (!store || typeof store !== 'object' || Array.isArray(store)) {
        throw storageError('Podman storage information has no store record');
    }
    return store;
}

/**
 * Verified against the pinned Podman 5.8.2: `store.imageStore` is an image
 * *count* (`{number: N}`), never the configured path, and `overlay.imagestore`
 * is absent from `store.graphOptions`. The effective imagestore therefore
 * cannot be asserted from `podman info` at all, so it is proven on disk
 * instead. Any future release that starts reporting a path must be adopted
 * deliberately rather than silently accepted here.
 */
export function parsePodmanStorageInfo(stdout) {
    const store = storeRecord(stdout);
    const imageStoreField = store.imageStore;
    // Accept only the exact shape verified against 5.8.2. Absence, extra keys,
    // and non-count values all indicate an unverified Podman response shape.
    const imageStoreKeys = imageStoreField
        && typeof imageStoreField === 'object'
        && !Array.isArray(imageStoreField)
        ? Object.keys(imageStoreField)
        : [];
    const imageStoreShapeVerified = imageStoreKeys.length === 1
        && imageStoreKeys[0] === 'number'
        && Number.isSafeInteger(imageStoreField.number)
        && imageStoreField.number >= 0;
    return Object.freeze({
        configFile: String(store.configFile ?? ''),
        driver: String(store.graphDriverName ?? ''),
        graphRoot: String(store.graphRoot ?? ''),
        runRoot: String(store.runRoot ?? ''),
        volumePath: String(store.volumePath ?? ''),
        transientStore: store.transientStore === true,
        imageStoreShapeVerified,
    });
}

function withinDirectory(candidate, directory) {
    const parent = path.resolve(directory);
    const target = path.resolve(candidate);
    return target === parent || target.startsWith(`${parent}${path.sep}`);
}

function assertRealDirectory(target, fsApi, label) {
    let stat;
    try {
        stat = fsApi.lstatSync(target);
    } catch (error) {
        throw storageError(`${label} is missing: ${target}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw storageError(`${label} is not a real directory: ${target}`);
    }
}

export function validatePodmanStorage({
    runner,
    storageConf,
    graphRoot,
    runRoot,
    imageStore,
    fsApi = fs,
} = {}) {
    if (!runner || typeof runner.query !== 'function') {
        throw storageError('Podman storage validation requires a process runner');
    }
    const result = runner.query('podman', ['info', '--format', 'json']);
    if (!result.ok) {
        throw storageError(
            `Unable to inspect Podman storage: ${result.stderr || 'no diagnostic'}`,
        );
    }
    const observed = parsePodmanStorageInfo(result.stdout);
    const mismatches = [];
    if (observed.configFile !== path.resolve(storageConf)) {
        mismatches.push(`configFile=${observed.configFile || '<empty>'}`);
    }
    if (observed.driver !== 'overlay') {
        mismatches.push(`driver=${observed.driver || '<empty>'}`);
    }
    if (observed.graphRoot !== path.resolve(graphRoot)) {
        mismatches.push(`graphRoot=${observed.graphRoot || '<empty>'}`);
    }
    if (observed.runRoot !== path.resolve(runRoot)) {
        mismatches.push(`runRoot=${observed.runRoot || '<empty>'}`);
    }
    if (!observed.transientStore) {
        mismatches.push('transientStore=false');
    }
    if (!observed.volumePath || !withinDirectory(observed.volumePath, graphRoot)) {
        mismatches.push(`volumePath=${observed.volumePath || '<empty>'}`);
    }
    if (observed.volumePath && withinDirectory(observed.volumePath, imageStore)) {
        mismatches.push(`volumePath=${observed.volumePath} is inside the image cache`);
    }
    if (!observed.imageStoreShapeVerified) {
        mismatches.push(
            'store.imageStore no longer has the verified image-count shape on this '
            + 'Podman release; the effective image store must be revalidated before it is trusted',
        );
    }
    if (mismatches.length > 0) {
        throw storageError(
            `Podman did not adopt the intended Box storage configuration: ${mismatches.join(', ')}`,
        );
    }
    // podman info alone initializes the store, so the imagestore layout must
    // exist by now; its absence means Podman ignored the configured path.
    assertRealDirectory(imageStore, fsApi, 'Box image cache');
    assertRealDirectory(
        path.join(imageStore, IMAGE_STORE_MARKER),
        fsApi,
        'Box image cache was not adopted by Podman; its image layout',
    );
    return observed;
}

export function configureBoxStorage({
    runner,
    storageConf,
    graphRoot,
    runRoot,
    imageStore,
    fsApi = fs,
    ...writeOptions
} = {}) {
    assertRealDirectory(graphRoot, fsApi, 'Box private container storage root');
    assertRealDirectory(imageStore, fsApi, 'Box image cache');
    const written = writeStorageConf({
        target: storageConf,
        contents: renderStorageConf({ graphRoot, runRoot, imageStore }),
        fsApi,
        ...writeOptions,
    });
    const observed = validatePodmanStorage({
        runner,
        storageConf: written,
        graphRoot,
        runRoot,
        imageStore,
        fsApi,
    });
    return Object.freeze({ storageConf: written, ...observed });
}
