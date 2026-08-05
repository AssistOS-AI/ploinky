import assert from 'node:assert/strict';
import test from 'node:test';

import { signPrivateRouterAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { derivePrivateAgentRequestSecret } from '../../cli/utils/security/masterKey.js';
import {
    authorizePrivateRoutePlan,
    createTurnCredentialRateLimiter,
    mintTurnCredentials,
} from '../../cli/server/privateRouter.js';

const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_MASTER_KEY = '4'.repeat(64);
test.after(() => {
    if (previousMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousMasterKey;
});

const caller = Object.freeze({
    agentId: 'agent:fixtures/beta',
    instanceId: 'beta-instance',
    enableGeneration: 'beta-generation',
    routeKey: 'beta',
    containerName: 'beta-container',
});

function snapshot() {
    return {
        agents: {
            'beta-container': {
                type: 'agent',
                repoName: 'fixtures',
                agentName: 'beta',
                instanceId: caller.instanceId,
                enableGeneration: caller.enableGeneration,
            },
        },
        desired: {
            turn: {
                urls: [
                    'turn:turn.example.test:3478?transport=udp',
                    'turns:turn.example.test:5349?transport=tcp',
                ],
                sharedSecret: 'turn/test-secret',
            },
        },
        compiled: {
            security: {
                turnCredentialConsumers: [caller],
            },
        },
    };
}

function privateRoutePlan() {
    return {
        ok: true,
        listener: 'private',
        kind: 'agent-port',
        routeKey: 'alpha',
        pathname: '/base-agent-additional-server/alpha/7000/private/items',
        parsedUrl: new URL('http://host.containers.internal/base-agent-additional-server/alpha/7000/private/items?view=full'),
        access: { access: 'authenticated' },
        snapshot: snapshot(),
    };
}

function assertionEnv() {
    return {
        PLOINKY_AGENT_ID: caller.agentId,
        PLOINKY_AGENT_INSTANCE_ID: caller.instanceId,
        PLOINKY_AGENT_ENABLE_GENERATION: caller.enableGeneration,
        PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(
            caller.agentId,
            caller.instanceId,
            caller.enableGeneration,
        ),
    };
}

function signedRequest(plan, body, overrides = {}) {
    const method = overrides.method || 'POST';
    const token = signPrivateRouterAssertion({
        method,
        path: plan.pathname,
        query: plan.parsedUrl.search,
        body,
        env: { ...assertionEnv(), ...(overrides.env || {}) },
    });
    return {
        method,
        headers: { 'ploinky-agent-assertion': token },
    };
}

test('private convention admission derives authority from effective HTTP policy and exact current request binding', () => {
    const plan = privateRoutePlan();
    const body = Buffer.from('{"value":1}');
    const req = signedRequest(plan, body);
    const identity = authorizePrivateRoutePlan({
        req,
        plan,
        body,
        assertionCache: createMemoryReplayCache(),
    });
    assert.deepEqual(identity, {
        agentId: caller.agentId,
        instanceId: caller.instanceId,
        enableGeneration: caller.enableGeneration,
        routeKey: caller.routeKey,
    });
    assert.equal(req.headers['ploinky-agent-assertion'], undefined);

    const publicPolicy = privateRoutePlan();
    publicPolicy.access = { access: 'guest' };
    assert.throws(() => authorizePrivateRoutePlan({
        req: signedRequest(publicPolicy, body),
        plan: publicPolicy,
        body,
        assertionCache: createMemoryReplayCache(),
    }), (error) => error.code === 'PRIVATE_POLICY_DENIED');
});

test('private assertions reject body tampering, replay, stale generations, and unlisted methods', () => {
    const plan = privateRoutePlan();
    const signedBody = Buffer.from('signed');
    assert.throws(() => authorizePrivateRoutePlan({
        req: signedRequest(plan, signedBody),
        plan,
        body: Buffer.from('tampered'),
        assertionCache: createMemoryReplayCache(),
    }), (error) => error.code === 'PRIVATE_ASSERTION_REJECTED');

    const cache = createMemoryReplayCache();
    const replayRequest = signedRequest(plan, signedBody);
    const replayToken = replayRequest.headers['ploinky-agent-assertion'];
    authorizePrivateRoutePlan({ req: replayRequest, plan, body: signedBody, assertionCache: cache });
    assert.throws(() => authorizePrivateRoutePlan({
        req: { method: 'POST', headers: { 'ploinky-agent-assertion': replayToken } },
        plan,
        body: signedBody,
        assertionCache: cache,
    }), /already been consumed/i);

    const stale = privateRoutePlan();
    stale.snapshot.agents['beta-container'].enableGeneration = 'replacement-generation';
    assert.throws(() => authorizePrivateRoutePlan({
        req: signedRequest(plan, signedBody),
        plan: stale,
        body: signedBody,
        assertionCache: createMemoryReplayCache(),
    }), (error) => error.code === 'PRIVATE_ASSERTION_REJECTED');

    assert.throws(() => authorizePrivateRoutePlan({
        req: signedRequest(plan, Buffer.alloc(0), { method: 'TRACE' }),
        plan,
        body: Buffer.alloc(0),
        assertionCache: createMemoryReplayCache(),
    }), (error) => error.code === 'PRIVATE_CALLER_DENIED');
});

test('TURN broker uses compiled exact callers and only external configured lanes', () => {
    const plan = {
        ok: true,
        listener: 'private',
        kind: 'private-operation',
        operation: 'turn-credentials',
        pathname: '/api/edge/turn-credentials',
        parsedUrl: new URL('http://host.containers.internal/api/edge/turn-credentials'),
        snapshot: snapshot(),
    };
    const body = Buffer.from(JSON.stringify({ roomName: 'room-1', participantIdentity: 'user-1' }));
    authorizePrivateRoutePlan({
        req: signedRequest(plan, body),
        plan,
        body,
        assertionCache: createMemoryReplayCache(),
    });
    const credentials = mintTurnCredentials({
        plan,
        body,
        callerIdentity: caller,
        env: {
            PLOINKY_TURN_CREDENTIAL_TTL_SECONDS: '300',
        },
        secretStore: { readAll: () => ({ 'turn/test-secret': 'fixture-turn-secret' }) },
        nowMs: Date.parse('2026-07-15T12:00:00Z'),
    });
    assert.deepEqual(credentials.urls, snapshot().desired.turn.urls);
    assert.match(credentials.username, /^\d+:user-1$/);
    assert.equal(credentials.password.length > 20, true);
    assert.equal(credentials.expiresAt, '2026-07-15T12:05:00.000Z');
});

test('TURN broker rate-limits each exact instance generation without unbounded caller state', () => {
    const plan = {
        snapshot: snapshot(),
    };
    const body = Buffer.from(JSON.stringify({ roomName: 'room-1', participantIdentity: 'user-1' }));
    const limiter = createTurnCredentialRateLimiter({ maximumRequests: 2, windowMs: 1_000, maximumCallers: 2 });
    const options = {
        plan,
        body,
        callerIdentity: caller,
        env: { PLOINKY_TURN_SHARED_SECRET: 'must-not-be-authority' },
        secretStore: { readAll: () => ({ 'turn/test-secret': 'fixture-turn-secret' }) },
        nowMs: 100,
        rateLimiter: limiter,
    };
    mintTurnCredentials(options);
    mintTurnCredentials(options);
    assert.throws(() => mintTurnCredentials(options), (error) => (
        error.code === 'TURN_CREDENTIAL_RATE_LIMITED' && error.status === 429
    ));
    mintTurnCredentials({ ...options, nowMs: 1_101 });
    assert.equal(limiter.size(), 1);
});

test('TURN broker resolves only the captured encrypted-store handle', () => {
    const plan = { snapshot: snapshot() };
    const body = Buffer.from(JSON.stringify({ roomName: 'room-1', participantIdentity: 'user-1' }));
    assert.throws(() => mintTurnCredentials({
        plan,
        body,
        callerIdentity: caller,
        env: { PLOINKY_TURN_SHARED_SECRET: 'environment-is-not-authority' },
        secretStore: { readAll: () => ({ 'turn/other-secret': 'wrong-secret' }) },
        rateLimiter: createTurnCredentialRateLimiter(),
    }), (error) => error.code === 'TURN_BROKER_UNAVAILABLE' && error.status === 503);

    assert.throws(() => mintTurnCredentials({
        plan,
        body,
        callerIdentity: caller,
        secretStore: { readAll: () => { throw new Error('decrypt failed'); } },
        rateLimiter: createTurnCredentialRateLimiter(),
    }), (error) => error.code === 'TURN_SECRET_STORE_UNAVAILABLE' && error.status === 503);
});
