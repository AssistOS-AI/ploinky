// Runtime for a persistent tool worker started by Agent/server/toolWorkerPool.mjs.
//
// An agent opts in by declaring a worker command whose script imports this
// module (its absolute path arrives in PLOINKY_TOOL_WORKER_MODULE) and calls
// `serveToolWorker(handler)`.
//
// Channel. fd 3 carries only a one-time bootstrap token. The worker reads it,
// connects to the pool's private Unix socket (PLOINKY_TOOL_WORKER_SOCKET),
// proves itself with the token and closes fd 3. libuv creates the connected
// socket close-on-exec, so no tool child inherits the channel, reads later
// calls' frames (which can carry invocation tokens) or forges replies. Frames
// are newline-delimited JSON:
//
//   worker -> pool  {"v":1,"type":"hello","token"}, then {"v":1,"type":"ready","pid"}
//   pool -> worker  {"v":1,"type":"call","id","toolName","toolEnv","envelope"}
//   worker -> pool  {"v":1,"type":"result","id","exitCode","stdout","stderr","rssBytes","recycle"}
//
// One call runs at a time. Frames can carry invocation tokens, so this module
// never logs frame contents. stdin is /dev/null, so a handler that reads stdin
// sees EOF instead of protocol frames.

import net from 'node:net';
import { Writable } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';

export const TOOL_WORKER_PROTOCOL_VERSION = 1;
export const TOOL_WORKER_EXIT_OUTSIDE_CALL = 70;

const EXIT_FLUSH_TIMEOUT_MS = 1000;
const BOOTSTRAP_MAX_BYTES = 1024;

const callStorage = new AsyncLocalStorage();

function toBuffer(chunk, encoding) {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (typeof chunk === 'string') {
        return Buffer.from(chunk, typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8');
    }
    if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return Buffer.from(String(chunk));
}

function snapshotEnv() {
    return { ...process.env };
}

// Put process.env back to the snapshot. Returns true when the call had changed it.
function restoreEnv(snapshot) {
    let changed = false;
    for (const key of Object.keys(process.env)) {
        if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
            delete process.env[key];
            changed = true;
        }
    }
    for (const [key, value] of Object.entries(snapshot)) {
        if (process.env[key] !== value) {
            process.env[key] = value;
            changed = true;
        }
    }
    return changed;
}

function errorMessage(error) {
    if (error instanceof Error) return error.message || error.name || 'Error';
    return String(error);
}

function readBootstrapToken() {
    return new Promise((resolve, reject) => {
        const boot = new net.Socket({ fd: 3, readable: true, writable: false });
        let text = '';
        const onData = (chunk) => {
            text += chunk;
            const newline = text.indexOf('\n');
            if (newline !== -1) {
                boot.removeListener('data', onData);
                resolve({ token: text.slice(0, newline), boot });
            } else if (text.length > BOOTSTRAP_MAX_BYTES) {
                reject(new Error('tool worker bootstrap token is too long'));
            }
        };
        boot.setEncoding('utf8');
        boot.on('data', onData);
        boot.on('error', reject);
        boot.once('end', () => reject(new Error('tool worker bootstrap channel closed before the token')));
    });
}

function connectChannel(socketPath) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.once('connect', () => {
            socket.removeListener('error', reject);
            resolve(socket);
        });
        socket.once('error', reject);
    });
}

/**
 * Serve tool calls until the pool closes the channel.
 *
 * @param {(call: { toolName: string, toolEnv: object, envelope: object, stdout: Writable, stderr: Writable }) => any} handler
 *   Runs one call. Output goes to the given streams or to process.stdout/stderr
 *   (both are captured per call). The exit code is the returned number (or
 *   `{ exitCode }`), default 0, except that a non-zero `process.exitCode` set
 *   during the call becomes the call's exit code (the CLI convention). A throw
 *   ends the call with exit code 1 and the error message on stderr.
 * @returns {Promise<void>} resolves once the worker has announced `ready`.
 */
export async function serveToolWorker(handler) {
    if (typeof handler !== 'function') {
        throw new TypeError('serveToolWorker requires a handler function');
    }
    if (process.env.PLOINKY_TOOL_WORKER_PROTOCOL !== String(TOOL_WORKER_PROTOCOL_VERSION)) {
        throw new Error('serveToolWorker must run under a Ploinky tool worker pool (PLOINKY_TOOL_WORKER_PROTOCOL is not 1)');
    }

    const socketPath = process.env.PLOINKY_TOOL_WORKER_SOCKET;
    if (!socketPath) {
        throw new Error('serveToolWorker requires PLOINKY_TOOL_WORKER_SOCKET');
    }
    const { token, boot } = await readBootstrapToken();
    const channel = await connectChannel(socketPath);
    channel.write(`${JSON.stringify({ v: TOOL_WORKER_PROTOCOL_VERSION, type: 'hello', token })}\n`);
    // The channel is now a close-on-exec socket: drop fd 3 so no tool child
    // can inherit any path to the pool.
    boot.destroy();
    delete process.env.PLOINKY_TOOL_WORKER_SOCKET;
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const strayPrefix = Buffer.from(`[toolWorker pid=${process.pid}] `);

    // Output that belongs to no open call goes to the worker's own stderr,
    // which the pool forwards to the host log. It never enters another call.
    // Each stray chunk becomes complete lines so the pool forwards it at once.
    function writeStray(buffer) {
        if (!buffer.length) return;
        const parts = [strayPrefix, buffer];
        if (buffer[buffer.length - 1] !== 0x0a) parts.push(Buffer.from('\n'));
        originalStderrWrite.call(process.stderr, Buffer.concat(parts));
    }

    function captureWrite(target) {
        return function captured(chunk, encoding, callback) {
            const cb = typeof encoding === 'function' ? encoding : callback;
            const enc = typeof encoding === 'function' ? undefined : encoding;
            const buffer = toBuffer(chunk, enc);
            const call = callStorage.getStore();
            if (call && !call.closed) {
                call[target].push(buffer);
            } else {
                writeStray(buffer);
            }
            if (typeof cb === 'function') process.nextTick(cb);
            return true;
        };
    }

    process.stdout.write = captureWrite('stdout');
    process.stderr.write = captureWrite('stderr');

    function callStream(call, target) {
        return new Writable({
            write(chunk, encoding, callback) {
                const buffer = toBuffer(chunk, encoding);
                if (!call.closed) call[target].push(buffer);
                else writeStray(buffer);
                callback();
            },
        });
    }

    let activeCall = null;
    let envSnapshot = null;
    let cwdSnapshot = null;
    let poisoned = false;
    let exiting = false;

    function sendFrame(frame) {
        if (channel.destroyed || !channel.writable) return;
        channel.write(`${JSON.stringify(frame)}\n`);
    }

    // A fatal error outside any call: announce the exit (the pool then knows a
    // call frame already on its way was never started), deliver the frames
    // already written (a reply sent just before) within a short bound, then
    // exit 70. The pool kills the worker's process group once it sees the exit.
    function exitAfterFlush(code) {
        if (exiting) return;
        exiting = true;
        // Name a started call (normally none) so the pool never re-runs it.
        sendFrame({
            v: TOOL_WORKER_PROTOCOL_VERSION,
            type: 'exiting',
            startedCallId: activeCall && !activeCall.closed ? activeCall.id : null,
        });
        const flushed = new Promise((resolve) => channel.end(resolve));
        const bound = new Promise((resolve) => setTimeout(resolve, EXIT_FLUSH_TIMEOUT_MS));
        Promise.race([flushed, bound]).finally(() => process.exit(code));
    }

    // The pool is gone (EOF on the channel): end the worker's whole process
    // group, tool children included. The pool spawns the worker detached, so
    // it leads its own group.
    function exitHostGone() {
        if (exiting) return;
        exiting = true;
        try {
            process.kill(-process.pid, 'SIGKILL');
        } catch (_) {
            // Not a group leader (or not POSIX): fall through to a plain exit.
        }
        process.exit(0);
    }

    function finishCall(call, { exitCode, failure, forceRecycle }) {
        if (call.closed) return;
        if (failure) call.stderr.push(Buffer.from(`${failure}\n`));
        call.closed = true;
        if (activeCall === call) activeCall = null;

        const pendingExitCode = process.exitCode;
        process.exitCode = undefined;
        let code = exitCode;
        if (Number.isInteger(pendingExitCode) && pendingExitCode !== 0) code = pendingExitCode;

        let recycle = forceRecycle === true || poisoned;
        if (restoreEnv(envSnapshot)) recycle = true;
        let cwdNow = null;
        try {
            cwdNow = process.cwd();
        } catch (_) {
            cwdNow = null;
        }
        if (cwdNow !== cwdSnapshot) {
            recycle = true;
            try {
                process.chdir(cwdSnapshot);
            } catch (_) {
                // The pool replaces the worker anyway.
            }
        }

        sendFrame({
            v: TOOL_WORKER_PROTOCOL_VERSION,
            type: 'result',
            id: call.id,
            exitCode: code,
            stdout: Buffer.concat(call.stdout).toString('utf8'),
            stderr: Buffer.concat(call.stderr).toString('utf8'),
            rssBytes: process.memoryUsage.rss(),
            recycle,
        });
    }

    function failFromProcessEvent(kind, error) {
        const store = callStorage.getStore();
        // The ALS store identifies the call whose async work failed. A failure
        // with no store while a call is open is attributed to that call.
        const target = store || activeCall;
        if (target && !target.closed) {
            finishCall(target, {
                exitCode: 1,
                failure: `tool worker: ${kind} during call: ${errorMessage(error)}`,
                forceRecycle: true,
            });
            return;
        }
        const message = Buffer.from(`${kind} outside a call: ${errorMessage(error)}\n`);
        if (activeCall && !activeCall.closed) {
            // A late failure from an ended call while another call runs: leave
            // that call alone, and recycle the worker after its reply.
            poisoned = true;
            writeStray(message);
            return;
        }
        writeStray(message);
        exitAfterFlush(TOOL_WORKER_EXIT_OUTSIDE_CALL);
    }

    process.on('uncaughtException', (error) => failFromProcessEvent('uncaught exception', error));
    process.on('unhandledRejection', (reason) => failFromProcessEvent('unhandled rejection', reason));

    function normalizeExitCode(returned) {
        if (Number.isInteger(returned)) return returned;
        if (returned && typeof returned === 'object' && Number.isInteger(returned.exitCode)) return returned.exitCode;
        return 0;
    }

    function startCall(frame) {
        if (activeCall) {
            writeStray(Buffer.from('protocol error: call frame while a call is active\n'));
            exitAfterFlush(TOOL_WORKER_EXIT_OUTSIDE_CALL);
            return;
        }
        const call = {
            id: frame.id,
            stdout: [],
            stderr: [],
            closed: false,
        };
        activeCall = call;
        process.exitCode = undefined;
        const toolEnv = frame.toolEnv && typeof frame.toolEnv === 'object' ? { ...frame.toolEnv } : {};
        const envelope = frame.envelope && typeof frame.envelope === 'object' ? frame.envelope : {};
        const toolName = typeof frame.toolName === 'string' ? frame.toolName : '';
        callStorage.run(call, () => {
            const stdout = callStream(call, 'stdout');
            const stderr = callStream(call, 'stderr');
            Promise.resolve()
                .then(() => handler({ toolName, toolEnv, envelope, stdout, stderr }))
                .then(
                    (returned) => finishCall(call, { exitCode: normalizeExitCode(returned) }),
                    (error) => finishCall(call, { exitCode: 1, failure: errorMessage(error) }),
                );
        });
    }

    let pending = [];
    channel.on('data', (chunk) => {
        // A worker that has decided to exit starts no further call.
        if (exiting) return;
        let start = 0;
        let newline = chunk.indexOf(0x0a, start);
        while (newline !== -1) {
            pending.push(chunk.subarray(start, newline));
            const line = Buffer.concat(pending).toString('utf8');
            pending = [];
            start = newline + 1;
            newline = chunk.indexOf(0x0a, start);
            if (!line.trim()) continue;
            let frame = null;
            try {
                frame = JSON.parse(line);
            } catch (_) {
                frame = null;
            }
            if (!frame || frame.v !== TOOL_WORKER_PROTOCOL_VERSION || frame.type !== 'call') {
                // Never echo the frame: it can carry credentials.
                writeStray(Buffer.from('protocol error: unreadable frame\n'));
                exitAfterFlush(TOOL_WORKER_EXIT_OUTSIDE_CALL);
                return;
            }
            startCall(frame);
            if (exiting) return;
        }
        if (start < chunk.length) pending.push(chunk.subarray(start));
    });
    channel.on('end', () => exitHostGone());
    channel.on('close', () => exitHostGone());
    channel.on('error', () => exitHostGone());

    envSnapshot = snapshotEnv();
    cwdSnapshot = process.cwd();
    sendFrame({ v: TOOL_WORKER_PROTOCOL_VERSION, type: 'ready', pid: process.pid });
}
