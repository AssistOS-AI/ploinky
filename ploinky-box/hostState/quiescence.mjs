import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { PloinkyBoxError } from '../errors.mjs';
import { createLockLiveness } from '../lockLiveness.mjs';
import { containsPath, realpathOfNearestExisting } from './paths.mjs';

// Quiescence gate (plan D3, r2.3 and r2.4). A transaction that adopts a
// workspace, creates or recreates its Box, or creates a Box data path first
// proves that nothing other than this command can write the workspace: no
// host-runtime agent of it (masked or not) and no running container with a
// read-write bind of it, of an ancestor or of a descendant. It runs under the
// workspace lock (D4), which host-runtime launches also take, so no host agent
// can start between this scan and the writes that follow it.
//
// The evidence is something a Box process cannot edit:
// - Linux: the mount table (/proc/<pid>/mountinfo) of every process of the
//   invoking user outside this command's own mount namespace. A process whose
//   mount table cannot be read blocks (fail closed).
// - macOS: seatbelt agents share the host mount namespace, so the evidence is
//   the workspace's launch records plus a `ps` scan for command lines that
//   name the workspace. A record erased by a legacy Box hides a still-running
//   agent of older code from this scan; that residual is unsupported (D-K).
// - Both: the engine view, for containers (other subuids included).
// A reported process is cleared by stopping it or with
// `--allow-host-process PID`, which holds only for that exact process: its
// start time is read at the scan and verified again before the gate passes.

const DARWIN_PS_ENV = Object.freeze({ LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
const COMMAND_PREVIEW = 160;

function activeError(message, blockers) {
    return Object.assign(new PloinkyBoxError(message, { code: 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE' }), {
        blockers: Object.freeze(blockers.map((blocker) => Object.freeze({ ...blocker }))),
    });
}

/** `/proc/<pid>/mountinfo` octal escapes (space, tab, newline, backslash). */
function unescapeMountField(value) {
    return String(value).replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export function parseMountinfo(text) {
    const mounts = [];
    for (const line of String(text || '').split('\n')) {
        if (!line.trim()) continue;
        const fields = line.split(' ');
        const separator = fields.indexOf('-');
        if (fields.length < 7 || separator < 6) throw new Error(`malformed mountinfo line: ${line.slice(0, 120)}`);
        mounts.push(Object.freeze({
            id: fields[0],
            device: fields[2],
            root: unescapeMountField(fields[3]),
            mountPoint: unescapeMountField(fields[4]),
            options: fields[5].split(','),
            line,
        }));
    }
    return mounts;
}

// Mount IDs are global: a process in the same mount namespace lists the same
// mount at `/`, while a copied namespace has new IDs. Keyed this way the scan
// does not need /proc/<pid>/ns/mnt, which non-dumpable processes hide.
function namespaceKey(mounts) {
    const roots = mounts.filter((mount) => mount.mountPoint === '/').map((mount) => mount.id);
    return roots.length ? roots.join(',') : null;
}

/**
 * Where the workspace lives in this command's own mount table: the device of
 * the mount that holds it and its path relative to that filesystem's root.
 */
export function workspaceMountLocation(workspaceReal, ownMounts) {
    let best = null;
    for (const mount of ownMounts) {
        if (!containsPath(mount.mountPoint, workspaceReal)) continue;
        if (!best || mount.mountPoint.length >= best.mountPoint.length) best = mount;
    }
    if (!best) return null;
    return Object.freeze({
        device: best.device,
        path: path.posix.join(best.root, path.posix.relative(best.mountPoint, workspaceReal)),
    });
}

/** A read-write mount that exposes the workspace, an ancestor or a descendant of it. */
export function exposingMount(mounts, location) {
    return mounts.find((mount) => mount.device === location.device
        && mount.options.includes('rw')
        && (containsPath(mount.root, location.path) || containsPath(location.path, mount.root))) || null;
}

// A zombie (Z) or dead (X) task has exited: it runs no code.
function taskExited(statusText) {
    const line = String(statusText || '').split('\n').find((entry) => entry.startsWith('State:'));
    return Boolean(line) && /^[ZX]\b/.test(line.slice(6).trim());
}

const GONE = new Set(['ENOENT', 'ESRCH']);

/**
 * Whether a process has exited, and where to read the mount table of a part
 * of it that still runs. A zombie thread-group leader can outlive its other
 * threads' code: those threads keep running with the same mount table, which
 * the leader's own `/proc/<pid>/mountinfo` no longer shows (EINVAL). So the
 * process counts as exited only when every task under `/proc/<pid>/task` is
 * Z or X; otherwise the mount table of a live task is read. A task list or a
 * task status that cannot be read is never taken as exited (fail closed).
 */
function processActivity(pid, statusText, fsApi) {
    const leader = `/proc/${pid}/mountinfo`;
    if (!taskExited(statusText)) return { exited: false, mountinfo: leader };
    let tasks;
    try {
        tasks = fsApi.readdirSync(`/proc/${pid}/task`).filter((entry) => /^[1-9][0-9]*$/.test(entry));
    } catch (error) {
        if (GONE.has(error?.code)) return { exited: true };
        return { exited: false, mountinfo: leader };
    }
    for (const task of tasks) {
        let status;
        try {
            status = fsApi.readFileSync(`/proc/${pid}/task/${task}/status`, 'utf8');
        } catch (error) {
            if (GONE.has(error?.code)) continue;
            return { exited: false, mountinfo: leader };
        }
        if (!taskExited(status)) return { exited: false, mountinfo: `/proc/${pid}/task/${task}/mountinfo` };
    }
    return { exited: true };
}

function processUids(statusText) {
    const line = String(statusText || '').split('\n').find((entry) => entry.startsWith('Uid:'));
    return line ? line.slice(4).trim().split(/\s+/).map(Number) : [];
}

// Rootless Podman keeps its own processes (the catatonit pause process,
// conmon, and the network helpers) in one user and mount namespace that copies
// the host mounts, so `/` is read-write there: under the rule above every
// workspace would be blocked on any host that runs rootless Podman. Exactly
// that namespace is exempt, and in it only Podman's own executables. The
// namespace is found from the pause process Podman records in the user's
// runtime directory (never in a workspace), which must be a private file of
// this user naming this user's catatonit or podman process. When any of that
// cannot be proven, nothing is exempt (fail closed). Container processes,
// the Box included, live in their own mount namespaces and are judged as
// before.
export const PODMAN_INFRA_EXECUTABLES = Object.freeze([
    'catatonit', 'conmon', 'podman', 'pasta', 'pasta.avx2', 'slirp4netns', 'rootlessport',
]);
const PODMAN_PAUSE_EXECUTABLES = Object.freeze(['catatonit', 'podman']);

// The kernel appends ` (deleted)` to the link of an executable whose file was
// replaced after the process started, as a package upgrade of Podman does to
// its running helpers. The name is still the one that was executed. The name
// alone never exempts anything: the namespace must match as well.
function executableName(pid, fsApi) {
    try {
        return path.posix.basename(fsApi.readlinkSync(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, '');
    } catch (_) {
        return null;
    }
}

function mountNamespace(pid, fsApi) {
    try {
        const value = fsApi.readlinkSync(`/proc/${pid}/ns/mnt`);
        return /^mnt:\[[0-9]+\]$/.test(value) ? value : null;
    } catch (_) {
        return null;
    }
}

/**
 * The mount namespace of rootless Podman's pause process, or null when it
 * cannot be proven. Returns `{ namespace, pid, source }` on success.
 */
export function podmanInfraNamespace({ fsApi = fs, env = process.env, uid } = {}) {
    if (uid === null || uid === undefined) return null;
    const runtimeDirectory = String(env?.XDG_RUNTIME_DIR || '').trim() || `/run/user/${uid}`;
    if (!path.isAbsolute(runtimeDirectory)) return null;
    const source = path.join(runtimeDirectory, 'libpod', 'tmp', 'pause.pid');
    try {
        const stat = fsApi.lstatSync(source);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid || (stat.mode & 0o022) !== 0) return null;
        const text = String(fsApi.readFileSync(source, 'utf8')).trim();
        if (!/^[1-9][0-9]{0,9}$/.test(text)) return null;
        const pid = Number(text);
        const status = fsApi.readFileSync(`/proc/${pid}/status`, 'utf8');
        if (!processUids(status).includes(uid)) return null;
        if (!PODMAN_PAUSE_EXECUTABLES.includes(executableName(pid, fsApi))) return null;
        const namespace = mountNamespace(pid, fsApi);
        if (!namespace || namespace === mountNamespace('self', fsApi)) return null;
        return Object.freeze({ namespace, pid, source });
    } catch (_) {
        return null;
    }
}

function isPodmanInfra(pid, infra, fsApi) {
    return Boolean(infra)
        && mountNamespace(pid, fsApi) === infra.namespace
        && PODMAN_INFRA_EXECUTABLES.includes(executableName(pid, fsApi));
}

// The cgroup v2 subtree of a running container (its scope), from its init
// process. Processes of the container and of everything nested in it live
// below that scope.
function containerScope(pid, fsApi) {
    try {
        const line = String(fsApi.readFileSync(`/proc/${pid}/cgroup`, 'utf8')).split('\n').find((entry) => entry.startsWith('0::'));
        const cgroup = line ? line.slice(3).trim() : '';
        if (!cgroup.startsWith('/') || cgroup === '/') return null;
        return path.posix.basename(cgroup) === 'container' ? path.posix.dirname(cgroup) : cgroup;
    } catch (_) {
        return null;
    }
}

function insideScopes(pid, scopes, fsApi) {
    if (!scopes.length) return false;
    const scope = containerScope(pid, fsApi);
    return Boolean(scope) && scopes.some((entry) => scope === entry || scope.startsWith(`${entry}/`));
}

function linuxBlockers({ workspaceReal, uid, selfPid, fsApi, infra = null, exempted = [], excludedScopes = [] }) {
    const ownMounts = parseMountinfo(fsApi.readFileSync('/proc/self/mountinfo', 'utf8'));
    const ownKey = namespaceKey(ownMounts);
    const location = workspaceMountLocation(workspaceReal, ownMounts);
    if (!ownKey || !location) {
        return [{ kind: 'scan', pid: null, reason: `the mount of ${workspaceReal} cannot be found in this command's mount table` }];
    }
    const blockers = [];
    for (const entry of fsApi.readdirSync('/proc')) {
        if (!/^[1-9][0-9]*$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid === selfPid) continue;
        let status;
        try {
            status = fsApi.readFileSync(`/proc/${pid}/status`, 'utf8');
        } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ESRCH') continue;
            blockers.push({ kind: 'process', pid, reason: `its status cannot be read (${error?.code || 'error'})` });
            continue;
        }
        if (uid !== null && !processUids(status).includes(uid)) continue;
        const activity = processActivity(pid, status, fsApi);
        if (activity.exited) continue;
        if (insideScopes(pid, excludedScopes, fsApi)) continue;
        let mounts;
        try {
            mounts = parseMountinfo(fsApi.readFileSync(activity.mountinfo, 'utf8'));
        } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ESRCH') continue;
            blockers.push({ kind: 'process', pid, reason: `its mount table cannot be read (${error?.code || error?.message})` });
            continue;
        }
        if (!mounts.length) continue;
        if (namespaceKey(mounts) === ownKey) continue;
        const mount = exposingMount(mounts, location);
        if (!mount) continue;
        if (isPodmanInfra(pid, infra, fsApi)) {
            exempted.push(Object.freeze({ pid, executable: executableName(pid, fsApi), namespace: infra.namespace }));
            continue;
        }
        blockers.push({ kind: 'process', pid, reason: 'it has the workspace mounted read-write', mount: mount.line });
    }
    return blockers;
}

function linuxCommand(pid, fsApi) {
    try {
        return fsApi.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    } catch (_) {
        return '';
    }
}

function darwinProcesses(execFile) {
    const output = execFile('/bin/ps', ['-axww', '-o', 'pid=,ppid=,uid=,command='], {
        encoding: 'utf8', env: DARWIN_PS_ENV, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
    });
    return String(output).split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line))
        .filter(Boolean)
        .map(([, pid, ppid, uid, command]) => ({ pid: Number(pid), ppid: Number(ppid), uid: Number(uid), command }));
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A command line names the workspace when it contains its path as a whole
// path: followed by the end, a separator, whitespace or a quote.
function namesWorkspace(command, spellings) {
    return spellings.some((spelling) => new RegExp(`${escapeRegExp(spelling)}(?=$|[/\\s'"=:;,)])`).test(command));
}

function readLaunchRecords(workspaceRoot, fsApi) {
    const directory = path.join(workspaceRoot, '.ploinky', 'bwrap-pids');
    let names;
    try {
        names = fsApi.readdirSync(directory);
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        return [{ file: directory, error: error?.code || 'unreadable' }];
    }
    return names.filter((name) => name.endsWith('.pid')).map((name) => {
        const file = path.join(directory, name);
        try {
            const record = JSON.parse(fsApi.readFileSync(file, 'utf8'));
            if (!Number.isSafeInteger(record?.pid) || record.pid <= 0) return { file, error: 'invalid' };
            // Schema 3 records a launch with the host state mask; an older
            // record names an agent of older code that runs without it.
            const masked = record.schemaVersion === 3 && record.hostStateMasked === true;
            return { file, pid: record.pid, runtimeKey: String(record.runtimeKey || name), masked, schemaVersion: record.schemaVersion };
        } catch (error) {
            return { file, error: error instanceof SyntaxError ? 'unparseable' : (error?.code || 'unreadable') };
        }
    });
}

function darwinBlockers({ identity, workspaceReal, uid, selfPid, fsApi, execFile, kill }) {
    const blockers = [];
    for (const record of readLaunchRecords(identity.workspaceRoot, fsApi)) {
        if (record.error) {
            blockers.push({ kind: 'record', pid: null, reason: `the launch record ${record.file} is ${record.error}; inspect and remove it` });
            continue;
        }
        try {
            kill(record.pid, 0);
        } catch (error) {
            if (error?.code === 'ESRCH') continue;
        }
        if (record.masked) {
            blockers.push({ kind: 'process', pid: record.pid, reason: `its launch record ${record.file} names a running process` });
            continue;
        }
        // An agent that runs without the mask can write `.ploinky-box`; it is
        // never excused, only stopped.
        blockers.push({
            kind: 'process', pid: record.pid, excusable: false,
            reason: `its launch record ${record.file} (schema ${record.schemaVersion ?? 'unknown'}) names a running agent that an `
                + 'older Ploinky started without the host state mask; stop that agent (it cannot be excused)',
        });
    }
    const processes = darwinProcesses(execFile);
    const ancestors = new Set([selfPid]);
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    for (let current = byPid.get(selfPid); current && !ancestors.has(current.ppid); current = byPid.get(current.ppid)) {
        ancestors.add(current.ppid);
    }
    const spellings = [...new Set([identity.workspaceRoot, workspaceReal])];
    for (const entry of processes) {
        if (ancestors.has(entry.pid) || (uid !== null && entry.uid !== uid)) continue;
        if (namesWorkspace(entry.command, spellings)) {
            blockers.push({ kind: 'process', pid: entry.pid, reason: 'its command line names the workspace', command: entry.command });
        }
    }
    return blockers;
}

/** Running containers with a read-write bind of the workspace, an ancestor or a descendant. */
export function containerBlockers(workspaceReal, view, { fsApi = fs, excludeContainerIds = [] } = {}) {
    const blockers = [];
    for (const container of view || []) {
        if (!container.running || excludeContainerIds.includes(container.id)) continue;
        for (const mount of container.mounts || []) {
            if (!mount.rw || !path.isAbsolute(mount.source || '')) continue;
            let real;
            try {
                real = realpathOfNearestExisting(mount.source, fsApi);
            } catch (_) {
                real = path.resolve(mount.source);
            }
            if (containsPath(real, workspaceReal) || containsPath(workspaceReal, real)) {
                blockers.push({
                    kind: 'container', pid: null, id: container.id, name: container.name,
                    reason: `it binds ${mount.source} read-write at ${mount.destination}`,
                });
                break;
            }
        }
    }
    return blockers;
}

function describe(blocker) {
    if (blocker.kind === 'container') return `container ${blocker.name || blocker.id.slice(0, 12)}: ${blocker.reason}`;
    if (blocker.pid === null) return blocker.reason;
    const command = blocker.command ? ` (${blocker.command.slice(0, COMMAND_PREVIEW)})` : '';
    const mount = blocker.mount ? `; mount: ${blocker.mount.slice(0, 200)}` : '';
    return `process ${blocker.pid}${command}: ${blocker.reason}${mount}`;
}

/**
 * Builds the gate. `assert(identity, { view })` returns quietly or throws
 * PLOINKY_BOX_HOST_RUNTIME_ACTIVE listing every blocker.
 */
export function createQuiescenceGate({
    platform = process.platform,
    fsApi = fs,
    execFile = execFileSync,
    kill = (pid, signal) => process.kill(pid, signal),
    uid = typeof process.getuid === 'function' ? process.getuid() : null,
    selfPid = process.pid,
    liveness = createLockLiveness({ platform }),
    allowHostProcesses = [],
    env = process.env,
    // Exempt rootless Podman's own infrastructure namespace (Linux only).
    exemptPodmanInfra = true,
} = {}) {
    const allowed = new Set(allowHostProcesses.map(Number));
    let lastExempted = Object.freeze([]);

    function hostBlockers(identity, workspaceReal, excludedScopes) {
        if (platform === 'linux') {
            const infra = exemptPodmanInfra ? podmanInfraNamespace({ fsApi, env, uid }) : null;
            const exempted = [];
            const found = linuxBlockers({ workspaceReal, uid, selfPid, fsApi, infra, exempted, excludedScopes });
            lastExempted = Object.freeze(exempted);
            return found;
        }
        if (platform === 'darwin') return darwinBlockers({ identity, workspaceReal, uid, selfPid, fsApi, execFile, kill });
        return [{ kind: 'scan', pid: null, reason: `host processes cannot be inspected on ${platform}` }];
    }

    // `excludeContainerIds` serves the advisory scan a replacement runs before
    // it stops the old Box: that Box and the processes in its cgroup scope
    // are not counted. When a scope cannot be read on Linux, the host half is
    // skipped rather than guessed. The full scan after the stop decides.
    function assert(identity, { view = [], excludeContainerIds = [] } = {}) {
        const workspaceReal = realpathOfNearestExisting(identity.workspaceRoot, fsApi);
        let excludedScopes = [];
        let hostScan = true;
        if (excludeContainerIds.length && platform === 'linux') {
            const excluded = (view || []).filter((container) => excludeContainerIds.includes(container.id) && container.running);
            excludedScopes = excluded.map((container) => (container.pid ? containerScope(container.pid, fsApi) : null));
            hostScan = excludedScopes.every(Boolean);
        }
        const found = [
            ...containerBlockers(workspaceReal, view, { fsApi, excludeContainerIds }),
            ...(hostScan ? hostBlockers(identity, workspaceReal, excludedScopes) : []),
        ];
        const blocking = [];
        const excused = [];
        for (const blocker of found) {
            if (blocker.kind === 'process' && blocker.excusable !== false && allowed.has(blocker.pid)) {
                const start = liveness.processStart(blocker.pid);
                if (start) {
                    excused.push({ ...blocker, start });
                    continue;
                }
            }
            blocking.push(blocker);
        }
        // An allowance holds only for the exact process seen by this scan.
        for (const entry of excused) {
            if (liveness.processStart(entry.pid) !== entry.start) {
                blocking.push({ ...entry, reason: `${entry.reason}; its PID now belongs to another process` });
            }
        }
        if (!blocking.length) {
            return Object.freeze({ excused: Object.freeze(excused.map((entry) => entry.pid)), podmanInfra: lastExempted });
        }
        for (const blocker of blocking) {
            if (blocker.kind === 'process' && !blocker.command && platform === 'linux') blocker.command = linuxCommand(blocker.pid, fsApi);
        }
        const pids = blocking.filter((blocker) => blocker.kind === 'process' && blocker.excusable !== false)
            .map((blocker) => blocker.pid);
        throw activeError(
            `Something other than this command can write the workspace ${identity.workspaceRoot}, so the Box cannot be `
            + `created, recreated or adopted now:\n${blocking.map((blocker) => `  - ${describe(blocker)}`).join('\n')}\n`
            + 'Stop those agents and containers (for a Box of this workspace, `ploinky stop`), then run the command again.'
            + (pids.length ? ` A process that does not write the workspace can be excused with \`--allow-host-process ${pids[0]}\`.` : ''),
            blocking,
        );
    }

    return Object.freeze({ assert });
}
