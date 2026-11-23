import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    assertCanaryEligibility, exportCanarySource, inspectCanarySource, removeCanaryExport,
} from '../../cli/sandbox/canary/export.mjs';
import { deriveCanaryNetworkAlias } from '../../cli/sandbox/networkContract.js';

const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-config-'));
const savedWorkspace = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = configRoot;
test.after(() => {
    if (savedWorkspace === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = savedWorkspace;
    fs.rmSync(configRoot, { recursive: true, force: true });
});

const probe = { port: 8787, path: '/healthz', status: 200 };
const accepted = {
    routeKey: 'alpha', inventoryRow: { routeKey: 'alpha', eligible: true, requiredMemoryBytes: 1000 },
    availableMemoryBytes: 1000, cacheConfirmation: 'no-shared-html-cache',
};

function git(repo, ...args) {
    return execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
    }).trim();
}

function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
}

function scratch(t) {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canary-start-')));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    return workspace;
}

function fixture(t, { manifest = { canary: { probe } }, change, nested = false } = {}) {
    const workspaceRoot = scratch(t);
    const repoRoot = path.join(workspaceRoot, 'fixtures');
    const agentPath = path.join(repoRoot, 'alpha');
    const codeDir = nested ? agentPath : path.join(agentPath, 'code');
    const skillsDir = path.join(agentPath, 'skills');
    const manifestPath = path.join(agentPath, 'manifest.json');
    const sibling = path.join(repoRoot, 'beta');
    write(manifestPath, JSON.stringify(manifest));
    write(path.join(codeDir, 'app'), 'old code');
    write(path.join(skillsDir, 'SKILL.md'), 'old skill');
    write(path.join(sibling, 'manifest.json'), '{}');
    git(repoRoot, 'init', '-q', '-b', 'predecessor');
    git(repoRoot, 'config', 'user.name', 'Fixture');
    git(repoRoot, 'config', 'user.email', 'fixture@example.invalid');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-qm', 'predecessor');
    const oldCommit = git(repoRoot, 'rev-parse', 'HEAD');
    git(repoRoot, 'switch', '-qc', 'candidate');
    write(path.join(codeDir, 'app'), 'candidate code');
    write(path.join(skillsDir, 'SKILL.md'), 'candidate skill');
    change?.({ repoRoot, agentPath, codeDir, skillsDir, sibling, manifestPath });
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-qm', 'candidate');
    const commit = git(repoRoot, 'rev-parse', 'HEAD');
    git(repoRoot, 'switch', '-q', 'predecessor');
    return {
        workspaceRoot, repoRoot, agentPath, codeDir, skillsDir, manifestPath,
        siblingDirs: [sibling], servedPorts: [8787], commit, oldCommit, routeKey: 'alpha',
    };
}

for (const nested of [true, false]) {
    test('export pins code and ' + (nested ? 'nested' : 'separately mounted') + ' skills without moving HEAD', t => {
        const f = fixture(t, { nested });
        const source = inspectCanarySource(f);
        assert.equal(source.oldCommit, f.oldCommit);
        assert.deepEqual(source.probe, probe);
        const args = { ...f, source, mountPoints: [{ target: '/code/cache/location', type: 'file' }] };
        const result = exportCanarySource(args);
        t.after(() => { if (fs.existsSync(f.workspaceRoot)) removeCanaryExport(f); });
        assert.equal(result.exportRoot, path.join(f.workspaceRoot, '.ploinky/canary/alpha', f.commit));
        assert.equal(result.skillsPath, path.join(nested ? result.codePath : result.exportRoot, 'skills'));
        assert.equal(fs.readFileSync(path.join(result.codePath, 'app'), 'utf8'), 'candidate code');
        assert.equal(fs.readFileSync(path.join(result.skillsPath, 'SKILL.md'), 'utf8'), 'candidate skill');
        assert.equal(fs.readFileSync(path.join(f.codeDir, 'app'), 'utf8'), 'old code');
        assert.equal(git(f.repoRoot, 'rev-parse', 'HEAD'), f.oldCommit);
        assert.equal(git(f.repoRoot, 'status', '--porcelain'), '');
        for (const file of [result.exportRoot, result.codePath, result.skillsPath, path.join(result.codePath, 'app')]) {
            assert.equal(fs.statSync(file).mode & 0o222, 0, file);
        }
        assert.equal(fs.existsSync(path.join(result.codePath, '.git')), false);
        assert.ok(fs.statSync(path.join(result.codePath, 'cache/location')).isFile());
        assert.ok(fs.statSync(path.join(result.codePath, 'node_modules')).isDirectory());
        assert.match(result.codeDigest, /^sha256:[a-f0-9]{64}$/);
        assert.throws(() => exportCanarySource(args), /EEXIST/);
        removeCanaryExport(f);
        assert.equal(exportCanarySource(args).codeDigest, result.codeDigest);
        removeCanaryExport(f);
        assert.equal(fs.existsSync(result.exportRoot), false);
    });
}

test('source preflight refuses dirty, changed manifest, sibling changes and a non-fast-forward', t => {
    const f = fixture(t);
    write(path.join(f.repoRoot, 'untracked'), 'local work');
    assert.throws(() => inspectCanarySource(f), /uncommitted/);
    git(f.repoRoot, 'add', 'untracked');
    assert.throws(() => inspectCanarySource(f), /uncommitted/);
    git(f.repoRoot, 'commit', '-qm', 'divergent checkout');
    assert.throws(() => inspectCanarySource(f), /fast-forward/);
    const changed = fixture(t, { change: ({ manifestPath }) => write(manifestPath, '{"new":true}') });
    assert.throws(() => inspectCanarySource(changed), /manifest differs/);
    const sibling = fixture(t, { change: ({ sibling }) => write(path.join(sibling, 'skills/change'), 'new') });
    assert.throws(() => inspectCanarySource(sibling), /another deployed agent/);
});

test('source preflight requires manifest opt-in and an exact private HTTP probe', t => {
    assert.throws(() => inspectCanarySource(fixture(t, { manifest: {} })), /no canary probe/);
    const f = fixture(t);
    assert.throws(() => inspectCanarySource({ ...f, servedPorts: [7000] }), /served TCP port/);
    const invalid = fixture(t, { manifest: { canary: { probe: { ...probe, path: '//different-host' } } } });
    assert.throws(() => inspectCanarySource(invalid), /invalid canary probe/);
    assert.throws(() => inspectCanarySource({ ...f, commit: 'candidate' }), /exact lowercase/);
});

test('eligibility requires an affirmative route-specific row, measured memory and explicit cache confirmation', () => {
    assertCanaryEligibility(accepted);
    assertCanaryEligibility({ ...accepted, cacheConfirmation: 'no-store-and-purge-verified' });
    for (const inventoryRow of [undefined, { ...accepted.inventoryRow, eligible: false },
        { ...accepted.inventoryRow, routeKey: 'beta' }]) {
        assert.throws(() => assertCanaryEligibility({ ...accepted, inventoryRow }), /eligible inventory row/);
    }
    for (const availableMemoryBytes of [999, NaN, undefined]) {
        assert.throws(() => assertCanaryEligibility({ ...accepted, availableMemoryBytes }), /headroom/);
    }
    assert.throws(() => assertCanaryEligibility({
        ...accepted, inventoryRow: { ...accepted.inventoryRow, requiredMemoryBytes: 0 },
    }), /headroom/);
    assert.throws(() => assertCanaryEligibility({ ...accepted, cacheConfirmation: 'purge-pending' }), /cache/);
});

test('escaping archive links and replaced export ancestors preserve unrelated files', t => {
    const f = fixture(t, { change: ({ codeDir }) => fs.symlinkSync(codeDir, path.join(codeDir, 'escape')) });
    const source = inspectCanarySource(f);
    assert.throws(() => exportCanarySource({ ...f, source }), /escapes its mounted archive/);
    const canaryDir = path.join(f.workspaceRoot, '.ploinky', 'canary');
    assert.equal(fs.existsSync(path.join(canaryDir, 'alpha', f.commit)), false);
    const bystander = path.join(f.workspaceRoot, 'bystander');
    write(path.join(bystander, 'marker'), 'bystander data');
    fs.rmdirSync(path.join(canaryDir, 'alpha'));
    fs.symlinkSync(bystander, path.join(canaryDir, 'alpha'));
    assert.throws(() => exportCanarySource({ ...f, source }), /real directory/);
    assert.throws(() => removeCanaryExport(f), /real directory/);
    assert.deepEqual(fs.readdirSync(bystander), ['marker']);
});

test('a canary alias that would exceed one DNS label is bounded and rollout-specific', () => {
    const owner = 'alpha/' + 'b'.repeat(57);
    const first = deriveCanaryNetworkAlias(owner, 'rollout-1');
    assert.equal(first.length, 63);
    assert.match(first, /^[a-z0-9-]+$/);
    assert.equal(deriveCanaryNetworkAlias(owner, 'rollout-1'), first);
    assert.notEqual(deriveCanaryNetworkAlias(owner, 'rollout-2'), first);
});

test('network preflight rejects the alias of an existing or stopped member before creating a container', async t => {
    const { createNetworkLifecycleAdapter, NETWORK_LABELS, physicalNetworkName, workspaceNetworkIdentity } =
        await import('../../cli/sandbox/networkLifecycle.js');
    const workspaceRoot = scratch(t);
    const hash = workspaceNetworkIdentity(workspaceRoot).hash;
    const name = physicalNetworkName(hash, 'shared');
    const network = { mode: 'bridge', attachments: [{ name: 'shared', primary: true }] };
    const containerId = 'f'.repeat(64);
    const alias = deriveCanaryNetworkAlias('fixtures/alpha', 'canary-1');
    let aliases = [alias.toUpperCase()];
    const adapter = createNetworkLifecycleAdapter({
        runtime: 'podman', workspaceRoot,
        run(_runtime, args) {
            let stdout;
            switch (args[0]) {
                case 'info':
                    stdout = JSON.stringify({
                        rootless: true, networkBackend: 'netavark', serviceIsRemote: true,
                        pasta: { executable: '/usr/bin/pasta', version: 'test-version' },
                    });
                    break;
                case 'version':
                    stdout = '5.4.0';
                    break;
                case 'network':
                    assert.deepEqual(args, ['network', 'inspect', name]);
                    stdout = JSON.stringify([{
                        Name: name, Driver: 'bridge', DNSEnabled: true, Options: { isolate: 'true' },
                        IPAM: { Driver: 'host-local' }, Subnets: [{ Subnet: '10.56.0.0/24', Gateway: '10.56.0.1' }],
                        Labels: {
                            [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'network',
                            [NETWORK_LABELS.schema]: '2', [NETWORK_LABELS.workspace]: hash,
                            [NETWORK_LABELS.logical]: 'shared',
                        },
                    }]);
                    break;
                case 'ps':
                    assert.deepEqual(args, ['ps', '-a', '--no-trunc', '--filter', 'network=' + name, '--format', '{{.ID}}']);
                    stdout = containerId;
                    break;
                case 'container':
                    assert.deepEqual(args, ['container', 'inspect', containerId]);
                    stdout = JSON.stringify([{
                        Id: containerId, Name: '/other', NetworkSettings: { Networks: { [name]: { Aliases: aliases } } },
                    }]);
                    break;
                default: assert.fail('unexpected Podman command ' + args[0]);
            }
            return { ok: true, status: 0, stdout, stderr: '' };
        },
    });
    const preflight = () => adapter.preflight(network, 'fixtures/alpha', { networkAlias: alias });
    assert.throws(preflight, /network alias collision/);
    aliases = ['different'];
    assert.equal(preflight().alias, alias);
});

async function activeFixture(t) {
    const f = fixture(t);
    const edge = await import('../../cli/sandbox/edgeGeneration.js');
    const { readReceipt } = await import('../../cli/sandbox/canary/receipt.mjs');
    const old = {
        type: 'agent', runtime: 'podman', repoName: 'fixtures', agentName: 'alpha',
        instanceId: 'instance-old', enableGeneration: 'enabled-old', auth: { mode: 'sso' },
        containerId: 'a'.repeat(64), launchId: 'launch-old', hostPort: 42101,
    };
    const route = { repo: 'fixtures', agent: 'alpha', container: 'primary', hostPath: f.agentPath, hostPort: old.hostPort };
    const data = path.join(f.workspaceRoot, '.ploinky');
    write(path.join(data, 'routing.json'), JSON.stringify({ port: 8080, routes: { alpha: route } }));
    write(path.join(data, 'agents.json'), JSON.stringify({ primary: old }));
    write(path.join(data, 'data/edge-routing/desired.json'), JSON.stringify({
        hosts: { 'app.example.com': { agent: 'fixtures/alpha' } }, cloudflare: { tunnelTokenSecret: 'cloudflare/tunnel-token' },
    }));
    write(path.join(data, 'data/router-security/policy-state.json'), JSON.stringify({
        schema: 'router-policy', httpRoutes: [], mcpTools: [],
    }));
    edge.applyEdgeRoutingGeneration({ workspaceRoot: f.workspaceRoot, reason: 'canary-start-test', publicationState: 'ready' });
    const active = () => edge.loadActiveEdgeRoutingGeneration(f).generation;
    const receipt = () => readReceipt('alpha', f);
    const observed = { codeDir: f.codeDir, skillsDir: f.skillsDir, servedPorts: [8787],
        mountPoints: [], imageId: 'sha256:' + 'f'.repeat(64) };
    const nextId = 'b'.repeat(64);
    const nextLaunch = 'new-launch';
    const calls = [];
    const deps = {
        observePrimary: () => observed, admission: () => accepted, runtimeForAgent: () => 'podman',
        withNetwork: async fn => fn({}),
        async ensureService(name, _manifest, _dir, options) {
            calls.push('create');
            const r = receipt();
            assert.equal(r.oldCommit, f.oldCommit);
            assert.equal(r.oldContainerId, old.containerId);
            assert.equal(r.oldLaunchId, old.launchId);
            assert.equal(r.canaryContainerName, options.containerName);
            assert.equal(r.intent, 'create');
            assert.equal(name, 'alpha');
            assert.equal(options.canaryLaunch, true);
            assert.equal(options.canaryInputs.rolloutId, r.rolloutId);
            assert.equal(options.canaryInputs.networkAlias, r.networkAlias);
            assert.equal(options.canaryInputs.imageId, observed.imageId);
            assert.notEqual(options.instanceId, old.instanceId);
            assert.equal(fs.readFileSync(path.join(options.canaryInputs.codePath, 'app'), 'utf8'), 'candidate code');
            assert.equal(fs.readFileSync(path.join(options.canaryInputs.skillsPath, 'SKILL.md'), 'utf8'), 'candidate skill');
            assert.equal(active().routing.routes.alpha.canary, undefined);
            options.canaryInputs.onCreated({ containerId: nextId, launchId: nextLaunch });
            assert.equal(receipt().canaryContainerId, nextId);
            return {
                containerName: options.containerName, containerId: nextId, hostPort: 42102,
                registryRecord: { ...options.preparedRegistryRecord, containerId: nextId, launchId: nextLaunch },
            };
        },
        async readiness(_name, _manifest, started) {
            calls.push('readiness');
            assert.equal(started.containerId, nextId);
            assert.equal(receipt().canaryLaunchId, nextLaunch);
        },
        async probe(input) {
            calls.push('probe');
            assert.equal(input.containerId, nextId);
            assert.equal(input.port, probe.port);
            assert.equal(input.path, probe.path);
            assert.equal(input.status, probe.status);
            assert.equal(active().routing.routes.alpha.canary, undefined);
            return { ok: true, status: 200 };
        },
    };
    return { f, deps, receipt, active, old, calls, nextId, nextLaunch,
        args: { workspaceRoot: f.workspaceRoot, agentRef: 'fixtures/alpha', commit: f.commit, share: 0, testAccounts: ['tester'] } };
}

test('start publishes both members only after the exact runtime passes readiness and probe', async t => {
    const { startCanary, changeCanary, abortCanary } = await import('../../cli/sandbox/canary/start.mjs');
    const { updateReceipt } = await import('../../cli/sandbox/canary/receipt.mjs');
    const { f, deps, receipt, active, old, calls, args, nextId, nextLaunch } = await activeFixture(t);
    try {
        const rolloutId = await startCanary(args, deps);
        assert.deepEqual(calls, ['create', 'readiness', 'probe']);
        assert.equal(receipt().rolloutId, rolloutId);
        assert.equal(receipt().step, 'published');
        assert.equal(receipt().intent, null);
        let field = active().routing.routes.alpha.canary;
        assert.equal(field.share, 0);
        assert.equal(field.mode, 'split');
        assert.deepEqual(field.testAccounts, ['tester']);
        assert.equal(field.commit, f.commit);
        assert.equal(fs.readFileSync(path.join(f.workspaceRoot, field.codePath, 'app'), 'utf8'), 'candidate code');
        assert.equal(active().agents.primary.containerId, old.containerId);
        assert.equal(active().agents[field.container].containerId, nextId);
        assert.equal(active().agents[field.container].launchId, nextLaunch);
        assert.equal(active().agents[field.container].hostPort, 42102);
        assert.equal(active().agents[field.container].canaryOf, f.routeKey);
        assert.equal(field.hostPort, undefined);
        await assert.rejects(startCanary(args, deps), /already has a canary/);
        const status = state => async () => ({ rollouts: [{ routeKey: f.routeKey, rolloutId, state, exposureVersion: 'epoch:4' }] });
        await changeCanary({ ...args, action: 'set', share: 10, status: status('split') });
        field = active().routing.routes.alpha.canary;
        assert.equal(field.share, 10);
        await assert.rejects(changeCanary({ ...args, action: 'resume', status: status('split') }), /cannot resume/);
        await assert.rejects(changeCanary({ ...args, action: 'resume', status: status('tripped') }), /Router did not confirm/);
        let reads = 0;
        await changeCanary({ ...args, action: 'resume', status: async () => ++reads === 1 ? status('paused')()
            : { rollouts: [{ routeKey: f.routeKey, rolloutId, state: 'split', splitStartedAt: active().routing.routes.alpha.canary.splitStartedAt }] } });
        assert.ok(Date.parse(active().routing.routes.alpha.canary.splitStartedAt) > Date.parse(field.splitStartedAt));
        const end = async options => options;
        assert.deepEqual(await abortCanary(args, { end }), { routeKey: f.routeKey, workspaceRoot: f.workspaceRoot, reason: 'abort' });
        updateReceipt({ routeKey: f.routeKey, rolloutId, fields: { promotionStep: 1 } }, f);
        await assert.rejects(abortCanary(args, { end }), /cannot abort/);
    } finally { removeCanaryExport(f); }
});

test('start refuses other runtimes and never publishes a runtime whose operator probe failed', async t => {
    const { startCanary, reconcileCanaryCommands } = await import('../../cli/sandbox/canary/start.mjs');
    const { f, deps, receipt, active, calls, args, nextId } = await activeFixture(t);
    await assert.rejects(startCanary(args, { ...deps, runtimeForAgent: () => 'docker' }), /Podman/);
    assert.equal(receipt(), null);
    assert.deepEqual(calls, []);
    try {
        const cleanup = [];
        await assert.rejects(startCanary(args, {
            ...deps, probe: async () => ({ ok: false, status: 503 }),
            end: async options => { cleanup.push(options); throw new Error('cleanup unavailable'); },
        }), /operator probe failed/);
        assert.equal(receipt().canaryContainerId, nextId);
        assert.equal(receipt().terminal, null);
        assert.equal(active().routing.routes.alpha.canary, undefined);
        assert.deepEqual(Object.keys(active().agents), ['primary']);
        assert.deepEqual(cleanup, [{ workspaceRoot: f.workspaceRoot, routeKey: f.routeKey, reason: 'interrupted-start' }]);
        await reconcileCanaryCommands(f.workspaceRoot, { end: async options => cleanup.push(options) });
        assert.equal(cleanup.length, 2);
        assert.deepEqual(cleanup[1], cleanup[0]);
    } finally { removeCanaryExport(f); }
});

test('command rejects ambiguous or malformed mutation inputs before taking a workspace lease', async () => {
    const { runCanaryCommand } = await import('../../cli/commands/canaryCommand.js');
    const sha = 'a'.repeat(40);
    for (const args of [
        ['start', 'fixtures/alpha'], ['start', 'fixtures/alpha', '--commit', 'HEAD'],
        ['start', '../alpha', '--commit', sha], ['start', 'fixtures/alpha', '--commit', sha, '--test-accounts', 'a,a'],
        ['set', 'fixtures/alpha'], ['set', 'fixtures/alpha', '--share', '101'],
        ['set', 'fixtures/alpha', '--share', '10', '--share', '20'], ['abort', 'fixtures/alpha', '--commit', sha],
        ['resume', 'fixtures/alpha', '--share', '10'], ['status', 'fixtures/alpha', '--json', '--json'],
    ]) {
        await assert.rejects(runCanaryCommand(args), /Usage: ploinky canary/, args.join(' '));
    }
});

test('a separate config beside the manifest comes from the candidate and missing config cannot fall back to the primary home', t => {
    for (const config of [undefined, { tools: [{ name: 'candidate' }] }, 'malformed']) {
        const f = fixture(t, { change: ({ agentPath }) => {
            if (config !== undefined) write(path.join(agentPath, 'mcp-config.json'),
                typeof config === 'string' ? config : JSON.stringify(config));
        } });
        write(path.join(f.workspaceRoot, '.data/agents/alpha/mcp-config.json'), '{"tools":[{"name":"primary"}]}');
        const args = { workspaceRoot: f.workspaceRoot, routeKey: f.routeKey, source: inspectCanarySource(f) };
        if (config === 'malformed') {
            assert.throws(() => exportCanarySource(args), /invalid JSON in canary MCP configuration/);
        } else {
            const { codePath } = exportCanarySource(args);
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codePath, 'mcp-config.json'))), config ?? {});
            removeCanaryExport({ ...args, commit: f.commit });
        }
    }
});

test('reconciliation recovers settings on both sides of selector commit and preserves unrelated source edits', async t => {
    const { startCanary, reconcileCanaryCommands } = await import('../../cli/sandbox/canary/start.mjs');
    const { assertActiveEdgeRoutingSourcesCurrent, resolveEdgeGenerationPaths, readCurrentEdgeTopology } =
        await import('../../cli/sandbox/edgeGeneration.js');
    const { f, deps, args, active, receipt } = await activeFixture(t);
    try {
        const rolloutId = await startCanary(args, deps);
        const paths = resolveEdgeGenerationPaths(f);
        // Kill the writer after a real atomic rename. Its JavaScript exception
        // handlers cannot undo the mutation and its process-owned locks remain.
        const child = `
            import fs from 'node:fs';
            const [url, file, request, status] = process.argv.slice(1);
            const { changeCanary } = await import(url);
            const rename = fs.renameSync;
            fs.renameSync = (from, to) => {
                rename(from, to);
                if (to === file) process.kill(process.pid, 'SIGKILL');
            };
            await changeCanary({ ...JSON.parse(request), status: async () => JSON.parse(status) });
        `;
        for (const file of [paths.routingFile, paths.topologyCurrentFile, paths.activeSelectorFile]) {
            const previous = active().routing.routes.alpha.canary.share;
            const selected = file === paths.activeSelectorFile;
            const request = { ...args, action: 'set', share: previous + 1 };
            const result = spawnSync(process.execPath, ['--input-type=module', '-e', child,
                new URL('../../cli/sandbox/canary/start.mjs', import.meta.url).href, file, JSON.stringify(request),
                JSON.stringify({ rollouts: [{ state: 'tripped', routeKey: f.routeKey, rolloutId, exposureVersion: 'epoch:8' }] })],
            { cwd: f.workspaceRoot, encoding: 'utf8' });
            assert.equal(result.signal, 'SIGKILL');
            assert.equal(receipt().intent, 'set');
            if (file === paths.routingFile) {
                const partial = fs.readFileSync(file);
                const edited = Buffer.concat([partial, Buffer.from('\n')]);
                fs.writeFileSync(file, edited);
                await assert.rejects(reconcileCanaryCommands(f.workspaceRoot), /sources changed during recovery/);
                assert.deepEqual(fs.readFileSync(file), edited);
                fs.writeFileSync(file, partial);
            }
            await reconcileCanaryCommands(f.workspaceRoot);
            const current = assertActiveEdgeRoutingSourcesCurrent(f);
            assert.equal(current.generation.routing.routes.alpha.canary.share, selected ? request.share : previous);
            assert.equal(readCurrentEdgeTopology(f).authorizationGeneration, current.selector.generation);
            assert.equal(receipt().intent, null);
            assert.equal(receipt().settingsChange?.action ?? null, selected ? 'set' : null);
        }
    } finally { removeCanaryExport(f); }
});

test('an interrupted successful start retires only the durable candidate published by this rollout', async t => {
    const { startCanary, reconcileCanaryCommands } = await import('../../cli/sandbox/canary/start.mjs');
    const { writeRuntimeCandidate, readRuntimeCandidate } = await import('../../cli/sandbox/runtimeCandidateStore.js');
    const { f, deps, args, receipt, active } = await activeFixture(t);
    try {
        await startCanary(args, deps);
        const r = receipt();
        const runtime = {
            operationId: '00000000-0000-4000-8000-000000000001', containerName: r.canaryContainerName,
            containerId: r.canaryContainerId, runtime: 'podman', runtimeNetwork: { mode: 'default' },
            registryRecord: r.canaryRecord,
        };
        const other = { ...runtime, registryRecord: { ...r.canaryRecord, instanceId: 'another-instance' } };
        writeRuntimeCandidate(runtime, f);
        writeRuntimeCandidate(other, f);
        await reconcileCanaryCommands(f.workspaceRoot, { end: () => assert.fail('published rollout must keep running') });
        assert.equal(readRuntimeCandidate(runtime.containerName, runtime.registryRecord, f), null);
        assert.equal(readRuntimeCandidate(other.containerName, other.registryRecord, f)?.operationId, other.operationId);
        assert.equal(active().agents[r.canaryContainerName].containerId, r.canaryContainerId);
    } finally { removeCanaryExport(f); }
});
