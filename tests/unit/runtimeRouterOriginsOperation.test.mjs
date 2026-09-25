import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { signPrivateRouterAssertion } from '../../Agent/lib/agentAssertion.mjs';
import {
    abortEdgeRoutingPreparation,
    applyEdgeRoutingGeneration,
    commitAdditiveEdgeRoutingGeneration,
    inactivateEdgeRoutingGeneration,
    prepareAdditiveEdgeRoutingGeneration,
    prepareEdgeRoutingGeneration,
    readCurrentEdgeTopology,
    withEdgeGenerationApplyLock,
} from '../../cli/sandbox/edgeGeneration.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import {
    authorizePrivateRoutePlan,
    buildRuntimeRouterOriginsResponse,
} from '../../cli/server/privateRouter.js';
import {
    MockResponse,
    consumerAssertionEnv,
    createRouterOriginsWorkspace,
    handlePrivateRuntimeOrigins,
    installGenerationWithoutPublicHosts,
    selectBinding,
    signedRuntimeOriginsHeaders,
} from '../helpers/routerOriginsWorkspace.mjs';

const ORIGINS = ['http://100.73.151.25:3000', 'http://pgx:3000'];

function request({ method = 'GET', url = '/api/edge/runtime-origins', headers = signedRuntimeOriginsHeaders(), body } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    return Object.assign(req, { method, url, headers });
}

async function call(options = {}, pipeline = {}) {
    const res = new MockResponse();
    await handlePrivateRuntimeOrigins(request(options), res, pipeline);
    return res;
}

function errorCode(res) {
    return res.json().error;
}

test('a current signed agent reads the active lease origins, not the advisory topology file', async (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['100.73.151.25', 'pgx'] });
    const res = await call({
        headers: {
            ...signedRuntimeOriginsHeaders(),
            origin: 'http://attacker.example',
            'x-forwarded-host': 'attacker.example:3000',
            forwarded: 'host=attacker.example',
        },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['content-type'], 'application/json');
    assert.deepEqual(res.json(), {
        schemaVersion: 1,
        authorizationGeneration: fixture.applied.selector.generation,
        activationId: fixture.applied.selector.activationId,
        routerOrigins: ORIGINS,
    });
    assert.deepEqual(Object.keys(res.json()).sort(), ['activationId', 'authorizationGeneration', 'routerOrigins', 'schemaVersion']);
    assert.doesNotMatch(res.body, /attacker|workspace|\/tmp|secret/i);

    const topologyFile = path.join(fixture.workspace, '.ploinky', 'run', 'edge-topology', 'current.json');
    const advisory = JSON.parse(fs.readFileSync(topologyFile, 'utf8'));
    fs.writeFileSync(topologyFile, JSON.stringify({ ...advisory, routerOrigins: ['http://attacker.example:3000'] }));
    const again = await call();
    assert.deepEqual(again.json().routerOrigins, ORIGINS);
});

test('unsigned, replayed, stale, unknown, and wrong-workspace callers are rejected', async (t) => {
    createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    const unsigned = await call({ headers: { host: 'host.containers.internal:8081' } });
    assert.equal(unsigned.statusCode, 401);
    assert.equal(errorCode(unsigned), 'PRIVATE_ASSERTION_REJECTED');

    const replayedHeaders = signedRuntimeOriginsHeaders();
    assert.equal((await call({ headers: replayedHeaders })).statusCode, 200);
    const replayed = await call({ headers: replayedHeaders });
    assert.equal(replayed.statusCode, 401);

    const stale = await call({ headers: signedRuntimeOriginsHeaders(consumerAssertionEnv({ enableGeneration: 'retired-generation' })) });
    assert.equal(stale.statusCode, 401);

    const unknown = await call({ headers: signedRuntimeOriginsHeaders(consumerAssertionEnv({ agentId: 'agent:fixtures/unrelated' })) });
    assert.equal(unknown.statusCode, 401);

    const previousKey = process.env.PLOINKY_MASTER_KEY;
    process.env.PLOINKY_MASTER_KEY = '6'.repeat(64);
    const foreignEnv = consumerAssertionEnv();
    process.env.PLOINKY_MASTER_KEY = previousKey;
    const foreign = await call({ headers: signedRuntimeOriginsHeaders(foreignEnv) });
    assert.equal(foreign.statusCode, 401, 'another workspace key cannot authenticate this caller');
    assert.notEqual(foreignEnv.PLOINKY_AGENT_PRIVATE_SECRET, consumerAssertionEnv().PLOINKY_AGENT_PRIVATE_SECRET);
});

test('the operation accepts only an exact bodyless GET on the private listener', async (t) => {
    createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    const env = consumerAssertionEnv();
    const sign = (method, body = Buffer.alloc(0), query = '') => ({
        host: 'host.containers.internal:8081',
        'ploinky-agent-assertion': signPrivateRouterAssertion({ method, path: '/api/edge/runtime-origins', query, body, env }),
    });
    for (const url of ['/api/edge/runtime-origins?', '/api/edge/runtime-origins?refresh=1', '/api/edge/./runtime-origins']) {
        const res = await call({ url, headers: sign('GET', Buffer.alloc(0), url.includes('?') ? url.slice(url.indexOf('?')) : '') });
        assert.equal(res.statusCode, 400, url);
        assert.equal(errorCode(res), 'RUNTIME_ORIGINS_REQUEST_INVALID', url);
    }
    const post = await call({ method: 'POST', headers: sign('POST') });
    assert.equal(post.statusCode, 400);
    assert.equal(errorCode(post), 'RUNTIME_ORIGINS_REQUEST_INVALID');

    const body = Buffer.from('{}');
    const withBody = await call({ headers: sign('GET', body), body });
    assert.equal(withBody.statusCode, 400);
    assert.equal(errorCode(withBody), 'RUNTIME_ORIGINS_REQUEST_INVALID');

    const publicClass = await call({}, { listener: 'public' });
    assert.notEqual(publicClass.statusCode, 200);
    for (const [listener, host] of [['public', 'localhost:3000'], ['public', 'pgx:3000'], ['managed', 'host.containers.internal:8080']]) {
        const plan = resolveEdgeRoutePlan({
            req: { method: 'GET', url: '/api/edge/runtime-origins', headers: { ...signedRuntimeOriginsHeaders(), host } },
            listener,
        });
        assert.equal(plan.ok, false, `${listener} ${host}`);
        assert.notEqual(plan.operation, 'runtime-origins');
    }
    const privatePlan = resolveEdgeRoutePlan({
        req: { method: 'GET', url: '/api/edge/runtime-origins', headers: { host: 'host.containers.internal:8081' }, ploinkyListenerClass: 'private' },
        listener: 'private',
    });
    assert.throws(() => authorizePrivateRoutePlan({
        req: { method: 'GET', headers: signedRuntimeOriginsHeaders() },
        plan: { ...privatePlan, listener: 'public' },
        body: Buffer.alloc(0),
    }), { code: 'PRIVATE_LISTENER_REQUIRED' });
    assert.throws(() => buildRuntimeRouterOriginsResponse({ ...privatePlan, listener: 'public' }), { code: 'PRIVATE_LISTENER_REQUIRED' });
});

test('a lease change between authorization and reply returns 503 instead of retired origins', async (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    const res = await call({}, {
        beforeReply: () => applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'reactivation-race' }),
    });
    assert.equal(res.statusCode, 503);
    assert.equal(errorCode(res), 'edge_generation_changed');
    const fresh = await call();
    assert.equal(fresh.statusCode, 200);
    assert.notEqual(fresh.json().activationId, fixture.applied.selector.activationId, 'identical bytes reactivated as a new lease');
});

test('replacement failure between topology publication and selector commit never exposes the candidate', async (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    assert.deepEqual((await call()).json().routerOrigins, ['http://pgx:3000']);

    // The Box is recreated with a new host list before its graph restarts.
    selectBinding({ hosts: ['100.73.151.25'] });
    const drifted = await call();
    assert.equal(drifted.statusCode, 503);
    assert.equal(errorCode(drifted), 'EDGE_GENERATION_RUNTIME_MISMATCH');

    const observed = [];
    assert.throws(() => applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'rebind-crash',
        testHooks: {
            beforeSelectorCommit: ({ topology }) => {
                observed.push({ advisory: topology.routerOrigins, file: readCurrentEdgeTopology({ workspaceRoot: fixture.workspace }).routerOrigins });
                throw new Error('injected crash before selector commit');
            },
        },
    }), /injected crash/);
    assert.deepEqual(observed, [{ advisory: ['http://100.73.151.25:3000'], file: ['http://100.73.151.25:3000'] }]);
    for (const res of [await call()]) {
        assert.equal(res.statusCode, 503, 'a published but uncommitted candidate is never an answer');
        assert.equal(errorCode(res), 'EDGE_GENERATION_INACTIVE');
    }

    // A durable prepared replacement candidate is never an answer either.
    const prepared = prepareEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'rebind-prepare' });
    assert.deepEqual(prepared.topology.routerOrigins, ['http://100.73.151.25:3000']);
    const preparedAnswer = await call();
    assert.equal(preparedAnswer.statusCode, 503);
    assert.doesNotMatch(preparedAnswer.body, /100\.73/);
    abortEdgeRoutingPreparation(prepared.preparationLease, { workspaceRoot: fixture.workspace });

    // In-flight observation during the commit window also fails closed.
    const during = [];
    const committed = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'rebind',
        testHooks: {
            beforeSelectorCommit: () => {
                during.push(call());
            },
        },
    });
    const duringResponse = await during[0];
    assert.equal(duringResponse.statusCode, 503);
    const after = await call();
    assert.equal(after.statusCode, 200);
    assert.deepEqual(after.json().routerOrigins, ['http://100.73.151.25:3000']);
    assert.equal(after.json().authorizationGeneration, committed.selector.generation);

    // Rolling back to the prior Box restores exactly its captured origins.
    selectBinding({ hosts: ['pgx'] });
    assert.equal((await call()).statusCode, 503);
    const rolledBack = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'rebind-rollback' });
    const restored = await call();
    assert.deepEqual(restored.json().routerOrigins, ['http://pgx:3000']);
    assert.equal(restored.json().authorizationGeneration, fixture.applied.selector.generation);
    assert.equal(restored.json().activationId, rolledBack.selector.activationId);

    inactivateEdgeRoutingGeneration('operator-stop', { workspaceRoot: fixture.workspace });
    const inactive = await call();
    assert.equal(inactive.statusCode, 503);
    assert.equal(errorCode(inactive), 'EDGE_GENERATION_INACTIVE');
});

test('additive failure after candidate topology publication keeps answering from the active predecessor', async (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['100.73.151.25', 'pgx'] });
    const predecessor = fixture.applied;
    const routing = structuredClone(predecessor.generation.routing);
    routing.routes.consumer.hostPort = 43112;
    let prepared;
    withEdgeGenerationApplyLock((applyLockCapability) => {
        prepared = prepareAdditiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, routing, applyLockCapability });
    }, { workspaceRoot: fixture.workspace });

    const responses = [];
    await assert.rejects(async () => {
        const pending = [];
        try {
            withEdgeGenerationApplyLock((applyLockCapability) => commitAdditiveEdgeRoutingGeneration(prepared.preparationLease, {
                workspaceRoot: fixture.workspace,
                routing,
                applyLockCapability,
                testHooks: {
                    afterBeforeSelectorCommit: ({ topology }) => {
                        responses.push({ topologyGeneration: topology.authorizationGeneration });
                        pending.push(call());
                        throw new Error('readiness revoked before commit');
                    },
                },
            }), { workspaceRoot: fixture.workspace, preparationLease: prepared.preparationLease });
        } finally {
            responses.push(...(await Promise.all(pending)).map((res) => res.json()));
        }
    }, /readiness revoked/);
    assert.equal(responses[0].topologyGeneration, prepared.preparationLease.preparedGeneration);
    assert.equal(responses[1].authorizationGeneration, predecessor.selector.generation);
    assert.equal(responses[1].activationId, predecessor.selector.activationId);
    const afterFailure = (await call()).json();
    assert.equal(afterFailure.authorizationGeneration, predecessor.selector.generation);
    assert.deepEqual(afterFailure.routerOrigins, ORIGINS);
});

test('origins are available whether the consumer is added after binding or the graph is bound afterward', async (t) => {
    // Graph bound first; the consumer is enabled later through an additive change.
    const bound = createRouterOriginsWorkspace(t, { hosts: ['100.73.151.25', 'pgx'], apply: false });
    const agentsFile = path.join(bound.ploinkyDir, 'agents.json');
    const routingFile = path.join(bound.ploinkyDir, 'routing.json');
    const fullAgents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    const fullRouting = JSON.parse(fs.readFileSync(routingFile, 'utf8'));
    fs.writeFileSync(agentsFile, JSON.stringify({}));
    fs.writeFileSync(routingFile, JSON.stringify({ routes: {} }));
    const withoutConsumer = applyEdgeRoutingGeneration({ workspaceRoot: bound.workspace, reason: 'graph-without-consumer' });
    assert.deepEqual(withoutConsumer.topology.routerOrigins, ORIGINS);
    assert.equal((await call()).statusCode, 401, 'an agent that is not enabled cannot read workspace metadata');
    let prepared;
    withEdgeGenerationApplyLock((applyLockCapability) => {
        prepared = prepareAdditiveEdgeRoutingGeneration({
            workspaceRoot: bound.workspace,
            routing: fullRouting,
            agents: fullAgents,
            applyLockCapability,
        });
    }, { workspaceRoot: bound.workspace });
    withEdgeGenerationApplyLock((applyLockCapability) => commitAdditiveEdgeRoutingGeneration(prepared.preparationLease, {
        workspaceRoot: bound.workspace,
        routing: fullRouting,
        agents: fullAgents,
        applyLockCapability,
    }), { workspaceRoot: bound.workspace, preparationLease: prepared.preparationLease });
    assert.deepEqual((await call()).json().routerOrigins, ORIGINS);

    // Consumer running on a loopback-only Box first; binding recreates the Box.
    const later = createRouterOriginsWorkspace(t, { hosts: undefined });
    const loopbackOnly = await call();
    assert.equal(loopbackOnly.statusCode, 200);
    assert.deepEqual(loopbackOnly.json().routerOrigins, []);
    selectBinding({ hosts: ['100.73.151.25', 'pgx'] });
    applyEdgeRoutingGeneration({ workspaceRoot: later.workspace, reason: 'bind-after-consumer' });
    assert.deepEqual((await call()).json().routerOrigins, ORIGINS);
});

test('an active generation without public Router hosts gives no Router-origin answer even on a bound Box', async (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['100.73.151.25', 'pgx'] });
    assert.deepEqual((await call()).json().routerOrigins, ORIGINS);

    const plan = resolveEdgeRoutePlan({
        req: { method: 'GET', url: '/api/edge/runtime-origins', headers: { host: 'host.containers.internal:8081' }, ploinkyListenerClass: 'private' },
        listener: 'private',
    });
    const malformedSnapshot = { ...plan.snapshot, routerOrigins: ['http://pgx:3000/'] };
    assert.throws(() => buildRuntimeRouterOriginsResponse({ ...plan, snapshot: malformedSnapshot, lease: { ...plan.lease, snapshot: malformedSnapshot } }),
        { code: 'RUNTIME_ORIGINS_INVALID', status: 503 });
    assert.throws(() => buildRuntimeRouterOriginsResponse({ ...plan, lease: { ...plan.lease, activationId: 'not-a-uuid' } }),
        { code: 'RUNTIME_ORIGINS_LEASE_INVALID', status: 503 });

    installGenerationWithoutPublicHosts(fixture.edgeDir, fixture.applied.selector.generation);
    const unsupported = await call();
    assert.equal(unsupported.statusCode, 503);
    assert.equal(errorCode(unsupported), 'EDGE_GENERATION_CORRUPT');
    assert.doesNotMatch(unsupported.body, /pgx|100\.73/);
});
