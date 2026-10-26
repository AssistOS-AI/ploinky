import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { signAgentHttpAssertion, signPrivateRouterAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { createMemoryReplayCache, verifyJws } from '../../Agent/lib/jwtVerify.mjs';
import { verifyRouterRequestFromHeaders } from '../../Agent/lib/invocationAuth.mjs';
import { computeRchHttp, sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import {
    MAX_JTI_LENGTH,
    REPLAY_CACHE_EXHAUSTED_CODE,
    REPLAY_CLOCK_INVALID_CODE,
    REPLAY_JTI_INVALID_CODE,
    REPLAY_PARTITION_INVALID_CODE,
    REPLAY_PARTITION_REQUIRED_CODE,
    REPLAY_QUOTA_EXHAUSTED_CODE,
    createBoundedReplayCache,
    createPartitionedReplayCache,
    legacyMinRetentionMs,
    replayRefusalStatus,
} from '../../Agent/lib/replayCache.mjs';
import { authorizePrivateRoutePlan, sendPrivateError } from '../../cli/server/privateRouter.js';
import { createTokenReplayCache } from '../../cli/server/security/tokens/JwsCodec.js';
import { deriveAgentRequestSecret, derivePrivateAgentRequestSecret } from '../../cli/utils/security/masterKey.js';

const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_MASTER_KEY = '8'.repeat(64);
test.after(() => {
    if (previousMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousMasterKey;
});

function manualClock(start = 0) {
    const clock = { value: start, now: () => clock.value };
    return clock;
}

const QUOTA_ERROR = { code: REPLAY_QUOTA_EXHAUSTED_CODE, status: 429, message: 'replayCache: replay quota exhausted' };
const CAPACITY_ERROR = { code: REPLAY_CACHE_EXHAUSTED_CODE, status: 503 };

// --- private Router fixture -------------------------------------------------

const ROUTE_PATH = '/base-agent-additional-server/target/7000/private/items';
const BODY = Buffer.from('{"value":1}');

function enabledAgent(name) {
    return { name, agentId: `agent:fixtures/${name}`, instanceId: `${name}-instance`, enableGeneration: `${name}-gen` };
}

const ALPHA = enabledAgent('alpha');
const BETA = enabledAgent('beta');

function privateRoutePlan() {
    const agents = {};
    for (const agent of [ALPHA, BETA]) {
        agents[`${agent.name}-container`] = {
            type: 'agent',
            repoName: 'fixtures',
            agentName: agent.name,
            instanceId: agent.instanceId,
            enableGeneration: agent.enableGeneration,
        };
    }
    return {
        ok: true,
        listener: 'private',
        kind: 'agent-port',
        routeKey: 'target',
        pathname: ROUTE_PATH,
        parsedUrl: new URL(`http://host.containers.internal${ROUTE_PATH}?view=full`),
        access: { access: 'authenticated' },
        snapshot: { agents, compiled: { security: {} } },
    };
}

function signPrivate(agent, plan, body = BODY) {
    return signPrivateRouterAssertion({
        method: 'POST',
        path: plan.pathname,
        query: plan.parsedUrl.search,
        body,
        env: {
            PLOINKY_AGENT_ID: agent.agentId,
            PLOINKY_AGENT_INSTANCE_ID: agent.instanceId,
            PLOINKY_AGENT_ENABLE_GENERATION: agent.enableGeneration,
            PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(
                agent.agentId,
                agent.instanceId,
                agent.enableGeneration,
            ),
        },
    });
}

function presentPrivate(token, plan, assertionCache, body = BODY) {
    return authorizePrivateRoutePlan({
        req: { method: 'POST', headers: { 'ploinky-agent-assertion': token } },
        plan,
        body,
        assertionCache,
    });
}

// --- bounded cache ---------------------------------------------------------

test('bounded cache consumes once, reports a replay, and refuses a new jti with 503 when full', () => {
    const clock = manualClock(1000);
    const cache = createBoundedReplayCache({ maxSize: 2, now: clock.now });
    assert.equal(cache.consume('a', 1000), true);
    assert.equal(cache.consume('a', 1000), false);
    assert.equal(cache.consume('b', 1000), true);
    assert.throws(() => cache.consume('c', 1000), { ...CAPACITY_ERROR, message: /replay cache capacity exhausted/ });
    assert.equal(cache.seen('c'), false);
    assert.equal(cache.consume('a', 1000), false);
    assert.equal(cache.size(), 2);
    clock.value = 2000;
    assert.equal(cache.consume('c', 1000), true);
    assert.throws(() => createBoundedReplayCache({ maxSize: 0 }), /maxSize must be a positive safe integer/);
});

test('bounded cache applies the legacy floor to remember but keeps consume exact', () => {
    const clock = manualClock(0);
    const cache = createBoundedReplayCache({ maxSize: 4, legacyMinRetentionMs: 5000, now: clock.now });
    cache.remember('legacy', 100);
    assert.equal(cache.consume('exact', 100), true);
    clock.value = 100;
    assert.equal(cache.seen('exact'), false);
    assert.equal(cache.seen('legacy'), true);
    clock.value = 4999;
    assert.equal(cache.seen('legacy'), true);
    clock.value = 5000;
    assert.equal(cache.seen('legacy'), false);
    cache.remember('extended', 10_000);
    cache.remember('extended', 1);
    clock.value = 14_999;
    assert.equal(cache.seen('extended'), true, 'retention never shrinks');
});

// --- partitioned cache -----------------------------------------------------

test('partitioned cache refuses one caller at its quota with 429 without affecting another caller', () => {
    const cache = createPartitionedReplayCache({ perCallerMaxSize: 2, maxSize: 10, now: manualClock(0).now });
    const alpha = cache.forCaller(ALPHA.agentId);
    const beta = cache.forCaller(BETA.agentId);
    assert.equal(alpha.consume('a1', 1000), true);
    assert.equal(alpha.consume('a2', 1000), true);
    assert.throws(() => alpha.consume('a3', 1000), QUOTA_ERROR);
    assert.throws(() => alpha.remember('a3', 1000), QUOTA_ERROR);
    assert.equal(beta.consume('b1', 1000), true);
    assert.deepEqual(cache.stats(), { partitions: 2, entries: 3 });
});

test('partitioned cache refuses every caller with 503 at the global ceiling', () => {
    const cache = createPartitionedReplayCache({ perCallerMaxSize: 2, maxSize: 3, now: manualClock(0).now });
    const alpha = cache.forCaller(ALPHA.agentId);
    const beta = cache.forCaller(BETA.agentId);
    assert.equal(alpha.consume('a1', 1000), true);
    assert.equal(alpha.consume('a2', 1000), true);
    assert.equal(beta.consume('b1', 1000), true);
    assert.throws(() => beta.consume('b2', 1000), { ...CAPACITY_ERROR, message: /replay cache capacity exhausted/ });
    assert.deepEqual(cache.stats(), { partitions: 2, entries: 3 });
});

test('partitioned cache refuses a new caller with 503 at maxPartitions while existing callers still work', () => {
    const cache = createPartitionedReplayCache({ maxPartitions: 2, now: manualClock(0).now });
    assert.equal(cache.forCaller('agent:fixtures/one').consume('j1', 1000), true);
    assert.equal(cache.forCaller('agent:fixtures/two').consume('j2', 1000), true);
    assert.throws(() => cache.forCaller('agent:fixtures/three').consume('j3', 1000), CAPACITY_ERROR);
    assert.equal(cache.forCaller('agent:fixtures/one').consume('j4', 1000), true);
    assert.equal(cache.forCaller('agent:fixtures/two').consume('j5', 1000), true);
    assert.deepEqual(cache.stats(), { partitions: 2, entries: 4 });
});

test('partitioned cache reclaims an expired partition so a new caller is admitted', () => {
    const clock = manualClock(0);
    const cache = createPartitionedReplayCache({ maxPartitions: 1, now: clock.now });
    assert.equal(cache.forCaller('agent:fixtures/one').consume('j1', 100), true);
    clock.value = 50;
    assert.throws(() => cache.forCaller('agent:fixtures/two').consume('j2', 100), CAPACITY_ERROR);
    clock.value = 1100;
    assert.equal(cache.forCaller('agent:fixtures/two').consume('j2', 100), true);
    assert.deepEqual(cache.stats(), { partitions: 1, entries: 1 });
    clock.value = 1300;
    assert.equal(cache.forCaller('agent:fixtures/two').seen('j2'), false);
    assert.deepEqual(cache.stats(), { partitions: 0, entries: 0 });
});

test('partitioned cache seen and forCaller allocate nothing', () => {
    const cache = createPartitionedReplayCache({ now: manualClock(0).now });
    const view = cache.forCaller(ALPHA.agentId);
    assert.equal(view.seen('unknown'), false);
    assert.deepEqual(cache.stats(), { partitions: 0, entries: 0 });
});

test('partitioned cache rejects an invalid caller key with PLOINKY_REPLAY_PARTITION_INVALID', () => {
    const cache = createPartitionedReplayCache();
    for (const key of ['', 'x'.repeat(513), 42, null, undefined]) {
        assert.throws(() => cache.forCaller(key), (error) => {
            assert.equal(error.code, REPLAY_PARTITION_INVALID_CODE);
            assert.equal(error.status, undefined);
            assert.equal(String(error.message).includes('xxxx'), false);
            return true;
        });
    }
    assert.equal(cache.forCaller('x'.repeat(512)).consume('j', 1000), true);
    assert.equal(cache.forCaller('agent:é/ü').consume('j', 1000), true);
});

test('partitioned cache root seen, remember and consume require forCaller', () => {
    const cache = createPartitionedReplayCache();
    for (const call of [() => cache.seen('j'), () => cache.remember('j', 1000), () => cache.consume('j', 1000)]) {
        assert.throws(call, { code: REPLAY_PARTITION_REQUIRED_CODE, status: 503 });
    }
    assert.deepEqual(cache.stats(), { partitions: 0, entries: 0 });
});

test('partitioned cache reports a replay at quota as consumed, not as quota', () => {
    const secret = crypto.randomBytes(32);
    const cache = createPartitionedReplayCache({ perCallerMaxSize: 1 });
    const view = cache.forCaller(ALPHA.agentId);
    const sign = () => {
        const iat = Math.floor(Date.now() / 1000);
        const jti = crypto.randomBytes(12).toString('base64url');
        return signHmacJwt({ payload: { aud: 'quota-test', iat, exp: iat + 30, jti }, secret });
    };
    const token = sign();
    verifyJws(token, { secret, expectedAudience: 'quota-test', replayCache: view });
    assert.throws(
        () => verifyJws(token, { secret, expectedAudience: 'quota-test', replayCache: view }),
        /already been consumed/,
    );
    assert.throws(() => verifyJws(sign(), { secret, expectedAudience: 'quota-test', replayCache: view }), QUOTA_ERROR);
});

test('partitioned cache does not rescan a partition within 1000 ms of its last sweep', () => {
    const clock = manualClock(0);
    const cache = createPartitionedReplayCache({ perCallerMaxSize: 2, now: clock.now });
    const view = cache.forCaller(ALPHA.agentId);
    assert.equal(view.consume('long-lived', 10_000), true);
    assert.equal(view.consume('short-lived', 100), true);
    clock.value = 50;
    assert.throws(() => view.consume('first-refused', 100), QUOTA_ERROR);
    // short-lived has expired, but it sits behind a live entry and the last full
    // sweep ran less than 1000 ms ago, so the refusal does not rescan.
    clock.value = 200;
    assert.throws(() => view.consume('second-refused', 100), QUOTA_ERROR);
    assert.deepEqual(cache.stats(), { partitions: 1, entries: 2 });
    clock.value = 1050;
    assert.equal(view.consume('admitted-after-sweep', 100), true);
    assert.deepEqual(cache.stats(), { partitions: 1, entries: 2 });
});

test('replayRefusalStatus maps only replay quota and capacity codes', () => {
    assert.equal(REPLAY_CACHE_EXHAUSTED_CODE, 'JWT_REPLAY_CACHE_EXHAUSTED');
    assert.equal(replayRefusalStatus({ code: REPLAY_QUOTA_EXHAUSTED_CODE }), 429);
    assert.equal(replayRefusalStatus({ code: 'JWT_REPLAY_CACHE_EXHAUSTED' }), 503);
    assert.equal(replayRefusalStatus(Object.assign(new Error('x'), { code: 'JWT_REPLAY_CACHE_EXHAUSTED' })), 503);
    assert.equal(REPLAY_CLOCK_INVALID_CODE, 'PLOINKY_REPLAY_CLOCK_INVALID');
    assert.equal(replayRefusalStatus({ code: REPLAY_CLOCK_INVALID_CODE }), 503);
    assert.equal(replayRefusalStatus({ code: REPLAY_JTI_INVALID_CODE }), null);
    assert.equal(replayRefusalStatus({ code: REPLAY_PARTITION_REQUIRED_CODE }), null);
    assert.equal(replayRefusalStatus({ code: REPLAY_PARTITION_INVALID_CODE }), null);
    assert.equal(replayRefusalStatus({ code: 'PRIVATE_ASSERTION_REJECTED', status: 401 }), null);
    assert.equal(replayRefusalStatus({ status: 503 }), null);
    assert.equal(replayRefusalStatus(new Error('jwtVerify: signature invalid')), null);
    assert.equal(replayRefusalStatus(null), null);
    assert.equal(replayRefusalStatus(undefined), null);
    assert.equal(legacyMinRetentionMs({ maxTtlSeconds: 30 }), 92_000);
    assert.equal(legacyMinRetentionMs({ maxTtlSeconds: 60 }), 122_000);
});

test('authorizePrivateRoutePlan refuses an agent that is not enabled without allocating a partition', () => {
    const plan = privateRoutePlan();
    const cache = createPartitionedReplayCache();
    const ghost = enabledAgent('ghost');
    assert.throws(() => presentPrivate(signPrivate(ghost, plan), plan, cache), (error) => {
        assert.equal(error.status, 401);
        assert.match(error.message, /not currently enabled/);
        return true;
    });
    assert.deepEqual(cache.stats(), { partitions: 0, entries: 0 });
});

test('authorizePrivateRoutePlan charges a binding-mismatch token only to its own caller', () => {
    const plan = privateRoutePlan();
    const cache = createPartitionedReplayCache({ perCallerMaxSize: 1 });
    const mismatched = signPrivate(ALPHA, plan, Buffer.from('signed body'));
    assert.throws(() => presentPrivate(mismatched, plan, cache, Buffer.from('other body')), (error) => {
        assert.equal(error.status, 401);
        assert.match(error.message, /binding mismatch/);
        return true;
    });
    assert.throws(() => presentPrivate(signPrivate(ALPHA, plan), plan, cache), QUOTA_ERROR);
    assert.equal(presentPrivate(signPrivate(BETA, plan), plan, cache).agentId, BETA.agentId);
    assert.deepEqual(cache.stats(), { partitions: 2, entries: 2 });
});

test('createTokenReplayCache returns a partitioned cache with the default bounds', () => {
    const clock = manualClock(0);
    const cache = createTokenReplayCache({ now: clock.now });
    assert.equal(typeof cache.forCaller, 'function');
    assert.throws(() => cache.consume('j', 1000), { code: REPLAY_PARTITION_REQUIRED_CODE });

    for (let caller = 0; caller < 8; caller += 1) {
        const view = cache.forCaller(`agent:fixtures/caller-${caller}`);
        for (let index = 0; index < 16384; index += 1) {
            assert.equal(view.consume(`jti-${index}`, 60_000), true);
        }
        assert.throws(() => view.consume('over-quota', 60_000), QUOTA_ERROR);
    }
    assert.deepEqual(cache.stats(), { partitions: 8, entries: 131072 });
    assert.throws(() => cache.forCaller('agent:fixtures/caller-8').consume('jti', 60_000), CAPACITY_ERROR);

    cache.reset();
    for (let caller = 0; caller < 256; caller += 1) {
        assert.equal(cache.forCaller(`agent:fixtures/caller-${caller}`).consume('jti', 60_000), true);
    }
    assert.throws(() => cache.forCaller('agent:fixtures/caller-256').consume('jti', 60_000), CAPACITY_ERROR);

    cache.reset();
    const legacyView = cache.forCaller(ALPHA.agentId);
    legacyView.remember('legacy', 1);
    clock.value = 121_999;
    assert.equal(legacyView.seen('legacy'), true);
    clock.value = 122_000;
    assert.equal(legacyView.seen('legacy'), false);
});

test('verifyRouterRequestFromHeaders reports a full bounded cache with its code', () => {
    const agentId = 'agent:fixtures/receiver';
    const secret = crypto.randomBytes(32);
    const env = { PLOINKY_AGENT_ID: agentId, PLOINKY_AGENT_SECRET: secret.toString('hex') };
    const replayCache = createBoundedReplayCache({ maxSize: 1 });
    const mint = () => {
        const iat = Math.floor(Date.now() / 1000);
        const token = signHmacJwt({
            secret,
            payload: {
                typ: 'router-request',
                iss: 'ploinky-router',
                aud: agentId,
                sub: 'user:local:admin',
                method: 'POST',
                path: '/mcp',
                jti: crypto.randomBytes(12).toString('base64url'),
                iat,
                exp: iat + 30,
            },
        });
        return { authorization: `Bearer ${token}` };
    };
    const first = verifyRouterRequestFromHeaders(mint(), { env, replayCache, method: 'POST', path: '/mcp' });
    assert.equal(first.ok, true);
    const second = verifyRouterRequestFromHeaders(mint(), { env, replayCache, method: 'POST', path: '/mcp' });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'JWT_REPLAY_CACHE_EXHAUSTED');
    assert.match(second.reason, /replay cache capacity exhausted/);
});

test('bounded and partitioned caches refuse a non-finite clock without admitting or forgetting a jti', () => {
    const clockError = { code: REPLAY_CLOCK_INVALID_CODE, status: 503, message: /non-finite time/ };
    const badClocks = {
        NaN: () => Number.NaN,
        Infinity: () => Number.POSITIVE_INFINITY,
        '-Infinity': () => Number.NEGATIVE_INFINITY,
        undefined: () => undefined,
        'Date called as a function': Date,
    };
    for (const [label, now] of Object.entries(badClocks)) {
        const bounded = createBoundedReplayCache({ maxSize: 4, now });
        assert.throws(() => bounded.consume('jti', 1000), clockError, `${label}: bounded consume`);
        assert.throws(() => bounded.seen('jti'), clockError, `${label}: bounded seen`);
        assert.throws(() => bounded.remember('jti', 1000), clockError, `${label}: bounded remember`);
        const view = createPartitionedReplayCache({ now }).forCaller(ALPHA.agentId);
        assert.throws(() => view.consume('jti', 1000), clockError, `${label}: partitioned consume`);
        assert.throws(() => view.seen('jti'), clockError, `${label}: partitioned seen`);
        assert.throws(() => view.remember('jti', 1000), clockError, `${label}: partitioned remember`);
    }

    const reading = { value: 10_000 };
    const bounded = createBoundedReplayCache({ maxSize: 4, now: () => reading.value });
    const partitioned = createPartitionedReplayCache({ now: () => reading.value });
    const view = partitioned.forCaller(ALPHA.agentId);
    assert.equal(bounded.consume('live', 60_000), true);
    assert.equal(view.consume('live', 60_000), true);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        reading.value = value;
        assert.throws(() => bounded.consume('live', 60_000), clockError);
        assert.throws(() => view.consume('live', 60_000), clockError);
    }
    reading.value = 10_001;
    assert.equal(bounded.consume('live', 60_000), false);
    assert.equal(view.consume('live', 60_000), false);
    assert.deepEqual(partitioned.stats(), { partitions: 1, entries: 1 });
});

test('bounded and partitioned caches refuse a clock that is not a function at construction', () => {
    for (const now of ['x', 5, null, {}]) {
        const refused = { code: REPLAY_CLOCK_INVALID_CODE, status: 503, message: /now must be a function/ };
        assert.throws(() => createBoundedReplayCache({ maxSize: 1, now }), refused);
        assert.throws(() => createPartitionedReplayCache({ now }), refused);
        assert.throws(() => createTokenReplayCache({ now }), refused);
    }
});

// The Marketplace route verifies with a module-level cache that cannot be
// injected, and ensureMarketplaceAgentRequest is not exported, so the 503 body
// is covered here on the OpenAI discovery and delegation handlers instead.
test('OpenAI discovery and delegation answer 503 replay_capacity_exhausted at the global ceiling', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-replay-capacity-'));
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
        const suffix = `?test=${Date.now()}-${Math.random()}`;
        const discovery = await import(`../../cli/server/openAiAgentDiscovery.js${suffix}`);
        const { verifyAndMintAgentOpenAiCall } = await import(`../../cli/server/agentOpenAiDelegation.js${suffix}`);
        const envFor = (agentId) => ({
            PLOINKY_AGENT_ID: agentId,
            PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(agentId),
        });

        const callDiscovery = (agentId, replayCache) => {
            const token = signAgentHttpAssertion({
                method: 'GET',
                path: discovery.OPENAI_AGENT_DISCOVERY_PATH,
                body: Buffer.alloc(0),
                targetAgent: discovery.OPENAI_AGENT_DISCOVERY_TARGET,
                tool: discovery.OPENAI_AGENT_DISCOVERY_TOOL,
                env: envFor(agentId),
            });
            const res = {
                statusCode: null,
                chunks: [],
                writeHead(status) { this.statusCode = status; },
                end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); },
            };
            discovery.handleOpenAiAgentDiscoveryRoute(
                { method: 'GET', headers: { authorization: `Bearer ${token}` } },
                res,
                { pathname: discovery.OPENAI_AGENT_DISCOVERY_PATH },
                { routing: { routes: {} }, replayCache },
            );
            return { status: res.statusCode, body: JSON.parse(Buffer.concat(res.chunks).toString('utf8')) };
        };
        const discoveryCache = createTokenReplayCache({ maxSize: 1 });
        assert.equal(callDiscovery('agent:fixtures/first', discoveryCache).status, 200);
        assert.deepEqual(callDiscovery('agent:fixtures/second', discoveryCache), {
            status: 503,
            body: { complete: false, error: 'replay_capacity_exhausted' },
        });

        const chatBody = Buffer.from('{"model":"fixture","messages":[]}');
        const callDelegation = (agentId, replayCache) => verifyAndMintAgentOpenAiCall({
            token: signAgentHttpAssertion({
                method: 'POST',
                path: '/v1/chat/completions',
                body: chatBody,
                targetAgent: 'llmAssistant',
                tool: '__openai_chat_completions__',
                env: envFor(agentId),
            }),
            routeKey: 'llmAssistant',
            route: { repo: 'fixtures', agent: 'llmAssistant', hostPort: 7501 },
            body: chatBody,
            replayCache,
        });
        const delegationCache = createTokenReplayCache({ maxSize: 1 });
        assert.equal(callDelegation('agent:fixtures/first', delegationCache).ok, true);
        assert.deepEqual(callDelegation('agent:fixtures/second', delegationCache), {
            ok: false,
            status: 503,
            error: 'replay_capacity_exhausted',
        });
    } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// --- jti length bound -------------------------------------------------------

test('bounded and partitioned caches refuse a non-string or over-long jti before any allocation', () => {
    assert.equal(MAX_JTI_LENGTH, 128);
    const bounded = createBoundedReplayCache({ maxSize: 4, legacyMinRetentionMs: 5000 });
    const partitioned = createPartitionedReplayCache({ legacyMinRetentionMs: 5000 });
    const view = partitioned.forCaller(ALPHA.agentId);
    const refused = (error) => {
        assert.equal(error.code, REPLAY_JTI_INVALID_CODE);
        assert.equal(error.status, undefined);
        assert.equal(replayRefusalStatus(error), null);
        return true;
    };
    for (const jti of ['x'.repeat(MAX_JTI_LENGTH + 1), 'y'.repeat(11_500), 42, undefined, null]) {
        for (const cache of [bounded, view]) {
            assert.throws(() => cache.consume(jti, 1000), refused);
            assert.throws(() => cache.seen(jti), refused);
            assert.throws(() => cache.remember(jti, 1000), refused);
        }
    }
    assert.equal(bounded.size(), 0);
    assert.deepEqual(partitioned.stats(), { partitions: 0, entries: 0 });
    const atLimit = 'z'.repeat(MAX_JTI_LENGTH);
    assert.equal(bounded.consume(atLimit, 1000), true);
    assert.equal(view.consume(atLimit, 1000), true);
    assert.deepEqual(partitioned.stats(), { partitions: 1, entries: 1 });
});

// A hand-signed private assertion, so the test controls the jti.
function signPrivateWithJti(agent, plan, jti) {
    const iat = Math.floor(Date.now() / 1000);
    return signHmacJwt({
        secret: derivePrivateAgentRequestSecret(agent.agentId, agent.instanceId, agent.enableGeneration, {
            encoding: 'buffer',
        }),
        payload: {
            typ: 'private-agent-assertion',
            iss: agent.agentId,
            sub: agent.agentId,
            aud: 'ploinky-private-router',
            instanceId: agent.instanceId,
            enableGeneration: agent.enableGeneration,
            method: 'POST',
            path: plan.pathname,
            rch: computeRchHttp({
                method: 'POST',
                path: plan.pathname,
                query: plan.parsedUrl.search,
                bodyHash: sha256RawBodyHash(BODY),
            }),
            iat,
            exp: iat + 30,
            jti,
        },
    });
}

// Holds with both shared JWT libraries: the current one refuses the jti in
// verifyJws, an older one reaches the cache's seen(), which refuses it.
test('authorizePrivateRoutePlan refuses an over-long jti with 401 and stores nothing', () => {
    const plan = privateRoutePlan();
    const cache = createPartitionedReplayCache();
    let refusal = null;
    try {
        presentPrivate(signPrivateWithJti(ALPHA, plan, 'j'.repeat(MAX_JTI_LENGTH + 1)), plan, cache);
    } catch (error) {
        refusal = error;
    }
    assert.ok(refusal, 'an over-long jti was admitted');
    assert.match(refusal.message, /jti too long|jti must be a string of at most 128 characters/);
    const res = { statusCode: null, writeHead(status) { this.statusCode = status; }, end() {} };
    sendPrivateError(res, refusal);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(cache.stats(), { partitions: 0, entries: 0 });

    const admitted = presentPrivate(signPrivateWithJti(ALPHA, plan, 'k'.repeat(MAX_JTI_LENGTH)), plan, cache);
    assert.equal(admitted.agentId, ALPHA.agentId);
    assert.deepEqual(cache.stats(), { partitions: 1, entries: 1 });
});

test('OpenAI discovery answers 401 for an over-long jti and admits one of 128 characters', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-replay-jti-'));
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
        const suffix = `?test=${Date.now()}-${Math.random()}`;
        const discovery = await import(`../../cli/server/openAiAgentDiscovery.js${suffix}`);
        const agentId = 'agent:fixtures/discoverer';
        const call = (jti, replayCache) => {
            const iat = Math.floor(Date.now() / 1000);
            const token = signHmacJwt({
                secret: deriveAgentRequestSecret(agentId, { encoding: 'buffer' }),
                payload: {
                    typ: 'agent-assertion',
                    iss: agentId,
                    sub: agentId,
                    aud: 'ploinky-router',
                    targetAgent: discovery.OPENAI_AGENT_DISCOVERY_TARGET,
                    method: 'GET',
                    path: discovery.OPENAI_AGENT_DISCOVERY_PATH,
                    tool: discovery.OPENAI_AGENT_DISCOVERY_TOOL,
                    rch: computeRchHttp({
                        method: 'GET',
                        path: discovery.OPENAI_AGENT_DISCOVERY_PATH,
                        query: '',
                        bodyHash: sha256RawBodyHash(''),
                    }),
                    iat,
                    exp: iat + 60,
                    jti,
                },
            });
            const res = {
                statusCode: null,
                chunks: [],
                writeHead(status) { this.statusCode = status; },
                end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); },
            };
            discovery.handleOpenAiAgentDiscoveryRoute(
                { method: 'GET', headers: { authorization: `Bearer ${token}` } },
                res,
                { pathname: discovery.OPENAI_AGENT_DISCOVERY_PATH },
                { routing: { routes: {} }, replayCache },
            );
            return { status: res.statusCode, body: JSON.parse(Buffer.concat(res.chunks).toString('utf8')) };
        };
        const replayCache = createTokenReplayCache();
        assert.deepEqual(call('m'.repeat(MAX_JTI_LENGTH + 1), replayCache), {
            status: 401,
            body: { complete: false, error: 'agent_assertion_required' },
        });
        assert.deepEqual(replayCache.stats(), { partitions: 0, entries: 0 });
        assert.equal(call('n'.repeat(MAX_JTI_LENGTH), replayCache).status, 200);
        assert.deepEqual(replayCache.stats(), { partitions: 1, entries: 1 });
    } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// The current shared library refuses a padded jti by its raw length. An older
// one trims first, so the cache only sees the fitting trimmed value: it is
// admitted, stored under a fixed-size digest key (the private Map cannot be
// inspected here; the apparatus heap probe covers retention) and still refused
// on replay, which proves the digest lookups match.
test('a padded jti is refused by the current library and stored by digest under an older one', () => {
    const plan = privateRoutePlan();
    const cache = createPartitionedReplayCache();
    const token = signPrivateWithJti(BETA, plan, `${'p'.repeat(MAX_JTI_LENGTH)}${' '.repeat(11_000)}`);
    assert.ok(token.length < 16384, `fixture token is ${token.length} characters, over the private header cap`);
    const libraryHasConsume = typeof createMemoryReplayCache().consume === 'function';
    if (libraryHasConsume) {
        let refusal = null;
        try {
            presentPrivate(token, plan, cache);
        } catch (error) {
            refusal = error;
        }
        assert.ok(refusal, 'a padded jti was admitted by the current library');
        assert.match(refusal.message, /^jwtVerify: jti too long$/);
        const res = { statusCode: null, writeHead(status) { this.statusCode = status; }, end() {} };
        sendPrivateError(res, refusal);
        assert.equal(res.statusCode, 401);
        assert.deepEqual(cache.stats(), { partitions: 0, entries: 0 });
    } else {
        assert.equal(presentPrivate(token, plan, cache).agentId, BETA.agentId);
        assert.deepEqual(cache.stats(), { partitions: 1, entries: 1 });
        assert.throws(() => presentPrivate(token, plan, cache), /already been consumed/);
        assert.deepEqual(cache.stats(), { partitions: 1, entries: 1 });
    }
});
