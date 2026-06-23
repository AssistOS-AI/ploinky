import { authenticateLocalUser, getSession as getLocalSession, getSessionCookieMaxAge as getLocalSessionCookieMaxAge, resolveLocalAuthConfig, updateLocalCredentials, verifySessionJwt, revokeSession as revokeLocalSession } from '../auth/localService.js';
import { revokeSessionId } from '../auth/sessionRevocations.js';
import {
    appendLog,
    authService,
    buildCookie,
    getCookieNameForMode,
    getRequestBaseUrl,
    GUEST_SESSION_TTL_SECONDS,
    LOCAL_AUTH_COOKIE_NAME,
    normalizeRelativePath,
    parseCookies,
    readJsonBody,
    readLoginBody,
    sendJson,
    SSO_AUTH_COOKIE_NAME,
} from './shared.js';
import {
    getLocalAuthPolicyFromSession,
    getLocalRouteKey,
    resolveAuthContext,
    waitForAgentRedirectReady,
} from './authContext.js';
import {
    renderExternalAccountHtml,
    renderLocalAccountHtml,
    renderLocalLoginHtml,
    renderLoggedOutHtml,
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

export async function handleAuthRoutes(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname || '/';
    if (!pathname.startsWith('/auth/')) return false;
    const method = (req.method || 'GET').toUpperCase();
    const baseUrl = getRequestBaseUrl(req);
    const authContext = resolveAuthContext(parsedUrl);
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
                        agentName: authContext.routeKey,
                        returnTo,
                        error: parsedUrl.searchParams.get('error') || '',
                        notice: parsedUrl.searchParams.get('notice') || '',
                        usersVar: localCfg.usersVar
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
                const agent = String(body?.agent || authContext.routeKey || '').trim();
                try {
                    const result = authenticateLocalUser({ username, password, policy: authContext.policy, routeKey: agent });
                    await waitForAgentRedirectReady(agent);
                    const cookie = buildCookie(LOCAL_AUTH_COOKIE_NAME, result.sessionId, req, '/', {
                        maxAge: getLocalSessionCookieMaxAge(),
                        sameSite: 'Lax'
                    });
                    res.writeHead(302, {
                        Location: returnTo,
                        'Set-Cookie': cookie
                    });
                    res.end('Login successful');
                    appendLog('auth_local_login_success', { user: result.user?.username, agent });
                    return true;
                } catch (err) {
                    appendLog('auth_local_login_failure', { error: err?.message || String(err), agent });
                    const params = new URLSearchParams({
                        agent,
                        returnTo,
                        error: err?.message === 'local_auth_not_configured'
                            ? 'Local auth is not configured for this agent.'
                            : 'Invalid username or password.'
                    });
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
            const returnTo = parsedUrl.searchParams.get('returnTo') || '/';
            const prompt = parsedUrl.searchParams.get('prompt') || undefined;
            const { redirectUrl } = await authService.beginLogin({ baseUrl, returnTo, prompt });
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(renderSsoLoginHtml({
                agentName: authContext.routeKey,
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
            const routeKey = getLocalRouteKey(parsedUrl, session, authContext.routeKey);
            const returnToFromQuery = normalizeRelativePath(parsedUrl.searchParams.get('returnTo') || '/', '/');

            if (!session) {
                const params = new URLSearchParams({ returnTo: returnToFromQuery });
                if (routeKey) params.set('agent', routeKey);
                res.writeHead(302, { Location: `/auth/login?${params.toString()}` });
                res.end('Authentication required');
                return true;
            }

            req.user = session.user;
            req.session = session;
            req.sessionId = sessionId;
            req.authMode = 'local';

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
                        username: req.user?.username || req.user?.name || ''
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
                    usersVar: localCfg.usersVar
                }));
                return true;
            }

            const body = await readLoginBody(req);
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
                    const params = new URLSearchParams({ returnTo, notice });
                    if (routeKey) params.set('agent', routeKey);
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

            const params = new URLSearchParams({ returnTo });
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
            const result = await authService.handleCallback({ code, state, baseUrl });
            await waitForAgentRedirectReady(authContext.routeKey || '');
            const cookie = buildCookie(SSO_AUTH_COOKIE_NAME, result.sessionId, req, '/', {
                maxAge: authService.getSessionCookieMaxAge(),
                sameSite: 'Lax'
            });
            res.writeHead(302, {
                Location: result.redirectTo || '/',
                'Set-Cookie': cookie
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
            const requestedReturnTo = normalizeRelativePath(parsedUrl.searchParams.get('returnTo') || '/', '/');
            // For stateless JWT sessions (local + guest), add the session's sid to
            // the persistent revocation list so the cookie cannot be replayed.
            if (sessionId && (authContext.mode === 'local' || authContext.mode === 'guest')) {
                try {
                    const payload = verifySessionJwt(sessionId);
                    revokeSessionId({ sid: payload.sid, jti: payload.jti, reason: 'logout' });
                } catch { /* already invalid/expired — nothing to revoke */ }
            }
            const outcome = authContext.mode === 'local'
                ? (revokeLocalSession(sessionId), { redirect: requestedReturnTo || '/' })
                : await authService.logout(sessionId, {
                    baseUrl,
                    postLogoutRedirectUri: requestedReturnTo
                });
            const clearCookie = buildCookie(cookieName, '', req, '/', { maxAge: 0, sameSite: 'Lax' });
            const redirectTarget = outcome.redirect || requestedReturnTo || '/';
            if (method === 'GET' || redirectTarget) {
                res.writeHead(302, {
                    Location: redirectTarget || '/',
                    'Set-Cookie': clearCookie
                });
                res.end('Logged out');
            } else {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Set-Cookie': clearCookie
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
            const cookieName = getCookieNameForMode(authContext.mode);
            const sessionId = cookies.get(cookieName);
            if (!sessionId) {
                sendJson(res, 401, { ok: false, error: 'not_authenticated' });
                return true;
            }
            const session = (authContext.mode === 'local' || authContext.mode === 'guest')
                ? getLocalSession(sessionId, { policy: authContext.policy })
                : authService.getSession(sessionId);
            if (!session) {
                const clearCookie = buildCookie(cookieName, '', req, '/', { maxAge: 0, sameSite: 'Lax' });
                res.writeHead(401, {
                    'Content-Type': 'application/json',
                    'Set-Cookie': clearCookie
                });
                res.end(JSON.stringify({ ok: false, error: 'session_expired' }));
                return true;
            }
            let refreshRequested = false;
            if (method === 'POST') {
                try {
                    const body = await readJsonBody(req);
                    refreshRequested = Boolean(body?.refresh);
                } catch (_) { }
            }
            let tokenInfo;
            if (authContext.mode === 'sso' && refreshRequested) {
                tokenInfo = await authService.refreshSession(sessionId);
            } else {
                tokenInfo = {
                    accessToken: session.tokens?.accessToken || null,
                    expiresAt: session.expiresAt,
                    scope: session.tokens?.scope || null,
                    tokenType: session.tokens?.tokenType || null
                };
            }
            const cookieMaxAge = authContext.mode === 'local'
                ? getLocalSessionCookieMaxAge()
                : authContext.mode === 'guest'
                    ? GUEST_SESSION_TTL_SECONDS
                    : authService.getSessionCookieMaxAge();
            const cookie = buildCookie(cookieName, sessionId, req, '/', {
                maxAge: cookieMaxAge,
                sameSite: 'Lax'
            });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': cookie
            });
            res.end(JSON.stringify({ ok: true, token: tokenInfo, user: session.user }));
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
