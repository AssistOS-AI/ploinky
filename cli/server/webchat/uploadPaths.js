import fs from 'fs';
import path from 'path';

import {
    isPathWithinRoots,
    resolveCanonicalPathSync,
} from '../utils/workspacePaths.js';

const SECRET_LEAF_RE = /\.secrets$/i;
const RESERVED_DIRECTORY_NAMES = new Set(['.data', '.ploinky', 'node_modules']);
const MAX_SEGMENT_LENGTH = 255;
const MAX_PATH_LENGTH = 4096;

function isReservedSegment(segment) {
    return RESERVED_DIRECTORY_NAMES.has(segment)
        || segment === '.secrets'
        || SECRET_LEAF_RE.test(segment);
}

function isSafeSegment(segment) {
    if (!segment || segment === '.' || segment === '..') return false;
    if (segment.length > MAX_SEGMENT_LENGTH) return false;
    if (segment.includes('\0') || segment.includes('/') || segment.includes('\\')) return false;
    return !isReservedSegment(segment);
}

function normalizeRelativePath(rawPath, { allowEmpty = false } = {}) {
    const provided = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!provided) return allowEmpty ? '' : null;
    if (provided.includes('\0') || provided.length > MAX_PATH_LENGTH) return null;
    const slashOnly = provided.replace(/\\+/g, '/');
    if (slashOnly.startsWith('/') || path.isAbsolute(slashOnly)) return null;
    const segments = slashOnly.split('/').filter(Boolean);
    if (!segments.length) return allowEmpty ? '' : null;
    if (segments.some((segment) => !isSafeSegment(segment))) return null;
    const joined = segments.join('/');
    return joined.length <= MAX_PATH_LENGTH ? joined : null;
}

export function sanitizeUploadRelativePath(rawPath, fallbackName = '') {
    const candidate = typeof rawPath === 'string' && rawPath.trim() ? rawPath : fallbackName;
    return normalizeRelativePath(candidate);
}

export function sanitizeUploadDirectoryPath(rawPath) {
    return normalizeRelativePath(rawPath, { allowEmpty: true });
}

function isInsideRoot(targetPath, rootPath) {
    const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
    return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasSymlinkOrInvalidParent(rootPath, targetPath, { allowFileLeaf = true } = {}) {
    const relative = path.relative(rootPath, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return true;
    const segments = relative.split(path.sep).filter(Boolean);
    let current = rootPath;
    for (let index = 0; index < segments.length; index += 1) {
        current = path.join(current, segments[index]);
        if (!fs.existsSync(current)) return false;
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) return true;
        const isLeaf = index === segments.length - 1;
        if (!stat.isDirectory() && !(isLeaf && allowFileLeaf && stat.isFile())) return true;
    }
    return false;
}

function resolveConfinedBase(cwd, workspaceRoot) {
    if (!cwd || !workspaceRoot) return null;
    let resolvedCwd;
    let resolvedWorkspace;
    try {
        resolvedCwd = fs.realpathSync(path.resolve(cwd));
        resolvedWorkspace = fs.realpathSync(path.resolve(workspaceRoot));
        if (!fs.statSync(resolvedCwd).isDirectory()) return null;
    } catch (_) {
        return null;
    }
    if (!isPathWithinRoots([resolvedWorkspace], resolvedCwd)) return null;
    const relativeBase = path.relative(resolvedWorkspace, resolvedCwd);
    if (relativeBase.split(path.sep).filter(Boolean).some(isReservedSegment)) return null;
    return { cwd: resolvedCwd, workspaceRoot: resolvedWorkspace };
}

export function resolveUploadTarget({ cwd, workspaceRoot, destinationPath = '', relativePath } = {}) {
    const base = resolveConfinedBase(cwd, workspaceRoot);
    if (!base) return null;
    const safeDestination = sanitizeUploadDirectoryPath(destinationPath);
    const safeRelative = sanitizeUploadRelativePath(relativePath, '');
    if (safeDestination === null || !safeRelative) return null;
    const cwdRelative = safeDestination ? `${safeDestination}/${safeRelative}` : safeRelative;
    const absolutePath = path.resolve(base.cwd, cwdRelative);
    if (!isInsideRoot(absolutePath, base.cwd)) return null;
    if (hasSymlinkOrInvalidParent(base.cwd, absolutePath)) return null;
    const canonical = resolveCanonicalPathSync(absolutePath);
    if (!canonical || !isPathWithinRoots([base.cwd], canonical, { allowMissing: true })) return null;
    if (!isPathWithinRoots([base.workspaceRoot], canonical, { allowMissing: true })) return null;
    return {
        absolutePath: canonical,
        relativePath: cwdRelative.replace(/\\+/g, '/'),
        workspacePath: path.relative(base.workspaceRoot, canonical).replace(/\\+/g, '/'),
    };
}

export function resolveWorkspaceDirectory({ cwd, workspaceRoot, relativePath = '', allowMissing = false } = {}) {
    const base = resolveConfinedBase(cwd, workspaceRoot);
    if (!base) return null;
    const safeRelative = sanitizeUploadDirectoryPath(relativePath);
    if (safeRelative === null) return null;
    const absolutePath = path.resolve(base.cwd, safeRelative || '.');
    if (!isInsideRoot(absolutePath, base.cwd)) return null;
    if (hasSymlinkOrInvalidParent(base.cwd, absolutePath, { allowFileLeaf: false })) return null;
    if (!allowMissing) {
        try {
            if (!fs.statSync(absolutePath).isDirectory()) return null;
        } catch (_) {
            return null;
        }
    }
    const canonical = resolveCanonicalPathSync(absolutePath);
    if (!canonical || !isPathWithinRoots([base.cwd], canonical, { allowMissing })) return null;
    return {
        absolutePath: canonical,
        relativePath: safeRelative,
    };
}

export function buildWorkspaceFileUrl(workspacePath) {
    const safePath = sanitizeUploadRelativePath(workspacePath, '');
    if (!safePath) return null;
    const encoded = safePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    return `/workspace-files/${encoded}`;
}

export const __testables = {
    hasSymlinkOrInvalidParent,
    isInsideRoot,
    isSafeSegment,
};
