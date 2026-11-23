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

class LaunchBoundRouterRequestTokenService extends RouterRequestTokenService {
    _payload(input) {
        const result = super._payload(input);
        if (input.launchId) result.payload.launchId = input.launchId;
        return result;
    }
}

const routerRequestTokenService = new LaunchBoundRouterRequestTokenService({
    resolveAgentSecret: (targetAgentId) => deriveAgentRequestSecret(targetAgentId, { encoding: 'buffer' }),
});

const agentAssertionService = new AgentAssertionService({
    resolveAgentSecret: (sourceAgentId) => deriveAgentRequestSecret(sourceAgentId, { encoding: 'buffer' }),
});

// The active generation's snapshot, or null when no generation is active.
function tryLoadActiveSnapshot({ forMint = false } = {}) {
    try {
        return loadActiveRoutingState().snapshot || null;
    } catch (error) {
        if (forMint && error?.code !== 'EDGE_GENERATION_INACTIVE') throw error;
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

function routeInSnapshot(snapshot, routeKey) {
    const routes = snapshot?.routing?.routes;
    return routes && Object.hasOwn(routes, routeKey) ? routes[routeKey] : undefined;
}

// A generation digest survives cache reconstruction. The route key and
// container select the dial target within that immutable generation.
export function resolveRouteTargetRecord({ routeKey, route, generation, snapshot } = {}) {
    const expectedGeneration = generation ?? snapshot?.generation;
    // A host-port-only dial supplies no container selection. The issuer
    // still requires a selected record if this principal has a launch ID.
    if (route && !route.container && expectedGeneration === undefined) return undefined;
    const active = expectedGeneration === undefined && snapshot ? snapshot : tryLoadActiveSnapshot({ forMint: true });
    const currentRoute = routeInSnapshot(active, routeKey);
    if (expectedGeneration !== undefined && (!expectedGeneration || expectedGeneration !== active?.generation
        || (snapshot && snapshot.generation !== expectedGeneration))) {
        throw new Error('invocationMinter: selected route generation changed');
    }
    // A raw route has no digest. When the caller omits its generation, the
    // route must belong to the selection snapshot (or the current snapshot).
    if (route && ((generation === undefined && route !== routeInSnapshot(snapshot ?? active, routeKey))
        || (route.routeKey !== undefined && route.routeKey !== routeKey)
        || !currentRoute || (currentRoute.container ?? '') !== (route.container ?? ''))) {
        throw new Error('invocationMinter: selected route generation changed');
    }
    const selected = route ?? currentRoute;
    if (!selected?.container) return undefined;
    const agents = active.agents;
    if (!agents || !Object.hasOwn(agents, selected.container) || !agents[selected.container]) {
        throw new Error('invocationMinter: selected target container missing');
    }
    return agents[selected.container];
}

// The audience identifies the agent principal. Aliases and a canary can share
// it. Prefer the record chosen for the dial; principal-only callers may use a
// unique record from the snapshot they used to select the target. Loading a
// newer generation by principal could sign for a same-name replacement.
function requestLaunchId(targetAgentId, { targetRecord, routeDefinition, snapshot }) {
    const matchesPrincipal = record => record?.type === 'agent'
        && `agent:${record.repoName}/${record.agentName}` === targetAgentId;
    let record = targetRecord;
    if (record === undefined) {
        if (routeDefinition?.route?.container) {
            record = resolveRouteTargetRecord({ routeKey: routeDefinition.routeKey, route: routeDefinition.route, snapshot });
        } else {
            const generation = snapshot ?? tryLoadActiveSnapshot({ forMint: true });
            const agents = generation?.agents;
            if (!agents) return undefined;
            const matches = Object.values(agents).filter(matchesPrincipal);
            if (!matches.some(candidate => candidate.launchId !== undefined)) return undefined;
            if (!snapshot || matches.length !== 1) {
                throw new Error('invocationMinter: selected target record required for launch-bound agent');
            }
            [record] = matches;
        }
    }
    if (!matchesPrincipal(record)) throw new Error('invocationMinter: target record principal mismatch');
    if (record.launchId !== undefined && (typeof record.launchId !== 'string' || !record.launchId)) {
        throw new Error('invocationMinter: invalid launchId in target record');
    }
    return record.launchId;
}

/**
 * Mint a Router Request JWT (router -> target agent), signed with the target
 * agent's own secret. The caller computes `rch` over the exact request surface
 * the target will execute; the target recomputes and rejects any mismatch.
 */
export function buildRouterRequest({
    targetAgentId,
    targetRecord,
    routeDefinition,
    snapshot,
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
        launchId: requestLaunchId(targetAgentId, { targetRecord, routeDefinition, snapshot }),
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
