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

export function createEngineClient({
    name,
    dryRun = false,
    spawnSyncImpl = spawnSync,
    spawnImpl = spawn,
    stdout = process.stdout,
    stderr = process.stderr,
}) {
    return {
        name,
        query(args) {
            const result = spawnSyncImpl(name, args, { encoding: 'utf8' });
            return {
                ok: result.status === 0 && !result.error,
                status: syncExitCode(result),
                stdout: result.stdout || '',
                stderr: result.stderr || '',
            };
        },
        run(args, { silence = 'none', allowFail = false } = {}) {
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
                    'inherit',
                    silence === 'none' ? 'inherit' : 'ignore',
                    silence === 'all' ? 'ignore' : 'inherit',
                ],
            });
            const code = syncExitCode(result);
            if (code !== 0 && !allowFail) {
                throw runFailure(name, args, result, code);
            }
            return code;
        },
        streamContains(args, needle) {
            return streamContainsWith(spawnImpl, name, args, needle);
        },
        streamToStderr(args) {
            return streamToStderrWith(spawnImpl, stderr, name, args);
        },
    };
}
