import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PloinkyBoxError } from './errors.mjs';
import { snapshotBoxCanaryPreparations } from '../cli/sandbox/canary/preparation.mjs';

const HELPER_PATH = fileURLToPath(import.meta.url);
const MARKER_SUFFIX = '.current.json';

function cleanupError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_NO_WAIT_CLEANUP_FAILED' });
}

function inspectDirectories(workspaceRoot, rootFingerprint, includeNoWait = true) {
    const directories = [workspaceRoot, ...['.ploinky', 'running', ...(includeNoWait ? ['no-wait'] : [])].map((_, index, parts) => (
        path.join(workspaceRoot, ...parts.slice(0, index + 1))
    ))];
    const snapshots = [];
    for (const directory of directories) {
        let stat;
        let identityStat;
        try {
            identityStat = fs.lstatSync(directory);
            stat = fs.statSync(directory);
        } catch (error) {
            if (error.code === 'ENOENT' && directory !== workspaceRoot) return null;
            throw cleanupError('Cannot inspect the selected workspace no-wait directory');
        }
        // Follow directory links for replacement detection; root identity uses
        // the same link inode captured when the workspace was selected.
        if (directory === workspaceRoot && (String(identityStat.dev) !== rootFingerprint?.device
            || String(identityStat.ino) !== rootFingerprint?.inode || identityStat.mode !== rootFingerprint?.mode)) {
            throw cleanupError('Workspace identity changed before no-wait marker cleanup');
        }
        snapshots.push({ directory, device: stat.dev, inode: stat.ino, mode: stat.mode });
    }
    return snapshots;
}

function assertDirectoriesUnchanged(workspaceRoot, rootFingerprint, before) {
    const after = inspectDirectories(workspaceRoot, rootFingerprint, before.length === 4);
    if (!after || after.some((entry, index) => entry.device !== before[index].device
        || entry.inode !== before[index].inode || entry.mode !== before[index].mode)) {
        throw cleanupError('Workspace no-wait directories changed during marker cleanup');
    }
}

function inspectStartLock(workspaceRoot) {
    const lockPath = path.join(workspaceRoot, '.ploinky', 'running', 'workspace-start.json');
    let stat;
    try { stat = fs.lstatSync(lockPath); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw cleanupError('Cannot inspect the destroyed Box workspace mutation lock');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
        || (stat.mode & 0o022) !== 0) {
        throw cleanupError('The destroyed Box workspace mutation lock is not a secure owned regular file');
    }
    return stat;
}

function assertSameStartLock(before, after) {
    if (Boolean(before) !== Boolean(after) || (before && ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs']
        .some((key) => before[key] !== after[key]))) {
        throw cleanupError('The destroyed Box workspace mutation lock changed during cleanup');
    }
}

function canaryWriterBelongsElsewhere(file, stat, identity) {
    // Canary-start publishes only fixed owner, token and timestamp metadata.
    // Its capability requires owner-read permission. Keep legacy retirement
    // independent of file read access when the mode rules out such a writer.
    if (!(stat.mode & 0o400) || !stat.size || stat.size > 64 * 1024) return false;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        assertSameStartLock(stat, fs.fstatSync(fd));
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!count) throw cleanupError('The destroyed Box workspace mutation lock changed during cleanup');
            offset += count;
        }
        assertSameStartLock(stat, fs.fstatSync(fd));
        let record;
        try { record = JSON.parse(bytes); } catch { return false; }
        return record?.operation === 'canary-start'
            && (!identity.pathHash || record.canaryOwner !== 'box-' + identity.pathHash);
    } finally { fs.closeSync(fd); }
}

function retireStartLock(identity, before, directories) {
    const { workspaceRoot, rootFingerprint } = identity;
    const after = inspectStartLock(workspaceRoot);
    assertSameStartLock(before, after);
    if (!after) return;
    const file = path.join(workspaceRoot, '.ploinky', 'running', 'workspace-start.json');
    if (canaryWriterBelongsElsewhere(file, after, identity)) return;
    assertDirectoriesUnchanged(workspaceRoot, rootFingerprint, directories);
    assertSameStartLock(after, inspectStartLock(workspaceRoot));
    fs.unlinkSync(file);
}

// The caller must prove the exact Box is stopped or absent while holding the
// host workspace lock. A live Box's inner mutation lease must never be retired.
export function retireQuiescentBoxWorkspaceStartLock({ identity, lock }) {
    if (!lock || typeof lock.assertHeld !== 'function') {
        throw cleanupError('Workspace start lock cleanup requires the workspace mutation lock');
    }
    lock.assertHeld(identity.instance);
    const snapshots = inspectDirectories(identity.workspaceRoot, identity.rootFingerprint, false);
    if (!snapshots) return;
    const startLock = inspectStartLock(identity.workspaceRoot);
    const retirePreparations = snapshotBoxCanaryPreparations(identity);
    lock.assertHeld(identity.instance);
    assertDirectoriesUnchanged(identity.workspaceRoot, identity.rootFingerprint, snapshots);
    retirePreparations(() => lock.assertHeld(identity.instance));
    retireStartLock(identity, startLock, snapshots);
}

// Run only after the host has removed the exact Box or proved it already absent.
// The child confines config.js workspace discovery and environment defaults to
// this selected workspace, without importing those side effects in the host.
export function retireDestroyedBoxNoWaitMarkers({ identity, lock, spawn = spawnSync }) {
    if (!lock || typeof lock.assertHeld !== 'function') {
        throw cleanupError('No-wait marker cleanup requires the workspace mutation lock');
    }
    lock.assertHeld(identity.instance);
    const snapshots = inspectDirectories(identity.workspaceRoot, identity.rootFingerprint, false);
    if (!snapshots) return;
    const markerSnapshots = inspectDirectories(identity.workspaceRoot, identity.rootFingerprint);
    const startLock = inspectStartLock(identity.workspaceRoot);
    const retirePreparations = snapshotBoxCanaryPreparations(identity);
    const result = spawn(process.execPath, [
        HELPER_PATH, identity.workspaceRoot, JSON.stringify(identity.rootFingerprint),
    ], {
        cwd: identity.workspaceRoot,
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: identity.workspaceRoot,
            PLOINKY_CWD: identity.workspaceRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024,
    });
    lock.assertHeld(identity.instance);
    if (result.error || result.status !== 0) {
        // Child errors may contain paths; do not forward arbitrary retained
        // marker contents or inherited runtime diagnostics into host output.
        throw cleanupError('Box is absent, but secure no-wait marker cleanup failed; retained markers were not fully retired');
    }
    assertDirectoriesUnchanged(identity.workspaceRoot, identity.rootFingerprint, snapshots);
    if (markerSnapshots) assertDirectoriesUnchanged(identity.workspaceRoot, identity.rootFingerprint, markerSnapshots);
    retirePreparations(() => lock.assertHeld(identity.instance));
    retireStartLock(identity, startLock, snapshots);
}

async function retireMarkersInChild(workspaceRoot, rootFingerprint) {
    const snapshots = inspectDirectories(workspaceRoot, rootFingerprint);
    if (!snapshots) return;
    const directory = path.join(workspaceRoot, '.ploinky', 'running', 'no-wait');
    const names = fs.readdirSync(directory).filter((name) => name.endsWith(MARKER_SUFFIX)).sort();
    if (!names.length) return;
    const { retireNoWaitRunMarker } = await import('../cli/commands/noWaitMarkerLifecycle.js');
    for (const name of names) {
        assertDirectoriesUnchanged(workspaceRoot, rootFingerprint, snapshots);
        // The prior Box is gone, so even a marker from an older registry tuple
        // is obsolete. Keep its secure file/immutable container checks, while
        // leaving all run-scoped status, log, and workspace data untouched.
        retireNoWaitRunMarker(name.slice(0, -MARKER_SUFFIX.length), {
            runningDir: path.dirname(directory),
        });
    }
    assertDirectoriesUnchanged(workspaceRoot, rootFingerprint, snapshots);
}

// Node gives import.meta.url the real path, while argv[1] keeps a symlinked path
// as typed, so a run through a symlinked checkout also compares the real path.
function invokedAsMain() {
    if (!process.argv[1]) return false;
    const invokedPath = path.resolve(process.argv[1]);
    if (invokedPath === HELPER_PATH) return true;
    try { return fs.realpathSync(invokedPath) === HELPER_PATH; } catch { return false; }
}

if (invokedAsMain()) {
    try {
        if (process.argv.length !== 4 || !path.isAbsolute(process.argv[2])) {
            throw cleanupError('Invalid no-wait cleanup invocation');
        }
        await retireMarkersInChild(process.argv[2], JSON.parse(process.argv[3]));
    } catch {
        process.exitCode = 1;
    }
}
