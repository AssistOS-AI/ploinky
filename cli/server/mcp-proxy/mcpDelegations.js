import fs from 'node:fs';
import path from 'node:path';

import { loadRoutingConfig } from '../routingState.js';
import { mintUserDelegationGrant, resolveMaxTtlSeconds } from './userDelegationGrant.js';
import { deriveSubkey } from '../../utils/security/masterKey.js';
import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
import { REPOS_DIR } from '../../utils/config.js';

function readMcpConfigTools(agentDir) {
    if (!agentDir) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp-config.json'), 'utf8'));
        return Array.isArray(parsed?.tools) ? parsed.tools : [];
    } catch {
        return [];
    }
}

function resolveAgentDir(route) {
    if (route && typeof route.hostPath === 'string' && route.hostPath) {
        return route.hostPath;
    }
    const repo = String(route?.repo || '').trim();
    const agent = String(route?.agent || '').trim();
    return repo && agent ? path.join(REPOS_DIR, repo, agent) : '';
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

export function deriveDelegationKey(entry = {}, index = 0) {
    const explicit = String(entry.key || '').trim();
    if (explicit) {
        return explicit;
    }
    const scope = Array.isArray(entry.scope) ? String(entry.scope[0] || '').trim() : '';
    const parts = scope.split(':').filter(Boolean);
    if (parts.length >= 2) {
        const [first, second] = parts;
        return `${first}${second.slice(0, 1).toUpperCase()}${second.slice(1)}`;
    }
    const target = String(entry.targetAgentId || '').split('/').pop() || `delegation${index + 1}`;
    return target
        .replace(/Agent$/i, '')
        .replace(/[^A-Za-z0-9]+([A-Za-z0-9])/g, (_match, letter) => letter.toUpperCase());
}

export function normalizeMcpDelegationEntries(entries, { route = {}, toolName = '', sourceAgentId = '' } = {}) {
    if (!Array.isArray(entries) || !entries.length) return [];
    const out = [];
    const errors = [];
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index] && typeof entries[index] === 'object' ? entries[index] : {};
        let targetAgentId = String(entry.targetAgentId || '').trim();
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
            errors.push(`invalid targetAgentId '${entry.targetAgentId || ''}'`);
            continue;
        }
        const tools = uniqueTrimmedStrings(entry.tools);
        if (!tools.length) {
            errors.push(`empty delegation tools for '${targetAgentId}'`);
            continue;
        }
        const scope = uniqueTrimmedStrings(entry.scopes || entry.scope || []);
        if (!scope.length) {
            errors.push(`empty delegation scopes for '${targetAgentId}'`);
            continue;
        }
        const ttlSeconds = Number.parseInt(String(entry.ttlSeconds || ''), 10);
        if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > resolveMaxTtlSeconds()) {
            errors.push(`invalid ttlSeconds for '${targetAgentId}'`);
            continue;
        }
        out.push({
            key: deriveDelegationKey({ ...entry, scope }, index),
            targetAgentId,
            tools,
            scope,
            ttlSeconds,
            sourceAgentId,
        });
    }
    if (errors.length) {
        throw new Error(`Invalid MCP tool delegations for '${toolName}': ${errors.join('; ')}`);
    }
    return out;
}

export function resolveMcpToolDelegations({ routeKey, toolName, routes } = {}) {
    const resolvedRoutes = routes || loadRoutingConfig().routes || {};
    const route = resolvedRoutes?.[String(routeKey || '').trim()] || null;
    if (!route) return [];
    const repo = String(route.repo || '').trim();
    const agent = String(route.agent || '').trim();
    if (!repo || !agent) return [];
    let sourceAgentId = '';
    try {
        sourceAgentId = deriveAgentPrincipalId(repo, agent);
    } catch {
        return [];
    }
    const tool = readMcpConfigTools(resolveAgentDir(route))
        .find((entry) => entry && typeof entry === 'object' && String(entry.name || '') === String(toolName || ''));
    if (!tool || !Array.isArray(tool.delegations) || !tool.delegations.length) return [];
    return normalizeMcpDelegationEntries(tool.delegations, { route, toolName: String(toolName || ''), sourceAgentId });
}

export function buildMcpDelegationsForUserCall({ req, routeKey, toolName, routes, now = new Date() } = {}) {
    const user = req?.user && typeof req.user === 'object' ? req.user : null;
    if (!user || !String(user.id || '').trim()) return undefined;
    const roles = Array.isArray(user.roles)
        ? user.roles.map((role) => String(role || '').trim().toLowerCase())
        : [];
    if (roles.includes('guest')) return undefined;
    const specs = resolveMcpToolDelegations({ routeKey, toolName, routes });
    if (!specs.length) return undefined;
    const signingSecret = deriveSubkey('router-user-delegation', 32);
    const out = {};
    for (const entry of specs) {
        const { token, payload } = mintUserDelegationGrant({
            signingSecret,
            now,
            ttlSeconds: entry.ttlSeconds,
            sourceAgentId: entry.sourceAgentId,
            user: {
                id: user.id,
                username: user.username || user.name || user.email || '',
                email: user.email || '',
                roles: Array.isArray(user.roles) ? [...user.roles] : [],
            },
            targetAgentId: entry.targetAgentId,
            tools: entry.tools,
            scopes: entry.scope,
        });
        out[entry.key] = {
            token,
            expiresAt: new Date(Number(payload.exp || 0) * 1000).toISOString(),
            targetAgentId: entry.targetAgentId,
            tools: [...entry.tools],
            scope: [...entry.scope],
        };
    }
    return Object.keys(out).length ? out : undefined;
}

export default {
    buildMcpDelegationsForUserCall,
    deriveDelegationKey,
    normalizeMcpDelegationEntries,
    resolveMcpToolDelegations,
};
