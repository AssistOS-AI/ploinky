import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { onAuthenticatedRequestDecision } from '../../cli/server/auth/authenticatedRequestEvents.mjs';
import { dispatchAgentStartupRequest } from '../../cli/server/agentStartupDispatch.js';
import { handleAgentRootUpgrade } from '../../cli/server/wsAgentRootProxy.js';
import { mintSessionJwt, verifySessionJwt } from '../../cli/server/auth/localService.js';

export function registerAuthenticatedRequestMatrix({
    authHandlers, handleMarketplaceRoutes, authService, policy, provider, described, unavailable,
    login, request, MockResponse, controlPlan, webttyPlan, adminSurfaces,
    protectedRoute, admitWebtty, webttyManager, registerTerminal, getProviderCalls,
}) {
    function captureDecisions(t) {
        const decisions = [];
        const unsubscribe = onAuthenticatedRequestDecision(decision => decisions.push(decision));
        t.after(unsubscribe);
        return decisions;
    }

    function assertSsoDecision(decisions, roles, before) {
        assert.equal(decisions.length, 1, 'one fresh authentication publishes one decision');
        assert.equal(decisions[0].authMode, 'sso');
        assert.equal(decisions[0].userId, 'sso:admin');
        assert.deepEqual(decisions[0].roles, roles);
        assert.ok(decisions[0].decidedAt >= before && decisions[0].decidedAt <= Date.now());
        assert.deepEqual(Object.keys(decisions[0]).sort(), ['authMode', 'decidedAt', 'roles', 'userId']);
    }

    const authenticatedEntrypoints = [
        ['ordinary HTTP', '/explorer/index.html', async (req, res, routePlan) =>
            authHandlers.ensureHttpRouteAccess(req, res, new URL(req.url, 'http://localhost'),
                { access: 'authenticated', routeKey: 'explorer' }, { routePlan })],
        ['aggregate MCP', '/mcp', async (req, res, routePlan) =>
            authHandlers.ensureAuthenticated(req, res, new URL(req.url, 'http://localhost'), { routePlan })],
        ['agent MCP', '/explorer/mcp', async (req, res, routePlan) =>
            authHandlers.ensureAuthenticated(req, res, new URL(req.url, 'http://localhost'), { routePlan })],
        ['agent-port WebSocket admission', '/base-agent-additional-server/explorer/7000/ws', async (req, res, routePlan) =>
            authHandlers.ensureHttpRouteAccess(req, res, new URL(req.url, 'http://localhost'),
                { access: 'authenticated', routeKey: 'explorer' }, { routePlan: { ...routePlan, kind: 'agent-port', transport: 'websocket' } })],
    ];

    for (const [label, url, admit] of authenticatedEntrypoints) {
        test(`${label} publishes the real provider's fresh full-role decision exactly once`, async t => {
            const decisions = captureDecisions(t);
            const sessionId = await login();
            provider(providerSession => described(providerSession, []));
            const req = request({ url, cookie: `ploinky_sso=${sessionId}` });
            const res = new MockResponse();
            const calls = getProviderCalls();
            const before = Date.now();
            const result = await admit(req, res, controlPlan());
            assert.equal(result.ok, true, res.body);
            assert.equal(getProviderCalls() - calls, 1);
            assertSsoDecision(decisions, [], before);
        });
    }

    test('the actual startup dispatcher publishes before its pending lifecycle response', async t => {
        const decisions = captureDecisions(t);
        const sessionId = await login();
        provider(providerSession => described(providerSession, ['user']));
        const req = request({ url: '/explorer/index.html', cookie: `ploinky_sso=${sessionId}`,
            headers: { accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } });
        const res = new MockResponse();
        const routePlan = { ...controlPlan(), ok: true, kind: 'agent-root-pending', routeKey: 'explorer',
            upstreamPath: '/index.html', canonicalPath: req.url, decision: { access: 'authenticated', routeKey: 'explorer' } };
        const calls = getProviderCalls();
        const before = Date.now();
        await dispatchAgentStartupRequest({ req, res, parsedUrl: new URL(req.url, 'http://localhost'), routePlan,
            inspectPublication: () => ({ ok: true, canPublishHttp: true }),
            ensureRouteAccess: authHandlers.ensureHttpRouteAccess,
            resolveStartupState: async () => {
                assertSsoDecision(decisions, ['user'], before);
                return { state: 'starting' };
            } });
        assert.equal(res.statusCode, 503);
        assert.match(res.body, /data-ploinky-agent-startup-page="starting"/);
        assert.equal(getProviderCalls() - calls, 1);
    });

    test('the actual agent-root WebSocket upgrade publishes before forwarding to the upstream', async t => {
        const decisions = captureDecisions(t);
        const sessionId = await login();
        provider(providerSession => described(providerSession, ['user']));
        const sockets = new Set();
        const target = http.createServer();
        let upstreamCalls = 0;
        target.on('upgrade', (req, socket) => {
            sockets.add(socket);
            upstreamCalls += 1;
            assert.equal(decisions.length, 1, 'publication precedes upstream upgrade');
            assert.equal(req.headers.cookie, undefined, 'the upstream receives no authentication cookie');
            socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
        });
        await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
        const router = http.createServer();
        router.on('upgrade', (req, socket, head) => {
            sockets.add(socket);
            const routePlan = { ...controlPlan(), matched: true, ok: true, kind: 'agent-root', routeKey: 'explorer',
                decision: { access: 'authenticated', routeKey: 'explorer' },
                target: { hostPort: target.address().port }, upstreamPath: '/ws' };
            void handleAgentRootUpgrade({ req, socket, head, parsedUrl: new URL(req.url, 'http://localhost'), routePlan });
        });
        t.after(async () => {
            for (const socket of sockets) socket.destroy();
            await Promise.all([new Promise(resolve => router.close(resolve)), new Promise(resolve => target.close(resolve))]);
        });
        await new Promise(resolve => router.listen(0, '127.0.0.1', resolve));
        const client = net.connect(router.address().port, '127.0.0.1');
        sockets.add(client);
        const calls = getProviderCalls();
        const before = Date.now();
        const response = new Promise((resolve, reject) => {
            client.once('data', chunk => resolve(chunk.toString()));
            client.once('error', reject);
            client.setTimeout(2000, () => reject(new Error('agent-root upgrade timed out')));
        });
        await new Promise(resolve => client.once('connect', resolve));
        client.write(['GET /explorer/ws HTTP/1.1', 'Host: localhost', 'Connection: Upgrade', 'Upgrade: websocket',
            'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${Buffer.alloc(16, 7).toString('base64')}`,
            `Cookie: ploinky_sso=${sessionId}`, '', ''].join('\r\n'));
        assert.match(await response, /^HTTP\/1\.1 101 /);
        assert.equal(upstreamCalls, 1);
        assert.equal(getProviderCalls() - calls, 1);
        assertSsoDecision(decisions, ['user'], before);
    });

    for (const [surface, , call] of adminSurfaces) {
        test(`${surface} publishes a fresh non-admin decision before its existing response`, async t => {
            const decisions = captureDecisions(t);
            const sessionId = await login();
            provider(providerSession => described(providerSession, ['user']));
            const calls = getProviderCalls();
            const before = Date.now();
            const { res } = await call(sessionId);
            assert.equal(res.statusCode, surface.includes('marketplace') ? 200 : 403, res.body);
            assert.equal(getProviderCalls() - calls, 1);
            assertSsoDecision(decisions, ['user'], before);
        });
    }

    test('/auth/token publishes the freshly validated decision and cached logout stays silent', async t => {
        const decisions = captureDecisions(t);
        const sessionId = await login();
        provider(providerSession => described(providerSession, ['user']));
        const before = Date.now();
        const req = request({ url: '/auth/token', cookie: `ploinky_sso=${sessionId}` });
        const res = new MockResponse();
        await authHandlers.handleAuthRoutes(req, res, new URL(req.url, 'http://localhost'), { routePlan: controlPlan() });
        assert.equal(res.statusCode, 200);
        assertSsoDecision(decisions, ['user'], before);
        decisions.length = 0;
        provider(() => { throw unavailable(); });
        const logout = request({ url: '/auth/logout', cookie: `ploinky_sso=${sessionId}` });
        const logoutRes = new MockResponse();
        const calls = getProviderCalls();
        await authHandlers.handleAuthRoutes(logout, logoutRes, new URL(logout.url, 'http://localhost'), { routePlan: controlPlan() });
        assert.equal(logoutRes.statusCode, 200);
        assert.equal(getProviderCalls(), calls, 'logout uses cached identity without a fresh provider decision');
        assert.deepEqual(decisions, []);
    });

    test('local CLI and local marketplace publish the signed issuance time with no provider call', async t => {
        const decisions = captureDecisions(t);
        const token = mintSessionJwt({ id: 'local:admin', username: 'operator', roles: ['admin'] }, 1, { channel: 'cli' });
        const issuedAt = verifySessionJwt(token).iat * 1000;
        const calls = getProviderCalls();
        for (const url of ['/explorer/index.html', '/api/marketplace/agents']) {
            decisions.length = 0;
            const req = request({ url, cookie: `ploinky_jwt=${token}` });
            const res = new MockResponse();
            if (url.includes('marketplace')) {
                await handleMarketplaceRoutes(req, res, new URL(url, 'http://localhost'),
                    { routePlan: controlPlan(), agentListOptions: { liveContainers: [] } });
                assert.equal(res.statusCode, 200, res.body);
            } else {
                assert.equal((await authHandlers.ensureAuthenticated(req, res, new URL(url, 'http://localhost'),
                    { routePlan: controlPlan() })).ok, true);
            }
            assert.deepEqual(decisions, [{ authMode: 'local', userId: 'local:admin', roles: ['admin'], decidedAt: issuedAt }]);
        }
        assert.equal(getProviderCalls(), calls);
    });

    test('public, guest, failed, expired and unavailable authentication publish no demotion decision', async t => {
        const decisions = captureDecisions(t);
        const publicReq = request({ url: '/explorer/public' });
        assert.equal((await authHandlers.ensureHttpRouteAccess(publicReq, new MockResponse(),
            new URL(publicReq.url, 'http://localhost'), { access: 'public', routeKey: 'explorer' })).ok, true);
        const guestReq = request({ url: '/webAssist/page' });
        assert.equal((await authHandlers.ensureHttpRouteAccess(guestReq, new MockResponse(),
            new URL(guestReq.url, 'http://localhost'), { access: 'guest', routeKey: 'webAssist' })).ok, true);
        assert.equal(guestReq.authMode, 'guest');
        for (const [behavior, status] of [
            [() => { throw unavailable(); }, 503],
            [() => { throw Object.assign(new Error('session_revoked'), { code: 'session_revoked', statusCode: 401 }); }, 401],
            [providerSession => ({ ...described(providerSession), providerSession: { ...providerSession, expiresAt: Date.now() - 1 } }), 401],
        ]) {
            const sessionId = await login();
            provider(behavior);
            const denied = await protectedRoute(sessionId);
            assert.equal(denied.res.statusCode, status);
        }
        assert.deepEqual(decisions, []);
    });

    test('real provider identities without a complete roles array publish no decision', async t => {
        const decisions = captureDecisions(t);
        for (const roles of [undefined, null, 'user', ['user', 7]]) {
            const sessionId = await login();
            provider(providerSession => {
                const outcome = described(providerSession);
                if (roles === undefined) delete outcome.user.roles;
                else outcome.user.roles = roles;
                return outcome;
            });
            const admitted = await protectedRoute(sessionId);
            assert.equal(admitted.result.ok, true, 'observation does not change the existing provider admission');
        }
        assert.deepEqual(decisions, []);
    });

    test('malformed real-provider token and policy bodies publish before existing body errors', async t => {
        const decisions = captureDecisions(t);
        const sessionId = await login();
        provider(providerSession => described(providerSession));
        for (const url of ['/auth/token', '/policy/command']) {
            decisions.length = 0;
            const req = request({ method: 'POST', url, cookie: `ploinky_sso=${sessionId}`,
                rawBody: '{ malformed', headers: { 'content-type': 'application/json' } });
            const res = new MockResponse();
            const calls = getProviderCalls();
            const before = Date.now();
            if (url === '/auth/token') {
                await authHandlers.handleAuthRoutes(req, res, new URL(url, 'http://localhost'), { routePlan: controlPlan() });
                assert.equal(JSON.parse(res.body).error, 'invalid_json');
            } else {
                await policy.commandInvoker.handle(req, res, { routePlan: controlPlan() });
                assert.equal(JSON.parse(res.body).error.code, 'UNKNOWN_COMMAND');
            }
            assert.equal(res.statusCode, 400, res.body);
            assert.equal(getProviderCalls() - calls, 1);
            assertSsoDecision(decisions, ['user', 'admin'], before);
        }
    });

    test('fresh non-admin denial closes the owner shell only when its decision subscriber is wired', async t => {
        const sessionId = await login();
        provider(providerSession => described(providerSession));
        const routePlan = webttyPlan();
        const owner = await admitWebtty({ method: 'GET', url: '/webtty', sessionId, routePlan });
        const manager = webttyManager();
        const terminal = registerTerminal(manager, owner.req, routePlan);
        terminal.owner.adminAdmittedAt = Date.now() - 1;
        let workerCloses = 0;
        terminal.worker = { close: async () => { workerCloses += 1; }, waitForExit: async () => true };
        terminal.terminalCleanupProven = true;
        terminal.releaseQuota = () => {};
        provider(providerSession => described(providerSession, ['user']));
        const deniedWithoutWiring = await adminSurfaces[0][2](sessionId);
        assert.equal(deniedWithoutWiring.res.statusCode, 403);
        assert.equal(manager.sessions.get(terminal.id), terminal);
        assert.equal(workerCloses, 0, 'negative control: fresh denied request leaves the owned shell alive without the subscriber');
        const unsubscribe = onAuthenticatedRequestDecision(decision => manager.observeAuthenticatedRequest(decision));
        t.after(unsubscribe);
        const deniedWithWiring = await adminSurfaces[0][2](sessionId);
        assert.equal(deniedWithWiring.res.statusCode, 403);
        await Promise.all([...manager.inFlightCloses]);
        assert.equal(manager.sessions.has(terminal.id), false);
        assert.equal(terminal.closeReason, 'owner_admin_revoked');
        assert.equal(workerCloses, 1, 'the fresh request reclaims the worker through the manager');
    });
}

