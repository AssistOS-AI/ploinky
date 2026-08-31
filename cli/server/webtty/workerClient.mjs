import { fork as forkDefault } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    validateRouterToWorkerMessage,
    validateWorkerToRouterMessage,
    workerMessage,
} from '../../../core-services/webtty/worker-protocol.mjs';
import { buildWorkerEnvironment } from '../../../core-services/webtty/environment.mjs';
import { readLinuxProcessIdentity } from './runtimeRecords.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WEBTTY_WORKER_PATH = path.resolve(
    __dirname,
    '../../../core-services/webtty/terminal-worker.mjs',
);

const MAX_QUEUED_IPC_BYTES = 256 * 1024;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

export class WebttyWorkerClient extends EventEmitter {
    constructor({
        terminalId,
        marker,
        workerPath = DEFAULT_WEBTTY_WORKER_PATH,
        forkImpl = forkDefault,
        workerEnv = buildWorkerEnvironment(),
        readProcessIdentity = readLinuxProcessIdentity,
        startupTimeoutMs = 10_000,
        closeGraceMs = 2_000,
        ipcSendTimeoutMs = 2_000,
    } = {}) {
        super();
        this.terminalId = terminalId;
        this.marker = marker;
        this.workerPath = workerPath;
        this.forkImpl = forkImpl;
        this.workerEnv = workerEnv;
        this.readProcessIdentity = readProcessIdentity;
        this.startupTimeoutMs = startupTimeoutMs;
        this.closeGraceMs = closeGraceMs;
        this.ipcSendTimeoutMs = ipcSendTimeoutMs;
        this.child = null;
        this.initialized = false;
        this.closing = false;
        this.exited = false;
        this.sequence = 0;
        this.queuedBytes = 0;
        this.diagnosticBytes = 0;
        this.readyMessage = null;
        this.closePromise = null;
        this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    }

    async spawn() {
        if (this.child) throw new Error('worker already spawned');
        const child = this.forkImpl(
            this.workerPath,
            [`--ploinky-webtty-marker=${this.marker}`],
            {
                detached: false,
                env: this.workerEnv,
                serialization: 'json',
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            },
        );
        this.child = child;
        for (const stream of [child.stdout, child.stderr]) {
            stream?.on('data', (chunk) => {
                this.diagnosticBytes = Math.min(
                    MAX_DIAGNOSTIC_BYTES,
                    this.diagnosticBytes + Buffer.byteLength(chunk),
                );
            });
        }
        child.on('message', (message) => this.onMessage(message));
        child.on('error', () => this.fail('worker_error'));
        child.on('disconnect', () => {
            if (!this.exited) this.fail('ipc_disconnected');
        });
        child.on('exit', (code, signal) => {
            if (this.exited) return;
            this.exited = true;
            this.resolveExit?.({ code, signal });
            this.emit('process-exit', {
                exitCode: Number.isInteger(code) ? code : null,
                signal: signal || null,
                category: this.closing ? 'requested' : 'worker_process_exit',
            });
        });
        const identity = await this.readProcessIdentity(child.pid);
        if (!identity) throw new Error('worker process identity unavailable');
        return identity;
    }

    onMessage(raw) {
        if (this.exited) return;
        let message;
        try {
            message = validateWorkerToRouterMessage(raw, { expectedTerminalId: this.terminalId });
            if (message.type === 'ready') {
                if (this.readyMessage || !this.initialized) throw new Error('out-of-order ready');
                this.readyMessage = message;
            } else if (message.type === 'output') {
                if (!this.readyMessage || message.sequence !== this.sequence + 1) {
                    throw new Error('out-of-order output');
                }
                this.sequence = message.sequence;
            }
        } catch (_) {
            this.fail('protocol_error');
            return;
        }
        if (message.type === 'exit') this.emit('terminal-exit', message);
        else if (message.type === 'error') this.emit('terminal-error', message);
        else this.emit(message.type, message);
    }

    async send(type, fields = {}, { timeoutMs = this.ipcSendTimeoutMs } = {}) {
        if (!this.child || !this.child.connected || this.exited) throw new Error('worker IPC is unavailable');
        const message = workerMessage(type, this.terminalId, fields);
        validateRouterToWorkerMessage(message, {
            initialized: this.initialized,
            closing: this.closing,
            expectedTerminalId: this.terminalId,
        });
        const bytes = Buffer.byteLength(JSON.stringify(message));
        if (this.queuedBytes + bytes > MAX_QUEUED_IPC_BYTES) {
            const error = new Error('worker IPC high-water limit exceeded');
            error.code = 'WEBTTY_IPC_BACKPRESSURE';
            throw error;
        }
        this.queuedBytes += bytes;
        if (type === 'init') this.initialized = true;
        await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
                if (error) reject(error); else resolve();
            };
            const timer = setTimeout(() => {
                const error = new Error('worker IPC send timed out');
                error.code = 'WEBTTY_IPC_SEND_TIMEOUT';
                finish(error);
            }, timeoutMs);
            try {
                this.child.send(message, (error) => {
                    finish(error || null);
                });
            } catch (error) {
                finish(error);
            }
        });
    }

    async start(fields) {
        await this.send('init', fields);
        if (this.readyMessage) return this.readyMessage;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                this.fail('startup_timeout');
                reject(new Error('WebTTY worker startup timed out'));
            }, this.startupTimeoutMs);
            timer.unref?.();
            const onReady = (message) => { cleanup(); resolve(message); };
            const onExit = () => { cleanup(); reject(new Error('WebTTY worker exited before ready')); };
            const cleanup = () => {
                clearTimeout(timer);
                this.off('ready', onReady);
                this.off('terminal-exit', onExit);
                this.off('process-exit', onExit);
            };
            this.on('ready', onReady);
            this.on('terminal-exit', onExit);
            this.on('process-exit', onExit);
        });
    }

    input(data) {
        return this.send('input', { data });
    }

    resize(cols, rows) {
        return this.send('resize', { cols, rows });
    }

    fail(category) {
        if (this.exited) return;
        this.emit('error-category', { category, diagnosticBytes: this.diagnosticBytes });
        void this.close();
    }

    close() {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        const child = this.child;
        const timer = setTimeout(() => {
            try { if (!this.exited) child?.kill('SIGKILL'); } catch (_) { }
        }, this.closeGraceMs);
        timer.unref?.();
        this.closePromise = (async () => {
            try {
                if (this.child?.connected && !this.exited) {
                    await this.send('close', {}, {
                        timeoutMs: Math.min(this.ipcSendTimeoutMs, this.closeGraceMs),
                    });
                }
            } catch (_) { }
        })();
        return this.closePromise;
    }

    async waitForExit(timeoutMs = this.closeGraceMs + 500) {
        if (this.exited) return true;
        let timer;
        const timedOut = new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
            timer.unref?.();
        });
        const exited = this.exitPromise.then(() => true);
        const result = await Promise.race([exited, timedOut]);
        clearTimeout(timer);
        return result;
    }
}

export default WebttyWorkerClient;
