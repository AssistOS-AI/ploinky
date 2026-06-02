import fs from 'fs';
import path from 'path';

import { ROUTING_FILE } from '../services/config.js';
import { resolveEnabledAgentRecord } from '../services/agents.js';
import { findAgent } from '../services/utils.js';

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
        notFoundMessage: String(spec.notFoundMessage || 'HTTP service route not found.')
    };
}

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
