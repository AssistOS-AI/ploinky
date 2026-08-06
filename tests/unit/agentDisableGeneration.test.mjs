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
        runtime: 'podman',
        containerId: 'a'.repeat(64),
        repoName: 'demo',
        agentName,
        instanceId: `${agentName}-instance`,
        enableGeneration: `${agentName}-generation`,
        auth: { mode: 'local', usersVar: `PLOINKY_AUTH_${agentName.toUpperCase()}_USERS` },
        ...overrides,
    };
}

function lifecycleHarness({
    initialRegistry,
    initialRouting,
    failRemoval = false,
    failApply = false,
    failAbort = false,
    activePreparedSelector = false,
} = {}) {
    let registry = structuredClone(initialRegistry);
    let routing = structuredClone(initialRouting);
    const existing = new Set(Object.keys(registry).filter((key) => key !== '_config'));
    const events = [];
    const lease = Object.freeze({
        transactionId: 'disable-lease',
        preparedGeneration: 'sha256:prepared',
        lifecycleBindingDigest: 'sha256:binding',
    });
    const snapshots = [];
    const dependencies = {
        loadAgentsImpl() {
            return registry;
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
        withApplyLock(callback) {
            events.push('edge-lock');
            return callback(Object.freeze({ testCapability: true }));
        },
        prepareGeneration() {
            events.push('prepare');
            snapshots.push({ registry: structuredClone(registry), routing: structuredClone(routing) });
            return {
                selector: { state: activePreparedSelector ? 'active' : 'inactive' },
                preparationLease: lease,
            };
        },
        applyGeneration(options) {
            events.push('apply');
            assert.equal(options.preparationLease, lease);
            if (failApply) throw new Error('selector commit failed');
            return { selector: { state: 'active' } };
        },
        abortPreparation(received) {
            events.push('abort');
            assert.equal(received, lease);
            if (failAbort) throw new Error('durable disable abort failed');
        },
        reconcileProviderOwnershipImpl() {
            events.push('reconcile-provider-ownership');
            return [];
        },
        stopAndRemoveImpl(containerName, options) {
            events.push(`remove:${containerName}`);
            assert.deepEqual(options?.records, {
                [containerName]: initialRegistry[containerName],
            });
            assert.equal(options?.retireRuntimeOwnership, true);
            if (failRemoval) throw new Error('engine refused removal');
            existing.delete(containerName);
        },
        stopAndRemoveManyImpl(containerNames, options) {
            events.push(`remove-many:${containerNames.join(',')}`);
            assert.deepEqual(
                options?.records,
                Object.fromEntries(containerNames.map((name) => [name, initialRegistry[name]])),
            );
            assert.equal(options?.retireRuntimeOwnership, true);
            if (failRemoval) throw new Error('engine refused removal');
            containerNames.forEach((name) => existing.delete(name));
        },
        containerExistsImpl(containerName, options) {
            assert.deepEqual(options, { runtime: 'podman' });
            return existing.has(containerName);
        },
        stopSandboxImpl(containerName, options) {
            events.push(`stop-sandbox:${containerName}`);
            assert.deepEqual(options, {
                expectedIdentity: {
                    instanceId: initialRegistry[containerName].instanceId,
                    enableGeneration: initialRegistry[containerName].enableGeneration,
                },
            });
            existing.delete(containerName);
        },
        sandboxRunningImpl(containerName, expectedIdentity) {
            assert.deepEqual(expectedIdentity, {
                instanceId: initialRegistry[containerName].instanceId,
                enableGeneration: initialRegistry[containerName].enableGeneration,
            });
            return existing.has(containerName);
        },
    };
    return {
        dependencies,
        events,
        snapshots,
        registry: () => registry,
        routing: () => routing,
    };
}

test('single disable commits exact registry and route removal before runtime removal and preserves a reused port owner', () => {
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

    const result = agents.disableAgent('old_container', harness.dependencies);
    assert.equal(result.status, 'removed');
    assert.equal(harness.registry().old_container, undefined);
    assert.deepEqual(harness.registry().current_container, currentRecord);
    assert.deepEqual(harness.registry()._config, { unrelated: { retained: true } });
    assert.equal(harness.routing().routes.old, undefined);
    assert.equal(harness.routing().routes.current.hostPort, 31000);
    assert.equal(harness.snapshots[0].routing.routes.old, undefined);
    assert.ok(
        harness.events.indexOf('reconcile-provider-ownership')
            < harness.events.indexOf('inactive:agent-disable-prepare'),
        'provider ownership must reconcile before disable invalidates and removes the selected runtime',
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

test('single disable fails closed before generation mutation when provider ownership is unreconciled', () => {
    const harness = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old') },
        initialRouting: { port: 8080, routes: {} },
    });
    harness.dependencies.reconcileProviderOwnershipImpl = () => {
        const error = new Error('provider ownership mixed-generation');
        error.code = 'PLOINKY_PROVIDER_TASK_LIFECYCLE_UNRECONCILED';
        throw error;
    };
    assert.throws(
        () => agents.disableAgent('old_container', harness.dependencies),
        { code: 'PLOINKY_PROVIDER_TASK_LIFECYCLE_UNRECONCILED' },
    );
    assert.deepEqual(harness.registry().old_container, agentRecord('old'));
    assert.equal(harness.events.length, 0);
});

test('runtime removal failure leaves the exact removal sources inactive and never restores stale routing', () => {
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

    assert.throws(
        () => agents.disableAgent('old_container', harness.dependencies),
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

test('runtime removal abort failure preserves the exact preparation and propagates recovery evidence', () => {
    const harness = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old') },
        initialRouting: {
            port: 8080,
            routes: {
                old: { container: 'old_container', repo: 'demo', agent: 'old', hostPort: 32500 },
            },
        },
        failRemoval: true,
        failAbort: true,
    });

    assert.throws(
        () => agents.disableAgent('old_container', harness.dependencies),
        (error) => (
            error?.code === 'PLOINKY_RECOVERY_ABORT_FAILED'
            && error.cause?.message === 'durable disable abort failed'
            && /engine refused removal/.test(error.originalFailure?.message)
            && Object.isFrozen(error.ploinkyRecoveryPreparation)
            && error.ploinkyRecoveryPreparation?.preparationLease?.transactionId === 'disable-lease'
            && error.ploinkyRecoveryPreparation?.preparationAbortFailed === true
            && error.ploinkyRecoveryPreparation?.preparationAbortedBeforeCleanup === false
        ),
    );
    assert.equal(harness.events.filter((event) => event === 'abort').length, 1);
    assert.equal(harness.events.includes('apply'), false);
    assert.equal(harness.events.at(-1), 'abort');
});

test('invalid active prepared selector aborts its exact lease before runtime removal or apply', () => {
    const harness = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old') },
        initialRouting: {
            port: 8080,
            routes: {
                old: { container: 'old_container', repo: 'demo', agent: 'old', hostPort: 32700 },
            },
        },
        activePreparedSelector: true,
    });

    assert.throws(
        () => agents.disableAgent('old_container', harness.dependencies),
        /prepared route-removal generation did not remain inactive/,
    );
    assert.equal(harness.events.filter((event) => event === 'abort').length, 1);
    assert.equal(harness.events.some((event) => event.startsWith('remove:')), false);
    assert.equal(harness.events.includes('apply'), false);
    assert.deepEqual(harness.events.slice(-2), ['prepare', 'abort']);
});

test('invalid active prepared selector abort failure preserves its exact preparation evidence', () => {
    const harness = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old') },
        initialRouting: {
            port: 8080,
            routes: {
                old: { container: 'old_container', repo: 'demo', agent: 'old', hostPort: 32800 },
            },
        },
        activePreparedSelector: true,
        failAbort: true,
    });

    assert.throws(
        () => agents.disableAgent('old_container', harness.dependencies),
        (error) => (
            error?.code === 'PLOINKY_RECOVERY_ABORT_FAILED'
            && error.cause?.message === 'durable disable abort failed'
            && /prepared route-removal generation did not remain inactive/.test(
                error.originalFailure?.message,
            )
            && Object.isFrozen(error.ploinkyRecoveryPreparation)
            && error.ploinkyRecoveryPreparation?.preparationLease?.transactionId === 'disable-lease'
            && error.ploinkyRecoveryPreparation?.reason === 'agent-disable-prepare-invalid'
            && error.ploinkyRecoveryPreparation?.preparationAbortFailed === true
            && error.ploinkyRecoveryPreparation?.preparationAbortedBeforeCleanup === false
        ),
    );
    assert.equal(harness.events.filter((event) => event === 'abort').length, 1);
    assert.equal(harness.events.some((event) => event.startsWith('remove:')), false);
    assert.equal(harness.events.includes('apply'), false);
    assert.equal(harness.events.at(-1), 'abort');
});

test('selector commit failure after removal remains inactive and releases the exact preparation lease', () => {
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

    assert.throws(
        () => agents.disableAgent('old_container', harness.dependencies),
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

test('selector commit abort failure is not downgraded to the selector error or retried', () => {
    const harness = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old') },
        initialRouting: {
            port: 8080,
            routes: {
                old: { container: 'old_container', repo: 'demo', agent: 'old', hostPort: 33500 },
            },
        },
        failApply: true,
        failAbort: true,
    });

    assert.throws(
        () => agents.disableAgent('old_container', harness.dependencies),
        (error) => (
            error?.code === 'PLOINKY_RECOVERY_ABORT_FAILED'
            && error.cause?.message === 'durable disable abort failed'
            && error.originalFailure?.message === 'selector commit failed'
            && Object.isFrozen(error.ploinkyRecoveryPreparation)
            && error.ploinkyRecoveryPreparation?.reason === 'agent-disable-commit-failed'
        ),
    );
    assert.equal(harness.events.filter((event) => event === 'abort').length, 1);
    assert.equal(harness.events.at(-1), 'abort');
});

test('batch disable stages every exact route removal before one physical batch removal', () => {
    const harness = lifecycleHarness({
        initialRegistry: {
            alpha_container: agentRecord('alpha'),
            beta_container: agentRecord('beta', { alias: 'beta-alias' }),
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

    const result = agents.disableAgentContainers(
        ['beta_container', 'alpha_container', 'beta_container'],
        harness.dependencies,
    );
    assert.equal(result.filter((item) => item.status === 'removed').length, 2);
    assert.deepEqual(harness.registry(), {});
    assert.deepEqual(harness.routing().routes, {});
    assert.deepEqual(harness.snapshots[0].routing.routes, {});
    assert.ok(
        harness.events.indexOf('prepare')
            < harness.events.indexOf('remove-many:beta_container,alpha_container'),
    );
    assert.ok(
        harness.events.indexOf('remove-many:beta_container,alpha_container')
            < harness.events.indexOf('apply'),
    );
});

test('sandbox disable binds stop and liveness checks to the captured generation identity', () => {
    const sandboxRecord = agentRecord('sandbox', {
        runtime: 'bwrap',
        containerId: undefined,
    });
    const harness = lifecycleHarness({
        initialRegistry: { sandbox_runtime: sandboxRecord },
        initialRouting: {
            port: 8080,
            routes: {
                sandbox: {
                    container: 'sandbox_runtime',
                    repo: 'demo',
                    agent: 'sandbox',
                    hostPort: 34500,
                },
            },
        },
    });

    assert.equal(agents.disableAgent('sandbox_runtime', harness.dependencies).status, 'removed');
    assert.equal(harness.events.includes('stop-sandbox:sandbox_runtime'), true);
    assert.equal(harness.events.some((event) => event.startsWith('remove:')), false);
});

test('disable is idempotent after exact removal and empty batch inputs are inert', () => {
    const harness = lifecycleHarness({
        initialRegistry: { old_container: agentRecord('old') },
        initialRouting: {
            port: 8080,
            routes: {
                old: { container: 'old_container', repo: 'demo', agent: 'old', hostPort: 35000 },
            },
        },
    });

    assert.equal(agents.disableAgent('old_container', harness.dependencies).status, 'removed');
    const eventCountAfterRemoval = harness.events.length;

    assert.deepEqual(agents.disableAgent('old_container', harness.dependencies), {
        status: 'not-found',
        requested: 'old_container',
    });
    assert.deepEqual(agents.disableAgentContainers([], harness.dependencies), []);
    assert.equal(
        harness.events.length,
        eventCountAfterRemoval,
        'already-removed and empty targets must not prepare or apply another generation',
    );
    assert.throws(() => agents.disableAgent('   ', harness.dependencies), /missing agent name/i);
});
