import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const originalCwd = process.cwd();
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-policy-restart-')));
fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), JSON.stringify({ port: 8080, routes: {} }));
process.chdir(root);
const { restartRouterOnly, graphNodeRuntimeReplacementReason } = await import('../../cli/commands/workspaceUtil.js');
const { runWithRuntimePolicyEnvironment } = await import('../../cli/utils/runtime/runtimePolicyContext.mjs');
const { getProfileEnvVars } = await import('../../cli/utils/runtime/profileService.js');
const { PROD_GATES_FILE } = await import('../../cli/utils/runtime/mcpProdGates.mjs');
const { computeEnvHash } = await import('../../cli/sandbox/docker/common.js');
const { buildRuntimeNetworkPlan, computeAgentEnvHash } = await import('../../cli/sandbox/docker/agentServiceManager.js');
test.after(() => { process.chdir(originalCwd); fs.rmSync(root, { recursive: true, force: true }); });

function routerFixture() {
    const events = [];
    const generation = { selector: { generation: 'g1', activationId: 'a1' }, generation: { routing: { port: 8080 } } };
    const agents = { worker: { instanceId: 'instance-1', enableGeneration: 'generation-1' } };
    const desired = { profile: 'prod', prod: true, routes: { changed: true } };
    const originalAgents = structuredClone(agents);
    const deps = {
        acquireLease: async () => { events.push('acquire'); return 'lease'; },
        runWithLease: async (lease, callback) => { assert.equal(lease, 'lease'); return callback(); },
        releaseLease: (lease) => { assert.equal(lease, 'lease'); events.push('release'); },
        readCapture: () => ({ prod: false, workspaceProfile: 'dev' }),
        loadGeneration: () => generation,
        readPort: () => 8080,
        waitForListener: async () => { throw new Error('old listener stopped'); },
        routerEnvironment: () => ({}),
        ensureReady: async ({ spawnRouter }) => { events.push('ready'); spawnRouter(); },
        spawnRouter: (port) => { assert.equal(port, 8080); events.push('spawn'); },
    };
    const killRouterIfRunning = () => { events.push('stop'); };
    return { events, generation, agents, desired, originalAgents, deps, killRouterIfRunning };
}

test('Router-only restart retains active policy and generation despite pending desired changes', async () => {
    const f = routerFixture();
    fs.mkdirSync(path.dirname(PROD_GATES_FILE), { recursive: true });
    fs.writeFileSync(PROD_GATES_FILE, JSON.stringify({ schema: 1, prod: false, workspaceProfile: 'dev', routes: {} }));
    fs.writeFileSync(path.join(root, '.ploinky', 'profile'), 'prod');
    const deps = { ...f.deps };
    delete deps.readCapture;
    await restartRouterOnly({ killRouterIfRunning: f.killRouterIfRunning }, deps);
    assert.equal(getProfileEnvVars('worker', 'demo', 'embedded').PLOINKY_PROFILE_ENV, 'development');
    assert.equal(fs.readFileSync(path.join(root, '.ploinky', 'profile'), 'utf8'), 'prod');
    assert.deepEqual(f.events, ['acquire', 'stop', 'ready', 'spawn', 'release']);
    assert.deepEqual(f.agents, f.originalAgents);
    assert.deepEqual(f.generation.selector, { generation: 'g1', activationId: 'a1' });
    assert.deepEqual(f.desired, { profile: 'prod', prod: true, routes: { changed: true } });
});

test('Router-only restart validates capture, generation and port before stopping', async () => {
    for (const change of [
        { readCapture: () => ({ unavailable: true }) },
        { readCapture: () => ({ prod: false }) },
        { loadGeneration: () => { throw new Error('inactive generation'); } },
        { readPort: () => 8081 },
    ]) {
        const f = routerFixture();
        await assert.rejects(restartRouterOnly({ killRouterIfRunning: f.killRouterIfRunning }, { ...f.deps, ...change }));
        assert.deepEqual(f.events, ['acquire', 'release']);
        assert.deepEqual(f.agents, f.originalAgents);
    }
});

test('Router-only restart detects a changed active selector after listener startup', async () => {
    const f = routerFixture();
    let reads = 0;
    f.deps.loadGeneration = () => (++reads === 1 ? f.generation : {
        ...f.generation, selector: { generation: 'g2', activationId: 'a2' },
    });
    await assert.rejects(restartRouterOnly({ killRouterIfRunning: f.killRouterIfRunning }, f.deps), /generation changed/);
    assert.deepEqual(f.events, ['acquire', 'stop', 'ready', 'spawn', 'release']);
    assert.deepEqual(f.agents, f.originalAgents);
});

test('container and native graph adoption replace an identical manifest when runtime policy changes', () => {
    const manifest = { container: 'node:20-alpine', network: { mode: 'none' }, profiles: { default: {}, embedded: {} } };
    const node = { id: 'demo/worker', repoName: 'demo', shortAgentName: 'worker', profile: 'embedded', manifest };
    const record = { instanceId: 'i1', enableGeneration: 'e1', profile: 'embedded' };
    const policy = (prod, workspaceProfile, fn) => runWithRuntimePolicyEnvironment({ prod, workspaceProfile }, fn);
    const options = { agentName: 'worker', repoName: 'demo', profileName: 'embedded' };
    const network = buildRuntimeNetworkPlan('podman', { mode: 'none' });
    const createdContainerHash = policy(false, 'dev', () => computeAgentEnvHash(manifest, {}, { ...options, runtimeNetworkPlan: network }));
    const createdNativeHash = policy(false, 'dev', () => computeEnvHash(manifest, {}, {}, options));
    assert.ok(createdContainerHash && createdNativeHash);
    for (const backend of ['container', 'bwrap', 'seatbelt']) {
        const plan = { node, existing: { key: 'worker', rec: { ...record, envHash: createdNativeHash } }, predecessorBackend: backend };
        const deps = {
            getRuntimeForAgentImpl: () => backend === 'container' ? 'podman' : backend,
            getRuntimeImpl: () => 'podman', containerExistsImpl: () => true,
            isContainerRunningImpl: () => true, isSandboxRunningImpl: () => true,
            getContainerLabelImpl: () => createdContainerHash,
            admitRuntimeImpl: () => null, isLlmRuntimeManifestImpl: () => false,
            createNetworkLifecycleAdapterImpl: () => ({ inspectContainerContract: () => ({ state: 'exact' }) }),
        };
        assert.equal(policy(false, 'dev', () => graphNodeRuntimeReplacementReason(plan, deps)), '', backend);
        assert.equal(policy(false, 'qa', () => graphNodeRuntimeReplacementReason(plan, deps)), 'envHashChanged', backend);
        assert.equal(policy(true, 'prod', () => graphNodeRuntimeReplacementReason(plan, deps)), 'envHashChanged', backend);
        const prodOffHash = policy(false, 'prod', () => backend === 'container'
            ? computeAgentEnvHash(manifest, {}, { ...options, runtimeNetworkPlan: network })
            : computeEnvHash(manifest, {}, {}, options));
        plan.existing.rec.envHash = prodOffHash;
        deps.getContainerLabelImpl = () => prodOffHash;
        assert.equal(policy(false, 'prod', () => graphNodeRuntimeReplacementReason(plan, deps)), '', backend);
        assert.equal(policy(true, 'prod', () => graphNodeRuntimeReplacementReason(plan, deps)), 'envHashChanged', backend);
    }
});
