import { EventEmitter } from 'node:events';
import { ProviderTerminalClient } from '../../../cli/server/webtty/providerTerminalClient.mjs';
import { RouterServiceTokenService } from '../../../cli/server/security/tokens/RouterServiceTokenService.js';

export const OWNER = '12345678-1234-4234-8234-123456789abc';
export const GENERATION = '87654321-4321-4321-a321-cba987654321';
export const PTY = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const OPERATION = '33333333-3333-4333-8333-333333333333';
export const SECRET = Buffer.alloc(32, 17).toString('base64url');
// Distinct 32-byte challenge nonce per transport (index 0 is NONCE), so a hello
// token minted for one connection can never satisfy another.
export const nonceFor = (index) => Buffer.alloc(32, 33 + index).toString('base64url');
export const NONCE = nonceFor(0);
export const fields = (extra = {}) => ({ operationId: OPERATION, targetId: 'target_1', project: null,
    cols: 80, rows: 24, ...extra });
export const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

export class ManualClock {
    constructor() {
        this.time = 10000000;
        this.next = 1;
        this.timers = new Map();
    }
    now = () => this.time;
    setTimeout = (fn, delay) => {
        const id = this.next++;
        this.timers.set(id, { at: this.time + delay, fn });
        return id;
    };
    clearTimeout = (id) => { this.timers.delete(id); };
    async advance(ms) {
        const target = this.time + ms;
        for (;;) {
            await flush();
            const next = [...this.timers].filter(([, timer]) => timer.at <= target)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            this.time = next[1].at;
            this.timers.delete(next[0]);
            next[1].fn();
        }
        this.time = target;
        await flush();
    }
}

// Scripted bytes only: no worker authentication, session implementation or PTY.
export class ScriptedTerminalTransport extends EventEmitter {
    constructor() {
        super();
        this.sent = [];
        this.callbacks = [];
        this.autoCallback = true;
        this.closed = 0;
        this.nonce = NONCE;
    }
    send(data, options, callback) {
        this.sent.push({ data: Buffer.isBuffer(data) ? Buffer.from(data) : data, binary: options.binary });
        if (this.autoCallback) callback(null);
        else this.callbacks.push(callback);
    }
    close() { this.closed += 1; }
    peer(type, values = {}) { this.emit('message', JSON.stringify({ v: 1, type, ...values }), false); }
    output(id, sequence, payload = 'out') {
        const frame = Buffer.alloc(26 + Buffer.byteLength(payload));
        frame[0] = 1;
        frame[1] = 2;
        Buffer.from(id.replaceAll('-', ''), 'hex').copy(frame, 2);
        frame.writeBigUInt64BE(sequence, 18);
        frame.write(payload, 26);
        this.emit('message', frame, true);
    }
    controls(type) {
        return this.sent.filter((frame) => !frame.binary).map((frame) => JSON.parse(frame.data))
            .filter((frame) => !type || frame.type === type);
    }
}

export function harness(options = {}) {
    const clock = new ManualClock();
    const transports = [];
    const openings = [];
    const evidence = [];
    const diagnostics = [];
    const lease = { current: true };
    let tokenCount = 0;
    const service = new RouterServiceTokenService({
        resolveAgentSecret: () => Buffer.alloc(32, 99),
        now: () => new Date(clock.time), randomId: () => `fixture-jti-${++tokenCount}`,
    });
    const client = new ProviderTerminalClient({
        provider: 'agent:fixture/provider', path: '/terminal-control',
        openTransport: async (request) => {
            openings.push(request);
            const transport = new ScriptedTerminalTransport();
            transport.nonce = nonceFor(transports.length);
            transports.push(transport);
            if (options.open) await options.open(transport);
            return transport;
        },
        routerServiceTokenService: options.service || service,
        mintLaunchEvidence: async (request) => {
            evidence.push(request);
            return options.evidence ? options.evidence(request) : `fixture-evidence-${evidence.length}`;
        },
        isLeaseCurrent: (value) => value.current,
        now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        limits: { handshakeMs: 200, sendMs: 50, operationMs: 100, heartbeatMs: 1000, leaseMs: 3000,
            operations: 4, ptys: 4, queueBytes: 4096, inputBytes: 4096, ...options.limits },
    });
    client.on('diagnostic', (entry) => diagnostics.push(entry));
    return { client, clock, transports, openings, evidence, diagnostics, lease };
}

export async function connect(h) {
    const promise = h.client.connect({ lease: h.lease });
    await flush();
    const transport = h.transports.at(-1);
    transport.peer('challenge', { nonce: transport.nonce });
    await flush();
    transport.peer('hello-ok', { ownershipSessionId: OWNER, workerGeneration: GENERATION,
        leaseExpiresAt: 12, secret: SECRET });
    await promise;
    return transport;
}

export async function launch(h, transport, input = fields(), id = PTY) {
    const result = h.client.launch(input, { lease: h.lease });
    await flush();
    transport.peer('launched', { operationId: input.operationId, ptySessionId: id });
    return result;
}

export async function startRotation(h) {
    const promise = h.client.rotate({ lease: h.lease });
    await flush();
    const transport = h.transports.at(-1);
    transport.peer('challenge', { nonce: transport.nonce });
    await flush();
    return { promise, transport };
}

export async function finishRotation(rotation, ptys = []) {
    rotation.transport.peer('reattach-ok', { leaseExpiresAt: 12, ptys });
    await rotation.promise;
}
