import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    EDGE_DESIRED_CANDIDATE_MAX_BYTES,
    abortEdgeRoutingPreparation,
    applyEdgeDesiredStateFile,
    applyEdgeRoutingGeneration,
    assertHostModeGenerationCapability,
    captureEdgeRoutingLease,
    inactivateEdgeRoutingGeneration,
    initializeFreshEdgeRoutingSources,
    loadActiveEdgeRoutingGeneration,
    normalizePublicMediaIPv4,
    prepareEdgeRoutingGeneration,
    readCurrentEdgeTopology,
    withEdgeGenerationApplyLock,
} from '../../cli/services/edgeGeneration.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';

function localDesired(overrides = {}) {
    return {
        schemaVersion: 1,
        hosts: {},
        security: {
            hostNetworkAllowedInstances: [],
            internalServiceConsumers: {},
        },
        ...overrides,
    };
}

function completeCloudflare() {
    return {
        accountId: 'test-account',
        zoneId: 'test-zone',
        tunnelId: 'test-tunnel',
        tunnelTokenSecret: 'publication/cloudflare-connector',
        apiTokenSecret: 'publication/cloudflare-api',
    };
}

function defaultRoutes() {
    return [
        {
            routeKey: 'alpha',
            repo: 'fixtures',
            agent: 'alpha',
            hostPort: 43101,
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
        },
        {
            routeKey: 'beta',
            repo: 'fixtures',
            agent: 'beta',
            hostPort: 43102,
            services: [{
                slug: 'telemetry',
                externalPrefix: '/public-services/telemetry/',
                internalPrefix: '/collect/',
                access: 'guest',
            }],
        },
    ];
}

function createFixture(t, {
    desired = localDesired(),
    routes: routeInputs = defaultRoutes(),
    policy = { schema: 'router-policy', httpRoutes: [], mcpTools: [] },
} = {}) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-generation-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    fs.mkdirSync(edgeDir, { recursive: true });
    fs.mkdirSync(policyDir, { recursive: true });
    const routes = {};
    const agents = {};
    for (const input of routeInputs) {
        const manifestDir = path.join(ploinkyDir, 'repos', input.repo, input.agent);
        fs.mkdirSync(manifestDir, { recursive: true });
        fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({
            httpServices: input.services || [],
            ...(input.manifest || {}),
        }, null, 2));
        routes[input.routeKey] = {
            repo: input.repo,
            agent: input.agent,
            container: `${input.routeKey}-container`,
            hostPath: manifestDir,
            hostPort: input.hostPort,
            ...(input.route || {}),
        };
        agents[`${input.routeKey}-container`] = {
            type: 'agent',
            repoName: input.repo,
            agentName: input.agent,
            ...(input.routeKey !== input.agent ? { alias: input.routeKey } : {}),
            instanceId: `${input.routeKey}-instance`,
            enableGeneration: `${input.routeKey}-enable-generation`,
            auth: { mode: 'local' },
        };
    }
    const routingFile = path.join(ploinkyDir, 'routing.json');
    const agentsFile = path.join(ploinkyDir, 'agents.json');
    const desiredFile = path.join(edgeDir, 'desired.json');
    const policyFile = path.join(policyDir, 'policy-state.json');
    fs.writeFileSync(routingFile, JSON.stringify({
        static: { agent: routeInputs[0]?.routeKey || '', port: 7777 },
        routes,
    }, null, 2));
    fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
    fs.writeFileSync(desiredFile, JSON.stringify(desired, null, 2));
    fs.writeFileSync(policyFile, JSON.stringify(policy));

    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    const previousRouterHostPort = process.env.PLOINKY_ROUTER_HOST_PORT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
    t.after(() => {
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        if (previousRouterHostPort === undefined) delete process.env.PLOINKY_ROUTER_HOST_PORT;
        else process.env.PLOINKY_ROUTER_HOST_PORT = previousRouterHostPort;
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    return { workspace, ploinkyDir, edgeDir, routingFile, agentsFile, desiredFile, policyFile };
}

function generationFile(result) {
    return path.join(
        result.paths.generationsDir,
        `${result.selector.generation.replace(/^sha256:/, '')}.json`,
    );
}

test('coordinated generation rejects publication-shaped httpServices fields', (t) => {
    const fixture = createFixture(t, {
        routes: [{
            routeKey: 'alpha',
            repo: 'fixtures',
            agent: 'alpha',
            hostPort: 43101,
            services: [{
                slug: 'dashboard',
                externalPrefix: '/services/alpha-dashboard/',
                internalPrefix: '/',
                access: 'authenticated',
                hostPort: 3000,
            }],
        }],
    });

    assert.throws(
        () => applyEdgeRoutingGeneration({
            workspaceRoot: fixture.workspace,
            reason: 'publication-shaped-service-field',
        }),
        (error) => error?.code === 'PLOINKY_MANIFEST_HTTP_SERVICE_INVALID'
            && /physical-host publication|httpServices\[\]\.port/.test(error.message),
    );
});

test('fresh edge initialization creates every explicit empty source exactly once', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-fresh-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const initialized = initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    assert.equal(initialized.initialized, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(initialized.paths.routingFile, 'utf8')), { routes: {} });
    assert.deepEqual(JSON.parse(fs.readFileSync(initialized.paths.agentsFile, 'utf8')), {});
    assert.deepEqual(JSON.parse(fs.readFileSync(initialized.paths.policyFile, 'utf8')), {
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(initialized.paths.desiredFile, 'utf8')), localDesired());
    assert.equal(initializeFreshEdgeRoutingSources({ workspaceRoot: workspace }).initialized, false);
});

test('prepared immutable generation remains inactive and publishes no active locator', (t) => {
    const fixture = createFixture(t);
    const prepared = prepareEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'runtime-replacement-preflight',
    });
    assert.equal(prepared.selector.state, 'inactive');
    assert.match(prepared.selector.generation, /^sha256:[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(generationFile(prepared)), true);
    assert.equal(prepared.topology.state, 'publication-error');
    assert.equal(prepared.topology.services.some((service) => (
        Object.hasOwn(service, 'activeBrowserUrl')
    )), false);
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
});

test('durable lifecycle preparation lease denies unrelated apply until exact commit', (t) => {
    const fixture = createFixture(t);
    const prepared = prepareEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'concurrent-lifecycle-preparation',
    });
    const leaseFile = prepared.paths.preparationLeaseFile;
    assert.equal(fs.statSync(leaseFile).mode & 0o777, 0o600);
    assert.throws(
        () => applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'unrelated-process-apply' }),
        { code: 'EDGE_PREPARATION_BUSY' },
    );
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );

    const routing = JSON.parse(fs.readFileSync(fixture.routingFile, 'utf8'));
    routing.routes.alpha.hostPort = 49123;
    fs.writeFileSync(fixture.routingFile, JSON.stringify(routing, null, 2));
    const committed = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'exact-lifecycle-commit',
        preparationLease: prepared.preparationLease,
    });
    assert.equal(committed.selector.state, 'active');
    assert.equal(fs.existsSync(leaseFile), false);
    assert.throws(
        () => applyEdgeRoutingGeneration({
            workspaceRoot: fixture.workspace,
            reason: 'replayed-lifecycle-commit',
            preparationLease: prepared.preparationLease,
        }),
        { code: 'EDGE_PREPARATION_STALE' },
    );
});

test('boolean lock claims cannot bypass the opaque edge apply capability', (t) => {
    const fixture = createFixture(t);
    withEdgeGenerationApplyLock(() => {
        assert.throws(
            () => inactivateEdgeRoutingGeneration('forged-lock-claim', {
                workspaceRoot: fixture.workspace,
                applyLockHeld: true,
            }),
            { code: 'EDGE_GENERATION_BUSY' },
        );
    }, { workspaceRoot: fixture.workspace });
});

test('a lifecycle preparation lease cannot authorize after its inactive selector changes', (t) => {
    const fixture = createFixture(t);
    const prepared = prepareEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'selector-bound-preparation',
    });
    inactivateEdgeRoutingGeneration('independent-emergency-inactivation', {
        workspaceRoot: fixture.workspace,
        preparationLease: prepared.preparationLease,
    });

    assert.throws(
        () => applyEdgeRoutingGeneration({
            workspaceRoot: fixture.workspace,
            reason: 'stale-selector-commit',
            preparationLease: prepared.preparationLease,
        }),
        { code: 'EDGE_PREPARATION_STALE' },
    );
    assert.equal(JSON.parse(fs.readFileSync(
        path.join(fixture.edgeDir, 'active.json'),
        'utf8',
    )).state, 'inactive');
    abortEdgeRoutingPreparation(prepared.preparationLease, {
        workspaceRoot: fixture.workspace,
        reason: 'test-stale-selector-abort',
    });
});

test('lifecycle commit rejects launch profile changes made after runtime preparation', (t) => {
    const fixture = createFixture(t);
    const agents = JSON.parse(fs.readFileSync(fixture.agentsFile, 'utf8'));
    agents['alpha-container'].profile = 'default';
    fs.writeFileSync(fixture.agentsFile, JSON.stringify(agents, null, 2));
    const prepared = prepareEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'profile-bound-preparation',
    });
    agents['alpha-container'].profile = 'production';
    fs.writeFileSync(fixture.agentsFile, JSON.stringify(agents, null, 2));

    assert.throws(
        () => applyEdgeRoutingGeneration({
            workspaceRoot: fixture.workspace,
            reason: 'profile-bound-commit',
            preparationLease: prepared.preparationLease,
        }),
        { code: 'EDGE_PREPARATION_SOURCE_CHANGED' },
    );
    assert.equal(JSON.parse(fs.readFileSync(
        path.join(fixture.edgeDir, 'active.json'),
        'utf8',
    )).state, 'inactive');
    abortEdgeRoutingPreparation(prepared.preparationLease, {
        workspaceRoot: fixture.workspace,
        reason: 'test-profile-change-abort',
    });
});

test('lifecycle commit rejects manifest changes made after runtime preparation', (t) => {
    const fixture = createFixture(t);
    const prepared = prepareEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'manifest-bound-preparation',
    });
    const routing = JSON.parse(fs.readFileSync(fixture.routingFile, 'utf8'));
    const manifestFile = path.join(routing.routes.alpha.hostPath, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.httpServices[0].externalPrefix = '/services/edited-after-launch/';
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    assert.throws(
        () => applyEdgeRoutingGeneration({
            workspaceRoot: fixture.workspace,
            reason: 'manifest-bound-commit',
            preparationLease: prepared.preparationLease,
        }),
        { code: 'EDGE_PREPARATION_SOURCE_CHANGED' },
    );
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
    const aborted = abortEdgeRoutingPreparation(prepared.preparationLease, {
        workspaceRoot: fixture.workspace,
        reason: 'test-explicit-abort',
    });
    assert.equal(aborted.selector.state, 'inactive');
    assert.equal(fs.existsSync(prepared.paths.preparationLeaseFile), false);
});

for (const [label, sourceKey] of [
    ['persisted policy', 'policyFile'],
    ['edge desired state', 'desiredFile'],
    ['enabled-agent registry', 'agentsFile'],
]) {
    test(`missing ${label} leaves coordinated apply inactive instead of installing an empty substitute`, (t) => {
        const fixture = createFixture(t);
        applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'missing-source-baseline' });
        fs.rmSync(fixture[sourceKey]);
        assert.throws(
            () => applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'missing-source-test' }),
            /is unavailable/,
        );
        const selector = JSON.parse(fs.readFileSync(
            path.join(fixture.edgeDir, 'active.json'),
            'utf8',
        ));
        assert.equal(selector.state, 'inactive');
        assert.throws(
            () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
            /inactive/,
        );
    });
}

function plan(host, url, listener = 'public') {
    return resolveEdgeRoutePlan({
        req: { method: 'GET', url, headers: { host } },
        parsedUrl: new URL(url, `http://${host}`),
        listener,
    });
}

test('active generation reconstructs semantics from exact bytes and rejects stored semantic tampering', (t) => {
    const fixture = createFixture(t);
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'semantic-tamper-test' });
    const file = generationFile(applied);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.compiled.services[0].access = 'public';
    fs.writeFileSync(file, JSON.stringify(stored, null, 2));

    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_CORRUPT' },
    );
});

test('active generation rejects noncanonical source base64 and undeclared semantic fields', (t) => {
    const fixture = createFixture(t);
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'base64-test' });
    const file = generationFile(applied);
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    const noncanonical = structuredClone(original);
    noncanonical.sources.routing = `${noncanonical.sources.routing}\n`;
    fs.writeFileSync(file, JSON.stringify(noncanonical, null, 2));
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_CORRUPT' },
    );

    const undeclared = structuredClone(original);
    undeclared.routing = { routes: {} };
    fs.writeFileSync(file, JSON.stringify(undeclared, null, 2));
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_CORRUPT' },
    );
});

test('same-size same-mtime staged policy edits have no effect before coordinated apply', (t) => {
    const fixture = createFixture(t, {
        policy: {
            schema: 'router-policy',
            httpRoutes: [{ path: '/alpha/*', access: 'authenticated' }],
            mcpTools: [],
        },
    });
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'staging-test' });
    assert.equal(plan('localhost', '/alpha/resource').decision.access, 'authenticated');

    const before = fs.statSync(fixture.policyFile);
    const original = fs.readFileSync(fixture.policyFile, 'utf8');
    const staged = original.replace('"authenticated"', '"public"       ');
    assert.equal(Buffer.byteLength(staged), Buffer.byteLength(original));
    fs.writeFileSync(fixture.policyFile, staged);
    fs.utimesSync(fixture.policyFile, before.atime, before.mtime);

    assert.equal(plan('localhost', '/alpha/resource').decision.access, 'authenticated');
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'staging-apply' });
    assert.equal(plan('localhost', '/alpha/resource').decision.access, 'public');
});

test('exact-generation commit rejects changed candidate bytes before authorization can move', (t) => {
    const fixture = createFixture(t, {
        policy: {
            schema: 'router-policy',
            httpRoutes: [{ path: '/alpha/*', access: 'authenticated' }],
            mcpTools: [],
        },
    });
    const initial = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'exact-commit-initial' });
    const changed = JSON.parse(fs.readFileSync(fixture.policyFile, 'utf8'));
    changed.httpRoutes[0].access = 'public';
    fs.writeFileSync(fixture.policyFile, JSON.stringify(changed));

    assert.throws(
        () => applyEdgeRoutingGeneration({
            workspaceRoot: fixture.workspace,
            reason: 'stale-publication-commit',
            expectedGeneration: initial.selector.generation,
            testHooks: {
                beforeSelectorCommit: () => assert.fail('stale exact commit reached selector authorization'),
            },
        }),
        { code: 'EDGE_GENERATION_RACE' },
    );
    const stillActive = loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace });
    assert.equal(stillActive.selector.generation, initial.selector.generation);
    assert.equal(plan('localhost', '/alpha/resource').decision.access, 'authenticated');
});

test('physical Router host port is an exact generation input and a changed supervisor value fails closed until apply', (t) => {
    const fixture = createFixture(t);
    const initial = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'router-host-port-initial',
    });
    assert.equal(initial.generation.routerHostPort, 18080);
    assert.equal(
        initial.generation.compiled.locators.find((entry) => entry.slug === 'dashboard').configuredBrowserUrl,
        'http://dashboard.alpha.localhost:18080/',
    );

    process.env.PLOINKY_ROUTER_HOST_PORT = '18081';
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_RUNTIME_MISMATCH' },
    );

    const changed = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'router-host-port-changed',
    });
    assert.notEqual(changed.selector.generation, initial.selector.generation);
    assert.equal(changed.generation.routerHostPort, 18081);
    assert.equal(
        changed.generation.compiled.locators.find((entry) => entry.slug === 'dashboard').configuredBrowserUrl,
        'http://dashboard.alpha.localhost:18081/',
    );
});

test('corrupt selector installs no generation and snapshots are deeply frozen', (t) => {
    const fixture = createFixture(t);
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'selector-test' });
    const active = loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace });
    assert.equal(Object.isFrozen(active), true);
    assert.equal(Object.isFrozen(active.generation.compiled.services[0]), true);
    assert.throws(() => {
        active.generation.compiled.services[0].slug = 'changed';
    }, TypeError);

    fs.writeFileSync(applied.paths.activeSelectorFile, '{not-json');
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
});

test('selector field tampering fails closed even when selector JSON remains valid', (t) => {
    const fixture = createFixture(t, {
        desired: localDesired({
            hosts: {
                'dashboard.example.test': {
                    agent: 'fixtures/alpha',
                    httpService: 'dashboard',
                },
            },
            cloudflare: completeCloudflare(),
        }),
    });
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'selector-digest-test' });
    const selector = JSON.parse(fs.readFileSync(applied.paths.activeSelectorFile, 'utf8'));
    selector.publicationState = 'cloudflare-ready';
    fs.writeFileSync(applied.paths.activeSelectorFile, JSON.stringify(selector, null, 2));
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
});

test('generation lease is invalidated by inactivation and by same-digest reactivation', (t) => {
    const fixture = createFixture(t);
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'lease-test' });
    const lease = captureEdgeRoutingLease({ workspaceRoot: fixture.workspace });
    assert.equal(lease.commit(), true);
    inactivateEdgeRoutingGeneration('test-invalidation', { workspaceRoot: fixture.workspace });
    assert.equal(lease.isCurrent(), false);
    assert.equal(lease.commit(), false);

    const reapplied = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'lease-reactivation' });
    assert.equal(reapplied.selector.generation, lease.id);
    assert.notEqual(reapplied.selector.activationId, lease.activationId);
    assert.equal(lease.commit(), false);
});

test('host-network capability resolves desired names to exact current instance generations', (t) => {
    const fixture = createFixture(t, {
        desired: localDesired({
            security: {
                hostNetworkAllowedInstances: ['fixtures/alpha'],
                internalServiceConsumers: {},
            },
        }),
    });
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'host-capability-test' });
    assert.deepEqual(applied.generation.compiled.security.hostNetworkCapabilities, [{
        agentId: 'agent:fixtures/alpha',
        instanceId: 'alpha-instance',
        enableGeneration: 'alpha-enable-generation',
        routeKey: 'alpha',
        containerName: 'alpha-container',
    }]);
    assert.equal(assertHostModeGenerationCapability({
        agentId: 'agent:fixtures/alpha',
        instanceId: 'alpha-instance',
        enableGeneration: 'alpha-enable-generation',
        routeKey: 'alpha',
        containerName: 'alpha-container',
    }, { workspaceRoot: fixture.workspace }), applied.selector.generation);
    assert.throws(() => assertHostModeGenerationCapability({
        agentId: 'agent:fixtures/alpha',
        instanceId: 'alpha-instance',
        enableGeneration: 'stale',
        routeKey: 'alpha',
        containerName: 'alpha-container',
    }, { workspaceRoot: fixture.workspace }), { code: 'HOST_MODE_CAPABILITY_DENIED' });
    for (const changed of [
        { routeKey: 'alpha-confusable' },
        { containerName: 'alpha-container-confusable' },
    ]) {
        assert.throws(() => assertHostModeGenerationCapability({
            agentId: 'agent:fixtures/alpha',
            instanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
            routeKey: 'alpha',
            containerName: 'alpha-container',
            ...changed,
        }, { workspaceRoot: fixture.workspace }), { code: 'HOST_MODE_CAPABILITY_DENIED' });
    }
});

test('media address changes restart only the exact capability owner while resolver-only changes never restart', (t) => {
    const fixture = createFixture(t, {
        desired: localDesired({
            media: {
                publicIPv4: '8.8.8.8',
                addressMode: 'nat-forward',
            },
            security: {
                hostNetworkAllowedInstances: ['fixtures/alpha'],
                internalServiceConsumers: {},
            },
        }),
    });
    const initial = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'initial-media-generation',
    });

    const desired = JSON.parse(fs.readFileSync(fixture.desiredFile, 'utf8'));
    desired.media.publicIPv4 = '8.8.4.4';
    fs.writeFileSync(fixture.desiredFile, JSON.stringify(desired, null, 2));
    let restarted = null;
    const changed = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'media-address-change',
        restartCapabilityRuntime(contract) {
            restarted = contract;
            assert.equal(contract.owner.containerName, 'alpha-container');
            assert.equal(contract.assertSelectorsInactive({
                containerName: contract.owner.containerName,
                affectedSelectors: contract.affectedSelectors,
            }), true);
            assert.equal(assertHostModeGenerationCapability({
                agentId: contract.owner.agentId,
                instanceId: contract.owner.instanceId,
                enableGeneration: contract.owner.enableGeneration,
                routeKey: contract.owner.routeKey,
                containerName: contract.owner.containerName,
            }, {
                preparedCapability: contract.preparedHostModeCapability,
            }), contract.generation.generation);
        },
    });
    assert.ok(restarted);
    assert.deepEqual(restarted.affectedSelectors, [...restarted.affectedSelectors].sort());
    assert.ok(restarted.affectedSelectors.includes('media:agent:fixtures/alpha'));
    assert.ok(restarted.affectedSelectors.includes('runtime:alpha-container'));
    assert.notEqual(changed.selector.generation, initial.selector.generation);
    assert.equal(loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }).selector.generation, changed.selector.generation);

    let resolverOnlyRestarts = 0;
    const withTurn = JSON.parse(fs.readFileSync(fixture.desiredFile, 'utf8'));
    withTurn.turn = {
        urls: [
            'turn:turn.example.test:3478?transport=udp',
            'turns:turn.example.test:5349?transport=tcp',
        ],
        credentialMode: 'turn-rest',
        sharedSecret: 'media/turn-rest',
        credentialConsumers: ['fixtures/beta'],
    };
    fs.writeFileSync(fixture.desiredFile, JSON.stringify(withTurn, null, 2));
    applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'turn-resolver-only-change',
        restartCapabilityRuntime() { resolverOnlyRestarts += 1; },
    });
    applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'readiness-only-publication-change',
        publicationState: 'publication-error',
        restartCapabilityRuntime() { resolverOnlyRestarts += 1; },
    });
    assert.equal(resolverOnlyRestarts, 0);
});

test('first media configuration for an owner absent from the prior generation does not restart', (t) => {
    const fixture = createFixture(t);
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'owner-absent-baseline' });

    const desired = JSON.parse(fs.readFileSync(fixture.desiredFile, 'utf8'));
    desired.media = { publicIPv4: '8.8.8.8', addressMode: 'direct' };
    desired.security.hostNetworkAllowedInstances = ['fixtures/alpha'];
    fs.writeFileSync(fixture.desiredFile, JSON.stringify(desired, null, 2));
    let effectiveChecks = 0;
    let restarts = 0;
    applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'owner-absent-first-media',
        isCapabilityRuntimeEffective() { effectiveChecks += 1; return true; },
        restartCapabilityRuntime() { restarts += 1; },
    });
    assert.equal(effectiveChecks, 0);
    assert.equal(restarts, 0);
});

test('registered but never-started media owner consumes initial config on normal launch', (t) => {
    const fixture = createFixture(t, {
        desired: localDesired({
            security: {
                hostNetworkAllowedInstances: ['fixtures/alpha'],
                internalServiceConsumers: {},
            },
        }),
    });
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'registered-owner-baseline' });

    const desired = JSON.parse(fs.readFileSync(fixture.desiredFile, 'utf8'));
    desired.media = { publicIPv4: '8.8.8.8', addressMode: 'direct' };
    fs.writeFileSync(fixture.desiredFile, JSON.stringify(desired, null, 2));
    let effectiveChecks = 0;
    let restarts = 0;
    applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'registered-owner-first-media',
        isCapabilityRuntimeEffective() { effectiveChecks += 1; return false; },
        restartCapabilityRuntime() { restarts += 1; },
    });
    assert.equal(effectiveChecks, 1);
    assert.equal(restarts, 0);
});

test('running effective prior-generation media owner is targeted for initial config restart', (t) => {
    const fixture = createFixture(t, {
        desired: localDesired({
            security: {
                hostNetworkAllowedInstances: ['fixtures/alpha'],
                internalServiceConsumers: {},
            },
        }),
    });
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'effective-owner-baseline' });

    const desired = JSON.parse(fs.readFileSync(fixture.desiredFile, 'utf8'));
    desired.media = { publicIPv4: '8.8.8.8', addressMode: 'direct' };
    fs.writeFileSync(fixture.desiredFile, JSON.stringify(desired, null, 2));
    let effectiveChecks = 0;
    let restarts = 0;
    applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'effective-owner-first-media',
        isCapabilityRuntimeEffective(contract) {
            effectiveChecks += 1;
            assert.equal(contract.owner.containerName, 'alpha-container');
            return true;
        },
        restartCapabilityRuntime() { restarts += 1; },
    });
    assert.equal(effectiveChecks, 1);
    assert.equal(restarts, 1);
});

test('failed media drain leaves the selected generation inactive with no old locator fallback', (t) => {
    const fixture = createFixture(t, {
        desired: localDesired({
            media: { publicIPv4: '8.8.8.8', addressMode: 'direct' },
            security: {
                hostNetworkAllowedInstances: ['fixtures/alpha'],
                internalServiceConsumers: {},
            },
        }),
    });
    const baseline = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'media-drain-baseline' });
    const desired = JSON.parse(fs.readFileSync(fixture.desiredFile, 'utf8'));
    desired.media.addressMode = 'nat-forward';
    fs.writeFileSync(fixture.desiredFile, JSON.stringify(desired, null, 2));
    assert.throws(() => applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'media-drain-failure',
        restartCapabilityRuntime() {
            const error = new Error('application drain was not acknowledged');
            error.code = 'TARGETED_DRAIN_FAILED';
            throw error;
        },
    }), { code: 'TARGETED_DRAIN_FAILED' });
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
    const topology = readCurrentEdgeTopology({ workspaceRoot: fixture.workspace });
    assert.equal(topology.state, 'publication-error');
    assert.equal(topology.services.some((service) => service.activeBrowserUrl), false);
    const failedSelector = JSON.parse(fs.readFileSync(baseline.paths.activeSelectorFile, 'utf8'));
    assert.equal(failedSelector.state, 'inactive');
    assert.equal(failedSelector.generation, topology.authorizationGeneration);
    assert.equal(failedSelector.previousGeneration, baseline.selector.generation);

    let repairRestarts = 0;
    const repaired = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'media-drain-repair',
        restartCapabilityRuntime(contract) {
            repairRestarts += 1;
            assert.equal(contract.generation.generation, failedSelector.generation);
            assert.equal(contract.assertSelectorsInactive({
                containerName: contract.owner.containerName,
                affectedSelectors: contract.affectedSelectors,
            }), true);
        },
    });
    assert.equal(repairRestarts, 1);
    assert.equal(repaired.selector.state, 'active');
    assert.equal(repaired.selector.generation, failedSelector.generation);
});

test('hard-cut desired schema rejects mode, selectors, and old capability aliases', (t) => {
    const fixture = createFixture(t, {
        desired: {
            schemaVersion: 1,
            mode: 'local-only',
            selectors: [],
            hosts: {},
            security: {
                hostModeCapabilities: [],
                internalServiceConsumers: {},
            },
        },
    });
    assert.throws(
        () => applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'old-schema-test' }),
        /unsupported field 'mode'/,
    );
});

test('media public IPv4 accepts only an exact globally routable unicast literal', (t) => {
    const nonGlobal = {
        'this-network': ['0.0.0.0', '0.255.255.255'],
        'private-use': ['10.0.0.0', '10.255.255.255', '172.16.0.0', '172.31.255.255', '192.168.0.0', '192.168.255.255'],
        'shared-address-space': ['100.64.0.0', '100.127.255.255'],
        loopback: ['127.0.0.0', '127.255.255.255'],
        'link-local': ['169.254.0.0', '169.254.255.255'],
        'protocol-and-anycast-special-use': ['192.0.0.0', '192.0.0.9', '192.0.0.10', '192.0.0.255'],
        documentation: ['192.0.2.1', '198.51.100.1', '203.0.113.1'],
        'special-purpose-services': ['192.31.196.1', '192.52.193.1', '192.88.99.2', '192.175.48.1'],
        benchmarking: ['198.18.0.0', '198.19.255.255'],
        multicast: ['224.0.0.0', '239.255.255.255'],
        'reserved-and-broadcast': ['240.0.0.0', '255.255.255.255'],
    };
    for (const [category, addresses] of Object.entries(nonGlobal)) {
        for (const address of addresses) {
            assert.throws(
                () => normalizePublicMediaIPv4(address),
                /globally routable unicast IPv4/,
                `${category} address ${address} must fail closed`,
            );
        }
    }
    for (const invalidLiteral of [8_080_808, '', ' 8.8.8.8', '8.8.8.8 ', '008.8.8.8', '8.8.8', '8.8.8.8.8', '2001:4860:4860::8888']) {
        assert.throws(
            () => normalizePublicMediaIPv4(invalidLiteral),
            /exact canonical literal IPv4/,
            `non-literal ${String(invalidLiteral)} must fail closed`,
        );
    }
    for (const address of ['1.1.1.1', '8.8.8.8', '9.9.9.9', '208.67.222.222']) {
        assert.equal(normalizePublicMediaIPv4(address), address);
    }

    const fixture = createFixture(t, {
        desired: localDesired({
            media: { publicIPv4: '203.0.113.42', addressMode: 'direct' },
        }),
    });
    assert.throws(
        () => applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'non-global-media-address' }),
        /globally routable unicast IPv4/,
    );
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
});

test('named desired-state service selection requires an exact lower-case slug', (t) => {
    for (const httpService of ['dashboard ', ' Dashboard', 'DASHBOARD', '', null, true]) {
        const fixture = createFixture(t, {
            desired: localDesired({
                hosts: {
                    'dashboard.example.test': {
                        agent: 'fixtures/alpha',
                        httpService,
                    },
                },
                cloudflare: completeCloudflare(),
            }),
        });
        assert.throws(
            () => applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'invalid-named-service-slug' }),
            /exact lower-case service slug/,
        );
    }
});

test('TURN configuration requires explicit external UDP and TLS relay lanes', (t) => {
    const fixture = createFixture(t, {
        desired: localDesired({
            turn: {
                urls: ['turn:turn.example.test:3478?transport=udp'],
                credentialMode: 'turn-rest',
                sharedSecret: 'media/turn-rest',
                credentialConsumers: ['fixtures/beta'],
            },
        }),
    });
    assert.throws(
        () => applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'missing-turn-tls-test' }),
        /both external TURN\/UDP and TURN\/TLS lanes/,
    );
});

test('alias collisions and overlapping service prefixes fail generation compilation', (t) => {
    const aliasFixture = createFixture(t, {
        routes: [{
            routeKey: 'Alpha',
            repo: 'fixtures',
            agent: 'one',
            hostPort: 43101,
            services: [{
                slug: 'dashboard',
                externalPrefix: '/services/one/',
                internalPrefix: '/',
                access: 'authenticated',
            }],
        }, {
            routeKey: 'alpha',
            repo: 'fixtures',
            agent: 'two',
            hostPort: 43102,
            services: [{
                slug: 'dashboard',
                externalPrefix: '/services/two/',
                internalPrefix: '/',
                access: 'authenticated',
            }],
        }],
    });
    assert.throws(
        () => applyEdgeRoutingGeneration({ workspaceRoot: aliasFixture.workspace, reason: 'alias-collision-test' }),
        /local service alias collision/,
    );

    const overlapFixture = createFixture(t, {
        routes: [{
            routeKey: 'alpha',
            repo: 'fixtures',
            agent: 'alpha',
            hostPort: 43101,
            services: [{
                slug: 'editor',
                externalPrefix: '/services/editor/',
                internalPrefix: '/',
                access: 'authenticated',
            }],
        }, {
            routeKey: 'beta',
            repo: 'fixtures',
            agent: 'beta',
            hostPort: 43102,
            services: [{
                slug: 'assets',
                externalPrefix: '/services/editor/assets/',
                internalPrefix: '/',
                access: 'authenticated',
            }],
        }],
    });
    assert.throws(
        () => applyEdgeRoutingGeneration({ workspaceRoot: overlapFixture.workspace, reason: 'prefix-overlap-test' }),
        /HTTP service prefix overlap/,
    );
});

test('generation canonicalizes delegation queryPathRoots aliases', (t) => {
    const fixture = createFixture(t, {
        routes: [{
            routeKey: 'alpha',
            repo: 'fixtures',
            agent: 'alpha',
            hostPort: 43101,
            services: [{
                slug: 'dashboard',
                externalPrefix: '/services/alpha-dashboard/',
                internalPrefix: '/',
                access: 'authenticated',
                delegations: [{
                    targetAgentId: 'agent:fixtures/beta',
                    tools: ['records.read'],
                    scopes: ['records:read'],
                    when: { queryPathRoots: ['/Confidential', 'Confidential/', ''] },
                }],
            }],
        }],
    });

    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'delegation-query-path-roots',
    });

    assert.deepEqual(applied.generation.compiled.services[0].delegations[0].when, {
        queryParam: 'path',
        pathRoots: ['/Confidential'],
    });
});

test('reconciling and error topology omit active locators and all secret handles', (t) => {
    const fixture = createFixture(t, {
        desired: localDesired({
            hosts: {
                'dashboard.example.test': {
                    agent: 'fixtures/alpha',
                    httpService: 'dashboard',
                },
            },
            cloudflare: completeCloudflare(),
            media: {
                publicIPv4: '8.8.8.8',
                addressMode: 'nat-forward',
            },
            turn: {
                urls: [
                    'turn:turn.example.test:3478?transport=udp',
                    'turns:turn.example.test:5349?transport=tcp',
                ],
                credentialMode: 'turn-rest',
                sharedSecret: 'media/turn-rest',
                credentialConsumers: ['fixtures/beta'],
            },
        }),
    });
    const reconciling = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'topology-reconciling-test' });
    assert.equal(reconciling.topology.state, 'cloudflare-reconciling');
    assert.equal(reconciling.topology.services.some((entry) => entry.activeBrowserUrl), false);
    assert.equal(plan('dashboard.example.test', '/').code, 'HOST_SELECTOR_INACTIVE');
    const serialized = JSON.stringify(reconciling.topology);
    assert.equal(serialized.includes('publication/cloudflare'), false);
    assert.equal(serialized.includes('media/turn-rest'), false);
    assert.equal(serialized.includes('test-account'), false);
    assert.deepEqual(reconciling.topology.media.turn, {
        urls: [
            'turn:turn.example.test:3478?transport=udp',
            'turns:turn.example.test:5349?transport=tcp',
        ],
        credentialMode: 'turn-rest',
        credentialPath: '/api/edge/turn-credentials',
    });

    const failed = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'topology-error-test',
        publicationState: 'publication-error',
    });
    assert.equal(failed.topology.services.some((entry) => entry.activeBrowserUrl), false);
    assert.equal(readCurrentEdgeTopology({ workspaceRoot: fixture.workspace }).state, 'publication-error');
    assert.equal(failed.topology.configurationGeneration, reconciling.topology.configurationGeneration);
    assert.equal(failed.topology.authorizationGeneration, reconciling.topology.authorizationGeneration);
    assert.equal(failed.topology.publicationGeneration, reconciling.topology.publicationGeneration + 1);

    const ready = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'topology-ready-test',
        publicationState: 'cloudflare-ready',
    });
    assert.equal(ready.topology.services.find((entry) => entry.slug === 'dashboard').activeBrowserUrl, 'https://dashboard.example.test/');
    assert.equal(ready.topology.configurationGeneration, reconciling.topology.configurationGeneration);
    assert.equal(ready.topology.authorizationGeneration, reconciling.topology.authorizationGeneration);
    assert.equal(ready.topology.publicationGeneration, failed.topology.publicationGeneration + 1);
});

test('target-only changes advance publication and authorization generations without changing consumer configuration', (t) => {
    const fixture = createFixture(t);
    const routing = JSON.parse(fs.readFileSync(fixture.routingFile, 'utf8'));
    delete routing.routes.alpha.hostPort;
    fs.writeFileSync(fixture.routingFile, JSON.stringify(routing, null, 2));
    const initial = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'initial-target-generation',
    });
    routing.routes.alpha.hostPort = 43201;
    fs.writeFileSync(fixture.routingFile, JSON.stringify(routing, null, 2));

    const changed = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'changed-target-generation',
    });
    assert.notEqual(changed.selector.generation, initial.selector.generation);
    assert.equal(initial.topology.authorizationGeneration, initial.selector.generation);
    assert.equal(changed.topology.authorizationGeneration, changed.selector.generation);
    assert.notEqual(changed.topology.authorizationGeneration, initial.topology.authorizationGeneration);
    assert.equal(changed.topology.configurationGeneration, initial.topology.configurationGeneration);
    assert.equal(changed.topology.publicationGeneration, initial.topology.publicationGeneration + 1);
    assert.equal(initial.generation.compiled.services.find((entry) => entry.routeKey === 'alpha').target, null);
    assert.notDeepEqual(
        changed.generation.compiled.services.find((entry) => entry.routeKey === 'alpha').target,
        initial.generation.compiled.services.find((entry) => entry.routeKey === 'alpha').target,
    );
});

test('current topology rejects invalid authorization generation digests', (t) => {
    const fixture = createFixture(t);
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'invalid-topology-authorization-generation',
    });
    const topology = JSON.parse(fs.readFileSync(applied.paths.topologyCurrentFile, 'utf8'));
    topology.authorizationGeneration = 'sha256:invalid';
    fs.writeFileSync(applied.paths.topologyCurrentFile, JSON.stringify(topology, null, 2));
    assert.throws(
        () => readCurrentEdgeTopology({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_TOPOLOGY_INVALID' },
    );
});

test('coordinated apply rejects structurally invalid persisted and manifest policy sources', (t) => {
    const persistedFixture = createFixture(t);
    applyEdgeRoutingGeneration({ workspaceRoot: persistedFixture.workspace, reason: 'valid-policy-baseline' });
    fs.writeFileSync(persistedFixture.policyFile, JSON.stringify({
        schema: 'router-policy',
        httpRoutes: [{ path: '/alpha/private/*', access: 'bogus' }],
        mcpTools: [],
    }));
    assert.throws(
        () => applyEdgeRoutingGeneration({ workspaceRoot: persistedFixture.workspace, reason: 'invalid-persisted-policy' }),
        { code: 'HTTP_ROUTE_POLICY_INVALID' },
    );
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: persistedFixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );

    const manifestFixture = createFixture(t, {
        routes: [{
            routeKey: 'alpha',
            repo: 'fixtures',
            agent: 'alpha',
            hostPort: 43101,
            services: [],
            manifest: {
                routerAccess: {
                    httpRoutes: [{ path: '/private/*', access: 'bogus' }],
                },
            },
        }],
    });
    assert.throws(
        () => applyEdgeRoutingGeneration({ workspaceRoot: manifestFixture.workspace, reason: 'invalid-manifest-policy' }),
        /routerAccess\.httpRoutes\[0\] is invalid/,
    );
});

test('policy compilation records pathname partitions and method-specific winners', (t) => {
    const fixture = createFixture(t, {
        routes: [{
            routeKey: 'beta',
            repo: 'fixtures',
            agent: 'beta',
            hostPort: 43102,
            services: [{
                slug: 'telemetry',
                externalPrefix: '/public-services/telemetry/',
                internalPrefix: '/collect/',
                access: 'public',
            }],
        }],
        policy: {
            schema: 'router-policy',
            httpRoutes: [{
                path: '/public-services/telemetry/admin',
                access: 'authenticated',
                routeKey: 'beta',
            }, {
                path: '/public-services/telemetry/reports/*',
                access: 'guest',
                routeKey: 'beta',
                guestScope: 'telemetry-reports',
            }],
            mcpTools: [],
        },
    });
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'policy-partition-matrix' });
    const namespace = applied.generation.compiled.policy.namespaces.find((entry) => (
        entry.id === 'service:beta/telemetry'
    ));
    assert.ok(namespace);
    const root = namespace.partitions.find((entry) => entry.representative === '/public-services/telemetry');
    const admin = namespace.partitions.find((entry) => entry.representative === '/public-services/telemetry/admin');
    const adminChild = namespace.partitions.find((entry) => entry.representative.startsWith('/public-services/telemetry/admin/'));
    const reports = namespace.partitions.find((entry) => entry.representative === '/public-services/telemetry/reports');
    const reportsChild = namespace.partitions.find((entry) => entry.representative.startsWith('/public-services/telemetry/reports/'));
    assert.deepEqual([root.methods.GET.access, root.methods.HEAD.access, root.methods.POST.access], ['public', 'public', 'deny']);
    assert.equal(admin.winner.access, 'authenticated');
    assert.equal(admin.winner.routeKey, 'beta');
    assert.equal(adminChild.winner.access, 'public');
    assert.equal(reports.winner.access, 'guest');
    assert.equal(reports.winner.guestScope, 'telemetry-reports');
    assert.equal(reportsChild.winner.access, 'guest');
});

test('equal-rank policy ties accept equivalent execution metadata and reject conflicts', (t) => {
    const publicFixture = createFixture(t, {
        routes: [{
            routeKey: 'beta',
            repo: 'fixtures',
            agent: 'beta',
            hostPort: 43102,
            services: [{
                slug: 'telemetry',
                externalPrefix: '/public-services/telemetry/',
                internalPrefix: '/collect/',
                access: 'public',
            }],
        }],
        policy: {
            schema: 'router-policy',
            httpRoutes: [{ path: '/public-services/telemetry/*', access: 'public' }],
            mcpTools: [],
        },
    });
    assert.doesNotThrow(() => applyEdgeRoutingGeneration({
        workspaceRoot: publicFixture.workspace,
        reason: 'equivalent-public-tie',
    }));

    const guestFixture = createFixture(t, {
        policy: {
            schema: 'router-policy',
            httpRoutes: [{
                path: '/public-services/telemetry/*',
                access: 'guest',
                routeKey: 'beta',
                guestScope: 'http-service:beta:/public-services/telemetry/',
            }],
            mcpTools: [],
        },
    });
    assert.doesNotThrow(() => applyEdgeRoutingGeneration({
        workspaceRoot: guestFixture.workspace,
        reason: 'equivalent-guest-tie',
    }));
    const policy = JSON.parse(fs.readFileSync(guestFixture.policyFile, 'utf8'));
    policy.httpRoutes[0].guestScope = 'conflicting-scope';
    fs.writeFileSync(guestFixture.policyFile, JSON.stringify(policy));
    assert.throws(
        () => applyEdgeRoutingGeneration({ workspaceRoot: guestFixture.workspace, reason: 'conflicting-guest-tie' }),
        { code: 'HTTP_ROUTE_POLICY_TIE' },
    );
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: guestFixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
});

test('selector is the final apply commit and stale crash locks are recoverable', (t) => {
    const fixture = createFixture(t);
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'selector-order-baseline' });
    let observed = null;
    assert.throws(() => applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'selector-order-fault',
        testHooks: {
            beforeSelectorCommit({ paths }) {
                observed = {
                    selector: JSON.parse(fs.readFileSync(paths.activeSelectorFile, 'utf8')),
                    topologyExists: fs.existsSync(paths.topologyCurrentFile),
                };
                throw new Error('injected pre-selector crash');
            },
        },
    }), /injected pre-selector crash/);
    assert.equal(observed.selector.state, 'inactive');
    assert.equal(observed.topologyExists, true);
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );

    const paths = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'selector-order-recovery' }).paths;
    inactivateEdgeRoutingGeneration('simulate-crashed-apply', { workspaceRoot: fixture.workspace });
    fs.writeFileSync(paths.applyLockFile, JSON.stringify({
        pid: 99_999_999,
        lockId: '00000000-0000-4000-8000-000000000001',
        createdAt: new Date().toISOString(),
    }));
    assert.doesNotThrow(() => applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'stale-lock-recovery',
    }));
});

test('ordinary apply cannot overwrite a selector changed before authorization commit', (t) => {
    const fixture = createFixture(t);
    assert.throws(() => applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'selector-cas-race',
        testHooks: {
            beforeSelectorCommit({ paths }) {
                fs.writeFileSync(paths.activeSelectorFile, JSON.stringify({
                    schemaVersion: 1,
                    state: 'inactive',
                    reason: 'concurrent-candidate-mutation',
                }));
            },
        },
    }), { code: 'EDGE_GENERATION_RACE' });
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
});

test('unparsable apply locks fail closed and preserve the active generation', (t) => {
    const fixture = createFixture(t);
    const baseline = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'invalid-lock-baseline',
    });
    fs.writeFileSync(baseline.paths.applyLockFile, '{not-a-lock');

    assert.throws(
        () => applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'invalid-lock-retry' }),
        { code: 'EDGE_GENERATION_BUSY' },
    );
    const stillActive = loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace });
    assert.equal(stillActive.selector.generation, baseline.selector.generation);
    assert.equal(fs.readFileSync(baseline.paths.applyLockFile, 'utf8'), '{not-a-lock');
});

test('torn immutable generation temp cannot poison retry and selector stays inactive', (t) => {
    const fixture = createFixture(t);
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'generation-temp-baseline' });
    fs.appendFileSync(fixture.desiredFile, '\n');
    let crashArtifact;
    let immutableFile;

    assert.throws(() => applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'generation-temp-crash',
        testHooks: {
            afterGenerationTempFsync({ file, tmp }) {
                immutableFile = file;
                crashArtifact = tmp;
                fs.truncateSync(tmp, 7);
                throw new Error('injected generation temp crash');
            },
        },
    }), /injected generation temp crash/);
    assert.equal(fs.existsSync(crashArtifact), true);
    assert.equal(fs.statSync(crashArtifact).size, 7);
    assert.equal(fs.existsSync(immutableFile), false);
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );

    const retried = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'generation-temp-retry',
    });
    assert.equal(retried.selector.state, 'active');
    assert.equal(fs.existsSync(immutableFile), true);
    assert.equal(fs.existsSync(crashArtifact), true);
});

test('torn immutable topology temp cannot poison retry and selector stays inactive', (t) => {
    const fixture = createFixture(t);
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'topology-temp-baseline' });
    fs.appendFileSync(fixture.desiredFile, '\n');
    let crashArtifact;
    let immutableFile;

    assert.throws(() => applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'topology-temp-crash',
        testHooks: {
            afterTopologyTempFsync({ file, tmp }) {
                immutableFile = file;
                crashArtifact = tmp;
                fs.truncateSync(tmp, 9);
                throw new Error('injected topology temp crash');
            },
        },
    }), /injected topology temp crash/);
    assert.equal(fs.existsSync(crashArtifact), true);
    assert.equal(fs.statSync(crashArtifact).size, 9);
    assert.equal(fs.existsSync(immutableFile), false);
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );

    const retried = applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'topology-temp-retry',
    });
    assert.equal(retried.selector.state, 'active');
    assert.equal(fs.existsSync(immutableFile), true);
    assert.equal(fs.existsSync(crashArtifact), true);
});

test('torn apply-lock temp is ignored and never displaces an active selector', (t) => {
    const fixture = createFixture(t);
    const baseline = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'lock-temp-baseline' });
    let crashArtifact;

    assert.throws(() => applyEdgeRoutingGeneration({
        workspaceRoot: fixture.workspace,
        reason: 'lock-temp-crash',
        testHooks: {
            afterApplyLockTempFsync({ tmp }) {
                crashArtifact = tmp;
                fs.truncateSync(tmp, 5);
                throw new Error('injected apply lock temp crash');
            },
        },
    }), /injected apply lock temp crash/);
    assert.equal(fs.existsSync(crashArtifact), true);
    assert.equal(fs.statSync(crashArtifact).size, 5);
    assert.equal(fs.existsSync(baseline.paths.applyLockFile), false);
    assert.equal(
        loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }).selector.generation,
        baseline.selector.generation,
    );

    const retried = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'lock-temp-retry' });
    assert.equal(retried.selector.state, 'active');
    assert.equal(fs.existsSync(crashArtifact), true);
});

test('operator desired-state apply stages exact bounded bytes with mode 0600', (t) => {
    const fixture = createFixture(t);
    const candidate = path.join(fixture.workspace, 'candidate.json');
    const bytes = Buffer.from(`${JSON.stringify(localDesired(), null, 2)}\n`);
    fs.writeFileSync(candidate, bytes);

    const applied = applyEdgeDesiredStateFile(candidate, { workspaceRoot: fixture.workspace });

    assert.equal(applied.selector.state, 'active');
    assert.equal(fs.readFileSync(fixture.desiredFile).equals(bytes), true);
    assert.equal(fs.statSync(fixture.desiredFile).mode & 0o777, 0o600);
});

test('invalid operator desired-state apply leaves selector inactive without rollback', (t) => {
    const fixture = createFixture(t);
    const baseline = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'operator-baseline' });
    const invalid = path.join(fixture.workspace, 'invalid-candidate.json');
    const invalidBytes = Buffer.from('{"schemaVersion":1,"hosts":');
    fs.writeFileSync(invalid, invalidBytes);

    assert.throws(
        () => applyEdgeDesiredStateFile(invalid, { workspaceRoot: fixture.workspace }),
        /not valid JSON/,
    );
    assert.equal(fs.readFileSync(fixture.desiredFile).equals(invalidBytes), true);
    const selector = JSON.parse(fs.readFileSync(baseline.paths.activeSelectorFile, 'utf8'));
    assert.equal(selector.state, 'inactive');
    assert.equal(selector.previousGeneration, baseline.selector.generation);
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
});

test('operator desired-state apply rejects symlinks, non-regular files, and oversized input fail closed', (t) => {
    const fixture = createFixture(t);
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'candidate-shape-baseline' });
    const regular = path.join(fixture.workspace, 'regular.json');
    const symlink = path.join(fixture.workspace, 'candidate-link.json');
    fs.writeFileSync(regular, JSON.stringify(localDesired()));
    fs.symlinkSync(regular, symlink);
    assert.throws(
        () => applyEdgeDesiredStateFile(symlink, { workspaceRoot: fixture.workspace }),
        { code: 'EDGE_DESIRED_CANDIDATE_INVALID' },
    );
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );

    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'candidate-shape-reactivate' });
    assert.throws(
        () => applyEdgeDesiredStateFile(fixture.workspace, { workspaceRoot: fixture.workspace }),
        { code: 'EDGE_DESIRED_CANDIDATE_INVALID' },
    );
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );

    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'candidate-size-reactivate' });
    const oversized = path.join(fixture.workspace, 'oversized.json');
    const fd = fs.openSync(oversized, 'w');
    try {
        fs.ftruncateSync(fd, EDGE_DESIRED_CANDIDATE_MAX_BYTES + 1);
    } finally {
        fs.closeSync(fd);
    }
    assert.throws(
        () => applyEdgeDesiredStateFile(oversized, { workspaceRoot: fixture.workspace }),
        { code: 'EDGE_DESIRED_CANDIDATE_TOO_LARGE' },
    );
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }),
        { code: 'EDGE_GENERATION_INACTIVE' },
    );
});
