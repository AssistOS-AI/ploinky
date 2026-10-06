import { parseQualifiedAgentReference, resolveEnabledAgentRecordFromMap } from './agentRegistryResolver.js';

/**
 * agentTargetResolver.js
 *
 * Pure resolution of one agent reference against an already-loaded active
 * edge-generation snapshot ({ routing, agents }). It performs no I/O and never
 * mutates the snapshot (the active generation is deeply frozen), so a Router
 * request can derive an agent's identity from the same generation it routes
 * with instead of scanning installed repositories.
 *
 * Lookup order:
 *   1. a bare reference that is a route key carrying `repo` and `agent`;
 *   2. a qualified `repo/agent` or `repo:agent` reference: the routes carrying
 *      that repo and agent (distinct host paths are ambiguous), else an enabled
 *      record for that repo and agent;
 *   3. a bare reference naming the static agent: the static container's record;
 *   4. the enabled-record resolver over `snapshot.agents` (same precedence and
 *      ambiguity rules as operator references);
 *   5. nothing.
 *
 * Agent alias instances never resolve for a bare reference. An alias route
 * (or alias record) is a separate instance of a base agent that shares the base
 * agent's repo/agent identity; minting that identity for it would let a grant
 * for the base agent authorize calls to the alias instance. A bare reference
 * therefore resolves only when it names the agent itself on a non-alias route
 * or record, which keeps alias routes refusing provider-principal resolution.
 */

export const AGENT_TARGET_AMBIGUOUS = 'AGENT_TARGET_AMBIGUOUS';

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object';
}

function ownEntry(map, key) {
    if (!key || !isObject(map) || !Object.hasOwn(map, key)) return null;
    const value = map[key];
    return isObject(value) ? value : null;
}

function ambiguousTarget(agentRef, detail) {
    const error = new Error(`agentTargetResolver: agent reference '${agentRef}' is ambiguous${detail ? ` (${detail})` : ''}`);
    error.code = AGENT_TARGET_AMBIGUOUS;
    return error;
}

function makeTarget(repo, agent, routeKey, hostPath) {
    return { repo: text(repo), agent: text(agent), routeKey: routeKey || null, hostPath: text(hostPath) };
}

// A bare reference reaches an alias instance when the route or the record it
// resolves through carries an alias, or when the reference is not the agent's
// own name (route keys and registry aliases differ from the agent name only
// through aliasing).
function isAliasResolution(agentRef, { route, record, agentName }) {
    return Boolean(text(route?.alias) || text(record?.alias) || agentRef !== text(agentName));
}

function resolveQualified(agentRef, { repoName, agentName }, routes, agents) {
    const matches = Object.entries(routes).filter(([, route]) => isObject(route)
        && text(route.repo) === repoName && text(route.agent) === agentName);
    if (matches.length) {
        // The base agent's routes describe it; alias instances only when no
        // base route exists.
        const baseRoutes = matches.filter(([, route]) => !text(route.alias));
        const candidates = baseRoutes.length ? baseRoutes : matches;
        const hostPaths = new Set(candidates.map(([, route]) => text(route.hostPath)));
        if (hostPaths.size > 1) throw ambiguousTarget(agentRef, 'routes with different host paths');
        const [routeKey, route] = candidates.find(([key]) => key === agentName) || candidates[0];
        return makeTarget(repoName, agentName, routeKey, route.hostPath);
    }
    const enabled = Object.values(agents).some((record) => isObject(record)
        && record.type === 'agent'
        && text(record.repoName) === repoName
        && text(record.agentName) === agentName);
    return enabled ? makeTarget(repoName, agentName, null, '') : null;
}

export function resolveAgentTargetFromSnapshot(agentRef, snapshot) {
    const ref = text(agentRef);
    if (!ref || !isObject(snapshot)) return null;
    const routing = isObject(snapshot.routing) ? snapshot.routing : {};
    const routes = isObject(routing.routes) ? routing.routes : {};
    const agents = isObject(snapshot.agents) ? snapshot.agents : {};

    const qualification = parseQualifiedAgentReference(ref);
    if (qualification.malformed) return null;
    if (qualification.qualified) return resolveQualified(ref, qualification, routes, agents);

    // (1) The route the reference names.
    const route = ownEntry(routes, ref);
    if (route && text(route.repo) && text(route.agent)) {
        const record = ownEntry(agents, text(route.container));
        if (isAliasResolution(ref, { route, record, agentName: route.agent })) return null;
        return makeTarget(route.repo, route.agent, ref, route.hostPath);
    }

    // (3) The static agent, through its container record.
    const staticConfig = isObject(routing.static) ? routing.static : null;
    if (staticConfig && text(staticConfig.agent) === ref) {
        const record = ownEntry(agents, text(staticConfig.container));
        if (record && record.type === 'agent' && text(record.repoName) && text(record.agentName)) {
            if (isAliasResolution(ref, { route, record, agentName: record.agentName })) return null;
            return makeTarget(record.repoName, record.agentName, route ? ref : null,
                text(route?.hostPath) || text(staticConfig.hostPath));
        }
    }

    // (4) The enabled-record resolver.
    let resolved;
    try {
        resolved = resolveEnabledAgentRecordFromMap(ref, agents);
    } catch (error) {
        if (error?.code === 'AGENT_ALIAS_AMBIGUOUS') throw ambiguousTarget(ref, 'multiple enabled records');
        throw error;
    }
    const record = resolved?.record;
    if (!record || !text(record.repoName) || !text(record.agentName)) return null;
    if (isAliasResolution(ref, { route, record, agentName: record.agentName })) return null;
    return makeTarget(record.repoName, record.agentName, route ? ref : null, route?.hostPath);
}

export default {
    AGENT_TARGET_AMBIGUOUS,
    resolveAgentTargetFromSnapshot,
};
