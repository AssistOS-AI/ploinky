import fs from 'node:fs';
import path from 'node:path';

export const WEBTTY_WORKSPACE_ROOT = '/workspace';
export const WEBTTY_MAX_CWD_BYTES = 4 * 1024;

export function cwdError(category) {
    const error = new Error(`invalid WebTTY starting directory: ${category}`);
    error.code = 'WEBTTY_CWD_INVALID';
    error.category = category;
    return error;
}

function hasUnpairedSurrogate(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xD800 && code <= 0xDBFF) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
            index += 1;
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
            return true;
        }
    }
    return false;
}

export function normalizeCwdRelative(requested) {
    if (requested === undefined || requested === null || requested === '' || requested === '.') return '';
    if (typeof requested !== 'string') throw cwdError('type');
    if (Buffer.byteLength(requested, 'utf8') > WEBTTY_MAX_CWD_BYTES) throw cwdError('size');
    if (requested.includes('\0')) throw cwdError('nul');
    if (hasUnpairedSurrogate(requested)) throw cwdError('encoding');
    if (requested.includes('\\')) throw cwdError('backslash');
    if (path.posix.isAbsolute(requested) || requested.startsWith('//')) throw cwdError('absolute');
    if (/^[A-Za-z]:/.test(requested)) throw cwdError('drive');
    const segments = requested.split('/');
    if (segments.some((segment) => segment === '..')) throw cwdError('traversal');

    const normalized = path.posix.normalize(requested).replace(/\/$/, '');
    if (normalized === '.' || normalized === '') return '';
    if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
        throw cwdError('traversal');
    }
    return normalized;
}

function realpath(fsApi, target) {
    const implementation = fsApi.realpathSync?.native || fsApi.realpathSync;
    if (typeof implementation !== 'function') throw cwdError('filesystem');
    try {
        return implementation(target);
    } catch (_) {
        throw cwdError('missing');
    }
}

function requireDirectory(fsApi, target, category) {
    try {
        if (!fsApi.statSync(target).isDirectory()) throw cwdError(category);
    } catch (error) {
        if (error?.code === 'WEBTTY_CWD_INVALID') throw error;
        throw cwdError(category);
    }
}

function isContained(rootRealPath, candidateRealPath, pathApi) {
    return candidateRealPath === rootRealPath || candidateRealPath.startsWith(`${rootRealPath}${pathApi.sep}`);
}

export function resolveWorkspaceRoot({
    workspaceRoot = WEBTTY_WORKSPACE_ROOT,
    fsApi = fs,
    pathApi = path,
} = {}) {
    if (workspaceRoot !== WEBTTY_WORKSPACE_ROOT && !pathApi.isAbsolute(workspaceRoot)) {
        throw cwdError('workspace-root');
    }
    const rootRealPath = realpath(fsApi, workspaceRoot);
    requireDirectory(fsApi, rootRealPath, 'workspace-root');
    return rootRealPath;
}

export function resolveWorkspaceDirectory(requested, {
    workspaceRoot = WEBTTY_WORKSPACE_ROOT,
    workspaceRealPath,
    fsApi = fs,
    pathApi = path,
} = {}) {
    const relativePath = normalizeCwdRelative(requested);
    const rootRealPath = workspaceRealPath || resolveWorkspaceRoot({ workspaceRoot, fsApi, pathApi });
    if (!pathApi.isAbsolute(rootRealPath)) throw cwdError('workspace-root');
    const lexicalCandidate = pathApi.resolve(rootRealPath, ...relativePath.split('/').filter(Boolean));
    if (!isContained(rootRealPath, lexicalCandidate, pathApi)) throw cwdError('traversal');
    const candidateRealPath = realpath(fsApi, lexicalCandidate);
    requireDirectory(fsApi, candidateRealPath, 'not-directory');
    if (!isContained(rootRealPath, candidateRealPath, pathApi)) throw cwdError('containment');
    return Object.freeze({
        relativePath,
        absolutePath: candidateRealPath,
        workspaceRealPath: rootRealPath,
    });
}

export function createWorkspaceDirectoryResolver(options = {}) {
    const workspaceRealPath = resolveWorkspaceRoot(options);
    return (requested) => resolveWorkspaceDirectory(requested, { ...options, workspaceRealPath });
}
