import childProcess from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { AcceptanceError, LIMITS, need, absolute } from './manifest.mjs';

// Every host command of the live acceptance run goes through this one owner: an exact argument array, a
// private environment, one retained ChildProcess, bounded bytes, a bounded deadline and observed close.
// There are no shells, process groups, name searches or signals; a command that does not settle is handed off.
export const COMMAND_KINDS = Object.freeze({ git: 30000, read: 120000, mutation: LIMITS.commandMs, continuation: 3300000 });
export const COMMAND_STREAM_BYTES = Object.freeze({ git: 4 * 1024 * 1024, read: 4 * 1024 * 1024, mutation: LIMITS.outputBytes, continuation: LIMITS.outputBytes });
const ENV_ALLOWLIST = Object.freeze(['HOME', 'USER', 'LOGNAME', 'PATH', 'XDG_RUNTIME_DIR', 'TMPDIR']);

export const monotonicNow = () => Math.floor(performance.now());
export const defaultDelay = milliseconds => sleep(milliseconds);

// Whole-environment inheritance would expose unrelated credentials to every child and to its diagnostics.
export function buildCommandEnvironment(processEnv, extra = {}) {
    const env = { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
    for (const key of ENV_ALLOWLIST) if (typeof processEnv?.[key] === 'string' && processEnv[key] && !/[\0\r\n]/.test(processEnv[key])) env[key] = processEnv[key];
    for (const [key, value] of Object.entries(extra)) {
        need(/^[A-Z][A-Z0-9_]{0,63}$/.test(key) && typeof value === 'string' && value.length <= 4096 && !/[\0\r\n]/.test(value), 'command-environment');
        env[key] = value;
    }
    return env;
}

function validateSpec(spec) {
    need(spec && typeof spec.operation === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(spec.operation), 'command-operation');
    need(Object.hasOwn(COMMAND_KINDS, spec.kind), 'command-kind');
    need(Array.isArray(spec.argv) && spec.argv.length >= 1 && spec.argv.length <= 256 && spec.argv.every(value => typeof value === 'string' && !value.includes('\0')
        && Buffer.byteLength(value) <= 8192), 'command-argv');
    need(absolute(spec.argv[0]) && absolute(spec.cwd), 'command-paths');
    need(Number.isSafeInteger(spec.deadlineMs) && spec.deadlineMs > 0 && spec.deadlineMs <= COMMAND_KINDS[spec.kind], 'command-deadline-cap');
    const stdoutCap = spec.maxStdoutBytes ?? COMMAND_STREAM_BYTES[spec.kind], stderrCap = spec.maxStderrBytes ?? COMMAND_STREAM_BYTES[spec.kind];
    need([stdoutCap, stderrCap].every(value => Number.isSafeInteger(value) && value > 0 && value <= COMMAND_STREAM_BYTES[spec.kind]), 'command-byte-cap');
    need(spec.input === undefined || (Buffer.isBuffer(spec.input) && spec.input.length <= LIMITS.controlBytes), 'command-input');
    const exits = spec.allowedExitCodes ?? [0];
    need(Array.isArray(exits) && exits.length > 0 && exits.length <= 4 && exits.every(code => Number.isInteger(code) && code >= 0 && code <= 255), 'command-exit-codes');
    need(spec.collect === undefined || typeof spec.collect === 'boolean', 'command-collect');
    need(spec.controlBytes === undefined || (Number.isSafeInteger(spec.controlBytes) && spec.controlBytes > 0 && spec.controlBytes <= LIMITS.controlBytes), 'command-control-cap');
    need(spec.tap === undefined || (typeof spec.tap?.push === 'function' && typeof spec.tap.end === 'function'), 'command-tap');
    need(spec.env && Object.getPrototypeOf(spec.env) === Object.prototype, 'command-environment');
    return { stdoutCap, stderrCap, exits, collect: spec.collect !== false };
}

// deps: { launch, now, delay, latch, custody, runId, register?, current? }
export async function runOwnedCommand(spec, deps) {
    const { stdoutCap, stderrCap, exits, collect } = validateSpec(spec);
    const { launch = childProcess.spawn, now = monotonicNow, delay = defaultDelay, latch, custody, runId, register, current } = deps;
    need(latch && custody && typeof runId === 'string', 'command-ownership-adapters');
    latch.assertMayLaunch();
    const started = now(), deadline = started + spec.deadlineMs;
    let child, registration = null, closed = false, code = null, signal = null, failure = null;
    const streams = { stdout: { ended: false, closed: false, bytes: 0, chunks: [] }, stderr: { ended: false, closed: false, bytes: 0, chunks: [] } };
    if (spec.controlBytes !== undefined) streams.control = { ended: false, closed: false, bytes: 0, chunks: [] };
    const fail = reason => { failure ??= reason; latch.stop(reason); };
    const retained = () => ({ pid: child?.pid ?? null, registered: registration !== null, childClosed: closed,
        pipesClosed: Object.values(streams).every(value => value.ended && value.closed) });
    const unsettled = reason => { const error = new AcceptanceError(reason); error.retained = retained(); return error; };
    try {
        child = launch(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, shell: false, detached: false, windowsHide: true,
            stdio: [spec.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', ...(spec.controlBytes === undefined ? [] : ['pipe'])] });
        // The returned handle and every observer exist before any fallible step.
        custody.retain(child, { operation: spec.operation, runId });
        child.on('error', () => fail('command-error'));
        child.on('close', (exitCode, exitSignal) => { closed = true; code = exitCode; signal = exitSignal; });
        const channels = [['stdout', child.stdout], ['stderr', child.stderr], ...(spec.controlBytes === undefined ? [] : [['control', child.stdio?.[3]]])];
        for (const [name, stream] of channels) {
            need(stream?.on, 'command-channel-missing');
            const state = streams[name], cap = name === 'stdout' ? stdoutCap : name === 'stderr' ? stderrCap : spec.controlBytes;
            stream.on('error', () => fail('command-pipe-error'));
            stream.on('end', () => { state.ended = true; if (name !== 'control' && spec.tap && !failure) spec.tap.end(name); });
            stream.on('close', () => { state.closed = true; });
            stream.on('data', chunk => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                state.bytes = Math.min(Number.MAX_SAFE_INTEGER, state.bytes + buffer.length);
                if (state.bytes > cap) { state.chunks.length = 0; fail('command-output-overflow'); return; }
                if (failure) return;
                if (name !== 'control' && spec.tap && spec.tap.push(name, buffer) === false) { state.chunks.length = 0; fail('command-output-rejected'); return; }
                if (collect || name === 'control') state.chunks.push(buffer);
            });
        }
        if (spec.input !== undefined) {
            need(child.stdin?.on, 'command-channel-missing');
            child.stdin.on('error', () => fail('command-stdin-error'));
            child.stdin.end(spec.input);
        }
        if (typeof register === 'function') registration = register(child, { operation: spec.operation, runId });
        while (!closed) {
            if (failure) break;
            if (now() >= deadline) { fail('command-deadline'); break; }
            await delay(10);
        }
        if (failure) throw unsettled(failure);
        const closeDeadline = Math.min(deadline, now() + LIMITS.closeMs);
        while (!Object.values(streams).every(value => value.ended && value.closed) && now() < closeDeadline && !failure) await delay(10);
        if (failure) throw unsettled(failure);
        need(now() <= deadline, 'command-deadline');
        need(closed && Object.values(streams).every(value => value.ended && value.closed), 'command-close-unproven');
        need(signal === null, 'command-signalled');
        if (typeof current === 'function') need(current(registration) === null, 'command-incarnation-unsettled');
        need(exits.includes(code), 'command-exit-unexpected');
        latch.assertMayLaunch();
        custody.settled(child);
        return Object.freeze({ code, durationMs: now() - started, stdout: Buffer.concat(streams.stdout.chunks), stderr: Buffer.concat(streams.stderr.chunks),
            stdoutBytes: streams.stdout.bytes, stderrBytes: streams.stderr.bytes, control: streams.control ? Buffer.concat(streams.control.chunks) : Buffer.alloc(0) });
    } catch (error) {
        const reason = error instanceof AcceptanceError ? error.code : 'command-setup-failed';
        fail(reason);
        for (const stream of Object.values(streams)) stream.chunks.length = 0;
        const result = error instanceof AcceptanceError && error.retained ? error : new AcceptanceError(reason);
        result.retained ??= retained();
        // A closed, drained command whose only defect is its exit status is settled; everything else stays handoff.
        if (child && reason === 'command-exit-unexpected') custody.settled(child);
        throw result;
    }
}
