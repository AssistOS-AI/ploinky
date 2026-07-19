import assert from 'node:assert';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const MASTER_KEY = '5'.repeat(64);
const fixture = createRoutingFixture();
const previousEnv = {
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTING_FILE: process.env.PLOINKY_ROUTING_FILE,
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
    PLOINKY_AUTH_EXPLORER_USERS: process.env.PLOINKY_AUTH_EXPLORER_USERS,
};

process.env.PLOINKY_WORKSPACE_ROOT = fixture.workspace;
process.env.PLOINKY_ROUTING_FILE = fixture.routingFile;
process.env.PLOINKY_MASTER_KEY = MASTER_KEY;

const [
    { createMemoryReplayCache },
    { computeRchHttp },
    { verifyRouterRequestToken },
    { deriveAgentRequestSecret },
    { applyEdgeRoutingGeneration },
] = await Promise.all([
    import('../../Agent/lib/jwtVerify.mjs'),
    import('../../Agent/lib/requestHash.mjs'),
    import('../../Agent/lib/requestSignedTokens.mjs'),
    import('../../cli/services/masterKey.js'),
    import('../../cli/services/edgeGeneration.js'),
]);
applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'ws-service-test-fixture' });

after(() => {
    restoreEnv(previousEnv);
    rmSync(fixture.workspace, { recursive: true, force: true });
});

test('resolveUpgradeTarget returns matched:false for a non-service path', async () => {
    const { resolveUpgradeTarget } = await import('../../cli/server/wsServiceProxy.js');
    const req = { method: 'GET', url: '/definitely-not-a-service/ws', headers: {} };
    const parsedUrl = new URL(req.url, 'http://router.local');
    const policy = { httpRouteAccessPolicy: { evaluate: () => ({ access: 'deny' }) } };
    const out = await resolveUpgradeTarget({ req, parsedUrl, policy });
    assert.equal(out.matched, false);
});

test('resolveUpgradeTarget rewrites authenticated service upgrades and signs router auth info', async () => {
    const { resolveUpgradeTarget } = await import('../../cli/server/wsServiceProxy.js');
    const localService = await import('../../cli/server/auth/localService.js');
    const authPolicy = { mode: 'local', usersVar: 'PLOINKY_AUTH_EXPLORER_USERS' };
    const username = `admin${process.pid}${Date.now()}`;
    localService.createLocalAuthUser({
        policy: authPolicy,
        username,
        password: 'correct horse battery staple',
        roles: ['admin'],
    });
    const login = localService.authenticateLocalUser({
        policy: authPolicy,
        username,
        password: 'correct horse battery staple',
    });

    const req = makeRequest({
        url: '/services/demo/management/ws/logs?tail=1',
        cookie: `ploinky_jwt=${login.sessionId}`,
        headers: {
            'x-ploinky-auth-info': '{"user":{"id":"spoofed"}}',
            'sec-websocket-key': 'fixture-key',
        },
    });
    req.user = { id: 'u1', roles: ['admin'] };
    const parsedUrl = new URL(req.url, 'http://router.local');
    const policy = {
        httpRouteAccessPolicy: {
            evaluate: ({ routeKey }) => ({ access: 'authenticated', routeKey }),
        },
    };

    const out = await resolveUpgradeTarget({ req, parsedUrl, policy });

    assert.equal(out.matched, true);
    assert.equal(out.ok, true);
    assert.equal(out.hostPort, fixture.hostPort);
    assert.equal(out.upstreamPath, '/internal/management/ws/logs?tail=1');
    assert.equal(req.headers['x-ploinky-auth-info'], undefined);
    const refreshedCookies = Array.isArray(out.responseHeaders['set-cookie'])
        ? out.responseHeaders['set-cookie']
        : [out.responseHeaders['set-cookie']];
    assert.ok(refreshedCookies.some((cookie) => String(cookie).startsWith('ploinky_jwt=')));
    assert.ok(refreshedCookies.some((cookie) => String(cookie).startsWith('ploinky_browser_csrf=')));

    const authInfo = JSON.parse(out.identityHeaders['x-ploinky-auth-info']);
    assert.equal(authInfo.user.id, `local:${username}`);
    assert.equal(authInfo.user.username, username);
    assert.deepEqual(authInfo.user.roles, ['user', 'admin']);
    assert.equal(typeof authInfo.invocationToken, 'string');
    assert.deepEqual(authInfo.invocationBody, {
        method: 'GET',
        externalPath: '/services/demo/management/ws/logs',
        path: '/internal/management/ws/logs',
        search: '?tail=1',
        routeKey: 'demoService',
        bodyHash: sha256BodyHash(''),
    });

    const verified = verifyRouterRequestToken(authInfo.invocationToken, {
        secret: deriveAgentRequestSecret('agent:fixtures/demoService', { encoding: 'buffer' }),
        expectedAudience: 'agent:fixtures/demoService',
        tool: '__http_service__',
        method: authInfo.invocationBody.method,
        path: authInfo.invocationBody.path,
        rch: computeRchHttp({
            method: authInfo.invocationBody.method,
            path: authInfo.invocationBody.path,
            query: authInfo.invocationBody.search,
            bodyHash: authInfo.invocationBody.bodyHash,
        }),
        replayCache: createMemoryReplayCache(),
    });
    assert.equal(verified.payload.typ, 'router-request');
    assert.equal(verified.payload.sub, `user:local:${username}`);
});

test('agent-root WebSocket upgrades use the same host plan and replace client credentials with Router identity', async () => {
    const { resolveUpgradeTarget } = await import('../../cli/server/wsServiceProxy.js');
    const localService = await import('../../cli/server/auth/localService.js');
    const authPolicy = { mode: 'local', usersVar: 'PLOINKY_AUTH_EXPLORER_USERS' };
    const username = `rootws${process.pid}${Date.now()}`;
    localService.createLocalAuthUser({
        policy: authPolicy,
        username,
        password: 'correct horse battery staple',
        roles: ['user'],
    });
    const login = localService.authenticateLocalUser({
        policy: authPolicy,
        username,
        password: 'correct horse battery staple',
    });
    const req = makeRequest({
        url: '/explorer/socket?transport=websocket',
        cookie: `ploinky_jwt=${login.sessionId}; attacker_cookie=forward-me`,
        headers: {
            authorization: 'Bearer attacker-controlled',
            'x-ploinky-auth-info': '{"user":{"id":"spoofed"}}',
            'x-ploinky-user-id': 'spoofed',
            'sec-websocket-key': 'fixture-agent-root-key',
        },
    });

    const out = await resolveUpgradeTarget({
        req,
        parsedUrl: new URL(req.url, 'http://localhost'),
    });

    assert.equal(out.matched, true);
    assert.equal(out.ok, true);
    assert.equal(out.routePlan.kind, 'agent-root');
    assert.equal(out.hostPort, 55289);
    assert.equal(out.upstreamPath, '/socket?transport=websocket');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers['x-ploinky-auth-info'], undefined);
    assert.equal(req.headers['x-ploinky-user-id'], undefined);
    assert.equal(out.identityHeaders['X-Ploinky-User-Id'], `local:${username}`);
    assert.equal(out.identityHeaders['X-Ploinky-User'], username);
    assert.equal(out.identityHeaders.Authorization, undefined);
});

test('guest WebSocket upgrades receive the same spoof-proof transport-source partition as HTTP', async () => {
    const { resolveUpgradeTarget } = await import('../../cli/server/wsServiceProxy.js');
    const req = makeRequest({
        url: '/public-services/demo-telemetry/socket',
        headers: {
            'x-ploinky-rate-source': 'f'.repeat(64),
            'cf-connecting-ip': '198.51.100.77',
            'sec-websocket-key': 'fixture-key',
        },
    });
    req.socket.remoteAddress = '::ffff:192.0.2.61';
    const parsedUrl = new URL(req.url, 'http://localhost');

    const out = await resolveUpgradeTarget({ req, parsedUrl });

    assert.equal(out.matched, true);
    assert.equal(out.ok, true);
    assert.equal(out.hostPort, fixture.hostPort);
    assert.equal(out.upstreamPath, '/telemetry/socket');
    assert.match(out.identityHeaders['x-ploinky-rate-source'] || '', /^[a-f0-9]{64}$/);
    assert.notEqual(out.identityHeaders['x-ploinky-rate-source'], 'f'.repeat(64));
    assert.equal(out.identityHeaders['x-ploinky-auth-info'], undefined);
    assert.equal(req.headers['x-ploinky-rate-source'], undefined);
    assert.equal(req.headers['cf-connecting-ip'], undefined);
});

function createRoutingFixture() {
    const workspace = mkdtempSync(join(tmpdir(), 'ploinky-ws-service-'));
    const ploinkyDir = join(workspace, '.ploinky');
    const explorerManifestDir = join(ploinkyDir, 'repos', 'fixtures', 'explorer');
    const serviceManifestDir = join(ploinkyDir, 'repos', 'fixtures', 'demoService');
    const edgeDir = join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = join(ploinkyDir, 'data', 'router-security');
    const routingFile = join(ploinkyDir, 'routing.json');
    const hostPort = 41234;

    mkdirSync(explorerManifestDir, { recursive: true });
    mkdirSync(serviceManifestDir, { recursive: true });
    mkdirSync(edgeDir, { recursive: true });
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(explorerManifestDir, 'manifest.json'), JSON.stringify({ about: 'Explorer' }, null, 2));
    writeFileSync(join(serviceManifestDir, 'manifest.json'), JSON.stringify({
        httpServices: [{
            slug: 'demo',
            externalPrefix: '/services/demo/',
            internalPrefix: '/internal/',
            access: 'authenticated',
        }, {
            slug: 'demo-telemetry',
            externalPrefix: '/public-services/demo-telemetry/',
            internalPrefix: '/telemetry/',
            access: 'guest',
            includeAuthInfo: false,
            issueInvocation: false,
        }],
    }, null, 2));
    writeFileSync(join(ploinkyDir, 'agents.json'), JSON.stringify({
        explorer: {
            type: 'agent',
            agentName: 'explorer',
            repoName: 'fixtures',
            instanceId: 'explorer-instance',
            enableGeneration: 'explorer-enable-generation',
            auth: { mode: 'local', usersVar: 'PLOINKY_AUTH_EXPLORER_USERS' },
        },
        demoService: {
            type: 'agent',
            agentName: 'demoService',
            repoName: 'fixtures',
            instanceId: 'demo-service-instance',
            enableGeneration: 'demo-service-enable-generation',
            auth: { mode: 'none' },
        },
    }, null, 2));
    writeFileSync(routingFile, JSON.stringify({
        routes: {
            explorer: {
                agent: 'explorer',
                repo: 'fixtures',
                container: 'explorer',
                hostPort: 55289,
                hostPath: explorerManifestDir,
            },
            demoService: {
                agent: 'demoService',
                repo: 'fixtures',
                container: 'demoService',
                hostPort,
                hostPath: serviceManifestDir,
            },
        },
        static: {
            agent: 'explorer',
            hostPath: explorerManifestDir,
        },
    }, null, 2));
    writeFileSync(join(edgeDir, 'desired.json'), JSON.stringify({
        schemaVersion: 1,
        hosts: {},
        security: {
            hostNetworkAllowedInstances: [],
            internalServiceConsumers: {},
        },
    }, null, 2));
    writeFileSync(join(policyDir, 'policy-state.json'), JSON.stringify({
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    }, null, 2));

    return { workspace, routingFile, hostPort };
}

function makeRequest({ method = 'GET', url, cookie = '', headers = {} }) {
    return {
        method,
        url,
        headers: {
            accept: 'application/json',
            host: 'localhost',
            ...headers,
            ...(cookie ? { cookie } : {}),
        },
        socket: { encrypted: false, remoteAddress: '127.0.0.1' },
    };
}

function restoreEnv(snapshot) {
    for (const [name, value] of Object.entries(snapshot)) {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
}

function sha256BodyHash(body) {
    return crypto.createHash('sha256').update(Buffer.from(body)).digest('base64url');
}
