import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';

import { normalizeCanonicalPortSet } from '../../../Agent/lib/requestHash.mjs';
import { RelayFrameDecoder, encodeRelayFrame } from './protocol.js';
import { normalizeRelayDescriptor, verifyInspectedContainer } from './confinement.js';

const DEFAULT_CHANNEL_IDLE_TIMEOUT_MS = 30_000;
const MAX_RELAY_STDERR_BYTES = 4096;

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
        spawnProcess = spawn,
        limits,
        channelIdleTimeoutMs = DEFAULT_CHANNEL_IDLE_TIMEOUT_MS,
    } = {}) {
        if (!minter) throw new Error('runtimeRelay: request minter required');
        this.minter = minter;
        this.inspectContainer = inspectContainer;
        this.spawnProcess = spawnProcess;
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
            relay.releaseGeneration,
            relay.networkMode,
            normalizeCanonicalPortSet(plan.deniedPorts || []),
        ]);
    }

    async _createChannel({ plan, relay, key }) {
        verifyInspectedContainer(relay, await this.inspectContainer(relay.runtime, relay.containerId));
        const child = this.spawnProcess(relay.runtime, [
            'exec', '-i', relay.containerId,
            'node', '/Agent/server/RuntimeHttpRelay.mjs',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        let signingSecret = null;
        try {
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
            try { child.kill(); } catch (_) {}
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
            || relay.enableGeneration !== plan.owner.enableGeneration
            || relay.releaseGeneration !== String(plan.owner.releaseGeneration || '')) {
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
