import assert from 'node:assert/strict';
import test from 'node:test';

import { signPrivateRouterAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { derivePrivateAgentRequestSecret } from '../../cli/utils/security/masterKey.js';
import { authorizePrivateRoutePlan, sendPrivateError } from '../../cli/server/privateRouter.js';

// These tests exercise the module's default private-Router replay cache, with no
// injection, and import only names that exist before the change. The cache is
// shared by every test in this file, so each test uses its own enabled callers
// and its own mocked time, far enough apart that earlier entries have expired.

const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
test.after(() => {
    if (previousMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousMasterKey;
});

const T0 = Math.floor(Date.now() / 1000) * 1000;
const FLOOD_LIMIT = 40000;
const BODY = Buffer.from('{"value":1}');

const ROUTE_PATH = '/base-agent-additional-server/target/7000/private/items';

function enabledAgent(name) {
    return Object.freeze({
        name,
        agentId: `agent:fixtures/${name}`,
        instanceId: `${name}-instance`,
        enableGeneration: `${name}-generation`,
    });
}

const AGENTS = Object.freeze({
    alpha: enabledAgent('alpha'),
    beta: enabledAgent('beta'),
    gamma: enabledAgent('gamma'),
    delta: enabledAgent('delta'),
});

function snapshot() {
    const agents = {};
    for (const agent of Object.values(AGENTS)) {
        agents[`${agent.name}-container`] = {
            type: 'agent',
            repoName: 'fixtures',
            agentName: agent.name,
            instanceId: agent.instanceId,
            enableGeneration: agent.enableGeneration,
        };
    }
    return { agents, compiled: { security: {} } };
}

function privateRoutePlan() {
    return {
        ok: true,
        listener: 'private',
        kind: 'agent-port',
        routeKey: 'target',
        pathname: ROUTE_PATH,
        parsedUrl: new URL(`http://host.containers.internal${ROUTE_PATH}?view=full`),
        access: { access: 'authenticated' },
        snapshot: snapshot(),
    };
}

const signingEnv = new Map();
function envFor(agent) {
    if (!signingEnv.has(agent.agentId)) {
        signingEnv.set(agent.agentId, {
            PLOINKY_AGENT_ID: agent.agentId,
            PLOINKY_AGENT_INSTANCE_ID: agent.instanceId,
            PLOINKY_AGENT_ENABLE_GENERATION: agent.enableGeneration,
            PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(
                agent.agentId,
                agent.instanceId,
                agent.enableGeneration,
            ),
        });
    }
    return signingEnv.get(agent.agentId);
}

function sign(agent, plan) {
    return signPrivateRouterAssertion({
        method: 'POST',
        path: plan.pathname,
        query: plan.parsedUrl.search,
        body: BODY,
        env: envFor(agent),
    });
}

// A successful verification deletes the assertion header, so every
// presentation gets a fresh request object.
function present(token, plan) {
    return authorizePrivateRoutePlan({
        req: { method: 'POST', headers: { 'ploinky-agent-assertion': token } },
        plan,
        body: BODY,
    });
}

function admit(agent, plan) {
    return present(sign(agent, plan), plan);
}

function floodUntilRefused(agent, plan) {
    for (let index = 0; index < FLOOD_LIMIT; index += 1) {
        try {
            admit(agent, plan);
        } catch (error) {
            return error;
        }
    }
    return null;
}

function mockResponse() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers;
        },
        end(chunk) {
            if (chunk) this.body += Buffer.from(chunk).toString('utf8');
        },
    };
}

test('a private assertion replayed 5 s after exp is refused', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const plan = privateRoutePlan();
    const token = sign(AGENTS.delta, plan);
    assert.equal(present(token, plan).agentId, AGENTS.delta.agentId);
    t.mock.timers.tick(35_000);
    assert.throws(() => present(token, plan), /already been consumed/);
});

test('caller A exhausting its replay quota is refused with 429 while caller B is still admitted', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 + 600_000 });
    const plan = privateRoutePlan();
    assert.equal(admit(AGENTS.beta, plan).agentId, AGENTS.beta.agentId);
    assert.equal(admit(AGENTS.alpha, plan).agentId, AGENTS.alpha.agentId);

    const refusal = floodUntilRefused(AGENTS.alpha, plan);
    assert.ok(refusal, 'caller A was never refused within 40000 assertions');
    assert.equal(refusal.status, 429);
    assert.equal(refusal.code, 'PLOINKY_REPLAY_QUOTA_EXHAUSTED');

    const res = mockResponse();
    sendPrivateError(res, refusal);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body, '{"ok":false,"error":"PLOINKY_REPLAY_QUOTA_EXHAUSTED"}');

    const bystander = admit(AGENTS.beta, plan);
    assert.equal(bystander.agentId, AGENTS.beta.agentId);
    assert.equal(bystander.instanceId, AGENTS.beta.instanceId);
});

test('a flood from caller A cannot evict A\'s live jti', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 + 1_200_000 });
    const plan = privateRoutePlan();
    const first = sign(AGENTS.gamma, plan);
    assert.equal(present(first, plan).agentId, AGENTS.gamma.agentId);
    floodUntilRefused(AGENTS.gamma, plan);
    assert.throws(() => present(first, plan), /already been consumed/);
});
