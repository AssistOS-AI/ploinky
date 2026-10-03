// The CLI repository commands (`uninstall`, `install`/`add`, `enable repo`,
// `disable repo`) are workspace mutations like their Router counterparts. An
// uninstall resolves, selects, disables and removes under one lease; the
// others run their whole mutation under one. Repository files, lease helpers,
// edge generation, registry and routing are real; only the container engine is
// simulated. Concurrent owners hold the lease from their own async chain, so a
// command can never nest inside them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(['PLOINKY_WORKSPACE_ROOT', 'PLOINKY_ROUTER_HOST_PORT', 'PLOINKY_MEDIA_HOST_PORT', 'PLOINKY_MASTER_KEY']
    .map((name) => [name, process.env[name]]));
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cli-repo-lease-')));
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';
process.env.PLOINKY_MASTER_KEY = '6'.repeat(64);

const commands = await import('../../cli/commands/repoAgentCommands.js');
const edge = await import('../../cli/sandbox/edgeGeneration.js');
const locks = await import('../../cli/utils/runtime/maintenanceLocks.js');

const { WORKSPACE_START_LOCK_PATH } = locks;
const paths = edge.resolveEdgeGenerationPaths();
const NETWORK_LOCK_PATH = path.join(paths.ploinkyDir, 'run', 'network.lock');
const REPOS_DIR = path.join(paths.ploinkyDir, 'repos');
const REPO_DIR = path.join(REPOS_DIR, 'fixtures');
const NEW_REPO_DIR = path.join(REPOS_DIR, 'newrepo');
const LOCAL_REPO_DIR = path.join(workspace, 'localrepo');
const USER_FILE = path.join(LOCAL_REPO_DIR, 'helper', 'notes.txt');
const ENABLED_REPOS_FILE = path.join(paths.ploinkyDir, 'enabled_repos.json');
const REPO_SOURCES_FILE = path.join(paths.ploinkyDir, 'repo_sources.json');
const UNREGISTERED_FILE = path.join(paths.ploinkyDir, 'unregistered_agent_repos.json');
const STATE_FILES = [ENABLED_REPOS_FILE, REPO_SOURCES_FILE, UNREGISTERED_FILE];
const TARGET = 'ploinky_fixtures_probe';
const LATE = 'ploinky_fixtures_late';
const SURVIVOR = 'ploinky_others_keeper';

test.after(() => {
    process.chdir(originalCwd);
    for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

test.beforeEach((t) => { t.mock.method(console, 'log', () => {}); });

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

function snapshot(files) {
    return files.map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
}

// A managed `fixtures` checkout (optionally with an enabled agent), a managed
// `newrepo` checkout that is not yet registered, an `others` repository whose
// agent must survive and a workspace-local `localrepo` with a user file, all
// under one active generation.
function fixture({ withAgent = true } = {}) {
    fs.rmSync(paths.ploinkyDir, { recursive: true, force: true });
    fs.rmSync(LOCAL_REPO_DIR, { recursive: true, force: true });
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
    fs.mkdirSync(path.join(NEW_REPO_DIR, 'fresh'), { recursive: true });
    fs.writeFileSync(path.join(NEW_REPO_DIR, 'fresh', 'manifest.json'), '{}');
    fs.mkdirSync(path.join(LOCAL_REPO_DIR, 'local'), { recursive: true });
    fs.writeFileSync(path.join(LOCAL_REPO_DIR, 'local', 'manifest.json'), '{}');
    fs.mkdirSync(path.dirname(USER_FILE), { recursive: true });
    fs.writeFileSync(USER_FILE, 'user-owned work in progress\n');
    fs.writeFileSync(ENABLED_REPOS_FILE, JSON.stringify(['fixtures', 'others', 'localrepo'], null, 2));
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
    const active = edge.applyEdgeRoutingGeneration({ reason: 'cli-repo-lease-fixture' });
    assert.equal(active.selector.state, 'active');
    const files = [paths.agentsFile, paths.routingFile, paths.activeSelectorFile, ...STATE_FILES];
    const before = snapshot(files);
    return {
        generation: active.selector.generation,
        assertUntouched() {
            assert.deepEqual(snapshot(files), before, 'no registry, routing or repository state changed');
            assert.ok(fs.existsSync(path.join(REPO_DIR, 'probe', 'manifest.json')), 'repository source preserved');
            assert.equal(fs.readFileSync(USER_FILE, 'utf8'), 'user-owned work in progress\n');
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

// Records the lease on disk whenever a repository source is removed or a
// repository state file is written.
function watchMutations(t) {
    const removals = [];
    const writes = [];
    const originalRm = fs.rmSync;
    const originalWrite = fs.writeFileSync;
    const originalRename = fs.renameSync;
    const sourceDirs = [REPO_DIR, NEW_REPO_DIR, LOCAL_REPO_DIR];
    fs.rmSync = function rmSync(target, ...rest) {
        const resolved = path.resolve(String(target));
        if (sourceDirs.some((dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`))) {
            removals.push({ path: resolved, lease: readLease() });
        }
        return originalRm.call(this, target, ...rest);
    };
    fs.writeFileSync = function writeFileSync(target, ...rest) {
        if (STATE_FILES.includes(path.resolve(String(target)))) writes.push({ path: path.resolve(String(target)), lease: readLease() });
        return originalWrite.call(this, target, ...rest);
    };
    fs.renameSync = function renameSync(from, target, ...rest) {
        if (STATE_FILES.includes(path.resolve(String(target)))) writes.push({ path: path.resolve(String(target)), lease: readLease() });
        return originalRename.call(this, from, target, ...rest);
    };
    t.after(() => {
        fs.rmSync = originalRm;
        fs.writeFileSync = originalWrite;
        fs.renameSync = originalRename;
    });
    return { removals, writes };
}

// Another operation of the same process that owns the lease in its own async
// chain, not in the command's.
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

function settledState(promise) {
    const state = { settled: false };
    promise.then(() => { state.settled = true; }, () => { state.settled = true; });
    return state;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertLocksReleased() {
    assert.equal(fs.existsSync(WORKSPACE_START_LOCK_PATH), false, 'workspace mutation lease leaked');
    assert.equal(fs.existsSync(NETWORK_LOCK_PATH), false, 'network lifecycle lock leaked');
}

function assertUninstalled() {
    assert.equal(fs.existsSync(REPO_DIR), false, 'repository checkout removed');
    assert.deepEqual(readJson(ENABLED_REPOS_FILE), ['others', 'localrepo']);
    const registry = readJson(paths.agentsFile);
    assert.deepEqual(Object.values(registry).filter((record) => record?.repoName === 'fixtures'), [],
        'no agent of the uninstalled repository stays enabled');
    assert.ok(registry[SURVIVOR]);
    assert.ok(fs.existsSync(path.join(REPOS_DIR, 'others', 'keeper', 'manifest.json')));
}

for (const operation of ['agent-enable', 'update']) {
    test(`a CLI uninstall of a repository without agents waits for a concurrent ${operation} and removes under its own lease`, { timeout: 30_000 }, async (t) => {
        const f = fixture({ withAgent: false });
        const { removals, writes } = watchMutations(t);
        const owner = concurrentOwner(operation);

        const pending = commands.uninstallRepo('fixtures');
        const state = settledState(pending);
        await pause(400);
        assert.equal(state.settled, false, `the uninstall must wait for the concurrent ${operation}`);
        f.assertUntouched();
        assert.deepEqual(removals, []);
        assert.deepEqual(writes, []);
        assert.equal(readLease()?.token, owner.lease.token);

        await owner.release();
        const result = await pending;
        assert.equal(result.status, 'removed');
        assert.deepEqual(result.disabledAgents, []);
        assert.equal(removals.length, 1);
        assert.equal(removals[0].lease?.operation, 'repositories-uninstall', 'the checkout is removed under the uninstall lease');
        assert.equal(removals[0].lease.ownerPid, process.pid);
        assert.notEqual(removals[0].lease.token, owner.lease.token);
        assert.deepEqual(writes.map((entry) => entry.lease?.token), [removals[0].lease.token], 'unregistering shares that lease');
        assertUninstalled();
        assertLocksReleased();
    });
}

test('a CLI uninstall refuses past its bounded wait and leaves every repository and routing file unchanged', { timeout: 30_000 }, async (t) => {
    const f = fixture();
    const engine = fakeEngine();
    const { removals, writes } = watchMutations(t);
    const owner = concurrentOwner('cloudflare-publication:fixture');

    await assert.rejects(
        commands.uninstallRepo('fixtures', { workspaceLeaseWaitMs: 300, agentDisableDependencies: engine.dependencies }),
        /Timed out waiting for cloudflare-publication:fixture/,
    );
    f.assertUntouched();
    assert.deepEqual(engine.calls, [], 'no runtime was signalled');
    assert.deepEqual(removals, []);
    assert.deepEqual(writes, []);
    assert.equal(fs.existsSync(NETWORK_LOCK_PATH), false);
    assert.equal(edge.loadActiveEdgeRoutingGeneration().selector.generation, f.generation);
    assert.deepEqual(readLease(), owner.lease, 'the concurrent owner keeps its exact lease');

    await owner.release();
    assertLocksReleased();
});

test('a CLI uninstall selects agents only after a concurrent enable finishes and disables them nested under its one lease', { timeout: 30_000 }, async (t) => {
    const f = fixture();
    const engine = fakeEngine();
    const { removals } = watchMutations(t);
    const owner = concurrentOwner('agent-enable');

    const pending = commands.uninstallRepo('fixtures', { workspaceLeaseWaitMs: 10_000, agentDisableDependencies: engine.dependencies });
    const state = settledState(pending);
    await pause(400);
    assert.equal(state.settled, false, 'the uninstall must wait for the concurrent enable');
    f.assertUntouched();
    assert.deepEqual(engine.calls, []);

    // The enable commits another agent of the same repository, then releases.
    await owner.release(() => {
        const registry = readJson(paths.agentsFile);
        registry[LATE] = registryRecord('fixtures', 'late');
        fs.writeFileSync(paths.agentsFile, JSON.stringify(registry, null, 2));
    });
    const result = await pending;
    assert.equal(result.status, 'removed');
    assert.deepEqual(result.disabledAgents.map((entry) => `${entry.status}:${entry.containerName}`).sort(),
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

test('a CLI uninstall of a workspace-local repository unregisters it under its lease and preserves user files', { timeout: 30_000 }, async (t) => {
    const f = fixture({ withAgent: false });
    const userBytes = fs.readFileSync(USER_FILE);
    const { removals, writes } = watchMutations(t);
    const owner = concurrentOwner('agent-enable');

    const pending = commands.uninstallRepo('localrepo');
    const state = settledState(pending);
    await pause(400);
    assert.equal(state.settled, false, 'the unregister must wait for the concurrent owner');
    f.assertUntouched();
    assert.deepEqual(writes, []);

    await owner.release();
    const result = await pending;
    assert.equal(result.status, 'unregistered');
    assert.equal(result.preserved, true);
    assert.deepEqual(removals, [], 'nothing under the workspace-local checkout was removed');
    assert.deepEqual(fs.readFileSync(USER_FILE), userBytes);
    assert.ok(fs.existsSync(path.join(LOCAL_REPO_DIR, 'local', 'manifest.json')));
    assert.deepEqual(readJson(UNREGISTERED_FILE), ['localrepo']);
    assert.deepEqual(readJson(ENABLED_REPOS_FILE), ['fixtures', 'others']);
    assert.ok(writes.length >= 2);
    for (const entry of writes) {
        assert.equal(entry.lease?.operation, 'repositories-uninstall', `${path.basename(entry.path)} written under the uninstall lease`);
        assert.equal(entry.lease.token, writes[0].lease.token);
    }
    assertLocksReleased();
});

test('a CLI uninstall whose lease is lost during the disable refuses to remove the repository source', { timeout: 30_000 }, async (t) => {
    fixture();
    const engine = fakeEngine();
    const { removals } = watchMutations(t);
    const enabledBefore = fs.readFileSync(ENABLED_REPOS_FILE);
    let lost = null;
    await assert.rejects(commands.uninstallRepo('fixtures', {
        agentDisableDependencies: {
            ...engine.dependencies,
            stopAndRemoveImpl(name) {
                // Another owner recovers the lease while the runtime is removed.
                lost = readLease();
                fs.rmSync(WORKSPACE_START_LOCK_PATH);
                return engine.dependencies.stopAndRemoveImpl(name);
            },
        },
    }), /exact live workspace lease/);
    assert.equal(lost?.operation, 'repositories-uninstall');
    assert.deepEqual(removals.filter((entry) => entry.path === REPO_DIR), [], 'the source is not removed without the live lease');
    assert.ok(fs.existsSync(path.join(REPO_DIR, 'probe', 'manifest.json')));
    assert.deepEqual(fs.readFileSync(ENABLED_REPOS_FILE), enabledBefore);
    assert.equal(readLease(), null, 'nothing re-created a lease on the lost owner\'s behalf');
});

test('a CLI uninstall inside an operation that already holds the lease reuses that exact lease and leaves it held', { timeout: 30_000 }, async (t) => {
    fixture();
    const engine = fakeEngine();
    const { removals } = watchMutations(t);
    const outer = locks.createWorkspaceMutationLease({ operation: 'reinstall' });
    try {
        // Acquiring instead of reusing would time out after 300ms: this same pid holds the lease.
        const result = await locks.runWithWorkspaceMutationLease(outer, () => commands.uninstallRepo('fixtures', {
            workspaceLeaseWaitMs: 300,
            agentDisableDependencies: engine.dependencies,
        }));
        assert.equal(result.status, 'removed');
        assert.equal(engine.calls.length, 1);
        assert.equal(engine.calls[0].lease?.token, outer.token);
        assert.equal(removals.length, 1);
        assert.equal(removals[0].lease?.token, outer.token);
        assert.equal(readLease()?.token, outer.token, 'the nested command did not release the outer lease');
        assertUninstalled();
    } finally {
        assert.equal(locks.releaseWorkspaceMutationLease(outer), true);
    }
    assertLocksReleased();
});

const repositoryCommands = [
    {
        name: 'install',
        operation: 'repositories-prepare',
        run: (options) => commands.installRepo('https://example.test/newrepo.git', null, null, options),
        verify(result) {
            assert.equal(result.status, 'exists');
            assert.equal(readJson(REPO_SOURCES_FILE).newrepo?.url, 'https://example.test/newrepo.git');
        },
    },
    {
        name: 'add',
        operation: 'repositories-prepare',
        run: (options) => commands.addRepo('https://example.test/newrepo.git', 'newrepo', null, options),
        verify(result) {
            assert.equal(result.status, 'exists');
            assert.equal(readJson(REPO_SOURCES_FILE).newrepo?.url, 'https://example.test/newrepo.git');
        },
    },
    {
        name: 'enable repo',
        operation: 'repositories-enable',
        run: (options) => commands.enableRepo('newrepo', null, options),
        prepare() {
            const sources = readJson(REPO_SOURCES_FILE);
            sources.newrepo = { url: 'https://example.test/newrepo.git' };
            fs.writeFileSync(REPO_SOURCES_FILE, JSON.stringify(sources, null, 2));
        },
        verify(result) {
            assert.equal(result.name, 'newrepo');
            assert.deepEqual(readJson(ENABLED_REPOS_FILE), ['fixtures', 'others', 'localrepo', 'newrepo']);
        },
    },
    {
        name: 'disable repo',
        operation: 'repositories-disable',
        run: (options) => commands.disableRepo('others', options),
        verify(result) {
            assert.equal(result.status, 'disabled');
            assert.deepEqual(readJson(ENABLED_REPOS_FILE), ['fixtures', 'localrepo']);
        },
    },
];

for (const command of repositoryCommands) {
    test(`a CLI ${command.name} waits for a concurrent owner and writes only under its own ${command.operation} lease`, { timeout: 30_000 }, async (t) => {
        fixture();
        command.prepare?.();
        const before = snapshot(STATE_FILES);
        const { removals, writes } = watchMutations(t);
        const owner = concurrentOwner('agent-enable');

        const pending = command.run();
        const state = settledState(pending);
        await pause(400);
        assert.equal(state.settled, false, `${command.name} must wait for the concurrent owner`);
        assert.deepEqual(writes, []);
        assert.deepEqual(snapshot(STATE_FILES), before);

        await owner.release();
        command.verify(await pending);
        assert.deepEqual(removals, []);
        assert.ok(writes.length >= 1);
        for (const entry of writes) {
            assert.equal(entry.lease?.operation, command.operation, `${path.basename(entry.path)} written under ${command.operation}`);
            assert.notEqual(entry.lease.token, owner.lease.token);
        }
        assertLocksReleased();
    });

    test(`a CLI ${command.name} refuses past its bounded wait without writing repository state`, { timeout: 30_000 }, async (t) => {
        fixture();
        command.prepare?.();
        const before = snapshot(STATE_FILES);
        const { writes } = watchMutations(t);
        const owner = concurrentOwner('workspace-restart');

        await assert.rejects(command.run({ workspaceLeaseWaitMs: 300 }), /Timed out waiting for workspace-restart/);
        assert.deepEqual(writes, []);
        assert.deepEqual(snapshot(STATE_FILES), before);
        assert.deepEqual(readLease(), owner.lease, 'the concurrent owner keeps its exact lease');
        await owner.release();
        assertLocksReleased();
    });
}
