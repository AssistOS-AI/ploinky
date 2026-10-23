import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    containerBlockers,
    createQuiescenceGate,
    exposingMount,
    podmanInfraNamespace,
    parseMountinfo,
    workspaceMountLocation,
} from '../../ploinky-box/hostState/quiescence.mjs';

// The workspace of these cases lives on device 0:50 at /home/dev/ws, inside a
// mount of /home (root `/`). The command's own mount namespace has mount 21 at
// `/`; another namespace has its own copy (mount 900).
const OWN_MOUNTINFO = [
    '21 1 0:40 / / rw,relatime shared:1 - ext4 /dev/root rw',
    '22 21 0:50 / /home rw,relatime shared:2 - ext4 /dev/home rw',
    '23 21 0:51 / /tmp rw,nosuid shared:3 - tmpfs tmpfs rw',
].join('\n');

function realWorkspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-quiescence-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'ws');
    fs.mkdirSync(workspace);
    return { root, workspace };
}

// A fake /proc: `processes` maps PID to { uids, mountinfo | error, cmdline }.
// `tasks` maps TID to { state, mountinfo | error } for /proc/<pid>/task/*;
// without it the only task is the leader itself. `taskError` makes the task
// list unreadable.
// The workspace path seen by the scan is fixed to /home/dev/ws through a
// realpath override, while the real directory backs identity resolution.
// `pause` describes rootless Podman's pause file under the fake runtime
// directory /run/fake (see RUNTIME_ENV): { pid, uid, mode, symlink }.
const RUNTIME_ENV = Object.freeze({ XDG_RUNTIME_DIR: '/run/fake' });
const PAUSE_FILE = '/run/fake/libpod/tmp/pause.pid';

function procFs(workspace, processes, { own = OWN_MOUNTINFO, pause = null } = {}) {
    const denied = (code = 'EACCES') => Object.assign(new Error(code), { code });
    return {
        realpathSync(target) {
            return target === workspace ? '/home/dev/ws' : fs.realpathSync(target);
        },
        lstatSync(target, ...rest) {
            if (target === PAUSE_FILE) {
                if (!pause) throw denied('ENOENT');
                return {
                    isSymbolicLink: () => pause.symlink === true, isFile: () => pause.symlink !== true,
                    uid: pause.uid ?? 1000, mode: pause.mode ?? 0o100600,
                };
            }
            return fs.lstatSync(target, ...rest);
        },
        readlinkSync(target, ...rest) {
            if (target === '/proc/self/ns/mnt') return 'mnt:[1]';
            const match = /^\/proc\/(\d+)\/(ns\/mnt|exe)$/.exec(target);
            if (!match) return fs.readlinkSync(target, ...rest);
            const entry = processes[match[1]];
            const value = entry?.[match[2] === 'exe' ? 'exe' : 'ns'];
            if (!value) throw denied();
            return value;
        },
        readdirSync(target) {
            if (target === '/proc') return ['self', ...Object.keys(processes), 'sys'];
            const tasks = /^\/proc\/(\d+)\/task$/.exec(target);
            if (tasks) {
                const entry = processes[tasks[1]];
                if (!entry) throw denied('ENOENT');
                if (entry.taskError) throw denied(entry.taskError);
                return Object.keys(entry.tasks || { [tasks[1]]: {} });
            }
            return fs.readdirSync(target);
        },
        readFileSync(target, encoding) {
            if (target === '/proc/self/mountinfo') return own;
            if (target === PAUSE_FILE) {
                if (!pause) throw denied('ENOENT');
                return `${pause.pid}\n`;
            }
            const taskFile = /^\/proc\/(\d+)\/task\/(\d+)\/(status|mountinfo)$/.exec(target);
            if (taskFile) {
                const entry = processes[taskFile[1]];
                const task = entry?.tasks ? entry.tasks[taskFile[2]] : (taskFile[1] === taskFile[2] ? entry : null);
                if (!task) throw denied('ENOENT');
                if (taskFile[3] === 'status') {
                    if (task.statusError) throw denied(task.statusError);
                    return `Name:\tx\nState:\t${task.state || 'S (sleeping)'}\nUid:\t1000\n`;
                }
                if (task.error) throw Object.assign(new Error(task.error), { code: task.error });
                return task.mountinfo;
            }
            const match = /^\/proc\/(\d+)\/(status|mountinfo|cmdline|cgroup)$/.exec(target);
            if (!match) return fs.readFileSync(target, encoding);
            const entry = processes[match[1]];
            if (!entry) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
            if (match[2] === 'status') return `Name:\tx\nState:\t${entry.state || 'S (sleeping)'}\nUid:\t${entry.uids.join('\t')}\nGid:\t1\n`;
            if (match[2] === 'cmdline') return entry.cmdline || 'agent\0--flag\0';
            if (match[2] === 'cgroup') {
                if (!entry.cgroup) throw denied('ENOENT');
                return `0::${entry.cgroup}\n`;
            }
            if (entry.error) throw Object.assign(new Error(entry.error), { code: entry.error });
            return entry.mountinfo;
        },
    };
}

const SAME_NAMESPACE = OWN_MOUNTINFO;
const BWRAP_WITH_WORKSPACE = [
    '900 899 0:40 / / ro,relatime - ext4 /dev/root rw',
    '901 900 0:50 /dev/ws /home/dev/ws rw,relatime - ext4 /dev/home rw',
].join('\n');

function linuxGate(fsApi, overrides = {}) {
    return createQuiescenceGate({
        platform: 'linux', fsApi, uid: 1000, selfPid: 10, env: RUNTIME_ENV,
        liveness: { processStart: () => 'linux:1' },
        ...overrides,
    });
}

test('mountinfo parsing decodes escapes and locates the workspace on its filesystem', () => {
    const mounts = parseMountinfo('30 1 0:50 /dev/my\\040ws /mnt/a\\040b rw - ext4 /dev/home rw\n');
    assert.equal(mounts[0].root, '/dev/my ws');
    assert.equal(mounts[0].mountPoint, '/mnt/a b');
    assert.deepEqual(workspaceMountLocation('/home/dev/ws', parseMountinfo(OWN_MOUNTINFO)), { device: '0:50', path: '/dev/ws' });
    const location = { device: '0:50', path: '/dev/ws' };
    const read = (line) => exposingMount(parseMountinfo(line), location);
    assert.ok(read('1 0 0:50 /dev/ws /w rw - ext4 x rw'), 'the workspace itself');
    assert.ok(read('1 0 0:50 /dev /w rw - ext4 x rw'), 'an ancestor');
    assert.ok(read('1 0 0:50 /dev/ws/.ploinky/box /w rw - ext4 x rw'), 'a descendant');
    assert.equal(read('1 0 0:50 /dev/ws /w ro - ext4 x rw'), null, 'a read-only view');
    assert.equal(read('1 0 0:51 /dev/ws /w rw - ext4 x rw'), null, 'another filesystem');
    assert.equal(read('1 0 0:50 /dev/ws2 /w rw - ext4 x rw'), null, 'a sibling with a common prefix');
});

test('Linux: a host agent of the workspace in another mount namespace blocks, naming its PID and mount', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    // No launch record exists anywhere (the erased-record variant of A18):
    // the mount table alone is the evidence.
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky', 'bwrap-pids')), false);
    const gate = linuxGate(procFs(workspace, {
        41: { uids: [1000, 1000, 1000, 1000], mountinfo: BWRAP_WITH_WORKSPACE, cmdline: 'bwrap\0--bind\0/home/dev/ws\0' },
    }));
    assert.throws(() => gate.assert(identity), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE');
        assert.match(error.message, /process 41 \(bwrap --bind \/home\/dev\/ws\)/);
        assert.match(error.message, /mount: 901 900 0:50 \/dev\/ws \/home\/dev\/ws rw/);
        assert.match(error.message, /--allow-host-process 41/);
        return true;
    });
});

test('Linux: processes in this command\'s own namespace, of other users, read-only or on other filesystems do not block', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const gate = linuxGate(procFs(workspace, {
        10: { uids: [1000, 1000, 1000, 1000], mountinfo: BWRAP_WITH_WORKSPACE }, // this command
        42: { uids: [1000, 1000, 1000, 1000], mountinfo: SAME_NAMESPACE },
        43: { uids: [1001, 1001, 1001, 1001], mountinfo: BWRAP_WITH_WORKSPACE },
        44: { uids: [1000, 1000, 1000, 1000], mountinfo: '700 1 0:50 /dev/ws /w ro - ext4 x rw' },
        45: { uids: [1000, 1000, 1000, 1000], mountinfo: '710 1 0:77 / / rw - ext4 x rw' },
    }));
    assert.doesNotThrow(() => gate.assert(identity));
});

test('Linux: an own-user process whose mount table cannot be read blocks (fail closed)', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const gate = linuxGate(procFs(workspace, { 46: { uids: [1000, 1000, 1000, 1000], error: 'EACCES' } }));
    assert.throws(() => gate.assert(identity), /process 46 .*mount table cannot be read \(EACCES\)/);
});

test('Linux: without a provable Podman pause namespace, a process with the host root read-write blocks (fail closed)', (t) => {
    // The rootless Podman pause process and conmon run as the invoking user in
    // Podman's own mount namespace, which copies the host mounts. When that
    // namespace cannot be proven (here: no pause file), nothing is exempt.
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const pause = [
        '1500 1400 0:40 / / rw,relatime - ext4 /dev/root rw',
        '1501 1500 0:50 / /home rw,relatime - ext4 /dev/home rw',
    ].join('\n');
    const gate = linuxGate(procFs(workspace, { 47: { uids: [1000, 1000, 1000, 1000], mountinfo: pause, cmdline: 'catatonit\0-P\0' } }));
    assert.throws(() => gate.assert(identity), /process 47 \(catatonit -P\).*1501 1500 0:50 \/ \/home rw/s);
});

test('--allow-host-process excuses exactly the process seen by the scan', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const fsApi = procFs(workspace, { 41: { uids: [1000, 1000, 1000, 1000], mountinfo: BWRAP_WITH_WORKSPACE } });
    assert.doesNotThrow(() => linuxGate(fsApi, { allowHostProcesses: [41] }).assert(identity));
    assert.throws(() => linuxGate(fsApi, { allowHostProcesses: [99] }).assert(identity), /process 41/);
    // The PID was reused between the scan and its re-verification.
    let reads = 0;
    const reused = { processStart: () => (reads++ === 0 ? 'linux:1' : 'linux:2') };
    assert.throws(() => linuxGate(fsApi, { allowHostProcesses: [41], liveness: reused }).assert(identity),
        /process 41 .*its PID now belongs to another process/);
    // A start time that cannot be read is no proof of the excused process.
    assert.throws(() => linuxGate(fsApi, { allowHostProcesses: [41], liveness: { processStart: () => null } }).assert(identity),
        /process 41/);
});

test('engine half: a running container with a read-write bind of the workspace, an ancestor or a descendant blocks', (t) => {
    const { root, workspace } = realWorkspace(t);
    const real = fs.realpathSync(workspace);
    const container = (mounts, running = true) => ({ id: 'c'.repeat(64), name: 'other', running, labels: {}, mounts });
    const bind = (source, rw = true) => ({ type: 'bind', source, destination: '/w', rw });
    assert.equal(containerBlockers(real, [container([bind(workspace)])]).length, 1);
    assert.equal(containerBlockers(real, [container([bind(root)])]).length, 1, 'an ancestor');
    assert.equal(containerBlockers(real, [container([bind(path.join(workspace, '.ploinky', 'box', 'images'))])]).length, 1, 'a descendant');
    assert.equal(containerBlockers(real, [container([bind(workspace)], false)]).length, 0, 'a stopped container');
    assert.equal(containerBlockers(real, [container([bind(workspace, false)])]).length, 0, 'a read-only bind');
    assert.equal(containerBlockers(real, [container([bind(`${workspace}-other`)])]).length, 0, 'a sibling');
    const identity = buildWorkspaceIdentity(workspace);
    // The host scan finds nothing here; the container alone blocks.
    const gate = createQuiescenceGate({ platform: 'darwin', uid: 501, selfPid: 600, execFile: () => '', kill: () => {} });
    assert.doesNotThrow(() => gate.assert(identity, { view: [container([bind(workspace, false)])] }));
    assert.throws(() => gate.assert(identity, { view: [container([bind(root)])] }),
        /container other: it binds .* read-write at \/w/);
});

function darwinGate(workspace, { processes = [], records = {}, alive = new Set(), uid = 501, selfPid = 600 } = {}) {
    const directory = path.join(workspace, '.ploinky', 'bwrap-pids');
    if (Object.keys(records).length) {
        fs.mkdirSync(directory, { recursive: true });
        for (const [name, body] of Object.entries(records)) fs.writeFileSync(path.join(directory, name), body);
    }
    return createQuiescenceGate({
        platform: 'darwin', uid, selfPid,
        execFile: (file, args, options) => {
            assert.equal(file, '/bin/ps');
            assert.equal(options.env.LC_ALL, 'C');
            return processes.map((entry) => `${entry.pid} ${entry.ppid} ${entry.uid} ${entry.command}`).join('\n');
        },
        kill: (pid) => { if (!alive.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
        liveness: { processStart: () => 'darwin:1' },
    });
}

test('macOS: launch records of running agents, invalid records and command lines naming the workspace block', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const record = (pid) => JSON.stringify({ schemaVersion: 3, hostStateMasked: true, pid, runtimeKey: 'agent' });
    assert.throws(() => darwinGate(workspace, { records: { 'a.pid': record(700) }, alive: new Set([700]) }).assert(identity),
        /process 700: its launch record .*a\.pid names a running process/);
    assert.doesNotThrow(() => darwinGate(workspace, { records: { 'a.pid': record(700) } }).assert(identity),
        'a record of a process that is gone');
    fs.rmSync(path.join(workspace, '.ploinky'), { recursive: true, force: true });
    assert.throws(() => darwinGate(workspace, { records: { 'b.pid': '{oops' } }).assert(identity),
        /launch record .*b\.pid is unparseable; inspect and remove it/);
    fs.rmSync(path.join(workspace, '.ploinky'), { recursive: true, force: true });
    const seatbelt = { pid: 701, ppid: 1, uid: 501, command: `/usr/bin/sandbox-exec -p (allow file-write* (subpath "${workspace}")) node agent.js` };
    assert.throws(() => darwinGate(workspace, { processes: [seatbelt] }).assert(identity),
        /process 701 \(\/usr\/bin\/sandbox-exec .*command line names the workspace/);
});

test('macOS: this command, its ancestors, other users and sibling paths do not block', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const processes = [
        { pid: 600, ppid: 550, uid: 501, command: `node ploinky-box.mjs start ${workspace}` },
        { pid: 550, ppid: 1, uid: 501, command: `zsh -c cd ${workspace} && ploinky start` },
        { pid: 702, ppid: 1, uid: 0, command: `mds ${workspace}` },
        { pid: 703, ppid: 1, uid: 501, command: `vim ${workspace}-notes/todo.md` },
        { pid: 704, ppid: 1, uid: 501, command: `vfkit --device virtio-fs,sharedDir=${path.dirname(workspace)}` },
    ];
    assert.doesNotThrow(() => darwinGate(workspace, { processes }).assert(identity));
});

// Rootless Podman's infrastructure: the pause process (catatonit) and conmon
// in Podman's own namespace, which copies the host mounts read-write.
const PODMAN_NS_MOUNTINFO = [
    '1500 1400 0:40 / / rw,relatime - ext4 /dev/root rw',
    '1501 1500 0:50 / /home rw,relatime - ext4 /dev/home rw',
].join('\n');
const PODMAN_NS = 'mnt:[4026533445]';
const infraProcess = (exe, extra = {}) => ({
    uids: [1000, 1000, 1000, 1000], mountinfo: PODMAN_NS_MOUNTINFO, ns: PODMAN_NS, exe: `/usr/bin/${exe}`, cmdline: `${exe}\0`, ...extra,
});

test('Linux: rootless Podman infrastructure in its own pause namespace does not block', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const processes = {
        6469: infraProcess('catatonit'),
        1464: infraProcess('conmon'),
        1465: infraProcess('rootlessport'),
        1466: infraProcess('pasta'),
        1467: infraProcess('podman'),
    };
    const gate = linuxGate(procFs(workspace, processes, { pause: { pid: 6469 } }));
    const result = gate.assert(identity);
    assert.deepEqual(result.podmanInfra.map((entry) => entry.pid).sort(), [1464, 1465, 1466, 1467, 6469]);
    assert.ok(result.podmanInfra.every((entry) => entry.namespace === PODMAN_NS));
    // With the exemption disabled the same host is refused, naming them.
    assert.throws(() => linuxGate(procFs(workspace, processes, { pause: { pid: 6469 } }), { exemptPodmanInfra: false }).assert(identity),
        /process 6469 \(catatonit\)/);
});

test('Linux: in the Podman namespace, a process that is not one of Podman\'s executables still blocks', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    for (const intruder of [infraProcess('sh'), infraProcess('conmon', { exe: null }), infraProcess('node', { cmdline: 'conmon\0' })]) {
        const gate = linuxGate(procFs(workspace, { 6469: infraProcess('catatonit'), 77: intruder }, { pause: { pid: 6469 } }));
        assert.throws(() => gate.assert(identity), (error) => error.blockers.map((entry) => entry.pid).join() === '77', JSON.stringify(intruder.exe));
    }
});

test('Linux: Podman executables in any other namespace with / read-write block', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const elsewhere = infraProcess('conmon', { ns: 'mnt:[4026539999]' });
    const gate = linuxGate(procFs(workspace, { 6469: infraProcess('catatonit'), 88: elsewhere }, { pause: { pid: 6469 } }));
    assert.throws(() => gate.assert(identity), (error) => error.blockers.map((entry) => entry.pid).join() === '88');
});

test('Linux: the Podman namespace is never exempt unless the pause process is proven', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const processes = { 6469: infraProcess('catatonit'), 1464: infraProcess('conmon') };
    const cases = {
        'no pause file': null,
        'pause file is a link': { pid: 6469, symlink: true },
        'pause file of another user': { pid: 6469, uid: 0 },
        'group-writable pause file': { pid: 6469, mode: 0o100620 },
        'pause pid is not a Podman executable': { pid: 1468 },
        'pause pid is gone': { pid: 99999 },
    };
    for (const [label, pause] of Object.entries(cases)) {
        // A shell in the same namespace that sees no workspace mount, so it
        // cannot block on its own: only the pause proof decides this case.
        const table = label === 'pause pid is not a Podman executable'
            ? { ...processes, 1468: infraProcess('sh', { mountinfo: '1600 1 0:77 / / rw - ext4 /dev/other rw' }) }
            : processes;
        const gate = linuxGate(procFs(workspace, table, { pause }));
        assert.throws(() => gate.assert(identity), { code: 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE' }, label);
    }
    // A pause process that shares this command's own namespace proves nothing.
    const shared = { 6469: infraProcess('catatonit', { ns: 'mnt:[1]' }), 1464: infraProcess('conmon', { ns: 'mnt:[1]' }) };
    assert.throws(() => linuxGate(procFs(workspace, shared, { pause: { pid: 6469 } })).assert(identity), /process 1464/);
    assert.equal(podmanInfraNamespace({ fsApi: procFs(workspace, {}, {}), env: RUNTIME_ENV, uid: 1000 }), null);
    assert.equal(podmanInfraNamespace({ fsApi: procFs(workspace, processes, { pause: { pid: 6469 } }), env: RUNTIME_ENV, uid: null }), null);
});

test('Linux: a Box\'s own processes in their container namespace still block even while Podman infrastructure is exempt', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const boxProcess = { uids: [1000, 1000, 1000, 1000], mountinfo: BWRAP_WITH_WORKSPACE, ns: 'mnt:[4026534006]', exe: '/usr/bin/conmon' };
    const gate = linuxGate(procFs(workspace, { 6469: infraProcess('catatonit'), 90: boxProcess }, { pause: { pid: 6469 } }));
    assert.throws(() => gate.assert(identity), (error) => error.blockers.map((entry) => entry.pid).join() === '90');
});

test('Linux: an exited (zombie) process never blocks, even though its mount table cannot be read', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const zombie = { uids: [1000, 1000, 1000, 1000], state: 'Z (zombie)', error: 'EINVAL' };
    assert.doesNotThrow(() => linuxGate(procFs(workspace, { 4065226: zombie })).assert(identity));
    // A live process whose mount table fails the same way still blocks.
    const live = { uids: [1000, 1000, 1000, 1000], error: 'EINVAL' };
    assert.throws(() => linuxGate(procFs(workspace, { 4065227: live })).assert(identity), /process 4065227 .*cannot be read \(EINVAL\)/);
    // A zombie name does not excuse a live mount of the workspace.
    const running = { uids: [1000, 1000, 1000, 1000], state: 'S (sleeping)', mountinfo: BWRAP_WITH_WORKSPACE };
    assert.throws(() => linuxGate(procFs(workspace, { 41: running })).assert(identity), /process 41/);
});

test('the scan before a replacement stops the old Box ignores exactly that Box and its cgroup scope', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const scope = '/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-eeee.scope';
    const boxId = 'e'.repeat(64);
    const boxInit = { uids: [1000, 1000, 1000, 1000], mountinfo: BWRAP_WITH_WORKSPACE, cgroup: `${scope}/container` };
    const nestedAgent = { uids: [1000, 1000, 1000, 1000], mountinfo: BWRAP_WITH_WORKSPACE, cgroup: `${scope}/container/ploinky/agents/a` };
    const hostAgent = { uids: [1000, 1000, 1000, 1000], mountinfo: BWRAP_WITH_WORKSPACE, cgroup: '/user.slice/user-1000.slice/session-3.scope' };
    const view = [{ id: boxId, name: 'box', running: true, pid: 500, labels: {}, mounts: [{ type: 'bind', source: workspace, destination: workspace, rw: true }] }];
    const gate = (processes) => linuxGate(procFs(workspace, processes));
    assert.doesNotThrow(() => gate({ 500: boxInit, 501: nestedAgent }).assert(identity, { view, excludeContainerIds: [boxId] }));
    assert.throws(() => gate({ 500: boxInit, 501: nestedAgent, 41: hostAgent }).assert(identity, { view, excludeContainerIds: [boxId] }),
        (error) => error.blockers.map((entry) => entry.pid).join() === '41');
    // Without the exclusion (the full scan after the stop) the Box counts.
    assert.throws(() => gate({ 500: boxInit, 501: nestedAgent }).assert(identity, { view }),
        (error) => error.blockers.some((entry) => entry.kind === 'container') && error.blockers.some((entry) => entry.pid === 500));
    // A scope that cannot be read skips the host half of this advisory scan only.
    assert.doesNotThrow(() => gate({ 500: { ...boxInit, cgroup: null }, 41: hostAgent }).assert(identity, { view, excludeContainerIds: [boxId] }));
    // Another container is never excused by the exclusion.
    const other = { ...view[0], id: 'f'.repeat(64), name: 'other', pid: 600 };
    assert.throws(() => gate({ 500: boxInit }).assert(identity, { view: [...view, other], excludeContainerIds: [boxId] }),
        /container other/);
});

// Steps 4–5 review minor (A): a zombie thread-group leader can still have live
// threads that run with the workspace mounted. Its own mountinfo then fails
// with EINVAL, so the decision must come from /proc/<pid>/task.
test('Linux: a zombie leader with a live thread still blocks; only all-exited tasks are skipped', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const uids = [1000, 1000, 1000, 1000];
    const leaderZombie = (tasks, extra = {}) => ({ uids, state: 'Z (zombie)', error: 'EINVAL', tasks, ...extra });
    // A live thread that has the workspace mounted read-write blocks, and the
    // mount line comes from that thread's own table.
    const withLiveThread = leaderZombie({
        500: { state: 'Z (zombie)', error: 'EINVAL' },
        501: { state: 'S (sleeping)', mountinfo: BWRAP_WITH_WORKSPACE },
    });
    assert.throws(() => linuxGate(procFs(workspace, { 500: withLiveThread })).assert(identity), (error) => {
        assert.deepEqual(error.blockers.map((entry) => entry.pid), [500]);
        assert.match(error.message, /process 500 .*has the workspace mounted read-write; mount: 901 900 0:50 \/dev\/ws/);
        return true;
    });
    // A live thread whose own table cannot be read blocks too (fail closed).
    const unreadable = leaderZombie({ 600: { state: 'Z (zombie)' }, 601: { state: 'R (running)', error: 'EACCES' } });
    assert.throws(() => linuxGate(procFs(workspace, { 600: unreadable })).assert(identity), /process 600 .*cannot be read \(EACCES\)/);
    // A task list or a task status that cannot be read is not proof of exit.
    assert.throws(() => linuxGate(procFs(workspace, { 700: leaderZombie(undefined, { taskError: 'EACCES' }) })).assert(identity),
        /process 700 .*cannot be read \(EINVAL\)/);
    const statusDenied = leaderZombie({ 800: { state: 'Z (zombie)' }, 801: { statusError: 'EACCES' } });
    assert.throws(() => linuxGate(procFs(workspace, { 800: statusDenied })).assert(identity), /process 800 /);
    // Every task Z or X, or vanished meanwhile: exited, never a blocker.
    const allExited = leaderZombie({ 900: { state: 'Z (zombie)' }, 901: { state: 'X (dead)' } });
    const vanished = leaderZombie(undefined, { taskError: 'ENOENT' });
    assert.doesNotThrow(() => linuxGate(procFs(workspace, { 900: allExited, 1000: vanished })).assert(identity));
});

// Steps 4–5 review minor (B): after a package upgrade the running Podman
// helpers' /proc/<pid>/exe ends in " (deleted)". They stay exempt, the pause
// proof still holds, and the exemption still requires Podman's namespace.
test('Linux: upgraded Podman helpers (" (deleted)" executables) stay exempt only in the proven Podman namespace', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const deleted = (exe, extra = {}) => infraProcess(exe, { exe: `/usr/bin/${exe} (deleted)`, ...extra });
    const processes = { 6469: deleted('catatonit'), 1464: deleted('conmon'), 1466: deleted('pasta') };
    const result = linuxGate(procFs(workspace, processes, { pause: { pid: 6469 } })).assert(identity);
    assert.deepEqual(result.podmanInfra.map((entry) => entry.pid).sort(), [1464, 1466, 6469]);
    assert.deepEqual(result.podmanInfra.map((entry) => entry.executable).sort(), ['catatonit', 'conmon', 'pasta']);
    assert.equal(podmanInfraNamespace({ fsApi: procFs(workspace, processes, { pause: { pid: 6469 } }), env: RUNTIME_ENV, uid: 1000 })?.pid, 6469);
    // The same upgraded helper in another namespace with / read-write blocks.
    const elsewhere = deleted('conmon', { ns: 'mnt:[4026539999]' });
    assert.throws(() => linuxGate(procFs(workspace, { ...processes, 88: elsewhere }, { pause: { pid: 6469 } })).assert(identity),
        (error) => error.blockers.map((entry) => entry.pid).join() === '88');
    // Only the exact suffix is stripped: another name is still not Podman's.
    const lookalike = infraProcess('conmon', { exe: '/usr/bin/conmon (deleted) (deleted)' });
    assert.throws(() => linuxGate(procFs(workspace, { ...processes, 89: lookalike }, { pause: { pid: 6469 } })).assert(identity),
        (error) => error.blockers.map((entry) => entry.pid).join() === '89');
});

// Plan D3 with schema 3 launch records: on macOS a running agent whose record
// is not a masked schema 3 record (an older Ploinky's schema 2 record) blocks
// and cannot be excused; a masked agent's record blocks but can be excused.
test('macOS: a running unmasked (schema 2) agent blocks and cannot be excused; a masked one can', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const v2 = JSON.stringify({ schemaVersion: 2, pid: 700, runtimeKey: 'old' });
    const v3 = JSON.stringify({ schemaVersion: 3, hostStateMasked: true, pid: 701, runtimeKey: 'new' });
    const forged = JSON.stringify({ schemaVersion: 2, hostStateMasked: true, pid: 702, runtimeKey: 'forged' });
    const allowing = (records, pids) => {
        const directory = path.join(workspace, '.ploinky', 'bwrap-pids');
        fs.mkdirSync(directory, { recursive: true });
        for (const [name, body] of Object.entries(records)) fs.writeFileSync(path.join(directory, name), body);
        const built = createQuiescenceGate({
            platform: 'darwin', uid: 501, selfPid: 600, execFile: () => '', allowHostProcesses: pids,
            kill: (pid) => { if (![700, 701, 702].includes(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
            liveness: { processStart: () => 'darwin:1' },
        });
        return { assert: () => { try { return built.assert(identity); } finally { fs.rmSync(path.join(workspace, '.ploinky'), { recursive: true, force: true }); } } };
    };
    assert.throws(() => allowing({ 'old.pid': v2 }, []).assert(), (error) => {
        assert.match(error.message, /process 700: its launch record .*old\.pid \(schema 2\) names a running agent that an older Ploinky started without the host state mask/);
        assert.doesNotMatch(error.message, /--allow-host-process/);
        return true;
    });
    assert.throws(() => allowing({ 'old.pid': v2 }, [700]).assert(), /process 700: .*without the host state mask/,
        'an unmasked agent is never excused');
    assert.throws(() => allowing({ 'forged.pid': forged }, [702]).assert(), /process 702: .*schema 2/,
        'only a schema 3 record counts as masked');
    assert.throws(() => allowing({ 'new.pid': v3 }, []).assert(), /process 701: its launch record .*new\.pid names a running process.*--allow-host-process 701/s);
    assert.doesNotThrow(() => allowing({ 'new.pid': v3 }, [701]).assert(), 'a masked agent can be excused');
});
