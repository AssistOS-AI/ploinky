// Code identity for warm tool workers (see toolWorkerPool.mjs).
//
// A warm worker must never run code older than what a fresh process would
// load at request time. The pool reads this identity before every dispatch
// and when it spawns a worker, and retires idle workers spawned under another
// identity; when the identity cannot be read, the call runs as a fresh
// process. The identity is derived from the code itself, never from a marker:
// a sha256 over the sorted (path, stat stamp) list of every entry under the
// code roots plus a few fixed files. A stamp is dev, ino, size, mtimeNs,
// ctimeNs and mode (bigint stat), so an in-place rewrite, an atomic replace,
// an added, removed or renamed entry each change it at the next read.
//
// Racy stamps. A rewrite within one filesystem timestamp tick can keep every
// stamp. While any stamp (mtime or ctime, file or directory) is younger than
// `settleMs`, or lies in the future, the identity throws, so those calls run
// as fresh processes; afterwards a later rewrite moves some timestamp.
//
// Walk. Directories are followed through symlinks and visited once per
// dev/ino. A directory listing is cached and reused only while that
// directory's own stamp is unchanged, and a listing read while its directory
// stamp was racy is never cached. `node_modules` and `.git` are excluded by
// name at every depth (dependencies are prepared outside the agent source and
// mounted read-only; `.git` is not loadable code). A staged root, whose
// top-level entries are symlinks into the real source directory, also walks
// that real directory, so a top-level entry added to the source later (which
// relative imports can load) is stamped too. More than `maxEntries` entries
// makes the identity throw.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SETTLE_MS = 2000;
export const DEFAULT_MAX_ENTRIES = 20_000;
export const EXCLUDED_NAMES = Object.freeze(['node_modules', '.git']);

const NS_PER_MS = 1_000_000n;

function stampOf(stat) {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
}

/**
 * @param {object} options
 * @param {string[]} options.roots directories walked recursively
 * @param {string[]} [options.extraFiles] paths stamped without walking (missing ones stamp as absent)
 * @param {number} [options.settleMs] racy window
 * @param {number} [options.maxEntries]
 * @param {() => number} [options.now] wall clock in ms
 * @param {object} [options.fsApi] `statSync`, `lstatSync`, `readdirSync`, `realpathSync` (tests)
 * @param {(m: { index: number, root: string, ms: number, entries: number }) => void} [options.onMeasure]
 *   called once per root (index into `roots`, staged-source walks included)
 *   and once for the fixed files (index -1) of every read that gets that far;
 *   it only observes, the stamped set is the same with or without it
 * @returns {(extraFiles?: string[]) => string}
 */
export function createCodeIdentity({
    roots,
    extraFiles = [],
    settleMs = DEFAULT_SETTLE_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    now = Date.now,
    fsApi = fs,
    onMeasure = null,
} = {}) {
    if (!Array.isArray(roots) || roots.length === 0) throw new TypeError('createCodeIdentity requires roots');
    const excluded = new Set(EXCLUDED_NAMES);
    const listings = new Map();
    const settleNs = BigInt(Math.max(0, Math.floor(settleMs))) * NS_PER_MS;

    return function codeIdentity(callExtraFiles = []) {
        // The clock has millisecond resolution: count the whole current
        // millisecond as the present, so only later stamps are "future".
        const settledBeforeNs = (BigInt(Math.floor(now())) + 1n) * NS_PER_MS - settleNs;
        // Racy: younger than settleMs, or in the future.
        const isRacy = (stat) => stat.mtimeNs >= settledBeforeNs || stat.ctimeNs >= settledBeforeNs;
        const lines = [];
        const visitedDirs = new Set();
        let racy = false;

        const record = (entryPath, stat) => {
            if (lines.length >= maxEntries) {
                throw new Error(`tool code identity exceeds ${maxEntries} entries`);
            }
            lines.push(`${entryPath}\u0000${stampOf(stat)}`);
            if (isRacy(stat)) racy = true;
        };

        const statEntry = (entryPath) => {
            try {
                return fsApi.statSync(entryPath, { bigint: true });
            } catch (error) {
                if (error?.code !== 'ENOENT' && error?.code !== 'ELOOP' && error?.code !== 'ENOTDIR') throw error;
            }
            // A dangling symlink: stamp the link itself.
            try {
                return fsApi.lstatSync(entryPath, { bigint: true });
            } catch (error) {
                if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
                throw error;
            }
        };

        const listDirectory = (dirPath, stat) => {
            const stamp = stampOf(stat);
            const cached = listings.get(dirPath);
            if (cached && cached.stamp === stamp) return cached.names;
            const names = fsApi.readdirSync(dirPath).filter((name) => !excluded.has(name)).sort();
            if (isRacy(stat)) listings.delete(dirPath);
            else listings.set(dirPath, { stamp, names });
            return names;
        };

        const walk = (dirPath, stat) => {
            const key = `${stat.dev}:${stat.ino}`;
            if (visitedDirs.has(key)) return;
            visitedDirs.add(key);
            for (const name of listDirectory(dirPath, stat)) {
                const entryPath = path.join(dirPath, name);
                const entryStat = statEntry(entryPath);
                if (!entryStat) {
                    lines.push(`${entryPath}\u0000absent`);
                    continue;
                }
                record(entryPath, entryStat);
                if (entryStat.isDirectory()) walk(entryPath, entryStat);
            }
        };

        // The real source directories behind a staged root: the parent of a
        // top-level symlink that mirrors an entry of the same name.
        const realSourceDirs = (rootPath) => {
            const dirs = [];
            for (const name of listings.get(rootPath)?.names || fsApi.readdirSync(rootPath).filter((n) => !excluded.has(n)).sort()) {
                const entryPath = path.join(rootPath, name);
                let link;
                try {
                    link = fsApi.lstatSync(entryPath);
                } catch (_) {
                    continue;
                }
                if (!link.isSymbolicLink()) continue;
                let real;
                try {
                    real = fsApi.realpathSync(entryPath);
                } catch (_) {
                    continue;
                }
                if (path.basename(real) !== name) continue;
                const parent = path.dirname(real);
                if (!dirs.includes(parent)) dirs.push(parent);
            }
            return dirs.sort();
        };

        const measure = typeof onMeasure === 'function'
            ? (index, root, startedAt, linesBefore) => {
                try {
                    onMeasure({ index, root, ms: performance.now() - startedAt, entries: lines.length - linesBefore });
                } catch (_) {
                    // Measuring must never change the identity.
                }
            }
            : null;
        for (const [index, root] of roots.entries()) {
            const startedAt = measure ? performance.now() : 0;
            const linesBefore = lines.length;
            const rootStat = fsApi.statSync(root, { bigint: true });
            if (!rootStat.isDirectory()) throw new Error(`tool code root is not a directory: ${root}`);
            record(root, rootStat);
            walk(root, rootStat);
            for (const realDir of realSourceDirs(root)) {
                const realStat = statEntry(realDir);
                if (!realStat || !realStat.isDirectory()) continue;
                record(`${root}\u0000staged-source:${realDir}`, realStat);
                walk(realDir, realStat);
            }
            measure?.(index, root, startedAt, linesBefore);
        }
        const filesStartedAt = measure ? performance.now() : 0;
        const filesLinesBefore = lines.length;
        for (const file of [...extraFiles, ...callExtraFiles]) {
            const stat = statEntry(file);
            if (stat) record(file, stat);
            else lines.push(`${file}\u0000absent`);
        }
        measure?.(-1, 'files', filesStartedAt, filesLinesBefore);
        if (racy) {
            throw new Error(`tool code changed less than ${settleMs} ms ago`);
        }
        return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
    };
}

/** The Agent library root of the running AgentServer (`/Agent` in containers, a host path elsewhere). */
export const AGENT_LIB_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * The inputs of the identity AgentServer passes to its pools: the agent code
 * directory, the Agent library (including linked repositories under
 * `linked/`), the resolved config and manifest, the edge topology file (one
 * inode per generation) and the dependency sentinels. A non-image AgentLib
 * grant is walked as well. `labels` names each root for timing lines.
 */
export function agentServerIdentityInputs({
    codeDir,
    agentLibRoot = AGENT_LIB_ROOT,
    configPath = null,
    manifestPath = null,
    env = process.env,
} = {}) {
    const roots = [codeDir, agentLibRoot];
    const labels = ['code', 'agent'];
    const agentLibDir = String(env.PLOINKY_AGENTLIB_DIR || '').trim();
    if (agentLibDir && env.PLOINKY_AGENTLIB_MODE !== 'image') {
        roots.push(agentLibDir);
        labels.push('agentlib');
    }
    const extraFiles = [
        configPath,
        manifestPath,
        String(env.PLOINKY_EDGE_TOPOLOGY_FILE || '').trim() || null,
        path.join(codeDir, 'node_modules'),
        path.join(codeDir, 'node_modules', '.package-lock.json'),
        path.join(agentLibRoot, 'node_modules'),
    ].filter(Boolean);
    return { roots, labels, extraFiles };
}

/** The per-pool file stamped with the identity: the pool's command, when it is an absolute path. */
export function poolCommandFiles(command) {
    return typeof command === 'string' && path.isAbsolute(command) ? [command] : [];
}

/** `code:12.3/456,agent:…,files:0.1/8` (ms/entries per root) for timing lines. */
export function formatIdentityMeasures(measures = [], labels = []) {
    return measures.map((m) => {
        const label = m.index === -1 ? 'files' : (labels[m.index] || `root${m.index}`);
        return `${label}:${Number(m.ms).toFixed(1)}/${m.entries}`;
    }).join(',');
}

/**
 * The identity AgentServer passes to its pools (see agentServerIdentityInputs),
 * plus per pool its command file. `poolCommand(poolName)` returns a pool's
 * command.
 */
export function createAgentServerCodeIdentity({
    codeDir,
    agentLibRoot = AGENT_LIB_ROOT,
    configPath = null,
    manifestPath = null,
    poolCommand = () => null,
    env = process.env,
    ...options
} = {}) {
    const { roots, extraFiles } = agentServerIdentityInputs({ codeDir, agentLibRoot, configPath, manifestPath, env });
    const identity = createCodeIdentity({ roots, extraFiles, ...options });
    return (poolName) => identity(poolCommandFiles(poolCommand(poolName)));
}
