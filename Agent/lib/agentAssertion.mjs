import crypto from 'node:crypto';

import { signHmacJwt } from './jwtSign.mjs';
import { computeRchTool } from './requestHash.mjs';
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

export function signAgentAssertion({
    method = 'POST',
    path = '/mcp',
    targetAgent,
    tool,
    argumentsObj = {},
    env = process.env,
}) {
    const secret = readAgentSecret(env);
    if (!secret) {
        throw new Error('agentAssertion: PLOINKY_AGENT_SECRET not configured');
    }
    const self = expectedAudienceForSelf(env);
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
    const rch = computeRchTool({ method, path, tool, arguments: argumentsObj });
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

export default {
    signAgentAssertion,
};
