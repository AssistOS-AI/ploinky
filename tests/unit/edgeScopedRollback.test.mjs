import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// A10 and the RF-I4 rollback precondition. The cross-revision halves (base
// code reading candidate state, and the reverse) are exercised against an
// export of the base commit and recorded with the implementation report.

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-scoped-rollback-'));
const previous = {
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
    PLOINKY_MEDIA_HOST_PORT: process.env.PLOINKY_MEDIA_HOST_PORT,
};
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const { prepareEdgeScopedRollback } = await import('../../cli/commands/edgeScopedRollback.js');

test.after(() => {
    for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

const ploinkyDir = path.join(workspace, '.ploinky');
const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
const repoDir = path.join(ploinkyDir, 'repos', 'fixtures');
// The exact preparation lease document keys and schema of the base revision.
const BASE_LEASE_KEYS = [
    'createdAt', 'lifecycleBindingDigest', 'mode', 'pid', 'predecessorGeneration', 'preparedGeneration',
    'reason', 'schemaVersion', 'selectorActivationId', 'selectorDigest', 'transactionId',
].sort();
const BASE_LEASE_MODES = ['replacement', 'additive'];

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function record(agentName, extra = {}) {
    return {
        type: 'agent',
        repoName: 'fixtures',
        agentName,
        instanceId: `${agentName}-instance`,
        enableGeneration: `${agentName}-generation`,
        auth: { mode: 'sso' },
        ...extra,
    };
}

function seed() {
    fs.rmSync(ploinkyDir, { recursive: true, force: true });
    for (const agentName of ['alpha', 'beta', 'gamma']) writeJson(path.join(repoDir, agentName, 'manifest.json'), {});
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        routes: Object.fromEntries(['alpha', 'beta', 'gamma'].map((agentName, index) => [agentName, {
            repo: 'fixtures',
            agent: agentName,
            container: `${agentName}-container`,
            hostPath: path.join(repoDir, agentName),
            hostPort: 43100 + index,
        }])),
    });
    writeJson(path.join(ploinkyDir, 'agents.json'), Object.fromEntries(
        ['alpha', 'beta', 'gamma'].map((agentName) => [`${agentName}-container`, record(agentName)]),
    ));
    writeJson(path.join(edgeDir, 'desired.json'), { hosts: {} });
    writeJson(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), { schema: 'router-policy', httpRoutes: [], mcpTools: [] });
    edge.applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'rollback-fixture' });
}

function drainAndPrepare(containerName = 'beta-container', agentName = 'beta') {
    return edge.withEdgeGenerationApplyLock((applyLockCapability) => {
        edge.commitWithdrawalEdgeRoutingGeneration({
            workspaceRoot: workspace,
            withdraw: [{
                containerName,
                mode: 'drain',
                drainOwner: { containerName, instanceId: `${agentName}-instance`, enableGeneration: `${agentName}-generation`, reason: 'replacement' },
            }],
            applyLockCapability,
        });
        const agents = JSON.parse(fs.readFileSync(path.join(ploinkyDir, 'agents.json'), 'utf8'));
        agents[containerName] = record(agentName, { instanceId: `${agentName}-next`, enableGeneration: `${agentName}-next-generation` });
        return edge.prepareWithdrawnReplacementEdgeRoutingGeneration({
            workspaceRoot: workspace,
            containerName,
            agents,
            applyLockCapability,
        });
    }, { workspaceRoot: workspace });
}

function leaseFile() {
    return path.join(edgeDir, 'preparation-lease.json');
}

function abandonLease() {
    const exited = spawnSync(process.execPath, ['-e', '']);
    const document = JSON.parse(fs.readFileSync(leaseFile(), 'utf8'));
    fs.writeFileSync(leaseFile(), JSON.stringify({ ...document, pid: exited.pid }, null, 2), { mode: 0o600 });
}

test('A10 a withdrawn lease keeps the base lease document shape, so the base revision refuses it only by its mode', () => {
    seed();
    drainAndPrepare();
    const document = JSON.parse(fs.readFileSync(leaseFile(), 'utf8'));
    assert.deepEqual(Object.keys(document).sort(), BASE_LEASE_KEYS);
    assert.equal(document.schemaVersion, 3);
    assert.equal(document.mode, 'withdrawn');
    assert.equal(BASE_LEASE_MODES.includes(document.mode), false);
    assert.match(document.predecessorGeneration, /^sha256:[a-f0-9]{64}$/);
});

test('RF-I4 the rollback precondition retires an abandoned withdrawn lease and lifts every automatic drain', async () => {
    seed();
    // An operator drain is not the candidate's to lift.
    edge.withEdgeGenerationApplyLock((applyLockCapability) => edge.commitWithdrawalEdgeRoutingGeneration({
        workspaceRoot: workspace,
        withdraw: [{ containerName: 'gamma-container', mode: 'drain' }],
        applyLockCapability,
    }), { workspaceRoot: workspace });
    drainAndPrepare();
    assert.throws(() => drainAndPrepare('alpha-container', 'alpha'), { code: 'EDGE_PREPARATION_BUSY' });
    abandonLease();

    const result = await prepareEdgeScopedRollback();
    assert.equal(result.preparation.retired, true);
    assert.equal(result.preparation.mode, 'withdrawn');
    assert.deepEqual(result.reopenedRoutes, ['beta']);
    assert.equal(edge.readEdgeRoutingPreparationOwner({ workspaceRoot: workspace }), null);
    const active = edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(active.selector.state, 'active');
    const beta = active.generation.routing.routes.beta;
    assert.equal(beta.drainOwner, undefined, 'the rollback removes every drainOwner');
    assert.equal(beta.draining, undefined);
    assert.equal(beta.hostPort, undefined, 'the lifted route has no target until the restart');
    assert.equal(active.generation.routing.routes.gamma.draining, true, 'an operator drain stays');
    assert.equal(Object.values(active.generation.routing.routes).some((route) => route.drainOwner), false);

    const again = await prepareEdgeScopedRollback();
    assert.deepEqual(again, { preparation: { retired: false }, reopenedRoutes: [] });
});

test('RF-I4 the rollback precondition refuses while the preparation owner is alive and changes nothing', async () => {
    seed();
    const prepared = drainAndPrepare();
    const routingBefore = fs.readFileSync(path.join(ploinkyDir, 'routing.json'), 'utf8');
    const selectorBefore = fs.readFileSync(path.join(edgeDir, 'active.json'), 'utf8');
    await assert.rejects(prepareEdgeScopedRollback(), { code: 'EDGE_PREPARATION_BUSY' });
    assert.equal(fs.readFileSync(path.join(ploinkyDir, 'routing.json'), 'utf8'), routingBefore);
    assert.equal(fs.readFileSync(path.join(edgeDir, 'active.json'), 'utf8'), selectorBefore);
    assert.equal(edge.readEdgeRoutingPreparationOwner({ workspaceRoot: workspace }).mode, 'withdrawn');
    edge.abortEdgeRoutingPreparation(prepared.preparationLease, { workspaceRoot: workspace });
});
