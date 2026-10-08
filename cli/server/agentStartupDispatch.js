import { hardwareStartupResultFromCompiled } from './hardwareAvailability.mjs';
import {
    buildAgentStartupDocumentResponse,
    buildAgentStartupProbeResponse,
    classifyAgentStartupRequest,
    writeAgentStartupResponse,
} from './agentStartupPage.js';

const AGENT_ROOT_KINDS = new Set(['agent-root', 'agent-root-pending']);

function writeJson(res, statusCode, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
}

function writeInactive(res) {
    writeJson(res, 503, { error: 'TARGET_INACTIVE' });
}

function writeGenerationChanged(req, res, requestKind) {
    if (requestKind === 'probe') {
        writeAgentStartupResponse(res, buildAgentStartupProbeResponse({
            state: 'retry',
            code: 'edge_generation_changed',
        }), { method: req?.method });
        return;
    }
    writeJson(res, 503, { error: 'edge_generation_changed' });
}

const HARDWARE_CODES = new Set(['hardware_refused', 'hardware_blocked']);

function isHardwareState(result) {
    return result?.state === 'unavailable' && HARDWARE_CODES.has(result?.code);
}

function isRenderableDocumentState(result) {
    return result?.state === 'starting'
        || isHardwareState(result)
        || (result?.state === 'failed'
            && (result?.code === 'startup_failed' || result?.code === 'startup_timed_out'));
}

function isRenderableProbeState(result) {
    return isRenderableDocumentState(result)
        || (result?.state === 'unavailable' && result?.code === 'route_unavailable')
        || result?.state === 'generation_changed';
}

function writeObservedState(req, res, routePlan, requestKind, result) {
    if (requestKind === 'navigation') {
        if (!isRenderableDocumentState(result)) return false;
        writeAgentStartupResponse(res, buildAgentStartupDocumentResponse({
            state: result.state,
            code: result.code || '',
            routeLabel: routePlan.routeKey,
            ...(isHardwareState(result) ? { reason: result.reason, fix: result.fix } : {}),
        }), { method: req?.method });
        return true;
    }

    if (!isRenderableProbeState(result)) return false;
    if (result.state === 'generation_changed') {
        writeGenerationChanged(req, res, requestKind);
        return true;
    }
    writeAgentStartupResponse(res, buildAgentStartupProbeResponse({
        state: result.state,
        code: result.code || '',
        generation: result.state === 'starting' ? routePlan.lease?.id : '',
        ...(isHardwareState(result) ? { reason: result.reason, fix: result.fix } : {}),
    }), { method: req?.method });
    return true;
}

// Terminal answer for a refused/blocked instance on a request that is not a
// startup navigation or probe (API, SSE, MCP over HTTP).
function writeHardwareUnavailable(res, entry) {
    const result = hardwareStartupResultFromCompiled(entry);
    writeJson(res, 503, {
        error: 'AGENT_HARDWARE_UNAVAILABLE',
        state: entry.state,
        code: result.code,
        reason: result.reason,
        fix: result.fix,
    });
}

// The activation clock and its routing-mutation reader resolve workspace
// paths. Load them only for a lease that carries an activation, so importing
// this dispatcher never evaluates the workspace configuration. The Router's
// route planner imports the same module instance and observes activations
// early.
let activationClock = null;

async function loadActivationClock() {
    try {
        activationClock ??= await import('./edgeActivationClock.js');
        return activationClock;
    } catch (_) {
        return null;
    }
}

function carriesActivation(lease) {
    return typeof lease?.activationId === 'string' && lease.activationId.length > 0;
}

async function readMutation(readMutationState) {
    try {
        return (await readMutationState()) === 'idle' ? 'idle' : 'busy';
    } catch (_) {
        return 'busy';
    }
}

function readyWithoutActivation(routePlan) {
    return buildAgentStartupProbeResponse({ state: 'ready', generation: routePlan.lease?.id });
}

async function writeReady(req, res, routePlan, requestKind, { commitPlan, readMutationState }) {
    const clock = carriesActivation(routePlan.lease) ? await loadActivationClock() : null;
    const activation = clock ? clock.observeEdgeActivation(routePlan.lease) : null;
    if (!activation) {
        writeAgentStartupResponse(res, readyWithoutActivation(routePlan), { method: req?.method });
        return;
    }
    const mutation = await readMutation(readMutationState === undefined
        ? clock.readRoutingMutationState
        : readMutationState);
    if (!commitPlan(routePlan)) {
        writeGenerationChanged(req, res, requestKind);
        return;
    }
    let response;
    try {
        response = buildAgentStartupProbeResponse({
            state: 'ready',
            generation: routePlan.lease.id,
            activation: activation.activation,
            activeForMs: activation.activeForMs,
            mutation,
        });
    } catch (_) {
        // Without valid activation fields a client runs its full forward check.
        response = readyWithoutActivation(routePlan);
    }
    writeAgentStartupResponse(res, response, { method: req?.method });
}

/**
 * Handle the narrow same-route no-wait startup protocol.
 *
 * `inspectPublication` is restricted to the captured immutable snapshot and
 * must not perform lifecycle filesystem/process I/O. `resolveStartupState` is
 * the only lifecycle observer and is deliberately called after authorization
 * and a successful first lease commit. This module performs the second commit
 * immediately before writing any lifecycle-derived response.
 *
 * A `ready` answer for a lease that carries an activation also reports the
 * activation's opaque token and age and `readMutationState()` ('idle' or
 * 'busy'; anything else, or a throw, is 'busy'; the default is the production
 * readRoutingMutationState), behind a second commit so a reactivation between
 * the reads answers `edge_generation_changed`.
 */
export async function dispatchAgentStartupRequest({
    req,
    res,
    parsedUrl,
    routePlan,
    isOrdinaryAgentHttp = true,
    ensureRouteAccess,
    inspectPublication,
    resolveStartupState,
    commitPlan = (plan) => Boolean(plan?.ok && plan?.lease?.commit?.()),
    readMutationState,
    onObservationError = () => {},
} = {}) {
    if (!routePlan?.ok || !AGENT_ROOT_KINDS.has(routePlan.kind)) return false;

    const pending = routePlan.kind === 'agent-root-pending';
    let publication = null;
    if (pending && typeof inspectPublication === 'function') {
        try {
            publication = inspectPublication(routePlan);
        } catch (_) {
            publication = null;
        }
    }

    const requestKind = classifyAgentStartupRequest(req, {
        routePlan,
        isOrdinaryAgentHttp,
        canPublishHttp: publication?.ok === true && publication?.canPublishHttp === true,
    });

    const hardwareEntry = pending ? routePlan.hardwareAvailability || null : null;
    if (!requestKind) {
        if (!pending) return false;
        if (hardwareEntry) writeHardwareUnavailable(res, hardwareEntry);
        else writeInactive(res);
        return true;
    }

    if (typeof ensureRouteAccess !== 'function') {
        writeInactive(res);
        return true;
    }
    const access = await ensureRouteAccess(req, res, parsedUrl, routePlan.decision, { routePlan });
    if (!access?.ok) return true;

    if (!commitPlan(routePlan)) {
        writeGenerationChanged(req, res, requestKind);
        return true;
    }

    if (!pending) {
        await writeReady(req, res, routePlan, requestKind, { commitPlan, readMutationState });
        return true;
    }

    if (hardwareEntry) {
        // Terminal: no startup observation, no reload loop.
        if (!writeObservedState(req, res, routePlan, requestKind, hardwareStartupResultFromCompiled(hardwareEntry))) {
            writeHardwareUnavailable(res, hardwareEntry);
        }
        return true;
    }

    if (typeof resolveStartupState !== 'function') {
        writeInactive(res);
        return true;
    }

    let result;
    try {
        result = await resolveStartupState(routePlan, { publication });
    } catch (_) {
        try { onObservationError('unverified'); } catch (_) {}
        writeInactive(res);
        return true;
    }

    if (!commitPlan(routePlan)) {
        writeGenerationChanged(req, res, requestKind);
        return true;
    }

    if (!writeObservedState(req, res, routePlan, requestKind, result)) {
        writeInactive(res);
    }
    return true;
}

/**
 * Production integration seam for RoutingServer's post-surface startup slot.
 *
 * The caller must invoke this only after Router-owned surfaces have had
 * precedence. Keeping the route-kind and ordinary-HTTP derivation here makes
 * the exact slice independently testable with real resolveEdgeRoutePlan()
 * results, without importing the side-effectful listening server module.
 */
export async function dispatchAgentStartupAfterRouterSurfaces({
    req,
    res,
    parsedUrl,
    routePlan,
    ensureRouteAccess,
    inspectPublication,
    resolveStartupState,
    commitPlan,
    readMutationState,
    onObservationError,
} = {}) {
    if (!routePlan?.ok || !AGENT_ROOT_KINDS.has(routePlan.kind)) return false;

    const upstreamPath = String(routePlan.upstreamPath || '');
    const isAgentMcpRoute = upstreamPath === '/mcp'
        || upstreamPath.startsWith('/mcp?')
        || upstreamPath.startsWith('/mcp/');
    const handled = await dispatchAgentStartupRequest({
        req,
        res,
        parsedUrl,
        routePlan,
        isOrdinaryAgentHttp: !isAgentMcpRoute,
        ensureRouteAccess,
        inspectPublication,
        resolveStartupState,
        commitPlan,
        readMutationState,
        onObservationError,
    });
    if (handled) return true;

    // Pending plans are observational only. Fail closed if a future request
    // classifier ever declines one without producing the generic response.
    if (routePlan.kind === 'agent-root-pending') {
        writeInactive(res);
        return true;
    }
    return false;
}

export const __testables = {
    isRenderableDocumentState,
    isRenderableProbeState,
    writeObservedState,
};
