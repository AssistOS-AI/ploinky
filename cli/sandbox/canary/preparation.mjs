import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isInsideBox } from '../../../ploinky-box/lib/boxMarker.mjs';
import { workspacePathHash } from '../../../ploinky-box/identity.mjs';

const prefix = 'canary-preparation-';
const markerName = /^canary-preparation-(?:box(?:-([0-9a-f]{12}))?|native)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const directoryKeys = ['dev', 'ino', 'uid', 'mode'];
const fileKeys = [...directoryKeys, 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const same = (a, b, keys) => a && b && keys.every(key => a[key] === b[key]);
const stats = { bigint: true };

function directory(location, rejectLinks) {
    const link = fs.lstatSync(location, stats);
    if (rejectLinks && link.isSymbolicLink()) throw new Error('Box canary preparation marker directory is redirected');
    const real = fs.realpathSync.native(location);
    const target = fs.statSync(real, stats);
    if (!target.isDirectory()) throw new Error('Invalid canary preparation directory');
    return { location, real, link, target };
}

function assertDirectories(directories) {
    for (const prior of directories) {
        const current = directory(prior.location, false);
        if (current.real !== prior.real || !same(prior.link, current.link, directoryKeys)
            || !same(prior.target, current.target, directoryKeys)) throw new Error('Canary preparation directory changed');
    }
}

function captureDirectories(workspaceRoot, { create = false, rejectLinks = false } = {}) {
    if (!path.isAbsolute(workspaceRoot)) throw new Error('Canary preparation requires an absolute workspace');
    const directories = [directory(workspaceRoot, false)];
    for (const part of ['.ploinky', 'running']) {
        const parent = directories.at(-1);
        const location = path.join(parent.real, part);
        if (create && !fs.lstatSync(location, { throwIfNoEntry: false })) {
            assertDirectories(directories);
            try { fs.mkdirSync(location); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        directories.push(directory(location, rejectLinks));
    }
    assertDirectories(directories);
    return directories;
}

function markerStat(file) {
    const stat = fs.lstatSync(file, stats);
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== 0n || (stat.mode & 0o7777n) !== 0o600n
        || (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))) {
        throw new Error('Unsafe canary preparation marker');
    }
    return stat;
}

function removeExact(directories, file, expected) {
    assertDirectories(directories);
    if (!same(markerStat(file), expected, fileKeys)) throw new Error('Canary preparation marker changed');
    fs.unlinkSync(file);
}

export function canaryWorkspaceOwner(workspaceRoot) {
    return isInsideBox() ? 'box-' + workspacePathHash(path.resolve(workspaceRoot)) : 'native';
}

// Independent preparations can overlap. Keep the exclusive-create descriptor
// until release, so inode reuse cannot turn a replacement into our marker.
export function registerCanaryPreparation(workspaceRoot) {
    const owner = canaryWorkspaceOwner(workspaceRoot);
    const directories = captureDirectories(workspaceRoot, { create: true });
    const file = path.join(directories.at(-1).real, prefix + owner + '-' + randomUUID());
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
        fs.fchmodSync(fd, 0o600);
        const expected = fs.fstatSync(fd, stats);
        assertDirectories(directories);
        if (!same(markerStat(file), expected, fileKeys)) throw new Error('Canary preparation marker changed at creation');
        return () => {
            try { removeExact(directories, file, expected); } finally { fs.closeSync(fd); }
        };
    } catch (error) {
        fs.closeSync(fd);
        throw error;
    }
}

export function assertNoCanaryPreparations(workspaceRoot) {
    let directories;
    try { directories = captureDirectories(workspaceRoot); } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }
    const names = fs.readdirSync(directories.at(-1).real);
    assertDirectories(directories);
    if (names.some(name => markerName.test(name))) {
        throw new Error('Workspace start or restart preparation is pending; retry canary start after it finishes');
    }
}

// The host calls this only with the selected Box proved stopped or absent.
// Leave native and ambiguous names in place: stopping a Box cannot stop
// their git children. Preserve existing no-wait handling of linked layouts
// when no Box preparation marker needs retirement.
export function snapshotBoxCanaryPreparations({ workspaceRoot, pathHash }) {
    const running = path.join(workspaceRoot, '.ploinky', 'running');
    const names = fs.readdirSync(running).filter(name => pathHash && markerName.exec(name)?.[1] === pathHash);
    if (!names.length) return () => {};
    const directories = captureDirectories(workspaceRoot, { rejectLinks: true });
    const markers = names.map(name => {
        const file = path.join(directories.at(-1).real, name);
        return { file, expected: markerStat(file) };
    });
    return assertHeld => {
        for (const { file, expected } of markers) {
            assertHeld();
            removeExact(directories, file, expected);
        }
    };
}
