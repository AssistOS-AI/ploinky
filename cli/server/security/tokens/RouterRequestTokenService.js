import crypto from 'node:crypto';

import { JwsCodec } from './JwsCodec.js';

export const ROUTER_REQUEST_TTL_SECONDS = 30;

function isPromiseLike(value) {
    return value && typeof value.then === 'function';
}

export function normalizeActor(actor) {
    if (!actor || typeof actor !== 'object') {
        return { kind: 'user', id: '', roles: [] };
    }
    const kind = actor.kind === 'agent' || actor.kind === 'guest' ? actor.kind : 'user';
    return {
        kind,
        id: String(actor.id || ''),
        roles: Array.isArray(actor.roles) ? actor.roles.map((r) => String(r || '')).filter(Boolean) : [],
    };
}

export function normalizeCaller(caller) {
    if (!caller || typeof caller !== 'object') return undefined;
    const id = String(caller.id || '').trim();
    if (!id) return undefined;
    return {
        kind: caller.kind === 'user' || caller.kind === 'guest' ? caller.kind : 'agent',
        id,
        roles: Array.isArray(caller.roles) ? caller.roles.map((r) => String(r || '')).filter(Boolean) : [],
    };
}

export function normalizeUserClaims(usr) {
    if (!usr || typeof usr !== 'object') return undefined;
    const id = String(usr.id || usr.sub || '').trim();
    if (!id) return undefined;
    return {
        id,
        username: String(usr.username || usr.preferred_username || '').trim(),
        email: String(usr.email || '').trim(),
        roles: Array.isArray(usr.roles) ? usr.roles.map((role) => String(role || '')).filter(Boolean) : [],
    };
}

export function normalizeScope(scope) {
    if (!Array.isArray(scope)) return undefined;
    const normalized = [...new Set(scope.map((entry) => String(entry || '').trim()).filter(Boolean))];
    return normalized.length ? normalized : undefined;
}

export function normalizeDelegation(delegation) {
    if (!delegation || typeof delegation !== 'object') return undefined;
    const jti = String(delegation.jti || '').trim();
    const sourceAgentId = String(delegation.sourceAgentId || '').trim();
    if (jti) {
        return {
            jti,
            scope: Array.isArray(delegation.scope) ? delegation.scope.map((scope) => String(scope || '')).filter(Boolean) : [],
            sourceAgentId,
        };
    }
    const tool = String(delegation.tool || '').trim();
    if (!sourceAgentId && !tool) return undefined;
    return {
        sourceAgentId,
        tool,
    };
}

export function normalizeDelegations(delegations) {
    if (!delegations || typeof delegations !== 'object' || Array.isArray(delegations)) return undefined;
    const out = {};
    for (const [key, entry] of Object.entries(delegations)) {
        const normalizedKey = String(key || '').trim();
        if (!/^[A-Za-z0-9_.-]+$/.test(normalizedKey)) continue;
        const token = String(entry?.token || '').trim();
        const targetAgentId = String(entry?.targetAgentId || '').trim();
        if (!token || !targetAgentId) continue;
        out[normalizedKey] = {
            token,
            expiresAt: String(entry?.expiresAt || '').trim(),
            targetAgentId,
            tools: Array.isArray(entry?.tools) ? entry.tools.map((value) => String(value || '').trim()).filter(Boolean) : [],
            scope: Array.isArray(entry?.scope) ? entry.scope.map((value) => String(value || '').trim()).filter(Boolean) : [],
        };
    }
    return Object.keys(out).length ? out : undefined;
}

export class RouterRequestTokenService {
    constructor({
        jwsCodec = new JwsCodec(),
        resolveAgentSecret,
        now = () => new Date(),
        randomId = () => crypto.randomBytes(16).toString('base64url'),
    } = {}) {
        this.jwsCodec = jwsCodec;
        this.resolveAgentSecret = resolveAgentSecret;
        this.now = now;
        this.randomId = randomId;
    }

    _payload({
        targetAgentId,
        sub,
        actor,
        caller,
        usr,
        scope,
        method,
        path,
        tool,
        rch,
        delegation,
        delegations,
        ttlSeconds,
    }) {
        const target = String(targetAgentId || '').trim();
        if (!target) throw new Error('invocationMinter: targetAgentId required');
        if (!method) throw new Error('invocationMinter: method required');
        if (!path) throw new Error('invocationMinter: path required');
        if (!rch) throw new Error('invocationMinter: rch required');
        const iat = Math.floor(this.now().getTime() / 1000);
        const ttl = Math.max(5, Math.min(Number(ttlSeconds) || ROUTER_REQUEST_TTL_SECONDS, ROUTER_REQUEST_TTL_SECONDS));
        const payload = {
            typ: 'router-request',
            iss: 'ploinky-router',
            aud: target,
            sub: String(sub || ''),
            actor: normalizeActor(actor),
            method: String(method),
            path: String(path),
            rch: String(rch),
            jti: this.randomId(),
            iat,
            exp: iat + ttl,
        };
        if (tool !== undefined && tool !== null && String(tool) !== '') {
            payload.tool = String(tool);
        }
        const normalizedCaller = normalizeCaller(caller);
        if (normalizedCaller) payload.caller = normalizedCaller;
        const normalizedUser = normalizeUserClaims(usr);
        if (normalizedUser) payload.usr = normalizedUser;
        const normalizedRequestScope = normalizeScope(scope);
        if (normalizedRequestScope) payload.scope = normalizedRequestScope;
        const normalizedDelegation = normalizeDelegation(delegation);
        if (normalizedDelegation) payload.delegation = normalizedDelegation;
        const normalizedDelegations = normalizeDelegations(delegations);
        if (normalizedDelegations) payload.delegations = normalizedDelegations;
        return { target, payload };
    }

    async mint(input) {
        const { target, payload } = this._payload(input);
        return this.jwsCodec.signHmacJwt({
            payload,
            secret: await this.resolveAgentSecret(target),
        });
    }

    async mintWithPayload(input) {
        const { target, payload } = this._payload(input);
        const token = await this.jwsCodec.signHmacJwt({
            payload,
            secret: await this.resolveAgentSecret(target),
        });
        return { token, payload };
    }

    mintWithPayloadSync(input) {
        const { target, payload } = this._payload(input);
        const secret = this.resolveAgentSecret(target);
        if (isPromiseLike(secret)) {
            throw new Error('RouterRequestTokenService: async secret resolver cannot be used through sync adapter');
        }
        const token = this.jwsCodec.signHmacJwt({ payload, secret });
        if (isPromiseLike(token)) {
            throw new Error('RouterRequestTokenService: async signer cannot be used through sync adapter');
        }
        return { token, payload };
    }
}
