import assert from 'node:assert';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { computeRchHttp } from '../../Agent/lib/requestHash.mjs';
import { verifyRouterRequestToken } from '../../Agent/lib/requestSignedTokens.mjs';
import { deriveAgentRequestSecret } from '../../cli/services/masterKey.js';

const MASTER_KEY = '5'.repeat(64);
const fixture = createRoutingFixture();
const previousEnv = {
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTING_FILE: process.env.PLOINKY_ROUTING_FILE,
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
};

process.env.PLOINKY_WORKSPACE_ROOT = fixture.workspace;
process.env.PLOINKY_ROUTING_FILE = fixture.routingFile;
process.env.PLOINKY_MASTER_KEY = MASTER_KEY;

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
    const authHandlers = await import('../../cli/server/authHandlers/index.js');
    const originalIsConfigured = authHandlers.authService.isConfigured;
    const originalGetSession = authHandlers.authService.getSession;
    authHandlers.authService.isConfigured = () => true;
    authHandlers.authService.getSession = (id) => id === 'sso-admin'
        ? { user: { id: 'sso:admin', username: 'admin', roles: ['user', 'admin'] }, expiresAt: Date.now() + 60_000 }
        : null;

    const req = makeRequest({
        url: '/services/demo/management/ws/logs?tail=1',
        cookie: 'ploinky_sso=sso-admin',
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
    authHandlers.authService.isConfigured = originalIsConfigured;
    authHandlers.authService.getSession = originalGetSession;

    assert.equal(out.matched, true);
    assert.equal(out.ok, true);
    assert.equal(out.hostPort, fixture.hostPort);
    assert.equal(out.upstreamPath, '/internal/management/ws/logs?tail=1');
    assert.equal(req.headers['x-ploinky-auth-info'], undefined);
    assert.equal(typeof out.responseHeaders['set-cookie'], 'string');

    const authInfo = JSON.parse(out.identityHeaders['x-ploinky-auth-info']);
    assert.equal(authInfo.user.id, 'sso:admin');
    assert.equal(authInfo.user.username, 'admin');
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
    assert.equal(verified.payload.sub, 'user:sso:admin');
});

function createRoutingFixture() {
    const workspace = mkdtempSync(join(tmpdir(), 'ploinky-ws-service-'));
    const ploinkyDir = join(workspace, '.ploinky');
    const explorerManifestDir = join(ploinkyDir, 'repos', 'fixtures', 'explorer');
    const serviceManifestDir = join(ploinkyDir, 'repos', 'fixtures', 'demoService');
    const routingFile = join(ploinkyDir, 'routing.json');
    const hostPort = 41234;

    mkdirSync(explorerManifestDir, { recursive: true });
    mkdirSync(serviceManifestDir, { recursive: true });
    writeFileSync(join(explorerManifestDir, 'manifest.json'), JSON.stringify({ about: 'Explorer' }, null, 2));
    writeFileSync(join(serviceManifestDir, 'manifest.json'), JSON.stringify({
        httpServices: [{
            slug: 'demo',
            externalPrefix: '/services/demo/',
            internalPrefix: '/internal/',
            access: 'authenticated',
        }],
    }, null, 2));
    writeFileSync(join(ploinkyDir, 'agents.json'), JSON.stringify({
        explorer: {
            type: 'agent',
            agentName: 'explorer',
            repoName: 'fixtures',
            auth: { mode: 'sso' },
        },
        demoService: {
            type: 'agent',
            agentName: 'demoService',
            repoName: 'fixtures',
            auth: { mode: 'none' },
        },
    }, null, 2));
    writeFileSync(routingFile, JSON.stringify({
        routes: {
            explorer: {
                agent: 'explorer',
                repo: 'fixtures',
                hostPort: 55289,
                hostPath: explorerManifestDir,
            },
            demoService: {
                agent: 'demoService',
                repo: 'fixtures',
                hostPort,
                hostPath: serviceManifestDir,
            },
        },
        static: {
            agent: 'explorer',
            hostPath: explorerManifestDir,
        },
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
        socket: { encrypted: false },
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
