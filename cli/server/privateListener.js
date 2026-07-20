import http from 'node:http';
import crypto from 'node:crypto';

import { sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import { AGENT_PORT_CONVENTION_ROUTE_KEY } from '../utils/runtime/reservedRouteKeys.js';
import { executeHttpPlan } from './proxy/executeHttpPlan.js';
import { recordProxyOutcome } from './proxy/recordProxyOutcome.js';
import { classifyRequestAuthority } from './generation/authority.js';

export const PRIVATE_LISTENER_HOST = '127.0.0.1';
export const PRIVATE_LISTENER_PORT = 8081;

function sendPrivateError(res, statusCode, error) {
    res.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error }));
}

function readBody(req, maximumBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maximumBytes) {
                reject(Object.assign(new Error('private request too large'), { status: 413 }));
                req.pause();
                return;
            }
            chunks.push(Buffer.from(chunk));
        });
        req.once('end', () => resolve(Buffer.concat(chunks)));
        req.once('aborted', () => reject(new Error('private request aborted')));
        req.once('error', reject);
    });
}

function primarySelector(pathname, routes) {
    const parts = String(pathname || '').split('/').filter(Boolean);
    if (!parts.length) return null;
    let routeKey;
    try { routeKey = decodeURIComponent(parts[0]); } catch (_) { return null; }
    if (!routes?.[routeKey]) return null;
    return {
        routeKey,
        targetPath: `/${parts.slice(1).join('/')}` || '/',
    };
}

export function createPrivateRouteHandler({ runtime, assertionService, auditSink } = {}) {
    if (!runtime || !assertionService) throw new Error('privateListener: runtime and assertion service required');
    return async (req, res) => {
        if (!runtime.store.active) return sendPrivateError(res, 503, 'routing_unavailable');
        let classification;
        try {
            classification = classifyRequestAuthority(req, {
                expectedAuthority: runtime.privateAuthority,
                scheme: 'http',
            });
        } catch (error) {
            return sendPrivateError(res, error?.status || 400, 'private_request_rejected');
        }
        req.url = classification.requestTarget;
        req.headers.host = classification.authority;
        const parsedUrl = new URL(req.url, `http://${classification.authority}`);
        let lease;
        let plan;
        let targetRouteKey = '';
        try {
            lease = runtime.acquire({ listenerClass: 'private', authority: runtime.privateAuthority });
            if (parsedUrl.pathname === `/${AGENT_PORT_CONVENTION_ROUTE_KEY}`
                || parsedUrl.pathname.startsWith(`/${AGENT_PORT_CONVENTION_ROUTE_KEY}/`)) {
                plan = runtime.resolveConvention({
                    lease,
                    requestTarget: req.url || '/',
                    method: req.method || 'GET',
                    authority: runtime.privateAuthority,
                    listenerClass: 'private',
                    scheme: 'http',
                });
                targetRouteKey = plan.routeKey;
            } else {
                const selector = primarySelector(parsedUrl.pathname, lease.generation.routes);
                if (!selector) throw Object.assign(new Error('private target not found'), { status: 404 });
                targetRouteKey = selector.routeKey;
                plan = runtime.resolvePrimary({
                    lease,
                    routeKey: selector.routeKey,
                    method: req.method || 'GET',
                    externalPath: parsedUrl.pathname,
                    targetPath: selector.targetPath,
                    query: parsedUrl.search.slice(1),
                    authority: runtime.privateAuthority,
                    listenerClass: 'private',
                    scheme: 'http',
                });
            }
            if (!plan) throw Object.assign(new Error('private target unavailable'), { status: 503 });
            if (plan.access?.access !== 'authenticated') {
                throw Object.assign(new Error('private policy denied'), { status: 403 });
            }
            const body = await readBody(req, plan.limits.bufferedBodyBytes);
            const assertion = String(req.headers['x-ploinky-machine-assertion'] || '');
            assertionService.verify(assertion, {
                targetRouteKey,
                port: plan.port,
                method: req.method || 'GET',
                path: parsedUrl.pathname,
                bodyHash: sha256RawBodyHash(body),
            });
            return executeHttpPlan({
                req,
                res,
                plan,
                lease,
                relayManager: runtime.relayManager,
                authorized: true,
                prebufferedBody: body,
                auditSink,
            });
        } catch (error) {
            lease?.release();
            if (plan) {
                recordProxyOutcome({
                    plan,
                    outcome: 'denied',
                    error,
                    status: error?.status || 401,
                    leaseOutcome: 'released',
                    relayOutcome: 'not_started',
                    upstreamOutcome: 'not_started',
                    sink: auditSink,
                });
            }
            sendPrivateError(res, error?.status || (error?.message?.includes('policy') ? 403 : 401), 'private_request_rejected');
            return false;
        }
    };
}

export async function createPrivateListener({
    handler,
    proveBinding,
    port = PRIVATE_LISTENER_PORT,
} = {}) {
    if (typeof handler !== 'function') throw new Error('privateListener: handler required');
    const proofNonce = crypto.randomBytes(18).toString('base64url');
    const proofPath = `/.well-known/ploinky-private-proof/${proofNonce}`;
    const server = http.createServer((req, res) => {
        if (req.url === proofPath && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            res.end(proofNonce);
            return;
        }
        handler(req, res, { listenerClass: 'private' });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, PRIVATE_LISTENER_HOST, () => {
            server.off('error', reject);
            resolve();
        });
    });
    try {
        if (proveBinding && await proveBinding({ port, proofPath, expectedBody: proofNonce }) !== true) {
            throw new Error('privateListener: container loopback proof failed');
        }
    } catch (error) {
        await new Promise(resolve => server.close(resolve));
        throw error;
    }
    return server;
}

export default createPrivateListener;
