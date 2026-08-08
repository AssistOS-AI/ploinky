import http from 'node:http';
import { Transform } from 'node:stream';

import { finalizePlanAfterAdmission } from './RoutePlan.js';
import { measureHeaderBytes, sanitizeRequestHeaders } from './sanitizeRequestHeaders.js';
import { sanitizeResponseHeaders } from './sanitizeResponseHeaders.js';
import { recordProxyOutcome } from './recordProxyOutcome.js';
import { createRelayHttpAgent, proxyErrorStatus, RelayDuplex } from './executeHttpPlan.js';

export class WebSocketFrameLimitTransform extends Transform {
    constructor({ frameBytes, messageBytes } = {}) {
        super();
        this.frameBytes = frameBytes;
        this.messageBytes = messageBytes;
        this.buffer = Buffer.alloc(0);
        this.fragmented = false;
        this.messageSize = 0;
        this.bytes = 0;
    }

    _validateMessage(opcode, fin, payloadLength) {
        const control = opcode >= 0x8;
        if (control) {
            if (!fin || payloadLength > 125 || ![0x8, 0x9, 0xa].includes(opcode)) {
                throw new Error('proxy: invalid WebSocket control frame');
            }
            return;
        }
        if (opcode === 0x0) {
            if (!this.fragmented) throw new Error('proxy: unexpected WebSocket continuation frame');
            this.messageSize += payloadLength;
            if (this.messageSize > this.messageBytes) throw new Error('proxy: WebSocket message limit exceeded');
            if (fin) {
                this.fragmented = false;
                this.messageSize = 0;
            }
            return;
        }
        if (![0x1, 0x2].includes(opcode) || this.fragmented) {
            throw new Error('proxy: invalid WebSocket data frame sequence');
        }
        if (payloadLength > this.messageBytes) throw new Error('proxy: WebSocket message limit exceeded');
        if (!fin) {
            this.fragmented = true;
            this.messageSize = payloadLength;
        }
    }

    _transform(chunk, _encoding, callback) {
        try {
            this.bytes += chunk.length;
            this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
            while (this.buffer.length >= 2) {
                if (this.buffer[0] & 0x70) throw new Error('proxy: unsupported WebSocket extension frame');
                const fin = Boolean(this.buffer[0] & 0x80);
                const opcode = this.buffer[0] & 0x0f;
                const masked = Boolean(this.buffer[1] & 0x80);
                let payloadLength = this.buffer[1] & 0x7f;
                let offset = 2;
                if (payloadLength === 126) {
                    if (this.buffer.length < 4) break;
                    payloadLength = this.buffer.readUInt16BE(2);
                    offset = 4;
                } else if (payloadLength === 127) {
                    if (this.buffer.length < 10) break;
                    const wideLength = this.buffer.readBigUInt64BE(2);
                    if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('proxy: invalid WebSocket frame length');
                    payloadLength = Number(wideLength);
                    offset = 10;
                }
                if (payloadLength > this.frameBytes) throw new Error('proxy: WebSocket frame limit exceeded');
                const frameLength = offset + (masked ? 4 : 0) + payloadLength;
                if (this.buffer.length < frameLength) break;
                this._validateMessage(opcode, fin, payloadLength);
                this.push(this.buffer.subarray(0, frameLength));
                this.buffer = this.buffer.subarray(frameLength);
            }
            callback();
        } catch (error) {
            callback(error);
        }
    }

    _flush(callback) {
        callback(this.buffer.length ? new Error('proxy: truncated WebSocket frame') : undefined);
    }
}

function rejectSocket(socket, status = 403) {
    const reason = http.STATUS_CODES[status] || 'Request Failed';
    try { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`); } catch (_) {}
}

function assertWebSocketOrigin(req, plan) {
    const origin = String(req.headers?.origin || '');
    const allowed = plan.originPolicy?.allowedOrigins || [plan.origin];
    if ((!origin && plan.originPolicy?.allowMissingOrigin !== true) || (origin && !allowed.includes(origin))) {
        const error = new Error('proxy: WebSocket Origin rejected');
        error.code = 'ORIGIN_REJECTED';
        throw error;
    }
}

export function assertWebSocketHandshake(req) {
    const method = String(req?.method || 'GET').toUpperCase();
    const upgrade = String(req?.headers?.upgrade || '').toLowerCase();
    const connection = String(req?.headers?.connection || '').toLowerCase().split(',').map(value => value.trim());
    const version = String(req?.headers?.['sec-websocket-version'] || '');
    const key = String(req?.headers?.['sec-websocket-key'] || '');
    let keyBytes = Buffer.alloc(0);
    try { keyBytes = Buffer.from(key, 'base64'); } catch (_) {}
    if (method !== 'GET' || upgrade !== 'websocket' || !connection.includes('upgrade')
        || version !== '13' || keyBytes.length !== 16) {
        throw Object.assign(new Error('proxy: invalid WebSocket handshake'), { code: 'PROTOCOL_REJECTED' });
    }
    return true;
}

export async function executeWebSocketPlan({
    req,
    socket,
    head = Buffer.alloc(0),
    plan,
    lease,
    relayManager,
    authorized = false,
    trustedHeaders = {},
    auditSink,
} = {}) {
    const startedAt = Date.now();
    let channel;
    let relayAgent;
    let clientFrames;
    let targetFrames;
    let leaseOutcome = 'uncommitted';
    try {
        if (authorized !== true) {
            throw Object.assign(new Error('proxy: request not authorized'), { code: 'AUTH_REQUIRED' });
        }
        assertWebSocketHandshake(req);
        assertWebSocketOrigin(req, plan);
        const finalized = finalizePlanAfterAdmission(plan);
        const headers = sanitizeRequestHeaders(req.headers, finalized, trustedHeaders);
        delete headers['sec-websocket-extensions'];
        headers.connection = 'Upgrade';
        headers.upgrade = 'websocket';
        if (measureHeaderBytes(headers) > finalized.limits.requestHeaderBytes) {
            throw Object.assign(new Error('proxy: request header limit exceeded'), { code: 'REQUEST_TOO_LARGE' });
        }
        channel = await relayManager.checkout({ plan: finalized, lease, authorized: true });
        leaseOutcome = 'committed';
        const relayStream = await channel.openRequest({
            plan: { ...finalized, transport: 'websocket' },
            bodyMode: 'stream',
            bodyHash: '',
            headers,
        });
        const connection = new RelayDuplex(relayStream);
        relayAgent = createRelayHttpAgent(connection);
        await new Promise((resolve, reject) => {
            let settled = false;
            let upstreamSocket;
            let headerTimer;
            let idleTimer;
            let lifetimeTimer;
            const clearTimers = () => {
                clearTimeout(headerTimer);
                clearTimeout(idleTimer);
                clearTimeout(lifetimeTimer);
            };
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimers();
                resolve();
            };
            const fail = error => {
                if (settled) return;
                settled = true;
                clearTimers();
                // The rejection below retains the causal error for audit and
                // response classification. Passing it to destroy() would emit
                // a second asynchronous 'error' after the request's one-shot
                // listener had already handled the first failure. On upgraded
                // sockets that duplicate can escape as an uncaught exception.
                try { socket.destroy(); } catch (_) {}
                try { upstreamSocket?.destroy(); } catch (_) {}
                try { upstream.destroy(); } catch (_) {}
                reject(error);
            };
            const resetIdleTimer = () => {
                if (settled) return;
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => fail(new Error('proxy: WebSocket idle timeout')), finalized.limits.idleTimeoutMs);
                idleTimer.unref?.();
            };
            const upstream = http.request({
                method: 'GET',
                path: `${finalized.targetPath}${finalized.query ? `?${finalized.query}` : ''}`,
                headers,
                maxHeaderSize: finalized.limits.responseHeaderBytes,
                agent: relayAgent,
            });
            headerTimer = setTimeout(
                () => fail(new Error('proxy: WebSocket handshake timeout')),
                finalized.limits.webSocketHandshakeTimeoutMs,
            );
            headerTimer.unref?.();
            upstream.once('upgrade', (response, selectedUpstreamSocket, upstreamHead) => {
                clearTimeout(headerTimer);
                upstreamSocket = selectedUpstreamSocket;
                const responseHeaders = {
                    ...sanitizeResponseHeaders(response.headers, finalized),
                    connection: 'Upgrade',
                    upgrade: 'websocket',
                };
                delete responseHeaders['sec-websocket-extensions'];
                const lines = [`HTTP/1.1 ${response.statusCode || 101} ${response.statusMessage || 'Switching Protocols'}`];
                for (const [name, value] of Object.entries(responseHeaders)) {
                    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
                }
                socket.write(`${lines.join('\r\n')}\r\n\r\n`);
                clientFrames = new WebSocketFrameLimitTransform({
                    frameBytes: finalized.limits.webSocketFrameBytes,
                    messageBytes: finalized.limits.webSocketMessageBytes,
                });
                targetFrames = new WebSocketFrameLimitTransform({
                    frameBytes: finalized.limits.webSocketFrameBytes,
                    messageBytes: finalized.limits.webSocketMessageBytes,
                });
                clientFrames.once('error', fail);
                targetFrames.once('error', fail);
                socket.on('data', resetIdleTimer);
                upstreamSocket.on('data', resetIdleTimer);
                socket.pipe(clientFrames).pipe(upstreamSocket);
                upstreamSocket.pipe(targetFrames).pipe(socket);
                if (upstreamHead?.length) targetFrames.write(upstreamHead);
                if (head?.length) clientFrames.write(head);
                resetIdleTimer();
                lifetimeTimer = setTimeout(
                    () => fail(new Error('proxy: WebSocket lifetime exceeded')),
                    finalized.limits.longLivedTimeoutMs,
                );
                lifetimeTimer.unref?.();
                socket.once('close', finish);
                upstreamSocket.once('close', finish);
            });
            upstream.once('response', response => {
                response.resume();
                fail(new Error(`proxy: target refused WebSocket (${response.statusCode})`));
            });
            upstream.once('error', fail);
            upstream.end();
        });
        relayAgent.destroy();
        relayAgent = null;
        recordProxyOutcome({
            plan: finalized,
            outcome: 'success',
            startedAt,
            status: 101,
            requestBytes: clientFrames?.bytes || 0,
            responseBytes: targetFrames?.bytes || 0,
            leaseOutcome,
            relayOutcome: 'ready',
            upstreamOutcome: 'success',
            sink: auditSink,
        });
        channel.close();
        lease.release?.();
        return true;
    } catch (error) {
        relayAgent?.destroy();
        recordProxyOutcome({
            plan,
            outcome: 'failure',
            startedAt,
            error,
            status: proxyErrorStatus(error),
            requestBytes: clientFrames?.bytes || 0,
            responseBytes: targetFrames?.bytes || 0,
            leaseOutcome,
            relayOutcome: channel ? 'ready' : 'failure',
            upstreamOutcome: 'failure',
            sink: auditSink,
        });
        channel?.close();
        lease?.release?.();
        rejectSocket(socket, proxyErrorStatus(error));
        return false;
    }
}

export default executeWebSocketPlan;
