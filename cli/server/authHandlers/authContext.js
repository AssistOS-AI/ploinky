import fs from 'fs';
import path from 'path';

import { PLOINKY_WORKSPACE_ROOT, ROUTING_FILE } from '../../utils/config.js';
import { resolveEnabledAgentRecord } from '../../utils/agents.js';
import { findAgent } from '../../utils/utils.js';
import { GUEST_SESSION_TTL_SECONDS, getSessionCookieMaxAge as getLocalSessionCookieMaxAge, mintGuestSessionJwt, mintSessionJwt } from '../auth/localService.js';
import { waitForAgentReady } from '../utils/agentReadiness.js';
import { BROWSER_CSRF_COOKIE_NAME, mintBrowserCsrfToken } from '../browserMutationSecurity.js';
import {
    appendLog,
    appendSetCookie,
    authService,
    buildCookie,
    getCookieNameForMode,
    GUEST_AUTH_COOKIE_NAME,
    LOCAL_AUTH_COOKIE_NAME,
    parseCookies,
    sendJson,
    sessionTokenService,
    SSO_AUTH_COOKIE_NAME,
    wantsJsonResponse,
} from './shared.js';

function snapshotFromOptions(options = {}) {
    return options?.snapshot || options?.routePlan?.snapshot || options?.routePlan?.lease?.snapshot || null;
}

function readRouting(options = {}) {
    const snapshot = snapshotFromOptions(options);
    if (snapshot) return snapshot.routing || {};
    const dynamicRoutingFile = process.env.PLOINKY_ROUTING_FILE
        || path.join(resolveCurrentWorkspaceRoot(), '.ploinky', 'routing.json');
    const routingFile = fs.existsSync(dynamicRoutingFile) ? dynamicRoutingFile : ROUTING_FILE;
    try {
        return JSON.parse(fs.readFileSync(routingFile, 'utf8')) || {};
    } catch (_) {
        return {};
    }
}

function resolveEnabledAgentRecordFromSnapshot(agentRef, snapshot) {
    const input = String(agentRef || '').trim();
    if (!input || !snapshot || typeof snapshot !== 'object') return null;
    const agents = snapshot.agents && typeof snapshot.agents === 'object' ? snapshot.agents : {};
    const routing = snapshot.routing && typeof snapshot.routing === 'object' ? snapshot.routing : {};
    const route = routing.routes?.[input] || null;
    const exactContainer = String(route?.container || '').trim();
    if (exactContainer && agents[exactContainer]?.type === 'agent') {
        return { containerName: exactContainer, record: agents[exactContainer] };
    }

    const parts = input.split(/[:/]/).filter(Boolean);
    const namespaced = parts.length === 2;
    const repoName = namespaced ? parts[0] : String(route?.repo || '').trim();
    const agentName = namespaced ? parts[1] : String(route?.agent || input).trim();
    const matches = Object.entries(agents).filter(([, record]) => (
        record?.type === 'agent'
        && (
            String(record.alias || '') === input
            || (repoName && agentName
                && String(record.repoName || '') === repoName
                && String(record.agentName || '') === agentName)
            || (!repoName && String(record.agentName || '') === agentName)
        )
    ));
    if (matches.length > 1) {
        const error = new Error(`active edge generation has ambiguous auth owner '${input}'`);
        error.code = 'EDGE_GENERATION_INVALID';
        throw error;
    }
    return matches.length === 1 ? { containerName: matches[0][0], record: matches[0][1] } : null;
}

function resolveEnabledAgentRecordForAuth(routeKey, options = {}) {
    const snapshot = snapshotFromOptions(options);
    if (snapshot) return resolveEnabledAgentRecordFromSnapshot(routeKey, snapshot);
    return resolveEnabledAgentRecord(routeKey);
}

function resolveCurrentWorkspaceRoot() {
    return String(process.env.PLOINKY_WORKSPACE_ROOT || '').trim() || PLOINKY_WORKSPACE_ROOT;
}

async function waitForAgentRedirectReady(agentName, options = {}) {
    const normalizedAgent = typeof agentName === 'string' ? agentName.trim() : '';
    if (!normalizedAgent) {
        return true;
    }
    const snapshot = snapshotFromOptions(options);
    const route = snapshot?.routing?.routes?.[normalizedAgent] || normalizedAgent;
    return waitForAgentReady(route, {
        timeoutMs: 5000,
        intervalMs: 125,
        probeTimeoutMs: 250,
        beforeProbe: options.routePlan?.lease?.commit
            ? () => options.routePlan.lease.commit() === true
            : null,
    });
}

function readJsonFileIfExists(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return null;
    }
}

function readEnabledAgentManifest(routeKey, routes = {}, options = {}) {
    const normalizedRouteKey = String(routeKey || '').trim();
    if (!normalizedRouteKey) return null;

    const snapshot = snapshotFromOptions(options);
    if (snapshot) return snapshot.manifests?.[normalizedRouteKey] || null;

    const routeHostPath = String(routes?.[normalizedRouteKey]?.hostPath || '').trim();
    const routeManifest = readJsonFileIfExists(routeHostPath ? path.join(routeHostPath, 'manifest.json') : '');
    if (routeManifest) return routeManifest;

    let resolved = null;
    try {
        resolved = resolveEnabledAgentRecord(normalizedRouteKey);
    } catch (_) {
        resolved = null;
    }
    const record = resolved?.record || null;
    if (!record?.repoName || !record?.agentName) return null;

    try {
        const found = findAgent(`${record.repoName}/${record.agentName}`);
        return readJsonFileIfExists(found?.manifestPath || '');
    } catch (_) {
        return null;
    }
}

function resolveSurfaceAuthRouteKey(surfaceName, targetRouteKey, routing = {}, options = {}) {
    const normalizedSurface = String(surfaceName || '').trim();
    const normalizedTarget = String(targetRouteKey || '').trim();
    if (!normalizedSurface || !normalizedTarget) return '';

    const manifest = readEnabledAgentManifest(normalizedTarget, routing.routes || {}, options);
    const surfaceConfig = manifest?.[normalizedSurface];
    const authPolicy = typeof surfaceConfig === 'string'
        ? surfaceConfig
        : String(surfaceConfig?.auth || '').trim();
    const normalizedAuthPolicy = String(authPolicy || '').trim().toLowerCase();

    if (normalizedAuthPolicy === 'static') {
        return String(routing.static?.agent || '').trim();
    }
    if (normalizedAuthPolicy === 'self') {
        return normalizedTarget;
    }
    return '';
}

function resolveAuthRouteKey(parsedUrl, options = {}) {
    const pathname = parsedUrl.pathname || '/';
    const parts = pathname.split('/').filter(Boolean);
    const routing = readRouting(options);
    const routes = routing.routes || {};
    const explicit = String(parsedUrl.searchParams.get('agent') || '').trim();
    const staticAgent = String(routing.static?.agent || '').trim();
    if (parts[0] === 'webchat' && explicit) {
        const surfaceAuthRoute = resolveSurfaceAuthRouteKey('webchat', explicit, routing, options);
        if (surfaceAuthRoute) {
            return surfaceAuthRoute;
        }
    }
    if (parts.length >= 1 && routes[parts[0]]) {
        const pathAgent = parts[0];
        if (explicit) return explicit;
        try {
            const resolved = resolveEnabledAgentRecordForAuth(pathAgent, options);
            const pathAuthMode = String(resolved?.record?.auth?.mode || 'none').trim().toLowerCase() || 'none';
            if (pathAuthMode !== 'none') {
                return pathAgent;
            }
        } catch (_) { }
        if (!staticAgent) return pathAgent;
        if (staticAgent) return staticAgent;
    }
    if (explicit) return explicit;
    return staticAgent || null;
}

function resolveAuthContext(parsedUrl, options = {}) {
    const routeKey = resolveAuthRouteKey(parsedUrl, options);
    if (!routeKey) {
        return { routeKey: null, mode: 'none', policy: { mode: 'none' }, record: null };
    }
    const resolved = resolveEnabledAgentRecordForAuth(routeKey, options);
    const record = resolved?.record || null;
    const policy = record?.auth || { mode: 'none' };
    const mode = String(policy.mode || 'none').trim().toLowerCase() || 'none';
    return { routeKey, mode, policy, record };
}

function resolveAuthContextForRouteKey(routeKey, options = {}) {
    const normalizedRouteKey = String(routeKey || '').trim();
    if (!normalizedRouteKey) {
        return { routeKey: null, mode: 'none', policy: { mode: 'none' }, record: null };
    }
    const resolved = resolveEnabledAgentRecordForAuth(normalizedRouteKey, options);
    const record = resolved?.record || null;
    const policy = record?.auth || { mode: 'none' };
    const mode = String(policy.mode || 'none').trim().toLowerCase() || 'none';
    return { routeKey: normalizedRouteKey, mode, policy, record };
}

function isUserAuthenticatedAuthMode(mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    return Boolean(normalized && normalized !== 'none' && normalized !== 'guest');
}

function resolveAuthenticatedRouteAuthContext(routeKey, options = {}) {
    const normalizedRouteKey = String(routeKey || '').trim();
    const routing = readRouting(options);
    const ownerContext = resolveAuthContextForRouteKey(normalizedRouteKey, options);
    if (isUserAuthenticatedAuthMode(ownerContext.mode)) return ownerContext;

    const staticRouteKey = String(routing.static?.agent || '').trim();
    if (staticRouteKey && staticRouteKey !== normalizedRouteKey) {
        const staticContext = resolveAuthContextForRouteKey(staticRouteKey, options);
        if (isUserAuthenticatedAuthMode(staticContext.mode)) {
            return { ...staticContext, serviceRouteKey: normalizedRouteKey };
        }
    }

    return {
        routeKey: normalizedRouteKey,
        mode: 'authenticated-unconfigured',
        policy: { mode: 'authenticated-unconfigured' },
        record: ownerContext.record || null,
        error: 'authenticated_http_route_auth_not_configured',
        errorDetail: 'Authenticated HTTP routes require a user-authenticated route or static-agent auth policy.'
    };
}

function routePlanSelectedRouteKey(routePlan) {
    return String(
        routePlan?.hostSelection?.record?.routeKey
        || routePlan?.definition?.routeKey
        || routePlan?.routeKey
        || '',
    ).trim();
}

function isHostBoundRoutePlan(routePlan) {
    return ['agent-root', 'dedicated-service'].includes(String(routePlan?.hostSelection?.kind || ''));
}

export function resolveAuthContextForRoutePlan(parsedUrl, routePlan, { browserAuth = false } = {}) {
    const snapshot = snapshotFromOptions({ routePlan });
    const selectedRouteKey = routePlanSelectedRouteKey(routePlan);
    if (browserAuth && isHostBoundRoutePlan(routePlan) && selectedRouteKey) {
        return {
            ...resolveAuthenticatedRouteAuthContext(selectedRouteKey, { snapshot }),
            boundHostRouteKey: selectedRouteKey,
            boundGeneration: String(routePlan?.lease?.id || snapshot?.generation || ''),
        };
    }

    const decision = routePlan?.decision;
    if (decision?.access === 'guest') {
        return resolveGuestRouteAuthContext(decision.routeKey, decision);
    }
    if (decision?.access === 'authenticated') {
        return resolveAuthenticatedRouteAuthContext(decision.routeKey, { snapshot });
    }
    if (selectedRouteKey && routePlan?.kind === 'agent-root') {
        const routeDefault = snapshot?.compiled?.policy?.routeDefaults?.[selectedRouteKey];
        if (routeDefault?.access === 'authenticated') {
            return resolveAuthenticatedRouteAuthContext(selectedRouteKey, { snapshot });
        }
        if (routeDefault?.access === 'guest') {
            return resolveGuestRouteAuthContext(selectedRouteKey, routeDefault);
        }
    }
    return resolveAuthContext(parsedUrl, { snapshot });
}

function resolveGuestRouteAuthContext(routeKey, options = {}) {
    return {
        routeKey: String(routeKey || '').trim(),
        mode: 'guest',
        policy: {
            mode: 'guest',
            guestScope: String(options.guestScope || `http-route:${routeKey || ''}`).trim(),
        },
        record: null,
    };
}

export function resolveRouteDefaultHttpAccess(routeKey, options = {}) {
    const normalizedRouteKey = String(routeKey || '').trim();
    const context = resolveAuthContextForRouteKey(normalizedRouteKey, options);
    if (context.mode === 'guest') {
        return { access: 'guest', routeKey: normalizedRouteKey, source: 'routeDefault' };
    }
    if (isUserAuthenticatedAuthMode(context.mode)) {
        return { access: 'authenticated', routeKey: normalizedRouteKey, source: 'routeDefault' };
    }

    const staticRouteKey = String(readRouting(options).static?.agent || '').trim();
    if (staticRouteKey && staticRouteKey !== normalizedRouteKey) {
        const staticContext = resolveAuthContextForRouteKey(staticRouteKey, options);
        if (isUserAuthenticatedAuthMode(staticContext.mode)) {
            return { access: 'authenticated', routeKey: normalizedRouteKey, source: 'routeDefault' };
        }
        if (staticContext.mode === 'guest') {
            return { access: 'guest', routeKey: normalizedRouteKey, source: 'routeDefault' };
        }
    }

    return { access: 'guest', routeKey: normalizedRouteKey, source: 'routeDefault' };
}

function getLocalRouteKey(parsedUrl, session = null, fallback = '') {
    const fromSession = String(session?.localAuth?.routeKey || session?.externalAuth?.routeKey || '').trim();
    if (fromSession) return fromSession;
    const fromQuery = String(parsedUrl.searchParams.get('agent') || '').trim();
    if (fromQuery) return fromQuery;
    return String(fallback || '').trim();
}

function getLocalAuthPolicyFromSession(session = null, fallbackPolicy = null) {
    const localAuth = session?.localAuth || {};
    if (localAuth.usersVar) {
        return {
            mode: 'local',
            usersVar: localAuth.usersVar
        };
    }
    if (session?.externalAuth?.provider) {
        return null;
    }
    return fallbackPolicy;
}

async function resolveSessionForAuthContext(authContext, sessionId) {
    if (!sessionId) return null;
    let session = authContext.mode === 'local'
        ? await sessionTokenService.getUserSession(sessionId, { policy: authContext.policy })
        : authService.getSession(sessionId);
    if (authContext.mode === 'sso' && (!session || (session.expiresAt && Date.now() > session.expiresAt))) {
        try {
            await authService.refreshSession(sessionId);
        } catch (_) {
            // ignore refresh failures; caller will treat as unauthenticated
        }
        session = authService.getSession(sessionId);
    }
    return session;
}

function respondUnauthenticated(req, res, parsedUrl, authContext = resolveAuthContext(parsedUrl), options = {}) {
    const pathname = parsedUrl.pathname || '/';
    const returnTo = `${pathname || '/'}${parsedUrl.search || ''}`;
    const query = new URLSearchParams({ returnTo });
    if (authContext?.routeKey && !isHostBoundRoutePlan(options.routePlan)) query.set('agent', authContext.routeKey);
    const loginUrl = `/auth/login?${query.toString()}`;
    const cookieName = getCookieNameForMode(authContext?.mode);
    const clearCookie = buildCookie(cookieName, '', req, '/', { maxAge: 0, sameSite: 'Lax' });
    const method = (req.method || 'GET').toUpperCase();
    const wantsJson = wantsJsonResponse(req, pathname) || method !== 'GET';
    if (wantsJson) {
        res.writeHead(401, {
            'Content-Type': 'application/json',
            'Set-Cookie': clearCookie
        });
        res.end(JSON.stringify({ ok: false, error: 'not_authenticated', login: loginUrl }));
    } else {
        res.writeHead(302, {
            Location: loginUrl,
            'Set-Cookie': clearCookie
        });
        res.end('Authentication required');
    }
    return { ok: false };
}

export function buildIdentityHeaders(req) {
    if (!req || !req.user) return {};
    const headers = {};
    const user = req.user || {};
    if (user.id) headers['X-Ploinky-User-Id'] = String(user.id);
    const name = user.username || user.email || user.name || user.id;
    if (name) headers['X-Ploinky-User'] = String(name);
    if (user.email) headers['X-Ploinky-User-Email'] = String(user.email);
    if (Array.isArray(user.roles) && user.roles.length) {
        headers['X-Ploinky-User-Roles'] = user.roles.join(',');
    }
    if (req.sessionId) headers['X-Ploinky-Session-Id'] = String(req.sessionId);
    if (req.session?.tokens?.accessToken) {
        headers['Authorization'] = `Bearer ${req.session.tokens.accessToken}`;
    }
    return headers;
}

export async function ensureAgentAuthenticated(req, res, parsedUrl) {
    return {
        ok: false,
        error: 'legacy_agent_bearer_auth_removed',
        detail: 'Agent-to-agent calls use an Agent Assertion JWT carried as `Authorization: Bearer`, verified by the router (DS013).'
    };
}

function finalizeAuthenticatedRequest(req, res, authContext, options, session) {
    req.edgeAuthContext = authContext;
    if (req.sessionId && options.routePlan?.lease?.id) {
        try {
            const csrfToken = mintBrowserCsrfToken({
                req,
                routePlan: options.routePlan,
                authContext,
                sessionId: req.sessionId,
            });
            const csrfCookie = buildCookie(BROWSER_CSRF_COOKIE_NAME, csrfToken, req, '/', {
                maxAge: req.authMode === 'guest'
                    ? GUEST_SESSION_TTL_SECONDS
                    : (req.authMode === 'local'
                        ? getLocalSessionCookieMaxAge()
                        : authService.getSessionCookieMaxAge()),
                sameSite: 'Strict',
            });
            appendSetCookie(res, csrfCookie);
            req.browserCsrfToken = csrfToken;
        } catch (_) {
            // The route remains authenticated, but every state-changing browser
            // request will fail closed when no exact generation/origin proof exists.
        }
    }
    return { ok: true, session };
}

async function ensureAuthenticatedWithContext(req, res, parsedUrl, authContext, options = {}) {
    if (options.routePlan?.lease?.commit && options.routePlan.lease.commit() !== true) {
        sendJson(res, 503, { ok: false, error: 'edge_generation_changed' });
        return { ok: false, error: 'edge_generation_changed' };
    }
    if (authContext.error === 'authenticated_http_route_auth_not_configured') {
        sendJson(res, 503, {
            ok: false,
            error: authContext.error,
            detail: authContext.errorDetail || 'Authenticated HTTP routes require a user-authenticated route or static-agent auth policy.',
        });
        return { ok: false, error: authContext.error };
    }
    const cookies = parseCookies(req);
    const localCookie = cookies.get(LOCAL_AUTH_COOKIE_NAME);
    if (localCookie) {
        const localCliSession = await sessionTokenService.getUserSession(localCookie, { policy: {} });
        if (localCliSession?._jwtPayload?.chn === 'cli'
            && localCliSession?.user?.id === 'local:admin') {
            req.user = localCliSession.user;
            req.session = localCliSession;
            req.sessionId = localCookie;
            req.authMode = 'local';
            req.authChannel = 'cli';
            return finalizeAuthenticatedRequest(req, res, authContext, options, localCliSession);
        }
    }
    if (authContext.mode === 'none') {
        if (localCookie) {
            const localSession = await sessionTokenService.getUserSession(localCookie, { policy: {} });
            if (localSession) {
                req.user = localSession.user;
                req.session = localSession;
                req.sessionId = localCookie;
                req.authMode = 'local';
                return finalizeAuthenticatedRequest(req, res, authContext, options, localSession);
            }
        }
        return { ok: true };
    }
    if (authContext.mode === 'sso' && !authService.isConfigured()) {
        sendJson(res, 503, { ok: false, error: 'sso_not_configured' });
        return { ok: false, error: 'sso_not_configured' };
    }

    if (authContext.mode === 'guest') {
        const existingAuth = cookies.get(LOCAL_AUTH_COOKIE_NAME);
        if (existingAuth) {
            const authSession = await sessionTokenService.getUserSession(existingAuth, { policy: authContext.policy });
            if (authSession) {
                req.user = authSession.user;
                req.session = authSession;
                req.sessionId = existingAuth;
                req.authMode = 'local';
                return finalizeAuthenticatedRequest(req, res, authContext, options, authSession);
            }
        }
        const ssoCookie = cookies.get(SSO_AUTH_COOKIE_NAME);
        if (ssoCookie && authService.isConfigured()) {
            const ssoSession = authService.getSession(ssoCookie);
            if (ssoSession && (!ssoSession.expiresAt || Date.now() <= ssoSession.expiresAt)) {
                req.user = ssoSession.user;
                req.session = ssoSession;
                req.sessionId = ssoCookie;
                req.authMode = 'sso';
                return finalizeAuthenticatedRequest(req, res, authContext, options, ssoSession);
            }
        }
        const guestCookie = cookies.get(GUEST_AUTH_COOKIE_NAME);
        if (guestCookie) {
            const guestSession = await sessionTokenService.getGuestSession(guestCookie, { policy: authContext.policy });
            if (guestSession) {
                req.user = guestSession.user;
                req.session = guestSession;
                req.sessionId = guestCookie;
                req.authMode = 'guest';
                return finalizeAuthenticatedRequest(req, res, authContext, options, guestSession);
            }
        }
        const guestJwt = mintGuestSessionJwt({ policy: authContext.policy });
        const guestSession = await sessionTokenService.getGuestSession(guestJwt, { policy: authContext.policy });
        const cookie = buildCookie(GUEST_AUTH_COOKIE_NAME, guestJwt, req, '/', {
            maxAge: GUEST_SESSION_TTL_SECONDS,
            sameSite: 'Lax'
        });
        appendSetCookie(res, cookie);
        req.user = guestSession?.user || { id: 'guest', username: 'visitor', roles: ['guest'] };
        req.session = guestSession;
        req.sessionId = guestJwt;
        req.authMode = 'guest';
        appendLog('auth_guest_session_created', { path: parsedUrl.pathname });
        return finalizeAuthenticatedRequest(req, res, authContext, options, guestSession);
    }

    const cookieName = getCookieNameForMode(authContext.mode);
    const sessionId = cookies.get(cookieName);
    if (!sessionId) {
        appendLog('auth_missing_cookie', { path: parsedUrl.pathname });
        return respondUnauthenticated(req, res, parsedUrl, authContext, options);
    }
    let session = authContext.mode === 'local'
        ? await sessionTokenService.getUserSession(sessionId, { policy: authContext.policy })
        : authService.getSession(sessionId);
    if (authContext.mode === 'sso' && (!session || (session.expiresAt && Date.now() > session.expiresAt))) {
        try {
            await authService.refreshSession(sessionId);
        } catch (err) {
            appendLog('auth_refresh_failed', { error: err?.message || String(err) });
        }
        session = authService.getSession(sessionId);
    }
    if (!session) {
        appendLog('auth_session_invalid', { sessionId: '[redacted]', mode: authContext.mode });
        return respondUnauthenticated(req, res, parsedUrl, authContext, options);
    }
    req.user = session.user;
    req.session = session;
    req.sessionId = sessionId;
    req.authMode = authContext.mode;
    try {
        if (authContext.mode === 'local' && session.user) {
            const refreshedJwt = mintSessionJwt(session.user, session._jwtPayload?.rev || 1, {
                usersVar: session.localAuth?.usersVar || authContext.policy?.usersVar || '',
                sid: session._jwtPayload?.sid || ''
            });
            const cookie = buildCookie(cookieName, refreshedJwt, req, '/', {
                maxAge: getLocalSessionCookieMaxAge(),
                sameSite: 'Lax'
            });
            appendSetCookie(res, cookie);
        } else {
            const cookie = buildCookie(cookieName, sessionId, req, '/', {
                maxAge: authService.getSessionCookieMaxAge(),
                sameSite: 'Lax'
            });
            appendSetCookie(res, cookie);
        }
    } catch (_) { }
    return finalizeAuthenticatedRequest(req, res, authContext, options, session);
}

export async function ensureAuthenticated(req, res, parsedUrl, options = {}) {
    const authContext = options.routePlan
        ? resolveAuthContextForRoutePlan(parsedUrl, options.routePlan)
        : resolveAuthContext(parsedUrl, options);
    return ensureAuthenticatedWithContext(req, res, parsedUrl, authContext, options);
}

export async function ensureHttpRouteAccess(req, res, parsedUrl, decision, options = {}) {
    if (decision?.access === 'public') return { ok: true };
    if (decision?.access === 'guest') {
        return ensureAuthenticatedWithContext(
            req,
            res,
            parsedUrl,
            resolveGuestRouteAuthContext(decision.routeKey, decision),
            options,
        );
    }
    if (decision?.access === 'authenticated') {
        return ensureAuthenticatedWithContext(
            req,
            res,
            parsedUrl,
            resolveAuthenticatedRouteAuthContext(decision.routeKey, {
                snapshot: snapshotFromOptions(options),
            }),
            options,
        );
    }

    const status = decision?.access === 'deny' ? (decision.status || 403) : 403;
    const code = decision?.access === 'deny' ? (decision.code || 'HTTP_ROUTE_ACCESS_DENIED') : 'HTTP_ROUTE_ACCESS_DENIED';
    sendJson(res, status, { ok: false, error: code });
    return { ok: false, error: code };
}

export {
    getLocalAuthPolicyFromSession,
    getLocalRouteKey,
    resolveAuthContext,
    resolveAuthContextForRouteKey,
    waitForAgentRedirectReady,
};
