import fs from 'node:fs';
import path from 'node:path';

import { BOX_DATA_KEYS } from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { hardwareStorePaths } from '../../cli/sandbox/hardwareLimits/store.mjs';
import { checkoutShadowMount } from '../contract/checkoutAlias.mjs';
import { boxWorkspaceRoots } from './nested.mjs';
import {
    ancestorDirectoryIdentities,
    containsPath,
    directoryIdentity,
    hasHostStateComponent,
    realpathOfNearestExisting,
    strictlyInside,
} from './paths.mjs';

// Confinement of the Box's writable binds (plan D1). Every read-write bind
// source other than the workspace root itself must resolve strictly inside
// the workspace and away from every protected root: this workspace's
// `.ploinky-box`, any path component that folds to `.ploinky-box` (another
// workspace's host state), the invoking checkout when it lies inside the
// workspace, and any other Box's workspace. `.ploinky` and `.ploinky/box`,
// through which the data directories are created, follow the same rule.
// The engine receives the resolved location, so a link inside the workspace
// is never followed again at create time. The one writable bind inside
// `.ploinky-box` is the hardware-limits store, whose source must be exactly
// `<workspace>/.ploinky-box/hardware-limits/<instance>/store`.

function escapeError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_DATA_PATH_ESCAPES' });
}

function overlapError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_HOST_STATE_OVERLAP' });
}

function resolveReal(target, fsApi) {
    try {
        return realpathOfNearestExisting(target, fsApi);
    } catch (error) {
        throw escapeError(`Unable to resolve the Box data path ${target}: ${error?.code || error?.message}`);
    }
}

function protectedRootsOf(identity, workspaceReal, { fsApi, repositoryRoot, view }) {
    const roots = [];
    const hostState = path.join(workspaceReal, path.basename(identity.hostStateRoot));
    roots.push({ real: hostState, label: `the host state directory ${identity.hostStateRoot}` });
    const hostStateReal = resolveReal(identity.hostStateRoot, fsApi);
    if (hostStateReal !== hostState) {
        roots.push({ real: hostStateReal, label: `the host state directory ${identity.hostStateRoot}` });
    }
    if (repositoryRoot) {
        const checkoutReal = resolveReal(path.resolve(repositoryRoot), fsApi);
        if (strictlyInside(workspaceReal, checkoutReal)) {
            roots.push({ real: checkoutReal, label: `the Ploinky checkout ${repositoryRoot}` });
        }
    }
    const others = boxWorkspaceRoots(view, { fsApi })
        .filter((root) => root.real !== workspaceReal)
        .map((root) => ({
            real: root.real,
            label: `the workspace ${root.source} of Box ${root.container.name || root.container.id}`,
        }));
    return { roots, others };
}

// `bindSource` applies the full rule; the parents through which the data
// directories are created must only stay inside the workspace and outside
// every protected root.
function assertConfined(subject, target, real, workspaceReal, protectedRoots, fsApi, { bindSource = true } = {}) {
    if (!strictlyInside(workspaceReal, real)) {
        throw escapeError(
            `${subject} ${target} resolves to ${real}, which is not inside the workspace ${workspaceReal}. `
            + 'Writable Box binds must stay inside the workspace; replace that link with a directory inside it, '
            + 'then run the command again.',
        );
    }
    if (hasHostStateComponent(real)) {
        throw overlapError(`${subject} ${target} resolves into a host state directory (${real}); nothing was changed.`);
    }
    const realIdentity = directoryIdentity(real, fsApi);
    const realAncestors = ancestorDirectoryIdentities(real, fsApi);
    for (const root of protectedRoots.roots) {
        const rootIdentity = directoryIdentity(root.real, fsApi);
        if (containsPath(root.real, real) || (rootIdentity && realAncestors.has(rootIdentity))
            || (bindSource && (containsPath(real, root.real)
                || (realIdentity && ancestorDirectoryIdentities(root.real, fsApi).has(realIdentity))))) {
            throw overlapError(`${subject} ${target} overlaps ${root.label}; nothing was changed.`);
        }
    }
    for (const other of bindSource ? protectedRoots.others : []) {
        if (containsPath(real, other.real)) {
            throw overlapError(`${subject} ${target} contains ${other.label}; nothing was changed.`);
        }
    }
}

/**
 * Resolves and confines `.ploinky`, `.ploinky/box` and every Box data path,
 * without creating or changing anything. Returns the source the engine must
 * receive for each data key: the resolved location, spelled under the
 * selected workspace root (identical to the literal path when no link inside
 * the workspace is involved).
 */
export function resolveBoxDataSources(identity, { fsApi = fs, repositoryRoot = null, view = [] } = {}) {
    let workspaceReal;
    try {
        workspaceReal = fsApi.realpathSync(identity.workspaceRoot);
    } catch (error) {
        throw escapeError(`Unable to resolve the workspace ${identity.workspaceRoot}: ${error?.code || error?.message}`);
    }
    const protectedRoots = protectedRootsOf(identity, workspaceReal, { fsApi, repositoryRoot, view });
    const parents = [['The workspace anchor', identity.anchorPath], ['The Box data root', identity.boxDataRoot]];
    for (const [subject, target] of parents) {
        const real = resolveReal(target, fsApi);
        assertConfined(subject, target, real, workspaceReal, protectedRoots, fsApi, { bindSource: false });
    }
    const sources = {};
    for (const key of BOX_DATA_KEYS) {
        const target = identity.dataPaths[key];
        const real = resolveReal(target, fsApi);
        assertConfined(`The Box ${key} data path`, target, real, workspaceReal, protectedRoots, fsApi);
        sources[key] = path.join(identity.workspaceRoot, path.relative(workspaceReal, real));
    }
    return Object.freeze({ workspaceReal, sources: Object.freeze(sources) });
}

function volumeParts(value) {
    const text = String(value);
    const first = text.indexOf(':');
    const second = first < 0 ? -1 : text.indexOf(':', first + 1);
    if (first <= 0) return null;
    const source = text.slice(0, first);
    const destination = second < 0 ? text.slice(first + 1) : text.slice(first + 1, second);
    const options = second < 0 ? [] : text.slice(second + 1).split(',');
    return { source, destination, rw: !options.includes('ro') };
}

/**
 * The check immediately before `container create`: the data sources still
 * resolve exactly as they did when the paths were prepared, and every
 * read-write `--volume` of the rendered arguments is the workspace bind, one
 * of those data sources or the exact hardware store.
 */
export function assertCreateArgsConfined(identity, argv, {
    fsApi = fs,
    repositoryRoot = null,
    view = [],
    dataSources,
}) {
    const current = resolveBoxDataSources(identity, { fsApi, repositoryRoot, view }).sources;
    for (const key of BOX_DATA_KEYS) {
        if (!dataSources || current[key] !== dataSources[key]) {
            throw new PloinkyBoxError(
                `The Box ${key} data path ${identity.dataPaths[key]} changed after it was prepared; nothing was created.`,
                { code: 'PLOINKY_BOX_WORKSPACE_DATA_CHANGED' },
            );
        }
    }
    const allowed = new Set(Object.values(current));
    const store = hardwareStorePaths({ identity }).storeRoot;
    // The checkout's parent directories may each be bound onto itself, and
    // nothing else (contract/checkoutAlias.mjs).
    const selfBinds = new Set(repositoryRoot
        ? (checkoutShadowMount(identity.workspaceRoot, repositoryRoot, { fsApi })?.parents || []).map((parent) => parent.source)
        : []);
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] !== '--volume') continue;
        const volume = volumeParts(argv[index + 1]);
        if (!volume) throw escapeError(`Unrecognized Box volume ${argv[index + 1]}`);
        if (!volume.rw) continue;
        if (volume.source === identity.workspaceRoot && volume.destination === identity.workspaceRoot) continue;
        if (allowed.has(volume.source) || volume.source === store) continue;
        if (selfBinds.has(volume.source) && volume.destination === volume.source) continue;
        throw escapeError(`The writable Box bind ${volume.source} is not a confined workspace path; nothing was created.`);
    }
}

/**
 * Starting an existing Box re-resolves the bind sources it recorded at
 * create time. Each recorded data source must still be a confined workspace
 * path that resolves to itself, with no link inside the workspace, so the
 * engine binds exactly the directory the fingerprint labels name.
 */
export function assertRecordedDataSourcesConfined(identity, container, {
    fsApi = fs,
    repositoryRoot = null,
    view = [],
    dataDestinations,
}) {
    let workspaceReal;
    try {
        workspaceReal = fsApi.realpathSync(identity.workspaceRoot);
    } catch (error) {
        throw escapeError(`Unable to resolve the workspace ${identity.workspaceRoot}: ${error?.code || error?.message}`);
    }
    const protectedRoots = protectedRootsOf(identity, workspaceReal, { fsApi, repositoryRoot, view });
    const destinations = new Set(dataDestinations);
    for (const mount of container?.runtime?.mounts || []) {
        if (!destinations.has(mount.destination)) continue;
        const real = resolveReal(mount.source, fsApi);
        assertConfined('The recorded Box data source', mount.source, real, workspaceReal, protectedRoots, fsApi);
        if (path.join(identity.workspaceRoot, path.relative(workspaceReal, real)) !== mount.source) {
            throw new PloinkyBoxError(
                `The recorded Box data source ${mount.source} now resolves to ${real}; the stopped Box was not started. `
                + 'Run `ploinky restart` to recreate it.',
                { code: 'PLOINKY_BOX_WORKSPACE_DATA_CHANGED' },
            );
        }
    }
}
