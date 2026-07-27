import path from 'node:path';

import { normalizeHttpRouteAccess } from './policy/HttpRouteAccessDecision.js';
import { resolveMaxTtlSeconds } from './mcp-proxy/userDelegationGrant.js';

const DEFAULT_DELEGATION_TTL_SECONDS = 1800;

function uniqueTrimmedStrings(values) {
    if (!Array.isArray(values)) return [];
    const output = [];
    const seen = new Set();
    for (const raw of values) {
        const value = String(raw || '').trim();
        if (!value || seen.has(value.toLowerCase())) continue;
        seen.add(value.toLowerCase());
        output.push(value);
    }
    return output;
}

function normalizePathRoot(value) {
    const raw = String(value || '').trim().replace(/\\/g, '/');
    if (!raw) return '';
    const normalized = path.posix.normalize(raw.startsWith('/') ? raw : `/${raw}`);
    if (!normalized || normalized === '.') return '';
    return normalized === '/' ? '/' : normalized.replace(/\/+$/g, '');
}

function uniquePathRoots(values) {
    const output = [];
    const seen = new Set();
    for (const raw of Array.isArray(values) ? values : []) {
        const value = normalizePathRoot(raw);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        output.push(value);
    }
    return output;
}

function normalizeDelegationWhen(value) {
    if (value === undefined || value === null) return null;
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
    return { queryParam, pathRoots };
}

function normalizeDelegations(spec, access, route = {}) {
    if (!Array.isArray(spec.delegations)) return [];
    if (access !== 'authenticated') {
        throw new Error('Delegations are only supported for authenticated HTTP routes.');
    }

    const output = [];
    const errors = [];
    for (const raw of spec.delegations) {
        let targetAgentId = String(raw?.targetAgentId || '').trim();
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
        if (!targetMatch || targetMatch.slice(1).some((segment) => segment === '.' || segment === '..')) {
            errors.push(`invalid targetAgentId '${targetAgentId}'`);
            continue;
        }

        const tools = uniqueTrimmedStrings(raw?.tools);
        const scope = uniqueTrimmedStrings(raw?.scopes || raw?.scope || []);
        const ttlRaw = Number.parseInt(String(raw?.ttlSeconds || ''), 10);
        const ttlSeconds = Number.isFinite(ttlRaw) ? ttlRaw : DEFAULT_DELEGATION_TTL_SECONDS;
        const when = normalizeDelegationWhen(raw?.when);
        if (!tools.length) errors.push(`empty delegation tools for '${targetAgentId}'`);
        else if (!scope.length) errors.push(`empty delegation scopes for '${targetAgentId}'`);
        else if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > resolveMaxTtlSeconds()) {
            errors.push(`invalid ttlSeconds for '${targetAgentId}'`);
        } else if (when?.error) {
            errors.push(`${when.error} for '${targetAgentId}'`);
        } else {
            output.push({
                key: String(raw?.key || '').trim(),
                targetAgentId,
                tools,
                scope,
                ttlSeconds,
                ...(when ? { when } : {}),
            });
        }
    }
    if (errors.length) throw new Error(`Invalid HTTP route delegations: ${errors.join('; ')}`);
    return output;
}

function canonicalPrefix(value) {
    const raw = String(value || '').trim();
    if (!raw || !raw.startsWith('/')) throw new Error('HTTP route path must be absolute');
    return raw.endsWith('/') ? raw : `${raw}/`;
}

export function normalizeHttpRouteAuthDefinition(routeKey, route, spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new Error('HTTP route authentication definition must be an object');
    }
    const port = Number(spec.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error('HTTP route port must be an integer in 1..65535');
    }
    const access = normalizeHttpRouteAccess(spec.access);
    if (!access) throw new Error('HTTP route requires public, guest, or authenticated access');
    const pathPrefix = canonicalPrefix(spec.path);
    return {
        routeKey,
        route,
        port,
        pathPrefix,
        access,
        guestScope: String(spec.guestScope || `http-route:${routeKey}:${pathPrefix}`).trim(),
        issueInvocation: spec.invocation !== false && access !== 'public',
        includeAuthInfo: spec.includeAuthInfo !== false && access !== 'public',
        delegations: normalizeDelegations(spec, access, route),
    };
}
