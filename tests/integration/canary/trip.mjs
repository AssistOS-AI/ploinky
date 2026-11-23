import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import '../../helpers/agentlibTestContract.mjs';
import { copyRecord, fixtureSessions, fixtureWorkspace, guarded, listen, rolloutId, routeKey,
    writeCanaryFixture } from './loopbackFixture.mjs';

test('five canary HTTP 500 responses trip once and return the tester to the old copy', { timeout: 30_000 }, async t => {
    const root = fixtureWorkspace(t, 'canary-trip-');
    const identities = {};
    let canaryStatusCode = 200;
    for (const [index, copy] of ['old', 'canary'].entries()) {
        const server = http.createServer((req, res) => {
            res.writeHead(copy === 'old' ? 200 : canaryStatusCode).end(copy);
        });
        identities[copy] = copyRecord(copy, index, randomUUID(), await listen(t, server));
    }
    const { state } = writeCanaryFixture(root, identities);
    const edge = await import('../../../cli/sandbox/edgeGeneration.js');
    edge.applyEdgeRoutingGeneration({ workspaceRoot: root, publicationState: 'ready', reason: 'canary-trip-test' });
    const { generation } = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: root });
    const { canarySignals, canaryStatus, observeCanarySnapshot } = await import('../../../cli/server/canary/routerSignals.js');
    canarySignals.setProbe(null);
    observeCanarySnapshot(generation);
    assert.equal(canarySignals.resume(routeKey, rolloutId), true);

    const { cookies } = await fixtureSessions(t);
    const { resolveEdgeRoutePlan, httpAccessForEdgeRoutePlan } = await import('../../../cli/server/edgeRoutePlan.js');
    const { ensureHttpRouteAccess, buildIdentityHeaders } = await import('../../../cli/server/authHandlers/authContext.js');
    const { dispatchAgentRootHttp } = await import('../../../cli/server/proxy/executeHttpPlan.js');
    const router = http.createServer(guarded(async (req, res) => {
        const plan = resolveEdgeRoutePlan({ req });
        assert.ok(plan.ok, plan.code);
        const access = await ensureHttpRouteAccess(req, res, plan.parsedUrl, httpAccessForEdgeRoutePlan(plan), { routePlan: plan });
        if (access.ok) await dispatchAgentRootHttp({ req, res, plan, headersForSelection: () => buildIdentityHeaders(req) });
    }));
    const port = await listen(t, router);
    async function expectReply(cookie, status, copy) {
        const response = await fetch('http://127.0.0.1:' + port + '/service/private/page', { headers: { cookie } });
        assert.deepEqual([response.status, await response.text()], [status, copy]);
    }
    await expectReply(cookies.reader, 200, 'old');
    await expectReply(cookies.tester, 200, 'canary');
    canaryStatusCode = 500;
    for (let i = 0; i < 5; i++) await expectReply(cookies.tester, 500, 'canary');
    await expectReply(cookies.tester, 200, 'old');

    const { runCanaryCommand } = await import('../../../cli/commands/canaryCommand.js');
    let stdout = '';
    await runCanaryCommand(['status', 'fixture/service', '--json'], {
        client: { async json(method, endpoint) {
            assert.deepEqual([method, endpoint], ['GET', '/api/router/canary/status']);
            return canaryStatus(generation.routing.routes);
        } },
        output: { write(chunk) { stdout += chunk; } },
    });
    const row = JSON.parse(stdout);
    assert.equal(row.rolloutId, rolloutId);
    assert.equal(row.state, 'tripped');
    assert.equal(row.lastTripReason, 'server-errors');
    assert.equal(row.counts.canary.window.backendFailures, 5);
    assert.equal(row.counts.old.window.backendFailures, 0);

    const { flushPendingLogs } = await import('../../../cli/server/utils/logger.js');
    await flushPendingLogs();
    const lines = fs.readFileSync(path.join(state, 'logs/router.log'), 'utf8').trimEnd().split('\n');
    const trips = lines.filter(line => line.includes('canary_trip')).map(line => JSON.parse(line));
    assert.equal(trips.length, 1);
    const [trip] = trips;
    assert.deepEqual([trip.type, trip.routeKey, trip.rolloutId, trip.reason], ['canary_trip', routeKey, rolloutId, 'server-errors']);
});
