import fs from 'fs';
import path from 'path';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';

import { PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';

// Several requests can resume in the same check phase. Reserve most of that
// turn for response encoding, I/O callbacks and collection, rather than
// allowing each runnable sort to consume half a millisecond.
const WORKSPACE_SORT_SLICE_MS = 0.125;

export function getWorkspaceRoot() {
    return path.resolve(PLOINKY_WORKSPACE_ROOT);
}

// Stable merging preserves readdir order for comparator ties, while bounded
// CPU slices let other requests and timers run during a large directory sort.
export async function sortWorkspaceEntriesAsync(entries, compare) {
    let source = entries;
    let target = new Array(entries.length);
    let deadline = performance.now() + WORKSPACE_SORT_SLICE_MS;
    let operations = 0;
    for (let width = 1; width < entries.length; width *= 2) {
        for (let start = 0; start < entries.length; start += width * 2) {
            const middle = Math.min(start + width, entries.length);
            const end = Math.min(start + width * 2, entries.length);
            let left = start;
            let right = middle;
            for (let index = start; index < end; index += 1) {
                target[index] = left < middle && (right >= end || compare(source[left], source[right]) <= 0)
                    ? source[left++] : source[right++];
                operations += 1;
                if (operations % 64 === 0 && performance.now() >= deadline) {
                    await setImmediate();
                    deadline = performance.now() + WORKSPACE_SORT_SLICE_MS;
                }
            }
        }
        [source, target] = [target, source];
    }
    return source;
}

export function sanitizeRelativeRequestPath(relPath) {
    const cleaned = String(relPath || '').replace(/[\\]+/g, '/').replace(/^\/+/, '');
    if (cleaned.includes('..')) return null;
    return cleaned;
}

export function toRealPathSafe(value) {
    try {
        return fs.realpathSync(value);
    } catch (_) {
        return null;
    }
}

export function resolveCanonicalPathSync(targetPath) {
    const normalizedTarget = path.resolve(targetPath);
    try {
        return fs.realpathSync(normalizedTarget);
    } catch (_) {
        let current = path.dirname(normalizedTarget);
        while (true) {
            try {
                const realCurrent = fs.realpathSync(current);
                const suffix = path.relative(current, normalizedTarget);
                return path.resolve(realCurrent, suffix);
            } catch (_) {
                const parent = path.dirname(current);
                if (parent === current) {
                    return null;
                }
                current = parent;
            }
        }
    }
}

export function isPathWithinRoots(allowedRoots, targetPath, { allowMissing = false } = {}) {
    const resolvedTarget = allowMissing
        ? resolveCanonicalPathSync(targetPath)
        : toRealPathSafe(targetPath);
    if (!resolvedTarget) return false;

    for (const root of allowedRoots || []) {
        const resolvedRoot = toRealPathSafe(root) || path.resolve(root);
        if (!resolvedRoot) continue;
        if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep)) {
            return true;
        }
    }
    return false;
}

// Async siblings of the realpath helpers above for request hot paths. Results
// are never cached: a cached realpath would widen the window between the
// containment check and the open.
export async function toRealPathSafeAsync(value) {
    try {
        return await fs.promises.realpath(value);
    } catch (_) {
        return null;
    }
}

export async function resolveCanonicalPathAsync(targetPath) {
    const normalizedTarget = path.resolve(targetPath);
    try {
        return await fs.promises.realpath(normalizedTarget);
    } catch (_) {
        let current = path.dirname(normalizedTarget);
        while (true) {
            try {
                const realCurrent = await fs.promises.realpath(current);
                const suffix = path.relative(current, normalizedTarget);
                return path.resolve(realCurrent, suffix);
            } catch (_) {
                const parent = path.dirname(current);
                if (parent === current) {
                    return null;
                }
                current = parent;
            }
        }
    }
}

export async function isPathWithinRootsAsync(allowedRoots, targetPath, { allowMissing = false } = {}) {
    const resolvedTarget = allowMissing
        ? await resolveCanonicalPathAsync(targetPath)
        : await toRealPathSafeAsync(targetPath);
    if (!resolvedTarget) return false;

    for (const root of allowedRoots || []) {
        const resolvedRoot = (await toRealPathSafeAsync(root)) || path.resolve(root);
        if (!resolvedRoot) continue;
        if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep)) {
            return true;
        }
    }
    return false;
}

export function resolveWorkspacePath(inputPath, {
    workspaceRoot = getWorkspaceRoot(),
    leadingSlashIsWorkspaceRelative = true
} = {}) {
    if (typeof inputPath !== 'string' || !inputPath.trim()) {
        throw new Error('Missing path.');
    }
    if (inputPath.includes('\0')) {
        throw new Error('Invalid path.');
    }

    const candidate = inputPath.trim();
    const treatAsWorkspaceRelative = leadingSlashIsWorkspaceRelative && candidate.startsWith('/');
    const resolvedPath = treatAsWorkspaceRelative
        ? path.resolve(workspaceRoot, candidate.replace(/^\/+/, ''))
        : path.isAbsolute(candidate)
            ? path.resolve(candidate)
            : path.resolve(workspaceRoot, candidate);

    if (!isPathWithinRoots([workspaceRoot], resolvedPath, { allowMissing: true })) {
        throw new Error(`Access denied for "${inputPath}".`);
    }

    const canonicalPath = resolveCanonicalPathSync(resolvedPath);
    if (!canonicalPath || !isPathWithinRoots([workspaceRoot], canonicalPath, { allowMissing: true })) {
        throw new Error(`Symlink escape denied for "${inputPath}".`);
    }

    return canonicalPath;
}

export async function resolveWorkspacePathAsync(inputPath, {
    workspaceRoot = getWorkspaceRoot(),
    leadingSlashIsWorkspaceRelative = true
} = {}) {
    if (typeof inputPath !== 'string' || !inputPath.trim()) {
        throw new Error('Missing path.');
    }
    if (inputPath.includes('\0')) {
        throw new Error('Invalid path.');
    }

    const candidate = inputPath.trim();
    const treatAsWorkspaceRelative = leadingSlashIsWorkspaceRelative && candidate.startsWith('/');
    const resolvedPath = treatAsWorkspaceRelative
        ? path.resolve(workspaceRoot, candidate.replace(/^\/+/, ''))
        : path.isAbsolute(candidate)
            ? path.resolve(candidate)
            : path.resolve(workspaceRoot, candidate);

    if (!await isPathWithinRootsAsync([workspaceRoot], resolvedPath, { allowMissing: true })) {
        throw new Error(`Access denied for "${inputPath}".`);
    }

    const canonicalPath = await resolveCanonicalPathAsync(resolvedPath);
    if (!canonicalPath || !await isPathWithinRootsAsync([workspaceRoot], canonicalPath, { allowMissing: true })) {
        throw new Error(`Symlink escape denied for "${inputPath}".`);
    }

    return canonicalPath;
}
