import { EventEmitter } from 'node:events';

export const RUNTIME_RELAY_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_RELAY_FRAME_BYTES = 8 * 1024 * 1024;
export const RELAY_FRAME_TYPES = Object.freeze([
    'HELLO', 'READY', 'OPEN', 'DATA', 'HALF_CLOSE', 'CANCEL', 'END', 'ERROR',
]);

const TYPES = new Set(RELAY_FRAME_TYPES);

function normalizeFrame(frameOrType, payload) {
    const frame = typeof frameOrType === 'string'
        ? { ...(payload || {}), type: frameOrType }
        : { ...(frameOrType || {}) };
    const type = String(frame.type || '').toUpperCase();
    if (!TYPES.has(type)) throw new Error(`runtimeRelayProtocol: unknown frame type '${frame.type || ''}'`);
    const normalized = { ...frame, type };
    if (Buffer.isBuffer(normalized.data) || normalized.data instanceof Uint8Array) {
        normalized.data = Buffer.from(normalized.data).toString('base64');
        normalized.dataEncoding = 'base64';
    }
    return normalized;
}

function restoreFrameData(frame) {
    if (frame?.dataEncoding !== 'base64') return frame;
    if (typeof frame.data !== 'string') throw new Error('runtimeRelayProtocol: base64 DATA payload must be a string');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) {
        throw new Error('runtimeRelayProtocol: malformed base64 DATA payload');
    }
    return { ...frame, data: Buffer.from(frame.data, 'base64') };
}

export function encodeRelayFrame(frameOrType, payload, { maxFrameBytes = DEFAULT_MAX_RELAY_FRAME_BYTES } = {}) {
    const body = Buffer.from(JSON.stringify(normalizeFrame(frameOrType, payload)), 'utf8');
    if (!body.length || body.length > maxFrameBytes) throw new Error(`runtimeRelayProtocol: invalid frame length ${body.length}`);
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(body.length, 0);
    return Buffer.concat([prefix, body]);
}

export function decodeRelayFrameBody(body) {
    let frame;
    try { frame = JSON.parse(Buffer.from(body).toString('utf8')); } catch (_) {
        throw new Error('runtimeRelayProtocol: malformed JSON frame');
    }
    return restoreFrameData(normalizeFrame(frame));
}

export class RelayFrameDecoder extends EventEmitter {
    constructor({ maxFrameBytes = DEFAULT_MAX_RELAY_FRAME_BYTES } = {}) {
        super();
        this.maxFrameBytes = maxFrameBytes;
        this.buffer = Buffer.alloc(0);
        this.failed = false;
    }

    push(chunk) {
        if (this.failed) return [];
        const bytes = Buffer.from(chunk || Buffer.alloc(0));
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, bytes]) : bytes;
        const frames = [];
        try {
            while (this.buffer.length >= 4) {
                const length = this.buffer.readUInt32BE(0);
                if (!length || length > this.maxFrameBytes) throw new Error(`runtimeRelayProtocol: invalid frame length ${length}`);
                if (this.buffer.length < 4 + length) break;
                const body = this.buffer.subarray(4, 4 + length);
                this.buffer = this.buffer.subarray(4 + length);
                const frame = decodeRelayFrameBody(body);
                frames.push(frame);
                this.emit('frame', frame);
            }
        } catch (error) {
            this.failed = true;
            if (this.listenerCount('error')) this.emit('error', error);
            throw error;
        }
        return frames;
    }

    end() {
        if (!this.buffer.length) return;
        const error = new Error('runtimeRelayProtocol: truncated frame');
        this.failed = true;
        if (this.listenerCount('error')) this.emit('error', error);
        throw error;
    }
}

export function createRelayFrameDecoder(options) {
    return new RelayFrameDecoder(options);
}

export const encodeFrame = encodeRelayFrame;
export const FrameDecoder = RelayFrameDecoder;

export default {
    RUNTIME_RELAY_PROTOCOL_VERSION,
    DEFAULT_MAX_RELAY_FRAME_BYTES,
    RELAY_FRAME_TYPES,
    encodeRelayFrame,
    decodeRelayFrameBody,
    RelayFrameDecoder,
    createRelayFrameDecoder,
};
