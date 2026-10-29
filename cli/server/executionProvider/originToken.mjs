import crypto from 'node:crypto';

import { canonicalJson, sha256b64url } from '../../../Agent/lib/requestHash.mjs';
import { JwsCodec } from '../security/tokens/JwsCodec.js';
import { deriveAgentRequestSecret } from '../../utils/security/masterKey.js';
import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
import { readExecutionProviderDeclaration } from './declaration.mjs';
import { loadActiveRoutingState } from '../routingState.js';

// The Router origin token of an MCP-forwarded task-reference admission. The
// Router alone computes the canonical caller key from the verified direct
// caller and mints, for the declared provider, a short-lived Router Request
// that binds {originKey, originRequestId, agent, tool}. The provider verifies
// it with its own secret, recomputes `rch` from the admission and consumes
// its `jti`. Nothing in it is taken from request content except the
// caller-chosen `originRequestId`, whose grammar is fixed.

export const TASK_REFERENCE_ORIGIN_TOOL = '__task_ref_origin__';
export const TASK_REFERENCE_ORIGIN_METHOD = 'ORIGIN';
export const TASK_REFERENCE_ORIGIN_PATH = '/origin';
export const TASK_REFERENCE_ORIGIN_TTL_SECONDS = 30;
export const TASK_REFERENCE_ANNOTATION = 'ploinkyTaskReference';
const ORIGIN_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const AGENT_PRINCIPAL_PATTERN = /^agent:[^\s/:]+\/[^\s/:]+$/;

const jwsCodec = new JwsCodec();

export function isOriginRequestId(value) {
    return typeof value === 'string' && ORIGIN_REQUEST_ID_PATTERN.test(value);
}

// `user:<id>` for a direct non-guest user (the id without a duplicated
// `user:` prefix) or the verified agent principal `agent:<repo>/<agent>` for
// an agent caller. A delegation carried by an agent never enters the key.
// Returns '' when no verified caller can be named.
export function canonicalOriginCallerKey(req) {
    const delegated = req?.delegatedAgentVerified && typeof req.delegatedAgentVerified === 'object'
        ? req.delegatedAgentVerified
        : null;
    if (delegated) {
        const principal = String(delegated.callerPrincipal || '').trim();
        return AGENT_PRINCIPAL_PATTERN.test(principal) ? principal : '';
    }
    const user = req?.user && typeof req.user === 'object' ? req.user : null;
    const id = String(user?.id || '').trim().replace(/^user:/i, '');
    if (!id || id.startsWith('guest:')) return '';
    const roles = Array.isArray(user.roles) ? user.roles.map((role) => String(role || '').trim().toLowerCase()) : [];
    if (roles.includes('guest')) return '';
    return `user:${id}`;
}

// The bound origin and its `rch`: SHA-256 (base64url) of the canonical JSON of
// exactly these four values. They travel as the `origin` claim, because the
// token's own `tool` claim names the origin purpose.
export function taskReferenceOriginBinding({ originKey, originRequestId, agent, tool }) {
    const origin = {
        originKey: String(originKey || ''),
        originRequestId: String(originRequestId || ''),
        agent: String(agent || ''),
        tool: String(tool || ''),
    };
    return { origin, rch: sha256b64url(canonicalJson(origin)) };
}

export function mintTaskReferenceOriginToken({
    providerPrincipal,
    originKey,
    originRequestId,
    agent,
    tool,
    now = new Date(),
    resolveSecret = (target) => deriveAgentRequestSecret(target, { encoding: 'buffer' }),
}) {
    const aud = String(providerPrincipal || '').trim();
    if (!AGENT_PRINCIPAL_PATTERN.test(aud)) throw new Error('origin token: provider principal required');
    if (!String(originKey || '').trim()) throw new Error('origin token: caller key required');
    if (!isOriginRequestId(originRequestId)) throw new Error('origin token: originRequestId must be 22 base64url characters');
    if (!String(agent || '').trim() || !String(tool || '').trim()) throw new Error('origin token: agent and tool required');
    const { origin, rch } = taskReferenceOriginBinding({ originKey, originRequestId, agent, tool });
    const iat = Math.floor(now.getTime() / 1000);
    const payload = {
        typ: 'router-request',
        iss: 'ploinky-router',
        aud,
        sub: origin.originKey,
        method: TASK_REFERENCE_ORIGIN_METHOD,
        path: TASK_REFERENCE_ORIGIN_PATH,
        tool: TASK_REFERENCE_ORIGIN_TOOL,
        rch,
        origin,
        jti: crypto.randomBytes(16).toString('base64url'),
        iat,
        exp: iat + TASK_REFERENCE_ORIGIN_TTL_SECONDS,
    };
    const token = jwsCodec.sign({ payload, secret: resolveSecret(aud) });
    return { token, payload };
}

// The provider principal of an enabled route whose admitted manifest declares
// task references, or '' (an undeclared, disabled or draining provider never
// receives an origin token).
export function declaredTaskReferenceProvider(snapshot, providerRouteKey) {
    const key = String(providerRouteKey || '').trim();
    const route = snapshot?.routing?.routes?.[key];
    if (!key || !route || route.disabled || route.draining) return '';
    const read = readExecutionProviderDeclaration(snapshot?.manifests?.[key], { routeKey: key });
    if (!read.present || !read.valid || !read.declaration.taskReferences) return '';
    try {
        return deriveAgentPrincipalId(String(route.repo || ''), String(route.agent || ''));
    } catch {
        return '';
    }
}

// The principal of the enabled route that serves the tool, or ''.
function toolAgentPrincipal(snapshot, agentRouteKey) {
    const route = snapshot?.routing?.routes?.[String(agentRouteKey || '').trim()];
    if (!route || route.disabled) return '';
    try {
        return deriveAgentPrincipalId(String(route.repo || ''), String(route.agent || ''));
    } catch {
        return '';
    }
}

// The origin token for one forwarded MCP tool call, or null when the tool is
// not a task-reference tool. `toolListing` is the Router's own listing entry
// for the tool; a task-reference tool whose provider is not an enabled
// declared provider, whose call lacks a valid `originRequestId`, or whose
// caller or serving agent cannot be named gets no token, and the provider
// then refuses the admission explicitly. The bound `agent` is the serving
// agent's principal, so the provider can compare it with the verified
// `caller` of the coordinator hop that presents the token.
export function buildTaskReferenceOriginForToolCall({ req, agentName, toolName, toolArgs, toolListing, snapshot, now }) {
    const annotation = toolListing?.annotations?.[TASK_REFERENCE_ANNOTATION];
    if (!annotation || typeof annotation !== 'object' || annotation.version !== 1) return null;
    snapshot = snapshot || activeSnapshot();
    const providerPrincipal = declaredTaskReferenceProvider(snapshot, annotation.provider);
    const agent = toolAgentPrincipal(snapshot, agentName);
    const originKey = canonicalOriginCallerKey(req);
    const originRequestId = toolArgs?.originRequestId;
    if (!providerPrincipal || !agent || !originKey || !isOriginRequestId(originRequestId)) return null;
    return mintTaskReferenceOriginToken({
        providerPrincipal,
        originKey,
        originRequestId,
        agent,
        tool: String(toolName || ''),
        now,
    }).token;
}

function activeSnapshot() {
    try {
        return loadActiveRoutingState().snapshot || null;
    } catch {
        return null;
    }
}

// The trusted header of one forwarded MCP tool call: `{taskRefOrigin}` in
// `x-ploinky-auth-info` for a task-reference tool, otherwise nothing. Used by
// every Router path that forwards a tools/call to an agent.
export function taskReferenceOriginHeaders(input) {
    const token = buildTaskReferenceOriginForToolCall(input);
    return token ? { 'x-ploinky-auth-info': JSON.stringify({ taskRefOrigin: token }) } : {};
}

// The serving agent's own listing entry for `toolName`, or null.
export function findToolListing(tools, toolName) {
    return (Array.isArray(tools) ? tools : []).find((tool) => tool && tool.name === toolName) || null;
}
