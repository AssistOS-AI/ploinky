import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { createRoutePlan } from '../../../cli/server/proxy/RoutePlan.js';
import { compileProxyLimits } from '../../../cli/server/proxy/limits.js';

export const PRINCIPAL = 'agent:fixture/provider';
export const TERMINALS_PATH = '/fixture/terminal-control';

// A pre-admission plan of the kind planProviderEndpoint returns, for the
// websocket operation ('') or the targets POST ('/targets').
export function providerPlan({ routeKey = 'fixture-provider', suffix = '', lease, path = TERMINALS_PATH, instance = 'instance-1',
    generation = 'enable-1', principal = PRINCIPAL, transport = suffix ? 'http' : 'websocket' } = {}) {
    return createRoutePlan({
        matched: true,
        ok: true,
        kind: 'provider-endpoint',
        listenerClass: 'internal',
        authority: 'router.internal',
        surfaceKind: 'provider-endpoint',
        owner: { effectiveInstanceId: instance, enableGeneration: generation },
        routeKey,
        route: { repo: 'fixture', agent: 'provider' },
        endpoint: 'terminals',
        port: 7300,
        policyPath: `${path}${suffix}`,
        convention: 'agent-port',
        unmatchedSuffix: `${path}${suffix}`,
        relay: { kind: 'container-control-socket', targetAgentId: principal, effectiveInstanceId: instance,
            enableGeneration: generation },
        access: { access: 'internal-provider-endpoint', routeKey, endpoint: 'terminals' },
        scheme: 'http',
        origin: 'http://router.internal',
        limits: compileProxyLimits(),
        generationDigest: lease?.id ?? 'generation-1',
        auditId: crypto.randomUUID(),
        method: suffix ? 'POST' : 'GET',
        query: '',
        transport,
        lease,
    });
}

// The relay stream a RuntimeRelay channel returns from openRequest, as far as
// RelayDuplex and node:http use it. `respond({ method, path, headers, body })`
// returns the raw bytes of the answer (or null to stay silent); a function
// may also return `{ bytes, then }` to push frames after the handshake.
export class FakeRelayStream extends EventEmitter {
    constructor(respond) {
        super();
        this.respond = respond;
        this.received = Buffer.alloc(0);
        this.abandoned = false;
        this.ended = false;
        this.answered = false;
    }

    write(chunk) {
        this.received = Buffer.concat([this.received, Buffer.from(chunk)]);
        this.#maybeAnswer();
        return true;
    }

    end() { this.ended = true; this.#maybeAnswer(); }

    abandon() { this.abandoned = true; }

    cancel() { this.abandoned = true; }

    push(bytes) { this.emit('data', Buffer.from(bytes)); }

    #maybeAnswer() {
        if (this.answered) return;
        const text = this.received.toString('latin1');
        const split = text.indexOf('\r\n\r\n');
        if (split < 0) return;
        const [requestLine, ...headerLines] = text.slice(0, split).split('\r\n');
        const headers = Object.fromEntries(headerLines.map((line) => {
            const index = line.indexOf(':');
            return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
        }));
        const bodyStart = split + 4;
        const length = Number(headers['content-length'] || 0);
        if (this.received.length < bodyStart + length) return;
        this.answered = true;
        const [method, path] = requestLine.split(' ');
        const body = this.received.subarray(bodyStart, bodyStart + length);
        this.request = { method, path, headers, body };
        const answer = this.respond(this.request, this);
        if (answer) queueMicrotask(() => {
            this.push(answer);
            if (!headers.upgrade) this.emit('end');
        });
    }
}

export function httpAnswer(status, body = '', headers = {}) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const lines = [`HTTP/1.1 ${status} X`, `content-length: ${payload.length}`, 'connection: close',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)];
    return Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), payload]);
}

export function upgradeAnswer(key, extra = {}) {
    const accept = extra.accept ?? crypto.createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const lines = ['HTTP/1.1 101 Switching Protocols', 'upgrade: websocket', 'connection: Upgrade',
        `sec-websocket-accept: ${accept}`, ...Object.entries(extra.headers || {}).map(([n, v]) => `${n}: ${v}`)];
    return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
}

// A runtime relay manager whose checkouts are observable.
export function fakeRelayManager(respond) {
    const manager = { checkouts: [], streams: [], closed: 0 };
    manager.checkout = async ({ plan, lease, authorized }) => {
        const checkout = {
            plan, lease, authorized, closed: 0,
            async openRequest(request) {
                checkout.request = request;
                const stream = new FakeRelayStream(respond);
                manager.streams.push(stream);
                return stream;
            },
            close() { checkout.closed += 1; manager.closed += 1; },
        };
        manager.checkouts.push(checkout);
        return checkout;
    };
    return manager;
}

// Server-side (unmasked) frames for the bounded client codec.
export function serverFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = false, rsv = 0 } = {}) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const length = body.length;
    const header = [];
    header.push((fin ? 0x80 : 0) | rsv | opcode);
    const maskBit = mask ? 0x80 : 0;
    if (length < 126) header.push(maskBit | length);
    else if (length <= 0xffff) header.push(maskBit | 126, length >> 8, length & 0xff);
    else {
        const wide = Buffer.alloc(8);
        wide.writeBigUInt64BE(BigInt(length));
        header.push(maskBit | 127, ...wide);
    }
    return Buffer.concat([Buffer.from(header), mask ? Buffer.alloc(4) : Buffer.alloc(0), body]);
}

// Reads one masked client frame from `bytes`: { opcode, payload, masked }.
export function readClientFrame(bytes) {
    const opcode = bytes[0] & 0x0f;
    const masked = Boolean(bytes[1] & 0x80);
    let length = bytes[1] & 0x7f;
    let offset = 2;
    if (length === 126) { length = bytes.readUInt16BE(2); offset = 4; }
    else if (length === 127) { length = Number(bytes.readBigUInt64BE(2)); offset = 10; }
    const key = masked ? bytes.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    const payload = Buffer.from(bytes.subarray(offset, offset + length));
    if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] ^= key[index % 4];
    return { opcode, payload, masked, total: offset + length };
}
