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
        auth: { mode: 'local', usersVar: `PLOINKY_AUTH_${agentName.toUpperCase()}_USERS` },
        ...overrides,
    };
}

function lifecycleHarness({
    initialRegistry,
    initialRouting,
    failRemoval = false,
    failApply = false,
} = {}) {
    let registry = structuredClone(initialRegistry);
    let routing = structuredClone(initialRouting);
    const existing = new Set(Object.keys(registry).filter((key) => key !== '_config'));
    const events = [];
    const removalCalls = [];
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
            return { selector: { state: 'inactive' }, preparationLease: lease };
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
        },
        isSandboxRuntimeImpl() {
            return false;
        },
        stopAndRemoveImpl(containerName, options = {}) {
            events.push(`remove:${containerName}`);
            removalCalls.push({ containerNames: [containerName], options: structuredClone(options) });
            if (failRemoval) throw new Error('engine refused removal');
            existing.delete(containerName);
        },
        stopAndRemoveManyImpl(containerNames, options = {}) {
            events.push(`remove-many:${containerNames.join(',')}`);
            removalCalls.push({ containerNames: [...containerNames], options: structuredClone(options) });
            if (failRemoval) throw new Error('engine refused removal');
            containerNames.forEach((name) => existing.delete(name));
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
    assert.deepEqual(harness.removalCalls, [{
        containerNames: ['old_container'],
        options: { records: { old_container: oldRecord } },
    }]);
    assert.ok(
        harness.events.indexOf('prepare') < harness.events.indexOf('remove:old_container'),
        'the inactive route-removal generation must exist before physical removal',
    );
    assert.ok(
        harness.events.indexOf('remove:old_container') < harness.events.indexOf('apply'),
        'authorization may commit only after physical removal succeeds',
    );
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

test('batch disable stages every exact route removal before one physical batch removal', () => {
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

    const result = agents.disableAgentContainers(
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
        harness.events.indexOf('prepare')
            < harness.events.indexOf('remove-many:beta_container,alpha_container'),
    );
    assert.ok(
        harness.events.indexOf('remove-many:beta_container,alpha_container')
            < harness.events.indexOf('apply'),
    );
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
