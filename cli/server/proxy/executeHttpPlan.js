import http from 'node:http';
import net from 'node:net';
import { Duplex, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { computeRchHttp, sha256RawBodyHash } from '../../../Agent/lib/requestHash.mjs';
import { OPENAI_MODELS_TOOL, OPENAI_CHAT_COMPLETIONS_TOOL } from '../../../Agent/lib/invocationAuth.mjs';
import { finalizePlanAfterAdmission } from './RoutePlan.js';
import { measureHeaderBytes, sanitizeRequestHeaders } from './sanitizeRequestHeaders.js';
import { sanitizeResponseHeaders } from './sanitizeResponseHeaders.js';
import { recordProxyOutcome } from './recordProxyOutcome.js';
import { commitRoutePlan, leaseForSelectedPlan, selectAgentPortPlan } from '../edgeRoutePlan.js';
import { observeProxyFirstByte, observeProxyOutcome } from '../canary/proxyOutcomes.js';
import { assertSelectionCurrent, selectRouteRuntime, trackCanaryConnection } from '../canary/selection.mjs';
import { serveAgentStaticRequest } from '../static/index.js';
import { buildRouterRequest } from '../mcp-proxy/invocationMinter.js';
import { leaseRouteHardwareAvailability } from '../hardwareAvailability.mjs';

const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);
const ABANDONED_REQUEST_CLOSE_GRACE_MS = 1_000;

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
            // The relay stream slices large chunks and queues what the
            // channel cannot take yet; its own 'drain' means every slice of
            // this chunk has been handed to the channel.
            const accepted = this.relayStream.write(chunk);
            if (accepted === false) this.relayStream.once('drain', callback);
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
        try { this.relayStream.abandon(); } catch (_) {}
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
    const hasRouterCookie = /(?:^|;\s*)ploinky_(?:sso|jwt|guest[A-Za-z0-9_-]*)=/.test(String(req.headers?.cookie || ''));
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
    const chunks = [];
    let size = 0;
    let settled = false;
    let closeAfterResponse = false;
    let resolveBody;
    let rejectBody;
    const cleanup = () => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('aborted', onAborted);
        req.off('error', onError);
    };
    const resolve = value => {
        if (settled) return false;
        settled = true;
        cleanup();
        resolveBody(value);
        return true;
    };
    const reject = (error, { abandon = false } = {}) => {
        if (settled) return false;
        settled = true;
        closeAfterResponse = abandon && !req.complete && !req.destroyed;
        cleanup();
        chunks.length = 0;
        if (abandon) {
            try { req.pause(); } catch (_) {}
        }
        rejectBody(error);
        return true;
    };
    const cancel = error => reject(error, { abandon: true });
    const onData = chunk => {
        size += chunk.length;
        if (size > limit) {
            const error = new Error('proxy: buffered request body limit exceeded');
            error.code = 'REQUEST_TOO_LARGE';
            cancel(error);
            return;
        }
        chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => resolve(Buffer.concat(chunks));
    const onAborted = () => cancel(new Error('proxy: client aborted'));
    const onError = error => reject(error);
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolveBody = resolvePromise;
        rejectBody = rejectPromise;
        req.once('end', onEnd);
        req.once('aborted', onAborted);
        req.once('error', onError);
        req.on('data', onData);
    });
    return {
        promise,
        cancel,
        shouldCloseAfterResponse: () => closeAfterResponse,
    };
}

export function proxyErrorStatus(error) {
    if (error?.code === 'PROTOCOL_REJECTED') return 400;
    // A guest request refused before any relay is asked for: no usable transport source, or no route scope.
    if (error?.code === 'INVALID_RATE_SOURCE') return error.statusCode === 503 ? 503 : 400;
    if (error?.code === 'METHOD_REJECTED') return 405;
    if (error?.code === 'REQUEST_TOO_LARGE') return 413;
    if (['AUTH_REQUIRED', 'ORIGIN_REJECTED', 'CSRF_REJECTED'].includes(error?.code)) return 403;
    if (['EDGE_GENERATION_CHANGED', 'RELAY_BUSY', 'ROUTING_UNAVAILABLE', 'CANARY_SELECTION_CHANGED'].includes(error?.code)
        || error?.status === 503
        || /lease|concurrenc|routing unavailable/i.test(String(error?.message || ''))) return 503;
    if (error?.code === 'TARGET_TIMEOUT'
        || /timeout|lifetime exceeded/i.test(String(error?.message || ''))) return 504;
    return 502;
}

function sendError(res, error, { abandonedRequest } = {}) {
    let closeTimer;
    const closeRequest = () => {
        clearTimeout(closeTimer);
        closeTimer = null;
        if (!abandonedRequest || abandonedRequest.destroyed || abandonedRequest.complete) return;
        try { abandonedRequest.destroy(); } catch (_) {}
    };
    if (res.destroyed || res.writableEnded) {
        closeRequest();
        return;
    }
    if (res.headersSent) {
        try { res.destroy(error); } catch (_) {}
        closeRequest();
        return;
    }
    const status = proxyErrorStatus(error);
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    if (status === 503) headers['retry-after'] = '1';
    if (abandonedRequest && !abandonedRequest.complete && !abandonedRequest.destroyed) {
        headers.connection = 'close';
        res.shouldKeepAlive = false;
        closeTimer = setTimeout(closeRequest, ABANDONED_REQUEST_CLOSE_GRACE_MS);
        closeTimer.unref?.();
    }
    res.writeHead(status, headers);
    const responseError = status === 403 ? 'request_rejected'
        : status === 413 ? 'request_too_large'
            : status === 504 ? 'upstream_timeout' : 'upstream_unavailable';
    res.end(JSON.stringify({ error: responseError }), closeRequest);
}

// A retry is permitted only before OPEN. The caller retains its buffered
// bytes (or its still-unread streaming body) and original authorization.
export async function openSelectedRelay({ plan, req, lease, initial, open }) {
    let selected = initial;
    for (let attempt = 0; ; attempt++) {
        try {
            return await open(selected, leaseForSelectedPlan(lease, selected.selection));
        } catch (error) {
            if (attempt || error?.code !== 'CANARY_SELECTION_CHANGED') throw error;
            selected = finalizePlanAfterAdmission(selectAgentPortPlan(plan, req));
        }
    }
}

export async function withSelectedRoot({ plan, req, taskId }, dispatch) {
    for (let attempt = 0; ; attempt++) {
        const selection = selectRouteRuntime({
            routeKey: plan.routeKey, route: plan.route || plan.target,
            snapshot: plan.snapshot || plan.lease?.snapshot, req, taskId,
        });
        const port = Number(selection.route?.hostPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw Object.assign(new Error('target_inactive'), { status: 503 });
        }
        const check = () => {
            if (!commitRoutePlan(plan)) throw Object.assign(new Error('edge_generation_changed'), {
                code: 'EDGE_GENERATION_CHANGED', status: 503,
            });
            assertSelectionCurrent(selection);
            if (leaseRouteHardwareAvailability(plan.lease, plan.routeKey, selection.route.container)) {
                throw Object.assign(new Error('hardware_unavailable'), { status: 503 });
            }
            return true;
        };
        try {
            return await dispatch(selection, check);
        } catch (error) {
            if (attempt || error?.code !== 'CANARY_SELECTION_CHANGED') throw error;
        }
    }
}

// Make the lease and version checks adjacent to the physical TCP open.
// Returning the connected socket to Node's HTTP Agent avoids replaying a
// streaming caller body if the first selection changes before this point.
export function openRootConnection(selection, check) {
    const port = Number(selection.route.hostPort);
    check();
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => socket;
    return { agent, socket };
}

export async function dispatchAgentRootHttp({ req, res, plan, taskId, agentBody, headersForSelection = () => ({}) }) {
    // Relay readiness imports this module while policy storage initializes.
    // Load the policy-backed dispatchers only for an admitted root request.
    const { proxyHttpBuffered, proxyHttpPassthrough } = await import('../routerHandlers.js');
    try {
        return await withSelectedRoot({ plan, req: agentBody === undefined ? req : undefined, taskId }, async (selection, check) => {
            if (agentBody === undefined && !taskId && await serveAgentStaticRequest(req, res, {
                routeKey: plan.routeKey, hostPath: selection.route.hostPath,
                confinedExport: selection.copy === 'canary', beforeRead: check,
                beforeServe: plan.route?.canary ? check : undefined,
            })) return;
            const headers = headersForSelection(selection);
            const startedAt = Date.now();
            const { agent, socket } = openRootConnection(selection, check);
            try {
                const upstream = agentBody === undefined
                    ? proxyHttpPassthrough(req, res, selection.route.hostPort, plan.upstreamPath, headers, { agent })
                    : proxyHttpBuffered(req, res, selection.route.hostPort, plan.upstreamPath, agentBody, headers, {
                        agent, credentialPolicy: { preserveAuthorization: false, preserveCookie: false },
                    });
                let received = false;
                upstream.once('response', response => {
                    received = true;
                    observeProxyFirstByte({ plan: selection, ttfbMs: Date.now() - startedAt });
                    let complete = false;
                    const finish = (failed = false) => {
                        if (complete) return;
                        complete = true;
                        observeProxyOutcome({ plan: selection, outcome: failed ? 'failure' : 'success',
                            upstreamStatus: response.statusCode, serverError: failed });
                    };
                    response.once('end', () => finish());
                    response.once('aborted', () => finish(!req.aborted && !res.destroyed));
                    response.once('error', () => finish(!req.aborted && !res.destroyed));
                    if (String(response.headers['content-type']).toLowerCase().startsWith('text/event-stream')) {
                        const untrack = trackCanaryConnection(selection, () => { response.destroy(); res.destroy(); });
                        response.once('close', untrack);
                    }
                });
                upstream.once('error', error => {
                    if (!received && !req.aborted && !res.destroyed) {
                        observeProxyOutcome({ plan: selection, outcome: 'failure', error, serverError: true,
                            unreachable: ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code) });
                    }
                });
                return upstream;
            } catch (error) {
                socket.destroy();
                throw error;
            }
        });
    } catch (error) {
        if (!error.status) throw error;
        res.writeHead(error.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
            ...(error.status === 503 ? { 'Retry-After': '1' } : {}) });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// The first attempt consumes the source assertion in the existing process-wide
// replay cache. A pre-dial retry can reuse only the verified caller and body
// hash, and signs a fresh proof for the new selection.
export async function dispatchCanaryAgentOpenAi({ req, res, plan }) {
    const [{ readRequestBody, resolveHttpRouteInvocationMaxBodyBytes }, {
        isDelegatedAgentOpenAiCall, MAX_AGENTIC_DEPTH, readAgenticDepth, verifyAndMintAgentOpenAiCall,
    }] = await Promise.all([import('../routerHandlers.js'), import('../agentOpenAiDelegation.js')]);
    const routeKey = plan.routeKey;
    const method = req.method;
    const path = plan.upstreamPath;
    const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
    };
    if (!isDelegatedAgentOpenAiCall({ req, agentName: routeKey, method, agentProxyPath: path })) {
        return send(401, { error: 'agent_assertion_required' });
    }
    if (readAgenticDepth(req.headers) >= MAX_AGENTIC_DEPTH) return send(400, { error: {
        message: `agentic recursion depth exceeded (${MAX_AGENTIC_DEPTH})`, type: 'invalid_request_error',
    } });
    const body = await new Promise(resolve => readRequestBody(req, {
        maxBytes: resolveHttpRouteInvocationMaxBodyBytes(),
        onSuccess: resolve,
        onTooLarge: ({ limitBytes }) => {
            send(413, { error: method === 'GET' ? 'openai_models_body_too_large' : 'openai_body_too_large', limitBytes });
            resolve(null);
        },
        onError: () => { send(500, { error: 'request error' }); resolve(null); },
    }));
    if (body === null) return;
    const depthHeader = { 'x-ploinky-agentic-depth': String(readAgenticDepth(req.headers) + 1) };
    let verified;
    return dispatchAgentRootHttp({ req, res, plan, agentBody: body, headersForSelection: selection => {
        if (!selection.targetRecord) throw Object.assign(new Error('router_request_unavailable'), { status: 503 });
        if (!verified) {
            const raw = req.headers.authorization ?? req.headers.Authorization;
            const token = (Array.isArray(raw) ? raw[0] : raw).trim().replace(/^bearer\s+/i, '');
            verified = verifyAndMintAgentOpenAiCall({ token, routeKey, route: plan.route, method, path, body,
                targetRecord: selection.targetRecord });
            if (!verified.ok) throw Object.assign(new Error(verified.error), { status: verified.status });
            return { ...verified.authInfoHeader, ...depthHeader };
        }
        const id = verified.callerPrincipal;
        const envelope = JSON.parse(verified.authInfoHeader['x-ploinky-auth-info']);
        envelope.invocationToken = buildRouterRequest({
            targetAgentId: verified.targetAgentId, targetRecord: selection.targetRecord, sub: id,
            actor: { kind: 'agent', id, roles: [] }, caller: { kind: 'agent', id, roles: ['agent'] },
            method, path, tool: method === 'GET' ? OPENAI_MODELS_TOOL : OPENAI_CHAT_COMPLETIONS_TOOL,
            rch: computeRchHttp({ method, path, query: '', bodyHash: verified.bodyHash }),
        }).token;
        return { 'x-ploinky-auth-info': JSON.stringify(envelope), ...depthHeader };
    } });
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
    let upstream;
    let bodyReader;
    let leaseOutcome = 'uncommitted';
    let requestBytes = 0;
    let responseBytes = 0;
    let responseStatus = 0;
    let dialStarted;
    let finalized;
    let untrack;
    let cancellationError;
    let resolveCancellation;
    const cancellationPromise = new Promise(resolve => { resolveCancellation = resolve; });
    let headerDeadlineError;
    let resolveHeaderDeadline;
    const headerDeadlinePromise = new Promise(resolve => { resolveHeaderDeadline = resolve; });
    let headerDeadlineAt;
    let headerDeadlineTimer;
    let cancelActiveRequest;
    const observeCancellation = error => {
        if (!cancellationError) {
            cancellationError = error;
            resolveCancellation(error);
        }
        cancelActiveRequest?.(cancellationError);
    };
    const onRequestAborted = () => observeCancellation(new Error('proxy: client aborted'));
    const onResponseClosed = () => {
        if (!res.writableEnded) observeCancellation(new Error('proxy: downstream cancelled'));
    };
    const expireHeaderDeadline = () => {
        if (!headerDeadlineError) {
            headerDeadlineError = new Error('proxy: upstream response header timeout');
            resolveHeaderDeadline(headerDeadlineError);
        }
        cancelActiveRequest?.(headerDeadlineError);
    };
    const clearHeaderDeadline = () => {
        clearTimeout(headerDeadlineTimer);
        headerDeadlineTimer = null;
    };
    const currentInterruptionError = () => {
        if (cancellationError) return cancellationError;
        if (!headerDeadlineError && headerDeadlineAt !== undefined && Date.now() >= headerDeadlineAt) {
            expireHeaderDeadline();
        }
        return headerDeadlineError;
    };
    const throwIfInterrupted = () => {
        const error = currentInterruptionError();
        if (error) throw error;
    };
    const closeCheckout = checkout => {
        try { checkout?.close?.(); } catch (_) {}
    };
    const awaitSetup = async (setupPromise, { onInterrupt, onLateResolve } = {}) => {
        const completion = Promise.resolve(setupPromise).then(
            value => ({ type: 'resolved', value }),
            error => ({ type: 'rejected', error }),
        );
        const outcome = await Promise.race([
            cancellationPromise.then(error => ({ type: 'interrupted', error })),
            headerDeadlinePromise.then(error => ({ type: 'interrupted', error })),
            completion,
        ]);
        const interruptionError = outcome.type === 'interrupted'
            ? outcome.error
            : currentInterruptionError();
        if (interruptionError) {
            try { onInterrupt?.(interruptionError); } catch (_) {}
            if (outcome.type === 'resolved') {
                try { onLateResolve?.(outcome.value); } catch (_) {}
            } else {
                void completion.then(lateOutcome => {
                    if (lateOutcome.type !== 'resolved') return;
                    try { onLateResolve?.(lateOutcome.value); } catch (_) {}
                });
            }
            throw interruptionError;
        }
        if (outcome.type === 'resolved') return outcome.value;
        if (outcome.type === 'rejected') throw outcome.error;
        throw new Error('proxy: setup interrupted');
    };
    req.once('aborted', onRequestAborted);
    res.once('close', onResponseClosed);
    if (req.aborted) onRequestAborted();
    if (res.destroyed && !res.writableEnded) onResponseClosed();
    try {
        if (authorized !== true) throw Object.assign(new Error('proxy: request not authorized'), { code: 'AUTH_REQUIRED' });
        assertSupportedHttp1Request(req, plan);
        finalized = finalizePlanAfterAdmission(selectAgentPortPlan(plan, req));
        headerDeadlineAt = startedAt + finalized.limits.headerTimeoutMs;
        const headerDeadlineDelay = Math.max(0, headerDeadlineAt - Date.now());
        headerDeadlineTimer = setTimeout(expireHeaderDeadline, headerDeadlineDelay);
        headerDeadlineTimer.unref?.();
        throwIfInterrupted();
        const hasBody = !['GET', 'HEAD'].includes(finalized.method);
        const hasPrebufferedBody = prebufferedBody !== undefined;
        const streaming = hasBody
            && finalized.allowRequestStreaming === true
            && !hasPrebufferedBody;
        if (!streaming && prebufferedBody === undefined) {
            bodyReader = readBoundedBody(req, finalized.limits.bufferedBodyBytes);
        }
        const body = streaming ? null
            : prebufferedBody !== undefined ? Buffer.from(prebufferedBody)
                : await awaitSetup(bodyReader.promise, { onInterrupt: bodyReader.cancel });
        throwIfInterrupted();
        if (body && body.length > finalized.limits.bufferedBodyBytes) {
            throw Object.assign(new Error('proxy: buffered request body limit exceeded'), { code: 'REQUEST_TOO_LARGE' });
        }
        requestBytes = body?.length || 0;
        const bodyMode = streaming ? 'stream' : body?.length ? 'buffered' : 'none';
        const bodyHash = streaming ? '' : sha256RawBodyHash(body || Buffer.alloc(0));
        throwIfInterrupted();
        let headers;
        const relayStream = await openSelectedRelay({ plan, req, lease, initial: finalized, open: async (selected, checkedLease) => {
            finalized = selected;
            const trusted = typeof trustedHeadersFactory === 'function'
                ? await awaitSetup(trustedHeadersFactory({ body, bodyMode, bodyHash, plan: selected })) : trustedHeaders;
            throwIfInterrupted();
            headers = sanitizeRequestHeaders(req.headers, selected, trusted || {});
            if (!streaming) headers['content-length'] = String(body?.length || 0);
            if (measureHeaderBytes(headers) > selected.limits.requestHeaderBytes) {
                throw Object.assign(new Error('proxy: request header limit exceeded'), { code: 'REQUEST_TOO_LARGE' });
            }
            throwIfInterrupted();
            dialStarted = Date.now();
            channel = await awaitSetup(relayManager.checkout({ plan: selected, lease: checkedLease, authorized: true }),
                { onLateResolve: closeCheckout });
            leaseOutcome = 'committed';
            try {
                throwIfInterrupted();
                const checkout = channel;
                return await awaitSetup(checkout.openRequest({ plan: selected, bodyMode, bodyHash, headers }),
                    { onLateResolve: () => closeCheckout(checkout) });
            } catch (error) {
                closeCheckout(channel);
                channel = undefined;
                throw error;
            }
        } });
        throwIfInterrupted();
        const connection = new RelayDuplex(relayStream);
        relayAgent = createRelayHttpAgent(connection);
        await new Promise((resolve, reject) => {
            let settled = false;
            let idleTimer;
            let lifetimeTimer;
            const clearTimers = () => {
                clearTimeout(idleTimer);
                clearTimeout(lifetimeTimer);
            };
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimers();
                clearHeaderDeadline();
                if (cancelActiveRequest === fail) cancelActiveRequest = null;
                resolve();
            };
            const fail = error => {
                if (settled) return;
                settled = true;
                clearTimers();
                clearHeaderDeadline();
                if (cancelActiveRequest === fail) cancelActiveRequest = null;
                try { upstream?.destroy(error); } catch (_) {}
                reject(error);
            };
            const resetIdleTimer = () => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => fail(new Error('proxy: upstream idle timeout')), finalized.limits.idleTimeoutMs);
                idleTimer.unref?.();
            };
            cancelActiveRequest = fail;
            const interruptionError = currentInterruptionError();
            if (interruptionError) {
                fail(interruptionError);
                return;
            }
            upstream = http.request({
                method: finalized.method,
                path: `${finalized.targetPath}${finalized.query ? `?${finalized.query}` : ''}`,
                headers,
                maxHeaderSize: finalized.limits.responseHeaderBytes,
                agent: relayAgent,
            }, upstreamRes => {
                const responseInterruptionError = currentInterruptionError();
                if (responseInterruptionError) {
                    fail(responseInterruptionError);
                    return;
                }
                clearHeaderDeadline();
                responseStatus = upstreamRes.statusCode || 502;
                observeProxyFirstByte({ plan: finalized, ttfbMs: Date.now() - dialStarted });
                res.writeHead(responseStatus, sanitizeResponseHeaders(upstreamRes.headers, finalized));
                const contentType = String(upstreamRes.headers['content-type'] || '').toLowerCase();
                const longLived = finalized.transport === 'sse' || contentType.startsWith('text/event-stream');
                if (longLived) {
                    untrack = trackCanaryConnection(finalized.selection || finalized, () => res.destroy());
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
                responseLimiter.once('error', fail);
                upstreamRes.once('aborted', () => {
                    if (!cancellationError) fail(Object.assign(new Error('target response truncated'), { code: 'RELAY_FAILURE' }));
                });
                responseLimiter.on('data', resetIdleTimer);
                responseLimiter.on('data', chunk => { responseBytes += chunk.length; });
                resetIdleTimer();
                pipeline(upstreamRes, responseLimiter, res).then(finish, fail);
            });
            upstream.once('error', fail);
            const postRequestInterruptionError = currentInterruptionError();
            if (postRequestInterruptionError) {
                fail(postRequestInterruptionError);
                return;
            }
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
        closeCheckout(channel);
        lease.release?.();
        return true;
    } catch (error) {
        clearHeaderDeadline();
        try { upstream?.destroy(error); } catch (_) {}
        relayAgent?.destroy();
        recordProxyOutcome({
            plan: finalized || plan,
            outcome: 'failure',
            startedAt,
            error,
            status: proxyErrorStatus(error),
            upstreamStatus: responseStatus,
            requestBytes,
            responseBytes,
            leaseOutcome,
            relayOutcome: channel ? 'ready' : 'failure',
            upstreamOutcome: 'failure',
            sink: auditSink,
        });
        closeCheckout(channel);
        lease?.release?.();
        sendError(res, error, {
            abandonedRequest: bodyReader?.shouldCloseAfterResponse() ? req : undefined,
        });
        return false;
    } finally {
        untrack?.();
        clearHeaderDeadline();
        cancelActiveRequest = null;
        req.off('aborted', onRequestAborted);
        res.off('close', onResponseClosed);
    }
}

export default executeHttpPlan;
