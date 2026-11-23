import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fixtureWorkspace, guarded, json, listen } from '../integration/canary/loopbackFixture.mjs';

const workspace = fixtureWorkspace(test, 'canary-mcp-routing-');

test('delegated task status without secure wire strips the caller proof and refuses a canary route', async t => {
    const previous = process.env.PLOINKY_SECURE_WIRE;
    process.env.PLOINKY_SECURE_WIRE = 'off';
    t.after(() => {
        if (previous === undefined) delete process.env.PLOINKY_SECURE_WIRE;
        else process.env.PLOINKY_SECURE_WIRE = previous;
    });
    const { delegatedTaskStatusHeaders } = await import('../../cli/server/mcp-proxy/index.js');
    const { dispatchAgentRootHttp } = await import('../../cli/server/proxy/executeHttpPlan.js');
    let dials = 0;
    const port = await listen(t, http.createServer((req, res) => {
        dials++;
        json(res, 200, { hasAuthorization: 'authorization' in req.headers });
    }));
    const route = { container: 'primary', hostPort: port };
    const snapshot = { routing: { routes: { service: route } }, agents: {} };
    const taskId = '0123456789abcdef';
    const plan = { ok: true, route, routeKey: 'service', snapshot, upstreamPath: '/task?taskId=' + taskId,
        lease: { commit: () => true, snapshot } };
    const router = await listen(t, http.createServer(guarded(async (req, res) => {
        req.delegatedAgentVerified = { callerPrincipal: 'agent:fixture/caller' };
        await dispatchAgentRootHttp({ req, res, plan, taskId, headersForSelection: selection => delegatedTaskStatusHeaders({
            req, agentName: 'service', selection, snapshot, taskId, path: '/task',
        }) });
    })));
    const request = () => fetch('http://127.0.0.1:' + router + plan.upstreamPath, { headers: { authorization: 'Bearer synthetic' } });
    const ordinary = await request();
    assert.equal(ordinary.status, 200);
    assert.deepEqual(await ordinary.json(), { hasAuthorization: false });
    route.canary = { rolloutId: 'r1', mode: 'split' };
    const refused = await request();
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).code, 'CANARY_TASK_INVOCATION_UNAVAILABLE');
    process.env.PLOINKY_SECURE_WIRE = 'on';
    const mintFailure = await request();
    assert.equal(mintFailure.status, 503);
    assert.equal((await mintFailure.json()).code, 'CANARY_TASK_INVOCATION_UNAVAILABLE');
    assert.equal(dials, 1);
});

test('an unavailable split target does not hide a healthy MCP agent or agent card', async t => {
    const { createAgentRouteEntries } = await import('../../cli/server/routerHandlers.js');
    const { selectAgentCardCandidates, requestAgentCard } = await import('../../cli/server/agentCardFanout.js');
    const port = await listen(t, http.createServer((_req, res) => json(res, 200, { agent: 'healthy' })));
    const routes = {
        broken: { container: 'primary', hostPort: port, canary: {
            rolloutId: 'r', mode: 'split', testAccounts: ['tester'], container: 'missing',
        } },
        healthy: { hostPort: port },
    };
    const plan = { lease: { snapshot: { routing: { routes }, agents: {} }, commit: () => true } };
    const req = { user: { id: 'tester' } };
    const entries = createAgentRouteEntries(plan, { req });
    assert.deepEqual(entries.map(entry => entry.agentName), ['healthy']);
    const cards = selectAgentCardCandidates(plan, req);
    assert.deepEqual(cards.map(card => card.agentName), ['healthy']);
    const [card] = cards;
    const result = await requestAgentCard(card.selection.route, card.agentName, {}, { beforeDial: plan.lease.commit });
    assert.deepEqual(result.agent.payload, { agent: 'healthy' });
    const { flushPendingLogs } = await import('../../cli/server/utils/logger.js');
    await flushPendingLogs();
    const log = await readFile(path.join(workspace, '.ploinky/logs/router.log'), 'utf8');
    const skipped = log.trim().split('\n').map(line => JSON.parse(line)).filter(record => record.type === 'fanout_route_unavailable');
    assert.deepEqual(skipped.map(record => [record.routeKey, record.code]), Array(2).fill(['broken', 'CANARY_TARGET_UNAVAILABLE']));
});

test('aggregate MCP pins both items to one copy and still checks the lease before each dispatch', async t => {
    const { handleRouterMcp } = await import('../../cli/server/routerHandlers.js');
    const { setRoutingSignals } = await import('../../cli/server/canary/routeAdmission.mjs');
    let state = 'split';
    let churn = false;
    let version = 0;
    setRoutingSignals({ routingState: () => ({ state, exposureVersion: churn ? ++version : version }) });
    t.after(() => setRoutingSignals(undefined));
    const dials = [];
    let leaseValid = true;
    let invalidateLease = false;
    async function backend(copy) {
        return listen(t, http.createServer(guarded(async (req, res) => {
            if (req.method === 'DELETE') return res.writeHead(204).end();
            if (req.method === 'GET') return res.writeHead(405).end();
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const rpc = JSON.parse(Buffer.concat(chunks));
            if (rpc.method === 'notifications/initialized') return res.writeHead(202).end();
            if (rpc.method === 'initialize') {
                return json(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: rpc.params.protocolVersion,
                    capabilities: {}, serverInfo: { name: copy, version: '1' } } }, { 'mcp-session-id': copy });
            }
            assert.equal(rpc.method, 'ping');
            dials.push(copy);
            state = 'tripped';
            if (invalidateLease) leaseValid = false;
            return json(res, 200, { jsonrpc: '2.0', id: rpc.id, result: {} });
        })));
    }
    const primary = await backend('primary');
    const candidate = await backend('candidate');
    const route = { container: 'primary', hostPort: primary, canary: {
        mode: 'split', rolloutId: 'batch', testAccounts: ['tester'], container: 'candidate', codePath: 'export',
    } };
    const snapshot = { routing: { routes: { service: route } }, agents: { candidate: { canaryOf: 'service', hostPort: candidate } } };
    const router = await listen(t, http.createServer((req, res) => {
        Object.assign(req, { user: { id: 'tester' }, authMode: 'sso', sessionId: 'fixture' });
        return handleRouterMcp(req, res, { lease: { snapshot, commit: () => leaseValid } });
    }));
    const rpc = (id, method) => ({ jsonrpc: '2.0', id, method, params: { agent: 'service' } });
    async function request(body, sessionId) {
        return fetch('http://127.0.0.1:' + router + '/mcp', { method: 'POST', body: JSON.stringify(body),
            headers: { 'content-type': 'application/json', ...(sessionId && { 'mcp-session-id': sessionId }) } });
    }
    const initialized = await request(rpc(1, 'initialize'));
    const sessionId = initialized.headers.get('mcp-session-id');
    assert.ok(sessionId);
    const batch = [rpc(2, 'ping'), rpc(3, 'ping')];
    const response = await request(batch, sessionId);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).map(item => item.result), [{}, {}]);
    assert.deepEqual(dials, ['candidate', 'candidate']);
    await request(rpc(4, 'ping'), sessionId);
    assert.deepEqual(dials, ['candidate', 'candidate', 'primary']);

    state = 'split';
    invalidateLease = true;
    const stale = await request(batch, sessionId);
    const [accepted, refused] = await stale.json();
    assert.deepEqual(accepted.result, {});
    assert.match(refused.error.message, /edge_generation_changed/);
    assert.deepEqual(dials, ['candidate', 'candidate', 'primary', 'candidate']);

    leaseValid = true;
    churn = true;
    const changed = await request(batch, sessionId);
    assert.equal(changed.status, 503);
    assert.equal((await changed.json()).error, 'canary_selection_changed');
    assert.equal(dials.length, 4);
});
