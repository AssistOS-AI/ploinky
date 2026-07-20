import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import {
    verifyRelayRequestToken,
    verifyRelaySessionToken,
} from '../../Agent/lib/relayRequestAuth.mjs';
import { RelayRequestMinter } from '../../cli/server/runtimeRelay/relayRequestMinter.js';
import { AGENT_SECRET, CONTAINER_ID } from './routingProxyTestFixtures.mjs';

let nonce = 0;
const minter = new RelayRequestMinter({
    resolveAgentSecret: async () => AGENT_SECRET,
    createNonce: () => `nonce-${++nonce}`,
});

const identity = {
    targetAgentId: 'alpha-agent-id',
    effectiveInstanceId: 'alpha-instance-1',
    containerId: CONTAINER_ID,
    generationDigest: 'generation-one',
};

test('relay session token binds immutable owner, generation, session, and deny set', async () => {
    const minted = await minter.mintSession({ ...identity, relaySessionId: 'session-one', deniedPorts: [8081, 22, 22] });
    const expected = {
        secret: AGENT_SECRET,
        expectedAudience: identity.targetAgentId,
        ...identity,
        relaySessionId: 'session-one',
        deniedPorts: [22, 8081],
        replayCache: createMemoryReplayCache(),
    };
    const verified = verifyRelaySessionToken(minted.token, expected);
    assert.deepEqual(verified.deniedPorts, [22, 8081]);
    for (const [key, value] of [
        ['effectiveInstanceId', 'other-instance'],
        ['containerId', 'b'.repeat(64)],
        ['generationDigest', 'other-generation'],
        ['relaySessionId', 'other-session'],
    ]) {
        assert.throws(() => verifyRelaySessionToken(minted.token, {
            ...expected,
            [key]: value,
            replayCache: createMemoryReplayCache(),
        }), /mismatch/);
    }
    assert.throws(() => verifyRelaySessionToken(minted.token, {
        ...expected,
        deniedPorts: [22],
        replayCache: createMemoryReplayCache(),
    }), /deny set mismatch/);
});

test('relay request token binds every target and HTTP body selector', async () => {
    const session = await minter.mintSession({ ...identity, relaySessionId: 'session-two', deniedPorts: [22] });
    const requestInput = {
        ...identity,
        relaySessionId: 'session-two',
        denySetDigest: session.payload.denySetDigest,
        method: 'POST',
        port: 7000,
        path: '/api/items',
        query: 'page=1',
        bodyMode: 'buffered-v1',
        bodyHash: 'body-digest',
    };
    const minted = await minter.mintRequest(requestInput);
    const expected = {
        secret: AGENT_SECRET,
        expectedAudience: identity.targetAgentId,
        ...requestInput,
    };
    verifyRelayRequestToken(minted.token, { ...expected, replayCache: createMemoryReplayCache() });
    const mismatches = {
        effectiveInstanceId: 'other-instance',
        containerId: 'b'.repeat(64),
        generationDigest: 'other-generation',
        relaySessionId: 'other-session',
        denySetDigest: 'other-deny-set',
        method: 'GET',
        port: '7001',
        path: '/other',
        query: 'page=2',
        bodyMode: 'stream-v1',
        bodyHash: 'other-body',
    };
    for (const [key, value] of Object.entries(mismatches)) {
        assert.throws(() => verifyRelayRequestToken(minted.token, {
            ...expected,
            [key]: value,
            replayCache: createMemoryReplayCache(),
        }), /mismatch/);
    }
});

test('relay tokens expire and are replay protected', async () => {
    const minted = await minter.mintSession({ ...identity, relaySessionId: 'session-replay', deniedPorts: [] });
    const replayCache = createMemoryReplayCache();
    const expected = {
        secret: AGENT_SECRET,
        expectedAudience: identity.targetAgentId,
        ...identity,
        relaySessionId: 'session-replay',
        deniedPorts: [],
        replayCache,
    };
    verifyRelaySessionToken(minted.token, expected);
    assert.throws(() => verifyRelaySessionToken(minted.token, expected), /consumed|replay/i);

    const oldMinter = new RelayRequestMinter({
        resolveAgentSecret: async () => AGENT_SECRET,
        now: () => new Date('2000-01-01T00:00:00Z'),
        createNonce: () => `old-${++nonce}`,
    });
    const expired = await oldMinter.mintSession({ ...identity, relaySessionId: 'expired', deniedPorts: [] });
    assert.throws(() => verifyRelaySessionToken(expired.token, {
        ...expected,
        relaySessionId: 'expired',
        replayCache: createMemoryReplayCache(),
    }), /expired/i);
});
