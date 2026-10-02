// Delegation state seen by the Box core (uid 1000) after root preparation
// (plan §7.1-§7.2). Structural readiness depends only on placement and
// ownership; backend readiness additionally needs the verified nested
// runtime/manager and successful parent creation. Each requested resource
// checks its own controller.

import fs from 'node:fs';
import path from 'node:path';

import { parseCgroupMount } from '../../../ploinky-box/entrypoint/cgroupDelegation.mjs';
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
/**
 * The Box's own cgroup mount, read from its mountinfo: cgroup v2, writable and
 * delegated with nsdelegate (plan §7.1). null when mountinfo is unreadable,
 * so an unknown mount is never reported as a known cgroup problem.
 */
export function readCgroupMountProblem({ fsApi = fs, cgroupRoot = CGROUP_ROOT, procRoot = '/proc' } = {}) {
    let mountinfo;
    try {
        mountinfo = read(fsApi, `${procRoot}/self/mountinfo`);
    } catch (_) {
        return null;
    }
    const mount = parseCgroupMount(mountinfo, cgroupRoot);
    if (!mount || mount.fstype !== 'cgroup2') return `${cgroupRoot} is ${mount ? mount.fstype : 'not mounted'} (cgroup v1 or no unified hierarchy), not cgroup2`;
    if (!mount.mountOptions.includes('rw') || !mount.superOptions.includes('rw')) return `the cgroup2 mount at ${cgroupRoot} is read-only`;
    if (!mount.superOptions.includes('nsdelegate')) return `the cgroup2 mount at ${cgroupRoot} lacks nsdelegate`;
    return '';
}

export function readStructuralDelegation({ fsApi = fs, cgroupRoot = CGROUP_ROOT, procRoot = '/proc' } = {}) {
    const mountProblem = readCgroupMountProblem({ fsApi, cgroupRoot, procRoot });
    if (mountProblem) return { structurallyPrepared: false, controllers: [], kind: 'cgroup', reason: mountProblem };
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
        // kind 'cgroup': the Box's own mount is v1, read-only or lacks
        // nsdelegate; 'placement': preparation was not observed.
        return Object.freeze({
            gate, structurallyPrepared: false, backendReady: false, controllers: [], helperControllers: [],
            kind: structural.kind || 'placement',
            reason: structural.reason, fix: 'On the host run ploinky limits status, repair the reported prerequisite, then ploinky restart.',
        });
    }
    const backend = typeof query === 'function' ? verifyNestedBackend({ query }) : { ready: false, runtime: 'unknown', manager: 'unknown', reason: 'nested backend not verified' };
    if (!backend.ready) {
        // kind 'runtime': the nested runtime/manager is not the verified
        // crun + cgroupfs pair (or could not be observed).
        return Object.freeze({
            gate, structurallyPrepared: true, backendReady: false, controllers: structural.controllers, helperControllers: [],
            kind: 'runtime',
            backend, reason: backend.reason, fix: 'Hardware limits require verified crun and nested cgroupfs; inspect ploinky diagnose before retrying.',
        });
    }
    if (createParents) {
        try {
            ensureAgentCgroupParents({ fsApi, cgroupRoot, controllers: structural.controllers });
        } catch (error) {
            // kind 'parents': the backend is verified but uid 1000 could not
            // create /ploinky/agents or /ploinky/system (backend unavailable).
            return Object.freeze({
                gate, structurallyPrepared: true, backendReady: false, controllers: structural.controllers, helperControllers: [],
                kind: 'parents',
                backend, reason: `the agent cgroup parents could not be created (${error.message})`,
                fix: 'On the host run ploinky limits status, repair the reported prerequisite, then ploinky restart.',
            });
        }
    }
    return Object.freeze({
        gate,
        structurallyPrepared: true,
        backendReady: true,
        kind: null,
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

// The kernel stores memory.max rounded down to its page size, so a declared
// byte count such as 100000000 reads back as 99999744. Accept exactly that
// rounding (never a larger value or a different limit).
const PAGE_BYTES = 4096;
const MAX_PAGE_ROUNDING = 65536;

export function memoryLimitMatches(observed, expectedBytes) {
    if (!/^\d+$/.test(String(observed ?? ''))) return false;
    const actual = Number(observed);
    const expected = Number(expectedBytes);
    if (!Number.isSafeInteger(actual) || !Number.isSafeInteger(expected)) return false;
    if (actual === expected) return true;
    return actual < expected && expected - actual < MAX_PAGE_ROUNDING && actual % PAGE_BYTES === 0;
}

const SWAP_ACCOUNTING_REFUSAL = Object.freeze({
    reasonCode: 'controller_unavailable',
    reason: 'Swap accounting is unavailable: the agent cgroup has no memory.swap.max, so its memory limit cannot be '
        + 'paired with an equal memory-and-swap limit and swap could extend the cap.',
    fix: 'Enable cgroup v2 swap accounting for the memory controller on the host (on macOS inside the Podman machine), '
        + 'then run ploinky restart. Ploinky will not change host boot settings.',
});

/**
 * Exact leaf readback after create/start (plan §8.1): memory.max equals the
 * rendered limit (allowing only the kernel's page rounding), memory.swap.max
 * is 0 with a memory limit, cpu.max matches the quota and pids.max the limit.
 * An inspect field alone is never proof. A missing memory.swap.max means swap
 * accounting is unavailable only while the leaf directory itself exists; a
 * leaf that is gone (its process exited) is reported as missing, and every
 * file that could not be read is listed so the caller can re-check liveness.
 */
export function verifyLeafLimits({ fsApi = fs, cgroupRoot = CGROUP_ROOT, leaf, expected }) {
    const directory = path.join(cgroupRoot, leaf);
    const problems = [];
    const readFailures = [];
    const observed = {};
    let refusal = null;
    let leafPresent = false;
    try {
        const stat = fsApi.lstatSync(directory);
        leafPresent = stat.isDirectory() && !stat.isSymbolicLink();
    } catch (_) {
        leafPresent = false;
    }
    if (!leafPresent) {
        return Object.freeze({ ok: false, problems: [`the agent cgroup ${leaf} is absent`], refusal: null, leafPresent, readFailures });
    }
    const read = (name) => {
        try {
            const value = String(fsApi.readFileSync(`${directory}/${name}`, 'utf8')).trim();
            observed[name] = value;
            return { value };
        } catch (error) {
            readFailures.push(name);
            return { value: null, code: error?.code || 'EIO' };
        }
    };
    const value = (name) => read(name).value;
    if (!leaf.startsWith(`${AGENTS_CGROUP_PARENT}/`)) problems.push(`leaf ${leaf} is not under ${AGENTS_CGROUP_PARENT}`);
    if (expected.memoryBytes) {
        const memoryMax = value('memory.max');
        if (!memoryLimitMatches(memoryMax, expected.memoryBytes)) problems.push(`memory.max is ${memoryMax}`);
        const swap = read('memory.swap.max');
        if (swap.value === null && swap.code === 'ENOENT') {
            problems.push('memory.swap.max is absent (swap accounting unavailable)');
            refusal = SWAP_ACCOUNTING_REFUSAL;
        } else if (swap.value !== '0') {
            problems.push(`memory.swap.max is ${swap.value}`);
        }
    }
    if (expected.cpus) {
        const cpuMax = value('cpu.max');
        const parts = String(cpuMax || '').split(/\s+/);
        const quota = Number(parts[0]);
        const period = Number(parts[1]);
        if (!(quota > 0 && period > 0) || Math.abs(quota / period - Number(expected.cpus)) > 1e-9) problems.push(`cpu.max is ${cpuMax}`);
    }
    if (expected.pidsLimit) {
        const pidsMax = value('pids.max');
        if (pidsMax !== String(expected.pidsLimit)) problems.push(`pids.max is ${pidsMax}`);
    }
    return Object.freeze({ ok: problems.length === 0, problems, refusal, leafPresent, readFailures, observed });
}

// Re-check that the launched process is still the one in `leaf`: returns the
// reason it vanished, or null when it is still running there.
function launchedProcessVanished({ runtime, query, containerId, pid, leaf, fsApi, procRoot }) {
    const again = query(runtime, ['container', 'inspect', '--format', '{{.State.Pid}}', containerId], { timeoutMs: 10_000 });
    if (!again?.ok) return 'the container could not be inspected after a failed leaf read';
    const pidAgain = Number(String(again?.stdout || '').trim());
    if (!Number.isSafeInteger(pidAgain) || pidAgain <= 0) return `PID ${pid} exited during the readback`;
    if (pidAgain !== pid) return `its process changed during the readback (PID ${pid}, now ${pidAgain})`;
    let leafAgain;
    try {
        leafAgain = cgroupPath(read(fsApi, `${procRoot}/${pid}/cgroup`));
    } catch (error) {
        return `PID ${pid} exited during the readback (${error?.code || 'unreadable'})`;
    }
    if (leafAgain !== leaf) return `PID ${pid} left ${leaf} during the readback`;
    return null;
}

/**
 * After create/start of a hardware-placed agent: find its actual leaf from the
 * running process's cgroup and compare the applied values. A process that is
 * not running or whose cgroup cannot be observed is an ordinary start failure
 * (no hardware refusal). Only an observed disagreement with the admitted
 * limits is a hardware refusal; the caller removes the candidate through its
 * exact ownership checks. The engine's own inspect fields are never the proof.
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
    const notObserved = (detail) => {
        const error = new Error(`the launched agent ${String(containerId).slice(0, 12)} is not running, so its limits could not be read back (${detail})`);
        error.code = 'PLOINKY_AGENT_NOT_RUNNING';
        return error;
    };
    const inspected = query(runtime, ['container', 'inspect', '--format', '{{.State.Pid}}', containerId], { timeoutMs: 10_000 });
    if (!inspected?.ok) throw notObserved('the container could not be inspected');
    const pid = Number(String(inspected?.stdout || '').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw notObserved('it has no running process');
    let leaf;
    try {
        leaf = cgroupPath(read(fsApi, `${procRoot}/${pid}/cgroup`));
    } catch (error) {
        throw notObserved(`PID ${pid} is not visible (${error?.code || 'unreadable'})`);
    }
    if (!leaf) throw notObserved(`PID ${pid} has no unified cgroup entry`);
    if (!leaf.startsWith(`${placement.cgroupParent}/`)) {
        throw refuse(`the applied limits disagree with the admitted ones (the agent runs in ${leaf}, not under ${placement.cgroupParent})`);
    }
    let coreNamespace;
    let agentNamespace;
    try {
        coreNamespace = fsApi.readlinkSync(`${procRoot}/self/ns/cgroup`);
        agentNamespace = fsApi.readlinkSync(`${procRoot}/${pid}/ns/cgroup`);
        if (!/^cgroup:\[\d+\]$/.test(coreNamespace) || !/^cgroup:\[\d+\]$/.test(agentNamespace)) {
            throw new Error('invalid cgroup namespace identity');
        }
    } catch (error) {
        const vanished = launchedProcessVanished({ runtime, query, containerId, pid, leaf, fsApi, procRoot });
        if (vanished) throw notObserved(vanished);
        throw refuse(`the agent's private cgroup namespace could not be verified (${error?.code || 'unreadable namespace identity'})`);
    }
    if (agentNamespace === coreNamespace) {
        throw refuse('the applied limits disagree with the admitted ones (the agent shares the Box core cgroup namespace instead of a private namespace)');
    }
    const readback = verifyLeafLimits({ fsApi, cgroupRoot, leaf, expected: placement.expected || {} });
    if (!readback.ok && (!readback.leafPresent || readback.readFailures.length)) {
        // A failed leaf read can mean the process exited mid-readback: that is
        // the ordinary not-running failure, never a hardware refusal.
        const vanished = launchedProcessVanished({ runtime, query, containerId, pid, leaf, fsApi, procRoot });
        if (vanished) throw notObserved(vanished);
    }
    if (!readback.ok) {
        // Missing swap accounting has its own reason and fix when it is the
        // only disagreement.
        if (readback.refusal && readback.problems.length === 1) throw refuse(readback.refusal.reason, readback.refusal);
        throw refuse(`the applied limits disagree with the admitted ones (${readback.problems.join('; ')})`);
    }
    const vanished = launchedProcessVanished({ runtime, query, containerId, pid, leaf, fsApi, procRoot });
    if (vanished) throw notObserved(vanished);
    let finalNamespace;
    try { finalNamespace = fsApi.readlinkSync(`${procRoot}/${pid}/ns/cgroup`); } catch (_) {
        const disappeared = launchedProcessVanished({ runtime, query, containerId, pid, leaf, fsApi, procRoot });
        if (disappeared) throw notObserved(disappeared);
    }
    if (finalNamespace !== agentNamespace) {
        const disappeared = launchedProcessVanished({ runtime, query, containerId, pid, leaf, fsApi, procRoot });
        if (disappeared) throw notObserved(disappeared);
        throw refuse('the agent cgroup namespace changed during limits readback');
    }
    return Object.freeze({ leaf, cgroupNamespace: agentNamespace, observed: readback.observed, verified: true });
}
