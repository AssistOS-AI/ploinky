// Behavioral start-path proof for the immutable dependency cache: the real
// ensureAgentService/startAgentContainer code runs in a child process against
// a temporary workspace and a stateful fake engine on PATH (outside the
// package tree). No real container engine is used.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { installFakeEngine } from './dependencyStoreFakeEngine.mjs';
import { tempRoot } from './dependencyStoreFixtures.mjs';
import { hashInstalledTree } from '../../cli/utils/dependencies/store/treeHash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, 'dependencyStoreStartDriver.mjs');
const CONTAINER = 'ploinky_repo_demo';

function workspace(t, { runtime = 'podman', manifest = null, packageJson = { name: 'demo', dependencies: { 'left-pad': '1.3.0' } } } = {}) {
    const root = tempRoot(t, 'depstore-start-');
    const ws = path.join(root, 'ws');
    const agentDir = path.join(ws, '.ploinky', 'repos', 'repo', 'demo');
    fs.mkdirSync(path.join(agentDir, 'code'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.ploinky', 'data'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.ploinky', 'shared'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest || {
        container: 'node:20', start: 'node index.js', network: { mode: 'none' }, readiness: { protocol: 'none' },
    }));
    fs.writeFileSync(path.join(agentDir, 'code', 'index.js'), 'console.log(1)\n');
    if (packageJson) fs.writeFileSync(path.join(agentDir, 'code', 'package.json'), JSON.stringify(packageJson));
    const engine = installFakeEngine(root, { engines: [runtime] });
    const env = {
        ...process.env,
        ...engine.env,
        PLOINKY_WORKSPACE_ROOT: ws,
        PLOINKY_ROOT: ws,
        CONTAINER_RUNTIME: runtime,
        HOME: path.join(root, 'home'),
        PLOINKY_AGENTLIB_FINGERPRINT: 'fixture-fingerprint',
        PLOINKY_AGENTLIB_MODE: 'local',
        PLOINKY_AGENTLIB_SOURCE_ID: 'd'.repeat(64),
    };
    return { root, ws, agentDir, engine, env };
}

function drive(w, steps) {
    const out = path.join(w.root, `out-${crypto.randomUUID()}.json`);
    const config = path.join(w.root, `config-${crypto.randomUUID()}.json`);
    fs.writeFileSync(config, JSON.stringify({ steps, out }));
    const run = spawnSync(process.execPath, [DRIVER, config], { cwd: w.ws, env: { ...w.env, ...(process.env.DEPENDENCY_STORE_DEBUG ? { PLOINKY_DEBUG: '1' } : {}) }, encoding: 'utf8', timeout: 120_000 });
    if (process.env.DEPENDENCY_STORE_DEBUG) console.log(run.stdout);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function registration() {
    return { type: 'agent', repoName: 'repo', agentName: 'demo', runMode: 'isolated', profile: 'default', instanceId: 'inst-1', enableGeneration: 'gen-1' };
}

function snapshotObject(dependencies) {
    const approved = JSON.parse(fs.readFileSync(path.join(path.dirname(dependencies.payloadPath), 'manifest.json'), 'utf8')).approvedExternalTargets;
    return {
        tree: hashInstalledTree(dependencies.payloadPath, { approvedExternalTargets: approved }).hash,
        agentLibLink: fs.readlinkSync(path.join(dependencies.nodeModulesPath, 'achillesAgentLib')),
        bytes: fs.readFileSync(path.join(dependencies.nodeModulesPath, 'left-pad', 'index.js'), 'utf8'),
    };
}

function byStep(results) {
    return Object.fromEntries(results.map((entry) => [entry.step, entry]));
}

function assertOk(steps, name) {
    assert.equal(steps[name]?.ok, true, `${name}: ${JSON.stringify(steps[name])}`);
    return steps[name].value;
}

for (const runtime of ['podman', 'docker']) {
    const layout = runtime === 'podman' ? 'staged Podman' : 'non-staged Docker';
    test(`dependency store start path (${layout}): first start builds, warm restart reuses, a package change replaces`, (t) => {
        const w = workspace(t, { runtime });
        const steps = byStep(drive(w, [
            { action: 'init-edge' },
            { action: 'register', containerName: CONTAINER, record: { ...registration(), projectPath: path.join(w.ws, '.data', 'demo') } },
            { action: 'prepare-lease' },
            { label: 'first', action: 'ensure-with-lease', containerName: CONTAINER, startPath: true, activate: true },
            { action: 'prepare-lease' },
            { label: 'warm', action: 'ensure-with-lease', containerName: CONTAINER, startPath: true, activate: true },
            { label: 'adoption-unchanged', action: 'no-wait-adoption', containerName: CONTAINER },
        ]));
        const first = assertOk(steps, 'first');
        assert.equal(first.createdByThisLaunch, true);
        assert.equal(first.dependencies.mode, 'store');
        assert.deepEqual(first.stored, first.dependencies, 'the activated registry record carries the admitted generation');
        assert.equal(w.engine.state().installs.length, 1, 'one fake npm run, in an empty payload');
        assert.deepEqual(w.engine.state().installs[0].preexisting, []);
        const container = Object.values(w.engine.state().containers)[0];
        const dependencyMounts = container.Mounts.filter((mount) => mount.Source === first.dependencies.nodeModulesPath);
        assert.ok(dependencyMounts.length >= 1 && dependencyMounts.every((mount) => mount.RW === false),
            'the container binds the stable payload read-only');
        if (runtime === 'docker') {
            assert.deepEqual(dependencyMounts.map((mount) => mount.Destination).sort(), ['/Agent/node_modules', '/code/node_modules']);
        } else {
            assert.deepEqual(dependencyMounts.map((mount) => mount.Destination), [first.dependencies.nodeModulesPath], 'Podman self-mount');
            const staged = container.Mounts.filter((mount) => mount.Destination === '/code' || mount.Destination === '/Agent');
            for (const mount of staged) {
                assert.equal(fs.readlinkSync(path.join(mount.Source, 'node_modules')), first.dependencies.nodeModulesPath,
                    `staged ${mount.Destination}/node_modules names the admitted payload`);
            }
        }

        const warm = assertOk(steps, 'warm');
        assert.equal(warm.createdByThisLaunch, false, 'warm restart reuses the running runtime');
        assert.equal(warm.dependencies.generationId, first.dependencies.generationId);
        assert.equal(w.engine.state().installs.length, 1, 'warm start performs no installer calls');
        assert.equal(assertOk(steps, 'adoption-unchanged').problem, '', 'no-wait adoption accepts the unchanged generation');

        const before = snapshotObject(first.dependencies);
        fs.writeFileSync(path.join(w.agentDir, 'code', 'package.json'), JSON.stringify({ name: 'demo', dependencies: { 'left-pad': '1.3.1' } }));
        const changed = byStep(drive(w, [
            { label: 'adoption-changed', action: 'no-wait-adoption', containerName: CONTAINER },
            { action: 'prepare-lease' },
            { label: 'replace', action: 'ensure-with-lease', containerName: CONTAINER, startPath: true, activate: true },
        ]));
        assert.equal(assertOk(changed, 'adoption-changed').problem, 'dependency inputs changed', 'no-wait adoption refuses the stale runtime');
        assert.equal(changed['prepare-lease']?.ok, true, JSON.stringify(changed['prepare-lease']));
        const replaced = assertOk(changed, 'replace');
        assert.equal(replaced.createdByThisLaunch, true, 'a package change replaces the runtime');
        assert.notEqual(replaced.dependencies.objectId, first.dependencies.objectId);
        assert.equal(w.engine.state().installs.length, 2);
        assert.deepEqual(w.engine.state().installs[1].preexisting, [], 'the replacement installs from empty npm state');
        assert.deepEqual(snapshotObject(first.dependencies), before, 'predecessor payload bytes and AgentLib link text unchanged');
        assert.deepEqual(replaced.stored, replaced.dependencies);
    });
}

test('dependency store start path: a runtime without a dependency record is replaced once, never adopted', (t) => {
    const w = workspace(t);
    const unrecorded = path.join(w.ws, '.ploinky', 'deps', 'agents', 'repo', 'demo', 'container-linux-x64-glibc-node20', 'node_modules');
    fs.mkdirSync(unrecorded, { recursive: true });
    const steps = byStep(drive(w, [
        { action: 'init-edge' },
        { action: 'register', containerName: CONTAINER, record: { ...registration(), projectPath: path.join(w.ws, '.data', 'demo') } },
        { action: 'prepare-lease' },
        { label: 'first', action: 'ensure-with-lease', containerName: CONTAINER, startPath: true, activate: true },
    ]));
    const first = assertOk(steps, 'first');
    // Drop the dependency record and point the bind outside the store.
    const agentsFile = path.join(w.ws, '.ploinky', 'agents.json');
    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    delete agents[CONTAINER].dependencies;
    agents[CONTAINER].config.binds = agents[CONTAINER].config.binds.map((bind) => (
        bind.source === first.dependencies.nodeModulesPath ? { ...bind, source: unrecorded } : bind));
    fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
    const after = byStep(drive(w, [
        { label: 'adoption', action: 'no-wait-adoption', containerName: CONTAINER },
        { label: 'restart', action: 'ensure-with-lease', containerName: CONTAINER, activate: true },
    ]));
    assert.equal(assertOk(after, 'adoption').problem, 'admitted runtime has no dependency generation record');
    const restarted = assertOk(after, 'restart');
    assert.equal(restarted.createdByThisLaunch, true);
    assert.equal(restarted.dependencies.objectId, first.dependencies.objectId, 'the valid store object is reused for the new runtime');
    assert.equal(w.engine.state().installs.length, 1);
    assert.ok(fs.existsSync(unrecorded), 'an unrecorded tree is ignored, never deleted');
});

test('dependency store start path: a start-only agent without package.json keeps its no-cache path', (t) => {
    const w = workspace(t, { packageJson: null });
    const steps = byStep(drive(w, [
        { action: 'init-edge' },
        { action: 'register', containerName: CONTAINER, record: { ...registration(), projectPath: path.join(w.ws, '.data', 'demo') } },
        { action: 'prepare-lease' },
        { label: 'first', action: 'ensure-with-lease', containerName: CONTAINER, startPath: true, activate: true },
        { label: 'warm', action: 'ensure-with-lease', containerName: CONTAINER, activate: true },
    ]));
    const first = assertOk(steps, 'first');
    assert.equal(first.dependencies.mode, 'none');
    assert.equal(assertOk(steps, 'warm').createdByThisLaunch, false);
    assert.equal(w.engine.state().installs.length, 0, 'no dependency build for no-cache agents');
    assert.equal(fs.existsSync(path.join(w.ws, '.ploinky', 'deps', 'store', 'objects')), false);
});

test('dependency store start path: a coordinated same-name host/none replacement removes its exact predecessor', (t) => {
    // Regression: the coordinator rotates the registered tuple before launch,
    // so predecessor ownership must be proven with the pre-rotation record.
    const w = workspace(t);
    const steps = byStep(drive(w, [
        { action: 'init-edge' },
        { action: 'register', containerName: CONTAINER, record: { ...registration(), projectPath: path.join(w.ws, '.data', 'demo') } },
        { action: 'prepare-lease' },
        { label: 'first', action: 'ensure-with-lease', containerName: CONTAINER, startPath: true, activate: true },
    ]));
    const first = assertOk(steps, 'first');
    fs.writeFileSync(path.join(w.agentDir, 'manifest.json'), JSON.stringify({
        container: 'node:20', start: 'node index.js', network: { mode: 'none' }, readiness: { protocol: 'none' }, env: { EXTRA: 'x' },
    }));
    const after = byStep(drive(w, [{ label: 'replace', action: 'ensure-with-lease', containerName: CONTAINER, activate: true }]));
    const replaced = assertOk(after, 'replace');
    assert.equal(replaced.createdByThisLaunch, true);
    assert.notEqual(replaced.containerId, first.containerId);
    const containers = Object.values(w.engine.state().containers);
    assert.deepEqual(containers.map((container) => container.Id), [replaced.containerId], 'exactly the predecessor was removed');
    assert.equal(replaced.dependencies.objectId, first.dependencies.objectId, 'an env-only change keeps the same dependency generation');
    assert.equal(w.engine.state().installs.length, 1);
});

test('dependency store start path (seatbelt): first start builds, warm reuses, a package change replaces behind the fail-closed link', { skip: process.platform !== 'darwin' && 'seatbelt runs on macOS only' }, (t) => {
    const w = workspace(t, {
        manifest: { 'lite-sandbox': true, start: 'node index.js', network: { mode: 'host' }, readiness: { protocol: 'none' } },
    });
    t.after(() => w.engine.killSandboxes());
    const steps = byStep(drive(w, [
        { action: 'init-edge' },
        { action: 'enable-sandbox' },
        { action: 'register', containerName: CONTAINER, record: { ...registration(), runtime: 'seatbelt', projectPath: path.join(w.ws, '.data', 'demo') } },
        { action: 'prepare-lease' },
        { label: 'first', action: 'ensure-with-lease', hostRouter: true, containerName: CONTAINER, startPath: true, activate: true },
        { label: 'warm', action: 'ensure-with-lease', hostRouter: true, containerName: CONTAINER, activate: true },
    ]));
    const first = assertOk(steps, 'first');
    assert.equal(first.runtime, 'seatbelt');
    assert.equal(first.dependencies.mode, 'store');
    assert.equal(first.dependencies.family, 'seatbelt');
    assert.deepEqual(first.stored, first.dependencies);
    assert.equal(w.engine.state().installs.length, 1, 'host npm (fake) ran once in an empty payload');
    assert.deepEqual(w.engine.state().installs[0].preexisting, []);
    const link = path.join(w.agentDir, 'code', 'node_modules');
    assert.equal(fs.readlinkSync(link), first.dependencies.nodeModulesPath, 'the source link names the admitted payload');
    const warm = assertOk(steps, 'warm');
    assert.equal(warm.createdByThisLaunch, false);
    assert.equal(w.engine.state().installs.length, 1, 'warm start performs no installer calls');
    const receipts = fs.readdirSync(path.join(w.ws, '.ploinky', 'deps', 'store', 'receipts', 'readers'))
        .map((name) => JSON.parse(fs.readFileSync(path.join(w.ws, '.ploinky', 'deps', 'store', 'receipts', 'readers', name), 'utf8')));
    assert.ok(receipts.some((receipt) => receipt.consumer.kind === 'seatbelt-service' && receipt.consumer.phase === 'running' && receipt.consumer.process?.pid),
        'the service receipt records its sandbox process');

    const before = snapshotObject(first.dependencies);
    fs.writeFileSync(path.join(w.agentDir, 'code', 'package.json'), JSON.stringify({ name: 'demo', dependencies: { 'left-pad': '1.3.1' } }));
    const changed = byStep(drive(w, [{ label: 'replace', action: 'ensure-with-lease', hostRouter: true, containerName: CONTAINER, activate: true }]));
    const replaced = assertOk(changed, 'replace');
    assert.equal(replaced.createdByThisLaunch, true);
    assert.notEqual(replaced.dependencies.objectId, first.dependencies.objectId);
    assert.equal(fs.readlinkSync(link), replaced.dependencies.nodeModulesPath, 'switched after the only consumer was replaced');
    assert.deepEqual(snapshotObject(first.dependencies), before, 'predecessor payload unchanged');
});
