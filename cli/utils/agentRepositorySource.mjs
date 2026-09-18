import fs from 'node:fs';
import { isAgentRepositoryUnregistered } from './agentRepositoryRegistration.mjs';
import path from 'node:path';
import { repositoryEntries, repositoryIdentity, repositoryOrigin, workspaceRepositoryPath, workspaceRepositories as discoverWorkspaceRepositories } from './repositorySource.mjs';
import { PLOINKY_WORKSPACE_ROOT, REPOS_DIR } from './config.js';
import { getPredefinedRepos, getRepoSources } from './repos.js';

const directoryEntries = repositoryEntries;
function hasAgents(candidate) {
    return directoryEntries(candidate).some(entry => entry.isDirectory() && !entry.name.startsWith('.')
        && fs.existsSync(path.join(candidate, entry.name, 'manifest.json')));
}
const originIdentity = repositoryOrigin;

// Read lazily: repos.js also uses this module to choose installation sources.
function registeredSources() {
    return { ...getPredefinedRepos(), ...getRepoSources() };
}

function workspaceRepositories() {
    return discoverWorkspaceRepositories(PLOINKY_WORKSPACE_ROOT, hasAgents);
}

// Registered aliases retain their identity even when the checkout has a different name.
export function workspaceAgentRepositoryPath(name, { url = null } = {}) {
    return workspaceRepositoryPath(name, { workspaceRoot: PLOINKY_WORKSPACE_ROOT,
        url: url || registeredSources()[name]?.url, accept: hasAgents });
}

export function resolveAgentRepositoryPath(name) {
    if (isAgentRepositoryUnregistered(name)) {
        throw new Error(`Repository '${name}' is unregistered; install it explicitly before using it.`);
    }
    return workspaceAgentRepositoryPath(name) || path.join(REPOS_DIR, name);
}

export function listAgentRepositoryNames() {
    const names = new Set(directoryEntries(REPOS_DIR)
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
        .map(entry => entry.name));
    const sources = registeredSources();
    for (const entry of workspaceRepositories()) {
        const identity = originIdentity(entry.directory);
        const aliases = identity ? Object.entries(sources)
            .filter(([, source]) => repositoryIdentity(source.url) === identity)
            .map(([name]) => name) : [];
        if (aliases.length && !aliases.includes(entry.name)) {
            names.delete(entry.name);
            aliases.forEach(name => names.add(name));
        } else names.add(entry.name);
    }
    return [...names].filter(name => !isAgentRepositoryUnregistered(name)).sort();
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
    return matches[0] || path.basename(repositoryPath);
}
