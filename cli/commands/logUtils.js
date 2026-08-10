// Verified log sources for `ploinky logs`.
//
// The previous implementation shelled out to `tail -f` and, on failure, fell
// back to an uncancellable watcher that reopened the file by name. Both could
// follow a replacement inode after validation, neither could be cancelled, and
// `showLast` read whole files into memory. These primitives instead validate a
// path, open one descriptor without following symlinks, and keep that exact
// descriptor for the whole read or follow.

import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { spawn as spawnDefault } from 'node:child_process';

import { LOGS_DIR, PLOINKY_DIR } from '../utils/config.js';
import {
    assertSafeRelativeSegment,
    openVerifiedRegularFile,
} from '../utils/verifiedReadOnlyFile.js';
import { superviseLogChild } from './logChildSupervisor.js';

export const ROUTER_LOG_FILE = 'router.log';
export const MAX_LAST_OUTPUT_BYTES = 16 * 1024 * 1024;
export const READ_CHUNK_BYTES = 64 * 1024;
export const SUPPORTED_LOG_RUNTIMES = Object.freeze(['docker', 'podman']);
export const IMMUTABLE_CONTAINER_ID = /^[0-9a-f]{64}$/;

export function logPathError(message) {
    const error = new Error(message);
    error.code = 'LOG_PATH_UNSAFE';
    return error;
}

export function getLogPath(kind) {
    const map = {
        router: pathDefault.join(LOGS_DIR, ROUTER_LOG_FILE),
        policy: pathDefault.join(PLOINKY_DIR, 'data', 'router-security', 'policy-audit.log'),
    };
    return map[kind] || null;
}
export function logOutputLimitError(message) {
    const error = new Error(message);
    error.code = 'LOG_OUTPUT_LIMIT';
    return error;
}

export function logRuntimeError(message) {
    const error = new Error(message);
    error.code = 'LOG_RUNTIME_UNSUPPORTED';
    return error;
}

export function assertSafeLogSegment(segment, label = 'log path component') {
    try {
        return assertSafeRelativeSegment(segment, label);
    } catch (error) {
        throw logPathError(error.message);
    }
}

// Returns an open descriptor, or null when the file is not present yet. Unsafe
// state -- a symlinked component, a non-regular file, an escape from the
// trusted root, or an inode swapped between validation and open -- always
// throws instead of silently selecting whatever is there.
export function openVerifiedLogFile({
    trustedRoot,
    relativeSegments = [],
    fsApi = fsDefault,
    pathApi = pathDefault,
} = {}) {
    try {
        return openVerifiedRegularFile({ trustedRoot, relativeSegments, fsApi, pathApi });
    } catch (error) {
        throw logPathError(error?.message || 'the log path could not be verified');
    }
}

export function sleepUntil(delayMs, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        let onAbort;
        const timer = setTimeout(() => {
            if (onAbort) signal?.removeEventListener?.('abort', onAbort);
            resolve();
        }, delayMs);
        if (signal) {
            onAbort = () => {
                clearTimeout(timer);
                signal.removeEventListener?.('abort', onAbort);
                resolve();
            };
            signal.addEventListener?.('abort', onAbort, { once: true });
        }
    });
}

export function writeWithBackpressure(writable, chunk, { signal } = {}) {
    if (signal?.aborted) return Promise.resolve(false);
    let accepted;
    try { accepted = writable.write(chunk); } catch (error) { return Promise.reject(error); }
    if (accepted !== false) return Promise.resolve(true);

    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            writable.removeListener?.('drain', onDrain);
            writable.removeListener?.('error', onError);
            writable.removeListener?.('close', onClose);
            signal?.removeEventListener?.('abort', onAbort);
        };
        const settle = (finish, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            finish(value);
        };
        const onDrain = () => settle(resolve, true);
        const onError = (error) => settle(reject, error);
        const onClose = () => settle(reject, new Error('log output closed before it drained'));
        const onAbort = () => settle(resolve, false);
        writable.once?.('drain', onDrain);
        writable.once?.('error', onError);
        writable.once?.('close', onClose);
        signal?.addEventListener?.('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

function readExactLogBytes(descriptor, buffer, offset, length, position, fsApi) {
    let copied = 0;
    while (copied < length) {
        const count = fsApi.readSync(
            descriptor,
            buffer,
            offset + copied,
            length - copied,
            position + copied,
        );
        if (!Number.isSafeInteger(count) || count <= 0) {
            throw logPathError('the selected log changed while its suffix was being read');
        }
        copied += count;
    }
}

// Scans backwards in fixed-size chunks and stops at the requested boundary, so
// the cost is proportional to the emitted suffix rather than the file size.
export function readLastLinesFromDescriptor(descriptor, {
    lineCount = 200,
    byteLimit = MAX_LAST_OUTPUT_BYTES,
    fsApi = fsDefault,
    // A follower pins one size for both the initial suffix and its follow
    // start. Letting this function re-stat instead would either skip bytes
    // appended between the two stats or emit them twice.
    endOffset,
} = {}) {
    const size = Number.isInteger(endOffset) ? endOffset : fsApi.fstatSync(descriptor).size;
    if (size <= 0) return Buffer.alloc(0);

    const scratch = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = size;
    let newlines = 0;
    let start = 0;
    let bounded = false;

    while (position > 0) {
        const length = Math.min(READ_CHUNK_BYTES, position);
        position -= length;
        readExactLogBytes(descriptor, scratch, 0, length, position, fsApi);
        for (let index = length - 1; index >= 0; index -= 1) {
            if (scratch[index] !== 0x0a) continue;
            // A newline at the very end terminates the final line instead of
            // starting another one.
            if (position + index === size - 1) continue;
            newlines += 1;
            if (newlines >= lineCount) {
                start = position + index + 1;
                bounded = true;
                break;
            }
        }
        if (bounded) break;
        if (size - position > byteLimit) {
            throw logOutputLimitError(
                `the requested ${lineCount} lines exceed the ${byteLimit}-byte output limit`,
            );
        }
    }

    const suffixLength = size - start;
    if (suffixLength > byteLimit) {
        throw logOutputLimitError(
            `the requested ${lineCount} lines exceed the ${byteLimit}-byte output limit`,
        );
    }
    const suffix = Buffer.allocUnsafe(suffixLength);
    let copied = 0;
    while (copied < suffixLength) {
        const length = Math.min(READ_CHUNK_BYTES, suffixLength - copied);
        readExactLogBytes(descriptor, suffix, copied, length, start + copied, fsApi);
        copied += length;
    }
    return suffix;
}

// Follows the one already-verified descriptor. Replacing the pathname never
// redirects this loop, and truncation of the same inode restarts cleanly.
export async function followDescriptor(descriptor, {
    initialLines = 10,
    byteLimit = MAX_LAST_OUTPUT_BYTES,
    signal,
    output = process.stdout,
    pollIntervalMs = 200,
    fsApi = fsDefault,
    sleepImpl = sleepUntil,
    onIdle,
} = {}) {
    // One stat fixes the boundary between the initial suffix and the follow, so
    // a write landing between them is neither skipped nor emitted twice.
    let position = fsApi.fstatSync(descriptor).size;
    const initial = readLastLinesFromDescriptor(descriptor, {
        lineCount: initialLines,
        byteLimit,
        fsApi,
        endOffset: position,
    });
    if (initial.length && !await writeWithBackpressure(output, initial, { signal })) return;
    const scratch = Buffer.allocUnsafe(READ_CHUNK_BYTES);

    while (!signal?.aborted) {
        const size = fsApi.fstatSync(descriptor).size;
        if (size < position) position = 0;
        while (position < size && !signal?.aborted) {
            const length = Math.min(READ_CHUNK_BYTES, size - position);
            const read = fsApi.readSync(descriptor, scratch, 0, length, position);
            if (read <= 0) break;
            // Copy out of the reused scratch buffer so a slow writer cannot
            // observe the next chunk's bytes.
            const delivered = await writeWithBackpressure(
                output,
                Buffer.from(scratch.subarray(0, read)),
                { signal },
            );
            if (!delivered) return;
            position += read;
        }
        if (signal?.aborted) break;
        if (onIdle) {
            const verdict = await onIdle();
            if (verdict === 'stop') break;
        }
        if (signal?.aborted) break;
        await sleepImpl(pollIntervalMs, signal);
    }
}

export function buildRuntimeLogArgs({
    runtime,
    containerId,
    follow = false,
    lineCount = 200,
    initialLines = 10,
}) {
    if (!SUPPORTED_LOG_RUNTIMES.includes(runtime)) {
        throw logRuntimeError(`'${runtime}' is not one supported log runtime`);
    }
    if (!IMMUTABLE_CONTAINER_ID.test(String(containerId || ''))) {
        throw logRuntimeError('runtime logs require one immutable 64-hex container id');
    }
    return follow
        ? ['logs', '--follow', '--tail', String(initialLines), containerId]
        : ['logs', '--tail', String(lineCount), containerId];
}

// Runtime output is spawned as a fixed executable plus an argument array, never
// through a shell, and is always addressed by the immutable container id.
export function runRuntimeLogs({
    runtime,
    containerId,
    follow = false,
    lineCount = 200,
    initialLines = 10,
    byteLimit = MAX_LAST_OUTPUT_BYTES,
    signal,
    output = process.stdout,
    errorOutput = process.stderr,
    spawnImpl = spawnDefault,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
} = {}) {
    const args = buildRuntimeLogArgs({ runtime, containerId, follow, lineCount, initialLines });
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawnImpl(runtime, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            reject(error);
            return;
        }

        let emitted = 0;
        let terminalError = null;
        const pumpController = new AbortController();
        const relayAbort = () => pumpController.abort();
        if (signal?.aborted) relayAbort();
        else signal?.addEventListener?.('abort', relayAbort, { once: true });
        const releasePumpSignal = () => signal?.removeEventListener?.('abort', relayAbort);
        const supervisor = superviseLogChild(child, {
            signal,
            setTimeoutImpl,
            clearTimeoutImpl,
        });
        const pumps = [];
        const pump = (stream, writable) => {
            if (!stream) return;
            let chain = Promise.resolve();
            const onData = (value) => {
                if (terminalError) return;
                const chunk = Buffer.from(value);
                if (!follow && emitted + chunk.length > byteLimit) {
                    terminalError = logOutputLimitError(
                        `${runtime} logs exceeded the ${byteLimit}-byte output limit`,
                    );
                    supervisor.terminate('output-limit');
                    return;
                }
                emitted += chunk.length;
                try { stream.pause?.(); } catch (_) {}
                chain = chain
                    .then(() => writeWithBackpressure(writable, chunk, {
                        signal: pumpController.signal,
                    }))
                    .then((delivered) => {
                        if (delivered) {
                            try { stream.resume?.(); } catch (_) {}
                        }
                    })
                    .catch((error) => {
                        terminalError ||= error;
                        supervisor.terminate('output-error');
                    });
            };
            stream.on('data', onData);
            pumps.push({
                pending: () => chain,
                cleanup: () => stream.removeListener?.('data', onData),
            });
        };
        pump(child.stdout, output);
        pump(child.stderr, errorOutput);

        (async () => {
            try {
                const result = await supervisor.completion;
                for (const entry of pumps) entry.cleanup();
                if (terminalError) pumpController.abort();
                await Promise.all(pumps.map((entry) => entry.pending()));
                releasePumpSignal();
                if (terminalError) throw terminalError;
                if (result.terminationReason === 'abort' || signal?.aborted) {
                    resolve(0);
                } else if (Number.isInteger(result.code)) {
                    resolve(result.code);
                } else {
                    resolve(result.closeSignal ? 1 : 0);
                }
            } catch (error) {
                pumpController.abort();
                for (const entry of pumps) entry.cleanup();
                await Promise.allSettled(pumps.map((entry) => entry.pending()));
                releasePumpSignal();
                reject(error);
            }
        })();
    });
}

export function routerLogSource({ logsDir = LOGS_DIR } = {}) {
    return { trustedRoot: logsDir, relativeSegments: [ROUTER_LOG_FILE] };
}
