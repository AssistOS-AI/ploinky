// Native WebSocket implementation using only Node.js built-in modules
// Implements both server (accepting connections) and client (making connections)

import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { EventEmitter } from 'events';

// WebSocket opcodes
const OPCODES = {
    CONTINUATION: 0x0,
    TEXT: 0x1,
    BINARY: 0x2,
    CLOSE: 0x8,
    PING: 0x9,
    PONG: 0xA
};

// WebSocket close codes
const CLOSE_CODES = {
    NORMAL: 1000,
    GOING_AWAY: 1001,
    PROTOCOL_ERROR: 1002,
    UNSUPPORTED_DATA: 1003,
    INVALID_FRAME_PAYLOAD_DATA: 1007,
    POLICY_VIOLATION: 1008,
    MESSAGE_TOO_BIG: 1009,
    INTERNAL_ERROR: 1011
};

/**
 * Parse a WebSocket frame
 */
function parseFrame(buffer) {
    if (buffer.length < 2) {
        return null;
    }

    const firstByte = buffer[0];
    const secondByte = buffer[1];

    const fin = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0F;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7F;
    let offset = 2;

    if (payloadLength === 126) {
        if (buffer.length < 4) return null;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
    } else if (payloadLength === 127) {
        if (buffer.length < 10) return null;
        const high = buffer.readUInt32BE(2);
        const low = buffer.readUInt32BE(6);
        payloadLength = high * 0x100000000 + low;
        offset = 10;
    }

    if (buffer.length < offset + (masked ? 4 : 0) + payloadLength) {
        return null;
    }

    let payload = Buffer.allocUnsafe(payloadLength);

    if (masked) {
        const maskKey = buffer.slice(offset, offset + 4);
        offset += 4;

        for (let i = 0; i < payloadLength; i++) {
            payload[i] = buffer[offset + i] ^ maskKey[i % 4];
        }
    } else {
        buffer.copy(payload, 0, offset, offset + payloadLength);
    }

    return {
        fin,
        opcode,
        payload,
        length: offset + payloadLength
    };
}

/**
 * Create a WebSocket frame
 */
function createFrame(opcode, payload, masked = false) {
    const payloadLength = payload.length;
    let frameLength = 2 + payloadLength;
    let payloadOffset = 2;

    if (payloadLength > 65535) {
        frameLength += 8;
        payloadOffset += 8;
    } else if (payloadLength > 125) {
        frameLength += 2;
        payloadOffset += 2;
    }

    if (masked) {
        frameLength += 4;
        payloadOffset += 4;
    }

    const frame = Buffer.allocUnsafe(frameLength);

    // First byte: FIN + opcode
    frame[0] = 0x80 | opcode;

    // Second byte: MASK + payload length
    if (payloadLength <= 125) {
        frame[1] = (masked ? 0x80 : 0x00) | payloadLength;
    } else if (payloadLength <= 65535) {
        frame[1] = (masked ? 0x80 : 0x00) | 126;
        frame.writeUInt16BE(payloadLength, 2);
    } else {
        frame[1] = (masked ? 0x80 : 0x00) | 127;
        frame.writeUInt32BE(0, 2);
        frame.writeUInt32BE(payloadLength, 6);
    }

    if (masked) {
        const maskKey = crypto.randomBytes(4);
        maskKey.copy(frame, payloadOffset - 4);

        for (let i = 0; i < payloadLength; i++) {
            frame[payloadOffset + i] = payload[i] ^ maskKey[i % 4];
        }
    } else {
        payload.copy(frame, payloadOffset);
    }

    return frame;
}

/**
 * WebSocket connection class (for both client and server connections)
 */
class WebSocket extends EventEmitter {
    constructor(socket, isServer = false) {
        super();
        this.socket = socket;
        this.isServer = isServer;
        this.buffer = Buffer.alloc(0);
        this.readyState = 1; // OPEN
        this.fragments = [];

        this.socket.on('data', (data) => this._handleData(data));
        this.socket.on('close', () => {
            this.readyState = 3; // CLOSED
            this.emit('close');
        });
        this.socket.on('error', (error) => {
            this.emit('error', error);
        });
    }

    _handleData(data) {
        this.buffer = Buffer.concat([this.buffer, data]);

        while (this.buffer.length > 0) {
            const frame = parseFrame(this.buffer);
            if (!frame) break;

            this.buffer = this.buffer.slice(frame.length);

            switch (frame.opcode) {
                case OPCODES.TEXT:
                case OPCODES.BINARY:
                    if (frame.fin) {
                        if (this.fragments.length > 0) {
                            this.fragments.push(frame.payload);
                            const message = Buffer.concat(this.fragments);
                            this.fragments = [];
                            this.emit('message', message);
                        } else {
                            this.emit('message', frame.payload);
                        }
                    } else {
                        this.fragments.push(frame.payload);
                    }
                    break;

                case OPCODES.CONTINUATION:
                    this.fragments.push(frame.payload);
                    if (frame.fin) {
                        const message = Buffer.concat(this.fragments);
                        this.fragments = [];
                        this.emit('message', message);
                    }
                    break;

                case OPCODES.CLOSE:
                    this.close();
                    break;

                case OPCODES.PING:
                    this._sendFrame(OPCODES.PONG, frame.payload);
                    break;

                case OPCODES.PONG:
                    this.emit('pong', frame.payload);
                    break;
            }
        }
    }

    _sendFrame(opcode, data) {
        if (this.readyState !== 1) return;

        const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const frame = createFrame(opcode, payload, !this.isServer);

        try {
            this.socket.write(frame);
        } catch (error) {
            this.emit('error', error);
        }
    }

    send(data) {
        const opcode = Buffer.isBuffer(data) ? OPCODES.BINARY : OPCODES.TEXT;
        this._sendFrame(opcode, data);
    }

    ping(data = '') {
        this._sendFrame(OPCODES.PING, data);
    }

    close(code = CLOSE_CODES.NORMAL, reason = '') {
        if (this.readyState === 3) return;

        const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
        payload.writeUInt16BE(code, 0);
        if (reason) {
            payload.write(reason, 2);
        }

        this._sendFrame(OPCODES.CLOSE, payload);
        this.readyState = 3;

        setTimeout(() => {
            this.socket.destroy();
        }, 1000);
    }

    get OPEN() { return 1; }
    get CLOSED() { return 3; }
}

/**
 * Perform WebSocket handshake (server side)
 */
function acceptWebSocketUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
        socket.write('HTTP/1.1 400 Bad Request\r\nCloudflare-CDN-Cache-Control: no-store\r\n\r\n');
        socket.destroy();
        return null;
    }

    const MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const hash = crypto.createHash('sha1')
        .update(key + MAGIC_STRING)
        .digest('base64');

    const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${hash}`,
        '\r\n'
    ].join('\r\n');

    socket.write(headers);

    return new WebSocket(socket, true);
}

/**
 * Connect to a WebSocket server (client side)
 */
function connectWebSocket(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isSecure = urlObj.protocol === 'wss:';
        const port = urlObj.port || (isSecure ? 443 : 80);
        const path = urlObj.pathname + urlObj.search;

        const key = crypto.randomBytes(16).toString('base64');

        const headers = {
            'Host': urlObj.hostname,
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Key': key,
            'Sec-WebSocket-Version': '13',
            ...options.headers
        };

        const requestOptions = {
            hostname: urlObj.hostname,
            port: port,
            path: path,
            method: 'GET',
            headers: headers
        };

        const httpModule = isSecure ? https : http;

        const req = httpModule.request(requestOptions);

        req.on('upgrade', (res, socket, head) => {
            const acceptKey = res.headers['sec-websocket-accept'];
            const MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
            const expectedKey = crypto.createHash('sha1')
                .update(key + MAGIC_STRING)
                .digest('base64');

            if (acceptKey !== expectedKey) {
                socket.destroy();
                reject(new Error('Invalid Sec-WebSocket-Accept header'));
                return;
            }

            const ws = new WebSocket(socket, false);
            resolve(ws);
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.end();
    });
}

export {
    WebSocket,
    acceptWebSocketUpgrade,
    connectWebSocket,
    OPCODES,
    CLOSE_CODES
};

