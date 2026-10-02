// W5: the refusals of the MPS verification and ownership proofs keep their reasons. Every case below changes no decision
// (the daemon is still not owned, not verified, or the directory still unsafe); it names what differed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMpsDaemonBackend, createMpsStateStore, inspectOwnedMpsServer, observeOwnedMpsDaemon, verifyDetail } from '../../cli/sandbox/hardwareLimits/mps.mjs';
import { createMpsLaunch, verifyMpsLaunch } from '../../cli/sandbox/hardwareLimits/mpsLaunch.mjs';
import { runMpsTransition } from '../../cli/sandbox/hardwareLimits/mpsTransition.mjs';

const pipeDirectory = `/run/ploinky/mps/pipe-${'1'.repeat(32)}`;
const logDirectory = `/run/ploinky/mps/log-${'1'.repeat(32)}`;
const baseState = () => ({ daemon: { pid: 12, startTime: '123', executableDev: 1, executableIno: 2 }, pipeDirectory, logDirectory, pipeIdentity: { dev: 10, ino: 20 }, serverDefault: { smPercent: 25, memoryMiB: 1024 }, tools: { server: { dev: 5, ino: 6 } } });

// A /proc and a directory the tests bend one fact at a time.
function host(change = {}) {
    const facts = { start: '123', zombie: false, uid: 1000, cgroup: '0::/ploinky/core', exe: { dev: 1, ino: 2 }, environ: `CUDA_MPS_PIPE_DIRECTORY=${pipeDirectory}\0`, pidFile: '12\n', dir: { uid: 1000, mode: 0o40700, dev: 10, ino: 20, link: false, directory: true }, real: pipeDirectory, errno: {}, ...change };
    const fail = (code, name) => Object.assign(new Error(`${code} ${name}`), { code });
    const fsApi = {
        realpathSync: value => (value === pipeDirectory ? facts.real : value),
        lstatSync: () => { if (facts.errno.lstat) throw fail(facts.errno.lstat, 'lstat'); return { uid: facts.dir.uid, dev: facts.dir.dev, ino: facts.dir.ino, mode: facts.dir.mode, isSymbolicLink: () => facts.dir.link, isDirectory: () => facts.dir.directory }; },
        statSync: target => { if (facts.errno.exe) throw fail(facts.errno.exe, target); return target.includes('/99/') ? facts.server ?? { dev: 5, ino: 6 } : facts.exe; },
        readFileSync(target) {
            const kind = target.split('/').at(-1);
            if (facts.errno[kind]) throw fail(facts.errno[kind], target);
            if (kind === 'stat') return `12 (nvidia-cuda-mps) ${facts.zombie ? 'Z' : 'S'} ${Array(18).fill('0').join(' ')} ${facts.start}`;
            if (kind === 'status') return `Uid:\t${facts.uid}\t${facts.uid}\t${facts.uid}\t${facts.uid}\n`;
            if (kind === 'cgroup') return `${facts.cgroup}\n`;
            if (kind === 'environ') return Buffer.from(facts.environ);
            throw fail('ENOENT', target);
        },
        openSync: () => 1, closeSync: () => {},
        fstatSync: () => ({ uid: facts.file?.uid ?? 1000, size: facts.file?.size ?? 3, nlink: facts.file?.nlink ?? 1, mode: facts.file?.mode ?? 0o100600, isFile: () => facts.file?.regular ?? true }),
        readSync: (_fd, buffer) => buffer.write(facts.pidFile),
    };
    return { facts, fsApi };
}
const owner = change => { const h = host(change); return observeOwnedMpsDaemon(baseState(), { fsApi: h.fsApi, uid: 1000 }); };

test('W5.the-ownership-proof-names-what-differed-for-every-refusal', () => {
    assert.deepEqual({ ...owner({}) }.state, 'owned');
    const cases = [
        ['gone', { zombie: true }, /the process is a zombie/],
        ['gone', { start: '124' }, /the pid now has start time 124, not 123/],
        ['foreign', { dir: { uid: 1000, mode: 0o40700, dev: 10, ino: 21, link: false, directory: true } }, /pipe directory is not the journaled one/],
        ['foreign', { uid: 0 }, /Uid line is 0 0 0 0, not 1000/],
        ['foreign', { exe: { dev: 1, ino: 3 } }, /not the journaled MPS control binary/],
        ['foreign', { cgroup: '0::/ploinky/agents/x' }, /cgroup is 0::\/ploinky\/agents\/x, not 0::\/ploinky\/core/],
        ['foreign', { environ: 'PATH=/bin\0' }, /does not name the private pipe directory/],
        ['foreign', { environ: 'x'.repeat(9000) }, /environment is 9000 bytes, over 8192/],
        ['foreign', { pidFile: '13\n' }, /pid file says 13, not 12/],
        ['unknown', { errno: { environ: 'EACCES' } }, /EACCES while reading \/proc\/12\/environ/],
        ['unknown', { errno: { status: 'EPERM' } }, /EPERM while reading \/proc\/12\/status/],
        ['unknown', { errno: { exe: 'EACCES' } }, /EACCES while reading \/proc\/12\/exe/],
        ['gone', { errno: { stat: 'ENOENT' } }, /ENOENT while reading \/proc\/12\/stat/],
    ];
    for (const [verdict, change, pattern] of cases) { const result = owner(change); assert.equal(result.state, verdict, JSON.stringify(change)); assert.match(result.reason, pattern, JSON.stringify(change)); assert.ok(result.reason.length <= 200); }
    assert.equal(observeOwnedMpsDaemon({ daemon: null }, { fsApi: host().fsApi, uid: 1000 }).reason, 'the journal names no valid daemon pid and start time');
});

test('W5.an-unsafe-private-directory-names-uid-mode-link-or-realpath', () => {
    const verify = change => { const h = host(change); return createMpsDaemonBackend({ fsApi: h.fsApi, uid: 1000, observe: () => ({ state: 'owned' }) }).verifyReason(baseState()); };
    const directory = (extra) => ({ uid: 1000, mode: 0o40700, dev: 10, ino: 20, link: false, directory: true, ...extra });
    for (const [change, pattern] of [
        [{ dir: directory({ uid: 0 }) }, /directories: MPS directory ownership or mode is unsafe \(\/run\/ploinky\/mps: uid 0 \(expected 1000\)\)/],
        [{ dir: directory({ mode: 0o40755 }) }, /mode 755 \(expected 700\)/],
        [{ dir: directory({ link: true }) }, /a symbolic link/],
        [{ dir: directory({ directory: false }) }, /not a directory/],
        [{ real: '/elsewhere/pipe' }, /realpath \/elsewhere\/pipe/],
    ]) { const result = verify(change); assert.equal(result.ok, false); assert.match(result.reason, pattern, JSON.stringify(change)); }
});

test('W5.an-unsafe-state-or-pid-file-names-what-differed', () => {
    const read = file => { const h = host({ file }); return () => createMpsStateStore({ root: '/run/ploinky/mps', fsApi: { ...h.fsApi, lstatSync: () => ({ uid: 1000, mode: 0o40700, isSymbolicLink: () => false, isDirectory: () => true }) }, uid: 1000 }).read(); };
    for (const [file, pattern] of [
        [{ uid: 0 }, /MPS state file is unsafe \(state\.json: uid 0 \(expected 1000\)\)/], [{ mode: 0o100644 }, /mode 644 \(expected 600\)/], [{ nlink: 2 }, /2 links/],
        [{ regular: false }, /not a regular file/], [{ size: 70000 }, /size 70000 over 65536/],
    ]) assert.throws(read(file), pattern, JSON.stringify(file));
});

test('W5.an-owned-server-check-names-what-differed', () => {
    const server = change => { const h = host(change); return inspectOwnedMpsServer(baseState(), 99, { fsApi: h.fsApi, uid: 1000 }); };
    assert.deepEqual({ ...server({}) }, { owned: true, reason: null });
    for (const [change, pattern] of [
        [{ uid: 0 }, /Uid line is 0 0 0 0, not 1000/], [{ server: { dev: 5, ino: 7 } }, /not the journaled MPS server tool/], [{ cgroup: '0::/' }, /cgroup is 0::\/, not/],
        [{ environ: 'A=b\0' }, /does not name the private pipe directory/], [{ errno: { environ: 'EACCES' } }, /EACCES while reading \/proc\/99\/environ/],
    ]) { const result = server(change); assert.equal(result.owned, false); assert.match(result.reason, pattern, JSON.stringify(change)); }
    assert.equal(inspectOwnedMpsServer({ ...baseState(), tools: {} }, 99, { fsApi: host().fsApi, uid: 1000 }).owned, false);
});

test('W5.verify-keeps-its-boolean-and-reports-the-failing-step-and-reply', () => {
    const query = replies => (_binary, _args, options) => ({ status: 0, stdout: replies[String(options.input).trim()] ?? '', stderr: '' });
    const good = { get_default_active_thread_percentage: '25\n', 'get_default_device_pinned_mem_limit 0': '1024M\n', get_server_list: '' };
    const backend = (replies, change = {}, observe = () => ({ state: 'owned' })) => createMpsDaemonBackend({ fsApi: host(change).fsApi, uid: 1000, observe, query: query(replies) });
    const state = baseState();
    assert.deepEqual({ ...backend(good).verifyReason(state) }, { ok: true, reason: null }); assert.equal(backend(good).verify(state), true);
    for (const [replies, pattern] of [
        [{ ...good, get_default_active_thread_percentage: '25 %\n' }, /^sm readback: Unsupported MPS SM default reply \(reply: "25 %\\n"\)/],
        [{ ...good, 'get_default_device_pinned_mem_limit 0': '1024 MB\n' }, /^memory readback: Unsupported MPS device-memory default reply \(reply: "1024 MB\\n"\)/],
        [{ ...good, get_server_list: 'abc\n' }, /^server list: Unsupported MPS server-list reply \(reply: "abc\\n"\)/],
        [{ ...good, get_default_active_thread_percentage: '50\n' }, /^sm readback 50, not the saved 25/],
        [{ ...good, 'get_default_device_pinned_mem_limit 0': '2G\n' }, /^memory readback 2147483648 bytes, not the saved 1073741824/],
        [{ ...good, get_server_list: '99\n' }, /^server 99 is not an owned MPS server \(the environment does not name the private pipe directory\)/],
    ]) { const result = backend(replies, { environ: 'A=b\0' }).verifyReason(state); assert.equal(result.ok, false); assert.match(result.reason, pattern); assert.equal(backend(replies, { environ: 'A=b\0' }).verify(state), false); }
    const foreign = backend(good, {}, () => ({ state: 'foreign', reason: 'the pid file says 13, not 12' })).verifyReason(state);
    assert.deepEqual({ ...foreign }, { ok: false, reason: 'ownership: foreign (the pid file says 13, not 12)' });
    assert.deepEqual({ ...verifyDetail({ verify: () => false }, state) }, { ok: false, reason: null }, 'a backend that only decides gives no reason');
    // The decision is verify's even when a caller replaced it on a copy of the real backend.
    const real = backend({ ...good, get_default_active_thread_percentage: '50\n' });
    assert.deepEqual({ ...verifyDetail({ ...real, verify: () => true }, state) }, { ok: true, reason: null });
    assert.equal(verifyDetail(real, state).reason, 'sm readback 50, not the saved 25');
});

test('W5.the-callers-pass-the-reason-into-their-typed-errors', () => {
    const state = baseState();
    const detailed = { observe: () => ({ state: 'owned', daemon: state.daemon }), verify: () => false, verifyReason: () => ({ ok: false, reason: 'sm readback 50, not the saved 25' }), stop() {}, start: () => ({ ...state, status: 'ready' }), cleanup() {} };
    // The transition: a daemon that lost its defaults before a client is created.
    const run = (backend) => runMpsTransition({ oldClients: [], desiredClients: [{ key: 'a', ref: 'demo/a', instanceId: 'i', enableGeneration: 'g', share: { smPercent: 25, memoryMiB: 1024 } }], configuredPolicies: [{ share: { smPercent: 25, memoryMiB: 1024, deviceUuid: 'u', driverVersion: 'd', wiringFingerprint: 'w' } }], selectedKeys: ['a'], capability: {}, state: { ...state, status: 'ready', pendingClients: [], oldClients: [] } },
        { assertCapability: () => {}, store: { read: () => ({ ...state, status: 'ready', pendingClients: [] }), write: () => {} }, backend, drain: () => {}, recreate: () => ({ key: 'a', state: 'applied' }), tools: {} });
    assert.throws(() => run(detailed), error => /MPS daemon lost its verified defaults before client create \(sm readback 50, not the saved 25\)/.test(error.message));
    // The launch capability: every named check, and the daemon's own reason.
    const share = { smPercent: 25, memoryMiB: 1024, deviceUuid: 'u', driverVersion: 'd', wiringFingerprint: 'w' };
    const launchState = { status: 'ready', daemonGeneration: 'g1', configurationGeneration: 'c1', pipeDirectory, serverDefault: { ...share } };
    const capability = createMpsLaunch({ key: 'a', share, state: launchState, imageId: 'a'.repeat(64) });
    const store = value => ({ read: () => value });
    assert.throws(() => verifyMpsLaunch(capability, 'a', share, { store: store(null), backend: detailed }), /changed before runtime admission \(the MPS state is gone\)/);
    assert.throws(() => verifyMpsLaunch(capability, 'a', share, { store: store({ ...launchState, daemonGeneration: 'g2' }), backend: detailed }), /\(the daemon generation changed\)/);
    assert.throws(() => verifyMpsLaunch(capability, 'a', share, { store: store({ ...launchState, pipeDirectory: `${pipeDirectory}x` }), backend: detailed }), /\(the private pipe directory changed\)/);
    assert.throws(() => verifyMpsLaunch(capability, 'a', share, { store: store({ ...launchState }), backend: detailed }), /\(the daemon no longer verifies: sm readback 50, not the saved 25\)/);
    assert.equal(verifyMpsLaunch(capability, 'a', share, { store: store({ ...launchState }), backend: { verify: () => true } }).key, 'a');
});
