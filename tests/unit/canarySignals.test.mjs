import assert from 'node:assert/strict';
import test from 'node:test';

import { runCanaryCommand } from '../../cli/commands/canaryCommand.js';
import { registerProxyOutcomeSink } from '../../cli/server/canary/proxyOutcomes.js';
import { scheduleProbes } from '../../cli/server/canary/probeScheduler.js';
import { CanarySignals } from '../../cli/server/canary/signals.js';
import { recordProxyOutcome } from '../../cli/server/proxy/recordProxyOutcome.js';

const routeKey = 'fixture/app';
const rolloutId = 'rollout-1';
const config = { routeKey, rolloutId, commit: 'a'.repeat(40), share: 10 };
const tenMinutes = 600_000;
const oneDay = 86_400_000;

function fixture(options = {}) {
    let time = Date.UTC(2026, 10, 23);
    const events = [];
    const signals = new CanarySignals({ now: () => time, log: (type, data) => events.push({ type, data }) });
    signals.startRollout({ ...config, ...options });
    function record(copy, outcome, count = 1) {
        for (let index = 0; index < count; index++) {
            signals.recordOutcome({ routeKey, copy, rolloutId, ...outcome });
        }
    }
    return {
        signals, events,
        advance: ms => { time += ms; },
        status: () => signals.status().rollouts.find(row => row.routeKey === routeKey),
        old: (outcome, count) => record('old', outcome, count),
        canary: (outcome, count) => record('canary', outcome, count),
        probe: result => signals.recordProbe(routeKey, rolloutId, result),
    };
}

function assertTrip(f, reason) {
    const status = f.status();
    assert.equal(status.state, 'tripped');
    assert.equal(status.lastTripReason, reason);
    assert.equal(f.events.filter(event => event.type === 'canary_trip').length, 1);
}

test('per-route baseline works without a rollout and expires independently of lifetime counts', () => {
    let time = oneDay;
    const signals = new CanarySignals({ now: () => time, log() {} });
    signals.recordOutcome({ routeKey, status: 503 });
    time += tenMinutes - 1;
    signals.recordOutcome({ routeKey: 'fixture/other', status: 200 });
    const baseline = key => signals.status().baselines.find(row => row.routeKey === key);
    assert.equal(baseline(routeKey).window.backendFailures, 1);
    time += 2;
    assert.equal(baseline(routeKey).window.requests, 0);
    assert.equal(baseline(routeKey).sinceStart.serverErrors, 1);
    assert.equal(baseline('fixture/other').window.requests, 1);
    assert.deepEqual(signals.status().rollouts, []);
});

test('old-copy failures never trip, stale canary outcomes cannot contribute, and caller errors stay separate', () => {
    const f = fixture();
    f.old({ status: 503 }, 20);
    f.canary({ status: 499 }, 6);
    f.canary({ status: 500, rolloutId: 'previous' }, 8);
    f.canary({ status: 500, rolloutId: undefined }, 8);
    f.probe({ ok: false });
    const { state, counts } = f.status();
    assert.equal(state, 'split');
    assert.equal(counts.old.window.backendFailures, 20);
    assert.equal(counts.canary.window.requests, 6);
    assert.equal(counts.canary.window.callerErrors, 6);
    assert.equal(counts.canary.window.backendFailures, 0);
    assert.equal(counts.canary.window.probeFailures, 1);
});

test('MCP backend errors translated to 200 trip on the fifth failure without old traffic', () => {
    const f = fixture();
    f.canary({ status: 200, serverError: true }, 4);
    assert.equal(f.status().state, 'split');
    f.canary({ status: 200, serverError: true });
    assertTrip(f, 'server-errors');
    assert.equal(f.status().counts.canary.sinceStart.serverErrors, 5);
});

test('server error trip requires strictly more than double the old failure rate', () => {
    const f = fixture();
    f.old({ status: 200 }, 90);
    f.old({ status: 500 }, 10);
    f.canary({ status: 200 }, 20);
    f.canary({ status: 500 }, 5);
    assert.equal(f.status().state, 'split'); // 5/25 equals twice 10/100.
    f.canary({ status: 500 });
    assertTrip(f, 'server-errors');
});

test('server error trip also requires strictly more than two additional percentage points', () => {
    const f = fixture();
    f.old({ status: 200 }, 99);
    f.old({ status: 500 });
    f.canary({ status: 200 }, 194);
    f.canary({ status: 500 }, 6);
    assert.equal(f.status().state, 'split'); // 6/200 equals 1/100 plus two points.
    f.canary({ status: 500 });
    assertTrip(f, 'server-errors');
});

test('expired failures drop out of the trip window while lifetime counts persist', () => {
    const f = fixture();
    f.canary({ status: 500 }, 4);
    f.advance(tenMinutes + 1);
    f.canary({ status: 500 }, 4);
    assert.equal(f.status().state, 'split');
    assert.equal(f.status().counts.canary.window.serverErrors, 4);
    assert.equal(f.status().counts.canary.sinceStart.serverErrors, 8);
    f.canary({ status: 500 });
    assertTrip(f, 'server-errors');
});

for (const oldTraffic of [false, true]) {
    const baseline = oldTraffic ? 'with old traffic' : 'without old traffic';

    test('three consecutive connection failures trip ' + baseline, () => {
        const f = fixture();
        if (oldTraffic) f.old({ status: 500 }, 5);
        const refused = { status: 0, unreachable: true, serverError: true };
        f.canary(refused);
        f.canary({ status: 200 });
        f.canary(refused, 2);
        assert.equal(f.status().state, 'split');
        f.canary(refused);
        assertTrip(f, 'unreachable');
        assert.equal(f.status().counts.canary.window.unreachable, 4);
        assert.equal(f.status().counts.canary.window.backendFailures, 4);
    });

    test('three consecutive failed probes trip ' + baseline, () => {
        const f = fixture();
        if (oldTraffic) f.old({ status: 200 });
        f.probe({ ok: false });
        f.probe({ ok: true });
        f.probe({ ok: false });
        f.probe({ ok: false, inspectFailed: true });
        assert.equal(f.status().state, 'split');
        f.probe({ ok: false });
        assertTrip(f, 'probe-failures');
        const counts = f.status().counts.canary.sinceStart;
        assert.equal(counts.probes, 5);
        assert.equal(counts.probeFailures, 4);
        assert.equal(counts.inspectFailures, 1);
        assert.equal(counts.requests, 0);
        assert.equal(counts.backendFailures, 0);
    });

    test('slow responses need a twentieth timing sample ' + baseline, () => {
        const f = fixture();
        if (oldTraffic) f.old({ status: 200, ttfbMs: 20 });
        f.canary({ status: 200, ttfbMs: 5001 }, 19);
        assert.equal(f.status().state, 'split');
        f.canary({ status: 200, ttfbMs: 5001 });
        assertTrip(f, 'slow');
    });

    test('slow share must strictly exceed the rate boundary ' + baseline, () => {
        const f = fixture();
        if (oldTraffic) {
            f.old({ status: 200, ttfbMs: 5000 }, 18);
            f.old({ status: 200, ttfbMs: 5001 }, 2);
        }
        f.canary({ status: 200, ttfbMs: 5000 }, 16);
        f.canary({ status: 200, ttfbMs: 5001 }, 4);
        assert.equal(f.status().counts.canary.window.slowResponses, 4);
        assert.equal(f.status().state, 'split'); // 20%, exactly ten points above a 10% baseline.
        f.canary({ status: 200, ttfbMs: 5001 });
        assertTrip(f, 'slow');
    });
}

for (const change of [{ containerId: 'two' }, { startedAt: '2026-11-23T12:01:00Z' }]) {
    test('changed container ' + Object.keys(change)[0] + ' trips and invalidates a sealed exposure', () => {
        const identity = { containerId: 'one', startedAt: '2026-11-23T12:00:00Z' };
        const f = fixture(identity);
        f.probe({ ok: true, running: true, ...identity });
        f.advance(oneDay);
        const version = f.status().exposureVersion;
        assert.equal(f.signals.seal(routeKey, rolloutId, version), true);
        f.probe({ ok: true, running: true, ...identity, ...change });
        assertTrip(f, 'container-restart');
        assert.equal(f.status().counts.canary.window.restarts, 1);
        assert.notEqual(version, f.status().exposureVersion);
        assert.equal(f.signals.acceptsSeal(routeKey, rolloutId, version), false);
    });
}

test('a stopped container trips on first observation', () => {
    const f = fixture();
    f.probe({ ok: false, running: false });
    assertTrip(f, 'container-exit');
    assert.equal(f.status().counts.canary.window.exits, 1);
});

test('promotion needs a full day at 10%, and changing share invalidates its seal', () => {
    const f = fixture({ share: 0 });
    f.advance(oneDay);
    assert.equal(f.status().promotable, false);
    f.signals.setShare(routeKey, rolloutId, 9);
    f.advance(oneDay);
    assert.equal(f.status().promotable, false);
    f.signals.setShare(routeKey, rolloutId, 10);
    f.advance(oneDay - 1);
    assert.equal(f.status().promotable, false);
    f.advance(1);
    assert.equal(f.status().promotable, true);
    const version = f.status().exposureVersion;
    assert.equal(f.signals.seal(routeKey, 'stale', version), false);
    assert.equal(f.signals.acceptsSeal(routeKey, rolloutId, version), false);
    assert.equal(f.signals.seal(routeKey, rolloutId, version), true);
    assert.equal(f.signals.acceptsSeal(routeKey, rolloutId, version), true);
    assert.equal(f.status().state, 'split');
    f.signals.setShare(routeKey, rolloutId, 15);
    assert.equal(f.status().promotable, false);
    assert.equal(f.signals.acceptsSeal(routeKey, rolloutId, version), false);
    assert.equal(f.signals.seal(routeKey, rolloutId, version), false);
});

test('a fresh Router pauses configured splits and rejects the previous Router seal', () => {
    const f = fixture();
    f.advance(oneDay);
    const version = f.status().exposureVersion;
    assert.equal(f.signals.seal(routeKey, rolloutId, version), true);
    const fresh = new CanarySignals({ now: () => oneDay, log() {} });
    fresh.routerStarted({ [routeKey]: { canary: { ...config, mode: 'split' } } });
    const [row] = fresh.status().rollouts;
    assert.equal(row.state, 'paused');
    assert.equal(row.promotable, false);
    assert.notEqual(row.exposureVersion, version);
    assert.equal(fresh.acceptsSeal(routeKey, rolloutId, version), false);
    fresh.resume(routeKey, rolloutId);
    assert.equal(fresh.status().rollouts[0].state, 'split');
    assert.equal(fresh.status().rollouts[0].promotable, false);
});

test('operator thresholds can change the minimum failure count', () => {
    const f = fixture({ thresholds: { minFailures: 2 } });
    f.canary({ status: 500 });
    assert.equal(f.status().state, 'split');
    f.canary({ status: 500 });
    assertTrip(f, 'server-errors');
});

test('recorded WebSocket uses handshake timing even after a ten-minute connection', t => {
    const f = fixture();
    t.after(registerProxyOutcomeSink(outcome => f.signals.recordOutcome(outcome)));
    const plan = { routeKey, copy: 'canary', rolloutId, transport: 'websocket' };
    const event = recordProxyOutcome({
        plan, outcome: 'success', upstreamStatus: 101, status: 101,
        startedAt: Date.now() - tenMinutes, ttfbMs: 15,
    });
    assert.equal(event.latencyBucket, 'over-15000ms');
    const counts = f.status().counts.canary.window;
    assert.equal(counts.timedResponses, 1);
    assert.equal(counts.slowResponses, 0);
});

test('five proxy 500s produce a single trip and the operator GET returns its status as JSON', async t => {
    const f = fixture();
    t.after(registerProxyOutcomeSink(outcome => f.signals.recordOutcome(outcome)));
    const plan = { routeKey, copy: 'canary', rolloutId };
    const fail = () => recordProxyOutcome({ plan, outcome: 'success', status: 500, upstreamStatus: 500, ttfbMs: 4 });
    for (let i = 0; i < 4; i++) fail();
    assert.equal(f.status().state, 'split');
    fail();
    assertTrip(f, 'server-errors');
    fail();
    const calls = [];
    let stdout = '';
    await runCanaryCommand(['status', '--json'], {
        client: { async json(...args) { calls.push(args); return f.signals.status(); } },
        output: { write(data) { stdout += data; } },
    });
    assert.deepEqual(calls, [['GET', '/api/router/canary/status']]);
    const [row] = JSON.parse(stdout).rollouts;
    assert.equal(row.rolloutId, rolloutId);
    assert.equal(row.routeKey, routeKey);
    assert.equal(row.commit, config.commit);
    assert.equal(row.share, config.share);
    assert.ok(row.splitStartedAt != null);
    assert.equal(row.state, 'tripped');
    assert.equal(row.lastTripReason, 'server-errors');
    assert.equal(row.requestsServed, 6);
    assert.equal(row.counts.canary.sinceStart.serverErrors, 6);
    assert.equal(row.counts.canary.window.backendFailures, 6);
    assert.equal(row.counts.old.window.requests, 0);
    for (const field of ['lastStep', 'intent', 'failurePhase']) assert.ok(Object.hasOwn(row.receipt, field));
    assert.equal(f.events.filter(event => event.type === 'canary_trip').length, 1);
});

test('a known-stopped canary cannot resume until a probe finds it running', () => {
    const f = fixture();
    f.probe({ running: false, ok: false });
    const version = f.status().exposureVersion;
    assert.equal(f.signals.resume(routeKey, rolloutId), false);
    f.probe({ running: false, ok: false });
    assert.equal(f.status().exposureVersion, version);
    assert.equal(f.status().counts.canary.sinceStart.exits, 1);
    f.probe({ running: true, ok: true });
    assert.equal(f.signals.resume(routeKey, rolloutId), true);
});

test('restoration retains the published split time and an unaccepted all is paused', () => {
    const signals = new CanarySignals({ now: () => oneDay });
    const splitStartedAt = new Date(0).toISOString();
    signals.routerStarted({ [routeKey]: { canary: { ...config, splitStartedAt, mode: 'all' } } });
    const [row] = signals.status().rollouts;
    assert.equal(row.state, 'paused');
    assert.equal(row.splitStartedAt, splitStartedAt);
    assert.equal(row.promotable, false);
});

test('a custom slow threshold also applies to old-copy traffic before publication', () => {
    const signals = new CanarySignals();
    signals.recordOutcome({ routeKey, status: 200, ttfbMs: 20 });
    signals.startRollout({ ...config, thresholds: { slowMs: 10, minResponses: 1 } });
    signals.recordOutcome({ routeKey, rolloutId, copy: 'canary', status: 200, ttfbMs: 12 });
    const [row] = signals.status().rollouts;
    assert.equal(row.counts.old.window.slowResponses, 1);
    assert.equal(row.counts.old.sinceStart.slowResponses, 0);
    assert.equal(row.state, 'split');
});

test('recorder distinguishes target down, raw backend status, translated MCP and pre-dial rejection', t => {
    const f = fixture();
    t.after(registerProxyOutcomeSink(event => f.signals.recordOutcome(event)));
    const plan = { routeKey, rolloutId, copy: 'canary' };
    recordProxyOutcome({ plan, outcome: 'failure', status: 502,
        error: Object.assign(new Error(), { code: 'AUTH_REQUIRED' }) });
    recordProxyOutcome({ plan, outcome: 'failure', status: 502, upstreamStatus: 403 });
    recordProxyOutcome({ plan, outcome: 'success', status: 200, serverError: true });
    const oldVersion = f.status().exposureVersion;
    for (let i = 0; i < 3; i++) {
        recordProxyOutcome({ plan, outcome: 'failure', status: 502, relayOutcome: 'failure',
            error: new Error('relayConfinement: container is not running') });
    }
    assertTrip(f, 'unreachable');
    const { counts, exposureVersion } = f.status();
    assert.equal(counts.canary.window.requests, 5);
    assert.equal(counts.canary.window.backendFailures, 4);
    assert.equal(counts.canary.window.serverErrors, 1);
    assert.equal(counts.canary.window.unreachable, 3);
    assert.equal(counts.canary.window.callerErrors, 1);
    assert.equal(counts.canary.window.timedResponses, 0);
    const [epoch, revision] = oldVersion.split(':');
    assert.equal(exposureVersion, `${epoch}:${Number(revision) + 1}`);
});

test('probe scheduler enforces a 30-second cadence and ignores late or cancelled results', async () => {
    const results = [];
    const target = { routeKey, rolloutId, containerId: 'exact' };
    let tick, finishProbe, signal, cleared;
    let calls = 0;
    const stop = scheduleProbes({
        target,
        probe: async (identity, options) => {
            calls++;
            assert.equal(identity, target);
            signal = options.signal;
            return new Promise(resolve => { finishProbe = resolve; });
        },
        observe: result => results.push(result),
        setIntervalFn(fn, ms) { tick = fn; assert.equal(ms, 30_000); return 1; },
        clearIntervalFn(timer) { cleared = timer; },
    });
    const pending = tick();
    await tick();
    await tick();
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
    assert.deepEqual(results, [{ ok: false }, { ok: false }]);
    finishProbe({ ok: true });
    await pending;
    const last = tick();
    stop();
    finishProbe({ ok: true });
    await last;
    assert.equal(cleared, 1);
    assert.equal(calls, 2);
    assert.equal(results.length, 2);
});

test('expiry of an unhealthy baseline can trip a quiet rollout and break its seal', () => {
    const f = fixture();
    f.advance(oneDay);
    const version = f.status().exposureVersion;
    assert.equal(f.signals.seal(routeKey, rolloutId, version), true);
    f.old({ status: 503 });
    f.advance(1);
    f.canary({ status: 503 }, 5);
    assert.equal(f.status().state, 'split');
    f.advance(tenMinutes - 1);
    assert.equal(f.signals.acceptsSeal(routeKey, rolloutId, version), false);
    assertTrip(f, 'server-errors');
});

test('equal-millisecond samples trim correctly after partial expiry, including probe and timing fields', () => {
    const f = fixture();
    f.canary({ status: 200, ttfbMs: 0 }, 3);
    f.probe({ ok: false });
    f.advance(1);
    f.canary({ status: 503, ttfbMs: 6001 }, 2);
    f.advance(tenMinutes - 1);
    const counts = f.status().counts.canary;
    assert.deepEqual([counts.window.requests, counts.window.serverErrors, counts.window.probes,
        counts.window.timedResponses, counts.window.slowResponses], [2, 2, 0, 2, 2]);
    assert.deepEqual([counts.sinceStart.requests, counts.sinceStart.probes,
        counts.sinceStart.timedResponses, counts.sinceStart.slowResponses], [5, 1, 5, 2]);
});

test('a transient threshold crossing between sweeps invalidates the seal', () => {
    const f = fixture();
    f.advance(oneDay);
    const version = f.status().exposureVersion;
    assert.equal(f.signals.seal(routeKey, rolloutId, version), true);
    f.old({ status: 503 });
    f.advance(1);
    f.canary({ status: 503 }, 5);
    f.advance(tenMinutes + 30_000);
    assert.equal(f.signals.acceptsSeal(routeKey, rolloutId, version), false);
    assertTrip(f, 'server-errors');
    assert.equal(f.status().counts.canary.window.requests, 0);
});

test('equal expiry times cannot manufacture an empty-baseline trip', () => {
    const f = fixture();
    f.old({ status: 503 });
    f.canary({ status: 503 }, 5);
    f.advance(tenMinutes);
    assert.equal(f.status().state, 'split');
    assert.equal(f.status().counts.old.window.requests, 0);
});

test('resume acknowledges the old trip and observes a fresh failure', () => {
    const f = fixture();
    f.canary({ status: 500 }, 5);
    assertTrip(f, 'server-errors');
    assert.equal(f.signals.resume(routeKey, rolloutId), true);
    assert.equal(f.status().state, 'split');
    f.canary({ status: 500 });
    assert.equal(f.status().state, 'tripped');
    assert.equal(f.events.filter(event => event.type === 'canary_trip').length, 2);
});

test('a local caller 4xx counts separately without interrupting consecutive backend failures', t => {
    const f = fixture();
    t.after(registerProxyOutcomeSink(event => f.signals.recordOutcome(event)));
    const plan = { routeKey, rolloutId, copy: 'canary' };
    const refused = () => recordProxyOutcome({ plan, outcome: 'failure', status: 502,
        error: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    refused();
    refused();
    recordProxyOutcome({ plan, outcome: 'failure', status: 413,
        error: Object.assign(new Error('request body limit exceeded'), { code: 'REQUEST_TOO_LARGE' }) });
    refused();
    assertTrip(f, 'unreachable');
    const { window } = f.status().counts.canary;
    assert.equal(window.callerErrors, 1);
    assert.equal(window.requests, 3);
    assert.equal(window.unreachable, 3);
    assert.equal(window.responses, 0);
});
