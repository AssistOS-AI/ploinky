import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-abandoned-preparation-'));
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';
const edge = await import('../../cli/sandbox/edgeGeneration.js');
const locks = await import('../../cli/utils/runtime/maintenanceLocks.js');
const network = await import('../../cli/sandbox/networkLifecycle.js');
test.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

function fixture(t, { reason = 'runtime-identity-rotation:forceRecreate:alpha-container' } = {}) {
    const paths = edge.resolveEdgeGenerationPaths({ workspaceRoot: workspace });
    fs.rmSync(paths.ploinkyDir, { recursive: true, force: true });
    const agentPath = path.join(paths.ploinkyDir, 'repos', 'fixtures', 'alpha');
    fs.mkdirSync(agentPath, { recursive: true });
    fs.mkdirSync(path.dirname(paths.policyFile), { recursive: true });
    fs.mkdirSync(paths.edgeDir, { recursive: true });
    fs.writeFileSync(path.join(agentPath, 'manifest.json'), '{}');
    const record = { type: 'agent', repoName: 'fixtures', agentName: 'alpha',
        instanceId: 'instance', enableGeneration: 'generation', auth: { mode: 'local' } };
    fs.writeFileSync(paths.agentsFile, JSON.stringify({ 'alpha-container': record }));
    fs.writeFileSync(paths.routingFile, JSON.stringify({ routes: { alpha: {
        repo: 'fixtures', agent: 'alpha', container: 'alpha-container', hostPath: agentPath, hostPort: 43101,
    } } }));
    fs.writeFileSync(paths.policyFile, JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }));
    fs.writeFileSync(paths.desiredFile, JSON.stringify({ hosts: {} }));
    const prepared = edge.prepareEdgeRoutingGeneration({ workspaceRoot: workspace, reason });
    const sourceFiles = [paths.activeSelectorFile, paths.agentsFile, paths.routingFile, paths.desiredFile, paths.policyFile];
    const before = sourceFiles.map(file => fs.readFileSync(file));
    const assertUnchanged = () => sourceFiles.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
    const updateLease = change => {
        const lease = JSON.parse(fs.readFileSync(paths.preparationLeaseFile));
        fs.writeFileSync(paths.preparationLeaseFile, JSON.stringify({ ...lease, ...change }));
    };
    const recover = (target = 'alpha-container', extra = {}) => locks.withWorkspaceMutationLease(
        { operation: 'reinstall', waitTimeoutMs: 0 },
        workspaceMutationLease => network.withNetworkLifecycleLock(networkLifecycleCapability => (
            edge.retireAbandonedAgentPreparation(target, { workspaceRoot: workspace,
                workspaceMutationLease, networkLifecycleCapability, ...extra })
        )),
    );
    return { paths, prepared, record, recover, assertUnchanged, updateLease };
}

test('reinstall retires an abandoned same-process preparation and preserves inactive sources', async t => {
    const f = fixture(t);
    assert.equal((await f.recover()).retired, true);
    assert.equal(fs.existsSync(f.paths.preparationLeaseFile), false);
    f.assertUnchanged();
    assert.equal((await f.recover()).retired, false, 'repeat recovery is an exact no-op');
    const retry = edge.prepareEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'retry' });
    edge.abortEdgeRoutingPreparation(retry.preparationLease, { workspaceRoot: workspace });
});

test('reinstall retires a dead owner from a failed graph start even after dependency files are corrected', async t => {
    const f = fixture(t, { reason: 'workspace-graph-enable-prelaunch' });
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    f.updateLease({ pid: child.pid });
    fs.writeFileSync(path.join(f.paths.ploinkyDir, 'repos/fixtures/alpha/manifest.json'), '{"description":"corrected dependency"}');
    assert.equal((await f.recover()).retired, true);
    f.assertUnchanged();
});

test('a live foreign preparation owner blocks reinstall without modifying state', async t => {
    const f = fixture(t);
    f.updateLease({ pid: process.ppid });
    const before = fs.readFileSync(f.paths.preparationLeaseFile);
    await assert.rejects(f.recover(), { code: 'EDGE_PREPARATION_BUSY' });
    assert.deepEqual(fs.readFileSync(f.paths.preparationLeaseFile), before);
    f.assertUnchanged();
});

for (const change of ['target', 'generation', 'binding', 'operation', 'additive']) {
    test(`recovery preserves a preparation with mismatched ${change}`, async t => {
        const f = fixture(t);
        let target = 'alpha-container';
        if (change === 'target') target = 'unrelated-container';
        if (change === 'generation') f.updateLease({ preparedGeneration: `sha256:${'a'.repeat(64)}` });
        if (change === 'binding') f.updateLease({ lifecycleBindingDigest: `sha256:${'b'.repeat(64)}` });
        if (change === 'operation') f.updateLease({ reason: 'runtime-identity-rotation:forceRecreate:other-container' });
        if (change === 'additive') f.updateLease({ mode: 'additive', predecessorGeneration: f.prepared.preparationLease.preparedGeneration });
        const before = fs.readFileSync(f.paths.preparationLeaseFile);
        await assert.rejects(f.recover(target), /preparation|binding/);
        assert.deepEqual(fs.readFileSync(f.paths.preparationLeaseFile), before);
        f.assertUnchanged();
    });
}

test('selector activation drift and current identity drift preserve the outstanding lease', async t => {
    const f = fixture(t);
    const before = fs.readFileSync(f.paths.preparationLeaseFile);
    const agents = JSON.parse(fs.readFileSync(f.paths.agentsFile));
    agents['alpha-container'].enableGeneration = 'different-generation';
    fs.writeFileSync(f.paths.agentsFile, JSON.stringify(agents));
    await assert.rejects(f.recover(), { code: 'EDGE_PREPARATION_SOURCE_CHANGED' });
    assert.deepEqual(fs.readFileSync(f.paths.preparationLeaseFile), before);
    edge.inactivateEdgeRoutingGeneration('another-operation', { workspaceRoot: workspace, preserveSelectedGeneration: true });
    await assert.rejects(f.recover(), { code: 'EDGE_PREPARATION_STALE' });
    assert.deepEqual(fs.readFileSync(f.paths.preparationLeaseFile), before);
});

test('same PID does not authorize recovery without real live workspace and network leases', async t => {
    const f = fixture(t);
    const before = fs.readFileSync(f.paths.preparationLeaseFile);
    await assert.rejects(f.recover('alpha-container', { workspaceMutationLease: {} }), { code: 'PLOINKY_WORKSPACE_MUTATION_CAPABILITY_REQUIRED' });
    await assert.rejects(f.recover('alpha-container', { networkLifecycleCapability: {} }), { code: 'PLOINKY_NETWORK_LIFECYCLE_CAPABILITY_REQUIRED' });
    let released;
    await locks.withWorkspaceMutationLease({ operation: 'reinstall' }, lease => { released = lease; });
    assert.throws(() => locks.assertWorkspaceMutationLease(released), { code: 'PLOINKY_WORKSPACE_MUTATION_CAPABILITY_REQUIRED' });
    assert.deepEqual(fs.readFileSync(f.paths.preparationLeaseFile), before);
    f.assertUnchanged();
});
