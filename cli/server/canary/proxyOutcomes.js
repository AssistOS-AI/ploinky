let registration;

// The Router owns this synchronous observer for its lifetime. An old cleanup
// cannot detach a replacement Router's observer.
export function registerProxyOutcomeSink(sink) {
    if (typeof sink !== 'function') throw new TypeError('proxy outcome sink must be a function');
    const current = { sink, observed: new WeakMap() };
    registration = current;
    return () => {
        if (registration === current) registration = undefined;
    };
}

function validStatus(status) {
    return Number.isInteger(status) && status >= 100 && status <= 599;
}

function classifyFailure(error, leaseOutcome) {
    const code = error?.code;
    const message = typeof error?.message === 'string' ? error.message : '';
    // Both WebSocket refusal and target socket errors carry the causal
    // backend result in the existing relay/proxy protocol.
    const refused = /^proxy: target refused WebSocket \(([1-5]\d\d)\)$/.exec(message);
    if (refused) return { status: Number(refused[1]) };
    if (code === 'TARGET_FAILURE') {
        if (message === 'request byte limit exceeded') return;
        const unreachable = /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b/.test(message)
            || message === 'target connect timeout' || message === 'target idle timeout';
        return { serverError: true, unreachable };
    }
    if (code === 'TARGET_TIMEOUT' || code === 'ECONNREFUSED'
        || message === 'relayConfinement: container is not running'
        || message === 'runtimeRelay: control socket connect timeout'
        || message === 'runtimeRelay: HELLO timeout'
        || message === 'proxy: WebSocket handshake timeout'
        || (leaseOutcome === 'committed' && message === 'proxy: upstream response header timeout')) {
        return { serverError: true, unreachable: true };
    }
    if (code === 'RELAY_FAILURE' || code === 'RESPONSE_TOO_LARGE' || /^HPE_/.test(code)
        || message === 'proxy: upstream idle timeout'
        || message === 'runtimeRelay: channel is closed'
        || message.startsWith('runtime relay exited (')) return { serverError: true };
    // The WebSocket executor funnels both sockets' ECONNRESET into one catch.
    // Only a TARGET_FAILURE envelope or an explicit dial-site observation
    // attributes such a reset to the target. HTTP header deadlines can also
    // expire during caller body buffering, before relay checkout.
}

export function observeProxyOutcome({
    plan, outcome, status, error, leaseOutcome, upstreamStatus, serverError, unreachable, ttfbMs,
}) {
    if (!registration || !plan?.routeKey) return;
    const copy = plan.copy ?? 'old';
    if (copy !== 'old' && (copy !== 'canary' || !plan.rolloutId)) return;
    const failure = outcome === 'failure' ? classifyFailure(error, leaseOutcome) : undefined;
    const explicitFailure = serverError === true || unreachable === true;
    let backendStatus = failure?.status;
    if (validStatus(upstreamStatus)) backendStatus = upstreamStatus;
    else if (validStatus(status) && (outcome === 'success' || (explicitFailure && status === 200))) {
        backendStatus = status;
    }
    // A local 4xx is attributable to the caller. No backend request or
    // response was observed, so it must not dilute the backend failure rate.
    const callerError = !backendStatus && !failure && !explicitFailure
        && outcome === 'failure' && validStatus(status) && status >= 400 && status < 500;
    if (!backendStatus && !failure && !explicitFailure && !callerError) return;

    // The pre-admission and finalized plan share their per-request lease.
    const identity = plan.lease ?? plan;
    if (plan.auditId && typeof identity === 'object') {
        if (registration.observed.get(identity) === plan.auditId) return;
        registration.observed.set(identity, plan.auditId);
    }
    try {
        registration.sink({
            routeKey: plan.routeKey,
            copy,
            rolloutId: plan.rolloutId,
            status: backendStatus ?? 0,
            callerError,
            serverError: explicitFailure || failure?.serverError === true || backendStatus >= 500,
            unreachable: unreachable === true || failure?.unreachable === true,
            ttfbMs: Number.isFinite(ttfbMs) && ttfbMs >= 0 ? ttfbMs : undefined,
        });
    } catch {
        // Observation must never interrupt proxy completion or audit delivery.
    }
}

// Headers can arrive hours before an SSE/WS closes. A timing observation
// updates the latency distribution without declaring the stream successful.
export function observeProxyFirstByte({ plan, ttfbMs }) {
    if (!registration || !plan?.routeKey || !Number.isFinite(ttfbMs) || ttfbMs < 0) return;
    try {
        registration.sink({ routeKey: plan.routeKey, copy: plan.copy || 'old', rolloutId: plan.rolloutId,
            timingOnly: true, ttfbMs });
    } catch { /* Observation cannot interrupt forwarding. */ }
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

const sdkTiming = new AsyncLocalStorage();
const sdkRequests = new WeakMap();
const requestCreated = channel('undici:request:create');
const responseHeaders = channel('undici:request:headers');
let activeSdkCalls = 0;

function sdkRequestCreated({ request }) {
    const scope = sdkTiming.getStore();
    if (!scope?.active || request.method !== 'POST' || request.path !== '/mcp'
        || String(request.origin) !== scope.origin) return;
    // A cold SDK client initializes and acknowledges a session before issuing
    // the actual RPC. Each new POST replaces the previous provisional sample.
    const attempt = { scope, started: performance.now() };
    scope.latest = attempt;
    scope.ttfbMs = undefined;
    sdkRequests.set(request, attempt);
}

function sdkResponseHeaders({ request, response }) {
    const attempt = sdkRequests.get(request);
    if (!attempt || response.statusCode < 200) return;
    sdkRequests.delete(request);
    if (attempt.scope.active && attempt.scope.latest === attempt) {
        attempt.scope.ttfbMs = performance.now() - attempt.started;
    }
}

// Keep subscriptions alive only while a measured SDK operation is in flight.
// Fetch responses may arrive in a pooled socket's async context, so correlate
// the header event by its Undici request object, never by socket or port alone.
export async function withSdkHeaderTiming(baseUrl, run, reportTiming) {
    if (!registration || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(baseUrl)) return run();
    const scope = { origin: baseUrl.slice(0, -'/mcp'.length), active: true };
    if (activeSdkCalls++ === 0) {
        requestCreated.subscribe(sdkRequestCreated);
        responseHeaders.subscribe(sdkResponseHeaders);
    }
    try {
        return await sdkTiming.run(scope, run);
    } finally {
        scope.active = false;
        if (--activeSdkCalls === 0) {
            requestCreated.unsubscribe(sdkRequestCreated);
            responseHeaders.unsubscribe(sdkResponseHeaders);
        }
        reportTiming(scope.ttfbMs);
    }
}
