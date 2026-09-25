// One process, several lifecycle operations: the Router hosts the Cloudflare
// publication runtime and serves `disable_agent` side by side. A workspace
// mutation lease belongs to the operation that acquired it, not to its PID, so
// only work nested inside that operation may reuse it. The publication runtime,
// lease helpers, edge generation, registry and routing files are real; only
// the Cloudflare controller and the container engine are simulated.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(['PLOINKY_WORKSPACE_ROOT', 'PLOINKY_ROUTER_HOST_PORT', 'PLOINKY_MEDIA_HOST_PORT']
    .map((name) => [name, process.env[name]]));
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-lease-ownership-')));
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

const agents = await import('../../cli/utils/agents.js');
const edge = await import('../../cli/sandbox/edgeGeneration.js');
const fleet = await import('../../cli/sandbox/docker/containerFleet.js');
const { NETWORK_LABELS } = await import('../../cli/sandbox/networkLifecycle.js');
const { NETWORK_SCHEMA_VERSION } = await import('../../cli/sandbox/networkContract.js');
const locks = await import('../../cli/utils/runtime/maintenanceLocks.js');
const { resolveDependencyLease } = await import('../../cli/utils/dependencies/store/runtimeDependencies.mjs');
const { startCloudflarePublicationRuntime } = await import('../../ploinky-box/cloudflared/runtime.mjs');

const { WORKSPACE_START_LOCK_PATH } = locks;
const LOCKS_URL = new URL('../../cli/utils/runtime/maintenanceLocks.js', import.meta.url).href;
const paths = edge.resolveEdgeGenerationPaths();
const NETWORK_LOCK_PATH = path.join(paths.ploinkyDir, 'run', 'network.lock');
const CONTAINER_ID = 'a'.repeat(64);
const WORKSPACE_HASH = 'lease-ownership-workspace';
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
    const active = edge.applyEdgeRoutingGeneration({ reason: 'lease-ownership-fixture' });
    assert.equal(active.selector.state, 'active');
    const files = [paths.agentsFile, paths.routingFile, paths.activeSelectorFile];
    const before = files.map((file) => fs.readFileSync(file));
    return {
        generation: active.selector.generation,
        assertUntouched() {
            files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index], `${file} changed`));
            assert.equal(fs.existsSync(paths.preparationLeaseFile), false);
        },
    };
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readLease() {
    return fs.existsSync(WORKSPACE_START_LOCK_PATH) ? readJson(WORKSPACE_START_LOCK_PATH) : null;
}

// Another process tries to take the workspace lease right now.
function secondProcessLeaseAttempt() {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const locks = await import(${JSON.stringify(LOCKS_URL)});
        try {
            const lease = locks.createWorkspaceMutationLease({ operation: 'second-process' });
            locks.releaseWorkspaceMutationLease(lease);
            process.stdout.write('ACQUIRED');
        } catch (error) {
            process.stdout.write(String(error?.code));
        }
    `], { cwd: workspace, env: process.env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
}

// The target container as the engine reports it. Each control call records
// the workspace lease on disk at that moment and what another process gets.
function fakeEngine() {
    let current = {
        Id: CONTAINER_ID,
        Name: `/${TARGET}`,
        Config: {
            Labels: {
                [NETWORK_LABELS.managed]: '1',
                [NETWORK_LABELS.resource]: 'agent',
                [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
                [NETWORK_LABELS.workspace]: WORKSPACE_HASH,
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
                lease: readLease(),
                networkOwner: readJson(NETWORK_LOCK_PATH).pid,
                secondProcess: secondProcessLeaseAttempt(),
            });
            if (args[0] === 'kill') current = { ...current, State: { Running: false } };
            if (args[0] === 'rm') current = null;
            return { status: 0 };
        },
    };
}

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
                onPreserved?.({ name, error, runtimeTouched: error?.runtimeUntouched !== true });
                return [];
            }
        },
        containerExistsImpl: (name) => name === TARGET && engine.exists(),
        ...extra,
    };
}

// The real publication runtime reconciling the active generation. Its lease
// helpers are the production defaults; only the Cloudflare controller is a
// stub whose reconcile stays in flight until the test finishes it.
async function publicationInFlight(t) {
    let finish;
    const reconciling = new Promise((resolve) => { finish = resolve; });
    let started;
    const reconcileStarted = new Promise((resolve) => { started = resolve; });
    const audits = [];
    const runtime = startCloudflarePublicationRuntime({
        workspaceRoot: workspace,
        statusFile: path.join(workspace, 'publication-status.json'),
        restartHandoffFile: path.join(workspace, 'publication-handoff.json'),
        routerSupervisorId: 'lease-ownership-supervisor',
        pollIntervalMs: 60_000,
        routeCoordinatorFactory: () => ({ inactivate() {}, commit() {} }),
        controllerFactory: () => ({
            reconcile: () => { started(); return reconciling; },
            getStatus: () => ({ state: 'fixture' }),
            stop: async () => {},
        }),
        probeHostname: async () => ({ ok: true }),
        audit: (event, value) => audits.push({ event, value }),
    });
    t.after(async () => { finish(); await runtime.stop(); });
    await reconcileStarted;
    const lease = readLease();
    assert.match(lease?.operation || '', /^cloudflare-publication:/);
    assert.equal(lease.ownerPid, process.pid);
    return {
        lease,
        audits,
        async finish() {
            finish();
            for (let i = 0; i < 100 && readLease()?.token === lease.token; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.notEqual(readLease()?.token, lease.token, 'publication released its own lease');
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

test('a Router disable does not reuse a concurrent publication lease; past the bounded wait it refuses unchanged', { timeout: 30_000 }, async (t) => {
    const f = fixture();
    const engine = fakeEngine();
    const publication = await publicationInFlight(t);

    await assert.rejects(
        (async () => agents.disableAgent('fixtures/probe', disableDependencies(engine, { workspaceLeaseWaitMs: 300 })))(),
        (error) => error.code === 'workspace_mutation_lock_timeout' && /cloudflare-publication:/.test(error.message),
    );
    f.assertUntouched();
    assert.deepEqual(engine.controls, [], 'no runtime was signalled');
    assert.equal(fs.existsSync(NETWORK_LOCK_PATH), false);
    assert.equal(edge.loadActiveEdgeRoutingGeneration().selector.generation, f.generation);
    assert.deepEqual(readLease(), publication.lease, 'the publication keeps its exact lease');

    await publication.finish();
    assert.deepEqual(publication.audits.filter(({ event }) => /release/.test(event)), []);
    assertLocksReleased();
});

test('a Router disable waits for the publication, then mutates under its own lease that nobody else can take or remove', { timeout: 30_000 }, async (t) => {
    const f = fixture();
    const engine = fakeEngine();
    const publication = await publicationInFlight(t);

    const pending = (async () => agents.disableAgent('fixtures/probe', disableDependencies(engine, { workspaceLeaseWaitMs: 10_000 })))();
    const state = settledState(pending);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(state.settled, false, 'disable must wait for the publication operation');
    f.assertUntouched();
    assert.deepEqual(engine.controls, []);

    await publication.finish();
    const result = await pending;
    assert.equal(result.status, 'removed');
    assert.deepEqual(engine.controls.map((entry) => entry.command), ['kill', 'rm']);
    for (const entry of engine.controls) {
        assert.equal(entry.lease?.operation, 'agent-disable', 'runtime removal runs under the disable lease');
        assert.equal(entry.lease.ownerPid, process.pid);
        assert.notEqual(entry.lease.token, publication.lease.token);
        assert.equal(entry.networkOwner, process.pid);
        assert.equal(entry.secondProcess, 'PLOINKY_WORKSPACE_MUTATION_BUSY', 'another process stays excluded');
    }
    const registry = readJson(paths.agentsFile);
    assert.equal(registry[TARGET], undefined);
    assert.ok(registry[SURVIVOR]);
    assert.equal(readJson(paths.routingFile).routes.probe, undefined);
    const active = edge.loadActiveEdgeRoutingGeneration();
    assert.notEqual(active.selector.generation, f.generation);
    assert.equal(active.generation.routing.routes.probe, undefined);
    assert.ok(active.generation.routing.routes.keeper);
    assert.deepEqual(publication.audits.filter(({ event }) => /release/.test(event)), []);
    assertLocksReleased();
});

test('work nested in the owning operation reuses its exact lease; a concurrent operation in the same process does not', { timeout: 30_000 }, async () => {
    fixture();
    let releaseOwner;
    const ownerHolding = new Promise((resolve) => { releaseOwner = resolve; });
    let ownerReady;
    const ready = new Promise((resolve) => { ownerReady = resolve; });
    const nested = {};

    // A watchdog-style owner: acquired without a callback, then bound.
    const owner = locks.createWorkspaceMutationLease({ operation: 'watchdog-restart:owner' });
    const ownerRun = locks.runWithWorkspaceMutationLease(owner, async () => {
        await Promise.resolve();
        nested.held = locks.heldWorkspaceMutationLease();
        await locks.withHeldOrAcquiredWorkspaceMutationLease({ operation: 'agent-enable', waitTimeoutMs: 0 }, async (inner) => {
            nested.inner = inner;
            const dependency = resolveDependencyLease();
            nested.dependency = dependency.lease;
            dependency.release();
        });
        nested.afterNested = readLease();
        ownerReady();
        await ownerHolding;
    });
    await ready;
    assert.equal(nested.held, owner);
    assert.equal(nested.inner, owner);
    assert.equal(nested.dependency, owner);
    assert.equal(nested.afterNested?.token, owner.token, 'nested reuse leaves the owner lease in place');

    // Started beside the owner, not inside it.
    assert.equal(locks.heldWorkspaceMutationLease(), null);
    await assert.rejects(
        locks.withHeldOrAcquiredWorkspaceMutationLease({ operation: 'agent-disable', waitTimeoutMs: 200, retryIntervalMs: 20 }, async () => {
            assert.fail('a concurrent operation must not run under another operation lease');
        }),
        { code: 'workspace_mutation_lock_timeout' },
    );
    assert.throws(() => resolveDependencyLease(), { code: 'PLOINKY_DEPS_WORKSPACE_LEASE_BUSY' });
    assert.equal(readLease()?.token, owner.token);

    releaseOwner();
    await ownerRun;
    assert.equal(locks.releaseWorkspaceMutationLease(owner), true);
    assertLocksReleased();
});

test('a disable nested in its owning operation reuses that lease and leaves it held for the owner', { timeout: 30_000 }, async () => {
    const f = fixture();
    const engine = fakeEngine();
    let ownerToken;
    const result = await locks.withWorkspaceMutationLease({ operation: 'repositories-remove' }, async (lease) => {
        ownerToken = lease.token;
        const disabled = await agents.disableAgent('fixtures/probe', disableDependencies(engine, { workspaceLeaseWaitMs: 0 }));
        assert.equal(readLease()?.token, lease.token, 'the owner still holds its lease after the nested disable');
        return disabled;
    });
    assert.equal(result.status, 'removed');
    assert.deepEqual(engine.controls.map((entry) => entry.command), ['kill', 'rm']);
    for (const entry of engine.controls) {
        assert.equal(entry.lease?.token, ownerToken, 'the nested disable runs under the owner lease');
        assert.equal(entry.secondProcess, 'PLOINKY_WORKSPACE_MUTATION_BUSY');
    }
    assert.equal(readJson(paths.agentsFile)[TARGET], undefined);
    assert.notEqual(edge.loadActiveEdgeRoutingGeneration().selector.generation, f.generation);
    assertLocksReleased();
});
