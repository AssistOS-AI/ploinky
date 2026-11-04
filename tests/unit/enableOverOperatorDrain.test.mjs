import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Enabling an agent under an operator drain is refused. The refusal must leave
// the other routes served: it happens before the selector is touched.

const originalCwd = process.cwd();
const previous = {
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
};
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-enable-operator-drain-')));
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '8080';
process.env.PLOINKY_MASTER_KEY = '8'.repeat(64);

test.after(() => {
    process.chdir(originalCwd);
    for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

function writeManifest(agentName) {
    const directory = path.join(workspace, '.ploinky', 'repos', 'demo', agentName);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
        container: 'node:20-alpine',
        network: { mode: 'default' },
    }));
}
writeManifest('failing');
writeManifest('bystander');

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const routing = await import('../../cli/server/routingFile.js');
const agents = await import('../../cli/utils/agents.js');
const coordinated = await import('../../cli/sandbox/coordinatedEdgeApply.js');

function seedTwoAgents() {
    const init = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    routing.writeRoutingConfig({ port: 8080, routes: {} }, { coordinate: false });
    fs.writeFileSync(init.paths.desiredFile, JSON.stringify({ hosts: {} }));
    const first = agents.prepareAgentEnableBatch([{agentName:'demo/failing',mode:'global'},{agentName:'demo/bystander',mode:'global'}],{reason:'seed',retireNoWaitMarkers(){return []}});
    const lease = first.preparedGeneration?.preparationLease;
    const finalRouting = structuredClone(first.preparedGeneration.generation.routing);
    const finalAgents = structuredClone(first.preparedGeneration.generation.agents);
    for (const plan of first.plans) {
        finalRouting.routes[plan.routeKey].hostPort = plan.routeKey === 'failing' ? 41001 : 41002;
    }
    edge.withEdgeGenerationApplyLock((applyLockCapability) => {
        if (lease?.mode === 'additive' || lease?.mode === 'withdrawn') {
            edge.commitAdditiveEdgeRoutingGeneration(lease, { routing: finalRouting, agents: finalAgents, applyLockCapability });
        } else {
            fs.writeFileSync(init.paths.agentsFile, JSON.stringify(finalAgents));
            routing.writeRoutingConfig(finalRouting, { coordinate: false });
            coordinated.applyEdgeRoutingGeneration({ reason: 'fixture', preparationLease: lease, applyLockCapability });
        }
    }, { preparationLease: lease });
}

function state() {
    return {
        loaded: edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }),
        routing: fs.readFileSync(path.join(workspace, '.ploinky', 'routing.json'), 'utf8'),
        agents: fs.readFileSync(path.join(workspace, '.ploinky', 'agents.json'), 'utf8'),
    };
}

function assertUntouched(before) {
    const after = state();
    assert.equal(after.loaded.selector.state, 'active');
    assert.equal(after.loaded.selector.generation, before.loaded.selector.generation);
    assert.equal(after.routing, before.routing);
    assert.equal(after.agents, before.agents);
    assert.equal(after.loaded.generation.routing.routes.bystander.hostPort, 41002);
    assert.equal(after.loaded.generation.routing.routes.failing.draining, true);
}

test.before(() => {
    seedTwoAgents();
    const seeded = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    edge.withEdgeGenerationApplyLock((applyLockCapability) => edge.commitWithdrawalEdgeRoutingGeneration({
        withdraw: [{ containerName: seeded.generation.routing.routes.failing.container, mode: 'drain' }],
        reason: 'operator-drain',
        workspaceRoot: workspace,
        applyLockCapability,
    }), { workspaceRoot: workspace });
});

test('enable over an operator drain is refused and keeps the generation active', async () => {
    const before = state();
    await assert.rejects(agents.enableAgent('demo/failing', 'global'), { code: 'PLOINKY_AGENT_DRAINING' });
    assertUntouched(before);
});

test('enable after the manifest changed takes no other path past the drain', async () => {
    const manifest = path.join(workspace, '.ploinky', 'repos', 'demo', 'failing', 'manifest.json');
    const original = fs.readFileSync(manifest);
    fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), about: 'updated' }));
    try {
        const before = state();
        await assert.rejects(agents.enableAgent('demo/failing', 'global'), { code: 'PLOINKY_AGENT_DRAINING' });
        assertUntouched(before);
    } finally {
        fs.writeFileSync(manifest, original);
    }
});

test('a drain that appears after the preflight is refused by the batch without inactivation', () => {
    const before = state();
    assert.throws(() => agents.prepareAgentEnableBatch(
        [{ agentName: 'demo/failing', mode: 'global' }],
        { reason: 'race', retireNoWaitMarkers() { return []; } },
    ), { code: 'PLOINKY_AGENT_DRAINING' });
    assertUntouched(before);
});
