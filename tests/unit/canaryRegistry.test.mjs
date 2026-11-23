import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-canary-registry-'));
const ploinky = path.join(workspaceRoot, '.ploinky');
const repo = path.join(workspaceRoot, 'fixtures');
const environment = {
    PLOINKY_WORKSPACE_ROOT: workspaceRoot,
    PLOINKY_ROUTER_HOST_PORT: '18080',
    PLOINKY_MEDIA_HOST_PORT: '17891',
    PLOINKY_MASTER_KEY: randomBytes(32).toString('hex'),
};
const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
test.after(() => {
    for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const monitorModule = await import('../../cli/server/containerMonitor.js');
const manager = await import('../../cli/sandbox/docker/agentServiceManager.js');
const { resolveEnabledAgentRecord } = await import('../../cli/utils/agents.js');
const { applyHardwareLimits } = await import('../../cli/sandbox/hardwareLimits/reconcile.mjs');
const { prepareTargetedAgentRestart } = await import('../../cli/commands/targetedAgentRestart.js');
const { destroyWorkspaceContainers } = await import('../../cli/sandbox/docker/containerFleet.js');
const { resolveEnabledAgentRecordFromMap } = await import('../../cli/utils/agentRegistryResolver.js');

const primary = 'alpha-container';
const secondary = primary + '__canary';
const bystander = 'beta-container';
const manifest = {
    container: 'node:20-alpine', start: 'sleep infinity',
    health: { readiness: { type: 'script', script: 'true' } },
    routerAccess: { workspaceLogs: true },
};
function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}
function record(agentName, id = agentName) {
    return {
        type: 'agent', runtime: 'container', repoName: 'fixtures', agentName, profile: 'default',
        instanceId: id + '-instance', enableGeneration: id + '-generation', containerId: id + '-id',
        auth: { mode: 'sso' },
    };
}
function route(agent, container, hostPort) {
    return { repo: 'fixtures', agent, container, hostPort, hostPath: path.join(repo, agent) };
}
const active = () => edge.loadActiveEdgeRoutingGeneration({ workspaceRoot });
function reset(mutate = () => {}) {
    fs.rmSync(ploinky, { recursive: true, force: true });
    edge.initializeFreshEdgeRoutingSources({ workspaceRoot });
    write(path.join(repo, 'alpha/manifest.json'), manifest);
    write(path.join(repo, 'beta/manifest.json'), { container: 'node:20-alpine' });
    const canary = {
        rolloutId: 'rollout-1', container: secondary, commit: '1'.repeat(40), codeDigest: 'sha256:' + '2'.repeat(64),
        codePath: '.ploinky/canary/alpha/release', share: 10, testAccounts: ['tester'], salt: 'fixture-salt',
        splitStartedAt: '2026-11-23T00:00:00Z', mode: 'split', probe: { port: 8787, path: '/healthz', status: 200 },
        thresholds: { minFailures: 2, errorDeltaPoints: 3.5 },
    };
    const agents = {
        [secondary]: { ...record('alpha', 'canary'), canaryOf: 'alpha', launchId: 'launch-2', hostPort: 43103 },
        [primary]: record('alpha'), [bystander]: record('beta'),
    };
    const routing = { routes: { alpha: { ...route('alpha', primary, 43101), canary }, beta: route('beta', bystander, 43102) } };
    mutate({ agents, routing });
    write(path.join(ploinky, 'agents.json'), agents);
    write(path.join(ploinky, 'routing.json'), routing);
    write(path.join(ploinky, 'data/edge-routing/desired.json'), { hosts: {} });
    write(path.join(ploinky, 'data/router-security/policy-state.json'), { schema: 'router-policy', httpRoutes: [], mcpTools: [] });
    edge.applyEdgeRoutingGeneration({ workspaceRoot, publicationState: 'ready' });
    return active().generation;
}

for (const [label, change] of [
    ['orphan record', ({ routing }) => { delete routing.routes.alpha.canary; }],
    ['orphan route', ({ agents }) => { delete agents[secondary]; }],
    ['wrong route', ({ agents }) => { agents[secondary].canaryOf = 'beta'; }],
    ['canary as static owner', ({ routing }) => { routing.static = { agent: 'alpha', container: secondary }; }],
    ['wrong principal', ({ agents }) => { agents[secondary].repoName = 'another'; }],
    ['duplicate tuple', ({ agents }) => { Object.assign(agents[secondary], { instanceId: agents[primary].instanceId, enableGeneration: agents[primary].enableGeneration }); }],
    ['traversal', ({ routing }) => { routing.routes.alpha.canary.codePath = '.ploinky/canary/../outside'; }],
    ['symlinked ancestor of a missing export', () => {
        fs.mkdirSync(path.join(ploinky, 'canary'));
        fs.symlinkSync(repo, path.join(ploinky, 'canary/alpha'));
    }],
    ['sibling directory', ({ routing }) => { routing.routes.alpha.canary.codePath = '.ploinky/canary-other/export'; }],
    ['unknown route field', ({ routing }) => { routing.routes.alpha.canary.hostPort = 43103; }],
    ['unknown nested field', ({ routing }) => { routing.routes.alpha.canary.probe.host = 'some-host'; }],
    ['invalid share', ({ routing }) => { routing.routes.alpha.canary.share = -1; }],
    ['abbreviated digest', ({ routing }) => { routing.routes.alpha.canary.codeDigest = 'sha256:aaaa'; }],
]) test('compile rejects ' + label, () => assert.throws(() => reset(change), { code: 'EDGE_GENERATION_INVALID' }));

test('registry and rollout thresholds accept the same fields and bounds', async () => {
    const { validateCanaryField } = await import('../../cli/sandbox/canaryRecord.mjs');
    const { DEFAULT_THRESHOLDS } = await import('../../cli/server/canary/tripRules.js');
    const field = reset().routing.routes.alpha.canary;
    const validate = thresholds => validateCanaryField({ ...field, thresholds }, 'canary');
    for (const overrides of [{}, DEFAULT_THRESHOLDS, { errorMultiple: 0 }, { slowDeltaPoints: 100 },
        ...[10, 50, 100, 250, 500, 1000, 5000, 15000].map(slowMs => ({ slowMs }))]) {
        assert.doesNotThrow(() => validate(overrides));
    }
    for (const overrides of [null, undefined, [], 3, { windowSeconds: 600 }, { errorRate: 0.05 }, { [Symbol('x')]: 1 },
        { minFailures: 0 }, { minResponses: 1.5 }, { consecutiveProbes: 2 ** 53 },
        { consecutiveConnections: -1 }, { slowWithoutBaselinePercent: 100.1 },
        { slowMs: 0.5 }, { slowMs: 30 }, { slowMs: 0 }, { slowMs: 5001 },
        { slowMs: Infinity }, { errorMultiple: NaN }, { errorDeltaPoints: -0.1 }]) {
        assert.throws(() => validate(overrides), { code: 'EDGE_GENERATION_INVALID' });
    }
});

test('Router startup isolates invalid overrides and honors the compiled thresholds on the next route', async t => {
    const { canarySignals } = await import('../../cli/server/canary/routerSignals.js');
    const { validateCanaryField } = await import('../../cli/sandbox/canaryRecord.mjs');
    const { canary } = reset().routing.routes.alpha;
    validateCanaryField(canary, 'alpha.canary');
    const events = [];
    t.mock.method(canarySignals, 'log', (type, data) => events.push({ type, ...data }));
    const routes = {
        legacy: { canary: { ...canary, mode: 'retiring', thresholds: { windowSeconds: 300 } } },
        valid: { canary },
    };
    t.after(() => {
        for (const key of Object.keys(routes)) canarySignals.removeRollout(key, canary.rolloutId);
    });
    canarySignals.startRollout({ ...canary, routeKey: 'legacy', thresholds: { minFailures: 1 } });
    canarySignals.routerStarted(routes);
    const status = key => canarySignals.status().rollouts.find(row => row.routeKey === key);
    for (const [key, minFailures] of [['legacy', 5], ['valid', 2]]) {
        assert.equal(status(key).state, 'paused');
        assert.equal(canarySignals.resume(key, canary.rolloutId), true);
        const fail = () => canarySignals.recordOutcome({ routeKey: key, rolloutId: canary.rolloutId,
            copy: 'canary', status: 503 });
        for (let n = 1; n < minFailures; n++) fail();
        assert.equal(status(key).state, 'split');
        fail();
        assert.equal(status(key).state, 'tripped');
    }
    assert.deepEqual(events.filter(event => event.type === 'canary_restore_error').map(event => event.routeKey), ['legacy']);
});

test('a committed generation retires only missing route baselines, including their lifetime counts', async () => {
    const { canarySignals, canaryStatus, observeCanarySnapshot } = await import('../../cli/server/canary/routerSignals.js');
    const { observeProxyOutcome, observeProxyFirstByte } = await import('../../cli/server/canary/proxyOutcomes.js');
    const { selectRouteRuntime } = await import('../../cli/server/canary/selection.mjs');
    const { resolveEdgeRoutePlan } = await import('../../cli/server/edgeRoutePlan.js');
    const { finalizePlanAfterAdmission } = await import('../../cli/server/proxy/RoutePlan.js');
    const portPlan = () => {
        const plan = resolveEdgeRoutePlan({ req: { method: 'GET', headers: { host: 'localhost' },
            url: '/base-agent-additional-server/beta/8787/health' } });
        assert.equal(plan.ok, true, plan.code);
        return plan;
    };
    const first = reset(({ agents }) => Object.assign(agents[bystander], { runtime: 'podman', containerId: 'b'.repeat(64) }));
    const { selector, paths } = active();
    observeCanarySnapshot(first);
    const response = (snapshot, routeKey, status) => ({
        plan: selectRouteRuntime({ routeKey, route: snapshot.routing.routes[routeKey], snapshot }), status, outcome: 'success',
    });
    const retired = response(first, 'beta', 503);
    const retiredPort = portPlan();
    for (const routeKey of ['alpha', 'beta']) observeProxyOutcome(response(first, routeKey, 503));
    const routesWithoutBeta = { ...first.routing.routes };
    delete routesWithoutBeta.beta;
    write(path.join(ploinky, 'routing.json'), { ...first.routing, routes: routesWithoutBeta });
    edge.applyEdgeRoutingGeneration({ workspaceRoot, publicationState: 'ready' });
    const onlyAlpha = active().generation;
    observeCanarySnapshot(onlyAlpha);
    assert.deepEqual(canaryStatus(onlyAlpha.routing.routes).baselines.map(row => row.routeKey), ['alpha']);
    canarySignals.recordOutcome({ routeKey: 'beta', status: 503 });
    assert.deepEqual(canarySignals.status().baselines.map(row => row.routeKey), ['alpha']);
    // Reselect the original immutable file, as rollback can do. The cache
    // returns the very same objects that the first request admitted.
    write(paths.activeSelectorFile, selector);
    const restored = active().generation;
    assert.equal(restored, first);
    observeCanarySnapshot(restored);
    observeProxyOutcome(response(restored, 'beta', 200));
    observeProxyOutcome(retired);
    observeProxyFirstByte({ plan: retired.plan, ttfbMs: 60_000 });
    observeProxyOutcome({ plan: finalizePlanAfterAdmission(retiredPort), outcome: 'success', status: 503 });
    observeProxyFirstByte({ plan: retiredPort, ttfbMs: 60_000 });
    observeProxyOutcome({ plan: finalizePlanAfterAdmission(portPlan()), outcome: 'success', status: 200 });
    const { baselines } = canaryStatus(restored.routing.routes);
    assert.deepEqual(baselines.map(row => [row.routeKey, row.sinceStart.requests, row.sinceStart.backendFailures]),
        [['alpha', 1, 1], ['beta', 2, 0]]);
    assert.equal(baselines.find(row => row.routeKey === 'beta').sinceStart.timedResponses, 0);
    assert.deepEqual(canaryStatus(undefined).baselines, []);
});

test('snapshot reconciliation isolates a legacy route from a new rollout and a prepared receipt', async () => {
    const { canarySignals, observeCanarySnapshot } = await import('../../cli/server/canary/routerSignals.js');
    const { openReceipt } = await import('../../cli/sandbox/canary/receipt.mjs');
    const snapshot = reset();
    const { alpha } = snapshot.routing.routes;
    const bad = { ...alpha, canary: { ...alpha.canary, mode: 'all', thresholds: { slowMs: 30 } } };
    openReceipt({ routeKey: 'legacy', rolloutId: bad.canary.rolloutId, fields: { lastCompletedStep: 1 } }, { workspaceRoot });
    const publish = routes => observeCanarySnapshot({ ...snapshot, routing: { routes } });
    const state = key => canarySignals.routingState(key, alpha.canary.rolloutId)?.state;
    publish({});
    publish({ legacy: bad, alpha });
    assert.equal(state('legacy'), 'paused');
    assert.equal(state('alpha'), 'split');
    const count = (copy, ttfbMs) => canarySignals.recordOutcome({ routeKey: 'alpha', rolloutId: alpha.canary.rolloutId,
        copy, status: 200, ttfbMs });
    count('old', 30);
    count('canary', 120);
    const changed = { ...alpha, canary: { ...alpha.canary, thresholds: { minResponses: 1, slowMs: 50 } } };
    publish({ legacy: bad, alpha: changed });
    assert.equal(state('legacy'), 'paused');
    assert.equal(state('alpha'), 'tripped');
    const { counts } = canarySignals.status().rollouts.find(row => row.routeKey === 'alpha');
    assert.equal(counts.old.sinceStart.slowResponses, 0);
    assert.equal(counts.canary.sinceStart.slowResponses, 1);
    publish({ alpha: { ...changed, canary: { ...changed.canary, mode: 'all', thresholds: { slowMs: 51 } } } });
    assert.equal(state('alpha'), 'paused');
    assert.equal(state('legacy'), undefined);
    publish({});
});

test('the Router schedules and cancels the exact probe when its published container or rollout changes', async t => {
    const { canarySignals, observeCanarySnapshot, exactContainerProbe } = await import('../../cli/server/canary/routerSignals.js');
    const snapshot = reset();
    const { alpha } = snapshot.routing.routes;
    const publish = (route, record) => observeCanarySnapshot({
        routing: { routes: route ? { alpha: route } : {} }, agents: { [secondary]: record },
    });
    const probes = [];
    publish();
    t.mock.timers.enable({ apis: ['setInterval'] });
    canarySignals.setProbe((target, { signal }) => new Promise(resolve => probes.push({ target, signal, resolve })));
    t.after(() => { publish(); canarySignals.setProbe(exactContainerProbe()); });
    const first = { ...snapshot.agents[secondary], startedAt: '2026-11-23T10:00:00Z' };
    const counts = () => canarySignals.status().rollouts[0].counts.canary.sinceStart;
    publish(alpha, first);
    t.mock.timers.tick(30_000);
    assert.equal(probes.length, 1);
    assert.equal(probes[0].target.registryRecord, first);
    probes[0].resolve({ ok: true, running: true, containerId: first.containerId, startedAt: '2026-11-23T10:00:20Z' });
    await Promise.resolve();
    assert.equal(canarySignals.status().rollouts[0].lastTripReason, 'container-restart');
    assert.equal(counts().restarts, 1);
    t.mock.timers.tick(30_000);
    const replacement = { ...first, containerId: 'replacement-id', startedAt: '2026-11-23T10:01:00Z' };
    publish(alpha, replacement);
    assert.equal(probes[1].signal.aborted, true);
    probes[1].resolve({ ok: true, running: true, containerId: first.containerId });
    await Promise.resolve();
    assert.equal(counts().probes, 2);
    assert.equal(counts().restarts, 2);
    t.mock.timers.tick(30_000);
    assert.equal(probes[2].target.containerId, replacement.containerId);
    probes[2].resolve({ ok: true, running: true, containerId: replacement.containerId, startedAt: replacement.startedAt });
    await Promise.resolve();
    assert.equal(counts().restarts, 2);
    t.mock.timers.tick(30_000);
    publish();
    assert.equal(probes[3].signal.aborted, true);
    t.mock.timers.tick(60_000);
    assert.equal(probes.length, 4);
    assert.deepEqual(canarySignals.status().rollouts, []);
});

test('withdrawn compiles with both records; canary-first name resolution selects the primary', () => {
    const generation = reset(({ routing }) => { routing.routes.alpha.canary.mode = 'withdrawn'; });
    assert.equal(generation.routing.routes.alpha.canary.mode, 'withdrawn');
    assert.equal(generation.agents[secondary].canaryOf, 'alpha');
    const registry = { [secondary]: generation.agents[secondary], ...generation.agents };
    assert.equal(resolveEnabledAgentRecordFromMap('alpha', registry).containerName, primary);
    assert.equal(resolveEnabledAgentRecordFromMap(secondary, registry), null);
    assert.equal(edge.currentEnabledAgentIdentity({ ...generation, agents: registry }, 'agent:fixtures/alpha').instanceId, registry[primary].instanceId);
});

test('hardware Apply never plans a canary and refuses a mixed explicit request before planning any key', async () => {
    const generation = reset();
    const planned = [];
    const run = containers => applyHardwareLimits({ expectedToken: { epoch: '1'.repeat(32), revision: 1 }, containers }, {
        lease: (_options, fn) => fn(), loadRegistry: () => generation.agents, loadRouting: () => generation.routing,
        policyCheck() {}, loadPlan({ key }) { planned.push(key); return {}; }, isUnchanged: () => true,
    });
    assert.equal((await run([])).ok, true);
    assert.deepEqual(planned.sort(), [primary, bystander]);
    planned.length = 0;
    await assert.rejects(run([bystander, secondary]), { code: 'canary_not_applicable' });
    assert.deepEqual(planned, []);
    assert.deepEqual(active().generation.routing.routes.beta, generation.routing.routes.beta);
    assert.deepEqual(active().generation, generation);
});

test('targeted restart and ordinary ensure refuse the canary before any launch', async () => {
    const generation = reset(({ agents }) => { agents[bystander].alias = secondary; });
    assert.throws(() => resolveEnabledAgentRecord(secondary, { forRestart: true }),
        /^Error: A canary runtime cannot be targeted for restart\.$/);
    await assert.rejects(prepareTargetedAgentRestart({
        containerName: secondary, routeKey: 'alpha', record: generation.agents[secondary],
    }), /^Error: A canary runtime cannot be targeted for restart\.$/);
    const containersBefore = JSON.stringify(active().generation.agents);
    assert.throws(() => manager.ensureAgentService('alpha', manifest, path.join(repo, 'alpha'), {
        containerName: secondary, routerEndpoint: null,
    }), /^Error: Only a canary launch may start a registered canary runtime\.$/);
    assert.equal(JSON.stringify(active().generation.agents), containersBefore, 'no runtime record changed');
    assert.equal(active().generation.routing.routes.alpha.draining, undefined);
});

test('the fallback inactivation keeps its pre-canary behavior and honours abortIf under its own lock', () => {
    reset();
    // No canary anywhere, with an outstanding additive preparation lease: the
    // fallback must still inactivate, exactly as before canaries existed.
    edge.withEdgeGenerationApplyLock((applyLockCapability) => {
        edge.prepareAdditiveEdgeRoutingGeneration({ workspaceRoot, applyLockCapability, reason: 'test-outstanding-lease' });
    }, { workspaceRoot });
    const selector = edge.inactivateEdgeRoutingGeneration('continuous-runtime-probe-failed:test', {
        workspaceRoot,
        abortIf: () => false,
    });
    assert.equal(selector?.state, 'inactive');
});

test('abortIf true leaves the active selector untouched', () => {
    reset();
    const before = active().selector;
    const result = edge.inactivateEdgeRoutingGeneration('continuous-runtime-probe-failed:test', {
        workspaceRoot,
        abortIf: () => true,
    });
    assert.equal(result, null);
    assert.deepEqual(active().selector, before);
});

test('Watchdog omits the canary; workspace destroy selects both physical copies', () => {
    reset();
    const monitor = monitorModule.createContainerMonitor({ readAppliedObservation: () => null });
    monitorModule.syncManagedContainers(monitor);
    assert.deepEqual([...monitor.targets.keys()].sort(), [primary, bystander]);
    assert.deepEqual(destroyWorkspaceContainers({}, { removeMany: keys => keys }).sort(), [primary, secondary, bystander]);
});

class ProbeWorker extends EventEmitter {
    postMessage() {}
    terminate() { return Promise.resolve(0); }
}
function monitorForPrimary(generation) {
    const events = [];
    const target = {
        ...generation.agents[primary], containerName: primary, manifestPath: path.join(repo, 'alpha/manifest.json'),
        probeState: 'pending', restartHistory: [], currentBackoff: 60_000,
    };
    const monitor = {
        config: { INITIAL_BACKOFF_MS: 60_000 }, targets: new Map([[primary, target]]), Worker: ProbeWorker,
        isShuttingDown: () => false, log: (_level, event) => events.push(event),
    };
    return { monitor, target, events };
}

test('all mode reports a continuous probe failure and preserves the selected generation', () => {
    const generation = reset(({ routing }) => { routing.routes.alpha.canary.mode = 'all'; });
    const before = active().selector;
    const { monitor, target, events } = monitorForPrimary(generation);
    monitorModule.startProbeWorker(monitor, target);
    try {
        target.probeWorker.emit('message', { status: 'error', error: 'readiness failed', code: 'PLOINKY_READINESS_FAILED' });
        assert.ok(events.includes('container_probe_failed'));
        assert.deepEqual(active().selector, before);
        assert.ok(!target.pendingRestartTimer);
    } finally { clearTimeout(target.pendingRestartTimer); }
});

test('a Watchdog alongside replacement reopens the primary route and preserves the split canary', async () => {
    const before = reset();
    edge.withEdgeGenerationApplyLock(applyLockCapability => edge.commitWithdrawalEdgeRoutingGeneration({
        workspaceRoot, withdraw: [{ containerName: primary, mode: 'drain', drainOwner: {
            containerName: primary, instanceId: before.agents[primary].instanceId,
            enableGeneration: before.agents[primary].enableGeneration, reason: 'probe-failure',
        } }], applyLockCapability,
    }), { workspaceRoot });
    const { monitor, target } = monitorForPrimary(before);
    const retired = [];
    Object.assign(monitor, {
        createWorkspaceMutationLease: () => ({}), releaseWorkspaceMutationLease() {},
        resolveRouterEndpoint: mode => ({ mode, host: '127.0.0.1', port: 8080, url: 'http://127.0.0.1:8080' }),
        ensureAgentService(_name, _manifest, _dir, options) {
            const old = before.agents[primary];
            const identity = manager.resolveReplacementRuntimeIdentity({
                containerName: primary, existingRecord: old, existingRuntime: false, stageAlongsidePredecessor: true,
                preserveActiveAuthorization: options.preserveActiveAuthorization, networkLifecycleCapability: options.networkLifecycleCapability,
                portMappings: [],
            });
            const staged = identity.preparedRegistryRecord;
            return {
                containerName: identity.candidateContainerName, hostPort: 43901, registryRecord: { ...staged, containerId: 'e'.repeat(64) },
                stagedRegistryRecord: staged, preparationLease: identity.preparationLease, requiresEdgeActivation: true,
                replacementPredecessor: { containerName: primary, containerId: old.containerId, registryRecord: old, runtimeNetwork: options.profileResolution.network },
            };
        },
        resolveAgentReadinessProtocol: () => 'script', runContainerScriptReadiness: () => ({ status: 'success' }),
        retireExactAgentRuntimePredecessor: predecessor => retired.push(predecessor.containerName),
    });
    await monitorModule.performContainerRestart(monitor, target, 'semantic_probe_failed');
    const after = active().generation;
    assert.deepEqual(retired, [primary]);
    assert.notEqual(after.routing.routes.alpha.container, primary);
    assert.equal(after.routing.routes.alpha.hostPort, 43901);
    assert.equal(after.routing.routes.alpha.draining, undefined);
    assert.deepEqual(after.routing.routes.alpha.canary, before.routing.routes.alpha.canary);
    assert.deepEqual(after.agents[secondary], before.agents[secondary]);
    assert.deepEqual(after.routing.routes.beta, before.routing.routes.beta);
});

async function privateCalls() {
    const { signPrivateRouterAssertion } = await import('../../Agent/lib/agentAssertion.mjs');
    const { derivePrivateAgentRequestSecret } = await import('../../cli/utils/security/masterKey.js');
    const { authorizePrivateRoutePlan } = await import('../../cli/server/privateRouter.js');
    const { resolveEdgeRoutePlan, commitRoutePlan } = await import('../../cli/server/edgeRoutePlan.js');
    function plan(operation = 'workspace-logs') {
        const req = {
            method: 'POST', url: `/api/edge/${operation}`, headers: { host: 'localhost' }, ploinkyListenerClass: 'private',
        };
        const result = resolveEdgeRoutePlan({ req, listener: 'private' });
        assert.equal(result.ok, true, result.code);
        return result;
    }
    function call(member, captured = plan(), signingMember = member) {
        const agentId = `agent:${member.repoName}/${member.agentName}`;
        const token = signPrivateRouterAssertion({
            method: 'POST', path: captured.pathname,
            env: {
                PLOINKY_AGENT_ID: agentId,
                PLOINKY_AGENT_INSTANCE_ID: member.instanceId,
                PLOINKY_AGENT_ENABLE_GENERATION: member.enableGeneration,
                PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(agentId, signingMember.instanceId, signingMember.enableGeneration),
            },
        });
        const req = { method: 'POST', headers: { 'ploinky-agent-assertion': token } };
        return authorizePrivateRoutePlan({ req, plan: captured });
    }
    return { plan, call, commitRoutePlan };
}

test('private assertions bind both permitted copies to their own secret and deny other tuples and operations', async () => {
    const { plan, call, commitRoutePlan } = await privateCalls();
    const snapshot = reset(({ agents }) => {
        agents.third = { ...agents[primary], instanceId: 'third-instance', enableGeneration: 'third-generation' };
    });
    const permitted = plan();
    const forbidden = plan('agent-exec');
    for (const name of [primary, secondary]) {
        const member = snapshot.agents[name];
        const sibling = snapshot.agents[name === primary ? secondary : primary];
        assert.equal(call(member, permitted).containerName, name);
        assert.throws(() => call(member, forbidden), { code: 'PRIVATE_CALLER_DENIED' });
        assert.throws(() => call(member, permitted, sibling), /signature/i);
    }
    assert.throws(() => call(snapshot.agents.third, permitted), { code: 'PRIVATE_ASSERTION_REJECTED' });
    assert.equal(commitRoutePlan(permitted), true);
    reset(({ agents }) => { agents[secondary].enableGeneration = 'replacement-generation'; });
    assert.equal(commitRoutePlan(permitted), false);
    assert.throws(() => call(snapshot.agents[secondary]), { code: 'PRIVATE_ASSERTION_REJECTED' });
});

test('a stale primary denial cannot follow its replacement into a paired route', async () => {
    const { entryFor } = await import('./hardwareAvailabilityFixtures.mjs');
    assert.throws(() => reset(({ routing, agents }) => {
        delete routing.routes.alpha.hostPort;
        routing.routes.alpha.hardwareAvailability = entryFor('alpha', {
            ...agents[primary], key: primary, enableGeneration: 'retired',
        }).projection;
    }), { code: 'EDGE_GENERATION_INVALID' });
});

test('a compiled hardware refusal of the primary leaves the canary authorized', async () => {
    const { plan, call } = await privateCalls();
    const { entryFor } = await import('./hardwareAvailabilityFixtures.mjs');
    const { markRouteHardwareUnavailable, leaseRouteHardwareAvailability } = await import('../../cli/server/hardwareAvailability.mjs');
    const snapshot = reset(({ routing, agents }) => {
        const entry = entryFor('alpha', { ...agents[primary], key: primary });
        routing.routes.alpha = markRouteHardwareUnavailable(routing.routes.alpha, entry.projection);
    });
    const captured = plan();
    assert.throws(() => call(snapshot.agents[primary], captured), { code: 'PRIVATE_CALLER_HARDWARE_UNAVAILABLE' });
    assert.equal(call(snapshot.agents[secondary], captured).containerName, secondary);
    assert.equal(leaseRouteHardwareAvailability(captured.lease, 'alpha', primary)?.key, primary);
    assert.equal(leaseRouteHardwareAvailability(captured.lease, 'alpha', secondary), null);
});

test('a canary registry refusal survives independent primary no-wait store writes', async () => {
    const { commit, entryFor } = await import('./hardwareAvailabilityFixtures.mjs');
    const { readHardwareAvailabilityPolicy } = await import('../../cli/sandbox/hardwareAvailabilityStore.mjs');
    const { leaseRouteHardwareAvailability, identityHardwareUnavailable, identityLeaseHardwareUnavailable } =
        await import('../../cli/server/hardwareAvailability.mjs');
    const snapshot = reset(({ agents, routing }) => {
        delete routing.routes.alpha.hostPort;
        delete agents[secondary].hostPort;
        agents[secondary].hardwareAvailability = entryFor('alpha', { ...agents[secondary], key: secondary }).projection;
    });
    const paths = edge.resolveEdgeGenerationPaths({ workspaceRoot });
    const capture = () => edge.captureEdgeRoutingLease({ workspaceRoot });
    const updatePrimary = (entries) => commit(workspaceRoot, paths, {
        expectedRevision: readHardwareAvailabilityPolicy({ paths }).revision,
        entries,
    });
    const id = (containerName) => ({ ...snapshot.agents[containerName], routeKey: 'alpha', containerName });
    const check = (lease, primaryDenied) => {
        const expected = primaryDenied ? primary : undefined;
        assert.equal(leaseRouteHardwareAvailability(lease, 'alpha', primary)?.key, expected);
        assert.equal(identityLeaseHardwareUnavailable(lease, id(primary))?.key, expected);
        assert.equal(leaseRouteHardwareAvailability(lease, 'alpha', secondary)?.key, secondary);
        assert.equal(identityLeaseHardwareUnavailable(lease, id(secondary))?.key, secondary);
    };
    assert.equal(identityHardwareUnavailable(snapshot, id(primary)), null);
    assert.equal(identityHardwareUnavailable(snapshot, id(secondary))?.key, secondary);
    const initial = capture();
    check(initial, false);
    updatePrimary({ alpha: entryFor('alpha', { ...snapshot.agents[primary], key: primary }) });
    assert.equal(initial.commit(), false);
    const both = capture();
    check(both, true);
    updatePrimary({});
    assert.equal(both.commit(), false);
    check(capture(), false);
});

for (const [label, mutate] of [
    ['wrong physical owner', (member, projectionFor) => { member.hardwareAvailability = projectionFor(primary, member); }],
    ['retired instance', member => { member.hardwareAvailability.instanceId = 'retired'; }],
    ['retired enable generation', member => { member.hardwareAvailability.enableGeneration = 'retired'; }],
    ['published host port', member => { member.hostPort = 43103; }],
    ['published service targets', member => { member.serviceTargets = { extra: 43103 }; }],
    ['malformed outcome', member => { member.hardwareAvailability.problem.state = 'unknown'; }],
]) test('generation rejects a canary hardware projection with ' + label, async () => {
    const { entryFor } = await import('./hardwareAvailabilityFixtures.mjs');
    const projectionFor = (key, member) => entryFor('alpha', { ...member, key }).projection;
    assert.throws(() => reset(({ agents }) => {
        const member = agents[secondary];
        delete member.hostPort;
        member.hardwareAvailability = projectionFor(secondary, member);
        mutate(member, projectionFor);
    }), { code: 'EDGE_GENERATION_INVALID' });
});

test('private hardware admission refuses a canary with a registry refusal and admits its primary', async () => {
    const { entryFor } = await import('./hardwareAvailabilityFixtures.mjs');
    const snapshot = reset(({ agents }) => {
        delete agents[secondary].hostPort;
        agents[secondary].hardwareAvailability = entryFor('alpha', { ...agents[secondary], key: secondary }).projection;
    });
    const { call, plan } = await privateCalls();
    const captured = plan();
    assert.throws(() => call(snapshot.agents[secondary], captured), { code: 'PRIVATE_CALLER_HARDWARE_UNAVAILABLE' });
    assert.equal(call(snapshot.agents[primary], captured).containerName, primary);
});

for (const retryAfterFailure of [false, true]) {
    const queuedReason = retryAfterFailure ? 'restart_failed' : 'drain_owner_retry';
    test(`all mode preserves a split probe drain across a queued ${queuedReason} and later Watchdog ticks`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const generation = reset();
        const { monitor, target } = monitorForPrimary(generation);
        const scheduled = [];
        const held = [];
        let leases = 0;
        let physicalAttempts = 0;
        Object.assign(monitor, {
            syncManagedContainers() {},
            listRunningContainerNames: () => [primary],
            observeSandboxRuntime: () => ({ state: 'absent' }),
            log(_level, event, detail) {
                if (event === 'container_scheduling_restart') scheduled.push(detail.reason);
                if (event === 'container_probe_restart_held_for_canary') held.push(detail.reason);
            },
            createWorkspaceMutationLease() {
                leases++;
                if (retryAfterFailure && leases === 1) throw new Error('transient lease failure');
                return {};
            },
            releaseWorkspaceMutationLease() {},
            withNetworkLifecycleLock() { physicalAttempts++; throw new Error('unexpected physical restart'); },
        });
        const drainOwner = { containerName: primary, instanceId: target.instanceId, enableGeneration: target.enableGeneration, reason: 'probe-failure' };
        edge.withEdgeGenerationApplyLock(applyLockCapability => edge.commitWithdrawalEdgeRoutingGeneration({
            workspaceRoot, withdraw: [{ containerName: primary, mode: 'drain', drainOwner }], applyLockCapability,
        }), { workspaceRoot });
        monitorModule.monitorTick(monitor);
        assert.deepEqual(scheduled, ['drain_owner_retry']);
        if (retryAfterFailure) {
            t.mock.timers.runAll();
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(scheduled, ['drain_owner_retry', 'restart_failed']);
        }
        edge.withEdgeGenerationApplyLock(applyLockCapability => {
            const routing = JSON.parse(fs.readFileSync(path.join(ploinky, 'routing.json'), 'utf8'));
            const agents = JSON.parse(fs.readFileSync(path.join(ploinky, 'agents.json'), 'utf8'));
            routing.routes.alpha.canary.mode = 'all';
            const options = { workspaceRoot, routing, agents, applyLockCapability };
            const { preparationLease } = edge.prepareAdditiveEdgeRoutingGeneration(options);
            edge.commitAdditiveEdgeRoutingGeneration(preparationLease, options);
        }, { workspaceRoot });
        const selected = active().selector;
        t.mock.timers.runAll();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(held, [queuedReason]);
        assert.equal(leases, retryAfterFailure ? 2 : 1);
        assert.equal(physicalAttempts, 0);

        const previousSchedules = [...scheduled];
        monitorModule.monitorTick(monitor);
        assert.deepEqual(scheduled, previousSchedules);
        assert.equal(target.drainOwnerRetry.attempts, 1);
        assert.deepEqual(active().selector, selected);
        assert.deepEqual(active().generation.routing.routes.alpha.drainOwner, drainOwner);
        assert.deepEqual(active().generation.agents, generation.agents);
    });
}
