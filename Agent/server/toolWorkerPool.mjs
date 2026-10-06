// Opt-in pools of persistent tool-worker processes.
//
// An agent declares `toolWorkers.<pool>` in its MCP config; tools that name
// that pool can run in a warm worker instead of a fresh process per call. Each
// worker is spawned detached (it leads its own process group), gets
// /dev/null on stdin and talks to the pool over fd 3 with newline-delimited
// JSON frames (see Agent/lib/toolWorker.mjs). Pools never retry a call, never
// log frames (they can carry invocation tokens) and never leave a worker
// process group behind: timeouts, crashes, recycling and shutdown all end with
// a SIGKILL to the worker's process group.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// Consecutive deaths before `ready` (no worker became ready in between) that
// mark the command broken. Counting consecutive deaths, not deaths inside a
// fixed time window, also catches workers that hang until readyTimeoutMs.
const PRE_READY_DEATH_LIMIT = 3;
const DEGRADED_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;
const MAX_LOG_PARTIAL_CHARS = 64 * 1024;

const registeredPools = new Set();

function positiveInteger(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value, fallback) {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
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
        this.callTimeoutMs = positiveInteger(options.callTimeoutMs, TOOL_WORKER_DEFAULTS.callTimeoutMs);
        this.readyTimeoutMs = positiveInteger(options.readyTimeoutMs, TOOL_WORKER_DEFAULTS.readyTimeoutMs);
        this.maxCallsPerWorker = positiveInteger(options.maxCallsPerWorker, TOOL_WORKER_DEFAULTS.maxCallsPerWorker);
        this.maxRssBytes = positiveInteger(options.maxRssBytes, TOOL_WORKER_DEFAULTS.maxRssBytes);
        this.idleTimeoutMs = positiveInteger(options.idleTimeoutMs, TOOL_WORKER_DEFAULTS.idleTimeoutMs);
        this.maxFrameBytes = positiveInteger(options.maxFrameBytes, TOOL_WORKER_DEFAULTS.maxFrameBytes);
        this.log = typeof options.log === 'function' ? options.log : defaultLog;
        this.now = typeof options.now === 'function' ? options.now : Date.now;

        this.workers = new Set();
        this.queue = [];
        this.nextCallId = 1;
        this.preReadyDeaths = 0;
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
    async call({ toolName, toolEnv, payload, timeoutMs, fallback } = {}) {
        if (this.shuttingDown) {
            return failureResult(`tool worker pool '${this.name}' is shutting down`);
        }
        if (this.isDegraded()) {
            return this.runFallback(fallback);
        }
        const effectiveTimeoutMs = positiveInteger(timeoutMs, this.callTimeoutMs);
        const frame = {
            v: TOOL_WORKER_PROTOCOL_VERSION,
            type: 'call',
            id: `${this.name}-${this.nextCallId++}`,
            toolName: typeof toolName === 'string' ? toolName : '',
            toolEnv: toolEnv && typeof toolEnv === 'object' ? toolEnv : {},
            envelope: payload ?? {},
        };
        const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
        if (encoded.length > this.maxFrameBytes) {
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

        return new Promise((resolve, reject) => {
            const call = {
                id: frame.id,
                encoded,
                fallback,
                timeoutMs: effectiveTimeoutMs,
                worker: null,
                settled: false,
                timer: null,
                resolve,
                reject,
            };
            // Queue wait counts toward the call timeout.
            call.timer = setTimeout(() => this.onCallTimeout(call), effectiveTimeoutMs);
            this.queue.push(call);
            this.pump();
        });
    }

    async runFallback(fallback) {
        if (typeof fallback !== 'function') {
            return failureResult(`tool worker pool '${this.name}' is degraded and no spawn fallback was supplied`);
        }
        this.counters.fallbacks += 1;
        return fallback();
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

    pump() {
        if (this.shuttingDown) return;
        while (this.queue.length) {
            const worker = this.findIdleWorker();
            if (!worker) break;
            this.dispatch(worker, this.queue.shift());
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
        let child;
        try {
            child = spawn(this.command, this.args, {
                cwd: this.cwd,
                env: {
                    ...process.env,
                    ...this.env,
                    PLOINKY_TOOL_WORKER_PROTOCOL: String(TOOL_WORKER_PROTOCOL_VERSION),
                    PLOINKY_TOOL_WORKER_MODULE: TOOL_WORKER_MODULE_PATH,
                },
                stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
                detached: true,
            });
        } catch (error) {
            this.log(`[toolWorkerPool:${this.name}] spawn failed: ${error?.message || error}`);
            this.recordPreReadyDeath();
            return false;
        }
        this.counters.spawned += 1;
        const worker = {
            child,
            pid: child.pid,
            channel: child.stdio[3],
            state: 'starting',
            calls: 0,
            call: null,
            idleTimer: null,
            readyTimer: null,
            gone: false,
        };
        this.workers.add(worker);

        const prefix = () => `[toolWorker:${this.name} pid=${worker.pid ?? '?'}]`;
        const forward = (stream) => {
            let partial = '';
            stream.setEncoding('utf8');
            stream.on('data', (text) => {
                const lines = (partial + text).split('\n');
                partial = lines.pop();
                for (const line of lines) if (line) this.log(`${prefix()} ${line}`);
                // Output without newlines (e.g. from a tool child) is not held forever.
                if (partial.length > MAX_LOG_PARTIAL_CHARS) {
                    this.log(`${prefix()} ${partial}`);
                    partial = '';
                }
            });
            stream.on('end', () => {
                if (partial) this.log(`${prefix()} ${partial}`);
                partial = '';
            });
            stream.on('error', () => {});
        };
        forward(child.stdout);
        forward(child.stderr);

        const decoder = new FrameDecoder(
            this.maxFrameBytes,
            (frame) => this.onFrame(worker, frame),
            (reason) => this.onProtocolError(worker, reason),
        );
        if (worker.channel) {
            worker.channel.on('data', (chunk) => decoder.push(chunk));
            worker.channel.on('error', () => {});
            // A worker that closes its channel can no longer answer: end it.
            worker.channel.on('end', () => this.retire(worker));
        }

        worker.readyTimer = setTimeout(() => {
            if (worker.state !== 'starting') return;
            this.log(`${prefix()} not ready after ${this.readyTimeoutMs}ms; killing it`);
            this.retire(worker);
        }, this.readyTimeoutMs);

        child.on('error', (error) => {
            this.log(`${prefix()} process error: ${error?.message || error}`);
            if (!child.pid) this.onWorkerGone(worker, { code: null, signal: null, spawnError: true });
        });
        child.on('exit', (code, signal) => this.onWorkerGone(worker, { code, signal }));
        return true;
    }

    onFrame(worker, frame) {
        // Late frames from a worker being retired (e.g. a result after its
        // call timed out) are dropped.
        if (worker.gone || worker.state === 'retiring' || worker.state === 'starting-retiring') return;
        if (!frame || frame.v !== TOOL_WORKER_PROTOCOL_VERSION) {
            this.onProtocolError(worker, 'unsupported frame');
            return;
        }
        if (frame.type === 'ready' && worker.state === 'starting') {
            clearTimeout(worker.readyTimer);
            worker.readyTimer = null;
            worker.state = 'idle';
            this.preReadyDeaths = 0;
            this.becomeIdle(worker);
            return;
        }
        if (frame.type === 'result' && worker.state === 'busy' && worker.call && frame.id === worker.call.id) {
            const call = worker.call;
            worker.call = null;
            worker.calls += 1;
            this.counters.completed += 1;
            this.settle(call, {
                code: Number.isInteger(frame.exitCode) ? frame.exitCode : 1,
                signal: null,
                stdout: typeof frame.stdout === 'string' ? frame.stdout : '',
                stderr: typeof frame.stderr === 'string' ? frame.stderr : '',
            });
            const rss = Number(frame.rssBytes);
            const recycle = frame.recycle === true
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
        const next = this.queue.shift();
        if (next) {
            this.dispatch(worker, next);
            return;
        }
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
        clearTimeout(worker.idleTimer);
        worker.idleTimer = null;
        if (worker.state !== 'starting') {
            clearTimeout(worker.readyTimer);
            worker.readyTimer = null;
        }
        worker.state = worker.state === 'starting' ? 'starting-retiring' : 'retiring';
        // Kill before closing fd 3 so the group kill, not the worker's own
        // EOF handling, decides what ends.
        killWorkerGroup(worker.child);
        try {
            worker.channel?.destroy();
        } catch (_) {
            // Already closed.
        }
    }

    onWorkerGone(worker, { code, signal }) {
        if (worker.gone) return;
        const wasStarting = worker.state === 'starting' || worker.state === 'starting-retiring';
        worker.gone = true;
        clearTimeout(worker.idleTimer);
        clearTimeout(worker.readyTimer);
        worker.idleTimer = null;
        worker.readyTimer = null;
        this.workers.delete(worker);
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
        if (wasStarting && !this.shuttingDown) {
            this.recordPreReadyDeath();
        }
        this.notifyExitWaiters();
        if (this.isDegraded()) {
            this.drainQueueToFallback();
            return;
        }
        this.pump();
    }

    recordPreReadyDeath() {
        this.preReadyDeaths += 1;
        if (this.preReadyDeaths >= PRE_READY_DEATH_LIMIT) {
            this.preReadyDeaths = 0;
            this.degradedUntil = this.now() + DEGRADED_MS;
            this.log(`[toolWorkerPool:${this.name}] ${PRE_READY_DEATH_LIMIT} consecutive workers died before ready; degraded for ${DEGRADED_MS}ms (spawn fallback)`);
            this.drainQueueToFallback();
        }
    }

    drainQueueToFallback() {
        const waiting = this.queue.splice(0);
        for (const call of waiting) {
            if (call.settled) continue;
            clearTimeout(call.timer);
            call.timer = null;
            call.settled = true;
            Promise.resolve()
                .then(() => this.runFallback(call.fallback))
                .then(call.resolve, call.reject);
        }
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
            const deadline = Date.now() + positiveInteger(timeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
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
 * @param {{ buildCommandSpec: Function, defaultCwd?: string, log?: Function }} deps
 * @returns {Map<string, ToolWorkerPool>}
 */
export function createToolWorkerPools(config, { buildCommandSpec, defaultCwd, log } = {}) {
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
