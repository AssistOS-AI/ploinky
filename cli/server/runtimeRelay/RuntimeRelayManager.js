import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { normalizeCanonicalPortSet } from '../../../Agent/lib/requestHash.mjs';
import { HEALTH_PROBE_CONTROL_HOST_ROOT } from '../../utils/runtime/healthProbeControlPath.js';
import { RelayFrameDecoder, encodeRelayFrame } from './protocol.js';
import { normalizeRelayDescriptor, verifyInspectedContainer } from './confinement.js';

const DEFAULT_CHANNEL_IDLE_TIMEOUT_MS = 30_000;
const MAX_RELAY_STDERR_BYTES = 4096;
export const RUNTIME_RELAY_CONTROL_DESTINATION = '/run/ploinky-health-probes';
export const RUNTIME_RELAY_SOCKET_NAME = 'runtime-relay.sock';
export const RUNTIME_RELAY_CONTROL_HOST_ROOT = HEALTH_PROBE_CONTROL_HOST_ROOT;

function isPrivateRelaySocketMode(mode) {
    const permissions = mode & 0o777;
    return permissions === 0o600 || permissions === 0o755;
}

export function resolveRuntimeRelaySocket(relay, inspection, options = {}) {
    const record = Array.isArray(inspection) ? inspection[0] : inspection;
    const mounts = (record?.Mounts || []).filter(mount => (
        String(mount?.Destination || '') === RUNTIME_RELAY_CONTROL_DESTINATION
    ));
    if (mounts.length !== 1 || mounts[0]?.RW !== true || mounts[0]?.Type !== 'bind') {
        throw new Error('runtimeRelay: exact writable control bind is unavailable');
    }
    const source = String(mounts[0]?.Source || '');
    const containerName = String(relay?.containerName || '');
    const controlRoot = path.resolve(options.controlRoot || RUNTIME_RELAY_CONTROL_HOST_ROOT);
    const expectedSource = path.join(controlRoot, containerName);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerName)
        || !path.isAbsolute(source)
        || path.resolve(source) !== expectedSource) {
        throw new Error('runtimeRelay: control bind source identity is invalid');
    }
    const directory = fs.lstatSync(source);
    if (!directory.isDirectory() || directory.isSymbolicLink()
        || (directory.mode & 0o777) !== 0o700
        || directory.uid !== process.geteuid()) {
        throw new Error('runtimeRelay: control bind ownership is invalid');
    }
    const socketPath = path.join(source, RUNTIME_RELAY_SOCKET_NAME);
    const socket = fs.lstatSync(socketPath);
    if (!socket.isSocket() || socket.isSymbolicLink()
        || !isPrivateRelaySocketMode(socket.mode)
        || socket.uid !== directory.uid) {
        throw new Error('runtimeRelay: control socket identity is invalid');
    }
    return Object.freeze({
        path: socketPath,
        directoryPath: source,
        socketName: RUNTIME_RELAY_SOCKET_NAME,
        dev: socket.dev,
        ino: socket.ino,
        uid: socket.uid,
        mode: socket.mode & 0o777,
    });
}

class RuntimeRelaySocketTransport extends EventEmitter {
    constructor(socket) {
        super();
        this.socket = socket;
        this.stdin = socket;
        this.stdout = socket;
        this.stderr = null;
        socket.on('error', error => this.emit('error', error));
        socket.once('close', () => this.emit('exit', null, 'SOCKET_CLOSED'));
    }

    kill() {
        this.socket.destroy();
    }
}

export function openRuntimeRelaySocketTransport({ endpoint, timeoutMs }) {
    return new Promise((resolve, reject) => {
        // The mounted source can exceed Linux's AF_UNIX pathname budget even
        // though the broker bound the same inode through its short in-container
        // path. Resolve it through a private, process-owned directory alias so
        // direct ploinky-local workspaces and long generated container names do
        // not make the transport depend on host path length.
        let aliasRoot = '';
        let aliasDirectory = '';
        let settled = false;
        const cleanupAlias = () => {
            if (aliasDirectory) {
                try { fs.unlinkSync(aliasDirectory); } catch (_) {}
            }
            if (aliasRoot) {
                try { fs.rmdirSync(aliasRoot); } catch (_) {}
            }
        };
        let socket;
        try {
            aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-relay-'));
            fs.chmodSync(aliasRoot, 0o700);
            aliasDirectory = path.join(aliasRoot, 'control');
            fs.symlinkSync(endpoint.directoryPath, aliasDirectory, 'dir');
            socket = net.createConnection({
                path: path.join(aliasDirectory, endpoint.socketName),
            });
        } catch (error) {
            cleanupAlias();
            reject(error);
            return;
        }
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.destroy();
            cleanupAlias();
            reject(new Error('runtimeRelay: control socket connect timeout'));
        }, Math.max(1, Number(timeoutMs) || 1));
        timer.unref?.();
        const onError = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off('connect', onConnect);
            cleanupAlias();
            reject(error);
        };
        const onConnect = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off('error', onError);
            try {
                const current = fs.lstatSync(endpoint.path);
                if (!current.isSocket() || current.isSymbolicLink()
                    || current.dev !== endpoint.dev
                    || current.ino !== endpoint.ino
                    || current.uid !== endpoint.uid
                    || (current.mode & 0o777) !== endpoint.mode
                    || !isPrivateRelaySocketMode(current.mode)) {
                    throw new Error('runtimeRelay: control socket changed during connection');
                }
                cleanupAlias();
                resolve(new RuntimeRelaySocketTransport(socket));
            } catch (error) {
                socket.destroy();
                cleanupAlias();
                reject(error);
            }
        };
        socket.once('error', onError);
        socket.once('connect', onConnect);
    });
}

export function openRuntimeRelayExecTransport({ relay, spawnProcess = spawn }) {
    const runtime = String(relay?.runtime || '').trim();
    const containerId = String(relay?.containerId || '').trim().toLowerCase();
    if (!['docker', 'podman'].includes(runtime) || !/^[a-f0-9]{64}$/.test(containerId)) {
        throw new Error('runtimeRelay: direct macOS transport identity is invalid');
    }
    return spawnProcess(runtime, [
        'exec', '-i', containerId,
        'node', '/Agent/server/RuntimeHttpRelay.mjs', 'stdio',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
}

export function openRuntimeRelayTransport(options = {}) {
    const platform = String(options.platform || process.platform);
    if (platform === 'darwin') {
        // Public Ploinky runs the Router inside the Linux Box, where the exact
        // bind-mounted Unix socket is connectable and remains exec-free. The
        // internal ploinky-local lifecycle tests run directly on macOS while
        // their containers live in a Linux VM: the projected socket keeps its
        // inode and mode but cannot cross that kernel boundary (ECONNREFUSED).
        // Preserve direct local development by using the authenticated stdio
        // helper against the already-inspected immutable container identity.
        return openRuntimeRelayExecTransport(options);
    }
    const openSocketTransport = options.openSocketTransport || openRuntimeRelaySocketTransport;
    return openSocketTransport(options);
}

function staleGenerationError() {
    const error = new Error('runtimeRelay: generation lease is stale');
    error.code = 'EDGE_GENERATION_CHANGED';
    return error;
}

class RelayRequestStream extends EventEmitter {
    constructor(channel, requestId) {
        super();
        this.channel = channel;
        this.requestId = requestId;
        this.terminal = false;
        this.failure = null;
        this.failureDelivered = false;
    }

    on(eventName, listener) {
        const result = super.on(eventName, listener);
        if (eventName === 'error' && this.failure && !this.failureDelivered) {
            this.failureDelivered = true;
            queueMicrotask(() => this.emit('error', this.failure));
        }
        return result;
    }

    write(data) {
        if (this.terminal) throw new Error('runtimeRelay: request stream is terminal');
        return this.channel._write({ type: 'DATA', requestId: this.requestId, data: Buffer.from(data) });
    }

    end(data) {
        if (data?.length) this.write(data);
        if (!this.terminal) this.channel._write({ type: 'HALF_CLOSE', requestId: this.requestId });
    }

    cancel() {
        if (!this.terminal) this.channel._write({ type: 'CANCEL', requestId: this.requestId });
    }

    abandon() {
        if (this.terminal) return;
        try {
            this.channel._write({ type: 'CANCEL', requestId: this.requestId });
        } finally {
            // The Router-side consumer is gone. Do not retain the stream until
            // the helper acknowledges CANCEL: a concurrent managed-container
            // restart can terminate the helper first, and forwarding that
            // channel failure to an abandoned downstream stream would create
            // an unhandled error.
            this.terminal = true;
            this.channel.streams.delete(this.requestId);
            this.channel._scheduleIdleClose();
        }
    }

    _frame(frame) {
        if (frame.type === 'DATA') this.emit('data', frame.data);
        if (frame.type === 'READY') this.emit('ready');
        if (frame.type === 'ERROR') {
            const error = new Error(frame.message || 'runtime relay request failed');
            error.code = frame.code || 'RELAY_FAILURE';
            this._fail(error);
        }
        if (frame.type === 'END') {
            this.terminal = true;
            this.emit('end', frame);
        }
    }

    _fail(error) {
        if (this.terminal) return;
        this.terminal = true;
        this.failure = error;
        if (this.listenerCount('error')) {
            this.failureDelivered = true;
            this.emit('error', error);
        }
    }
}

class RuntimeRelayChannel extends EventEmitter {
    constructor({ child, relay, session, signingSecret, minter, idleTimeoutMs, onClose }) {
        super();
        this.child = child;
        this.relay = relay;
        this.session = session;
        this.signingSecret = signingSecret;
        this.minter = minter;
        this.idleTimeoutMs = idleTimeoutMs;
        this.onClose = onClose;
        this.streams = new Map();
        this.checkoutCount = 0;
        this.idleTimer = null;
        this.closed = false;
        this.stderr = '';
        const decoder = new RelayFrameDecoder();
        child.stdout.on('data', chunk => {
            try { decoder.push(chunk); } catch (error) { this._fail(error); }
        });
        decoder.on('frame', frame => {
            const stream = frame.requestId ? this.streams.get(String(frame.requestId)) : null;
            if (stream) {
                stream._frame(frame);
                if (stream.terminal) {
                    this.streams.delete(stream.requestId);
                    this._scheduleIdleClose();
                }
            } else {
                this.emit('frame', frame);
            }
        });
        decoder.on('error', error => this._fail(error));
        child.stderr?.on?.('data', chunk => {
            this.stderr = `${this.stderr}${String(chunk)}`.slice(-MAX_RELAY_STDERR_BYTES);
        });
        child.once('error', error => this._fail(error));
        child.once('exit', (code, signal) => {
            if (!this.closed) {
                const detail = this.stderr.trim().replace(/\s+/g, ' ');
                this._fail(new Error(
                    `runtime relay exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
                ));
            }
        });
    }

    retain() {
        if (this.closed) throw new Error('runtimeRelay: channel is closed');
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
        this.checkoutCount += 1;
    }

    releaseCheckout() {
        if (this.checkoutCount > 0) this.checkoutCount -= 1;
        this._scheduleIdleClose();
    }

    _scheduleIdleClose() {
        if (this.closed || this.checkoutCount || this.streams.size || this.idleTimer) return;
        this.idleTimer = setTimeout(() => this.close(), this.idleTimeoutMs);
        this.idleTimer.unref?.();
    }

    _write(frame) {
        if (this.closed || !this.child.stdin.writable) throw new Error('runtimeRelay: channel is closed');
        return this.child.stdin.write(encodeRelayFrame(frame));
    }

    async openRequest({ plan, bodyMode = 'none', bodyHash = '', headers = {} } = {}, { lease } = {}) {
        if (!plan?.targetPath) throw new Error('runtimeRelay: finalized route plan required');
        const requestId = crypto.randomUUID();
        const minted = await this.minter.mintRequest({
            targetAgentId: this.relay.targetAgentId,
            effectiveInstanceId: this.relay.effectiveInstanceId,
            enableGeneration: this.relay.enableGeneration,
            containerId: this.relay.containerId,
            generationDigest: plan.generationDigest,
            relaySessionId: this.session.payload.relaySessionId,
            denySetDigest: this.session.payload.denySetDigest,
            method: plan.method,
            port: plan.port,
            path: plan.targetPath,
            query: plan.query || '',
            bodyMode,
            bodyHash,
        }, { signingSecret: this.signingSecret });
        // Token minting and channel creation are asynchronous. Revalidate the
        // captured authorization generation at the last Router-controlled
        // point before OPEN can make the helper create a target TCP socket.
        if (!lease || lease.commit() !== true) throw staleGenerationError();
        const stream = new RelayRequestStream(this, requestId);
        this.streams.set(requestId, stream);
        try {
            this._write({
                type: 'OPEN',
                requestId,
                mode: plan.transport === 'websocket' ? 'websocket' : 'http1',
                method: plan.method,
                port: String(plan.port),
                path: plan.targetPath,
                query: plan.query || '',
                bodyMode,
                bodyHash,
                headers,
                limits: plan.limits,
                token: minted.token,
            });
        } catch (error) {
            this.streams.delete(requestId);
            throw error;
        }
        return stream;
    }

    _fail(error) {
        for (const stream of this.streams.values()) {
            stream._fail(error);
        }
        this.streams.clear();
        if (this.listenerCount('error')) this.emit('error', error);
        this.close();
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
        this.signingSecret?.fill?.(0);
        try { this.child.stdin.end(); } catch (_) {}
        try { this.child.kill(); } catch (_) {}
        this.onClose?.(this);
    }
}

class RuntimeRelayCheckout {
    constructor({ channel, lease, release }) {
        this.channel = channel;
        this.lease = lease;
        this.release = release;
        this.stream = null;
        this.closed = false;
        channel.retain();
    }

    async openRequest(options) {
        if (this.closed) throw new Error('runtimeRelay: checkout is closed');
        if (this.stream) throw new Error('runtimeRelay: checkout already opened a request');
        const stream = await this.channel.openRequest(options, { lease: this.lease });
        if (this.closed) {
            stream.cancel();
            throw new Error('runtimeRelay: checkout closed while opening request');
        }
        this.stream = stream;
        return stream;
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        try {
            if (this.stream && !this.stream.terminal) this.stream.cancel();
        } catch (_) {}
        this.channel.releaseCheckout();
        this.release();
    }
}

function defaultInspect(runtime, containerId) {
    return JSON.parse(execFileSync(runtime, ['inspect', containerId], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
    }));
}

export class RuntimeRelayManager {
    constructor({
        minter,
        inspectContainer = defaultInspect,
        resolveSocket = resolveRuntimeRelaySocket,
        openTransport = openRuntimeRelayTransport,
        limits,
        channelIdleTimeoutMs = DEFAULT_CHANNEL_IDLE_TIMEOUT_MS,
    } = {}) {
        if (!minter) throw new Error('runtimeRelay: request minter required');
        this.minter = minter;
        this.inspectContainer = inspectContainer;
        this.resolveSocket = resolveSocket;
        this.openTransport = openTransport;
        this.perAgentLimit = limits?.concurrentStreamsPerAgent || 64;
        this.totalLimit = limits?.concurrentStreamsTotal || 256;
        this.channelIdleTimeoutMs = Math.max(1, Number(channelIdleTimeoutMs) || DEFAULT_CHANNEL_IDLE_TIMEOUT_MS);
        this.totalActive = 0;
        this.agentActive = new Map();
        this.channels = new Map();
        this.creating = new Map();
        this.closed = false;
    }

    _reserve(agentId, limits = {}) {
        const perAgentLimit = limits.concurrentStreamsPerAgent || this.perAgentLimit;
        const totalLimit = limits.concurrentStreamsTotal || this.totalLimit;
        const agentCount = this.agentActive.get(agentId) || 0;
        if (this.totalActive >= totalLimit || agentCount >= perAgentLimit) {
            throw new Error('runtimeRelay: concurrency limit exceeded');
        }
        this.totalActive += 1;
        this.agentActive.set(agentId, agentCount + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.totalActive -= 1;
            const current = (this.agentActive.get(agentId) || 1) - 1;
            if (current) this.agentActive.set(agentId, current);
            else this.agentActive.delete(agentId);
        };
    }

    _poolKey(plan, relay) {
        return JSON.stringify([
            plan.generationDigest,
            relay.runtime,
            relay.containerId,
            relay.containerName,
            relay.targetAgentId,
            relay.effectiveInstanceId,
            relay.enableGeneration,
            relay.networkMode,
            normalizeCanonicalPortSet(plan.deniedPorts || []),
        ]);
    }

    async _createChannel({ plan, relay, key }) {
        const inspection = await this.inspectContainer(relay.runtime, relay.containerId);
        verifyInspectedContainer(relay, inspection);
        const endpoint = this.resolveSocket(relay, inspection);
        let child = null;
        let signingSecret = null;
        try {
            child = await this.openTransport({
                endpoint,
                timeoutMs: plan.limits.connectTimeoutMs,
                relay,
            });
            // The relay receives a fresh channel key only after the route lease
            // and exact managed-container identity have been verified. It does
            // not need the target agent's reusable request-signing secret in
            // its ambient environment.
            signingSecret = crypto.randomBytes(32);
            const session = await this.minter.mintSession({
                targetAgentId: relay.targetAgentId,
                effectiveInstanceId: relay.effectiveInstanceId,
                enableGeneration: relay.enableGeneration,
                containerId: relay.containerId,
                generationDigest: plan.generationDigest,
                deniedPorts: plan.deniedPorts || [],
            }, { signingSecret });
            let channel;
            channel = new RuntimeRelayChannel({
                child,
                relay,
                session,
                signingSecret,
                minter: this.minter,
                idleTimeoutMs: this.channelIdleTimeoutMs,
                onClose: () => {
                    if (this.channels.get(key) === channel) this.channels.delete(key);
                },
            });
            const ready = new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error('runtimeRelay: HELLO timeout')),
                    plan.limits.connectTimeoutMs,
                );
                timer.unref?.();
                const onFrame = frame => {
                    if (frame.type === 'ERROR' && !frame.requestId) {
                        cleanup();
                        const error = new Error(frame.message || 'runtimeRelay: HELLO rejected');
                        error.code = frame.code || 'RELAY_REJECTED';
                        reject(error);
                        return;
                    }
                    if (frame.type !== 'READY' || frame.requestId) return;
                    cleanup();
                    if (frame.containerId !== relay.containerId
                        || frame.effectiveInstanceId !== relay.effectiveInstanceId
                        || frame.enableGeneration !== relay.enableGeneration
                        || frame.generationDigest !== plan.generationDigest
                        || frame.denySetDigest !== session.payload.denySetDigest) {
                        reject(new Error('runtimeRelay: READY identity mismatch'));
                        return;
                    }
                    resolve();
                };
                const onError = error => { cleanup(); reject(error); };
                const cleanup = () => {
                    clearTimeout(timer);
                    channel.off('frame', onFrame);
                    channel.off('error', onError);
                };
                channel.on('frame', onFrame);
                channel.on('error', onError);
            });
            channel._write({
                type: 'HELLO',
                targetAgentId: relay.targetAgentId,
                effectiveInstanceId: relay.effectiveInstanceId,
                enableGeneration: relay.enableGeneration,
                containerId: relay.containerId,
                generationDigest: plan.generationDigest,
                relaySessionId: session.payload.relaySessionId,
                deniedPorts: session.payload.deniedPorts,
                denySetDigest: session.payload.denySetDigest,
                verificationKey: signingSecret.toString('hex'),
                token: session.token,
            });
            await ready;
            if (this.closed) {
                channel.close();
                throw new Error('runtimeRelay: manager is closed');
            }
            this.channels.set(key, channel);
            return channel;
        } catch (error) {
            signingSecret?.fill?.(0);
            try { child?.kill(); } catch (_) {}
            throw error;
        }
    }

    async _getOrCreateChannel({ plan, relay, key }) {
        const existing = this.channels.get(key);
        if (existing && !existing.closed) return existing;
        let pending = this.creating.get(key);
        if (!pending) {
            pending = this._createChannel({ plan, relay, key });
            this.creating.set(key, pending);
        }
        try {
            return await pending;
        } finally {
            if (this.creating.get(key) === pending) this.creating.delete(key);
        }
    }

    async checkout({ plan, lease, authorized = false } = {}) {
        if (authorized !== true) throw new Error('runtimeRelay: authorization must complete before checkout');
        if (this.closed) throw new Error('runtimeRelay: manager is closed');
        if (!lease || lease.commit() !== true) throw staleGenerationError();
        const relay = normalizeRelayDescriptor(plan?.relay);
        if (relay.containerId !== plan.relay.containerId
            || relay.effectiveInstanceId !== plan.owner.effectiveInstanceId
            || relay.enableGeneration !== plan.owner.enableGeneration) {
            throw new Error('runtimeRelay: plan owner/relay identity mismatch');
        }
        const release = this._reserve(relay.targetAgentId, plan.limits);
        try {
            const key = this._poolKey(plan, relay);
            const channel = await this._getOrCreateChannel({ plan, relay, key });
            if (this.closed || channel.closed) throw new Error('runtimeRelay: channel is closed');
            return new RuntimeRelayCheckout({ channel, lease, release });
        } catch (error) {
            release();
            throw error;
        }
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        for (const channel of this.channels.values()) {
            if (channel.streams.size) channel._fail(new Error('runtimeRelay: manager is closed'));
            else channel.close();
        }
        this.channels.clear();
    }
}

export default RuntimeRelayManager;
