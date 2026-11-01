// Fixed, read-only startup preparation. This runs before AgentEntrypoint's
// brokers, hooks or agent code, using only the existing nested-Podman authority.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CGROUP_MOUNT = '/run/ploinky/cgroup';
const CONTROLLERS = ['cpu', 'memory', 'pids'];
const MAX_BYTES = 256 * 1024;

function fail(message) { throw Object.assign(new Error(message), { code: 'PLOINKY_CGROUP_DELEGATION_UNAVAILABLE' }); }
function read(fsApi, target) {
    const text = String(fsApi.readFileSync(target, 'utf8'));
    if (Buffer.byteLength(text) > MAX_BYTES) fail('preparation read bound exceeded');
    return text.trim();
}
function directory(fsApi, target) {
    const stat = fsApi.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('preparation path is not a real directory');
    return stat;
}
function membership(fsApi, procRoot, pid) {
    const rows = read(fsApi, `${procRoot}/${pid}/cgroup`).split('\n').filter((row) => row.startsWith('0::'));
    if (rows.length !== 1) fail('unified membership is ambiguous');
    return rows[0].slice(3);
}
export function verifyNamespaceDiff({ boxCgroup, boxPid, fsApi = fs, procRoot = '/proc' } = {}) {
    if (!/^cgroup:\[\d+\]$/.test(boxCgroup) || !/^pid:\[\d+\]$/.test(boxPid)) fail('expected Box namespaces missing');
    const cgroup = fsApi.readlinkSync(`${procRoot}/self/ns/cgroup`);
    const pid = fsApi.readlinkSync(`${procRoot}/self/ns/pid`);
    if (!/^cgroup:\[\d+\]$/.test(cgroup) || !/^pid:\[\d+\]$/.test(pid)
        || cgroup === boxCgroup || pid === boxPid
        || fsApi.readlinkSync(`${procRoot}/1/ns/cgroup`) !== cgroup
        || fsApi.readlinkSync(`${procRoot}/1/ns/pid`) !== pid) fail('agent namespaces are not private to PID1');
    for (const selected of ['self', '1']) {
        if (!['/', '/core'].includes(membership(fsApi, procRoot, selected))) fail('PID1/self is not at its native root/core');
    }
    return Object.freeze({ cgroup, pid });
}

export function cgroupMounts(text, target) {
    return text.split('\n').filter(Boolean).flatMap((line) => {
        const parts = line.split(' '), separator = parts.indexOf('-');
        if (separator < 6 || parts.length < separator + 4) fail('invalid mountinfo');
        if (parts[4] !== target) return [];
        return [{ id: parts[0], root: parts[3], options: parts[5].split(','),
            optional: parts.slice(6, separator), type: parts[separator + 1], superOptions: parts[separator + 3].split(',') }];
    });
}

function verifiedMount(fsApi, procRoot, target) {
    const mounts = cgroupMounts(read(fsApi, `${procRoot}/self/mountinfo`), target);
    if (mounts.length !== 1) fail('private cgroup mount is missing or stacked');
    const mount = mounts[0];
    if (mount.type !== 'cgroup2' || mount.root !== '/' || !['rw', 'nosuid', 'nodev', 'noexec'].every((v) => mount.options.includes(v))
        || !mount.superOptions.includes('rw') || !mount.superOptions.includes('nsdelegate')
        || mount.optional.some((option) => /^(?:shared|master|propagate_from):/.test(option))) fail('private cgroup mount contract mismatch');
    if (Number(fsApi.statfsSync(target).type) !== 0x63677270) fail('private mount is not cgroup2');
    return mount;
}

export async function prepareAgentCgroupSubtree({ boxCgroup, boxPid, fsApi = fs, procRoot = '/proc',
    target = CGROUP_MOUNT, mount = spawnSync, now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), getuid = process.getuid } = {}) {
    if (target !== CGROUP_MOUNT || getuid() !== 0) fail('preparation requires existing image namespace root');
    if (Number(process.versions.node.split('.')[0]) < 22) fail('cgroup delegation requires Node.js 22 or newer in the agent image');
    const namespace = verifyNamespaceDiff({ boxCgroup, boxPid, fsApi, procRoot });
    const sysMounts = cgroupMounts(read(fsApi, `${procRoot}/self/mountinfo`), '/sys/fs/cgroup');
    if (sysMounts.length !== 1 || sysMounts[0].type !== 'cgroup2' || sysMounts[0].root !== '/'
        || !sysMounts[0].options.includes('ro')) fail('sysfs cgroup view is not the read-only native root');
    const nativeRoot = directory(fsApi, '/sys/fs/cgroup');
    if (Number(fsApi.statfsSync('/sys/fs/cgroup').type) !== 0x63677270) fail('native root is not cgroup2');
    // Namespace/native-root checks precede every mkdir, mount and process move.
    for (const current of ['/run', '/run/ploinky']) {
        try { directory(fsApi, current); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            fsApi.mkdirSync(current);
        }
    }
    let mounts = cgroupMounts(read(fsApi, `${procRoot}/self/mountinfo`), target);
    if (!mounts.length) {
        try { directory(fsApi, target); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            fsApi.mkdirSync(target);
        }
        if (fsApi.readdirSync(target).length) fail('refusing to overmount nonempty cgroup target');
        const created = mount('/bin/mount', ['-t', 'cgroup2', '-o', 'rw,nosuid,nodev,noexec,nsdelegate', 'none', target],
            { timeout: 3000, maxBuffer: 8192, encoding: 'utf8' });
        if (created.error || created.status !== 0) fail('private cgroup mount failed');
        const privateMount = mount('/bin/mount', ['--make-private', target], { timeout: 3000, maxBuffer: 8192 });
        if (privateMount.error || privateMount.status !== 0) fail('private cgroup propagation failed');
    }
    directory(fsApi, target);
    const checked = verifiedMount(fsApi, procRoot, target);
    const visible = directory(fsApi, target);
    if (visible.dev !== nativeRoot.dev || visible.ino !== nativeRoot.ino) fail('mounted hierarchy is not the native agent root');
    for (const leaf of ['core', 'workloads']) {
        try { fsApi.mkdirSync(`${target}/${leaf}`); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        directory(fsApi, `${target}/${leaf}`);
    }
    const deadline = now() + 2000;
    let moved = 0;
    for (let pass = 0; pass < 16; pass += 1) {
        const pids = read(fsApi, `${target}/cgroup.procs`).split(/\s+/).filter(Boolean);
        if (!pids.length) break;
        if (pids.length > 4096 || now() >= deadline) fail('startup task evacuation bound exceeded');
        for (const pid of pids) {
            if (!/^[1-9][0-9]*$/.test(pid) || !Number.isSafeInteger(Number(pid))) fail('invalid/invisible startup PID');
            try {
                if (fsApi.readlinkSync(`${procRoot}/${pid}/ns/pid`) !== namespace.pid
                    || membership(fsApi, procRoot, pid) !== '/') fail('refusing to migrate a non-startup task');
                fsApi.writeFileSync(`${target}/core/cgroup.procs`, pid);
                moved += 1;
            } catch (error) {
                if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
                try { fsApi.lstatSync(`${procRoot}/${pid}`); fail('task move failed while PID remains visible'); }
                catch (gone) { if (gone.code !== 'ENOENT') throw gone; }
            }
        }
        await sleep(5);
    }
    for (const suffix of ['', '/workloads']) {
        const current = `${target}${suffix}`;
        if (read(fsApi, `${current}/cgroup.procs`) || read(fsApi, `${current}/cgroup.type`) !== 'domain') fail('delegation internal node is not empty domain');
        const available = read(fsApi, `${current}/cgroup.controllers`).split(/\s+/);
        if (!CONTROLLERS.every((name) => available.includes(name))) fail('required cgroup controllers unavailable');
        for (const controller of CONTROLLERS) fsApi.writeFileSync(`${current}/cgroup.subtree_control`, `+${controller}`);
        const enabled = read(fsApi, `${current}/cgroup.subtree_control`).split(/\s+/);
        if (!CONTROLLERS.every((name) => enabled.includes(name))) fail('controller enablement readback failed');
    }
    verifyNamespaceDiff({ boxCgroup, boxPid, fsApi, procRoot });
    verifiedMount(fsApi, procRoot, target);
    return Object.freeze({ prepared: true, namespace, mountId: checked.id, moved });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    try {
        if (process.argv.length !== 4) fail('expected exactly the two Box namespace identities');
        await prepareAgentCgroupSubtree({ boxCgroup: process.argv[2], boxPid: process.argv[3] });
    } catch (error) { process.stderr.write(`cgroup delegation startup refused: ${error.message}\n`); process.exitCode = 1; }
}
