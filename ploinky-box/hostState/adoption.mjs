import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PloinkyBoxError } from '../errors.mjs';
import { readOwnerRecord } from '../lockFiles.mjs';
import { createLockLiveness, LIVENESS } from '../lockLiveness.mjs';
import {
    currentUid,
    fsyncDirectory,
    readPrivateFile,
    writePrivateFileAtomically,
} from '../privateStateFiles.mjs';
import { HOST_STAGING_LABEL } from './staging.mjs';
import { containsPath, realpathOfNearestExisting } from './paths.mjs';
import { hostStatePaths, identityHostStateRoot } from './root.mjs';

// First-use quarantine (r3 trust). Host state is trusted because only the host
// can write `.ploinky-box`: every Box masks it and every agent runtime guards
// it. Content that was there before this workspace was adopted may have been
// written by anything (an older Ploinky, an unmasked container, a copy of
// another workspace), so the first locked transaction that finds no
// `workspace.json` moves every entry except the skeleton into
// `quarantine/<UTC>-<rand>/`, then records the adoption. Nothing is trusted
// or deleted: quarantined content stays for the operator to inspect.
//
// Names are matched exactly, never by prefix or fold; an entry that is the
// same directory as a skeleton component under another spelling (a
// case-insensitive filesystem) is refused rather than moved.

export const WORKSPACE_RECORD_NAME = 'workspace.json';
export const WORKSPACE_RECORD_SCHEMA = 'ploinky-box-workspace';
export const WORKSPACE_RECORD_VERSION = 1;
export const HOST_STATE_SKELETON_NAMES = Object.freeze(['locks', 'empty', 'quarantine', 'tmp']);
const WORKSPACE_RECORD_MAX_BYTES = 4096;

function adoptionError(message, code = 'PLOINKY_BOX_HOST_STATE_INVALID', cause) {
    return new PloinkyBoxError(message, { code, cause });
}

const RECORD_FILES = Object.freeze({
    subject: 'Workspace host state record',
    stateError: (message, cause) => adoptionError(message, 'PLOINKY_BOX_HOST_STATE_INVALID', cause),
});

function recordBytes(identity) {
    return Buffer.from(`${JSON.stringify({
        schema: WORKSPACE_RECORD_SCHEMA,
        version: WORKSPACE_RECORD_VERSION,
        instance: identity.instance,
    })}\n`);
}

/**
 * The adoption record of this workspace: `valid` only for this exact instance,
 * `absent` when `.ploinky-box` has no entry named exactly `workspace.json`,
 * otherwise `invalid` (a foreign, malformed or unsafe record).
 */
export function readWorkspaceRecord(identity, { fsApi = fs } = {}) {
    const root = identityHostStateRoot(identity);
    let names;
    try {
        names = fsApi.readdirSync(root);
    } catch (error) {
        if (error?.code === 'ENOENT') return Object.freeze({ state: 'absent' });
        throw adoptionError(`Unable to read the host state directory ${root}`, undefined, error);
    }
    if (!names.includes(WORKSPACE_RECORD_NAME)) return Object.freeze({ state: 'absent' });
    let bytes;
    try {
        bytes = readPrivateFile(fsApi, path.join(root, WORKSPACE_RECORD_NAME), WORKSPACE_RECORD_MAX_BYTES,
            'The workspace host state record', RECORD_FILES);
    } catch (error) {
        return Object.freeze({ state: 'invalid', reason: error.message });
    }
    if (!bytes) return Object.freeze({ state: 'absent' });
    return Object.freeze(Buffer.compare(bytes, recordBytes(identity)) === 0
        ? { state: 'valid' }
        : { state: 'invalid', reason: 'it does not record this workspace' });
}

function utcStamp(now) {
    return now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Every mount source of a running container that lies inside `.ploinky-box`:
// such a directory is a live bind and is never moved.
function liveBindSources(hostStateReal, view, fsApi) {
    const sources = [];
    for (const container of view || []) {
        if (!container.running) continue;
        for (const mount of container.mounts || []) {
            if (!path.isAbsolute(mount.source || '')) continue;
            let real;
            try {
                real = realpathOfNearestExisting(mount.source, fsApi);
            } catch (_) {
                real = path.resolve(mount.source);
            }
            if (containsPath(hostStateReal, real)) sources.push({ real, container });
        }
    }
    return sources;
}

/**
 * Moves every entry of `.ploinky-box` except the skeleton into one new
 * `quarantine/<UTC>-<rand>/` directory, under the lock. Never moves the
 * skeleton under another spelling or a live bind source of a running
 * container: with `strict` either refuses before anything moves; otherwise
 * such entries are kept and reported, and everything else still moves.
 *
 * @returns {{ quarantine: string|null, moved: string[], kept: string[] }}
 */
export function quarantineHostStateEntries(identity, lock, {
    view = [],
    fsApi = fs,
    now = () => new Date(),
    random = () => crypto.randomBytes(6).toString('hex'),
    strict = true,
} = {}) {
    lock.assertHeld(identity.instance);
    const paths = hostStatePaths(identity.workspaceRoot);
    const skeleton = new Map();
    for (const name of HOST_STATE_SKELETON_NAMES) {
        try {
            const stat = fsApi.lstatSync(path.join(paths.root, name));
            skeleton.set(`${stat.dev}:${stat.ino}`, name);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw adoptionError(`Unable to inspect ${path.join(paths.root, name)}`, undefined, error);
        }
    }
    const names = fsApi.readdirSync(paths.root).filter((name) => !HOST_STATE_SKELETON_NAMES.includes(name)).sort();
    const hostStateReal = realpathOfNearestExisting(paths.root, fsApi);
    const live = liveBindSources(hostStateReal, view, fsApi);
    const candidates = [];
    const kept = [];
    for (const name of names) {
        const entry = path.join(paths.root, name);
        const stat = fsApi.lstatSync(entry);
        const alias = skeleton.get(`${stat.dev}:${stat.ino}`);
        const bound = live.find((source) => containsPath(path.join(hostStateReal, name), source.real));
        if (alias && strict) {
            throw adoptionError(
                `${entry} is the host state directory's own ${alias}/ under another spelling; inspect ${paths.root}. Nothing was moved.`,
            );
        }
        if (bound && strict) {
            throw adoptionError(
                `${entry} is bound by the running container ${bound.container.name || bound.container.id}; the workspace `
                + 'cannot be adopted while it runs. Run `ploinky stop` (or `ploinky destroy`), then the command again.',
                'PLOINKY_BOX_HOST_STATE_BOUND',
            );
        }
        if (alias || bound) kept.push(name);
        else candidates.push(name);
    }
    let quarantine = null;
    if (candidates.length) {
        quarantine = path.join(paths.quarantine, `${utcStamp(now)}-${random()}`);
        fsApi.mkdirSync(quarantine, { recursive: false, mode: 0o700 });
        for (const name of candidates) {
            lock.assertHeld(identity.instance);
            fsApi.renameSync(path.join(paths.root, name), path.join(quarantine, name));
        }
        fsyncDirectory(fsApi, paths.root);
    }
    return Object.freeze({ quarantine, moved: Object.freeze(candidates), kept: Object.freeze(kept) });
}

/**
 * Adopts the workspace under its lock. With a valid record nothing happens.
 * Otherwise `assertQuiescent()` must pass first; then every non-skeleton entry
 * moves into one new quarantine directory and the record is written.
 *
 * @returns {{ adopted: boolean, quarantine: string|null, moved: string[] }}
 */
export function adoptWorkspaceHostState(identity, lock, {
    view = [],
    assertQuiescent,
    fsApi = fs,
    now = () => new Date(),
    random = () => crypto.randomBytes(6).toString('hex'),
    uid = currentUid(),
} = {}) {
    lock.assertHeld(identity.instance);
    const record = readWorkspaceRecord(identity, { fsApi });
    if (record.state === 'valid') return Object.freeze({ adopted: false, quarantine: null, moved: Object.freeze([]) });
    if (typeof assertQuiescent !== 'function') {
        throw adoptionError('Adopting the workspace host state requires the quiescence gate');
    }
    assertQuiescent();
    const paths = hostStatePaths(identity.workspaceRoot);
    const { quarantine, moved: candidates } = quarantineHostStateEntries(identity, lock, { view, fsApi, now, random });
    const remaining = fsApi.readdirSync(paths.root).filter((name) => !HOST_STATE_SKELETON_NAMES.includes(name));
    if (remaining.length) {
        throw adoptionError(`Entries appeared in ${paths.root} during adoption (${remaining.join(', ')}); nothing was recorded.`);
    }
    const rootStat = fsApi.lstatSync(paths.root);
    if (uid !== null && rootStat.uid !== uid) throw adoptionError(`${paths.root} is not owned by the current user`);
    writePrivateFileAtomically(fsApi, paths.root, path.join(paths.root, WORKSPACE_RECORD_NAME), recordBytes(identity),
        () => lock.assertHeld(identity.instance), RECORD_FILES);
    fsyncDirectory(fsApi, paths.root);
    return Object.freeze({ adopted: true, quarantine, moved: Object.freeze(candidates) });
}

/**
 * Removes host staging directories (`tmp/<rand>/`) whose owner record the
 * lock liveness rules classify as stale. Never on age alone; anything that
 * cannot be attributed is left in place.
 *
 * @returns {string[]} the removed paths
 */
export function sweepStaleHostStaging(identity, lock, {
    fsApi = fs,
    liveness = createLockLiveness(),
    uid = currentUid(),
} = {}) {
    lock.assertHeld(identity.instance);
    const tmp = hostStatePaths(identity.workspaceRoot).tmp;
    let tmpStat;
    try {
        tmpStat = fsApi.lstatSync(tmp);
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
    if (tmpStat.isSymbolicLink() || !tmpStat.isDirectory()) return [];
    const removed = [];
    for (const name of fsApi.readdirSync(tmp)) {
        const entry = path.join(tmp, name);
        let before;
        try {
            before = fsApi.lstatSync(entry);
        } catch (_) {
            continue;
        }
        if (before.isSymbolicLink() || !before.isDirectory() || (uid !== null && before.uid !== uid)) continue;
        let record;
        try {
            record = readOwnerRecord(fsApi, entry);
        } catch (_) {
            continue;
        }
        if (!record?.owner || record.owner.label !== HOST_STAGING_LABEL) continue;
        if (liveness.classify(record.owner).state !== LIVENESS.stale) continue;
        const after = fsApi.lstatSync(entry);
        if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) continue;
        lock.assertHeld(identity.instance);
        // Recursive removal unlinks links it meets; it never follows them.
        fsApi.rmSync(entry, { recursive: true, force: true });
        removed.push(entry);
    }
    return removed;
}
