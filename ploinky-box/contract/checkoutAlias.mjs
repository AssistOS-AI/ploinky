// Read-only shadow of the invoking Ploinky checkout (plan D6).
//
// The Box runs Ploinky from a read-only bind of the checkout at /opt/ploinky.
// When that checkout lies inside the workspace, the writable workspace bind
// exposes the same files a second time at their workspace path, where in-Box
// code could edit the host CLI, its `.git` (and so the source lock) and its
// `node_modules`. A read-only bind of the checkout over that path, rendered
// after the workspace bind, closes the alias; nested agents inherit it through
// their recursive binds. A shadow covers one path, not the directories above
// it: renaming `<ws>/.runtime` inside the Box would carry the shadow away and
// let the Box plant a tree where the host runs Ploinky from. Every directory
// strictly between the workspace and the checkout is therefore bound onto
// itself read-write, which keeps write access inside it unchanged but makes it
// a mount point that cannot be renamed or removed.

import fs from 'node:fs';
import path from 'node:path';

import { PloinkyBoxError } from '../errors.mjs';
import {
    containsPath,
    hasHostStateComponent,
    realpathOfNearestExisting,
    strictlyInside,
} from '../hostState/paths.mjs';
import { boxWorkspacePath } from './workspace-root.mjs';

function aliasError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_CHECKOUT_ALIAS_INVALID' });
}

// A path that does not exist yet is judged by its nearest existing ancestor.
function realpathOf(target, fsApi, subject) {
    try {
        return realpathOfNearestExisting(target, fsApi);
    } catch (error) {
        throw aliasError(`Unable to resolve ${subject} ${target}: ${error?.code || error?.message}`);
    }
}

/**
 * The checkout placement rules that hold before anything is written into the
 * workspace: the workspace may not be the checkout or lie inside it, and a
 * checkout inside the workspace may not lie inside `.ploinky-box`.
 */
export function assertCheckoutPlacement(workspaceRoot, repositoryRoot, { fsApi = fs } = {}) {
    const workspaceReal = realpathOf(workspaceRoot, fsApi, 'the workspace');
    const checkoutReal = realpathOf(path.resolve(repositoryRoot), fsApi, 'the Ploinky checkout');
    if (containsPath(checkoutReal, workspaceReal)) {
        throw aliasError(
            `The workspace ${workspaceRoot} ${checkoutReal === workspaceReal ? 'is' : 'lies inside'} the Ploinky checkout `
            + `${repositoryRoot}. A Box would make the Ploinky code that runs on the host writable from inside it. `
            + 'Run Ploinky from a workspace directory outside its checkout (create one with a `.ploinky` directory).',
        );
    }
    if (strictlyInside(workspaceReal, checkoutReal)
        && hasHostStateComponent(path.relative(workspaceReal, checkoutReal))) {
        throw aliasError(`The Ploinky checkout ${repositoryRoot} lies inside the host state directory of ${workspaceRoot}.`);
    }
    return Object.freeze({ workspaceReal, checkoutReal });
}

/**
 * The read-only shadow bind for a checkout inside the workspace, or null when
 * the checkout lies outside it, with `parents`: the read-write self-binds of
 * every directory strictly between the workspace and the checkout, outermost
 * first. Throws PLOINKY_BOX_CHECKOUT_ALIAS_INVALID when the placement is
 * refused or a path cannot be expressed.
 *
 * @returns {Readonly<{ source: string, destination: string, rw: false, parents: ReadonlyArray<object> }>|null}
 */
export function checkoutShadowMount(workspaceRoot, repositoryRoot, { fsApi = fs } = {}) {
    const { workspaceReal, checkoutReal } = assertCheckoutPlacement(workspaceRoot, repositoryRoot, { fsApi });
    if (!strictlyInside(workspaceReal, checkoutReal)) return null;
    const relative = path.relative(workspaceReal, checkoutReal).split(path.sep).join('/');
    const source = path.resolve(repositoryRoot);
    let destination;
    try {
        destination = boxWorkspacePath(workspaceRoot, relative);
    } catch (error) {
        throw aliasError(`The Ploinky checkout ${repositoryRoot} has no expressible path inside the Box: ${error.message}`);
    }
    // Volume syntax separates source, destination and options with ':'.
    if (destination.includes(':') || source.includes(':')) {
        throw aliasError(`The Ploinky checkout path ${destination} cannot be expressed as a Box volume.`);
    }
    const segments = relative.split('/');
    const parents = [];
    for (let depth = 1; depth < segments.length; depth += 1) {
        const parent = boxWorkspacePath(workspaceRoot, segments.slice(0, depth).join('/'));
        let stat;
        try {
            stat = fsApi.lstatSync(path.join(workspaceReal, ...segments.slice(0, depth)));
        } catch (error) {
            throw aliasError(`Unable to inspect ${parent} above the Ploinky checkout: ${error?.code || error?.message}`);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw aliasError(`${parent} above the Ploinky checkout is not a real directory.`);
        }
        parents.push(Object.freeze({ source: parent, destination: parent, rw: true }));
    }
    return Object.freeze({ source, destination, rw: false, parents: Object.freeze(parents) });
}

/**
 * `container create` arguments for the checkout: the self-binds of its parent
 * directories, then the read-only shadow; empty when there is none.
 */
export function checkoutShadowArgs(mount) {
    if (!mount) return [];
    return [
        ...(mount.parents || []).flatMap((parent) => ['--volume', `${parent.source}:${parent.destination}`]),
        '--volume', `${mount.source}:${mount.destination}:ro`,
    ];
}
