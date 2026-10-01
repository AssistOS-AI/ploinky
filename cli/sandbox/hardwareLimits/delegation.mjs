// Delegation state seen by the Box core (uid 1000) after root preparation
// (plan §7.1-§7.2). Structural readiness depends only on placement and
// ownership; backend readiness additionally needs the verified nested
// runtime/manager and successful parent creation. Each requested resource
// checks its own controller.

import fs from 'node:fs';
import path from 'node:path';

import {
    AGENTS_CGROUP_PARENT,
    SYSTEM_CGROUP_PARENT,
} from './resolve.mjs';

export const CGROUP_ROOT = '/sys/fs/cgroup';
export const CORE_CGROUP = '/ploinky/core';
export const DELEGATED_UID = 1000;
const CONTROLLERS = Object.freeze(['cpu', 'memory', 'pids']);
const MAX_READ = 256 * 1024;

function read(fsApi, target) {
    const text = String(fsApi.readFileSync(target, 'utf8'));
    if (text.length > MAX_READ) throw new Error(`${target} exceeds its read bound`);
    return text;
}

function words(text) {
    return String(text || '').split(/\s+/).filter(Boolean);
}

function cgroupPath(text) {
    const line = String(text || '').split('\n').find((entry) => entry.startsWith('0::'));
    return line ? line.slice(3).trim() : null;
}

function relative(root, cgroup) {
    return path.join(root, cgroup);
}

/**
 * Observe structural preparation from the core: this process and PID 1 are in
 * /ploinky/core, the root and /ploinky have no direct processes, and /ploinky
 * is delegated to uid 1000. Controllers are the ones actually enabled in
 * /ploinky's subtree.
 */
export function readStructuralDelegation({ fsApi = fs, cgroupRoot = CGROUP_ROOT, procRoot = '/proc' } = {}) {
    try {
        const self = cgroupPath(read(fsApi, `${procRoot}/self/cgroup`));
        const pid1 = cgroupPath(read(fsApi, `${procRoot}/1/cgroup`));
        if (self !== CORE_CGROUP || pid1 !== CORE_CGROUP) {
            return { structurallyPrepared: false, controllers: [], reason: `core placement is ${self || 'unknown'} (PID 1 ${pid1 || 'unknown'}), not ${CORE_CGROUP}` };
        }
        const ploinky = relative(cgroupRoot, '/ploinky');
        if (words(read(fsApi, `${cgroupRoot}/cgroup.procs`)).length || words(read(fsApi, `${ploinky}/cgroup.procs`)).length) {
            return { structurallyPrepared: false, controllers: [], reason: 'the namespace root or /ploinky has direct processes' };
        }
        const stat = fsApi.lstatSync(ploinky);
        if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== DELEGATED_UID) {
            return { structurallyPrepared: false, controllers: [], reason: '/ploinky is not delegated to the Box user' };
        }
        const enabled = new Set(words(read(fsApi, `${ploinky}/cgroup.subtree_control`)));
        return {
            structurallyPrepared: true,
            controllers: CONTROLLERS.filter((controller) => enabled.has(controller)),
            reason: null,
        };
    } catch (error) {
        return { structurallyPrepared: false, controllers: [], reason: `delegation state is unreadable (${error?.code || error?.message || error})` };
    }
}

/**
 * The nested backend: a bounded uid-1000 `podman --cgroup-manager=cgroupfs
 * info` must report crun and the cgroupfs manager. Configured defaults and
 * the effective invocation are reported separately.
 */
export function verifyNestedBackend({ query, timeoutMs = 10_000 } = {}) {
    let result;
    try {
        result = query('podman', ['--cgroup-manager=cgroupfs', 'info', '--format', 'json'], { timeoutMs });
    } catch (error) {
        return { ready: false, runtime: 'unknown', manager: 'unknown', reason: `nested podman info failed (${error.message})` };
    }
    if (!result?.ok) return { ready: false, runtime: 'unknown', manager: 'unknown', reason: 'nested podman info failed' };
    let info;
    try {
        info = JSON.parse(String(result.stdout || ''));
    } catch (_) {
        return { ready: false, runtime: 'unknown', manager: 'unknown', reason: 'nested podman info is not JSON' };
    }
    const runtime = String(info?.host?.ociRuntime?.name || 'unknown');
    const manager = String(info?.host?.cgroupManager || 'unknown');
    const ready = runtime === 'crun' && manager === 'cgroupfs';
    return { ready, runtime, manager, reason: ready ? null : `nested runtime ${runtime} with manager ${manager}` };
}

/**
 * Create /ploinky/agents and /ploinky/system as uid 1000 and enable only the
 * delegated controllers in each parent's subtree. No aggregate memory.max,
 * memory.swap.max or cpu.max is ever written (no pool in v1).
 */
export function ensureAgentCgroupParents({ fsApi = fs, cgroupRoot = CGROUP_ROOT, controllers = [] } = {}) {
    const created = [];
    for (const parent of [AGENTS_CGROUP_PARENT, SYSTEM_CGROUP_PARENT]) {
        const directory = relative(cgroupRoot, parent);
        try {
            fsApi.mkdirSync(directory);
            created.push(parent);
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            const stat = fsApi.lstatSync(directory);
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${parent} is not a real cgroup directory`);
        }
        for (const controller of controllers) {
            fsApi.writeFileSync(`${directory}/cgroup.subtree_control`, `+${controller}`);
        }
        const enabled = new Set(words(read(fsApi, `${directory}/cgroup.subtree_control`)));
        for (const controller of controllers) {
            if (!enabled.has(controller)) throw new Error(`${controller} could not be enabled in ${parent}`);
        }
    }
    return Object.freeze({ created });
}

/**
 * The complete delegation state: gate, structural and backend readiness,
 * agent controllers and the helper's controllers, with reason and fix.
 */
export function readDelegationState({
    gate = 'on',
    fsApi = fs,
    cgroupRoot = CGROUP_ROOT,
    procRoot = '/proc',
    query = null,
    createParents = true,
} = {}) {
    if (gate !== 'on') {
        return Object.freeze({ gate, structurallyPrepared: false, backendReady: false, controllers: [], helperControllers: [], reason: 'hardware limits are off', fix: null });
    }
    const structural = readStructuralDelegation({ fsApi, cgroupRoot, procRoot });
    if (!structural.structurallyPrepared) {
        return Object.freeze({
            gate, structurallyPrepared: false, backendReady: false, controllers: [], helperControllers: [],
            reason: structural.reason, fix: 'On the host run ploinky limits status, repair the reported prerequisite, then ploinky restart.',
        });
    }
    const backend = typeof query === 'function' ? verifyNestedBackend({ query }) : { ready: false, reason: 'nested backend not verified' };
    if (!backend.ready) {
        return Object.freeze({
            gate, structurallyPrepared: true, backendReady: false, controllers: structural.controllers, helperControllers: [],
            backend, reason: backend.reason, fix: 'Hardware limits require verified crun and nested cgroupfs; inspect ploinky diagnose before retrying.',
        });
    }
    if (createParents) {
        try {
            ensureAgentCgroupParents({ fsApi, cgroupRoot, controllers: structural.controllers });
        } catch (error) {
            return Object.freeze({
                gate, structurallyPrepared: true, backendReady: false, controllers: structural.controllers, helperControllers: [],
                backend, reason: `agent cgroup parents are unavailable (${error.message})`, fix: 'On the host run ploinky restart.',
            });
        }
    }
    return Object.freeze({
        gate,
        structurallyPrepared: true,
        backendReady: true,
        controllers: structural.controllers,
        helperControllers: structural.controllers,
        backend,
        reason: null,
        fix: null,
    });
}

// The authority helper gets /ploinky/system placement only when every one of
// its three limits is enforceable; otherwise its complete recorded argv is
// kept without placement (recorded, not enforced).
export function helperPlacement(state) {
    const all = CONTROLLERS.every((controller) => state?.helperControllers?.includes(controller));
    if (!state?.backendReady || !all) {
        return Object.freeze({ enforced: false, enginePrefix: [], args: [], status: 'recorded, not enforced' });
    }
    return Object.freeze({
        enforced: true,
        enginePrefix: ['--cgroup-manager=cgroupfs'],
        args: ['--cgroups=enabled', '--cgroupns=private', `--cgroup-parent=${SYSTEM_CGROUP_PARENT}`],
        status: 'enforced',
    });
}

/**
 * The helper placement from a captured hardware context: placement only in a
 * gate-on, prepared, backend-ready Box with all three controllers delegated.
 */
export function authorityHelperPlacementFromContext(context) {
    const usable = context?.gate === 'on' && context?.prepared === true && context?.backendReady === true;
    return helperPlacement({ backendReady: usable, helperControllers: usable ? [...(context.controllers || [])] : [] });
}

/**
 * Remove only empty libpod-ID leaves under the two owned parents whose full
 * IDs are absent from the engine. Never recurse or kill tasks.
 */
export function cleanupStaleLeaves({ fsApi = fs, cgroupRoot = CGROUP_ROOT, liveIds = new Set() } = {}) {
    const removed = [];
    const retained = [];
    for (const parent of [AGENTS_CGROUP_PARENT, SYSTEM_CGROUP_PARENT]) {
        const directory = relative(cgroupRoot, parent);
        let names = [];
        try { names = fsApi.readdirSync(directory); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
        for (const name of names) {
            const match = /^libpod-([a-f0-9]{64})(?:\.scope)?$/.exec(name);
            if (!match || liveIds.has(match[1])) continue;
            const leaf = path.join(directory, name);
            const stat = fsApi.lstatSync(leaf);
            if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== DELEGATED_UID) {
                retained.push({ leaf, reason: 'unexpected ownership or type' });
                continue;
            }
            if (words(read(fsApi, `${leaf}/cgroup.procs`)).length) {
                retained.push({ leaf, reason: 'not empty' });
                continue;
            }
            try {
                fsApi.rmdirSync(leaf);
                removed.push(leaf);
            } catch (error) {
                retained.push({ leaf, reason: error?.code || 'rmdir failed' });
            }
        }
    }
    return Object.freeze({ removed, retained });
}

/**
 * Exact leaf readback after create/start (plan §8.1): memory.max equals the
 * rendered limit, memory.swap.max is 0 with a memory limit, cpu.max matches
 * the quota and pids.max the limit. An inspect field alone is never proof.
 */
export function verifyLeafLimits({ fsApi = fs, cgroupRoot = CGROUP_ROOT, leaf, expected }) {
    const directory = path.join(cgroupRoot, leaf);
    const problems = [];
    const value = (name) => {
        try { return String(fsApi.readFileSync(`${directory}/${name}`, 'utf8')).trim(); } catch (_) { return null; }
    };
    if (!leaf.startsWith(`${AGENTS_CGROUP_PARENT}/`)) problems.push(`leaf ${leaf} is not under ${AGENTS_CGROUP_PARENT}`);
    if (expected.memoryBytes) {
        if (value('memory.max') !== String(expected.memoryBytes)) problems.push(`memory.max is ${value('memory.max')}`);
        if (value('memory.swap.max') !== '0') problems.push(`memory.swap.max is ${value('memory.swap.max')}`);
    }
    if (expected.cpus) {
        const cpuMax = value('cpu.max');
        const parts = String(cpuMax || '').split(/\s+/);
        const quota = Number(parts[0]);
        const period = Number(parts[1]);
        if (!(quota > 0 && period > 0) || Math.abs(quota / period - Number(expected.cpus)) > 1e-9) problems.push(`cpu.max is ${cpuMax}`);
    }
    if (expected.pidsLimit) {
        if (value('pids.max') !== String(expected.pidsLimit)) problems.push(`pids.max is ${value('pids.max')}`);
    }
    return Object.freeze({ ok: problems.length === 0, problems });
}

/**
 * After create/start of a hardware-placed agent: find its actual leaf from the
 * running process's cgroup and compare the applied values. Any disagreement
 * is a hardware refusal; the caller removes the candidate through its exact
 * ownership checks. The engine's own inspect fields are never the proof.
 */
export function verifyLaunchedHardwareLimits({
    descriptor,
    containerId,
    runtime = 'podman',
    query,
    fsApi = fs,
    cgroupRoot = CGROUP_ROOT,
    procRoot = '/proc',
    refuse,
}) {
    const placement = descriptor?.hardwarePlacement;
    if (!placement) return null;
    const inspected = query(runtime, ['container', 'inspect', '--format', '{{.State.Pid}}', containerId], { timeoutMs: 10_000 });
    const pid = Number(String(inspected?.stdout || '').trim());
    let leaf = null;
    if (inspected?.ok && Number.isSafeInteger(pid) && pid > 0) {
        try {
            leaf = cgroupPath(read(fsApi, `${procRoot}/${pid}/cgroup`));
        } catch (_) {
            leaf = null;
        }
    }
    const readback = leaf
        ? verifyLeafLimits({ fsApi, cgroupRoot, leaf, expected: placement.expected || {} })
        : { ok: false, problems: ['the agent leaf cgroup could not be observed'] };
    const problems = [...readback.problems];
    if (!leaf || !leaf.startsWith(`${placement.cgroupParent}/`)) {
        problems.push(`the agent runs in ${leaf || 'an unknown cgroup'}, not under ${placement.cgroupParent}`);
    }
    if (!readback.ok || problems.length) {
        throw refuse(`the applied limits disagree with the admitted ones (${problems.join('; ')})`);
    }
    return Object.freeze({ leaf, verified: true });
}
