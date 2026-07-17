import crypto from 'node:crypto';

import { signHmacJwt } from './jwtSign.mjs';
import { computeRchTool, computeRchHttp, sha256RawBodyHash } from './requestHash.mjs';
import { readAgentSecret, expectedAudienceForSelf } from './invocationAuth.mjs';

/**
 * agentAssertion.mjs — agent-side signer for the Agent Assertion JWT
 * (source agent → router, DS013 / Phase 3).
 *
 * A source agent proves its own identity to the router by signing a short-lived
 * assertion with its OWN `PLOINKY_AGENT_SECRET`. The assertion binds the
 * request surface (method, path, target agent, tool, `rch`) so the router can
 * apply MCP policy and mint a target-scoped Router Request. The router never
 * forwards this assertion onward; agent-to-agent calls are always router-mediated.
 */

const ASSERTION_TTL_SECONDS = 60;
const PRIVATE_ASSERTION_TTL_SECONDS = 30;
const PRIVATE_ROUTER_AUDIENCE = 'ploinky-private-router';

/**
 * Internal helper that builds and signs the `typ:'agent-assertion'` payload from
 * an already-computed `rch`. Both the MCP signer (`computeRchTool`) and the HTTP
 * signer (`computeRchHttp`) funnel through here so the payload shape, the
 * `tool`-optional behavior, and the empty-target/empty-secret guards stay
 * identical regardless of how `rch` was derived.
 */
function signAgentAssertionWithRch({ secret, self, method, path, targetAgent, tool, rch }) {
    if (!secret) {
        throw new Error('agentAssertion: PLOINKY_AGENT_SECRET not configured');
    }
    if (!self) {
        throw new Error('agentAssertion: PLOINKY_AGENT_ID not configured');
    }
    // The assertion MUST bind the addressed target (DS013). A target-less
    // assertion is not cryptographically tied to the agent it is sent to.
    const target = String(targetAgent ?? '').trim();
    if (!target) {
        throw new Error('agentAssertion: targetAgent is required');
    }
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
        typ: 'agent-assertion',
        iss: self,
        sub: self,
        aud: 'ploinky-router',
        targetAgent: target,
        method: String(method),
        path: String(path),
        rch,
        iat,
        exp: iat + ASSERTION_TTL_SECONDS,
        jti: crypto.randomBytes(16).toString('base64url'),
    };
    if (tool !== undefined && tool !== null && String(tool) !== '') {
        payload.tool = String(tool);
    }
    return signHmacJwt({ payload, secret });
}

export function signAgentAssertion({
    method = 'POST',
    path = '/mcp',
    targetAgent,
    tool,
    argumentsObj = {},
    env = process.env,
}) {
    // MCP transport: the signed surface is {method, path, tool, arguments}.
    const rch = computeRchTool({ method, path, tool, arguments: argumentsObj });
    return signAgentAssertionWithRch({
        secret: readAgentSecret(env),
        self: expectedAudienceForSelf(env),
        method,
        path,
        targetAgent,
        tool,
        rch,
    });
}

/**
 * HTTP-surface signer for agent-to-agent OpenAI calls. The signed `rch` binds the
 * exact raw request body bytes (`sha256RawBodyHash(body)`) plus method/path/query,
 * NOT a canonical-JSON argument set — so this path uses `computeRchHttp`, never
 * `computeRchTool`. The router verifies against the same buffered bytes before it
 * proxies and mints its own Router Request token.
 */
export function signAgentHttpAssertion({
    method = 'POST',
    path,
    query = '',
    body = Buffer.alloc(0),
    targetAgent,
    tool,
    env = process.env,
}) {
    const bodyHash = sha256RawBodyHash(body);
    const rch = computeRchHttp({ method, path, query, bodyHash });
    return signAgentAssertionWithRch({
        secret: readAgentSecret(env),
        self: expectedAudienceForSelf(env),
        method,
        path,
        targetAgent,
        tool,
        rch,
    });
}

/**
 * Sign a box-private Router request. This capability deliberately does not
 * reuse the stable DS013 PLOINKY_AGENT_SECRET: disable/re-enable and instance
 * replacement rotate PLOINKY_AGENT_PRIVATE_SECRET, while the bound instance
 * and enable generation let the Router compare the assertion with its captured
 * current registry before dialing a private service.
 */
export function signPrivateRouterAssertion({
    method = 'POST',
    path,
    query = '',
    body = Buffer.alloc(0),
    audience = PRIVATE_ROUTER_AUDIENCE,
    env = process.env,
} = {}) {
    const encodedSecret = String(env?.PLOINKY_AGENT_PRIVATE_SECRET || '').trim();
    const self = String(env?.PLOINKY_AGENT_ID || '').trim();
    const instanceId = String(env?.PLOINKY_AGENT_INSTANCE_ID || '').trim();
    const enableGeneration = String(env?.PLOINKY_AGENT_ENABLE_GENERATION || '').trim();
    const normalizedPath = String(path || '').trim();
    const normalizedMethod = String(method || '').trim().toUpperCase();
    const normalizedAudience = String(audience || '').trim();
    if (!/^[a-f0-9]{64}$/i.test(encodedSecret)) {
        throw new Error('agentAssertion: PLOINKY_AGENT_PRIVATE_SECRET must be a 32-byte hex secret');
    }
    if (!self) throw new Error('agentAssertion: PLOINKY_AGENT_ID not configured');
    if (!instanceId) throw new Error('agentAssertion: PLOINKY_AGENT_INSTANCE_ID not configured');
    if (!enableGeneration) throw new Error('agentAssertion: PLOINKY_AGENT_ENABLE_GENERATION not configured');
    if (!normalizedPath.startsWith('/')) throw new Error('agentAssertion: private path is required');
    if (!normalizedMethod || !normalizedAudience) throw new Error('agentAssertion: private method and audience are required');
    const bodyHash = sha256RawBodyHash(body);
    const rch = computeRchHttp({ method: normalizedMethod, path: normalizedPath, query, bodyHash });
    const iat = Math.floor(Date.now() / 1000);
    return signHmacJwt({
        secret: Buffer.from(encodedSecret, 'hex'),
        payload: {
            typ: 'private-agent-assertion',
            iss: self,
            sub: self,
            aud: normalizedAudience,
            instanceId,
            enableGeneration,
            method: normalizedMethod,
            path: normalizedPath,
            rch,
            iat,
            exp: iat + PRIVATE_ASSERTION_TTL_SECONDS,
            jti: crypto.randomBytes(16).toString('base64url'),
        },
    });
}

export default {
    signAgentAssertion,
    signAgentHttpAssertion,
    signPrivateRouterAssertion,
};
