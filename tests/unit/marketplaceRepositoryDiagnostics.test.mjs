import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepositoryDiagnostics, diagnosticPayload, DIAGNOSTIC_LIMITS } from '../../cli/server/marketplaceRepositoryDiagnostics.mjs';

const id = '01234567-89ab-cdef-0123-456789abcdef';
const cause = { source: 'router', phase: 'baseline', reason: 'incomplete', category: 'permission', field: 'namespace', errno: 'EACCES' };

test('first cause survives eviction, caller mutation and loss of the first queued log', () => {
    let now = 0;
    const logs = [];
    const diagnostics = createRepositoryDiagnostics({ now: () => now, sink: (_type, entry) => logs.push(entry) });
    const original = { ...cause };
    diagnostics.retain(id, original, true);
    original.reason = 'shutdown';
    diagnostics.emit();
    logs.length = 0; // the existing logger can lose its initial queued record
    for (let i = 0; i < 1000; i += 1) diagnostics.retain(id, { phase: 'ipc', reason: 'diagnostic-loss' }, true);
    diagnostics.emit();
    assert.equal(logs.length, 0);
    now = 5000;
    diagnostics.emit();
    assert.deepEqual(logs[0].firstCause, { operationId: id, ...cause });
    logs[0].firstCause.reason = 'shutdown';
    const state = diagnostics.snapshot();
    assert.deepEqual(state.firstCause, { operationId: id, ...cause });
    assert.equal(state.recent.length, 32);
    assert.ok(state.bytes <= DIAGNOSTIC_LIMITS.bytes);
    assert.equal(state.suppressed, 1);
    assert.ok(state.loss > 0);
});

test('closed schema drops secrets, unknown fields, large values and nested frames without retaining their contents', () => {
    const diagnostics = createRepositoryDiagnostics();
    for (const payload of [
        { ...cause, stderr: 'SECRET_CANARY' }, { ...cause, reason: 'SECRET_CANARY' },
        { ...cause, unknowns: Array(25).fill({ category: 'permission', field: 'status' }) },
        { ...cause, unknowns: [{ unknowns: [{ category: 'permission' }] }] },
        { ...cause, field: 'SECRET_CANARY'.repeat(10000) },
    ]) {
        assert.equal(diagnosticPayload(payload), null);
        assert.equal(diagnostics.retain(id, payload, true), false);
    }
    assert.equal(diagnostics.snapshot().loss, 5);
    assert.equal(diagnostics.snapshot().firstCause, null);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /SECRET_CANARY/);
});

test('throwing, rejected and stalled sinks do not prevent retained evidence or create unbounded pending writes', async () => {
    for (const sink of [() => { throw new Error('SECRET_CANARY'); }, () => Promise.reject(new Error('SECRET_CANARY'))]) {
        const diagnostics = createRepositoryDiagnostics({ sink });
        diagnostics.retain(id, cause, true);
        assert.doesNotThrow(() => diagnostics.emit());
        await Promise.resolve();
        assert.equal(diagnostics.snapshot().loss, 1);
        assert.deepEqual(diagnostics.snapshot().firstCause, { operationId: id, ...cause });
    }
    let calls = 0;
    let now = 0;
    const diagnostics = createRepositoryDiagnostics({ now: () => now, sink: () => { calls += 1; return new Promise(() => {}); } });
    diagnostics.retain(id, cause, true);
    for (let i = 0; i < 1000; i += 1) { now += 5000; diagnostics.emit(); }
    assert.equal(calls, 1);
    assert.equal(diagnostics.snapshot().suppressed, 999);
});
