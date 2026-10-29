import fs from 'node:fs';
import path from 'node:path';

import { loadActiveRoutingState, loadRoutingConfig } from '../routingState.js';
import { mintUserDelegationGrant, resolveMaxTtlSeconds } from './userDelegationGrant.js';
import { deriveSubkey } from '../../utils/security/masterKey.js';
import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
import { REPOS_DIR } from '../../utils/config.js';
import { resolveAgentRepositoryPath } from '../../utils/agentRepositorySource.mjs';

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
    return repo && agent ? path.join(resolveAgentRepositoryPath(repo), agent) : '';
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

// The WebChat message pseudo-tool. Its delegations are declared by the
// manifest key `webchat.delegations`, never by `mcp-config.json`.
export const WEBCHAT_MESSAGE_TOOL = '__webchat_message__';

function isPlainManifestObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Presence is the own property of a `webchat` object, whatever its value.
export function readWebchatDelegationDeclaration(manifest) {
    const webchat = isPlainManifestObject(manifest) && isPlainManifestObject(manifest.webchat) ? manifest.webchat : null;
    if (!webchat || !Object.hasOwn(webchat, 'delegations')) return { present: false };
    return { present: true, entries: webchat.delegations };
}

// Manifest admission: a present `webchat.delegations` must be a non-empty
// array that the MCP-tool delegation normalizer accepts. An invalid value is a
// manifest error, never an absent declaration.
export function normalizeWebchatDelegations(manifest, { repoName = '', agentName = '' } = {}) {
    const read = readWebchatDelegationDeclaration(manifest);
    if (!read.present) return [];
    if (!Array.isArray(read.entries) || read.entries.length === 0) {
        throw new Error(`Invalid MCP tool delegations for '${WEBCHAT_MESSAGE_TOOL}': webchat.delegations must be a non-empty array`);
    }
    let sourceAgentId = '';
    try {
        sourceAgentId = repoName && agentName ? deriveAgentPrincipalId(repoName, agentName) : '';
    } catch {
        sourceAgentId = '';
    }
    return normalizeMcpDelegationEntries(read.entries, {
        route: { repo: repoName },
        toolName: WEBCHAT_MESSAGE_TOOL,
        sourceAgentId,
    });
}

export function assertWebchatDelegationsManifest({ manifest, repoName, agentName, label = '' } = {}) {
    try {
        normalizeWebchatDelegations(manifest, { repoName, agentName });
    } catch (error) {
        throw new Error(`${label ? `${label}: ` : ''}${error.message}`);
    }
}

function activeGenerationSnapshot() {
    try {
        return loadActiveRoutingState().snapshot || null;
    } catch {
        return null;
    }
}

// The WebChat delegations of a route, read only from the admitted manifest of
// the active edge generation (or the caller's lease snapshot). Without an
// active generation, or for an invalid value, nothing is minted.
export function resolveWebchatDelegations({ routeKey, snapshot } = {}) {
    const activeSnapshot = snapshot || activeGenerationSnapshot();
    const key = String(routeKey || '').trim();
    const route = activeSnapshot?.routing?.routes?.[key];
    if (!key || !route || route.disabled) return [];
    const repo = String(route.repo || '').trim();
    const agent = String(route.agent || '').trim();
    if (!repo || !agent) return [];
    try {
        return normalizeWebchatDelegations(activeSnapshot.manifests?.[key], { repoName: repo, agentName: agent });
    } catch {
        return [];
    }
}

export function routeDeclaresWebchatDelegations({ routeKey, snapshot } = {}) {
    return resolveWebchatDelegations({ routeKey, snapshot }).length > 0;
}

export function buildMcpDelegationsForUserCall({ req, routeKey, toolName, routes, snapshot, now = new Date() } = {}) {
    const user = req?.user && typeof req.user === 'object' ? req.user : null;
    if (!user || !String(user.id || '').trim()) return undefined;
    const roles = Array.isArray(user.roles)
        ? user.roles.map((role) => String(role || '').trim().toLowerCase())
        : [];
    if (roles.includes('guest')) return undefined;
    const specs = String(toolName || '') === WEBCHAT_MESSAGE_TOOL
        ? resolveWebchatDelegations({ routeKey, snapshot })
        : resolveMcpToolDelegations({ routeKey, toolName, routes });
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
                displayName: user.username || '',
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
    assertWebchatDelegationsManifest,
    buildMcpDelegationsForUserCall,
    deriveDelegationKey,
    normalizeMcpDelegationEntries,
    normalizeWebchatDelegations,
    resolveMcpToolDelegations,
    resolveWebchatDelegations,
    routeDeclaresWebchatDelegations,
};
