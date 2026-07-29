import { authenticateLocalUser, getSession as getLocalSession, getSessionCookieMaxAge as getLocalSessionCookieMaxAge, isLocalAdminUser, resolveLocalAuthConfig, updateLocalCredentials, verifySessionJwt, revokeSession as revokeLocalSession } from '../auth/localService.js';
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
    LOCAL_AUTH_COOKIE_NAME,
    normalizeRelativePath,
    parseCookies,
    readJsonBody,
    readLoginBody,
    sendJson,
    sessionTokenService,
    SSO_AUTH_COOKIE_NAME,
} from './shared.js';
import {
    getLocalAuthPolicyFromSession,
    getLocalRouteKey,
    resolveAuthContextForRoutePlan,
    waitForAgentRedirectReady,
} from './authContext.js';
import {
    renderExternalAccountHtml,
    renderLocalAccountHtml,
    renderLocalLoginHtml,
    renderLoggedOutHtml,
    renderLogoutConfirmationHtml,
    renderSsoLoginHtml,
} from './authPages.js';

function getLocalAccountErrorMessage(code = '') {
    switch (String(code || '').trim()) {
        case 'current_password_required':
            return 'Enter the current password to apply changes.';
        case 'username_required':
            return 'Username cannot be empty.';
        case 'password_too_short':
            return 'New password must be at least 8 characters.';
        case 'password_confirmation_required':
            return 'Confirm the new password.';
        case 'password_confirmation_mismatch':
            return 'The new password and confirmation do not match.';
        case 'invalid_credentials':
            return 'Current password is incorrect.';
        case 'local_auth_not_configured':
            return 'Local auth is not configured for this account.';
        case 'no_changes_requested':
            return 'No changes were submitted.';
        case 'session_stale':
            return 'Your session is out of date. Sign in again and retry.';
        default:
            return code ? 'Unable to update credentials.' : '';
    }
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

function addUnboundAgent(params, authContext, routeKey = authContext?.routeKey) {
    if (!isHostBoundAuthContext(authContext) && String(routeKey || '').trim()) {
        params.set('agent', String(routeKey).trim());
    }
    return params;
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
                mode: 'local',
                cookieName: LOCAL_AUTH_COOKIE_NAME,
                getSession: (sessionId) => sessionTokenService.getUserSession(sessionId, {
                    policy: authContext.policy,
                }),
            },
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
            getSession: (sessionId) => authContext.mode === 'local'
                ? sessionTokenService.getUserSession(sessionId, { policy: authContext.policy })
                : authService.getSession(sessionId),
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
        sendJson(res, 503, { ok: false, error: authContext.error });
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
            if (authContext.mode === 'local') {
                if (method === 'GET') {
                    const returnTo = parsedUrl.searchParams.get('returnTo') || '/';
                    const localCfg = resolveLocalAuthConfig(authContext.policy);
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-store'
                    });
                    res.end(renderLocalLoginHtml({
                        agentName: authContext.boundHostRouteKey || authContext.routeKey,
                        returnTo,
                        error: parsedUrl.searchParams.get('error') || '',
                        notice: parsedUrl.searchParams.get('notice') || '',
                        usersVar: localCfg.usersVar,
                        includeAgentSelector: !isHostBoundAuthContext(authContext),
                    }));
                    return true;
                }
                if (method !== 'POST') {
                    res.writeHead(405); res.end(); return true;
                }
                const body = await readLoginBody(req);
                const username = String(body?.username || '').trim();
                const password = String(body?.password || '');
                const returnTo = normalizeRelativePath(body?.returnTo || '/', '/');
                if (rejectMismatchedHostSelector(res, authContext, body?.agent)) return true;
                const agent = isHostBoundAuthContext(authContext)
                    ? String(authContext.routeKey || '').trim()
                    : String(body?.agent || authContext.routeKey || '').trim();
                if (!requireCurrentGeneration(res, routePlan)) return true;
                try {
                    const result = authenticateLocalUser({ username, password, policy: authContext.policy, routeKey: agent });
                    await waitForAgentRedirectReady(agent, { routePlan });
                    if (!requireCurrentGeneration(res, routePlan)) return true;
                    const cookie = buildCookie(LOCAL_AUTH_COOKIE_NAME, result.sessionId, req, '/', {
                        maxAge: getLocalSessionCookieMaxAge(),
                        sameSite: 'Lax'
                    });
                    const csrfToken = issueBrowserMutationProof(req, res, {
                        routePlan,
                        authContext,
                        sessionId: result.sessionId,
                        maxAge: getLocalSessionCookieMaxAge(),
                    });
                    void csrfToken;
                    appendSetCookie(res, cookie);
                    res.writeHead(302, {
                        Location: returnTo,
                    });
                    res.end('Login successful');
                    appendLog('auth_local_login_success', { user: result.user?.username, agent });
                    return true;
                } catch (err) {
                    appendLog('auth_local_login_failure', { error: err?.message || String(err), agent });
                    const params = addUnboundAgent(new URLSearchParams({
                        returnTo,
                        error: err?.message === 'local_auth_not_configured'
                            ? 'Local auth is not configured for this agent.'
                            : 'Invalid username or password.'
                    }), authContext, agent);
                    res.writeHead(302, { Location: `/auth/login?${params.toString()}` });
                    res.end('Login failed');
                    return true;
                }
            }
            if (!authService.isConfigured()) {
                sendJson(res, 503, { ok: false, error: 'sso_disabled' });
                return true;
            }
            if (method !== 'GET') {
                res.writeHead(405); res.end(); return true;
            }
            const returnTo = normalizeRelativePath(parsedUrl.searchParams.get('returnTo') || '/', '/');
            const prompt = parsedUrl.searchParams.get('prompt') || undefined;
            if (!requireCurrentGeneration(res, routePlan)) return true;
            const { redirectUrl } = await authService.beginLogin({ baseUrl, returnTo, prompt });
            if (!requireCurrentGeneration(res, routePlan)) return true;
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
            if (method !== 'GET' && method !== 'POST') {
                res.writeHead(405); res.end(); return true;
            }
            const cookies = parseCookies(req);
            const sessionId = cookies.get(LOCAL_AUTH_COOKIE_NAME) || '';
            const session = getLocalSession(sessionId, { policy: authContext.policy });
            const routeKey = isHostBoundAuthContext(authContext)
                ? String(authContext.routeKey || '').trim()
                : getLocalRouteKey(parsedUrl, session, authContext.routeKey);
            const returnToFromQuery = normalizeRelativePath(parsedUrl.searchParams.get('returnTo') || '/', '/');

            if (!session) {
                const params = addUnboundAgent(
                    new URLSearchParams({ returnTo: returnToFromQuery }),
                    authContext,
                    routeKey,
                );
                res.writeHead(302, { Location: `/auth/login?${params.toString()}` });
                res.end('Authentication required');
                return true;
            }

            setAuthenticatedRequest(req, { session, sessionId, mode: 'local' });

            let body = null;
            if (method === 'POST') {
                body = await readLoginBody(req);
                if (rejectMismatchedHostSelector(res, authContext, body?.agent)) return true;
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

            const policy = getLocalAuthPolicyFromSession(session, authContext.policy);
            if (!policy) {
                if (method === 'GET') {
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-store'
                    });
                    res.end(renderExternalAccountHtml({
                        providerLabel: session?.externalAuth?.provider === 'github' ? 'GitHub' : 'External sign-in',
                        returnTo: returnToFromQuery,
                        username: req.user?.username || req.user?.name || '',
                        agentName: routeKey,
                        includeAgentSelector: !isHostBoundAuthContext(authContext),
                    }));
                    return true;
                }
                sendJson(res, 400, {
                    ok: false,
                    error: 'external_account_readonly',
                    message: 'Account settings are not available for this sign-in method.'
                });
                return true;
            }

            if (method === 'GET') {
                const localCfg = resolveLocalAuthConfig(policy);
                const csrfToken = issueBrowserMutationProof(req, res, {
                    routePlan,
                    authContext,
                    sessionId,
                    maxAge: getLocalSessionCookieMaxAge(),
                });
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store'
                });
                res.end(renderLocalAccountHtml({
                    agentName: routeKey,
                    returnTo: returnToFromQuery,
                    error: getLocalAccountErrorMessage(parsedUrl.searchParams.get('error') || ''),
                    notice: parsedUrl.searchParams.get('notice') || '',
                    username: req.user?.username || '',
                    usersVar: localCfg.usersVar,
                    csrfToken,
                    includeAgentSelector: !isHostBoundAuthContext(authContext),
                }));
                return true;
            }

            const returnTo = normalizeRelativePath(body?.returnTo || '/', '/');
            const nextUsername = String(body?.newUsername || '').trim();
            const currentPassword = String(body?.currentPassword || '');
            const newPassword = String(body?.newPassword || '');
            const confirmPassword = String(body?.confirmPassword || '');
            const wantsJson = String(req.headers?.accept || '').toLowerCase().includes('application/json');
            let errorCode = '';

            if (!currentPassword) {
                errorCode = 'current_password_required';
            } else if (!nextUsername) {
                errorCode = 'username_required';
            } else if ((newPassword || confirmPassword) && !confirmPassword) {
                errorCode = 'password_confirmation_required';
            } else if ((newPassword || confirmPassword) && newPassword !== confirmPassword) {
                errorCode = 'password_confirmation_mismatch';
            } else if (newPassword && newPassword.length < 8) {
                errorCode = 'password_too_short';
            }

            if (!errorCode) {
                try {
                    const result = updateLocalCredentials({
                        currentPassword,
                        nextUsername,
                        nextPassword: newPassword,
                        policy,
                        sessionUser: req.user
                    });
                    const clearCookie = buildCookie(LOCAL_AUTH_COOKIE_NAME, '', req, '/', { maxAge: 0, sameSite: 'Lax' });
                    const notice = result.passwordChanged
                        ? 'Credentials updated. Sign in again with the new username and password.'
                        : 'Username updated. Sign in again with the new username.';
                    appendLog('auth_local_account_updated', {
                        user: req.user?.username || null,
                        agent: routeKey || null,
                        usernameChanged: result.usernameChanged,
                        passwordChanged: result.passwordChanged
                    });
                    if (wantsJson) {
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            'Set-Cookie': clearCookie
                        });
                        res.end(JSON.stringify({ ok: true, notice }));
                        return true;
                    }
                    const params = addUnboundAgent(
                        new URLSearchParams({ returnTo, notice }),
                        authContext,
                        routeKey,
                    );
                    res.writeHead(302, {
                        Location: `/auth/login?${params.toString()}`,
                        'Set-Cookie': clearCookie
                    });
                    res.end('Credentials updated');
                    return true;
                } catch (err) {
                    errorCode = err?.message || 'local_account_update_failed';
                    appendLog('auth_local_account_update_failure', {
                        error: errorCode,
                        agent: routeKey || null
                    });
                }
            }

            if (wantsJson) {
                sendJson(res, 400, {
                    ok: false,
                    error: errorCode,
                    message: getLocalAccountErrorMessage(errorCode)
                });
                return true;
            }

            const params = addUnboundAgent(new URLSearchParams({ returnTo }), authContext, routeKey);
            if (errorCode) params.set('error', errorCode);
            res.writeHead(302, { Location: `/auth/account?${params.toString()}` });
            res.end('Unable to update credentials');
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
            if (!authService.isConfigured()) {
                sendJson(res, 503, { ok: false, error: 'sso_disabled' });
                return true;
            }
            if (method !== 'GET') {
                res.writeHead(405); res.end(); return true;
            }
            const code = parsedUrl.searchParams.get('code') || '';
            const state = parsedUrl.searchParams.get('state') || '';
            if (!code || !state) {
                sendJson(res, 400, { ok: false, error: 'missing_parameters' });
                return true;
            }
            if (!requireCurrentGeneration(res, routePlan)) return true;
            const result = await authService.handleCallback({ code, state, baseUrl });
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
                ? ((authContext.mode === 'local' || authContext.mode === 'guest')
                    ? getLocalSession(sessionId, { policy: authContext.policy })
                    : authService.getSession(sessionId))
                : null;
            const returnToFromQuery = normalizeRelativePath(parsedUrl.searchParams.get('returnTo') || '/', '/');
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
                        : authContext.mode === 'sso'
                            ? authService.getSessionCookieMaxAge()
                            : getLocalSessionCookieMaxAge(),
                });
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                });
                res.end(renderLogoutConfirmationHtml({
                    agentName: authContext.routeKey,
                    returnTo: returnToFromQuery,
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
            // For stateless JWT sessions (local + guest), add the session's sid to
            // the persistent revocation list so the cookie cannot be replayed.
            if (sessionId && (authContext.mode === 'local' || authContext.mode === 'guest')) {
                try {
                    const payload = verifySessionJwt(sessionId);
                    revokeSessionId({ sid: payload.sid, jti: payload.jti, reason: 'logout' });
                } catch { /* already invalid/expired — nothing to revoke */ }
            }
            const outcome = authContext.mode === 'local' || authContext.mode === 'guest'
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
            res.writeHead(302, { Location: redirectTarget || '/' });
            res.end('Logged out');
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
            const cookieMaxAge = sessionMode === 'local'
                ? getLocalSessionCookieMaxAge()
                : sessionMode === 'guest'
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
            if (isLocalAdminUser(session.user)) {
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
                    routeKey: authContext.boundHostRouteKey || authContext.serviceRouteKey || authContext.routeKey || 'control',
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
