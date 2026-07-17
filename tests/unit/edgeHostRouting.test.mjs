import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyEdgeRoutingGeneration } from '../../cli/services/edgeGeneration.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import { handleEdgeTopologyProjection } from '../../cli/server/edgeTopologyRoute.js';

function desiredState() {
    return {
        schemaVersion: 1,
        hosts: {
            'app.example.test': {
                agent: 'fixtures/alpha',
                routerSurfaces: ['browser-auth', 'topology-projection'],
                mounts: [{ agent: 'fixtures/beta', httpService: 'telemetry' }],
            },
            'dashboard.example.test': {
                agent: 'fixtures/alpha',
                httpService: 'dashboard',
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
            hostNetworkAllowedInstances: [],
            internalServiceConsumers: {
                'fixtures/alpha/internal-api': ['fixtures/beta'],
            },
        },
    };
}

function createFixture(t, desired = desiredState()) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-host-routing-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    fs.mkdirSync(edgeDir, { recursive: true });
    fs.mkdirSync(policyDir, { recursive: true });
    const routes = {};
    const agents = {};
    const inputs = [{
        routeKey: 'alpha',
        repo: 'fixtures',
        agent: 'alpha',
        hostPort: 43201,
        services: [{
            slug: 'dashboard',
            externalPrefix: '/services/alpha-dashboard/',
            internalPrefix: '/',
            access: 'authenticated',
        }, {
            slug: 'internal-api',
            externalPrefix: '/services/internal-api/',
            internalPrefix: '/private/',
            access: 'authenticated',
        }],
    }, {
        routeKey: 'beta',
        repo: 'fixtures',
        agent: 'beta',
        hostPort: 43202,
        services: [{
            slug: 'telemetry',
            externalPrefix: '/public-services/telemetry/',
            internalPrefix: '/collect/',
            access: 'guest',
        }],
    }];
    for (const input of inputs) {
        const manifestDir = path.join(ploinkyDir, 'repos', input.repo, input.agent);
        fs.mkdirSync(manifestDir, { recursive: true });
        fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({
            httpServices: input.services,
        }, null, 2));
        routes[input.routeKey] = {
            repo: input.repo,
            agent: input.agent,
            container: `${input.routeKey}-container`,
            hostPath: manifestDir,
            hostPort: input.hostPort,
        };
        agents[`${input.routeKey}-container`] = {
            type: 'agent',
            repoName: input.repo,
            agentName: input.agent,
            instanceId: `${input.routeKey}-instance`,
            enableGeneration: `${input.routeKey}-generation`,
            auth: { mode: 'local' },
        };
    }
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        static: { agent: 'alpha', port: 18080 },
        routes,
    }, null, 2));
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify(agents, null, 2));
    fs.writeFileSync(path.join(edgeDir, 'desired.json'), JSON.stringify(desired, null, 2));
    fs.writeFileSync(path.join(policyDir, 'policy-state.json'), JSON.stringify({
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    }, null, 2));

    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    t.after(() => {
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    return { workspace };
}

function resolve(host, url, listener = 'public', method = 'GET') {
    return resolveEdgeRoutePlan({
        req: { method, url, headers: { host }, ploinkyListenerClass: listener },
        parsedUrl: new URL(url, `http://${host}`),
        listener,
    });
}

class MockResponse {
    writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
    }

    end(body) {
        this.body = Buffer.from(body || '').toString('utf8');
    }
}

test('compiler emits closed host, surface, mount, alias, and private-service tables', (t) => {
    const fixture = createFixture(t);
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'host-table-test',
        publicationState: 'cloudflare-ready',
    });
    assert.deepEqual(applied.generation.compiled.hosts, {
        'app.example.test': {
            kind: 'agent-root',
            agent: 'fixtures/alpha',
            routeKey: 'alpha',
        },
        'dashboard.example.test': {
            kind: 'dedicated-service',
            agent: 'fixtures/alpha',
            routeKey: 'alpha',
            httpService: 'dashboard',
            optionalLogin: false,
        },
    });
    assert.deepEqual(applied.generation.compiled.surfaces['app.example.test'], [
        'browser-auth',
        'topology-projection',
    ]);
    assert.deepEqual(applied.generation.compiled.mounts['app.example.test'], [{
        agent: 'fixtures/beta',
        routeKey: 'beta',
        slug: 'telemetry',
        externalPrefix: '/public-services/telemetry/',
    }]);
    assert.deepEqual(applied.generation.compiled.localAliases, {
        'dashboard.alpha.localhost': { routeKey: 'alpha', slug: 'dashboard' },
        'telemetry.beta.localhost': { routeKey: 'beta', slug: 'telemetry' },
    });
    assert.equal(Object.hasOwn(applied.generation.compiled.localAliases, 'internal-api.alpha.localhost'), false);
    assert.deepEqual(applied.generation.compiled.security.internalServiceConsumers, [{
        routeKey: 'alpha',
        slug: 'internal-api',
        canonicalPrefix: '/services/internal-api/',
        callers: [{
            agentId: 'agent:fixtures/beta',
            instanceId: 'beta-instance',
            enableGeneration: 'beta-generation',
            routeKey: 'beta',
            containerName: 'beta-container',
        }],
    }]);
    assert.equal(Object.hasOwn(applied.generation.compiled.hosts['app.example.test'], 'port'), false);
    assert.equal(Object.hasOwn(applied.generation.compiled.hosts['app.example.test'], 'access'), false);
});

test('host-first routing selects roots, mounts, dedicated services, and closed surfaces', (t) => {
    const fixture = createFixture(t);
    applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'host-routing-test',
        publicationState: 'cloudflare-ready',
    });

    const root = resolve('app.example.test', '/projects');
    assert.equal(root.ok, true);
    assert.equal(root.kind, 'agent-root');
    assert.equal(root.routeKey, 'alpha');
    assert.equal(root.canonicalPath, '/alpha/projects');
    assert.equal(root.upstreamPath, '/projects');
    assert.deepEqual(root.forwarding, { authority: 'app.example.test', protocol: 'https' });

    const mounted = resolve('app.example.test', '/public-services/telemetry/event?x=1');
    assert.equal(mounted.ok, true);
    assert.equal(mounted.kind, 'service');
    assert.equal(mounted.definition.routeKey, 'beta');
    assert.equal(mounted.upstreamPath, '/collect/event?x=1');

    const topology = resolve('app.example.test', '/api/edge/topology?routeKey=beta&slug=telemetry');
    assert.equal(topology.ok, true);
    assert.equal(topology.kind, 'router-surface');
    assert.equal(topology.surface, 'topology-projection');

    assert.equal(resolve('app.example.test', '/api/marketplace').code, 'ROUTE_SURFACE_DENIED');
    assert.equal(resolve('app.example.test', '/health').code, 'ROUTE_SURFACE_DENIED');

    const dedicated = resolve('dashboard.example.test', '/widgets');
    assert.equal(dedicated.ok, true);
    assert.equal(dedicated.kind, 'service');
    assert.equal(dedicated.canonicalPath, '/services/alpha-dashboard/widgets');
    assert.equal(dedicated.upstreamPath, '/widgets');
    assert.deepEqual(dedicated.forwarding, { authority: 'dashboard.example.test', protocol: 'https' });
    assert.equal(resolve('dashboard.example.test', '/auth/login').surface, 'browser-auth');
    assert.equal(resolve('dashboard.example.test', '/api/edge/topology').code, 'ROUTE_SURFACE_DENIED');
    assert.equal(resolve('dashboard.example.test', '/dashboard').code, 'ROUTE_SURFACE_DENIED');
});

test('dedicated service auth surface excludes token and account operations', (t) => {
    const fixture = createFixture(t);
    applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'dedicated-auth-surface-test',
        publicationState: 'cloudflare-ready',
    });

    for (const pathname of ['/auth/login', '/auth/callback', '/auth/logout', '/auth/logged-out']) {
        const plan = resolve('dashboard.example.test', pathname);
        assert.equal(plan.ok, true, pathname);
        assert.equal(plan.kind, 'router-surface', pathname);
        assert.equal(plan.surface, 'browser-auth', pathname);
    }

    for (const [pathname, method] of [['/auth/token', 'POST'], ['/auth/account', 'GET']]) {
        for (const host of ['dashboard.example.test', 'dashboard.alpha.localhost']) {
            const plan = resolve(host, pathname, 'public', method);
            assert.equal(plan.ok, false, `${host}${pathname}`);
            assert.equal(plan.status, 404, `${host}${pathname}`);
            assert.equal(plan.code, 'ROUTE_SURFACE_DENIED', `${host}${pathname}`);
        }
    }

    for (const [pathname, method] of [['/auth/token', 'POST'], ['/auth/account', 'GET']]) {
        const plan = resolve('app.example.test', pathname, 'public', method);
        assert.equal(plan.ok, true, pathname);
        assert.equal(plan.kind, 'router-surface', pathname);
        assert.equal(plan.surface, 'browser-auth', pathname);
    }
});

test('local aliases are route-scoped and internal-only services resolve only on private listener', (t) => {
    const fixture = createFixture(t);
    applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'local-private-test',
        publicationState: 'cloudflare-ready',
    });
    const alpha = resolve('dashboard.alpha.localhost', '/settings');
    assert.equal(alpha.ok, true);
    assert.equal(alpha.definition.routeKey, 'alpha');
    assert.equal(alpha.canonicalPath, '/services/alpha-dashboard/settings');
    assert.equal(resolve('dashboard.beta.localhost', '/').code, 'UNKNOWN_HOST');
    assert.equal(resolve('internal-api.alpha.localhost', '/').code, 'UNKNOWN_HOST');
    assert.equal(resolve('localhost', '/services/internal-api/items').code, 'ROUTE_NOT_FOUND');

    const privatePlan = resolve(
        'host.containers.internal',
        '/services/internal-api/items',
        'private',
        'POST',
    );
    assert.equal(privatePlan.ok, true);
    assert.equal(privatePlan.definition.slug, 'internal-api');
    assert.equal(privatePlan.decision.access, 'authenticated');
});

test('unknown, malformed, suffix-confusable, stale, and transport-spoofed hosts fail closed', (t) => {
    const fixture = createFixture(t);
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'host-confusion-reconciling' });
    assert.equal(resolve('app.example.test', '/').code, 'HOST_SELECTOR_INACTIVE');

    applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'host-confusion-ready',
        publicationState: 'cloudflare-ready',
    });
    assert.equal(resolve('app.example.test.evil', '/').code, 'UNKNOWN_HOST');
    assert.equal(resolve('app.example.test.', '/').code, 'MALFORMED_HOST');
    assert.equal(resolve('app.example.test@evil.test', '/').code, 'MALFORMED_HOST');
    assert.equal(resolve('app.example.test.localhost', '/').code, 'UNKNOWN_HOST');

    const managedRoot = resolve('host.containers.internal', '/alpha/projects', 'managed');
    assert.equal(managedRoot.ok, true);
    assert.equal(managedRoot.hostSelection.kind, 'managed-agent');
    assert.equal(managedRoot.routeKey, 'alpha');
    assert.equal(resolve('host.containers.internal', '/api/edge/topology', 'managed').code, 'ROUTE_SURFACE_DENIED');
    assert.equal(resolve('app.example.test', '/alpha/projects', 'managed').code, 'UNKNOWN_HOST');
    assert.equal(resolve('localhost', '/health', 'managed').code, 'UNKNOWN_HOST');
});

test('unknown Router surfaces fail compilation', (t) => {
    const unknown = desiredState();
    unknown.hosts['app.example.test'].routerSurfaces.push('raw-path');
    const unknownFixture = createFixture(t, unknown);
    assert.throws(
        () => applyEdgeRoutingGeneration({ workspaceRoot: unknownFixture.workspace, reason: 'unknown-surface-test' }),
        /unknown Router surface 'raw-path'/,
    );
});

test('public selection of an internal-only service fails compilation', (t) => {
    const desired = desiredState();
    desired.hosts['private.example.test'] = {
        agent: 'fixtures/alpha',
        httpService: 'internal-api',
    };
    const fixture = createFixture(t, desired);
    assert.throws(
        () => applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'internal-host-test' }),
        /cannot publish internal-only service 'internal-api'/,
    );
});

test('authenticated no-store topology projection is host-scoped and non-enumerating', (t) => {
    const fixture = createFixture(t);
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'topology-projection-test',
        publicationState: 'cloudflare-ready',
    });
    const request = {
        method: 'GET',
        url: '/api/edge/topology?routeKey=beta&slug=telemetry',
        headers: { host: 'app.example.test' },
        user: { id: 'local:alice', roles: ['user'] },
    };
    const parsed = new URL(request.url, 'https://app.example.test');
    const routePlan = resolveEdgeRoutePlan({ req: request, parsedUrl: parsed, listener: 'public' });
    const response = new MockResponse();
    assert.equal(handleEdgeTopologyProjection(request, response, parsed, { routePlan }), true);
    assert.equal(response.status, 200);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.deepEqual(JSON.parse(response.body), {
        routeKey: 'beta',
        slug: 'telemetry',
        browserUrl: 'https://app.example.test/public-services/telemetry/',
        state: 'cloudflare-ready',
        configurationGeneration: applied.topology.configurationGeneration,
        publicationGeneration: 1,
    });

    const forbiddenUrl = new URL('/api/edge/topology?routeKey=alpha&slug=internal-api', 'https://app.example.test');
    const forbiddenRequest = { ...request, url: forbiddenUrl.pathname + forbiddenUrl.search };
    const forbiddenPlan = resolveEdgeRoutePlan({ req: forbiddenRequest, parsedUrl: forbiddenUrl, listener: 'public' });
    const forbiddenResponse = new MockResponse();
    handleEdgeTopologyProjection(forbiddenRequest, forbiddenResponse, forbiddenUrl, { routePlan: forbiddenPlan });
    assert.equal(forbiddenResponse.status, 404);

    const guestResponse = new MockResponse();
    handleEdgeTopologyProjection(
        { ...request, user: { id: 'guest', roles: ['guest'] } },
        guestResponse,
        parsed,
        { routePlan },
    );
    assert.equal(guestResponse.status, 401);

    const topology = JSON.parse(fs.readFileSync(applied.paths.topologyCurrentFile, 'utf8'));
    topology.authorizationGeneration = `sha256:${'f'.repeat(64)}`;
    fs.writeFileSync(applied.paths.topologyCurrentFile, JSON.stringify(topology, null, 2));
    const staleResponse = new MockResponse();
    handleEdgeTopologyProjection(request, staleResponse, parsed, { routePlan });
    assert.equal(staleResponse.status, 503);
    assert.deepEqual(JSON.parse(staleResponse.body), { ok: false, error: 'locator_inactive' });
});
