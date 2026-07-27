import crypto from 'node:crypto';

import { signHmacJwt } from '../../../Agent/lib/jwtSign.mjs';
import {
    computeRelayDenySetDigest,
    computeRchRelayRequest,
    computeRchRelaySession,
    normalizeCanonicalPortSet,
} from '../../../Agent/lib/requestHash.mjs';

export const RELAY_TOKEN_TTL_SECONDS = 30;

function nowSeconds(now) {
    return Math.floor(now().getTime() / 1000);
}

function randomId() {
    return crypto.randomBytes(18).toString('base64url');
}

function requireText(value, label) {
    const normalized = String(value || '').trim();
    if (!normalized) throw new Error(`relayRequestMinter: ${label} required`);
    return normalized;
}

function normalizeSecret(value) {
    if (Buffer.isBuffer(value) && value.length >= 32) return value;
    const hex = String(value || '').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
    throw new Error('relayRequestMinter: 32-byte agent secret required');
}

export class RelayRequestMinter {
    constructor({
        resolveAgentSecret,
        now = () => new Date(),
        createNonce = randomId,
        ttlSeconds = RELAY_TOKEN_TTL_SECONDS,
    } = {}) {
        if (typeof resolveAgentSecret !== 'function') {
            throw new Error('relayRequestMinter: resolveAgentSecret required');
        }
        this.resolveAgentSecret = resolveAgentSecret;
        this.now = now;
        this.createNonce = createNonce;
        this.ttlSeconds = Math.max(5, Math.min(Number(ttlSeconds) || RELAY_TOKEN_TTL_SECONDS, RELAY_TOKEN_TTL_SECONDS));
    }

    async _sign(targetAgentId, payload) {
        return signHmacJwt({
            payload,
            secret: normalizeSecret(await this.resolveAgentSecret(targetAgentId)),
        });
    }

    async mintSession(input = {}) {
        const targetAgentId = requireText(input.targetAgentId, 'targetAgentId');
        const effectiveInstanceId = requireText(input.effectiveInstanceId, 'effectiveInstanceId');
        const enableGeneration = requireText(input.enableGeneration, 'enableGeneration');
        const containerId = requireText(input.containerId, 'containerId');
        const generationDigest = requireText(input.generationDigest, 'generationDigest');
        const relaySessionId = requireText(input.relaySessionId || this.createNonce(), 'relaySessionId');
        const deniedPorts = normalizeCanonicalPortSet(input.deniedPorts || []);
        const denySetDigest = computeRelayDenySetDigest(deniedPorts);
        const rch = computeRchRelaySession({
            targetAgentId,
            effectiveInstanceId,
            enableGeneration,
            containerId,
            generationDigest,
            relaySessionId,
            deniedPorts,
            denySetDigest,
        });
        const iat = nowSeconds(this.now);
        const payload = {
            typ: 'relay-session',
            iss: 'ploinky-router',
            aud: targetAgentId,
            sub: targetAgentId,
            effectiveInstanceId,
            enableGeneration,
            containerId,
            generationDigest,
            relaySessionId,
            deniedPorts,
            denySetDigest,
            rch,
            iat,
            exp: iat + this.ttlSeconds,
            jti: this.createNonce(),
        };
        return { token: await this._sign(targetAgentId, payload), payload };
    }

    async mintRequest(input = {}) {
        const targetAgentId = requireText(input.targetAgentId, 'targetAgentId');
        const effectiveInstanceId = requireText(input.effectiveInstanceId, 'effectiveInstanceId');
        const enableGeneration = requireText(input.enableGeneration, 'enableGeneration');
        const containerId = requireText(input.containerId, 'containerId');
        const generationDigest = requireText(input.generationDigest, 'generationDigest');
        const relaySessionId = requireText(input.relaySessionId, 'relaySessionId');
        const denySetDigest = requireText(input.denySetDigest, 'denySetDigest');
        const method = requireText(input.method, 'method').toUpperCase();
        const path = requireText(input.path, 'path');
        const bodyMode = requireText(input.bodyMode, 'bodyMode');
        if (!['buffered', 'stream', 'none'].includes(bodyMode)) {
            throw new Error(`relayRequestMinter: invalid bodyMode '${bodyMode}'`);
        }
        const rch = computeRchRelayRequest({
            targetAgentId,
            effectiveInstanceId,
            enableGeneration,
            containerId,
            generationDigest,
            relaySessionId,
            denySetDigest,
            method,
            port: input.port,
            path,
            query: input.query || '',
            bodyMode,
            bodyHash: input.bodyHash || '',
        });
        const iat = nowSeconds(this.now);
        const payload = {
            typ: 'relay-request',
            iss: 'ploinky-router',
            aud: targetAgentId,
            sub: targetAgentId,
            effectiveInstanceId,
            enableGeneration,
            containerId,
            generationDigest,
            relaySessionId,
            denySetDigest,
            method,
            port: String(input.port),
            path,
            query: String(input.query || ''),
            bodyMode,
            bodyHash: String(input.bodyHash || ''),
            rch,
            iat,
            exp: iat + this.ttlSeconds,
            jti: this.createNonce(),
        };
        return { token: await this._sign(targetAgentId, payload), payload };
    }
}

export function createRelayRequestMinter(options) {
    return new RelayRequestMinter(options);
}

export default RelayRequestMinter;
