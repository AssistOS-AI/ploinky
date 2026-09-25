import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const originalWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-disable-generation-'));
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const agents = await import(new URL('../../cli/utils/agents.js', import.meta.url).href);

test.after(() => {
    process.chdir(originalCwd);
    if (originalWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = originalWorkspaceRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

function agentRecord(agentName, overrides = {}) {
    return {
        type: 'agent',
        repoName: 'demo',
        agentName,
        instanceId: `${agentName}-instance`,
        enableGeneration: `${agentName}-generation`,
        auth: { mode: 'sso' },
        ...overrides,
    };
}

const PRIOR_GENERATION = `sha256:${'c'.repeat(64)}`;

function lifecycleHarness({
    initialRegistry,
    initialRouting,
    failRemoval = false,
    failApply = false,
    failRetirement = false,
    // Per-container outcome reported like stopAndRemoveMany: 'removed',
    // 'refused-untouched', 'refused-touched', or 'absent-name-reused'.
    removalOutcomes = {},
    priorSelector = { state: 'active', generation: PRIOR_GENERATION },
} = {}) {
    let registry = structuredClone(initialRegistry);
    let routing = structuredClone(initialRouting);
    const existing = new Set(Object.keys(registry).filter((key) => key !== '_config'));
    const events = [];
    const removalCalls = [];
    const removeWithOutcomes = (containerNames, options) => {
        const removed = [];
        for (const name of containerNames) {
            const outcome = removalOutcomes[name] || 'removed';
            if (outcome === 'removed') {
                existing.delete(name);
                removed.push(name);
            } else if (outcome === 'refused-untouched' || outcome === 'refused-touched') {
                options.onPreserved?.({
                    name,
                    error: new Error(`${name} ${outcome}`),
                    runtimeTouched: outcome === 'refused-touched',
                });
            }
            // 'absent-name-reused': the recorded ID is gone but a same-named
            // container still exists; nothing is reported as preserved.
        }
        return removed;
    };
    const lease = Object.freeze({
        transactionId: 'disable-lease',
        preparedGeneration: 'sha256:prepared',
        lifecycleBindingDigest: 'sha256:binding',
    });
    const snapshots = [];
    const dependencies = {
        loadAgentsImpl() {
            // Like loadAgents(), every read is a fresh copy of the persisted registry.
            return structuredClone(registry);
        },
        saveAgentsImpl(next) {
            events.push('save-registry');
            registry = structuredClone(next);
        },
        readRoutingImpl() {
            return structuredClone(routing);
        },
        writeRoutingImpl(next) {
            events.push('save-routing');
            routing = structuredClone(next);
        },
        inactivateGeneration(reason) {
            events.push(`inactive:${reason}`);
        },
        retireNoWaitMarkersImpl(entries) {
            events.push(`retire:${entries.map((entry) => (
                typeof entry === 'string' ? entry : entry.containerName
            )).join(',')}`);
            if (failRetirement) throw new Error('marker retirement failed');
            for (const entry of entries) {
                if (typeof entry === 'string') continue;
                const expected = initialRegistry[entry.containerName];
                assert.deepEqual(entry.record, expected);
            }
            return [];
        },
        withApplyLock(callback) {
            events.push('edge-lock');
            return callback(Object.freeze({ testCapability: true }));
        },
        prepareGeneration() {
            events.push('prepare');
            snapshots.push({ registry: structuredClone(registry), routing: structuredClone(routing) });
            return { selector: { state: 'inactive' }, preparationLease: lease };
        },
        applyGeneration(options) {
            if (options.expectedGeneration !== undefined) {
                events.push(`reactivate:${options.expectedGeneration}`);
                assert.equal(options.preparationLease, undefined);
                return { selector: { state: 'active' } };
            }
            events.push('apply');
            assert.equal(options.preparationLease, lease);
            if (failApply) throw new Error('selector commit failed');
            return { selector: { state: 'active' } };
        },
        snapshotSourcesImpl() {
            events.push('snapshot');
            return {
                selector: priorSelector,
                registry: structuredClone(registry),
                routing: structuredClone(routing),
            };
        },
        restoreSourcesImpl(snapshot) {
            events.push('restore');
            registry = structuredClone(snapshot.registry);
            routing = structuredClone(snapshot.routing);
        },
        abortPreparation(received) {
            events.push('abort');
            assert.equal(received, lease);
        },
        isSandboxRuntimeImpl() {
            return false;
        },
        stopAndRemoveImpl(containerName, options = {}) {
            events.push(`remove:${containerName}`);
            assert.equal(typeof options.onPreserved, 'function');
            removalCalls.push({ containerNames: [containerName], options: { records: structuredClone(options.records) } });
            if (failRemoval) throw new Error('engine refused removal');
            return removeWithOutcomes([containerName], options);
        },
        stopAndRemoveManyImpl(containerNames, options = {}) {
            events.push(`remove-many:${containerNames.join(',')}`);
            assert.equal(typeof options.onPreserved, 'function');
            removalCalls.push({ containerNames: [...containerNames], options: { records: structuredClone(options.records) } });
            if (failRemoval) throw new Error('engine refused removal');
            return removeWithOutcomes(containerNames, options);
        },
        containerExistsImpl(containerName) {
            return existing.has(containerName);
        },
    };
    return {
        dependencies,
        events,
        removalCalls,
        snapshots,
        registry: () => registry,
        routing: () => routing,
    };
}

test('single disable commits exact registry and route removal before runtime removal and preserves a reused port owner', async () => {
    const oldRecord = agentRecord('old');
    const currentRecord = agentRecord('current');
    const harness = lifecycleHarness({
        initialRegistry: {
            old_container: oldRecord,
            current_container: currentRecord,
            _config: { unrelated: { retained: true } },
        },
        initialRouting: {
            port: 8080,
            routes: {
                old: {
                    container: 'old_container',
                    repo: 'demo',
                    agent: 'old',
                    hostPort: 31000,
                    serviceTargets: { '9000': 31001 },
                },
                current: {
                    container: 'current_container',
                    repo: 'demo',
                    agent: 'current',
                    hostPort: 31000,
                },
            },
        },
    });

    const result = await agents.disableAgent('old_container', harness.dependencies);
    assert.equal(result.status, 'removed');
    assert.equal(harness.registry().old_container, undefined);
    assert.deepEqual(harness.registry().current_container, currentRecord);
    assert.deepEqual(harness.registry()._config, { unrelated: { retained: true } });
    assert.equal(harness.routing().routes.old, undefined);
    assert.equal(harness.routing().routes.current.hostPort, 31000);
    assert.equal(harness.snapshots[0].routing.routes.old, undefined);
    assert.deepEqual(harness.removalCalls, [{
        containerNames: ['old_container'],
        options: { records: { old_container: oldRecord } },
    }]);
    assert.ok(
        harness.events.indexOf('retire:old_container') < harness.events.indexOf('save-registry'),
        'the exact prior marker must retire before the registry removal is persisted',
    );
    assert.ok(
        harness.events.indexOf('prepare') < harness.events.indexOf('remove:old_container'),
        'the inactive route-removal generation must exist before physical removal',
    );
    assert.ok(
        harness.events.indexOf('remove:old_container') < harness.events.indexOf('apply'),
        'authorization may commit only after physical removal succeeds',
    );
});

test('runtime removal failure leaves the exact removal sources inactive and never restores stale routing', async () => {
    const harness = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old') },
        initialRouting: {
            port: 8080,
            routes: {
                old: { container: 'old_container', repo: 'demo', agent: 'old', hostPort: 32000 },
            },
        },
        failRemoval: true,
    });

    await assert.rejects(
        agents.disableAgent('old_container', harness.dependencies),
        /engine refused removal/,
    );
    assert.equal(harness.registry().old_container, undefined);
    assert.equal(harness.routing().routes.old, undefined);
    assert.equal(harness.events.includes('apply'), false);
    assert.equal(harness.events.includes('abort'), true);
    assert.equal(
        harness.events.some((event) => event === 'inactive:agent-disable-runtime-removal-failed'),
        true,
    );
});

test('selector commit failure after removal remains inactive and releases the exact preparation lease', async () => {
    const harness = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old') },
        initialRouting: {
            port: 8080,
            routes: {
                old: { container: 'old_container', repo: 'demo', agent: 'old', hostPort: 33000 },
            },
        },
        failApply: true,
    });

    await assert.rejects(
        agents.disableAgent('old_container', harness.dependencies),
        /selector commit failed/,
    );
    assert.equal(harness.registry().old_container, undefined);
    assert.equal(harness.routing().routes.old, undefined);
    assert.equal(harness.events.includes('remove:old_container'), true);
    assert.equal(harness.events.includes('abort'), true);
    assert.equal(
        harness.events.some((event) => event === 'inactive:agent-disable-commit-failed'),
        true,
    );
});

test('marker retirement failure leaves routing inactive and prevents every registry, route, runtime, and selector commit', async () => {
    const harness = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old') },
        initialRouting: {
            port: 8080,
            routes: {
                old: { container: 'old_container', repo: 'demo', agent: 'old', hostPort: 33500 },
            },
        },
        failRetirement: true,
    });

    await assert.rejects(
        agents.disableAgent('old_container', harness.dependencies),
        /marker retirement failed/,
    );
    assert.deepEqual(harness.events, [
        'snapshot',
        'edge-lock',
        'inactive:agent-disable-prepare',
        'retire:old_container',
    ]);
    assert.equal(harness.removalCalls.length, 0);
    assert.equal(harness.snapshots.length, 0);
});

test('batch disable stages every exact route removal before one physical batch removal', async () => {
    const alphaRecord = agentRecord('alpha');
    const betaRecord = agentRecord('beta', { alias: 'beta-alias' });
    const harness = lifecycleHarness({
        initialRegistry: {
            alpha_container: alphaRecord,
            beta_container: betaRecord,
        },
        initialRouting: {
            port: 8080,
            routes: {
                alpha: { container: 'alpha_container', repo: 'demo', agent: 'alpha', hostPort: 34000 },
                'beta-alias': {
                    container: 'beta_container',
                    repo: 'demo',
                    agent: 'beta',
                    alias: 'beta-alias',
                    hostPort: 34001,
                },
            },
        },
    });

    const result = await agents.disableAgentContainers(
        ['beta_container', 'alpha_container', 'beta_container'],
        harness.dependencies,
    );
    assert.equal(result.filter((item) => item.status === 'removed').length, 2);
    assert.deepEqual(harness.registry(), {});
    assert.deepEqual(harness.routing().routes, {});
    assert.deepEqual(harness.snapshots[0].routing.routes, {});
    assert.deepEqual(harness.removalCalls, [{
        containerNames: ['beta_container', 'alpha_container'],
        options: {
            records: {
                beta_container: betaRecord,
                alpha_container: alphaRecord,
            },
        },
    }]);
    assert.ok(
        harness.events.indexOf('retire:beta_container,alpha_container')
            < harness.events.indexOf('save-registry'),
        'all exact prior markers retire before the batch registry write',
    );
    assert.ok(
        harness.events.indexOf('prepare')
            < harness.events.indexOf('remove-many:beta_container,alpha_container'),
    );
    assert.ok(
        harness.events.indexOf('remove-many:beta_container,alpha_container')
            < harness.events.indexOf('apply'),
    );
});

test('disable is idempotent after exact removal and empty batch inputs are inert', async () => {
    const harness = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old') },
        initialRouting: {
            port: 8080,
            routes: {
                old: { container: 'old_container', repo: 'demo', agent: 'old', hostPort: 35000 },
            },
        },
    });

    assert.equal((await agents.disableAgent('old_container', harness.dependencies)).status, 'removed');
    const eventCountAfterRemoval = harness.events.length;

    assert.deepEqual(await agents.disableAgent('old_container', harness.dependencies), {
        status: 'not-found',
        requested: 'old_container',
    });
    assert.deepEqual(await agents.disableAgentContainers([], harness.dependencies), []);
    assert.equal(
        harness.events.length,
        eventCountAfterRemoval,
        'already-removed and empty targets must not prepare or apply another generation',
    );
    await assert.rejects(agents.disableAgent('   ', harness.dependencies), /missing agent name/i);
});

function singleAgentRouting(port) {
    return {
        port: 8080,
        routes: { old: { container: 'old_container', repo: 'demo', agent: 'old', hostPort: port } },
    };
}

test('a removal refused before the runtime was touched restores the exact registration and reactivates the prior generation', async () => {
    const initialRegistry = {
        old_container: agentRecord('old'),
        _config: { static: { agent: 'demo/old', port: 8080 } },
    };
    const harness = lifecycleHarness({
        initialRegistry,
        initialRouting: singleAgentRouting(36000),
        removalOutcomes: { old_container: 'refused-untouched' },
    });

    await assert.rejects(
        agents.disableAgent('old_container', harness.dependencies),
        (error) => error.code === 'PLOINKY_AGENT_DISABLE_REFUSED'
            && /was not disabled/.test(error.message)
            && /refused before the runtime was touched/.test(error.message)
            && /registration and routing were restored/.test(error.message),
    );
    assert.deepEqual(harness.registry(), initialRegistry);
    assert.deepEqual(harness.routing(), singleAgentRouting(36000));
    const tail = harness.events.slice(harness.events.indexOf('remove:old_container'));
    assert.deepEqual(tail, [
        'remove:old_container',
        'edge-lock',
        'abort',
        'restore',
        `reactivate:${PRIOR_GENERATION}`,
    ]);
    assert.equal(harness.events.includes('apply'), false);
    assert.equal(harness.events.some((event) => /runtime-removal-failed/.test(event)), false);
});

test('an untouched refusal keeps an already inactive selector inactive after restoring the registration', async () => {
    const harness = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old') },
        initialRouting: singleAgentRouting(36100),
        removalOutcomes: { old_container: 'refused-untouched' },
        priorSelector: { state: 'inactive', previousGeneration: PRIOR_GENERATION },
    });

    await assert.rejects(
        agents.disableAgent('old_container', harness.dependencies),
        /routing generation was not active before this disable and stays inactive/,
    );
    assert.deepEqual(harness.registry(), { old_container: agentRecord('old') });
    assert.equal(harness.events.includes('restore'), true);
    assert.equal(harness.events.some((event) => event.startsWith('reactivate:')), false);
});

for (const [name, options] of [
    ['a refusal after the runtime was signalled', {
        removalOutcomes: { old_container: 'refused-touched' },
    }],
    ['a recorded runtime that vanished while a same-named container exists', {
        removalOutcomes: { old_container: 'absent-name-reused' },
    }],
]) {
    test(`${name} fails closed without restoring the registration`, async () => {
        const harness = lifecycleHarness({
            initialRegistry: { old_container: agentRecord('old') },
            initialRouting: singleAgentRouting(36200),
            ...options,
        });
        await assert.rejects(
            agents.disableAgent('old_container', harness.dependencies),
            (error) => error.code !== 'PLOINKY_AGENT_DISABLE_REFUSED'
                && /failed to stop and remove container/.test(error.message),
        );
        assert.equal(harness.registry().old_container, undefined);
        assert.equal(harness.routing().routes.old, undefined);
        assert.equal(harness.events.includes('restore'), false);
        assert.equal(harness.events.includes('inactive:agent-disable-runtime-removal-failed'), true);
    });
}

test('a batch rolls back only when no runtime in it was touched', async () => {
    const records = { alpha_container: agentRecord('alpha'), beta_container: agentRecord('beta') };
    const routing = {
        port: 8080,
        routes: {
            alpha: { container: 'alpha_container', repo: 'demo', agent: 'alpha', hostPort: 37000 },
            beta: { container: 'beta_container', repo: 'demo', agent: 'beta', hostPort: 37001 },
        },
    };
    const untouched = lifecycleHarness({
        initialRegistry: records,
        initialRouting: routing,
        removalOutcomes: { alpha_container: 'refused-untouched', beta_container: 'refused-untouched' },
    });
    await assert.rejects(
        agents.disableAgentContainers(['alpha_container', 'beta_container'], untouched.dependencies),
        { code: 'PLOINKY_AGENT_DISABLE_REFUSED' },
    );
    assert.deepEqual(untouched.registry(), records);
    assert.deepEqual(untouched.routing(), routing);

    const partial = lifecycleHarness({
        initialRegistry: records,
        initialRouting: routing,
        removalOutcomes: { alpha_container: 'removed', beta_container: 'refused-untouched' },
    });
    await assert.rejects(
        agents.disableAgentContainers(['alpha_container', 'beta_container'], partial.dependencies),
        (error) => error.code !== 'PLOINKY_AGENT_DISABLE_REFUSED'
            && /failed to stop and remove containers/.test(error.message),
    );
    assert.deepEqual(partial.registry(), {});
    assert.equal(partial.events.includes('restore'), false);
    assert.equal(partial.events.includes('inactive:agent-disable-batch-runtime-removal-failed'), true);
});
