import { deriveAgentRequestSecret } from '../../utils/security/masterKey.js';
import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
import { describeAgent } from '../../utils/agentRegistry.js';
import { parseQualifiedAgentReference } from '../../utils/agentRegistryResolver.js';
import { AGENT_TARGET_AMBIGUOUS, resolveAgentTargetFromSnapshot } from '../../utils/agentTargetResolver.js';
import { loadActiveRoutingState } from '../routingState.js';
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
 * `typ:"invocation"` families are removed; the DS015 per-agent model replaces them.
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

// The active generation's snapshot, or null when no generation is active.
function tryLoadActiveSnapshot() {
    try {
        return loadActiveRoutingState().snapshot || null;
    } catch (_) {
        return null;
    }
}

function unresolvedProvider(providerAgentRef, cause) {
    const suffix = cause?.code === AGENT_TARGET_AMBIGUOUS ? `: ${cause.message}` : '';
    const error = new Error(`invocationMinter: could not resolve provider '${providerAgentRef}'${suffix}`);
    if (cause?.code) error.code = cause.code;
    return error;
}

/**
 * The provider principal comes from the active route: the generation the
 * Router routes with names the target's repo/agent, which is the identity the
 * agent was launched with. `snapshot` is the caller's lease snapshot; without
 * one the active generation is loaded. No installed-repository scan runs.
 * A bare reference that resolves to no route or enabled record, or only to an
 * agent alias instance, is refused; a qualified reference without a route or
 * record falls back to that one agent's installed manifest, by the exact
 * parsed repo/agent pair (never re-read as a bare name).
 */
export function resolveProviderPrincipal({ providerAgentRef, providerPrincipal, snapshot } = {}) {
    if (providerPrincipal) return String(providerPrincipal).trim();
    const ref = typeof providerAgentRef === 'string' ? providerAgentRef.trim() : '';
    if (!ref) throw unresolvedProvider(providerAgentRef);
    const activeSnapshot = snapshot ?? tryLoadActiveSnapshot();
    let target;
    try {
        target = resolveAgentTargetFromSnapshot(ref, activeSnapshot);
    } catch (error) {
        throw unresolvedProvider(providerAgentRef, error);
    }
    if (target) {
        try {
            return deriveAgentPrincipalId(target.repo, target.agent);
        } catch (_) {
            throw unresolvedProvider(providerAgentRef);
        }
    }
    const qualification = parseQualifiedAgentReference(ref);
    if (qualification.qualified && !qualification.malformed) {
        const descriptor = describeAgent(qualification.repoName, qualification.agentName, { snapshot: activeSnapshot });
        if (descriptor?.principalId) return descriptor.principalId;
    }
    throw unresolvedProvider(providerAgentRef);
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
