import crypto from 'crypto';

import { parseCookies, buildCookie, appendSetCookie } from '../common.js';
import { getRuntimeMap, scheduleDisconnectedTabCleanup } from './runtimeState.js';

const APP_NAME = 'webchat';
const SID_COOKIE = `${APP_NAME}_sid`;
export function getSession(req, appState) {
    const cookies = parseCookies(req);
    const sid = cookies.get(SID_COOKIE);
    return (sid && appState.sessions.has(sid)) ? sid : null;
}

export function authorized(req) {
    return Boolean(req?.user);
}

export function redirectToRouterLogin(req, res, parsedUrl, agentOverride = '') {
    const returnTo = `${parsedUrl.pathname || `/${APP_NAME}/`}${parsedUrl.search || ''}`;
    const params = new URLSearchParams({ returnTo });
    if (agentOverride) {
        params.set('agent', agentOverride);
    }
    res.writeHead(302, {
        Location: `/auth/login?${params.toString()}`,
        'Cache-Control': 'no-store'
    });
    res.end('Authentication required');
}

export function ensureAppSession(req, res, appState) {
    const cookies = parseCookies(req);
    let sid = cookies.get(SID_COOKIE);
    if (!sid) {
        sid = crypto.randomBytes(16).toString('hex');
        appState.sessions.set(sid, { tabs: new Map(), createdAt: Date.now() });
        appendSetCookie(res, buildCookie(SID_COOKIE, sid, req, `/${APP_NAME}`));
    } else if (!appState.sessions.has(sid)) {
        appState.sessions.set(sid, { tabs: new Map(), createdAt: Date.now() });
    }
    if (!cookies.has(SID_COOKIE)) {
        const existing = req.headers.cookie || '';
        req.headers.cookie = existing ? `${existing}; ${SID_COOKIE}=${sid}` : `${SID_COOKIE}=${sid}`;
    }
    return sid;
}

function buildLogoutRedirect(agentQuery) {
    return agentQuery ? `/${APP_NAME}/?${agentQuery}` : `/${APP_NAME}/`;
}

function buildSsoLogoutRedirect(agentQuery) {
    const loggedOut = '/auth/logged-out';
    return `/auth/logout?returnTo=${encodeURIComponent(loggedOut)}`;
}

export function handleLogout(req, res, appState, agentQuery) {
    const sid = getSession(req, appState);
    const session = sid ? appState.sessions.get(sid) : null;

    for (const [runtimeKey, runtime] of getRuntimeMap(appState).entries()) {
        if (!(runtime.subscribers instanceof Map)) continue;
        for (const [connectionId, subscriber] of runtime.subscribers.entries()) {
            if (subscriber.sid !== sid) continue;
            try { subscriber.res.end(); } catch (_) { }
            runtime.subscribers.delete(connectionId);
        }
        if (runtime.subscribers.size === 0) {
            scheduleDisconnectedTabCleanup(runtime, runtimeKey, { runtimes: getRuntimeMap(appState) });
        }
    }

    if (sid) {
        appState.sessions.delete(sid);
    }

    const cookies = [
        buildCookie(SID_COOKIE, '', req, `/${APP_NAME}`, { maxAge: 0 })
    ];

    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': cookies,
        'Cache-Control': 'no-store'
    });
    const redirect = req.user
        ? buildSsoLogoutRedirect(agentQuery)
        : buildLogoutRedirect(agentQuery);
    res.end(JSON.stringify({
        ok: true,
        redirect
    }));
}
