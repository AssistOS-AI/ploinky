import fs from 'fs';
import path from 'path';

import { PLOINKY_WORKSPACE_ROOT, ROUTING_FILE } from '../../utils/config.js';
import { resolveEnabledAgentRecord } from '../../utils/agents.js';
import { findAgent } from '../../utils/utils.js';
import { resolveAgentAuthPolicy } from '../../utils/manifestAuth.js';
import { GUEST_SESSION_TTL_SECONDS, getSessionCookieMaxAge as getLocalSessionCookieMaxAge, mintGuestSessionJwt } from '../auth/localService.js';
import { waitForAgentReady } from '../utils/agentReadiness.js';
import { BROWSER_CSRF_COOKIE_NAME, mintBrowserCsrfToken } from '../browserMutationSecurity.js';
import { HttpRouteAccessPath } from '../policy/HttpRouteAccessPath.js';
import { HttpRouteAccessPolicy } from '../policy/HttpRouteAccessPolicy.js';
import { collectManifestHttpRouteAccess } from '../policy/HttpRouteProviders.js';
import { evaluateRequiredCapability } from './requiredCapability.js';
import {
    appendLog,
    appendSetCookie,
    authService,
    buildCookie,
    getCookieNameForMode,
    GUEST_AUTH_COOKIE_NAME,
    LOCAL_AUTH_COOKIE_NAME,
    normalizeRelativePath,
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
            const pathAuthMode = resolveAuthContextForRouteKey(pathAgent, options).mode;
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

function bindWebchatSurfaceServiceRoute(parsedUrl, authContext, options = {}) {
    const parts = String(parsedUrl.pathname || '/').split('/').filter(Boolean);
    const explicitRouteKey = String(parsedUrl.searchParams.get('agent') || '').trim();
    if (parts[0] !== 'webchat'
        || !explicitRouteKey
        || !authContext?.routeKey
        || authContext.routeKey === explicitRouteKey) {
        return authContext;
    }
    const authRouteKey = resolveSurfaceAuthRouteKey(
        'webchat',
        explicitRouteKey,
        readRouting(options),
        options,
    );
    return authRouteKey === authContext.routeKey
        ? { ...authContext, serviceRouteKey: explicitRouteKey }
        : authContext;
}

function resolveAuthContext(parsedUrl, options = {}) {
    const routeKey = resolveAuthRouteKey(parsedUrl, options);
    if (!routeKey) {
        return { routeKey: null, mode: 'none', policy: { mode: 'none' }, record: null };
    }
    const context = resolveAuthContextForRouteKey(routeKey, options);
    return bindWebchatSurfaceServiceRoute(parsedUrl, context, options);
}

function resolveAuthContextForRouteKey(routeKey, options = {}) {
    const normalizedRouteKey = String(routeKey || '').trim();
    if (!normalizedRouteKey) {
        return { routeKey: null, mode: 'none', policy: { mode: 'none' }, record: null };
    }
    const resolved = resolveEnabledAgentRecordForAuth(normalizedRouteKey, options);
    const record = resolved?.record || null;
    const manifest = readEnabledAgentManifest(normalizedRouteKey, readRouting(options).routes, options);
    const policy = resolveAgentAuthPolicy(manifest, record?.auth);
    const mode = String(policy.mode || 'none').trim().toLowerCase() || 'none';
    return { routeKey: normalizedRouteKey, mode, policy, record };
}

function isUserAuthenticatedAuthMode(mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    return Boolean(normalized && normalized !== 'none' && normalized !== 'guest');
}

export function localSessionAllowedForRoutePlan(session) {
    return session?._jwtPayload?.chn === 'cli' && session?.user?.id === 'local:admin';
}

function hasOwnedAuthenticatedDeclaration(routeKey, routing, options) {
    const decision = options.httpRouteDecision;
    const pathname = options.parsedUrl?.pathname;
    if (decision?.access !== 'authenticated' || decision.routeKey !== routeKey || !pathname) return false;
    const manifest = readEnabledAgentManifest(routeKey, routing.routes || {}, options);
    return collectManifestHttpRouteAccess(
        { [routeKey]: routing.routes?.[routeKey] },
        { manifests: { [routeKey]: manifest } },
    ).some((entry) => entry.access === 'authenticated' && HttpRouteAccessPath.matches(pathname, entry.path));
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
            // An explicitly authenticated service owns its access requirements,
            // while the static agent supplies the verified user identity. Default
            // inherited routes still require both owners' capabilities.
            return {
                ...staticContext,
                serviceRouteKey: normalizedRouteKey,
                ...(hasOwnedAuthenticatedDeclaration(normalizedRouteKey, routing, options)
                    ? { capabilityOwnerRouteKey: normalizedRouteKey }
                    : {}),
            };
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
    return ['agent-root', 'dedicated-service'].includes(String(routePlan?.hostSelection?.kind || ''))
        || (routePlan?.kind === 'router-surface' && routePlan?.surface === 'webtty');
}

function requestedMutationRouteKey(parsedUrl) {
    return (parsedUrl.pathname || '/') === '/auth/token'
        ? String(parsedUrl.searchParams.get('mutationRoute') || '').trim()
        : '';
}

function hostBoundMutationRouteKey(parsedUrl, routePlan, snapshot) {
    const requested = requestedMutationRouteKey(parsedUrl);
    if (!requested) return '';
    const host = String(routePlan?.hostSelection?.host || routePlan?.host || '').trim();
    const allowed = snapshot?.compiled?.agentMcpRoutes?.[host];
    return Array.isArray(allowed) && allowed.includes(requested) ? requested : null;
}

function snapshotHttpRoutePolicy(snapshot) {
    const compiled = snapshot?.compiled?.policy;
    if (!compiled || !Array.isArray(compiled.entries)
        || !compiled.routeDefaults || typeof compiled.routeDefaults !== 'object') return null;
    return new HttpRouteAccessPolicy({
        repository: {
            listHttpRoutes: () => ({
                corrupt: false,
                entries: compiled.entries.map((entry) => ({ ...entry })),
            }),
        },
        manifestRouteProvider: () => [],
        routeDefaultProvider: ({ routeKey }) => compiled.routeDefaults[routeKey] || null,
    });
}

function deniedGuestMutationContext() {
    return {
        error: 'browser_mutation_guest_route_denied',
        errorDetail: 'The requested browser mutation guest path is not an admitted guest route.',
    };
}

function resolveGuestBrowserProofAuthContext(parsedUrl, {
    routePlan = null,
    snapshot = null,
    targetRouteKey = '',
} = {}) {
    const requestedPath = String(parsedUrl.searchParams.get('mutationPath') || '').trim();
    if (!requestedPath) return null;

    const normalized = HttpRouteAccessPath.normalize(requestedPath, { allowWildcard: false });
    const routeKey = String(targetRouteKey || '').trim();
    if (!normalized.ok || HttpRouteAccessPath.routeKeyForPath(normalized.path) !== routeKey) {
        return deniedGuestMutationContext();
    }

    const manifestEntry = snapshot?.compiled?.policy?.entries?.find((entry) => (
        entry?.source === 'manifest'
        && entry.routeKey === routeKey
        && typeof entry.path === 'string'
        && HttpRouteAccessPath.matches(normalized.path, entry.path)
    ));
    if (!manifestEntry) return deniedGuestMutationContext();

    if (isHostBoundRoutePlan(routePlan)) {
        const host = String(routePlan?.hostSelection?.host || routePlan?.host || '').trim();
        const selectedRouteKey = routePlanSelectedRouteKey(routePlan);
        if (routeKey !== selectedRouteKey) {
            const admittedDependency = snapshot?.compiled?.dependencyHttpRoutes?.[host]?.some((entry) => (
                entry?.routeKey === routeKey
                && typeof entry.path === 'string'
                && HttpRouteAccessPath.matches(normalized.path, entry.path)
            ));
            if (!admittedDependency) return deniedGuestMutationContext();
        }
    }

    const policy = snapshotHttpRoutePolicy(snapshot);
    const decision = policy?.evaluate({
        pathname: normalized.path,
        method: 'GET',
        routeKey,
    });
    if (decision?.access !== 'guest' || decision.routeKey !== routeKey) {
        return deniedGuestMutationContext();
    }

    return {
        ...resolveGuestRouteAuthContext(routeKey, decision, parsedUrl),
        ...(isHostBoundRoutePlan(routePlan)
            ? {
                boundHostRouteKey: routePlanSelectedRouteKey(routePlan),
                boundGeneration: String(routePlan?.lease?.id || snapshot?.generation || ''),
                serviceRouteKey: routeKey,
            }
            : {}),
    };
}

function resolveControlBrowserProofAuthContext(parsedUrl, options = {}) {
    if ((parsedUrl.pathname || '/') !== '/auth/token') return null;
    const targetRouteKey = String(
        parsedUrl.searchParams.get('mutationRoute')
        || parsedUrl.searchParams.get('agent')
        || '',
    ).trim();
    if (!targetRouteKey) return null;

    const targetContext = resolveAuthContextForRouteKey(targetRouteKey, options);
    if (!targetContext.record) return null;
    const guestContext = resolveGuestBrowserProofAuthContext(parsedUrl, {
        snapshot: snapshotFromOptions(options),
        targetRouteKey,
    });
    if (guestContext) return guestContext;
    if (targetContext.mode !== 'none') return targetContext;

    const inheritedContext = resolveAuthenticatedRouteAuthContext(targetRouteKey, options);
    return inheritedContext.error ? null : inheritedContext;
}

export function resolveAuthContextForRoutePlan(parsedUrl, routePlan, { browserAuth = false } = {}) {
    const snapshot = snapshotFromOptions({ routePlan });
    const selectedRouteKey = routePlanSelectedRouteKey(routePlan);
    if (routePlan?.kind === 'router-surface' && routePlan?.surface === 'webtty' && selectedRouteKey) {
        return {
            ...resolveAuthenticatedRouteAuthContext(selectedRouteKey, { snapshot }),
            boundHostRouteKey: selectedRouteKey,
            boundGeneration: String(routePlan?.lease?.id || snapshot?.generation || ''),
            serviceRouteKey: 'webtty',
        };
    }
    if (browserAuth && isHostBoundRoutePlan(routePlan) && selectedRouteKey) {
        const mutationRouteKey = hostBoundMutationRouteKey(parsedUrl, routePlan, snapshot);
        if (mutationRouteKey === null) {
            return {
                routeKey: selectedRouteKey,
                mode: 'authenticated-unconfigured',
                policy: { mode: 'authenticated-unconfigured' },
                record: null,
                error: 'browser_mutation_route_denied',
                errorDetail: 'The requested browser mutation route is outside the selected host service closure.',
            };
        }
        if (mutationRouteKey) {
            const guestContext = resolveGuestBrowserProofAuthContext(parsedUrl, {
                routePlan,
                snapshot,
                targetRouteKey: mutationRouteKey,
            });
            if (guestContext) return guestContext;
        }
        return bindWebchatSurfaceServiceRoute(parsedUrl, {
            ...resolveAuthenticatedRouteAuthContext(selectedRouteKey, { snapshot }),
            boundHostRouteKey: selectedRouteKey,
            boundGeneration: String(routePlan?.lease?.id || snapshot?.generation || ''),
            ...(mutationRouteKey ? { serviceRouteKey: mutationRouteKey } : {}),
        }, { snapshot });
    }
    if (browserAuth) {
        const proofContext = resolveControlBrowserProofAuthContext(parsedUrl, { snapshot });
        if (proofContext) return proofContext;
    }

    const decision = routePlan?.decision;
    if (decision?.access === 'guest') {
        return bindWebchatSurfaceServiceRoute(
            parsedUrl,
            resolveGuestRouteAuthContext(decision.routeKey, decision, parsedUrl),
            { snapshot },
        );
    }
    if (decision?.access === 'authenticated') {
        return bindWebchatSurfaceServiceRoute(
            parsedUrl,
            resolveAuthenticatedRouteAuthContext(decision.routeKey, {
                snapshot, parsedUrl, httpRouteDecision: decision,
            }),
            { snapshot },
        );
    }
    if (selectedRouteKey && routePlan?.kind === 'agent-root') {
        const routeDefault = snapshot?.compiled?.policy?.routeDefaults?.[selectedRouteKey];
        if (routeDefault?.access === 'authenticated') {
            return bindWebchatSurfaceServiceRoute(
                parsedUrl,
                resolveAuthenticatedRouteAuthContext(selectedRouteKey, { snapshot }),
                { snapshot },
            );
        }
        if (routeDefault?.access === 'guest') {
            return bindWebchatSurfaceServiceRoute(
                parsedUrl,
                resolveGuestRouteAuthContext(selectedRouteKey, routeDefault, parsedUrl),
                { snapshot },
            );
        }
    }
    return resolveAuthContext(parsedUrl, { snapshot });
}

function resolveGuestRouteAuthContext(routeKey, options = {}, parsedUrl = null) {
    const normalizedRouteKey = String(routeKey || '').trim();
    const guestScopeBase = String(options.guestScope || `http-route:${normalizedRouteKey}`).trim();
    const guestScopeParam = String(options.guestScopeParam || '').trim();
    let guestScope = guestScopeBase;
    if (guestScopeParam) {
        const values = parsedUrl?.searchParams?.getAll?.(guestScopeParam) || [];
        const value = values.length === 1 ? String(values[0] || '').trim() : '';
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
            return {
                routeKey: normalizedRouteKey,
                mode: 'guest',
                policy: {
                    mode: 'guest',
                    routeKey: normalizedRouteKey,
                    guestScope: '',
                    guestScopeError: 'guest_scope_parameter_invalid',
                    guestScopeErrorDetail: `The guest route requires one valid '${guestScopeParam}' query parameter.`,
                },
                record: null,
            };
        }
        guestScope = `${guestScopeBase}:${value}`;
    }
    return {
        routeKey: normalizedRouteKey,
        mode: 'guest',
        policy: {
            mode: 'guest',
            routeKey: normalizedRouteKey,
            guestScope,
        },
        record: null,
    };
}

function isAgentMcpRequestForRoute(parsedUrl, routeKey) {
    const pathname = String(parsedUrl?.pathname || '').replace(/\/+$/g, '') || '/';
    if (pathname === '/mcp') return true;
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || parts[1] !== 'mcp') return false;
    try {
        return decodeURIComponent(parts[0]) === String(routeKey || '').trim();
    } catch (_) {
        return false;
    }
}

function effectiveGuestScopeSpecsForRoute(routeKey, options = {}) {
    const normalizedRouteKey = String(routeKey || '').trim();
    const compiled = snapshotFromOptions(options)?.compiled?.policy;
    if (!normalizedRouteKey || !compiled) return [];
    const specs = new Map();
    for (const namespace of compiled.namespaces || []) {
        if (namespace?.routeKey !== normalizedRouteKey) continue;
        for (const partition of namespace.partitions || []) {
            const winner = partition?.winner;
            if (winner?.access !== 'guest' || winner.routeKey !== normalizedRouteKey) continue;
            const guestScope = String(winner.guestScope || `http-route:${normalizedRouteKey}`).trim();
            const guestScopeParam = String(winner.guestScopeParam || '').trim();
            specs.set(`${guestScope}\0${guestScopeParam}`, { guestScope, guestScopeParam });
        }
    }
    return [...specs.values()];
}

function matchesEffectiveGuestScope(guestScope, specs) {
    return specs.some((spec) => {
        if (!spec.guestScopeParam) return guestScope === spec.guestScope;
        const prefix = `${spec.guestScope}:`;
        return guestScope.startsWith(prefix)
            && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(guestScope.slice(prefix.length));
    });
}

async function resolveRouteBoundGuestMcpSession(guestCookie, parsedUrl, authContext, options = {}) {
    if (!guestCookie
        || !isAgentMcpRequestForRoute(parsedUrl, authContext?.routeKey)) return null;
    const session = await sessionTokenService.getGuestSession(guestCookie, {
        routeKey: authContext.routeKey,
        allowAnyGuestScope: true,
    });
    const guestScope = String(session?._jwtPayload?.gscope || '').trim();
    if (!guestScope
        || !matchesEffectiveGuestScope(
            guestScope,
            effectiveGuestScopeSpecsForRoute(authContext.routeKey, options),
        )) return null;
    return session;
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
        detail: 'Agent-to-agent calls use an Agent Assertion JWT carried as `Authorization: Bearer`, verified by the router (DS015).'
    };
}

function capabilityDenialRedirectTarget(req, parsedUrl, manifest) {
    const target = normalizeRelativePath(manifest?.routerAccess?.capabilityDeniedRedirect, '');
    if (!target || String(req?.method || '').toUpperCase() !== 'GET') return '';
    const headers = req.headers || {};
    if (headers.upgrade || headers['x-requested-with'] || headers['mcp-session-id']
        || headers['mcp-protocol-version'] || headers['last-event-id']) return '';
    if (headers['sec-fetch-mode'] && headers['sec-fetch-mode'] !== 'navigate') return '';
    if (headers['sec-fetch-dest'] && headers['sec-fetch-dest'] !== 'document') return '';
    const pathname = parsedUrl?.pathname || '/';
    if (wantsJsonResponse(req, pathname)) return '';
    const accept = String(headers.accept || '').toLowerCase();
    if (/(?:application\/[\w.+-]*json|text\/event-stream)/.test(accept)) return '';
    const acceptsHtml = accept.split(',').some((entry) => {
        const [type, ...parameters] = entry.trim().split(';');
        if (!['text/html', 'application/xhtml+xml'].includes(type.trim())) return false;
        const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
        return quality === undefined || Number(quality.trim().slice(2)) > 0;
    });
    if (!acceptsHtml) return '';
    let decodedPath;
    let redirectPath;
    try {
        decodedPath = decodeURIComponent(pathname);
        redirectPath = decodeURIComponent(new URL(target, 'http://localhost').pathname).replace(/\/+$/, '');
    } catch (_) {
        return '';
    }
    if (/(?:^|\/)(?:api|apis|mcp)(?:\/|$)/i.test(decodedPath)) return '';
    if (!redirectPath || decodedPath === redirectPath || decodedPath.startsWith(`${redirectPath}/`)) return '';
    return target;
}

function finalizeAuthenticatedRequest(req, res, parsedUrl, authContext, options, session) {
    const routes = readRouting(options).routes || {};
    const capabilityRouteKeys = [...new Set([
        String(authContext?.capabilityOwnerRouteKey || authContext?.routeKey || '').trim(),
        String(authContext?.serviceRouteKey || '').trim(),
    ].filter(Boolean))];
    const privilegedLocalCli = req.authMode === 'local'
        && req.authChannel === 'cli'
        && req.user?.id === 'local:admin';
    let capabilityDecision = { ok: true };
    let deniedManifest = null;
    for (const routeKey of privilegedLocalCli ? [] : capabilityRouteKeys) {
        const manifest = readEnabledAgentManifest(routeKey, routes, options);
        capabilityDecision = evaluateRequiredCapability(manifest, req.user, { authMode: req.authMode });
        if (!capabilityDecision.ok) {
            deniedManifest = manifest;
            break;
        }
    }
    if (!capabilityDecision.ok) {
        const redirect = capabilityDecision.error === 'required_capability_missing'
            ? capabilityDenialRedirectTarget(req, parsedUrl, deniedManifest)
            : '';
        if (redirect) {
            res.writeHead(302, { Location: redirect, 'Cache-Control': 'no-store' });
            res.end('Additional access is required');
            return { ok: false, error: capabilityDecision.error, redirect };
        }
        sendJson(res, 403, {
            ok: false,
            error: capabilityDecision.error,
            ...(capabilityDecision.requiredCapability
                ? { requiredCapability: capabilityDecision.requiredCapability }
                : {}),
        });
        return { ok: false, error: capabilityDecision.error };
    }
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
    if (authContext.error) {
        sendJson(res, authContext.errorStatus || 503, {
            ok: false,
            error: authContext.error,
            ...(authContext.errorDetail ? { detail: authContext.errorDetail } : {}),
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
            return finalizeAuthenticatedRequest(req, res, parsedUrl, authContext, options, localCliSession);
        }
    }
    if (authContext.mode === 'none') return { ok: true };
    if (authContext.mode === 'sso' && !authService.isConfigured()) {
        sendJson(res, 503, { ok: false, error: 'sso_not_configured' });
        return { ok: false, error: 'sso_not_configured' };
    }

    if (authContext.mode === 'guest') {
        const ssoCookie = cookies.get(SSO_AUTH_COOKIE_NAME);
        if (ssoCookie && authService.isConfigured()) {
            const ssoSession = await authService.validateSession(ssoCookie);
            if (ssoSession && (!ssoSession.expiresAt || Date.now() <= ssoSession.expiresAt)) {
                req.user = ssoSession.user;
                req.session = ssoSession;
                req.sessionId = ssoCookie;
                req.authMode = 'sso';
                return finalizeAuthenticatedRequest(req, res, parsedUrl, authContext, options, ssoSession);
            }
        }
        if (authContext.policy?.guestScopeError) {
            sendJson(res, 403, {
                ok: false,
                error: authContext.policy.guestScopeError,
                ...(authContext.policy.guestScopeErrorDetail
                    ? { detail: authContext.policy.guestScopeErrorDetail }
                    : {}),
            });
            return { ok: false, error: authContext.policy.guestScopeError };
        }
        const guestCookie = cookies.get(GUEST_AUTH_COOKIE_NAME);
        if (guestCookie) {
            const guestSession = await resolveRouteBoundGuestMcpSession(
                guestCookie,
                parsedUrl,
                authContext,
                options,
            ) || await sessionTokenService.getGuestSession(guestCookie, { policy: authContext.policy });
            if (guestSession) {
                req.user = guestSession.user;
                req.session = guestSession;
                req.sessionId = guestCookie;
                req.authMode = 'guest';
                return finalizeAuthenticatedRequest(req, res, parsedUrl, authContext, options, guestSession);
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
        return finalizeAuthenticatedRequest(req, res, parsedUrl, authContext, options, guestSession);
    }

    const cookieName = getCookieNameForMode(authContext.mode);
    const sessionId = cookies.get(cookieName);
    if (!sessionId) {
        appendLog('auth_missing_cookie', { path: parsedUrl.pathname });
        return respondUnauthenticated(req, res, parsedUrl, authContext, options);
    }
    let session = await authService.validateSession(sessionId);
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
        const cookie = buildCookie(cookieName, sessionId, req, '/', {
            maxAge: authService.getSessionCookieMaxAge(),
            sameSite: 'Lax'
        });
        appendSetCookie(res, cookie);
    } catch (_) { }
    return finalizeAuthenticatedRequest(req, res, parsedUrl, authContext, options, session);
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
            resolveGuestRouteAuthContext(decision.routeKey, decision, parsedUrl),
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
                parsedUrl,
                httpRouteDecision: decision,
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
    resolveAuthContext,
    resolveAuthContextForRouteKey,
    waitForAgentRedirectReady,
};
