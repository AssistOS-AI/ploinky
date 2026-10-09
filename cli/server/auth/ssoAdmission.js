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
 * Cancellation contract: the bridge passes an AbortSignal as `signal` to
 * `sso_refresh_session` / `sso_validate_session`. It aborts the signal when
 * the validation deadline expires, on logout or revocation, and on a
 * configuration reload, then stops waiting and ignores whatever the operation
 * later returns. A provider must either honour the signal (stop the request
 * and settle promptly) or make the operation idempotent, because the bridge
 * may dispatch the next validation for the same session while an abandoned
 * call is still running. Token-rotating providers must do one of the two: an
 * abandoned call that still rotates a refresh token can leave the stored
 * provider session holding a token the provider has already replaced, and a
 * provider that ignores the signal can accumulate one overlapping call per
 * deadline for a session whose provider never answers.
 *
 * An admission that is denied because the provider is unavailable keeps the
 * stored session and is reported to opted-in callers as an error whose code is
 * SSO_PROVIDER_UNAVAILABLE, so they can answer with a retryable status instead
 * of discarding the browser session. HTTP callers answer such a denial with
 * 503 `authentication_unavailable`, `Retry-After` and `Cache-Control:
 * no-store`, and never clear the session cookie.
 */

export const SSO_PROVIDER_UNAVAILABLE = 'SSO_PROVIDER_UNAVAILABLE';

// Seconds a client should wait before retrying an undecided admission.
export const AUTHENTICATION_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export const AUTHENTICATION_UNAVAILABLE_MESSAGE = 'Authentication is temporarily unavailable. Retry shortly.';

// Headers for a 503 that reports an undecided admission.
export function authenticationUnavailableHeaders() {
    return {
        'Cache-Control': 'no-store',
        'Retry-After': String(AUTHENTICATION_UNAVAILABLE_RETRY_AFTER_SECONDS),
    };
}

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
