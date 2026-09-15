import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';
import { dispatchAgentStartupAfterRouterSurfaces } from '../../cli/server/agentStartupDispatch.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PROBE_HEADER = 'x-ploinky-agent-startup-probe';

class MockResponse {
    constructor() {
        this.statusCode = 0;
        this.headers = {};
        this.body = '';
    }

    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = { ...headers };
    }

    end(body = '') {
        this.body += body === undefined ? '' : String(body);
    }
}

function writeJson(target, value) {
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-startup-integration-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const alphaDir = path.join(ploinkyDir, 'repos', 'fixtures', 'alpha');
    const betaDir = path.join(ploinkyDir, 'repos', 'fixtures', 'beta');
    for (const directory of [edgeDir, policyDir, alphaDir, betaDir]) {
        fs.mkdirSync(directory, { recursive: true });
    }

    const manifest = {
        routerAccess: {
            httpRoutes: [
                { path: '/public.html', access: 'public' },
                {
                    path: '/guest.html',
                    access: 'guest',
                    guestScope: 'fixture:guest',
                },
                { path: '/authenticated.html', access: 'authenticated' },
            ],
        },
    };
    writeJson(path.join(alphaDir, 'manifest.json'), manifest);
    writeJson(path.join(betaDir, 'manifest.json'), manifest);
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        static: { agent: 'alpha', port: 7777 },
        routes: {
            alpha: {
                repo: 'fixtures',
                agent: 'alpha',
                container: 'alpha-container',
                hostPath: alphaDir,
                hostPort: null,
            },
            beta: {
                repo: 'fixtures',
                agent: 'beta',
                container: 'beta-container',
                hostPath: betaDir,
                hostPort: 43102,
            },
        },
    });
    writeJson(path.join(ploinkyDir, 'agents.json'), {
        'alpha-container': {
            type: 'agent',
            repoName: 'fixtures',
            agentName: 'alpha',
            instanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
            profile: 'default',
            auth: { mode: 'sso' },
        },
        'beta-container': {
            type: 'agent',
            repoName: 'fixtures',
            agentName: 'beta',
            instanceId: 'beta-instance',
            enableGeneration: 'beta-enable-generation',
            profile: 'default',
            auth: { mode: 'sso' },
        },
    });
    writeJson(path.join(edgeDir, 'desired.json'), {
        hosts: {
            'alpha.example.test': {
                agent: 'fixtures/alpha',
                routerSurfaces: ['agent-mcp', 'browser-auth', 'marketplace-ui'],
            },
            'beta.example.test': {
                agent: 'fixtures/beta',
                routerSurfaces: [],
            },
        },
        cloudflare: { tunnelTokenSecret: 'publication/test-connector' },
    });
    writeJson(path.join(policyDir, 'policy-state.json'), {
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    });

    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    const previousRouterPort = process.env.PLOINKY_ROUTER_HOST_PORT;
    const previousMediaPort = process.env.PLOINKY_MEDIA_HOST_PORT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
    process.env.PLOINKY_MEDIA_HOST_PORT = '17891';
    t.after(() => {
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        if (previousRouterPort === undefined) delete process.env.PLOINKY_ROUTER_HOST_PORT;
        else process.env.PLOINKY_ROUTER_HOST_PORT = previousRouterPort;
        if (previousMediaPort === undefined) delete process.env.PLOINKY_MEDIA_HOST_PORT;
        else process.env.PLOINKY_MEDIA_HOST_PORT = previousMediaPort;
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'router-startup-integration-matrix',
        publicationState: 'ready',
    });
    return { workspace, generation: applied.selector.generation };
}

function requestFor({
    routeKey = 'alpha',
    pathname = '/public.html',
    hostKind = 'control',
    probe = false,
    method = 'GET',
    authorization = '',
    grant = '',
} = {}) {
    const dedicated = hostKind === 'dedicated';
    const host = dedicated ? `${routeKey}.example.test` : '127.0.0.1:18080';
    const url = dedicated ? pathname : `/${routeKey}${pathname}`;
    return {
        method,
        url,
        headers: {
            host,
            accept: probe ? 'application/json' : 'text/html',
            'sec-fetch-dest': probe ? 'empty' : 'document',
            'sec-fetch-mode': probe ? 'cors' : 'navigate',
            ...(probe ? { [PROBE_HEADER]: '1' } : {}),
            ...(authorization ? { authorization } : {}),
            ...(grant ? { 'x-test-route-grant': grant } : {}),
        },
    };
}

function resolvePlan(req) {
    return resolveEdgeRoutePlan({ req, listener: 'public' });
}

function parseBody(res) {
    return JSON.parse(res.body || '{}');
}

async function runStartup(req, {
    result = { state: 'starting' },
    commitPlan,
    canPublishHttp = true,
} = {}) {
    const routePlan = resolvePlan(req);
    const res = new MockResponse();
    let authCalls = 0;
    let lifecycleReads = 0;
    const handled = await dispatchAgentStartupAfterRouterSurfaces({
        req,
        res,
        parsedUrl: routePlan.parsedUrl,
        routePlan,
        ensureRouteAccess: async (_request, response, _parsedUrl, decision) => {
            authCalls += 1;
            const grant = String(req.headers['x-test-route-grant'] || '');
            if (decision?.access === 'public'
                || (decision?.access === 'guest' && grant === 'guest')
                || (decision?.access === 'authenticated' && grant === 'authenticated')) {
                return { ok: true };
            }
            response.writeHead(decision?.access === 'authenticated' ? 401 : 403, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
            });
            response.end(JSON.stringify({ error: 'route_access_denied' }));
            return { ok: false, error: 'route_access_denied' };
        },
        inspectPublication: () => ({ ok: true, canPublishHttp }),
        resolveStartupState: async () => {
            lifecycleReads += 1;
            return result;
        },
        ...(commitPlan ? { commitPlan } : {}),
    });
    return { authCalls, handled, lifecycleReads, res, routePlan };
}

test('real Router plans preserve host/surface/auth precedence through the production startup seam', async (t) => {
    const { generation } = createFixture(t);
    assert.match(generation, /^sha256:[a-f0-9]{64}$/);

    const routingSource = fs.readFileSync(path.join(REPO_ROOT, 'cli/server/RoutingServer.js'), 'utf8');
    const authSurface = routingSource.indexOf("if (pathname.startsWith('/auth/'))");
    const marketplaceSurface = routingSource.indexOf("if (pathname === '/api/marketplace'");
    const startupSeam = routingSource.indexOf('dispatchAgentStartupAfterRouterSurfaces({');
    const generalAgentAuth = routingSource.indexOf('if (routedAggregateAgentCard)', startupSeam);
    assert.ok(authSurface >= 0 && authSurface < startupSeam);
    assert.ok(marketplaceSurface >= 0 && marketplaceSurface < startupSeam);
    assert.ok(startupSeam >= 0 && startupSeam < generalAgentAuth);

    for (const hostKind of ['control', 'dedicated']) {
        const starting = await runStartup(requestFor({ hostKind }));
        assert.equal(starting.routePlan.kind, 'agent-root-pending');
        assert.equal(starting.routePlan.routeKey, 'alpha');
        assert.equal(starting.routePlan.pathname, hostKind === 'control' ? '/alpha/public.html' : '/public.html');
        assert.equal(starting.routePlan.canonicalPath, '/alpha/public.html');
        assert.equal(starting.routePlan.upstreamPath, '/public.html');
        assert.equal(starting.routePlan.decision.access, 'public');
        assert.equal(starting.handled, true);
        assert.equal(starting.authCalls, 1);
        assert.equal(starting.lifecycleReads, 1);
        assert.equal(starting.res.statusCode, 503);
        assert.match(starting.res.body, /data-ploinky-agent-startup-page="starting"/);

        const failed = await runStartup(requestFor({ hostKind }), {
            result: { state: 'failed', code: 'startup_failed' },
        });
        assert.equal(failed.lifecycleReads, 1);
        assert.equal(failed.res.statusCode, 503);
        assert.match(failed.res.body, /Agent startup failed/);

        const unavailable = await runStartup(requestFor({ hostKind, probe: true }), {
            canPublishHttp: false,
            result: { state: 'unavailable', code: 'route_unavailable' },
        });
        assert.equal(unavailable.authCalls, 1);
        assert.equal(unavailable.lifecycleReads, 1);
        assert.deepEqual(parseBody(unavailable.res), {
            state: 'unavailable',
            code: 'route_unavailable',
            message: 'This agent does not provide a web page.',
        });

        for (const [pathname, access, grant] of [
            ['/guest.html', 'guest', 'guest'],
            ['/authenticated.html', 'authenticated', 'authenticated'],
        ]) {
            const allowed = await runStartup(requestFor({ hostKind, pathname, grant }));
            assert.equal(allowed.routePlan.decision.access, access);
            assert.equal(allowed.authCalls, 1);
            assert.equal(allowed.lifecycleReads, 1);

            const denied = await runStartup(requestFor({ hostKind, pathname }));
            assert.equal(denied.routePlan.decision.access, access);
            assert.equal(denied.authCalls, 1);
            assert.equal(denied.lifecycleReads, 0);
            assert.equal(denied.res.statusCode, access === 'authenticated' ? 401 : 403);
            assert.deepEqual(parseBody(denied.res), { error: 'route_access_denied' });
        }

        const rotated = await runStartup(requestFor({ hostKind, probe: true }), {
            commitPlan: () => false,
        });
        assert.equal(rotated.authCalls, 1);
        assert.equal(rotated.lifecycleReads, 0);
        assert.deepEqual(parseBody(rotated.res), {
            state: 'retry',
            code: 'edge_generation_changed',
        });

        const active = await runStartup(requestFor({
            hostKind,
            routeKey: 'beta',
            probe: true,
        }));
        assert.equal(active.routePlan.kind, 'agent-root');
        assert.equal(active.routePlan.routeKey, 'beta');
        assert.equal(active.authCalls, 1);
        assert.equal(active.lifecycleReads, 0);
        assert.equal(active.res.statusCode, 200);
        assert.deepEqual(parseBody(active.res), {
            state: 'ready',
            generation,
        });
    }

    for (const req of [
        requestFor({ pathname: '/mcp', probe: true }),
        requestFor({ authorization: 'Bearer delegated-assertion' }),
        requestFor({ pathname: '/__agent/private' }),
        requestFor({ method: 'POST' }),
    ]) {
        const result = await runStartup(req);
        assert.equal(result.routePlan.kind, 'agent-root-pending');
        assert.equal(result.handled, true);
        assert.equal(result.authCalls, 0);
        assert.equal(result.lifecycleReads, 0);
        assert.equal(result.res.statusCode, 503);
        assert.deepEqual(parseBody(result.res), { error: 'TARGET_INACTIVE' });
    }

    for (const pathname of ['/auth/login', '/api/marketplace']) {
        const req = requestFor({ pathname, hostKind: 'dedicated' });
        const result = await runStartup(req);
        assert.equal(result.routePlan.kind, 'router-surface', pathname);
        assert.equal(result.handled, false, pathname);
        assert.equal(result.authCalls, 0, pathname);
        assert.equal(result.lifecycleReads, 0, pathname);
        assert.equal(result.res.statusCode, 0, pathname);
        assert.doesNotMatch(result.res.body, /data-ploinky-agent-startup-page/, pathname);
    }

    const dedicatedMcp = await runStartup(requestFor({
        pathname: '/mcp',
        hostKind: 'dedicated',
        probe: true,
    }));
    assert.equal(dedicatedMcp.routePlan.kind, 'agent-root-pending');
    assert.equal(dedicatedMcp.handled, true);
    assert.equal(dedicatedMcp.authCalls, 0);
    assert.equal(dedicatedMcp.lifecycleReads, 0);
    assert.deepEqual(parseBody(dedicatedMcp.res), { error: 'TARGET_INACTIVE' });

    const deniedSurface = resolvePlan(requestFor({
        pathname: '/status',
        hostKind: 'dedicated',
    }));
    assert.equal(deniedSurface.ok, false);
    assert.equal(deniedSurface.code, 'ROUTE_SURFACE_DENIED');
});
