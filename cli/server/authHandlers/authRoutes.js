import { verifySessionJwt } from '../auth/localService.js';
import { revokeSessionId } from '../auth/sessionRevocations.js';
import {
    appendLog,
    authService,
    buildCookie,
    getCookieNameForMode,
    getRequestBaseUrl,
    GUEST_SESSION_TTL_SECONDS,
    normalizeRelativePath,
    parseCookies,
    readJsonBody,
    sendJson,
    sessionTokenService,
    SSO_AUTH_COOKIE_NAME,
} from './shared.js';
import {
    resolveAuthContext,
    waitForAgentRedirectReady,
} from './authContext.js';
import {
    renderLoggedOutHtml,
    renderSsoLoginHtml,
} from './authPages.js';

function sendLocalAuthRemoved(res) {
    sendJson(res, 410, {
        ok: false,
        error: 'local_auth_removed',
        message: 'Local password auth was removed. Enable an SSO provider agent.'
    });
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
            if (authContext.mode === 'local' || authContext.mode === 'pwd') {
                sendLocalAuthRemoved(res);
                return true;
            }
            if (authContext.mode !== 'sso') {
                sendJson(res, 404, { ok: false, error: 'login_not_supported' });
                return true;
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
            sendLocalAuthRemoved(res);
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
            // Guest sessions are stateless JWTs; add their sid/jti to the
            // persistent revocation list so the cookie cannot be replayed.
            if (sessionId && authContext.mode === 'guest') {
                try {
                    const payload = verifySessionJwt(sessionId);
                    revokeSessionId({ sid: payload.sid, jti: payload.jti, reason: 'logout' });
                } catch { /* already invalid/expired — nothing to revoke */ }
            }
            const outcome = authContext.mode === 'sso'
                ? await authService.logout(sessionId, {
                    baseUrl,
                    postLogoutRedirectUri: requestedReturnTo
                })
                : { redirect: requestedReturnTo || '/' };
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
            const session = authContext.mode === 'guest'
                ? await sessionTokenService.getGuestSession(sessionId, { policy: authContext.policy })
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
            const cookieMaxAge = authContext.mode === 'guest'
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
