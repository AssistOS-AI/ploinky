import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    agentWorkspaceHash,
    containerBlockers,
    createQuiescenceGate,
    launchRecordBlockers,
} from '../../ploinky-box/hostState/quiescence.mjs';

function realWorkspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-quiescence-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'ws');
    fs.mkdirSync(workspace);
    return { root, workspace };
}

function writeRecords(workspace, records) {
    const directory = path.join(workspace, '.ploinky', 'bwrap-pids');
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    for (const [name, body] of Object.entries(records)) fs.writeFileSync(path.join(directory, name), body);
}

const record = (pid, { schemaVersion = 3, processIdentity = `linux-proc:${pid}00` } = {}) => JSON.stringify({
    schemaVersion, ...(schemaVersion === 3 ? { hostStateMasked: true } : {}), pid, runtimeKey: `agent-${pid}`, processIdentity,
});

// The real file system, except /proc: `stats` maps PID to the start ticks
// /proc/<pid>/stat reports (a missing PID has no stat). Every other /proc read
// is recorded in `procReads` and fails, so a test can prove the gate never
// scans host processes.
function hostFs(stats = {}) {
    const procReads = [];
    const denied = (code) => Object.assign(new Error(code), { code });
    const api = {
        ...fs,
        procReads,
        readFileSync(target, ...rest) {
            const stat = /^\/proc\/(\d+)\/stat$/.exec(String(target));
            if (stat) {
                if (!(stat[1] in stats)) throw denied('ENOENT');
                return `${stat[1]} (agent) S ${Array(18).fill('0').join(' ')} ${stats[stat[1]]} 0 0`;
            }
            if (String(target).startsWith('/proc/')) {
                procReads.push(String(target));
                throw denied('EACCES');
            }
            return fs.readFileSync(target, ...rest);
        },
        readdirSync(target, ...rest) {
            if (String(target) === '/proc') {
                procReads.push('/proc');
                throw denied('EACCES');
            }
            return fs.readdirSync(target, ...rest);
        },
    };
    return api;
}

const alive = (pids) => (pid) => { if (!pids.includes(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
const noPs = () => { throw Object.assign(new Error('no ps'), { code: 'ENOENT' }); };

function gate(fsApi, { kill = () => {}, execFile = noPs, allowHostProcesses = [], liveness = { processStart: () => 'linux:1' }, platform = 'linux' } = {}) {
    return createQuiescenceGate({ platform, fsApi, kill, execFile, allowHostProcesses, liveness });
}

test('Mircea\'s Snap layout: desktop apps with the host root mounted read-write do not block, and no host process is scanned', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    // Discord, the Snap Store and snapd-desktop-integration each see the host
    // root through `/var/lib/snapd/hostfs` (device 259:5, root `/`, rw). The
    // gate never looks at them: it reads only Ploinky's own records and labels.
    const fsApi = hostFs();
    assert.deepEqual(gate(fsApi).assert(identity), { excused: [] });
    assert.deepEqual(fsApi.procReads, [], 'no /proc scan');
    // An unlabelled container that binds the host root read-write does not block either.
    const hostRoot = { id: 'a'.repeat(64), name: 'toolbox', running: true, labels: {}, mounts: [{ type: 'bind', source: '/', destination: '/var/lib/snapd/hostfs', rw: true }] };
    assert.doesNotThrow(() => gate(fsApi).assert(identity, { view: [hostRoot] }));
});

test('launch records: a recorded agent that still runs with its start identity blocks', (t) => {
    const { workspace } = realWorkspace(t);
    writeRecords(workspace, { 'a.pid': record(700) });
    const blockers = launchRecordBlockers(workspace, { fsApi: hostFs({ 700: '70000' }), kill: alive([700]), execFile: noPs });
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].pid, 700);
    assert.match(blockers[0].reason, /launch record .*a\.pid names a running agent/);
});

test('launch records: a gone PID, or a PID now held by another process, does not block', (t) => {
    const { workspace } = realWorkspace(t);
    writeRecords(workspace, { 'a.pid': record(700) });
    assert.deepEqual(launchRecordBlockers(workspace, { fsApi: hostFs(), kill: alive([]), execFile: noPs }), [], 'gone');
    assert.deepEqual(launchRecordBlockers(workspace, { fsApi: hostFs({ 700: '99999' }), kill: alive([700]), execFile: noPs }), [],
        'reused PID');
    // A record of an agent inside the Box names a PID of the Box's PID
    // namespace; on the host that PID is another process with another start.
    assert.deepEqual(launchRecordBlockers(workspace, { fsApi: hostFs({ 700: '12' }), kill: alive([700]), execFile: noPs }), []);
});

test('launch records: an unreadable start identity is taken as the agent; ps-lstart identities are compared too', (t) => {
    const { workspace } = realWorkspace(t);
    writeRecords(workspace, { 'a.pid': record(700) });
    assert.equal(launchRecordBlockers(workspace, { fsApi: hostFs(), kill: alive([700]), execFile: noPs }).length, 1);
    writeRecords(workspace, { 'b.pid': record(701, { processIdentity: 'ps-lstart:Tue Oct 27 09:00:00 2026' }) });
    const ps = (start) => (file, args) => {
        assert.equal(file, 'ps');
        assert.deepEqual(args, ['-p', '701', '-o', 'stat=', '-o', 'lstart=']);
        return `S    ${start}\n`;
    };
    assert.equal(launchRecordBlockers(workspace, { fsApi: hostFs(), kill: alive([701]), execFile: ps('Tue Oct 27  09:00:00 2026') }).length, 1);
    assert.deepEqual(launchRecordBlockers(workspace, { fsApi: hostFs(), kill: alive([701]), execFile: ps('Tue Oct 27 10:00:00 2026') }), []);
});

test('launch records: a record that cannot be parsed blocks, naming the file to inspect', (t) => {
    const { workspace } = realWorkspace(t);
    writeRecords(workspace, { 'b.pid': '{oops' });
    assert.throws(() => gate(hostFs()).assert(buildWorkspaceIdentity(workspace)),
        /launch record .*b\.pid is unparseable; inspect and remove it/);
});

test('--allow-host-process excuses exactly a masked agent seen by the check; an unmasked (schema 2) agent is never excused', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const fsApi = hostFs({ 700: '70000', 701: '70100' });
    const kill = alive([700, 701]);
    writeRecords(workspace, { 'new.pid': record(701) });
    assert.throws(() => gate(fsApi, { kill }).assert(identity), /process 701: .*new\.pid names a running agent.*--allow-host-process 701/s);
    assert.deepEqual(gate(fsApi, { kill, allowHostProcesses: [701] }).assert(identity), { excused: [701] });
    assert.throws(() => gate(fsApi, { kill, allowHostProcesses: [99] }).assert(identity), /process 701/);
    let reads = 0;
    const reused = { processStart: () => (reads++ === 0 ? 'linux:1' : 'linux:2') };
    assert.throws(() => gate(fsApi, { kill, allowHostProcesses: [701], liveness: reused }).assert(identity),
        /process 701: .*its PID now belongs to another process/);
    assert.throws(() => gate(fsApi, { kill, allowHostProcesses: [701], liveness: { processStart: () => null } }).assert(identity),
        /process 701/);

    writeRecords(workspace, { 'old.pid': record(700, { schemaVersion: 2 }) });
    assert.throws(() => gate(fsApi, { kill, allowHostProcesses: [700] }).assert(identity), (error) => {
        assert.match(error.message, /process 700: .*old\.pid \(schema 2\) names a running agent that an older Ploinky started without the host state mask/);
        assert.doesNotMatch(error.message, /--allow-host-process/);
        return true;
    });
    const forged = JSON.stringify({ schemaVersion: 2, hostStateMasked: true, pid: 700, processIdentity: 'linux-proc:70000' });
    writeRecords(workspace, { 'forged.pid': forged });
    assert.throws(() => gate(fsApi, { kill, allowHostProcesses: [700] }).assert(identity), /process 700: .*schema 2/,
        'only a schema 3 record counts as masked');
});

test('containers: a running Box or host agent container of this workspace blocks; others do not', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const real = fs.realpathSync(workspace);
    const container = (labels, { running = true, id = 'c'.repeat(64), name = 'other' } = {}) => ({
        id, name, running, labels, mounts: [{ type: 'bind', source: workspace, destination: '/w', rw: true }],
    });
    const box = { [BOX_LABELS.pathHash]: identity.pathHash, [BOX_LABELS.role]: 'box' };
    const agent = (hash) => ({ 'io.assistos.ploinky.managed': '1', 'io.assistos.ploinky.workspace': hash });
    assert.equal(agentWorkspaceHash(real), agentWorkspaceHash(fs.realpathSync(workspace)));
    assert.match(containerBlockers(identity, real, [container(box)])[0].reason, /a Box of this workspace/);
    assert.match(containerBlockers(identity, real, [container(agent(agentWorkspaceHash(real)))])[0].reason,
        /a Ploinky agent container of this workspace/);
    assert.equal(containerBlockers(identity, real, [container(box, { running: false })]).length, 0, 'a stopped Box');
    assert.equal(containerBlockers(identity, real, [container({ [BOX_LABELS.pathHash]: 'f'.repeat(12) })]).length, 0, 'another workspace\'s Box');
    assert.equal(containerBlockers(identity, real, [container(agent('0'.repeat(12)))]).length, 0, 'another workspace\'s agent');
    assert.equal(containerBlockers(identity, real, [container({ ...agent(agentWorkspaceHash(real)), 'io.assistos.ploinky.managed': '0' })]).length, 0,
        'an unmanaged container');
    assert.equal(containerBlockers(identity, real, [container({})]).length, 0, 'an unlabelled container binding the workspace');
    assert.throws(() => gate(hostFs()).assert(identity, { view: [container(box, { name: 'box' })] }),
        /container box: it is a Box of this workspace/);
});

test('the check before a replacement stops the old Box ignores exactly that Box', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    const box = { [BOX_LABELS.pathHash]: identity.pathHash, [BOX_LABELS.role]: 'box' };
    const oldBox = { id: 'e'.repeat(64), name: 'box', running: true, labels: box, mounts: [] };
    const other = { id: 'f'.repeat(64), name: 'second', running: true, labels: box, mounts: [] };
    assert.doesNotThrow(() => gate(hostFs()).assert(identity, { view: [oldBox], excludeContainerIds: [oldBox.id] }));
    assert.throws(() => gate(hostFs()).assert(identity, { view: [oldBox] }), /container box/);
    assert.throws(() => gate(hostFs()).assert(identity, { view: [oldBox, other], excludeContainerIds: [oldBox.id] }), /container second/);
});

test('the gate behaves the same on macOS: records and labels only', (t) => {
    const { workspace } = realWorkspace(t);
    const identity = buildWorkspaceIdentity(workspace);
    writeRecords(workspace, { 'a.pid': record(700, { processIdentity: 'ps-lstart:Tue Oct 27 09:00:00 2026' }) });
    const ps = () => 'Ss   Tue Oct 27 09:00:00 2026\n';
    assert.throws(() => gate(hostFs(), { platform: 'darwin', kill: alive([700]), execFile: ps }).assert(identity), /process 700/);
    assert.doesNotThrow(() => gate(hostFs(), { platform: 'darwin', kill: alive([]), execFile: ps }).assert(identity));
});
