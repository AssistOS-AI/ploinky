// `disable agent` while detached no-wait workers (or any other lifecycle
// owner) hold the workspace mutation lease and the network lifecycle lock.
// Lock holders are real processes; the edge generation, registry, routing,
// lease and lock files are real. Only the container engine is simulated,
// behind the real exact-removal routine and its real network lock.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(['PLOINKY_WORKSPACE_ROOT', 'PLOINKY_ROUTER_HOST_PORT', 'PLOINKY_MEDIA_HOST_PORT']
    .map((name) => [name, process.env[name]]));
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-disable-contention-')));
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

const agents = await import('../../cli/utils/agents.js');
const edge = await import('../../cli/sandbox/edgeGeneration.js');
const fleet = await import('../../cli/sandbox/docker/containerFleet.js');
const { NETWORK_LABELS } = await import('../../cli/sandbox/networkLifecycle.js');
const { NETWORK_SCHEMA_VERSION } = await import('../../cli/sandbox/networkContract.js');
const { WORKSPACE_START_LOCK_PATH } = await import('../../cli/utils/runtime/maintenanceLocks.js');

const paths = edge.resolveEdgeGenerationPaths();
const NETWORK_LOCK_PATH = path.join(paths.ploinkyDir, 'run', 'network.lock');
const CONTAINER_ID = 'a'.repeat(64);
const WORKSPACE_HASH = 'disable-contention-workspace';
const TARGET = 'ploinky_fixtures_probe';
const SURVIVOR = 'ploinky_fixtures_keeper';

test.after(() => {
    process.chdir(originalCwd);
    for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

function registryRecord(agentName, overrides = {}) {
    return {
        type: 'agent',
        repoName: 'fixtures',
        agentName,
        instanceId: `${agentName}-instance`,
        enableGeneration: `${agentName}-generation`,
        auth: { mode: 'sso' },
        config: { binds: [] },
        ...overrides,
    };
}

// A fresh workspace with one active edge generation that routes two agents.
function fixture() {
    fs.rmSync(paths.ploinkyDir, { recursive: true, force: true });
    const routes = {};
    for (const agentName of ['probe', 'keeper']) {
        const agentPath = path.join(paths.ploinkyDir, 'repos', 'fixtures', agentName);
        fs.mkdirSync(agentPath, { recursive: true });
        fs.writeFileSync(path.join(agentPath, 'manifest.json'), '{}');
        routes[agentName] = {
            repo: 'fixtures',
            agent: agentName,
            container: agentName === 'probe' ? TARGET : SURVIVOR,
            hostPath: agentPath,
            hostPort: agentName === 'probe' ? 43101 : 43102,
        };
    }
    fs.mkdirSync(path.dirname(paths.policyFile), { recursive: true });
    fs.mkdirSync(paths.edgeDir, { recursive: true });
    fs.writeFileSync(paths.agentsFile, JSON.stringify({
        [TARGET]: registryRecord('probe', { containerId: CONTAINER_ID }),
        [SURVIVOR]: registryRecord('keeper', { containerId: 'd'.repeat(64) }),
    }, null, 2));
    fs.writeFileSync(paths.routingFile, JSON.stringify({ routes }, null, 2));
    fs.writeFileSync(paths.policyFile, JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }));
    fs.writeFileSync(paths.desiredFile, JSON.stringify({ hosts: {} }));
    const active = edge.applyEdgeRoutingGeneration({ reason: 'disable-contention-fixture' });
    assert.equal(active.selector.state, 'active');
    const files = [paths.agentsFile, paths.routingFile, paths.activeSelectorFile];
    const before = files.map((file) => fs.readFileSync(file));
    return {
        generation: active.selector.generation,
        assertSourcesRestored() {
            // Selector activation IDs rotate on every apply; the sources may not.
            files.slice(0, 2).forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index], `${file} changed`));
        },
        assertUntouched() {
            files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index], `${file} changed`));
            assert.equal(fs.existsSync(paths.preparationLeaseFile), false);
        },
    };
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The target container as the engine reports it. Every control call records
// which process then owned the workspace lease and the network lock.
function fakeEngine({ workspaceHash = WORKSPACE_HASH } = {}) {
    let current = {
        Id: CONTAINER_ID,
        Name: `/${TARGET}`,
        Config: {
            Labels: {
                [NETWORK_LABELS.managed]: '1',
                [NETWORK_LABELS.resource]: 'agent',
                [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
                [NETWORK_LABELS.workspace]: workspaceHash,
                [NETWORK_LABELS.contract]: 'b'.repeat(64),
                [NETWORK_LABELS.instanceId]: 'probe-instance',
                [NETWORK_LABELS.enableGeneration]: 'probe-generation',
            },
        },
        HostConfig: { Init: true },
        Mounts: [],
        State: { Running: true },
    };
    const controls = [];
    return {
        controls,
        exists: () => current !== null,
        inspect(identifier) {
            assert.equal(identifier, CONTAINER_ID);
            return current ? structuredClone(current) : null;
        },
        control(args) {
            controls.push({
                command: args[0],
                leaseOwner: readJson(WORKSPACE_START_LOCK_PATH).ownerPid,
                networkOwner: readJson(NETWORK_LOCK_PATH).pid,
            });
            if (args[0] === 'kill') current = { ...current, State: { Running: false } };
            if (args[0] === 'rm') current = null;
            return { status: 0 };
        },
    };
}

// Real exact removal (and its real network lock) against the simulated engine,
// reporting preserved runtimes the way stopAndRemoveMany does.
function disableDependencies(engine, extra = {}) {
    return {
        stopAndRemoveImpl(name, { records, onPreserved } = {}) {
            try {
                const result = fleet.removeExactContainerAndDescriptor(name, records[name], 'podman', {
                    fast: true,
                    inspect: (_runtime, identifier) => engine.inspect(identifier),
                    control: (_runtime, args) => engine.control(args),
                    pause() {},
                    retireRelay() {},
                    workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
                });
                return result.removed ? [name] : [];
            } catch (error) {
                console.log(`[destroy] Preserved ${name}: ${error?.message || error}`);
                onPreserved?.({ name, error, runtimeTouched: error?.runtimeUntouched !== true });
                return [];
            }
        },
        containerExistsImpl: (name) => name === TARGET && engine.exists(),
        ...extra,
    };
}

// A separate process that holds the locks exactly as a no-wait worker does:
// the workspace mutation lease, then the network lifecycle lock inside it.
async function lockHolder(t, { lease = false, network = false }) {
    const locksUrl = new URL('../../cli/utils/runtime/maintenanceLocks.js', import.meta.url).href;
    const networkUrl = new URL('../../cli/sandbox/networkLifecycle.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const locks = await import(${JSON.stringify(locksUrl)});
        const network = await import(${JSON.stringify(networkUrl)});
        const lease = ${lease}
            ? await locks.acquireWorkspaceMutationLease({ operation: 'no-wait-runtime:${SURVIVOR}', waitTimeoutMs: 0 })
            : null;
        const lock = ${network} ? network.acquireNetworkLifecycleLock() : null;
        process.stdout.write('locked\\n');
        process.stdin.once('data', () => {
            lock?.release();
            if (lease && !locks.releaseWorkspaceMutationLease(lease)) process.exitCode = 3;
            process.stdin.destroy();
        });
    `], { cwd: workspace, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
    const closed = once(child, 'close');
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
    });
    await once(child.stdout, 'data');
    if (lease) assert.equal(readJson(WORKSPACE_START_LOCK_PATH).ownerPid, child.pid);
    if (network) assert.equal(readJson(NETWORK_LOCK_PATH).pid, child.pid);
    return {
        pid: child.pid,
        async release() {
            child.stdin.end('release');
            assert.deepEqual(await closed, [0, null]);
        },
    };
}

function settledState(promise) {
    const state = { settled: false };
    promise.then(() => { state.settled = true; }, () => { state.settled = true; });
    return state;
}

function assertLocksReleased() {
    assert.equal(fs.existsSync(WORKSPACE_START_LOCK_PATH), false, 'workspace mutation lease leaked');
    assert.equal(fs.existsSync(NETWORK_LOCK_PATH), false, 'network lifecycle lock leaked');
}

test('disable waits for a no-wait lock holder, then removes the runtime under its own locks', { timeout: 30_000 }, async (t) => {
    const f = fixture();
    const engine = fakeEngine();
    const holder = await lockHolder(t, { lease: true, network: true });

    const pending = (async () => agents.disableAgent('fixtures/probe', disableDependencies(engine)))();
    const state = settledState(pending);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(state.settled, false, 'disable must wait instead of refusing or mutating under a live holder');
    f.assertUntouched();
    assert.deepEqual(engine.controls, []);

    await holder.release();
    const result = await pending;
    assert.equal(result.status, 'removed');
    assert.equal(result.containerName, TARGET);
    assert.deepEqual(engine.controls.map((entry) => entry.command), ['kill', 'rm']);
    for (const entry of engine.controls) {
        assert.equal(entry.leaseOwner, process.pid, 'runtime removal must run under this process lease');
        assert.equal(entry.networkOwner, process.pid, 'runtime removal must run under this process network lock');
    }
    const registry = readJson(paths.agentsFile);
    assert.equal(registry[TARGET], undefined);
    assert.ok(registry[SURVIVOR]);
    assert.equal(readJson(paths.routingFile).routes.probe, undefined);
    const active = edge.loadActiveEdgeRoutingGeneration();
    assert.notEqual(active.selector.generation, f.generation);
    assert.equal(active.generation.routing.routes.probe, undefined);
    assert.ok(active.generation.routing.routes.keeper);
    assert.equal(fs.existsSync(paths.preparationLeaseFile), false);
    assertLocksReleased();
});

test('a network lock held past the bounded wait refuses before any registry, routing, or selector mutation', { timeout: 30_000 }, async (t) => {
    const f = fixture();
    const engine = fakeEngine();
    const holder = await lockHolder(t, { network: true });

    await assert.rejects(
        (async () => agents.disableAgent('fixtures/probe', disableDependencies(engine, { networkLockWaitMs: 300 })))(),
        (error) => error.code === 'PLOINKY_NETWORK_LIFECYCLE_BUSY'
            && error.message.includes(`already owned by pid ${holder.pid}`),
    );
    f.assertUntouched();
    assert.deepEqual(engine.controls, []);
    assert.equal(fs.existsSync(WORKSPACE_START_LOCK_PATH), false);
    assert.equal(readJson(NETWORK_LOCK_PATH).pid, holder.pid, 'the live holder keeps its lock');
    assert.equal(edge.loadActiveEdgeRoutingGeneration().selector.generation, f.generation);
    await holder.release();
    assertLocksReleased();
});

test('a workspace lease held past the bounded wait refuses before any mutation', { timeout: 30_000 }, async (t) => {
    const f = fixture();
    const engine = fakeEngine();
    const holder = await lockHolder(t, { lease: true });

    await assert.rejects(
        (async () => agents.disableAgent('fixtures/probe', disableDependencies(engine, { workspaceLeaseWaitMs: 300 })))(),
        { code: 'workspace_mutation_lock_timeout' },
    );
    f.assertUntouched();
    assert.deepEqual(engine.controls, []);
    assert.equal(fs.existsSync(NETWORK_LOCK_PATH), false);
    assert.equal(readJson(WORKSPACE_START_LOCK_PATH).ownerPid, holder.pid, 'the live holder keeps its lease');
    await holder.release();
    assertLocksReleased();
});

test('a removal refused before the runtime was touched restores the exact registration and the prior active generation', { timeout: 30_000 }, async () => {
    const f = fixture();
    const engine = fakeEngine({ workspaceHash: 'another-workspace' });

    await assert.rejects(
        (async () => agents.disableAgent('fixtures/probe', disableDependencies(engine)))(),
        (error) => error.code === 'PLOINKY_AGENT_DISABLE_REFUSED'
            && error.message.includes('registration and routing were restored'),
    );
    assert.deepEqual(engine.controls, []);
    f.assertSourcesRestored();
    const active = edge.loadActiveEdgeRoutingGeneration();
    assert.equal(active.selector.state, 'active');
    assert.equal(active.selector.generation, f.generation, 'the exact prior generation is active again');
    assert.ok(readJson(paths.agentsFile)[TARGET], 'the running container keeps its registration');
    assert.ok(readJson(paths.routingFile).routes.probe);
    assert.equal(fs.existsSync(paths.preparationLeaseFile), false);
    assertLocksReleased();
});

test('exact removal marks only refusals raised before its first signal as untouched', { timeout: 30_000 }, async (t) => {
    fixture();
    const record = registryRecord('probe', { containerId: CONTAINER_ID });
    const holder = await lockHolder(t, { network: true });
    const engine = fakeEngine();
    const options = {
        fast: true,
        inspect: (_runtime, identifier) => engine.inspect(identifier),
        control: (_runtime, args) => engine.control(args),
        pause() {},
        retireRelay() {},
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
    };
    assert.throws(
        () => fleet.removeExactContainerAndDescriptor(TARGET, record, 'podman', options),
        (error) => /network lifecycle is busy/.test(error.message) && error.runtimeUntouched === true,
    );
    await holder.release();

    assert.throws(
        () => fleet.removeExactContainerAndDescriptor(TARGET, { ...record, containerId: '' }, 'podman', options),
        (error) => /immutable registry container ID/.test(error.message) && error.runtimeUntouched === true,
    );
    assert.deepEqual(engine.controls, []);

    assert.throws(
        () => fleet.removeExactContainerAndDescriptor(TARGET, record, 'podman', {
            ...options,
            control: () => ({ status: 1 }),
        }),
        (error) => /could not send SIGTERM/.test(error.message) && error.runtimeUntouched === undefined,
    );

    const preserved = [];
    fleet.stopAndRemoveMany(['ploinky_unregistered_runtime'], { onPreserved: (entry) => preserved.push(entry) });
    assert.deepEqual(preserved.map(({ name, runtimeTouched }) => ({ name, runtimeTouched })), [
        { name: 'ploinky_unregistered_runtime', runtimeTouched: false },
    ]);
    assertLocksReleased();
});
