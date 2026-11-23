import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BOX_MARKER_CONTENT, BOX_MARKER_PATH } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { retireQuiescentBoxWorkspaceStartLock } from '../../ploinky-box/noWaitCleanup.mjs';
import { assertNoCanaryPreparations } from '../../cli/sandbox/canary/preparation.mjs';
import { openReceipt, readReceipt } from '../../cli/sandbox/canary/receipt.mjs';
import { observeEffects } from './fixtures/canaryLifecycleEffects.mjs';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-dispatch-'));
const previous = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
const metadata = path.join(workspaceRoot, '.ploinky');
const fixtureUrl = new URL('./fixtures/canaryLifecycleEffects.mjs', import.meta.url).href;
const modules = new Map(Object.entries({
    'sandbox/docker/index.js': ['stopConfiguredAgents', 'destroyWorkspaceContainers', 'stopAndRemove', 'containerExists'],
    'sandbox/docker/containerFleet.js': ['inspectCanaryContainer', 'removeCanaryContainer'],
    'commands/sessionControl.js': ['killRouterIfRunning', 'destroyAll'],
    'commands/ploinkyboot.js': ['prepareDefaultBootRepositories'],
    'utils/runtime/bootstrapManifest.js': ['prepareManifestRepositories'],
    'commands/repoAgentCommands.js': ['updateRepoResult'],
}).map(([file, names]) => [new URL('../../cli/' + file, import.meta.url).href, names]));

// Keep the actual dispatcher, lease, teardown, start, update and disable
// code. Redirect only engine/process control and repository mutations.
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolution = nextResolve(specifier, context);
        const names = modules.get(resolution.url);
        if (!names || context.parentURL?.startsWith('data:')) return resolution;
        const source = `export * from ${JSON.stringify(resolution.url)};\n`
            + `export { ${names.join(', ')} } from ${JSON.stringify(fixtureUrl)};`;
        return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
    },
});
const { handleCommand } = await import('../../cli/commands/cli.js');
const locks = await import('../../cli/utils/runtime/maintenanceLocks.js');
const { applyEdgeRoutingGeneration, inactivateEdgeRoutingGeneration } = await import('../../cli/sandbox/edgeGeneration.js');
test.after(() => {
    hooks.deregister();
    if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previous;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}

const probeManifest = { canary: { probe: { port: 8787, path: '/health', status: 200 } } };

function fixture(canary, { published = canary, manifest = {}, onEffect, prepare } = {}) {
    fs.rmSync(metadata, { recursive: true, force: true });
    const hostPath = path.join(workspaceRoot, 'fixtures', 'alpha');
    write(path.join(hostPath, 'manifest.json'), manifest);
    const primary = { type: 'agent', repoName: 'fixtures', agentName: 'alpha', runtime: 'podman',
        containerId: 'a'.repeat(64), instanceId: 'primary-instance', enableGeneration: 'primary-generation' };
    const agents = { _config: { static: { agent: 'fixtures/alpha', port: 8080 } }, primary };
    const route = { repo: 'fixtures', agent: 'alpha', container: 'primary', hostPath, hostPort: 43101 };
    const canaryId = 'c'.repeat(64);
    const commit = 'b'.repeat(40);
    const routingFile = path.join(metadata, 'routing.json');
    const agentsFile = path.join(metadata, 'agents.json');
    if (published) {
        route.canary = {
            rolloutId: 'rollout', container: 'primary__canary', commit, codePath: '.ploinky/canary/alpha/' + commit,
            codeDigest: 'sha256:' + '1'.repeat(64), share: 10, testAccounts: [], salt: 'fixture',
            splitStartedAt: '2026-11-23T00:00:00Z', mode: 'split', thresholds: {},
            probe: { port: 8787, path: '/health', status: 200 },
        };
        agents.primary__canary = { ...primary, canaryOf: 'alpha', containerId: canaryId, hostPort: 43102,
            instanceId: 'secondary-instance', enableGeneration: 'secondary-generation', launchId: 'secondary-launch' };
    }
    write(agentsFile, agents);
    write(routingFile, { port: 8080, routes: { alpha: route } });
    write(path.join(metadata, 'data/edge-routing/desired.json'), { hosts: {} });
    write(path.join(metadata, 'data/router-security/policy-state.json'), { schema: 'router-policy', httpRoutes: [], mcpTools: [] });
    applyEdgeRoutingGeneration({ workspaceRoot, reason: 'fixture', publicationState: 'ready' });
    if (canary) openReceipt({ routeKey: 'alpha', rolloutId: 'rollout', fields: {
        oldContainerName: 'primary', canaryContainerName: 'primary__canary', canaryCommit: commit,
        ...(published && { step: 'published', repoName: 'fixtures', agentName: 'alpha', canaryContainerId: canaryId,
            canaryLaunchId: 'secondary-launch', canaryInstanceId: 'secondary-instance', canaryEnableGeneration: 'secondary-generation' }),
    } }, { workspaceRoot });
    const effects = [];
    observeEffects(name => {
        effects.push({
            name, receipt: readReceipt('alpha', { workspaceRoot })?.terminal ?? null,
            lease: locks.heldWorkspaceMutationLease()?.operation ?? null,
            mode: JSON.parse(fs.readFileSync(routingFile)).routes?.alpha?.canary?.mode ?? null,
            registered: Boolean(JSON.parse(fs.readFileSync(agentsFile)).primary__canary),
        });
        onEffect?.(name);
    }, published ? { Id: canaryId } : null, prepare);
    return effects;
}

const commands = [
    [['stop'], ['killRouterIfRunning', 'stopConfiguredAgents']],
    [['shutdown'], ['killRouterIfRunning', 'destroyWorkspaceContainers']],
    [['destroy'], ['killRouterIfRunning', 'destroyAll']],
    [['clean'], ['destroyAll']],
    [['restart'], ['killRouterIfRunning', 'stopConfiguredAgents', 'prepareDefaultBootRepositories']],
    [['start'], ['prepareDefaultBootRepositories']],
    [['update', 'repo', 'fixtures'], ['updateRepoResult']],
    [['disable', 'agent', 'fixtures/alpha'], ['stopAndRemove:primary']],
];

const running = path.join(metadata, 'running');
const markers = () => fs.readdirSync(running).filter(name => name.startsWith('canary-preparation-')).sort();
function attemptNewCanary() {
    const entry = new URL('../../cli/commands/canaryCommand.js', import.meta.url).href;
    const program = `import { runCanaryCommand } from ${JSON.stringify(entry)};
        try { await runCanaryCommand(['start','fixtures/alpha','--commit','${'a'.repeat(40)}']); }
        catch (err) { process.stdout.write(err.message); process.exitCode = 1; }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program],
        { cwd: workspaceRoot, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /preparation is pending/);
    assert.equal(readReceipt('alpha', { workspaceRoot }), null);
}

for (const command of ['start', 'restart']) {
    test(`${command} blocks canary admission even when a probe becomes eligible during preparation`, async () => {
        const effects = fixture(false, {
            onEffect(name) {
                if (name !== 'prepareDefaultBootRepositories') return;
                write(path.join(workspaceRoot, 'fixtures/alpha/manifest.json'), probeManifest);
                applyEdgeRoutingGeneration({ workspaceRoot, reason: 'admit-probe', publicationState: 'ready' });
                assert.equal(markers().length, 1);
                attemptNewCanary();
            },
        });
        if (command === 'start') inactivateEdgeRoutingGeneration('cold-start-fixture', { workspaceRoot });
        await assert.rejects(handleCommand([command]), /fixture reached start repository preparation/);
        assert.deepEqual(markers(), []);
        assert.ok(effects.every(effect => effect.lease === null));
    });
}

test('two ordinary preparations overlap and each releases only its own marker on a thrown checkout error', async () => {
    const entered = [];
    const effects = fixture(false, { prepare: () => new Promise((_, reject) => entered.push(reject)) });
    const first = handleCommand(['start']);
    const second = handleCommand(['start']);
    try {
        assert.equal(entered.length, 2);
        assert.equal(markers().length, 2);
        assert.ok(effects.every(effect => effect.lease === null));
        entered[0](new Error('first checkout failed'));
        await assert.rejects(first, /first checkout failed/);
        assert.equal(markers().length, 1);
        attemptNewCanary();
    } finally {
        for (const reject of entered) reject(new Error('checkout finished'));
        await Promise.allSettled([first, second]);
    }
    assert.deepEqual(markers(), []);
});

test('a canary writer admitted first is allowed to publish before start reconciles and prepares repositories', async () => {
    const effects = fixture(false);
    const writer = locks.createWorkspaceMutationLease({ operation: 'canary-start' });
    const start = handleCommand(['start']);
    assert.deepEqual(effects, []);
    assert.deepEqual(markers(), []);
    openReceipt({ routeKey: 'alpha', rolloutId: 'rollout', fields: {
        oldContainerName: 'primary', canaryContainerName: 'primary__canary', canaryCommit: 'b'.repeat(40),
    } }, { workspaceRoot });
    assert.equal(locks.releaseWorkspaceMutationLease(writer), true);
    await assert.rejects(start, /fixture reached start repository preparation/);
    assert.deepEqual(effects.map(effect => effect.name), ['inspectCanaryContainer', 'prepareDefaultBootRepositories']);
    assert.equal(effects.at(-1).receipt.reason, 'start');
    assert.equal(effects.at(-1).lease, 'workspace-start');
    assert.deepEqual(markers(), []);
});

for (const partialFirst of [false, true]) {
    test(`a reader registered ${partialFirst ? 'during' : 'before'} initial canary lease publication excludes the writer`, async t => {
        let rejectCheckout;
        const effects = fixture(false, { prepare: () => new Promise((_, reject) => { rejectCheckout = reject; }) });
        let reader;
        let observedPartial = false;
        const writeFile = fs.writeFileSync;
        t.mock.method(fs, 'writeFileSync', (file, bytes, options) => {
            if (file !== locks.WORKSPACE_START_LOCK_PATH || options?.flag !== 'wx' || JSON.parse(bytes).operation !== 'canary-start') {
                return writeFile(file, bytes, options);
            }
            const fd = fs.openSync(file, 'wx', 0o600);
            try {
                fs.writeSync(fd, bytes.slice(0, 1));
                if (partialFirst) reader = handleCommand(['start']);
                assert.equal(locks.canaryStartMayBeInFlight(), false);
                assert.equal(markers().length, 1);
                observedPartial = true;
                fs.writeSync(fd, bytes.slice(1));
            } finally { fs.closeSync(fd); }
        });
        try {
            if (!partialFirst) reader = handleCommand(['start']);
            await assert.rejects(handleCommand(['canary', 'start', 'fixtures/alpha', '--commit', 'a'.repeat(40)]),
                /preparation is pending/);
            assert.ok(observedPartial);
            assert.equal(readReceipt('alpha', { workspaceRoot }), null);
            assert.equal(effects.at(-1).lease, null);
        } finally {
            rejectCheckout?.(new Error('fixture checkout finished'));
            if (reader) await assert.rejects(reader, /fixture checkout finished/);
        }
        assert.deepEqual(markers(), []);
    });
}

test('an exited canary writer without a receipt leaves its stale lease untouched during ordinary preparation', async () => {
    const effects = fixture(false);
    const entry = new URL('../../cli/utils/runtime/maintenanceLocks.js', import.meta.url).href;
    const script = `import { createWorkspaceMutationLease } from ${JSON.stringify(entry)};
        createWorkspaceMutationLease({ operation: 'canary-start' });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: workspaceRoot, timeout: 10000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0);
    const before = fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH);
    await assert.rejects(handleCommand(['start']), /fixture reached start repository preparation/);
    assert.deepEqual(fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH), before);
    assert.equal(effects.at(-1).lease, null);
    assert.deepEqual(markers(), []);
});

test('stopping an alias Box preserves an already-admitted canary writer before it has a receipt', t => {
    fixture(false);
    const marker = path.join(workspaceRoot, 'fixture-box-marker');
    fs.writeFileSync(marker, BOX_MARKER_CONTENT);
    for (const method of ['lstatSync', 'readFileSync']) {
        const original = fs[method];
        t.mock.method(fs, method, (file, ...args) => original(file === BOX_MARKER_PATH ? marker : file, ...args));
    }
    const owner = buildWorkspaceIdentity(workspaceRoot);
    const aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-writer-'));
    t.after(() => fs.rmSync(aliasDir, { recursive: true, force: true }));
    const alias = path.join(aliasDir, 'alias-to-workspace');
    fs.symlinkSync(workspaceRoot, alias);
    const other = buildWorkspaceIdentity(alias);
    const lease = locks.createWorkspaceMutationLease({ operation: 'canary-start' });
    assert.equal(lease.canaryOwner, 'box-' + owner.pathHash);
    assertNoCanaryPreparations(workspaceRoot);
    assert.equal(readReceipt('alpha', { workspaceRoot }), null);
    const before = fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH);
    const inode = fs.lstatSync(locks.WORKSPACE_START_LOCK_PATH).ino;
    const quiescent = identity => retireQuiescentBoxWorkspaceStartLock({
        identity, lock: { assertHeld: instance => assert.equal(instance, identity.instance) },
    });
    quiescent(other);
    assert.deepEqual(fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH), before);
    assert.equal(fs.lstatSync(locks.WORKSPACE_START_LOCK_PATH).ino, inode);
    assert.equal(locks.assertWorkspaceMutationLease(lease), lease);
    assert.equal(locks.canaryStartMayBeInFlight(), true);
    quiescent(owner);
    assert.equal(fs.existsSync(locks.WORKSPACE_START_LOCK_PATH), false);
});

for (const lostAt of ['partial publication', 'admission']) {
    test('canary start refuses a writer lease unlinked during ' + lostAt, async t => {
        fixture(false);
        const file = locks.WORKSPACE_START_LOCK_PATH;
        let retired = 0;
        if (lostAt === 'partial publication') {
            const writeFile = fs.writeFileSync;
            t.mock.method(fs, 'writeFileSync', (target, bytes, options) => {
                if (target !== file || options?.flag !== 'wx') return writeFile(target, bytes, options);
                const fd = fs.openSync(file, 'wx', 0o600);
                try {
                    fs.writeSync(fd, bytes.slice(0, 1));
                    const identity = buildWorkspaceIdentity(workspaceRoot);
                    retireQuiescentBoxWorkspaceStartLock({ identity, lock: { assertHeld() {} } });
                    assert.equal(fs.existsSync(file), false);
                    retired++;
                    fs.writeSync(fd, bytes.slice(1));
                } finally { fs.closeSync(fd); }
            });
        } else {
            const read = fs.readdirSync;
            const canonicalRunning = path.join(fs.realpathSync(metadata), 'running');
            t.mock.method(fs, 'readdirSync', (directory, ...args) => {
                const names = read(directory, ...args);
                if (directory === canonicalRunning && !retired && locks.heldWorkspaceMutationLease()?.operation === 'canary-start') {
                    fs.unlinkSync(file);
                    retired++;
                }
                return names;
            });
        }
        await assert.rejects(handleCommand(['canary', 'start', 'fixtures/alpha', '--commit', 'a'.repeat(40)]),
            { code: 'PLOINKY_WORKSPACE_MUTATION_CAPABILITY_REQUIRED' });
        assert.equal(retired, 1);
        assert.equal(readReceipt('alpha', { workspaceRoot }), null);
    });
}

test('canary admission requires an owner-readable writer lease even if the runtime could read it', t => {
    fixture(false);
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
        const result = write(file, ...args);
        if (file === locks.WORKSPACE_START_LOCK_PATH) fs.chmodSync(file, 0o200);
        return result;
    });
    assert.throws(() => locks.createWorkspaceMutationLease({ operation: 'canary-start' }),
        { code: 'PLOINKY_WORKSPACE_MUTATION_CAPABILITY_REQUIRED' });
    assert.equal(locks.canaryStartMayBeInFlight(), false);
});

test('ordinary start with an explicit profile supports stable linked running directories', async () => {
    const effects = fixture(false);
    const linked = fs.mkdtempSync(path.join(workspaceRoot, 'linked-running-'));
    fs.mkdirSync(running, { recursive: true });
    fs.renameSync(running, path.join(linked, 'running'));
    fs.symlinkSync(path.join(linked, 'running'), running);
    await assert.rejects(handleCommand(['start', '--profile', 'default']), /fixture reached start repository preparation/);
    assert.equal(fs.readFileSync(path.join(metadata, 'profile'), 'utf8'), 'default');
    assert.deepEqual(markers(), []);
    assert.ok(effects.every(effect => effect.lease === null));
});

test('ordinary start persists an explicit profile before reporting a missing static agent', async () => {
    const effects = fixture(false);
    write(path.join(metadata, 'agents.json'), {});
    await assert.rejects(handleCommand(['start', '--profile', 'default']), /missing static agent or port/);
    assert.equal(fs.readFileSync(path.join(metadata, 'profile'), 'utf8'), 'default');
    assert.deepEqual(effects, []);
});

test('start finishes canary teardown before persisting an explicit profile', async t => {
    fixture(true);
    inactivateEdgeRoutingGeneration('cold-start-fixture', { workspaceRoot });
    const atProfileWrite = [];
    const writeFile = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
        if (file === path.join(metadata, 'profile')) {
            atProfileWrite.push(readReceipt('alpha', { workspaceRoot }).terminal?.reason);
        }
        return writeFile(file, ...args);
    });
    await assert.rejects(handleCommand(['start', '--profile', 'default']), /fixture reached start repository preparation/);
    assert.deepEqual(atProfileWrite, ['start']);
});

for (const [args, boundaries] of commands) {
    const command = args[0];
    for (const canary of [false, true]) {
        test(`${command} dispatch ${canary ? 'finishes teardown before lifecycle effects' : 'runs the base lifecycle without teardown'}`, async () => {
            const effects = fixture(canary);
            if (canary && command === 'start') inactivateEdgeRoutingGeneration('cold-start-fixture', { workspaceRoot });
            if (['start', 'restart'].includes(command)) {
                await assert.rejects(handleCommand(args), /fixture reached start repository preparation/);
            } else if (command === 'update') {
                const result = await handleCommand(args);
                assert.ok(result.records.some(record => record.code === 'update-threw'));
            } else await handleCommand(args);
            const teardown = canary ? ['inspectCanaryContainer', 'removeCanaryContainer', 'inspectCanaryContainer'] : [];
            assert.deepEqual(effects.map(effect => effect.name), [...teardown, ...boundaries]);
            if (canary) {
                assert.equal(effects[1].mode, 'withdrawn');
                assert.equal(effects[1].registered, true);
                assert.equal(effects[1].receipt, null);
            }
            for (const effect of effects.slice(teardown.length)) {
                assert.equal(effect.mode, null);
                assert.equal(effect.registered, false);
                assert.equal(effect.receipt?.reason ?? null, canary ? command : null);
                assert.equal(effect.receipt?.outcome ?? null, canary ? 'aborted' : null);
                if (!canary && !['disable', 'update'].includes(command)) assert.equal(effect.lease, null);
            }
        });
    }
}

for (const [args, boundaries] of commands.slice(0, 4)) {
    for (const canary of [false, true]) {
        test(`${args[0]} dispatch recovers under a retained lease ${canary ? 'with an open receipt' : 'without a canary'}`, async t => {
            const effects = fixture(canary, { published: false, manifest: probeManifest });
            const lease = locks.createWorkspaceMutationLease({ operation: 'fixture-worker' });
            assert.equal(locks.retainWorkspaceMutationLeaseForRecovery(lease), true);
            const before = fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH);
            const messages = [];
            t.mock.method(console, 'warn', text => messages.push(text));
            await handleCommand(args);
            assert.deepEqual(effects.map(effect => effect.name), boundaries);
            assert.ok(effects.every(effect => effect.receipt === null && effect.lease === null));
            assert.deepEqual(fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH), before);
            assert.equal(Boolean(readReceipt('alpha', { workspaceRoot })), canary);
            assert.equal(messages.some(text => /canar.*next start/i.test(text)), canary);
        });
    }
}
