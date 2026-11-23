import { observeProxyOutcome, proxyOutcomeIdentity } from '../canary/proxyOutcomes.js';
import { LATENCY_BUCKETS } from '../canary/counters.js';

function latencyBucket(milliseconds) {
    const value = Math.max(0, Number(milliseconds) || 0);
    return `${LATENCY_BUCKETS.find(limit => value <= limit) || 'over-15000'}ms`;
}

export function recordProxyOutcome({
    plan,
    outcome,
    startedAt = Date.now(),
    error,
    status = 0,
    requestBytes = 0,
    responseBytes = 0,
    leaseOutcome = '',
    relayOutcome = '',
    upstreamOutcome = '',
    upstreamStatus,
    serverError,
    unreachable,
    ttfbMs,
    sink,
} = {}) {
    const event = Object.freeze({
        event: 'agent_port_proxy_outcome',
        auditId: String(plan?.auditId || ''),
        generationDigest: String(plan?.generationDigest || ''),
        listenerClass: String(plan?.listenerClass || ''),
        surfaceKind: String(plan?.surfaceKind || ''),
        ownerInstanceId: String(plan?.owner?.effectiveInstanceId || ''),
        routeKey: String(plan?.routeKey || ''),
        ...proxyOutcomeIdentity(plan),
        port: Number(plan?.port || 0),
        method: String(plan?.method || ''),
        transport: String(plan?.transport || ''),
        policyAccess: String(plan?.access?.access || ''),
        policyPathClass: String(plan?.surfaceKind || ''),
        leaseOutcome: String(leaseOutcome || ''),
        relayOutcome: String(relayOutcome || ''),
        upstreamOutcome: String(upstreamOutcome || ''),
        outcome: String(outcome || 'unknown'),
        status: Number(status || 0),
        requestBytes: Math.max(0, Number(requestBytes) || 0),
        responseBytes: Math.max(0, Number(responseBytes) || 0),
        latencyBucket: latencyBucket(Date.now() - startedAt),
        ...(error ? { errorCode: String(error.code || 'PROXY_FAILURE') } : {}),
    });
    observeProxyOutcome({ plan, outcome, status, error, leaseOutcome, upstreamStatus, serverError, unreachable, ttfbMs });
    sink?.(event);
    return event;
}

export default recordProxyOutcome;
