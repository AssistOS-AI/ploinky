import crypto from 'node:crypto';

import { JwsCodec } from './JwsCodec.js';

const DEFAULT_MAX_TTL_SECONDS = 8 * 60 * 60;

function isPromiseLike(value) {
    return value && typeof value.then === 'function';
}

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

function normalizeSecret(signingSecret) {
    const secret = Buffer.isBuffer(signingSecret) ? signingSecret : Buffer.from(signingSecret || '');
    if (!secret.length) {
        throw new Error('userDelegationGrant: signingSecret required');
    }
    return secret;
}

function isGuestActor(actor) {
    return String(actor?.kind || '').trim().toLowerCase() === 'guest';
}

function isGuestUser(user) {
    const roles = normalizeStringList(user?.roles).map((role) => role.toLowerCase());
    return roles.includes('guest') || String(user?.id || '').startsWith('guest:');
}

export class UserDelegationGrantService {
    constructor({
        jwsCodec = new JwsCodec(),
        resolveGrantSecret,
        now = () => new Date(),
        randomId = () => crypto.randomBytes(16).toString('base64url'),
    } = {}) {
        this.jwsCodec = jwsCodec;
        this.resolveGrantSecret = resolveGrantSecret;
        this.now = now;
        this.randomId = randomId;
    }

    _mintPayload({
        now = this.now(),
        ttlSeconds,
        sourceAgentId,
        route,
        user,
        actor,
        targetAgentId,
        tools,
        scopes,
    }) {
        if (isGuestActor(actor) || isGuestUser(user)) {
            throw new Error('USER_DELEGATION_REQUIRES_AUTHENTICATED_USER');
        }
        const normalizedUser = normalizeUser(user);
        if (!normalizedUser) {
            throw new Error('delegation user missing');
        }
        const iat = toUnixSeconds(now);
        const maxTtl = resolveMaxTtlSeconds();
        const ttl = Math.max(30, Math.min(Number.parseInt(String(ttlSeconds || ''), 10) || DEFAULT_MAX_TTL_SECONDS, maxTtl));
        return {
            typ: 'user-delegation',
            iss: 'ploinky-router',
            aud: 'ploinky-router',
            sub: buildStableSubject(normalizedUser),
            jti: this.randomId(),
            iat,
            exp: iat + ttl,
            sourceAgentId: String(sourceAgentId || '').trim(),
            route: route && typeof route === 'object' ? {
                routeKey: String(route.routeKey || '').trim(),
                pathPrefix: String(route.pathPrefix || '').trim(),
                requestPath: String(route.requestPath || '').trim(),
            } : undefined,
            usr: normalizedUser,
            allowedTargets: normalizeStringList([targetAgentId]),
            allowedTools: normalizeStringList(tools),
            scope: normalizeStringList(scopes),
        };
    }

    async mint(input) {
        const payload = this._mintPayload(input);
        const token = await this.jwsCodec.signHmacJwt({
            payload,
            secret: normalizeSecret(await this.resolveGrantSecret(input)),
        });
        return { token, payload };
    }

    mintSync(input) {
        const payload = this._mintPayload(input);
        const signingSecret = this.resolveGrantSecret(input);
        if (isPromiseLike(signingSecret)) {
            throw new Error('UserDelegationGrantService: async secret resolver cannot be used through sync adapter');
        }
        const token = this.jwsCodec.signHmacJwt({ payload, secret: normalizeSecret(signingSecret) });
        if (isPromiseLike(token)) {
            throw new Error('UserDelegationGrantService: async signer cannot be used through sync adapter');
        }
        return { token, payload };
    }

    _verifyPayload({
        payload,
        now = this.now(),
        expectedSourceAgentId,
        expectedTargetAgentId,
        expectedTool,
    }) {
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

    async verify(input) {
        let payload;
        try {
            ({ payload } = await this.jwsCodec.verifyJws(input.token, {
                secret: normalizeSecret(await this.resolveGrantSecret(input)),
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
        return this._verifyPayload({ ...input, payload });
    }

    verifySync(input) {
        const signingSecret = this.resolveGrantSecret(input);
        if (isPromiseLike(signingSecret)) {
            throw new Error('UserDelegationGrantService: async secret resolver cannot be used through sync adapter');
        }
        let payload;
        try {
            const result = this.jwsCodec.verifyJws(input.token, {
                secret: normalizeSecret(signingSecret),
                expectedAudience: 'ploinky-router',
                maxTtlSeconds: resolveMaxTtlSeconds(),
            });
            if (isPromiseLike(result)) {
                throw new Error('UserDelegationGrantService: async verifier cannot be used through sync adapter');
            }
            ({ payload } = result);
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
        return this._verifyPayload({ ...input, payload });
    }
}
