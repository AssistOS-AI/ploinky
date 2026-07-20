import crypto from 'node:crypto';

import { signHmacJwt } from './jwtSign.mjs';
import { verifyJws } from './jwtVerify.mjs';
import { computeRchMachineCall } from './requestHash.mjs';

function nowSeconds(now) {
    return Math.floor(now().getTime() / 1000);
}

function normalizeSecret(value) {
    if (Buffer.isBuffer(value) && value.length >= 32) return value;
    const hex = String(value || '').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
    throw new Error('machineCallAssertion: 32-byte agent secret required');
}

export async function mintMachineCallAssertion(input = {}, {
    secret,
    now = () => new Date(),
    createNonce = () => crypto.randomBytes(18).toString('base64url'),
    ttlSeconds = 30,
} = {}) {
    const payload = {
        typ: 'machine-call',
        iss: String(input.callerAgentId || ''),
        sub: String(input.callerAgentId || ''),
        aud: 'ploinky-router',
        callerEnableGeneration: String(input.callerEnableGeneration || ''),
        targetAgentId: String(input.targetAgentId || ''),
        port: String(input.port || ''),
        method: String(input.method || '').toUpperCase(),
        path: String(input.path || ''),
        bodyHash: String(input.bodyHash || ''),
        generationDigest: String(input.generationDigest || ''),
    };
    for (const [key, value] of Object.entries(payload)) {
        if (!value) throw new Error(`machineCallAssertion: ${key} required`);
    }
    payload.rch = computeRchMachineCall({ callerAgentId: payload.iss, ...payload });
    payload.iat = nowSeconds(now);
    payload.exp = payload.iat + Math.min(30, Math.max(5, Number(ttlSeconds) || 30));
    payload.jti = createNonce();
    return signHmacJwt({ payload, secret: normalizeSecret(secret) });
}

export function verifyMachineCallAssertion(token, expected = {}) {
    const result = verifyJws(token, {
        secret: normalizeSecret(expected.secret),
        expectedAudience: 'ploinky-router',
        replayCache: expected.replayCache,
        clockSkewSeconds: expected.clockSkewSeconds,
        maxTtlSeconds: 30,
    });
    const payload = result.payload || {};
    if (payload.typ !== 'machine-call') throw new Error('machineCallAssertion: invalid token type');
    if (!payload.iss || payload.sub !== payload.iss) throw new Error('machineCallAssertion: invalid caller subject');
    const comparisons = {
        iss: expected.callerAgentId,
        callerEnableGeneration: expected.callerEnableGeneration,
        targetAgentId: expected.targetAgentId,
        port: expected.port,
        method: expected.method && String(expected.method).toUpperCase(),
        path: expected.path,
        bodyHash: expected.bodyHash,
        generationDigest: expected.generationDigest,
    };
    for (const [key, value] of Object.entries(comparisons)) {
        if (value !== undefined && String(payload[key] || '') !== String(value)) {
            throw new Error(`machineCallAssertion: ${key} mismatch`);
        }
    }
    const rch = computeRchMachineCall({ callerAgentId: payload.iss, ...payload });
    if (payload.rch !== rch) throw new Error('machineCallAssertion: request hash mismatch');
    return result;
}

export default { mintMachineCallAssertion, verifyMachineCallAssertion };
