import fs from 'node:fs';
import path from 'node:path';

import { PloinkyBoxError } from './errors.mjs';

const STATE_PARTS = ['.ploinky', 'data', 'edge-routing'];
const LEASE_NAME = 'preparation-lease.json';
const MAX_LEASE_BYTES = 1024 * 1024;

function cleanupError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_EDGE_PREPARATION_CLEANUP_FAILED' });
}

function inspectDirectories(identity) {
    const directories = [identity.workspaceRoot, ...STATE_PARTS.map((_, index) => (
        path.join(identity.workspaceRoot, ...STATE_PARTS.slice(0, index + 1))
    ))];
    const snapshots = [];
    for (const directory of directories) {
        let stat;
        try { stat = fs.lstatSync(directory); } catch (error) {
            if (error.code === 'ENOENT' && directory !== identity.workspaceRoot) return null;
            throw cleanupError('Cannot inspect the selected workspace edge preparation directory');
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()
            || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
            || (directory !== identity.workspaceRoot && (stat.mode & 0o022) !== 0)) {
            throw cleanupError('The selected workspace edge preparation path is not a secure owned directory');
        }
        if (directory === identity.workspaceRoot
            && (String(stat.dev) !== identity.rootFingerprint?.device
                || String(stat.ino) !== identity.rootFingerprint?.inode
                || stat.mode !== identity.rootFingerprint?.mode)) {
            throw cleanupError('Workspace identity changed before edge preparation cleanup');
        }
        snapshots.push(stat);
    }
    return snapshots;
}

function inspectLease(leasePath) {
    let stat;
    try { stat = fs.lstatSync(leasePath); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw cleanupError('Cannot inspect the quiescent Box edge preparation lease');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
        || (stat.mode & 0o022) !== 0 || stat.size > MAX_LEASE_BYTES) {
        throw cleanupError('The quiescent Box edge preparation lease is not a bounded secure owned regular file');
    }
    return stat;
}

// The caller must prove the exact Box is stopped or absent under the host
// workspace lock. Only then is its unfinished preparation safe to retire.
export function retireQuiescentBoxEdgePreparation({ identity, lock }) {
    if (!lock || typeof lock.assertHeld !== 'function') {
        throw cleanupError('Edge preparation cleanup requires the workspace mutation lock');
    }
    lock.assertHeld(identity.instance);
    const directoriesBefore = inspectDirectories(identity);
    if (!directoriesBefore) return;
    const leasePath = path.join(identity.workspaceRoot, ...STATE_PARTS, LEASE_NAME);
    const leaseBefore = inspectLease(leasePath);
    lock.assertHeld(identity.instance);
    const directoriesAfter = inspectDirectories(identity);
    if (!directoriesAfter || directoriesAfter.some((stat, index) => (
        ['dev', 'ino', 'mode', 'uid'].some((key) => stat[key] !== directoriesBefore[index][key])
    ))) {
        throw cleanupError('Workspace edge preparation directories changed during cleanup');
    }
    const leaseAfter = inspectLease(leasePath);
    if (Boolean(leaseBefore) !== Boolean(leaseAfter)
        || (leaseBefore && ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs']
            .some((key) => leaseBefore[key] !== leaseAfter[key]))) {
        throw cleanupError('The quiescent Box edge preparation lease changed during cleanup');
    }
    // The owning Box is gone; payload validity and host PID liveness cannot
    // establish ownership. Keep every other routing and workspace record intact.
    if (leaseAfter) fs.unlinkSync(leasePath);
}
