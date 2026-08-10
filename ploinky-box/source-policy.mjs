import { PloinkyBoxError } from './errors.mjs';

function policyError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_AGENTLIB_SOURCE_POLICY_INVALID' });
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

export function resolveStartSourcePolicy(env = process.env) {
    const present = hasOwn(env, 'PLOINKY_PROD');
    const value = present ? String(env.PLOINKY_PROD) : null;
    if (present && value !== 'true' && value !== 'false') {
        throw policyError('PLOINKY_PROD must be exactly true or false');
    }

    const requestedRefValue = hasOwn(env, 'PLOINKY_AGENTLIB_REF')
        ? String(env.PLOINKY_AGENTLIB_REF)
        : '';
    if (value !== 'true') {
        if (requestedRefValue.length > 0) {
            throw policyError(
                'PLOINKY_AGENTLIB_REF requires PLOINKY_PROD=true; '
                + 'local development mode uses the editable AchillesAgentLib checkout',
            );
        }
        return Object.freeze({ mode: 'local' });
    }

    const requestedRef = requestedRefValue.trim();
    return Object.freeze(requestedRef
        ? { mode: 'resolved-ref', requestedRef }
        : { mode: 'locked' });
}

export function assertSourcePolicyRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw policyError('A typed AchillesAgentLib source request is required');
    }
    const keys = Object.keys(request).sort();
    if (request.mode === 'local' || request.mode === 'locked') {
        if (JSON.stringify(keys) !== JSON.stringify(['mode'])) {
            throw policyError(`Unexpected ${request.mode} source request fields`);
        }
        return request;
    }
    if (request.mode === 'resolved-ref') {
        if (JSON.stringify(keys) !== JSON.stringify(['mode', 'requestedRef'])
            || typeof request.requestedRef !== 'string'
            || !request.requestedRef.trim()) {
            throw policyError('resolved-ref requires one nonempty requestedRef');
        }
        return request;
    }
    throw policyError(`Unsupported AchillesAgentLib source mode: ${String(request.mode || '')}`);
}
