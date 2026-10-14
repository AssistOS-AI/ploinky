// Read-only observation of the apparatus host's own process and cgroup trees,
// for the GPU idle gate (plan §15.5) and the owned-daemon proofs. The runner
// executes on the host (remote-local), where a rootless Box's processes are the
// runner user's own, so /proc and the cgroup tree are readable without any
// privilege. Nothing here writes, signals or opens a device. Every read is
// bounded; a vanished process is `null`, never an error.
import fs from 'node:fs';
import { blocked } from './liveCommon.mjs';

export const PROC_ROOT = '/proc';
export const CGROUP_ROOT = '/sys/fs/cgroup';
const MAX_PROCS = 4096;
const goneCode = error => error?.code === 'ENOENT' || error?.code === 'ESRCH' || error?.code === 'ENOTDIR';

// A host process tuple: boot identity, host PID, start identity (field 22 of
// /proc/PID/stat, in clock ticks since boot), the cgroup path the kernel
// reports for it, the PID chain across namespaces (NSpid) and the host UIDs.
export function createHostProc({ fsApi = fs, procRoot = PROC_ROOT, cgroupRoot = CGROUP_ROOT } = {}) {
    const read = file => fsApi.readFileSync(file, 'utf8');
    const host = {
        bootId() {
            const id = read(`${procRoot}/sys/kernel/random/boot_id`).trim();
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Unsupported host boot identity');
            return id;
        },
        // The runner's own effective UID: the host UID of the Box user under keep-id.
        uid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
        pidNamespace(pid) {
            if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid host PID');
            let value;
            try { value = fsApi.readlinkSync(`${procRoot}/${pid}/ns/pid`); } catch (error) { if (goneCode(error)) return null; throw error; }
            if (!/^pid:\[[1-9][0-9]*\]$/.test(value)) throw new Error('Unsupported PID namespace identity');
            return value;
        },
        observe(pid) {
            if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid host PID');
            let stat; let status; let cgroup;
            try {
                stat = read(`${procRoot}/${pid}/stat`);
                status = read(`${procRoot}/${pid}/status`);
                cgroup = read(`${procRoot}/${pid}/cgroup`);
            } catch (error) { if (goneCode(error)) return null; throw error; }
            const close = stat.lastIndexOf(')');
            const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(' ');
            if (fields.length < 20 || !/^[0-9]+$/.test(fields[19]) || !/^[0-9]+$/.test(fields[1])) throw new Error('Unsupported process stat grammar');
            if (['Z', 'X', 'x'].includes(fields[0])) return null;
            const lines = cgroup.trim().split('\n');
            const unified = lines.length === 1 && lines[0].startsWith('0::') ? lines[0].slice(3) : null;
            const nspid = /^NSpid:\s+([0-9]+(?:\s+[0-9]+)*)\s*$/m.exec(status);
            const uid = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/m.exec(status);
            if (!nspid || !uid) throw new Error('Unsupported process status grammar');
            return {
                bootId: host.bootId(), hostPid: pid, startIdentity: fields[19], ppid: Number(fields[1]), cgroup: unified,
                nspid: nspid[1].split(/\s+/).map(Number),
                uid: { real: Number(uid[1]), effective: Number(uid[2]), saved: Number(uid[3]), fs: Number(uid[4]) },
            };
        },
        // The host PIDs listed by one cgroup directory (null when it is absent).
        cgroupProcs(cgroupPath) {
            let text;
            try { text = read(`${cgroupRoot}${cgroupPath}/cgroup.procs`); } catch (error) { if (goneCode(error)) return null; throw error; }
            const pids = text.split('\n').filter(Boolean);
            if (pids.length > MAX_PROCS || pids.some(value => !/^[1-9][0-9]{0,9}$/.test(value))) throw new Error('Unsupported cgroup.procs grammar');
            return pids.map(Number);
        },
        cgroupDirectories(cgroupPath) {
            let names;
            try { names = fsApi.readdirSync(`${cgroupRoot}${cgroupPath}`); } catch (error) { if (goneCode(error)) return null; throw error; }
            if (names.length > MAX_PROCS) throw new Error('Cgroup directory observation exceeded its bound');
            return names;
        },
    };
    return host;
}

// Budget-off agents can share the Box cgroup. Discovery proves only ancestry;
// callers must independently establish the exact agent namespace and identity.
export function processesWithin(host, prefix) {
    const observed = []; const seen = new Set();
    let directories = 0; let observations = 0;
    function visit(directory, depth, pids) {
        if (++directories > 128 || depth > 8) throw new Error('Ordinary GPU ancestry observation exceeded its bound');
        if (!Array.isArray(pids)) throw new Error('Ordinary GPU cgroup processes unavailable');
        observations += pids.length;
        if (observations > MAX_PROCS) throw new Error('Ordinary GPU process observation exceeded its bound');
        for (const pid of pids) {
            if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid host PID');
            if (seen.has(pid)) continue;
            seen.add(pid);
            const value = host.observe(pid);
            if (value && cgroupWithin(value.cgroup, prefix)) observed.push(value);
        }
        const names = host.cgroupDirectories(directory);
        if (!Array.isArray(names) || names.length > MAX_PROCS) throw new Error('Ordinary GPU cgroup directories unavailable or exceeded bound');
        for (const name of new Set(names)) {
            if (!/^[A-Za-z0-9_:@-][A-Za-z0-9_.:@-]*$/.test(name)) throw new Error('Invalid observed cgroup directory');
            const child = `${directory}/${name}`; const childPids = host.cgroupProcs(child);
            if (childPids !== null) visit(child, depth + 1, childPids);
        }
    }
    visit(prefix, 0, host.cgroupProcs(prefix));
    return observed;
}

// The exact cgroup prefix of one Box, from its init process: the host path
// under which the Box's own namespace root sits. The Box's init runs in
// /ploinky/core, so the prefix is its host cgroup minus that suffix, and it
// must name this exact Box (the engine's libpod-<ID> scope, with the engine's
// own `container` leaf when it adds one). Anything else cannot prove ancestry.
export function boxCgroupPrefix(host, { boxPid, boxId }) {
    if (!/^[a-f0-9]{64}$/.test(String(boxId)) || !Number.isSafeInteger(boxPid) || boxPid <= 0) throw blocked('The Box has no host init PID, so its cgroup ancestry cannot be proved');
    const observed = host.observe(boxPid);
    const match = observed?.cgroup ? /^(\/.+)\/ploinky\/core$/.exec(observed.cgroup) : null;
    if (!match) throw blocked('The Box init process is not in /ploinky/core as the host sees it, so its cgroup ancestry cannot be proved');
    const parts = match[1].split('/');
    const scope = new RegExp(`^libpod-${boxId}(?:\\.scope)?$`);
    const last = parts.at(-1); const before = parts.at(-2);
    if (!(scope.test(last) || (last === 'container' && scope.test(before)))) throw blocked('The Box init cgroup does not carry this exact Box identity, so its cgroup ancestry cannot be proved');
    return match[1];
}

// True when `cgroup` is the directory `ancestor` or beneath it.
export const cgroupWithin = (cgroup, ancestor) => typeof cgroup === 'string' && typeof ancestor === 'string'
    && (cgroup === ancestor || cgroup.startsWith(`${ancestor}/`));

// An owned agent container's leaf under the Box: the nested engine's cgroupfs
// layout names it libpod-<ID> (with the .scope suffix under a systemd manager).
// The leaf is returned only when it exists and lists processes readably.
export function agentLeaf(host, prefix, containerId) {
    if (!/^[a-f0-9]{64}$/.test(String(containerId))) throw new Error('Invalid agent container identity');
    for (const name of [`libpod-${containerId}`, `libpod-${containerId}.scope`]) {
        const leaf = `${prefix}/ploinky/agents/${name}`;
        if (host.cgroupProcs(leaf) !== null) return leaf;
    }
    return null;
}
