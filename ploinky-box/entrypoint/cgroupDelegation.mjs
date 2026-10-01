// Fixed Box-namespace-root cgroup preparation (plan §7.2-§7.3, U5).
//
// Run only as `node cgroupDelegation.mjs prepare` by the host, as the Box's
// user-namespace root, with workdir / and NODE_OPTIONS/NODE_PATH cleared. It
// imports only node: built-ins, starts no subprocess, reads no workspace input
// and touches only fixed cgroup paths. It moves Box-root tasks into
// /ploinky/core, enables the available cpu/memory/pids controllers at the root
// and /ploinky, and delegates only /ploinky to Box uid 1000. A retry completes
// partial setup and never moves or limits existing agent leaves.

import fs from 'node:fs';
import process from 'node:process';

export const CGROUP_ROOT = '/sys/fs/cgroup';
export const WANTED_CONTROLLERS = Object.freeze(['cpu', 'memory', 'pids']);
export const DELEGATED_UID = 1000;
export const DELEGATED_GID = 1000;
export const MOVE_PASSES = 50;
export const MOVE_INTERVAL_MS = 20;
const MAX_READ_BYTES = 256 * 1024;
const EXIT = Object.freeze({ ok: 0, notCgroup2: 2, readOnly: 3, rootBusy: 4, noNsdelegate: 5, failure: 6, notRoot: 10 });

class PreparationFailure extends Error {
    constructor(exitCode, reason) {
        super(reason);
        this.exitCode = exitCode;
    }
}

function boundedRead(fsApi, target) {
    const text = String(fsApi.readFileSync(target, 'utf8'));
    if (text.length > MAX_READ_BYTES) throw new PreparationFailure(EXIT.failure, `${target} exceeds its read bound`);
    return text;
}

function words(text) {
    return String(text || '').split(/\s+/).filter(Boolean);
}

// Find the mount whose mount point is exactly the cgroup root.
export function parseCgroupMount(mountinfo, cgroupRoot = CGROUP_ROOT) {
    for (const line of String(mountinfo || '').split('\n')) {
        if (!line.trim()) continue;
        const separator = line.indexOf(' - ');
        if (separator < 0) continue;
        const pre = line.slice(0, separator).split(' ');
        const post = line.slice(separator + 3).split(' ');
        if (pre[4] !== cgroupRoot) continue;
        return {
            fstype: post[0],
            mountOptions: (pre[5] || '').split(','),
            superOptions: (post[2] || '').split(','),
        };
    }
    return null;
}

export function cgroupPathOf(procCgroup) {
    const line = String(procCgroup || '').split('\n').find((entry) => entry.startsWith('0::'));
    return line ? line.slice(3).trim() : null;
}

function procsOf(fsApi, directory) {
    return words(boundedRead(fsApi, `${directory}/cgroup.procs`));
}

function enabledControllers(fsApi, directory) {
    return new Set(words(boundedRead(fsApi, `${directory}/cgroup.subtree_control`)));
}

function availableControllers(fsApi, directory) {
    return new Set(words(boundedRead(fsApi, `${directory}/cgroup.controllers`)));
}

function realDirectory(fsApi, target) {
    try {
        const stat = fsApi.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new PreparationFailure(EXIT.failure, `${target} is not a real cgroup directory`);
        }
        return stat;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function ownerOf(fsApi, target) {
    return fsApi.lstatSync(target).uid;
}

function settledControllers(fsApi, root, ploinky, wanted) {
    const rootEnabled = enabledControllers(fsApi, root);
    const ploinkyEnabled = enabledControllers(fsApi, ploinky);
    const ploinkyAvailable = availableControllers(fsApi, ploinky);
    for (const controller of wanted) {
        if (!rootEnabled.has(controller)) return false;
        if (ploinkyAvailable.has(controller) && !ploinkyEnabled.has(controller)) return false;
    }
    return true;
}

function delegatedOwnershipExact(fsApi, ploinky) {
    return [ploinky, `${ploinky}/cgroup.procs`, `${ploinky}/cgroup.subtree_control`, `${ploinky}/cgroup.threads`]
        .every((target) => ownerOf(fsApi, target) === DELEGATED_UID);
}

function exactPreparedLayout(fsApi, { root, ploinky, core, pid1Path, selfPath }) {
    if (!realDirectory(fsApi, ploinky) || !realDirectory(fsApi, core)) return false;
    if (pid1Path !== '/ploinky/core' || selfPath !== '/ploinky/core') return false;
    if (procsOf(fsApi, root).length || procsOf(fsApi, ploinky).length) return false;
    if (!delegatedOwnershipExact(fsApi, ploinky)) return false;
    return ownerOf(fsApi, `${root}/cgroup.procs`) === 0 && ownerOf(fsApi, `${core}/cgroup.procs`) === 0;
}

function writeController(fsApi, directory, controller) {
    try {
        fsApi.writeFileSync(`${directory}/cgroup.subtree_control`, `+${controller}`);
    } catch (error) {
        return `write failed (${error?.code || 'error'})`;
    }
    return enabledControllers(fsApi, directory).has(controller) ? null : 'not enabled after write';
}

/**
 * The preparation itself, parameterized over fs and process facts for tests.
 * Returns {exitCode, result}; result is the bounded JSON document.
 */
export async function prepareCgroupDelegation({
    argv = process.argv.slice(2),
    getuid = () => process.getuid(),
    fsApi = fs,
    cgroupRoot = CGROUP_ROOT,
    procRoot = '/proc',
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
    const observed = { controllers: [], missing: [], movedPids: 0, nsdelegate: false };
    const failure = (exitCode, reason) => ({
        exitCode,
        result: {
            schema: 1, structurallyPrepared: false, already: false, controllers: observed.controllers,
            missing: observed.missing, movedPids: observed.movedPids, nsdelegate: observed.nsdelegate,
            reason: String(reason).slice(0, 512),
        },
    });
    try {
        if (argv.length !== 1 || argv[0] !== 'prepare') throw new PreparationFailure(EXIT.failure, 'the only accepted invocation is `prepare`');
        if (getuid() !== 0) throw new PreparationFailure(EXIT.notRoot, 'preparation must run as the Box namespace root');
        const mount = parseCgroupMount(boundedRead(fsApi, `${procRoot}/self/mountinfo`), cgroupRoot);
        if (!mount || mount.fstype !== 'cgroup2') throw new PreparationFailure(EXIT.notCgroup2, `${cgroupRoot} is not a cgroup2 mount`);
        if (!mount.mountOptions.includes('rw') || mount.superOptions.includes('ro') || !mount.superOptions.includes('rw')) {
            throw new PreparationFailure(EXIT.readOnly, `${cgroupRoot} is not writable`);
        }
        observed.nsdelegate = mount.superOptions.includes('nsdelegate');
        if (!observed.nsdelegate) throw new PreparationFailure(EXIT.noNsdelegate, `${cgroupRoot} is not mounted with nsdelegate`);
        const root = cgroupRoot;
        const ploinky = `${root}/ploinky`;
        const core = `${ploinky}/core`;
        const available = availableControllers(fsApi, root);
        const wanted = WANTED_CONTROLLERS.filter((controller) => available.has(controller));
        const pathsFor = () => ({
            root, ploinky, core,
            pid1Path: cgroupPathOf(boundedRead(fsApi, `${procRoot}/1/cgroup`)),
            selfPath: cgroupPathOf(boundedRead(fsApi, `${procRoot}/self/cgroup`)),
        });
        if (exactPreparedLayout(fsApi, pathsFor()) && settledControllers(fsApi, root, ploinky, wanted)) {
            const enabled = enabledControllers(fsApi, ploinky);
            observed.controllers = wanted.filter((controller) => enabled.has(controller));
            observed.missing = WANTED_CONTROLLERS.filter((controller) => !observed.controllers.includes(controller))
                .map((controller) => ({ controller, reason: available.has(controller) ? 'not delegated to /ploinky' : 'not delegated' }));
            return { exitCode: EXIT.ok, result: { schema: 1, structurallyPrepared: true, already: true, ...observed, reason: null } };
        }
        for (const directory of [ploinky, core]) {
            const stat = realDirectory(fsApi, directory);
            if (!stat) {
                fsApi.mkdirSync(directory);
            } else if (![0, DELEGATED_UID].includes(stat.uid)) {
                throw new PreparationFailure(EXIT.failure, `${directory} has an unexpected owner`);
            }
        }
        for (let pass = 1; pass <= MOVE_PASSES; pass += 1) {
            const pids = procsOf(fsApi, root);
            if (!pids.length) break;
            for (const pid of pids) {
                try {
                    fsApi.writeFileSync(`${core}/cgroup.procs`, pid);
                    observed.movedPids += 1;
                } catch (error) {
                    if (error?.code !== 'ESRCH') throw error;
                }
            }
            if (!procsOf(fsApi, root).length) break;
            await sleep(MOVE_INTERVAL_MS);
        }
        if (procsOf(fsApi, root).length) throw new PreparationFailure(EXIT.rootBusy, 'tasks remain in the namespace root cgroup');
        // Existing agent leaves are never migrated; /ploinky stays empty.
        if (procsOf(fsApi, ploinky).length) throw new PreparationFailure(EXIT.failure, '/ploinky has direct processes');
        const delegated = [];
        for (const controller of wanted) {
            const rootProblem = writeController(fsApi, root, controller);
            if (rootProblem) {
                observed.missing.push({ controller, reason: `root ${rootProblem}` });
                continue;
            }
            if (!availableControllers(fsApi, ploinky).has(controller)) {
                observed.missing.push({ controller, reason: 'not available in /ploinky' });
                continue;
            }
            const ploinkyProblem = writeController(fsApi, ploinky, controller);
            if (ploinkyProblem) {
                observed.missing.push({ controller, reason: `/ploinky ${ploinkyProblem}` });
                continue;
            }
            delegated.push(controller);
        }
        for (const controller of WANTED_CONTROLLERS) {
            if (!available.has(controller)) observed.missing.push({ controller, reason: 'not delegated' });
        }
        observed.controllers = delegated;
        // Delegate only /ploinky and its delegation files to Box uid 1000.
        for (const target of [ploinky, `${ploinky}/cgroup.procs`, `${ploinky}/cgroup.subtree_control`, `${ploinky}/cgroup.threads`]) {
            fsApi.chownSync(target, DELEGATED_UID, DELEGATED_GID);
        }
        if (ownerOf(fsApi, `${root}/cgroup.procs`) !== 0 || ownerOf(fsApi, `${core}/cgroup.procs`) !== 0) {
            throw new PreparationFailure(EXIT.failure, 'root or core process files are not root-owned');
        }
        const final = pathsFor();
        if (final.pid1Path !== '/ploinky/core' || final.selfPath !== '/ploinky/core') {
            throw new PreparationFailure(EXIT.failure, 'PID 1 or this process is not in /ploinky/core');
        }
        if (procsOf(fsApi, root).length || procsOf(fsApi, ploinky).length) {
            throw new PreparationFailure(EXIT.failure, 'the root or /ploinky cgroup gained direct processes');
        }
        observed.missing.sort((left, right) => left.controller.localeCompare(right.controller));
        return { exitCode: EXIT.ok, result: { schema: 1, structurallyPrepared: true, already: false, ...observed, reason: null } };
    } catch (error) {
        if (error instanceof PreparationFailure) return failure(error.exitCode, error.message);
        return failure(EXIT.failure, `unexpected structure or I/O error: ${error?.code || error?.message || error}`);
    }
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
    const { exitCode, result } = await prepareCgroupDelegation();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = exitCode;
}
