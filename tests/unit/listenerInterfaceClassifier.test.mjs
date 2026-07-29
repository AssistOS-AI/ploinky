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
    let calls = 0;
    const run = (args) => {
        calls += 1;
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
    assert.equal(calls, 2);
    fail = true;
    timestamp = 101;
    // Expired snapshots deny immediately and classification never starts I/O.
    assert.equal(classifier.classify('10.89.0.1'), 'unmanaged');
    assert.equal(calls, 2);
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

test('start primes the first managed classification before readiness', async () => {
    const scheduled = [];
    const cancelled = [];
    const run = (args) => {
        if (args[1] === 'ls') return { ok: true, stdout: JSON.stringify([{ Name: networkName }]) };
        return { ok: true, stdout: JSON.stringify([networkRecord()]) };
    };
    const classifier = createListenerInterfaceClassifier({
        workspaceRoot,
        run,
        now: () => 10_000,
        platform: 'linux',
        schedule(callback, delay) {
            const token = { callback, delay, unref() {} };
            scheduled.push(token);
            return token;
        },
        cancelSchedule(token) {
            cancelled.push(token);
        },
    });

    const snapshot = await classifier.start();
    assert.deepEqual(snapshot.gateways, ['10.89.0.1']);
    assert.equal(classifier.classify('10.89.0.1'), 'managed');
    assert.equal(scheduled.length, 1);
    assert.ok(scheduled[0].delay > 0 && scheduled[0].delay < 1_000);

    await classifier.close();
    assert.deepEqual(cancelled, [scheduled[0]]);
});

test('startup rejects if close aborts the priming sweep', async () => {
    let sweepStarted;
    const started = new Promise((resolve) => { sweepStarted = resolve; });
    const classifier = createListenerInterfaceClassifier({
        workspaceRoot,
        platform: 'linux',
        run(_args, { signal }) {
            sweepStarted();
            return new Promise((resolve) => {
                signal.addEventListener('abort', () => {
                    resolve({ ok: false, stderr: 'aborted' });
                }, { once: true });
            });
        },
    });

    const starting = classifier.start();
    await started;
    const closing = classifier.close();
    await assert.rejects(starting, /closed during startup/);
    await closing;
    assert.deepEqual(classifier.snapshot().gateways, []);
});

test('expired snapshot denies while a failing refresh remains in flight', async () => {
    let timestamp = 0;
    let release;
    let fail = false;
    const run = async (args) => {
        if (args[1] === 'ls' && fail) {
            await new Promise((resolve) => { release = resolve; });
            return { ok: false, stderr: 'runtime unavailable' };
        }
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

    await classifier.refresh({ force: true });
    assert.equal(classifier.classify('10.89.0.1'), 'managed');
    timestamp = 100;
    fail = true;
    const pending = classifier.refresh({ force: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(classifier.classify('10.89.0.1'), 'unmanaged');
    release();
    await pending;
    assert.equal(classifier.classify('10.89.0.1'), 'unmanaged');
    assert.match(classifier.snapshot().lastError, /runtime unavailable/);
});

test('one batch inspection must exactly match every listed managed network', async () => {
    const secondName = `ploinky-nw-${workspaceHash}-fedcba987654`;
    const secondRecord = networkRecord({
        Name: secondName,
        Subnets: [{ Subnet: '10.90.0.0/24', Gateway: '10.90.0.1' }],
        Labels: {
            ...networkRecord().Labels,
            [NETWORK_LABELS.logical]: 'fixture-two',
        },
    });
    const calls = [];
    const classifier = createListenerInterfaceClassifier({
        workspaceRoot,
        platform: 'linux',
        now: () => 0,
        run(args) {
            calls.push(args);
            if (args[1] === 'ls') {
                return {
                    ok: true,
                    stdout: JSON.stringify([{ Name: secondName }, { Name: networkName }]),
                };
            }
            return {
                ok: true,
                stdout: JSON.stringify([secondRecord, networkRecord()]),
            };
        },
    });

    await classifier.refresh({ force: true });
    assert.deepEqual(classifier.snapshot().gateways, ['10.89.0.1', '10.90.0.1']);
    assert.deepEqual(calls, [
        ['network', 'ls', '--format', 'json'],
        ['network', 'inspect', networkName, secondName],
    ]);
});

test('a successful refresh removes gateways for networks no longer listed', async () => {
    let present = true;
    const classifier = createListenerInterfaceClassifier({
        workspaceRoot,
        platform: 'linux',
        now: () => 0,
        run(args) {
            if (args[1] === 'ls') {
                return {
                    ok: true,
                    stdout: JSON.stringify(present ? [{ Name: networkName }] : []),
                };
            }
            return { ok: true, stdout: JSON.stringify([networkRecord()]) };
        },
    });

    await classifier.refresh({ force: true });
    assert.equal(classifier.classify('10.89.0.1'), 'managed');

    present = false;
    await classifier.refresh({ force: true });
    assert.equal(classifier.classify('10.89.0.1'), 'unmanaged');
    assert.deepEqual(classifier.snapshot().gateways, []);
});

test('close aborts an active sweep and schedules no trailing work', async () => {
    let observedSignal;
    let scheduled = 0;
    const classifier = createListenerInterfaceClassifier({
        workspaceRoot,
        platform: 'linux',
        run(_args, { signal }) {
            observedSignal = signal;
            return new Promise((resolve) => {
                signal.addEventListener('abort', () => {
                    resolve({ ok: false, stderr: 'aborted' });
                }, { once: true });
            });
        },
        schedule() {
            scheduled += 1;
            return { unref() {} };
        },
        cancelSchedule() {},
    });

    const pending = classifier.refresh({ force: true });
    await new Promise((resolve) => setImmediate(resolve));
    await classifier.close();
    await pending;
    assert.equal(observedSignal.aborted, true);
    assert.equal(scheduled, 0);
    assert.deepEqual(classifier.snapshot().gateways, []);
});

test('background refresh schedules only after the active sweep settles', async () => {
    const scheduled = [];
    let background = false;
    let release;
    const run = async (args) => {
        if (args[1] === 'ls' && background) {
            await new Promise((resolve) => { release = resolve; });
        }
        if (args[1] === 'ls') return { ok: true, stdout: JSON.stringify([{ Name: networkName }]) };
        return { ok: true, stdout: JSON.stringify([networkRecord()]) };
    };
    const classifier = createListenerInterfaceClassifier({
        workspaceRoot,
        run,
        now: () => 0,
        refreshIntervalMs: 100,
        platform: 'linux',
        schedule(callback, delay) {
            const token = { callback, delay, unref() {} };
            scheduled.push(token);
            return token;
        },
        cancelSchedule() {},
    });

    await classifier.start();
    assert.equal(scheduled.length, 1);
    background = true;
    scheduled[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduled.length, 1);
    assert.equal(classifier.snapshot().refreshing, true);

    release();
    while (scheduled.length < 2) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(classifier.snapshot().refreshing, false);
    await classifier.close();
});

test('failed startup is fail closed and a later background sweep recovers', async () => {
    const scheduled = [];
    let fail = true;
    const classifier = createListenerInterfaceClassifier({
        workspaceRoot,
        platform: 'linux',
        now: () => 0,
        refreshIntervalMs: 100,
        run(args) {
            if (fail) return { ok: false, stderr: 'runtime unavailable' };
            if (args[1] === 'ls') return { ok: true, stdout: JSON.stringify([{ Name: networkName }]) };
            return { ok: true, stdout: JSON.stringify([networkRecord()]) };
        },
        schedule(callback, delay) {
            const token = { callback, delay, unref() {} };
            scheduled.push(token);
            return token;
        },
        cancelSchedule() {},
    });

    const initial = await classifier.start();
    assert.deepEqual(initial.gateways, []);
    assert.match(initial.lastError, /runtime unavailable/);
    assert.equal(classifier.classify('10.89.0.1'), 'unmanaged');
    assert.equal(scheduled.length, 1);

    fail = false;
    scheduled[0].callback();
    while (scheduled.length < 2) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(classifier.classify('10.89.0.1'), 'managed');
    await classifier.close();
});

test('partial or mismatched batch inspection publishes no gateway', async () => {
    const secondName = `ploinky-nw-${workspaceHash}-fedcba987654`;
    const classifier = createListenerInterfaceClassifier({
        workspaceRoot,
        platform: 'linux',
        now: () => 0,
        run(args) {
            if (args[1] === 'ls') {
                return {
                    ok: true,
                    stdout: JSON.stringify([{ Name: networkName }, { Name: secondName }]),
                };
            }
            return { ok: true, stdout: JSON.stringify([networkRecord()]) };
        },
    });

    await classifier.refresh({ force: true });
    assert.deepEqual(classifier.snapshot().gateways, []);
    assert.match(classifier.snapshot().lastError, /did not match/);
    assert.equal(classifier.classify('10.89.0.1'), 'unmanaged');
});

test('classifier rejects invalid refresh intervals and scheduler dependencies', () => {
    assert.throws(
        () => createListenerInterfaceClassifier({ refreshIntervalMs: 0 }),
        /refresh interval must be positive/,
    );
    assert.throws(
        () => createListenerInterfaceClassifier({ schedule: null }),
        /scheduler must be callable/,
    );
});
