#!/usr/bin/env node

import { resolveWorkspaceDirectory } from './cwd.mjs';
import { assertExactShellEnvironment } from './environment.mjs';
import { loadImmutableNodePty } from './native-runtime.mjs';
import {
    capturePtyProcessIdentity,
    processIdentityError,
    signalVerifiedPtyProcessGroup,
    waitForPtyProcessExit,
} from './process-identity.mjs';
import {
    WEBTTY_PROTOCOL_LIMITS,
    validateRouterToWorkerMessage,
    workerMessage,
} from './worker-protocol.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_QUEUED_IPC_BYTES = 256 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 128 * 1024;
const IDENTITY_WAIT_MS = 500;
const TERMINATION_GRACE_MS = 750;
const FORCE_GRACE_MS = 500;
const EXIT_SEND_GRACE_MS = 100;

function validateInvocation(argv) {
    if (argv.length !== 1 || !/^--ploinky-webtty-marker=[A-Za-z0-9_-]{24,128}$/.test(argv[0])) {
        const error = new Error('invalid worker invocation');
        error.code = 'WEBTTY_WORKER_INVOCATION_INVALID';
        throw error;
    }
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function outputChunks(value) {
    const chunks = [];
    let current = '';
    let currentBytes = 0;
    for (const character of String(value)) {
        const bytes = Buffer.byteLength(character, 'utf8');
        if (currentBytes + bytes > WEBTTY_PROTOCOL_LIMITS.maxOutputBytes && current) {
            chunks.push(current);
            current = '';
            currentBytes = 0;
        }
        current += character;
        currentBytes += bytes;
    }
    if (current) chunks.push(current);
    return chunks;
}

export class TerminalWorker {
    constructor({
        processApi = process,
        resolveDirectory = resolveWorkspaceDirectory,
        assertShellEnv = assertExactShellEnvironment,
        loadNodePty = loadImmutableNodePty,
        capturePtyIdentityImpl = capturePtyProcessIdentity,
        signalGroupImpl = signalVerifiedPtyProcessGroup,
        waitForExitImpl = waitForPtyProcessExit,
        delayImpl = delay,
        identityWaitMs = IDENTITY_WAIT_MS,
    } = {}) {
        this.processApi = processApi;
        this.resolveDirectory = resolveDirectory;
        this.assertShellEnv = assertShellEnv;
        this.loadNodePty = loadNodePty;
        this.capturePtyIdentityImpl = capturePtyIdentityImpl;
        this.signalGroupImpl = signalGroupImpl;
        this.waitForExitImpl = waitForExitImpl;
        this.delayImpl = delayImpl;
        this.identityWaitMs = identityWaitMs;
        this.terminalId = '';
        this.initialized = false;
        this.readySent = false;
        this.closing = false;
        this.exitSent = false;
        this.sequence = 0;
        this.queuedIpcBytes = 0;
        this.pendingOutput = [];
        this.pendingOutputBytes = 0;
        this.pty = null;
        this.ptyIdentity = null;
        this.ptyExited = false;
        this.cleanupPromise = null;
        this.requestedExitCategory = 'worker-error';
        this.cleanupUnprovenReported = false;
    }

    send(type, fields = {}) {
        if (!this.terminalId || !this.processApi.connected) return false;
        const message = workerMessage(type, this.terminalId, fields);
        const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
        if (bytes > WEBTTY_PROTOCOL_LIMITS.maxWireBytes
            || this.queuedIpcBytes + bytes > MAX_QUEUED_IPC_BYTES) {
            void this.cleanup('output-limit');
            return false;
        }
        this.queuedIpcBytes += bytes;
        try {
            this.processApi.send(message, (error) => {
                this.queuedIpcBytes = Math.max(0, this.queuedIpcBytes - bytes);
                if (error && !this.closing) void this.cleanup('parent-disconnect');
            });
            return true;
        } catch (_) {
            this.queuedIpcBytes = Math.max(0, this.queuedIpcBytes - bytes);
            void this.cleanup('parent-disconnect');
            return false;
        }
    }

    sendError(category) {
        if (!this.exitSent) this.send('error', { category });
    }

    reportCleanupUnproven() {
        if (this.cleanupUnprovenReported) return;
        this.cleanupUnprovenReported = true;
        this.sendError('cleanup-unproven');
    }

    handleOutput(data) {
        if (this.closing || this.ptyExited) return;
        for (const chunk of outputChunks(data)) {
            const bytes = Buffer.byteLength(chunk, 'utf8');
            if (!this.readySent) {
                if (this.pendingOutputBytes + bytes > MAX_PENDING_OUTPUT_BYTES) {
                    this.sendError('output-limit');
                    void this.cleanup('output-limit');
                    return;
                }
                this.pendingOutput.push(chunk);
                this.pendingOutputBytes += bytes;
                continue;
            }
            this.sequence += 1;
            if (!this.send('output', { sequence: this.sequence, data: chunk })) return;
        }
    }

    flushPendingOutput() {
        const pending = this.pendingOutput;
        this.pendingOutput = [];
        this.pendingOutputBytes = 0;
        for (const chunk of pending) {
            if (this.closing) return;
            this.sequence += 1;
            if (!this.send('output', { sequence: this.sequence, data: chunk })) return;
        }
    }

    async captureIdentity(pid) {
        const deadline = Date.now() + this.identityWaitMs;
        let lastError;
        while (Date.now() <= deadline) {
            try {
                return this.capturePtyIdentityImpl(pid);
            } catch (error) {
                lastError = error;
                if (error?.code === 'WEBTTY_PROCESS_IDENTITY_STALE') throw error;
            }
            await this.delayImpl(10);
        }
        throw lastError || processIdentityError('pty-startup');
    }

    async initialize(message) {
        this.terminalId = message.terminalId;
        validateRouterToWorkerMessage(message, { initialized: false, expectedTerminalId: this.terminalId });
        this.initialized = true;
        const shellEnv = this.assertShellEnv(message.shellEnv);
        let cwd;
        try {
            // This is the authoritative worker-side revalidation performed
            // immediately before the native spawn.
            cwd = this.resolveDirectory(message.cwdRelative);
        } catch (_) {
            this.sendError('cwd-validation');
            await this.cleanup('worker-error');
            return;
        }

        let nodePty;
        try {
            nodePty = this.loadNodePty();
        } catch (_) {
            this.sendError('native-runtime');
            await this.cleanup('worker-error');
            return;
        }
        try {
            this.pty = nodePty.spawn('/bin/bash', ['--noprofile', '--norc'], {
                name: 'xterm-256color',
                cols: message.cols,
                rows: message.rows,
                cwd: cwd.absolutePath,
                env: { ...shellEnv },
            });
        } catch (_) {
            this.sendError('pty-spawn');
            await this.cleanup('worker-error');
            return;
        }
        try {
            this.pty.onData((data) => this.handleOutput(data));
            this.pty.onExit((event) => this.handlePtyExit(event));
            this.ptyIdentity = await this.captureIdentity(this.pty.pid);
        } catch (_) {
            // A native PTY exists, but no complete identity/group proof can be
            // persisted. Never describe master-close as proven reclamation.
            this.reportCleanupUnproven();
            await this.cleanup('worker-error');
            return;
        }
        if (this.closing) return;
        this.send('ready', { processIdentity: this.ptyIdentity });
        this.readySent = true;
        this.flushPendingOutput();
    }

    handlePtyExit(event = {}) {
        if (this.ptyExited) return;
        this.ptyExited = true;
        const exitCode = Number.isSafeInteger(event.exitCode) ? event.exitCode : null;
        const signal = Number.isSafeInteger(event.signal) ? event.signal : null;
        let category = this.closing ? this.requestedExitCategory : 'clean';
        if (!this.closing && signal) category = 'signal';
        if (!this.exitSent) {
            this.exitSent = true;
            this.send('exit', { exitCode, signal, category });
        }
        void this.cleanup(category, { ptyAlreadyExited: true });
    }

    handleMessage(raw) {
        if (this.closing) return;
        let message;
        try {
            message = validateRouterToWorkerMessage(raw, {
                initialized: this.initialized,
                closing: this.closing,
                expectedTerminalId: this.terminalId || undefined,
            });
        } catch (_) {
            this.sendError('protocol');
            void this.cleanup('protocol-error');
            return;
        }
        if (message.type === 'init') {
            void this.initialize(message);
            return;
        }
        if (!this.readySent || !this.pty || this.ptyExited) {
            this.sendError('protocol');
            void this.cleanup('protocol-error');
            return;
        }
        if (message.type === 'input') {
            try {
                this.pty.write(message.data);
            } catch (_) {
                this.sendError('pty-io');
                void this.cleanup('worker-error');
            }
        } else if (message.type === 'resize') {
            try {
                this.pty.resize(message.cols, message.rows);
            } catch (_) {
                this.sendError('pty-io');
                void this.cleanup('worker-error');
            }
        } else if (message.type === 'close') {
            void this.cleanup('requested');
        }
    }

    cleanup(category, { ptyAlreadyExited = false } = {}) {
        if (this.cleanupPromise) return this.cleanupPromise;
        this.closing = true;
        this.requestedExitCategory = category;
        this.cleanupPromise = this.performCleanup(category, { ptyAlreadyExited });
        return this.cleanupPromise;
    }

    async performCleanup(category, { ptyAlreadyExited }) {
        // This proves the recorded shell/session leader has exited. The Router
        // separately verifies that no process remains in the recorded Linux
        // terminal session before deleting durable recovery evidence.
        let cleanupProven = Boolean(ptyAlreadyExited || this.ptyExited);
        let safeToDispose = cleanupProven;
        if (this.pty && !this.ptyIdentity && !cleanupProven) this.reportCleanupUnproven();
        if (this.pty && this.ptyIdentity && !ptyAlreadyExited && !this.ptyExited) {
            try {
                this.signalGroupImpl(this.ptyIdentity, 'SIGTERM');
                const exited = await this.waitForExitImpl(this.ptyIdentity, { timeoutMs: TERMINATION_GRACE_MS });
                cleanupProven = exited;
                if (!exited) {
                    this.signalGroupImpl(this.ptyIdentity, 'SIGKILL');
                    cleanupProven = await this.waitForExitImpl(this.ptyIdentity, { timeoutMs: FORCE_GRACE_MS });
                    if (!cleanupProven) this.reportCleanupUnproven();
                }
            } catch (error) {
                if (error?.code === 'WEBTTY_PROCESS_IDENTITY_STALE') cleanupProven = true;
                else {
                    this.sendError('cleanup');
                    this.reportCleanupUnproven();
                }
            }
        }
        if (this.ptyExited) {
            cleanupProven = true;
            safeToDispose = true;
        }
        // If identity became ambiguous, exiting the worker closes the PTY
        // master. A stale identity proves that the original process is gone,
        // but does not make node-pty's stored numeric PID safe for dispose().
        if (safeToDispose) {
            try { this.pty?.dispose?.(); } catch (_) { }
        }
        if (!this.exitSent && this.terminalId) {
            this.exitSent = true;
            this.send('exit', {
                exitCode: null,
                signal: null,
                category: ['requested', 'parent-disconnect', 'protocol-error'].includes(category)
                    ? category
                    : 'worker-error',
            });
        }
        await this.delayImpl(EXIT_SEND_GRACE_MS);
        try { this.processApi.disconnect?.(); } catch (_) { }
        this.processApi.exitCode = category === 'requested' || category === 'clean' ? 0 : 1;
        const timer = setTimeout(() => this.processApi.exit?.(this.processApi.exitCode), 10);
        timer.unref?.();
    }
}

export function runTerminalWorker({ processApi = process, argv = processApi.argv.slice(2) } = {}) {
    let worker;
    try {
        validateInvocation(argv);
        worker = new TerminalWorker({ processApi });
    } catch (_) {
        processApi.exitCode = 1;
        try { processApi.disconnect?.(); } catch (_) { }
        return null;
    }
    processApi.on('message', (message) => worker.handleMessage(message));
    processApi.once('disconnect', () => { void worker.cleanup('parent-disconnect'); });
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        processApi.once(signal, () => { void worker.cleanup('requested'); });
    }
    processApi.once('uncaughtException', () => {
        worker.sendError('internal');
        void worker.cleanup('worker-error');
    });
    processApi.once('unhandledRejection', () => {
        worker.sendError('internal');
        void worker.cleanup('worker-error');
    });
    return worker;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    runTerminalWorker();
}
