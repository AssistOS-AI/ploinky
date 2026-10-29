import { computeRchHttp, computeRchTool, sha256RawBodyHash } from '../../../Agent/lib/requestHash.mjs';
import { createAgentClient } from '../AgentClient.js';
import { exactRoute } from '../edgeRoutePlan.js';
import { buildRouterRequest, verifyAgentAssertion } from '../mcp-proxy/invocationMinter.js';
import { verifyUserDelegationGrant } from '../mcp-proxy/userDelegationGrant.js';
import { Caller } from '../policy/Caller.js';
import { executeHttpPlan } from '../proxy/executeHttpPlan.js';
import { createTokenReplayCache } from '../security/tokens/JwsCodec.js';
import { currentEnabledAgentIdentity } from '../../sandbox/edgeGeneration.js';
import { deriveSubkey } from '../../utils/security/masterKey.js';
import { identityLeaseHardwareUnavailable } from '../hardwareAvailability.mjs';
import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
import { canonicalOriginCallerKey, declaredTaskReferenceProvider, isOriginRequestId } from './originToken.mjs';
import { planProviderEndpoint } from './providerEndpointPlan.mjs';

// Router handlers of the generic task-reference surface (interface contract
// §2.2 descriptor, §2.3 read/events/control/lookup). Browser callers are
// authenticated by their session on the public listener (guests refused);
// agent callers present an agent assertion on the private listener. The
// Router forwards to the provider only through the internal provider-endpoint
// planner, signed with a provider-audience `__task_ref__` Router Request bound
// to the exact method, path, query and body. Callers never select a URL, port
// or provider path.

export const TASK_REFERENCE_TOOL = '__task_ref__';
const TASK_REFERENCE_ANNOTATION = 'ploinkyTaskReference';
const USER_DELEGATION_HEADER = 'x-ploinky-user-delegation';
const BODY_MAX_BYTES = 64 * 1024;
const CONTROL_KEYS = new Set(['operationId', 'op', 'attemptId', 'payload']);

const taskReferenceAssertionCache = createTokenReplayCache();

function sendJson(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}

function refusal(status, code) {
    const error = new Error(code);
    error.status = status;
    error.code = code;
    return error;
}

// The descriptor's one answer for hidden, unknown and unavailable tools.
const DESCRIPTOR_NOT_FOUND = Object.freeze({ error: 'task_reference_descriptor_not_found' });

function readBody(req, maxBytes = BODY_MAX_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        const fail = (error) => { if (!settled) { settled = true; reject(error); } };
        req.on('data', (chunk) => {
            if (settled) return;
            total += chunk.length;
            if (total > maxBytes) { fail(refusal(413, 'task_reference_body_too_large')); return; }
            chunks.push(Buffer.from(chunk));
        });
        req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
        req.on('error', fail);
        req.on('aborted', () => fail(refusal(400, 'task_reference_request_aborted')));
    });
}

function readAuthorizationBearer(req) {
    const raw = req?.headers?.authorization;
    const value = Array.isArray(raw) ? raw[0] : String(raw || '');
    return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

function parseJsonObject(body) {
    try {
        const value = JSON.parse(Buffer.from(body).toString('utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

// Exact request bodies: lookup is exactly {originRequestId}; control is an
// object with string operationId and op and only the listed optional keys.
function validateBody(request, body) {
    if (request.op === 'lookup') {
        const value = parseJsonObject(body);
        if (!value || Object.keys(value).length !== 1 || !isOriginRequestId(value.originRequestId)) {
            throw refusal(400, 'task_reference_request_invalid');
        }
        return value;
    }
    if (request.op === 'control') {
        const value = parseJsonObject(body);
        if (!value || typeof value.operationId !== 'string' || !value.operationId
            || typeof value.op !== 'string' || !value.op
            || Object.keys(value).some((key) => !CONTROL_KEYS.has(key))) {
            throw refusal(400, 'task_reference_request_invalid');
        }
        return value;
    }
    if (body.length) throw refusal(400, 'task_reference_request_invalid');
    return null;
}

// The signed arguments of an agent caller's `__task_ref__` assertion
// (interface §2.3, amended 2026-10-28): the operation and its target, plus
// the SHA-256 (base64url) of the exact body for control and lookup and the
// canonical query (without `?`) for events, so a valid assertion cannot carry
// another action, body or event window.
function assertionArguments(request, bodyValue, rawBody) {
    if (request.op === 'descriptor') return { op: 'descriptor', agent: request.agent, tool: request.tool };
    if (request.op === 'lookup') {
        return { provider: request.provider, op: 'lookup', originRequestId: bodyValue.originRequestId, bodyHash: sha256RawBodyHash(rawBody) };
    }
    if (request.op === 'control') return { provider: request.provider, op: 'control', id: request.id, bodyHash: sha256RawBodyHash(rawBody) };
    if (request.op === 'events') return { provider: request.provider, op: 'events', id: request.id, query: request.query };
    return { provider: request.provider, op: request.op, id: request.id };
}

function routePrincipal(snapshot, routeKey) {
    const selected = exactRoute(snapshot?.routing?.routes || {}, routeKey);
    if (!selected) return '';
    try {
        return deriveAgentPrincipalId(String(selected.route.repo || ''), String(selected.route.agent || ''));
    } catch {
        return '';
    }
}

// The verified direct caller. On the private listener: a fresh agent
// assertion for this exact operation from a currently enabled agent, plus an
// optional user delegation for target = provider, tool = `__task_ref__`. On
// the public listener: the session user (already admitted by the Router's
// session gate), never a guest.
function authenticateCaller({ req, plan, request, bodyValue, rawBody = Buffer.alloc(0), assertionCache }) {
    if (plan.listener === 'private') {
        const token = readAuthorizationBearer(req);
        if (!token) throw refusal(401, 'task_reference_assertion_required');
        const targetAgentId = request.op === 'descriptor' ? request.agent : request.provider;
        let verified;
        try {
            verified = verifyAgentAssertion({
                token,
                method: String(req.method || 'GET').toUpperCase(),
                path: request.path,
                tool: TASK_REFERENCE_TOOL,
                rch: computeRchTool({
                    method: String(req.method || 'GET').toUpperCase(),
                    path: request.path,
                    tool: TASK_REFERENCE_TOOL,
                    arguments: assertionArguments(request, bodyValue, rawBody),
                }),
                targetAgentId,
                replayCache: assertionCache,
            });
        } catch {
            throw refusal(401, 'task_reference_assertion_rejected');
        }
        const callerPrincipal = String(verified.callerPrincipal || '');
        const current = currentEnabledAgentIdentity(plan.snapshot, callerPrincipal);
        if (!current) throw refusal(403, 'task_reference_caller_not_enabled');
        // As for every private caller: a refused or blocked caller, or one
        // whose availability the lease cannot prove, keeps no authority.
        if (plan.lease && (!plan.lease.effective || identityLeaseHardwareUnavailable(plan.lease, current))) {
            throw refusal(403, 'task_reference_caller_unavailable');
        }
        let userDelegation = null;
        const rawGrant = req.headers?.[USER_DELEGATION_HEADER];
        // Interface §2.2 known limitation: a delegated agent caller of the
        // descriptor gets the descriptor's one 404, never a distinct refusal.
        if (rawGrant !== undefined && request.op === 'descriptor') throw refusal(404, DESCRIPTOR_NOT_FOUND.error);
        if (rawGrant !== undefined) {
            const providerPrincipal = routePrincipal(plan.snapshot, request.provider);
            try {
                if (Array.isArray(rawGrant) || !providerPrincipal) throw new Error('unusable grant');
                userDelegation = verifyUserDelegationGrant({
                    signingSecret: deriveSubkey('router-user-delegation', 32),
                    token: String(rawGrant).trim(),
                    expectedSourceAgentId: callerPrincipal,
                    expectedTargetAgentId: providerPrincipal,
                    expectedTool: TASK_REFERENCE_TOOL,
                });
            } catch {
                throw refusal(403, 'task_reference_delegation_rejected');
            }
        }
        return Object.freeze({
            kind: 'agent',
            originKey: callerPrincipal,
            actor: { kind: 'agent', id: callerPrincipal, roles: [] },
            caller: { kind: 'agent', id: callerPrincipal, roles: ['agent'] },
            usr: userDelegation?.user,
            delegation: userDelegation?.delegation,
            policyCaller: Caller.fromRequest({ delegatedAgentVerified: { callerPrincipal, userDelegation } }),
        });
    }
    const user = req.user && typeof req.user === 'object' ? req.user : null;
    if (!user || !String(user.id || '').trim()) throw refusal(401, 'task_reference_authentication_required');
    const originKey = canonicalOriginCallerKey({ user });
    if (!originKey) throw refusal(403, 'task_reference_guest_refused');
    const roles = Array.isArray(user.roles) ? user.roles.map(String) : [];
    return Object.freeze({
        kind: 'user',
        originKey,
        actor: { kind: 'user', id: originKey, roles },
        policyCaller: Caller.fromRequest({ user }),
    });
}

async function defaultListTools({ route, lease }) {
    const client = createAgentClient(`http://127.0.0.1:${route.hostPort}/mcp`, {
        beforeConnect: () => lease?.commit?.() === true,
    });
    try {
        return await client.listTools();
    } finally {
        await client.close().catch(() => {});
    }
}

// GET /task-refs/descriptor: {version, provider} for a tool the caller may
// see, from the serving agent's own listing. Hidden, unknown and
// unavailable-provider tools (and an unreachable agent) share one 404.
async function serveDescriptor({ res, plan, request, caller, toolPolicy, listTools }) {
    const selected = exactRoute(plan.snapshot?.routing?.routes || {}, request.agent);
    let descriptor = null;
    if (selected && Number(selected.route.hostPort) > 0) {
        let tools = [];
        try {
            tools = await listTools({ route: selected.route, routeKey: request.agent, lease: plan.lease });
        } catch {
            tools = [];
        }
        const visible = toolPolicy.filterTools(request.agent, Array.isArray(tools) ? tools : [], caller.policyCaller);
        const tool = visible.find((entry) => entry && entry.name === request.tool);
        const annotation = tool?.annotations?.[TASK_REFERENCE_ANNOTATION];
        if (annotation && annotation.version === 1 && typeof annotation.provider === 'string'
            && declaredTaskReferenceProvider(plan.snapshot, annotation.provider)) {
            descriptor = { version: 1, provider: annotation.provider };
        }
    }
    if (!descriptor) {
        sendJson(res, 404, DESCRIPTOR_NOT_FOUND);
        return;
    }
    if (plan.lease?.commit?.() !== true) {
        sendJson(res, 503, { error: 'edge_generation_changed' });
        return;
    }
    sendJson(res, 200, descriptor);
}

// Read, events, control and lookup: plan through the provider-endpoint
// planner (fresh active generation, fixed grammar, runtime and lease checks),
// sign, and forward the exact body.
async function forwardToProvider({ req, res, plan, request, caller, body, relayManager, auditSink }) {
    const method = String(req.method || 'GET').toUpperCase();
    const providerPlan = planProviderEndpoint({
        routeKey: request.provider,
        endpoint: 'taskReferences',
        subpath: request.subpath,
        method,
        query: request.query,
        transport: 'http',
    });
    if (!providerPlan.ok) {
        sendJson(res, providerPlan.status || 503, { error: providerPlan.code || 'provider_unavailable' });
        return;
    }
    // The caller was authenticated against the request's generation; the
    // provider plan must belong to that same generation.
    if (plan.lease?.id && providerPlan.generationDigest !== plan.lease.id) {
        sendJson(res, 503, { error: 'edge_generation_changed' });
        return;
    }
    const path = providerPlan.unmatchedSuffix;
    const search = providerPlan.query ? `?${providerPlan.query}` : '';
    await executeHttpPlan({
        req,
        res,
        plan: providerPlan,
        lease: providerPlan.lease,
        relayManager,
        authorized: true,
        prebufferedBody: body,
        trustedHeadersFactory: ({ bodyHash }) => {
            const { token } = buildRouterRequest({
                targetAgentId: providerPlan.relay.targetAgentId,
                sub: caller.originKey,
                actor: caller.actor,
                caller: caller.caller,
                usr: caller.usr,
                delegation: caller.delegation,
                originKey: request.op === 'lookup' ? caller.originKey : undefined,
                method,
                path,
                tool: TASK_REFERENCE_TOOL,
                rch: computeRchHttp({ method, path, query: search, bodyHash }),
            });
            return {
                authInfo: JSON.stringify({
                    invocationToken: token,
                    invocationBody: { method, path, search, bodyHash, op: request.op },
                }),
            };
        },
        auditSink,
    });
}

export async function handleTaskReferenceRequest({
    req,
    res,
    plan,
    body,
    relayManager,
    toolPolicy,
    listTools = defaultListTools,
    assertionCache = taskReferenceAssertionCache,
    auditSink,
} = {}) {
    try {
        if (!plan?.ok || plan.kind !== 'task-reference' || !plan.request?.ok) {
            throw refusal(503, 'task_reference_unavailable');
        }
        const { request } = plan;
        // A browser caller is identified before its body is read; an agent's
        // assertion covers body facts (lookup's originRequestId), so its
        // body is validated first and then bound by the assertion.
        if (plan.listener !== 'private') authenticateCaller({ req, plan, request, bodyValue: null, assertionCache });
        const rawBody = body !== undefined ? Buffer.from(body) : await readBody(req);
        if (rawBody.length > BODY_MAX_BYTES) throw refusal(413, 'task_reference_body_too_large');
        const bodyValue = validateBody(request, rawBody);
        const caller = authenticateCaller({ req, plan, request, bodyValue, rawBody, assertionCache });
        if (request.op === 'descriptor') {
            await serveDescriptor({ res, plan, request, caller, toolPolicy, listTools });
            return;
        }
        await forwardToProvider({ req, res, plan, request, caller, body: rawBody, relayManager, auditSink });
    } catch (error) {
        if (res.headersSent) {
            try { res.destroy?.(); } catch (_) {}
            return;
        }
        const status = Number.isInteger(error?.status) ? error.status : 500;
        sendJson(res, status, { error: error?.code && status !== 500 ? error.code : 'task_reference_failed' });
    }
}
