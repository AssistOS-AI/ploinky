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
    const candidates = [
        path.join(path.dirname(root), `.ploinky-runtime-guards-${digest}`),
        path.join(os.tmpdir(), 'ploinky-runtime-guards', digest),
    ];
    const selected = candidates.find(candidate => !isPathWithin(candidate, root));
    if (!selected) throw guardError('unable to place runtime guard outside the agent-visible workspace', { root });
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

function runtimeDescendant(target, relativeHostPath) {
    const segments = relativeHostPath.split(path.sep).filter(Boolean);
    return path.posix.join(String(target || '/'), ...segments);
}

export function legacyAgentGuardTargets(bindings, {
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
} = {}) {
    const targets = new Map();
    for (const binding of bindings || []) {
        const rawSource = String(binding?.hostPath || binding?.source || '').trim();
        const destination = String(binding?.runtimePath || binding?.destination || '').trim();
        if (!rawSource || !destination) continue;
        const source = path.resolve(rawSource);
        const canonicalSource = projectedCanonicalPath(source);
        for (const protectedRoot of protectedLegacyAgentRoots(workspaceRoot)) {
            const canonicalProtectedRoot = projectedCanonicalPath(protectedRoot.hostPath);
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
            }));
        }
    }
    return Array.from(targets.values()).sort((left, right) => left.target.localeCompare(right.target));
}
