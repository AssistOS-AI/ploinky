import assert from 'node:assert/strict';
import test from 'node:test';

import { NETWORK_SCHEMA_VERSION } from '../../cli/sandbox/networkContract.js';
import { NETWORK_LABELS, workspaceNetworkIdentity } from '../../cli/sandbox/networkLifecycle.js';
import {
    createListenerInterfaceClassifier,
    validatedManagedGateway,
} from '../../cli/server/listenerInterfaceClassifier.js';

const workspaceRoot = '/workspace/interface-classifier-fixture';
const workspaceHash = workspaceNetworkIdentity(workspaceRoot).hash;
const networkName = `ploinky-nw-${workspaceHash}-0123456789ab`;

function networkRecord(overrides = {}) {
    return {
        Name: networkName,
        Driver: 'bridge',
        Internal: false,
        IPv6Enabled: false,
        DNSEnabled: true,
        Options: { isolate: 'true' },
        IPAM: { Driver: 'host-local', Options: {} },
        Subnets: [{ Subnet: '10.89.0.0/24', Gateway: '10.89.0.1' }],
        Labels: {
            [NETWORK_LABELS.managed]: '1',
            [NETWORK_LABELS.resource]: 'network',
            [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
            [NETWORK_LABELS.workspace]: workspaceHash,
            [NETWORK_LABELS.logical]: 'fixture',
        },
        ...overrides,
    };
}

test('managed interface classifier admits only exact owned bridge gateways and loopback', async () => {
    const calls = [];
    const run = (args) => {
        calls.push(args);
        if (args[1] === 'ls') return { ok: true, stdout: JSON.stringify([{ Name: networkName }]) };
        return { ok: true, stdout: JSON.stringify([networkRecord()]) };
    };
    const classifier = createListenerInterfaceClassifier({
        workspaceRoot,
        run,
        now: () => 10_000,
        platform: 'linux',
    });

    await classifier.refresh();
    assert.equal(classifier.classify('10.89.0.1'), 'managed');
    assert.equal(classifier.classify('::ffff:10.89.0.1'), 'managed');
    assert.equal(classifier.classify('127.0.0.1'), 'loopback');
    assert.equal(classifier.classify('10.89.0.42'), 'unmanaged');
    assert.deepEqual(classifier.snapshot().gateways, ['10.89.0.1']);
    assert.equal(calls.filter((args) => args[1] === 'ls').length, 1);
});

test('remote-VM host topology does not query or bind VM-only bridge gateways', async () => {
    const calls = [];
    const run = (args) => {
        calls.push(args);
        if (args[1] === 'ls') return { ok: true, stdout: JSON.stringify([{ Name: networkName }]) };
        return { ok: true, stdout: JSON.stringify([networkRecord()]) };
    };
    const classifier = createListenerInterfaceClassifier({
        workspaceRoot,
        run,
        now: () => 10_000,
        platform: 'darwin',
    });

    await classifier.refresh();
    assert.equal(classifier.classify('10.89.0.1'), 'unmanaged');
    assert.equal(classifier.classify('127.0.0.1'), 'loopback');
    assert.deepEqual(classifier.snapshot().gateways, []);
    assert.deepEqual(calls, []);
});

test('managed gateway validation rejects foreign labels and non-exact bridge state', () => {
    const options = { workspaceHash, expectedNamePrefix: `ploinky-nw-${workspaceHash}-` };
    assert.equal(validatedManagedGateway(networkRecord(), options), '10.89.0.1');
    assert.throws(() => validatedManagedGateway(networkRecord({
        Labels: { ...networkRecord().Labels, unexpected: '1' },
    }), options), /exact managed ownership labels/);
    assert.throws(() => validatedManagedGateway(networkRecord({
        Options: { isolate: 'true', mtu: '1500' },
    }), options), /isolate=true/);
    assert.throws(() => validatedManagedGateway(networkRecord({ IPv6Enabled: true }), options), /IPv6/);
});

test('classifier clears previously accepted gateways when runtime inspection fails', async () => {
    let timestamp = 0;
    let fail = false;
    const run = (args) => {
        if (fail) return { ok: false, stderr: 'runtime unavailable' };
        if (args[1] === 'ls') return { ok: true, stdout: JSON.stringify([{ Name: networkName }]) };
        return { ok: true, stdout: JSON.stringify([networkRecord()]) };
    };
    const classifier = createListenerInterfaceClassifier({
        workspaceRoot,
        run,
        now: () => timestamp,
        refreshIntervalMs: 100,
        platform: 'linux',
    });
    await classifier.refresh();
    assert.equal(classifier.classify('10.89.0.1'), 'managed');
    fail = true;
    timestamp = 101;
    // The stale-noticing call still serves the last validated set; the sweep it
    // starts applies fail-closed before the next classification.
    assert.equal(classifier.classify('10.89.0.1'), 'managed');
    await classifier.refresh();
    assert.equal(classifier.classify('10.89.0.1'), 'unmanaged');
    assert.deepEqual(classifier.snapshot().gateways, []);
    assert.match(classifier.snapshot().lastError, /runtime unavailable/);
});

test('classify never blocks the event loop while a runtime sweep is in flight', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const run = async (args) => {
        if (args[1] === 'ls') {
            await gate;
            return { ok: true, stdout: JSON.stringify([{ Name: networkName }]) };
        }
        return { ok: true, stdout: JSON.stringify([networkRecord()]) };
    };
    const classifier = createListenerInterfaceClassifier({
        workspaceRoot,
        run,
        now: () => 10_000,
        platform: 'linux',
    });

    const pending = classifier.refresh();
    // classify() answers immediately from the (empty) cache instead of waiting
    // for Podman, and timers keep firing while the sweep is gated.
    assert.equal(classifier.classify('10.89.0.1'), 'unmanaged');
    let timerFired = false;
    setTimeout(() => { timerFired = true; }, 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(timerFired, true);

    release();
    await pending;
    assert.equal(classifier.classify('10.89.0.1'), 'managed');
});

test('concurrent refresh requests share a single runtime sweep', async () => {
    let lsCalls = 0;
    const run = async (args) => {
        if (args[1] === 'ls') {
            lsCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { ok: true, stdout: JSON.stringify([{ Name: networkName }]) };
        }
        return { ok: true, stdout: JSON.stringify([networkRecord()]) };
    };
    const classifier = createListenerInterfaceClassifier({
        workspaceRoot,
        run,
        now: () => 10_000,
        platform: 'linux',
    });

    await Promise.all([
        classifier.refresh({ force: true }),
        classifier.refresh({ force: true }),
        classifier.refresh(),
    ]);
    assert.equal(lsCalls, 1);
    assert.equal(classifier.classify('10.89.0.1'), 'managed');
});
