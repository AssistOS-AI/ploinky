import { readRouterSettings, updateRouterSettings } from '../../services/routerSettings.js';
import { readJsonBody, sendJson } from './shared.js';
import { resolveAuthContextForRouteKey } from './authContext.js';

function getUserAdminErrorStatus(code = '') {
    switch (String(code || '').trim()) {
        case 'authentication_required':
        case 'invalid_session':
            return 401;
        case 'admin_required':
            return 403;
        case 'local_auth_removed':
            return 410;
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
        case 'local_auth_removed':
            return 'Built-in local password user management was removed. Manage users in the configured SSO provider agent.';
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

export async function handleUserAdminRoutes(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname || '/';
    const route = parseUserAdminPath(pathname);
    if (!route) return false;

    const method = (req.method || 'GET').toUpperCase();
    const authContext = resolveAuthContextForRouteKey(route.agent);

    try {
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

        sendUserAdminError(res, 'local_auth_removed');
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
