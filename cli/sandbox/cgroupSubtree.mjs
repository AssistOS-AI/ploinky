import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readStructuralDelegation, verifyNestedBackend } from './hardwareLimits/delegation.mjs';
import { PLOINKY_WORKSPACE_ROOT } from '../utils/config.js';
import { cgroupMounts } from './docker/cgroupSubtreePrepare.mjs';

export const CGROUP_SUBTREE_MOUNT = '/run/ploinky/cgroup';
export const CGROUP_SUBTREE_PATH = `${CGROUP_SUBTREE_MOUNT}/workloads`;
export const CGROUP_HELPER_DIRECTORY = '/run/ploinky-cgroup';
export const CGROUP_ENTRYPOINT = `${CGROUP_HELPER_DIRECTORY}/cgroupSubtreeEntrypoint.sh`;
export const CGROUP_HELPER_SOURCE = path.resolve(fileURLToPath(new URL('./docker/', import.meta.url)));
export const CGROUP_PARENT = '/ploinky/agents';
const CONTROLLERS = ['cpu', 'memory', 'pids'];
const MAX_BYTES = 256 * 1024;
const ID = /^[a-f0-9]{64}$/;

export function cgroupUnavailable(detail = '') {
    return Object.assign(new Error('cgroup delegation not prepared yet; run ploinky restart'
        + (detail ? ` (${detail})` : '')), { code: 'PLOINKY_CGROUP_DELEGATION_UNAVAILABLE' });
}

function read(fsApi, target) {
    const result = String(fsApi.readFileSync(target, 'utf8'));
    if (Buffer.byteLength(result) > MAX_BYTES) throw cgroupUnavailable('read bound exceeded');
    return result;
}

function directory(fsApi, target) {
    const stat = fsApi.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw cgroupUnavailable('unexpected directory');
    return stat;
}

function unified(value) {
    const rows = value.trim().split('\n').filter((row) => row.startsWith('0::'));
    if (rows.length !== 1) throw cgroupUnavailable('ambiguous cgroup membership');
    return rows[0].slice(3);
}

function queryDefault(command, args, { timeoutMs = 5000 } = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BYTES });
    return { ok: !result.error && result.status === 0, stdout: result.stdout };
}

export function isNamespaceRootImageUser(value) {
    return value === '' || /^(?:0|root)(?::[A-Za-z0-9_.-]+)?$/.test(String(value));
}

export function observeCgroupSubtreeContext({ fsApi = fs, query = queryDefault,
    cgroupRoot = '/sys/fs/cgroup', procRoot = '/proc' } = {}) {
    try {
        const mounts = cgroupMounts(read(fsApi, `${procRoot}/self/mountinfo`), cgroupRoot);
        if (mounts.length !== 1 || mounts[0].type !== 'cgroup2' || !mounts[0].options.includes('rw')
            || !mounts[0].superOptions.includes('rw') || !mounts[0].superOptions.includes('nsdelegate')
            || Number(fsApi.statfsSync(cgroupRoot).type) !== 0x63677270) throw cgroupUnavailable('Box cgroup mount is not verified');
        const structural = readStructuralDelegation({ fsApi, cgroupRoot, procRoot });
        const backend = structural.structurallyPrepared ? verifyNestedBackend({ query }) : null;
        const cgroupNamespace = fsApi.readlinkSync(`${procRoot}/self/ns/cgroup`);
        const pidNamespace = fsApi.readlinkSync(`${procRoot}/self/ns/pid`);
        const ready = structural.structurallyPrepared && backend?.ready
            && CONTROLLERS.every((controller) => structural.controllers.includes(controller))
            && /^cgroup:\[\d+\]$/.test(cgroupNamespace) && /^pid:\[\d+\]$/.test(pidNamespace);
        return Object.freeze({ schemaVersion: 1, ready: Boolean(ready), cgroupNamespace, pidNamespace,
            controllers: Object.freeze([...structural.controllers]), parent: CGROUP_PARENT,
            reason: ready ? null : structural.reason || backend?.reason || 'required controllers unavailable' });
    } catch { return Object.freeze({ schemaVersion: 1, ready: false, reason: 'delegation observation failed' }); }
}

export function admittedCgroupSubtree(context) {
    if (!context?.ready || context.schemaVersion !== 1 || context.parent !== CGROUP_PARENT
        || !/^cgroup:\[\d+\]$/.test(context.cgroupNamespace) || !/^pid:\[\d+\]$/.test(context.pidNamespace)
        || !CONTROLLERS.every((name) => context.controllers?.includes(name))) throw cgroupUnavailable(context?.reason);
    return Object.freeze({ ...context, controllers: Object.freeze([...context.controllers]) });
}

export function prepareCgroupSubtreeParent(context, { fsApi = fs, cgroupRoot = '/sys/fs/cgroup' } = {}) {
    admittedCgroupSubtree(context);
    const parent = `${cgroupRoot}${CGROUP_PARENT}`;
    try { fsApi.mkdirSync(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = directory(fsApi, parent);
    if (stat.uid !== 1000 || read(fsApi, `${parent}/cgroup.procs`).trim()) throw cgroupUnavailable('agent parent is not empty/delegated');
    for (const name of CONTROLLERS) fsApi.writeFileSync(`${parent}/cgroup.subtree_control`, `+${name}`);
    const enabled = read(fsApi, `${parent}/cgroup.subtree_control`).trim().split(/\s+/);
    if (!CONTROLLERS.every((name) => enabled.includes(name))) throw cgroupUnavailable('parent controllers unavailable');
    return Object.freeze({ parent: CGROUP_PARENT, dev: String(stat.dev), ino: String(stat.ino) });
}

export function reserveAgentCgroup(descriptor, containerId) {
    if (!descriptor?.cgroupDelegation) return null;
    if (!ID.test(containerId)) throw cgroupUnavailable('reservation requires exact container ID');
    const context = admittedCgroupSubtree(descriptor.cgroupDelegation);
    return Object.freeze({ schemaVersion: 1, containerId, parent: CGROUP_PARENT,
        box: Object.freeze({ cgroupNamespace: context.cgroupNamespace, pidNamespace: context.pidNamespace,
            markerIdentity: String(descriptor.boxContext?.markerIdentity || '') }), nativeRoot: null });
}

export function normalizeAgentCgroupReservation(value, containerId) {
    if (value === undefined || value === null) return null;
    if (value.schemaVersion !== 1 || !ID.test(containerId) || value.containerId !== containerId
        || value.parent !== CGROUP_PARENT || !/^cgroup:\[\d+\]$/.test(value.box?.cgroupNamespace)
        || !/^pid:\[\d+\]$/.test(value.box?.pidNamespace) || !value.box?.markerIdentity) throw cgroupUnavailable('invalid cleanup reservation');
    const root = value.nativeRoot;
    if (root !== null && (!new RegExp(`^${CGROUP_PARENT}/libpod-${containerId}(?:\\.scope)?$`).test(root?.path)
        || !/^\d+$/.test(root?.dev) || !/^\d+$/.test(root?.ino))) throw cgroupUnavailable('invalid native-root identity');
    return Object.freeze({ schemaVersion: 1, containerId, parent: CGROUP_PARENT,
        box: Object.freeze({ cgroupNamespace: value.box.cgroupNamespace, pidNamespace: value.box.pidNamespace,
            markerIdentity: value.box.markerIdentity }),
        nativeRoot: root ? Object.freeze({ path: root.path, dev: root.dev, ino: root.ino }) : null });
}

export function cgroupNamespaceModeFromInspection(record) {
    const modes = [record?.HostConfig?.CgroupMode, record?.HostConfig?.CgroupnsMode]
        .filter((value) => value !== undefined && value !== null);
    if (!modes.length || modes.some((value) => typeof value !== 'string' || value !== modes[0])) return null;
    return modes[0];
}

export function verifyCgroupContainerConfiguration({ descriptor, containerId, record } = {}) {
    if (!descriptor?.cgroupDelegation) return;
    if (record?.Id !== containerId) throw cgroupUnavailable('agent immutable ID contract mismatch');
    if (!isNamespaceRootImageUser(record?.Config?.User || '')) throw cgroupUnavailable('agent image user contract mismatch');
    if (JSON.stringify(record?.Config?.Entrypoint) !== JSON.stringify([CGROUP_ENTRYPOINT])) {
        throw cgroupUnavailable('agent entrypoint contract mismatch');
    }
    if (JSON.stringify(record?.Config?.Cmd?.slice(0, 2)) !== JSON.stringify([
        descriptor.cgroupDelegation.cgroupNamespace, descriptor.cgroupDelegation.pidNamespace])) {
        throw cgroupUnavailable('agent Box namespace arguments contract mismatch');
    }
    if (record?.HostConfig?.PidMode !== 'private') throw cgroupUnavailable('agent private PID namespace contract mismatch');
    if (cgroupNamespaceModeFromInspection(record) !== 'private') throw cgroupUnavailable('agent private cgroup namespace contract mismatch');
    const env = (record.Config.Env || []).filter((entry) => entry.startsWith('PLOINKY_CGROUP_SUBTREE='));
    const binds = (record.Mounts || []).filter((mount) => mount.Destination === CGROUP_HELPER_DIRECTORY);
    if (env.length !== 1 || env[0] !== `PLOINKY_CGROUP_SUBTREE=${CGROUP_SUBTREE_PATH}`) throw cgroupUnavailable('agent provider env contract mismatch');
    if (binds.length !== 1 || binds[0].RW !== false || binds[0].Source !== CGROUP_HELPER_SOURCE) throw cgroupUnavailable('agent read-only helper mount contract mismatch');
}

export function hasCgroupDelegationFootprint(record, inspected) {
    return Boolean(record?.cgroupSubtree
        || inspected?.Config?.Labels?.['ploinky.cgroup-subtree'] === '1'
        || inspected?.Config?.Env?.some((entry) => typeof entry === 'string' && entry.startsWith('PLOINKY_CGROUP_SUBTREE='))
        || inspected?.Config?.Entrypoint?.some((entry) => entry === CGROUP_ENTRYPOINT)
        || inspected?.Mounts?.some((mount) => mount.Destination === CGROUP_HELPER_DIRECTORY
            || mount.Destination === CGROUP_SUBTREE_MOUNT));
}

// Neither envhash nor the hardware gate records this independent permission.
// Inspect the existing authority too, including runtimes created before this
// comparison existed. False and absent request the same ordinary contract.
export function cgroupDelegationReuseReason(descriptor, record, inspected) {
    const requested = Boolean(descriptor?.cgroupDelegation);
    if (requested !== hasCgroupDelegationFootprint(record, inspected)) return 'cgroupDelegationChanged';
    if (requested) {
        try { verifyCgroupContainerConfiguration({ descriptor, containerId: inspected?.Id || inspected?.ID, record: inspected }); }
        catch { return 'cgroupDelegationContractChanged'; }
    }
    return null;
}

export function assertCgroupCleanupEvidence({ containerId, record, inspected, workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    fsApi = fs } = {}) {
    if (hasCgroupDelegationFootprint(record, inspected)
        && !recordedReservation(containerId, { record, workspaceRoot, fsApi })) {
        throw cgroupUnavailable('existing delegated runtime has no durable cleanup reservation; preserving its exact identity');
    }
}

export function verifyAgentCgroupSubtree({ descriptor, containerId, query = queryDefault, fsApi = fs,
    cgroupRoot = '/sys/fs/cgroup', procRoot = '/proc' } = {}) {
    if (!descriptor?.cgroupDelegation) return null;
    const reserved = reserveAgentCgroup(descriptor, containerId);
    const inspected = query('podman', ['container', 'inspect', containerId], { timeoutMs: 5000 });
    if (!inspected?.ok) throw cgroupUnavailable('exact agent inspection unavailable');
    let rows;
    try { rows = JSON.parse(inspected.stdout); } catch { throw cgroupUnavailable('invalid exact agent inspection'); }
    const record = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    verifyCgroupContainerConfiguration({ descriptor, containerId, record });
    const pid = record?.State?.Pid;
    if (!Number.isSafeInteger(pid) || pid < 1) throw cgroupUnavailable('agent has no running init');
    const cgroupNamespace = fsApi.readlinkSync(`${procRoot}/${pid}/ns/cgroup`);
    const pidNamespace = fsApi.readlinkSync(`${procRoot}/${pid}/ns/pid`);
    if (cgroupNamespace === reserved.box.cgroupNamespace || pidNamespace === reserved.box.pidNamespace
        || !/^cgroup:\[\d+\]$/.test(cgroupNamespace) || !/^pid:\[\d+\]$/.test(pidNamespace)) throw cgroupUnavailable('agent shares Box namespace');
    const membership = unified(read(fsApi, `${procRoot}/${pid}/cgroup`));
    const nativePath = membership.replace(/\/core$/, '');
    if (!membership.endsWith('/core')) throw cgroupUnavailable('agent startup has not moved init to core');
    if (!new RegExp(`^${CGROUP_PARENT}/libpod-${containerId}(?:\\.scope)?$`).test(nativePath)) {
        throw cgroupUnavailable('init is not in its exact native root/core');
    }
    const stat = directory(fsApi, `${cgroupRoot}${nativePath}`);
    const processStat = read(fsApi, `${procRoot}/${pid}/stat`);
    const start = processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    if (!/^[1-9][0-9]*$/.test(start || '')) throw cgroupUnavailable('init start identity unavailable');
    const mountinfo = read(fsApi, `${procRoot}/${pid}/mountinfo`);
    const ownMounts = cgroupMounts(mountinfo, CGROUP_SUBTREE_MOUNT);
    const sysMounts = cgroupMounts(mountinfo, '/sys/fs/cgroup');
    if (ownMounts.length !== 1 || ownMounts[0].type !== 'cgroup2'
        || !['rw', 'nosuid', 'nodev', 'noexec'].every((flag) => ownMounts[0].options.includes(flag))
        || !ownMounts[0].superOptions.includes('nsdelegate')
        || ownMounts[0].optional.some((flag) => /^(?:shared|master|propagate_from):/.test(flag))
        || sysMounts.length !== 1 || sysMounts[0].type !== 'cgroup2' || !sysMounts[0].options.includes('ro')) {
        throw cgroupUnavailable('agent private/sysfs mount contract mismatch');
    }
    if (stat.uid !== 1000 || Number(fsApi.statfsSync(`${cgroupRoot}${nativePath}`).type) !== 0x63677270) {
        throw cgroupUnavailable('native cgroup root filesystem/owner mismatch');
    }
    const mount = directory(fsApi, `${procRoot}/${pid}/root${CGROUP_SUBTREE_MOUNT}`);
    if (stat.dev !== mount.dev || stat.ino !== mount.ino) throw cgroupUnavailable('private view differs from native root');
    for (const suffix of ['', '/workloads']) {
        const dir = `${cgroupRoot}${nativePath}${suffix}`;
        if (read(fsApi, `${dir}/cgroup.procs`).trim() || read(fsApi, `${dir}/cgroup.type`).trim() !== 'domain'
            || !CONTROLLERS.every((name) => read(fsApi, `${dir}/cgroup.subtree_control`).trim().split(/\s+/).includes(name))) {
            throw cgroupUnavailable('agent delegated layout not prepared');
        }
    }
    const finalStat = read(fsApi, `${procRoot}/${pid}/stat`);
    if (finalStat.slice(finalStat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] !== start
        || unified(read(fsApi, `${procRoot}/${pid}/cgroup`)) !== membership
        || fsApi.readlinkSync(`${procRoot}/${pid}/ns/cgroup`) !== cgroupNamespace
        || fsApi.readlinkSync(`${procRoot}/${pid}/ns/pid`) !== pidNamespace) throw cgroupUnavailable('init identity changed during verification');
    return Object.freeze({ verified: true, root: nativePath, core: `${nativePath}/core`, workloads: `${nativePath}/workloads`,
        namespace: Object.freeze({ cgroup: cgroupNamespace, pid: pidNamespace }),
        mountIdentity: Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) }),
        reservation: Object.freeze({ ...reserved, nativeRoot: Object.freeze({ path: nativePath, dev: String(stat.dev), ino: String(stat.ino) }) }) });
}

export function waitForAgentCgroupSubtree(options, { timeoutMs = 10000, now = Date.now,
    pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
    const budget = Math.min(10000, Math.max(1, Number(timeoutMs) || 10000));
    const deadline = now() + budget;
    for (let attempt = 0; attempt < 201; attempt += 1) {
        try { return verifyAgentCgroupSubtree(options); }
        catch (error) {
            if (error.code !== 'PLOINKY_CGROUP_DELEGATION_UNAVAILABLE'
                || !/startup has not moved init|delegated layout not prepared/.test(error.message)) throw error;
            if (now() >= deadline || attempt === 200) throw cgroupUnavailable('agent cgroup startup did not settle within its deadline');
            pause(Math.min(50, Math.max(1, deadline - now())));
        }
    }
}

function recordedReservation(containerId, { record, workspaceRoot, fsApi }) {
    if (record?.cgroupSubtree) return normalizeAgentCgroupReservation(record.cgroupSubtree, containerId);
    const directory = path.join(workspaceRoot, '.ploinky/run/runtime-candidates');
    let names;
    try { names = fsApi.readdirSync(directory).sort(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (names.length > 512) throw cgroupUnavailable('candidate lookup bound exceeded');
    let result = null;
    for (const name of names) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const target = path.join(directory, name);
        let fd;
        try {
            fd = fsApi.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            const stat = fsApi.fstatSync(fd);
            if (!stat.isFile() || stat.size > 32768 || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
                throw cgroupUnavailable('invalid candidate receipt');
            }
            let value;
            try { value = JSON.parse(fsApi.readFileSync(fd, 'utf8')); } catch { throw cgroupUnavailable('malformed candidate receipt'); }
            if (value.containerId !== containerId || !value.registryRecord?.cgroupSubtree) continue;
            const reservation = normalizeAgentCgroupReservation(value.registryRecord.cgroupSubtree, containerId);
            if (result && JSON.stringify(result) !== JSON.stringify(reservation)) throw cgroupUnavailable('ambiguous candidate reservation');
            result = reservation;
        } finally { if (fd !== undefined) fsApi.closeSync(fd); }
    }
    return result;
}

// Shared by all exact engine-removal callers. Engine absence is necessary,
// never sufficient. An uncommitted reservation cannot authorize path guessing.
export function cleanupOwnedContainerCgroup({ containerId, record, workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    fsApi = fs, cgroupRoot = '/sys/fs/cgroup', procRoot = '/proc', removeEmpty = true } = {}) {
    const reservation = recordedReservation(containerId, { record, workspaceRoot, fsApi });
    if (!reservation) return Object.freeze({ absent: true, applicable: false });
    if (!reservation.nativeRoot) throw cgroupUnavailable('native-root reservation remains unresolved');
    if (fsApi.readlinkSync(`${procRoot}/self/ns/cgroup`) !== reservation.box.cgroupNamespace
        || fsApi.readlinkSync(`${procRoot}/self/ns/pid`) !== reservation.box.pidNamespace) throw cgroupUnavailable('cleanup Box namespace changed');
    const root = `${cgroupRoot}${reservation.nativeRoot.path}`;
    for (const target of [cgroupRoot, `${cgroupRoot}/ploinky`, `${cgroupRoot}${CGROUP_PARENT}`]) directory(fsApi, target);
    let stat;
    try { stat = directory(fsApi, root); } catch (error) {
        if (error.code === 'ENOENT') return Object.freeze({ absent: true, applicable: true });
        throw error;
    }
    if (String(stat.dev) !== reservation.nativeRoot.dev || String(stat.ino) !== reservation.nativeRoot.ino) throw cgroupUnavailable('native-root identity changed');
    if (Number(fsApi.statfsSync(root).type) !== 0x63677270) throw cgroupUnavailable('native-root filesystem changed');
    if (!removeEmpty) throw cgroupUnavailable('native cgroup root is still present');
    let visited = 0;
    const prune = (target, depth) => {
        if (++visited > 256 || depth > 16) throw cgroupUnavailable('cleanup bound exceeded');
        const identity = directory(fsApi, target);
        if (identity.dev !== stat.dev || read(fsApi, `${target}/cgroup.procs`).trim()) throw cgroupUnavailable('native hierarchy is busy or changed');
        const entries = fsApi.readdirSync(target, { withFileTypes: true });
        if (entries.length > 512) throw cgroupUnavailable('cleanup entry bound exceeded');
        for (const entry of entries) {
            if (entry.isSymbolicLink()) throw cgroupUnavailable('native hierarchy contains a symlink');
            if (entry.isDirectory()) prune(path.join(target, entry.name), depth + 1);
        }
        const again = directory(fsApi, target);
        if (again.dev !== identity.dev || again.ino !== identity.ino) throw cgroupUnavailable('cleanup identity changed');
        fsApi.rmdirSync(target);
    };
    prune(root, 0);
    try { fsApi.lstatSync(root); throw cgroupUnavailable('native root remained after cleanup'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return Object.freeze({ absent: true, applicable: true });
}
