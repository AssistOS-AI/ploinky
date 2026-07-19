import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

function signalExitCode(signal) {
    const number = os.constants.signals[signal];
    return Number.isInteger(number) ? 128 + number : 1;
}

function syncExitCode(result) {
    if (Number.isInteger(result?.status)) return result.status;
    if (result?.signal) return signalExitCode(result.signal);
    return 1;
}

function runFailure(name, args, result, exitCode) {
    const command = name + ' ' + args.join(' ');
    let message;
    if (result?.error) {
        message = command + ' failed: '
            + (result.error.message || String(result.error));
    } else if (result?.signal) {
        message = command + ' terminated by ' + result.signal
            + ' (exit ' + exitCode + ')';
    } else {
        message = command + ' exited ' + exitCode;
    }
    const error = new Error(message, result?.error
        ? { cause: result.error }
        : undefined);
    error.exitCode = exitCode;
    if (result?.signal) error.signal = result.signal;
    return error;
}

function streamContainsWith(spawnImpl, name, args, needle) {
    return new Promise((resolve) => {
        let tail = '';
        let settled = false;
        const done = (found) => {
            if (settled) return;
            settled = true;
            resolve(found);
        };
        let child;
        try {
            child = spawnImpl(name, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch {
            done(false);
            return;
        }
        const scan = (chunk) => {
            const text = `${tail}${chunk}`;
            if (text.includes(needle)) {
                done(true);
                child.kill();
                return;
            }
            tail = text.slice(-Math.max(needle.length - 1, 0));
        };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', scan);
        child.stderr.on('data', scan);
        child.on('error', () => done(false));
        child.on('close', () => done(false));
    });
}

function streamToStderrWith(spawnImpl, stderr, name, args) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawnImpl(name, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch {
            resolve(1);
            return;
        }
        child.stdout.pipe(stderr, { end: false });
        child.stderr.pipe(stderr, { end: false });
        child.on('error', () => resolve(1));
        child.on('close', (code, signal) => {
            resolve(
                typeof code === 'number'
                    ? code
                    : 128 + (os.constants.signals[signal] ?? 15),
            );
        });
    });
}

function captureWith(spawnImpl, name, args, {
    input = '',
    env,
    timeoutMs = 600000,
    maxBuffer = 4 * 1024 * 1024,
    signal,
} = {}) {
    return new Promise((resolve) => {
        let child;
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let settled = false;
        let timedOut = false;
        let overflow = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                ...result,
                stdout: Buffer.isBuffer(result.stdout)
                    ? result.stdout.toString('utf8')
                    : String(result.stdout || ''),
                stderr: Buffer.isBuffer(result.stderr)
                    ? result.stderr.toString('utf8')
                    : String(result.stderr || ''),
            });
        };
        try {
            child = spawnImpl(name, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                ...(env ? { env } : {}),
                ...(signal ? { signal } : {}),
            });
        } catch (error) {
            resolve({
                ok: false,
                status: 1,
                stdout: stdout.toString('utf8'),
                stderr: stderr.toString('utf8'),
                error,
                signal: null,
                timedOut: false,
                overflow: false,
            });
            return;
        }
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        const append = (current, chunk) => {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            const remaining = Math.max(0, maxBuffer - current.length);
            if (value.length > remaining) {
                overflow = true;
                child.kill('SIGKILL');
            }
            if (remaining === 0) return current;
            return Buffer.concat([current, value.subarray(0, remaining)]);
        };
        child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
        child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
        child.on('error', error => finish({
            ok: false,
            status: 1,
            stdout,
            stderr,
            error,
            signal: null,
            timedOut,
            overflow,
        }));
        child.on('close', (code, childSignal) => {
            const status = Number.isInteger(code)
                ? code
                : childSignal
                    ? signalExitCode(childSignal)
                    : 1;
            finish({
                ok: status === 0 && !timedOut && !overflow,
                status,
                stdout,
                stderr,
                error: null,
                signal: childSignal || null,
                timedOut,
                overflow,
            });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(String(input));
    });
}

export function createEngineClient({
    name,
    dryRun = false,
    spawnSyncImpl = spawnSync,
    spawnImpl = spawn,
    stdout = process.stdout,
    stderr = process.stderr,
    queryTimeoutMs = 5000,
}) {
    return {
        name,
        query(args, options = {}) {
            const result = spawnSyncImpl(name, args, {
                encoding: 'utf8',
                timeout: options.timeoutMs ?? queryTimeoutMs,
                ...(options.input === undefined
                    ? {}
                    : { input: String(options.input) }),
                ...(options.env ? { env: options.env } : {}),
            });
            return {
                ok: result.status === 0 && !result.error,
                status: syncExitCode(result),
                stdout: result.stdout || '',
                stderr: result.stderr || '',
                error: result.error || null,
                signal: result.signal || null,
            };
        },
        run(args, {
            silence = 'none',
            allowFail = false,
            input,
            env,
        } = {}) {
            if (dryRun) {
                if (silence === 'none') {
                    stdout.write(
                        'DRY-RUN: ' + name + ' ' + args.join(' ') + '\n',
                    );
                }
                return 0;
            }
            const result = spawnSyncImpl(name, args, {
                stdio: [
                    input === undefined ? 'inherit' : 'pipe',
                    silence === 'none' ? 'inherit' : 'ignore',
                    silence === 'all' ? 'ignore' : 'inherit',
                ],
                ...(input === undefined ? {} : { input: String(input) }),
                ...(env ? { env } : {}),
            });
            const code = syncExitCode(result);
            if (code !== 0 && !allowFail) {
                throw runFailure(name, args, result, code);
            }
            return code;
        },
        capture(args, options = {}) {
            if (dryRun) {
                stdout.write('DRY-RUN: ' + name + ' ' + args.join(' ') + '\n');
                return Promise.resolve({
                    ok: true,
                    status: 0,
                    stdout: '',
                    stderr: '',
                    error: null,
                    signal: null,
                    timedOut: false,
                    overflow: false,
                    dryRun: true,
                });
            }
            return captureWith(spawnImpl, name, args, options);
        },
        streamContains(args, needle) {
            return streamContainsWith(spawnImpl, name, args, needle);
        },
        streamToStderr(args) {
            return streamToStderrWith(spawnImpl, stderr, name, args);
        },
    };
}
