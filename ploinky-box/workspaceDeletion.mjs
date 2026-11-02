import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assertCheckoutPlacement } from './contract/checkoutAlias.mjs';
import { PloinkyBoxError } from './errors.mjs';
import { assertNotNestedWorkspace } from './hostState/nested.mjs';
import { containsPath, realpathOfNearestExisting, strictlyInside } from './hostState/paths.mjs';
import { HOST_STATE_SKELETON } from './hostState/root.mjs';

// `ploinky destroy --delete-data`: the irreversible removal of everything
// inside a workspace directory. The checks here are read-only and run before
// the workspace lock, which itself writes into the directory, and again under
// it. Removal reports counts only: the callers' logs must never name user files.

const REMOVAL_TIMEOUT_MS = 30 * 60 * 1000;
const PROC_MOUNT_TABLE = '/proc/self/mountinfo';

function refusal(message, cause) {
    const error = new PloinkyBoxError(`${message} Nothing was deleted.`, {
        code: 'PLOINKY_BOX_WORKSPACE_DELETE_REFUSED',
        cause,
    });
    error.reason = message;
    return error;
}

/** A check that refused once the Box was already gone: only the data was kept. */
export function workspaceDataKeptError(error) {
    return new PloinkyBoxError(
        'The Box is gone and its operator records were removed, but no workspace data was deleted: '
        + `${error?.reason || error?.message || error} Run the same command again once that is resolved.`,
        { code: 'PLOINKY_BOX_WORKSPACE_DELETE_KEPT', cause: error },
    );
}

function lstatOrNull(target, fsApi) {
    try {
        return fsApi.lstatSync(target);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw refusal(`Unable to inspect ${target}.`, error);
    }
}

function isRealDirectory(stat) {
    return Boolean(stat) && stat.isDirectory() && !stat.isSymbolicLink();
}

function decodeMountPoint(value) {
    return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Refuses a mount strictly inside the workspace. A workspace that is itself a mount point is fine. */
export function assertNoMountsInside(workspaceReal, mountTable) {
    for (const line of String(mountTable || '').split('\n')) {
        const mountPoint = line.split(' ')[4];
        if (mountPoint && strictlyInside(workspaceReal, decodeMountPoint(mountPoint))) {
            throw refusal(`A filesystem is mounted inside ${workspaceReal}. Unmount it first.`);
        }
    }
}

// Without a mount table, a different device anywhere below the root is the
// signal, and an unreadable directory cannot be proven free of one. The errors
// name no entry: their callers' logs must not show user file names.
function assertTreeOnOneDevice(workspaceRoot, fsApi) {
    const device = String(fsApi.lstatSync(workspaceRoot).dev);
    const pending = [workspaceRoot];
    while (pending.length > 0) {
        const directory = pending.pop();
        let names;
        try {
            names = fsApi.readdirSync(directory);
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw refusal(`Unable to read all of ${workspaceRoot} to prove that no volume is mounted inside it.`);
        }
        for (const name of names) {
            const target = path.join(directory, name);
            let stat;
            try {
                stat = fsApi.lstatSync(target);
            } catch (error) {
                if (error?.code === 'ENOENT') continue;
                throw refusal(`Unable to read all of ${workspaceRoot} to prove that no volume is mounted inside it.`);
            }
            if (String(stat.dev) !== device) {
                throw refusal(`A filesystem is mounted inside ${workspaceRoot}. Unmount it first.`);
            }
            if (stat.isDirectory()) pending.push(target);
        }
    }
}

/** The read-only path checks. Safe before the lock: they write nothing. */
export function assertWorkspaceDeletionPaths(identity, {
    confirmWorkspace,
    repositoryRoot,
    homeDirectory = os.homedir(),
    platform = process.platform,
    readMountTable,
    fsApi = fs,
} = {}) {
    const root = identity.workspaceRoot;
    if (confirmWorkspace !== root) {
        throw refusal(`--confirm-workspace must be exactly this workspace: ${root}.`);
    }
    if (!isRealDirectory(lstatOrNull(root, fsApi))) {
        throw refusal(`The workspace must be a real directory, not a link: ${root}.`);
    }
    const workspaceReal = fsApi.realpathSync(root);
    if (containsPath(workspaceReal, realpathOfNearestExisting(homeDirectory, fsApi))) {
        throw refusal(`The workspace ${root} is or contains the home directory.`);
    }
    const anchor = lstatOrNull(identity.anchorPath, fsApi);
    const hostState = lstatOrNull(identity.hostStateRoot, fsApi);
    if (!anchor && !hostState) {
        throw refusal(`${root} is not a Ploinky workspace: it has no .ploinky or .ploinky-box directory.`);
    }
    // A link's target would survive while this command reported success.
    for (const target of [
        identity.anchorPath,
        identity.hostStateRoot,
        path.join(identity.anchorPath, 'data'),
        path.join(root, '.data'),
    ]) {
        const stat = lstatOrNull(target, fsApi);
        if (stat && !isRealDirectory(stat)) {
            throw refusal(`${target} must be a real directory: its data would outlive this command.`);
        }
    }
    const envFile = path.join(root, '.env');
    if (lstatOrNull(envFile, fsApi)?.isSymbolicLink()) {
        throw refusal(`${envFile} must not be a link: its keys would outlive this command.`);
    }
    const { checkoutReal } = assertCheckoutPlacement(root, repositoryRoot, { fsApi });
    if (strictlyInside(workspaceReal, checkoutReal)) {
        throw refusal(`The running Ploinky checkout ${repositoryRoot} lies inside the workspace. Run Ploinky from a checkout outside it.`);
    }
    if (platform === 'linux') {
        const readTable = readMountTable || (() => fsApi.readFileSync(PROC_MOUNT_TABLE, 'utf8'));
        assertNoMountsInside(workspaceReal, readTable());
    } else {
        assertTreeOnOneDevice(root, fsApi);
    }
}

function removesWithPodman(engine, platform) {
    return platform === 'linux' && engine?.name === 'podman';
}

/**
 * Refuses when another workspace or a running container depends on this
 * directory. A running container's binds live in its own mount namespace, so
 * the host mount table cannot show them; the engine's view can.
 */
export function assertNoLiveWorkspaceUsers(identity, view, {
    engine,
    excludeContainerIds = [],
    platform = process.platform,
    runner,
    fsApi = fs,
} = {}) {
    assertNotNestedWorkspace(identity, view, { fsApi });
    const workspaceReal = realpathOfNearestExisting(identity.workspaceRoot, fsApi);
    for (const container of view || []) {
        if (!container.running || excludeContainerIds.includes(container.id)) continue;
        for (const mount of container.mounts || []) {
            if (!path.isAbsolute(mount.source || '')) continue;
            let real;
            try {
                real = realpathOfNearestExisting(mount.source, fsApi);
            } catch (_) {
                real = path.resolve(mount.source);
            }
            if (containsPath(workspaceReal, real)) {
                throw refusal(`The running container ${container.name || container.id} has a mount inside ${identity.workspaceRoot}. Stop it first.`);
            }
        }
    }
    // Removal runs in this namespace, so its mounts are the ones that matter.
    if (removesWithPodman(engine, platform)) {
        const table = runner.query('podman', ['unshare', 'cat', PROC_MOUNT_TABLE]);
        if (!table.ok) throw refusal('Unable to read the mount table of the Podman user namespace.');
        assertNoMountsInside(workspaceReal, table.stdout);
    }
}

// `.ploinky` is emptied, not removed, and comes last: the marker keeps later
// commands here from walking up to a marked ancestor, and an interrupted run
// resolves the same workspace again. The host state skeleton stays because the
// lock being held lives in it and a masked Box keeps it as mount points.
function removalGroups(identity) {
    return [
        {
            root: identity.workspaceRoot,
            keep: [path.basename(identity.anchorPath), path.basename(identity.hostStateRoot)],
        },
        { root: identity.hostStateRoot, keep: HOST_STATE_SKELETON.map((entry) => entry.name) },
        { root: path.join(identity.hostStateRoot, 'quarantine'), keep: [] },
        { root: identity.anchorPath, keep: [], identityAnchor: true },
    ];
}

function countEntries({ root, keep }, fsApi) {
    let names;
    try {
        names = fsApi.readdirSync(root, { encoding: 'buffer' });
    } catch (error) {
        if (error?.code === 'ENOENT') return 0;
        throw error;
    }
    return names.filter((name) => !keep.includes(name.toString())).length;
}

// No entry name passes through Node here, so a non-UTF-8 name is still removed.
export function podmanRemovalArgs({ root, keep }) {
    return [
        'unshare', 'find', root, '-mindepth', '1', '-maxdepth', '1',
        ...keep.flatMap((name) => ['!', '-name', name]),
        '-exec', 'rm', '-rf', '--one-file-system', '--', '{}', '+',
    ];
}

function removeWithNode({ root, keep }, fsApi) {
    for (const name of fsApi.readdirSync(root)) {
        if (keep.includes(name)) continue;
        // The failure carries a path and the recount below reports it.
        try { fsApi.rmSync(path.join(root, name), { recursive: true, force: true }); } catch (_) { /* counted */ }
    }
}

/** Removes the workspace contents under the lock and returns how many entries went. */
export function removeWorkspaceContents(identity, {
    lock,
    engine,
    platform = process.platform,
    runner,
    fsApi = fs,
} = {}) {
    let removedEntries = 0;
    let remainingEntries = 0;
    for (const group of removalGroups(identity)) {
        if (group.identityAnchor && remainingEntries > 0) continue;
        lock.assertHeld(identity.instance);
        const before = countEntries(group, fsApi);
        if (before === 0) continue;
        if (removesWithPodman(engine, platform)) {
            // Only the recount decides; its stderr names files. The fixed cwd
            // survives removal of a subdirectory the command was launched from.
            runner.query('podman', podmanRemovalArgs(group), {
                cwd: identity.workspaceRoot,
                timeoutMs: REMOVAL_TIMEOUT_MS,
            });
        } else {
            removeWithNode(group, fsApi);
        }
        const after = countEntries(group, fsApi);
        removedEntries += before - after;
        remainingEntries += after;
    }
    if (remainingEntries > 0) {
        throw new PloinkyBoxError(
            `The Box is gone but ${remainingEntries} workspace entries could not be deleted (${removedEntries} were). `
            + 'Run the same command again to finish; a file owned outside this user\'s subordinate ID range needs an administrator.',
            { code: 'PLOINKY_BOX_WORKSPACE_DELETE_INCOMPLETE' },
        );
    }
    return Object.freeze({ removedEntries });
}
