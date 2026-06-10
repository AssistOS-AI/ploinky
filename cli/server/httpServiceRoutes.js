import fs from 'fs';
import path from 'path';

import { ROUTING_FILE } from '../services/config.js';
import { resolveEnabledAgentRecord } from '../services/agents.js';
import { findAgent } from '../services/utils.js';
import { resolveMaxTtlSeconds } from './mcp-proxy/userDelegationGrant.js';

export function loadRoutingConfig() {
    const dynamicRoutingFile = process.env.PLOINKY_ROUTING_FILE
        || path.join(process.cwd(), '.ploinky', 'routing.json');
    const routingFile = fs.existsSync(dynamicRoutingFile) ? dynamicRoutingFile : ROUTING_FILE;
    try {
        return JSON.parse(fs.readFileSync(routingFile, 'utf8')) || {};
    } catch (_) {
        return {};
    }
}

function readJsonFileIfExists(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return null;
    }
}

function readEnabledAgentManifest(routeKey, routes = {}) {
    const normalizedRouteKey = String(routeKey || '').trim();
    if (!normalizedRouteKey) return null;

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

function asServiceSpecEntries(value, defaultAuthMode = '') {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.map((entry) => ({ spec: entry, defaultAuthMode }));
    }
    if (typeof value === 'object') {
        return Object.entries(value).map(([key, entry]) => ({
            spec: typeof entry === 'object' && entry !== null
                ? { slug: key, ...entry }
                : { slug: key, internalPrefix: String(entry || '/') },
            defaultAuthMode
        }));
    }
    return [];
}

function normalizePrefix(value, fallback) {
    const raw = String(value || fallback || '').trim();
    if (!raw) return '';
    const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
    return prefixed.endsWith('/') ? prefixed : `${prefixed}/`;
}

function normalizeAuthMode(value, fallback = '') {
    const normalized = String(value || fallback || '').trim().toLowerCase();
    if (['none', 'public', 'anonymous'].includes(normalized)) return 'none';
    if (['guest', 'visitor'].includes(normalized)) return 'guest';
    if (['protected', 'authenticated', 'auth', 'local', 'sso'].includes(normalized)) return 'protected';
    return fallback || 'protected';
}

function uniqueTrimmedStrings(values) {
    if (!Array.isArray(values)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of values) {
        const value = String(raw || '').trim();
        if (!value || seen.has(value.toLowerCase())) continue;
        seen.add(value.toLowerCase());
        out.push(value);
    }
    return out;
}

function normalizeDelegation(spec) {
    const hasDelegations = Array.isArray(spec.delegations);
    const delegations = hasDelegations ? spec.delegations.map((entry) => {
        const targetAgentId = String(entry?.targetAgentId || '').trim();
        const tools = uniqueTrimmedStrings(entry?.tools);
        const scopes = uniqueTrimmedStrings(entry?.scopes || entry?.scope || []);
        const ttlRaw = Number.parseInt(String(entry?.ttlSeconds || ''), 10);
        const ttlSeconds = Number.isFinite(ttlRaw) ? ttlRaw : 1800;
        return {
            targetAgentId,
            tools,
            scopes,
            ttlSeconds,
        };
    }) : [];

    return {
        hasDelegations,
        entries: delegations.filter((entry) => entry.targetAgentId || entry.tools.length || entry.scopes.length || entry.ttlSeconds !== 1800),
        rawSource: spec.delegations,
    };
}

function validateAndNormalizeDelegations(spec, authMode, route = {}) {
    const normalized = normalizeDelegation(spec);
    if (!normalized.hasDelegations) {
        return [];
    }

    if (authMode !== 'protected') {
        throw new Error(`Delegations are only supported for protected HTTP services. Route '${spec.slug || ''}' is '${authMode}'.`);
    }

    const out = [];
    const errors = [];

    for (const delegation of normalized.entries) {
        let targetAgentId = String(delegation.targetAgentId || '').trim();
        const sourceRepo = String(route?.repo || '').trim();
        const relativeMatch = targetAgentId.match(/^agent:\.\/([^/\s:]+)$/);
        if (relativeMatch) {
            if (!sourceRepo) {
                errors.push(`cannot expand relative target '${targetAgentId}' without a source repo`);
                continue;
            }
            targetAgentId = `agent:${sourceRepo}/${relativeMatch[1]}`;
        }
        const targetValid = /^agent:[^/\s:]+\/[^/\s:]+$/.test(targetAgentId);
        if (!targetValid) {
            errors.push(`invalid targetAgentId '${targetAgentId}'`);
            continue;
        }

        const tools = uniqueTrimmedStrings(delegation.tools);
        if (!tools.length) {
            errors.push(`empty delegation tools for '${targetAgentId}'`);
            continue;
        }

        const scopes = uniqueTrimmedStrings(delegation.scopes);
        if (!scopes.length) {
            errors.push(`empty delegation scopes for '${targetAgentId}'`);
            continue;
        }

        const ttlRaw = Number.parseInt(String(delegation.ttlSeconds), 10);
        const ttlSeconds = Number.isFinite(ttlRaw) ? ttlRaw : 1800;
        if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > resolveMaxTtlSeconds()) {
            errors.push(`invalid ttlSeconds for '${targetAgentId}'`);
            continue;
        }

        out.push({
            targetAgentId,
            tools,
            scope: scopes,
            ttlSeconds,
        });
    }

    if (errors.length) {
        throw new Error(`Invalid service delegations: ${errors.join('; ')}`);
    }
    return out;
}

function normalizeServiceSpec(routeKey, route, spec, defaultAuthMode = '') {
    if (!spec || typeof spec !== 'object') return null;
    const slug = String(spec.slug || spec.name || '').trim().replace(/^\/+|\/+$/g, '');
    const authMode = normalizeAuthMode(spec.auth || spec.mode, defaultAuthMode);
    const explicitExternalPrefix = String(spec.externalPrefix || spec.prefix || spec.path || '').trim();
    const externalPrefix = normalizePrefix(
        explicitExternalPrefix,
        slug
            ? `${authMode === 'protected' ? '/services' : '/public-services'}/${slug}/`
            : ''
    );
    const internalPrefix = normalizePrefix(spec.internalPrefix || spec.targetPrefix || spec.upstreamPrefix, '/');
    if (!externalPrefix || !internalPrefix) return null;

    return {
        routeKey,
        route,
        externalPrefix,
        internalPrefix,
        authMode,
        guestScope: String(spec.guestScope || `http-service:${routeKey}:${externalPrefix}`).trim(),
        forceGuest: spec.forceGuest === true,
        issueInvocation: spec.invocation !== false && authMode !== 'none',
        includeAuthInfo: spec.includeAuthInfo !== false && authMode !== 'none',
        notFoundMessage: String(spec.notFoundMessage || 'HTTP service route not found.'),
        delegations: validateAndNormalizeDelegations(spec, authMode, route),
    };
}

export { normalizeServiceSpec };

function collectRouteServiceSpecs(routeKey, route, routes) {
    const manifest = readEnabledAgentManifest(routeKey, routes) || {};
    return [
        ...asServiceSpecEntries(route?.httpServices),
        ...asServiceSpecEntries(manifest?.httpServices),
        ...asServiceSpecEntries(route?.publicServices, 'none'),
        ...asServiceSpecEntries(manifest?.publicServices, 'none')
    ]
        .map(({ spec, defaultAuthMode }) => normalizeServiceSpec(routeKey, route, spec, defaultAuthMode))
        .filter(Boolean);
}

export function collectHttpServiceRoutes(routing = loadRoutingConfig()) {
    const routes = routing?.routes || {};
    const definitions = [];
    for (const [routeKey, route] of Object.entries(routes)) {
        if (!route || route.disabled) continue;
        definitions.push(...collectRouteServiceSpecs(routeKey, route, routes));
    }
    return definitions;
}

export function resolveHttpServiceRoute(pathname, routing = loadRoutingConfig()) {
    const normalizedPathname = String(pathname || '');
    return collectHttpServiceRoutes(routing).find((definition) =>
        normalizedPathname === definition.externalPrefix.replace(/\/$/, '')
        || normalizedPathname.startsWith(definition.externalPrefix)
    ) || null;
}

export function isAnonymousHttpServiceRoute(pathname, routing = loadRoutingConfig()) {
    const definition = resolveHttpServiceRoute(pathname, routing);
    return definition?.authMode === 'none';
}

export function buildServiceAgentPath(pathname, search = '', externalPrefix, internalPrefix) {
    const suffix = String(pathname || '').startsWith(externalPrefix)
        ? String(pathname || '').slice(externalPrefix.length)
        : '';
    const normalizedSuffix = suffix.replace(/^\/+/, '');
    return `${internalPrefix}${normalizedSuffix}${search || ''}`;
}
