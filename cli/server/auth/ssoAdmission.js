/**
 * ssoAdmission.js
 *
 * Provider-neutral vocabulary shared by the SSO bridge and its callers.
 *
 * Provider contract: a validation operation that cannot reach a decision
 * (transport failure, timeout, provider-side 5xx or configuration failure)
 * throws an error carrying `providerUnavailable: true`. Any other throw is a
 * definitive refusal and ends the session.
 *
 * An admission that is denied because the provider is unavailable keeps the
 * stored session and is reported to opted-in callers as an error whose code is
 * SSO_PROVIDER_UNAVAILABLE, so they can answer with a retryable status instead
 * of discarding the browser session.
 */

export const SSO_PROVIDER_UNAVAILABLE = 'SSO_PROVIDER_UNAVAILABLE';

export function ssoProviderUnavailableError() {
    const error = new Error('SSO provider is temporarily unavailable');
    error.code = SSO_PROVIDER_UNAVAILABLE;
    return error;
}

export function isSsoProviderUnavailable(error) {
    return error?.code === SSO_PROVIDER_UNAVAILABLE;
}

// One request's completed SSO admission. Later checks in the same request may
// reuse it while the bridge still holds the exact admitted session record under
// the same configuration epoch; any change requires a fresh validation.
const requestAdmissions = new WeakMap();

export function recordSsoAdmission(req, { sessionId, session, isCurrent }) {
    if (!req || typeof req !== 'object' || !sessionId || !session || typeof isCurrent !== 'function') return;
    requestAdmissions.set(req, Object.freeze({ sessionId: String(sessionId), session, isCurrent }));
}

export function currentSsoAdmission(req, sessionId) {
    if (!req || typeof req !== 'object') return null;
    const admission = requestAdmissions.get(req);
    if (!admission || admission.sessionId !== String(sessionId || '')) return null;
    try {
        return admission.isCurrent() === true ? admission.session : null;
    } catch (_) {
        return null;
    }
}
