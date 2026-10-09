import { createHash } from 'node:crypto';

// The single source of guest cookie names. Every place that mints, reads or
// clears a guest session cookie derives the name here, from the guest route key
// (the value the Router stamps into the guest JWT as `groute`). The name only
// decides where the browser stores the token; authorization stays in the
// `groute`/`gscope` checks of the session token service.

export const LEGACY_GUEST_AUTH_COOKIE_NAME = 'ploinky_guest';
export const GUEST_AUTH_COOKIE_PREFIX = 'ploinky_guest_';
export const GUEST_COOKIE_ROUTE_REQUIRED = 'GUEST_COOKIE_ROUTE_REQUIRED';

const NAME_DOMAIN = 'ploinky-guest-cookie\0v1\0';
const SUFFIX_LENGTH = 22;

// Deterministic, fixed-length and limited to RFC 6265 token characters. The
// inputs carry no generation, secret or time, so the name is stable across
// Router restarts and edge generations.
export function guestCookieNameForRouteKey(routeKey) {
    const key = String(routeKey ?? '').trim();
    if (!key) {
        const error = new Error('A guest cookie name requires a guest route key.');
        error.code = GUEST_COOKIE_ROUTE_REQUIRED;
        throw error;
    }
    const digest = createHash('sha256').update(NAME_DOMAIN).update(key).digest('base64url');
    return `${GUEST_AUTH_COOKIE_PREFIX}${digest.slice(0, SUFFIX_LENGTH)}`;
}

export function guestCookieNameForAuthContext(authContext) {
    return guestCookieNameForRouteKey(authContext?.policy?.routeKey || authContext?.routeKey);
}

// The legacy name and every derived name. Used where recognition must fail
// closed, such as stripping Router cookies before forwarding to an agent.
export function isGuestCookieName(name) {
    return String(name ?? '').startsWith(LEGACY_GUEST_AUTH_COOKIE_NAME);
}

export function isGuestCookieRouteRequiredError(error) {
    return error?.code === GUEST_COOKIE_ROUTE_REQUIRED;
}
