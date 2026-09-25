// An update rollback stops the workspace after its restart was killed inside
// startWorkspace. The stop's selector rewrite used to replace the only selector
// that bound the killed start's graph preparation, so the rollback start
// refused to retire it. The owner here is a real process holding the workspace
// start lease, the network lifecycle lock and the preparation, killed without
// running its own abort path, exactly like the update runner's escalation.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-stop-retires-preparation-')));
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';
// The one-shot CLI selects this workspace's local AgentLib checkout.
writeAgentLibCheckout(path.join(workspace, 'achillesAgentLib'));

const moduleUrl = (relative) => new URL(`../../cli/${relative}`, import.meta.url).href;
const edge = await import(moduleUrl('sandbox/edgeGeneration.js'));
const locks = await import(moduleUrl('utils/runtime/maintenanceLocks.js'));
const network = await import(moduleUrl('sandbox/networkLifecycle.js'));
const { retireAbandonedStartPreparationBeforeStop } = await import(moduleUrl('commands/workspaceUtil.js'));

const CLI_ENTRY = path.resolve(import.meta.dirname, '../../cli/index.js');
const START_REASON = 'workspace-graph-enable-prelaunch';
const paths = edge.resolveEdgeGenerationPaths({ workspaceRoot: workspace });
const networkLockPath = path.join(paths.ploinkyDir, 'run', 'network.lock');
const children = new Set();

test.afterEach(async () => {
    for (const child of children) await stopChild(child);
});

test.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
});

// The owner takes what a workspace start holds when it prepares its graph.
const OWNER_SOURCE = `
const [edgeUrl, locksUrl, networkUrl, holds] = process.argv.slice(1);
const edge = await import(edgeUrl);
const locks = await import(locksUrl);
const network = await import(networkUrl);
if (holds.includes('lease')) await locks.acquireWorkspaceMutationLease({ operation: 'workspace-start', waitTimeoutMs: 0 });
if (holds.includes('network')) network.acquireNetworkLifecycleLock();
if (holds.includes('prepare')) {
    edge.prepareEdgeRoutingGeneration({ workspaceRoot: process.env.PLOINKY_WORKSPACE_ROOT, reason: '${START_REASON}' });
}
process.stdout.write('ready\\n');
setInterval(() => {}, 60000);
`;

async function startChild(holds) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', OWNER_SOURCE,
        moduleUrl('sandbox/edgeGeneration.js'), moduleUrl('utils/runtime/maintenanceLocks.js'),
        moduleUrl('sandbox/networkLifecycle.js'), holds], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (stdout.includes('ready\n')) resolve();
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`owner exited early (${code}): ${stderr}`)));
    });
    return child;
}

async function stopChild(child) {
    if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
    }
    children.delete(child);
}

// The whole workspace a one-shot CLI `stop` reads, with no agent to stop.
function resetWorkspace() {
    fs.rmSync(paths.ploinkyDir, { recursive: true, force: true });
    for (const repoName of ['AchillesIDE', 'AchillesCLI', 'copilot-agents']) {
        fs.mkdirSync(path.join(paths.ploinkyDir, 'repos', repoName), { recursive: true });
    }
    fs.mkdirSync(path.dirname(paths.policyFile), { recursive: true });
    fs.mkdirSync(paths.edgeDir, { recursive: true });
    fs.writeFileSync(paths.agentsFile, '{}');
    fs.writeFileSync(paths.routingFile, JSON.stringify({ routes: {} }));
    fs.writeFileSync(paths.policyFile, JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }));
    fs.writeFileSync(paths.desiredFile, JSON.stringify({ hosts: {} }));
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function snapshot() {
    const files = [paths.preparationLeaseFile, paths.activeSelectorFile, paths.agentsFile,
        paths.routingFile, paths.desiredFile, paths.policyFile];
    const before = files.map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
    return {
        assertUnchanged() {
            files.forEach((file, index) => assert.deepEqual(
                fs.existsSync(file) ? fs.readFileSync(file) : null, before[index], `${path.basename(file)} changed`,
            ));
        },
        assertOnlyLeaseRemoved() {
            assert.equal(fs.existsSync(paths.preparationLeaseFile), false, 'the abandoned preparation is retired');
            files.slice(1).forEach((file, index) => assert.deepEqual(
                fs.readFileSync(file), before[index + 1], `${path.basename(file)} changed`,
            ));
        },
    };
}

// Retire exactly as the next (rollback) start does, under its serialized leases.
function retireAsStart() {
    return locks.withWorkspaceMutationLease(
        { operation: 'workspace-start', waitTimeoutMs: 0 },
        (workspaceMutationLease) => network.withNetworkLifecycleLock((networkLifecycleCapability) => (
            edge.retireAbandonedWorkspaceStartPreparation({ workspaceRoot: workspace,
                workspaceMutationLease, networkLifecycleCapability })
        )),
    );
}

function assertApplyDenied() {
    assert.throws(
        () => edge.withEdgeGenerationApplyLock(() => {}, { workspaceRoot: workspace }),
        { code: 'EDGE_PREPARATION_BUSY', message: /unrelated apply is denied/ },
    );
}

// The incident: the restart dies holding its lease, network lock and prepared graph.
async function killedStart() {
    resetWorkspace();
    const owner = await startChild('lease,network,prepare');
    await stopChild(owner);
    assert.equal(readJson(paths.preparationLeaseFile).pid, owner.pid);
    assert.equal(readJson(locks.WORKSPACE_START_LOCK_PATH).ownerPid, owner.pid);
    assert.equal(readJson(networkLockPath).pid, owner.pid);
    return owner;
}

function runStopHelper() {
    const logs = [];
    const startedAt = Date.now();
    const result = retireAbandonedStartPreparationBeforeStop({ log: (line) => logs.push(line) });
    return { result, logs, elapsedMs: Date.now() - startedAt };
}

test('stop retires a killed start\'s preparation through its stale network lock, and the rollback start proceeds', async () => {
    const owner = await killedStart();
    const state = snapshot();
    assertApplyDenied();
    const lockAgeMs = Date.now() - Date.parse(readJson(networkLockPath).createdAt);
    assert.ok(lockAgeMs < network.NETWORK_LOCK_STALE_GRACE_MS,
        'the dead owner\'s network lock is still inside its stale-owner grace, as in the incident');
    assert.equal(network.networkLifecycleLockOwnerStopped({ lockPath: networkLockPath }), true);

    const { result, logs } = runStopHelper();
    assert.equal(result.retired, true, logs.join('\n'));
    assert.equal(result.pid, owner.pid);
    assert.deepEqual(logs, [`[stop] Retired the routing preparation of stopped workspace start pid ${owner.pid}.`]);
    state.assertOnlyLeaseRemoved();
    assert.equal(fs.existsSync(locks.WORKSPACE_START_LOCK_PATH), false, 'stop released the lease it took');
    assert.equal(fs.existsSync(networkLockPath), false, 'stop released the network lock it reclaimed');

    // The stop then rewrites the selector; the rollback start has nothing to
    // retire and its applies are no longer denied.
    edge.inactivateEdgeRoutingGeneration('cli-workspace-stop', { workspaceRoot: workspace });
    assert.deepEqual(await retireAsStart(), { retired: false });
    edge.withEdgeGenerationApplyLock(() => {}, { workspaceRoot: workspace });
});

test('a live preparation owner is left in place and stop neither waits for nor refuses on it', async () => {
    resetWorkspace();
    const owner = await startChild('lease,network,prepare');
    const state = snapshot();
    const { result, logs, elapsedMs } = runStopHelper();
    assert.deepEqual(result, { retired: false });
    assert.ok(elapsedMs < 1_000, `stop must not wait for a live owner (${elapsedMs}ms)`);
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(`^\\[stop\\] Left the routing preparation of pid ${owner.pid} \\(${START_REASON}\\) in place: `));
    state.assertUnchanged();
    assert.equal(readJson(locks.WORKSPACE_START_LOCK_PATH).ownerPid, owner.pid, 'the live owner keeps its lease');
    assert.equal(locks.heldWorkspaceMutationLease(), null);
});

test('a live network lock holder is never waited for, even when the preparation owner is dead', async () => {
    resetWorkspace();
    const deadOwner = await startChild('prepare');
    await stopChild(deadOwner);
    const holder = await startChild('network');
    const state = snapshot();
    const { result, logs, elapsedMs } = runStopHelper();
    assert.deepEqual(result, { retired: false });
    assert.ok(elapsedMs < 1_000, `only a dead lock owner's grace is waited out (${elapsedMs}ms)`);
    assert.match(logs[0], /in place: network lifecycle is busy/);
    state.assertUnchanged();
    assert.equal(fs.existsSync(locks.WORKSPACE_START_LOCK_PATH), false, 'the refused attempt releases its lease');
    await stopChild(holder);
});

test('a dead owner\'s preparation that fails any proof is left in place without refusing the stop', async () => {
    resetWorkspace();
    const deadOwner = await startChild('prepare');
    await stopChild(deadOwner);
    fs.writeFileSync(paths.preparationLeaseFile, JSON.stringify({
        ...readJson(paths.preparationLeaseFile), lifecycleBindingDigest: `sha256:${'b'.repeat(64)}`,
    }));
    const state = snapshot();
    const { result, logs } = runStopHelper();
    assert.deepEqual(result, { retired: false });
    assert.match(logs[0], /in place: .*captured generation no longer matches its lifecycle binding/);
    state.assertUnchanged();
    assertApplyDenied();
});

test('without an outstanding preparation stop takes no lease and logs nothing', () => {
    resetWorkspace();
    const { result, logs } = runStopHelper();
    assert.deepEqual(result, { retired: false });
    assert.deepEqual(logs, []);
    assert.equal(fs.existsSync(locks.WORKSPACE_START_LOCK_PATH), false);
});

function runPloinkyStop() {
    return spawnSync(process.execPath, [CLI_ENTRY, 'stop'], {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace, PLOINKY_MASTER_KEY: '5'.repeat(64) },
        timeout: 60_000,
    });
}

test('`ploinky stop` retires a killed start\'s preparation before its selector rewrite and a live one never refuses it', async () => {
    const owner = await killedStart();
    const stopped = runPloinkyStop();
    const output = `${stopped.stdout}\n${stopped.stderr}`;
    assert.equal(stopped.status, 0, output);
    assert.ok(output.indexOf(`[stop] Retired the routing preparation of stopped workspace start pid ${owner.pid}.`)
        < output.indexOf('[stop] Stopping RoutingServer...'), output);
    assert.match(output, /Stopped 0 configured agent containers\./);
    assert.equal(fs.existsSync(paths.preparationLeaseFile), false);
    assert.equal(readJson(paths.activeSelectorFile).reason, 'cli-workspace-stop');
    assert.deepEqual(await retireAsStart(), { retired: false }, 'the rollback start is no longer refused');

    resetWorkspace();
    const live = await startChild('lease,network,prepare');
    const refusedRetirement = runPloinkyStop();
    const liveOutput = `${refusedRetirement.stdout}\n${refusedRetirement.stderr}`;
    assert.equal(refusedRetirement.status, 0, liveOutput);
    assert.match(liveOutput, new RegExp(`\\[stop\\] Left the routing preparation of pid ${live.pid} \\(${START_REASON}\\) in place`));
    assert.match(liveOutput, /Stopped 0 configured agent containers\./);
    assert.equal(readJson(paths.preparationLeaseFile).pid, live.pid);
    assert.equal(readJson(paths.activeSelectorFile).reason, 'cli-workspace-stop', 'the stop itself still completed');
});

test('`ploinky stop` completes when the preparation lease cannot even be read', () => {
    resetWorkspace();
    fs.writeFileSync(paths.preparationLeaseFile, 'not a preparation lease', { mode: 0o600 });
    const stopped = runPloinkyStop();
    const output = `${stopped.stdout}\n${stopped.stderr}`;
    assert.equal(stopped.status, 0, output);
    assert.match(output, /\[stop\] Could not inspect the routing preparation lease: /);
    assert.match(output, /Stopped 0 configured agent containers\./);
    assert.equal(fs.readFileSync(paths.preparationLeaseFile, 'utf8'), 'not a preparation lease', 'stop never repairs what it cannot prove');
    assert.equal(readJson(paths.activeSelectorFile).reason, 'cli-workspace-stop');
    assert.equal(fs.existsSync(locks.WORKSPACE_START_LOCK_PATH), false);
});
