// The administrator Apply plans an exact instance with the REAL plan loader (readPlan): the manifest, the profile
// service, the dependency graph and the runtime admission read a real workspace on disk. Only the policy store, the
// locks and the engine (create, readiness, activation) are injected. LIVE-P1 attempt 4 failed here: the product persists
// the resolved profile 'default' on every agent record, and the graph refused it as an explicit profile of a manifest
// that declares none ("profile 'default' is not defined by hwlfixture/probe; available profiles: (none)").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-plan-')));
const priorRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const priorCwd = process.cwd();
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.chdir(workspace);
test.after(() => {
    process.chdir(priorCwd);
    if (priorRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = priorRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});
// (After the workspace root is set: the product reads it when its modules load.)
const { fixtureManifest, fixtureContainerName, GPU_FIXTURE_HARDWARE_LIMITS } = await import('../hardware-limits/liveFixture.mjs');
const { applyHardwareLimits, reconcileExactHardwareInstance } = await import('../../cli/sandbox/hardwareLimits/reconcile.mjs');
const { resolveWorkspaceDependencyGraph } = await import('../../cli/utils/workspaceDependencyGraph.js');
const { readAgentRegistrySnapshot } = await import('../../cli/utils/agentRegistrySnapshot.js');

const IMAGE = `docker.io/assistos/ploinky-node@sha256:${'a'.repeat(64)}`;
const REPOSITORY = 'hwlfixture';
const AGENTS = [{ name: 'probe', hardwareLimits: { ...GPU_FIXTURE_HARDWARE_LIMITS } }, { name: 'peer', hardwareLimits: { ...GPU_FIXTURE_HARDWARE_LIMITS } }, { name: 'cpu', hardwareLimits: { memory: '64m', cpus: '0.5', pidsLimit: 64 } }];
const token = { epoch: 'e'.repeat(32), revision: 2 };
const keyOf = name => fixtureContainerName(workspace, name, REPOSITORY);

// The fixture the live run writes (the real manifest builder), and the registry the product leaves after `ploinky start`:
// one agent record per instance, each carrying the RESOLVED profile exactly as cli/utils/agents.js persists it
// (`record.profile = profileResolution.resolvedProfileName`, which is 'default' for a manifest without profiles). The
// record is written with that shape directly: the real writer needs a running router and engine.
function writeWorkspace({ profile = 'default' } = {}) {
    const root = path.join(workspace, '.ploinky');
    fs.rmSync(root, { recursive: true, force: true });
    for (const agent of AGENTS) {
        const directory = path.join(root, 'repos', REPOSITORY, agent.name);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(fixtureManifest(agent, { image: IMAGE, agents: AGENTS }), null, 2));
    }
    fs.writeFileSync(path.join(root, 'enabled_repos.json'), JSON.stringify([REPOSITORY]));
    const registry = Object.fromEntries(AGENTS.map((agent, index) => [keyOf(agent.name), {
        type: 'agent', repoName: REPOSITORY, agentName: agent.name, containerImage: IMAGE, instanceId: `instance-${agent.name}`, enableGeneration: `generation-${agent.name}`,
        containerId: String(index + 1).repeat(64), ...(profile === null ? {} : { profile }),
    }]));
    fs.writeFileSync(path.join(root, 'agents.json'), JSON.stringify(registry, null, 2));
    // The router port the first workspace start persisted (the plan resolves the Router endpoint from it).
    fs.writeFileSync(path.join(root, 'routing.json'), JSON.stringify({ port: 8080, routes: {} }));
    return registry;
}

// Apply of the probe instance with the real loadPlan; `reached` names the injected boundary the flow got to.
function applyProbe(overrides = {}) {
    const reached = [];
    const run = () => applyHardwareLimits({ expectedToken: token, containers: [keyOf('probe')] }, {
        lease: (_options, callback) => callback(), readPolicy: () => ({ token }), policyCheck: () => ({ token }), isUnchanged: () => false,
        reconcile: (instance, options) => reconcileExactHardwareInstance(instance, { ...options, origin: 'cli' }, {
            readPolicy: () => ({ token }), policyCheck: () => ({ token }),
            maintenance: async (_key, _options, callback) => callback(), network: async (callback) => callback({}),
            ensure: (agentName) => { reached.push(`ensure:${agentName}`); throw Object.assign(new Error('the engine boundary was reached'), { code: 'engine_boundary' }); },
        }),
        ...overrides,
    });
    return { run, reached };
}

test('Z3b.apply-plans-a-profile-less-fixture-whose-record-carries-the-resolved-default-profile-and-reaches-the-launch', async () => {
    const registry = writeWorkspace();
    assert.equal(registry[keyOf('probe')].profile, 'default', 'the record carries the resolved profile, as the product writes it');
    assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, '.ploinky', 'repos', REPOSITORY, 'probe', 'manifest.json'), 'utf8')).profiles, undefined, 'the manifest declares no profiles');
    const { run, reached } = applyProbe();
    const result = await run();
    // Planning passed with the real loader and the flow reached the launch boundary (the engine is the only fake).
    assert.deepEqual(reached, ['ensure:probe'], JSON.stringify(result));
    assert.equal(result.results[0].error, 'engine_boundary');
    assert.equal(result.results[0].cause.step, 'runtime-launch', 'the failure is the injected launch, not planning');
    assert.doesNotMatch(JSON.stringify(result), /is not defined by/);
});

test('Z3b.the-graph-planning-of-that-record-resolves-the-persisted-profile-and-an-unknown-one-is-still-refused', () => {
    writeWorkspace();
    const record = readAgentRegistrySnapshot()[keyOf('probe')];
    const graph = resolveWorkspaceDependencyGraph({ staticAgentRef: `${REPOSITORY}/probe`, registry: readAgentRegistrySnapshot(), rootAlias: '', rootProfile: record.profile });
    assert.equal(graph.nodes.get(`${REPOSITORY}/probe`).profile, 'default');
    assert.throws(() => resolveWorkspaceDependencyGraph({ staticAgentRef: `${REPOSITORY}/probe`, registry: readAgentRegistrySnapshot(), rootProfile: 'gpu' }), /profile 'gpu' is not defined by hwlfixture\/probe; available profiles: \(none\)/);
});

test('Z3c.an-untyped-planning-failure-reports-the-planning-step', async () => {
    writeWorkspace();
    // The record names a profile the manifest does not declare: a real planning failure of the real loader.
    const registry = structuredClone(readAgentRegistrySnapshot());
    registry[keyOf('probe')].profile = 'gpu';
    fs.writeFileSync(path.join(workspace, '.ploinky', 'agents.json'), JSON.stringify(registry, null, 2));
    const { run, reached } = applyProbe();
    const result = await run();
    assert.equal(result.status, 409);
    assert.equal(result.results[0].cause.step, 'planning', JSON.stringify(result.results[0]));
    assert.match(result.results[0].message, /^Apply stopped at planning: Error \(PLOINKY_PROFILE_NOT_FOUND\): .*hwlfixture\/probe: profile 'gpu' not found/, result.results[0].message);
    assert.deepEqual(reached, [], 'nothing was launched');
    // An injected plan loader that fails is labelled the same way.
    writeWorkspace();
    const injected = await applyProbe({ loadPlan: () => { throw new Error('manifest unreadable'); } }).run();
    assert.equal(injected.error, 'apply_failed'); assert.equal(injected.results[0].cause.step, 'planning'); assert.equal(injected.cause.step, 'planning');
});
