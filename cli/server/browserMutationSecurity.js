import crypto from 'node:crypto';

import { deriveSubkey } from '../utils/security/masterKey.js';
import { canonicalControlOrigin } from './adminControlSecurity.js';
import { resolveSessionBindingId } from './sessionBinding.js';

export const BROWSER_CSRF_HEADER = 'x-ploinky-browser-csrf-token';
export const BROWSER_CSRF_COOKIE_NAME = 'ploinky_browser_csrf';

const BROWSER_CSRF_VERSION = 'v1';

function headerValue(req, name) {
    const value = req?.headers?.[name];
    return Array.isArray(value) ? '' : (typeof value === 'string' ? value : '');
}

function cookieValue(req, name) {
    const raw = headerValue(req, 'cookie');
    for (const entry of raw.split(';')) {
        const separator = entry.indexOf('=');
        if (separator < 1) continue;
        if (entry.slice(0, separator).trim() === name) return entry.slice(separator + 1).trim();
    }
    return '';
}

function routeGeneration(routePlan) {
    return String(routePlan?.lease?.id || routePlan?.snapshot?.generation || '').trim();
}

function routeBinding(routePlan, authContext = {}) {
    return String(
        authContext.boundHostRouteKey
        || authContext.serviceRouteKey
        || authContext.routeKey
        || routePlan?.hostSelection?.record?.routeKey
        || 'control',
    ).trim() || 'control';
}

export function canonicalBrowserMutationOrigin(req, routePlan) {
    const forwarding = routePlan?.forwarding;
    if (!forwarding) return canonicalControlOrigin(req);
    const protocol = String(forwarding.protocol || '').trim().toLowerCase();
    const authority = String(forwarding.authority || '').trim();
    if (!['http', 'https'].includes(protocol) || !authority) return null;
    try {
        const parsed = new URL(`${protocol}://${authority}`);
        if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
        if (parsed.origin !== `${protocol}://${authority}`) return null;
        return parsed.origin;
    } catch (_) {
        return null;
    }
}

function browserCsrfMac({ sessionId, origin, generation, routeKey }) {
    return crypto
        .createHmac('sha256', deriveSubkey('router-browser-csrf'))
        .update(BROWSER_CSRF_VERSION)
        .update('\0')
        .update(String(sessionId || ''))
        .update('\0')
        .update(String(origin || ''))
        .update('\0')
        .update(String(generation || ''))
        .update('\0')
        .update(String(routeKey || ''))
        .digest('base64url');
}

function bindingForRequest({ req, routePlan, authContext, sessionId }) {
    const origin = canonicalBrowserMutationOrigin(req, routePlan);
    const generation = routeGeneration(routePlan);
    const routeKey = routeBinding(routePlan, authContext);
    const sid = resolveSessionBindingId(req, sessionId);
    if (!origin || !generation || !routeKey || !sid) {
        const error = new Error('an exact routed origin, active edge generation, route binding, and authenticated session are required');
        error.code = 'BROWSER_MUTATION_BINDING_REQUIRED';
        throw error;
    }
    return { origin, generation, routeKey, sessionId: sid };
}

export function mintBrowserCsrfToken({ req, routePlan, authContext, sessionId } = {}) {
    const binding = bindingForRequest({ req, routePlan, authContext, sessionId });
    return `${BROWSER_CSRF_VERSION}.${browserCsrfMac(binding)}`;
}

export function verifyBrowserMutationRequest(req, {
    routePlan,
    authContext,
    sessionId = req?.sessionId,
    token = '',
} = {}) {
    let binding;
    try {
        binding = bindingForRequest({ req, routePlan, authContext, sessionId });
    } catch (error) {
        return { ok: false, code: error?.code || 'BROWSER_MUTATION_BINDING_REQUIRED' };
    }
    const suppliedOrigin = headerValue(req, 'origin');
    if (!suppliedOrigin || suppliedOrigin !== binding.origin) {
        return { ok: false, code: 'BROWSER_ORIGIN_REQUIRED' };
    }
    const supplied = String(
        token
        || headerValue(req, BROWSER_CSRF_HEADER)
        || cookieValue(req, BROWSER_CSRF_COOKIE_NAME)
        || '',
    );
    const expected = `${BROWSER_CSRF_VERSION}.${browserCsrfMac(binding)}`;
    const suppliedBytes = Buffer.from(supplied);
    const expectedBytes = Buffer.from(expected);
    if (!supplied || suppliedBytes.length !== expectedBytes.length
        || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) {
        return { ok: false, code: 'BROWSER_CSRF_INVALID' };
    }
    return {
        ok: true,
        origin: binding.origin,
        generation: binding.generation,
        routeKey: binding.routeKey,
    };
}

export default {
    BROWSER_CSRF_HEADER,
    BROWSER_CSRF_COOKIE_NAME,
    canonicalBrowserMutationOrigin,
    mintBrowserCsrfToken,
    verifyBrowserMutationRequest,
};
