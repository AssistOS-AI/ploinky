// W2: every readback of the MPS daemon is conclusive. A reply the product does not understand is refused (the memory
// grammar stays strict), and the reply itself, sanitized and bounded, is in the error, in the Apply cause, in the MPS
// journal's lastProblem and in its lastReadback. The daemon is a fake at the process boundary; the file system, the
// control channel and the whole of Apply, the MPS lifecycle and the backend's start are the product's own code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyHardwareLimits } from '../../cli/sandbox/hardwareLimits/reconcile.mjs';
import { coordinateMpsLifecycle } from '../../cli/sandbox/hardwareLimits/mpsLifecycle.mjs';
import { readMpsLaunch } from '../../cli/sandbox/hardwareLimits/mpsLaunch.mjs';
import { configureMpsDefaults, createMpsDaemonBackend, mpsClientArgs, mpsClientEnvironment, mpsServerDefaultMemoryMiB, parseMpsMemoryReply, parseMpsServerList, parseMpsSmReply, runMpsControl, validateMpsServerDefault } from '../../cli/sandbox/hardwareLimits/mps.mjs';
import { resolveMpsServerDefault } from '../../cli/sandbox/hardwareLimits/mpsTransition.mjs';
import { classifyMpsReply } from '../hardware-limits/liveGpuCommands.mjs';
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
function world({ replies = {}, share: desired = share, display = null } = {}) {
    const host = fakeHost();
    const queries = [];
    let setMemory = null;
    const query = (_binary, args, options) => {
        if (args[0] === '-d') return { status: 0 };
        const command = String(options.input).trim(); queries.push(command);
        const set = /^set_default_device_pinned_mem_limit 0 (\d+)M$/.exec(command); if (set) setMemory = Number(set[1]);
        // The observed display of the driver (595.91.07): a limit of at least 1 GiB is shown as floor(MiB/1024)G.
        const shown = display === 'floor-gib' && setMemory !== null ? (setMemory >= 1024 ? `${Math.floor(setMemory / 1024)}G\n` : `${setMemory}M\n`) : null;
        const reply = command === 'get_default_active_thread_percentage' ? replies.sm ?? `${desired.smPercent}\n` : command === 'get_default_device_pinned_mem_limit 0' ? replies.memory ?? shown ?? '1024M\n' : command === 'get_server_list' ? replies.servers ?? '' : '';
        return { status: 0, stdout: reply, stderr: '' };
    };
    // The 30 s deadline passes during the wait after the first refused attempt (the usual way the retries end).
    let clock = 0;
    const backend = createMpsDaemonBackend({ fsApi: host.fsApi, uid: 1000, query, observe: () => ({ state: 'owned' }), now: () => clock, wait: () => { clock += 40_000; } });
    const record = { type: 'agent', repoName: 'demo', agentName: 'a', instanceId: 'i-a', enableGeneration: 'g-a', containerId: 'b'.repeat(64) };
    const registry = { a: record };
    let state = null;
    const dependencies = {
        observeClients: () => [], readContext: () => ({ storeToken: token, overrides: new Map([['demo/a', { gpu: desired }]]), gpu: { eligible: true, grant: { mps: host.descriptors } } }),
        loadRegistry: () => registry, readApplied: () => null,
        loadPlan: () => ({ runtime: 'podman', manifest: {}, profile: { network: { mode: 'default' } }, image: 'prepared:tag' }),
        prepareImage: () => {}, inspectImage: () => ({ Id: imageId, Config: { User: '1000:1000' } }), resolveShare: policy => policy, policyCheck: () => {},
        store: { read: () => clone(state), write: value => { state = clone(value); } }, backend,
        network: async fn => fn({}), assertCapability: () => {}, drainClient: async () => {},
    };
    const launched = [];
    const launchTarget = async next => { const launch = readMpsLaunch(next.mpsLaunch, 'a', desired); launched.push({ args: mpsClientArgs(desired, launch.state), state: launch.state }); return { containerName: 'a', containerId: 'c'.repeat(64) }; };
    const apply = () => applyHardwareLimits({ expectedToken: token, containers: ['a'] }, {
        lease: (_options, callback) => callback(), loadRegistry: () => clone(registry), loadRouting: () => ({ routes: {} }), readPolicy: () => ({ token }), policyCheck: () => {},
        loadPlan: () => ({}), isUnchanged: () => false,
        reconcile: (instance, options) => coordinateMpsLifecycle({ target: { key: instance.key, record: clone(registry[instance.key]) }, options: { onMpsPlan: options.onMpsPlan, onMpsResult: options.onMpsResult }, launchTarget }, dependencies),
    });
    return { apply, queries, launched, get state() { return state; } };
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
    // The shared sanitizer removes the control bytes (they are not shown as `?`); the non-ASCII letter and the newline are shown as `?` and `\\n`.
    assert.ok(excerpt.startsWith('? line one\\nline two xxxx'), excerpt);
    assert.equal(w.state.lastReadback.sm.length <= 64 && /^[\x20-\x7e]*$/.test(w.state.lastReadback.sm), true, JSON.stringify(w.state.lastReadback));
    assert.ok(w.state.lastReadback.sm.startsWith('? line one\\nline two'), w.state.lastReadback.sm);
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

// V1/V2 (amendment A6): the daemon-wide memory default is a whole GiB. The driver reports its memory default in whole GiB
// and is lossy below that. LIVE-P1 attempt 5 captured it: the default 1044M read back as 1G.
// Provenance of the pinned fixture: driver 595.91.07, RTX 3060 Laptop (6144 MiB), 2026-10-03, run id
// 12ef3818df01c980cbe4caa4dd530493; control.log "get_default_active_thread_percentage" -> "25.0", "get_default_device_pinned_mem_limit 0" -> "1G".
const CAPTURED = Object.freeze({ driver: '595.91.07', runId: '12ef3818df01c980cbe4caa4dd530493', sm: '25.0\n', memory: '1G\n' });
const share17 = { smPercent: 25, vramPercent: 17, vramMiB: 1044, memoryMiB: 1044, memoryBytes: 1044 * 1048576, deviceUuid: 'GPU-fixture', driverVersion: CAPTURED.driver, wiringFingerprint: 'wiring' };
const policies = (...shares) => shares.map(entry => ({ share: entry }));

test('V1.the-server-default-memory-is-the-largest-share-rounded-up-to-a-whole-gib-and-keeps-the-share-it-came-from', () => {
    for (const [share, whole] of [[512, 1024], [1023, 1024], [1024, 1024], [1025, 2048], [1044, 2048], [2048, 2048], [2088, 3072], [6144, 6144]]) assert.equal(mpsServerDefaultMemoryMiB(share), whole, String(share));
    for (const bad of [0, -1, 1.5, NaN, Infinity, '1024', null, undefined, Number.MAX_SAFE_INTEGER]) assert.throws(() => mpsServerDefaultMemoryMiB(bad), /Invalid MPS share memory/, String(bad));
    const first = resolveMpsServerDefault(policies(share17));
    assert.deepEqual({ smPercent: first.smPercent, memoryMiB: first.memoryMiB, shareMemoryMiB: first.shareMemoryMiB }, { smPercent: 25, memoryMiB: 2048, shareMemoryMiB: 1044 });
    const raised = resolveMpsServerDefault(policies(share17, { ...share17, smPercent: 50, vramPercent: 34, vramMiB: 2088, memoryMiB: 2088, memoryBytes: 2088 * 1048576 }));
    assert.deepEqual({ smPercent: raised.smPercent, memoryMiB: raised.memoryMiB, shareMemoryMiB: raised.shareMemoryMiB }, { smPercent: 50, memoryMiB: 3072, shareMemoryMiB: 2088 });
    // Raising the share across a GiB boundary changes the default (a restart); a change inside one GiB does not.
    assert.notDeepEqual(first, raised);
    assert.equal(resolveMpsServerDefault(policies({ ...share17, memoryMiB: 1100, vramMiB: 1100 })).memoryMiB, first.memoryMiB);
    // The client's own variables keep the EXACT share.
    assert.equal(mpsClientEnvironment(share17, `/run/ploinky/mps/pipe-${'a'.repeat(32)}`).CUDA_MPS_PINNED_DEVICE_MEM_LIMIT, '0=1044M');
});

test('V1.a-memory-default-that-is-not-a-whole-gib-is-refused-by-the-daemon-configuration-and-start', () => {
    assert.equal(validateMpsServerDefault({ smPercent: 25, memoryMiB: 2048 }).memoryMiB, 2048);
    for (const memoryMiB of [1044, 1000, 1536, 2049]) {
        assert.throws(() => validateMpsServerDefault({ smPercent: 25, memoryMiB }), /not a whole number of GiB/, String(memoryMiB));
        const calls = [];
        assert.throws(() => configureMpsDefaults({ smPercent: 25, memoryMiB }, { uid: 1000, query: () => { calls.push(1); return { status: 0, stdout: '', stderr: '' }; } }), /Invalid MPS server defaults/, String(memoryMiB));
        assert.equal(calls.length, 0, 'nothing is sent to the daemon');
        const host = fakeHost();
        const backend = createMpsDaemonBackend({ fsApi: host.fsApi, uid: 1000, query: () => { calls.push(1); return { status: 0 }; }, observe: () => ({ state: 'owned' }), now: () => 0, wait: () => {} });
        assert.throws(() => backend.start({ smPercent: 25, memoryMiB }, { tools: host.descriptors }), /Invalid MPS server defaults/, String(memoryMiB));
        assert.equal(calls.length, 0, 'the daemon is not started');
    }
});

test('V2.the-captured-driver-replies-are-pinned-and-normalize-exactly-in-the-product-parser-and-the-runner-classifier', () => {
    assert.equal(CAPTURED.driver, '595.91.07');
    assert.equal(parseMpsSmReply(CAPTURED.sm), 25);
    assert.equal(parseMpsMemoryReply(CAPTURED.memory), 1073741824);
    assert.deepEqual(classifyMpsReply(CAPTURED.sm), { form: 'integer-percentage', value: 25 });
    assert.deepEqual(classifyMpsReply(CAPTURED.memory), { form: 'integer-with-M-or-G', bytes: 1073741824 });
    // The observed display, as the fake daemon models it: floor(MiB/1024)G from 1 GiB up.
    for (const [mib, shown] of [[1044, '1G\n'], [2048, '2G\n'], [3072, '3G\n']]) assert.equal(parseMpsMemoryReply(shown), Math.floor(mib / 1024) * 1073741824);
});

test('V2.a-seventeen-percent-share-of-a-6144-mib-gpu-is-applied-with-a-2048-mib-default-read-back-as-2g-and-a-1044m-client-env', async () => {
    const w = world({ share: share17, display: 'floor-gib' });
    const result = await w.apply();
    assert.equal(result.status, 200, JSON.stringify(result).slice(0, 600));
    assert.ok(w.queries.includes('set_default_device_pinned_mem_limit 0 2048M'), JSON.stringify(w.queries));
    // The journal keeps the sanitized text, a newline shown as \\n.
    assert.equal(w.state.lastReadback.memory, '2G\\n'); assert.equal(w.state.lastReadback.sm, '25\\n');
    assert.deepEqual({ memoryMiB: w.state.serverDefault.memoryMiB, shareMemoryMiB: w.state.serverDefault.shareMemoryMiB }, { memoryMiB: 2048, shareMemoryMiB: 1044 });
    assert.equal(w.launched.length, 1);
    const env = w.launched[0].args.filter((_, index, all) => all[index - 1] === '--env');
    assert.ok(env.includes('CUDA_MPS_PINNED_DEVICE_MEM_LIMIT=0=1044M'), env.join(' '));
    assert.ok(env.includes('CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=25'), env.join(' '));
});

test('V2.a-daemon-that-answers-1g-for-a-configured-2048-mib-is-still-refused-and-the-message-carries-both-replies', async () => {
    const w = world({ share: share17, replies: { memory: CAPTURED.memory } });
    const result = await w.apply();
    assert.equal(result.status, 422, JSON.stringify(result).slice(0, 400));
    assert.equal(w.launched.length, 0);
    const reason = result.results[0].problem.reason;
    assert.match(reason, /MPS default readback does not match configuration \(requested 25% and 2048M; read 25% and 1073741824 bytes; SM \(reply: "25\\n"\), memory \(reply: "1G\\n"\)\)/);
    assert.equal(result.results[0].cause.step, 'set-defaults');
});

// M-MPS-03: credentials are redacted from the ORIGINAL reply, before it is escaped or cut to its 256 and 64 character bounds.
// The secret is synthetic (never a real credential); it contains a newline and straddles both bounds.
const SYNTHETIC = `SYNTH-${'abcdefghij'.repeat(10)}\n${'klmnopqrst'.repeat(20)}`;
function withSyntheticSecret(callback) {
    const name = 'PLOINKY_SYNTHETIC_TEST_TOKEN';
    const before = process.env[name];
    process.env[name] = SYNTHETIC;
    const restore = () => { if (before === undefined) delete process.env[name]; else process.env[name] = before; };
    try { const result = callback(); if (result?.then) return result.finally(restore); restore(); return result; } catch (error) { restore(); throw error; }
}
const prefixLeaks = blob => { for (let at = 0; at + 8 <= SYNTHETIC.length; at += 1) { if (blob.includes(SYNTHETIC.slice(at, at + 8)) || blob.includes(JSON.stringify(SYNTHETIC.slice(at, at + 8)).slice(1, -1))) return at; } return -1; };

test('M03.no-part-of-a-known-secret-in-a-reply-reaches-the-error-the-cause-the-journal-or-the-readback', async () => {
    assert.ok(SYNTHETIC.includes('\n') && SYNTHETIC.length > 300);
    // The reply puts the secret across the 64 and the 256 character bounds, after an ordinary prefix.
    const reply = `${'p'.repeat(40)}${SYNTHETIC}\n`;
    await withSyntheticSecret(async () => {
        const w = world({ replies: { sm: '25.0\n', memory: reply } });
        const result = await w.apply();
        assert.equal(result.status, 422, JSON.stringify(result).slice(0, 300));
        const blob = `${JSON.stringify(result)}\n${JSON.stringify(w.state)}`;
        assert.equal(prefixLeaks(blob), -1, 'a window of the secret reached the Apply result or the journal');
        assert.ok(blob.includes('[REDACTED]'), 'the redaction is visible');
        assert.ok(blob.includes(`reply: \\"${'p'.repeat(40)}[REDACTED]`) || blob.includes(`reply: "${'p'.repeat(40)}[REDACTED]`), 'the ordinary part of the reply is still shown');
        assert.ok(w.state.lastReadback.memory.startsWith(`${'p'.repeat(40)}[REDACTED]`), w.state.lastReadback.memory);
        assert.equal(w.state.lastReadback.sm, '25.0\\n');
        assert.equal(w.state.lastProblem.cause.step, 'set-defaults');
    });
});

test('M03.the-excerpt-redacts-before-escaping-and-cutting-and-keeps-ordinary-replies-and-structured-secrets-bounded', async () => {
    withSyntheticSecret(() => {
        for (const reply of [SYNTHETIC, `${'p'.repeat(40)}${SYNTHETIC}`, `${'p'.repeat(200)}${SYNTHETIC}`, `${SYNTHETIC}\n`, `x${SYNTHETIC.slice(0, 120)}`]) {
            const shown = replyExcerpt(reply);
            assert.ok(shown.length <= 64 && /^[\x20-\x7e]*$/.test(shown), shown);
            if (reply.includes(SYNTHETIC)) assert.equal(prefixLeaks(shown), -1, JSON.stringify(shown));
        }
        // The secret value is not cut away piecemeal: a partial copy of it in the reply is not a known value and is shown as it is.
        assert.equal(replyExcerpt(`x${SYNTHETIC.slice(0, 20)}`.replace('\n', '')).startsWith('xSYNTH-'), true);
    });
    // Ordinary replies keep their form, including a trailing newline and bounded length.
    assert.equal(replyExcerpt('25.0\n'), '25.0\\n'); assert.equal(replyExcerpt('1G\n'), '1G\\n'); assert.equal(replyExcerpt('\n'), '\\n');
    assert.equal(replyExcerpt('a\r\nb'), 'a\\nb'); assert.equal(replyExcerpt('x'.repeat(500)).length, 64); assert.equal(replyExcerpt(undefined), '');
    // Structured and assignment-style credentials are redacted whole, before any cut.
    assert.equal(replyExcerpt('token=hunter2'), 'token=[REDACTED]');
    assert.equal(replyExcerpt(`{"password": "${'q'.repeat(90)}"}`).includes('qqqq'), false);
    // A reply too long to redact whole is not shown at all; only its size is.
    assert.match(replyExcerpt('z'.repeat(5000)), /^\[5000 bytes not shown\]$/);
});

// M-MPS-03 (round 2): what is shown is always the sanitizer's output, never the raw reply chosen by a test of its text. A reply that
// holds a (synthetic) credential and also the literal word REDACTED collapses to the same count of markers.
const SYNTHETIC_BEARER = 'SYNTHCRED0123456789abcdefghijklmnopqrstuvwxyz';
test('M03.a-reply-with-a-credential-and-the-literal-word-redacted-never-shows-the-raw-reply', async () => {
    for (const reply of [`Authorization: Bearer ${SYNTHETIC_BEARER} REDACTED`, `Bearer ${SYNTHETIC_BEARER}, REDACTED`, `token=${SYNTHETIC_BEARER} REDACTED`, `REDACTED password=${SYNTHETIC_BEARER}`]) {
        const shown = replyExcerpt(reply);
        assert.equal(shown.includes('SYNTHCRED'), false, `${reply}: ${shown}`);
        assert.match(shown, /REDACTED/);
        const w = world({ replies: { sm: '25.0\n', memory: `${reply}\n` } });
        const result = await w.apply();
        assert.equal(result.status, 422);
        const blob = `${JSON.stringify(result)}\n${JSON.stringify(w.state)}`;
        assert.equal(blob.includes('SYNTHCRED'), false, `${reply}: the credential reached the Apply result or the journal`);
        assert.equal(w.state.lastReadback.memory.includes('SYNTHCRED'), false);
    }
});
