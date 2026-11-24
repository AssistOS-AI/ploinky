import { randomUUID } from 'node:crypto';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { verifyJws } from '../../Agent/lib/jwtVerify.mjs';
import { createBoundedReplayCache, legacyMinRetentionMs } from '../../Agent/lib/replayCache.mjs';
import { computeRchHttp, sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import { deriveSubkey } from '../utils/security/masterKey.js';

export const CACHE_OPERATOR_PATH = '/api/edge/cache';
export const CACHE_OPERATOR_HEADER = 'ploinky-cache-operator-assertion';
const AUDIENCE = 'ploinky-private-cache';
const OPERATOR = 'local:admin';
const TTL = 30;
const replayCache = createBoundedReplayCache({
    maxSize: 4096,
    legacyMinRetentionMs: legacyMinRetentionMs({ maxTtlSeconds: TTL }),
});

function requestBinding(body, lease) {
    if (!/^sha256:[a-f0-9]{64}$/.test(lease?.id || '')
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(lease?.activationId || '')
        || lease.snapshot?.generation !== lease.id) {
        throw new Error('Cache command requires an active Router generation.');
    }
    return {
        generation: lease.id,
        activationId: lease.activationId,
        rch: computeRchHttp({ method: 'POST', path: CACHE_OPERATOR_PATH, query: '', bodyHash: sha256RawBodyHash(body) }),
    };
}

export function signCacheOperatorRequest(body, lease) {
    const iat = Math.floor(Date.now() / 1000);
    const binding = requestBinding(body, lease);
    return signHmacJwt({
        secret: deriveSubkey('private-cache-operator'),
        payload: { typ: 'cache-operator', iss: OPERATOR, sub: OPERATOR, aud: AUDIENCE, ...binding, iat, exp: iat + TTL, jti: randomUUID() },
    });
}

export function verifyCacheOperatorRequest(token, body, lease) {
    if (typeof token !== 'string' || !token || token.length > 4096) throw new Error('Missing cache operator assertion.');
    const binding = requestBinding(body, lease);
    const { payload } = verifyJws(token, {
        secret: deriveSubkey('private-cache-operator'), expectedAudience: AUDIENCE, maxTtlSeconds: TTL, replayCache,
    });
    if (payload.typ !== 'cache-operator' || payload.iss !== OPERATOR || payload.sub !== OPERATOR
        || payload.generation !== binding.generation || payload.activationId !== binding.activationId || payload.rch !== binding.rch) {
        throw new Error('Cache operator request binding mismatch.');
    }
    return OPERATOR;
}
