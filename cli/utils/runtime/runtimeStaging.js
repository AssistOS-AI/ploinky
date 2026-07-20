import fs from 'fs';
import path from 'path';

function runtimeSegment(value) {
    return String(value || 'runtime').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function assertManagedRuntimePath(candidatePath, parentPath) {
    const resolvedCandidate = path.resolve(candidatePath);
    const resolvedParent = path.resolve(parentPath);
    // Reject empty (parent == candidate) or escaping (../...) or absolute
    // (no shared prefix) relatives so we never rmSync a parent the helper
    // doesn't own.
    const relative = path.relative(resolvedParent, resolvedCandidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Refusing to remove unmanaged runtime path: ${resolvedCandidate}`);
    }
}

function prepareFreshRuntimeRoot(runtimeRoot, parentRoot) {
    assertManagedRuntimePath(runtimeRoot, parentRoot);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.mkdirSync(runtimeRoot, { recursive: true });
    return runtimeRoot;
}

const STAGED_ENTRY_PATTERN = /^(Agent|code)-(\d+)-\d+$/;

function isPidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means the process exists but we can't signal it — still alive.
        if (err && err.code === 'EPERM') return true;
        return false;
    }
}

/**
 * Sweep runtimeRoot and remove staged Agent-<pid>-<ts> / code-<pid>-<ts>
 * entries whose embedded PID is no longer alive on the host. Used by
 * runtimes (e.g. seatbelt) where a per-agent wipe would race against
 * concurrent interactive shells that share the same agent name.
 *
 * @param {string} runtimeRoot Absolute directory holding the staged entries.
 * @param {{ keepPaths?: string[] }} options Paths to keep even when their
 * embedded PID is no longer alive.
 * @returns {string[]} Names of entries that were removed.
 */
function pruneStaleRuntimeEntries(runtimeRoot, options = {}) {
    if (!runtimeRoot || typeof runtimeRoot !== 'string') return [];
    const keepPaths = new Set(
        (Array.isArray(options.keepPaths) ? options.keepPaths : [])
            .filter(Boolean)
            .map((entry) => path.resolve(String(entry)))
    );
    let entries;
    try {
        entries = fs.readdirSync(runtimeRoot, { withFileTypes: true });
    } catch (err) {
        if (err && err.code === 'ENOENT') return [];
        throw err;
    }
    const removed = [];
    for (const entry of entries) {
        const match = entry.name.match(STAGED_ENTRY_PATTERN);
        if (!match) continue;
        const pid = Number(match[2]);
        if (isPidAlive(pid)) continue;
        const target = path.join(runtimeRoot, entry.name);
        if (keepPaths.has(path.resolve(target))) continue;
        try {
            fs.rmSync(target, { recursive: true, force: true });
            removed.push(entry.name);
        } catch (_) {
            // best-effort sweep; leave broken entries for a later pass.
        }
    }
    return removed;
}

export {
    prepareFreshRuntimeRoot,
    pruneStaleRuntimeEntries,
    runtimeSegment,
};
