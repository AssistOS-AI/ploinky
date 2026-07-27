import http from 'node:http';
import { Duplex, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { sha256RawBodyHash } from '../../../Agent/lib/requestHash.mjs';
import { finalizePlanAfterAdmission } from './RoutePlan.js';
import { measureHeaderBytes, sanitizeRequestHeaders } from './sanitizeRequestHeaders.js';
import { sanitizeResponseHeaders } from './sanitizeResponseHeaders.js';
import { recordProxyOutcome } from './recordProxyOutcome.js';

const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

class ByteLimitTransform extends Transform {
    constructor(limit, message, code = 'STREAM_TOO_LARGE') {
        super();
        this.limit = limit;
        this.message = message;
        this.code = code;
        this.bytes = 0;
    }

    _transform(chunk, _encoding, callback) {
        this.bytes += chunk.length;
        if (this.bytes > this.limit) {
            const error = new Error(this.message);
            error.code = this.code;
            callback(error);
            return;
        }
        callback(null, chunk);
    }
}

export class RelayDuplex extends Duplex {
    constructor(relayStream) {
        super();
        this.relayStream = relayStream;
        this.remoteAddress = '127.0.0.1';
        this.remotePort = 0;
        relayStream.on('data', chunk => this.push(chunk));
        relayStream.on('end', () => this.push(null));
        relayStream.on('error', error => this.destroy(error));
        queueMicrotask(() => this.emit('connect'));
    }

    _read() {}

    _write(chunk, _encoding, callback) {
        try {
            const accepted = this.relayStream.write(chunk);
            if (accepted === false) this.relayStream.channel.child.stdin.once('drain', callback);
            else callback();
        } catch (error) {
            callback(error);
        }
    }

    _final(callback) {
        try { this.relayStream.end(); callback(); } catch (error) { callback(error); }
    }

    _destroy(error, callback) {
        if (this._timeout) {
            clearTimeout(this._timeout);
            this._timeout = null;
        }
        try { this.relayStream.cancel(); } catch (_) {}
        callback(error);
    }

    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    setTimeout(milliseconds, callback) {
        if (callback) this.once('timeout', callback);
        if (this._timeout) clearTimeout(this._timeout);
        if (milliseconds > 0) {
            this._timeout = setTimeout(() => this.emit('timeout'), milliseconds);
            this._timeout.unref?.();
        }
        return this;
    }
}

export function createRelayHttpAgent(connection) {
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => connection;
    return agent;
}

function cookieValue(cookieHeader, name) {
    for (const part of String(cookieHeader || '').split(';')) {
        const index = part.indexOf('=');
        if (index >= 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
    }
    return '';
}

export function assertMutationAllowed(req, plan) {
    const method = String(req.method || plan.method || 'GET').toUpperCase();
    if (READ_ONLY.has(method)) return true;
    const hasRouterCookie = /(?:^|;\s*)ploinky_(?:sso|jwt|guest)=/.test(String(req.headers?.cookie || ''));
    if (!hasRouterCookie) return true;
    if (String(req.headers?.origin || '') !== String(plan.origin)) {
        const error = new Error('proxy: mutation origin rejected');
        error.code = 'ORIGIN_REJECTED';
        throw error;
    }
    const cookieToken = cookieValue(req.headers?.cookie, 'ploinky_csrf');
    const headerToken = String(req.headers?.['x-csrf-token'] || '');
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        const error = new Error('proxy: CSRF token rejected');
        error.code = 'CSRF_REJECTED';
        throw error;
    }
    return true;
}

export function assertSupportedHttp1Request(req, plan) {
    const method = String(req?.method || plan?.method || '').toUpperCase();
    if (!/^[A-Z]+$/.test(method) || method === 'CONNECT' || method === 'TRACE') {
        throw Object.assign(new Error('proxy: unsupported HTTP method'), { code: 'METHOD_REJECTED' });
    }
    if (req?.headers?.upgrade) {
        throw Object.assign(new Error('proxy: unsupported HTTP upgrade'), { code: 'PROTOCOL_REJECTED' });
    }
    if (req?.headers?.['content-length'] !== undefined && req?.headers?.['transfer-encoding'] !== undefined) {
        throw Object.assign(new Error('proxy: ambiguous HTTP message framing'), { code: 'PROTOCOL_REJECTED' });
    }
    return true;
}

function readBoundedBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) {
                const error = new Error('proxy: buffered request body limit exceeded');
                error.code = 'REQUEST_TOO_LARGE';
                reject(error);
                req.pause();
                return;
            }
            chunks.push(Buffer.from(chunk));
        });
        req.once('end', () => resolve(Buffer.concat(chunks)));
        req.once('aborted', () => reject(new Error('proxy: client aborted')));
        req.once('error', reject);
    });
}

export function proxyErrorStatus(error) {
    if (error?.code === 'PROTOCOL_REJECTED') return 400;
    if (error?.code === 'METHOD_REJECTED') return 405;
    if (error?.code === 'REQUEST_TOO_LARGE') return 413;
    if (['AUTH_REQUIRED', 'ORIGIN_REJECTED', 'CSRF_REJECTED'].includes(error?.code)) return 403;
    if (['RELAY_BUSY', 'ROUTING_UNAVAILABLE'].includes(error?.code)
        || /lease|concurrenc|routing unavailable/i.test(String(error?.message || ''))) return 503;
    if (error?.code === 'TARGET_TIMEOUT'
        || /timeout|lifetime exceeded/i.test(String(error?.message || ''))) return 504;
    return 502;
}

function sendError(res, error) {
    if (res.headersSent) {
        try { res.destroy(error); } catch (_) {}
        return;
    }
    const status = proxyErrorStatus(error);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    const responseError = status === 403 ? 'request_rejected'
        : status === 413 ? 'request_too_large'
            : status === 504 ? 'upstream_timeout' : 'upstream_unavailable';
    res.end(JSON.stringify({ error: responseError }));
}

export async function executeHttpPlan({
    req,
    res,
    plan,
    lease,
    relayManager,
    authorized = false,
    trustedHeaders = {},
    trustedHeadersFactory,
    prebufferedBody,
    auditSink,
} = {}) {
    const startedAt = Date.now();
    let channel;
    let relayAgent;
    let leaseOutcome = 'uncommitted';
    let requestBytes = 0;
    let responseBytes = 0;
    let responseStatus = 0;
    try {
        if (authorized !== true) throw Object.assign(new Error('proxy: request not authorized'), { code: 'AUTH_REQUIRED' });
        assertSupportedHttp1Request(req, plan);
        const finalized = finalizePlanAfterAdmission(plan);
        const hasBody = !['GET', 'HEAD'].includes(finalized.method);
        const streaming = hasBody && finalized.allowRequestStreaming === true;
        const body = streaming
            ? null
            : prebufferedBody !== undefined
                ? Buffer.from(prebufferedBody)
                : await readBoundedBody(req, finalized.limits.bufferedBodyBytes);
        if (body && body.length > finalized.limits.bufferedBodyBytes) {
            throw Object.assign(new Error('proxy: buffered request body limit exceeded'), { code: 'REQUEST_TOO_LARGE' });
        }
        requestBytes = body?.length || 0;
        const bodyMode = streaming ? 'stream' : body?.length ? 'buffered' : 'none';
        const bodyHash = streaming ? '' : sha256RawBodyHash(body || Buffer.alloc(0));
        const resolvedTrustedHeaders = typeof trustedHeadersFactory === 'function'
            ? await trustedHeadersFactory({ body, bodyMode, bodyHash, plan: finalized })
            : trustedHeaders;
        const headers = sanitizeRequestHeaders(req.headers, finalized, resolvedTrustedHeaders || {});
        if (!streaming) headers['content-length'] = String(body?.length || 0);
        if (measureHeaderBytes(headers) > finalized.limits.requestHeaderBytes) {
            throw Object.assign(new Error('proxy: request header limit exceeded'), { code: 'REQUEST_TOO_LARGE' });
        }
        channel = await relayManager.checkout({ plan: finalized, lease, authorized: true });
        leaseOutcome = 'committed';
        const relayStream = await channel.openRequest({ plan: finalized, bodyMode, bodyHash, headers });
        const connection = new RelayDuplex(relayStream);
        relayAgent = createRelayHttpAgent(connection);
        await new Promise((resolve, reject) => {
            let settled = false;
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
                try { upstream.destroy(error); } catch (_) {}
                reject(error);
            };
            const resetIdleTimer = () => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => fail(new Error('proxy: upstream idle timeout')), finalized.limits.idleTimeoutMs);
                idleTimer.unref?.();
            };
            const upstream = http.request({
                method: finalized.method,
                path: `${finalized.targetPath}${finalized.query ? `?${finalized.query}` : ''}`,
                headers,
                maxHeaderSize: finalized.limits.responseHeaderBytes,
                agent: relayAgent,
            }, upstreamRes => {
                clearTimeout(headerTimer);
                res.writeHead(upstreamRes.statusCode || 502, sanitizeResponseHeaders(upstreamRes.headers, finalized));
                responseStatus = upstreamRes.statusCode || 502;
                const contentType = String(upstreamRes.headers['content-type'] || '').toLowerCase();
                const longLived = finalized.transport === 'sse' || contentType.startsWith('text/event-stream');
                if (longLived) {
                    res.flushHeaders?.();
                    lifetimeTimer = setTimeout(
                        () => fail(new Error('proxy: streaming response lifetime exceeded')),
                        finalized.limits.longLivedTimeoutMs,
                    );
                    lifetimeTimer.unref?.();
                }
                const responseLimiter = new ByteLimitTransform(
                    finalized.limits.streamedBodyBytes,
                    'proxy: streamed response body limit exceeded',
                    'RESPONSE_TOO_LARGE',
                );
                responseLimiter.on('data', resetIdleTimer);
                responseLimiter.on('data', chunk => { responseBytes += chunk.length; });
                resetIdleTimer();
                pipeline(upstreamRes, responseLimiter, res).then(finish, fail);
            });
            headerTimer = setTimeout(
                () => fail(new Error('proxy: upstream response header timeout')),
                finalized.limits.headerTimeoutMs,
            );
            headerTimer.unref?.();
            upstream.once('error', fail);
            req.once('aborted', () => fail(new Error('proxy: client aborted')));
            res.once('close', () => {
                if (!res.writableEnded) fail(new Error('proxy: downstream cancelled'));
            });
            if (streaming) {
                const requestLimiter = new ByteLimitTransform(
                    finalized.limits.streamedBodyBytes,
                    'proxy: streamed request body limit exceeded',
                    'REQUEST_TOO_LARGE',
                );
                requestLimiter.once('error', fail);
                requestLimiter.on('data', chunk => { requestBytes += chunk.length; });
                req.pipe(requestLimiter).pipe(upstream);
            } else {
                upstream.end(body || Buffer.alloc(0));
            }
        });
        relayAgent.destroy();
        relayAgent = null;
        recordProxyOutcome({
            plan: finalized,
            outcome: 'success',
            startedAt,
            status: responseStatus,
            requestBytes,
            responseBytes,
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
            requestBytes,
            responseBytes,
            leaseOutcome,
            relayOutcome: channel ? 'ready' : 'failure',
            upstreamOutcome: 'failure',
            sink: auditSink,
        });
        channel?.close();
        lease?.release?.();
        sendError(res, error);
        return false;
    }
}

export default executeHttpPlan;
