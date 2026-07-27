import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createRelayReplayCache } from '../../Agent/lib/relayTokenVerify.mjs';
import {
    verifyRelayRequestToken,
    verifyRelaySessionToken,
} from '../../Agent/lib/relayRequestAuth.mjs';
import { RelayRequestMinter } from '../../cli/server/runtimeRelay/relayRequestMinter.js';

const AGENT_SECRET = crypto.randomBytes(32);
const CONTAINER_ID = 'a'.repeat(64);
let nonce = 0;
const minter = new RelayRequestMinter({
    resolveAgentSecret: async () => AGENT_SECRET,
    createNonce: () => `nonce-${++nonce}`,
});

const identity = {
    targetAgentId: 'agent:fixtures/alpha',
    effectiveInstanceId: 'alpha-instance-1',
    enableGeneration: 'alpha-enable-generation-1',
    containerId: CONTAINER_ID,
    generationDigest: 'generation-one',
};

test('runtime relay starts with only the tracked Agent library available', () => {
    const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('../../Agent/server/RuntimeHttpRelay.mjs', import.meta.url)),
    ], {
        env: {
            ...process.env,
            NODE_PATH: '',
            PLOINKY_AGENT_ID: identity.targetAgentId,
            PLOINKY_AGENT_SECRET: AGENT_SECRET.toString('hex'),
        },
        input: '',
        encoding: 'utf8',
        timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
});

test('relay session token binds owner, runtime identity, generation, session, and deny set', async () => {
    const minted = await minter.mintSession({
        ...identity,
        relaySessionId: 'session-one',
        deniedPorts: [8081, 22, 22],
    });
    const expected = {
        secret: AGENT_SECRET,
        expectedAudience: identity.targetAgentId,
        ...identity,
        relaySessionId: 'session-one',
        deniedPorts: [22, 8081],
        replayCache: createRelayReplayCache(),
    };
    const verified = verifyRelaySessionToken(minted.token, expected);
    assert.deepEqual(verified.deniedPorts, [22, 8081]);
    for (const [key, value] of [
        ['effectiveInstanceId', 'other-instance'],
        ['enableGeneration', 'other-enable-generation'],
        ['containerId', 'b'.repeat(64)],
        ['generationDigest', 'other-generation'],
        ['relaySessionId', 'other-session'],
    ]) {
        assert.throws(() => verifyRelaySessionToken(minted.token, {
            ...expected,
            [key]: value,
            replayCache: createRelayReplayCache(),
        }), /mismatch/);
    }
    assert.throws(() => verifyRelaySessionToken(minted.token, {
        ...expected,
        deniedPorts: [22],
        replayCache: createRelayReplayCache(),
    }), /deny set mismatch/);
});

test('relay request token binds every HTTP target and body selector without a protocol version', async () => {
    const session = await minter.mintSession({
        ...identity,
        relaySessionId: 'session-two',
        deniedPorts: [22],
    });
    const requestInput = {
        ...identity,
        relaySessionId: 'session-two',
        denySetDigest: session.payload.denySetDigest,
        method: 'POST',
        port: 7000,
        path: '/api/items',
        query: 'page=1',
        bodyMode: 'buffered',
        bodyHash: 'body-digest',
    };
    const minted = await minter.mintRequest(requestInput);
    const expected = {
        secret: AGENT_SECRET,
        expectedAudience: identity.targetAgentId,
        ...requestInput,
    };
    assert.equal(Object.hasOwn(minted.payload, 'schemaVersion'), false);
    verifyRelayRequestToken(minted.token, {
        ...expected,
        replayCache: createRelayReplayCache(),
    });
    const mismatches = {
        effectiveInstanceId: 'other-instance',
        enableGeneration: 'other-enable-generation',
        containerId: 'b'.repeat(64),
        generationDigest: 'other-generation',
        relaySessionId: 'other-session',
        denySetDigest: 'other-deny-set',
        method: 'GET',
        port: '7001',
        path: '/other',
        query: 'page=2',
        bodyMode: 'stream',
        bodyHash: 'other-body',
    };
    for (const [key, value] of Object.entries(mismatches)) {
        assert.throws(() => verifyRelayRequestToken(minted.token, {
            ...expected,
            [key]: value,
            replayCache: createRelayReplayCache(),
        }), /mismatch/);
    }
});

test('relay tokens expire and reject replay', async () => {
    const minted = await minter.mintSession({
        ...identity,
        relaySessionId: 'session-replay',
        deniedPorts: [],
    });
    const replayCache = createRelayReplayCache();
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
    const expired = await oldMinter.mintSession({
        ...identity,
        relaySessionId: 'expired',
        deniedPorts: [],
    });
    assert.throws(() => verifyRelaySessionToken(expired.token, {
        ...expected,
        relaySessionId: 'expired',
        replayCache: createRelayReplayCache(),
    }), /expired/i);
});
