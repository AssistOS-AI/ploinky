import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// A7 against the real edge generation store: a disable withdraws its routes
// from the active generation, which stays active (and ready) while the
// runtime is removed; only the physical removal is simulated.

const originalCwd = process.cwd();
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-disable-withdrawal-'));
const previous = {
    root: process.env.PLOINKY_WORKSPACE_ROOT,
    routerHostPort: process.env.PLOINKY_ROUTER_HOST_PORT,
    mediaHostPort: process.env.PLOINKY_MEDIA_HOST_PORT,
};
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const agents = await import('../../cli/utils/agents.js');
const { withEdgeSelectionObserver } = await import('../../cli/sandbox/edgeSelectionMutations.mjs');

test.after(() => {
    process.chdir(originalCwd);
    for (const [key, name] of [['root', 'PLOINKY_WORKSPACE_ROOT'], ['routerHostPort', 'PLOINKY_ROUTER_HOST_PORT'], ['mediaHostPort', 'PLOINKY_MEDIA_HOST_PORT']]) {
        if (previous[key] === undefined) delete process.env[name];
        else process.env[name] = previous[key];
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

const ploinkyDir = path.join(workspace, '.ploinky');
const repoDir = path.join(ploinkyDir, 'repos', 'demo');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function record(agentName) {
    return {
        type: 'agent',
        repoName: 'demo',
        agentName,
        instanceId: `${agentName}-instance`,
        enableGeneration: `${agentName}-generation`,
        auth: { mode: 'sso' },
    };
}

function seedWorkspace() {
    fs.rmSync(ploinkyDir, { recursive: true, force: true });
    for (const agentName of ['root', 'old']) writeJson(path.join(repoDir, agentName, 'manifest.json'), {});
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        routes: {
            root: { repo: 'demo', agent: 'root', container: 'root_container', hostPath: path.join(repoDir, 'root'), hostPort: 41001 },
            old: { repo: 'demo', agent: 'old', container: 'old_container', hostPath: path.join(repoDir, 'old'), hostPort: 41002 },
        },
    });
    writeJson(path.join(ploinkyDir, 'agents.json'), {
        root_container: record('root'),
        old_container: record('old'),
        _config: { unrelated: true },
    });
    writeJson(path.join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), {
        hosts: { 'app.example.com': { agent: 'demo/root' } },
        cloudflare: { tunnelTokenSecret: 'cloudflare/tunnel-token' },
    });
    writeJson(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), {
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    });
    edge.applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'disable-withdrawal-fixture', publicationState: 'ready' });
}

function removalDependencies(onRemove) {
    const existing = new Set(['old_container']);
    return {
        isSandboxRuntimeImpl: () => false,
        classifyRecordRuntimeImpl: () => ({ kind: 'container' }),
        retireNoWaitMarkersImpl: () => [],
        stopAndRemoveImpl(containerName) {
            onRemove(containerName);
            existing.delete(containerName);
            return [containerName];
        },
        containerExistsImpl: (containerName) => existing.has(containerName),
    };
}

test('A7 a real disable keeps the edge active and ready from withdrawal through runtime removal', async () => {
    seedWorkspace();
    const before = edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector;
    const writes = [];
    let selectorAtRemoval = null;
    const result = await withEdgeSelectionObserver((entry) => writes.push(entry), () => agents.disableAgent(
        'old_container',
        removalDependencies(() => {
            selectorAtRemoval = edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector;
        }),
    ));
    assert.equal(result.status, 'removed');
    assert.deepEqual(writes.map((entry) => [entry.before.state, entry.after.state]), [['active', 'active']]);
    assert.equal(selectorAtRemoval.state, 'active');
    assert.equal(selectorAtRemoval.publicationState, 'ready');
    assert.notEqual(selectorAtRemoval.generation, before.generation);
    const active = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(active.selector.generation, selectorAtRemoval.generation, 'nothing commits after the removal');
    assert.equal(active.generation.routing.routes.old, undefined);
    assert.equal(active.generation.agents.old_container, undefined);
    assert.deepEqual(active.generation.agents._config, { unrelated: true });
    assert.equal(active.generation.routing.routes.root.hostPort, 41001);
});
