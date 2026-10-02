// W2: every readback of the MPS daemon is conclusive. A reply the product does not understand is refused (the memory
// grammar stays strict), and the reply itself, sanitized and bounded, is in the error, in the Apply cause, in the MPS
// journal's lastProblem and in its lastReadback. The daemon is a fake at the process boundary; the file system, the
// control channel and the whole of Apply, the MPS lifecycle and the backend's start are the product's own code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyHardwareLimits } from '../../cli/sandbox/hardwareLimits/reconcile.mjs';
import { coordinateMpsLifecycle } from '../../cli/sandbox/hardwareLimits/mpsLifecycle.mjs';
import { readMpsLaunch } from '../../cli/sandbox/hardwareLimits/mpsLaunch.mjs';
import { createMpsDaemonBackend, parseMpsMemoryReply, parseMpsServerList, parseMpsSmReply, runMpsControl } from '../../cli/sandbox/hardwareLimits/mps.mjs';
import { replyExcerpt } from '../../cli/sandbox/hardwareLimits/applyCause.mjs';
import { describeMpsTool, MPS_TOOL_PATHS } from '../../ploinky-box/lib/mpsTools.mjs';

const token = { epoch: 'e'.repeat(32), revision: 1 };
const imageId = 'a'.repeat(64);
const share = { smPercent: 25, vramPercent: 17, vramMiB: 1024, memoryMiB: 1024, memoryBytes: 1024 ** 3, deviceUuid: 'GPU-fixture', driverVersion: '550.1', wiringFingerprint: 'wiring' };
const clone = value => structuredClone(value);

// The tools, the private directories, the daemon's PID file and /proc entry, as the Box shows them.
function fakeHost() {
    const content = { control: Buffer.from('control-v1'), server: Buffer.from('server-v1') };
    const nameOf = file => (String(file).endsWith('.pid') ? 'pid' : String(file).endsWith('control') ? 'control' : 'server');
    const dir = { uid: 1000, mode: 0o40700, dev: 1, ino: 2, isSymbolicLink: () => false, isDirectory: () => true };
    const fsApi = {
        realpathSync: file => file, openSync: file => nameOf(file), accessSync: () => {}, closeSync: () => {}, mkdirSync: () => {}, readdirSync: () => [], lstatSync: () => dir,
        fstatSync: fd => (fd === 'pid' ? { isFile: () => true, nlink: 1, uid: 1000, size: 4, mode: 0o100600 } : { isFile: () => true, nlink: 1, size: content[fd].length, dev: 7, ino: fd === 'control' ? 10 : 11, mtimeMs: 5, ctimeMs: 5 }),
        readSync: (fd, buffer, offset, length, position) => { if (fd === 'pid') return buffer.write('777\n', offset); const read = Math.min(length, content[fd].length - position); content[fd].copy(buffer, offset, position, position + read); return read; },
        readFileSync: file => { if (file === '/proc/self/cgroup') return '0::/ploinky/core\n'; if (file === '/proc/777/stat') return `777 (nvidia-cuda-mps) S ${Array(18).fill('0').join(' ')} 4242`; throw Object.assign(new Error(`no ${file}`), { code: 'ENOENT' }); },
    };
    const descriptors = { control: describeMpsTool(MPS_TOOL_PATHS.control, MPS_TOOL_PATHS.control, { fsApi }), server: describeMpsTool(MPS_TOOL_PATHS.server, MPS_TOOL_PATHS.server, { fsApi }) };
    fsApi.statSync = file => (file === '/proc/777/exe' ? { dev: descriptors.control.dev, ino: descriptors.control.ino } : { dev: 1, ino: 1 });
    return { fsApi, descriptors };
}

// One Apply of the first share, with the real lifecycle and a real backend start over the fake host. `replies` are the
// daemon's answers to the three queries.
function world({ replies = {} } = {}) {
    const host = fakeHost();
    const queries = [];
    const query = (_binary, args, options) => {
        if (args[0] === '-d') return { status: 0 };
        const command = String(options.input).trim(); queries.push(command);
        const reply = command === 'get_default_active_thread_percentage' ? replies.sm ?? '25\n' : command === 'get_default_device_pinned_mem_limit 0' ? replies.memory ?? '1024M\n' : command === 'get_server_list' ? replies.servers ?? '' : '';
        return { status: 0, stdout: reply, stderr: '' };
    };
    // The 30 s deadline passes during the wait after the first refused attempt (the usual way the retries end).
    let clock = 0;
    const backend = createMpsDaemonBackend({ fsApi: host.fsApi, uid: 1000, query, observe: () => ({ state: 'owned' }), now: () => clock, wait: () => { clock += 40_000; } });
    const record = { type: 'agent', repoName: 'demo', agentName: 'a', instanceId: 'i-a', enableGeneration: 'g-a', containerId: 'b'.repeat(64) };
    const registry = { a: record };
    let state = null;
    const dependencies = {
        observeClients: () => [], readContext: () => ({ storeToken: token, overrides: new Map([['demo/a', { gpu: share }]]), gpu: { eligible: true, grant: { mps: host.descriptors } } }),
        loadRegistry: () => registry, readApplied: () => null,
        loadPlan: () => ({ runtime: 'podman', manifest: {}, profile: { network: { mode: 'default' } }, image: 'prepared:tag' }),
        prepareImage: () => {}, inspectImage: () => ({ Id: imageId, Config: { User: '1000:1000' } }), resolveShare: policy => policy, policyCheck: () => {},
        store: { read: () => clone(state), write: value => { state = clone(value); } }, backend,
        network: async fn => fn({}), assertCapability: () => {}, drainClient: async () => {},
    };
    const launchTarget = async next => { readMpsLaunch(next.mpsLaunch, 'a', share); return { containerName: 'a', containerId: 'c'.repeat(64) }; };
    const apply = () => applyHardwareLimits({ expectedToken: token, containers: ['a'] }, {
        lease: (_options, callback) => callback(), loadRegistry: () => clone(registry), loadRouting: () => ({ routes: {} }), readPolicy: () => ({ token }), policyCheck: () => {},
        loadPlan: () => ({}), isUnchanged: () => false,
        reconcile: (instance, options) => coordinateMpsLifecycle({ target: { key: instance.key, record: clone(registry[instance.key]) }, options: { onMpsPlan: options.onMpsPlan, onMpsResult: options.onMpsResult }, launchTarget }, dependencies),
    });
    return { apply, queries, get state() { return state; } };
}

test('W2.an-unsupported-memory-reply-fails-closed-and-its-sanitized-text-reaches-the-error-the-cause-the-journal-and-the-readback', async () => {
    const w = world({ replies: { sm: '25.0\n', memory: '1024 MB\n' } });
    const result = await w.apply();
    // Fails closed: no ready daemon, no client launched.
    assert.equal(result.ok, false); assert.equal(result.status, 422, JSON.stringify(result));
    assert.equal(result.results[0].state, 'refused');
    // The reply is in the refusal's reason, in the Apply cause (step and message) and in the journal.
    assert.match(result.results[0].problem.reason, /MPS daemon readiness failed at set defaults: Unsupported MPS device-memory default reply \(reply: "1024 MB\\n"\)/);
    assert.equal(result.results[0].cause.step, 'set-defaults');
    assert.match(result.results[0].cause.message, /Unsupported MPS device-memory default reply \(reply: "1024 MB\\n"\)/);
    assert.match(w.state.lastProblem.cause.message, /reply: "1024 MB\\n"/);
    assert.equal(w.state.lastProblem.cause.step, 'set-defaults');
    // lastReadback holds the replies the daemon really gave, as far as they went (the SM form was accepted: 25.0).
    assert.deepEqual({ sm: w.state.lastReadback.sm, memory: w.state.lastReadback.memory, servers: w.state.lastReadback.servers }, { sm: '25.0\\n', memory: '1024 MB\\n', servers: undefined });
    assert.ok(Number.isSafeInteger(w.state.lastReadback.at));
});

test('W2.a-reply-with-control-bytes-and-two-hundred-characters-is-sanitized-and-truncated-everywhere', async () => {
    const hostile = `\u0007\u0000é line one\nline two ${'x'.repeat(200)}`;
    const w = world({ replies: { sm: `${hostile}\n` } });
    const result = await w.apply();
    const reason = result.results[0].problem.reason;
    const excerpt = /reply: "([^"]*)"\)/.exec(reason)?.[1];
    assert.ok(excerpt, reason);
    // The transport refuses non-ASCII replies; the excerpt is printable ASCII, a newline shown as \n, at most 64 bytes.
    assert.match(reason, /MPS control reply is not ASCII \(reply: /);
    assert.ok(/^[\x20-\x7e]*$/.test(excerpt) && Buffer.byteLength(excerpt) <= 64, JSON.stringify(excerpt));
    assert.ok(excerpt.startsWith('??? line one\\nline two xxxx'), excerpt);
    assert.equal(w.state.lastReadback.sm.length <= 64 && /^[\x20-\x7e]*$/.test(w.state.lastReadback.sm), true, JSON.stringify(w.state.lastReadback));
    assert.ok(w.state.lastReadback.sm.startsWith('??? line one\\nline two'), w.state.lastReadback.sm);
    assert.equal(JSON.stringify(result).includes('\u0007'), false);
});

test('W2.a-successful-readback-is-journaled-too-the-captured-fixture', async () => {
    const w = world({ replies: { sm: '25.0\n', memory: '1024M\n', servers: '' } });
    const result = await w.apply();
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual({ sm: w.state.lastReadback.sm, memory: w.state.lastReadback.memory, servers: w.state.lastReadback.servers }, { sm: '25.0\\n', memory: '1024M\\n', servers: '' });
});

test('W2.every-reply-parse-error-carries-the-sanitized-reply-and-the-grammar-stays-strict', () => {
    assert.throws(() => parseMpsSmReply('25 %'), /Unsupported MPS SM default reply \(reply: "25 %"\)/);
    assert.throws(() => parseMpsMemoryReply('1024 MB'), /Unsupported MPS device-memory default reply \(reply: "1024 MB"\)/);
    assert.throws(() => parseMpsServerList('12\nabc'), /Unsupported MPS server-list reply \(reply: "12\\nabc"\)/);
    // No guessed forms: these stay refused.
    for (const text of ['1024', '1024 M', '1.5G', '1024MiB', 'unlimited', '0', '1024m', '10G\n10G']) assert.throws(() => parseMpsMemoryReply(text), /Unsupported MPS device-memory default reply/, text);
    assert.equal(parseMpsMemoryReply('1024M'), 1024 * 1048576); assert.equal(parseMpsMemoryReply('2G'), 2 * 1073741824);
    assert.throws(() => runMpsControl('get_server_list', { uid: 1000, env: {}, query: () => ({ status: 0, stdout: 'café', stderr: '' }) }), error => error.reply === 'café' && /not ASCII \(reply: "caf\?"\)/.test(error.message));
    // The excerpt itself.
    assert.equal(replyExcerpt('a\r\nb'), 'a\\nb'); assert.equal(replyExcerpt('x'.repeat(500)).length, 64); assert.equal(replyExcerpt(undefined), '');
    assert.equal(replyExcerpt('token=hunter2'), 'token=[REDACTED]');
});

// F1: the readiness retries end on the 30 s deadline wherever it lands. The clock advances on every control call (stepMs),
// so the deadline falls between two calls of an attempt, often before the memory query, and the attempt then ends on a bare
// "exceeded its deadline". The last refused reply must still be in the final error, the Apply step and the journal.
function startWithStep(stepMs, memoryReply) {
    const host = fakeHost();
    let clock = 0;
    const query = (_binary, args, options) => {
        if (args[0] === '-d') return { status: 0 };
        clock += stepMs;
        const command = String(options.input).trim();
        return { status: 0, stdout: command === 'get_default_active_thread_percentage' ? '25\n' : command === 'get_default_device_pinned_mem_limit 0' ? memoryReply : '', stderr: '' };
    };
    let saved = null;
    const backend = createMpsDaemonBackend({ fsApi: host.fsApi, uid: 1000, query, observe: () => ({ state: 'owned' }), now: () => clock, wait: ms => { clock += ms; } });
    try { backend.start({ smPercent: 25, memoryMiB: 1024 }, { tools: host.descriptors, onState: state => { saved = structuredClone(state); } }); return { ok: true }; }
    catch (error) { return { message: error.message, step: error.applyStep, journaled: saved?.lastReadback?.memory ?? null }; }
}

test('F1.the-final-readiness-error-keeps-the-last-refused-reply-wherever-the-deadline-lands', () => {
    const lost = [];
    let deadlineEnded = 0;
    for (let step = 1; step <= 60; step += 1) {
        const result = startWithStep(step, '1024 MB\n');
        if (/exceeded its deadline/.test(result.message)) deadlineEnded += 1;
        if (!/reply: "1024 MB\\n"/.test(result.message) || result.step !== 'set-defaults' && result.step !== 'daemon-start' || result.journaled !== '1024 MB\\n') lost.push({ step, ...result });
    }
    assert.deepEqual(lost, []);
    assert.ok(deadlineEnded > 10, `the sweep must include runs that end on the bare deadline (${deadlineEnded})`);
    // A run that ended on the deadline names both causes; a run refused by the reply alone is unchanged.
    const both = startWithStep(1000, '1024 MB\n');
    assert.match(both.message, /exceeded its deadline; last refused reply \(set defaults\): Unsupported MPS device-memory default reply \(reply: "1024 MB\\n"\)/);
});

test('F1.a-deadline-with-no-refused-reply-is-reported-as-the-deadline-alone', () => {
    const result = startWithStep(100_000, '1024M\n');
    assert.match(result.message, /exceeded its deadline/);
    assert.doesNotMatch(result.message, /last refused reply/);
});
