import { EventEmitter } from 'node:events';

import { ProviderTerminalChannel, TerminalTasks } from './providerTerminalChannel.mjs';
import { EXECUTION_PROVIDER_TERMINAL_HELLO_PURPOSE } from '../../../Agent/lib/routerServiceToken.mjs';
import { ProviderTerminalState } from './providerTerminalState.mjs';
import {
    encodeTerminalControl, encodeTerminalData, terminalError, terminalPossessionProof, terminalSequence, U64_MAX,
} from './providerTerminalProtocol.mjs';

export const PROVIDER_TERMINAL_LIMIT_NAMES = Object.freeze([
    'handshakeMs', 'sendMs', 'operationMs', 'heartbeatMs', 'leaseMs',
    'queueBytes', 'inputBytes', 'operations', 'ptys',
]);

export class ProviderTerminalClient extends EventEmitter {
    #deps;
    #limits;
    #tasks;
    #state;
    #ownership = null;
    #active = null;
    #provisional = null;
    #connecting = null;
    #controller = null;
    #helloSent = false;
    #closed = false;
    #shutdown = null;
    #expiryTimer;
    #heartbeatTimer;
    #heartbeatDeadline;
    #heartbeatPending = false;

    constructor({ provider, path, openTransport, routerServiceTokenService, mintLaunchEvidence,
        isLeaseCurrent, now = Date.now, setTimeout: schedule = setTimeout,
        clearTimeout: cancel = clearTimeout, limits } = {}) {
        super();
        if (typeof provider !== 'string' || !provider || typeof path !== 'string' || !path.startsWith('/')
            || typeof openTransport !== 'function' || typeof routerServiceTokenService?.mint !== 'function'
            || typeof mintLaunchEvidence !== 'function' || typeof isLeaseCurrent !== 'function'
            || typeof now !== 'function' || typeof schedule !== 'function' || typeof cancel !== 'function') {
            throw terminalError('configuration');
        }
        // The embedding Router must explicitly choose every local budget;
        // fixture timing is not a production liveness qualification.
        if (!limits || typeof limits !== 'object' || Array.isArray(limits)
            || Object.keys(limits).length !== PROVIDER_TERMINAL_LIMIT_NAMES.length
            || !PROVIDER_TERMINAL_LIMIT_NAMES.every((name) => Object.hasOwn(limits, name))) {
            throw terminalError('configuration');
        }
        this.#limits = Object.freeze({ ...limits });
        for (const [name, value] of Object.entries(this.#limits)) {
            if (!PROVIDER_TERMINAL_LIMIT_NAMES.includes(name)
                || !Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) {
                throw terminalError('configuration');
            }
        }
        this.#deps = { provider, path, openTransport, routerServiceTokenService, mintLaunchEvidence,
            isLeaseCurrent, now, setTimeout: schedule, clearTimeout: cancel };
        this.#tasks = new TerminalTasks(this.#deps);
        this.#state = new ProviderTerminalState(this.#limits);
    }

    #lease(lease) {
        if (!lease) throw terminalError('stale_lease');
        let current = false;
        try { current = this.#deps.isLeaseCurrent(lease) === true; } catch (_) { }
        if (!current) throw terminalError('stale_lease');
    }

    #usable(lease) {
        if (this.#closed) throw terminalError('closed');
        this.#lease(lease);
        const channel = this.#active;
        if (!channel || channel.closed || !this.#ownership
            || this.#ownership.deadline <= this.#deps.now()) throw terminalError('disconnected');
        channel.checkLease();
        return channel;
    }

    #onChannelClose(channel, category) {
        this.#state.disconnect(channel);
        if (channel === this.#active) {
            this.#active = null;
            this.#stopHeartbeat();
            this.emit('diagnostic', { category });
        }
    }

    connect({ lease } = {}) { return this.#connect(lease, false); }
    rotate({ lease } = {}) { return this.#connect(lease, true); }

    #connect(lease, rotate) {
        if (this.#closed) return Promise.reject(terminalError('closed'));
        try { this.#lease(lease); } catch (error) { return Promise.reject(error); }
        if (this.#connecting) return Promise.reject(terminalError('busy'));
        if (!rotate && this.#active) return Promise.reject(terminalError('already_connected'));
        if (rotate && !this.#ownership) return Promise.reject(terminalError('ownership_unavailable'));
        if (this.#helloSent && !this.#ownership) return Promise.reject(terminalError('ownership_unavailable'));
        const controller = new AbortController();
        this.#controller = controller;
        this.#connecting = this.#establish(lease, controller).finally(() => {
            this.#controller = null;
            this.#connecting = null;
        });
        return this.#connecting;
    }

    async #establish(lease, controller) {
        let channel;
        try {
            const { provider, path } = this.#deps;
            const token = await this.#tasks.call(() => this.#deps.routerServiceTokenService.mint({
                targetAgentId: provider, path,
            }), this.#limits.handshakeMs, 'token');
            this.#lease(lease);
            if (this.#closed) throw terminalError('closed');
            const transport = await this.#tasks.call(() => {
                this.#lease(lease);
                return this.#deps.openTransport({ provider, path, lease, signal: controller.signal,
                    headers: { 'x-ploinky-auth-info': JSON.stringify({ routerServiceToken: token }) },
                });
            }, this.#limits.handshakeMs, 'open', (late) => { try { late?.close(); } catch (_) { } });
            try {
                this.#lease(lease);
                if (this.#closed) throw terminalError('closed');
                channel = new ProviderTerminalChannel(transport, {
                    timers: this.#deps, limits: this.#limits, checkLease: () => this.#lease(lease),
                    onFrame: (frame, binary) => this.#onFrame(channel, frame, binary),
                    onClose: (category) => {
                        controller.abort();
                        this.#onChannelClose(channel, category);
                    },
                });
            } catch (error) {
                try { transport.close(); } catch (_) { }
                throw error;
            }
            this.#provisional = channel;
            const challenge = await channel.wait('challenge');
            const ownership = this.#ownership;
            if (ownership && ownership.deadline <= this.#deps.now()) throw terminalError('expired');
            // Mint the hello token for this connection's nonce within handshakeMs,
            // then recheck the lease and closed state. Only after that is the
            // frame committed: a mint failure or stale lease sends nothing and
            // leaves #helloSent unset, so a later connect() remains possible.
            const helloToken = await this.#tasks.call(() => this.#deps.routerServiceTokenService.mint({
                targetAgentId: provider, path, purpose: EXECUTION_PROVIDER_TERMINAL_HELLO_PURPOSE,
                nonce: challenge.nonce,
            }), this.#limits.handshakeMs, 'token');
            this.#lease(lease);
            if (this.#closed || channel.closed) throw terminalError('closed');
            if (ownership && ownership.deadline <= this.#deps.now()) throw terminalError('expired');
            const fields = ownership ? {
                ownershipSessionId: ownership.ownershipSessionId, workerGeneration: ownership.workerGeneration,
                proof: terminalPossessionProof({ ...ownership, nonce: challenge.nonce }), helloToken,
            } : { helloToken };
            // Encode (schema-validate, including helloToken) before the latch: a
            // minter result the frame rejects must send nothing and leave
            // reconnect possible. Nothing between the latch and send can throw.
            const frameType = ownership ? 'reattach' : 'hello';
            const wire = encodeTerminalControl({ v: 1, type: frameType, ...fields });
            const response = channel.wait(ownership ? 'reattach-ok' : 'hello-ok');
            if (!ownership) this.#helloSent = true;
            const [reply] = await Promise.all([response, channel.send(wire, false, () => {}, true)]);
            this.#lease(lease);
            if (this.#closed || channel.closed) throw terminalError('closed');
            let lost = [];
            if (ownership) lost = this.#state.reconcile(reply.ptys);
            else this.#ownership = {
                ownershipSessionId: reply.ownershipSessionId, workerGeneration: reply.workerGeneration,
                secret: reply.secret, leaseExpiresAt: reply.leaseExpiresAt,
            };
            const previous = this.#active;
            this.#active = channel;
            this.#provisional = null;
            this.#renew(reply.leaseExpiresAt);
            previous?.close('superseded');
            // After a reattach the worker's inventory is authoritative: a PTY
            // that is not in it has ended, and the Router learns that here.
            for (const ptySessionId of lost) this.emit('unavailable', { ptySessionId });
            channel.activate();
            if (this.#usable(lease) !== channel) throw terminalError('disconnected');
            this.#scheduleHeartbeat();
            return { connected: true };
        } catch (_) {
            controller.abort();
            channel?.close('connect_failed');
            if (this.#provisional === channel) this.#provisional = null;
            // A first hello that never produced an ownership session (refused,
            // or its reply lost) leaves no PTY and no secret to protect: a
            // later hello only supersedes whatever the worker created. Reset
            // the latch so that the next connect() can try again.
            if (!this.#ownership) this.#helloSent = false;
            throw terminalError('connect_failed');
        }
    }

    #renew(expiresAt) {
        // Remote time is opaque. This deadline bounds local liveness only;
        // expiry never supplies evidence of remote process termination.
        this.#ownership.leaseExpiresAt = expiresAt;
        this.#ownership.deadline = this.#deps.now() + this.#limits.leaseMs;
        this.#deps.clearTimeout(this.#expiryTimer);
        this.#expiryTimer = this.#deps.setTimeout(() => { void this.shutdown(); }, this.#limits.leaseMs);
    }

    #stopHeartbeat() {
        this.#deps.clearTimeout(this.#heartbeatTimer);
        this.#deps.clearTimeout(this.#heartbeatDeadline);
        this.#heartbeatPending = false;
    }

    #scheduleHeartbeat() {
        this.#stopHeartbeat();
        this.#heartbeatTimer = this.#deps.setTimeout(() => {
            const channel = this.#active;
            if (!channel || this.#closed) return;
            this.#heartbeatPending = true;
            this.#heartbeatDeadline = this.#deps.setTimeout(() => channel.close('heartbeat_timeout'),
                this.#limits.operationMs);
            void channel.sendControl('heartbeat').catch(() => channel.close('heartbeat_failed'));
        }, this.#limits.heartbeatMs);
    }

    #onFrame(channel, frame, binary) {
        if (channel !== this.#active || this.#closed) return;
        if (!this.#ownership || this.#ownership.deadline <= this.#deps.now()) throw terminalError('expired');
        if (!binary && frame.type === 'heartbeat-ok') {
            if (!this.#heartbeatPending) throw terminalError();
            this.#renew(frame.leaseExpiresAt);
            this.#scheduleHeartbeat();
        } else if (!binary && ['launched', 'launch-failed'].includes(frame.type)) {
            this.#state.reply(frame, channel);
        } else if (!binary && frame.type === 'superseded-connection') {
            channel.close('superseded');
        } else {
            const pty = this.#state.ptys.get(frame.ptySessionId);
            if (!pty) {
                if (!binary && !['ack', 'gap', 'ended'].includes(frame.type)) throw terminalError();
                return;
            }
            if (binary) {
                if (pty.attached !== channel || !pty.available || pty.closing) return;
                if (frame.sequence <= pty.output) return;
                if (frame.sequence !== pty.output + 1n) throw terminalError();
                pty.output = frame.sequence;
                this.emit('output', frame);
            } else if (frame.type === 'ack') {
                this.#state.acknowledge(pty, terminalSequence(frame.sequence));
            } else if (frame.type === 'gap') {
                pty.attached = null;
                this.emit('gap', { ptySessionId: pty.id, firstAvailable: terminalSequence(frame.firstAvailable) });
            } else if (frame.type === 'ended') {
                this.#state.ended(pty.id);
                this.emit('ended', frame);
            } else throw terminalError();
        }
    }

    launch(fields, { lease } = {}) {
        let channel;
        let operation;
        try {
            channel = this.#usable(lease);
            operation = this.#state.operation(fields);
            if (operation.result) return Promise.resolve(operation.result);
            if (operation.failure) {
                return Promise.reject(Object.assign(terminalError('launch_failed'), { refusal: operation.refusal }));
            }
            if (operation.attempt) return operation.attempt.promise;
        } catch (error) { return Promise.reject(error); }
        const attempt = { channel, finish: null };
        operation.attempt = attempt;
        attempt.promise = this.#tasks.run((finish) => {
            attempt.finish = finish;
            void (async () => {
                try {
                    const evidence = await this.#tasks.call(() => this.#deps.mintLaunchEvidence({
                        targetAgentId: this.#deps.provider, tool: '__provider_terminal_launch__',
                        method: 'LAUNCH', path: this.#deps.path, rch: operation.hash,
                        launch: operation.fields, lease,
                    }), this.#limits.operationMs, 'evidence');
                    if (operation.attempt !== attempt || this.#usable(lease) !== channel) throw terminalError();
                    await channel.sendControl('launch', { ...operation.fields, launchEvidence: evidence }, () => {
                        this.#lease(lease);
                        attempt.dispatched = true;
                    });
                } catch (_) { finish(true); }
            })();
        }, this.#limits.operationMs, 'launch_uncertain').catch((error) => {
            // A delivered refusal is final and says why; only a timeout, a
            // disconnect or a stale lease leaves the launch uncertain.
            if (operation.failure) {
                throw Object.assign(terminalError('launch_failed'), { refusal: operation.refusal });
            }
            throw error;
        }).finally(() => {
            if (operation.attempt === attempt) operation.attempt = null;
        });
        return attempt.promise;
    }

    async attach(ptySessionId, { lease, afterOutputSequence } = {}) {
        const channel = this.#usable(lease);
        const pty = this.#state.pty(ptySessionId);
        if (pty.attachPending) throw terminalError('busy');
        const cursor = afterOutputSequence === undefined ? pty.output : afterOutputSequence;
        if (typeof cursor !== 'bigint' || cursor < pty.output || cursor > U64_MAX) throw terminalError('cursor');
        pty.attachPending = true;
        try {
            await channel.sendControl('attach', { ptySessionId, afterOutputSequence: cursor.toString() }, () => {
                this.#lease(lease);
                pty.attached = channel;
                pty.output = cursor;
            });
            if (this.#usable(lease) !== channel || pty.attached !== channel) throw terminalError('disconnected');
            for (const [sequence, frame] of pty.inputs) {
                await channel.send(frame, true, () => {
                    this.#lease(lease);
                    if (sequence > pty.dispatched) pty.dispatched = sequence;
                });
                if (this.#usable(lease) !== channel) throw terminalError('disconnected');
            }
        } catch (error) {
            if (pty.attached === channel) pty.attached = null;
            throw error;
        } finally {
            pty.attachPending = false;
        }
    }

    async input(ptySessionId, payload, { lease } = {}) {
        const channel = this.#usable(lease);
        const pty = this.#state.pty(ptySessionId);
        if (pty.attached !== channel) throw terminalError('not_attached');
        if (pty.nextInput > U64_MAX) throw terminalError('sequence_exhausted');
        if (pty.nextInput > pty.dispatched + 1n) throw terminalError('input_requires_reattach');
        const sequence = pty.nextInput;
        const frame = encodeTerminalData({ ptySessionId, sequence, payload });
        if (this.#state.inputBytes + frame.length > this.#limits.inputBytes) throw terminalError('backpressure');
        pty.nextInput += 1n;
        this.#state.inputBytes += frame.length;
        pty.inputs.set(sequence, frame);
        await channel.send(frame, true, () => {
            this.#lease(lease);
            pty.dispatched = sequence;
        });
        return sequence;
    }

    resize(ptySessionId, cols, rows, { lease } = {}) {
        const channel = this.#usable(lease);
        const pty = this.#state.pty(ptySessionId);
        if (pty.attached !== channel) throw terminalError('not_attached');
        return channel.sendControl('resize', { ptySessionId, cols, rows }, () => this.#lease(lease));
    }

    close(ptySessionId, { lease } = {}) {
        const channel = this.#usable(lease);
        const existing = this.#state.ptys.get(ptySessionId);
        if (existing?.closePromise) return existing.closePromise;
        const pty = this.#state.pty(ptySessionId);
        pty.closing = true;
        pty.attached = null;
        const attempt = channel.sendControl('close', { ptySessionId, reason: 'user-close' },
            () => this.#lease(lease)).catch((error) => {
            // A refused or uncertain send retains no proof of remote closure.
            // A later current-lease call may retry without reviving attachment.
            if (pty.closePromise === attempt) {
                pty.closePromise = null;
                pty.closing = false;
            }
            throw error;
        });
        pty.closePromise = attempt;
        return attempt;
    }

    shutdown() {
        if (this.#shutdown) return this.#shutdown;
        this.#closed = true;
        this.#controller?.abort();
        this.#tasks.close();
        this.#stopHeartbeat();
        this.#deps.clearTimeout(this.#expiryTimer);
        this.#provisional?.close('shutdown');
        this.#provisional = null;
        const channel = this.#active;
        this.#shutdown = (async () => {
            if (channel && this.#ownership?.deadline > this.#deps.now()) {
                await Promise.allSettled([...this.#state.ptys.keys()].map((ptySessionId) =>
                    channel.sendControl('close', { ptySessionId, reason: 'router-shutdown' })));
            }
            channel?.close('shutdown');
            this.#active = null;
            this.#ownership = null;
            const known = [...this.#state.ptys.keys()];
            this.#state.clear();
            // A local notice, not a protocol cause and not an `ended` frame:
            // the client is permanently closed and every PTY it knew is gone
            // from its point of view. Its owner replaces it and ends those
            // sessions with the cause 'shutdown'.
            this.emit('shutdown', { ptySessionIds: known });
            return { localClosed: true, remoteTerminationProven: false };
        })();
        return this.#shutdown;
    }

    // Non-secret view for the owner of this client: whether the worker-side
    // ownership session is still held locally (its deadline has not passed).
    ownershipHeld() {
        return !this.#closed && Boolean(this.#ownership) && this.#ownership.deadline > this.#deps.now();
    }

    get closed() { return this.#closed; }

    // Drops an unresolved launch operation that no attempt is waiting on, so a
    // long-lived client does not accumulate operations it will never retry.
    forget(operationId) { return this.#state.forget(operationId); }
}
