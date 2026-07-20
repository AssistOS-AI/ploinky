import crypto from 'node:crypto';

import { parseAgentPortSelector } from './parseSelector.js';
import { createRoutePlan, finalizeRoutePlan } from '../proxy/RoutePlan.js';
import { normalizeAuthority } from '../generation/authority.js';

export function resolveConvention({
    requestTarget,
    method = 'GET',
    authority,
    listenerClass = 'public',
    scheme = 'http',
    generation,
    evaluateAccess,
    transport = 'http',
    auditId = crypto.randomUUID(),
} = {}) {
    if (!generation || generation.active !== true) throw new Error('resolveConvention: active generation required');
    const normalizedAuthority = normalizeAuthority(authority);
    const surface = generation.surfaces?.[listenerClass];
    if (!surface || surface.authority !== normalizedAuthority) {
        throw new Error('resolveConvention: authority is not active on this listener');
    }

    const preliminary = parseAgentPortSelector(requestTarget);
    if (!preliminary) return null;
    const owner = generation.routes?.[preliminary.agent];
    if (!owner || owner.enabled === false) throw new Error('resolveConvention: agent owner is not active');
    const selector = parseAgentPortSelector(requestTarget, { deniedPorts: owner.deniedPorts || [] });
    if (!owner.relay) throw new Error('resolveConvention: owner has no confined relay');
    const access = evaluateAccess?.({
        pathname: selector.policyPath,
        method,
        routeKey: preliminary.agent,
        surfaceKind: 'agent-port-convention',
    });
    if (!access || access.access === 'none') throw new Error('resolveConvention: access decision required');

    return createRoutePlan({
        listenerClass,
        authority: normalizedAuthority,
        surfaceKind: 'agent-port-convention',
        owner: {
            effectiveInstanceId: owner.effectiveInstanceId,
            enableGeneration: owner.enableGeneration,
        },
        routeKey: preliminary.agent,
        port: selector.port,
        policyPath: selector.policyPath,
        convention: selector.convention,
        forwardedPrefix: `/${selector.convention}/${selector.rawAgent}/${selector.canonicalPort}`,
        unmatchedSuffix: selector.suffix,
        relay: owner.relay,
        deniedPorts: owner.deniedPorts || [],
        allowedRouterCapabilities: [],
        access,
        scheme,
        origin: `${scheme}://${normalizedAuthority}`,
        limits: owner.limits || generation.limits,
        generationDigest: generation.digest,
        auditId,
        method: String(method).toUpperCase(),
        query: selector.query,
        transport,
        credentialPolicy: owner.credentialPolicy || {},
        responsePolicy: owner.responsePolicy || {},
        originPolicy: owner.originPolicy || {},
        allowRequestStreaming: owner.allowRequestStreaming === true,
    });
}

export function rewriteConventionAfterAdmission(plan) {
    if (plan?.surfaceKind !== 'agent-port-convention') {
        throw new Error('resolveConvention: conventional route plan required');
    }
    return finalizeRoutePlan(plan, {
        targetPath: plan.unmatchedSuffix || '/',
        query: plan.query || '',
    });
}

export default resolveConvention;
