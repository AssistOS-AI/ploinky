import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { TextDecoder } from 'node:util';

import { PROVIDER_TERMINAL_LIMITS, terminalError } from './providerTerminalProtocol.mjs';
import { createRelayHttpAgent, RelayDuplex } from '../proxy/executeHttpPlan.js';
import { finalizePlanAfterAdmission } from '../proxy/RoutePlan.js';
import { sanitizeRequestHeaders } from '../proxy/sanitizeRequestHeaders.js';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONTROL_MAX = 125;
// A data frame is at most the 26-byte header plus 64 KiB; a control (JSON)
// frame at most 16 KiB. Anything longer is refused before it is buffered.
const TEXT_MAX = PROVIDER_TERMINAL_LIMITS.json;
const BINARY_MAX = PROVIDER_TERMINAL_LIMITS.header + PROVIDER_TERMINAL_LIMITS.payload;
const FRAME_HEADER_MAX = 2 + 8;

function maskedFrame(opcode, payload) {
    const length = payload.length;
    const extra = length > 65535 ? 8 : length > 125 ? 2 : 0;
    const frame = Buffer.alloc(2 + extra + 4 + length);
    frame[0] = 0x80 | opcode;
    if (length > 65535) {
        frame[1] = 0x80 | 127;
        frame.writeBigUInt64BE(BigInt(length), 2);
    } else if (length > 125) {
        frame[1] = 0x80 | 126;
        frame.writeUInt16BE(length, 2);
    } else {
        frame[1] = 0x80 | length;
    }
    const mask = crypto.randomBytes(4);
    mask.copy(frame, 2 + extra);
    for (let index = 0; index < length; index += 1) frame[2 + extra + 4 + index] = payload[index] ^ mask[index % 4];
    return frame;
}

// A minimal RFC 6455 client over an already upgraded duplex: masked frames out,
// no extensions, no fragmentation, unmasked frames in, hard length bounds that
// are checked before any payload is buffered. It reports `(data, isBinary)` as
// the provider terminal channel requires and a completion callback per send.
export class BoundedClientWebSocket extends EventEmitter {
    constructor(socket, head = Buffer.alloc(0)) {
        super();
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.closed = false;
        this.decoder = new TextDecoder('utf-8', { fatal: true });
        socket.on('data', (chunk) => this.#data(chunk));
        socket.on('error', () => this.#end());
        socket.on('close', () => this.#end());
        socket.on('end', () => this.#end());
        if (head?.length) queueMicrotask(() => this.#data(head));
    }

    #end() {
        if (this.closed) return;
        this.closed = true;
        this.buffer = Buffer.alloc(0);
        try { this.socket.destroy(); } catch (_) { }
        this.emit('close');
    }

    #fail() {
        this.#end();
    }

    #data(chunk) {
        if (this.closed) return;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            if (this.closed || this.buffer.length < 2) return;
            const first = this.buffer[0];
            const second = this.buffer[1];
            const fin = (first & 0x80) !== 0;
            const opcode = first & 0x0f;
            if ((first & 0x70) !== 0 || !fin || (second & 0x80) !== 0) { this.#fail(); return; }
            if (![0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) { this.#fail(); return; }
            let length = second & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (this.buffer.length < 4) return;
                length = this.buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (this.buffer.length < FRAME_HEADER_MAX) return;
                const wide = this.buffer.readBigUInt64BE(2);
                if (wide > BigInt(BINARY_MAX)) { this.#fail(); return; }
                length = Number(wide);
                offset = FRAME_HEADER_MAX;
            }
            const limit = opcode >= 0x8 ? CONTROL_MAX : opcode === 0x1 ? TEXT_MAX : BINARY_MAX;
            if (length > limit) { this.#fail(); return; }
            if (this.buffer.length < offset + length) return;
            const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
            this.buffer = this.buffer.subarray(offset + length);
            if (opcode === 0x8) { this.#end(); return; }
            if (opcode === 0x9) { this.#write(maskedFrame(0xa, payload), () => {}); continue; }
            if (opcode === 0xa) continue;
            if (opcode === 0x1) {
                let text;
                try { text = this.decoder.decode(payload); } catch (_) { this.#fail(); return; }
                this.emit('message', text, false);
            } else {
                this.emit('message', payload, true);
            }
        }
    }

    #write(frame, callback) {
        if (this.closed || this.socket.destroyed || !this.socket.writable) {
            callback(terminalError('disconnected'));
            return;
        }
        try {
            this.socket.write(frame, (error) => callback(error || null));
        } catch (error) {
            callback(error);
        }
    }

    send(data, { binary } = {}, callback = () => {}) {
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        this.#write(maskedFrame(binary ? 0x2 : 0x1, payload), callback);
    }

    close() {
        if (this.closed) return;
        const code = Buffer.alloc(2);
        code.writeUInt16BE(1000, 0);
        try { this.socket.write(maskedFrame(0x8, code)); } catch (_) { }
        this.#end();
    }
}

// Opens one WebSocket to a provider terminal endpoint through the Router's
// private relay. `plan` is a planProviderEndpoint plan for the websocket
// operation; `authInfo` is the Router-only upgrade token header value the
// client minted. Resolves a transport for ProviderTerminalChannel. Every
// failure or abort releases the relay checkout.
export async function openProviderTerminalTransport({ plan, lease, relayManager, authInfo, signal } = {}) {
    if (!relayManager || typeof relayManager.checkout !== 'function') throw terminalError('transport');
    const finalized = finalizePlanAfterAdmission(plan);
    const key = crypto.randomBytes(16).toString('base64');
    const headers = sanitizeRequestHeaders({
        'sec-websocket-version': '13',
        'sec-websocket-key': key,
    }, finalized, { authInfo: String(authInfo || '') });
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    let checkout = null;
    let relayAgent = null;
    let upstream = null;
    let socket = null;
    let timer;
    let settled = false;
    const release = () => {
        clearTimeout(timer);
        try { upstream?.destroy(); } catch (_) { }
        try { relayAgent?.destroy(); } catch (_) { }
        try { checkout?.close?.(); } catch (_) { }
    };
    return new Promise((resolve, reject) => {
        const fail = (error) => {
            if (settled) return;
            settled = true;
            try { socket?.destroy(); } catch (_) { }
            release();
            reject(error instanceof Error ? error : terminalError('transport'));
        };
        const onAbort = () => fail(terminalError('aborted'));
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => fail(terminalError('handshake')), finalized.limits.webSocketHandshakeTimeoutMs);
        timer.unref?.();
        (async () => {
            checkout = await relayManager.checkout({ plan: finalized, lease, authorized: true });
            if (settled) { release(); return; }
            const relayStream = await checkout.openRequest({
                plan: { ...finalized, transport: 'websocket' }, bodyMode: 'stream', bodyHash: '', headers,
            });
            if (settled) { try { relayStream?.abandon?.(); } catch (_) { } release(); return; }
            relayAgent = createRelayHttpAgent(new RelayDuplex(relayStream));
            upstream = http.request({
                method: 'GET',
                path: finalized.targetPath,
                headers,
                maxHeaderSize: finalized.limits.responseHeaderBytes,
                agent: relayAgent,
            });
            upstream.once('upgrade', (response, upgraded, upstreamHead) => {
                socket = upgraded;
                const expected = crypto.createHash('sha1').update(key + MAGIC).digest('base64');
                if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expected
                    || response.headers['sec-websocket-extensions'] !== undefined) {
                    fail(terminalError('handshake'));
                    return;
                }
                if (settled) { try { upgraded.destroy(); } catch (_) { } return; }
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                const websocket = new BoundedClientWebSocket(upgraded, upstreamHead);
                websocket.once('close', release);
                resolve(websocket);
            });
            upstream.once('response', (response) => { response.resume(); fail(terminalError('handshake')); });
            upstream.once('error', () => fail(terminalError('transport')));
            upstream.end();
        })().catch(() => fail(terminalError('transport')));
    });
}
