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
//   pool -> worker  {"v":1,"type":"call","id","marker","toolName","toolEnv","envelope"}
//   worker -> pool  {"v":1,"type":"result","id","exitCode","rssBytes","recycle"}
//   worker -> pool  {"v":1,"type":"log","stream","text"}      output of no open call
//   worker -> pool  {"v":1,"type":"exiting","startedCallId"}  fatal error outside a call;
//                   startedCallId is the last call this worker started (replied or not)
//
// Output. A call's output, from the handler and from tool children that
// inherit fd 1/2, flows through the worker's stdout/stderr pipes, and the pool
// attributes it to the busy call. After the handler finishes, the worker
// writes the call's end marker (`toolWorkerEndMarker(marker)`, with a random
// per-call marker id from the call frame) to both streams, ordered after the
// call's own writes, and only then sends the result frame; the pool resolves
// the call once it has the frame and both markers, and strips the markers.
// In-process writes from code whose call has ended travel as `log` frames,
// never through the pipes, so they cannot land in another call.
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

/** End-of-call marker written to stdout and stderr for a call's marker id. */
export function toolWorkerEndMarker(marker) {
    return `\u0000PLOINKY_TOOL_WORKER_END:${marker}\u0000`;
}

function countChildProcesses() {
    return process.getActiveResourcesInfo().filter((name) => name === 'ProcessWrap').length;
}

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
 *   Runs one call. Output goes to the given streams, to process.stdout/stderr,
 *   or to fd 1/2 inherited by tool children; all of it is the call's output.
 *   The exit code is the returned number (or `{ exitCode }`), default 0,
 *   except that a non-zero `process.exitCode` set during the call becomes the
 *   call's exit code (the CLI convention). A throw ends the call with exit
 *   code 1 and the error message on stderr.
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
    const originals = {
        stdout: (chunk, encoding, cb) => originalStdoutWrite.call(process.stdout, chunk, encoding, cb),
        stderr: (chunk, encoding, cb) => originalStderrWrite.call(process.stderr, chunk, encoding, cb),
    };

    // Output that belongs to no open call: forwarded to the host log through
    // the channel, never through the pipes the pool attributes to calls.
    function writeStray(stream, buffer) {
        if (!buffer.length) return;
        sendFrame({ v: TOOL_WORKER_PROTOCOL_VERSION, type: 'log', stream, text: buffer.toString('utf8') });
    }

    function captureWrite(stream) {
        return function captured(chunk, encoding, callback) {
            const call = callStorage.getStore();
            if (call && !call.closed) return originals[stream](chunk, encoding, callback);
            const cb = typeof encoding === 'function' ? encoding : callback;
            writeStray(stream, toBuffer(chunk, typeof encoding === 'function' ? undefined : encoding));
            if (typeof cb === 'function') process.nextTick(cb);
            return true;
        };
    }

    process.stdout.write = captureWrite('stdout');
    process.stderr.write = captureWrite('stderr');

    function callStream(call, stream) {
        return new Writable({
            write(chunk, encoding, callback) {
                if (!call.closed) {
                    originals[stream](chunk, undefined, () => callback());
                    return;
                }
                writeStray(stream, toBuffer(chunk, encoding));
                callback();
            },
        });
    }

    function writeMarker(stream, marker) {
        return new Promise((resolve) => {
            originals[stream](toolWorkerEndMarker(marker), undefined, () => resolve());
        });
    }

    let activeCall = null;
    let envSnapshot = null;
    let cwdSnapshot = null;
    let baselineChildren = 0;
    let lastStartedCallId = null;
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
        // Name the last call this worker started, replied or not, so the pool
        // never runs it again: calls run one at a time, so any other call the
        // pool sent was never started.
        sendFrame({
            v: TOOL_WORKER_PROTOCOL_VERSION,
            type: 'exiting',
            startedCallId: lastStartedCallId,
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
        call.closed = true;
        if (failure) originals.stderr(`${failure}\n`);

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

        // Child processes still running could write into a later call's output.
        if (countChildProcesses() > baselineChildren) recycle = true;

        call.finalizing = (async () => {
            await Promise.all([writeMarker('stdout', call.marker), writeMarker('stderr', call.marker)]);
            sendFrame({
                v: TOOL_WORKER_PROTOCOL_VERSION,
                type: 'result',
                id: call.id,
                exitCode: code,
                rssBytes: process.memoryUsage.rss(),
                recycle: recycle || poisoned,
            });
            call.replied = true;
            if (activeCall === call) activeCall = null;
        })();
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
        if (activeCall && !activeCall.replied) {
            // A late failure from an ended call while another call runs (or is
            // replying): leave that call alone, recycle after its reply.
            poisoned = true;
            writeStray('stderr', message);
            return;
        }
        writeStray('stderr', message);
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
            writeStray('stderr', Buffer.from('protocol error: call frame while a call is active\n'));
            exitAfterFlush(TOOL_WORKER_EXIT_OUTSIDE_CALL);
            return;
        }
        if (typeof frame.marker !== 'string' || !/^[0-9a-f]{32,128}$/.test(frame.marker)) {
            writeStray('stderr', Buffer.from('protocol error: call frame without a valid marker\n'));
            exitAfterFlush(TOOL_WORKER_EXIT_OUTSIDE_CALL);
            return;
        }
        const call = {
            id: frame.id,
            marker: frame.marker,
            closed: false,
            replied: false,
            finalizing: null,
        };
        activeCall = call;
        lastStartedCallId = call.id;
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
                writeStray('stderr', Buffer.from('protocol error: unreadable frame\n'));
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
    baselineChildren = countChildProcesses();
    sendFrame({ v: TOOL_WORKER_PROTOCOL_VERSION, type: 'ready', pid: process.pid });
}
