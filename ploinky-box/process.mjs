import { spawn, spawnSync } from 'node:child_process';

import { PloinkyBoxError } from './errors.mjs';

const ENGINE_ENV_ALLOWLIST = Object.freeze([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'DBUS_SESSION_BUS_ADDRESS',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TERM',
]);

const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;

function assertProcessArguments(args) {
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
        throw new TypeError('Process arguments must be an array of strings');
    }
}

export function buildEngineProcessEnvironment(env = process.env) {
    return Object.fromEntries(ENGINE_ENV_ALLOWLIST
        .filter((name) => env[name] !== undefined)
        .map((name) => [name, String(env[name])]));
}

export function runProcess(command, args, {
    cwd,
    encoding = 'buffer',
    env,
} = {}) {
    assertProcessArguments(args);

    const result = spawnSync(command, args, {
        cwd,
        encoding: encoding === 'buffer' ? null : encoding,
        env,
        maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    });

    if (result.error) {
        throw new PloinkyBoxError(`Unable to execute ${command}`, {
            code: 'PLOINKY_BOX_PROCESS_START_FAILED',
            cause: result.error,
        });
    }
    if (result.status !== 0) {
        const stderr = Buffer.isBuffer(result.stderr)
            ? result.stderr.toString('utf8')
            : String(result.stderr ?? '');
        throw new PloinkyBoxError(
            `${command} exited with status ${result.status}${stderr ? `: ${stderr.trim()}` : ''}`,
            { code: 'PLOINKY_BOX_PROCESS_FAILED' },
        );
    }

    return result.stdout;
}

export function queryProcess(command, args, {
    cwd,
    env,
    input,
    timeoutMs = 10_000,
} = {}) {
    assertProcessArguments(args);
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        env,
        input,
        timeout: timeoutMs,
        maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    });
    return {
        ok: result.status === 0 && !result.error,
        status: Number.isInteger(result.status) ? result.status : 1,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error || null,
        signal: result.signal || null,
    };
}

export function streamProcess(command, args, {
    cwd,
    env,
    timeoutMs = 10_000,
    stdout = process.stdout,
    stderr = process.stderr,
} = {}) {
    assertProcessArguments(args);

    return new Promise((resolve) => {
        const stdoutChunks = [];
        const stderrChunks = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let processError = null;
        let settled = false;
        let timeout = null;
        let child;

        const capture = (chunk, chunks, byteCount, streamName) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            const nextByteCount = byteCount + buffer.length;
            if (nextByteCount > MAX_PROCESS_OUTPUT_BYTES && !processError) {
                processError = new Error(`${streamName} exceeded the process output limit`);
                processError.code = 'ENOBUFS';
                child?.kill();
            }
            if (nextByteCount <= MAX_PROCESS_OUTPUT_BYTES) chunks.push(buffer);
            return nextByteCount;
        };

        const finish = (status, signal) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            resolve({
                ok: status === 0 && !processError,
                status: Number.isInteger(status) ? status : 1,
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
                error: processError,
                signal: signal || null,
            });
        };

        try {
            child = spawn(command, args, {
                cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            processError = error;
            finish(1, null);
            return;
        }

        child.stdout.on('data', (chunk) => {
            stdout.write(chunk);
            stdoutBytes = capture(chunk, stdoutChunks, stdoutBytes, 'stdout');
        });
        child.stderr.on('data', (chunk) => {
            stderr.write(chunk);
            stderrBytes = capture(chunk, stderrChunks, stderrBytes, 'stderr');
        });
        child.once('error', (error) => {
            processError ||= error;
        });
        child.once('close', finish);

        timeout = setTimeout(() => {
            if (settled) return;
            processError = new Error(`Process timed out after ${timeoutMs}ms`);
            processError.code = 'ETIMEDOUT';
            child.kill();
        }, timeoutMs);
    });
}

export function pipeProcess(sourceCommand, sourceArgs, destinationCommand, destinationArgs, {
    cwd,
    env,
    timeoutMs = 1_800_000,
    stdout = process.stdout,
    stderr = process.stderr,
} = {}) {
    assertProcessArguments(sourceArgs);
    assertProcessArguments(destinationArgs);

    return new Promise((resolve) => {
        const stdoutChunks = [];
        const stderrChunks = [];
        let capturedBytes = 0;
        let processError = null;
        let sourceStatus = null;
        let destinationStatus = null;
        let sourceSignal = null;
        let destinationSignal = null;
        let settled = false;
        let timeout = null;
        let source;
        let destination;

        const capture = (chunk, chunks, output) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            capturedBytes += buffer.length;
            output?.write?.(chunk);
            if (capturedBytes > MAX_PROCESS_OUTPUT_BYTES) {
                if (!processError) {
                    processError = new Error('Image transfer output exceeded the process output limit');
                    processError.code = 'ENOBUFS';
                }
                source?.kill('SIGKILL');
                destination?.kill('SIGKILL');
                return;
            }
            chunks.push(buffer);
        };

        const finish = () => {
            if (settled || sourceStatus === null || destinationStatus === null) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            resolve({
                ok: sourceStatus === 0 && destinationStatus === 0 && !processError,
                status: destinationStatus === 0 ? sourceStatus : destinationStatus,
                sourceStatus,
                destinationStatus,
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
                error: processError,
                signal: destinationSignal || sourceSignal || null,
            });
        };

        const failStart = (error) => {
            processError ||= error;
            source?.kill('SIGKILL');
            destination?.kill('SIGKILL');
            if (!source) sourceStatus = 1;
            if (!destination) destinationStatus = 1;
            finish();
        };

        const failPipe = (error) => {
            processError ||= error;
            source?.kill('SIGKILL');
            destination?.kill('SIGKILL');
        };

        try {
            destination = spawn(destinationCommand, destinationArgs, {
                cwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            source = spawn(sourceCommand, sourceArgs, {
                cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            failStart(error);
            return;
        }

        destination.stdout.on('data', (chunk) => capture(chunk, stdoutChunks, stdout));
        destination.stderr.on('data', (chunk) => capture(chunk, stderrChunks, stderr));
        source.stderr.on('data', (chunk) => capture(chunk, stderrChunks, stderr));
        source.stdout.on('error', failPipe);
        destination.stdin.on('error', failPipe);
        destination.once('error', failStart);
        source.once('error', failStart);
        source.once('close', (status, signal) => {
            sourceStatus = Number.isInteger(status) ? status : 1;
            sourceSignal = signal || null;
            finish();
        });
        destination.once('close', (status, signal) => {
            destinationStatus = Number.isInteger(status) ? status : 1;
            destinationSignal = signal || null;
            if (sourceStatus === null && destinationStatus !== 0) source?.kill('SIGKILL');
            finish();
        });
        source.stdout.pipe(destination.stdin);

        timeout = setTimeout(() => {
            if (settled) return;
            processError = new Error(`Image transfer timed out after ${timeoutMs}ms`);
            processError.code = 'ETIMEDOUT';
            source.kill('SIGKILL');
            destination.kill('SIGKILL');
        }, timeoutMs);
    });
}

export function createProcessRunner(options = {}) {
    return {
        query(command, args, queryOptions = {}) {
            return queryProcess(command, args, {
                ...options,
                ...queryOptions,
            });
        },
        run(command, args, runOptions = {}) {
            return runProcess(command, args, {
                ...options,
                ...runOptions,
            });
        },
        stream(command, args, streamOptions = {}) {
            return streamProcess(command, args, {
                ...options,
                ...streamOptions,
            });
        },
        pipe(sourceCommand, sourceArgs, destinationCommand, destinationArgs, pipeOptions = {}) {
            return pipeProcess(
                sourceCommand,
                sourceArgs,
                destinationCommand,
                destinationArgs,
                { ...options, ...pipeOptions },
            );
        },
    };
}
