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
    if (matches.length > 1) throw repositoryAmbiguityError(name, matches.map(entry => entry.directory));
    return matches[0]?.directory || null;
}

export const REPOSITORY_AMBIGUOUS = 'PLOINKY_REPOSITORY_AMBIGUOUS';

// Two workspace folders with the same origin leave only this repository
// unresolved. Callers that iterate every repository skip it by this code;
// callers that resolve it by name refuse with this message. Neither falls back
// to another copy of the repository.
export function repositoryAmbiguityError(name, directories, { message = '' } = {}) {
    const names = directories.map(directory => path.basename(directory)).sort();
    const error = new Error(message || `Repository '${name}' is unresolved: the workspace folders ${names.map(entry => `'${entry}'`).join(' and ')} `
        + 'both have its Git origin. Remove or rename the folder that should not supply it.');
    error.code = REPOSITORY_AMBIGUOUS;
    error.repositoryName = name;
    error.candidates = [...directories];
    return error;
}

export function isRepositoryAmbiguity(error) {
    return error?.code === REPOSITORY_AMBIGUOUS;
}
