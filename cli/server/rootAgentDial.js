import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';

import { assertExactServiceOwner } from '../sandbox/bwrap/bwrapFleet.js';

const TRUSTED_ROOT_DIAL_CONTEXTS = new WeakSet();
const SANDBOX_SERVICE_RUNTIMES = new Set(['bwrap', 'seatbelt']);

function edgeGenerationChangedError(cause = null) {
    const error = new Error(
        'edge routing generation changed before upstream connection creation',
        cause ? { cause } : undefined,
    );
    error.code = 'EDGE_GENERATION_CHANGED';
    error.statusCode = 503;
    return error;
}

function exactPort(value) {
    return Number.isSafeInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

function copyOwner(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.freeze({ ...value })
        : null;
}

function exactNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 && value === value.trim()
        ? value
        : '';
}

function ownerFromCapturedRoute({ routePlan, routeKey, route, targetPort }) {
    const planOwner = copyOwner(routePlan?.ownerAttestation);
    const snapshot = routePlan?.lease?.snapshot;
    const containerName = exactNonEmptyString(route?.container);
    const record = snapshot?.agents?.[containerName];
    if (!record || !SANDBOX_SERVICE_RUNTIMES.has(record.runtime)) {
        if (planOwner) {
            return { invalid: new Error('captured plan owner does not belong to an exact sandbox route record') };
        }
        return { ownerAttestation: null };
    }

    const recordOwner = copyOwner(record.bwrapOwner);
    const invalid = !containerName
        || record.type !== 'agent'
        || !exactNonEmptyString(record.repoName)
        || !exactNonEmptyString(record.agentName)
        || record.repoName !== route?.repo
        || record.agentName !== route?.agent
        || !recordOwner
        || recordOwner.role !== 'service'
        || !Number.isSafeInteger(record.pid)
        || record.pid < 1
        || recordOwner.pid !== record.pid
        || recordOwner.runtimeKey !== containerName
        || !exactNonEmptyString(routeKey)
        || recordOwner.routeKey !== routeKey
        || exactPort(recordOwner.rootPort) !== targetPort
        || !exactNonEmptyString(record.instanceId)
        || !exactNonEmptyString(record.enableGeneration)
        || recordOwner.instanceId !== record.instanceId
        || recordOwner.enableGeneration !== record.enableGeneration
        || (routePlan?.kind === 'agent-root' && !planOwner)
        || (planOwner && exactPort(routePlan?.target?.hostPort) !== targetPort)
        || (planOwner && !isDeepStrictEqual(planOwner, recordOwner));
    return invalid
        ? { invalid: new Error('captured sandbox route has no exact immutable service owner') }
        : { ownerAttestation: planOwner || recordOwner };
}

/**
 * Capture everything required to authorize one root AgentServer socket. The
 * returned object never rereads mutable routing state.
 */
export function createRootAgentDialContext({
    routePlan = null,
    routeKey = routePlan?.routeKey || '',
    route = routePlan?.route || null,
    targetPort = routePlan?.target?.hostPort ?? route?.hostPort,
} = {}) {
    const port = exactPort(targetPort);
    if (!port) throw new TypeError('root AgentServer dial context requires one exact target port');
    const commit = routePlan?.lease?.commit;
    if (typeof commit !== 'function') {
        throw new TypeError('root AgentServer dial context requires a captured generation commit');
    }
    const owner = ownerFromCapturedRoute({ routePlan, routeKey, route, targetPort: port });
    const context = Object.freeze({
        targetPort: port,
        commit,
        ownerAttestation: owner.ownerAttestation || null,
        invalidOwner: owner.invalid || null,
    });
    TRUSTED_ROOT_DIAL_CONTEXTS.add(context);
    return context;
}

function normalizeDialContext(dialContext) {
    if (dialContext && typeof dialContext === 'object'
        && TRUSTED_ROOT_DIAL_CONTEXTS.has(dialContext)
        && typeof dialContext.commit === 'function'
        && exactPort(dialContext.targetPort)) {
        return dialContext;
    }
    return null;
}

/**
 * Build a non-reusing Agent whose guard executes in createConnection, directly
 * before the kernel socket is created. A stale lease or bwrap owner never dials.
 */
export function createLeaseCommittedAgent(dialContext, {
    createConnection = net.createConnection,
    assertServiceOwner = assertExactServiceOwner,
    maxSockets = 1,
} = {}) {
    const context = normalizeDialContext(dialContext);
    if (!context) return undefined;
    if (maxSockets !== Infinity && (!Number.isSafeInteger(maxSockets) || maxSockets < 1)) {
        throw new TypeError('guarded root Agent maxSockets must be a positive integer or Infinity');
    }
    const agent = new http.Agent({ keepAlive: false, maxSockets });
    agent.createConnection = (options, callback) => {
        let failure = context.invalidOwner || null;
        try {
            const targetHost = String(options?.hostname || options?.host || '');
            if (!failure && (targetHost !== '127.0.0.1'
                || exactPort(options?.port) !== context.targetPort)) {
                throw new Error('root AgentServer socket target differs from captured route');
            }
            if (!failure && context.commit() !== true) {
                throw new Error('captured edge generation is stale');
            }
            if (!failure && context.ownerAttestation) {
                assertServiceOwner(context.ownerAttestation);
            }
        } catch (error) {
            failure = error;
        }
        if (failure) {
            const error = edgeGenerationChangedError(failure);
            queueMicrotask(() => callback(error));
            return undefined;
        }
        return createConnection(options, callback);
    };
    return agent;
}

function responseHeaders(response) {
    const headers = new Headers();
    const raw = Array.isArray(response?.rawHeaders) ? response.rawHeaders : [];
    for (let index = 0; index + 1 < raw.length; index += 2) {
        headers.append(raw[index], raw[index + 1]);
    }
    return headers;
}

/** Fetch-compatible MCP transport backed by the guarded Node HTTP Agent. */
export function createRootAgentFetch(agent, { request = http.request } = {}) {
    if (!agent || typeof agent.addRequest !== 'function') {
        throw new TypeError('root AgentServer fetch requires a guarded HTTP Agent');
    }
    return async function rootAgentFetch(input, init = {}) {
        const url = input instanceof URL
            ? input
            : new URL(typeof input === 'string' ? input : input?.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
            throw new TypeError('root AgentServer fetch accepts only exact loopback HTTP URLs');
        }
        const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
        const body = init.body === undefined || init.body === null
            ? null
            : (Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body), 'utf8'));
        return await new Promise((resolve, reject) => {
            const upstream = request(url, {
                method: String(init.method || 'GET').toUpperCase(),
                headers,
                agent,
                signal: init.signal,
            }, (response) => {
                try {
                    const status = response.statusCode || 500;
                    const noBody = status === 204 || status === 205 || status === 304;
                    resolve(new Response(noBody ? null : Readable.toWeb(response), {
                        status,
                        statusText: response.statusMessage || '',
                        headers: responseHeaders(response),
                    }));
                } catch (error) {
                    response.destroy();
                    reject(error);
                }
            });
            upstream.once('error', reject);
            if (body) upstream.end(body);
            else upstream.end();
        });
    };
}

export { edgeGenerationChangedError };
