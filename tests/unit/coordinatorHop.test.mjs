import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { signPrivateRouterAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { verifyRouterRequestFromHeaders } from '../../Agent/lib/invocationAuth.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { computeRchHttp, sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import { authorizePrivateRoutePlan } from '../../cli/server/privateRouter.js';
import { COORDINATOR_ROUTE_UNAVAILABLE } from '../../cli/server/executionProvider/routing.mjs';
import {
    COORDINATOR_ADMISSION_TOOL,
    COORDINATOR_CALLER_DENIED,
    COORDINATOR_OWNER_GRANT_REJECTED,
    privateForwardTrustedHeadersFactory,
} from '../../cli/server/executionProvider/coordinatorHop.mjs';
import { mintUserDelegationGrant, verifyUserDelegationGrant } from '../../cli/server/mcp-proxy/userDelegationGrant.js';
import { validateExecutionProviderDeclaration } from '../../cli/server/executionProvider/declaration.mjs';
import { deriveAgentRequestSecret, derivePrivateAgentRequestSecret, deriveSubkey } from '../../cli/utils/security/masterKey.js';
import { domainFixture } from './directDomainFixtures.mjs';

const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_MASTER_KEY = '6'.repeat(64);
test.after(() => {
    if (previousMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousMasterKey;
});

// Fictional agents: `explorer` is the provider and declares `unrelated` as the
// only coordinator of its scopes; `mailer` is another enabled agent.
const AP = '/base-agent-additional-server';
const PROVIDER = 'agent:fixtures/explorer';
const COORDINATOR = 'agent:fixtures/unrelated';
const OTHER_AGENT = 'agent:fixtures/mailer';
const USER = { id: 'user-owner', username: 'owner', email: 'owner@example.test', roles: ['user'] };

function fixture(t) {
    const world = domainFixture(t, { mode: 'dual' });
    world.agents['explorer-container'].config = { ports: [{ containerPort: 7000, hostPort: 43101, hostIp: '127.0.0.1', protocol: 'tcp' }] };
    world.write(world.paths.agentsFile, world.agents);
    const file = path.join(world.root, 'fixtures', 'explorer', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.executionProvider = {
        version: 1,
        port: 7300,
        taskReferences: { path: '/explorer/task-refs' },
        coordinatorRoutes: [
            { path: `${AP}/explorer/7000/api/coord/*`, callers: [COORDINATOR] },
            { path: `${AP}/explorer/7000/exact`, callers: [COORDINATOR] },
        ],
    };
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    world.apply();
    return world;
}

function privatePlan(target, { method = 'POST', headers = {}, transport = 'http' } = {}) {
    const req = {
        url: target, method, headers: { host: '127.0.0.1:8081', ...headers }, ploinkyListenerClass: 'private',
    };
    return { req, plan: resolveEdgeRoutePlan({ req, listener: 'private', transport }) };
}

function callerEnv(agentId, name) {
    const instanceId = `${name}-instance`;
    const enableGeneration = `${name}-enable`;
    return {
        PLOINKY_AGENT_ID: agentId,
        PLOINKY_AGENT_INSTANCE_ID: instanceId,
        PLOINKY_AGENT_ENABLE_GENERATION: enableGeneration,
        PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(agentId, instanceId, enableGeneration),
    };
}

function sign(req, plan, body, env) {
    req.headers['ploinky-agent-assertion'] = signPrivateRouterAssertion({
        method: req.method, path: plan.pathname, query: plan.parsedUrl.search, body, env,
    });
}

function grant({
    source = COORDINATOR, target = PROVIDER, tools = [COORDINATOR_ADMISSION_TOOL], scopes = ['execution:owner'],
    now = new Date(), ttlSeconds = 30, user = USER,
} = {}) {
    return mintUserDelegationGrant({
        signingSecret: deriveSubkey('router-user-delegation', 32),
        now, ttlSeconds, sourceAgentId: source, user, targetAgentId: target, tools, scopes,
    }).token;
}

function admit(t, target, { caller = COORDINATOR, name = 'unrelated', delegation, body = Buffer.from('{"op":1}') } = {}) {
    const { req, plan } = privatePlan(target);
    assert.equal(plan.ok, true, `planned ${target}: ${plan.code}`);
    if (delegation !== undefined) req.headers['x-ploinky-user-delegation'] = delegation;
    sign(req, plan, body, callerEnv(caller, name));
    authorizePrivateRoutePlan({ req, plan, body, assertionCache: createMemoryReplayCache() });
    return { req, plan, body };
}

function forwardHeaders(req, plan, body) {
    const factory = privateForwardTrustedHeadersFactory({ req, plan });
    assert.equal(typeof factory, 'function');
    return factory({ bodyHash: sha256RawBodyHash(body), plan });
}

function verifyForward(headers, plan, body) {
    const authInfo = JSON.parse(headers.authInfo);
    const env = { PLOINKY_AGENT_ID: PROVIDER, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(PROVIDER) };
    const pathOnly = plan.unmatchedSuffix.split('?')[0];
    const verified = verifyRouterRequestFromHeaders({ authorization: `Bearer ${authInfo.invocationToken}` }, {
        env,
        replayCache: createMemoryReplayCache(),
        method: plan.method,
        path: pathOnly,
        tool: COORDINATOR_ADMISSION_TOOL,
        rch: computeRchHttp({ method: plan.method, path: pathOnly, query: plan.parsedUrl.search, bodyHash: sha256RawBodyHash(body) }),
    });
    assert.equal(verified.ok, true, verified.reason);
    return { payload: verified.payload, invocationBody: authInfo.invocationBody };
}

test('private listener: only an exact declared coordinator scope over HTTP plans; every other spelling and transport stays unavailable', (t) => {
    fixture(t);
    for (const suffix of ['/api/coord/x', '/api/coord', '/api/coord/a/b?x=1', '/exact']) {
        const { plan } = privatePlan(`${AP}/explorer/7000${suffix}`);
        assert.equal(plan.ok, true, suffix);
        assert.equal(plan.kind, 'agent-port', suffix);
    }
    for (const suffix of ['/API/coord/x', '/api/Coord/x', '/api/coord;x', '/api;p/coord', '/exact/', '/api/coord/x/']) {
        const { plan } = privatePlan(`${AP}/explorer/7000${suffix}`);
        assert.equal(plan.ok, false, suffix);
        assert.equal(plan.code, COORDINATOR_ROUTE_UNAVAILABLE, suffix);
    }
    // An upgrade cannot carry the signed Router Request, whatever transport it plans with.
    assert.equal(privatePlan(`${AP}/explorer/7000/api/coord/x`, { headers: { upgrade: 'websocket' } }).plan.code, COORDINATOR_ROUTE_UNAVAILABLE);
    assert.equal(privatePlan(`${AP}/explorer/7000/api/coord/x`, { transport: 'websocket' }).plan.code, COORDINATOR_ROUTE_UNAVAILABLE);
    // The public and managed listeners keep S2's denial for the exact scope.
    for (const [listener, host] of [['public', '127.0.0.1:8080'], ['managed', 'host.containers.internal:8080']]) {
        const req = { url: `${AP}/explorer/7000/api/coord/x`, method: 'POST', headers: { host } };
        assert.equal(resolveEdgeRoutePlan({ req, listener }).code, COORDINATOR_ROUTE_UNAVAILABLE, listener);
    }
});

test('coordinator-route ACL admits only the declared coordinator; an undeclared enabled agent is refused; ordinary routes keep any current caller', (t) => {
    fixture(t);
    const target = `${AP}/explorer/7000/api/coord/run`;
    const admitted = admit(t, target);
    assert.equal(admitted.req.privateAgentIdentity.agentId, COORDINATOR);
    assert.equal(admitted.req.coordinatorAdmission.callerPrincipal, COORDINATOR);
    assert.equal(admitted.req.coordinatorAdmission.providerPrincipal, PROVIDER);

    assert.throws(() => admit(t, target, { caller: OTHER_AGENT, name: 'mailer' }),
        (error) => error.status === 403 && error.code === COORDINATOR_CALLER_DENIED);

    // Positive control: the same undeclared agent still reaches an ordinary authenticated route of the provider.
    const ordinary = admit(t, `${AP}/explorer/7000/api/other`, { caller: OTHER_AGENT, name: 'mailer' });
    assert.equal(ordinary.req.privateAgentIdentity.agentId, OTHER_AGENT);
    assert.equal(ordinary.req.coordinatorAdmission, undefined);
    assert.equal(privateForwardTrustedHeadersFactory({ req: ordinary.req, plan: ordinary.plan }), undefined,
        'an ordinary private route forwards without Router claims, as before');

    // An upgrade on the coordinator scope is refused by the authorization step as well.
    const { req, plan } = privatePlan(target);
    req.headers.upgrade = 'websocket';
    sign(req, plan, Buffer.alloc(0), callerEnv(COORDINATOR, 'unrelated'));
    assert.throws(() => authorizePrivateRoutePlan({ req, plan, body: Buffer.alloc(0), assertionCache: createMemoryReplayCache() }),
        (error) => error.code === 'COORDINATOR_ROUTE_UNAVAILABLE');
});

test('a declared coordinator forward carries a provider-audience __coordinator_admission__ Router Request; usr and delegation only with a valid grant', (t) => {
    fixture(t);
    const target = `${AP}/explorer/7000/api/coord/run?view=1`;

    // Without a grant: coordinator identity only (background and MCP rows).
    const plain = admit(t, target);
    const plainForward = verifyForward(forwardHeaders(plain.req, plain.plan, plain.body), plain.plan, plain.body);
    assert.equal(plainForward.payload.aud, PROVIDER);
    assert.equal(plainForward.payload.tool, COORDINATOR_ADMISSION_TOOL);
    assert.deepEqual(plainForward.payload.actor, { kind: 'agent', id: COORDINATOR, roles: [] });
    assert.equal(plainForward.payload.caller.id, COORDINATOR);
    assert.equal(plainForward.payload.usr, undefined);
    assert.equal(plainForward.payload.delegation, undefined);
    assert.equal(plainForward.invocationBody.path, '/api/coord/run');
    assert.equal(plainForward.invocationBody.search, '?view=1');

    // With a valid grant: the verified user and delegation facts, never the grant bytes.
    const token = grant();
    const owned = admit(t, target, { delegation: token });
    assert.equal(owned.req.headers['x-ploinky-user-delegation'], undefined, 'the grant header is removed before forwarding');
    const headers = forwardHeaders(owned.req, owned.plan, owned.body);
    assert.equal(headers.authInfo.includes(token), false, 'the raw grant is never forwarded');
    const ownedForward = verifyForward(headers, owned.plan, owned.body);
    assert.equal(ownedForward.payload.usr.id, USER.id);
    assert.deepEqual(ownedForward.payload.usr.roles, ['user']);
    assert.deepEqual(ownedForward.payload.delegation.scope, ['execution:owner']);
    assert.equal(ownedForward.payload.delegation.sourceAgentId, COORDINATOR);
    assert.ok(ownedForward.payload.delegation.jti);

    // The verification consumed no grant jti: the same grant serves a second operation.
    const again = admit(t, target, { delegation: token });
    assert.equal(again.req.coordinatorAdmission.grant.user.id, USER.id);

    // The forward is bound to the exact body: a different body hash does not verify.
    const factory = privateForwardTrustedHeadersFactory({ req: owned.req, plan: owned.plan });
    const tampered = JSON.parse(factory({ bodyHash: sha256RawBodyHash(Buffer.from('other')), plan: owned.plan }).authInfo);
    const env = { PLOINKY_AGENT_ID: PROVIDER, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(PROVIDER) };
    const mismatch = verifyRouterRequestFromHeaders({ authorization: `Bearer ${tampered.invocationToken}` }, {
        env, replayCache: createMemoryReplayCache(), method: 'POST', path: '/api/coord/run', tool: COORDINATOR_ADMISSION_TOOL,
        rch: computeRchHttp({ method: 'POST', path: '/api/coord/run', query: '?view=1', bodyHash: sha256RawBodyHash(owned.body) }),
    });
    assert.equal(mismatch.ok, false);
});

test('owner grants are refused for a missing tool marker, expiry, wrong source, wrong target, missing scope or a repeated header', (t) => {
    fixture(t);
    const target = `${AP}/explorer/7000/exact`;
    const rejected = (delegation, label) => assert.throws(() => admit(t, target, { delegation }),
        (error) => error.status === 403 && error.code === COORDINATOR_OWNER_GRANT_REJECTED, label);
    rejected(grant({ tools: ['other_tool'] }), 'lacks __coordinator_admission__ in allowedTools');
    rejected(grant({ now: new Date(Date.now() - 31_000) }), 'expired');
    rejected(grant({ source: OTHER_AGENT }), 'issued to another source agent');
    rejected(grant({ target: 'agent:fixtures/bizanso' }), 'issued for another target');
    rejected(grant({ scopes: ['execution:viewer'] }), 'lacks the execution:owner scope');
    rejected('', 'empty header');
    rejected('not-a-grant', 'malformed grant');
    rejected([grant(), grant()], 'repeated header');
    // Positive control: the same request with a valid grant is admitted.
    assert.equal(admit(t, target, { delegation: grant() }).req.coordinatorAdmission.grant.user.id, USER.id);
});

test('a coordinator forward without recorded admission fails before the relay; an inexact spelling never gets the ordinary ACL', (t) => {
    fixture(t);
    const { req, plan } = privatePlan(`${AP}/explorer/7000/api/coord/run`);
    assert.equal(plan.ok, true);
    const factory = privateForwardTrustedHeadersFactory({ req, plan });
    assert.throws(() => factory({ bodyHash: sha256RawBodyHash(Buffer.alloc(0)), plan }),
        (error) => error.code === 'COORDINATOR_HOP_UNAVAILABLE');
    // A forged admission for another scope is not accepted either.
    req.coordinatorAdmission = Object.freeze({ path: `${AP}/explorer/7000/exact`, callerPrincipal: COORDINATOR, providerPrincipal: PROVIDER, grant: null, routeKey: 'explorer' });
    assert.throws(() => factory({ bodyHash: sha256RawBodyHash(Buffer.alloc(0)), plan }),
        (error) => error.code === 'COORDINATOR_HOP_UNAVAILABLE');
});

test('owner grant lifetime: a valid 30-second grant is admitted; signed, unexpired 31 s and 3600 s grants are refused before forwarding', (t) => {
    fixture(t);
    const target = `${AP}/explorer/7000/api/coord/run`;
    const ok = admit(t, target, { delegation: grant({ ttlSeconds: 30 }) });
    assert.equal(ok.req.coordinatorAdmission.grant.user.id, USER.id, 'positive control');
    for (const ttlSeconds of [31, 3600]) {
        const token = grant({ ttlSeconds });
        const { req, plan } = privatePlan(target);
        req.headers['x-ploinky-user-delegation'] = token;
        const body = Buffer.from('{"op":1}');
        sign(req, plan, body, callerEnv(COORDINATOR, 'unrelated'));
        assert.throws(() => authorizePrivateRoutePlan({ req, plan, body, assertionCache: createMemoryReplayCache() }),
            (error) => error.status === 403 && error.code === COORDINATOR_OWNER_GRANT_REJECTED && /exceeds 30 seconds/.test(error.message),
            `${ttlSeconds} s`);
        assert.equal(req.coordinatorAdmission, undefined, 'nothing is recorded for the forward');
        assert.throws(() => privateForwardTrustedHeadersFactory({ req, plan })({ bodyHash: sha256RawBodyHash(body), plan }),
            (error) => error.code === 'COORDINATOR_HOP_UNAVAILABLE', 'and no forward can be signed');
    }
    // The generic delegation verifier still accepts a long grant elsewhere (no jti is consumed either).
    const long = grant({ ttlSeconds: 3600 });
    const generic = verifyUserDelegationGrant({
        signingSecret: deriveSubkey('router-user-delegation', 32), token: long,
        expectedSourceAgentId: COORDINATOR, expectedTargetAgentId: PROVIDER, expectedTool: COORDINATOR_ADMISSION_TOOL,
    });
    assert.equal(generic.claims.exp - generic.claims.iat, 3600);
});

test('a provider cannot declare its own /mcp endpoint as a coordinator route', () => {
    const declare = (path) => validateExecutionProviderDeclaration({
        version: 1, port: 7300, taskReferences: { path: '/x/task-refs' },
        coordinatorRoutes: [{ path, callers: [COORDINATOR] }],
    }, { routeKey: 'explorer' });
    for (const path of [`${AP}/explorer/7000/mcp`, `${AP}/explorer/7000/mcp/*`, `${AP}/explorer/7000/MCP/x`]) {
        const result = declare(path);
        assert.equal(result.ok, false, path);
        assert.match(result.reason, /\/mcp endpoint/, path);
    }
    assert.equal(declare(`${AP}/explorer/7000/api/mcp`).ok, true, 'positive control: a deeper mcp segment is an ordinary scope');
});
