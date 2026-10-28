import {
    decodeTerminalControl, decodeTerminalData, encodeTerminalControl, terminalError,
} from './providerTerminalProtocol.mjs';

// Every asynchronous boundary has a deadline and a cancellation owner. Late
// callbacks may release their own resource but cannot publish a result.
export class TerminalTasks {
    constructor({ setTimeout: schedule, clearTimeout: cancel }) {
        this.schedule = schedule;
        this.cancel = cancel;
        this.pending = new Set();
        this.closed = false;
    }

    run(start, timeout, code, late = () => {}) {
        if (this.closed) return Promise.reject(terminalError('closed'));
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer;
            const finish = (error, value) => {
                if (settled) {
                    if (!error) late(value);
                    return;
                }
                settled = true;
                this.cancel(timer);
                this.pending.delete(stop);
                if (error) reject(terminalError(code));
                else resolve(value);
            };
            const stop = () => finish(true);
            this.pending.add(stop);
            timer = this.schedule(stop, timeout);
            try { start(finish); } catch (_) { finish(true); }
        });
    }

    async call(fn, timeout, code, late) {
        return this.run((finish) => {
            Promise.resolve().then(fn).then((value) => finish(null, value), () => finish(true));
        }, timeout, code, late);
    }

    close() {
        this.closed = true;
        for (const stop of [...this.pending]) stop();
    }
}

// Injected transport: EventEmitter on/off; message(data, isBinary), error,
// close; send(data, { binary }, callback), close(). No network is opened here.
export class ProviderTerminalChannel {
    constructor(transport, { timers, limits, checkLease, onFrame, onClose }) {
        this.transport = transport;
        this.limits = limits;
        this.checkLease = checkLease;
        this.onFrame = onFrame;
        this.onClose = onClose;
        this.tasks = new TerminalTasks(timers);
        this.queuedBytes = 0;
        this.closed = false;
        this.ready = false;
        this.waiter = null;
        this.buffering = false;
        this.buffer = [];
        this.bufferBytes = 0;
        this.receive = (data, binary) => {
            if (this.closed) return;
            try {
                if (typeof binary !== 'boolean') throw terminalError();
                const frame = binary ? decodeTerminalData(data) : decodeTerminalControl(data);
                if (this.waiter) {
                    if (binary || frame.type !== this.waiter.type) throw terminalError();
                    const finish = this.waiter.finish;
                    this.waiter = null;
                    this.buffering = ['hello-ok', 'reattach-ok'].includes(frame.type);
                    finish(null, frame);
                } else {
                    if (this.buffering && !this.ready) {
                        this.bufferBytes += Buffer.byteLength(data);
                        if (this.bufferBytes > this.limits.queueBytes) throw terminalError('backpressure');
                        this.buffer.push([frame, binary]);
                        return;
                    }
                    if (!this.ready) throw terminalError();
                    this.onFrame(frame, binary);
                }
            } catch (_) { this.close('protocol'); }
        };
        this.failed = () => this.close('transport');
        transport.on('message', this.receive);
        transport.on('error', this.failed);
        transport.on('close', this.failed);
    }

    wait(type) {
        if (this.waiter) throw terminalError('busy');
        const result = this.tasks.run((finish) => { this.waiter = { type, finish }; },
            this.limits.handshakeMs, 'handshake');
        return result.finally(() => { this.waiter = null; });
    }

    sendControl(type, fields = {}, leaseCheck = () => {}) {
        return this.send(encodeTerminalControl({ v: 1, type, ...fields }), false, leaseCheck, type !== 'heartbeat');
    }

    send(data, binary, leaseCheck = () => {}, checkRoute = true) {
        if (this.closed) return Promise.reject(terminalError('disconnected'));
        const bytes = Buffer.byteLength(data);
        if (this.queuedBytes + bytes > this.limits.queueBytes) {
            return Promise.reject(terminalError('backpressure'));
        }
        this.queuedBytes += bytes;
        return this.tasks.run((finish) => {
            if (checkRoute) this.checkLease();
            leaseCheck();
            this.transport.send(data, { binary }, (error) => finish(Boolean(error)));
        }, this.limits.sendMs, 'send').finally(() => { this.queuedBytes -= bytes; });
    }

    activate() {
        this.ready = true;
        this.buffering = false;
        const buffered = this.buffer;
        this.buffer = [];
        this.bufferBytes = 0;
        for (const [frame, binary] of buffered) this.onFrame(frame, binary);
    }

    close(category = 'disconnected') {
        if (this.closed) return;
        this.closed = true;
        this.ready = false;
        this.tasks.close();
        this.waiter = null;
        this.buffer = [];
        this.bufferBytes = 0;
        this.transport.off('message', this.receive);
        this.transport.off('error', this.failed);
        this.transport.off('close', this.failed);
        try { this.transport.close(); } catch (_) { }
        this.onClose(category);
    }
}
