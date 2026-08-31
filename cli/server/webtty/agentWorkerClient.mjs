import { fork as forkDefault } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readLinuxProcessIdentity } from './runtimeRecords.mjs';
import { buildAgentWorkerEnvironment } from './agentWorkerEnvironment.mjs';
import {
    agentWorkerMessage,
    validateAgentWorkerToRouterMessage,
    validateRouterToAgentWorkerMessage,
} from './agentWorkerProtocol.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WEBTTY_AGENT_WORKER_PATH = path.resolve(
    __dirname,
    './agentTerminalWorker.mjs',
);
export const WEBTTY_AGENT_WORKER_INVOCATION = '--ploinky-webtty-agent-worker=v1';
// The worker owns the 10-second in-band readiness deadline.  The Router-side
// waiter must leave a bounded delivery margin so the worker's validated error
// wins instead of racing an indistinguishable client timeout.
export const AGENT_WORKER_RESPONSE_TIMEOUT_MS = 11_000;

const MAX_QUEUED_IPC_BYTES = 256 * 1024;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
export const AGENT_WORKER_CLOSE_GRACE_MS = 8_500;

function exactWorkerIdentity(observed, expected, workerPath, executablePath) {
    return Boolean(observed
        && observed.pid === expected.pid
        && observed.startToken === expected.startToken
        && observed.uid === expected.uid
        && observed.cmdline?.length === 3
        && observed.cmdline?.[0] === executablePath
        && observed.cmdline?.[1] === workerPath
        && observed.cmdline?.[2] === WEBTTY_AGENT_WORKER_INVOCATION);
}

export class AgentWebttyWorkerClient extends EventEmitter {
    constructor({
        terminalId,
        workerPath = DEFAULT_WEBTTY_AGENT_WORKER_PATH,
        forkImpl = forkDefault,
        workerEnv = buildAgentWorkerEnvironment(),
        readProcessIdentity = readLinuxProcessIdentity,
        signalProcess = process.kill.bind(process),
        startupTimeoutMs = AGENT_WORKER_RESPONSE_TIMEOUT_MS,
        closeGraceMs = AGENT_WORKER_CLOSE_GRACE_MS,
        ipcSendTimeoutMs = 2_000,
    } = {}) {
        super();
        this.terminalId = terminalId;
        this.workerPath = workerPath;
        this.forkImpl = forkImpl;
        this.workerEnv = workerEnv;
        this.readProcessIdentity = readProcessIdentity;
        this.signalProcess = signalProcess;
        this.startupTimeoutMs = startupTimeoutMs;
        this.closeGraceMs = closeGraceMs;
        this.ipcSendTimeoutMs = ipcSendTimeoutMs;
        this.child = null;
        this.workerIdentity = null;
        this.workerExecutablePath = '';
        this.initialized = false;
        this.closing = false;
        this.exited = false;
        this.sequence = 0;
        this.queuedBytes = 0;
        this.diagnosticBytes = 0;
        this.readyMessage = null;
        this.preparedMessage = null;
        this.terminalErrorMessage = null;
        this.initSpec = null;
        this.closePromise = null;
        this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    }

    async spawn() {
        if (this.child) throw new Error('agent worker already spawned');
        const child = this.forkImpl(this.workerPath, [WEBTTY_AGENT_WORKER_INVOCATION], {
            detached: false,
            env: this.workerEnv,
            serialization: 'json',
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
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
            if (!this.exited && !this.closing) this.fail('ipc_disconnected');
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
        try {
            const identity = await this.readProcessIdentity(child.pid);
            if (!identity) throw new Error('agent worker process identity unavailable');
            if (!Array.isArray(identity.cmdline) || identity.cmdline.length !== 3
                || !path.isAbsolute(identity.cmdline[0])
                || identity.cmdline[1] !== this.workerPath
                || identity.cmdline[2] !== WEBTTY_AGENT_WORKER_INVOCATION) {
                throw new Error('agent worker invocation identity unavailable');
            }
            this.workerExecutablePath = identity.cmdline[0];
            this.workerIdentity = Object.freeze({
                pid: identity.pid,
                startToken: identity.startToken,
                uid: identity.uid,
            });
            return this.workerIdentity;
        } catch (error) {
            const reclaimed = await this.cleanupFailedSpawn();
            if (!reclaimed) {
                const cleanupError = new Error('agent worker bootstrap cleanup unproven', { cause: error });
                cleanupError.code = 'WEBTTY_AGENT_WORKER_CLEANUP_UNPROVEN';
                throw cleanupError;
            }
            const identityError = new Error('agent worker identity evidence is unproven', { cause: error });
            identityError.code = 'WEBTTY_AGENT_WORKER_IDENTITY_UNPROVEN';
            throw identityError;
        }
    }

    async cleanupFailedSpawn() {
        this.closing = true;
        if (this.child?.connected && !this.exited) {
            try {
                const message = agentWorkerMessage('close', this.terminalId);
                validateRouterToAgentWorkerMessage(message, {
                    initialized: false,
                    closing: true,
                    expectedTerminalId: this.terminalId,
                });
                this.child.send(message, () => {});
            } catch (_) { }
        }
        if (await this.waitForExit(this.closeGraceMs)) return true;

        // The ChildProcess object is the direct result of this exact fork and
        // remains the only ownership handle available when /proc identity
        // capture itself failed. Use it only for this pre-record bootstrap
        // rollback; normal lifecycle signals always revalidate immutable PID
        // identity through signalExactWorker().
        try { this.child?.kill?.('SIGKILL'); } catch (_) { }
        const reclaimed = await this.waitForExit(this.closeGraceMs);
        if (!reclaimed) {
            this.emit('error-category', {
                category: 'worker_cleanup_unproven',
                diagnosticBytes: this.diagnosticBytes,
            });
        }
        return reclaimed;
    }

    onMessage(raw) {
        if (this.exited) return;
        let message;
        try {
            message = validateAgentWorkerToRouterMessage(raw, {
                expectedTerminalId: this.terminalId,
            });
            if (message.type === 'prepared') {
                if (this.preparedMessage || this.readyMessage || !this.initialized) {
                    throw new Error('out-of-order prepared');
                }
                const evidence = message.startupEvidence;
                if (!this.initSpec || [
                    ['runtime', evidence.runtime],
                    ['containerId', evidence.containerId],
                    ['targetUser', evidence.targetUser],
                    ['translatedCwd', evidence.translatedCwd],
                    ['marker', evidence.marker],
                ].some(([field, observed]) => this.initSpec[field] !== observed)) {
                    throw new Error('prepared evidence does not match init');
                }
                this.preparedMessage = message;
            } else if (message.type === 'ready') {
                if (this.readyMessage || !this.preparedMessage || !this.initialized) {
                    throw new Error('out-of-order ready');
                }
                const evidence = message.recoveryEvidence;
                if (!this.initSpec || [
                    ['runtime', evidence.runtime],
                    ['containerId', evidence.containerId],
                    ['targetUser', evidence.targetUser],
                    ['translatedCwd', evidence.translatedCwd],
                    ['marker', evidence.marker],
                ].some(([field, observed]) => this.initSpec[field] !== observed)) {
                    throw new Error('ready evidence does not match init');
                }
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
        else if (message.type === 'error') {
            this.terminalErrorMessage = message;
            this.emit('terminal-error', message);
        }
        else this.emit(message.type, message);
    }

    async send(type, fields = {}, { timeoutMs = this.ipcSendTimeoutMs } = {}) {
        if (!this.child || !this.child.connected || this.exited) {
            throw new Error('agent worker IPC is unavailable');
        }
        const message = agentWorkerMessage(type, this.terminalId, fields);
        validateRouterToAgentWorkerMessage(message, {
            initialized: this.initialized,
            closing: this.closing,
            expectedTerminalId: this.terminalId,
        });
        const bytes = Buffer.byteLength(JSON.stringify(message));
        if (this.queuedBytes + bytes > MAX_QUEUED_IPC_BYTES) {
            const error = new Error('agent worker IPC high-water limit exceeded');
            error.code = 'WEBTTY_AGENT_IPC_BACKPRESSURE';
            throw error;
        }
        this.queuedBytes += bytes;
        if (type === 'init-agent') this.initialized = true;
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
                const error = new Error('agent worker IPC send timed out');
                error.code = 'WEBTTY_AGENT_IPC_SEND_TIMEOUT';
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

    waitForMessage(type, existing, timeoutCategory) {
        if (existing) return Promise.resolve(existing);
        if (this.terminalErrorMessage) {
            return Promise.reject(this.terminalErrorBefore(type, this.terminalErrorMessage));
        }
        if (this.exited) return Promise.reject(new Error(`WebTTY agent worker exited before ${type}`));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                this.fail(timeoutCategory);
                reject(new Error(`WebTTY agent worker ${type} timed out`));
            }, this.startupTimeoutMs);
            timer.unref?.();
            const onMessage = (message) => { cleanup(); resolve(message); };
            const onExit = () => {
                cleanup();
                reject(new Error(`WebTTY agent worker exited before ${type}`));
            };
            const onError = (message) => {
                cleanup();
                reject(this.terminalErrorBefore(type, message));
            };
            const cleanup = () => {
                clearTimeout(timer);
                this.off(type, onMessage);
                this.off('terminal-error', onError);
                this.off('terminal-exit', onExit);
                this.off('process-exit', onExit);
            };
            this.on(type, onMessage);
            this.on('terminal-error', onError);
            this.on('terminal-exit', onExit);
            this.on('process-exit', onExit);
            if (this.terminalErrorMessage) onError(this.terminalErrorMessage);
            else if (this.exited) onExit();
        });
    }

    terminalErrorBefore(type, message) {
        const error = new Error(
            `WebTTY agent worker reported ${message.category} before ${type}`,
        );
        error.code = 'WEBTTY_AGENT_WORKER_TERMINAL_ERROR';
        error.category = message.category;
        return error;
    }

    async prepare(fields) {
        if (this.initSpec) throw new Error('agent worker already initialized');
        this.initSpec = Object.freeze({
            runtime: fields.runtime,
            containerId: fields.containerId,
            targetUser: fields.targetUser,
            translatedCwd: fields.translatedCwd,
            marker: fields.marker,
        });
        await this.send('init-agent', fields);
        return this.waitForMessage('prepared', this.preparedMessage, 'prepare_timeout');
    }

    async start() {
        if (!this.preparedMessage || !this.initSpec) {
            throw new Error('agent worker is not durably prepared');
        }
        await this.send('start-agent');
        return this.waitForMessage('ready', this.readyMessage, 'startup_timeout');
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

    async signalExactWorker(signal) {
        if (!this.workerIdentity) throw new Error('agent worker identity unavailable');
        const observed = await this.readProcessIdentity(this.workerIdentity.pid);
        if (!observed) return false;
        if (!exactWorkerIdentity(
            observed,
            this.workerIdentity,
            this.workerPath,
            this.workerExecutablePath,
        )) {
            const error = new Error('agent worker identity changed before signal');
            error.code = 'WEBTTY_AGENT_WORKER_IDENTITY_UNPROVEN';
            throw error;
        }
        this.signalProcess(observed.pid, signal);
        return true;
    }

    close() {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        const timer = setTimeout(() => {
            if (this.exited) return;
            void this.signalExactWorker('SIGKILL').catch(() => {
                this.emit('error-category', {
                    category: 'worker_cleanup_unproven',
                    diagnosticBytes: this.diagnosticBytes,
                });
            });
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
        const result = await Promise.race([this.exitPromise.then(() => true), timedOut]);
        clearTimeout(timer);
        return result;
    }
}

export default AgentWebttyWorkerClient;
