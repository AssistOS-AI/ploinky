// A Router `uninstall_repo` is one workspace mutation: target resolution,
// agent selection, the nested disable and the source removal all run under a
// single `repositories-uninstall` lease. The Marketplace handler, lease
// helpers, repository files, edge generation, registry and routing are real;
// only the container engine is simulated. Concurrent owners hold the lease
// from their own async chain, so the request can never nest inside them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(['PLOINKY_WORKSPACE_ROOT', 'PLOINKY_ROUTER_HOST_PORT', 'PLOINKY_MEDIA_HOST_PORT', 'PLOINKY_MASTER_KEY']
    .map((name) => [name, process.env[name]]));
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-repo-uninstall-lease-')));
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);

const routes = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const edge = await import('../../cli/sandbox/edgeGeneration.js');
const locks = await import('../../cli/utils/runtime/maintenanceLocks.js');
const { mintSessionJwt, getSession } = await import('../../cli/server/auth/localService.js');
const { mintAdminCsrfToken } = await import('../../cli/server/adminControlSecurity.js');

const { WORKSPACE_START_LOCK_PATH } = locks;
const paths = edge.resolveEdgeGenerationPaths();
const NETWORK_LOCK_PATH = path.join(paths.ploinkyDir, 'run', 'network.lock');
const REPOS_DIR = path.join(paths.ploinkyDir, 'repos');
const REPO_DIR = path.join(REPOS_DIR, 'fixtures');
const ENABLED_REPOS_FILE = path.join(paths.ploinkyDir, 'enabled_repos.json');
const REPO_SOURCES_FILE = path.join(paths.ploinkyDir, 'repo_sources.json');
const TARGET = 'ploinky_fixtures_probe';
const LATE = 'ploinky_fixtures_late';
const SURVIVOR = 'ploinky_others_keeper';
const admin = { sessionId: mintSessionJwt({ id: 'local:admin', roles: ['admin'] }, 1, { channel: 'cli' }) };

test.after(() => {
    process.chdir(originalCwd);
    for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readLease() {
    return fs.existsSync(WORKSPACE_START_LOCK_PATH) ? readJson(WORKSPACE_START_LOCK_PATH) : null;
}

function registryRecord(repoName, agentName) {
    return {
        type: 'agent',
        repoName,
        agentName,
        instanceId: `${agentName}-instance`,
        enableGeneration: `${agentName}-generation`,
        auth: { mode: 'sso' },
        config: { binds: [] },
    };
}

// A managed `fixtures` checkout (optionally with an enabled agent) beside an
// `others` repository whose agent must survive, under one active generation.
function fixture({ withAgent = true } = {}) {
    fs.rmSync(paths.ploinkyDir, { recursive: true, force: true });
    const registry = { [SURVIVOR]: registryRecord('others', 'keeper') };
    const routing = { routes: {} };
    for (const [repoName, agentName, container, hostPort] of [
        ['fixtures', 'probe', TARGET, 43101],
        ['fixtures', 'late', LATE, 43103],
        ['others', 'keeper', SURVIVOR, 43102],
    ]) {
        const agentPath = path.join(REPOS_DIR, repoName, agentName);
        fs.mkdirSync(agentPath, { recursive: true });
        fs.writeFileSync(path.join(agentPath, 'manifest.json'), '{}');
        if (container === LATE || (container === TARGET && !withAgent)) continue;
        if (container === TARGET) registry[TARGET] = registryRecord('fixtures', 'probe');
        routing.routes[agentName] = { repo: repoName, agent: agentName, container, hostPath: agentPath, hostPort };
    }
    fs.writeFileSync(ENABLED_REPOS_FILE, JSON.stringify(['fixtures', 'others'], null, 2));
    fs.writeFileSync(REPO_SOURCES_FILE, JSON.stringify({
        fixtures: { url: 'https://example.test/fixtures.git' },
        others: { url: 'https://example.test/others.git' },
    }, null, 2));
    fs.mkdirSync(path.dirname(paths.policyFile), { recursive: true });
    fs.mkdirSync(paths.edgeDir, { recursive: true });
    fs.writeFileSync(paths.agentsFile, JSON.stringify(registry, null, 2));
    fs.writeFileSync(paths.routingFile, JSON.stringify(routing, null, 2));
    fs.writeFileSync(paths.policyFile, JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }));
    fs.writeFileSync(paths.desiredFile, JSON.stringify({ hosts: {} }));
    const active = edge.applyEdgeRoutingGeneration({ reason: 'repo-uninstall-lease-fixture' });
    assert.equal(active.selector.state, 'active');
    const files = [paths.agentsFile, paths.routingFile, paths.activeSelectorFile, ENABLED_REPOS_FILE, REPO_SOURCES_FILE];
    const before = files.map((file) => fs.readFileSync(file));
    return {
        generation: active.selector.generation,
        assertUntouched() {
            files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index], `${file} changed`));
            assert.ok(fs.existsSync(path.join(REPO_DIR, 'probe', 'manifest.json')), 'repository source preserved');
            assert.equal(fs.existsSync(paths.preparationLeaseFile), false);
        },
    };
}

// The container engine: each removal records the lease on disk, the network
// lock owner and whether the repository source is still present.
function fakeEngine() {
    const calls = [];
    const capture = (names) => {
        calls.push({
            names: [...names].sort(),
            lease: readLease(),
            networkOwner: readJson(NETWORK_LOCK_PATH).pid,
            repoPresent: fs.existsSync(REPO_DIR),
        });
        return [...names];
    };
    return {
        calls,
        dependencies: {
            stopAndRemoveImpl: (name) => capture([name]),
            stopAndRemoveManyImpl: (names) => capture(names),
            containerExistsImpl: () => false,
            isSandboxRuntimeImpl: () => false,
        },
    };
}

// Records the lease on disk when the repository checkout is removed.
function watchRepoRemoval(t) {
    const removals = [];
    const original = fs.rmSync;
    fs.rmSync = function rmSync(target, ...rest) {
        if (path.resolve(String(target)) === REPO_DIR) removals.push({ lease: readLease() });
        return original.call(this, target, ...rest);
    };
    t.after(() => { fs.rmSync = original; });
    return removals;
}

// Another operation of the same process that owns the lease in its own async
// chain, not in the request's.
function concurrentOwner(operation) {
    const lease = locks.createWorkspaceMutationLease({ operation });
    let finish;
    const holding = new Promise((resolve) => { finish = resolve; });
    const run = locks.runWithWorkspaceMutationLease(lease, async () => {
        const work = await holding;
        await work();
        assert.equal(locks.releaseWorkspaceMutationLease(lease), true);
    });
    return {
        lease,
        async release(work = () => {}) {
            finish(work);
            await run;
        },
    };
}

async function uninstallRequest({ target = 'fixtures', uninstallRepositoryAction } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify({ action: 'uninstall_repo', target }))]);
    req.method = 'POST';
    req.headers = { host: 'localhost', origin: 'http://localhost', cookie: `ploinky_jwt=${admin.sessionId}` };
    req.session = getSession(admin.sessionId);
    req.headers['x-ploinky-csrf-token'] = mintAdminCsrfToken({ req, sessionId: admin.sessionId });
    const res = { status: 200, setHeader() {}, writeHead(code) { this.status = code; }, end(body) { this.body = JSON.parse(body); } };
    const options = { routePlan: null };
    if (uninstallRepositoryAction) options.uninstallRepositoryAction = uninstallRepositoryAction;
    await routes.handleMarketplaceRoutes(req, res, new URL('http://localhost/api/marketplace'), options);
    return res;
}

// Resolved lazily so the file still loads against a handler without it. A
// handler without it would ignore the injected engine and reach the real one,
// so fail before the request instead.
function uninstallAction(options) {
    assert.equal(typeof routes.uninstallMarketplaceRepository, 'function', 'the handler accepts an injected uninstall');
    return (body) => routes.uninstallMarketplaceRepository(body, options);
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

function assertUninstalled() {
    assert.equal(fs.existsSync(REPO_DIR), false, 'repository checkout removed');
    assert.deepEqual(readJson(ENABLED_REPOS_FILE), ['others']);
    const registry = readJson(paths.agentsFile);
    assert.deepEqual(Object.values(registry).filter((record) => record?.repoName === 'fixtures'), [],
        'no agent of the uninstalled repository stays enabled');
    assert.ok(registry[SURVIVOR]);
    assert.ok(fs.existsSync(path.join(REPOS_DIR, 'others', 'keeper', 'manifest.json')));
}

test('an uninstall of a repository without agents waits for a concurrent owner and removes under its own lease', { timeout: 30_000 }, async (t) => {
    const f = fixture({ withAgent: false });
    const removals = watchRepoRemoval(t);
    const owner = concurrentOwner('agent-enable');

    const pending = uninstallRequest();
    const state = settledState(pending);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(state.settled, false, 'the uninstall must wait for the concurrent owner');
    f.assertUntouched();
    assert.deepEqual(removals, []);
    assert.equal(readLease()?.token, owner.lease.token);

    await owner.release();
    const res = await pending;
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.result.status, 'removed');
    assert.deepEqual(res.body.result.disabledAgents, []);
    assert.equal(removals.length, 1);
    assert.equal(removals[0].lease?.operation, 'repositories-uninstall', 'the checkout is removed under the uninstall lease');
    assert.equal(removals[0].lease.ownerPid, process.pid);
    assert.notEqual(removals[0].lease.token, owner.lease.token);
    assertUninstalled();
    assertLocksReleased();
});

test('an uninstall refuses past its bounded wait and leaves every repository and routing file unchanged', { timeout: 30_000 }, async (t) => {
    const f = fixture();
    const engine = fakeEngine();
    const removals = watchRepoRemoval(t);
    const owner = concurrentOwner('cloudflare-publication:fixture');

    const res = await uninstallRequest({
        uninstallRepositoryAction: uninstallAction({ workspaceLeaseWaitMs: 300, agentDisableDependencies: engine.dependencies }),
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, 'marketplace_action_failed');
    assert.match(res.body.message, /Timed out waiting for cloudflare-publication:fixture/);
    f.assertUntouched();
    assert.deepEqual(engine.calls, [], 'no runtime was signalled');
    assert.deepEqual(removals, []);
    assert.equal(fs.existsSync(NETWORK_LOCK_PATH), false);
    assert.equal(edge.loadActiveEdgeRoutingGeneration().selector.generation, f.generation);
    assert.deepEqual(readLease(), owner.lease, 'the concurrent owner keeps its exact lease');

    await owner.release();
    assertLocksReleased();
});

test('an uninstall selects agents only after a concurrent enable finishes and disables them nested under its one lease', { timeout: 30_000 }, async (t) => {
    const f = fixture();
    const engine = fakeEngine();
    const removals = watchRepoRemoval(t);
    const owner = concurrentOwner('agent-enable');

    const pending = uninstallRequest({
        uninstallRepositoryAction: uninstallAction({ workspaceLeaseWaitMs: 10_000, agentDisableDependencies: engine.dependencies }),
    });
    const state = settledState(pending);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(state.settled, false, 'the uninstall must wait for the concurrent enable');
    f.assertUntouched();
    assert.deepEqual(engine.calls, []);

    // The enable commits another agent of the same repository, then releases.
    await owner.release(() => {
        const registry = readJson(paths.agentsFile);
        registry[LATE] = registryRecord('fixtures', 'late');
        fs.writeFileSync(paths.agentsFile, JSON.stringify(registry, null, 2));
    });
    const res = await pending;
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.result.status, 'removed');
    assert.deepEqual(res.body.result.disabledAgents.map((entry) => `${entry.status}:${entry.containerName}`).sort(),
        [`removed:${LATE}`, `removed:${TARGET}`]);

    assert.equal(engine.calls.length, 1);
    const [call] = engine.calls;
    assert.deepEqual(call.names, [LATE, TARGET].sort());
    assert.equal(call.lease?.operation, 'repositories-uninstall', 'the nested disable runs under the uninstall lease');
    assert.notEqual(call.lease.token, owner.lease.token);
    assert.equal(call.networkOwner, process.pid);
    assert.equal(call.repoPresent, true, 'agents are disabled before their source is removed');
    assert.equal(removals.length, 1);
    assert.equal(removals[0].lease?.token, call.lease.token, 'disable and removal share one lease');

    assertUninstalled();
    const active = edge.loadActiveEdgeRoutingGeneration();
    assert.notEqual(active.selector.generation, f.generation);
    assert.equal(active.generation.routing.routes.probe, undefined);
    assert.ok(active.generation.routing.routes.keeper);
    assertLocksReleased();
});

test('an uninstall whose lease is lost during the disable refuses to remove the repository source', { timeout: 30_000 }, async (t) => {
    fixture();
    const engine = fakeEngine();
    const removals = watchRepoRemoval(t);
    const enabledBefore = fs.readFileSync(ENABLED_REPOS_FILE);
    let lost = null;
    const res = await uninstallRequest({
        uninstallRepositoryAction: uninstallAction({
            agentDisableDependencies: {
                ...engine.dependencies,
                stopAndRemoveImpl(name) {
                    // Another owner recovers the lease while the runtime is removed.
                    lost = readLease();
                    fs.rmSync(WORKSPACE_START_LOCK_PATH);
                    return engine.dependencies.stopAndRemoveImpl(name);
                },
            },
        }),
    });
    assert.equal(lost?.operation, 'repositories-uninstall');
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.message, /exact live workspace lease/);
    assert.deepEqual(removals, [], 'the source is not removed without the live lease');
    assert.ok(fs.existsSync(path.join(REPO_DIR, 'probe', 'manifest.json')));
    assert.deepEqual(fs.readFileSync(ENABLED_REPOS_FILE), enabledBefore);
    assert.equal(readLease(), null, 'nothing re-created a lease on the lost owner\'s behalf');
});
