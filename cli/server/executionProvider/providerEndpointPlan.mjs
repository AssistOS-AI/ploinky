import crypto from 'node:crypto';

import { captureEdgeRoutingLease } from '../../sandbox/edgeGeneration.js';
import { exactAgentRuntime, exactRoute } from '../edgeRoutePlan.js';
import { AGENT_PORT_ROUTE } from '../agentPortConvention/parseSelector.js';
import { leaseRouteHardwareAvailability } from '../hardwareAvailability.mjs';
import { compileProxyLimits } from '../proxy/limits.js';
import { createRoutePlan } from '../proxy/RoutePlan.js';
import { readExecutionProviderDeclaration } from './declaration.mjs';

// The Router-internal planner for provider endpoints. It is for trusted
// structured adapter input only: it never reads a request URL, Host header,
// base URL or caller-selected port, and takes the port and path from the
// declaration of a freshly captured active generation. Planning allocates no
// relay, signs nothing and grants no operation authorization; the adapter then
// authorizes, signs, finalizes the plan (finalizePlanAfterAdmission) and checks
// out the relay, which rechecks the captured lease before OPEN.

export const PROVIDER_UNAVAILABLE = 'provider_unavailable';
export const PROVIDER_REQUEST_INVALID = 'provider_request_invalid';

const INPUT_KEYS = new Set(['routeKey', 'endpoint', 'subpath', 'method', 'query', 'transport']);
const ENDPOINTS = new Set(['terminals', 'taskReferences']);

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
const EVENTS_QUERY_PATTERN = /^after=(0|[1-9][0-9]{0,15})&limit=([1-9][0-9]{0,3})$/;
export const TASK_EVENT_LIMIT_MAX = 1000;

export function isTaskReferenceId(value) {
    return typeof value === 'string' && TASK_ID_PATTERN.test(value);
}

// Empty, or exactly `after=<canonical unsigned decimal>&limit=<canonical
// positive decimal>` in that order. `after` is a safe integer, `limit` 1-1000.
// Duplicates, unknown keys, reordering, signs and leading zeros are refused.
export function validateTaskEventsQuery(query) {
    if (query === '') return { ok: true, after: null, limit: null };
    if (typeof query !== 'string') return { ok: false };
    const match = EVENTS_QUERY_PATTERN.exec(query);
    if (!match) return { ok: false };
    const after = Number(match[1]);
    const limit = Number(match[2]);
    if (!Number.isSafeInteger(after) || limit < 1 || limit > TASK_EVENT_LIMIT_MAX) return { ok: false };
    return { ok: true, after, limit };
}

function unavailable(code = PROVIDER_UNAVAILABLE, status = 503, details = {}) {
    return Object.freeze({ matched: true, ok: false, status, code, ...details });
}

function stringOrThrow(name, value) {
    if (typeof value !== 'string') throw new TypeError(`planProviderEndpoint: ${name} must be a string`);
    return value;
}

// The fixed operation grammar. Returns the declared-path-relative target
// suffix, or null for an operation outside the grammar.
function operationSuffix({ endpoint, subpath, method, query, transport }) {
    if (endpoint === 'terminals') {
        if (method === 'GET' && transport === 'websocket' && subpath === '' && query === '') return '';
        if (method === 'POST' && transport === 'http' && subpath === '/targets' && query === '') return '/targets';
        return null;
    }
    if (transport !== 'http') return null;
    if (method === 'POST' && subpath === '/lookup' && query === '') return '/lookup';
    const parts = subpath.split('/');
    if (parts.length >= 2 && parts[0] === '' && isTaskReferenceId(parts[1])) {
        if (parts.length === 2 && method === 'GET' && query === '') return subpath;
        if (parts.length === 3 && parts[2] === 'events' && method === 'GET' && validateTaskEventsQuery(query).ok) return subpath;
        if (parts.length === 3 && parts[2] === 'control' && method === 'POST' && query === '') return subpath;
    }
    return null;
}

export function planProviderEndpoint(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('planProviderEndpoint: structured input is required');
    }
    for (const key of Object.keys(input)) {
        if (!INPUT_KEYS.has(key)) throw new TypeError(`planProviderEndpoint: unsupported input key '${key}'`);
    }
    const routeKey = stringOrThrow('routeKey', input.routeKey);
    const endpoint = stringOrThrow('endpoint', input.endpoint);
    const subpath = stringOrThrow('subpath', input.subpath ?? '');
    const method = stringOrThrow('method', input.method ?? 'GET');
    const query = stringOrThrow('query', input.query ?? '');
    const transport = stringOrThrow('transport', input.transport ?? 'http');
    if (!ENDPOINTS.has(endpoint)) throw new TypeError(`planProviderEndpoint: unknown endpoint '${endpoint}'`);

    // The active generation is captured here, never supplied by the caller.
    let lease;
    try {
        lease = captureEdgeRoutingLease();
    } catch (error) {
        return unavailable(error?.code || 'EDGE_GENERATION_INACTIVE');
    }
    const snapshot = lease.snapshot;
    const selected = exactRoute(snapshot.routing?.routes || {}, routeKey);
    if (!selected) return unavailable(PROVIDER_UNAVAILABLE, 503, { lease });
    const read = readExecutionProviderDeclaration(snapshot.manifests?.[routeKey], { routeKey });
    const declared = read.present && read.valid ? read.declaration[endpoint] : null;
    if (!declared) return unavailable(PROVIDER_UNAVAILABLE, 503, { lease });
    if (leaseRouteHardwareAvailability(lease, routeKey)) return unavailable(PROVIDER_UNAVAILABLE, 503, { lease });
    const runtime = exactAgentRuntime(snapshot, routeKey, selected.route);
    if (!runtime) return unavailable(PROVIDER_UNAVAILABLE, 503, { lease });

    const upperMethod = method.toUpperCase();
    const suffix = operationSuffix({ endpoint, subpath, method: upperMethod, query, transport });
    if (method !== upperMethod || suffix === null) return unavailable(PROVIDER_REQUEST_INVALID, 400, { lease });
    const port = read.declaration.port;
    const targetPath = `${declared.path}${suffix}`;

    // A plan that is distinct from `agent-port`: its surface is finalized by
    // finalizePlanAfterAdmission, and no agent-port consumer accepts its kind.
    return createRoutePlan({
        matched: true,
        ok: true,
        kind: 'provider-endpoint',
        listenerClass: 'internal',
        authority: 'router.internal',
        surfaceKind: 'provider-endpoint',
        owner: {
            effectiveInstanceId: runtime.effectiveInstanceId,
            enableGeneration: runtime.enableGeneration,
        },
        routeKey,
        route: selected.route,
        endpoint,
        port,
        policyPath: targetPath,
        convention: AGENT_PORT_ROUTE,
        unmatchedSuffix: targetPath,
        relay: {
            kind: 'container-control-socket',
            runtime: runtime.runtime,
            containerId: runtime.containerId,
            containerName: runtime.containerName,
            targetAgentId: runtime.targetAgentId,
            effectiveInstanceId: runtime.effectiveInstanceId,
            enableGeneration: runtime.enableGeneration,
            networkMode: runtime.networkMode === 'host' ? 'host' : '',
        },
        access: { access: 'internal-provider-endpoint', routeKey, endpoint },
        scheme: 'http',
        origin: 'http://router.internal',
        limits: compileProxyLimits(),
        generationDigest: lease.id,
        auditId: crypto.randomUUID(),
        method: upperMethod,
        query,
        transport,
        // As agentPortPlan: a host-network runtime shares the Router's loopback.
        deniedPorts: runtime.networkMode === 'host' ? [8080, 8081] : [],
        allowedRouterCapabilities: [],
        allowRequestStreaming: false,
        lease,
        snapshot,
    });
}
