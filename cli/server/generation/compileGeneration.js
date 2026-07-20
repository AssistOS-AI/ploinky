import crypto from 'node:crypto';

import { normalizeCanonicalPortSet } from '../../../Agent/lib/requestHash.mjs';
import { normalizeRelayDescriptor } from '../runtimeRelay/confinement.js';
import { compileProxyLimits } from '../proxy/limits.js';
import { assertRouteKeyAvailable } from '../../utils/runtime/reservedRouteKeys.js';
import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
import { deepFreeze } from '../proxy/RoutePlan.js';
import { HttpRouteAccessPath } from '../policy/HttpRouteAccessPath.js';
import { normalizeHttpRouteAccess } from '../policy/HttpRouteAccessDecision.js';
import { normalizeAuthority } from './authority.js';

const LEGACY_KEYS = new Set([
    ['host', 'Port'].join(''),
    ['open', 'Ports'].join(''),
    ['additional', 'Server', 'Port'].join(''),
]);

function exactBytes(value, label) {
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (typeof value === 'string') return Buffer.from(value, 'utf8');
    throw new Error(`generationCompile: exact ${label} bytes required`);
}

function parseJson(bytes, label) {
    try {
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
        return parsed;
    } catch (error) {
        throw new Error(`generationCompile: invalid ${label}: ${error.message}`);
    }
}

function rejectLegacy(value, path = 'routing') {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        if (LEGACY_KEYS.has(key)) throw new Error(`generationCompile: forbidden legacy field ${path}.${key}`);
        rejectLegacy(child, `${path}.${key}`);
    }
}

function compileSurfaces(routing, options) {
    const source = routing.surfaces || options.surfaces || {};
    const publicAuthority = normalizeAuthority(source.public?.authority || options.publicAuthority, 'public');
    const surfaces = {
        public: Object.freeze({ listenerClass: 'public', authority: publicAuthority }),
    };
    if (source.private?.enabled !== false && (source.private?.authority || options.privateAuthority)) {
        const privateAuthority = normalizeAuthority(source.private?.authority || options.privateAuthority, 'private');
        if (privateAuthority === publicAuthority) throw new Error('generationCompile: listener authorities are ambiguous');
        surfaces.private = Object.freeze({ listenerClass: 'private', authority: privateAuthority });
    }
    return Object.freeze(surfaces);
}

function compileRoute(routeKey, route, inheritedLimits) {
    assertRouteKeyAvailable(routeKey, { label: 'Agent route key' });
    if (!route || typeof route !== 'object' || route.disabled === true) return null;
    const relayInput = route.relay || (route.containerId ? {
        kind: 'container-exec-stdio',
        runtime: route.runtime,
        containerId: route.containerId,
        containerName: route.container,
        targetAgentId: route.targetAgentId,
        effectiveInstanceId: route.effectiveInstanceId,
        networkMode: route.networkMode,
    } : null);
    const relay = relayInput ? normalizeRelayDescriptor(relayInput) : null;
    const repo = String(route.repo || '').trim();
    const agent = String(route.agent || routeKey).trim();
    let derivedPrincipal;
    try {
        derivedPrincipal = deriveAgentPrincipalId(repo, agent);
    } catch (_) {
        throw new Error(`generationCompile: route '${routeKey}' has incomplete agent identity`);
    }
    if (relay && relay.targetAgentId !== derivedPrincipal) {
        throw new Error(`generationCompile: route '${routeKey}' relay principal does not match its agent identity`);
    }
    const effectiveInstanceId = String(route.effectiveInstanceId || '').trim();
    const enableGeneration = String(route.enableGeneration || '').trim();
    if (!effectiveInstanceId || !enableGeneration || (relay && relay.effectiveInstanceId !== effectiveInstanceId)) {
        throw new Error(`generationCompile: route '${routeKey}' has incomplete or inconsistent identity`);
    }
    if (route.auth !== undefined && (!route.auth || typeof route.auth !== 'object' || Array.isArray(route.auth))) {
        throw new Error(`generationCompile: route '${routeKey}' has invalid captured auth policy`);
    }
    if (route.manifest !== undefined && (!route.manifest || typeof route.manifest !== 'object' || Array.isArray(route.manifest))) {
        throw new Error(`generationCompile: route '${routeKey}' has invalid captured manifest`);
    }
    if (route.mcpConfig !== undefined && (!route.mcpConfig || typeof route.mcpConfig !== 'object' || Array.isArray(route.mcpConfig))) {
        throw new Error(`generationCompile: route '${routeKey}' has invalid captured MCP config`);
    }
    const primaryService = route.primaryService === undefined ? null : route.primaryService;
    if (primaryService !== null) {
        if (!primaryService || !Number.isInteger(primaryService.port) || primaryService.port < 1 || primaryService.port > 65535) {
            throw new Error(`generationCompile: route '${routeKey}' has invalid primary service descriptor`);
        }
    }
    const deniedPorts = Object.freeze(normalizeCanonicalPortSet(route.deniedPorts || []));
    if (primaryService && deniedPorts.includes(primaryService.port)) {
        throw new Error(`generationCompile: route '${routeKey}' primary service is denied`);
    }
    const auth = deepFreeze({ ...(route.auth || { mode: 'none' }) });
    const authMode = String(auth.mode || 'none').trim().toLowerCase();
    const defaultAccess = String(route.defaultAccess || (
        authMode === 'guest' ? 'guest' : authMode && authMode !== 'none' ? 'authenticated' : 'guest'
    ));
    return Object.freeze({
        enabled: true,
        routeKey,
        agent,
        repo,
        hostPath: String(route.hostPath || ''),
        alias: String(route.alias || ''),
        auth,
        manifest: deepFreeze({ ...(route.manifest || {}) }),
        mcpConfig: deepFreeze({ ...(route.mcpConfig || {}) }),
        httpServices: deepFreeze(route.httpServices || null),
        routerAccess: deepFreeze(route.routerAccess || null),
        defaultAccess,
        effectiveInstanceId,
        enableGeneration,
        relay,
        deniedPorts,
        primaryService: primaryService ? Object.freeze({ port: primaryService.port }) : null,
        allowRequestStreaming: route.allowRequestStreaming === true,
        limits: compileProxyLimits({ ...(inheritedLimits || {}), ...(route.limits || {}) }),
        credentialPolicy: Object.freeze({ ...(route.credentialPolicy || {}) }),
        responsePolicy: Object.freeze({ ...(route.responsePolicy || {}) }),
        originPolicy: Object.freeze({ ...(route.originPolicy || {}) }),
    });
}

function manifestPolicyEntries(routes) {
    const entries = [];
    for (const [routeKey, route] of Object.entries(routes || {})) {
        const source = route?.routerAccess?.httpRoutes;
        const specs = Array.isArray(source)
            ? source
            : source && typeof source === 'object'
                ? Object.entries(source).map(([path, value]) => value && typeof value === 'object'
                    ? { path, ...value }
                    : { path, access: value })
                : [];
        for (const spec of specs) {
            const access = Object.prototype.hasOwnProperty.call(spec || {}, 'access')
                ? normalizeHttpRouteAccess(spec.access)
                : 'authenticated';
            const relative = String(spec?.path || '').trim();
            const suffix = relative.startsWith('/') ? relative : `/${relative}`;
            if (!access || suffix === '/' || suffix === '/*') {
                throw new Error(`generationCompile: invalid manifest HTTP policy for '${routeKey}'`);
            }
            const normalized = HttpRouteAccessPath.normalize(`/${encodeURIComponent(routeKey)}${suffix}`);
            if (!normalized.ok) throw new Error(`generationCompile: invalid manifest HTTP policy for '${routeKey}'`);
            entries.push({ path: normalized.path, access, routeKey, source: 'manifest' });
        }
    }
    return entries;
}

function validatePolicy(policy, routes) {
    const persisted = Array.isArray(policy.entries)
        ? policy.entries
        : Array.isArray(policy.httpRoutes) ? policy.httpRoutes : [];
    const entries = [...persisted, ...manifestPolicyEntries(routes)];
    const seen = new Map();
    const compiledEntries = [];
    for (const entry of entries) {
        if (entry?.enabled === false) continue;
        if (!entry || typeof entry !== 'object' || !entry.path || !entry.access) {
            throw new Error('generationCompile: incomplete policy entry');
        }
        const normalizedPath = HttpRouteAccessPath.normalize(String(entry.path));
        const access = normalizeHttpRouteAccess(entry.access);
        const method = String(entry.method || '*').toUpperCase();
        if (!normalizedPath.ok || normalizedPath.path !== String(entry.path) || !access
            || (method !== '*' && !/^[A-Z]+$/.test(method))) {
            throw new Error(`generationCompile: invalid policy entry at '${String(entry.path || '')}'`);
        }
        const key = `${normalizedPath.path}\0${method}\0${access}`;
        const accessMetadata = JSON.stringify({
            guestScope: entry.guestScope || '',
            origin: entry.origin || '',
            methods: entry.methods || null,
        });
        if (seen.has(key) && seen.get(key) !== accessMetadata) {
            throw new Error(`generationCompile: equal-rank policy metadata conflict at '${entry.path}'`);
        }
        seen.set(key, accessMetadata);
        compiledEntries.push(deepFreeze({ ...entry, path: normalizedPath.path, access, ...(entry.method ? { method } : {}) }));
    }
    return Object.freeze(compiledEntries);
}

function compilePrivateCallerAcls(input, routes) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('generationCompile: private caller ACLs must be an object');
    }
    const activePrincipals = new Set(Object.values(routes).map(route => route?.relay?.targetAgentId).filter(Boolean));
    const result = {};
    for (const [targetRouteKey, rawCallers] of Object.entries(input)) {
        if (!routes[targetRouteKey]) throw new Error(`generationCompile: private caller ACL target '${targetRouteKey}' is inactive`);
        if (!Array.isArray(rawCallers)) throw new Error(`generationCompile: private caller ACL '${targetRouteKey}' must be an array`);
        const entries = [];
        const targetRoute = routes[targetRouteKey];
        if (!targetRoute.relay) throw new Error(`generationCompile: private caller ACL target '${targetRouteKey}' has no relay`);
        for (const rawEntry of rawCallers) {
            if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
                throw new Error(`generationCompile: private caller ACL '${targetRouteKey}' requires exact entries`);
            }
            const callerAgentId = String(rawEntry.callerAgentId || '').trim();
            const method = String(rawEntry.method || '').trim().toUpperCase();
            const aclPath = String(rawEntry.path || '').trim();
            const port = Number(rawEntry.port);
            if (!activePrincipals.has(callerAgentId)) {
                throw new Error(`generationCompile: private caller ACL '${targetRouteKey}' contains an inactive caller`);
            }
            if (!/^[A-Z]+$/.test(method) || !Number.isInteger(port) || port < 1 || port > 65535) {
                throw new Error(`generationCompile: private caller ACL '${targetRouteKey}' has an invalid method or port`);
            }
            const normalizedPath = HttpRouteAccessPath.normalize(aclPath, { allowWildcard: false });
            if (!normalizedPath.ok || normalizedPath.path !== aclPath || aclPath.includes('*')) {
                throw new Error(`generationCompile: private caller ACL '${targetRouteKey}' has a non-canonical path`);
            }
            if (targetRoute.deniedPorts.includes(port)) {
                throw new Error(`generationCompile: private caller ACL '${targetRouteKey}' selects a denied port`);
            }
            const entry = deepFreeze({ callerAgentId, port, method, path: aclPath });
            if (!entries.some(existing => JSON.stringify(existing) === JSON.stringify(entry))) entries.push(entry);
        }
        result[targetRouteKey] = Object.freeze(entries);
    }
    return deepFreeze(result);
}

export function compileGeneration({ routingBytes, policyBytes = '{}', ...options } = {}) {
    const capturedRoutingBytes = exactBytes(routingBytes, 'routing');
    const capturedPolicyBytes = exactBytes(policyBytes, 'policy');
    const routing = parseJson(capturedRoutingBytes, 'routing');
    const policy = parseJson(capturedPolicyBytes, 'policy');
    rejectLegacy(routing);
    const limits = compileProxyLimits(routing.limits || options.limits || {});
    const surfaces = compileSurfaces(routing, options);
    const routes = {};
    for (const [routeKey, route] of Object.entries(routing.routes || {})) {
        const compiled = compileRoute(routeKey, route, routing.limits || options.limits || {});
        if (compiled) routes[routeKey] = compiled;
    }
    const routeByPrincipal = new Map();
    for (const [routeKey, route] of Object.entries(routes)) {
        const principal = route.relay?.targetAgentId;
        if (!principal) continue;
        if (routeByPrincipal.has(principal)) {
            throw new Error(`generationCompile: relay principal is ambiguous across '${routeByPrincipal.get(principal)}' and '${routeKey}'`);
        }
        routeByPrincipal.set(principal, routeKey);
    }
    const privateCallerAcls = compilePrivateCallerAcls(routing.privateCallerAcls || {}, routes);
    const digest = crypto.createHash('sha256')
        .update(capturedRoutingBytes)
        .update(Buffer.from([0]))
        .update(capturedPolicyBytes)
        .update(Buffer.from([0]))
        .update(JSON.stringify({ surfaces, limits }))
        .digest('base64url');
    return deepFreeze({
        active: true,
        digest,
        compiledAt: new Date().toISOString(),
        source: {
            routingBytes: capturedRoutingBytes.toString('base64'),
            policyBytes: capturedPolicyBytes.toString('base64'),
        },
        surfaces,
        routes,
        static: deepFreeze({ ...(routing.static || {}) }),
        policyEntries: validatePolicy(policy, routes),
        privateCallerAcls,
        limits,
    });
}

export default compileGeneration;
