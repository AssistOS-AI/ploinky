import fs from 'node:fs';
import { isAgentRepositoryUnregistered } from './agentRepositoryRegistration.mjs';
import path from 'node:path';
import { repositoryAmbiguityError, repositoryEntries, repositoryIdentity, repositoryOrigin, workspaceRepositoryPath, workspaceRepositories as discoverWorkspaceRepositories } from './repositorySource.mjs';
import { PLOINKY_WORKSPACE_ROOT, REPOS_DIR } from './config.js';
import { getPredefinedRepos, getRepoSources } from './repos.js';
import { memoizeRepositoryRead } from './repositoryResolutionScope.mjs';
import { readRegisteredAgents, repositoryPins } from './agentSourcePin.mjs';
export { runWithRepositoryResolutionScope } from './repositoryResolutionScope.mjs';

const directoryEntries = repositoryEntries;
function hasAgents(candidate) {
    return memoizeRepositoryRead('hasAgents', candidate, () => directoryEntries(candidate).some(entry => entry.isDirectory() && !entry.name.startsWith('.')
        && fs.existsSync(path.join(candidate, entry.name, 'manifest.json'))));
}
const originIdentity = repositoryOrigin;

// Read lazily: repos.js also uses this module to choose installation sources.
function registeredSources() {
    return memoizeRepositoryRead('sources', PLOINKY_WORKSPACE_ROOT, () => ({ ...getPredefinedRepos(), ...getRepoSources() }));
}

function workspaceRepositories() {
    return discoverWorkspaceRepositories(PLOINKY_WORKSPACE_ROOT, hasAgents);
}

function canonicalPath(value) {
    try { return fs.realpathSync(value); }
    catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return path.resolve(value);
        throw error;
    }
}

function insideManagedRepos(directory) {
    const relative = path.relative(canonicalPath(REPOS_DIR), directory);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// The source pins of enabled agents, per repository name (agentSourcePin.mjs).
// An unreadable registry yields no pins; every launch reads it again itself.
function registeredRepositoryPins() {
    return memoizeRepositoryRead('pins', PLOINKY_WORKSPACE_ROOT, () => {
        let agents = {};
        try { agents = readRegisteredAgents({ workspaceRoot: PLOINKY_WORKSPACE_ROOT }); } catch (_) { agents = {}; }
        return repositoryPins(agents);
    });
}

/**
 * The folder the enabled agents of a repository are pinned to, or null.
 * Enabled agents keep starting from it whatever other folders appear later;
 * pins of one repository that disagree refuse that repository only.
 */
export function pinnedAgentRepositoryPath(name) {
    const pin = registeredRepositoryPins().get(name);
    if (!pin) return null;
    if (pin.error) throw pin.error;
    return pin.path;
}

// Registered aliases retain their identity even when the checkout has a
// different name. This is the resolution a new enable makes; it ignores pins.
export function freshWorkspaceAgentRepositoryPath(name, { url = null } = {}) {
    return workspaceRepositoryPath(name, { workspaceRoot: PLOINKY_WORKSPACE_ROOT,
        url: url || registeredSources()[name]?.url, accept: hasAgents });
}

function assertRegistered(name) {
    if (isAgentRepositoryUnregistered(name)) {
        throw new Error(`Repository '${name}' is unregistered; install it explicitly before using it.`);
    }
}

/** The fresh (pin-ignoring) repository folder a new enable would choose. */
export function freshAgentRepositoryPath(name) {
    assertRegistered(name);
    return freshWorkspaceAgentRepositoryPath(name) || path.join(REPOS_DIR, name);
}

// The workspace checkout of a repository, or null for the installed copy: the
// pinned folder when its enabled agents are pinned, else the fresh resolution.
export function workspaceAgentRepositoryPath(name, { url = null } = {}) {
    const pinned = pinnedAgentRepositoryPath(name);
    if (pinned) return insideManagedRepos(pinned) ? null : pinned;
    return freshWorkspaceAgentRepositoryPath(name, { url });
}

export function resolveAgentRepositoryPath(name) {
    assertRegistered(name);
    return pinnedAgentRepositoryPath(name) || freshWorkspaceAgentRepositoryPath(name) || path.join(REPOS_DIR, name);
}

/**
 * The repository folder a new enable, a re-enable or bare-name planning may
 * use: the fresh resolution, refused when two workspace folders claim the
 * repository or when it differs from the folder enabled agents are pinned to
 * while that folder still exists. The message names the conflicting folders.
 */
export function planningAgentRepositoryPath(name) {
    const fresh = canonicalPath(freshAgentRepositoryPath(name));
    // Pinned folders that are gone do not count: after a checkout moves, each
    // agent can be enabled again toward the folder the repository resolves to.
    const existing = existingPinnedFolders(name);
    if (existing.length > 1) throw splitPinsError(name, existing);
    const [pinned] = existing;
    if (pinned && pinned !== fresh) {
        throw repositoryAmbiguityError(name, [pinned, fresh], {
            message: `Repository '${name}' is enabled from '${displayFolder(pinned)}', but the folder '${displayFolder(fresh)}' `
                + 'now also claims it. Ploinky will not enable from a second folder: remove or rename '
                + `'${displayFolder(fresh)}', or remove '${displayFolder(pinned)}' first if you are moving the repository on purpose.`,
        });
    }
    return fresh;
}

function splitPinsError(name, folders) {
    return repositoryAmbiguityError(name, folders, {
        message: `Repository '${name}' has enabled agents pinned to different existing folders `
            + `(${folders.map(folder => `'${displayFolder(folder)}'`).join(' and ')}). Remove the folder that should not supply it, `
            + 'then enable its agents again from the remaining one.',
    });
}

function displayFolder(directory) {
    const relative = path.relative(canonicalPath(PLOINKY_WORKSPACE_ROOT), directory);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : directory;
}

export function listAgentRepositoryNames() {
    return [...memoizeRepositoryRead('names', PLOINKY_WORKSPACE_ROOT, readAgentRepositoryNames).names];
}

// Repositories left unresolved because two workspace folders carry their
// origin: [{ name, error }]. They are absent from listAgentRepositoryNames, so
// loops over every repository keep working; resolving one by name refuses.
// A repository whose enabled agents are pinned stays resolved (to its pin)
// for launches; `{ planning: true }` also lists it, for new enables.
export function unresolvedAgentRepositories({ planning = false } = {}) {
    const listing = memoizeRepositoryRead('names', PLOINKY_WORKSPACE_ROOT, readAgentRepositoryNames);
    return (planning ? listing.planningUnresolved : listing.unresolved).map(entry => ({ ...entry }));
}

// The repositories a new enable or re-enable may search: the listed ones plus
// a repository whose enabled agents' pins disagree only because some pinned
// folders are gone (a moved checkout part-way through re-enabling its agents).
export function planningAgentRepositoryNames() {
    return [...memoizeRepositoryRead('names', PLOINKY_WORKSPACE_ROOT, readAgentRepositoryNames).planningNames];
}

// The pinned folders of a repository's enabled agents that still exist.
function existingPinnedFolders(name) {
    const pin = registeredRepositoryPins().get(name);
    if (!pin) return [];
    const folders = pin.error ? pin.error.candidates || [] : [pin.path];
    return [...new Set(folders.filter(folder => folder && fs.existsSync(folder)))].sort();
}

function readAgentRepositoryNames() {
    const names = new Set(directoryEntries(REPOS_DIR)
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
        .map(entry => entry.name));
    const sources = registeredSources();
    const origins = [];
    for (const entry of workspaceRepositories()) {
        const identity = originIdentity(entry.directory);
        origins.push({ name: entry.name, directory: entry.directory, identity });
        const aliases = identity ? Object.entries(sources)
            .filter(([, source]) => repositoryIdentity(source.url) === identity)
            .map(([name]) => name) : [];
        if (aliases.length && !aliases.includes(entry.name)) {
            names.delete(entry.name);
            aliases.forEach(name => names.add(name));
        } else names.add(entry.name);
    }
    // A pinned repository is listed under its own name, and the folder it is
    // pinned to never also appears under its folder name.
    const pins = registeredRepositoryPins();
    for (const [name, pin] of pins) {
        if (!pin.path) {
            names.add(name);
            continue;
        }
        for (const entry of origins) {
            if (entry.name !== name && canonicalPath(entry.directory) === pin.path) names.delete(entry.name);
        }
        names.add(name);
    }
    const resolved = [];
    const unresolved = [];
    const freshUnresolved = [];
    const planningUnresolved = [];
    const planningNames = [];
    for (const name of [...names].filter(entry => !isAgentRepositoryUnregistered(entry)).sort()) {
        // The forward resolver's origin scan (workspaceRepositoryPath), from
        // the origins read above: a name without its own folder whose
        // registered origin two workspace folders carry is unresolved.
        const identity = repositoryIdentity(sources[name]?.url || '');
        const matches = identity && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== 'node_modules'
            && !hasAgents(path.join(PLOINKY_WORKSPACE_ROOT, name))
            ? origins.filter(entry => entry.identity === identity)
            : [];
        const ambiguity = matches.length > 1 ? repositoryAmbiguityError(name, matches.map(entry => entry.directory)) : null;
        if (ambiguity) freshUnresolved.push({ name, error: ambiguity });
        const pin = pins.get(name);
        if (pin?.error) {
            unresolved.push({ name, error: pin.error });
            // For planning, only pinned folders that still exist can disagree.
            const existing = existingPinnedFolders(name);
            if (existing.length > 1) planningUnresolved.push({ name, error: splitPinsError(name, existing) });
            else if (!ambiguity) planningNames.push(name);
        } else if (ambiguity && !pin?.path) unresolved.push({ name, error: ambiguity });
        else resolved.push(name);
        if (ambiguity) planningUnresolved.push({ name, error: ambiguity });
    }
    planningNames.push(...resolved.filter(name => !freshUnresolved.some(entry => entry.name === name)));
    return { names: resolved, unresolved, freshUnresolved, planningUnresolved, planningNames: [...new Set(planningNames)].sort() };
}

// Source directory names are not principal names: a workspace checkout may
// supply a registered repository under a different local folder name.
export function resolveAgentRepositoryName(agentPath) {
    const repositoryPath = path.resolve(path.dirname(agentPath));
    const canonicalPath = value => {
        try { return fs.realpathSync(value); }
        catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return path.resolve(value);
            throw error;
        }
    };
    const physicalPath = canonicalPath(repositoryPath);
    const matches = listAgentRepositoryNames().filter(name =>
        canonicalPath(resolveAgentRepositoryPath(name)) === physicalPath);
    if (matches.length > 1) {
        throw new Error(`Agent source belongs to multiple registered repositories: ${matches.join(', ')}`);
    }
    if (!matches.length) {
        // A folder of an unresolved repository has no principal name; it never
        // takes its folder name instead.
        const unresolved = unresolvedAgentRepositories().find(entry =>
            entry.error.candidates.some(candidate => canonicalPath(candidate) === physicalPath));
        if (unresolved) throw unresolved.error;
    }
    return matches[0] || path.basename(repositoryPath);
}
