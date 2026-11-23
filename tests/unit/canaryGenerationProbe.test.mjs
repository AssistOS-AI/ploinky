import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Probes U2 and U14 of the agent canary rollout plan (section 3.2, section 5).
// Each test asserts the behavior the plan needs from the CURRENT code: a
// failing probe is a finding about what the first slice must change.

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-canary-probe-'));
const previous = {
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
    PLOINKY_MEDIA_HOST_PORT: process.env.PLOINKY_MEDIA_HOST_PORT,
};
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const routingFile = await import('../../cli/server/routingFile.js');

test.after(() => {
    for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

const ploinkyDir = path.join(workspace, '.ploinky');
const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
const policyDir = path.join(ploinkyDir, 'data', 'router-security');
const repoDir = path.join(workspace, 'fixtures');
const OLD = 'alpha-container';
const CANARY_NAME = `${OLD}__canary`;
const ROUTE_KEY = 'alpha';

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function agentRecord(agentName, extra = {}) {
    return {
        type: 'agent',
        repoName: 'fixtures',
        agentName,
        instanceId: `${agentName}-instance`,
        enableGeneration: `${agentName}-enable-generation`,
        auth: { mode: 'sso' },
        ...extra,
    };
}

function route(agentName, hostPort, extra = {}) {
    return {
        repo: 'fixtures',
        agent: agentName,
        container: `${agentName}-container`,
        hostPath: path.join(repoDir, agentName),
        hostPort,
        ...extra,
    };
}

// Route field of plan 3.2.
function canaryField(overrides = {}) {
    return {
        rolloutId: 'rollout-1',
        container: CANARY_NAME,
        commit: '0123456789abcdef0123456789abcdef01234567',
        codeDigest: `sha256:${'a'.repeat(64)}`,
        codePath: '.ploinky/canary/alpha/0123456789ab',
        share: 0.1,
        testAccounts: ['tester-1'],
        salt: 'salt-1',
        splitStartedAt: '2026-11-23T00:00:00.000Z',
        mode: 'split',
        probe: { port: 8787, path: '/healthz', status: 200 },
        thresholds: { minFailures: 5, slowMs: 5000 },
        ...overrides,
    };
}

// Registry record of plan 3.2: the normal shape plus `canaryOf`, no port and
// no container id until readiness.
function canaryRecord(extra = {}) {
    return agentRecord('alpha', {
        instanceId: 'alpha-canary-instance',
        enableGeneration: 'alpha-canary-enable-generation',
        canaryOf: ROUTE_KEY,
        ...extra,
    });
}

function resetWorkspace() {
    fs.rmSync(ploinkyDir, { recursive: true, force: true });
    for (const agentName of ['alpha', 'beta', 'gamma']) writeJson(path.join(repoDir, agentName, 'manifest.json'), {});
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        routes: { alpha: route('alpha', 43101), beta: route('beta', 43102), gamma: route('gamma', 43103) },
    });
    writeJson(path.join(ploinkyDir, 'agents.json'), {
        'alpha-container': agentRecord('alpha'),
        'beta-container': agentRecord('beta'),
        'gamma-container': agentRecord('gamma'),
    });
    writeJson(path.join(edgeDir, 'desired.json'), {
        hosts: { 'app.example.com': { agent: 'fixtures/alpha' } },
        cloudflare: { tunnelTokenSecret: 'cloudflare/tunnel-token' },
    });
    writeJson(path.join(policyDir, 'policy-state.json'), { schema: 'router-policy', httpRoutes: [], mcpTools: [] });
    return edge.applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'canary-probe-fixture', publicationState: 'ready' });
}

const readRouting = () => JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'routing.json'), 'utf8'));
const readAgents = () => JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'agents.json'), 'utf8'));
const activeSelector = () => edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector;
const active = () => edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });

// Prepare an additive generation from `prepared` sources, then commit
// `committed` sources (default: the same). Returns the commit result.
function additive({ prepared, committed = prepared, between, reason = 'canary-probe' }) {
    return edge.withEdgeGenerationApplyLock((applyLockCapability) => {
        const preparation = edge.prepareAdditiveEdgeRoutingGeneration({
            workspaceRoot: workspace,
            routing: prepared.routing,
            agents: prepared.agents,
            reason,
            applyLockCapability,
        });
        try {
            if (between) between(preparation);
            return edge.commitAdditiveEdgeRoutingGeneration(preparation.preparationLease, {
                workspaceRoot: workspace,
                routing: committed.routing,
                agents: committed.agents,
                applyLockCapability,
            });
        } catch (error) {
            try { edge.abortEdgeRoutingPreparation(preparation.preparationLease, { workspaceRoot: workspace, applyLockCapability }); } catch (_) {}
            throw error;
        }
    }, { workspaceRoot: workspace });
}

function withCanary({ routing = readRouting(), agents = readAgents() } = {}, field = canaryField(), record = canaryRecord()) {
    const nextRouting = structuredClone(routing);
    nextRouting.routes[ROUTE_KEY] = { ...nextRouting.routes[ROUTE_KEY], canary: field };
    const nextAgents = structuredClone(agents);
    nextAgents[CANARY_NAME] = record;
    return { routing: nextRouting, agents: nextAgents };
}

// Put the canary record and field in the active generation (no probe asserts
// are made here; a failure points at the fixture step, not at the probe).
function seedActiveCanary(field = canaryField()) {
    resetWorkspace();
    const sources = withCanary({}, field);
    return additive({ prepared: sources, reason: 'canary-probe-seed' });
}

test('U2a the canary route field survives mergeRuntimeRoute unchanged', () => {
    const field = canaryField();
    const existing = route('alpha', 43101, { canary: field });
    const kept = routingFile.mergeRuntimeRoute(existing, { repo: 'fixtures', agent: 'alpha', container: OLD }, { hostPort: 43111 });
    assert.deepEqual(kept.canary, field, 'existing field kept when the new route omits it');
    const supplied = routingFile.mergeRuntimeRoute(route('alpha', 43101), { ...route('alpha', 43101), canary: field }, { hostPort: 43111 });
    assert.deepEqual(supplied.canary, field, 'field supplied by the new route kept');
    const dropped = routingFile.mergeRuntimeRoute(existing, { repo: 'fixtures', agent: 'alpha', container: OLD }, {});
    assert.deepEqual(dropped.canary, field, 'field kept when no host port is published');
});

test('U2b the canary route field survives compile and publish and reads back from the active snapshot', () => {
    resetWorkspace();
    const field = canaryField();
    const sources = withCanary({}, field);
    writeJson(path.join(ploinkyDir, 'routing.json'), sources.routing);
    writeJson(path.join(ploinkyDir, 'agents.json'), sources.agents);
    const applied = edge.applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'u2b', publicationState: 'ready' });
    assert.equal(applied.selector.state, 'active');
    const snapshot = active();
    assert.deepEqual(snapshot.generation.routing.routes[ROUTE_KEY].canary, field);
    assert.deepEqual(snapshot.generation.agents[CANARY_NAME].canaryOf, ROUTE_KEY);
    assert.deepEqual(readRouting().routes[ROUTE_KEY].canary, field);
});

test('U2b2 validateRoutingShape refuses a malformed canary field (strict validator, plan O10)', () => {
    resetWorkspace();
    const sources = withCanary({}, { share: 'not-a-number', mode: 'bogus' });
    writeJson(path.join(ploinkyDir, 'routing.json'), sources.routing);
    writeJson(path.join(ploinkyDir, 'agents.json'), sources.agents);
    // The plan needs a strict validator (O10), so a malformed field is refused.
    assert.throws(() => edge.applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'u2b2', publicationState: 'ready' }));
});

test('U2c the canary route field survives the operator drain and the active to active reopen', () => {
    seedActiveCanary();
    const field = canaryField();
    const predecessorRoute = structuredClone(active().generation.routing.routes[ROUTE_KEY]);
    edge.withEdgeGenerationApplyLock((applyLockCapability) => edge.commitWithdrawalEdgeRoutingGeneration({
        workspaceRoot: workspace,
        withdraw: [{ containerName: OLD, mode: 'drain' }],
        reason: `manual-targeted-restart-drain:${OLD}`,
        applyLockCapability,
    }), { workspaceRoot: workspace });
    const drained = active().generation.routing.routes[ROUTE_KEY];
    assert.equal(drained.draining, true);
    assert.deepEqual(drained.canary, field, 'field kept in the drained snapshot');
    assert.deepEqual(readRouting().routes[ROUTE_KEY].canary, field, 'field kept in mutable routing');
    assert.ok(readAgents()[CANARY_NAME], 'canary record kept');

    // Reopen as reopenTargetedRoute does (targetedAgentRestart.js:248-281).
    edge.withEdgeGenerationApplyLock((applyLockCapability) => {
        const routing = readRouting();
        const agents = readAgents();
        agents[OLD] = { ...agents[OLD], instanceId: 'alpha-next-instance', enableGeneration: 'alpha-next-generation', containerId: 'alpha-next-id' };
        const prepared = edge.prepareWithdrawnReplacementEdgeRoutingGeneration({
            workspaceRoot: workspace,
            containerName: OLD,
            agents,
            reason: 'u2c-reopen',
            applyLockCapability,
        });
        // restoredRoute() of targetedAgentRestart.js:480-493.
        const restored = routingFile.mergeRuntimeRoute({ ...predecessorRoute, draining: false }, {
            repo: 'fixtures', agent: 'alpha', container: OLD, hostPath: path.join(repoDir, 'alpha'),
        }, { hostPort: 43901 });
        delete restored.draining;
        delete restored.hardwareAvailability;
        routing.routes[ROUTE_KEY] = restored;
        try {
            edge.commitAdditiveEdgeRoutingGeneration(prepared.preparationLease, { workspaceRoot: workspace, routing, agents, applyLockCapability });
        } catch (error) {
            try { edge.abortEdgeRoutingPreparation(prepared.preparationLease, { workspaceRoot: workspace, applyLockCapability }); } catch (_) {}
            throw error;
        }
    }, { workspaceRoot: workspace });
    const reopened = active().generation.routing.routes[ROUTE_KEY];
    assert.equal(reopened.draining, undefined);
    assert.equal(reopened.hostPort, 43901);
    assert.deepEqual(reopened.canary, field, 'field kept after the reopen');
});

test('U14a additive preparation containing the second record and the route field commits (route.container unchanged)', () => {
    resetWorkspace();
    const before = activeSelector();
    const sources = withCanary();
    assert.equal(sources.routing.routes[ROUTE_KEY].container, OLD);
    const committed = additive({ prepared: sources });
    assert.equal(committed.selector.state, 'active');
    assert.notEqual(committed.selector.generation, before.generation);
    const snapshot = active();
    assert.deepEqual(snapshot.generation.routing.routes[ROUTE_KEY].canary, canaryField());
    assert.ok(snapshot.generation.agents[CANARY_NAME], 'record in snapshot');
    assert.equal(snapshot.generation.routing.routes[ROUTE_KEY].container, OLD);
});

test('U14b a separate preparation that changes only the route field commits', () => {
    seedActiveCanary();
    const sources = withCanary({}, canaryField({ share: 0.25, testAccounts: ['tester-1', 'tester-2'] }));
    sources.agents = readAgents();
    const committed = additive({ prepared: sources });
    assert.equal(committed.selector.state, 'active');
    assert.equal(active().generation.routing.routes[ROUTE_KEY].canary.share, 0.25);
});

test('U14c mode changes split to all to retiring to withdrawn each commit as separate preparations', () => {
    seedActiveCanary();
    for (const mode of ['all', 'retiring', 'withdrawn']) {
        const routing = readRouting();
        routing.routes[ROUTE_KEY].canary = { ...routing.routes[ROUTE_KEY].canary, mode };
        const committed = additive({ prepared: { routing, agents: readAgents() }, reason: `u14c-${mode}` });
        assert.equal(committed.selector.state, 'active', mode);
        assert.equal(active().generation.routing.routes[ROUTE_KEY].canary.mode, mode);
    }
});

test('U14d removing both the record and the field in one preparation commits', () => {
    seedActiveCanary();
    const routing = readRouting();
    delete routing.routes[ROUTE_KEY].canary;
    const agents = readAgents();
    delete agents[CANARY_NAME];
    const committed = additive({ prepared: { routing, agents }, reason: 'u14d' });
    assert.equal(committed.selector.state, 'active');
    const snapshot = active();
    assert.equal(snapshot.generation.routing.routes[ROUTE_KEY].canary, undefined);
    assert.equal(snapshot.generation.agents[CANARY_NAME], undefined);
});

test('U14e filling the canary record port and container id after preparation still commits', () => {
    resetWorkspace();
    const prepared = withCanary();
    const committed = structuredClone(prepared);
    committed.agents[CANARY_NAME] = { ...committed.agents[CANARY_NAME], hostPort: 43555, containerId: 'canary-container-id', runtime: 'podman', launchId: 'launch-1' };
    let leaseDigest;
    const result = additive({ prepared, committed, between: (p) => { leaseDigest = p.preparationLease.lifecycleBindingDigest; } });
    assert.equal(result.selector.state, 'active');
    const record = active().generation.agents[CANARY_NAME];
    assert.equal(record.hostPort, 43555);
    assert.equal(record.containerId, 'canary-container-id');
    assert.equal(record.runtime, 'podman');
    assert.equal(record.launchId, 'launch-1');
    // Commit compares lease.lifecycleBindingDigest with the digest of the
    // filled sources (edgeGeneration.js:3227), so a commit proves it is equal.
    process.stdout.write(`# U14e lease lifecycleBindingDigest ${leaseDigest ? 'present' : 'not exposed on lease'}; commit succeeded => digest unchanged\n`);
});

test('U14e2 changing the route field after preparation changes the lifecycle binding and is refused', () => {
    resetWorkspace();
    const prepared = withCanary();
    const committed = withCanary({}, canaryField({ share: 0.5 }));
    assert.throws(() => additive({ prepared, committed }), { code: 'EDGE_PREPARATION_SOURCE_CHANGED' });
});

test('U14f an unrelated change between prepare and commit is refused and leaves the predecessor intact', () => {
    resetWorkspace();
    const before = activeSelector();
    const sources = withCanary();
    let error;
    try {
        additive({
            prepared: sources,
            between: () => {
                const routing = readRouting();
                routing.routes.gamma = { ...routing.routes.gamma, note: 'unrelated-change' };
                writeJson(path.join(ploinkyDir, 'routing.json'), routing);
            },
        });
    } catch (caught) {
        error = caught;
    }
    assert.ok(error, 'commit refused');
    process.stdout.write(`# U14f refusal code ${error.code}: ${error.message}\n`);
    assert.equal(error.code, 'EDGE_GENERATION_SOURCE_CHANGED');
    assert.deepEqual(activeSelector(), before, 'selector unchanged');
    const snapshot = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(snapshot.generation.routing.routes[ROUTE_KEY].canary, undefined);
    assert.equal(edge.readEdgeRoutingPreparationOwner({ workspaceRoot: workspace }), null);
});
