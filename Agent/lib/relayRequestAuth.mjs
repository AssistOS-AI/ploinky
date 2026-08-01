import {
    computeRelayDenySetDigest,
    computeRchRelayRequest,
    computeRchRelaySession,
    normalizeCanonicalPortSet,
} from './requestHash.mjs';
import { verifyRelayJws } from './relayTokenVerify.mjs';

function requireEqual(actual, expected, label) {
    if (expected !== undefined && String(actual ?? '') !== String(expected ?? '')) {
        throw new Error(`relayRequestAuth: ${label} mismatch`);
    }
}

function verifyBase(token, {
    secret,
    expectedAudience,
    replayCache,
    clockSkewSeconds,
    now,
} = {}) {
    return verifyRelayJws(token, {
        secret,
        expectedAudience,
        replayCache,
        clockSkewSeconds,
        now,
    });
}

export function verifyRelaySessionToken(token, expected = {}) {
    const result = verifyBase(token, expected);
    const payload = result.payload || {};
    if (payload.typ !== 'relay-session') throw new Error('relayRequestAuth: invalid relay-session token type');
    if (payload.iss !== 'ploinky-router') throw new Error('relayRequestAuth: invalid relay-session issuer');
    requireEqual(payload.sub, expected.expectedAudience, 'subject');
    requireEqual(payload.effectiveInstanceId, expected.effectiveInstanceId, 'effective instance');
    requireEqual(payload.enableGeneration, expected.enableGeneration, 'enable generation');
    requireEqual(payload.containerId, expected.containerId, 'container identity');
    requireEqual(payload.generationDigest, expected.generationDigest, 'generation');
    requireEqual(payload.relaySessionId, expected.relaySessionId, 'relay session');
    const deniedPorts = normalizeCanonicalPortSet(payload.deniedPorts || []);
    const denySetDigest = computeRelayDenySetDigest(deniedPorts);
    requireEqual(payload.denySetDigest, denySetDigest, 'deny set digest');
    if (expected.deniedPorts !== undefined) {
        requireEqual(JSON.stringify(deniedPorts), JSON.stringify(normalizeCanonicalPortSet(expected.deniedPorts)), 'deny set');
    }
    const rch = computeRchRelaySession({
        ...payload,
        targetAgentId: payload.aud,
        deniedPorts,
        denySetDigest,
    });
    requireEqual(payload.rch, rch, 'request hash');
    return { ...result, deniedPorts, denySetDigest };
}

export function verifyRelayRequestToken(token, expected = {}) {
    const result = verifyBase(token, expected);
    const payload = result.payload || {};
    if (payload.typ !== 'relay-request') throw new Error('relayRequestAuth: invalid relay-request token type');
    if (payload.iss !== 'ploinky-router') throw new Error('relayRequestAuth: invalid relay-request issuer');
    requireEqual(payload.sub, expected.expectedAudience, 'subject');
    for (const field of [
        'effectiveInstanceId',
        'enableGeneration',
        'containerId',
        'generationDigest',
        'relaySessionId',
        'denySetDigest',
        'method',
        'port',
        'path',
        'query',
        'bodyMode',
        'bodyHash',
    ]) {
        requireEqual(payload[field], expected[field], field);
    }
    const rch = computeRchRelayRequest({ ...payload, targetAgentId: payload.aud });
    requireEqual(payload.rch, rch, 'request hash');
    return result;
}

export default {
    verifyRelaySessionToken,
    verifyRelayRequestToken,
};
