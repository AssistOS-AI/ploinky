import crypto from 'node:crypto';

const MAX_RELAY_TOKEN_TTL_SECONDS = 30;
const DEFAULT_CLOCK_SKEW_SECONDS = 30;

function base64urlDecode(segment) {
    const padding = '==='.slice((segment.length + 3) % 4);
    const base64 = `${segment}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64');
}

function decodeJws(token) {
    if (typeof token !== 'string' || !token) {
        throw new Error('relayTokenVerify: token must be a non-empty string');
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('relayTokenVerify: malformed token');
    }
    const header = JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
    const payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
    return {
        header,
        payload,
        signature: base64urlDecode(parts[2]),
        signingInput: `${parts[0]}.${parts[1]}`,
    };
}

function assertSignatureMatches({ header, signingInput, signature, secret }) {
    if (header?.alg !== 'HS256') {
        throw new Error(`relayTokenVerify: unsupported alg ${header?.alg}`);
    }
    const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
    if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
        throw new Error('relayTokenVerify: signature invalid');
    }
}

function assertTimeValid(payload, { clockSkewSeconds, now }) {
    const nowSeconds = Math.floor((now ?? Date.now()) / 1000);
    const issuedAt = Number(payload?.iat);
    const expiresAt = Number(payload?.exp);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
        throw new Error('relayTokenVerify: iat/exp missing or invalid');
    }
    if (expiresAt - issuedAt > MAX_RELAY_TOKEN_TTL_SECONDS) {
        throw new Error('relayTokenVerify: token lifetime exceeds relay maximum');
    }
    if (issuedAt > nowSeconds + clockSkewSeconds) {
        throw new Error('relayTokenVerify: token used before its issued-at time');
    }
    if (expiresAt + clockSkewSeconds < nowSeconds) {
        throw new Error('relayTokenVerify: token expired');
    }
}

function assertAudience(payload, expectedAudience) {
    const audience = payload?.aud;
    const matches = Array.isArray(audience)
        ? audience.includes(expectedAudience)
        : String(audience || '') === String(expectedAudience || '');
    if (!expectedAudience || !matches) {
        throw new Error('relayTokenVerify: audience mismatch');
    }
}

function assertReplayProtected(payload, replayCache, { clockSkewSeconds, now } = {}) {
    const tokenId = String(payload?.jti || '').trim();
    if (!tokenId) {
        throw new Error('relayTokenVerify: jti missing');
    }
    if (!replayCache) return;
    if (replayCache.seen(tokenId)) {
        throw new Error('relayTokenVerify: jti has already been consumed');
    }
    // Keep the JTI for the entire interval in which time validation can still
    // accept the token, including the configured clock-skew allowance.
    const nowMs = Number(now ?? Date.now());
    const ttlMs = Math.max(
        1,
        (Number(payload.exp) * 1000) + (clockSkewSeconds * 1000) - nowMs,
    ) + 1000;
    replayCache.remember(tokenId, ttlMs);
}

export function verifyRelayJws(token, {
    secret,
    expectedAudience,
    replayCache,
    clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS,
    now,
} = {}) {
    if (!Buffer.isBuffer(secret) || secret.length < 32) {
        throw new Error('relayTokenVerify: 32-byte secret required');
    }
    const decoded = decodeJws(token);
    assertSignatureMatches({ ...decoded, secret });
    assertTimeValid(decoded.payload, { clockSkewSeconds, now });
    assertAudience(decoded.payload, expectedAudience);
    assertReplayProtected(decoded.payload, replayCache, { clockSkewSeconds, now });
    return { header: decoded.header, payload: decoded.payload };
}

export function createRelayReplayCache({ maxSize = 2048, now = () => Date.now() } = {}) {
    const capacity = Number.isSafeInteger(Number(maxSize)) && Number(maxSize) > 0
        ? Number(maxSize)
        : 2048;
    const entries = new Map();
    function prune() {
        const currentTime = Number(now());
        for (const [tokenId, expiresAt] of entries) {
            if (expiresAt <= currentTime) entries.delete(tokenId);
        }
    }
    return {
        seen(tokenId) {
            prune();
            return entries.has(tokenId);
        },
        remember(tokenId, ttlMs) {
            prune();
            if (!entries.has(tokenId) && entries.size >= capacity) {
                throw new Error('relayTokenVerify: replay cache capacity exhausted');
            }
            entries.set(tokenId, Number(now()) + Math.max(1, Number(ttlMs) || 1));
        },
        reset() {
            entries.clear();
        },
    };
}

export default {
    createRelayReplayCache,
    verifyRelayJws,
};
