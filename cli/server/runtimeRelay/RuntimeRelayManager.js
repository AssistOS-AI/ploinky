import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';

import { RelayFrameDecoder, RUNTIME_RELAY_PROTOCOL_VERSION, encodeRelayFrame } from './protocol.js';
import { normalizeRelayDescriptor, verifyInspectedContainer } from './confinement.js';

class RelayRequestStream extends EventEmitter {
    constructor(channel, requestId) {
        super();
        this.channel = channel;
        this.requestId = requestId;
        this.terminal = false;
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

    _frame(frame) {
        if (frame.type === 'DATA') this.emit('data', frame.data);
        if (frame.type === 'READY') this.emit('ready');
        if (frame.type === 'ERROR') {
            this.terminal = true;
            const error = new Error(frame.message || 'runtime relay request failed');
            error.code = frame.code || 'RELAY_FAILURE';
            this.emit('error', error);
        }
        if (frame.type === 'END') {
            this.terminal = true;
            this.emit('end', frame);
        }
    }
}

class RuntimeRelayChannel extends EventEmitter {
    constructor({ child, relay, session, minter, release }) {
        super();
        this.child = child;
        this.relay = relay;
        this.session = session;
        this.minter = minter;
        this.release = release;
        this.streams = new Map();
        this.closed = false;
        const decoder = new RelayFrameDecoder();
        child.stdout.on('data', chunk => {
            try { decoder.push(chunk); } catch (error) { this._fail(error); }
        });
        decoder.on('frame', frame => {
            const stream = frame.requestId ? this.streams.get(String(frame.requestId)) : null;
            if (stream) {
                stream._frame(frame);
                if (stream.terminal) this.streams.delete(stream.requestId);
            } else {
                this.emit('frame', frame);
            }
        });
        decoder.on('error', error => this._fail(error));
        child.once('error', error => this._fail(error));
        child.once('exit', (code, signal) => {
            if (!this.closed && (code || signal)) this._fail(new Error(`runtime relay exited (${code ?? signal})`));
            this.close();
        });
    }

    _write(frame) {
        if (this.closed || !this.child.stdin.writable) throw new Error('runtimeRelay: channel is closed');
        return this.child.stdin.write(encodeRelayFrame(frame));
    }

    async openRequest({ plan, bodyMode = 'none-v1', bodyHash = '', headers = {} } = {}) {
        if (!plan?.targetPath) throw new Error('runtimeRelay: finalized route plan required');
        const requestId = crypto.randomUUID();
        const minted = await this.minter.mintRequest({
            targetAgentId: this.relay.targetAgentId,
            effectiveInstanceId: this.relay.effectiveInstanceId,
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
        });
        const stream = new RelayRequestStream(this, requestId);
        this.streams.set(requestId, stream);
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
        return stream;
    }

    _fail(error) {
        for (const stream of this.streams.values()) {
            if (!stream.terminal) stream.emit('error', error);
        }
        this.streams.clear();
        if (this.listenerCount('error')) this.emit('error', error);
        this.close();
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        try { this.child.stdin.end(); } catch (_) {}
        try { this.child.kill(); } catch (_) {}
        this.release?.();
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
    constructor({ minter, inspectContainer = defaultInspect, spawnProcess = spawn, limits } = {}) {
        if (!minter) throw new Error('runtimeRelay: request minter required');
        this.minter = minter;
        this.inspectContainer = inspectContainer;
        this.spawnProcess = spawnProcess;
        this.perAgentLimit = limits?.concurrentStreamsPerAgent || 64;
        this.totalLimit = limits?.concurrentStreamsTotal || 256;
        this.totalActive = 0;
        this.agentActive = new Map();
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

    async checkout({ plan, lease, authorized = false } = {}) {
        if (authorized !== true) throw new Error('runtimeRelay: authorization must complete before checkout');
        if (!lease || lease.commit() !== true) throw new Error('runtimeRelay: generation lease is stale');
        const relay = normalizeRelayDescriptor(plan?.relay);
        if (relay.containerId !== plan.relay.containerId
            || relay.effectiveInstanceId !== plan.owner.effectiveInstanceId) {
            throw new Error('runtimeRelay: plan owner/relay identity mismatch');
        }
        const release = this._reserve(relay.targetAgentId, plan.limits);
        let child;
        try {
            verifyInspectedContainer(relay, await this.inspectContainer(relay.runtime, relay.containerId));
            child = this.spawnProcess(relay.runtime, [
                'exec', '-i', relay.containerId,
                'node', '/Agent/server/RuntimeHttpRelay.mjs',
            ], { stdio: ['pipe', 'pipe', 'pipe'] });
            child.stderr?.resume?.();
            const session = await this.minter.mintSession({
                targetAgentId: relay.targetAgentId,
                effectiveInstanceId: relay.effectiveInstanceId,
                containerId: relay.containerId,
                generationDigest: plan.generationDigest,
                deniedPorts: plan.deniedPorts || [],
            });
            const channel = new RuntimeRelayChannel({ child, relay, session, minter: this.minter, release });
            const ready = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('runtimeRelay: HELLO timeout')), plan.limits.connectTimeoutMs);
                timer.unref?.();
                const onFrame = frame => {
                    if (frame.type !== 'READY' || frame.requestId) return;
                    cleanup();
                    if (frame.containerId !== relay.containerId
                        || frame.effectiveInstanceId !== relay.effectiveInstanceId
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
                version: RUNTIME_RELAY_PROTOCOL_VERSION,
                targetAgentId: relay.targetAgentId,
                effectiveInstanceId: relay.effectiveInstanceId,
                containerId: relay.containerId,
                generationDigest: plan.generationDigest,
                relaySessionId: session.payload.relaySessionId,
                deniedPorts: session.payload.deniedPorts,
                denySetDigest: session.payload.denySetDigest,
                token: session.token,
            });
            await ready;
            return channel;
        } catch (error) {
            release();
            try { child?.kill(); } catch (_) {}
            throw error;
        }
    }
}

export default RuntimeRelayManager;
