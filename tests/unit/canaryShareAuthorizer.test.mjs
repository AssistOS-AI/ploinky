import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { copyRecord, fixtureWorkspace, guarded, json, listen, write, writeCanaryFixture } from '../integration/canary/loopbackFixture.mjs';

test('share approval signs for the admitted account’s copy, including after the primary port is withdrawn', async t => {
    const root = fixtureWorkspace(t, 'share-copies-');
    const { applyEdgeRoutingGeneration } = await import('../../cli/sandbox/edgeGeneration.js');
    const { HttpShareAuthorizer } = await import('../../cli/server/policy/HttpShareAuthorizer.js');
    const { deriveAgentRequestSecret } = await import('../../cli/utils/security/masterKey.js');
    const { verifyRouterRequestFromHeaders } = await import('../../Agent/lib/invocationAuth.mjs');
    const { computeRch } = await import('../../Agent/lib/requestHash.mjs');
    const { createMemoryReplayCache } = await import('../../Agent/lib/jwtVerify.mjs');
    const principal = 'agent:fixture/service';
    const identities = {};
    const received = [];
    for (const [index, copy] of ['old', 'canary'].entries()) {
        const launchId = copy + '-launch';
        const env = { PLOINKY_AGENT_ID: principal, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(principal), PLOINKY_LAUNCH_ID: launchId };
        const replayCache = createMemoryReplayCache();
        const port = await listen(t, http.createServer(guarded(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks));
            const verified = verifyRouterRequestFromHeaders(req.headers, {
                env, replayCache, method: 'POST', path: req.url, tool: '__public_route_share__', rch: computeRch(body),
            });
            received.push([copy, body.user.id, verified.ok]);
            json(res, 200, { allowed: verified.ok });
        })));
        identities[copy] = copyRecord(copy, index, launchId, port);
    }
    const { state, route } = writeCanaryFixture(root, identities);
    const apply = () => applyEdgeRoutingGeneration({ workspaceRoot: root, reason: 'share-test' });
    apply();
    const authorizer = new HttpShareAuthorizer();
    const authorize = async id => assert.equal((await authorizer.authorize({
        agentName: 'service', normalizedPath: '/service/shared', user: { id, roles: ['user'] },
    })).allowed, true);
    await authorize('tester');
    await authorize('reader');
    route.canary.mode = 'all';
    route.draining = true;
    delete route.hostPort;
    write(path.join(state, 'routing.json'), { routes: { service: route } });
    apply();
    await authorize('reader');
    assert.deepEqual(received, [['canary', 'tester', true], ['old', 'reader', true], ['canary', 'reader', true]]);
});
