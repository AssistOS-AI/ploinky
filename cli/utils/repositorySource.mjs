import fs from 'node:fs';
import path from 'node:path';
import { readOriginFromGitConfig, readOriginFromGitConfigAsync } from './repositoryOriginConfig.mjs';
import { memoizeRepositoryRead, prefetchRepositoryReads, repositoryReadScopeCancelled } from './repositoryResolutionScope.mjs';

export function repositoryEntries(root) {
    try { return fs.readdirSync(root, { withFileTypes: true }); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return []; throw error; }
}

export function repositoryIdentity(value) {
    const raw = String(value || '').trim().replace(/^git\+/, '').replace(/^git@([^:]+):/, 'ssh://git@$1/');
    try {
        const url = new URL(raw);
        const name = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
        return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${url.hostname.toLowerCase() === 'github.com' ? name.toLowerCase() : name}`;
    } catch { return raw.replace(/\/+$/, '').replace(/\.git$/, ''); }
}

export function repositoryOrigin(candidate) {
    return memoizeRepositoryRead('origins', candidate, () => repositoryIdentity(readOriginFromGitConfig(candidate)));
}

const acceptRepository = () => true;
export function workspaceRepositories(root, accept = acceptRepository) {
    const entries = memoizeRepositoryRead('workspaceRepos', root, () => repositoryEntries(root).filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules'
        && (entry.isDirectory() || entry.isSymbolicLink()))
        .map(entry => ({ name: entry.name, directory: path.join(root, entry.name) })));
    return entries.filter(entry => accept(entry.directory));
}

export async function prefetchWorkspaceRepositoryOrigins(roots, { signal } = {}) {
    if (signal?.aborted || repositoryReadScopeCancelled()) return;
    const directories = [...new Set(Array.isArray(roots) ? roots : [roots])]
        .flatMap(root => workspaceRepositories(root).map(entry => entry.directory));
    await prefetchRepositoryReads('origins', directories, async (directory, ownedSignal) =>
        repositoryIdentity(await readOriginFromGitConfigAsync(directory, { signal: ownedSignal })), { signal });
}

export function workspaceRepositoryPath(name, { workspaceRoot, url = '', accept = candidate => fs.existsSync(path.join(candidate, '.git')) } = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name || '') || name === 'node_modules') return null;
    const candidate = path.join(workspaceRoot, name);
    if (accept(candidate)) return candidate;
    const identity = repositoryIdentity(url);
    if (!identity) return null;
    const matches = workspaceRepositories(workspaceRoot, accept).filter(entry => repositoryOrigin(entry.directory) === identity);
    if (matches.length > 1) throw new Error(`Multiple workspace checkouts match repository '${name}'`);
    return matches[0]?.directory || null;
}
