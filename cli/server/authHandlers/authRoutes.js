import { getSession as getLocalSession, isAdminUser, verifySessionJwt, revokeSession as revokeLocalSession } from '../auth/localService.js';
import { revokeSessionId } from '../auth/sessionRevocations.js';
import { canonicalControlOrigin, mintAdminCsrfToken } from '../adminControlSecurity.js';
import {
    BROWSER_CSRF_COOKIE_NAME,
    canonicalBrowserMutationOrigin,
    mintBrowserCsrfToken,
    verifyBrowserMutationRequest,
} from '../browserMutationSecurity.js';
import {
    appendSetCookie,
    appendLog,
    authService,
    buildCookie,
    getCookieNameForMode,
    GUEST_AUTH_COOKIE_NAME,
    GUEST_SESSION_TTL_SECONDS,
    normalizeRelativePath,
    parseCookies,
    readJsonBody,
    readLoginBody,
    sendJson,
    sessionTokenService,
    SSO_AUTH_COOKIE_NAME,
} from './shared.js';
import {
    resolveAuthContextForRoutePlan,
    waitForAgentRedirectReady,
} from './authContext.js';
import {
    renderLoggedOutHtml,
    renderLogoutConfirmationHtml,
    renderSsoLoginHtml,
} from './authPages.js';

function loginBindingCookieName(state, baseUrl) {
    const prefix = baseUrl.startsWith('https:') ? '__Host-' : '';
    return /^[A-Za-z0-9_-]{22}$/.test(String(state || '')) ? `${prefix}ploinky_sso_login_${state}` : '';
}

function buildLoginBindingCookie(name, value, baseUrl, maxAge) {
    // Use the admitted origin for Secure, including when TLS terminates before
    // the router. The __Host- prefix also prevents sibling-domain overwrites.
    return buildCookie(name, value, { headers: {}, socket: { encrypted: baseUrl.startsWith('https:') } }, '/', {
        maxAge,
        sameSite: 'Lax',
    });
}

function isHostBoundAuthContext(authContext) {
    return Boolean(String(authContext?.boundHostRouteKey || '').trim());
}

function rejectMismatchedHostSelector(res, authContext, value) {
    const bound = String(authContext?.boundHostRouteKey || '').trim();
    const supplied = String(value || '').trim();
    if (!bound || !supplied || supplied === bound) return false;
    sendJson(res, 400, { ok: false, error: 'auth_route_context_mismatch' });
    return true;
}

function requireCurrentGeneration(res, routePlan) {
    if (!routePlan?.lease?.snapshot || typeof routePlan?.lease?.commit !== 'function') {
        sendJson(res, 503, { ok: false, error: 'edge_generation_required' });
        return false;
    }
    if (routePlan.lease.commit() !== true) {
        sendJson(res, 503, { ok: false, error: 'edge_generation_changed' });
        return false;
    }
    return true;
}

function setAuthenticatedRequest(req, { session, sessionId, mode }) {
    req.user = session.user;
    req.session = session;
    req.sessionId = sessionId;
    req.authMode = mode;
}

function issueBrowserMutationProof(req, res, { routePlan, authContext, sessionId, maxAge }) {
    const csrfToken = mintBrowserCsrfToken({ req, routePlan, authContext, sessionId });
    appendSetCookie(res, buildCookie(BROWSER_CSRF_COOKIE_NAME, csrfToken, req, '/', {
        maxAge,
        sameSite: 'Strict',
    }));
    return csrfToken;
}

async function resolveBrowserTokenSession(cookies, authContext) {
    const candidates = authContext.mode === 'guest'
        ? [
            {
                mode: 'sso',
                cookieName: SSO_AUTH_COOKIE_NAME,
                getSession: (sessionId) => authService.isConfigured()
                    ? authService.getSession(sessionId)
                    : null,
            },
            {
                mode: 'guest',
                cookieName: GUEST_AUTH_COOKIE_NAME,
                getSession: (sessionId) => sessionTokenService.getGuestSession(sessionId, {
                    policy: authContext.policy,
                }),
            },
        ]
        : [{
            mode: authContext.mode,
            cookieName: getCookieNameForMode(authContext.mode),
            getSession: (sessionId) => authService.getSession(sessionId),
        }];

    let invalidCookie = null;
    for (const candidate of candidates) {
        const sessionId = cookies.get(candidate.cookieName);
        if (!sessionId) continue;
        invalidCookie ||= candidate.cookieName;
        const session = await candidate.getSession(sessionId);
        if (session && (!session.expiresAt || Date.now() <= session.expiresAt)) {
            return {
                mode: candidate.mode,
                cookieName: candidate.cookieName,
                sessionId,
                session,
            };
        }
    }
    return { invalidCookie };
}

function denyBrowserMutation(res, decision) {
    sendJson(res, 403, {
        ok: false,
        error: String(decision?.code || 'BROWSER_MUTATION_DENIED').toLowerCase(),
    });
}

export async function handleAuthRoutes(req, res, parsedUrl, { routePlan = null } = {}) {
    const pathname = parsedUrl.pathname || '/';
    if (!pathname.startsWith('/auth/')) return false;
    const method = (req.method || 'GET').toUpperCase();
    if (!requireCurrentGeneration(res, routePlan)) return true;
    const authContext = resolveAuthContextForRoutePlan(parsedUrl, routePlan, { browserAuth: true });
    if (authContext.error) {
        sendJson(res, authContext.errorStatus || 503, {
            ok: false,
            error: authContext.error,
            ...(authContext.errorDetail ? { detail: authContext.errorDetail } : {}),
        });
        return true;
    }
    if (rejectMismatchedHostSelector(res, authContext, parsedUrl.searchParams.get('agent'))) return true;
    const baseUrl = canonicalBrowserMutationOrigin(req, routePlan);
    if (!baseUrl) {
        sendJson(res, 400, { ok: false, error: 'auth_origin_invalid' });
        return true;
    }
    try {
        if (pathname === '/auth/logged-out') {
            if (method !== 'GET') {
                res.writeHead(405); res.end(); return true;
            }
            const nextPath = normalizeRelativePath(parsedUrl.searchParams.get('next') || '/webchat/', '/webchat/');
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(renderLoggedOutHtml(nextPath));
            return true;
        }
        if (pathname === '/auth/login') {
            if (authContext.mode === 'none') {
                sendJson(res, 404, { ok: false, error: 'auth_disabled' });
                return true;
            }
            if (method !== 'GET') {
                res.writeHead(405); res.end(); return true;
            }
            if (!authService.isConfigured()) {
                sendJson(res, 503, { ok: false, error: 'sso_disabled' });
                return true;
            }
            const returnTo = normalizeRelativePath(parsedUrl.searchParams.get('returnTo') || '/', '/');
            const prompt = parsedUrl.searchParams.get('prompt') || undefined;
            if (!requireCurrentGeneration(res, routePlan)) return true;
            const { redirectUrl, state, browserBinding, expiresAt } = await authService.beginLogin({ baseUrl, returnTo, prompt });
            if (!requireCurrentGeneration(res, routePlan)) return true;
            const bindingCookieName = loginBindingCookieName(state, baseUrl);
            if (!bindingCookieName || !browserBinding) throw new Error('Invalid authorization browser binding');
            appendSetCookie(res, buildLoginBindingCookie(bindingCookieName, browserBinding, baseUrl,
                Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))));
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(renderSsoLoginHtml({
                agentName: authContext.boundHostRouteKey || authContext.routeKey,
                returnTo,
                redirectUrl
            }));
            appendLog('auth_login_redirect', { returnTo });
            return true;
        }
        if (pathname === '/auth/account') {
            sendJson(res, 404, { ok: false, error: 'local_auth_disabled' });
            return true;
        }

        if (pathname === '/auth/local-users') {
            sendJson(res, 410, {
                ok: false,
                error: 'local_users_endpoint_removed',
                detail: 'Use /api/agents/<agent>/users.'
            });
            return true;
        }

        if (pathname.startsWith('/auth/github/')) {
            sendJson(res, 404, { ok: false, error: 'github_auth_removed' });
            return true;
        }
        if (pathname === '/auth/callback') {
            if (authContext.mode !== 'sso') {
                sendJson(res, 404, { ok: false, error: 'callback_not_supported' });
                return true;
            }
            if (method !== 'GET') {
                res.writeHead(405); res.end(); return true;
            }
            if (!authService.isConfigured()) {
                sendJson(res, 503, { ok: false, error: 'sso_disabled' });
                return true;
            }
            const code = parsedUrl.searchParams.get('code') || '';
            const state = parsedUrl.searchParams.get('state') || '';
            if (!code || !state) {
                sendJson(res, 400, { ok: false, error: 'missing_parameters' });
                return true;
            }
            if (!requireCurrentGeneration(res, routePlan)) return true;
            const bindingCookieName = loginBindingCookieName(state, baseUrl);
            const browserBinding = bindingCookieName ? parseCookies(req).get(bindingCookieName) : '';
            if (!browserBinding) {
                sendJson(res, 400, { ok: false, error: 'invalid_authorization_browser' });
                return true;
            }
            let result;
            try {
                result = await authService.handleCallback({ code, state, browserBinding, baseUrl });
            } catch (err) {
                if (err?.statusCode === 400 || err?.statusCode === 401 || err?.statusCode === 403) {
                    appendLog('auth_callback_rejected', { statusCode: err.statusCode });
                    sendJson(res, 400, { ok: false, error: 'invalid_authorization_code' });
                    return true;
                }
                throw err;
            }
            appendSetCookie(res, buildLoginBindingCookie(bindingCookieName, '', baseUrl, 0));
            await waitForAgentRedirectReady(authContext.routeKey || '', { routePlan });
            if (!requireCurrentGeneration(res, routePlan)) return true;
            const cookie = buildCookie(SSO_AUTH_COOKIE_NAME, result.sessionId, req, '/', {
                maxAge: authService.getSessionCookieMaxAge(),
                sameSite: 'Lax'
            });
            issueBrowserMutationProof(req, res, {
                routePlan,
                authContext,
                sessionId: result.sessionId,
                maxAge: authService.getSessionCookieMaxAge(),
            });
            appendSetCookie(res, cookie);
            res.writeHead(302, {
                Location: normalizeRelativePath(result.redirectTo || '/', '/'),
            });
            res.end('Login successful');
            appendLog('auth_callback_success', { user: result.user?.id });
            return true;
        }
        if (pathname === '/auth/logout') {
            if (method !== 'GET' && method !== 'POST') {
                res.writeHead(405); res.end(); return true;
            }
            const cookies = parseCookies(req);
            const cookieName = getCookieNameForMode(authContext.mode);
            const sessionId = cookies.get(cookieName) || '';
            const session = sessionId
                ? (authContext.mode === 'guest'
                    ? getLocalSession(sessionId, { policy: authContext.policy })
                    : authService.getSession(sessionId))
                : null;
            const returnToFromQuery = normalizeRelativePath(parsedUrl.searchParams.get('returnTo') || '/', '/');
            const cancelToFromQuery = normalizeRelativePath(
                parsedUrl.searchParams.get('cancelTo') || returnToFromQuery,
                returnToFromQuery,
            );
            if (!session) {
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                });
                res.end(renderLoggedOutHtml(returnToFromQuery));
                return true;
            }
            setAuthenticatedRequest(req, { session, sessionId, mode: authContext.mode });

            if (method === 'GET') {
                const csrfToken = issueBrowserMutationProof(req, res, {
                    routePlan,
                    authContext,
                    sessionId,
                    maxAge: authContext.mode === 'guest'
                        ? GUEST_SESSION_TTL_SECONDS
                        : authService.getSessionCookieMaxAge(),
                });
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                });
                res.end(renderLogoutConfirmationHtml({
                    agentName: authContext.routeKey,
                    returnTo: returnToFromQuery,
                    cancelTo: cancelToFromQuery,
                    csrfToken,
                    includeAgentSelector: !isHostBoundAuthContext(authContext),
                }));
                return true;
            }

            const body = await readLoginBody(req);
            if (rejectMismatchedHostSelector(res, authContext, body?.agent)) return true;
            const requestedReturnTo = normalizeRelativePath(body?.returnTo || returnToFromQuery, '/');
            const mutationDecision = verifyBrowserMutationRequest(req, {
                routePlan,
                authContext,
                sessionId,
                token: body?.csrfToken,
            });
            if (!mutationDecision.ok) {
                denyBrowserMutation(res, mutationDecision);
                return true;
            }
            if (!requireCurrentGeneration(res, routePlan)) return true;
            // For guest JWT sessions, add the session's sid to
            // the persistent revocation list so the cookie cannot be replayed.
            if (sessionId && authContext.mode === 'guest') {
                try {
                    const payload = verifySessionJwt(sessionId);
                    revokeSessionId({ sid: payload.sid, jti: payload.jti, reason: 'logout' });
                } catch { /* already invalid/expired — nothing to revoke */ }
            }
            const outcome = authContext.mode === 'guest'
                ? (revokeLocalSession(sessionId), { redirect: requestedReturnTo || '/' })
                : await authService.logout(sessionId, {
                    baseUrl,
                    postLogoutRedirectUri: requestedReturnTo
                });
            const clearCookie = buildCookie(cookieName, '', req, '/', { maxAge: 0, sameSite: 'Lax' });
            const clearCsrfCookie = buildCookie(BROWSER_CSRF_COOKIE_NAME, '', req, '/', { maxAge: 0, sameSite: 'Strict' });
            const redirectTarget = outcome.redirect || requestedReturnTo || '/';
            appendSetCookie(res, clearCookie);
            appendSetCookie(res, clearCsrfCookie);
            const wantsJson = !outcome.redirect
                && String(req.headers?.accept || '').toLowerCase().includes('application/json');
            if (!wantsJson) {
                res.writeHead(302, {
                    Location: redirectTarget || '/',
                    'Cache-Control': 'no-store, no-cache, must-revalidate',
                    'Clear-Site-Data': '"cache"',
                });
                res.end('Logged out');
            } else {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store, no-cache, must-revalidate',
                    'Clear-Site-Data': '"cache"',
                });
                res.end(JSON.stringify({ ok: true }));
            }
            appendLog('auth_logout', { sessionId: sessionId ? '[redacted]' : null });
            return true;
        }
        if (pathname === '/auth/token') {
            if (authContext.mode === 'none') {
                sendJson(res, 404, { ok: false, error: 'auth_disabled' });
                return true;
            }
            if (method !== 'GET' && method !== 'POST') {
                res.writeHead(405); res.end(); return true;
            }
            const cookies = parseCookies(req);
            const tokenSession = await resolveBrowserTokenSession(cookies, authContext);
            if (!tokenSession.session) {
                if (tokenSession.invalidCookie) {
                    const clearCookie = buildCookie(tokenSession.invalidCookie, '', req, '/', {
                        maxAge: 0,
                        sameSite: 'Lax',
                    });
                    res.writeHead(401, {
                        'Content-Type': 'application/json',
                        'Set-Cookie': clearCookie,
                    });
                    res.end(JSON.stringify({ ok: false, error: 'session_expired' }));
                    return true;
                }
                sendJson(res, 401, { ok: false, error: 'not_authenticated' });
                return true;
            }
            const {
                cookieName,
                mode: sessionMode,
                sessionId,
                session,
            } = tokenSession;
            setAuthenticatedRequest(req, { session, sessionId, mode: sessionMode });
            let refreshRequested = false;
            if (method === 'POST') {
                let body = {};
                try {
                    body = await readJsonBody(req);
                    refreshRequested = Boolean(body?.refresh);
                } catch (_) {
                    sendJson(res, 400, { ok: false, error: 'invalid_json' });
                    return true;
                }
                const mutationDecision = verifyBrowserMutationRequest(req, {
                    routePlan,
                    authContext,
                    sessionId,
                    token: body?.csrfToken,
                });
                if (!mutationDecision.ok) {
                    denyBrowserMutation(res, mutationDecision);
                    return true;
                }
                if (!requireCurrentGeneration(res, routePlan)) return true;
            }
            let tokenInfo;
            if (sessionMode === 'sso' && refreshRequested) {
                tokenInfo = await authService.refreshSession(sessionId);
                if (!requireCurrentGeneration(res, routePlan)) return true;
            } else {
                tokenInfo = {
                    accessToken: session.tokens?.accessToken || null,
                    expiresAt: session.expiresAt,
                    scope: session.tokens?.scope || null,
                    tokenType: session.tokens?.tokenType || null
                };
            }
            if (!requireCurrentGeneration(res, routePlan)) return true;
            const cookieMaxAge = sessionMode === 'guest'
                ? GUEST_SESSION_TTL_SECONDS
                : authService.getSessionCookieMaxAge();
            const cookie = buildCookie(cookieName, sessionId, req, '/', {
                maxAge: cookieMaxAge,
                sameSite: 'Lax'
            });
            const browserCsrfToken = issueBrowserMutationProof(req, res, {
                routePlan,
                authContext,
                sessionId,
                maxAge: cookieMaxAge,
            });
            if (method === 'POST') appendSetCookie(res, cookie);
            let adminControl;
            if (isAdminUser(session.user)) {
                try {
                    adminControl = {
                        origin: canonicalControlOrigin(req),
                        csrfToken: mintAdminCsrfToken({ sessionId, req }),
                    };
                } catch (_) {
                    // Admin controls are deliberately unavailable on public,
                    // forwarded, or otherwise non-local hosts.
                }
            }
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({
                ok: true,
                token: tokenInfo,
                user: session.user,
                browserMutation: {
                    origin: baseUrl,
                    csrfToken: browserCsrfToken,
                    generation: String(routePlan.lease.id),
                    hostRouteKey: authContext.boundHostRouteKey
                        || routePlan?.hostSelection?.record?.routeKey
                        || 'control',
                    routeKey: authContext.serviceRouteKey
                        || authContext.routeKey
                        || authContext.boundHostRouteKey
                        || 'control',
                },
                ...(adminControl ? { adminControl } : {}),
            }));
            return true;
        }
        if (pathname === '/auth/agent-token') {
            if (method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
                res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
                return true;
            }
            sendJson(res, 410, {
                ok: false,
                error: 'agent_token_flow_removed',
                detail: 'Use router-mediated caller assertions and invocation tokens instead of /auth/agent-token.'
            });
            return true;
        }
    } catch (err) {
        appendLog('auth_error', { error: err?.message || String(err) });
        if (['Invalid or expired authorization state', 'Invalid authorization browser binding'].includes(err?.message)) {
            sendJson(res, 400, { ok: false, error: 'invalid_authorization_browser' });
            return true;
        }
        if ((err?.message || '').includes('SSO is not configured')) {
            sendJson(res, 503, { ok: false, error: 'sso_not_configured', detail: err?.message || String(err) });
            return true;
        }
        sendJson(res, 500, { ok: false, error: 'auth_failure', detail: err?.message || String(err) });
        return true;
    }
    res.writeHead(404); res.end('Not Found');
    return true;
}
