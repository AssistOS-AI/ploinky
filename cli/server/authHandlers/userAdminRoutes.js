import { createLocalAuthUser, deleteLocalAuthUser, getSession as getLocalSession, getSessionCookieMaxAge as getLocalSessionCookieMaxAge, isLocalAdminUser, listLocalAuthRoles, listLocalAuthUsers, updateLocalAuthUser } from '../auth/localService.js';
import { verifyAdminMutationRequest } from '../adminControlSecurity.js';
import {
    mintBrowserCsrfToken,
    verifyBrowserMutationRequest,
} from '../browserMutationSecurity.js';
import { readRouterSettings, updateRouterSettings } from '../auth/routerSettings.js';
import {
    appendSetCookie,
    buildCookie,
    LOCAL_AUTH_COOKIE_NAME,
    parseCookies,
    readJsonBody,
    sendJson,
} from './shared.js';
import { resolveAuthContextForRouteKey } from './authContext.js';

export const USER_ADMIN_CSRF_COOKIE_NAME = 'ploinky_user_admin_csrf';

function getUserAdminErrorStatus(code = '') {
    switch (String(code || '').trim()) {
        case 'authentication_required':
        case 'invalid_session':
            return 401;
        case 'admin_required':
            return 403;
        case 'local_auth_disabled':
        case 'user_not_found':
        case 'not_found':
            return 404;
        case 'username_taken':
        case 'last_admin_required':
        case 'roles_must_be_array':
        case 'username_required':
        case 'password_required':
        case 'user_id_required':
        case 'no_changes_requested':
            return 400;
        default:
            return 500;
    }
}

function getUserAdminErrorMessage(code = '') {
    switch (String(code || '').trim()) {
        case 'authentication_required':
        case 'invalid_session':
            return 'Authentication required.';
        case 'admin_required':
            return 'Admin access is required.';
        case 'local_auth_disabled':
            return 'Local auth is not enabled for this agent.';
        case 'user_not_found':
            return 'User not found.';
        case 'not_found':
            return 'Not found.';
        case 'username_taken':
            return 'Username is already in use.';
        case 'last_admin_required':
            return 'At least one admin user is required.';
        case 'roles_must_be_array':
            return 'Roles must be an array.';
        case 'username_required':
            return 'Username is required.';
        case 'password_required':
            return 'Password is required.';
        case 'user_id_required':
            return 'User id is required.';
        case 'no_changes_requested':
            return 'No changes were submitted.';
        default:
            return code ? 'User management request failed.' : '';
    }
}

function parseUserAdminPath(pathname = '') {
    const parts = String(pathname || '').split('/').filter(Boolean);
    if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'agents') {
        return null;
    }
    if (parts[3] !== 'users' && parts[3] !== 'settings') {
        return null;
    }
    if (parts.length > 5) {
        return null;
    }
    return {
        agent: decodeURIComponent(parts[2] || ''),
        resource: parts[3],
        userId: parts[4] ? decodeURIComponent(parts[4]) : ''
    };
}

function sendUserAdminError(res, code, detail = '') {
    const status = getUserAdminErrorStatus(code);
    sendJson(res, status, {
        ok: false,
        error: code,
        message: getUserAdminErrorMessage(code),
        ...(detail ? { detail } : {})
    });
}

async function readUserAdminBody(req) {
    try {
        return await readJsonBody(req);
    } catch (error) {
        const err = new Error('invalid_json');
        err.cause = error;
        throw err;
    }
}

function publicUserAdminAuthContext(routePlan, route, authContext) {
    const selectedRouteKey = String(routePlan?.hostSelection?.record?.routeKey || '').trim();
    if (routePlan?.ok !== true
        || routePlan?.kind !== 'router-surface'
        || routePlan?.surface !== 'user-admin'
        || routePlan?.listener !== 'public'
        || routePlan?.hostSelection?.kind !== 'agent-root'
        || !selectedRouteKey
        || selectedRouteKey !== route.agent) {
        return null;
    }
    return {
        ...authContext,
        boundHostRouteKey: selectedRouteKey,
        mutationRouteKey: `user-admin:${selectedRouteKey}`,
    };
}

export async function handleUserAdminRoutes(req, res, parsedUrl, { routePlan = null } = {}) {
    const pathname = parsedUrl.pathname || '/';
    const route = parseUserAdminPath(pathname);
    if (!route) return false;

    const method = (req.method || 'GET').toUpperCase();
    if (routePlan?.lease?.commit && routePlan.lease.commit() !== true) {
        sendJson(res, 503, { ok: false, error: 'edge_generation_changed' });
        return true;
    }
    const authContext = resolveAuthContextForRouteKey(route.agent, {
        snapshot: routePlan?.snapshot || routePlan?.lease?.snapshot || null,
    });
    if (authContext.mode !== 'local' || !authContext.policy?.usersVar) {
        sendUserAdminError(res, 'local_auth_disabled');
        return true;
    }

    const cookies = parseCookies(req);
    const sessionId = cookies.get(LOCAL_AUTH_COOKIE_NAME) || '';
    const session = getLocalSession(sessionId, { policy: authContext.policy });
    if (!session) {
        sendUserAdminError(res, 'authentication_required');
        return true;
    }
    if (!isLocalAdminUser(session.user)) {
        sendUserAdminError(res, 'admin_required');
        return true;
    }
    req.user = session.user;
    req.session = session;
    req.sessionId = sessionId;
    const publicAuthContext = publicUserAdminAuthContext(routePlan, route, authContext);
    if (['POST', 'PATCH', 'DELETE'].includes(method)) {
        const publicCsrfToken = publicAuthContext
            ? cookies.get(USER_ADMIN_CSRF_COOKIE_NAME) || ''
            : '';
        const mutationDecision = publicAuthContext
            ? (publicCsrfToken
                ? verifyBrowserMutationRequest(req, {
                    routePlan,
                    authContext: publicAuthContext,
                    sessionId,
                    token: publicCsrfToken,
                })
                : { ok: false, code: 'BROWSER_CSRF_INVALID' })
            : verifyAdminMutationRequest(req, sessionId);
        if (!mutationDecision.ok) {
            sendJson(res, 403, {
                ok: false,
                error: mutationDecision.code.toLowerCase(),
                message: 'Exact control Origin and CSRF proof are required.',
            });
            return true;
        }
    }

    try {
        const cookie = buildCookie(LOCAL_AUTH_COOKIE_NAME, sessionId, req, '/', {
            maxAge: getLocalSessionCookieMaxAge(),
            sameSite: 'Lax'
        });
        res.setHeader('Set-Cookie', cookie);
        if (publicAuthContext) {
            const userAdminCsrfToken = mintBrowserCsrfToken({
                req,
                routePlan,
                authContext: publicAuthContext,
                sessionId,
            });
            appendSetCookie(res, buildCookie(
                USER_ADMIN_CSRF_COOKIE_NAME,
                userAdminCsrfToken,
                req,
                `/api/agents/${encodeURIComponent(route.agent)}`,
                {
                    maxAge: getLocalSessionCookieMaxAge(),
                    sameSite: 'Strict',
                },
            ));
        }

        if (route.resource === 'settings') {
            if (route.userId) {
                sendUserAdminError(res, 'not_found');
                return true;
            }
            if (method === 'GET') {
                sendJson(res, 200, {
                    ok: true,
                    agent: authContext.routeKey,
                    settings: readRouterSettings()
                });
                return true;
            }
            if (method === 'PATCH') {
                const body = await readUserAdminBody(req);
                if (routePlan?.lease?.commit && routePlan.lease.commit() !== true) {
                    sendJson(res, 503, { ok: false, error: 'edge_generation_changed' });
                    return true;
                }
                const settings = updateRouterSettings({
                    loginBrandingName: body?.loginBrandingName
                });
                sendJson(res, 200, {
                    ok: true,
                    agent: authContext.routeKey,
                    settings
                });
                return true;
            }
            res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, PATCH' });
            res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
            return true;
        }

        if (method === 'GET' && !route.userId) {
            const users = listLocalAuthUsers(authContext.policy)
                .sort((left, right) => String(left.username || '').localeCompare(String(right.username || '')));
            sendJson(res, 200, {
                ok: true,
                agent: authContext.routeKey,
                availableRoles: listLocalAuthRoles(authContext.policy),
                users
            });
            return true;
        }

        if (method === 'POST' && !route.userId) {
            const body = await readUserAdminBody(req);
            if (routePlan?.lease?.commit && routePlan.lease.commit() !== true) {
                sendJson(res, 503, { ok: false, error: 'edge_generation_changed' });
                return true;
            }
            const user = createLocalAuthUser({
                policy: authContext.policy,
                username: body?.username,
                password: body?.password,
                name: body?.name,
                email: body?.email,
                roles: Object.prototype.hasOwnProperty.call(body || {}, 'roles') ? body.roles : undefined
            });
            sendJson(res, 201, {
                ok: true,
                agent: authContext.routeKey,
                user
            });
            return true;
        }

        if (method === 'PATCH' && route.userId) {
            const body = await readUserAdminBody(req);
            if (routePlan?.lease?.commit && routePlan.lease.commit() !== true) {
                sendJson(res, 503, { ok: false, error: 'edge_generation_changed' });
                return true;
            }
            const user = updateLocalAuthUser({
                policy: authContext.policy,
                id: route.userId,
                username: Object.prototype.hasOwnProperty.call(body || {}, 'username') ? body.username : undefined,
                password: Object.prototype.hasOwnProperty.call(body || {}, 'password') ? body.password : undefined,
                name: Object.prototype.hasOwnProperty.call(body || {}, 'name') ? body.name : undefined,
                email: Object.prototype.hasOwnProperty.call(body || {}, 'email') ? body.email : undefined,
                roles: Object.prototype.hasOwnProperty.call(body || {}, 'roles') ? body.roles : undefined
            });
            sendJson(res, 200, {
                ok: true,
                agent: authContext.routeKey,
                user
            });
            return true;
        }

        if (method === 'DELETE' && route.userId) {
            if (routePlan?.lease?.commit && routePlan.lease.commit() !== true) {
                sendJson(res, 503, { ok: false, error: 'edge_generation_changed' });
                return true;
            }
            const user = deleteLocalAuthUser({
                policy: authContext.policy,
                id: route.userId
            });
            sendJson(res, 200, {
                ok: true,
                agent: authContext.routeKey,
                deleted: true,
                user
            });
            return true;
        }

        res.writeHead(405, { 'Content-Type': 'application/json', Allow: route.userId ? 'PATCH, DELETE' : 'GET, POST' });
        res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
        return true;
    } catch (error) {
        const code = error?.message === 'invalid_json' ? 'invalid_json' : (error?.message || 'user_admin_failed');
        if (code === 'invalid_json') {
            sendJson(res, 400, { ok: false, error: code, message: 'Request body must be valid JSON.' });
            return true;
        }
        sendUserAdminError(res, code, error?.message || String(error));
        return true;
    }
}
