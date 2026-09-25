// A workspace start killed after creating its graph preparation leaves a lease
// that denies every later apply. These tests create that lease from a real
// child process, then prove start/restart retire it only while its owner is
// provably stopped and its exact selector, captured generation and registry
// identities are unchanged; every other case is refused with the host recovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-abandoned-start-preparation-'));
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';
const edgeModuleUrl = new URL('../../cli/sandbox/edgeGeneration.js', import.meta.url).href;
const edge = await import(edgeModuleUrl);
const locks = await import('../../cli/utils/runtime/maintenanceLocks.js');
const network = await import('../../cli/sandbox/networkLifecycle.js');
const { settleWorkspaceBeforeRestart } = await import('../../cli/commands/workspaceUtil.js');

const START_REASON = 'workspace-graph-enable-prelaunch';
const HOST_RECOVERY = /`ploinky stop`, then run `ploinky start`/;
const children = new Set();

test.after(async () => {
    for (const child of children) await stopOwner(child);
    fs.rmSync(workspace, { recursive: true, force: true });
});

// The owner imports the production module and prepares exactly as a workspace
// start does, then stays alive until the test stops it.
const OWNER_SOURCE = `
const edge = await import(process.argv[1]);
edge.prepareEdgeRoutingGeneration({ workspaceRoot: process.env.PLOINKY_WORKSPACE_ROOT, reason: process.argv[2] });
process.stdout.write('prepared\\n');
setInterval(() => {}, 60000);
`;

async function startOwner(reason = START_REASON) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', OWNER_SOURCE, edgeModuleUrl, reason], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => {
            stdout += chunk;
            if (stdout.includes('prepared\n')) resolve();
        });
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`preparation owner exited early (${code}): ${stderr}`)));
    });
    return child;
}

async function stopOwner(child) {
    if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        // The update runner's quiescence escalation gives the owner no chance
        // to run its own abort path.
        child.kill('SIGKILL');
        await exited;
    }
    children.delete(child);
}

function resetWorkspace() {
    const paths = edge.resolveEdgeGenerationPaths({ workspaceRoot: workspace });
    fs.rmSync(paths.ploinkyDir, { recursive: true, force: true });
    const agentPath = path.join(paths.ploinkyDir, 'repos', 'fixtures', 'alpha');
    fs.mkdirSync(agentPath, { recursive: true });
    fs.mkdirSync(path.dirname(paths.policyFile), { recursive: true });
    fs.mkdirSync(paths.edgeDir, { recursive: true });
    fs.writeFileSync(path.join(agentPath, 'manifest.json'), '{}');
    fs.writeFileSync(paths.agentsFile, JSON.stringify({ 'alpha-container': {
        type: 'agent', repoName: 'fixtures', agentName: 'alpha',
        instanceId: 'instance', enableGeneration: 'generation', auth: { mode: 'sso' },
    } }));
    fs.writeFileSync(paths.routingFile, JSON.stringify({ routes: { alpha: {
        repo: 'fixtures', agent: 'alpha', container: 'alpha-container', hostPath: agentPath, hostPort: 43101,
    } } }));
    fs.writeFileSync(paths.policyFile, JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }));
    fs.writeFileSync(paths.desiredFile, JSON.stringify({ hosts: {} }));
    return paths;
}

function snapshot(paths) {
    const files = [paths.preparationLeaseFile, paths.activeSelectorFile, paths.agentsFile,
        paths.routingFile, paths.desiredFile, paths.policyFile];
    const before = files.map(file => (fs.existsSync(file) ? fs.readFileSync(file) : null));
    return {
        assertUnchanged() {
            files.forEach((file, index) => assert.deepEqual(
                fs.existsSync(file) ? fs.readFileSync(file) : null, before[index], `${path.basename(file)} changed`,
            ));
        },
        assertOnlyLeaseRemoved() {
            assert.equal(fs.existsSync(paths.preparationLeaseFile), false, 'the abandoned lease is retired');
            files.slice(1).forEach((file, index) => assert.deepEqual(
                fs.readFileSync(file), before[index + 1], `${path.basename(file)} changed`,
            ));
        },
    };
}

function readLease(paths) {
    return JSON.parse(fs.readFileSync(paths.preparationLeaseFile, 'utf8'));
}

function rewriteLease(paths, change) {
    fs.writeFileSync(paths.preparationLeaseFile, JSON.stringify({ ...readLease(paths), ...change }));
}

// Retire exactly as startWorkspace does: under the live workspace mutation
// lease and network lifecycle capability of the serialized start.
function retireAsStart(extra = {}) {
    return locks.withWorkspaceMutationLease(
        { operation: 'workspace-start', waitTimeoutMs: 0 },
        workspaceMutationLease => network.withNetworkLifecycleLock(networkLifecycleCapability => (
            edge.retireAbandonedWorkspaceStartPreparation({ workspaceRoot: workspace,
                workspaceMutationLease, networkLifecycleCapability, ...extra })
        )),
    );
}

async function deadOwnerPreparation(reason = START_REASON) {
    const paths = resetWorkspace();
    const owner = await startOwner(reason);
    await stopOwner(owner);
    assert.equal(readLease(paths).pid, owner.pid, 'the killed child owns the outstanding preparation');
    return { paths, owner };
}

test('workspace start retires the graph preparation of a killed start and unblocks the next apply', async () => {
    const { paths, owner } = await deadOwnerPreparation();
    const state = snapshot(paths);
    // The incident symptom: every unrelated apply, including the next start's
    // agent enable batch, is denied while the dead owner's lease remains.
    assert.throws(
        () => edge.withEdgeGenerationApplyLock(() => {}, { workspaceRoot: workspace }),
        { code: 'EDGE_PREPARATION_BUSY', message: /unrelated apply is denied/ },
    );

    const result = await retireAsStart();
    assert.equal(result.retired, true);
    assert.equal(result.pid, owner.pid);
    state.assertOnlyLeaseRemoved();
    assert.deepEqual(await retireAsStart(), { retired: false }, 'repeat retirement is an exact no-op');

    edge.withEdgeGenerationApplyLock(() => {}, { workspaceRoot: workspace });
    const next = edge.prepareEdgeRoutingGeneration({ workspaceRoot: workspace, reason: START_REASON });
    assert.equal(next.selector.state, 'inactive', 'retirement authorizes nothing; the next start prepares inactive');
    edge.abortEdgeRoutingPreparation(next.preparationLease, { workspaceRoot: workspace });
});

test('a running preparation owner is refused without modifying state and is told to wait', async () => {
    const paths = resetWorkspace();
    const owner = await startOwner();
    try {
        const state = snapshot(paths);
        await assert.rejects(retireAsStart(), (error) => {
            assert.equal(error.code, 'EDGE_PREPARATION_BUSY');
            assert.match(error.message, /still owned by a running process; wait for that operation to finish/);
            assert.match(error.message, HOST_RECOVERY);
            return true;
        });
        state.assertUnchanged();
    } finally {
        await stopOwner(owner);
    }
});

test('a dead owner whose selector the next lifecycle step replaced is refused with the host recovery', async () => {
    const { paths } = await deadOwnerPreparation();
    // This is the recorded incident end state: a later start/restart replaced
    // the selector, so the lease no longer binds the exact inactive selector.
    edge.inactivateEdgeRoutingGeneration('workspace-start-prepare', { workspaceRoot: workspace });
    const selector = JSON.parse(fs.readFileSync(paths.activeSelectorFile, 'utf8'));
    assert.equal(selector.state, 'inactive');
    assert.equal(selector.generation, undefined);
    const state = snapshot(paths);
    await assert.rejects(retireAsStart(), (error) => {
        assert.equal(error.code, 'EDGE_PREPARATION_BUSY');
        assert.match(error.message, /exact inactive selector was replaced/);
        assert.match(error.message, HOST_RECOVERY);
        return true;
    });
    state.assertUnchanged();
});

const mismatches = {
    'captured generation': [
        (paths) => rewriteLease(paths, { preparedGeneration: `sha256:${'a'.repeat(64)}` }),
        /exact inactive selector was replaced/,
    ],
    'lifecycle binding': [
        (paths) => rewriteLease(paths, { lifecycleBindingDigest: `sha256:${'b'.repeat(64)}` }),
        /captured generation no longer matches its lifecycle binding/,
    ],
    'lifecycle operation': [
        (paths) => rewriteLease(paths, { reason: 'runtime-identity-rotation:forceRecreate:alpha-container' }),
        /belongs to another lifecycle operation/,
    ],
    'additive mode': [
        (paths) => rewriteLease(paths, { mode: 'additive', predecessorGeneration: readLease(paths).preparedGeneration }),
        /belongs to another lifecycle operation/,
    ],
    'registered identity': [
        (paths) => {
            const agents = JSON.parse(fs.readFileSync(paths.agentsFile, 'utf8'));
            agents['alpha-container'].enableGeneration = 'different-generation';
            fs.writeFileSync(paths.agentsFile, JSON.stringify(agents));
        },
        /enabled agent identities changed after it was captured/,
    ],
};

for (const [label, [mutate, why]] of Object.entries(mismatches)) {
    test(`a dead owner's preparation with a mismatched ${label} is refused with the host recovery`, async () => {
        const { paths } = await deadOwnerPreparation();
        mutate(paths);
        const state = snapshot(paths);
        await assert.rejects(retireAsStart(), (error) => {
            assert.equal(error.code, 'EDGE_PREPARATION_BUSY');
            assert.match(error.message, /cannot be retired automatically/);
            assert.match(error.message, why);
            assert.match(error.message, HOST_RECOVERY);
            return true;
        });
        state.assertUnchanged();
    });
}

test('a preparation owned by the retiring process itself is not provably abandoned', async () => {
    const paths = resetWorkspace();
    edge.prepareEdgeRoutingGeneration({ workspaceRoot: workspace, reason: START_REASON });
    const state = snapshot(paths);
    await assert.rejects(retireAsStart(), { code: 'EDGE_PREPARATION_BUSY', message: /owned by this process/ });
    state.assertUnchanged();
});

test('retirement requires the live workspace lease and network capability', async () => {
    const { paths } = await deadOwnerPreparation();
    const state = snapshot(paths);
    await assert.rejects(retireAsStart({ workspaceMutationLease: {} }), { code: 'PLOINKY_WORKSPACE_MUTATION_CAPABILITY_REQUIRED' });
    await assert.rejects(retireAsStart({ networkLifecycleCapability: {} }), { code: 'PLOINKY_NETWORK_LIFECYCLE_CAPABILITY_REQUIRED' });
    let released;
    await locks.withWorkspaceMutationLease({ operation: 'workspace-start' }, lease => { released = lease; });
    await network.withNetworkLifecycleLock(capability => assert.throws(
        () => edge.retireAbandonedWorkspaceStartPreparation({ workspaceRoot: workspace,
            workspaceMutationLease: released, networkLifecycleCapability: capability }),
        { code: 'PLOINKY_WORKSPACE_MUTATION_CAPABILITY_REQUIRED' },
    ));
    state.assertUnchanged();
});

test('restart settles a killed start preparation under its own serialized leases', async () => {
    const { paths } = await deadOwnerPreparation();
    const state = snapshot(paths);
    assert.equal((await settleWorkspaceBeforeRestart()).retired, true);
    state.assertOnlyLeaseRemoved();
    assert.equal(locks.heldWorkspaceMutationLease(), null, 'restart releases its workspace lease before starting');

    const drifted = await deadOwnerPreparation();
    edge.inactivateEdgeRoutingGeneration('workspace-start-prepare', { workspaceRoot: workspace });
    const driftedState = snapshot(drifted.paths);
    await assert.rejects(settleWorkspaceBeforeRestart(), { code: 'EDGE_PREPARATION_BUSY', message: HOST_RECOVERY });
    driftedState.assertUnchanged();
    assert.equal(locks.heldWorkspaceMutationLease(), null, 'a refused restart releases its workspace lease');
});
