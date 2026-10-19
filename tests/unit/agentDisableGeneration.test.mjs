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
    // A withdrawal refusal code makes the disable fall back to the inactive
    // route-removal staging; by default the routes are withdrawn from the
    // active generation before any runtime is touched.
    withdrawalRefusal = null,
    // Preparation owners reported before each withdrawal attempt; the last
    // entry repeats. A non-null owner makes the attempt busy.
    preparationOwners = [null],
} = {}) {
    let registry = structuredClone(initialRegistry);
    let routing = structuredClone(initialRouting);
    let selectorState = priorSelector?.state || 'inactive';
    const selectorAtRemoval = [];
    let ownerReads = 0;
    const existing = new Set(Object.keys(registry).filter((key) => key !== '_config'));
    const events = [];
    const removalCalls = [];
    const removeWithOutcomes = (containerNames, options) => {
        selectorAtRemoval.push(selectorState);
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
            selectorState = 'inactive';
        },
        readPreparationOwner() {
            const owner = preparationOwners[Math.min(ownerReads, preparationOwners.length - 1)];
            ownerReads += 1;
            return owner;
        },
        commitWithdrawal({ withdraw, routing: nextRouting, agents: nextAgents, applyLockCapability }) {
            events.push(`withdraw:${withdraw.map((entry) => `${entry.mode}:${entry.containerName}`).join(',')}`);
            assert.ok(applyLockCapability, 'the withdrawal runs under the edge apply lock');
            if (withdrawalRefusal) {
                const error = new Error(`withdrawal refused: ${withdrawalRefusal}`);
                error.code = withdrawalRefusal;
                throw error;
            }
            registry = structuredClone(nextAgents);
            routing = structuredClone(nextRouting);
            selectorState = 'active';
            return { selector: { state: 'active' } };
        },
        disableBusyRetryMs: 1,
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
                selectorState = 'active';
                return { selector: { state: 'active' } };
            }
            events.push('apply');
            assert.equal(options.preparationLease, lease);
            if (failApply) throw new Error('selector commit failed');
            selectorState = 'active';
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
        selectorAtRemoval,
        selectorState: () => selectorState,
        registry: () => registry,
        routing: () => routing,
    };
}

const FALLBACK = Object.freeze({ withdrawalRefusal: 'EDGE_WITHDRAWAL_NOT_SUBSET' });

test('single disable commits exact registry and route removal before runtime removal and preserves a reused port owner (fallback staging)', async () => {
    const oldRecord = agentRecord('old');
    const currentRecord = agentRecord('current');
    const harness = lifecycleHarness({
        ...FALLBACK,
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

test('runtime removal failure leaves the exact removal sources inactive and never restores stale routing (fallback staging)', async () => {
    const harness = lifecycleHarness({
        ...FALLBACK,
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

test('selector commit failure after removal remains inactive and releases the exact preparation lease (fallback staging)', async () => {
    const harness = lifecycleHarness({
        ...FALLBACK,
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

test('marker retirement failure prevents every registry, route, runtime, and selector change', async () => {
    for (const options of [{}, FALLBACK]) {
        const harness = lifecycleHarness({
            ...options,
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
            'retire:old_container',
        ]);
        assert.equal(harness.selectorState(), 'active', 'the active generation is never withdrawn or inactivated');
        assert.deepEqual(harness.registry(), { old_container: agentRecord('old') });
        assert.equal(harness.removalCalls.length, 0);
        assert.equal(harness.snapshots.length, 0);
    }
});

test('batch disable stages every exact route removal before one physical batch removal (fallback staging)', async () => {
    const alphaRecord = agentRecord('alpha');
    const betaRecord = agentRecord('beta', { alias: 'beta-alias' });
    const harness = lifecycleHarness({
        ...FALLBACK,
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

test('disable is idempotent after exact removal and empty batch inputs are inert (fallback staging)', async () => {
    const harness = lifecycleHarness({
        ...FALLBACK,
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

test('a removal refused before the runtime was touched restores the exact registration and reactivates the prior generation (fallback staging)', async () => {
    const initialRegistry = {
        old_container: agentRecord('old'),
        _config: { static: { agent: 'demo/old', port: 8080 } },
    };
    const harness = lifecycleHarness({
        ...FALLBACK,
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

test('an untouched refusal keeps an already inactive selector inactive after restoring the registration (fallback staging)', async () => {
    const harness = lifecycleHarness({
        ...FALLBACK,
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
    test(`${name} fails closed without restoring the registration (fallback staging)`, async () => {
        const harness = lifecycleHarness({
            ...FALLBACK,
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

test('a batch rolls back only when no runtime in it was touched (fallback staging)', async () => {
    const records = { alpha_container: agentRecord('alpha'), beta_container: agentRecord('beta') };
    const routing = {
        port: 8080,
        routes: {
            alpha: { container: 'alpha_container', repo: 'demo', agent: 'alpha', hostPort: 37000 },
            beta: { container: 'beta_container', repo: 'demo', agent: 'beta', hostPort: 37001 },
        },
    };
    const untouched = lifecycleHarness({
        ...FALLBACK,
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
        ...FALLBACK,
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

test('disabling a native runtime reports it removed only after its exact process is observed gone (fallback staging)', async () => {
    const record = agentRecord('native', { runtime: 'seatbelt' });
    const routing = {
        port: 8080,
        routes: { native: { container: 'native_container', repo: 'demo', agent: 'native', hostPort: 33000 } },
    };
    const calls = [];
    const sandboxDependencies = (harness, { before, after }) => ({
        ...harness.dependencies,
        isSandboxRuntimeImpl: (runtime) => runtime === 'seatbelt',
        stopSandboxImpl: (name) => { calls.push(['stop', name]); return false; },
        sandboxRunningImpl: () => false,
        // The first observation precedes any signal; the second follows the stop.
        sandboxObserveImpl: (() => {
            let n = 0;
            return () => (n++ === 0 ? before : after);
        })(),
    });

    // A runtime whose owner cannot be verified refuses before anything is
    // signalled, and the registration is restored with the process still tracked.
    const unverifiable = lifecycleHarness({ ...FALLBACK, initialRegistry: { native_container: record }, initialRouting: routing });
    await assert.rejects(
        agents.disableAgent('native_container', sandboxDependencies(unverifiable, {
            before: { state: 'unknown', reason: 'identity-probe-failed', record: null },
            after: { state: 'unknown', reason: 'identity-probe-failed', record: null },
        })),
        (error) => error.code === 'PLOINKY_AGENT_DISABLE_REFUSED',
    );
    assert.deepEqual(calls, [], 'nothing was signalled');
    assert.deepEqual(unverifiable.registry().native_container, record, 'the registration is restored');
    assert.equal(unverifiable.events.includes('restore'), true);
    assert.equal(unverifiable.events.includes('apply'), false);

    // A stop that does not end the process is not a removal.
    const survivor = lifecycleHarness({ ...FALLBACK, initialRegistry: { native_container: record }, initialRouting: routing });
    await assert.rejects(
        agents.disableAgent('native_container', sandboxDependencies(survivor, {
            before: { state: 'live-exact', reason: 'live', record: null },
            after: { state: 'live-exact', reason: 'live', record: null },
        })),
        /still running or its stop could not be verified/,
    );
    assert.deepEqual(calls, [['stop', 'native_container']]);
    assert.equal(survivor.events.includes('apply'), false, 'authorization is never committed over an unverified stop');

    const gone = lifecycleHarness({ ...FALLBACK, initialRegistry: { native_container: record }, initialRouting: routing });
    const result = await agents.disableAgent('native_container', sandboxDependencies(gone, {
        before: { state: 'live-exact', reason: 'live', record: null },
        after: { state: 'absent', reason: 'no-record', record: null },
    }));
    assert.equal(result.status, 'removed');
    assert.equal(gone.events.includes('apply'), true);
});

test('A7 a disable withdraws routes and registration from the active generation before any runtime is touched', async () => {
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
                old: { container: 'old_container', repo: 'demo', agent: 'old', hostPort: 31000 },
                current: { container: 'current_container', repo: 'demo', agent: 'current', hostPort: 31000 },
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
    assert.deepEqual(harness.selectorAtRemoval, ['active'], 'the selector is active while the runtime is removed');
    assert.equal(harness.selectorState(), 'active');
    assert.deepEqual(harness.events.filter((event) => event.startsWith('inactive:')), [], 'nothing inactivates the edge');
    assert.equal(harness.events.includes('prepare'), false);
    assert.equal(harness.events.includes('apply'), false);
    assert.ok(harness.events.indexOf('retire:old_container') < harness.events.indexOf('withdraw:remove:old_container'));
    assert.ok(harness.events.indexOf('withdraw:remove:old_container') < harness.events.indexOf('remove:old_container'));
});

test('A7 a runtime removal failure after the withdrawal keeps the selector active and reports the runtime for cleanup', async () => {
    const harness = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old', { containerId: 'old-id' }) },
        initialRouting: singleAgentRouting(32000),
        failRemoval: true,
    });

    await assert.rejects(
        agents.disableAgent('old_container', harness.dependencies),
        (error) => error.code === 'PLOINKY_AGENT_DISABLE_RUNTIME_ORPHANED'
            && /engine refused removal/.test(error.message)
            && error.cleanupReceipt.runtimes[0].containerName === 'old_container'
            && error.cleanupReceipt.runtimes[0].containerId === 'old-id',
    );
    assert.equal(harness.registry().old_container, undefined);
    assert.equal(harness.routing().routes.old, undefined);
    assert.equal(harness.selectorState(), 'active');
    assert.deepEqual(harness.events.filter((event) => event.startsWith('inactive:')), []);
    assert.equal(harness.events.includes('abort'), false);
    assert.equal(harness.events.includes('restore'), false);
});

test('A7 an untouched removal refusal after the withdrawal restores the registration and the exact prior generation', async () => {
    const initialRegistry = { old_container: agentRecord('old') };
    const harness = lifecycleHarness({
        initialRegistry,
        initialRouting: singleAgentRouting(36000),
        removalOutcomes: { old_container: 'refused-untouched' },
    });
    await assert.rejects(
        agents.disableAgent('old_container', harness.dependencies),
        (error) => error.code === 'PLOINKY_AGENT_DISABLE_REFUSED'
            && /registration and routing were restored/.test(error.message),
    );
    assert.deepEqual(harness.registry(), initialRegistry);
    assert.deepEqual(harness.routing(), singleAgentRouting(36000));
    const tail = harness.events.slice(harness.events.indexOf('remove:old_container'));
    assert.deepEqual(tail, ['remove:old_container', 'edge-lock', 'restore', `reactivate:${PRIOR_GENERATION}`]);
});

test('A7 a batch disable withdraws every runtime in one commit before one physical batch removal', async () => {
    const alphaRecord = agentRecord('alpha');
    const betaRecord = agentRecord('beta');
    const harness = lifecycleHarness({
        initialRegistry: { alpha_container: alphaRecord, beta_container: betaRecord },
        initialRouting: {
            port: 8080,
            routes: {
                alpha: { container: 'alpha_container', repo: 'demo', agent: 'alpha', hostPort: 34000 },
                beta: { container: 'beta_container', repo: 'demo', agent: 'beta', hostPort: 34001 },
            },
        },
    });
    const result = await agents.disableAgentContainers(['beta_container', 'alpha_container'], harness.dependencies);
    assert.equal(result.filter((item) => item.status === 'removed').length, 2);
    assert.deepEqual(harness.events.filter((event) => event.startsWith('withdraw:')), [
        'withdraw:remove:beta_container,remove:alpha_container',
    ]);
    assert.deepEqual(harness.selectorAtRemoval, ['active']);
    assert.deepEqual(harness.events.filter((event) => event.startsWith('inactive:')), []);
});

test('A7 a disable waits for an outstanding preparation outside its locks, then withdraws; a timeout changes nothing', async () => {
    const waiting = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old') },
        initialRouting: singleAgentRouting(38000),
        preparationOwners: [{ pid: 1, mode: 'additive' }, { pid: 1, mode: 'additive' }, null],
    });
    let leaseHolds = 0;
    const result = await agents.disableAgent('old_container', {
        ...waiting.dependencies,
        withWorkspaceLeaseImpl: async (_options, callback) => { leaseHolds += 1; return callback(); },
        withNetworkLockImpl: async (callback) => callback(),
    });
    assert.equal(result.status, 'removed');
    assert.equal(leaseHolds, 3, 'each busy attempt releases the locks before retrying');
    assert.deepEqual(waiting.events.filter((event) => event.startsWith('retire:')), ['retire:old_container'],
        'a busy attempt retires nothing');
    assert.deepEqual(waiting.selectorAtRemoval, ['active']);

    const timedOut = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old') },
        initialRouting: singleAgentRouting(38100),
        preparationOwners: [{ pid: 1, mode: 'additive' }],
    });
    await assert.rejects(
        agents.disableAgent('old_container', {
            ...timedOut.dependencies,
            workspaceLeaseWaitMs: 20,
            withWorkspaceLeaseImpl: async (_options, callback) => callback(),
            withNetworkLockImpl: async (callback) => callback(),
        }),
        { code: 'EDGE_PREPARATION_BUSY' },
    );
    assert.deepEqual(timedOut.registry(), { old_container: agentRecord('old') });
    assert.equal(timedOut.events.some((event) => event.startsWith('retire:') || event.startsWith('withdraw:')), false);
});
