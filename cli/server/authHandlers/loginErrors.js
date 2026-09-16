// Provider-neutral login rejections the Router may explain.
//
// A provider can report why a login could not start, but its messages, response
// bodies, and unexpected status combinations are never public. Only the exact
// code/status pairs below map to fixed wording; every other failure remains a
// neutral `auth_failure`.

const PUBLIC_LOGIN_ERRORS = Object.freeze({
    invalid_redirect_uri: Object.freeze({
        status: 400,
        title: 'Sign-in address is invalid',
        detail: 'The sign-in callback address is invalid.',
    }),
    redirect_origin_not_allowed: Object.freeze({
        status: 403,
        title: 'Sign-in is not enabled for this address',
        detail: 'Sign-in is not enabled for this address. Use a configured workspace address or contact the workspace administrator.',
    }),
    browser_origin_not_allowed: Object.freeze({
        status: 403,
        title: 'Address not enabled',
        detail: 'This address is not enabled for authentication.',
    }),
    auth_origin_topology_unavailable: Object.freeze({
        status: 503,
        title: 'Sign-in is temporarily unavailable',
        detail: 'The workspace authentication addresses are temporarily unavailable. Try again after the workspace is ready.',
        retryable: true,
    }),
    auth_origin_topology_invalid: Object.freeze({
        status: 503,
        title: 'Sign-in is not configured correctly',
        detail: 'The workspace authentication configuration is invalid. Contact the workspace administrator.',
    }),
});

export const LOGIN_FAILURE = Object.freeze({
    code: 'auth_failure',
    status: 500,
    title: 'Sign-in could not be started',
    detail: 'Sign-in could not be started.',
});

/**
 * The fixed public explanation for one approved provider-neutral rejection, or
 * null when the error must stay neutral. The status must be the exact numeric
 * status paired with the code.
 *
 * @param {unknown} error
 * @returns {Readonly<{ code: string, status: number, title: string, detail: string, retryable?: boolean }>|null}
 */
export function resolvePublicLoginError(error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    const entry = code && Object.hasOwn(PUBLIC_LOGIN_ERRORS, code) ? PUBLIC_LOGIN_ERRORS[code] : null;
    if (!entry || typeof error?.statusCode !== 'number' || error.statusCode !== entry.status) return null;
    return Object.freeze({ code, ...entry });
}

export default {
    LOGIN_FAILURE,
    resolvePublicLoginError,
};
