import fs from 'fs';
import path from 'path';

import { ROUTING_FILE } from '../services/config.js';
import { resolveEnabledAgentRecord } from '../services/agents.js';
import { findAgent } from '../services/utils.js';
import { resolveMaxTtlSeconds } from './mcp-proxy/userDelegationGrant.js';
import { normalizeHttpRouteAccess } from './policy/HttpRouteAccessDecision.js';

const DEFAULT_DELEGATION_TTL_SECONDS = 1800;
const REMOVED_SERVICE_SPEC_FIELDS = ['auth', 'mode', 'forceGuest'];

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

function asServiceSpecEntries(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.map((entry) => ({ spec: entry }));
    }
    if (typeof value === 'object') {
        return Object.entries(value).map(([key, entry]) => ({
            spec: typeof entry === 'object' && entry !== null
                ? { slug: key, ...entry }
                : { slug: key, internalPrefix: String(entry || '/') },
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

function normalizeServiceAccess(value) {
    return normalizeHttpRouteAccess(value);
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

function normalizePathRoot(value) {
    const raw = String(value || '').trim().replace(/\\/g, '/');
    if (!raw) return '';
    const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
    const collapsed = path.posix.normalize(prefixed);
    if (!collapsed || collapsed === '.') return '';
    return collapsed === '/' ? '/' : collapsed.replace(/\/+$/g, '');
}

function uniquePathRoots(values) {
    if (!Array.isArray(values)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of values) {
        const value = normalizePathRoot(raw);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

function normalizeDelegationWhen(value) {
    if (value === undefined || value === null) {
        return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { error: 'invalid delegation when condition' };
    }
    const queryParam = String(value.queryParam || 'path').trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(queryParam)) {
        return { error: `invalid delegation condition queryParam '${queryParam}'` };
    }
    const pathRoots = uniquePathRoots(value.pathRoots || value.queryPathRoots || []);
    if (!pathRoots.length) {
        return { error: 'delegation when condition requires non-empty pathRoots' };
    }
    return {
        queryParam,
        pathRoots,
    };
}

function normalizeDelegation(spec) {
    const hasDelegations = Array.isArray(spec.delegations);
    const delegations = hasDelegations ? spec.delegations.map((entry) => {
        const targetAgentId = String(entry?.targetAgentId || '').trim();
        const tools = uniqueTrimmedStrings(entry?.tools);
        const scopes = uniqueTrimmedStrings(entry?.scopes || entry?.scope || []);
        const ttlRaw = Number.parseInt(String(entry?.ttlSeconds || ''), 10);
        const ttlSeconds = Number.isFinite(ttlRaw) ? ttlRaw : DEFAULT_DELEGATION_TTL_SECONDS;
        return {
            key: String(entry?.key || '').trim(),
            targetAgentId,
            tools,
            scopes,
            ttlSeconds,
            when: normalizeDelegationWhen(entry?.when),
        };
    }) : [];

    return {
        hasDelegations,
        entries: delegations.filter((entry) => entry.targetAgentId || entry.tools.length || entry.scopes.length || entry.ttlSeconds !== DEFAULT_DELEGATION_TTL_SECONDS || entry.when),
        rawSource: spec.delegations,
    };
}

function validateAndNormalizeDelegations(spec, access, route = {}) {
    const normalized = normalizeDelegation(spec);
    if (!normalized.hasDelegations) {
        return [];
    }

    if (access !== 'authenticated') {
        throw new Error(`Delegations are only supported for authenticated HTTP services. Route '${spec.slug || ''}' is '${access}'.`);
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
        const targetMatch = targetAgentId.match(/^agent:([^/\s:]+)\/([^/\s:]+)$/);
        const targetValid = Boolean(targetMatch)
            && targetMatch.slice(1).every((segment) => segment !== '.' && segment !== '..');
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
        const ttlSeconds = Number.isFinite(ttlRaw) ? ttlRaw : DEFAULT_DELEGATION_TTL_SECONDS;
        if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > resolveMaxTtlSeconds()) {
            errors.push(`invalid ttlSeconds for '${targetAgentId}'`);
            continue;
        }
        if (delegation.when?.error) {
            errors.push(`${delegation.when.error} for '${targetAgentId}'`);
            continue;
        }

        out.push({
            key: String(delegation.key || '').trim(),
            targetAgentId,
            tools,
            scope: scopes,
            ttlSeconds,
            ...(delegation.when ? { when: delegation.when } : {}),
        });
    }

    if (errors.length) {
        throw new Error(`Invalid service delegations: ${errors.join('; ')}`);
    }
    return out;
}

function normalizeServiceSpec(routeKey, route, spec) {
    if (!spec || typeof spec !== 'object') return null;
    for (const field of REMOVED_SERVICE_SPEC_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(spec, field)) {
            throw new Error(`HTTP service spec field '${field}' was removed; declare access: public | guest | authenticated`);
        }
    }
    const slug = String(spec.slug || spec.name || '').trim().replace(/^\/+|\/+$/g, '');
    const access = normalizeServiceAccess(spec.access);
    if (!access) {
        throw new Error(`HTTP service '${slug || routeKey}' requires access: public | guest | authenticated`);
    }
    const explicitExternalPrefix = String(spec.externalPrefix || spec.prefix || spec.path || '').trim();
    const externalPrefix = normalizePrefix(
        explicitExternalPrefix,
        slug ? `${access === 'authenticated' ? '/services' : '/public-services'}/${slug}/` : ''
    );
    const internalPrefix = normalizePrefix(spec.internalPrefix || spec.targetPrefix || spec.upstreamPrefix, '/');
    if (!externalPrefix || !internalPrefix) return null;

    return {
        routeKey,
        route,
        externalPrefix,
        internalPrefix,
        access,
        guestScope: String(spec.guestScope || `http-service:${routeKey}:${externalPrefix}`).trim(),
        issueInvocation: spec.invocation !== false && access !== 'public',
        includeAuthInfo: spec.includeAuthInfo !== false && access !== 'public',
        notFoundMessage: String(spec.notFoundMessage || 'HTTP service route not found.'),
        delegations: validateAndNormalizeDelegations(spec, access, route),
    };
}

export { normalizeServiceSpec };

const loggedInvalidServiceSpecs = new Set();

function collectRouteServiceSpecs(routeKey, route, routes) {
    const manifest = readEnabledAgentManifest(routeKey, routes) || {};
    const collected = [];
    for (const { spec } of [
        ...asServiceSpecEntries(route?.httpServices),
        ...asServiceSpecEntries(manifest?.httpServices),
    ]) {
        try {
            const definition = normalizeServiceSpec(routeKey, route, spec);
            if (definition) collected.push(definition);
        } catch (err) {
            const key = `${routeKey}:${String(spec?.slug || spec?.name || spec?.externalPrefix || '')}`;
            if (!loggedInvalidServiceSpecs.has(key)) {
                loggedInvalidServiceSpecs.add(key);
                console.error(`[ploinky] invalid httpServices spec for route '${routeKey}': ${err?.message || err} - service not mounted (fail closed)`);
            }
        }
    }
    return collected;
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

export function buildServiceAgentPath(pathname, search = '', externalPrefix, internalPrefix) {
    const suffix = String(pathname || '').startsWith(externalPrefix)
        ? String(pathname || '').slice(externalPrefix.length)
        : '';
    const normalizedSuffix = suffix.replace(/^\/+/, '');
    return `${internalPrefix}${normalizedSuffix}${search || ''}`;
}
