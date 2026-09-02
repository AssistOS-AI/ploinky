import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { PLOINKY_WORKSPACE_ROOT } from '../config.js';
import {
    AGENT_DATA_POLICY_CODE,
    isPathWithin,
    projectedCanonicalPath,
} from './agentDataPathPolicy.js';

function guardError(message, context = {}) {
    const error = new Error(message);
    error.code = AGENT_DATA_POLICY_CODE;
    error.status = 422;
    error.context = context;
    return error;
}

export function protectedLegacyAgentRoots(workspaceRoot = PLOINKY_WORKSPACE_ROOT) {
    const root = path.resolve(workspaceRoot);
    return Object.freeze([
        Object.freeze({ key: 'data', hostPath: path.join(root, '.ploinky', 'data') }),
        Object.freeze({ key: 'shared', hostPath: path.join(root, '.ploinky', 'shared') }),
    ]);
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

export function ensureLegacyAgentGuardSources({
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
} = {}) {
    const base = guardBase(workspaceRoot);
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(base).isSymbolicLink()) {
        throw guardError(`runtime guard base '${base}' must be a physical directory`, { base });
    }
    fs.chmodSync(base, 0o700);
    const sources = new Map();
    for (const protectedRoot of protectedLegacyAgentRoots(workspaceRoot)) {
        const source = path.join(base, protectedRoot.key);
        fs.mkdirSync(source, { recursive: true, mode: 0o555 });
        if (fs.lstatSync(source).isSymbolicLink()) {
            throw guardError(`runtime guard source '${source}' must be a physical directory`, { source });
        }
        if (fs.readdirSync(source).length !== 0) {
            throw guardError(`runtime guard source '${source}' is not empty`, { source });
        }
        fs.chmodSync(source, 0o555);
        sources.set(protectedRoot.key, source);
    }
    return sources;
}

export function prepareLegacyGuardMountpointCleanup({
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
} = {}) {
    const missingRoots = protectedLegacyAgentRoots(workspaceRoot)
        .filter(({ hostPath }) => !fs.existsSync(hostPath));
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
                    `runtime created an unexpected non-empty legacy guard mountpoint '${hostPath}'`,
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

function legacyRootSymlinks(target) {
    const links = [];
    let remaining = path.resolve(target).split(path.sep).filter(Boolean);
    let cursor = path.parse(path.resolve(target)).root;
    for (let depth = 0; remaining.length; depth += 1) {
        if (depth > 256 || links.length > 40) throw guardError('legacy root has excessive symlink indirection');
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

export function legacyAgentGuardTargets(bindings, {
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
        for (const protectedRoot of protectedLegacyAgentRoots(workspaceRoot)) {
            const canonicalProtectedRoot = projectedCanonicalPath(protectedRoot.hostPath);
            for (const symlink of legacyRootSymlinks(protectedRoot.hostPath)) {
                const parent = projectedCanonicalPath(path.dirname(symlink));
                if (binding.readOnly !== true && !isPathWithin(parent, frameworkRoot)
                    && isPathWithin(parent, canonicalSource)) {
                    throw guardError('legacy root traverses a writable symlink outside its protected controller parent', {
                        symlink, source, destination,
                    });
                }
            }
            if (isPathWithin(canonicalSource, canonicalProtectedRoot)) {
                throw guardError(
                    `runtime bind source '${source}' is inside protected legacy agent data`,
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

export function legacyAgentGuardMounts(targets, options = {}) {
    const bindings = (options.bindings || []).map(binding => ({
        source: projectedCanonicalPath(binding.hostPath || binding.source),
        target: normalizeRuntimeMountTarget(binding.runtimePath || binding.destination),
        readOnly: binding.readOnly === true,
    }));
    if (!targets.length && !bindings.length) return [];
    const sources = ensureLegacyAgentGuardSources(options);
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
    // protects its symlink entries when a legacy root points into a code grant.
    for (const binding of bindings) pinAncestors(frameworkRoot, binding, { readOnly: true });
    for (const guard of targets) {
        const exists = fs.existsSync(guard.protectedHostPath);
        if (guard.parentTarget) {
            for (const binding of bindings) {
                if (runtimeDescendant(binding.target, path.relative(binding.source, guard.protectedParentHostPath)) !== guard.parentTarget) continue;
                pinAncestors(guard.protectedParentHostPath, binding, { readOnly: !exists });
            }
            // Retain the standalone planner contract for callers that already
            // supplied resolved targets rather than the original bind list.
            if (!bindings.length) {
                const source = fs.existsSync(guard.protectedParentHostPath)
                    ? guard.protectedParentHostPath : sources.get(guard.key);
                parents.set(guard.parentTarget, { source, target: guard.parentTarget, readOnly: true, parent: true });
            }
        }
        // An absent child must stay absent: a child bind would create a host
        // mountpoint which is unreachable if removed after container creation.
        if (exists || !guard.parentTarget) children.push({ source: sources.get(guard.key), target: guard.target, readOnly: true });
    }
    return [
        ...Array.from(parents.values()).sort((left, right) => left.target.split('/').length - right.target.split('/').length || left.target.localeCompare(right.target)),
        ...children,
    ];
}
