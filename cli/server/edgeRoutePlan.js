import net from 'node:net';
import { domainToASCII } from 'node:url';

import { captureEdgeRoutingLease } from '../services/edgeGeneration.js';
import { selectedRouterHostPort } from '../services/routerPort.js';
import {
    buildServiceAgentPath,
    collectHttpServiceRoutes,
    resolveHttpServiceTarget,
} from './httpServiceRoutes.js';
import { hasInternalAgentSegment } from './internalAgentPath.js';
import { HttpRouteAccessPolicy } from './policy/HttpRouteAccessPolicy.js';

const LOCAL_CONTROL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'router.localhost']);
const MANAGED_ROUTER_HOST = 'host.containers.internal';
const DEDICATED_SERVICE_AUTH_SUPPORT_PATHS = new Set([
    '/auth/callback',
    '/auth/logged-out',
    '/auth/login',
    '/auth/logout',
]);
const AGENT_ROOT_AUTH_SUPPORT_PATHS = new Set([
    ...DEDICATED_SERVICE_AUTH_SUPPORT_PATHS,
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

function serviceKey(routeKey, slug) {
    return `${routeKey}\u0000${slug}`;
}

function serviceInventoryKey({ routeKey, slug, externalPrefix }) {
    return slug
        ? serviceKey(routeKey, slug)
        : `${routeKey}\u0000prefix:${externalPrefix}`;
}

function exactRoute(routes, routeKey) {
    const key = String(routeKey || '');
    const route = routes?.[key];
    return route && !route.disabled ? { routeKey: key, route } : null;
}

function runtimeServices(snapshot) {
    const definitions = collectHttpServiceRoutes(snapshot.routing, { manifests: snapshot.manifests || {} });
    const compiled = snapshot.compiled?.services || [];
    if (definitions.length !== compiled.length) throw new Error('compiled HTTP service inventory mismatch');
    const compiledByKey = new Map(compiled.map((entry) => [serviceInventoryKey(entry), entry]));
    if (compiledByKey.size !== compiled.length) throw new Error('compiled HTTP service inventory is ambiguous');
    for (const definition of definitions) {
        const expected = compiledByKey.get(serviceInventoryKey(definition));
        if (!expected
            || expected.externalPrefix !== definition.externalPrefix
            || expected.internalPrefix !== definition.internalPrefix
            || expected.access !== definition.access
            || expected.port !== definition.port
            || expected.guestScope !== definition.guestScope
            || expected.issueInvocation !== definition.issueInvocation
            || expected.includeAuthInfo !== definition.includeAuthInfo) {
            throw new Error('compiled HTTP service semantics mismatch');
        }
    }
    return definitions;
}

function internalServiceKeys(snapshot) {
    return new Set((snapshot.compiled?.security?.internalServiceConsumers || []).map((entry) => (
        serviceKey(entry.routeKey, entry.slug)
    )));
}

function findService(services, routeKey, slug) {
    const matches = services.filter((definition) => definition.routeKey === routeKey && definition.slug === slug);
    return matches.length === 1 ? matches[0] : null;
}

function serviceForPath(services, pathname) {
    const normalizedPathname = String(pathname || '');
    const matches = services.filter((definition) => (
        normalizedPathname === definition.externalPrefix.replace(/\/$/, '')
        || normalizedPathname.startsWith(definition.externalPrefix)
    ));
    return matches.length === 1 ? matches[0] : null;
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
    const alias = snapshot.compiled?.localAliases?.[host];
    if (alias) return { kind: 'dedicated-service', source: 'local-alias', host, record: alias };
    const record = snapshot.compiled?.hosts?.[host];
    if (!record) return null;
    if (snapshot.publicationState !== 'cloudflare-ready') {
        return { kind: 'inactive-public', host, record };
    }
    return record.kind === 'dedicated-service'
        ? { kind: 'dedicated-service', source: 'public-host', host, record }
        : { kind: 'agent-root', source: 'public-host', host, record };
}

function snapshotPolicy(snapshot) {
    const compiled = snapshot.compiled?.policy;
    if (!compiled || compiled.schemaVersion !== 1 || !Array.isArray(compiled.entries)
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
        httpServiceProvider: () => [],
        routeDefaultProvider: ({ routeKey }) => compiled.routeDefaults[routeKey] || null,
    });
}

function canonicalizeDedicatedServicePath(definition, pathname) {
    const suffix = pathname === '/' ? '' : String(pathname || '').replace(/^\/+/, '');
    return `${definition.externalPrefix}${suffix}`;
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

function surfaceForPath(pathname, selectedSurfaces) {
    const available = new Set(selectedSurfaces || []);
    if (available.has('browser-auth') && (
        AGENT_ROOT_AUTH_SUPPORT_PATHS.has(pathname)
    )) return { name: 'browser-auth', routerOwned: true };
    if (available.has('agent-mcp')) {
        if (isRouteMount(pathname, '/mcp')) return { name: 'agent-mcp', routerOwned: false };
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
    if (available.has('topology-projection') && pathname === '/api/edge/topology') {
        return { name: 'topology-projection', routerOwned: true };
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
        || isRouteMount(pathname, '/dashboard')
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

function servicePlan({
    req,
    host,
    listener,
    pathname,
    parsedUrl,
    hostSelection,
    definition,
    dedicated,
    services,
    snapshot,
    lease,
}) {
    const canonicalPath = dedicated ? canonicalizeDedicatedServicePath(definition, pathname) : pathname;
    const policy = snapshotPolicy(snapshot);
    if (!policy) return deny(503, 'POLICY_GENERATION_INVALID', { lease, hostSelection });
    const decision = policy.evaluate({
        pathname: canonicalPath,
        method: req?.method || 'GET',
        routeKey: definition.routeKey,
    });
    // A policy denial is terminal route-plan state. In particular, the public
    // read-only method guard must reject control-plane POSTs before a target is
    // selected or any HTTP/SSE/WebSocket dial can be attempted.
    if (decision?.access === 'deny') {
        return deny(decision.status || 403, decision.code || 'HTTP_ROUTE_ACCESS_DENIED', {
            matched: true,
            listener,
            lease,
            hostSelection,
            definition,
            canonicalPath,
            decision,
        });
    }
    const target = resolveHttpServiceTarget(definition, snapshot.routing);
    const inventoryKey = serviceInventoryKey(definition);
    const compiled = snapshot.compiled.services.find((entry) => (
        serviceInventoryKey(entry) === inventoryKey
    ));
    if (!target || !compiled?.target
        || target.hostname !== compiled.target.hostname
        || target.hostPort !== compiled.target.hostPort
        || target.containerPort !== compiled.target.containerPort) {
        return deny(503, 'TARGET_INACTIVE', { lease, hostSelection, definition, decision });
    }
    const upstreamPath = buildServiceAgentPath(
        canonicalPath,
        parsedUrl.search,
        definition.externalPrefix,
        definition.internalPrefix,
    );
    if (hasInternalAgentSegment(upstreamPath)) return deny(404, 'ROUTE_NOT_FOUND', { lease, hostSelection });
    return {
        matched: true,
        ok: true,
        kind: 'service',
        listener,
        host,
        hostSelection,
        pathname,
        canonicalPath,
        parsedUrl: new URL(`${canonicalPath}${parsedUrl.search}`, `http://${host === '::1' ? '[::1]' : host}`),
        definition,
        target,
        upstreamPath,
        decision,
        policyFingerprint: snapshot.sourceDigests.policy,
        forwarding: canonicalForwardingMetadata({ snapshot, host, listener, hostSelection }),
        lease,
        snapshot,
    };
}

function agentRootPlan({ req, host, listener, pathname, parsedUrl, hostSelection, selectedRoot, routes, services, snapshot, lease }) {
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

export function resolveEdgeRoutePlan({ req, parsedUrl = null, listener = 'public' } = {}) {
    let lease;
    try {
        lease = captureEdgeRoutingLease();
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
    let services;
    try {
        services = runtimeServices(snapshot);
    } catch (_) {
        return deny(503, 'EDGE_GENERATION_INVALID', { lease });
    }
    const internalKeys = internalServiceKeys(snapshot);
    const publicServices = services.filter((service) => !internalKeys.has(serviceKey(service.routeKey, service.slug)));
    const privateServices = services.filter((service) => internalKeys.has(serviceKey(service.routeKey, service.slug)));
    const hostSelection = classifyHost({ host, listener, snapshot });
    if (!hostSelection) return deny(421, 'UNKNOWN_HOST', { lease });
    if (hostSelection.kind === 'inactive-public') {
        return deny(503, 'HOST_SELECTOR_INACTIVE', { lease, hostSelection });
    }

    if (listener === 'private') {
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
        const definition = serviceForPath(privateServices, pathname);
        if (!definition) return deny(404, 'PRIVATE_ROUTE_SURFACE_DENIED', { lease, hostSelection });
        return servicePlan({
            req,
            host,
            listener,
            pathname,
            parsedUrl: url,
            hostSelection,
            definition,
            dedicated: false,
            services,
            snapshot,
            lease,
        });
    }

    if (hostSelection.kind === 'dedicated-service') {
        const definition = findService(
            publicServices,
            hostSelection.record.routeKey,
            hostSelection.record.slug || hostSelection.record.httpService,
        );
        if (!definition) return deny(503, 'HOST_SELECTOR_STALE', { lease, hostSelection });
        const authEnabled = definition.access === 'authenticated'
            || (definition.access === 'guest' && hostSelection.record.optionalLogin === true);
        if (DEDICATED_SERVICE_AUTH_SUPPORT_PATHS.has(pathname) && authEnabled) {
            return routerSurfacePlan({
                hostSelection,
                host,
                pathname,
                parsedUrl: url,
                lease,
                snapshot,
                surface: 'browser-auth',
            });
        }
        if (isReservedRouterSurface(pathname)) {
            return deny(404, 'ROUTE_SURFACE_DENIED', { lease, hostSelection });
        }
        return servicePlan({
            req,
            host,
            listener,
            pathname,
            parsedUrl: url,
            hostSelection,
            definition,
            dedicated: true,
            services,
            snapshot,
            lease,
        });
    }

    if (hostSelection.kind === 'agent-root') {
        const mountRecords = snapshot.compiled.mounts?.[host] || [];
        const matchingMounts = mountRecords.filter((mount) => (
            pathname === mount.externalPrefix.replace(/\/$/, '') || pathname.startsWith(mount.externalPrefix)
        ));
        if (matchingMounts.length > 1) return deny(503, 'HOST_SELECTOR_INVALID', { lease, hostSelection });
        if (matchingMounts.length === 1) {
            const mount = matchingMounts[0];
            const definition = findService(publicServices, mount.routeKey, mount.slug);
            if (!definition) return deny(503, 'HOST_SELECTOR_STALE', { lease, hostSelection });
            return servicePlan({
                req,
                host,
                listener,
                pathname,
                parsedUrl: url,
                hostSelection,
                definition,
                dedicated: false,
                services,
                snapshot,
                lease,
            });
        }
        const surface = surfaceForPath(pathname, snapshot.compiled.surfaces?.[host] || []);
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
            services,
            snapshot,
            lease,
        });
    }

    const selectedByPath = serviceForPath(publicServices, pathname);
    if (selectedByPath) {
        return servicePlan({
            req,
            host,
            listener,
            pathname,
            parsedUrl: url,
            hostSelection,
            definition: selectedByPath,
            dedicated: false,
            services,
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
        services,
        snapshot,
        lease,
    });
    if (agentPlan.ok || hostSelection.kind !== 'control') return agentPlan;
    return deny(404, 'ROUTE_NOT_FOUND', { lease, hostSelection });
}

export function commitRoutePlan(plan) {
    return Boolean(plan?.ok && plan?.lease?.commit?.());
}

export default {
    commitRoutePlan,
    isPrivateInterfaceAllowed,
    normalizeExactHost,
    resolveEdgeRoutePlan,
};
