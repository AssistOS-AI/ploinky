function deepFreeze(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
}

const REQUIRED = [
    'listenerClass',
    'authority',
    'surfaceKind',
    'owner',
    'routeKey',
    'port',
    'policyPath',
    'convention',
    'unmatchedSuffix',
    'relay',
    'access',
    'scheme',
    'origin',
    'limits',
    'generationDigest',
    'auditId',
];

export function createRoutePlan(input = {}) {
    for (const key of REQUIRED) {
        if (input[key] === undefined || input[key] === null || input[key] === '') {
            throw new Error(`RoutePlan: ${key} is required`);
        }
    }
    if ('targetPath' in input) {
        throw new Error('RoutePlan: targetPath is created only after admission');
    }
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
        throw new Error('RoutePlan: invalid agent-local port');
    }
    if (input.relay.host || input.relay.port || input.relay[['host', 'Port'].join('')]) {
        throw new Error('RoutePlan: relay must not contain a host TCP target');
    }
    return deepFreeze({ ...input });
}

export function finalizeRoutePlan(plan, { targetPath, query = plan.query || '' } = {}) {
    if (!Object.isFrozen(plan)) throw new Error('RoutePlan: an immutable pre-admission plan is required');
    if (!String(targetPath || '').startsWith('/')) throw new Error('RoutePlan: canonical targetPath required');
    return deepFreeze({ ...plan, targetPath: String(targetPath), query: String(query || '') });
}

export function finalizePlanAfterAdmission(plan) {
    if (plan?.surfaceKind === 'agent-port-convention') {
        return finalizeRoutePlan(plan, { targetPath: plan.unmatchedSuffix || '/', query: plan.query || '' });
    }
    if (plan?.surfaceKind === 'agent-primary') {
        return finalizeRoutePlan(plan, { targetPath: plan.unmatchedSuffix || '/', query: plan.query || '' });
    }
    throw new Error('RoutePlan: unsupported route surface');
}

export { deepFreeze };

export default createRoutePlan;
