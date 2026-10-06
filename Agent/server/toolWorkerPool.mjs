// Opt-in pools of persistent tool-worker processes.
//
// An agent declares `toolWorkers.<pool>` in its MCP config; tools that name
// that pool can run in a warm worker instead of a fresh process per call. Each
// worker is spawned detached (it leads its own process group) and gets
// /dev/null on stdin. fd 3 carries only a one-time bootstrap token; frames
// (newline-delimited JSON, see Agent/lib/toolWorker.mjs) travel over a private
// Unix socket the worker connects to and proves itself on with that token. The
// worker's end of that socket is close-on-exec and fd 3 is closed after the
// handshake, so tool children cannot reach the channel.
//
// A call's output is what arrives on the busy worker's stdout/stderr pipes
// (the handler's writes and those of tool children that inherit fd 1/2), up to
// the call's random end marker on each stream; the call resolves once its
// result frame and both markers have arrived. Pipe output outside a call goes
// to the host log, never into a call; an idle worker that still produces it
// is replaced.
//
// Fresh code. With a `codeIdentity()` hook (a stamp of the agent's code,
// manifest and generation), every worker records the identity it was spawned
// under, and the pool reads the hook before every dispatch: a worker whose
// identity differs never gets another call and is replaced. Nothing is cached
// by time. If the hook fails, the call runs through the spawn fallback, which
// always loads current code. Pools never retry a call, never
// log frames (they can carry invocation tokens) and never leave a worker
// process group behind: timeouts, crashes, recycling and shutdown all end with
// a SIGKILL to the worker's process group.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolWorkerEndMarker } from '../lib/toolWorker.mjs';

export const TOOL_WORKER_MODULE_PATH = fileURLToPath(new URL('../lib/toolWorker.mjs', import.meta.url));
export const TOOL_WORKER_PROTOCOL_VERSION = 1;

export const TOOL_WORKER_DEFAULTS = Object.freeze({
    size: 2,
    maxQueue: 64,
    callTimeoutMs: 300_000,
    readyTimeoutMs: 15_000,
    maxCallsPerWorker: 500,
    maxRssBytes: 512 * 1024 * 1024,
    idleTimeoutMs: 600_000,
    maxFrameBytes: 256 * 1024 * 1024,
});

// Consecutive workers that died before completing any call (before `ready`,
// or after it without the pool ending them), with no call completed in
// between, mark the command broken. Counting consecutive deaths, not deaths
// inside a fixed time window, also catches workers that hang until
// readyTimeoutMs; counting deaths after `ready` catches workers that fail
// right after announcing it.
const UNPRODUCTIVE_DEATH_LIMIT = 3;
const DEGRADED_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;
// After a worker exits, frames and output it wrote just before can still be
// unread; wait for its stdio to close, up to this long, before judging the call.
const EXIT_SETTLE_MS = 1000;
// A worker that closes its channel is about to exit (e.g. exit 70 after
// flushing); give it this long before the pool kills it.
const CHANNEL_END_GRACE_MS = 500;
const MAX_LOG_PARTIAL_CHARS = 64 * 1024;
const HELLO_MAX_BYTES = 4096;
// sockaddr_un.sun_path is 104 bytes on macOS and 108 on Linux.
const MAX_SOCKET_PATH_BYTES = 100;

const registeredPools = new Set();

function positiveInteger(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

// setTimeout fires at once for delays above 2^31-1 ms; clamp instead.
const MAX_TIMER_MS = 2 ** 31 - 1;

function timerDelay(value, fallback) {
    return Math.min(positiveInteger(value, fallback), MAX_TIMER_MS);
}

function nonNegativeInteger(value, fallback) {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
}

// A fresh 0700 directory per worker for its handshake socket. The socket is
// removed as soon as the worker has connected.
function createSocketPath() {
    for (const base of [os.tmpdir(), '/tmp']) {
        let dir;
        try {
            dir = fs.mkdtempSync(path.join(base, 'ptw-'));
        } catch (_) {
            continue;
        }
        const socketPath = path.join(dir, 's');
        if (Buffer.byteLength(socketPath) <= MAX_SOCKET_PATH_BYTES) return { dir, socketPath };
        fs.rmSync(dir, { recursive: true, force: true });
    }
    throw new Error('no directory with a short enough path for a tool worker socket');
}

function tokensEqual(received, expected) {
    if (typeof received !== 'string') return false;
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function failureResult(message) {
    return { code: 1, signal: null, stdout: '', stderr: `${message}\n` };
}

function defaultLog(line) {
    try {
        process.stderr.write(`${line}\n`);
    } catch (_) {
        // Logging must never break a call.
    }
}

// Kill the worker's whole process group (pattern of TaskQueue.signalTaskProcess).
function killWorkerGroup(child) {
    const pid = Number(child?.pid);
    if (Number.isInteger(pid) && pid > 0 && process.platform !== 'win32') {
        try {
            process.kill(-pid, 'SIGKILL');
            return;
        } catch (_) {
            // Fall back to the leader alone.
        }
    }
    try {
        child?.kill('SIGKILL');
    } catch (_) {
        // Already gone.
    }
}

function processGroupExists(pid) {
    if (!Number.isInteger(pid) || pid < 1 || process.platform === 'win32') return false;
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') return false;
        if (error?.code === 'EPERM') return true;
        throw error;
    }
}

// Splits newline-delimited frames and enforces maxFrameBytes, counting bytes
// that have arrived without a terminating newline as well.
class FrameDecoder {
    constructor(maxFrameBytes, onFrame, onError) {
        this.maxFrameBytes = maxFrameBytes;
        this.onFrame = onFrame;
        this.onError = onError;
        this.pending = [];
        this.pendingBytes = 0;
        this.failed = false;
    }

    push(chunk) {
        if (this.failed) return;
        let start = 0;
        let newline = chunk.indexOf(0x0a, start);
        while (newline !== -1) {
            const piece = chunk.subarray(start, newline);
            if (this.pendingBytes + piece.length > this.maxFrameBytes) {
                this.fail('oversize');
                return;
            }
            this.pending.push(piece);
            const line = Buffer.concat(this.pending).toString('utf8');
            this.pending = [];
            this.pendingBytes = 0;
            start = newline + 1;
            if (line.trim()) {
                let frame;
                try {
                    frame = JSON.parse(line);
                } catch (_) {
                    this.fail('malformed');
                    return;
                }
                this.onFrame(frame);
                if (this.failed) return;
            }
            newline = chunk.indexOf(0x0a, start);
        }
        if (start < chunk.length) {
            const rest = chunk.subarray(start);
            if (this.pendingBytes + rest.length > this.maxFrameBytes) {
                this.fail('oversize');
                return;
            }
            this.pending.push(rest);
            this.pendingBytes += rest.length;
        }
    }

    fail(reason) {
        this.failed = true;
        this.pending = [];
        this.pendingBytes = 0;
        this.onError(reason);
    }
}

export class ToolWorkerPool {
    constructor(name, options = {}) {
        if (typeof name !== 'string' || !name) throw new TypeError('tool worker pool name is required');
        if (typeof options.command !== 'string' || !options.command) {
            throw new TypeError(`tool worker pool '${name}' requires a command`);
        }
        this.name = name;
        this.command = options.command;
        this.args = Array.isArray(options.args) ? options.args.slice() : [];
        this.cwd = options.cwd;
        this.env = options.env && typeof options.env === 'object' ? { ...options.env } : {};
        this.size = positiveInteger(options.size, TOOL_WORKER_DEFAULTS.size);
        this.maxQueue = nonNegativeInteger(options.maxQueue, TOOL_WORKER_DEFAULTS.maxQueue);
        this.callTimeoutMs = timerDelay(options.callTimeoutMs, TOOL_WORKER_DEFAULTS.callTimeoutMs);
        this.readyTimeoutMs = timerDelay(options.readyTimeoutMs, TOOL_WORKER_DEFAULTS.readyTimeoutMs);
        this.maxCallsPerWorker = positiveInteger(options.maxCallsPerWorker, TOOL_WORKER_DEFAULTS.maxCallsPerWorker);
        this.maxRssBytes = positiveInteger(options.maxRssBytes, TOOL_WORKER_DEFAULTS.maxRssBytes);
        this.idleTimeoutMs = timerDelay(options.idleTimeoutMs, TOOL_WORKER_DEFAULTS.idleTimeoutMs);
        this.maxFrameBytes = positiveInteger(options.maxFrameBytes, TOOL_WORKER_DEFAULTS.maxFrameBytes);
        this.log = typeof options.log === 'function' ? options.log : defaultLog;
        this.now = typeof options.now === 'function' ? options.now : Date.now;
        this.codeIdentity = typeof options.codeIdentity === 'function' ? options.codeIdentity : null;

        this.workers = new Set();
        this.queue = [];
        this.nextCallId = 1;
        this.unproductiveDeaths = 0;
        this.degradedUntil = 0;
        this.shuttingDown = false;
        this.shutdownPromise = null;
        this.counters = {
            spawned: 0,
            recycled: 0,
            timeouts: 0,
            crashes: 0,
            completed: 0,
            saturated: 0,
            fallbacks: 0,
        };
    }

    isDegraded() {
        return this.now() < this.degradedUntil;
    }

    stats() {
        let starting = 0;
        let idle = 0;
        let busy = 0;
        let retiring = 0;
        for (const worker of this.workers) {
            if (worker.state === 'starting') starting += 1;
            else if (worker.state === 'idle') idle += 1;
            else if (worker.state === 'busy') busy += 1;
            else if (worker.state === 'retiring') retiring += 1;
        }
        return {
            name: this.name,
            size: this.size,
            workers: this.workers.size,
            starting,
            idle,
            busy,
            retiring,
            queued: this.queue.length,
            degraded: this.isDegraded(),
            degradedUntil: this.degradedUntil || null,
            pids: [...this.workers].map((worker) => worker.pid).filter(Boolean),
            ...this.counters,
        };
    }

    /**
     * Run one tool call in a worker. Always resolves to
     * `{ code, signal: null, stdout, stderr }`; pool failures (timeout, crash,
     * saturation, oversize frame, shutdown) resolve with `code: 1` and the
     * reason on stderr. A call is never retried. While the pool is degraded
     * the call runs through `fallback()` instead (when given).
     */
    async call({ toolName, toolEnv, payload, timeoutMs: callTimeoutMs, fallback } = {}) {
        if (this.shuttingDown) {
            return failureResult(`tool worker pool '${this.name}' is shutting down`);
        }
        if (this.isDegraded()) {
            return this.runFallback(fallback);
        }
        const effectiveTimeoutMs = timerDelay(callTimeoutMs, this.callTimeoutMs);
        const marker = crypto.randomBytes(16).toString('hex');
        const frame = {
            v: TOOL_WORKER_PROTOCOL_VERSION,
            type: 'call',
            id: `${this.name}-${this.nextCallId++}`,
            marker,
            toolName: typeof toolName === 'string' ? toolName : '',
            toolEnv: toolEnv && typeof toolEnv === 'object' ? toolEnv : {},
            envelope: payload ?? {},
        };
        const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
        // maxFrameBytes bounds a frame without its newline, as the decoder counts it.
        if (encoded.length - 1 > this.maxFrameBytes) {
            return failureResult(`tool worker call frame exceeds maxFrameBytes (${this.maxFrameBytes})`);
        }

        // Calls that a starting worker, or a worker the pool may still spawn,
        // will take do not occupy the bounded wait queue.
        const spawnCapacity = Math.max(0, this.size - this.workers.size);
        const waitingForWorker = this.queue.length - this.countWorkers('starting') - spawnCapacity;
        if (waitingForWorker >= this.maxQueue && !this.findIdleWorker()) {
            this.counters.saturated += 1;
            return failureResult(`tool worker pool '${this.name}' is saturated (maxQueue ${this.maxQueue})`);
        }

        return new Promise((resolve) => {
            const markerBytes = Buffer.from(toolWorkerEndMarker(marker), 'utf8');
            const call = {
                id: frame.id,
                encoded,
                output: {
                    stdout: { marker: markerBytes, chunks: [], carry: null, done: false },
                    stderr: { marker: markerBytes, chunks: [], carry: null, done: false },
                },
                outputBytes: 0,
                resultFrame: null,
                fallback,
                timeoutMs: effectiveTimeoutMs,
                worker: null,
                settled: false,
                timer: null,
                resolve,
            };
            // Queue wait counts toward the call timeout.
            call.timer = setTimeout(() => this.onCallTimeout(call), effectiveTimeoutMs);
            this.queue.push(call);
            this.pump();
        });
    }

    async runFallback(fallback, reason = 'is degraded') {
        if (typeof fallback !== 'function') {
            return failureResult(`tool worker pool '${this.name}' ${reason} and no spawn fallback was supplied`);
        }
        this.counters.fallbacks += 1;
        try {
            return await fallback();
        } catch (error) {
            return failureResult(`spawn fallback failed: ${error?.message || error}`);
        }
    }

    settle(call, result) {
        if (call.settled) return false;
        call.settled = true;
        clearTimeout(call.timer);
        call.timer = null;
        call.resolve(result);
        return true;
    }

    countWorkers(state) {
        let count = 0;
        for (const worker of this.workers) if (worker.state === state) count += 1;
        return count;
    }

    findIdleWorker() {
        for (const worker of this.workers) if (worker.state === 'idle') return worker;
        return null;
    }

    // The current code identity, read from the hook on every use (no caching).
    readIdentity() {
        if (!this.codeIdentity) return { ok: true, value: null };
        try {
            return { ok: true, value: String(this.codeIdentity()) };
        } catch (error) {
            this.log(`[toolWorkerPool:${this.name}] codeIdentity failed (${error?.message || error}); using the spawn fallback`);
            return { ok: false, value: undefined };
        }
    }

    // Before every dispatch: retire idle workers spawned under another code
    // identity and pick a current one.
    takeCurrentWorker() {
        const identity = this.readIdentity();
        if (!identity.ok) return { identityError: true, worker: null };
        let found = null;
        for (const worker of [...this.workers]) {
            if (worker.state !== 'idle') continue;
            if (worker.identity !== identity.value) {
                this.log(`${this.prefix(worker)} tool code changed; replacing the worker`);
                this.counters.recycled += 1;
                this.retire(worker);
                continue;
            }
            if (!found) found = worker;
        }
        return { identityError: false, worker: found };
    }

    pump() {
        if (this.shuttingDown) return;
        while (this.queue.length) {
            const pick = this.takeCurrentWorker();
            if (pick.identityError) {
                this.runQueuedOnFallback(this.queue.shift(), 'tool code identity could not be read');
                continue;
            }
            if (!pick.worker) break;
            this.dispatch(pick.worker, this.queue.shift());
        }
        // Workers being retired still count toward `size` until they exit.
        while (this.queue.length > this.countWorkers('starting') && this.workers.size < this.size) {
            if (!this.spawnWorker()) break;
        }
    }

    dispatch(worker, call) {
        clearTimeout(worker.idleTimer);
        worker.idleTimer = null;
        worker.state = 'busy';
        worker.call = call;
        call.worker = worker;
        try {
            worker.channel.write(call.encoded);
        } catch (_) {
            this.failBusyCall(worker, 'tool worker channel closed before the call was sent');
            this.retire(worker);
        }
    }

    spawnWorker() {
        this.counters.spawned += 1;
        const worker = {
            child: null,
            pid: null,
            channel: null,
            server: null,
            socketDir: null,
            socketPath: null,
            token: crypto.randomBytes(32).toString('hex'),
            state: 'starting',
            calls: 0,
            call: null,
            idleTimer: null,
            readyTimer: null,
            gone: false,
            identity: this.readIdentity().value,
        };
        this.workers.add(worker);
        worker.readyTimer = setTimeout(() => {
            if (worker.state !== 'starting') return;
            this.log(`${this.prefix(worker)} not ready after ${this.readyTimeoutMs}ms; killing it`);
            this.retire(worker);
            if (!worker.child) this.abandonStart(worker);
        }, this.readyTimeoutMs);

        try {
            const { dir, socketPath } = createSocketPath();
            worker.socketDir = dir;
            worker.socketPath = socketPath;
        } catch (error) {
            this.log(`[toolWorkerPool:${this.name}] cannot create a worker socket: ${error?.message || error}`);
            setImmediate(() => this.abandonStart(worker));
            return true;
        }
        const server = net.createServer();
        worker.server = server;
        server.on('connection', (socket) => this.onHandshakeConnection(worker, socket));
        server.on('error', (error) => {
            this.log(`[toolWorkerPool:${this.name}] worker socket error: ${error?.message || error}`);
            if (!worker.child) this.abandonStart(worker);
            else this.retire(worker);
        });
        server.listen(worker.socketPath, () => this.launchWorker(worker));
        return true;
    }

    prefix(worker) {
        return `[toolWorker:${this.name} pid=${worker.pid ?? '?'}]`;
    }

    // A worker that never got a process (socket setup failed, or it was
    // retired before its listener was ready).
    abandonStart(worker) {
        if (worker.gone || worker.child) return;
        this.onWorkerGone(worker, { code: null, signal: null });
    }

    closeServer(worker) {
        const server = worker.server;
        worker.server = null;
        if (server) {
            try {
                server.close();
            } catch (_) {
                // Already closed.
            }
        }
        if (worker.socketDir) {
            fs.rmSync(worker.socketDir, { recursive: true, force: true });
            worker.socketDir = null;
        }
    }

    launchWorker(worker) {
        if (worker.gone) return;
        if (worker.state !== 'starting' || this.shuttingDown) {
            this.abandonStart(worker);
            return;
        }
        let child;
        try {
            child = spawn(this.command, this.args, {
                cwd: this.cwd,
                env: {
                    ...process.env,
                    ...this.env,
                    PLOINKY_TOOL_WORKER_PROTOCOL: String(TOOL_WORKER_PROTOCOL_VERSION),
                    PLOINKY_TOOL_WORKER_MODULE: TOOL_WORKER_MODULE_PATH,
                    PLOINKY_TOOL_WORKER_SOCKET: worker.socketPath,
                },
                stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
                detached: true,
            });
        } catch (error) {
            this.log(`[toolWorkerPool:${this.name}] spawn failed: ${error?.message || error}`);
            this.abandonStart(worker);
            return;
        }
        worker.child = child;
        worker.pid = child.pid;

        worker.strayPartial = { stdout: '', stderr: '' };
        for (const streamName of ['stdout', 'stderr']) {
            const stream = child[streamName];
            stream.on('data', (chunk) => this.onPipeData(worker, streamName, chunk));
            stream.on('end', () => this.flushStray(worker, streamName));
            stream.on('error', () => {});
        }

        // fd 3: the bootstrap token, then EOF. Nothing else ever travels there.
        const boot = child.stdio[3];
        if (boot) {
            boot.on('error', () => {});
            boot.on('data', () => {});
            boot.end(`${worker.token}\n`);
        }

        child.on('error', (error) => {
            this.log(`${this.prefix(worker)} process error: ${error?.message || error}`);
            if (!child.pid) this.onWorkerGone(worker, { code: null, signal: null, spawnError: true });
        });
        child.on('exit', (code, signal) => this.onWorkerExit(worker, { code, signal }));
        child.on('close', () => {
            worker.stdioClosed = true;
            this.maybeGone(worker);
        });
    }

    // Accept the worker's channel only from a peer that presents its token.
    // Attribute pipe bytes to the busy call up to its end marker (matched
    // anywhere, also across chunks, and never passed on); everything else is
    // stray output.
    onPipeData(worker, streamName, chunk) {
        const call = worker.call;
        const sink = call && !call.settled ? call.output[streamName] : null;
        if (!sink || sink.done) {
            this.onStrayOutput(worker, streamName, chunk);
            return;
        }
        const data = sink.carry ? Buffer.concat([sink.carry, chunk]) : chunk;
        sink.carry = null;
        const index = data.indexOf(sink.marker);
        if (index !== -1) {
            if (!this.commitOutput(worker, call, sink, data.subarray(0, index))) return;
            sink.done = true;
            const rest = data.subarray(index + sink.marker.length);
            if (rest.length) this.onStrayOutput(worker, streamName, rest);
            this.maybeCompleteCall(worker, call);
            return;
        }
        // Keep a possible marker prefix until the next chunk.
        const keep = Math.min(data.length, sink.marker.length - 1);
        if (!this.commitOutput(worker, call, sink, data.subarray(0, data.length - keep))) return;
        sink.carry = Buffer.from(data.subarray(data.length - keep));
    }

    commitOutput(worker, call, sink, bytes) {
        if (!bytes.length) return true;
        call.outputBytes += bytes.length;
        if (call.outputBytes > this.maxFrameBytes) {
            const message = `tool worker output exceeds maxFrameBytes (${this.maxFrameBytes})`;
            this.log(`${this.prefix(worker)} ${message}; recycling`);
            this.failBusyCall(worker, message);
            this.counters.recycled += 1;
            this.retire(worker);
            this.pump();
            return false;
        }
        sink.chunks.push(Buffer.from(bytes));
        return true;
    }

    // Output that belongs to no call: logged, never attributed. A worker
    // being retired is ignored. Output while idle means something outlived its
    // call (e.g. a background tool child), so the worker is replaced before it
    // can write into a later call; output after a marker recycles it after
    // the call.
    onStrayOutput(worker, streamName, chunk) {
        if (worker.state === 'retiring' || worker.gone) return;
        this.logStray(worker, streamName, chunk.toString('utf8'));
        if (worker.state === 'idle') {
            this.log(`${this.prefix(worker)} output outside a call; replacing the worker`);
            this.counters.recycled += 1;
            this.retire(worker);
            this.pump();
        } else if (worker.state === 'busy') {
            worker.dirty = true;
        }
    }

    logStray(worker, streamName, text) {
        const lines = (worker.strayPartial[streamName] + text).split('\n');
        worker.strayPartial[streamName] = lines.pop();
        for (const line of lines) if (line) this.log(`${this.prefix(worker)} ${line}`);
        if (worker.strayPartial[streamName].length > MAX_LOG_PARTIAL_CHARS) this.flushStray(worker, streamName);
    }

    flushStray(worker, streamName) {
        const partial = worker.strayPartial?.[streamName];
        if (partial) this.log(`${this.prefix(worker)} ${partial}`);
        if (worker.strayPartial) worker.strayPartial[streamName] = '';
    }

    maybeCompleteCall(worker, call) {
        if (worker.call !== call || call.settled) return;
        const frame = call.resultFrame;
        if (!frame || !call.output.stdout.done || !call.output.stderr.done) return;
        worker.call = null;
        worker.calls += 1;
        this.counters.completed += 1;
        this.unproductiveDeaths = 0;
        this.settle(call, {
            code: Number.isInteger(frame.exitCode) ? frame.exitCode : 1,
            signal: null,
            stdout: Buffer.concat(call.output.stdout.chunks).toString('utf8'),
            stderr: Buffer.concat(call.output.stderr.chunks).toString('utf8'),
        });
        // A worker that announced its exit is already on its way out.
        if (worker.announcedExit) {
            this.pump();
            return;
        }
        const rss = Number(frame.rssBytes);
        const recycle = frame.recycle === true
            || worker.dirty === true
            || worker.calls >= this.maxCallsPerWorker
            || (Number.isFinite(rss) && rss > this.maxRssBytes);
        if (recycle) {
            this.counters.recycled += 1;
            this.retire(worker);
            this.pump();
            return;
        }
        worker.state = 'idle';
        this.becomeIdle(worker);
    }

    onHandshakeConnection(worker, socket) {
        socket.on('error', () => {});
        if (worker.channel || worker.state !== 'starting') {
            socket.destroy();
            return;
        }
        let buffered = Buffer.alloc(0);
        const onData = (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            const newline = buffered.indexOf(0x0a);
            if (newline === -1) {
                if (buffered.length > HELLO_MAX_BYTES) socket.destroy();
                return;
            }
            socket.removeListener('data', onData);
            let hello = null;
            try {
                hello = JSON.parse(buffered.subarray(0, newline).toString('utf8'));
            } catch (_) {
                hello = null;
            }
            if (!hello || hello.v !== TOOL_WORKER_PROTOCOL_VERSION || hello.type !== 'hello'
                || !tokensEqual(hello.token, worker.token) || worker.channel || worker.state !== 'starting') {
                socket.destroy();
                return;
            }
            this.adoptChannel(worker, socket, buffered.subarray(newline + 1));
        };
        socket.on('data', onData);
    }

    adoptChannel(worker, socket, rest) {
        worker.channel = socket;
        worker.token = null;
        this.closeServer(worker);
        const decoder = new FrameDecoder(
            this.maxFrameBytes,
            (frame) => this.onFrame(worker, frame),
            (reason) => this.onProtocolError(worker, reason),
        );
        socket.on('data', (chunk) => decoder.push(chunk));
        // A worker that closes its channel can no longer answer: end it.
        socket.on('end', () => {
            if (worker.gone || worker.endTimer) return;
            worker.endTimer = setTimeout(() => this.retire(worker), CHANNEL_END_GRACE_MS);
            worker.endTimer.unref?.();
        });
        socket.on('close', () => {
            worker.channelClosed = true;
            this.maybeGone(worker);
        });
        if (rest.length) decoder.push(rest);
    }

    maybeGone(worker) {
        if (worker.exitInfo && worker.stdioClosed && (!worker.channel || worker.channelClosed)) {
            this.onWorkerGone(worker, worker.exitInfo);
        }
    }

    onFrame(worker, frame) {
        // Late frames from a worker being retired (e.g. a result after its
        // call timed out) are dropped.
        if (worker.gone || worker.state === 'retiring' || worker.state === 'starting-retiring') return;
        if (!frame || frame.v !== TOOL_WORKER_PROTOCOL_VERSION) {
            this.onProtocolError(worker, 'unsupported frame');
            return;
        }
        if (frame.type === 'exiting') {
            this.onWorkerExiting(worker, frame.startedCallId ?? null);
            return;
        }
        if (frame.type === 'ready' && worker.state === 'starting') {
            clearTimeout(worker.readyTimer);
            worker.readyTimer = null;
            worker.state = 'idle';
            this.becomeIdle(worker);
            return;
        }
        if (frame.type === 'result' && worker.state === 'busy' && worker.call
            && frame.id === worker.call.id && !worker.call.resultFrame) {
            worker.call.resultFrame = frame;
            this.maybeCompleteCall(worker, worker.call);
            return;
        }
        if (frame.type === 'log') {
            const text = typeof frame.text === 'string' ? frame.text : '';
            for (const line of text.split('\n')) if (line) this.log(`${this.prefix(worker)} ${line}`);
            return;
        }
        this.onProtocolError(worker, 'unexpected frame');
    }

    onProtocolError(worker, reason) {
        // The reason names the failure only; frame contents are never logged.
        const message = reason === 'oversize'
            ? `tool worker reply exceeds maxFrameBytes (${this.maxFrameBytes})`
            : `tool worker protocol error (${reason})`;
        this.log(`[toolWorker:${this.name} pid=${worker.pid ?? '?'}] ${message}; recycling`);
        this.failBusyCall(worker, message);
        this.counters.recycled += 1;
        this.retire(worker);
        this.pump();
    }

    becomeIdle(worker) {
        if (this.shuttingDown) {
            this.retire(worker);
            return;
        }
        // Queued calls go through pump(), which validates the code identity.
        if (this.queue.length) this.pump();
        if (worker.state !== 'idle') return;
        clearTimeout(worker.idleTimer);
        worker.idleTimer = setTimeout(() => {
            if (worker.state !== 'idle') return;
            this.retire(worker);
        }, this.idleTimeoutMs);
        worker.idleTimer.unref?.();
    }

    failBusyCall(worker, message) {
        const call = worker.call;
        if (!call) return;
        worker.call = null;
        this.settle(call, failureResult(message));
    }

    onCallTimeout(call) {
        if (call.settled) return;
        const message = `tool worker call timed out after ${call.timeoutMs}ms`;
        const worker = call.worker;
        if (!worker) {
            const index = this.queue.indexOf(call);
            if (index !== -1) this.queue.splice(index, 1);
            this.counters.timeouts += 1;
            this.settle(call, failureResult(`${message} waiting for a worker`));
            return;
        }
        this.counters.timeouts += 1;
        this.log(`[toolWorker:${this.name} pid=${worker.pid ?? '?'}] call timed out after ${call.timeoutMs}ms; killing the worker process group`);
        this.failBusyCall(worker, message);
        this.retire(worker);
    }

    // Take a worker out of service and kill its process group. It keeps
    // counting toward `size` until its exit is observed.
    retire(worker) {
        if (worker.gone) return;
        worker.retiredByPool = true;
        clearTimeout(worker.idleTimer);
        worker.idleTimer = null;
        if (worker.state !== 'starting') {
            clearTimeout(worker.readyTimer);
            worker.readyTimer = null;
        }
        worker.state = worker.state === 'starting' ? 'starting-retiring' : 'retiring';
        // Kill before closing the channel so the group kill, not the worker's
        // own EOF handling, decides what ends.
        killWorkerGroup(worker.child);
        try {
            worker.channel?.destroy();
        } catch (_) {
            // Already closed.
        }
    }

    // The worker announced that it exits (a fatal error outside any call). It
    // names the last call it started; it starts no call after the
    // announcement, and frames are ordered. A sent call that is not the named
    // one and has no result frame was therefore never started, and goes back
    // to the queue head. Any other call is never run again: it completes from
    // its result frame and end markers, or fails when the worker's exit settles.
    onWorkerExiting(worker, startedCallId) {
        worker.announcedExit = true;
        clearTimeout(worker.idleTimer);
        worker.idleTimer = null;
        clearTimeout(worker.readyTimer);
        worker.readyTimer = null;
        const sent = worker.call;
        worker.state = 'retiring';
        if (sent && !sent.settled && sent.id !== startedCallId && !sent.resultFrame) {
            worker.call = null;
            if (sent.requeued) {
                // Bounded: a call is put back once. A second unstarted loss
                // fails it (it never ran, so failing is safe).
                this.settle(sent, failureResult('tool worker exited twice before starting the call'));
                this.scheduleExitKill(worker);
                this.pump();
                return;
            }
            sent.requeued = true;
            sent.worker = null;
            sent.resultFrame = null;
            sent.outputBytes = 0;
            for (const sink of Object.values(sent.output)) {
                sink.chunks = [];
                sink.carry = null;
                sink.done = false;
            }
            this.queue.unshift(sent);
        }
        this.scheduleExitKill(worker);
        this.pump();
    }

    // Give a worker that announced its exit a short grace, then kill its group.
    scheduleExitKill(worker) {
        clearTimeout(worker.endTimer);
        worker.endTimer = setTimeout(() => {
            if (!worker.gone) killWorkerGroup(worker.child);
        }, CHANNEL_END_GRACE_MS);
        worker.endTimer.unref?.();
    }

    // The leader exited. Kill the rest of its group so the pipes close, then
    // finish once its stdio has closed (frames already written still count).
    onWorkerExit(worker, exitInfo) {
        if (worker.gone || worker.exitInfo) return;
        worker.exitInfo = exitInfo;
        killWorkerGroup(worker.child);
        worker.settleTimer = setTimeout(() => this.onWorkerGone(worker, exitInfo), EXIT_SETTLE_MS);
        this.maybeGone(worker);
    }

    onWorkerGone(worker, { code, signal }) {
        if (worker.gone) return;
        const wasStarting = worker.state === 'starting' || worker.state === 'starting-retiring';
        if (worker.state === 'idle' || worker.state === 'busy' || worker.announcedExit) {
            this.log(`[toolWorker:${this.name} pid=${worker.pid ?? '?'}] exited unexpectedly (code ${code}, signal ${signal})`);
        }
        worker.gone = true;
        clearTimeout(worker.idleTimer);
        clearTimeout(worker.readyTimer);
        clearTimeout(worker.settleTimer);
        clearTimeout(worker.endTimer);
        worker.idleTimer = null;
        worker.readyTimer = null;
        this.workers.delete(worker);
        this.closeServer(worker);
        // Tool children may outlive the leader; end the whole group.
        killWorkerGroup(worker.child);
        try {
            worker.channel?.destroy();
        } catch (_) {
            // Already closed.
        }
        if (worker.call) {
            this.counters.crashes += 1;
            this.failBusyCall(worker, `tool worker exited (code ${code}, signal ${signal}) during the call`);
        }
        if (!this.shuttingDown && (wasStarting || (worker.calls === 0 && !worker.retiredByPool))) {
            this.recordUnproductiveDeath();
        }
        this.notifyExitWaiters();
        if (this.isDegraded()) {
            this.drainQueueToFallback();
            return;
        }
        this.pump();
    }

    recordUnproductiveDeath() {
        this.unproductiveDeaths += 1;
        if (this.unproductiveDeaths >= UNPRODUCTIVE_DEATH_LIMIT) {
            this.unproductiveDeaths = 0;
            this.degradedUntil = this.now() + DEGRADED_MS;
            this.log(`[toolWorkerPool:${this.name}] ${UNPRODUCTIVE_DEATH_LIMIT} consecutive workers exited before completing a call; degraded for ${DEGRADED_MS}ms (spawn fallback)`);
            this.drainQueueToFallback();
        }
    }

    drainQueueToFallback() {
        for (const call of this.queue.splice(0)) this.runQueuedOnFallback(call, 'is degraded');
    }

    runQueuedOnFallback(call, reason) {
        if (!call || call.settled) return;
        clearTimeout(call.timer);
        call.timer = null;
        call.settled = true;
        Promise.resolve()
            .then(() => this.runFallback(call.fallback, reason === 'is degraded' ? reason : `cannot run the call (${reason})`))
            .then(call.resolve);
    }

    notifyExitWaiters() {
        if (this.workers.size > 0 || !this.exitWaiters) return;
        const waiters = this.exitWaiters;
        this.exitWaiters = null;
        for (const resolve of waiters) resolve();
    }

    /**
     * Stop accepting calls, fail queued and in-flight calls, SIGKILL every
     * worker process group and wait (bounded) until all are gone.
     * @returns {Promise<{ clean: boolean }>}
     */
    shutdown({ timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS } = {}) {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.shuttingDown = true;
        registeredPools.delete(this);
        const message = `tool worker pool '${this.name}' is shutting down`;
        for (const call of this.queue.splice(0)) this.settle(call, failureResult(message));
        const pids = [];
        for (const worker of this.workers) {
            if (worker.pid) pids.push(worker.pid);
            this.failBusyCall(worker, message);
            this.retire(worker);
        }
        this.shutdownPromise = (async () => {
            const deadline = Date.now() + timerDelay(timeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
            if (this.workers.size > 0) {
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
                    timer.unref?.();
                    this.exitWaiters = this.exitWaiters || [];
                    this.exitWaiters.push(() => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            }
            // The leaders are gone; wait for any group members to disappear too.
            while (pids.some((pid) => processGroupExists(pid)) && Date.now() < deadline) {
                for (const pid of pids) {
                    try {
                        process.kill(-pid, 'SIGKILL');
                    } catch (_) {
                        // Group already gone.
                    }
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            const clean = this.workers.size === 0 && !pids.some((pid) => processGroupExists(pid));
            if (!clean) this.log(`[toolWorkerPool:${this.name}] shutdown timed out with worker processes still present`);
            return { clean };
        })();
        return this.shutdownPromise;
    }
}

/**
 * Build the pools declared under `config.toolWorkers`. Invalid declarations
 * are skipped with a warning. Created pools are also tracked for
 * `shutdownToolWorkerPools`.
 *
 * @param {object} config agent MCP config
 * @param {{ buildCommandSpec: Function, defaultCwd?: string, log?: Function, codeIdentity?: (poolName: string) => string }} deps
 *   `codeIdentity(poolName)` returns a stamp of the pool's tool code, manifest
 *   and generation; it is read before every dispatch (see ToolWorkerPool).
 * @returns {Map<string, ToolWorkerPool>}
 */
export function createToolWorkerPools(config, { buildCommandSpec, defaultCwd, log, codeIdentity } = {}) {
    const pools = new Map();
    const declarations = config && typeof config === 'object' ? config.toolWorkers : null;
    if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) return pools;
    if (typeof buildCommandSpec !== 'function') {
        throw new TypeError('createToolWorkerPools requires buildCommandSpec');
    }
    const logLine = typeof log === 'function' ? log : defaultLog;
    for (const [name, declaration] of Object.entries(declarations)) {
        if (!name || !declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
            logLine(`[toolWorkerPool] skipping tool worker pool '${name}': declaration must be an object`);
            continue;
        }
        const spec = buildCommandSpec(declaration, defaultCwd);
        if (!spec || typeof spec.command !== 'string' || !spec.command) {
            logLine(`[toolWorkerPool] skipping tool worker pool '${name}': missing command`);
            continue;
        }
        const pool = new ToolWorkerPool(name, {
            command: spec.command,
            args: spec.args,
            cwd: spec.cwd,
            env: spec.env,
            size: declaration.size,
            maxQueue: declaration.maxQueue,
            callTimeoutMs: declaration.callTimeoutMs,
            readyTimeoutMs: declaration.readyTimeoutMs,
            maxCallsPerWorker: declaration.maxCallsPerWorker,
            maxRssBytes: declaration.maxRssBytes,
            idleTimeoutMs: declaration.idleTimeoutMs,
            maxFrameBytes: declaration.maxFrameBytes,
            log: logLine,
            codeIdentity: typeof codeIdentity === 'function' ? () => codeIdentity(name) : undefined,
        });
        pools.set(name, pool);
        registeredPools.add(pool);
    }
    return pools;
}

/**
 * Shut down every pool created by `createToolWorkerPools` (or the given pools).
 * @returns {Promise<{ clean: boolean }>}
 */
export async function shutdownToolWorkerPools({ timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS, pools } = {}) {
    const targets = pools ? [...(pools instanceof Map ? pools.values() : pools)] : [...registeredPools];
    const results = await Promise.all(targets.map((pool) => pool.shutdown({ timeoutMs })));
    return { clean: results.every((result) => result.clean) };
}
