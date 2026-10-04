import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installPureGuards } from './test_support_codex.mjs';
import { createOwnedCustody, createStopLatch } from './execution_codex.mjs';
import { runOwnedCommand, buildCommandEnvironment, COMMAND_KINDS } from './host_command_codex.mjs';
import { createLinuxProcessObserver, parseProcStat } from './linux_observer_codex.mjs';
installPureGuards();

const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

function clock() { let time = 1000; return { now: () => time, delay: async milliseconds => { time += milliseconds; await new Promise(resolve => setImmediate(resolve)); } }; }
// A fabricated child with no kill method: any attempt to signal it throws.
function fakeChild({ pid = 4242, script = () => {}, withStdin = false } = {}) {
    const child = new EventEmitter(); child.pid = pid; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.writes = []; if (withStdin) { child.stdin = new EventEmitter(); child.stdin.end = value => { child.writes.push(value); }; }
    child.finish = (code = 0, signal = null) => { for (const stream of [child.stdout, child.stderr]) { stream.emit('end'); stream.emit('close'); } child.emit('close', code, signal); };
    queueMicrotask(() => script(child)); return child;
}
function harness(options = {}) {
    const latch = createStopLatch(), custody = createOwnedCustody(), time = clock(), launches = [];
    const launch = (bin, args, launchOptions) => { launches.push({ bin, args, launchOptions }); const child = (options.child ?? fakeChild)(); launches.at(-1).child = child; return child; };
    return { latch, custody, launches, deps: { launch, latch, custody, runId: 'run_codex', now: time.now, delay: time.delay, ...options.deps } };
}
const spec = (extra = {}) => ({ operation: 'probe-one', kind: 'read', argv: ['/usr/bin/podman', 'container', 'inspect', 'id'], cwd: '/home/skutner/work/testExplorerFresh',
    env: buildCommandEnvironment({ HOME: '/home/skutner', PATH: '/usr/bin' }), deadlineMs: 5000, ...extra });

test('success keeps exact argv, private environment, retained handle and bounded collected bytes', async () => {
    const h = harness({ child: () => fakeChild({ script: child => { child.stdout.emit('data', Buffer.from('out')); child.stderr.emit('data', 'err'); child.finish(0); } }) });
    const result = await runOwnedCommand(spec(), h.deps);
    assert.equal(result.code, 0); assert.equal(result.stdout.toString(), 'out'); assert.equal(result.stderr.toString(), 'err');
    assert.deepEqual(h.launches[0].args, ['container', 'inspect', 'id']); assert.equal(h.launches[0].bin, '/usr/bin/podman');
    assert.equal(h.launches[0].launchOptions.shell, false); assert.equal(h.launches[0].launchOptions.detached, false);
    assert.deepEqual(h.launches[0].launchOptions.stdio, ['ignore', 'pipe', 'pipe']);
    assert.deepEqual(Object.keys(h.launches[0].launchOptions.env).sort(), ['GIT_TERMINAL_PROMPT', 'HOME', 'LC_ALL', 'PATH']);
    assert.deepEqual(h.custody.snapshot(), [{ pid: 4242, operation: 'probe-one', runId: 'run_codex', settled: true }]);
    assert.equal(h.latch.snapshot().uncertain, false);
});

test('stdin input is written once and a tap sees every chunk without retaining collected bytes', async () => {
    const seen = [], ended = [];
    const h = harness({ child: () => fakeChild({ withStdin: true, script: child => { child.stdout.emit('data', Buffer.from('a')); child.stdout.emit('data', Buffer.from('b')); child.finish(0); } }) });
    const result = await runOwnedCommand(spec({ input: Buffer.from('script'), collect: false, tap: { push: (name, chunk) => { seen.push([name, chunk.toString()]); return true; }, end: name => ended.push(name) } }), h.deps);
    assert.deepEqual(seen, [['stdout', 'a'], ['stdout', 'b']]); assert.deepEqual(ended.sort(), ['stderr', 'stdout']);
    assert.equal(result.stdout.length, 0); assert.equal(result.stdoutBytes, 2); assert.deepEqual(h.launches[0].child.writes.map(String), ['script']);
    assert.deepEqual(h.launches[0].launchOptions.stdio, ['pipe', 'pipe', 'pipe']);
});

test('an unexpected exit status latches later launches but is a settled command', async () => {
    const h = harness({ child: () => fakeChild({ script: child => child.finish(3) }) });
    await rejects(runOwnedCommand(spec(), h.deps), 'command-exit-unexpected');
    assert.equal(h.custody.snapshot()[0].settled, true); assert.equal(h.latch.snapshot().reason, 'command-exit-unexpected');
    await rejects(runOwnedCommand(spec(), h.deps), 'launch-after-uncertainty'); assert.equal(h.launches.length, 1);
    const allowed = harness({ child: () => fakeChild({ script: child => child.finish(1) }) });
    assert.equal((await runOwnedCommand(spec({ allowedExitCodes: [0, 1] }), allowed.deps)).code, 1);
});

test('output overflow, tap rejection and deadline expiry hand off without signalling the child', async () => {
    let h = harness({ child: () => fakeChild({ script: child => child.stdout.emit('data', Buffer.alloc(9)) }) });
    await assert.rejects(runOwnedCommand(spec({ maxStdoutBytes: 8 }), h.deps), error => error.code === 'command-output-overflow' && error.retained.childClosed === false);
    assert.equal(h.custody.snapshot()[0].settled, false);
    h = harness({ child: () => fakeChild({ script: child => child.stdout.emit('data', Buffer.from('x')) }) });
    await rejects(runOwnedCommand(spec({ tap: { push: () => false, end() {} } }), h.deps), 'command-output-rejected');
    h = harness({ child: () => fakeChild() });
    await assert.rejects(runOwnedCommand(spec({ deadlineMs: 50 }), h.deps), error => error.code === 'command-deadline' && error.retained.pid === 4242);
    assert.equal(h.custody.snapshot()[0].settled, false); assert.equal(h.latch.snapshot().reason, 'command-deadline');
    await rejects(runOwnedCommand(spec(), h.deps), 'launch-after-uncertainty');
});

test('child error, missing pipe drain, signal exit and unsettled incarnation never become success', async () => {
    let h = harness({ child: () => fakeChild({ script: child => child.emit('error', new Error('PRIVATE-DETAIL')) }) });
    await assert.rejects(runOwnedCommand(spec(), h.deps), error => error.code === 'command-error' && !String(error.message).includes('PRIVATE'));
    h = harness({ child: () => fakeChild({ script: child => child.emit('close', 0, null) }) });
    await rejects(runOwnedCommand(spec({ deadlineMs: 1000 }), h.deps), 'command-close-unproven');
    h = harness({ child: () => fakeChild({ script: child => child.finish(null, 'SIGTERM') }) });
    await rejects(runOwnedCommand(spec(), h.deps), 'command-signalled');
    h = harness({ child: () => fakeChild({ script: child => child.finish(0) }), deps: { register: () => ({ id: 1 }), current: () => ({ present: true }) } });
    await rejects(runOwnedCommand(spec(), h.deps), 'command-incarnation-unsettled'); assert.equal(h.custody.snapshot()[0].settled, false);
});

test('registration failure keeps the retained handle and observers attached first', async () => {
    const h = harness({ child: () => fakeChild(), deps: { register: () => { throw new Error('PRIVATE-DETAIL'); } } });
    await assert.rejects(runOwnedCommand(spec(), h.deps), error => error.code === 'command-setup-failed' && error.retained.pid === 4242);
    assert.equal(h.custody.handles().length, 1); assert.equal(h.latch.snapshot().uncertain, true);
    assert.equal(h.launches[0].child.listenerCount('close'), 1); assert.equal(h.launches[0].child.stdout.listenerCount('data'), 1);
});

test('invalid specifications refuse before any launch', async () => {
    const h = harness();
    for (const [mutate, code] of [[value => { value.cwd = 'relative'; }, 'command-paths'], [value => { value.argv = ['podman']; }, 'command-paths'],
        [value => { value.deadlineMs = COMMAND_KINDS.read + 1; }, 'command-deadline-cap'], [value => { value.kind = 'shell'; }, 'command-kind'],
        [value => { value.argv = ['/usr/bin/podman', 'a\0b']; }, 'command-argv'], [value => { value.maxStdoutBytes = 1 << 30; }, 'command-byte-cap'],
        [value => { value.operation = 'Has Space'; }, 'command-operation'], [value => { value.allowedExitCodes = [300]; }, 'command-exit-codes'],
        [value => { value.input = 'text'; }, 'command-input']]) {
        const bad = spec(); mutate(bad); await rejects(runOwnedCommand(bad, h.deps), code);
    }
    assert.equal(h.launches.length, 0);
    assert.equal(COMMAND_KINDS.git, 30000);
});

test('command environment is an allowlist and refuses malformed additions', () => {
    const env = buildCommandEnvironment({ HOME: '/h', PATH: '/p', SECRET_TOKEN: 'PRIVATE-SENTINEL', XDG_RUNTIME_DIR: '/run/user/1000', USER: 'u\nx' }, { PLOINKY_X: '1' });
    assert.deepEqual(env, { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', HOME: '/h', PATH: '/p', XDG_RUNTIME_DIR: '/run/user/1000', PLOINKY_X: '1' });
    assert.throws(() => buildCommandEnvironment({}, { lower: 'x' }), error => error.code === 'command-environment');
    assert.throws(() => buildCommandEnvironment({}, { A: 'x\0' }), error => error.code === 'command-environment');
});

test('linux observer parses /proc stat with hostile command names and distinguishes absent, reused and present incarnations', () => {
    const stat = (pid, comm, start) => `${pid} (${comm}) S 1 1 1 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 ${start} 1000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0`;
    assert.deepEqual(parseProcStat(stat(77, 'a) S 9 (b', '123456')), { pid: 77, state: 'S', startTicks: '123456' });
    for (const bad of ['', 'x', '77 (c', `77 (c) S ${'1 '.repeat(5)}`]) assert.throws(() => parseProcStat(bad), error => error.code === 'proc-stat-shape');
    const files = new Map([['/proc/sys/kernel/random/boot_id', '47ec5b32-52bc-489c-ae6b-4bad94022abb\n'], ['/proc/77/stat', stat(77, 'node', '500')]]);
    const readFile = file => { if (!files.has(file)) { const error = new Error('gone'); error.code = 'ENOENT'; throw error; } return files.get(file); };
    const observer = createLinuxProcessObserver({ readFile, platform: 'linux' });
    const registration = observer.register({ pid: 77 });
    assert.equal(registration.startTicks, '500'); assert.equal(registration.observedAtRegistration, true);
    assert.deepEqual(observer.current(registration), { pid: 77, identity: 'present', state: 'S' });
    files.set('/proc/77/stat', stat(77, 'other', '999')); assert.equal(observer.current(registration), null);
    files.delete('/proc/77/stat'); assert.equal(observer.current(registration), null);
    const early = observer.register({ pid: 77 }); assert.equal(early.startTicks, null);
    files.set('/proc/77/stat', stat(77, 'x', '1')); assert.deepEqual(observer.current(early), { pid: 77, identity: 'unobserved' });
    files.set('/proc/sys/kernel/random/boot_id', '11111111-52bc-489c-ae6b-4bad94022abb\n');
    assert.throws(() => observer.current(registration), error => error.code === 'observer-boot-changed');
    assert.throws(() => createLinuxProcessObserver({ readFile, platform: 'darwin' }), error => error.code === 'observer-platform-unqualified');
    assert.throws(() => observer.register({ pid: 0 }), error => error.code === 'observer-pid');
    const broken = createLinuxProcessObserver({ readFile: file => { if (file.endsWith('boot_id')) return '47ec5b32-52bc-489c-ae6b-4bad94022abb'; const error = new Error('x'); error.code = 'EACCES'; throw error; }, platform: 'linux' });
    assert.throws(() => broken.current({ pid: 5, boot: '47ec5b32-52bc-489c-ae6b-4bad94022abb', startTicks: '1' }), error => error.code === 'observer-unreadable');
    assert.equal(broken.register({ pid: 5 }).unreadableAtRegistration, true);
});

test('an optional private control descriptor is a fourth bounded pipe whose bytes are returned separately', async () => {
    const h = harness({ child: () => { const child = fakeChild(); child.stdio = [null, child.stdout, child.stderr, new EventEmitter()];
        queueMicrotask(() => { child.stdio[3].emit('data', Buffer.from('{"frame":1}')); child.stdout.emit('data', Buffer.from('ordinary')); for (const stream of [child.stdout, child.stderr, child.stdio[3]]) { stream.emit('end'); stream.emit('close'); } child.emit('close', 0, null); }); return child; } });
    const result = await runOwnedCommand(spec({ controlBytes: 64 }), h.deps);
    assert.deepEqual(h.launches[0].launchOptions.stdio, ['ignore', 'pipe', 'pipe', 'pipe']); assert.equal(result.control.toString(), '{"frame":1}'); assert.equal(result.stdout.toString(), 'ordinary');
    const over = harness({ child: () => { const child = fakeChild(); child.stdio = [null, child.stdout, child.stderr, new EventEmitter()]; queueMicrotask(() => child.stdio[3].emit('data', Buffer.alloc(65))); return child; } });
    await assert.rejects(runOwnedCommand(spec({ controlBytes: 64 }), over.deps), error => error.code === 'command-output-overflow');
    const missing = harness({ child: () => fakeChild() });
    await assert.rejects(runOwnedCommand(spec({ controlBytes: 64 }), missing.deps), error => error.code === 'command-channel-missing');
    const unclosed = harness({ child: () => { const child = fakeChild(); child.stdio = [null, child.stdout, child.stderr, new EventEmitter()]; queueMicrotask(() => child.finish(0)); return child; } });
    await assert.rejects(runOwnedCommand(spec({ controlBytes: 64, deadlineMs: 500 }), unclosed.deps), error => error.code === 'command-close-unproven');
    await assert.rejects(runOwnedCommand(spec({ controlBytes: 1 << 30 }), harness().deps), error => error.code === 'command-control-cap');
});
