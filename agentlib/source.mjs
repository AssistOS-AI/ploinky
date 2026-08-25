// Pure achillesAgentLib source selection and validation.
//
// Importing this module never clones, fetches, or creates workspace state.
// Materialization of a managed source is an explicit, separate call in
// `materialize.mjs`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    AGENTLIB_ERROR_CODES,
    AGENTLIB_LOCAL_DIR_NAME,
    AGENTLIB_MANAGED_RELATIVE_DIR,
    AGENTLIB_PACKAGE_NAME,
    AGENTLIB_REQUIRED_ENTRYPOINTS,
    AGENTLIB_SELECTION_SCHEMA_VERSION,
    agentLibError,
    validateSelectionDescriptor,
} from './contract.mjs';
import { fingerprintSource, sha256Hex, sourceIdEquals, sourceIdOf } from './fingerprint.mjs';

export const ACTIVE_DESCRIPTOR_FILENAME = 'active.json';
export const TRANSACTION_DESCRIPTOR_FILENAME = 'transaction.json';
export const MIRROR_DIRNAME = 'mirror.git';
export const GENERATIONS_DIRNAME = 'generations';
export const SOURCE_LOCK_FILENAME = '.source.lock';

/**
 * Resolve the one workspace root.
 *
 * This mirrors the public supervisor's algorithm exactly: an explicit
 * `PLOINKY_WORKSPACE_ROOT` wins, otherwise the nearest `.ploinky` ancestor of
 * the launch directory, otherwise the launch directory itself. Direct
 * `ploinky-local` must use this and export the result before importing core.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof fs} [opts.fsApi]
 * @returns {string} absolute workspace root
 */
export function resolveWorkspaceRoot({ cwd = process.cwd(), env = process.env, fsApi = fs } = {}) {
    const explicit = String(env?.PLOINKY_WORKSPACE_ROOT || '').trim();
    if (explicit) {
        const normalized = path.resolve(explicit);
        try {
            if (fsApi.statSync(normalized).isDirectory()) return normalized;
        } catch (_) { /* fall through to discovery */ }
    }
    let current = path.resolve(cwd);
    while (true) {
        try {
            if (fsApi.statSync(path.join(current, '.ploinky')).isDirectory()) return current;
        } catch (_) { /* keep walking */ }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return path.resolve(cwd);
}

export function workspacePathHash(workspaceRoot) {
    return sha256Hex(path.resolve(workspaceRoot));
}

/** The only implicit local candidate. No ancestor or recursive search. */
export function localCandidatePath(workspaceRoot) {
    return path.join(path.resolve(workspaceRoot), AGENTLIB_LOCAL_DIR_NAME);
}

export function managedRootPath(workspaceRoot) {
    return path.join(path.resolve(workspaceRoot), AGENTLIB_MANAGED_RELATIVE_DIR);
}

export function managedGenerationsDir(workspaceRoot) {
    return path.join(managedRootPath(workspaceRoot), GENERATIONS_DIRNAME);
}

export function managedMirrorPath(workspaceRoot) {
    return path.join(managedRootPath(workspaceRoot), MIRROR_DIRNAME);
}

export function activeDescriptorPath(workspaceRoot) {
    return path.join(managedRootPath(workspaceRoot), ACTIVE_DESCRIPTOR_FILENAME);
}

export function transactionDescriptorPath(workspaceRoot) {
    return path.join(managedRootPath(workspaceRoot), TRANSACTION_DESCRIPTOR_FILENAME);
}

export function generationDirName(commit, fingerprint) {
    return `${commit}-${String(fingerprint).slice(0, 12)}`;
}

/**
 * True when `candidate` exists at all. Distinguishes "absent, so materialize a
 * managed source" from "present but broken, so fail closed".
 */
export function localCandidateExists(candidate, fsApi = fs) {
    try {
        fsApi.lstatSync(candidate);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceInvalid,
            `Unable to inspect the achillesAgentLib candidate at ${candidate}: ${error.message}`,
            { cause: error },
        );
    }
}

function assertNoEscapingSymlink(sourceDir, relativePath, target, fsApi) {
    const linkDir = path.dirname(path.join(sourceDir, relativePath));
    const resolved = path.resolve(linkDir, target);
    const root = fsApi.realpathSync(sourceDir);
    let realResolved = resolved;
    try {
        realResolved = fsApi.realpathSync(resolved);
    } catch (_) {
        // A dangling link cannot leak bytes; its literal target still must not
        // point outside the tree.
    }
    const withinLiteral = resolved === root || resolved.startsWith(`${root}${path.sep}`);
    const withinReal = realResolved === root || realResolved.startsWith(`${root}${path.sep}`);
    if (!withinLiteral || !withinReal) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.pathEscape,
            `achillesAgentLib source contains a symlink escaping the tree: ${relativePath} -> ${target}`,
        );
    }
}

function walkForEscapingSymlinks(sourceDir, fsApi) {
    const walk = (absolute, relative) => {
        for (const name of fsApi.readdirSync(absolute).sort()) {
            if (!relative && name === '.git') continue;
            const childRelative = relative ? `${relative}/${name}` : name;
            const childAbsolute = path.join(absolute, name);
            const stat = fsApi.lstatSync(childAbsolute);
            if (stat.isSymbolicLink()) {
                assertNoEscapingSymlink(sourceDir, childRelative, fsApi.readlinkSync(childAbsolute), fsApi);
                continue;
            }
            if (stat.isDirectory()) walk(childAbsolute, childRelative);
        }
    };
    walk(sourceDir, '');
}

/**
 * Validate a candidate achillesAgentLib source directory.
 *
 * A candidate that exists but fails any check is a hard error: the presence of
 * the path signals developer intent, so falling back to a GitHub clone would
 * silently run different bytes than the developer edited.
 *
 * @param {string} candidate - absolute candidate path
 * @param {object} [opts]
 * @param {typeof fs} [opts.fsApi]
 * @param {boolean} [opts.deepSymlinkScan=true]
 * @returns {{ sourceDir: string, sourceId: {device:string,inode:string}, packageName: string }}
 */
export function validateAgentLibSource(candidate, { fsApi = fs, deepSymlinkScan = true } = {}) {
    const stat = (() => {
        try {
            return fsApi.lstatSync(candidate);
        } catch (error) {
            throw agentLibError(
                AGENTLIB_ERROR_CODES.sourceMissing,
                `achillesAgentLib source not found at ${candidate}.`,
                { cause: error },
            );
        }
    })();
    if (stat.isSymbolicLink()) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceInvalid,
            `achillesAgentLib source root must be a real directory, not a symlink: ${candidate}`,
        );
    }
    if (!stat.isDirectory()) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceInvalid,
            `achillesAgentLib source root is not a directory: ${candidate}`,
        );
    }
    const beforeId = { device: String(stat.dev), inode: String(stat.ino) };
    const sourceDir = fsApi.realpathSync(candidate);
    const afterId = sourceIdOf(sourceDir, fsApi);
    if (!sourceIdEquals(beforeId, afterId)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceChanged,
            `achillesAgentLib source at ${candidate} was substituted during validation.`,
        );
    }

    let pkg;
    try {
        pkg = JSON.parse(fsApi.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
    } catch (error) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceInvalid,
            `achillesAgentLib source at ${sourceDir} has no readable package.json: ${error.message}`,
            { cause: error },
        );
    }
    if (pkg?.name !== AGENTLIB_PACKAGE_NAME) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceInvalid,
            `achillesAgentLib source at ${sourceDir} declares package name '${String(pkg?.name)}'; `
            + `expected '${AGENTLIB_PACKAGE_NAME}'.`,
        );
    }
    for (const entry of AGENTLIB_REQUIRED_ENTRYPOINTS) {
        const entryPath = path.join(sourceDir, entry);
        let entryStat;
        try {
            entryStat = fsApi.statSync(entryPath);
        } catch (error) {
            throw agentLibError(
                AGENTLIB_ERROR_CODES.sourceInvalid,
                `achillesAgentLib source at ${sourceDir} is missing required entry point ${entry}.`,
                { cause: error },
            );
        }
        if (!entryStat.isFile()) {
            throw agentLibError(
                AGENTLIB_ERROR_CODES.sourceInvalid,
                `achillesAgentLib entry point ${entry} is not a regular file in ${sourceDir}.`,
            );
        }
    }
    if (deepSymlinkScan) walkForEscapingSymlinks(sourceDir, fsApi);

    return { sourceDir, sourceId: afterId, packageName: pkg.name };
}

/**
 * Build a validated selection descriptor for an already-validated source.
 *
 * @param {object} params
 * @param {string} params.workspaceRoot
 * @param {string} params.sourceDir - canonical absolute source path
 * @param {'local'|'managed'} params.mode
 * @param {string|null} [params.remoteUrl]
 * @param {string|null} [params.requestedRef]
 * @param {string|null} [params.resolvedCommit]
 * @param {boolean} [params.dirty]
 * @param {typeof fs} [params.fsApi]
 * @param {() => string} [params.now]
 */
export function buildSelection({
    workspaceRoot,
    sourceDir,
    mode,
    remoteUrl = null,
    requestedRef = null,
    resolvedCommit = null,
    dirty = false,
    fsApi = fs,
    now = () => new Date().toISOString(),
}) {
    const root = path.resolve(workspaceRoot);
    const canonicalSource = fsApi.realpathSync(sourceDir);
    const { fingerprint, sourceId } = fingerprintSource(canonicalSource, { fsApi });
    const relative = path.relative(root, canonicalSource);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceInvalid,
            `achillesAgentLib source ${canonicalSource} is not inside the workspace root ${root}.`,
        );
    }
    const descriptor = validateSelectionDescriptor({
        schemaVersion: AGENTLIB_SELECTION_SCHEMA_VERSION,
        workspacePathHash: workspacePathHash(root),
        mode,
        sourceRelativePath: relative.split(path.sep).join('/'),
        sourceId,
        remoteUrl,
        requestedRef,
        resolvedCommit,
        dirty,
        contentFingerprint: fingerprint,
        selectedAt: now(),
    });
    // The absolute path is derived state, never persisted: callers re-derive and
    // revalidate it from workspaceRoot + sourceRelativePath on every use.
    return { ...descriptor, sourceDir: canonicalSource, workspaceRoot: root };
}

/**
 * Re-derive and revalidate the absolute source directory for a descriptor.
 *
 * The descriptor is state, not authorization: this always canonicalizes and
 * re-checks the real source before a caller may mount or hash it.
 *
 * @param {object} descriptor
 * @param {string} workspaceRoot
 * @param {object} [opts]
 * @returns {{ sourceDir: string, sourceId: object }}
 */
export function resolveDescriptorSource(descriptor, workspaceRoot, { fsApi = fs, requireSameSourceId = true } = {}) {
    const normalized = validateSelectionDescriptor(descriptor);
    const root = path.resolve(workspaceRoot);
    if (normalized.workspacePathHash !== workspacePathHash(root)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.descriptorInvalid,
            'AgentLib selection belongs to a different workspace; refusing to adopt it.',
        );
    }
    const candidate = path.join(root, ...normalized.sourceRelativePath.split('/'));
    const { sourceDir, sourceId } = validateAgentLibSource(candidate, { fsApi, deepSymlinkScan: false });
    if (requireSameSourceId && !sourceIdEquals(sourceId, normalized.sourceId)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.sourceChanged,
            `achillesAgentLib source identity at ${sourceDir} no longer matches the active selection.`,
        );
    }
    return { sourceDir, sourceId, descriptor: normalized };
}

function atomicWriteJson(filePath, value, fsApi = fs) {
    fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`;
    fsApi.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fsApi.renameSync(temp, filePath);
}

function persistedShape(selection) {
    const { sourceDir: _sourceDir, workspaceRoot: _workspaceRoot, ...rest } = selection;
    return validateSelectionDescriptor(rest);
}

export function writeActiveDescriptor(workspaceRoot, selection, fsApi = fs) {
    atomicWriteJson(activeDescriptorPath(workspaceRoot), persistedShape(selection), fsApi);
}

export function writeTransactionDescriptor(workspaceRoot, selection, fsApi = fs) {
    atomicWriteJson(transactionDescriptorPath(workspaceRoot), persistedShape(selection), fsApi);
}

export function clearTransactionDescriptor(workspaceRoot, fsApi = fs) {
    try {
        fsApi.unlinkSync(transactionDescriptorPath(workspaceRoot));
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

/**
 * Read `active.json` if present. Returns null when absent; throws when present
 * and malformed, because a corrupt descriptor must not read as "no selection".
 */
export function readActiveDescriptor(workspaceRoot, fsApi = fs) {
    let raw;
    try {
        raw = fsApi.readFileSync(activeDescriptorPath(workspaceRoot), 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw agentLibError(
            AGENTLIB_ERROR_CODES.descriptorInvalid,
            `Unable to read the active AgentLib selection: ${error.message}`,
            { cause: error },
        );
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.descriptorInvalid,
            `The active AgentLib selection at ${activeDescriptorPath(workspaceRoot)} is not valid JSON.`,
            { cause: error },
        );
    }
    return validateSelectionDescriptor(parsed);
}

export function readTransactionDescriptor(workspaceRoot, fsApi = fs) {
    try {
        return validateSelectionDescriptor(JSON.parse(fsApi.readFileSync(transactionDescriptorPath(workspaceRoot), 'utf8')));
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

/**
 * Inspect the workspace without any network or mutation.
 *
 * @returns {{ mode: 'local'|'managed', candidate: string, present: boolean }}
 */
export function planSourceSelection(workspaceRoot, { fsApi = fs } = {}) {
    const candidate = localCandidatePath(workspaceRoot);
    const present = localCandidateExists(candidate, fsApi);
    return { mode: present ? 'local' : 'managed', candidate, present };
}

/**
 * Select a local source, or report that materialization is required.
 *
 * This call is pure with respect to the network and to workspace state. When it
 * returns `{ requiresMaterialization: true }` the caller must invoke
 * `materialize.mjs` explicitly under the source lock.
 *
 * @param {object} params
 * @param {string} params.workspaceRoot
 * @param {typeof fs} [params.fsApi]
 * @param {(dir: string) => {commit: string|null, dirty: boolean}} [params.readGitState]
 * @param {() => string} [params.now]
 */
export function selectAgentLibSource({ workspaceRoot, fsApi = fs, readGitState = null, now } = {}) {
    const root = path.resolve(workspaceRoot);
    const plan = planSourceSelection(root, { fsApi });
    if (!plan.present) {
        return { requiresMaterialization: true, mode: 'managed', candidate: plan.candidate, selection: null };
    }
    const { sourceDir } = validateAgentLibSource(plan.candidate, { fsApi });
    const git = readGitState ? readGitState(sourceDir) : { commit: null, dirty: false };
    const selection = buildSelection({
        workspaceRoot: root,
        sourceDir,
        mode: 'local',
        remoteUrl: null,
        requestedRef: null,
        resolvedCommit: git?.commit || null,
        dirty: Boolean(git?.dirty),
        fsApi,
        ...(now ? { now } : {}),
    });
    return { requiresMaterialization: false, mode: 'local', candidate: plan.candidate, selection };
}

// ---------------------------------------------------------------------------
// Workspace AgentLib source lock
// ---------------------------------------------------------------------------

function lockOwnerPayload() {
    return { pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString() };
}

function processIsProvenDead(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return error?.code === 'ESRCH';
    }
}

/**
 * Exclusive workspace lock around AgentLib source selection/materialization.
 *
 * Lock ordering is fixed: outer Box lock, then this source lock, then the
 * inner/core lifecycle lock. An in-Box process must never acquire this lock —
 * the host supervisor owns source mutation.
 *
 * @param {string} workspaceRoot
 * @param {() => Promise<T>|T} fn
 * @param {object} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export async function withAgentLibSourceLock(workspaceRoot, fn, {
    fsApi = fs,
    timeoutMs = 120_000,
    pollMs = 100,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
    const root = managedRootPath(workspaceRoot);
    fsApi.mkdirSync(root, { recursive: true, mode: 0o700 });
    const lockPath = path.join(root, SOURCE_LOCK_FILENAME);
    const deadline = Date.now() + timeoutMs;
    let handle = null;
    while (handle === null) {
        try {
            handle = fsApi.openSync(lockPath, 'wx', 0o600);
        } catch (error) {
            if (error?.code !== 'EEXIST') {
                throw agentLibError(
                    AGENTLIB_ERROR_CODES.lockFailed,
                    `Unable to acquire the AgentLib source lock at ${lockPath}: ${error.message}`,
                    { cause: error },
                );
            }
            let owner = null;
            try {
                owner = JSON.parse(fsApi.readFileSync(lockPath, 'utf8'));
            } catch (_) { /* malformed owner is treated as stale below */ }
            if (owner && owner.host === os.hostname() && processIsProvenDead(owner.pid)) {
                try { fsApi.unlinkSync(lockPath); } catch (_) { /* another waiter won */ }
                continue;
            }
            if (Date.now() >= deadline) {
                throw agentLibError(
                    AGENTLIB_ERROR_CODES.lockFailed,
                    `Timed out waiting for the AgentLib source lock at ${lockPath}`
                    + (owner?.pid ? ` (held by pid ${owner.pid})` : '') + '.',
                );
            }
            await sleep(pollMs);
        }
    }
    try {
        fsApi.writeFileSync(handle, JSON.stringify(lockOwnerPayload()));
    } catch (_) { /* the exclusive create already established ownership */ }
    try {
        return await fn();
    } finally {
        try { fsApi.closeSync(handle); } catch (_) { /* already closed */ }
        try { fsApi.unlinkSync(lockPath); } catch (_) { /* already released */ }
    }
}
