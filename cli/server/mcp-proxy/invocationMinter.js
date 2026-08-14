import { deriveAgentRequestSecret } from '../../utils/security/masterKey.js';
import { resolveAgentDescriptor } from '../../utils/agentRegistry.js';
import {
    AgentAssertionService,
    RouterRequestTokenService,
} from '../security/tokens/index.js';

/**
 * invocationMinter.js (router side)
 *
 * The router is the sole issuer of Router Request JWTs (typ:"router-request").
 * Each is signed with the TARGET agent's own per-agent secret and bound to one
 * concrete request via `rch` (request-content-hash), so a token minted for one
 * agent/operation cannot be replayed against another. The legacy shared-key
 * `typ:"invocation"` families are removed; the DS014 per-agent model replaces them.
 *
 * `verifyAgentAssertion` authenticates a source agent for agent-to-agent calls by
 * deriving THAT agent's secret from its (untrusted) issuer claim and verifying
 * the assertion — an agent cannot forge an assertion for another agent because it
 * does not hold that agent's secret.
 */

const routerRequestTokenService = new RouterRequestTokenService({
    resolveAgentSecret: (targetAgentId) => deriveAgentRequestSecret(targetAgentId, { encoding: 'buffer' }),
});

const agentAssertionService = new AgentAssertionService({
    resolveAgentSecret: (sourceAgentId) => deriveAgentRequestSecret(sourceAgentId, { encoding: 'buffer' }),
});

export function resolveProviderPrincipal({ providerAgentRef, providerPrincipal }) {
    if (providerPrincipal) return String(providerPrincipal).trim();
    const descriptor = resolveAgentDescriptor(providerAgentRef);
    if (!descriptor) {
        throw new Error(`invocationMinter: could not resolve provider '${providerAgentRef}'`);
    }
    return descriptor.principalId;
}

/**
 * Mint a Router Request JWT (router -> target agent), signed with the target
 * agent's own secret. The caller computes `rch` over the exact request surface
 * the target will execute; the target recomputes and rejects any mismatch.
 */
export function buildRouterRequest({
    targetAgentId,
    sub,
    actor,
    caller,
    usr,
    scope,
    delegation,
    delegations,
    method,
    path,
    tool,
    rch,
    ttlSeconds,
}) {
    return routerRequestTokenService.mintWithPayloadSync({
        targetAgentId,
        sub,
        actor,
        caller,
        usr,
        scope,
        delegation,
        delegations,
        method,
        path,
        tool,
        rch,
        ttlSeconds,
    });
}

/**
 * Verify an Agent Assertion JWT presented by a source agent for an
 * agent-to-agent call. The issuer claim is UNTRUSTED until verified: the router
 * derives the claimed agent's per-agent secret and verifies the signature with
 * it, so an agent that only knows its own secret cannot forge an assertion for
 * another agent. The assertion is bound to this exact request (method/path/tool/
 * `rch`) and, when provided, to the intended target agent.
 *
 * `token` is the raw assertion; `method`/`path`/`tool`/`rch` describe the actual
 * request; `targetAgentId` is the resolved target principal; `replayCache`
 * prevents reuse. Returns `{ callerPrincipal, payload }`.
 */
export function verifyAgentAssertion({ token, method, path, tool, rch, targetAgentId, replayCache }) {
    return agentAssertionService.verifySync({ token, method, path, tool, rch, targetAgentId, replayCache });
}

export default {
    buildRouterRequest,
    resolveProviderPrincipal,
    verifyAgentAssertion
};
