import crypto from 'node:crypto';
import net from 'node:net';
import { domainToASCII } from 'node:url';

import {
    captureEdgeRoutingLease,
    captureEdgeRoutingObservationLease,
} from '../sandbox/edgeGeneration.js';
import { selectedRouterHostPort } from '../sandbox/routerPort.js';
import { deriveAgentPrincipalId } from '../utils/security/agentIdentity.js';
import {
    AgentPortSelectorError,
    parseAgentPortSelector,
} from './agentPortConvention/parseSelector.js';
import { normalizeHttpRouteAuthDefinition } from './httpRouteAuth.js';
import { HttpRouteAccessPolicy } from './policy/HttpRouteAccessPolicy.js';
import { HttpRouteAccessPath } from './policy/HttpRouteAccessPath.js';
import { normalizeManifestHttpRouteAccess } from './policy/HttpRouteProviders.js';
import { compileProxyLimits } from './proxy/limits.js';
import { createRoutePlan } from './proxy/RoutePlan.js';

const LOCAL_CONTROL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'router.localhost']);
const MANAGED_ROUTER_HOST = 'host.containers.internal';
const AGENT_ROOT_AUTH_SUPPORT_PATHS = new Set([
    '/auth/callback',
    '/auth/logged-out',
    '/auth/login',
    '/auth/logout',
    '/auth/account',
    '/auth/token',
]);

function deny(status, code, details = {}) {
    return { matched: false, ok: false, status, code, ...details };
}

function normalizedHostName(value) {
    const raw = String(value || '');
    if (!raw || raw !== raw.trim() || /[\u0000-\u0020\u007f,@/\\%]/.test(raw)) return null;
    if (raw.startsWith('[')) {
        const close = raw.indexOf(']');
        if (close < 0) return null;
        const literal = raw.slice(1, close);
        const suffix = raw.slice(close + 1);
        if (net.isIP(literal) !== 6 || (suffix && !/^:\d{1,5}$/.test(suffix))) return null;
        if (suffix && (Number(suffix.slice(1)) < 1 || Number(suffix.slice(1)) > 65535)) return null;
        return literal.toLowerCase();
    }
    const colonCount = (raw.match(/:/g) || []).length;
    if (colonCount > 1) return null;
    const [name, port = ''] = raw.split(':');
    if (!name || name.endsWith('.') || (port && (!/^\d{1,5}$/.test(port) || Number(port) > 65535 || Number(port) < 1))) return null;
    if (net.isIP(name)) return name.toLowerCase();
    const ascii = domainToASCII(name.toLowerCase());
    if (!ascii || ascii.length > 253 || ascii.split('.').some((label) => (
        !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ))) return null;
    return ascii;
}

export function normalizeExactHost(hostHeader) {
    if (Array.isArray(hostHeader) || typeof hostHeader !== 'string') return null;
    return normalizedHostName(hostHeader);
}

function exactRoute(routes, routeKey) {
    const key = String(routeKey || '');
    const route = routes?.[key];
    return route && !route.disabled && !route.draining ? { routeKey: key, route } : null;
}

function classifyHost({ host, listener, snapshot }) {
    if (listener === 'private') {
        return host === MANAGED_ROUTER_HOST || LOCAL_CONTROL_HOSTS.has(host)
            ? { kind: 'private', host }
            : null;
    }
    if (listener === 'managed') {
        return host === MANAGED_ROUTER_HOST ? { kind: 'managed-agent', host } : null;
    }
    if (LOCAL_CONTROL_HOSTS.has(host)) return { kind: 'control', host };
    if (host === MANAGED_ROUTER_HOST) return null;
    const record = snapshot.compiled?.hosts?.[host];
    if (!record) return null;
    const selectedRoute = snapshot.routing?.routes?.[String(record.routeKey || '')];
    if (snapshot.publicationState !== 'ready' || selectedRoute?.draining === true) {
        return { kind: 'inactive-public', host, record };
    }
    return { kind: 'agent-root', source: 'public-host', host, record };
}

function snapshotPolicy(snapshot) {
    const compiled = snapshot.compiled?.policy;
    if (!compiled || !Array.isArray(compiled.entries)
        || !compiled.routeDefaults || typeof compiled.routeDefaults !== 'object') return null;
    const repository = {
        listHttpRoutes: () => ({
            corrupt: false,
            entries: compiled.entries.map((entry) => ({ ...entry })),
        }),
    };
    return new HttpRouteAccessPolicy({
        repository,
        manifestRouteProvider: () => [],
        routeDefaultProvider: ({ routeKey }) => compiled.routeDefaults[routeKey] || null,
    });
}

function exactAgentRuntime(snapshot, routeKey, route) {
    const containerName = String(route?.container || '').trim();
    const record = snapshot.agents?.[containerName];
    if (!containerName || !record || record.type !== 'agent') return null;
    if (String(record.repoName || '') !== String(route.repo || '')
        || String(record.agentName || '') !== String(route.agent || '')) return null;
    const runtime = String(record.runtime || '').trim();
    const containerId = String(record.containerId || '').trim().toLowerCase();
    const effectiveInstanceId = String(record.instanceId || '').trim();
    const enableGeneration = String(record.enableGeneration || '').trim();
    if (!['docker', 'podman'].includes(runtime)
        || !/^[a-f0-9]{64}$/.test(containerId)
        || !effectiveInstanceId
        || !enableGeneration) return null;
    let targetAgentId;
    try {
        targetAgentId = deriveAgentPrincipalId(record.repoName, record.agentName);
    } catch (_) {
        return null;
    }
    const manifest = snapshot.manifests?.[routeKey] || {};
    const profile = manifest.profiles?.[String(record.profile || '')] || {};
    const networkMode = String(
        profile?.network?.mode
        || manifest?.network?.mode
        || 'bridge',
    ).trim().toLowerCase();
    return {
        runtime,
        containerId,
        containerName,
        targetAgentId,
        effectiveInstanceId,
        enableGeneration,
        networkMode,
        routeKey,
    };
}

function manifestRouteSpecs(manifest = {}) {
    const raw = manifest?.routerAccess?.httpRoutes;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
        return Object.entries(raw).map(([pathValue, value]) => (
            value && typeof value === 'object'
                ? { path: pathValue, ...value }
                : { path: pathValue, access: String(value || '') }
        ));
    }
    return [];
}

function conventionAuthDefinition({ snapshot, routeKey, route, selector, decision }) {
    const matching = manifestRouteSpecs(snapshot.manifests?.[routeKey])
        .map((spec) => ({
            spec,
            normalized: normalizeManifestHttpRouteAccess(spec, { routeKey }),
        }))
        .filter(({ normalized }) => (
            normalized.ok
            && HttpRouteAccessPath.matches(selector.policyPath, normalized.path)
        ));
    const declaration = matching.find(({ normalized }) => normalized.access === decision.access)?.spec || {};
    return normalizeHttpRouteAuthDefinition(routeKey, route, {
        port: selector.port,
        path: `/${selector.convention}/${selector.rawAgent}/${selector.canonicalPort}/`,
        access: decision.access,
        ...(Array.isArray(declaration.delegations)
            ? { delegations: declaration.delegations }
            : {}),
    });
}

function agentPortPlan({
    req,
    host,
    listener,
    parsedUrl,
    hostSelection,
    routes,
    snapshot,
    lease,
    transport = 'http',
}) {
    let selector;
    try {
        selector = parseAgentPortSelector(req?.url || `${parsedUrl.pathname}${parsedUrl.search}`);
    } catch (error) {
        if (error instanceof AgentPortSelectorError) {
            return deny(error.status, error.code, {
                matched: true,
                listener,
                lease,
                hostSelection,
            });
        }
        throw error;
    }
    if (!selector) return null;
    const selected = exactRoute(routes, selector.agent);
    if (!selected) {
        return deny(404, 'AGENT_OWNER_INACTIVE', {
            matched: true,
            listener,
            lease,
            hostSelection,
        });
    }
    const runtime = exactAgentRuntime(snapshot, selected.routeKey, selected.route);
    if (!runtime) {
        return deny(503, 'AGENT_RUNTIME_INACTIVE', {
            matched: true,
            listener,
            lease,
            hostSelection,
        });
    }
    const deniedPorts = runtime.networkMode === 'host' ? [8080, 8081] : [];
    try {
        selector = parseAgentPortSelector(req?.url || `${parsedUrl.pathname}${parsedUrl.search}`, { deniedPorts });
    } catch (error) {
        if (error instanceof AgentPortSelectorError) {
            return deny(error.status, error.code, {
                matched: true,
                listener,
                lease,
                hostSelection,
            });
        }
        throw error;
    }
    const accessPolicy = snapshotPolicy(snapshot);
    if (!accessPolicy) {
        return deny(503, 'POLICY_GENERATION_INVALID', {
            matched: true,
            listener,
            lease,
            hostSelection,
        });
    }
    const decision = accessPolicy.evaluate({
        pathname: selector.policyPath,
        method: req?.method || 'GET',
        routeKey: selected.routeKey,
    });
    if (decision?.access === 'deny') {
        return deny(decision.status || 403, decision.code || 'HTTP_ROUTE_ACCESS_DENIED', {
            matched: true,
            listener,
            lease,
            hostSelection,
            decision,
        });
    }
    const forwarding = canonicalForwardingMetadata({
        snapshot,
        host,
        listener,
        hostSelection,
    });
    let authDefinition;
    try {
        authDefinition = conventionAuthDefinition({
            snapshot,
            routeKey: selected.routeKey,
            route: selected.route,
            selector,
            decision,
        });
    } catch (_) {
        return deny(503, 'POLICY_GENERATION_INVALID', {
            matched: true,
            listener,
            lease,
            hostSelection,
        });
    }
    return createRoutePlan({
        matched: true,
        ok: true,
        kind: 'agent-port',
        listener,
        listenerClass: listener,
        host,
        hostSelection,
        pathname: selector.policyPath,
        canonicalPath: selector.policyPath,
        parsedUrl,
        routeKey: selected.routeKey,
        route: selected.route,
        forwarding,
        lease,
        snapshot,
        authDefinition,
        authority: forwarding.authority,
        surfaceKind: 'agent-port-convention',
        owner: {
            effectiveInstanceId: runtime.effectiveInstanceId,
            enableGeneration: runtime.enableGeneration,
        },
        port: selector.port,
        policyPath: selector.policyPath,
        convention: selector.convention,
        forwardedPrefix: `/${selector.convention}/${selector.rawAgent}/${selector.canonicalPort}`,
        unmatchedSuffix: selector.suffix,
        relay: {
            kind: 'container-control-socket',
            runtime: runtime.runtime,
            containerId: runtime.containerId,
            containerName: runtime.containerName,
            targetAgentId: runtime.targetAgentId,
            effectiveInstanceId: runtime.effectiveInstanceId,
            enableGeneration: runtime.enableGeneration,
            networkMode: runtime.networkMode === 'host' ? 'host' : '',
        },
        deniedPorts,
        allowedRouterCapabilities: [],
        access: decision,
        scheme: forwarding.protocol,
        origin: `${forwarding.protocol}://${forwarding.authority}`,
        limits: compileProxyLimits(),
        generationDigest: lease.id,
        auditId: crypto.randomUUID(),
        method: String(req?.method || 'GET').toUpperCase(),
        query: selector.query,
        transport,
        credentialPolicy: {
            allowApplicationAuthorization: true,
            allowApplicationCookies: true,
        },
        responsePolicy: {
            allowApplicationCookies: true,
            allowRedirects: true,
            allowCaching: true,
        },
        originPolicy: {
            allowedOrigins: [`${forwarding.protocol}://${forwarding.authority}`],
            allowMissingOrigin: true,
        },
        allowRequestStreaming: true,
    });
}

function canonicalForwardingMetadata({ snapshot, host, listener, hostSelection }) {
    const publicHostname = hostSelection?.source === 'public-host';
    let authority = host;
    if (!publicHostname) {
        let canonicalPort = 0;
        if (listener === 'private') canonicalPort = 8081;
        else if (listener === 'managed') canonicalPort = 8080;
        else canonicalPort = selectedRouterHostPort();
        if (Number.isSafeInteger(canonicalPort) && canonicalPort > 0 && canonicalPort <= 65535
            && canonicalPort !== 80) {
            authority = `${host === '::1' ? '[::1]' : host}:${canonicalPort}`;
        }
    }
    return Object.freeze({
        authority,
        protocol: publicHostname ? 'https' : 'http',
    });
}

function resolveAgentPath(pathname, routes, selectedRoot = null) {
    if (selectedRoot) {
        const route = exactRoute(routes, selectedRoot.routeKey);
        if (!route) return null;
        const segments = String(pathname || '').split('/').filter(Boolean);
        let explicitlySelectedRoot = false;
        if (segments.length) {
            try {
                explicitlySelectedRoot = decodeURIComponent(segments[0]) === route.routeKey;
            } catch (_) {
                return null;
            }
        }
        if (explicitlySelectedRoot) {
            const firstSlash = pathname.indexOf('/', 1);
            return {
                ...route,
                canonicalPath: pathname,
                upstreamPath: firstSlash < 0 ? '/' : pathname.slice(firstSlash) || '/',
            };
        }
        return {
            ...route,
            canonicalPath: `/${encodeURIComponent(route.routeKey)}${pathname === '/' ? '/' : pathname}`,
            upstreamPath: pathname,
        };
    }
    const segments = String(pathname || '').split('/').filter(Boolean);
    if (!segments.length) return null;
    let routeKey = '';
    try { routeKey = decodeURIComponent(segments[0]); } catch (_) { return null; }
    const selected = exactRoute(routes, routeKey);
    if (!selected) return null;
    const firstSlash = pathname.indexOf('/', 1);
    return {
        ...selected,
        canonicalPath: pathname,
        upstreamPath: firstSlash < 0 ? '/' : pathname.slice(firstSlash) || '/',
    };
}

function isRouteMount(pathname, root) {
    return pathname === root || pathname.startsWith(`${root}/`);
}

function selectedAgentMcpRoute(pathname, routeKeys) {
    const segments = String(pathname || '').split('/').filter(Boolean);
    if (segments.length < 2) return '';
    let routeKey = '';
    try { routeKey = decodeURIComponent(segments[0]); } catch (_) { return ''; }
    if (!new Set(routeKeys || []).has(routeKey)) return '';
    const prefix = `/${segments[0]}/mcp`;
    return isRouteMount(pathname, prefix) ? routeKey : '';
}

function selectedDependencyHttpRoute(pathname, routes, selectedRootRouteKey, routeSpecs) {
    const candidate = resolveAgentPath(pathname, routes, null);
    if (!candidate || candidate.routeKey === String(selectedRootRouteKey || '')) return '';
    const admitted = (routeSpecs || []).some((entry) => (
        entry
        && entry.routeKey === candidate.routeKey
        && typeof entry.path === 'string'
        && HttpRouteAccessPath.matches(candidate.canonicalPath, entry.path)
    ));
    return admitted ? candidate.routeKey : '';
}

function isSelectedRootUserAdminPath(pathname, selectedRootRouteKey) {
    const routeKey = String(selectedRootRouteKey || '');
    if (!routeKey) return false;
    const segments = String(pathname || '').split('/');
    if ((segments.length !== 5 && segments.length !== 6)
        || segments[0] !== '' || segments[1] !== 'api'
        || segments[2] !== 'agents') return false;
    let requestedRouteKey = '';
    let requestedUserId = '';
    try {
        requestedRouteKey = decodeURIComponent(segments[3]);
        if (segments.length === 6) requestedUserId = decodeURIComponent(segments[5]);
    } catch (_) {
        return false;
    }
    if (requestedRouteKey !== routeKey) return false;
    if (segments[4] === 'settings') return segments.length === 5;
    if (segments[4] !== 'users') return false;
    return segments.length === 5 || (
        Boolean(requestedUserId)
        && !requestedUserId.includes('/')
        && !requestedUserId.includes('\\')
    );
}

function surfaceForPath(
    pathname,
    selectedSurfaces,
    agentMcpRoutes = [],
    selectedRootRouteKey = '',
) {
    const available = new Set(selectedSurfaces || []);
    if (available.has('browser-auth') && (
        AGENT_ROOT_AUTH_SUPPORT_PATHS.has(pathname)
    )) return { name: 'browser-auth', routerOwned: true };
    if (available.has('user-admin') && (
        isSelectedRootUserAdminPath(pathname, selectedRootRouteKey)
    )) return { name: 'user-admin', routerOwned: true };
    if (available.has('agent-mcp')) {
        if (isRouteMount(pathname, '/mcp')) return { name: 'agent-mcp', routerOwned: false };
        const routeKey = selectedAgentMcpRoute(pathname, agentMcpRoutes);
        if (routeKey) return { name: 'agent-mcp', routerOwned: false, routeKey };
        if (pathname === '/MCPBrowserClient.js' || isRouteMount(pathname, '/web-libs')) {
            return { name: 'agent-mcp', routerOwned: true };
        }
    }
    if (available.has('workspace-assets') && isRouteMount(pathname, '/workspace-files')) {
        return { name: 'workspace-assets', routerOwned: true };
    }
    if (available.has('blob-transfer') && (pathname === '/upload' || isRouteMount(pathname, '/blobs'))) {
        return { name: 'blob-transfer', routerOwned: true };
    }
    if (available.has('marketplace-ui') && isRouteMount(pathname, '/api/marketplace')) {
        return { name: 'marketplace-ui', routerOwned: true };
    }
    if (available.has('webchat') && isRouteMount(pathname, '/webchat')) {
        return { name: 'webchat', routerOwned: true };
    }
    return null;
}

function isReservedRouterSurface(pathname) {
    return isRouteMount(pathname, '/health')
        || isRouteMount(pathname, '/metrics')
        || isRouteMount(pathname, '/agent-card')
        || isRouteMount(pathname, '/mcp')
        || pathname === '/MCPBrowserClient.js'
        || isRouteMount(pathname, '/auth')
        || isRouteMount(pathname, '/policy')
        || pathname === '/admin'
        || pathname.startsWith('/admin/')
        || pathname === '/__agent'
        || pathname.startsWith('/__agent/')
        || isRouteMount(pathname, '/api/edge')
        || isRouteMount(pathname, '/api/agents')
        || pathname === '/api/marketplace'
        || pathname.startsWith('/api/marketplace/')
        || pathname.startsWith('/api/router/')
        || isRouteMount(pathname, '/status')
        || isRouteMount(pathname, '/webchat')
        || isRouteMount(pathname, '/web-libs')
        || isRouteMount(pathname, '/workspace-files')
        || pathname === '/upload'
        || isRouteMount(pathname, '/blobs');
}

function routerSurfacePlan({ hostSelection, host, pathname, parsedUrl, lease, snapshot, surface }) {
    return {
        matched: true,
        ok: true,
        kind: 'router-surface',
        listener: 'public',
        surface,
        host,
        hostSelection,
        pathname,
        canonicalPath: pathname,
        parsedUrl,
        forwarding: canonicalForwardingMetadata({
            snapshot,
            host,
            listener: 'public',
            hostSelection,
        }),
        lease,
        snapshot,
    };
}

function agentRootPlan({ req, host, listener, pathname, parsedUrl, hostSelection, selectedRoot, routes, snapshot, lease }) {
    const agent = resolveAgentPath(pathname, routes, selectedRoot);
    if (!agent) return deny(404, 'ROUTE_NOT_FOUND', { lease, hostSelection });
    const hostPort = Number(agent.route?.hostPort || 0);
    if (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
        return deny(503, 'TARGET_INACTIVE', { lease, hostSelection });
    }
    const policy = snapshotPolicy(snapshot);
    if (!policy) return deny(503, 'POLICY_GENERATION_INVALID', { lease, hostSelection });
    const decision = policy.evaluate({
        pathname: agent.canonicalPath,
        method: req?.method || 'GET',
        routeKey: agent.routeKey,
    });
    return {
        matched: true,
        ok: true,
        kind: 'agent-root',
        listener,
        host,
        hostSelection,
        pathname,
        canonicalPath: agent.canonicalPath,
        parsedUrl,
        routeKey: agent.routeKey,
        route: agent.route,
        target: { hostname: '127.0.0.1', hostPort },
        upstreamPath: `${agent.upstreamPath}${parsedUrl.search || ''}`,
        decision,
        forwarding: canonicalForwardingMetadata({
            snapshot,
            host,
            listener,
            hostSelection,
        }),
        lease,
        snapshot,
    };
}

export function isPrivateInterfaceAllowed(req, listenerClass = 'public') {
    // The server object determines the listener/interface class. Source-address
    // provenance is not an authorization capability for bridge or host mode.
    return listenerClass === 'private' && req?.ploinkyListenerClass === 'private';
}

export function resolveEdgeRoutePlan({
    req,
    parsedUrl = null,
    listener = 'public',
    transport = 'http',
    authorityObservationGeneration = '',
} = {}) {
    let lease;
    try {
        lease = authorityObservationGeneration
            ? captureEdgeRoutingObservationLease({
                expectedGeneration: authorityObservationGeneration,
            })
            : captureEdgeRoutingLease();
    } catch (error) {
        return deny(503, error?.code || 'EDGE_GENERATION_INACTIVE');
    }
    const snapshot = lease.snapshot;
    const host = normalizeExactHost(req?.headers?.host);
    if (!host) return deny(400, 'MALFORMED_HOST', { lease });
    if (listener === 'private' && !isPrivateInterfaceAllowed(req, listener)) {
        return deny(403, 'PRIVATE_INTERFACE_DENIED', { lease });
    }
    let url = parsedUrl;
    try {
        url ||= new URL(req?.url || '/', `http://${host === '::1' ? '[::1]' : host}`);
    } catch (_) {
        return deny(400, 'MALFORMED_URL', { lease });
    }
    const pathname = url.pathname || '/';
    const routes = snapshot.routing?.routes || {};
    const hostSelection = classifyHost({ host, listener, snapshot });
    if (!hostSelection) return deny(421, 'UNKNOWN_HOST', { lease });
    if (hostSelection.kind === 'inactive-public') {
        return deny(503, 'HOST_SELECTOR_INACTIVE', { lease, hostSelection });
    }

    const conventionPlan = agentPortPlan({
        req,
        host,
        listener,
        parsedUrl: url,
        hostSelection,
        routes,
        snapshot,
        lease,
        transport,
    });
    if (conventionPlan) return conventionPlan;

    if (listener === 'private') {
        if (pathname === '/api/edge/workspace-logs') {
            if (req.method !== 'POST' || url.search) {
                return deny(400, 'WORKSPACE_LOGS_REQUEST_INVALID', { lease, hostSelection });
            }
            return {
                matched: true,
                ok: true,
                kind: 'private-operation',
                operation: 'workspace-logs',
                listener,
                host,
                hostSelection,
                pathname,
                parsedUrl: url,
                lease,
                snapshot,
            };
        }
        if (pathname === '/api/edge/workspace-metrics') {
            if (url.search !== '?follow=1') {
                return deny(400, 'WORKSPACE_METRICS_QUERY_INVALID', { lease, hostSelection });
            }
            return {
                matched: true,
                ok: true,
                kind: 'private-operation',
                operation: 'workspace-metrics',
                listener,
                host,
                hostSelection,
                pathname,
                parsedUrl: url,
                lease,
                snapshot,
            };
        }
        if (pathname === '/api/edge/turn-credentials') {
            return {
                matched: true,
                ok: true,
                kind: 'private-operation',
                operation: 'turn-credentials',
                listener,
                host,
                hostSelection,
                pathname,
                parsedUrl: url,
                lease,
                snapshot,
            };
        }
        return deny(404, 'PRIVATE_ROUTE_SURFACE_DENIED', { lease, hostSelection });
    }

    if (hostSelection.kind === 'agent-root') {
        const surface = surfaceForPath(
            pathname,
            snapshot.compiled.surfaces?.[host] || [],
            snapshot.compiled.agentMcpRoutes?.[host] || [],
            hostSelection.record?.routeKey,
        );
        if (surface?.routerOwned) {
            return routerSurfacePlan({
                hostSelection,
                host,
                pathname,
                parsedUrl: url,
                lease,
                snapshot,
                surface: surface.name,
            });
        }
        if (surface?.name === 'agent-mcp' && surface.routeKey) {
            return agentRootPlan({
                req,
                host,
                listener,
                pathname,
                parsedUrl: url,
                hostSelection,
                selectedRoot: null,
                routes,
                snapshot,
                lease,
            });
        }
        const dependencyHttpRoute = selectedDependencyHttpRoute(
            pathname,
            routes,
            hostSelection.record?.routeKey,
            snapshot.compiled.dependencyHttpRoutes?.[host] || [],
        );
        if (dependencyHttpRoute) {
            return agentRootPlan({
                req,
                host,
                listener,
                pathname,
                parsedUrl: url,
                hostSelection,
                selectedRoot: null,
                routes,
                snapshot,
                lease,
            });
        }
        if (isReservedRouterSurface(pathname) && !surface) {
            return deny(404, 'ROUTE_SURFACE_DENIED', { lease, hostSelection });
        }
        return agentRootPlan({
            req,
            host,
            listener,
            pathname,
            parsedUrl: url,
            hostSelection,
            selectedRoot: hostSelection.record,
            routes,
            snapshot,
            lease,
        });
    }

    if (hostSelection.kind === 'managed-agent' && isReservedRouterSurface(pathname)) {
        return deny(404, 'ROUTE_SURFACE_DENIED', { lease, hostSelection });
    }
    const agentPlan = agentRootPlan({
        req,
        host,
        listener,
        pathname,
        parsedUrl: url,
        hostSelection,
        selectedRoot: null,
        routes,
        snapshot,
        lease,
    });
    if (agentPlan.ok || hostSelection.kind !== 'control') return agentPlan;
    return deny(404, 'ROUTE_NOT_FOUND', { lease, hostSelection });
}

export function commitRoutePlan(plan) {
    return Boolean(plan?.ok && plan?.lease?.commit?.());
}

export function commitRouteGeneration(plan) {
    return Boolean(plan?.lease?.commit?.());
}

export function httpAccessForEdgeRoutePlan(plan) {
    if (!plan?.ok) return null;
    return plan.kind === 'agent-port' ? (plan.access || null) : (plan.decision || null);
}

export default {
    commitRouteGeneration,
    commitRoutePlan,
    httpAccessForEdgeRoutePlan,
    isPrivateInterfaceAllowed,
    normalizeExactHost,
    resolveEdgeRoutePlan,
};
