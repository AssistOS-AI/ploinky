import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PloinkyBoxError } from './errors.mjs';

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
        try { stat = fs.lstatSync(directory); } catch (error) {
            if (error.code === 'ENOENT' && directory !== workspaceRoot) return null;
            throw cleanupError('Cannot inspect the selected workspace no-wait directory');
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()
            || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
            || (directory !== workspaceRoot && (stat.mode & 0o022) !== 0)) {
            throw cleanupError('The selected workspace no-wait path is not a secure owned directory');
        }
        if (directory === workspaceRoot && (String(stat.dev) !== rootFingerprint?.device
            || String(stat.ino) !== rootFingerprint?.inode || stat.mode !== rootFingerprint?.mode)) {
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

function retireStartLock(workspaceRoot, before) {
    const after = inspectStartLock(workspaceRoot);
    if (Boolean(before) !== Boolean(after) || (before && ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs']
        .some((key) => before[key] !== after[key]))) {
        throw cleanupError('The destroyed Box workspace mutation lock changed during cleanup');
    }
    // The exact Box is stopped or absent: its workers are gone. Never probe or signal
    // a recorded PID in the host namespace, including legacy bare-PID locks.
    if (after) fs.unlinkSync(path.join(workspaceRoot, '.ploinky', 'running', 'workspace-start.json'));
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
    lock.assertHeld(identity.instance);
    assertDirectoriesUnchanged(identity.workspaceRoot, identity.rootFingerprint, snapshots);
    retireStartLock(identity.workspaceRoot, startLock);
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
    retireStartLock(identity.workspaceRoot, startLock);
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

if (process.argv[1] && path.resolve(process.argv[1]) === HELPER_PATH) {
    try {
        if (process.argv.length !== 4 || !path.isAbsolute(process.argv[2])) {
            throw cleanupError('Invalid no-wait cleanup invocation');
        }
        await retireMarkersInChild(process.argv[2], JSON.parse(process.argv[3]));
    } catch {
        process.exitCode = 1;
    }
}
