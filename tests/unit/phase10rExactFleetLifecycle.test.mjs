import assert from 'node:assert/strict';
import test from 'node:test';

import {
    stopAndRemoveMany,
    stopConfiguredAgents,
} from '../../cli/sandbox/docker/containerFleet.js';

const OWNED_A = 'a'.repeat(64);
const OWNED_B = 'b'.repeat(64);
const UNRELATED = 'c'.repeat(64);

function record(containerId, suffix) {
    return {
        type: 'agent',
        runtime: 'podman',
        containerId,
        instanceId: `instance-${suffix}`,
        enableGeneration: `generation-${suffix}`,
        releaseGeneration: 'd'.repeat(64),
        agentName: `agent-${suffix}`,
        config: { binds: [] },
    };
}

test('managed stop contains the complete selected fleet under one bounded lock and never targets an unrelated container', () => {
    const registry = {
        ploinky_owned_a: record(OWNED_A, 'a'),
        ploinky_owned_b: record(OWNED_B, 'b'),
        _observe_only: {
            type: 'agent',
            runtime: 'podman',
            containerId: UNRELATED,
            instanceId: 'unrelated-instance',
            enableGeneration: 'unrelated-generation',
        },
    };
    const operations = [];
    const capability = Object.freeze({ selectedFleet: true });
    let lockCalls = 0;

    const stopped = stopConfiguredAgents({
        fast: true,
        removeContainers: true,
        loadRegistry: () => structuredClone(registry),
        reconcileProviderOwnership: () => [],
        networkLockWaitMs: 4_321,
        withLifecycleLock(callback, options) {
            lockCalls += 1;
            assert.deepEqual(options, { waitMs: 4_321 });
            operations.push(['lock-after-contention', options.waitMs]);
            return callback(capability);
        },
        removeContainer(name, selected, runtime, options) {
            operations.push(['remove', name, selected.containerId]);
            assert.equal(runtime, 'podman');
            assert.equal(options.networkLifecycleCapability, capability);
            assert.equal(options.withLock instanceof Function, true);
            assert.match(selected.containerId, /^[a-f0-9]{64}$/);
            assert.notEqual(selected.containerId, UNRELATED);
            return { found: true, stopped: true, removed: true };
        },
        clearContainerLiveness(name) {
            operations.push(['clear', name]);
        },
    });

    assert.equal(lockCalls, 1);
    assert.deepEqual(stopped, ['ploinky_owned_a', 'ploinky_owned_b']);
    assert.deepEqual(stopped.survivors, []);
    assert.deepEqual(operations, [
        ['lock-after-contention', 4_321],
        ['remove', 'ploinky_owned_a', OWNED_A],
        ['clear', 'ploinky_owned_a'],
        ['remove', 'ploinky_owned_b', OWNED_B],
        ['clear', 'ploinky_owned_b'],
    ]);
    assert.equal(JSON.stringify(operations).includes(UNRELATED), false);
});

test('managed stop enriches incomplete selected identity from exact ownership and contains it', () => {
    let lockCalls = 0;
    let removeCalls = 0;
    let removedOwnership = 0;
    let registry = {
        ploinky_incomplete: record('', 'incomplete'),
    };
    const result = stopConfiguredAgents({
        fast: true,
        removeContainers: true,
        removeRegistry: true,
        loadRegistry: () => structuredClone(registry),
        saveRegistry(next) { registry = structuredClone(next); },
        reconcileProviderOwnership: () => [],
        resolveRuntimeOwnership(name, selected) {
            assert.equal(name, 'ploinky_incomplete');
            assert.equal(selected.containerId, '');
            return Object.freeze({ ...selected, containerId: OWNED_A });
        },
        removeRuntimeOwnership(name, containerId) {
            assert.equal(name, 'ploinky_incomplete');
            assert.equal(containerId, OWNED_A);
            removedOwnership += 1;
            return true;
        },
        withLifecycleLock(callback) {
            lockCalls += 1;
            return callback(Object.freeze({ selectedFleet: true }));
        },
        removeContainer(name, selected) {
            assert.equal(name, 'ploinky_incomplete');
            assert.equal(selected.containerId, OWNED_A);
            removeCalls += 1;
            return { found: true, stopped: true, removed: true };
        },
    });

    assert.deepEqual(result, ['ploinky_incomplete']);
    assert.deepEqual(result.survivors, []);
    assert.equal(lockCalls, 1);
    assert.equal(removeCalls, 1);
    assert.equal(removedOwnership, 1);
    assert.deepEqual(registry, {});
});

test('managed stop fails closed on cross-owner ownership without lifecycle commands', () => {
    let lockCalls = 0;
    let removeCalls = 0;
    const result = stopConfiguredAgents({
        loadRegistry: () => ({
            ploinky_selected: record('', 'selected'),
        }),
        reconcileProviderOwnership: () => [],
        resolveRuntimeOwnership() {
            const error = new Error('owner/path mismatch');
            error.code = 'PLOINKY_RUNTIME_OWNERSHIP_CONFLICT';
            throw error;
        },
        withLifecycleLock() { lockCalls += 1; },
        removeContainer() { removeCalls += 1; },
    });

    assert.deepEqual(result, []);
    assert.deepEqual(result.survivors, [{
        runtimeKey: 'ploinky_selected',
        classification: 'registry-invalid',
    }]);
    assert.equal(lockCalls, 0);
    assert.equal(removeCalls, 0);
});

test('selected disable retires exact enriched ownership under one fleet lock', () => {
    const registryRecord = record('', 'disable');
    const operations = [];
    const capability = Object.freeze({ exactDisableFleet: true });
    const removed = stopAndRemoveMany(['ploinky_disable'], {
        records: { ploinky_disable: registryRecord },
        retireRuntimeOwnership: true,
        networkLockWaitMs: 2_468,
        resolveRuntimeOwnership(name, selected) {
            assert.equal(name, 'ploinky_disable');
            return Object.freeze({ ...selected, containerId: OWNED_A });
        },
        withLifecycleLock(callback, options) {
            operations.push(['lock', options.waitMs]);
            return callback(capability);
        },
        removeContainer(name, selected, runtime, options) {
            operations.push(['remove', name, selected.containerId]);
            assert.equal(runtime, 'podman');
            assert.equal(options.networkLifecycleCapability, capability);
            return { found: true, stopped: true, removed: true };
        },
        removeRuntimeOwnership(name, containerId) {
            operations.push(['retire', name, containerId]);
            return true;
        },
    });

    assert.deepEqual(removed, ['ploinky_disable']);
    assert.deepEqual(operations, [
        ['lock', 2_468],
        ['remove', 'ploinky_disable', OWNED_A],
        ['retire', 'ploinky_disable', OWNED_A],
    ]);
});
