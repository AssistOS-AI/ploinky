import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';
import { isPrivateInterfaceAllowed, resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';

test('private listener class admits bridge-gateway requests without IP provenance', () => {
    const bridgeRequest = {
        ploinkyListenerClass: 'private',
        socket: {
            localAddress: '10.88.0.1',
            remoteAddress: '10.88.0.42',
        },
    };

    assert.equal(isPrivateInterfaceAllowed(bridgeRequest, 'private'), true);
    assert.equal(isPrivateInterfaceAllowed(bridgeRequest, 'public'), false);
    assert.equal(isPrivateInterfaceAllowed({ socket: bridgeRequest.socket }, 'private'), false);
});

test('loopback provenance cannot turn the public listener into a private listener', () => {
    const loopbackRequest = {
        socket: {
            localAddress: '127.0.0.1',
            remoteAddress: '127.0.0.1',
        },
    };

    assert.equal(isPrivateInterfaceAllowed(loopbackRequest, 'public'), false);
});

test('local service aliases are route-scoped and internal consumers are private-only', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-hosts-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    t.after(() => {
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    const routes = {};
    const agents = {};
    for (const [routeKey, hostPort] of [['alpha', 43101], ['beta', 43102]]) {
        const manifestDir = path.join(ploinkyDir, 'repos', 'fixtures', routeKey);
        fs.mkdirSync(manifestDir, { recursive: true });
        const httpServices = [{
            slug: 'dashboard',
            externalPrefix: `/services/${routeKey}-dashboard/`,
            internalPrefix: '/',
            access: 'authenticated',
        }];
        if (routeKey === 'alpha') {
            httpServices.push({
                slug: 'internal-api',
                externalPrefix: '/services/internal-api/',
                internalPrefix: '/private/',
                access: 'authenticated',
            }, {
                externalPrefix: '/public-prefix-one/',
                internalPrefix: '/one/',
                access: 'public',
            }, {
                externalPrefix: '/public-prefix-two/',
                internalPrefix: '/two/',
                access: 'public',
            });
        }
        fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({ httpServices }));
        routes[routeKey] = { agent: routeKey, repo: 'fixtures', hostPath: manifestDir, hostPort };
        agents[routeKey] = {
            type: 'agent',
            agentName: routeKey,
            repoName: 'fixtures',
            instanceId: `${routeKey}-instance`,
            enableGeneration: `${routeKey}-generation`,
            auth: { mode: 'local' },
        };
    }
    fs.mkdirSync(path.join(ploinkyDir, 'data', 'edge-routing'), { recursive: true });
    fs.mkdirSync(path.join(ploinkyDir, 'data', 'router-security'), { recursive: true });
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({ routes }));
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify(agents));
    fs.writeFileSync(path.join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), JSON.stringify({
        schemaVersion: 1,
        hosts: {},
        security: {
            hostNetworkAllowedInstances: [],
            internalServiceConsumers: {
                'fixtures/alpha/internal-api': ['fixtures/beta'],
            },
        },
    }));
    fs.writeFileSync(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), JSON.stringify({
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    }));
    applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'edge-host-test-fixture' });

    const plan = (host, url, listener = 'public', transportClass = listener) => resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url,
            headers: { host },
            ploinkyListenerClass: transportClass,
            socket: { localAddress: '10.88.0.1' },
        },
        parsedUrl: new URL(url, `http://${host}`),
        listener,
    });

    assert.equal(plan('dashboard.alpha.localhost', '/').definition?.routeKey, 'alpha');
    assert.equal(plan('dashboard.beta.localhost', '/').definition?.routeKey, 'beta');
    assert.equal(plan('dashboard.localhost', '/').code, 'UNKNOWN_HOST');
    assert.equal(plan('internal-api.alpha.localhost', '/').code, 'UNKNOWN_HOST');

    const prefixOne = plan('localhost', '/public-prefix-one/items');
    assert.equal(prefixOne.ok, true, `${prefixOne.code || 'unknown'}: ${prefixOne.status || 'no status'}`);
    assert.equal(Object.hasOwn(prefixOne.definition, 'slug'), false);
    assert.equal(prefixOne.upstreamPath, '/one/items');
    const prefixTwo = plan('localhost', '/public-prefix-two/items');
    assert.equal(prefixTwo.ok, true, `${prefixTwo.code || 'unknown'}: ${prefixTwo.status || 'no status'}`);
    assert.equal(Object.hasOwn(prefixTwo.definition, 'slug'), false);
    assert.equal(prefixTwo.upstreamPath, '/two/items');

    const privatePlan = plan('host.containers.internal', '/services/internal-api/items', 'private');
    assert.equal(privatePlan.ok, true);
    assert.equal(privatePlan.definition?.slug, 'internal-api');
    assert.equal(privatePlan.decision?.access, 'authenticated');

    const unmanagedPrivate = plan(
        'host.containers.internal',
        '/services/internal-api/items',
        'private',
        'public',
    );
    assert.equal(unmanagedPrivate.code, 'PRIVATE_INTERFACE_DENIED');

    assert.equal(plan('host.containers.internal', '/alpha/', 'managed').ok, true);
    assert.equal(plan('app.example.test', '/alpha/', 'managed').code, 'UNKNOWN_HOST');
    assert.equal(plan('host.containers.internal', '/alpha/', 'public').code, 'UNKNOWN_HOST');
});
