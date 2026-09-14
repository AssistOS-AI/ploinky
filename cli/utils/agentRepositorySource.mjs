import fs from 'node:fs';
import { isAgentRepositoryUnregistered } from './agentRepositoryRegistration.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PLOINKY_WORKSPACE_ROOT, REPOS_DIR } from './config.js';
import { getPredefinedRepos, getRepoSources } from './repos.js';

function directoryEntries(root) {
    try {
        return fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
        throw error;
    }
}

function hasAgents(candidate) {
    return directoryEntries(candidate).some(entry => (
        entry.isDirectory() && !entry.name.startsWith('.')
        && fs.existsSync(path.join(candidate, entry.name, 'manifest.json'))
    ));
}

function repositoryIdentity(value) {
    const raw = String(value || '').trim().replace(/^git@([^:]+):/, 'ssh://git@$1/');
    try {
        const url = new URL(raw);
        const pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
        return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${url.hostname.toLowerCase() === 'github.com' ? pathname.toLowerCase() : pathname}`;
    } catch {
        return raw.replace(/\/+$/, '').replace(/\.git$/, '');
    }
}

function originIdentity(candidate) {
    // Do not accidentally read the parent workspace's Git origin.
    if (!fs.existsSync(path.join(candidate, '.git'))) return '';
    try {
        return repositoryIdentity(execFileSync('git', ['-C', candidate, 'config', '--get', 'remote.origin.url'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
        }));
    } catch { return ''; }
}

// Read lazily: repos.js also uses this module to choose installation sources.
function registeredSources() {
    return { ...getPredefinedRepos(), ...getRepoSources() };
}

function workspaceRepositories() {
    return directoryEntries(PLOINKY_WORKSPACE_ROOT)
        .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules'
            && (entry.isDirectory() || entry.isSymbolicLink()))
        .map(entry => ({ name: entry.name, directory: path.join(PLOINKY_WORKSPACE_ROOT, entry.name) }))
        .filter(entry => hasAgents(entry.directory));
}

// Registered aliases retain their identity even when the checkout has a different name.
export function workspaceAgentRepositoryPath(name, { url = null } = {}) {
    if (!name || name.startsWith('.') || name === 'node_modules'
        || name.includes('/') || name.includes('\\')) return null;
    const candidate = path.join(PLOINKY_WORKSPACE_ROOT, name);
    if (hasAgents(candidate)) return candidate;
    const source = registeredSources()[name];
    const identity = repositoryIdentity(url || source?.url);
    if (!identity) return null;
    const matches = workspaceRepositories().filter(entry => originIdentity(entry.directory) === identity);
    if (matches.length > 1) {
        throw new Error(`Multiple workspace checkouts match repository '${name}': ${matches.map(entry => entry.name).join(', ')}`);
    }
    return matches[0]?.directory || null;
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
