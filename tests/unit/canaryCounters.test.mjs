import assert from 'node:assert/strict';
import test from 'node:test';

import { SignalCounts, WINDOW_MS } from '../../cli/server/canary/counters.js';

const request = ['requests', 'responses'];

test('the ring retains both partial seconds and reuses expired seconds across multiple windows', () => {
    const counts = new SignalCounts(100);
    const times = [];
    for (let second = 0; second < 1_300; second++) {
        for (const offset of [0, 999]) {
            const now = second * 1_000 + offset;
            counts.record(now, request, offset);
            times.push(now);
            if (second < 598) continue;
            const active = times.filter(at => at > now - WINDOW_MS);
            assert.equal(counts.current(now).requests, active.length);
            assert.equal(counts.current(now).slowResponses, active.filter(at => at % 1_000 === 999).length);
            assert.equal(counts.nextExpiry(), active[0] + WINDOW_MS);
        }
    }
    const final = counts.snapshot(times.at(-1) + WINDOW_MS);
    assert.equal(final.window.requests, 0);
    assert.equal(final.sinceStart.requests, times.length);
    assert.equal(counts.nextExpiry(), Infinity);
});

test('seeding at any proxy latency edge uses the exact strictly greater share', () => {
    const edges = [10, 50, 100, 250, 500, 1_000, 5_000, 15_000];
    const latencies = [0, ...edges.flatMap(edge => [edge - 0.1, edge, edge + 0.1]), 60_000];
    const baseline = new SignalCounts(5_000);
    for (const timing of latencies) baseline.record(125, request, timing);
    baseline.record(125, request);
    for (const threshold of edges) {
        const old = new SignalCounts(threshold);
        old.seedWindow(baseline, 126);
        const { window, sinceStart } = old.snapshot(126);
        assert.equal(window.requests, latencies.length + 1);
        assert.equal(window.timedResponses, latencies.length);
        assert.equal(window.slowResponses, latencies.filter(ms => ms > threshold).length);
        assert.equal(sinceStart.requests, 0);
    }
});

test('same-millisecond timings in one proxy bin retain exact custom ranks at low diversity', () => {
    const baseline = new SignalCounts(5_000);
    for (const ms of [20, 20, 25, 35, 40, 40]) baseline.record(200, request, ms);
    const old = new SignalCounts(30);
    old.seedWindow(baseline, 200);
    assert.equal(old.current(200).slowResponses, 3);
    const minCutoff = new SignalCounts(20);
    minCutoff.seedWindow(baseline, 200);
    assert.equal(minCutoff.current(200).slowResponses, 4);
    baseline.record(200, request, 41);
    old.record(201, request, 35);
    old.record(201, request, 30);
    assert.equal(old.current(201).slowResponses, 4);
    assert.equal(old.current(201).timedResponses, 8);
    assert.equal(old.current(200 + WINDOW_MS).slowResponses, 1);
    assert.equal(old.snapshot(200 + WINDOW_MS).sinceStart.timedResponses, 2);
});

test('a custom cutoff inside an overflowed historical bin credits guaranteed slow responses', () => {
    const baseline = new SignalCounts(5_000);
    for (let timing = 11; timing <= 50; timing++) baseline.record(200, request, timing);
    baseline.record(200, request, 50);
    baseline.record(201, request, 31);
    const old = new SignalCounts(30);
    old.seedWindow(baseline, 201);
    // The 11..50 bin overflowed at t=200. Both maxima and the singleton at t=201 exceed 30.
    assert.equal(old.current(201).slowResponses, 3);
    old.record(201, request, 32);
    assert.equal(old.current(201).slowResponses, 4);
    assert.equal(old.current(200 + WINDOW_MS).slowResponses, 2);
    assert.equal(baseline.current(200 + WINDOW_MS).timedResponses, 1);
});

test('a seeded small burst can gain more metrics in the same millisecond and expire together', () => {
    const baseline = new SignalCounts(5_000);
    baseline.record(100, ['callerErrors']);
    for (let i = 0; i < 4; i++) {
        baseline.record(101, ['probes', 'inspectFailures']);
        baseline.record(101, request, 15 + i);
    }
    const old = new SignalCounts(16);
    old.seedWindow(baseline, 101);
    old.record(101, ['requests', 'unreachable'], 17);
    old.record(102, request, 12);
    const { window, sinceStart } = old.snapshot(100 + WINDOW_MS);
    assert.equal(window.requests, 6);
    assert.equal(window.callerErrors, 0);
    assert.equal(window.probes, 4);
    assert.equal(window.inspectFailures, 4);
    assert.equal(window.unreachable, 1);
    assert.equal(window.slowResponses, 3);
    assert.equal(sinceStart.requests, 2);
    assert.equal(old.current(101 + WINDOW_MS).requests, 1);
    assert.equal(old.current(101 + WINDOW_MS).slowResponses, 0);
    assert.equal(baseline.current(101).unreachable, 0);
});
