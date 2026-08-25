import {
  TARGETED_DRAIN_ACKNOWLEDGEMENT,
  cleanupExactAgentRuntimeCandidate,
} from '../sandbox/docker/index.js';
import { loadActiveEdgeRoutingGeneration } from '../sandbox/edgeGeneration.js';
import {
  mergeRoutingConfig,
  mergeRuntimeRoute,
} from '../server/routingFile.js';
import * as workspaceSvc from '../utils/workspace.js';

function text(value) {
  return String(value || '').trim();
}

function exactRuntimeIdentity(record) {
  const instanceId = text(record?.instanceId);
  const enableGeneration = text(record?.enableGeneration);
  if (record?.type !== 'agent' || !instanceId || !enableGeneration) {
    throw new Error('targeted agent restart requires one complete registered runtime identity');
  }
  return Object.freeze({ instanceId, enableGeneration });
}

function sameRuntimeIdentity(record, expected) {
  return record?.type === 'agent'
    && text(record.instanceId) === expected.instanceId
    && text(record.enableGeneration) === expected.enableGeneration;
}

function sameSelector(left, right) {
  return left?.state === 'active'
    && left.generation === right.generation
    && left.activationId === right.activationId
    && left.selectorDigest === right.selectorDigest;
}

function assertExactRouteOwner(route, {
  containerName,
  repoName,
  shortAgentName,
  routeKey,
} = {}) {
  if (!route || typeof route !== 'object'
    || text(route.container) !== containerName
    || text(route.repo) !== repoName
    || text(route.agent) !== shortAgentName) {
    throw new Error(`targeted agent restart route '${routeKey}' no longer selects its exact registered owner`);
  }
  return route;
}

function affectedRouteSelectors(generation, routeKey) {
  const selectors = new Set([
    `agent-root:${routeKey}`,
    `agent-port:${routeKey}`,
  ]);
  for (const [hostname, record] of Object.entries(generation?.compiled?.hosts || {})) {
    if (text(record?.routeKey) === routeKey) selectors.add(`host:${hostname}`);
  }
  return Object.freeze([...selectors].sort());
}

function assertTransitionSelected(transition, loadActive) {
  const active = loadActive();
  if (!sameSelector(active?.selector, transition.selector)) {
    throw new Error('targeted agent restart drain generation is no longer selected');
  }
  const route = active.generation?.routing?.routes?.[transition.routeKey];
  assertExactRouteOwner(route, transition);
  if (route.draining !== true) {
    throw new Error('targeted agent restart route is no longer marked draining');
  }
  const record = active.generation?.agents?.[transition.containerName];
  if (!sameRuntimeIdentity(record, transition.identity)) {
    throw new Error('targeted agent restart predecessor identity changed during drain');
  }
  return active;
}

/**
 * Withdraw one agent's external selectors while retaining its exact runtime
 * identity and policy in the active generation. The predecessor can therefore
 * finish authenticated drain work, but the Router admits no new traffic to it.
 */
export async function prepareTargetedAgentRestart({
  containerName: containerNameInput,
  routeKey: routeKeyInput,
  repoName: repoNameInput,
  shortAgentName: shortAgentNameInput,
  record,
  networkLifecycleCapability,
} = {}, {
  mergeRouting = mergeRoutingConfig,
  loadActive = loadActiveEdgeRoutingGeneration,
  loadAgents = workspaceSvc.loadAgents,
} = {}) {
  const containerName = text(containerNameInput);
  const routeKey = text(routeKeyInput);
  const repoName = text(repoNameInput || record?.repoName);
  const shortAgentName = text(shortAgentNameInput || record?.agentName);
  if (!containerName || !routeKey || !repoName || !shortAgentName) {
    throw new Error('targeted agent restart requires its exact container, route, repository, and agent names');
  }
  const identity = exactRuntimeIdentity(record);
  let predecessorRoute = null;

  await mergeRouting((routing) => {
    const currentRecord = loadAgents()?.[containerName];
    if (!sameRuntimeIdentity(currentRecord, identity)) {
      throw new Error('targeted agent restart registry identity changed before route withdrawal');
    }
    routing.routes = routing.routes || {};
    const route = assertExactRouteOwner(routing.routes[routeKey], {
      containerName,
      repoName,
      shortAgentName,
      routeKey,
    });
    predecessorRoute = structuredClone(route);
    delete predecessorRoute.draining;
    routing.routes[routeKey] = { ...route, draining: true };
    return routing;
  }, {
    reason: `manual-targeted-restart-drain:${containerName}`,
    networkLifecycleCapability,
  });

  const active = loadActive();
  const transition = {
    containerName,
    routeKey,
    repoName,
    shortAgentName,
    identity,
    predecessorRecord: structuredClone(record),
    predecessorRoute,
    selector: Object.freeze({
      state: active.selector?.state,
      generation: active.selector?.generation,
      activationId: active.selector?.activationId,
      selectorDigest: active.selector?.selectorDigest,
    }),
  };
  assertTransitionSelected(transition, loadActive);
  const affectedSelectors = affectedRouteSelectors(active.generation, routeKey);
  const expectedSelectors = JSON.stringify(affectedSelectors);
  const assertSelectorsInactive = (payload) => {
    try {
      if (text(payload?.containerName) !== containerName
        || JSON.stringify(payload?.affectedSelectors) !== expectedSelectors) return false;
      assertTransitionSelected(transition, loadActive);
      return true;
    } catch (_) {
      return false;
    }
  };

  return Object.freeze({
    ...transition,
    targetedRestart: Object.freeze({
      acknowledgement: TARGETED_DRAIN_ACKNOWLEDGEMENT,
      affectedSelectors,
      assertSelectorsInactive,
    }),
  });
}

/** Publish the ready successor's physical locator and reopen its route. */
export async function commitTargetedAgentRestart({
  transition,
  result,
  agentPath,
  alias = '',
  networkLifecycleCapability,
} = {}, {
  mergeRouting = mergeRoutingConfig,
  mergeRoute = mergeRuntimeRoute,
  loadActive = loadActiveEdgeRoutingGeneration,
  loadAgents = workspaceSvc.loadAgents,
  saveAgents = workspaceSvc.saveAgents,
} = {}) {
  if (!transition || !result?.containerName || !result?.registryRecord) {
    throw new Error('targeted agent restart commit requires its transition and exact ready runtime');
  }
  if (text(result.containerName) !== transition.containerName
    || !sameRuntimeIdentity(result.registryRecord, transition.identity)) {
    throw new Error('targeted agent restart successor does not preserve the coordinated runtime identity');
  }
  assertTransitionSelected(transition, loadActive);

  await mergeRouting((routing) => {
    routing.routes = routing.routes || {};
    const drainingRoute = assertExactRouteOwner(routing.routes[transition.routeKey], transition);
    if (drainingRoute.draining !== true) {
      throw new Error('targeted agent restart route changed before successor commit');
    }
    const agents = loadAgents();
    if (!sameRuntimeIdentity(agents?.[transition.containerName], transition.identity)) {
      throw new Error('targeted agent restart registry identity changed before successor commit');
    }
    agents[transition.containerName] = structuredClone(result.registryRecord);
    saveAgents(agents, { coordinate: false });

    const restored = mergeRoute({
      ...transition.predecessorRoute,
      draining: false,
    }, {
      container: transition.containerName,
      hostPath: agentPath,
      repo: transition.repoName,
      agent: transition.shortAgentName,
      ...(alias ? { alias } : {}),
    }, { hostPort: result.hostPort || 0 });
    delete restored.draining;
    routing.routes[transition.routeKey] = restored;
    return routing;
  }, {
    reason: `manual-targeted-restart-ready:${transition.containerName}`,
    networkLifecycleCapability,
  });

  const active = loadActive();
  const committedRoute = active.generation?.routing?.routes?.[transition.routeKey];
  assertExactRouteOwner(committedRoute, transition);
  if (committedRoute.draining === true
    || !sameRuntimeIdentity(active.generation?.agents?.[transition.containerName], transition.identity)
    || text(active.generation?.agents?.[transition.containerName]?.containerId)
      !== text(result.registryRecord.containerId)) {
    throw new Error('targeted agent restart successor was not published exactly');
  }
  return active;
}

export function cleanupFailedTargetedAgentRestart(result, error, {
  cleanupCandidate = cleanupExactAgentRuntimeCandidate,
} = {}) {
  if (!result || result.exactCleanupPerformed === true || result.createdByThisLaunch === false) return false;
  if (!result.containerName || !result.containerId || !result.registryRecord || !result.cleanupReceipt) return false;
  try {
    cleanupCandidate(result);
    result.exactCleanupPerformed = true;
    return true;
  } catch (cleanupError) {
    if (error && typeof error === 'object') {
      error.message = `${error.message || error}; exact targeted-restart cleanup: ${cleanupError?.message || cleanupError}`;
    }
    return false;
  }
}

export const _test = Object.freeze({
  affectedRouteSelectors,
  assertTransitionSelected,
  sameRuntimeIdentity,
});
