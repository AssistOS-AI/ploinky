import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
    CloudflarePublicationError,
    redactCloudflareText,
    toPublicationError,
} from './cloudflarePublicationPlan.js';

export const DEFAULT_CLOUDFLARED_RUNTIME_DIRECTORY = '/run/ploinky/cloudflared';

export function buildCloudflaredArguments(tokenFile) {
    const file = String(tokenFile || '').trim();
    if (!path.isAbsolute(file)) {
        throw new CloudflarePublicationError('cloudflared token file must use an absolute ephemeral path', {
            code: 'CLOUDFLARED_TOKEN_FILE_INVALID',
            operation: 'connector-start',
        });
    }
    return Object.freeze([
        'tunnel',
        '--no-autoupdate',
        'run',
        '--token-file',
        file,
    ]);
}

function minimalConnectorEnvironment(source = process.env) {
    const environment = {
        PATH: String(source.PATH || '/usr/local/bin:/usr/bin:/bin'),
    };
    for (const name of ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'TZ']) {
        if (source[name]) environment[name] = String(source[name]);
    }
    return environment;
}

function ensureRuntimeDirectory(runtimeDirectory) {
    fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
    const stats = fs.lstatSync(runtimeDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new CloudflarePublicationError('cloudflared runtime path must be a real directory', {
            code: 'CLOUDFLARED_RUNTIME_DIRECTORY_INVALID',
            operation: 'connector-start',
        });
    }
    fs.chmodSync(runtimeDirectory, 0o700);
}

function removeRuntimeDirectory(directory) {
    try {
        fs.rmSync(directory, { recursive: true, force: true });
    } catch (_) {}
}

function createOutputForwarder({ token, tokenFile, onOutput }) {
    if (typeof onOutput !== 'function') return { write() {}, flush() {} };
    const buffers = new Map();
    const emit = (stream, raw) => {
        const message = redactCloudflareText(raw, [token, tokenFile]);
        if (message) onOutput(Object.freeze({ stream, message }));
    };
    return {
        write(stream, chunk) {
            const combined = `${buffers.get(stream) || ''}${chunk?.toString?.('utf8') || chunk || ''}`;
            const lines = combined.split(/(?<=\n)/);
            const incomplete = lines.at(-1)?.endsWith('\n') ? '' : lines.pop() || '';
            for (const line of lines) emit(stream, line);
            if (incomplete.length > 65536) {
                emit(stream, '[cloudflared output omitted: oversized line]\n');
                buffers.set(stream, '');
            } else {
                buffers.set(stream, incomplete);
            }
        },
        flush() {
            for (const [stream, remainder] of buffers.entries()) {
                if (remainder) emit(stream, remainder);
            }
            buffers.clear();
        },
    };
}

export function createCloudflaredConnector({
    binary = 'cloudflared',
    runtimeDirectory = process.env.PLOINKY_CLOUDFLARED_RUNTIME_DIR || DEFAULT_CLOUDFLARED_RUNTIME_DIRECTORY,
    spawnImpl = spawn,
    environment = process.env,
    stopTimeoutMs = 5000,
} = {}) {
    const absoluteRuntimeDirectory = path.resolve(String(runtimeDirectory));
    let active = null;
    const forceStopOnParentExit = () => {
        try { active?.forceStop?.(); } catch (_) {}
        active = null;
    };
    process.once('exit', forceStopOnParentExit);

    async function stopActive(reason = 'stop') {
        const current = active;
        if (!current) return;
        active = null;
        await current.stop(reason);
    }

    return Object.freeze({
        async start({ tunnelToken, onExit, onOutput } = {}) {
            const token = String(tunnelToken || '').trim();
            if (!token) {
                throw new CloudflarePublicationError('Cloudflare connector secret is missing', {
                    code: 'CLOUDFLARED_TOKEN_MISSING',
                    operation: 'connector-start',
                });
            }
            await stopActive('replace');
            ensureRuntimeDirectory(absoluteRuntimeDirectory);
            const runDirectory = fs.mkdtempSync(path.join(absoluteRuntimeDirectory, 'connector-'));
            fs.chmodSync(runDirectory, 0o700);
            const tokenFile = path.join(runDirectory, 'tunnel-token');
            let child;
            let stopped = false;
            let exited = false;
            let outputForwarder = { write() {}, flush() {} };
            let exitPromiseResolve;
            const exitPromise = new Promise((resolve) => { exitPromiseResolve = resolve; });
            const finish = (event = {}) => {
                if (exited) return;
                exited = true;
                outputForwarder.flush();
                removeRuntimeDirectory(runDirectory);
                exitPromiseResolve();
                if (active?.runDirectory === runDirectory) active = null;
                if (typeof onExit === 'function') {
                    onExit(Object.freeze({
                        code: Number.isInteger(event.code) ? event.code : null,
                        signal: event.signal ? String(event.signal) : null,
                        intentional: stopped,
                        error: event.error
                            ? toPublicationError(event.error, {
                                code: 'CLOUDFLARED_PROCESS_ERROR',
                                operation: 'connector-process',
                                secrets: [token, tokenFile],
                            })
                            : null,
                    }));
                }
            };
            try {
                fs.writeFileSync(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
                const mode = fs.statSync(tokenFile).mode & 0o777;
                if (mode !== 0o600) {
                    throw new CloudflarePublicationError('cloudflared token file permissions are not 0600', {
                        code: 'CLOUDFLARED_TOKEN_FILE_MODE_INVALID',
                        operation: 'connector-start',
                    });
                }
                const args = buildCloudflaredArguments(tokenFile);
                outputForwarder = createOutputForwarder({ token, tokenFile, onOutput });
                child = spawnImpl(binary, args, {
                    env: minimalConnectorEnvironment(environment),
                    shell: false,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true,
                });
                child.stdout?.on?.('data', (chunk) => outputForwarder.write('stdout', chunk));
                child.stderr?.on?.('data', (chunk) => outputForwarder.write('stderr', chunk));
                child.once?.('error', (error) => finish({ error }));
                child.once?.('exit', (code, signal) => finish({ code, signal }));
            } catch (error) {
                removeRuntimeDirectory(runDirectory);
                throw toPublicationError(error, {
                    code: 'CLOUDFLARED_START_FAILED',
                    operation: 'connector-start',
                    secrets: [token, tokenFile],
                });
            }

            const handle = {
                runDirectory,
                get pid() {
                    return Number.isInteger(child?.pid) ? child.pid : null;
                },
                isRunning() {
                    return !exited && child?.exitCode == null && child?.signalCode == null;
                },
                async stop() {
                    if (stopped) {
                        await exitPromise;
                        return;
                    }
                    stopped = true;
                    if (exited) return;
                    try { child.kill?.('SIGTERM'); } catch (_) {}
                    let timer;
                    await Promise.race([
                        exitPromise,
                        new Promise((resolve) => {
                            timer = setTimeout(() => {
                                try { child.kill?.('SIGKILL'); } catch (_) {}
                                finish({ signal: 'SIGKILL' });
                                resolve();
                            }, Math.max(0, Number(stopTimeoutMs) || 0));
                            timer.unref?.();
                        }),
                    ]);
                    if (timer) clearTimeout(timer);
                    removeRuntimeDirectory(runDirectory);
                },
                forceStop() {
                    stopped = true;
                    try { child.kill?.('SIGTERM'); } catch (_) {}
                    removeRuntimeDirectory(runDirectory);
                },
            };
            active = handle;
            return Object.freeze({
                get pid() { return handle.pid; },
                isRunning: handle.isRunning,
                stop: handle.stop,
            });
        },
        stop: stopActive,
        isRunning() {
            return Boolean(active?.isRunning());
        },
    });
}
