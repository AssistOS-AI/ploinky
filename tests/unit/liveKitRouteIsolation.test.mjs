import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-livekit-route-'));
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);

const [
    { signPrivateRouterAssertion },
    { createMemoryReplayCache },
    { derivePrivateAgentRequestSecret },
    { applyEdgeRoutingGeneration },
    { resolveEdgeRoutePlan },
    { authorizePrivateRoutePlan },
    { resolveUpgradeTarget },
] = await Promise.all([
    import('../../Agent/lib/agentAssertion.mjs'),
    import('../../Agent/lib/jwtVerify.mjs'),
    import('../../cli/services/masterKey.js'),
    import('../../cli/services/edgeGeneration.js'),
    import('../../cli/server/edgeRoutePlan.js'),
    import('../../cli/server/privateRouter.js'),
    import('../../cli/server/wsServiceProxy.js'),
]);

test.after(() => {
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    if (previousMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousMasterKey;
    fs.rmSync(workspace, { recursive: true, force: true });
});

function writeFixture() {
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const liveKitDir = path.join(ploinkyDir, 'repos', 'webmeetInfra', 'liveKitServerAgent');
    const webMeetDir = path.join(ploinkyDir, 'repos', 'AssistOSExplorer', 'webmeetAgent');
    fs.mkdirSync(edgeDir, { recursive: true });
    fs.mkdirSync(policyDir, { recursive: true });
    fs.mkdirSync(liveKitDir, { recursive: true });
    fs.mkdirSync(webMeetDir, { recursive: true });
    fs.writeFileSync(path.join(liveKitDir, 'manifest.json'), JSON.stringify({
        start: 'sleep infinity',
        network: { mode: 'host' },
        httpServices: [{
            slug: 'livekit-signal',
            port: 7880,
            externalPrefix: '/public-services/livekit-signal/',
            internalPrefix: '/',
            access: 'public',
        }, {
            slug: 'livekit-api',
            port: 7880,
            externalPrefix: '/services/livekit-api/',
            internalPrefix: '/twirp/livekit.RoomService/',
            access: 'authenticated',
        }],
    }, null, 2));
    fs.writeFileSync(path.join(webMeetDir, 'manifest.json'), JSON.stringify({ start: 'sleep infinity' }));
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        routes: {
            liveKitServerAgent: {
                repo: 'webmeetInfra',
                agent: 'liveKitServerAgent',
                container: 'livekit-container',
                hostPath: liveKitDir,
                hostPort: 47880,
                serviceTargets: { '7880': 47880 },
            },
            webmeetAgent: {
                repo: 'AssistOSExplorer',
                agent: 'webmeetAgent',
                container: 'webmeet-container',
                hostPath: webMeetDir,
                hostPort: 47000,
            },
        },
    }, null, 2));
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        'livekit-container': {
            type: 'agent',
            repoName: 'webmeetInfra',
            agentName: 'liveKitServerAgent',
            instanceId: 'livekit-instance',
            enableGeneration: 'livekit-generation',
            auth: { mode: 'none' },
        },
        'webmeet-container': {
            type: 'agent',
            repoName: 'AssistOSExplorer',
            agentName: 'webmeetAgent',
            instanceId: 'webmeet-instance',
            enableGeneration: 'webmeet-generation',
            auth: { mode: 'local' },
        },
    }, null, 2));
    fs.writeFileSync(path.join(edgeDir, 'desired.json'), JSON.stringify({
        schemaVersion: 1,
        hosts: {
            'meet.example.test': {
                agent: 'webmeetInfra/liveKitServerAgent',
                httpService: 'livekit-signal',
            },
        },
        cloudflare: {
            accountId: 'test-account',
            zoneId: 'test-zone',
            tunnelId: 'test-tunnel',
            tunnelTokenSecret: 'publication/cloudflare-connector',
            apiTokenSecret: 'publication/cloudflare-api',
        },
        security: {
            hostNetworkAllowedInstances: ['webmeetInfra/liveKitServerAgent'],
            internalServiceConsumers: {
                'webmeetInfra/liveKitServerAgent/livekit-api': ['AssistOSExplorer/webmeetAgent'],
            },
        },
    }, null, 2));
    fs.writeFileSync(path.join(policyDir, 'policy-state.json'), JSON.stringify({
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    }, null, 2));
}

function plan({ host, url, method = 'GET', listener = 'public' }) {
    const req = {
        method,
        url,
        headers: { host },
        ploinkyListenerClass: listener,
    };
    return {
        req,
        routePlan: resolveEdgeRoutePlan({
            req,
            parsedUrl: new URL(url, `http://${host}`),
            listener,
        }),
    };
}

test('public LiveKit signaling cannot dial Twirp while WebSocket signaling and asserted private Twirp remain routable', async () => {
    writeFixture();
    applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'livekit-route-isolation-test',
        publicationState: 'cloudflare-ready',
    });

    const blocked = plan({
        host: 'meet.example.test',
        url: '/twirp/livekit.RoomService/CreateRoom',
        method: 'POST',
    }).routePlan;
    assert.equal(blocked.matched, true);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.code, 'PUBLIC_ROUTE_WRITE_DENIED');
    assert.equal(blocked.canonicalPath, '/public-services/livekit-signal/twirp/livekit.RoomService/CreateRoom');
    assert.equal(Object.hasOwn(blocked, 'target'), false, 'policy denial must occur before target selection');

    const signaling = plan({
        host: 'meet.example.test',
        url: '/rtc?access_token=room-jwt',
    });
    signaling.req.headers.forwarded = 'host=attacker.invalid;proto=http';
    signaling.req.headers['x-forwarded-host'] = 'attacker.invalid';
    signaling.req.headers['x-forwarded-proto'] = 'http';
    assert.equal(signaling.routePlan.ok, true);
    assert.equal(signaling.routePlan.definition.slug, 'livekit-signal');
    assert.equal(signaling.routePlan.upstreamPath, '/rtc?access_token=room-jwt');
    const upgrade = await resolveUpgradeTarget({
        req: signaling.req,
        parsedUrl: signaling.routePlan.parsedUrl,
        routePlan: signaling.routePlan,
    });
    assert.equal(upgrade.matched, true);
    assert.equal(upgrade.ok, true);
    assert.equal(upgrade.hostPort, 47880);
    assert.equal(upgrade.upstreamPath, '/rtc?access_token=room-jwt');
    assert.deepEqual(upgrade.forwardingHeaders, {
        host: 'meet.example.test',
        'x-forwarded-host': 'meet.example.test',
        'x-forwarded-proto': 'https',
    });
    assert.equal(signaling.req.headers.forwarded, undefined);
    assert.equal(signaling.req.headers['x-forwarded-host'], undefined);
    assert.equal(signaling.req.headers['x-forwarded-proto'], undefined);

    const privateCall = plan({
        host: 'host.containers.internal',
        url: '/services/livekit-api/CreateRoom',
        method: 'POST',
        listener: 'private',
    });
    assert.equal(privateCall.routePlan.ok, true);
    assert.equal(privateCall.routePlan.definition.slug, 'livekit-api');
    assert.equal(privateCall.routePlan.upstreamPath, '/twirp/livekit.RoomService/CreateRoom');
    const body = Buffer.from('{"name":"room-1"}');
    const currentCallerEnv = {
        PLOINKY_AGENT_ID: 'agent:AssistOSExplorer/webmeetAgent',
        PLOINKY_AGENT_INSTANCE_ID: 'webmeet-instance',
        PLOINKY_AGENT_ENABLE_GENERATION: 'webmeet-generation',
        PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(
            'agent:AssistOSExplorer/webmeetAgent',
            'webmeet-instance',
            'webmeet-generation',
        ),
    };
    privateCall.req.headers['ploinky-agent-assertion'] = signPrivateRouterAssertion({
        method: 'POST',
        path: privateCall.routePlan.pathname,
        query: privateCall.routePlan.parsedUrl.search,
        body,
        env: currentCallerEnv,
    });
    privateCall.req.headers['x-ploinky-auth-info'] = '{"user":{"id":"spoofed"}}';
    privateCall.req.headers['x-ploinky-user-id'] = 'spoofed';
    privateCall.req.headers['x-ploinky-agent-assertion'] = 'spoofed-alternate-header';
    privateCall.req.headers.forwarded = 'for=198.51.100.9;host=attacker.invalid;proto=https';
    privateCall.req.headers['x-forwarded-host'] = 'attacker.invalid';
    privateCall.req.headers['x-forwarded-proto'] = 'https';
    const identity = authorizePrivateRoutePlan({
        req: privateCall.req,
        plan: privateCall.routePlan,
        body,
        assertionCache: createMemoryReplayCache(),
    });
    assert.deepEqual(identity, {
        agentId: 'agent:AssistOSExplorer/webmeetAgent',
        instanceId: 'webmeet-instance',
        enableGeneration: 'webmeet-generation',
        routeKey: 'webmeetAgent',
    });
    assert.equal(privateCall.req.headers['ploinky-agent-assertion'], undefined);
    const privateUpgrade = await resolveUpgradeTarget({
        req: privateCall.req,
        parsedUrl: privateCall.routePlan.parsedUrl,
        listener: 'private',
        routePlan: privateCall.routePlan,
    });
    assert.equal(privateUpgrade.ok, true);
    assert.deepEqual(privateUpgrade.forwardingHeaders, {
        host: 'host.containers.internal:8081',
        'x-forwarded-host': 'host.containers.internal:8081',
        'x-forwarded-proto': 'http',
    });
    for (const header of [
        'x-ploinky-auth-info',
        'x-ploinky-user-id',
        'x-ploinky-agent-assertion',
        'forwarded',
        'x-forwarded-host',
        'x-forwarded-proto',
    ]) {
        assert.equal(privateCall.req.headers[header], undefined, `${header} must not reach the private target`);
    }

    const assertionFor = ({
        env = currentCallerEnv,
        method = 'POST',
        path = privateCall.routePlan.pathname,
        query = privateCall.routePlan.parsedUrl.search,
        audience,
    } = {}) => signPrivateRouterAssertion({ method, path, query, body, audience, env });
    const rejectPrivate = ({ token, method = 'POST', extraHeaders = {} } = {}) => {
        const req = {
            method,
            headers: {
                host: 'host.containers.internal',
                ...(token ? { 'ploinky-agent-assertion': token } : {}),
                ...extraHeaders,
            },
        };
        assert.throws(() => authorizePrivateRoutePlan({
            req,
            plan: privateCall.routePlan,
            body,
            assertionCache: createMemoryReplayCache(),
        }));
    };

    rejectPrivate({
        extraHeaders: {
            authorization: `Bearer ${assertionFor()}`,
            'x-ploinky-agent-assertion': assertionFor(),
            'x-ploinky-auth-info': '{"user":{"id":"spoofed"}}',
            'x-ploinky-user-id': 'spoofed',
            forwarded: 'for=127.0.0.1;host=host.containers.internal;proto=http',
            'x-forwarded-host': 'host.containers.internal',
            'x-forwarded-proto': 'http',
        },
    });
    rejectPrivate({ token: assertionFor({ audience: 'ploinky-public-router' }) });
    rejectPrivate({ token: assertionFor({ path: '/services/livekit-api/DeleteRoom' }) });
    rejectPrivate({ token: assertionFor({ query: '?admin=true' }) });
    rejectPrivate({ token: assertionFor({ method: 'GET' }) });

    const callerEnv = (agentId, instanceId = 'foreign-instance', enableGeneration = 'foreign-generation') => ({
        PLOINKY_AGENT_ID: agentId,
        PLOINKY_AGENT_INSTANCE_ID: instanceId,
        PLOINKY_AGENT_ENABLE_GENERATION: enableGeneration,
        PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(agentId, instanceId, enableGeneration),
    });
    rejectPrivate({ token: assertionFor({ env: callerEnv('agent:AssistOSExplorer/unknownAgent') }) });
    rejectPrivate({ token: assertionFor({ env: callerEnv('agent:AssistOSExplorer/*') }) });
    rejectPrivate({ token: assertionFor({ env: callerEnv('agent:AssistOSExplorer/webmeetAgent.attacker') }) });
    rejectPrivate({
        token: assertionFor({
            env: callerEnv(
                currentCallerEnv.PLOINKY_AGENT_ID,
                currentCallerEnv.PLOINKY_AGENT_INSTANCE_ID,
                'stale-webmeet-generation',
            ),
        }),
    });
});
