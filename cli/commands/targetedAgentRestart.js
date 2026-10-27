import {
  TARGETED_DRAIN_ACKNOWLEDGEMENT,
  cleanupExactAgentRuntimeCandidate,
  normalizeAcceptedFailedDrain,
} from '../sandbox/docker/index.js';
import {
  abortEdgeRoutingPreparation,
  commitAdditiveEdgeRoutingGeneration,
  commitWithdrawalEdgeRoutingGeneration,
  edgeWithdrawalRefusalDisposition,
  loadActiveEdgeRoutingGeneration,
  prepareWithdrawnReplacementEdgeRoutingGeneration,
  withEdgeGenerationApplyLock,
} from '../sandbox/edgeGeneration.js';
import { retireRuntimeCandidate } from '../sandbox/runtimeCandidateStore.js';
import {
  mergeRoutingConfig,
  mergeRuntimeRoute,
  readRoutingConfig,
} from '../server/routingFile.js';
import * as workspaceSvc from '../utils/workspace.js';
import { retireSameTupleAfterApply } from './hardwareAvailabilityRetirement.js';
import { loadRestartFaultHooks } from '../utils/testFaultHooks.js';

export const ACCEPT_FAILED_DRAIN_FLAG = '--accept-failed-drain';
const RESTART_USAGE = `Usage: restart [router | <agent> [${ACCEPT_FAILED_DRAIN_FLAG} <container-id>]]`;

function text(value) {
  return String(value || '').trim();
}

/**
 * Parse `restart` arguments. The agent is the first argument; the only
 * option is the operator's acceptance of one refused drain, which must name
 * the full immutable ID of the stopped predecessor it accepts.
 */
export function parseTargetedRestartArguments(options = []) {
  const tokens = options.map((value) => text(value));
  const target = tokens[0] || '';
  if (target.startsWith('-')) throw new Error(RESTART_USAGE);
  let acceptedFailedDrain = null;
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index] !== ACCEPT_FAILED_DRAIN_FLAG) continue;
    if (acceptedFailedDrain) throw new Error(`${ACCEPT_FAILED_DRAIN_FLAG} was supplied more than once`);
    const containerId = tokens[index + 1] || '';
    if (!/^[a-f0-9]{64}$/.test(containerId)) {
      throw new Error(`${ACCEPT_FAILED_DRAIN_FLAG} requires the full 64-hex ID of the stopped predecessor container. ${RESTART_USAGE}`);
    }
    acceptedFailedDrain = Object.freeze({ containerId });
    index += 1;
  }
  if (acceptedFailedDrain && (!target || target.toLowerCase() === 'router')) {
    throw new Error(`${ACCEPT_FAILED_DRAIN_FLAG} applies only to a named agent. ${RESTART_USAGE}`);
  }
  return Object.freeze({ target, acceptedFailedDrain });
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

function assertAcceptedFailedDrain({ acceptedFailedDrain, record, currentRecord, route, routeKey, containerName }) {
  if (!acceptedFailedDrain) return;
  // Acceptance answers one earlier refusal; it never starts a new drain.
  let message = '';
  if (route.draining !== true) {
    message = `targeted agent restart route '${routeKey}' has no refused targeted drain to accept`;
  } else if (text(currentRecord.containerId) !== acceptedFailedDrain.containerId
    || text(record.containerId) !== acceptedFailedDrain.containerId) {
    message = `the accepted container ${acceptedFailedDrain.containerId} is not the registered predecessor of '${containerName}'`;
  }
  if (message) {
    const error = new Error(message);
    error.code = 'TARGETED_DRAIN_INVALID';
    throw error;
  }
}

// The inactive merge's hold, present only while a test fault hook asks for it.
function holdOption(hooks) {
  return hooks?.holdInactiveMs > 0
    ? {
      holdInactiveMs: hooks.holdInactiveMs,
      ...(typeof hooks.stillActive === 'function' ? { holdContinues: hooks.stillActive } : {}),
    }
    : {};
}

// Withdraw the route from the active generation by an operator drain (W8,
// D3): the selector stays active and every other route stays served. Returns
// the route as it was before the drain.
function withdrawTargetedRoute({ containerName, routeKey, repoName, shortAgentName, identity, record, acceptedFailedDrain }, {
  loadActive = loadActiveEdgeRoutingGeneration,
  loadAgents = workspaceSvc.loadAgents,
  withApplyLock = withEdgeGenerationApplyLock,
  commitWithdrawal = commitWithdrawalEdgeRoutingGeneration,
} = {}) {
  return withApplyLock((applyLockCapability) => {
    const active = loadActive();
    const route = assertExactRouteOwner(active.generation?.routing?.routes?.[routeKey], {
      containerName,
      repoName,
      shortAgentName,
      routeKey,
    });
    const currentRecord = loadAgents()?.[containerName];
    if (!sameRuntimeIdentity(currentRecord, identity)) {
      throw new Error('targeted agent restart registry identity changed before route withdrawal');
    }
    assertAcceptedFailedDrain({ acceptedFailedDrain, record, currentRecord, route, routeKey, containerName });
    const predecessorRoute = structuredClone(route);
    delete predecessorRoute.draining;
    commitWithdrawal({
      withdraw: [{ containerName, mode: 'drain' }],
      reason: `manual-targeted-restart-drain:${containerName}`,
      applyLockCapability,
    });
    return predecessorRoute;
  });
}

// Reopen a withdrawn route with its ready successor active to active (W8,
// D4): the successor is prepared beside the drained predecessor and committed
// through the additive checks in one apply-lock hold.
function reopenTargetedRoute(transition, buildRoute, result, {
  readRouting = readRoutingConfig,
  loadAgents = workspaceSvc.loadAgents,
  withApplyLock = withEdgeGenerationApplyLock,
  prepareWithdrawn = prepareWithdrawnReplacementEdgeRoutingGeneration,
  commitAdditive = commitAdditiveEdgeRoutingGeneration,
  abortPreparation = abortEdgeRoutingPreparation,
} = {}) {
  return withApplyLock((applyLockCapability) => {
    const routing = readRouting();
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
    const prepared = prepareWithdrawn({
      containerName: transition.containerName,
      agents,
      reason: `manual-targeted-restart-ready:${transition.containerName}`,
      applyLockCapability,
    });
    routing.routes[transition.routeKey] = buildRoute();
    try {
      return commitAdditive(prepared.preparationLease, { routing, agents, applyLockCapability });
    } catch (error) {
      // The drained predecessor stays active; release the preparation so the
      // inactive commit can still take over.
      try { abortPreparation(prepared.preparationLease, { reason: 'manual-targeted-restart-reopen-failed', applyLockCapability }); } catch (_) {}
      throw error;
    }
  });
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
  acceptedFailedDrain: acceptedFailedDrainInput = null,
} = {}, {
  mergeRouting = mergeRoutingConfig,
  loadActive = loadActiveEdgeRoutingGeneration,
  loadAgents = workspaceSvc.loadAgents,
  withdrawRoute = withdrawTargetedRoute,
  faultHooks = loadRestartFaultHooks,
} = {}) {
  const hooks = faultHooks();
  const containerName = text(containerNameInput);
  const routeKey = text(routeKeyInput);
  const repoName = text(repoNameInput || record?.repoName);
  const shortAgentName = text(shortAgentNameInput || record?.agentName);
  if (!containerName || !routeKey || !repoName || !shortAgentName) {
    throw new Error('targeted agent restart requires its exact container, route, repository, and agent names');
  }
  const identity = exactRuntimeIdentity(record);
  const acceptedFailedDrain = normalizeAcceptedFailedDrain(acceptedFailedDrainInput);
  let predecessorRoute = null;

  try {
    // Test-only: an unprovable withdrawal takes the same fallback as a real one.
    if (hooks?.forceUnprovableWithdrawal) throw new Error('test fault hook: withdrawal forced unprovable');
    predecessorRoute = await withdrawRoute({ containerName, routeKey, repoName, shortAgentName, identity, record, acceptedFailedDrain });
  } catch (error) {
    // An invalid acceptance must never fall through to another mutation path.
    if (error?.code === 'TARGETED_DRAIN_INVALID') throw error;
    // Contention is the caller's to retry; a withdrawal that cannot be proven
    // takes the inactive drain below (D7).
    if (edgeWithdrawalRefusalDisposition(error) === 'defer') throw error;
    predecessorRoute = null;
  }

  if (!predecessorRoute) await mergeRouting((routing) => {
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
    assertAcceptedFailedDrain({ acceptedFailedDrain, record, currentRecord, route, routeKey, containerName });
    predecessorRoute = structuredClone(route);
    delete predecessorRoute.draining;
    routing.routes[routeKey] = { ...route, draining: true };
    return routing;
  }, {
    reason: `manual-targeted-restart-drain:${containerName}`,
    networkLifecycleCapability,
    ...holdOption(hooks),
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
      ...(acceptedFailedDrain ? { acceptedFailedDrain } : {}),
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
  mergeRouting: mergeRoutingDependency = mergeRoutingConfig,
  mergeRoute = mergeRuntimeRoute,
  loadActive = loadActiveEdgeRoutingGeneration,
  loadAgents = workspaceSvc.loadAgents,
  saveAgents = workspaceSvc.saveAgents,
  retireCandidate = retireRuntimeCandidate,
  retireEntriesAfterApply = retireSameTupleAfterApply,
  reportRetirementFailure = (error) => console.warn(`[edge] published targeted restart candidate receipt could not be retired: ${error?.message || error}`),
  reopenRoute = reopenTargetedRoute,
  faultHooks = loadRestartFaultHooks,
} = {}) {
  const hooks = faultHooks();
  if (!transition || !result?.containerName || !result?.registryRecord) {
    throw new Error('targeted agent restart commit requires its transition and exact ready runtime');
  }
  if (text(result.containerName) !== transition.containerName
    || !sameRuntimeIdentity(result.registryRecord, transition.identity)) {
    throw new Error('targeted agent restart successor does not preserve the coordinated runtime identity');
  }
  assertTransitionSelected(transition, loadActive);

  const restoredRoute = () => {
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
    delete restored.hardwareAvailability;
    return restored;
  };
  // Reopen the withdrawn route active to active; only a reopen that cannot be
  // proven takes the inactive merge below (D7).
  const mergeRouting = async (mutator, options) => {
    try {
      // Test-only: an unprovable reopen takes the same fallback as a real one.
      if (hooks?.forceUnprovableReopen) throw new Error('test fault hook: reopen forced unprovable');
      return await reopenRoute(transition, restoredRoute, result);
    } catch (error) {
      if (edgeWithdrawalRefusalDisposition(error) === 'defer') throw error;
    }
    return mergeRoutingDependency(mutator, { ...options, ...holdOption(hooks) });
  };

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
    delete restored.hardwareAvailability;
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
  // D2S.13 site T: the successor is applied and verified exactly. Retire the entries of the published tuple under a
  // fresh apply lock; failure keeps them, is logged, and does not undo the publication.
  await retireEntriesAfterApply({
    site: 'targeted-restart',
    networkLifecycleCapability,
    published: [{
      routeKey: transition.routeKey,
      key: transition.containerName,
      instanceId: text(result.registryRecord.instanceId),
      enableGeneration: text(result.registryRecord.enableGeneration),
    }],
  });
  if (result.durableCandidate) {
    try {
      retireCandidate(result.durableCandidate);
    } catch (error) {
      // Publication already succeeded; reporting must not trigger successor cleanup.
      try { reportRetirementFailure(error); } catch (_) {}
    }
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
