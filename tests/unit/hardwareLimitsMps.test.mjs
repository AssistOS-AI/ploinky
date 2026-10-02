import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildGpuWiring, renderBoxCdiSpec, resolveDesiredGpuWiring, gpuWiringCreateArgs } from '../../ploinky-box/gpuGrant.mjs';
import { discoverMpsTools, revalidateMpsTools, MPS_TOOL_PATHS } from '../../ploinky-box/lib/mpsTools.mjs';
import { assertMpsImageEligibility, classifyGpuMemoryModel, parseMpsGpuObservation, prepareMpsImage, inspectMpsImage } from '../../cli/sandbox/hardwareLimits/mpsEligibility.mjs';
import { configureMpsDefaults, parseMpsMemoryReply, parseMpsSmReply, parseMpsServerList, runMpsControl, observeOwnedMpsDaemon, createMpsDaemonBackend, createMpsStateStore, recoverMpsDaemonIdentity, discoverOwnedMpsDaemon, cleanupMpsGeneration } from '../../cli/sandbox/hardwareLimits/mps.mjs';

const discovery = { vendor: 'nvidia', driverVersion: '595.91.07', devices: [{ path: '/dev/nvidia0', major: 195, minor: 0 }], libraries: [{ soname: 'libcuda.so.1', source: '/usr/lib/libcuda.so.595.91.07', size: 100, mtimeMs: 1 }], tools: [{ name: 'nvidia-smi', source: '/usr/bin/nvidia-smi', size: 100, mtimeMs: 1 }] };
const grant = { vendor: 'nvidia', agents: ['repo/agent'] };
const gpuUuid = 'GPU-12345678-1234-1234-1234-123456789012';
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-mps-tools-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [key, destination] of Object.entries(MPS_TOOL_PATHS)) fs.writeFileSync(path.join(root, path.basename(destination)), `#!/bin/sh\n# ${key}\n`, { mode: 0o755 });
    const mps = discoverMpsTools({ directories: [root] });
    const pathHash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
    const identity = { workspaceRoot: root, pathHash, instance: `ploinky-box-test-${pathHash}` };
    return { root, mps, identity, wiring: (extra = {}) => buildGpuWiring({ identity, grant, discovery, homeDirectory: root, ...extra }) };
}

test('MP.disabled-bytes', (t) => {
    const { identity, root, wiring } = fixture(t);
    const old = wiring();
    const disabled = resolveDesiredGpuWiring(identity, grant, [], { discover: () => discovery, homeDirectory: root, mpsEnabled: false, discoverMps: () => { throw new Error('must not discover when disabled'); } });
    assert.deepEqual(disabled, old);
    assert.equal(JSON.parse(old.files.at(-1).content).mps, undefined);
});
test('MP.tools-not-cdi', (t) => {
    const { mps, wiring } = fixture(t);
    const enabled = wiring({ mps });
    assert.equal(enabled.files[0].content, renderBoxCdiSpec(discovery));
    assert.equal(enabled.files[0].content.includes('mps-control'), false);
    assert.equal(enabled.files[0].content.includes('mps-server'), false);
});
test('MP.both-tools-ro', (t) => {
    const { mps, wiring } = fixture(t);
    const enabled = wiring({ mps });
    const args = gpuWiringCreateArgs(enabled);
    for (const tool of Object.values(mps)) assert(args.volumes.includes(`${tool.source}:${tool.destination}:ro`));
    assert.deepEqual(JSON.parse(enabled.files.at(-1).content).mps, mps);
    assert.throws(() => wiring({ mps: { control: mps.control } }), /both MPS tools/);
});
test('MP.tool-only-fingerprint', (t) => {
    const { root, mps, wiring } = fixture(t);
    const before = wiring({ mps });
    const file = mps.control.source;
    const stat = fs.statSync(file);
    const bytes = fs.readFileSync(file); bytes[bytes.length - 2] ^= 1; fs.writeFileSync(file, bytes); fs.utimesSync(file, stat.atime, stat.mtime);
    const after = wiring({ mps: discoverMpsTools({ directories: [root] }) });
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.equal(before.files[0].content, after.files[0].content);
    assert.throws(() => revalidateMpsTools(mps), /changed/);
});
test('MP.missing-tools-ordinary-grant', (t) => {
    const { root, identity, wiring } = fixture(t);
    const actual = resolveDesiredGpuWiring(identity, grant, [], { discover: () => discovery, homeDirectory: root, mpsEnabled: true, discoverMps: () => { throw new Error('missing'); } });
    assert.deepEqual(actual, wiring()); assert.equal(actual.state, 'active');
});
test('MP.uid-predicate', () => {
    const imageId = 'a'.repeat(64);
    for (const user of ['1000:1000', '1:1', '4294967294:4294967294']) assert(assertMpsImageEligibility({ imageId, imageUser: user, networkMode: 'default' }).userNamespace.startsWith('keep-id:uid='));
    for (const user of ['', '0:0', '0:1000', '1000:0', 'node', '1000', '01:1000', '4294967295:1000', '1000:4294967295', '999999999999999999999:1']) assert.throws(() => assertMpsImageEligibility({ imageId, imageUser: user, networkMode: 'default' }));
});
test('MP.network-predicate', () => {
    for (const networkMode of ['default', 'bridge', 'managed']) assert.doesNotThrow(() => assertMpsImageEligibility({ imageId: 'b'.repeat(64), imageUser: '1000:1000', networkMode }));
    for (const networkMode of ['host', 'none', 'container:other', '']) assert.throws(() => assertMpsImageEligibility({ imageId: 'b'.repeat(64), imageUser: '1000:1000', networkMode }));
});
test('MP.cold-image', () => {
    const events = [];
    const prepared = prepareMpsImage({ image: 'tag', networkMode: 'default' }, { ensureImage: (image) => events.push(`ensure:${image}`), inspectImage: (image) => { assert.deepEqual(events, ['ensure:tag']); events.push(`inspect:${image}`); return [{ Id: `sha256:${'c'.repeat(64)}`, Config: { User: '1000:1000' } }]; } });
    assert.equal(prepared.imageId, `sha256:${'c'.repeat(64)}`);
    assert.throws(() => inspectMpsImage({ image: 'missing', networkMode: 'default' }, { inspectImage: () => { throw new Error('no image'); } }), { code: 'image_preparation_required' });
});
test('MP.immutable-image', () => {
    assert.throws(() => assertMpsImageEligibility({ imageId: 'mutable:tag', imageUser: '1000:1000', networkMode: 'default' }));
    const prepared = prepareMpsImage({ image: 'tag', networkMode: 'bridge' }, { ensureImage: () => {}, inspectImage: () => ({ Id: `sha256:${'d'.repeat(64)}`, Config: { User: '1000:1000' } }) });
    const create = [prepared.imageId]; assert.equal(create[0], `sha256:${'d'.repeat(64)}`);
});
test('MP.gb10-numeric-memory', () => {
    assert.equal(classifyGpuMemoryModel('NVIDIA GB10'), 'unified');
    assert.throws(() => parseMpsGpuObservation(`0, ${gpuUuid}, NVIDIA GB10, 131072, 595.91.07`), /Unified/);
    assert.equal(parseMpsGpuObservation(`0, ${gpuUuid}, NVIDIA GeForce RTX 4090, 24576, 595.91.07`).memoryModel, 'dedicated');
});
test('MP.unknown-model', () => {
    assert.equal(classifyGpuMemoryModel('Unknown model'), 'unknown');
    for (const name of ['Unknown model', 'NVIDIA futuristic 123']) assert.throws(() => parseMpsGpuObservation(`0, ${gpuUuid}, ${name}, 8192, 595.91.07`), /unknown/);
    assert.throws(() => parseMpsGpuObservation(`0, ${gpuUuid}, NVIDIA GeForce RTX 4090, N/A, 595.91.07`));
});
test('MP.control-readback', () => {
    const calls = [];
    const output = { get_default_active_thread_percentage: '25\n', 'get_default_device_pinned_mem_limit 0': '1024M\n', get_server_list: '12\n34\n' };
    const query = (binary, args, options) => { assert.equal(binary, MPS_TOOL_PATHS.control); assert.deepEqual(args, []); assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 8192); const command = options.input.trim(); calls.push(command); return { status: 0, stdout: output[command] || '', stderr: '' }; };
    assert.deepEqual(configureMpsDefaults({ smPercent: 25, memoryMiB: 1024 }, { uid: 1000, query, env: {}, verifyServer: (pid) => [12, 34].includes(pid) }), { smPercent: 25, memoryMiB: 1024 });
    assert.deepEqual(calls, ['set_default_active_thread_percentage 25', 'set_default_device_pinned_mem_limit 0 1024M', 'get_default_active_thread_percentage', 'get_default_device_pinned_mem_limit 0', 'get_server_list']);
});
test('MP.control-malformed', () => {
    for (const text of ['1024', '1024 MB', 'unlimited', '1024M extra', '0M', '1.5G', '9999999999999999G']) assert.throws(() => parseMpsMemoryReply(text));
    for (const text of ['0', '101', '25 percent', '1\n2']) assert.throws(() => parseMpsSmReply(text));
    for (const text of ['0', '12 abc', '-1', '999999999999']) assert.throws(() => parseMpsServerList(text));
    assert.throws(() => runMpsControl('quit\nget_server_list', { uid: 1000 }));
    assert.throws(() => runMpsControl('quit', { uid: 0 }));
});
test('MP.timeout', () => {
    for (const result of [{ status: null, error: { code: 'ETIMEDOUT' } }, { status: 0, signal: 'SIGTERM' }, { status: 1 }, { status: 0, truncated: true }, { status: 0, stdout: 'x'.repeat(8193) }]) assert.throws(() => runMpsControl('get_server_list', { uid: 1000, query: () => result }));
});

test('MPS daemon proof binds UID, process start, executable, core and private pipe identity', () => {
    const pipeDirectory = `/run/ploinky/mps/pipe-${'1'.repeat(32)}`;
    const state = { daemon: { pid: 12, startTime: '123', executableDev: 1, executableIno: 2 }, pipeDirectory, pipeIdentity: { dev: 10, ino: 20 } };
    let start = '123'; let owner = 1000; let inode = 20; let pidPresent = true; let alive = true;
    const fsApi = {
        realpathSync: (value) => value,
        lstatSync: () => ({ uid: 1000, dev: 10, ino: inode, mode: 0o40700, isSymbolicLink: () => false, isDirectory: () => true }),
        statSync: () => ({ dev: 1, ino: 2 }),
        readFileSync(target) {
            if (target.endsWith('/stat')) { if (!alive) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return `12 (nvidia-cuda-mps-control) S ${Array(18).fill('0').join(' ')} ${start}`; }
            if (target.endsWith('/status')) return `Uid:\t${owner}\t${owner}\t${owner}\t${owner}\n`;
            if (target.endsWith('/cgroup')) return '0::/ploinky/core\n';
            if (target.endsWith('/environ')) return Buffer.from(`CUDA_MPS_PIPE_DIRECTORY=${pipeDirectory}\0`);
            throw new Error(target);
        },
        openSync: () => { if (!pidPresent) throw Object.assign(new Error('pid absent'), { code: 'ENOENT' }); return 1; },
        fstatSync: () => ({ uid: 1000, size: 3, nlink: 1, isFile: () => true }),
        readSync: (_fd, buffer) => buffer.write('12\n'), closeSync: () => {},
    };
    const observe = () => observeOwnedMpsDaemon(state, { fsApi, uid: 1000 });
    assert.equal(observe().state, 'owned'); owner = 0; assert.equal(observe().state, 'foreign'); owner = 1000;
    inode = 21; assert.equal(observe().state, 'foreign'); inode = 20;
    pidPresent = false; assert.equal(observe().state, 'unknown'); pidPresent = true;
    start = '124'; assert.equal(observe().state, 'gone'); start = '123'; alive = false; assert.equal(observe().state, 'gone');
});

test('MPS quit exit zero waits for exact process termination and is bounded', () => {
    const state = { daemon: { pid: 12, startTime: '123' }, pipeDirectory: `/run/ploinky/mps/pipe-${'1'.repeat(32)}`, logDirectory: `/run/ploinky/mps/log-${'1'.repeat(32)}` };
    let clock = 0; let polls = 0; let terminate = true;
    const fsApi = { realpathSync: (value) => value, lstatSync: () => ({ uid: 1000, mode: 0o40700, isSymbolicLink: () => false, isDirectory: () => true }), readFileSync: () => { if (terminate && polls >= 2) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return `12 (mps) S ${Array(18).fill('0').join(' ')} 123`; } };
    const backend = createMpsDaemonBackend({ fsApi, uid: 1000, query: (_binary, args, options) => { assert.deepEqual(args, []); assert.equal(options.input, 'quit\n'); return { status: 0 }; }, observe: () => ({ state: 'owned' }), now: () => clock, wait: () => { polls += 1; clock += 10000; } });
    backend.stop(state); assert.equal(polls, 2);
    terminate = false; polls = 0; clock = 0; assert.throws(() => backend.stop(state), /did not terminate/);
});

test('MPS transition state is private, bounded, atomic and refuses substituted files', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-mps-state-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.chmodSync(root, 0o700);
    const fsApi = new Proxy(fs, { get(target, property) { if (['lstatSync', 'fstatSync'].includes(property)) return (...args) => { const result = target[property](...args); result.uid = 1000; return result; }; return target[property]; } });
    const store = createMpsStateStore({ root, fsApi, uid: 1000 });
    assert.equal(store.read(), null); store.write({ schema: 1, status: 'pending', pendingClients: [{ key: 'a' }] });
    assert.equal(store.read().pendingClients[0].key, 'a'); assert.equal(fs.statSync(path.join(root, 'state.json')).mode & 0o777, 0o600);
    assert.throws(() => store.write({ data: 'x'.repeat(65536) }), /bound/);
    const target = path.join(root, 'state.json'); fs.renameSync(target, path.join(root, 'kept.json')); fs.symlinkSync(path.join(root, 'kept.json'), target);
    assert.throws(() => store.read()); fs.unlinkSync(target); fs.linkSync(path.join(root, 'kept.json'), target); assert.throws(() => store.read(), /unsafe/);
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith('.state-')), false);
});

test('MPS interrupted startup recovers the exact daemon from its private PID receipt', () => {
    const pipeDirectory = `/run/ploinky/mps/pipe-${'1'.repeat(32)}`;
    const state = { daemon: null, pipeDirectory, pipeIdentity: { dev: 10, ino: 20 }, tools: { control: { dev: 1, ino: 2 } } };
    let pidPresent = true; let launcherPresent = false;
    const fsApi = {
        realpathSync: (value) => value,
        lstatSync: () => ({ uid: 1000, dev: 10, ino: 20, mode: 0o40700, isSymbolicLink: () => false, isDirectory: () => true }),
        statSync: () => ({ dev: 1, ino: 2 }),
        readFileSync(target) {
            if (target.endsWith('/stat')) return `12 (mps) S ${Array(18).fill('0').join(' ')} 123`;
            if (target.endsWith('/status')) return 'Uid:\t1000\t1000\t1000\t1000\n';
            if (target.endsWith('/cgroup')) return '0::/ploinky/core\n';
            if (target.endsWith('/environ')) return Buffer.from(`CUDA_MPS_PIPE_DIRECTORY=${pipeDirectory}\0`);
            throw new Error(target);
        },
        readdirSync: (target) => target === '/proc' ? launcherPresent ? ['12'] : [] : [`pipe-${'1'.repeat(32)}`, `log-${'1'.repeat(32)}`],
        openSync: () => { if (!pidPresent) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return 1; },
        fstatSync: () => ({ uid: 1000, size: 3, nlink: 1, isFile: () => true }), readSync: (_fd, buffer) => buffer.write('12\n'), closeSync: () => {},
    };
    const recovered = recoverMpsDaemonIdentity(state, { fsApi, uid: 1000 });
    assert.equal(recovered.state, 'owned'); assert.equal(recovered.daemon.startTime, '123');
    assert.equal(discoverOwnedMpsDaemon({ tools: state.tools, fsApi, uid: 1000 }).daemon.pid, 12);
    pidPresent = false; launcherPresent = true; assert.equal(recoverMpsDaemonIdentity(state, { fsApi, uid: 1000 }).state, 'unknown');
    launcherPresent = false; assert.equal(recoverMpsDaemonIdentity(state, { fsApi, uid: 1000 }).state, 'gone');
    assert.equal(recoverMpsDaemonIdentity({ ...state, tools: null }, { fsApi, uid: 1000 }).state, 'unknown');
});

test('MPS cleanup removes only terminated owned generations and rejects substituted entries', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-mps-cleanup-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pipeDirectory = path.join(root, `pipe-${'1'.repeat(32)}`), logDirectory = path.join(root, `log-${'1'.repeat(32)}`);
    for (const directory of [pipeDirectory, logDirectory]) fs.mkdirSync(directory, { mode: 0o700 });
    const identity = (target) => { const stat = fs.statSync(target); return { dev: stat.dev, ino: stat.ino }; };
    const state = { daemon: null, pipeDirectory, logDirectory, pipeIdentity: identity(pipeDirectory), logIdentity: identity(logDirectory), tools: { control: { dev: 1, ino: 2 } } };
    const fsApi = new Proxy(fs, { get(target, property) { if (['lstatSync', 'fstatSync'].includes(property)) return (...args) => { const value = target[property](...args); value.uid = 1000; return value; }; if (property === 'readdirSync') return (directory, ...args) => directory === '/proc' ? [] : target.readdirSync(directory, ...args); return target[property]; } });
    const foreign = path.join(root, 'foreign'); fs.writeFileSync(foreign, 'keep'); fs.symlinkSync(foreign, path.join(pipeDirectory, 'substituted'));
    assert.throws(() => cleanupMpsGeneration(state, { root, fsApi, uid: 1000 }), /unowned/); assert.equal(fs.readFileSync(foreign, 'utf8'), 'keep');
    fs.unlinkSync(path.join(pipeDirectory, 'substituted')); fs.writeFileSync(path.join(logDirectory, 'control.log'), 'owned');
    cleanupMpsGeneration(state, { root, fsApi, uid: 1000 }); assert.equal(fs.existsSync(pipeDirectory), false); assert.equal(fs.existsSync(logDirectory), false); assert.equal(fs.existsSync(foreign), true);
});

test('MP.stop-refuses-foreign-unknown-or-changed-daemon', () => {
    const state = { daemon: { pid: 12, startTime: '123' }, pipeDirectory: `/run/ploinky/mps/pipe-${'1'.repeat(32)}`, logDirectory: `/run/ploinky/mps/log-${'1'.repeat(32)}` };
    const fsApi = { realpathSync: (value) => value, lstatSync: () => ({ uid: 1000, mode: 0o40700, isSymbolicLink: () => false, isDirectory: () => true }), readFileSync: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } };
    for (const sequence of [['foreign'], ['unknown'], ['owned', 'foreign'], ['owned', 'unknown'], ['owned', 'gone']]) {
        const sent = [];
        let index = 0;
        const backend = createMpsDaemonBackend({ fsApi, uid: 1000, now: () => 0, wait: () => {},
            observe: () => ({ state: sequence[Math.min(index++, sequence.length - 1)] }),
            query: (_binary, _args, options) => { sent.push(options.input); return { status: 0 }; } });
        // A daemon that is not (or no longer) the exact owned one is never sent quit.
        assert.throws(() => backend.stop(state), /foreign or unknown|not live and owned/, sequence.join('>'));
        assert.deepEqual(sent, [], `${sequence.join('>')}: no control command reached a non-owned daemon`);
    }
    // A daemon proven gone needs no quit at all.
    const sent = [];
    createMpsDaemonBackend({ fsApi, uid: 1000, observe: () => ({ state: 'gone' }), query: (_b, _a, options) => { sent.push(options.input); return { status: 0 }; } }).stop(state);
    assert.deepEqual(sent, []);
});

// Plan §11.3 crash recovery: an interruption after generation cleanup removed
// the directories, but before the journal dropped their paths, recovers.
function cleanupBoundaryFixture(t, procEntries = {}) {
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-mps-boundary-')));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const fsApi = new Proxy(fs, { get(target, property) {
        if (['lstatSync', 'fstatSync', 'statSync'].includes(property)) return (file, ...args) => {
            const entry = typeof file === 'string' && Object.entries(procEntries).find(([prefix]) => file === `/proc/${prefix}/exe`);
            if (entry) return { dev: 1, ino: 2, isFile: () => true };
            const value = target[property](file, ...args); value.uid = 1000; return value;
        };
        if (property === 'readdirSync') return (directory, ...args) => directory === '/proc' ? Object.keys(procEntries) : target.readdirSync(directory, ...args);
        if (property === 'readFileSync') return (file, ...args) => {
            const match = typeof file === 'string' && /^\/proc\/(\d+)\/(environ|stat)$/.exec(file);
            if (match && procEntries[match[1]]) return match[2] === 'environ' ? Buffer.from(procEntries[match[1]]) : `${match[1]} (mps) S ${Array(18).fill('0').join(' ')} 1`;
            return target.readFileSync(file, ...args);
        };
        return target[property];
    } });
    const share = { smPercent: 25, memoryMiB: 1024, deviceUuid: gpuUuid, driverVersion: '595.91.07', wiringFingerprint: 'f'.repeat(64) };
    const generation = () => {
        const root = fs.mkdtempSync(path.join(scratch, 'root-')); fs.chmodSync(root, 0o700);
        const suffix = crypto.randomBytes(16).toString('hex');
        const pipeDirectory = path.join(root, `pipe-${suffix}`), logDirectory = path.join(root, `log-${suffix}`);
        for (const directory of [pipeDirectory, logDirectory]) { fs.mkdirSync(directory, { mode: 0o700 }); fs.chmodSync(directory, 0o700); }
        fs.writeFileSync(path.join(logDirectory, 'control.log'), 'owned');
        const id = (target) => { const stat = fs.lstatSync(target); return { dev: stat.dev, ino: stat.ino }; };
        const state = { schema: 1, status: 'transitioning', daemon: null, daemonGeneration: null, configurationGeneration: null, pipeDirectory, logDirectory,
            pipeIdentity: id(pipeDirectory), logIdentity: id(logDirectory), tools: { control: { dev: 1, ino: 2 }, server: { dev: 1, ino: 3 } }, serverDefault: share,
            oldClients: [], pendingClients: [], drainedClients: [], lastProblem: null };
        return { root, state, backend: createMpsDaemonBackend({ root, fsApi, uid: 1000 }) };
    };
    return { generation, share, fsApi };
}

test('MP.cleanup-journal-boundary-transition', async (t) => {
    const { runMpsTransition } = await import('../../cli/sandbox/hardwareLimits/mpsTransition.mjs');
    const { generation, share, fsApi } = cleanupBoundaryFixture(t);
    const { root, state, backend } = generation();
    assert.equal(backend.observe(state).state, 'gone');
    backend.cleanup(state);
    assert.equal(fs.existsSync(state.pipeDirectory) || fs.existsSync(state.logDirectory), false);
    // A3: the journaled paths no longer exist and no owned daemon is running.
    assert.equal(backend.observe(state).state, 'gone');
    // A5: repeating the exact cleanup is idempotent.
    assert.doesNotThrow(() => cleanupMpsGeneration(state, { root, fsApi, uid: 1000 }));
    // A4: the next transition proceeds from the journal instead of wedging.
    let journal = structuredClone(state);
    const store = { read: () => journal, write: (value) => { journal = structuredClone(value); } };
    const client = { key: 'k', ref: 'repo/gpu', alias: '', instanceId: 'i', enableGeneration: 'g', containerId: null, share };
    const started = { ...state, daemon: { pid: 9, startTime: '1' }, daemonGeneration: 'd1', configurationGeneration: 'c1', pipeDirectory: null, logDirectory: null, status: 'ready' };
    const fake = { ...backend, start: (_defaults, { onState }) => { onState(started); return started; }, verify: () => true };
    const result = runMpsTransition({ oldClients: [], desiredClients: [client], configuredPolicies: [{ share }], selectedKeys: ['k'], capability: {}, origin: 'cli' },
        { assertCapability: () => {}, store, backend: fake, drain: () => {}, recreate: () => ({ key: 'k', state: 'applied' }) });
    assert.equal(result.state.status, 'ready');
    // A crash after cleanup but before its journal write: the intent written
    // first already dropped the daemon, so a retry observes 'gone' and finishes.
    const second = generation();
    journal = { ...structuredClone(second.state), status: 'ready', daemon: null, daemonGeneration: 'd0', configurationGeneration: 'c0' };
    const crashing = { ...second.backend, cleanup: (value) => { second.backend.cleanup(value); throw new Error('process died after cleanup'); }, start: fake.start, verify: () => true };
    assert.throws(() => runMpsTransition({ oldClients: [], desiredClients: [client], configuredPolicies: [{ share }], selectedKeys: ['k'], capability: {}, origin: 'cli' },
        { assertCapability: () => {}, store, backend: crashing, drain: () => {}, recreate: () => ({ key: 'k', state: 'applied' }) }), /process died/);
    assert.equal(journal.daemon, null);
    assert.equal(journal.pipeDirectory, second.state.pipeDirectory, 'the journal still names the removed generation');
    assert.equal(second.backend.observe(journal).state, 'gone');
    const retried = runMpsTransition({ oldClients: [], desiredClients: [client], configuredPolicies: [{ share }], selectedKeys: ['k'], capability: {}, origin: 'cli' },
        { assertCapability: () => {}, store, backend: { ...second.backend, start: fake.start, verify: () => true }, drain: () => {}, recreate: () => ({ key: 'k', state: 'applied' }) });
    assert.equal(retried.state.status, 'ready');
});

test('MP.cleanup-journal-boundary-finalize', async (t) => {
    const { finalizeMpsGraph } = await import('../../cli/sandbox/hardwareLimits/mpsLifecycle.mjs');
    const { generation } = cleanupBoundaryFixture(t);
    const context = (revision) => () => ({ gate: 'on', overrides: new Map(), storeToken: { epoch: '0'.repeat(32), revision } });
    // B1/B2: a policy change after cleanup cannot strand the removed paths.
    {
        const { state, backend } = generation();
        let journal = { ...structuredClone(state), graphPrepared: true, graphNeedsTransition: true };
        const store = { read: () => journal, write: (value) => { journal = structuredClone(value); } };
        let calls = 0;
        const policyCheck = () => { calls += 1; if (calls >= 3) throw Object.assign(new Error('The hardware policy changed during reconciliation'), { code: 'revision_conflict' }); };
        await finalizeMpsGraph({ networkLifecycleCapability: {} }, { readContext: context(1), store, backend, assertCapability: () => {}, policyCheck });
        assert.equal(journal.pipeDirectory, null);
        assert.equal(journal.status, 'inactive');
        assert.equal(fs.existsSync(state.pipeDirectory), false);
    }
    // B3/B4: an interruption after cleanup recovers on the next finalize.
    {
        const { state, backend } = generation();
        let journal = { ...structuredClone(state), graphPrepared: true, graphNeedsTransition: true };
        const store = { read: () => journal, write: (value) => { journal = structuredClone(value); } };
        const crashing = { ...backend, cleanup: (value) => { backend.cleanup(value); throw new Error('process died after cleanup'); } };
        await assert.rejects(finalizeMpsGraph({ networkLifecycleCapability: {} }, { readContext: context(1), store, backend: crashing, assertCapability: () => {}, policyCheck: () => {} }), /process died/);
        assert.ok(journal.pipeDirectory);
        assert.equal(backend.observe(journal).state, 'gone');
        await finalizeMpsGraph({ networkLifecycleCapability: {} }, { readContext: context(2), store, backend, assertCapability: () => {}, policyCheck: () => {} });
        assert.equal(journal.pipeDirectory, null);
        assert.equal(journal.status, 'inactive');
    }
});

test('MP.missing-generation-directories-need-the-proc-scan', (t) => {
    // A live control process still bound to the removed pipe directory keeps
    // the generation unknown; missing directories alone never prove 'gone'.
    const entries = {};
    const { generation } = cleanupBoundaryFixture(t, entries);
    const { state, backend } = generation();
    fs.rmSync(state.pipeDirectory, { recursive: true }); fs.rmSync(state.logDirectory, { recursive: true });
    assert.equal(backend.observe(state).state, 'gone');
    entries['4242'] = `CUDA_MPS_PIPE_DIRECTORY=${state.pipeDirectory}\0`;
    assert.equal(backend.observe(state).state, 'unknown');
    delete entries['4242'];
    // A path outside the exact private generation stays unknown.
    assert.equal(backend.observe({ ...state, pipeDirectory: '/elsewhere/pipe-' + '1'.repeat(32) }).state, 'unknown');
    // A pipe directory that still exists but is unsafe stays unknown.
    fs.mkdirSync(state.pipeDirectory, { mode: 0o755 }); fs.chmodSync(state.pipeDirectory, 0o755);
    assert.equal(backend.observe(state).state, 'unknown');
});
