import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { signAgentHttpAssertion } from '../../Agent/lib/agentAssertion.mjs';
import {
    OPENAI_CHAT_COMPLETIONS_PATH,
    OPENAI_CHAT_COMPLETIONS_TOOL,
    verifyHttpRouteAuthInfoFromHeaders,
    verifyOpenAiServiceAuthInfoFromHeaders,
    verifyRouterRequestFromHeaders,
} from '../../Agent/lib/invocationAuth.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { computeRch, computeRchTool } from '../../Agent/lib/requestHash.mjs';

const cwd = process.cwd();
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-launch-binding-'));
const original = { PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY, PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT };
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = randomBytes(32).toString('hex');
test.after(() => {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

const { buildRouterRequest, resolveRouteTargetRecord } = await import('../../cli/server/mcp-proxy/invocationMinter.js');
const { buildInvocationContextForProviderCall } = await import('../../cli/server/mcp-proxy/index.js');
const { serializeWebchatEnvelopeForAgent } = await import('../../cli/server/handlers/webchat/messageEnvelope.js');
const { verifyAndMintAgentOpenAiCall } = await import('../../cli/server/agentOpenAiDelegation.js');
const { HttpShareAuthorizer } = await import('../../cli/server/policy/HttpShareAuthorizer.js');
const { applyEdgeRoutingGeneration, captureEdgeRoutingLease, __testables: generationCache } = await import('../../cli/sandbox/edgeGeneration.js');
const { loadActiveRoutingState } = await import('../../cli/server/routingState.js');
const { buildHttpRouteAuthInfoHeader } = await import('../../cli/server/routerHandlers.js');
const { buildAgentLaunchEnv, stripReservedAgentEnv, verifyRegisteredLaunchId } = await import('../../cli/utils/security/agentIdentityEnv.js');
const { deriveAgentRequestSecret } = await import('../../cli/utils/security/masterKey.js');
const { computeAgentEnvHash } = await import('../../cli/sandbox/docker/agentServiceManager.js');

const targetAgentId = 'agent:fixture/service';
const receiver = { PLOINKY_AGENT_ID: targetAgentId, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(targetAgentId) };
const surface = { method: 'POST', path: '/mcp', tool: 'lookup' };
const request = { ...surface, targetAgentId, rch: computeRchTool({ ...surface, arguments: {} }) };
const legacy = { type: 'agent', repoName: 'fixture', agentName: 'service', instanceId: 'instance', enableGeneration: 'generation' };

function verify(token, launchId) {
    return verifyRouterRequestFromHeaders({ authorization: `Bearer ${token}` }, {
        ...request, env: { ...receiver, PLOINKY_LAUNCH_ID: launchId }, replayCache: createMemoryReplayCache(),
    });
}

test('the signed launch ID distinguishes copies and replacements with the same tuple and secret', () => {
    const first = { ...legacy, launchId: buildAgentLaunchEnv().PLOINKY_LAUNCH_ID };
    const canary = { ...first, instanceId: 'canary-instance', launchId: buildAgentLaunchEnv().PLOINKY_LAUNCH_ID };
    const replacement = { ...first, launchId: buildAgentLaunchEnv().PLOINKY_LAUNCH_ID };
    const snapshot = { agents: { first, canary } };
    const { token, payload } = buildRouterRequest({ ...request, snapshot, targetRecord: first });
    assert.equal(payload.launchId, first.launchId);
    assert.equal(verify(token, first.launchId).ok, true);
    for (const other of [canary, replacement]) {
        assert.match(verify(token, other.launchId).reason, /launch ID mismatch/);
        const minted = buildRouterRequest({ ...request, targetRecord: other });
        assert.equal(verify(minted.token, other.launchId).ok, true);
        assert.match(verify(minted.token, first.launchId).reason, /launch ID mismatch/);
    }
    assert.throws(() => buildRouterRequest({ ...request, snapshot }), /selected target record required/);
});

test('launch-aware receivers require the claim and older receivers accept both valid token forms', () => {
    const launchId = buildAgentLaunchEnv().PLOINKY_LAUNCH_ID;
    const old = buildRouterRequest({ ...request, targetRecord: legacy });
    assert.equal(Object.hasOwn(old.payload, 'launchId'), false);
    assert.match(verify(old.token, launchId).reason, /launch ID mismatch/);
    assert.match(verify(old.token, '').reason, /launch ID mismatch/);
    assert.equal(verify(old.token).ok, true);
    const current = buildRouterRequest({ ...request, snapshot: { agents: { only: { ...legacy, launchId } } } });
    assert.equal(verify(current.token, launchId).ok, true);
    assert.equal(verify(current.token).ok, true);
});

test('adoption requires agreement between the registry, the inspected container and its managed descriptor', () => {
    const { PLOINKY_LAUNCH_ID: id } = buildAgentLaunchEnv();
    const env = [`PLOINKY_LAUNCH_ID=${id}`];
    assert.doesNotThrow(() => verifyRegisteredLaunchId(id, env, id));
    assert.doesNotThrow(() => verifyRegisteredLaunchId(undefined, [], 'legacy-descriptor'));
    for (const [recordId, actualEnv, descriptorId] of [
        [id, [], id], [undefined, env, id], [id, env, 'replacement'], [id, [...env, ...env], id],
        [id, ['PLOINKY_LAUNCH_ID=replacement'], id],
    ]) {
        assert.throws(() => verifyRegisteredLaunchId(recordId, actualEnv, descriptorId), /launch binding/);
    }
});

test('HTTP route auth-info uses the container selected for the request among identical principals', () => {
    const first = { ...legacy, launchId: 'first' };
    const second = { ...legacy, launchId: 'second' };
    const route = { repo: 'fixture', agent: 'service', container: 'second' };
    const sign = currentRoute => buildHttpRouteAuthInfoHeader(
        { method: 'GET', user: { id: 'reader' } },
        new URL('http://example.invalid/page'),
        { includeAuthInfo: true, issueInvocation: true, route, routeKey: 'service' },
        { snapshot: { agents: { first, second }, routing: { routes: { service: currentRoute } } } },
    );
    assert.throws(() => sign({ ...route }), /selected route generation changed/);
    const headers = sign(route);
    const options = { method: 'GET', path: '/page', env: { ...receiver, PLOINKY_LAUNCH_ID: first.launchId } };
    assert.match(verifyHttpRouteAuthInfoFromHeaders(headers, options).reason, /launch ID mismatch/);
    const verified = verifyHttpRouteAuthInfoFromHeaders(headers, {
        ...options, replayCache: createMemoryReplayCache(), env: { ...receiver, PLOINKY_LAUNCH_ID: second.launchId },
    });
    assert.equal(verified.ok, true, verified.reason);
});

test('the adoption hash excludes the generated launch ID but retains ordinary env changes', () => {
    const first = buildAgentLaunchEnv();
    const next = buildAgentLaunchEnv();
    assert.notEqual(first.PLOINKY_LAUNCH_ID, next.PLOINKY_LAUNCH_ID);
    assert.deepEqual(stripReservedAgentEnv({ ...first, KEEP: 'x' }), { KEEP: 'x' });
    const hash = env => computeAgentEnvHash({}, {}, {
        agentName: 'service', repoName: 'fixture', runtimeNetworkPlan: { hashEnv: {} }, runtimeRouterEnv: env,
    });
    assert.match(hash(first), /^[0-9a-f]{64}$/);
    assert.equal(hash(first), hash(next));
    assert.equal(hash(first), hash({}));
    assert.notEqual(hash(first), hash({ ...next, KEEP: 'x' }));
    const configured = computeAgentEnvHash({ expose: first }, {}, {
        agentName: 'service', repoName: 'fixture', runtimeNetworkPlan: { hashEnv: {} },
    });
    assert.equal(configured, hash({}));
});

function activateRoute(hostPort, selectedId = 'selected') {
    const hostPath = path.join(workspace, 'fixture', 'service');
    const route = { repo: 'fixture', agent: 'service', container: 'selected', hostPort, hostPath };
    const state = path.join(workspace, '.ploinky');
    for (const [file, data] of [
        [path.join(hostPath, 'manifest.json'), {}],
        [path.join(state, 'routing.json'), { routes: { service: route } }],
        [path.join(state, 'agents.json'), {
            alternate: { ...legacy, launchId: 'alternate' },
            selected: { ...legacy, launchId: selectedId },
        }],
        [path.join(state, 'data/edge-routing/desired.json'), { hosts: {} }],
        [path.join(state, 'data/router-security/policy-state.json'), { schema: 'router-policy', httpRoutes: [], mcpTools: [] }],
    ]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data));
    }
    applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'canary-launch-binding-test' });
    return loadActiveRoutingState().routing.routes.service;
}

const callerId = 'agent:fixture/caller';
const user = { id: 'reader', roles: ['user'] };

test('both MCP invocation branches bind their token to the routed container', () => {
    const route = activateRoute(7400);
    const mint = req => buildInvocationContextForProviderCall({
        req, route, agentName: 'service', toolName: surface.tool, toolArgs: {},
    });
    for (const req of [{ user }, { delegatedAgentVerified: { callerPrincipal: callerId } }]) {
        const { token } = mint(req);
        const result = verify(token, 'selected');
        assert.equal(result.ok, true, result.reason);
        assert.equal(result.payload.sub, req.user ? 'user:reader' : callerId);
        assert.match(verify(token, 'alternate').reason, /launch ID mismatch/);
    }
    activateRoute(7400, 'replacement');
    assert.throws(() => mint({ user }), /selected route generation changed/);
});

test('a route lease still signs for its container after the generation cache is cleared', () => {
    activateRoute(7400);
    const lease = captureEdgeRoutingLease();
    const route = lease.snapshot.routing.routes.service;
    generationCache.resetActiveGenerationCache();
    const reloaded = loadActiveRoutingState();
    assert.equal(reloaded.generation, lease.id);
    assert.notEqual(reloaded.routing.routes.service, route);
    const mint = () => buildInvocationContextForProviderCall({
        req: { user }, agentName: 'service', toolName: surface.tool, toolArgs: {},
        targetRecord: resolveRouteTargetRecord({
            routeKey: 'service', route, generation: lease.id, snapshot: reloaded.snapshot,
        }),
    });
    const { token } = mint();
    assert.equal(verify(token, 'selected').ok, true);
    assert.match(verify(token, 'alternate').reason, /launch ID mismatch/);
    const replacement = activateRoute(7400, 'replacement');
    assert.equal(replacement.container, route.container);
    assert.notEqual(loadActiveRoutingState().generation, lease.id);
    assert.throws(mint, /selected route generation changed/);
});

test('WebChat signs an envelope for the authorized container among copies sharing its principal', () => {
    const route = activateRoute(7400);
    const binding = {
        target: 'service', generation: loadActiveRoutingState().generation,
        targetRoute: { routeKey: 'service', container: route.container },
    };
    const serialize = webchatBinding => serializeWebchatEnvelopeForAgent({
        req: { user, edgeAuthContext: { webchatBinding } },
        effectiveConfig: { agentName: 'service' }, tabId: 'tab', pageInstanceId: 'page',
        envelope: { text: 'hello' },
    });
    const { invocation } = JSON.parse(serialize(binding));
    assert.ok(invocation?.token, 'WebChat must forward the signed invocation');
    const operation = { method: 'POST', path: '/mcp', tool: '__webchat_message__' };
    const rch = computeRchTool({ ...operation, arguments: {
        surface: 'webchat', tabId: 'tab', pageInstanceId: 'page', text: 'hello',
        attachments: [], references: [], presentation: { visible: true },
    } });
    const receive = launchId => verifyRouterRequestFromHeaders({ authorization: `Bearer ${invocation.token}` }, {
        ...operation, rch, env: { ...receiver, PLOINKY_LAUNCH_ID: launchId }, replayCache: createMemoryReplayCache(),
    });
    const accepted = receive('selected');
    assert.equal(accepted.ok, true, accepted.reason);
    assert.equal(accepted.payload.launchId, 'selected');
    assert.equal(accepted.payload.sub, 'user:reader');
    assert.match(receive('alternate').reason, /launch ID mismatch/);
    for (const targetRoute of [
        { routeKey: 'other', container: route.container },
        { routeKey: 'service', container: 'alternate' },
        { routeKey: 'service' },
    ]) {
        assert.throws(() => serialize({ ...binding, targetRoute }), /binding changed|selected route generation changed/);
    }
    activateRoute(7400, 'replacement');
    assert.match(receive('replacement').reason, /launch ID mismatch/);
    assert.throws(() => serialize(binding), /binding changed|selected route generation changed/);
});

test('delegated OpenAI signs for the current route and refuses a superseded route', () => {
    const route = activateRoute(7400);
    const body = Buffer.from('{"messages":[]}');
    const mint = () => verifyAndMintAgentOpenAiCall({
        route, routeKey: 'service', body,
        token: signAgentHttpAssertion({
            targetAgent: 'service', path: OPENAI_CHAT_COMPLETIONS_PATH, tool: OPENAI_CHAT_COMPLETIONS_TOOL, body,
            env: { PLOINKY_AGENT_ID: callerId, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(callerId) },
        }),
    });
    const minted = mint();
    assert.equal(minted.ok, true, minted.error);
    const receive = launchId => verifyOpenAiServiceAuthInfoFromHeaders(minted.authInfoHeader, {
        body, env: { ...receiver, PLOINKY_LAUNCH_ID: launchId }, replayCache: createMemoryReplayCache(),
    });
    const accepted = receive('selected');
    assert.equal(accepted.ok, true, accepted.reason);
    assert.match(receive('alternate').reason, /launch ID mismatch/);
    activateRoute(7400, 'replacement');
    assert.match(receive('replacement').reason, /launch ID mismatch/);
    assert.equal(mint().error, 'router_request_unavailable');
});

test('share authorization delivers a token bound to the owner at the selected port', async t => {
    let launchId = 'selected';
    let verification;
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        verification = verifyRouterRequestFromHeaders(req.headers, {
            method: req.method, path: req.url, tool: '__public_route_share__',
            rch: computeRch(JSON.parse(Buffer.concat(chunks).toString('utf8'))),
            env: { ...receiver, PLOINKY_LAUNCH_ID: launchId }, replayCache: createMemoryReplayCache(),
        });
        res.end(JSON.stringify({ allowed: verification.ok }));
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    activateRoute(server.address().port);
    const authorizer = new HttpShareAuthorizer();
    const authorize = () => authorizer.authorize({ agentName: 'service', normalizedPath: '/shared', user });
    assert.deepEqual(await authorize(), { allowed: true, reason: 'agent_approved' });
    launchId = 'alternate';
    assert.deepEqual(await authorize(), { allowed: false, reason: 'agent_denied' });
    assert.match(verification.reason, /launch ID mismatch/);
});
