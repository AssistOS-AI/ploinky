// Runtime for a persistent tool worker started by Agent/server/toolWorkerPool.mjs.
//
// An agent opts in by declaring a worker command whose script imports this
// module (its absolute path arrives in PLOINKY_TOOL_WORKER_MODULE) and calls
// `serveToolWorker(handler)`. The pool talks to the worker over fd 3, a private
// socketpair carrying newline-delimited JSON frames:
//
//   worker -> pool  {"v":1,"type":"ready","pid"}
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

/**
 * Serve tool calls on fd 3 until the pool closes the channel.
 *
 * @param {(call: { toolName: string, toolEnv: object, envelope: object, stdout: Writable, stderr: Writable }) => any} handler
 *   Runs one call. Output goes to the given streams or to process.stdout/stderr
 *   (both are captured per call). A returned number, or `{ exitCode }`, sets the
 *   exit code; a non-zero `process.exitCode` set during the call wins. A throw
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

    const channel = new net.Socket({ fd: 3, readable: true, writable: true });
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
    let exiting = false;

    function sendFrame(frame) {
        channel.write(`${JSON.stringify(frame)}\n`);
    }

    // Leave nothing behind: the worker leads its own process group (the pool
    // spawns it detached), so killing the group also ends tool children.
    function exitWorker(code) {
        if (exiting) return;
        exiting = true;
        try {
            process.kill(-process.pid, 'SIGKILL');
        } catch (_) {
            // Not a group leader (or not POSIX): fall through to a plain exit.
        }
        process.exit(code);
    }

    function finishCall(call, { exitCode, failure, forceRecycle }) {
        if (call.closed) return;
        if (failure) call.stderr.push(Buffer.from(`${failure}\n`));
        call.closed = true;
        if (activeCall === call) activeCall = null;

        const pendingExitCode = process.exitCode;
        process.exitCode = undefined;
        let code = exitCode;
        if (Number.isInteger(pendingExitCode) && pendingExitCode !== 0 && code === 0) code = pendingExitCode;

        let recycle = forceRecycle === true;
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
        const call = store || activeCall;
        if (call && !call.closed) {
            finishCall(call, {
                exitCode: 1,
                failure: `tool worker: ${kind} during call: ${errorMessage(error)}`,
                forceRecycle: true,
            });
            return;
        }
        writeStray(Buffer.from(`${kind} outside a call: ${errorMessage(error)}\n`));
        exitWorker(TOOL_WORKER_EXIT_OUTSIDE_CALL);
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
            exitWorker(TOOL_WORKER_EXIT_OUTSIDE_CALL);
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
                exitWorker(TOOL_WORKER_EXIT_OUTSIDE_CALL);
                return;
            }
            startCall(frame);
        }
        if (start < chunk.length) pending.push(chunk.subarray(start));
    });
    channel.on('end', () => exitWorker(0));
    channel.on('error', () => exitWorker(0));

    envSnapshot = snapshotEnv();
    cwdSnapshot = process.cwd();
    sendFrame({ v: TOOL_WORKER_PROTOCOL_VERSION, type: 'ready', pid: process.pid });
}
