import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { HOST_STATE_DIRECTORY_NAME } from '../../../ploinky-box/constants.mjs';
import { PLOINKY_WORKSPACE_ROOT } from '../config.js';
import {
    AGENT_DATA_POLICY_CODE,
    isPathWithin,
    projectedCanonicalPath,
    assertCanonicalAgentDataPath,
    validateAgentDataKey,
    AGENTS_DATA_SEGMENT,
} from './agentDataPathPolicy.js';

function guardError(message, context = {}) {
    const error = new Error(message);
    error.code = AGENT_DATA_POLICY_CODE;
    error.status = 422;
    error.context = context;
    return error;
}

// Router security, edge routing and edge publication state, and encrypted
// controller stores live under `.ploinky/data`. Agents never see that directory,
// even through a broad workspace bind. The master key lives under
// `.data/dpu-data`, accessible only through an explicit data grant.
// The rest of the controller
// root (`.ploinky`, including the dependency store) is pinned read-only by
// `controllerGuardMounts`, which does not make it confidential. Existing writable
// workspace grants retain a separate writable projection of `.ploinky/repos`.
//
// The Box host state (`<workspace>/.ploinky-box`, plan D3) is masked the same
// way, with one difference: it is never absent. Host launches create its
// skeleton before they plan mounts, and inside a Box the Box's own read-only
// mask is always there, so an absent or symlinked directory is a guard error,
// never a reason to pin the workspace read-only or to skip the mask.
export const HOST_STATE_GUARD_KEY = 'host';
// The whole workspace `.data` is opaque through a broad workspace bind. A
// launch sees its own `.data/agents/<instance>` at its real path inside that
// mask (and at /root); every other store under `.data` reaches an agent only
// through an explicit, separately validated bind (home, volume, storage).
export const DATA_GUARD_KEY = 'workspace-data';

function canonicalWorkspaceDataRoot(hostPath, workspaceRoot) {
    assertCanonicalAgentDataPath(hostPath, { workspaceRoot, allowDataRoot: true });
    let stat;
    try { stat = fs.lstatSync(hostPath); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        throw guardError(`the workspace data directory '${hostPath}' is missing`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw guardError(`the workspace data directory '${hostPath}' must be a real directory`);
    }
    return projectedCanonicalPath(hostPath);
}

export function protectedControllerStateRoots(workspaceRoot = PLOINKY_WORKSPACE_ROOT) {
    const root = path.resolve(workspaceRoot);
    return Object.freeze([
        Object.freeze({ key: 'data', hostPath: path.join(root, '.ploinky', 'data') }),
        Object.freeze({ key: HOST_STATE_GUARD_KEY, hostPath: path.join(root, HOST_STATE_DIRECTORY_NAME) }),
        Object.freeze({ key: DATA_GUARD_KEY, hostPath: path.join(root, '.data') }),
    ]);
}

// The canonical location of `.ploinky-box`: its canonical parent plus its own
// name, so that a symlink at the name itself is never followed. It must be a
// real directory: a missing one means the launch skipped the skeleton, and a
// link or file there would move the mask somewhere else.
function canonicalHostStateRoot(hostPath) {
    const canonical = path.join(projectedCanonicalPath(path.dirname(hostPath)), path.basename(hostPath));
    let stat;
    try {
        stat = fs.lstatSync(canonical);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw guardError(`the Box host state directory '${hostPath}' is missing; a host launch must create `
                + 'its skeleton before it plans the runtime guards', { hostPath });
        }
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw guardError(`the Box host state directory '${hostPath}' must be a real directory, not a link or a file`, {
            hostPath,
        });
    }
    return canonical;
}

function guardBase(workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    const digest = crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
    const temporaryRoot = fs.realpathSync.native(os.tmpdir());
    const selected = path.join(temporaryRoot, 'ploinky-runtime-guards', digest);
    if (isPathWithin(selected, projectedCanonicalPath(root))) {
        throw guardError('unable to place runtime guard outside the agent-visible workspace', { root });
    }
    return selected;
}

// A read-only view of `.data` that holds nothing but the mountpoint
// `agents/<name>` for the launch's own home. It lives beside the guard sources,
// outside the workspace, and is never written by the runtime: the home is bound
// over the pre-created, permanently empty mountpoint.
function ownAgentDataProjection(agentDataDir, workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    const source = path.resolve(String(agentDataDir));
    const agentsRoot = path.join(root, '.data', AGENTS_DATA_SEGMENT);
    // Only an agent home (`.data/agents/<name>`) is projected; any other home
    // (the workspace itself for a static agent) leaves the plain mask.
    if (path.dirname(source) !== agentsRoot) return null;
    const name = validateAgentDataKey(path.basename(source), { label: 'agent data directory name' });
    assertCanonicalAgentDataPath(source, { workspaceRoot: root });
    let stat;
    try { stat = fs.lstatSync(source); } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw guardError(`agent data directory '${source}' must be a real directory`, { source });
    }
    const digest = crypto.createHash('sha256').update(source).digest('hex').slice(0, 24);
    const view = path.join(guardBase(root), 'data-views', digest);
    const viewAgents = path.join(view, AGENTS_DATA_SEGMENT);
    const mountpoint = path.join(viewAgents, name);
    fs.mkdirSync(path.dirname(view), { recursive: true, mode: 0o700 });
    for (const directory of [view, viewAgents, mountpoint]) {
        try {
            fs.mkdirSync(directory, { mode: 0o755 });
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
        if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) {
            throw guardError(`runtime data view '${directory}' must be a physical directory`, { directory });
        }
    }
    const listing = (directory) => fs.readdirSync(directory).sort().join('/');
    if (listing(view) !== AGENTS_DATA_SEGMENT || listing(viewAgents) !== name || listing(mountpoint) !== '') {
        throw guardError(`runtime data view '${view}' holds unexpected entries`, { view });
    }
    for (const directory of [mountpoint, viewAgents, view]) fs.chmodSync(directory, 0o555);
    return Object.freeze({ view, source: projectedCanonicalPath(source), name });
}

// The mountpoints that binds nested strictly below `maskTarget` need, relative to
// it. Only the topmost nested targets count: a deeper target's mountpoint lives in
// that bind's own source. A bind of a regular file needs a file mountpoint.
function nestedMaskEntries(bindings, maskTarget) {
    const prefix = maskTarget === '/' ? '/' : `${maskTarget}/`;
    const nested = bindings.filter(binding => binding.target.startsWith(prefix));
    const kinds = new Map();
    for (const binding of nested) {
        if (nested.some(other => other.target !== binding.target && binding.target.startsWith(`${other.target}/`))) continue;
        const relative = binding.target.slice(prefix.length);
        const segments = relative.split('/');
        if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) {
            throw guardError(`runtime bind target '${binding.target}' below '${maskTarget}' is not a plain path`, {
                target: binding.target,
            });
        }
        let kind;
        try {
            kind = fs.statSync(binding.source).isFile() ? 'file' : 'dir';
        } catch (error) {
            if (error?.code === 'ENOENT') {
                throw guardError(`runtime bind source '${binding.source}' for '${binding.target}' is missing`, {
                    source: binding.source,
                    target: binding.target,
                });
            }
            throw error;
        }
        if (kinds.has(relative) && kinds.get(relative) !== kind) {
            throw guardError(`runtime bind target '${binding.target}' has conflicting kinds`, { target: binding.target });
        }
        kinds.set(relative, kind);
    }
    return Array.from(kinds.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([relative, kind]) => Object.freeze({ relative, kind }));
}

function expectedMaskViewListing(entries) {
    const listed = new Set();
    for (const { relative, kind } of entries) {
        const segments = relative.split('/');
        for (let depth = 1; depth < segments.length; depth += 1) listed.add(`${segments.slice(0, depth).join('/')}/`);
        listed.add(kind === 'file' ? relative : `${relative}/`);
    }
    return Array.from(listed).sort();
}

function setTreeModes(directory, { dirMode, fileMode }) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const child = path.join(directory, entry.name);
        if (entry.isDirectory()) setTreeModes(child, { dirMode, fileMode });
        else if (entry.isFile()) fs.chmodSync(child, fileMode);
    }
    fs.chmodSync(directory, dirMode);
}

// A read-only tree under the guard base holding only the given mountpoints. The
// name is derived from the entries, and the tree is built aside and published by
// one rename, so concurrent launches either publish it or reuse an identical one.
// Never writable once published; verified exactly on every use.
function nestedMaskView(workspaceRoot, entries) {
    const viewsRoot = path.join(guardBase(workspaceRoot), 'mask-views');
    fs.mkdirSync(viewsRoot, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(viewsRoot).isSymbolicLink() || !fs.lstatSync(viewsRoot).isDirectory()) {
        throw guardError(`runtime mask view root '${viewsRoot}' must be a physical directory`, { viewsRoot });
    }
    const key = JSON.stringify(entries.map(({ relative, kind }) => [relative, kind]));
    const view = path.join(viewsRoot, crypto.createHash('sha256').update(key).digest('hex').slice(0, 24));
    if (!fs.existsSync(view)) {
        const build = fs.mkdtempSync(path.join(viewsRoot, '.build-'));
        try {
            for (const { relative, kind } of entries) {
                const mountpoint = path.join(build, ...relative.split('/'));
                fs.mkdirSync(path.dirname(mountpoint), { recursive: true, mode: 0o755 });
                if (kind === 'file') fs.writeFileSync(mountpoint, '', { flag: 'wx', mode: 0o444 });
                else fs.mkdirSync(mountpoint, { mode: 0o755 });
            }
            setTreeModes(build, { dirMode: 0o555, fileMode: 0o444 });
            try {
                fs.renameSync(build, view);
            } catch (error) {
                if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
            }
        } finally {
            if (fs.existsSync(build)) {
                setTreeModes(build, { dirMode: 0o755, fileMode: 0o644 });
                fs.rmSync(build, { recursive: true, force: true });
            }
        }
    }
    const stat = fs.lstatSync(view);
    const listing = stat.isSymbolicLink() || !stat.isDirectory()
        ? null
        : guardSourceEntries(view, { maxDepth: Infinity, maxEntries: Infinity });
    if (!listing || [...listing].sort().join('\n') !== expectedMaskViewListing(entries).join('\n')) {
        throw guardError(`runtime mask view '${view}' holds unexpected entries`, { view, entries: listing });
    }
    return view;
}

// Lists what a guard source holds, for the error only: relative paths, directories
// with a trailing `/`, links with a trailing `@` and never followed, depth- and
// count-bounded, sorted. A listing failure is reported in place of the entries.
export function guardSourceEntries(source, { maxDepth = 4, maxEntries = 20 } = {}) {
    const entries = [];
    let truncated = false;
    const walk = (directory, relative, depth) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entries.length >= maxEntries) {
                truncated = true;
                return;
            }
            const name = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) {
                entries.push(`${name}@`);
            } else if (entry.isDirectory()) {
                entries.push(`${name}/`);
                if (depth < maxDepth) walk(path.join(directory, entry.name), name, depth + 1);
            } else {
                entries.push(name);
            }
        }
    };
    try {
        walk(source, '', 1);
    } catch (error) {
        entries.push(`<listing failed: ${error?.code || error?.message || 'unknown error'}>`);
    }
    if (truncated) entries.push('...');
    return entries;
}

export function ensureControllerGuardSources({
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
} = {}) {
    const base = guardBase(workspaceRoot);
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(base).isSymbolicLink()) {
        throw guardError(`runtime guard base '${base}' must be a physical directory`, { base });
    }
    fs.chmodSync(base, 0o700);
    const sources = new Map();
    for (const protectedRoot of protectedControllerStateRoots(workspaceRoot)) {
        const source = path.join(base, protectedRoot.key);
        fs.mkdirSync(source, { recursive: true, mode: 0o555 });
        if (fs.lstatSync(source).isSymbolicLink()) {
            throw guardError(`runtime guard source '${source}' must be a physical directory`, { source });
        }
        if (fs.readdirSync(source).length !== 0) {
            // A runtime that creates a mountpoint inside a shared source leaves a path such as
            // `agents/<name>/`. Naming it identifies the launch that nested a bind under the mask.
            const entries = guardSourceEntries(source);
            throw guardError(`runtime guard source '${source}' is not empty (entries: ${entries.join(', ')})`, {
                source,
                entries,
            });
        }
        fs.chmodSync(source, 0o555);
        sources.set(protectedRoot.key, source);
    }
    return sources;
}

// The host and workspace data skeletons persist. Only the controller data root
// can be a runtime-created mountpoint.
export function prepareControllerGuardMountpointCleanup({
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
} = {}) {
    const missingRoots = protectedControllerStateRoots(workspaceRoot)
        .filter(({ key, hostPath }) => key !== HOST_STATE_GUARD_KEY
            && key !== DATA_GUARD_KEY && !fs.existsSync(hostPath));
    return () => {
        for (const { hostPath } of missingRoots) {
            let stat;
            try {
                stat = fs.lstatSync(hostPath);
            } catch (error) {
                if (error?.code === 'ENOENT') continue;
                throw error;
            }
            if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(hostPath).length !== 0) {
                throw guardError(
                    `runtime created an unexpected non-empty controller guard mountpoint '${hostPath}'`,
                    { hostPath },
                );
            }
            try {
                fs.rmdirSync(hostPath);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
    };
}

export function normalizeRuntimeMountTarget(value) {
    const target = String(value || '');
    if (!path.posix.isAbsolute(target) || target.includes('\0')) {
        throw guardError('runtime bind target must be an absolute POSIX path', { target });
    }
    return path.posix.resolve(target);
}

function runtimeDescendant(target, relativeHostPath) {
    const segments = relativeHostPath.split(path.sep).filter(Boolean);
    return normalizeRuntimeMountTarget(path.posix.join(normalizeRuntimeMountTarget(target), ...segments));
}

function runtimePathWithin(candidate, parent) {
    return candidate === parent || candidate.startsWith(parent === '/' ? '/' : `${parent}/`);
}

function protectedRootSymlinks(target) {
    const links = [];
    let remaining = path.resolve(target).split(path.sep).filter(Boolean);
    let cursor = path.parse(path.resolve(target)).root;
    for (let depth = 0; remaining.length; depth += 1) {
        if (depth > 256 || links.length > 40) throw guardError('protected controller root has excessive symlink indirection');
        cursor = path.join(cursor, remaining.shift());
        let entry;
        try { entry = fs.lstatSync(cursor); } catch (error) {
            if (error?.code === 'ENOENT') break;
            throw error;
        }
        if (!entry.isSymbolicLink()) continue;
        links.push(cursor);
        const resolved = path.resolve(path.dirname(cursor), fs.readlinkSync(cursor), ...remaining);
        remaining = resolved.split(path.sep).filter(Boolean);
        cursor = path.parse(resolved).root;
    }
    return links;
}

export function controllerGuardTargets(bindings, {
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
} = {}) {
    const targets = new Map();
    const frameworkRoot = projectedCanonicalPath(path.join(workspaceRoot, '.ploinky'));
    for (const binding of bindings || []) {
        const rawSource = String(binding?.hostPath || binding?.source || '').trim();
        const rawDestination = String(binding?.runtimePath || binding?.destination || '');
        if (!rawSource || !rawDestination) continue;
        const destination = normalizeRuntimeMountTarget(rawDestination);
        const source = path.resolve(rawSource);
        const canonicalSource = projectedCanonicalPath(source);
        for (const protectedRoot of protectedControllerStateRoots(workspaceRoot)) {
            const hostState = protectedRoot.key === HOST_STATE_GUARD_KEY;
            const workspaceData = protectedRoot.key === DATA_GUARD_KEY;
            let canonicalProtectedRoot;
            if (workspaceData) canonicalProtectedRoot = canonicalWorkspaceDataRoot(protectedRoot.hostPath, workspaceRoot);
            else if (hostState) {
                canonicalProtectedRoot = path.join(
                    projectedCanonicalPath(path.dirname(protectedRoot.hostPath)), path.basename(protectedRoot.hostPath),
                );
            } else canonicalProtectedRoot = projectedCanonicalPath(protectedRoot.hostPath);
            // Workspace and controller aliases are allowed. Inspect indirection
            // introduced below the canonical controller root instead. The host
            // state directory takes no indirection at all (checked below).
            for (const symlink of hostState || workspaceData ? [] : protectedRootSymlinks(path.join(frameworkRoot, protectedRoot.key))) {
                const parent = projectedCanonicalPath(path.dirname(symlink));
                if (binding.readOnly !== true && !isPathWithin(parent, frameworkRoot)
                    && isPathWithin(parent, canonicalSource)) {
                    throw guardError('protected controller root traverses a writable symlink outside its controller parent', {
                        symlink, source, destination,
                    });
                }
            }
            if (hostState && isPathWithin(canonicalProtectedRoot, canonicalSource)) {
                canonicalHostStateRoot(protectedRoot.hostPath);
            }
            if (isPathWithin(canonicalSource, canonicalProtectedRoot)) {
                // Binds of or below `.data` (homes, volumes, storage) were
                // validated by the agent data policy and are explicit grants.
                if (workspaceData) {
                    assertCanonicalAgentDataPath(source, { workspaceRoot, allowDataRoot: true });
                    continue;
                }
                throw guardError(
                    `runtime bind source '${source}' is inside protected controller state`,
                    { source, canonicalSource, protectedRoot: protectedRoot.hostPath, destination },
                );
            }
            if (!isPathWithin(canonicalProtectedRoot, canonicalSource)) continue;
            const relative = path.relative(canonicalSource, canonicalProtectedRoot);
            const target = runtimeDescendant(destination, relative);
            const existing = targets.get(target);
            if (existing && existing.key !== protectedRoot.key) {
                throw guardError(`runtime guard target '${target}' has conflicting protected roots`);
            }
            targets.set(target, Object.freeze({
                key: protectedRoot.key,
                target,
                protectedHostPath: protectedRoot.hostPath,
                protectedParentHostPath: path.dirname(canonicalProtectedRoot),
                parentTarget: path.posix.dirname(target),
            }));
        }
    }
    return Array.from(targets.values()).sort((left, right) => left.target.localeCompare(right.target));
}

function writableRepositoryMounts(bindings, workspaceRoot) {
    const workspace = projectedCanonicalPath(workspaceRoot);
    const writableWorkspaces = bindings.filter(binding => (
        !binding.readOnly && isPathWithin(workspace, binding.source)
    ));
    if (!writableWorkspaces.length) return [];

    const repositories = path.join(projectedCanonicalPath(path.join(workspaceRoot, '.ploinky')), 'repos');
    let stat;
    try { stat = fs.lstatSync(repositories); } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || !isPathWithin(repositories, workspace)) {
        throw guardError('writable repository root must be a physical directory inside the workspace', { repositories });
    }
    for (const protectedRoot of protectedControllerStateRoots(workspaceRoot)) {
        const protectedPath = projectedCanonicalPath(protectedRoot.hostPath);
        if (isPathWithin(protectedPath, repositories) || isPathWithin(repositories, protectedPath)) {
            throw guardError('writable repository root overlaps protected controller state', { repositories, protectedPath });
        }
    }

    const mounts = new Map();
    for (const binding of writableWorkspaces) {
        const target = runtimeDescendant(binding.target, path.relative(binding.source, repositories));
        // Never override an explicit read-only grant at this projection. Nested
        // code/dependency grants remain separate mounts below this parent.
        if (bindings.some(entry => entry.readOnly
            && runtimePathWithin(target, entry.target)
            && runtimePathWithin(entry.target, binding.target))) continue;
        const existing = bindings.filter(entry => entry.target === target);
        if (existing.some(entry => entry.source !== repositories)) {
            throw guardError(`repository target '${target}' conflicts with a bind source`);
        }
        if (existing.length) continue;
        mounts.set(target, { source: repositories, target, readOnly: false });
    }
    return Array.from(mounts.values()).sort((left, right) => left.target.localeCompare(right.target));
}

export function controllerGuardMounts(targets, options = {}) {
    const bindings = (options.bindings || []).map(binding => ({
        source: projectedCanonicalPath(binding.hostPath || binding.source),
        target: normalizeRuntimeMountTarget(binding.runtimePath || binding.destination),
        readOnly: binding.readOnly === true,
    }));
    if (!targets.length && !bindings.length) return [];
    const repositories = writableRepositoryMounts(bindings, options.workspaceRoot || PLOINKY_WORKSPACE_ROOT);
    const sources = ensureControllerGuardSources(options);
    const parents = new Map();
    const children = [];

    const frameworkRoot = projectedCanonicalPath(path.join(
        options.workspaceRoot || PLOINKY_WORKSPACE_ROOT, '.ploinky',
    ));
    function pinAncestors(hostPath, binding, { readOnly = false } = {}) {
        if (!isPathWithin(hostPath, binding.source)) return;
        const relative = path.relative(binding.source, hostPath);
        let source = binding.source;
        let target = binding.target;
        for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
            if (segment) {
                source = path.join(source, segment);
                target = path.posix.join(target, segment);
            }
            const pinReadOnly = binding.readOnly || isPathWithin(source, frameworkRoot)
                || (source === hostPath && readOnly);
            // A bind already pins its own root against renames. Only tighten it
            // when this is the protected controller parent; never turn a broad
            // writable project bind read-only merely because it contains data.
            const existing = bindings.filter(entry => entry.target === target);
            if (existing.some(entry => entry.source !== source)) {
                throw guardError(`runtime guard parent '${target}' conflicts with a bind source`);
            }
            if (existing.length && (!pinReadOnly || existing.every(entry => entry.readOnly))) continue;
            const guardSource = fs.existsSync(source) ? source : sources.get('data');
            const previous = parents.get(target);
            if (previous && previous.source !== guardSource) {
                throw guardError(`runtime guard parent '${target}' has conflicting sources`);
            }
            parents.set(target, {
                source: guardSource,
                target,
                readOnly: pinReadOnly || previous?.readOnly === true,
                parent: true,
                replaceExisting: existing.length > 0,
            });
        }
    }

    // A mounted child alone does not stop renaming one of its ancestors and
    // recreating the old path. Pin every exposed ancestor, preserving project
    // writability, and make the controller parent itself read-only. This also
    // protects its symlink entries when a protected root points into a code grant.
    for (const binding of bindings) pinAncestors(frameworkRoot, binding, { readOnly: true });
    for (const guard of targets) {
        // The host state directory was proven a real directory when it was
        // targeted; prove it again here, so it is masked and never treated as
        // absent (which would pin the whole workspace read-only).
        const exists = guard.key === HOST_STATE_GUARD_KEY
            ? Boolean(canonicalHostStateRoot(guard.protectedHostPath))
            : guard.key === DATA_GUARD_KEY
                ? Boolean(canonicalWorkspaceDataRoot(guard.protectedHostPath, options.workspaceRoot || PLOINKY_WORKSPACE_ROOT))
            : fs.existsSync(guard.protectedHostPath);
        if (guard.parentTarget) {
            for (const binding of bindings) {
                if (runtimeDescendant(binding.target, path.relative(binding.source, guard.protectedParentHostPath)) !== guard.parentTarget) continue;
                pinAncestors(guard.protectedParentHostPath, binding, { readOnly: !exists });
            }
            // Retain the standalone planner contract for callers that already
            // supplied resolved targets rather than the original bind list. The
            // host state and workspace data parents are the workspace itself:
            // never pin it.
            if (!bindings.length && guard.key !== HOST_STATE_GUARD_KEY && guard.key !== DATA_GUARD_KEY) {
                const source = fs.existsSync(guard.protectedParentHostPath)
                    ? guard.protectedParentHostPath : sources.get(guard.key);
                parents.set(guard.parentTarget, { source, target: guard.parentTarget, readOnly: true, parent: true });
            }
        }
        // An absent child must stay absent: a child bind would create a host
        // mountpoint which is unreachable if removed after container creation.
        const ownData = guard.key === DATA_GUARD_KEY && guard.parentTarget && options.agentDataDir
            ? ownAgentDataProjection(options.agentDataDir, options.workspaceRoot || PLOINKY_WORKSPACE_ROOT)
            : null;
        if (ownData) {
            // Inside the mask, the launch's own home stays at its real path.
            children.push({ source: ownData.view, target: guard.target, readOnly: true });
            children.push({
                source: ownData.source,
                target: path.posix.join(guard.target, AGENTS_DATA_SEGMENT, ownData.name),
                readOnly: false,
            });
            continue;
        }
        if (exists || !guard.parentTarget) {
            // The shared source is mounted by every launch of the workspace, so the
            // engine must never create a mountpoint in it. A bind nested below the
            // `.data` mask (for example a staged real-path node_modules under the
            // agent's home) gets a launch-specific view that already holds exactly
            // those mountpoints and nothing else.
            const nested = guard.key === DATA_GUARD_KEY ? nestedMaskEntries(bindings, guard.target) : [];
            const source = nested.length
                ? nestedMaskView(options.workspaceRoot || PLOINKY_WORKSPACE_ROOT, nested)
                : sources.get(guard.key);
            children.push({ source, target: guard.target, readOnly: true });
        }
    }
    return [
        ...Array.from(parents.values()).sort((left, right) => left.target.split('/').length - right.target.split('/').length || left.target.localeCompare(right.target)),
        ...repositories,
        ...children,
    ];
}
