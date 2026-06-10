import crypto from 'node:crypto';

import { signHmacJwt } from '../../../Agent/lib/jwtSign.mjs';
import { verifyJws } from '../../../Agent/lib/jwtVerify.mjs';

const DEFAULT_MAX_TTL_SECONDS = 1800;

export function resolveMaxTtlSeconds(env = process.env) {
    const raw = Number.parseInt(String(env?.PLOINKY_USER_DELEGATION_MAX_TTL_SECONDS || ''), 10);
    return Number.isInteger(raw) && raw >= 30 && raw <= 86400 ? raw : DEFAULT_MAX_TTL_SECONDS;
}

function asDate(value) {
    return value instanceof Date ? value : new Date(value || Date.now());
}

function toUnixSeconds(value) {
    return Math.floor(asDate(value).getTime() / 1000);
}

function normalizeStringList(values) {
    if (!Array.isArray(values)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of values) {
        const value = String(raw || '').trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

function normalizeUser(user = {}) {
    if (!user || typeof user !== 'object') return null;
    const id = String(user.id || user.sub || '').trim().replace(/^user:/i, '');
    if (!id) return null;
    return {
        id,
        username: String(user.username || user.preferred_username || '').trim(),
        email: String(user.email || '').trim(),
        roles: normalizeStringList(user.roles),
    };
}

function buildStableSubject(user) {
    const id = String(user?.id || '').trim().replace(/^user:/i, '');
    return id ? `user:${id}` : '';
}

export function mintUserDelegationGrant({
    signingSecret,
    now = new Date(),
    ttlSeconds,
    sourceAgentId,
    service,
    user,
    targetAgentId,
    tools,
    scopes,
}) {
    const secret = Buffer.isBuffer(signingSecret) ? signingSecret : Buffer.from(signingSecret || '');
    if (!secret.length) {
        throw new Error('userDelegationGrant: signingSecret required');
    }
    const normalizedUser = normalizeUser(user);
    if (!normalizedUser) {
        throw new Error('delegation user missing');
    }
    const iat = toUnixSeconds(now);
    const maxTtl = resolveMaxTtlSeconds();
    const ttl = Math.max(30, Math.min(Number.parseInt(String(ttlSeconds || ''), 10) || DEFAULT_MAX_TTL_SECONDS, maxTtl));
    const payload = {
        typ: 'user-delegation',
        iss: 'ploinky-router',
        aud: 'ploinky-router',
        sub: buildStableSubject(normalizedUser),
        jti: crypto.randomBytes(16).toString('base64url'),
        iat,
        exp: iat + ttl,
        sourceAgentId: String(sourceAgentId || '').trim(),
        service: service && typeof service === 'object' ? {
            routeKey: String(service.routeKey || '').trim(),
            externalPrefix: String(service.externalPrefix || '').trim(),
            internalPrefix: String(service.internalPrefix || '').trim(),
            internalPath: String(service.internalPath || '').trim(),
        } : undefined,
        usr: normalizedUser,
        allowedTargets: normalizeStringList([targetAgentId]),
        allowedTools: normalizeStringList(tools),
        scope: normalizeStringList(scopes),
    };
    const token = signHmacJwt({ payload, secret });
    return { token, payload };
}

export function verifyUserDelegationGrant({
    signingSecret,
    token,
    now = new Date(),
    expectedSourceAgentId,
    expectedTargetAgentId,
    expectedTool,
    replayCache: _replayCache,
}) {
    const secret = Buffer.isBuffer(signingSecret) ? signingSecret : Buffer.from(signingSecret || '');
    if (!secret.length) {
        throw new Error('userDelegationGrant: signingSecret required');
    }
    let payload;
    try {
        ({ payload } = verifyJws(token, {
            secret,
            expectedAudience: 'ploinky-router',
            maxTtlSeconds: resolveMaxTtlSeconds(),
        }));
    } catch (error) {
        const message = String(error?.message || error || '');
        if (/audience mismatch/i.test(message) || /issuer mismatch/i.test(message)) {
            throw new Error('delegation audience mismatch');
        }
        if (/expired/i.test(message)) {
            throw new Error('delegation expired');
        }
        throw error;
    }

    if (payload?.typ !== 'user-delegation') {
        throw new Error('delegation typ mismatch');
    }
    if (String(payload?.iss || '') !== 'ploinky-router' || String(payload?.aud || '') !== 'ploinky-router') {
        throw new Error('delegation audience mismatch');
    }
    if (Number(payload?.exp || 0) <= toUnixSeconds(now)) {
        throw new Error('delegation expired');
    }

    const actorKind = String(payload?.actor?.kind || '').trim().toLowerCase();
    const user = normalizeUser(payload?.usr);
    const roles = normalizeStringList(payload?.usr?.roles);
    if (!user || actorKind === 'agent' || actorKind === 'guest' || roles.includes('guest')) {
        throw new Error('delegation user missing');
    }

    const sourceAgentId = String(payload?.sourceAgentId || '').trim();
    if (String(expectedSourceAgentId || '').trim() && sourceAgentId !== String(expectedSourceAgentId).trim()) {
        throw new Error('delegation source mismatch');
    }

    const allowedTargets = normalizeStringList(payload?.allowedTargets);
    if (String(expectedTargetAgentId || '').trim() && !allowedTargets.includes(String(expectedTargetAgentId).trim())) {
        throw new Error('delegation target mismatch');
    }

    const allowedTools = normalizeStringList(payload?.allowedTools);
    if (String(expectedTool || '').trim() && !allowedTools.includes(String(expectedTool).trim())) {
        throw new Error('delegation tool not allowed');
    }

    return {
        claims: payload,
        user,
        delegation: {
            jti: String(payload?.jti || ''),
            scope: normalizeStringList(payload?.scope),
            sourceAgentId,
            targetAgentId: String(expectedTargetAgentId || allowedTargets[0] || '').trim(),
            tool: String(expectedTool || '').trim(),
        },
    };
}

export default {
    mintUserDelegationGrant,
    verifyUserDelegationGrant,
};
