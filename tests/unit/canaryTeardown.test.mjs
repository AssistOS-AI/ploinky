import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeReceipt, openReceipt, readReceipt, receiptPath, updateReceipt } from '../../cli/sandbox/canary/receipt.mjs';
import { CanarySignals } from '../../cli/server/canary/signals.js';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-canary-teardown-'));
const env = {
    PLOINKY_WORKSPACE_ROOT: workspaceRoot,
    PLOINKY_ROUTER_HOST_PORT: '18080',
    PLOINKY_MEDIA_HOST_PORT: '17891',
};
const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
test.after(() => {
    for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const { NETWORK_LABELS, workspaceNetworkIdentity } = await import('../../cli/sandbox/networkIdentity.js');
const { NETWORK_SCHEMA_VERSION } = await import('../../cli/sandbox/networkContract.js');
const { ROUTER_GENERATION_SOURCE_FORMAT } = await import('../../cli/utils/runtime/routerGenerationReadiness.mjs');
const { endCanary, reconcileCanaries } = await import('../../cli/sandbox/canary/teardown.mjs');
const options = { workspaceRoot };
const routeKey = 'alpha';
const rolloutId = 'rollout-1';
const primary = 'alpha-container';
const secondary = primary + '__canary';
const oldCommit = 'a'.repeat(40);
const canaryCommit = 'b'.repeat(40);
const id = 'c'.repeat(64);
const launchId = 'canary-launch-1';
const codePath = '.ploinky/canary/alpha/' + canaryCommit;
const exportDir = path.join(workspaceRoot, codePath);
const home = path.join(workspaceRoot, '.data', 'agents', routeKey);
const queue = path.join(home, '.tasksQueue.canary.' + rolloutId);
const keep = [path.join(home, '.tasksQueue'), path.join(home, '.tasksQueue.canary.other'),
    path.join(workspaceRoot, '.ploinky', 'canary', routeKey, oldCommit, 'source')];
const metadata = path.join(workspaceRoot, '.ploinky');
const effects = ['withdraw', 'remove-container', 'remove-pair', 'remove-export', 'remove-queue'];

function put(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}

function source(file) {
    return JSON.parse(fs.readFileSync(path.join(metadata, file), 'utf8'));
}

function selected() {
    return edge.readEdgeRoutingSelection(options).selector;
}

function active() {
    return edge.loadActiveEdgeRoutingGeneration(options).generation;
}

function seed(state = 'split', { inactive = false, receipt = {}, mode } = {}) {
    fs.rmSync(metadata, { recursive: true, force: true });
    const field = {
        rolloutId, container: secondary, commit: canaryCommit, codePath, codeDigest: 'sha256:' + '1'.repeat(64),
        share: 10, testAccounts: [], salt: 'test-salt', splitStartedAt: '2026-11-23T00:00:00Z',
        mode: mode || (state === 'withdrawn' ? 'withdrawn' : 'split'),
        probe: { port: 8787, path: '/health', status: 200 }, thresholds: { minFailures: 5 },
    };
    const repo = 'fixtures';
    const hostPath = path.join(workspaceRoot, repo, routeKey);
    put(path.join(hostPath, 'manifest.json'), {});
    const route = { repo, agent: routeKey, container: primary, hostPath, hostPort: 43101, canary: field };
    const record = {
        type: 'agent', repoName: repo, agentName: routeKey, runtime: 'podman',
        instanceId: 'primary-instance', enableGeneration: 'primary-generation',
        containerId: 'e'.repeat(64), launchId: 'primary-launch', auth: { mode: 'sso' },
    };
    put(path.join(metadata, 'routing.json'), { routes: { [routeKey]: route } });
    put(path.join(metadata, 'agents.json'), {
        [primary]: record, [secondary]: {
            ...record, instanceId: 'canary-instance', enableGeneration: 'canary-generation', launchId,
            canaryOf: routeKey, containerId: id, hostPort: 43102,
        },
    });
    put(path.join(metadata, 'data/edge-routing/desired.json'), { hosts: {} });
    put(path.join(metadata, 'data/router-security/policy-state.json'), { schema: 'router-policy', httpRoutes: [], mcpTools: [] });
    put(path.join(exportDir, 'source'), 'candidate');
    put(queue, 'canary task');
    for (const file of keep) put(file, 'preserve');
    openReceipt({ routeKey, rolloutId, fields: {
        step: 'published', oldCommit, canaryCommit, canaryContainerName: secondary,
        repoName: repo, agentName: routeKey, canaryInstanceId: 'canary-instance', canaryEnableGeneration: 'canary-generation',
        canaryContainerId: id, canaryLaunchId: launchId, ...receipt,
    } }, options);
    edge.applyEdgeRoutingGeneration({ workspaceRoot, reason: 'fixture', publicationState: 'ready' });
    const signals = new CanarySignals();
    // The Router owns transient trip/pause state. Its rule configuration uses
    // S4's default thresholds independently of the route publication schema.
    const signalConfig = { routeKey, rolloutId, share: field.share, mode: field.mode };
    if (state === 'paused' || state === 'withdrawn') signals.routerStarted({ [routeKey]: { canary: signalConfig } });
    else signals.startRollout(signalConfig);
    if (state === 'tripped') signals.recordProbe(routeKey, rolloutId, { ok: false, running: false });
    assert.equal(signals.status().rollouts[0].state, state);
    if (inactive) edge.inactivateEdgeRoutingGeneration('cold-start-fixture', options);
    const initialRoute = source('routing.json').routes[routeKey];
    delete initialRoute.canary;
    const initialPrimary = source('agents.json')[primary];
    const runtime = { container: { Id: id, State: { Running: state !== 'tripped' } } };
    const calls = [];
    const dependencies = {
        removeContainer(name, rec, identity) {
            assert.equal(name, secondary);
            assert.equal(rec.containerId, id);
            assert.equal(rec.launchId, launchId);
            assert.equal(identity.rolloutId, rolloutId);
            assert.equal(source('routing.json').routes[routeKey].canary.mode, 'withdrawn');
            assert.equal(source('agents.json')[secondary].canaryOf, routeKey);
            if (inactive) assert.equal(selected().state, 'inactive');
            else {
                assert.equal(active().routing.routes[routeKey].canary.mode, 'withdrawn');
                assert.equal(active().agents[secondary].containerId, id);
            }
            runtime.container = null;
            return { removed: true };
        },
        inspectContainer(engine, address) {
            assert.equal(engine, 'podman');
            assert.equal(address, id);
            return runtime.container;
        },
        afterEffect(effect) { calls.push(effect); },
    };
    function assertClean(outcome = 'aborted') {
        assert.equal(runtime.container, null);
        assert.deepEqual(source('routing.json').routes[routeKey], initialRoute);
        assert.deepEqual(source('agents.json'), { [primary]: initialPrimary });
        assert.equal(selected().state, inactive ? 'inactive' : 'active');
        if (!inactive) {
            assert.equal(active().routing.routes[routeKey].canary, undefined);
            assert.equal(active().agents[secondary], undefined);
            assert.equal(active().routing.routes[routeKey].container, primary);
        }
        assert.equal(fs.existsSync(exportDir), false);
        assert.equal(fs.existsSync(queue), false);
        for (const file of keep) assert.equal(fs.readFileSync(file, 'utf8'), '"preserve"');
        assert.equal(readReceipt(routeKey, options).terminal.outcome, outcome);
    }
    return { runtime, dependencies, calls, assertClean };
}

function publishedStartFixture(seedOptions) {
    const f = seed('split', { ...seedOptions, receipt: {
        workspaceIdentity: workspaceNetworkIdentity(workspaceRoot).hash,
        ...seedOptions?.receipt,
    } });
    f.dependencies.readRouterHealth = async () => ({ status: 'healthy', pid: 123, generationSourceFormat: ROUTER_GENERATION_SOURCE_FORMAT });
    const record = source('agents.json')[secondary];
    Object.assign(f.runtime.container, {
        Name: secondary, HostConfig: { Init: true },
        Config: {
            Env: ['PLOINKY_CANARY=1', 'PLOINKY_CANARY_ROLLOUT=' + rolloutId, 'PLOINKY_LAUNCH_ID=' + launchId],
            Labels: {
                [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'agent',
                [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION, [NETWORK_LABELS.workspace]: workspaceNetworkIdentity(workspaceRoot).hash,
                [NETWORK_LABELS.contract]: 'd'.repeat(64), [NETWORK_LABELS.instanceId]: record.instanceId,
                [NETWORK_LABELS.enableGeneration]: record.enableGeneration,
            },
        },
    });
    return f;
}

test('warm start leaves the published rollout, selector, runtime and receipt untouched', async () => {
    const f = publishedStartFixture();
    const files = ['routing.json', 'agents.json', 'data/edge-routing/active.json', 'data/canary/alpha.json'];
    const capture = () => files.map(file => fs.readFileSync(path.join(metadata, file)));
    const before = capture();
    assert.deepEqual(await reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies }), []);
    assert.deepEqual(capture(), before);
    assert.deepEqual(f.calls, []);
    assert.ok(f.runtime.container.State.Running && fs.existsSync(exportDir) && fs.existsSync(queue));
});

test('start cleans up an interrupted unpublished route alongside a healthy published canary', async () => {
    const f = publishedStartFixture();
    openReceipt({ routeKey: 'beta', rolloutId: 'orphan', fields: {
        oldContainerName: 'beta', canaryContainerName: 'beta__canary', canaryCommit: oldCommit,
    } }, options);
    const inspect = f.dependencies.inspectContainer;
    f.dependencies.inspectContainer = (runtime, key) => key === 'beta__canary' ? null : inspect(runtime, key);
    const before = readReceipt(routeKey, options), selector = selected();
    assert.deepEqual(await reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies }),
        [{ routeKey: 'beta', outcome: 'aborted' }]);
    assert.deepEqual(readReceipt(routeKey, options), before);
    assert.deepEqual(selected(), selector);
    assert.equal(readReceipt('beta', options).terminal.reason, 'start');
    assert.ok(f.runtime.container.State.Running && fs.existsSync(exportDir) && fs.existsSync(queue));
});

for (const cold of ['router stopped', 'secondary stopped', 'inactive generation']) {
    test('start retires a published rollout with ' + cold, async () => {
        const f = publishedStartFixture({ inactive: cold === 'inactive generation' });
        if (cold === 'router stopped') f.dependencies.readRouterHealth = () => { throw Object.assign(new Error(), { code: 'ECONNREFUSED' }); };
        if (cold === 'secondary stopped') f.runtime.container.State.Running = false;
        await reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies });
        f.assertClean();
    });
}

test('a warm start preserves a running canary during promotion', async () => {
    const f = publishedStartFixture({ mode: 'all', receipt: { step: 3, lastCompletedStep: 3 } });
    const before = readReceipt(routeKey, options);
    assert.deepEqual(await reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies }), []);
    assert.deepEqual(readReceipt(routeKey, options), before);
    assert.equal(active().routing.routes[routeKey].canary.mode, 'all');
    assert.deepEqual(f.calls, []);
});

for (const [label, fields] of [
    ['missing instance', { canaryInstanceId: undefined }], ['missing generation', { canaryEnableGeneration: undefined }],
    ['missing agent', { agentName: undefined }], ['missing repo', { repoName: undefined }],
    ['unknown intent', { intent: { unexpected: true } }], ['invalid step', { step: -1 }],
    ['damaged journal', { teardown: 'damaged' }],
]) {
    test('start retires a split with ' + label + ' in its published receipt', async () => {
        const f = publishedStartFixture({ receipt: fields });
        await reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies });
        f.assertClean();
    });
}

for (const journal of [{ step: 'created', intent: 'publish' },
    { step: 'published', intent: 'set', settingsChange: { action: 'set', splitStartedAt: '2026-11-23T00:00:00Z' } }]) {
    test('warm start finishes the S2 ' + journal.intent + ' receipt of a published rollout', async () => {
        const f = publishedStartFixture({ receipt: journal });
        const selector = selected();
        assert.deepEqual(await reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies }), []);
        assert.deepEqual(selected(), selector);
        assert.equal(readReceipt(routeKey, options).intent, null);
        assert.equal(readReceipt(routeKey, options).step, 'published');
        assert.equal(readReceipt(routeKey, options).terminal, null);
        assert.deepEqual(f.calls, []);
        assert.ok(f.runtime.container.State.Running && fs.existsSync(exportDir) && fs.existsSync(queue));
    });
}

test('start recovers the published pair without unlinking the queue in a different journal home', async () => {
    const otherHome = path.join(workspaceRoot, '.data', 'agents', 'beta');
    const otherQueue = path.join(otherHome, '.tasksQueue.canary.' + rolloutId);
    put(otherQueue, 'preserve');
    const f = publishedStartFixture({ receipt: { teardown: {
        published: true, runtime: 'podman', name: secondary, id, launchId, commit: canaryCommit,
        instanceId: 'canary-instance', enableGeneration: 'canary-generation',
        reason: 'start', outcome: 'aborted', home: otherHome,
    } } });
    await reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies });
    assert.equal(fs.readFileSync(otherQueue, 'utf8'), '"preserve"');
    f.assertClean();
});

for (const inactive of [false, true]) {
    test('start verifies the removed pair’s custom home against its ' + (inactive ? 'inactive' : 'active') + ' generation', async () => {
        const f = publishedStartFixture({ inactive });
        const customHome = path.join(workspaceRoot, 'service-home');
        const customQueue = path.join(customHome, path.basename(queue));
        const otherHome = path.join(workspaceRoot, '.data', 'agents', 'beta');
        const otherQueue = path.join(otherHome, path.basename(queue));
        put(customQueue, 'owned');
        put(otherQueue, 'preserve');
        const agents = source('agents.json');
        agents[secondary].config = { binds: [{ target: '/root', source: customHome }] };
        put(path.join(metadata, 'agents.json'), agents);
        edge.applyEdgeRoutingGeneration({ ...options, reason: 'custom-home' });
        if (inactive) edge.inactivateEdgeRoutingGeneration('cold-start', options);
        f.dependencies.afterEffect = effect => {
            if (effect === 'remove-pair') throw new Error('fixture interrupted after pair removal');
        };
        await assert.rejects(reconcileCanaries({ ...options, reason: 'restart', dependencies: f.dependencies }), /fixture interrupted/);
        assert.equal(source('agents.json')[secondary], undefined);
        assert.equal(f.runtime.container, null);
        const receipt = readReceipt(routeKey, options);
        updateReceipt({ routeKey, rolloutId, fields: { teardown: { ...receipt.teardown, home: otherHome } } }, options);
        f.dependencies.afterEffect = () => {};
        const args = { ...options, reason: 'start', dependencies: f.dependencies };
        if (!inactive) {
            updateReceipt({ routeKey, rolloutId, fields: { teardownPairGeneration: null } }, options);
            await assert.rejects(reconcileCanaries(args), /cannot prove the queue home/);
            assert.ok(fs.existsSync(customQueue) && fs.existsSync(otherQueue));
            assert.equal(readReceipt(routeKey, options).terminal, null);
            updateReceipt({ routeKey, rolloutId, fields: { teardownPairGeneration: receipt.teardownPairGeneration } }, options);
        }
        await reconcileCanaries(args);
        assert.equal(fs.readFileSync(otherQueue, 'utf8'), '"preserve"');
        assert.equal(fs.existsSync(customQueue), false);
        assert.equal(readReceipt(routeKey, options).terminal.outcome, 'aborted');
    });
}

test('uncertain Router health leaves the rollout available for retry', async () => {
    const f = publishedStartFixture();
    f.dependencies.readRouterHealth = () => { throw Object.assign(new Error(), { code: 'EACCES' }); };
    const before = readReceipt(routeKey, options);
    await assert.rejects(reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies }), { code: 'EACCES' });
    assert.deepEqual(readReceipt(routeKey, options), before);
    assert.equal(active().routing.routes[routeKey].canary.mode, 'split');
    assert.deepEqual(f.calls, []);
});

test('a legacy removal journal can finish only in the shared home of its exact S2 members', async () => {
    const f = publishedStartFixture();
    const agents = source('agents.json');
    const old = agents[primary];
    updateReceipt({ routeKey, rolloutId, fields: {
        canaryRecord: agents[secondary], oldContainerName: primary, oldContainerId: old.containerId,
        oldLaunchId: old.launchId, oldInstanceId: old.instanceId, oldEnableGeneration: old.enableGeneration,
    } }, options);
    f.dependencies.afterEffect = effect => { if (effect === 'remove-pair') throw new Error('fixture interruption'); };
    await assert.rejects(reconcileCanaries({ ...options, reason: 'stop', dependencies: f.dependencies }), /fixture interruption/);
    const { teardown } = readReceipt(routeKey, options);
    const otherHome = path.join(workspaceRoot, '.data', 'agents', 'other');
    const otherQueue = path.join(otherHome, path.basename(queue));
    put(otherQueue, 'preserve');
    updateReceipt({ routeKey, rolloutId, fields: { teardownPairGeneration: null, teardown: { ...teardown, home: otherHome } } }, options);
    const args = { ...options, reason: 'start', dependencies: { ...f.dependencies, afterEffect() {} } };
    await assert.rejects(reconcileCanaries(args), /cannot prove the queue home/);
    assert.ok(fs.existsSync(queue) && fs.existsSync(otherQueue));
    updateReceipt({ routeKey, rolloutId, fields: { teardown } }, options);
    await reconcileCanaries(args);
    f.assertClean();
    assert.equal(fs.readFileSync(otherQueue, 'utf8'), '"preserve"');
});

for (const [invalid, inactive] of [['closed', false], ['malformed JSON', false], ['wrong shape', true], ['missing', true]]) {
    test('start retires the exact published rollout with a ' + invalid + ' receipt', async () => {
        const f = publishedStartFixture({ inactive });
        const file = receiptPath(routeKey, options);
        if (invalid === 'closed') closeReceipt({ routeKey, rolloutId, outcome: 'aborted' }, options);
        else if (invalid === 'missing') fs.unlinkSync(file);
        else fs.writeFileSync(file, invalid === 'wrong shape' ? '[]' : '{"');
        assert.deepEqual(await reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies }),
            [{ routeKey, outcome: 'aborted' }]);
        f.assertClean();
    });
}

test('start resumes from the recovered receipt after interruption before withdrawal', async t => {
    const f = publishedStartFixture();
    const file = receiptPath(routeKey, options);
    fs.writeFileSync(file, '{');
    const rename = fs.renameSync;
    const interrupted = t.mock.method(fs, 'renameSync', (from, to) => {
        rename(from, to);
        if (to === file) throw new Error('fixture interrupted receipt recovery');
    });
    const args = { ...options, reason: 'start', dependencies: f.dependencies };
    await assert.rejects(reconcileCanaries(args), /fixture interrupted receipt recovery/);
    interrupted.mock.restore();
    assert.equal(readReceipt(routeKey, options).intent, 'withdraw');
    assert.equal(active().routing.routes[routeKey].canary.mode, 'split');
    await reconcileCanaries(args);
    f.assertClean();
});

test('start refuses to reconstruct from uncorroborated inactive routing or a foreign runtime', async () => {
    for (const invalid of ['sources', 'runtime']) {
        const f = publishedStartFixture({ inactive: invalid === 'sources' });
        const file = receiptPath(routeKey, options);
        fs.writeFileSync(file, '{');
        if (invalid === 'sources') fs.appendFileSync(path.join(metadata, 'routing.json'), ' ');
        else f.runtime.container.Config.Labels[NETWORK_LABELS.workspace] = 'foreign';
        await assert.rejects(reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies }),
            invalid === 'sources' ? /changed publication sources/ : /ownership/);
        assert.equal(fs.readFileSync(file, 'utf8'), '{');
        assert.deepEqual(f.calls, []);
    }
});

test('start preserves an ambiguous promotion or a symlinked receipt for diagnosis', async () => {
    for (const invalid of ['promotion', 'symlink']) {
        const f = publishedStartFixture({ mode: invalid === 'promotion' ? 'all' : 'split' });
        const file = receiptPath(routeKey, options);
        const target = path.join(workspaceRoot, 'saved-receipt');
        if (invalid === 'symlink') {
            fs.renameSync(file, target);
            fs.symlinkSync(target, file);
        } else fs.writeFileSync(file, '{');
        const before = fs.readFileSync(file);
        await assert.rejects(reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies }),
            invalid === 'promotion' ? /without a published split/ : /regular file/);
        assert.deepEqual(fs.readFileSync(file), before);
        assert.deepEqual(f.calls, []);
    }
});

for (const [step, outcome] of [[2, 'aborted'], [3, 'reset']]) {
    test('start retires a closed promoted pair at exact completed step ' + step, async () => {
        const f = publishedStartFixture({ mode: 'all', receipt: { step, lastCompletedStep: step } });
        closeReceipt({ routeKey, rolloutId, outcome, reason: 'restart' }, options);
        await reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies });
        f.assertClean(outcome);
    });
}

test('a receipt-bound abort withdraws a verified legacy rollout while new publications stay strict', async () => {
    const { digestGenerationParts, generationDocumentFile, generationSourceParts, readGenerationDocument,
        selectActiveGeneration, sha256 } = await import('../helpers/routerOriginsWorkspace.mjs');
    const edgeDir = path.join(metadata, 'data/edge-routing');
    for (const thresholds of [{ errorRate: 0.05, windowSeconds: 300 }, { slowMs: 515 }]) {
        const fixture = seed();
        const routing = source('routing.json');
        routing.routes.alpha.canary.thresholds = thresholds;
        const bytes = Buffer.from(JSON.stringify(routing));
        fs.writeFileSync(path.join(metadata, 'routing.json'), bytes);
        const document = readGenerationDocument(edgeDir, selected().generation);
        document.sources.routing = bytes.toString('base64');
        document.sourceDigests.routing = sha256(bytes);
        document.generation = digestGenerationParts(generationSourceParts(document));
        put(generationDocumentFile(edgeDir, document.generation), document);
        selectActiveGeneration(edgeDir, document.generation);
        assert.deepEqual(active().routing.routes.alpha.canary.thresholds, thresholds);
        assert.throws(() => edge.withEdgeGenerationApplyLock(applyLockCapability =>
            edge.prepareAdditiveEdgeRoutingGeneration({ workspaceRoot, routing, applyLockCapability }), options),
        { code: 'EDGE_GENERATION_INVALID' });
        await endCanary({ workspaceRoot, routeKey, reason: 'abort', dependencies: fixture.dependencies });
        fixture.assertClean();
    }
});

for (const reason of ['stop', 'restart', 'shutdown', 'destroy', 'clean', 'update', 'disable', 'start']) {
    for (const state of ['split', 'tripped', 'paused', 'withdrawn']) {
        test(`${reason} reconciles a ${state} canary`, async () => {
            const f = seed(state, { inactive: reason === 'start' });
            await reconcileCanaries({ workspaceRoot, reason, dependencies: f.dependencies,
                ...(reason === 'disable' ? { routeKey } : {}) });
            f.assertClean();
        });
    }
}

for (const effect of effects) {
    test(`teardown resumes after the ${effect} side effect`, async () => {
        const f = seed();
        const args = { workspaceRoot, routeKey, reason: 'restart', dependencies: f.dependencies };
        f.dependencies.afterEffect = name => {
            f.calls.push(name);
            if (name === effect) throw new Error('fixture interruption');
        };
        await assert.rejects(endCanary(args), /fixture interruption/);
        assert.deepEqual(f.calls, effects.slice(0, effects.indexOf(effect) + 1));
        assert.equal(readReceipt(routeKey, options).terminal, null);
        f.dependencies.afterEffect = () => {};
        await reconcileCanaries(args);
        f.assertClean();
        const selector = selected();
        const terminal = readReceipt(routeKey, options);
        await endCanary(args);
        assert.deepEqual(selected(), selector);
        assert.deepEqual(readReceipt(routeKey, options), terminal);
    });
}

test('an exited container still present after removal keeps the withdrawn pair and open receipt', async () => {
    const f = seed('tripped');
    f.dependencies.removeContainer = () => ({ removed: true });
    await assert.rejects(endCanary({ ...options, routeKey, reason: 'stop', dependencies: f.dependencies }));
    assert.equal(f.runtime.container.State.Running, false);
    assert.equal(active().routing.routes[routeKey].canary.mode, 'withdrawn');
    assert.equal(active().agents[secondary].containerId, id);
    assert.equal(readReceipt(routeKey, options).terminal, null);
    assert.ok(fs.existsSync(exportDir) && fs.existsSync(queue));
});

test('an unavailable container engine leaves teardown retryable', async () => {
    const f = seed();
    const inspect = f.dependencies.inspectContainer;
    f.dependencies.inspectContainer = () => { throw new Error('engine offline'); };
    const args = { ...options, routeKey, reason: 'restart', dependencies: f.dependencies };
    await assert.rejects(endCanary(args), /engine offline/);
    assert.equal(readReceipt(routeKey, options).terminal, null);
    assert.equal(source('agents.json')[secondary].containerId, id);
    f.dependencies.inspectContainer = inspect;
    await reconcileCanaries(args);
    f.assertClean();
});

for (const [step, outcome] of [[2, 'aborted'], [3, 'reset']]) {
    test(`restart at completed promotion step ${step} records ${outcome}`, async () => {
        const f = seed('split', { mode: 'all', receipt: { step } });
        await reconcileCanaries({ ...options, reason: 'restart', dependencies: f.dependencies });
        f.assertClean(outcome);
    });
}

test('disable of a different route leaves the active rollout intact', async () => {
    const f = seed();
    const selector = selected();
    await reconcileCanaries({ ...options, routeKey: 'beta', reason: 'disable', dependencies: f.dependencies });
    assert.deepEqual(selected(), selector);
    assert.deepEqual(f.calls, []);
    assert.ok(f.runtime.container && fs.existsSync(exportDir) && fs.existsSync(queue));
    assert.equal(readReceipt(routeKey, options).terminal, null);
});

for (const [head, outcome] of [[oldCommit, 'aborted'], [canaryCommit, 'reset']]) {
    test(`pending promotion checkout records ${outcome} from the observed HEAD`, async () => {
        const f = seed('split', { mode: 'all', receipt: { step: 2, intent: 3 } });
        let reads = 0;
        f.dependencies.readCheckoutHead = directory => {
            const repo = fs.realpathSync(path.join(workspaceRoot, 'fixtures'));
            assert.ok(['', routeKey].includes(path.relative(repo, fs.realpathSync(directory))));
            reads++;
            return head;
        };
        await reconcileCanaries({ ...options, reason: 'restart', dependencies: f.dependencies });
        assert.equal(reads, 1);
        f.assertClean(outcome);
    });
}

test('a mismatched receipt container ID refuses teardown before the first side effect', async () => {
    const f = seed('split', { receipt: { canaryContainerId: 'd'.repeat(64) } });
    const selector = selected();
    await assert.rejects(endCanary({ ...options, routeKey, reason: 'stop', dependencies: f.dependencies }), /ID/i);
    assert.deepEqual(selected(), selector);
    assert.deepEqual(f.calls, []);
    assert.equal(f.runtime.container.Id, id);
    assert.equal(readReceipt(routeKey, options).terminal, null);
});

test('disableAgent retires the canary before withdrawing and removing its primary', async () => {
    const { disableAgent } = await import('../../cli/utils/agents.js');
    const f = seed();
    const removed = [];
    const result = await disableAgent('fixtures/alpha', {
        reconcileCanariesImpl: args => reconcileCanaries({ ...args, dependencies: f.dependencies }),
        isSandboxRuntimeImpl: () => false,
        classifyRecordRuntimeImpl: () => ({ kind: 'container' }),
        retireNoWaitMarkersImpl: () => [],
        stopAndRemoveImpl(name) {
            assert.equal(readReceipt(routeKey, options).terminal.outcome, 'aborted');
            assert.equal(f.runtime.container, null);
            assert.equal(active().routing.routes[routeKey], undefined);
            removed.push(name);
            return [name];
        },
        containerExistsImpl: name => name === primary && !removed.includes(name),
    });
    assert.equal(result.status, 'removed');
    assert.deepEqual(removed, [primary]);
    assert.equal(source('agents.json')[primary], undefined);
    assert.equal(source('agents.json')[secondary], undefined);
    assert.equal(fs.existsSync(queue), false);
    assert.equal(fs.existsSync(exportDir), false);
});

// Run this function in a child. SIGKILL leaves the real apply and preparation
// leases on disk, including the window after replacing the selector.
async function interruptPublication(moduleUrl, workspace, destination) {
    const { default: fs } = await import('node:fs');
    const { endCanary } = await import(moduleUrl);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
        rename(from, to);
        if (to === destination) process.kill(process.pid, 'SIGKILL');
    };
    await endCanary({ workspaceRoot: workspace, routeKey: 'alpha', reason: 'stop',
        dependencies: { inspectContainer: () => null, removeContainer: () => { throw new Error('unexpected container'); } } });
    throw new Error('teardown completed without reaching the intended publication step');
}

for (const [target, inactive] of [['routing.json', false], ['data/edge-routing/active.json', false], ['routing.json', true]]) {
    const state = inactive ? 'inactive' : 'active';
    test(`process death after replacing ${target} during ${state} pair removal recovers on restart`, async () => {
        const f = seed('withdrawn', { inactive });
        f.runtime.container = null;
        const moduleUrl = new URL('../../cli/sandbox/canary/teardown.mjs', import.meta.url).href;
        const args = [moduleUrl, workspaceRoot, path.join(metadata, target)];
        const script = 'await (' + interruptPublication.toString() + ')(...JSON.parse(process.argv[1]))';
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(args)], {
            cwd: workspaceRoot, timeout: 15_000, encoding: 'utf8',
        });
        assert.ifError(result.error);
        assert.equal(result.signal, 'SIGKILL', result.stderr);
        if (!inactive) assert.ok(edge.readEdgeRoutingPreparationOwner(options), 'child died before retiring the additive lease');
        assert.equal(source('routing.json').routes[routeKey].canary, undefined);
        if (target === 'routing.json') {
            assert.equal(source('agents.json')[secondary].containerId, id);
            if (inactive) assert.equal(selected().state, 'inactive');
            else assert.equal(active().routing.routes[routeKey].canary.mode, 'withdrawn');
        } else {
            assert.equal(source('agents.json')[secondary], undefined);
            assert.equal(active().agents[secondary], undefined);
        }
        await reconcileCanaries({ ...options, reason: 'restart', dependencies: f.dependencies });
        f.assertClean();
        assert.equal(edge.readEdgeRoutingPreparationOwner(options), null);
    });
}

test('teardown removes the route directory when it removes its last export', async () => {
    const f = seed();
    const routeDir = path.dirname(exportDir);
    fs.rmSync(path.join(routeDir, oldCommit), { recursive: true });
    await endCanary({ ...options, routeKey, reason: 'abort', dependencies: f.dependencies });
    assert.equal(fs.existsSync(routeDir), false);
    assert.ok(fs.statSync(path.dirname(routeDir)).isDirectory());
});

test('start retires the graph preparation left by a previous start before ending its cold canary', async () => {
    const f = publishedStartFixture({ inactive: true });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { prepareEdgeRoutingGeneration } = await import(process.argv[1]);
        prepareEdgeRoutingGeneration({ reason: 'workspace-graph-enable-prelaunch' });
        process.kill(process.pid, 'SIGKILL');
    `, new URL('../../cli/sandbox/edgeGeneration.js', import.meta.url).href], {
        cwd: workspaceRoot, encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal(edge.readEdgeRoutingPreparationOwner(options).pid, child.pid);
    await reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies });
    assert.equal(edge.readEdgeRoutingPreparationOwner(options), null);
    f.assertClean();
});

test('start leaves a live graph preparation and its cold canary in place', async () => {
    const f = publishedStartFixture({ inactive: true });
    const { preparationLease } = edge.prepareEdgeRoutingGeneration({ ...options, reason: 'workspace-graph-enable-prelaunch' });
    try {
        const selector = selected();
        const receipt = readReceipt(routeKey, options);
        await assert.rejects(reconcileCanaries({ ...options, reason: 'start', dependencies: f.dependencies }),
            { code: 'EDGE_PREPARATION_BUSY' });
        assert.equal(edge.readEdgeRoutingPreparationOwner(options).pid, process.pid);
        assert.deepEqual(selected(), selector);
        assert.deepEqual(readReceipt(routeKey, options), receipt);
        assert.deepEqual(f.calls, []);
    } finally {
        edge.abortEdgeRoutingPreparation(preparationLease, options);
    }
});

test('a substituted export directory cannot redirect teardown into another directory', async () => {
    const f = seed();
    const preserved = path.join(workspaceRoot, 'foreign-export');
    put(path.join(preserved, 'keep'), 'foreign');
    fs.renameSync(exportDir, exportDir + '.original');
    fs.symlinkSync(preserved, exportDir, 'dir');
    await assert.rejects(endCanary({ ...options, routeKey, reason: 'stop', dependencies: f.dependencies }));
    assert.equal(fs.readFileSync(path.join(preserved, 'keep'), 'utf8'), '"foreign"');
    assert.ok(fs.lstatSync(exportDir).isSymbolicLink());
    assert.equal(readReceipt(routeKey, options).terminal, null);
});

async function checkUnpublishedStart(tornPublication) {
    const f = seed('split', { receipt: {
        step: 'created', intent: 'readiness', oldContainerName: primary, oldContainerId: 'e'.repeat(64),
        oldLaunchId: 'primary-launch', oldInstanceId: 'primary-instance', oldEnableGeneration: 'primary-generation',
        repoName: 'fixtures', agentName: routeKey, canaryInstanceId: 'canary-instance',
        canaryEnableGeneration: 'canary-generation', networkAlias: 'canary-test', codePath,
    } });
    const routes = source('routing.json');
    const agents = source('agents.json');
    const candidateRoutes = structuredClone(routes);
    candidateRoutes.routes[routeKey].canary.codePath += '/code';
    const preparedAgents = structuredClone(agents);
    delete preparedAgents[secondary].containerId;
    delete preparedAgents[secondary].launchId;
    delete preparedAgents[secondary].hostPort;
    preparedAgents[secondary].networkAlias = 'canary-test';
    delete routes.routes[routeKey].canary;
    delete agents[secondary];
    put(path.join(metadata, 'routing.json'), routes);
    put(path.join(metadata, 'agents.json'), agents);
    edge.applyEdgeRoutingGeneration({ ...options, reason: 'primary-only', publicationState: 'ready' });
    const selector = selected();
    if (tornPublication) {
        const lease = edge.withEdgeGenerationApplyLock(applyLockCapability => edge.prepareAdditiveEdgeRoutingGeneration({
            workspaceRoot, expectedActiveGeneration: selector.generation, routing: candidateRoutes, agents: preparedAgents,
            reason: 'canary-start:' + rolloutId, applyLockCapability,
        }), options).preparationLease;
        updateReceipt({ routeKey, rolloutId, fields: { step: 'created', intent: 'publish', preparationLease: lease } }, options);
        const paths = edge.resolveEdgeGenerationPaths(options);
        const stored = JSON.parse(fs.readFileSync(path.join(paths.generationsDir, lease.preparedGeneration.slice(7) + '.json')));
        fs.writeFileSync(paths.routingFile, Buffer.from(stored.sources.routing, 'base64'));
        // The S2 command can abort its abandoned additive lease before handing
        // off. Its receipt still pins both the prepared and predecessor bytes.
        edge.abortEdgeRoutingPreparation(lease, options);
        assert.equal(source('routing.json').routes[routeKey].canary.container, secondary);
        assert.equal(source('agents.json')[secondary], undefined);
        assert.equal(active().routing.routes[routeKey].canary, undefined);
    }
    let removals = 0;
    f.dependencies.removeContainer = (name, rec, identity) => {
        assert.equal(name, secondary);
        assert.equal(rec.containerId, id);
        assert.equal(rec.launchId, launchId);
        assert.equal(rec.instanceId, 'canary-instance');
        assert.equal(rec.enableGeneration, 'canary-generation');
        assert.equal(identity.rolloutId, rolloutId);
        f.runtime.container = null;
        removals++;
        return { removed: true };
    };
    await reconcileCanaries({ ...options, reason: 'restart', dependencies: f.dependencies });
    assert.equal(removals, 1);
    assert.deepEqual(selected(), selector);
    f.assertClean();
}

test('an interrupted S2 creation is removed by the identity in its unpublished receipt', () => checkUnpublishedStart(false));
test('a torn S2 start publication restores primary-only sources and removes the unpublished container',
    () => checkUnpublishedStart(true));

for (const receiptState of ['missing', 'terminal']) {
    test(`a published pair with a ${receiptState} receipt prevents lifecycle mutation`, async () => {
        const f = seed();
        if (receiptState === 'missing') fs.unlinkSync(receiptPath(routeKey, options));
        else closeReceipt({ routeKey, rolloutId, outcome: 'aborted' }, options);
        const selector = selected();
        await assert.rejects(reconcileCanaries({ ...options, reason: 'stop', dependencies: f.dependencies }));
        assert.deepEqual(selected(), selector);
        assert.equal(source('agents.json')[secondary].containerId, id);
        assert.deepEqual(f.calls, []);
        assert.ok(f.runtime.container && fs.existsSync(exportDir) && fs.existsSync(queue));
    });
}

test('a receipt copied from another workspace cannot authorize cleanup', async () => {
    const f = seed('split', { receipt: { workspaceIdentity: 'foreign-workspace' } });
    const selector = selected();
    await assert.rejects(endCanary({ ...options, routeKey, reason: 'stop', dependencies: f.dependencies }), /another workspace/);
    assert.deepEqual(selected(), selector);
    assert.deepEqual(f.calls, []);
    assert.ok(fs.existsSync(queue) && fs.existsSync(exportDir));
});

test('a manifest home mount receives cleanup of just its rollout queue', async () => {
    const f = seed();
    const customHome = path.join(workspaceRoot, 'service-home');
    const agents = source('agents.json');
    agents[secondary].config = { binds: [{ source: customHome, target: '/root' }] };
    put(path.join(metadata, 'agents.json'), agents);
    edge.applyEdgeRoutingGeneration({ ...options, reason: 'custom-home' });
    const customQueue = path.join(customHome, path.basename(queue));
    put(customQueue, 'custom canary tasks');
    put(path.join(customHome, '.tasksQueue'), 'custom primary tasks');
    await endCanary({ ...options, routeKey, reason: 'disable', dependencies: f.dependencies });
    assert.ok(!fs.existsSync(customQueue));
    assert.equal(fs.readFileSync(path.join(customHome, '.tasksQueue'), 'utf8'), '"custom primary tasks"');
    assert.ok(fs.existsSync(queue), 'the unmounted home is untouched');
});

test('bare restart recovers its interrupted additive publication before settling workspace starts', async t => {
    seed('withdrawn');
    const routes = source('routing.json');
    const agents = source('agents.json');
    put(path.join(metadata, 'routing.json'), { ...routes, port: 8080 });
    put(path.join(metadata, 'agents.json'), { ...agents, _config: { static: { agent: 'fixtures/alpha', port: 8080 } } });
    edge.applyEdgeRoutingGeneration(options);

    const moduleUrl = new URL('../../cli/sandbox/canary/teardown.mjs', import.meta.url).href;
    const script = 'await (' + interruptPublication.toString() + ')(...JSON.parse(process.argv[1]))';
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script,
        JSON.stringify([moduleUrl, workspaceRoot, path.join(metadata, 'routing.json')])], { timeout: 15000 });
    assert.ifError(killed.error);
    assert.equal(killed.signal, 'SIGKILL');
    assert.equal(edge.readEdgeRoutingPreparationOwner(options).mode, 'additive');

    const { handleCommand } = await import('../../cli/commands/cli.js');
    const rename = fs.renameSync;
    const file = receiptPath(routeKey, options);
    t.mock.method(fs, 'renameSync', (from, to) => {
        // Stop the recovered command at its receipt checkpoint, before any
        // physical runtime or repository work.
        if (to === file && JSON.parse(fs.readFileSync(from)).teardownPublication === null) {
            throw new Error('restart reached canary recovery checkpoint');
        }
        rename(from, to);
    });
    await assert.rejects(handleCommand(['restart']), /restart reached canary recovery checkpoint/);
    assert.equal(edge.readEdgeRoutingPreparationOwner(options), null);
    assert.equal(source('routing.json').routes[routeKey].canary.mode, 'withdrawn');
    assert.equal(source('agents.json')[secondary].containerId, id);
});

test('a failed queue-directory sync leaves the receipt open after unlink and retries it', async t => {
    const f = seed();
    const open = fs.openSync;
    const fsync = fs.fsyncSync;
    let homeFd;
    let attempts = 0;
    t.mock.method(fs, 'openSync', (file, ...args) => {
        const fd = open(file, ...args);
        if (file === home) homeFd = fd;
        return fd;
    });
    t.mock.method(fs, 'fsyncSync', fd => {
        if (fd === homeFd) {
            homeFd = undefined;
            attempts++;
            assert.equal(readReceipt(routeKey, options).terminal, null);
            if (attempts === 1) throw new Error('fixture failed to sync canary home');
        }
        return fsync(fd);
    });
    const args = { ...options, reason: 'shutdown', routeKey, dependencies: f.dependencies };
    await assert.rejects(endCanary(args), /fixture failed to sync canary home/);
    assert.equal(fs.existsSync(queue), false);
    assert.equal(readReceipt(routeKey, options).terminal, null);
    await endCanary(args);
    assert.equal(attempts, 2);
    f.assertClean();
});
