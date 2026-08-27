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

function isRenderableDocumentState(result) {
    return result?.state === 'starting'
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
    }), { method: req?.method });
    return true;
}

/**
 * Handle the narrow same-route no-wait startup protocol.
 *
 * `inspectPublication` is restricted to the captured immutable snapshot and
 * must not perform lifecycle filesystem/process I/O. `resolveStartupState` is
 * the only lifecycle observer and is deliberately called after authorization
 * and a successful first lease commit. This module performs the second commit
 * immediately before writing any lifecycle-derived response.
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

    if (!requestKind) {
        if (!pending) return false;
        writeInactive(res);
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
        writeAgentStartupResponse(res, buildAgentStartupProbeResponse({
            state: 'ready',
            generation: routePlan.lease?.id,
        }), { method: req?.method });
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
