import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import * as diagnosticModule from '../../cli/server/marketplaceRepositoryDiagnostics.mjs';
import { createRepositoryDiagnostics, diagnosticPayload, DIAGNOSTIC_LIMITS } from '../../cli/server/marketplaceRepositoryDiagnostics.mjs';

const id = '01234567-89ab-cdef-0123-456789abcdef';
const cause = { source: 'router', phase: 'baseline', reason: 'incomplete', category: 'permission', field: 'namespace', errno: 'EACCES' };
const identity = { pid: 30, birth: '3000', namespace: 'pid:[42]', uids: '1000:1000:1000:1000' };
const fingerprint = createHash('sha256').update('ploinky:repository-process-subject:v1\0')
    .update(JSON.stringify([30, '3000', 'pid:[42]', '1000:1000:1000:1000'])).digest('hex');
const subject = { category: 'permission', field: 'environment', errno: 'EACCES',
    basis: 'prior-stable-identity', subjectFingerprint: fingerprint };

test('guard predicates and bounded observation counts remain a closed diagnostic schema', () => {
    const predicates = ['claim-unresolved', 'claim-expired', 'scan-incomplete', 'flight-expired',
        'flight-stale', 'remembered-invalid', 'cohort-capacity'];
    for (const predicate of predicates) {
        const payload = { predicate, claims: 8192, unresolvedPresent: 8192, unresolvedUnobserved: 8192,
            observationMs: 2147483647, observationBudgetMs: 1000 };
        assert.deepEqual(diagnosticPayload(payload), payload);
    }
    for (const key of ['claims', 'unresolvedPresent', 'unresolvedUnobserved', 'observationMs', 'observationBudgetMs']) {
        const limit = key === 'observationMs' ? 2147483647 : key === 'observationBudgetMs' ? 1000 : 8192;
        assert.deepEqual(diagnosticPayload({ [key]: 0 }), { [key]: 0 });
        for (const value of [-1, 0.5, NaN, Infinity, limit + 1, 'SECRET_CANARY']) {
            assert.equal(diagnosticPayload({ [key]: value }), null);
        }
    }
    const diagnostics = createRepositoryDiagnostics({ sink() { throw Error('SECRET_CANARY'); } });
    assert.equal(diagnostics.retain(id, { predicate: 'claim-unresolved', claims: 1 }, true), true);
    for (const payload of [{ predicate: 'SECRET_CANARY' }, { predicate: 'absence-unconfirmed' },
        { predicate: 'claim-unresolved', pid: 50_001 }, { retiredClaims: 1 },
        { unknowns: [{ predicate: 'claim-unresolved' }] }]) {
        assert.equal(diagnostics.retain(id, payload, true), false);
    }
    for (let i = 0; i < 100; i += 1) diagnostics.retain(id, { predicate: 'flight-expired' }, true);
    diagnostics.emit();
    assert.equal(diagnostics.snapshot().firstCause.predicate, 'claim-unresolved');
    assert.equal(diagnostics.snapshot().recent.length, 32);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /SECRET_CANARY|50001/);
});

test('process fingerprint uses only individually validated canonical identity fields', () => {
    const hash = diagnosticModule.diagnosticProcessFingerprint;
    assert.equal(typeof hash, 'function');
    assert.equal(hash(identity), fingerprint);
    for (const change of [{ pid: 31 }, { birth: '3001' }, { namespace: 'pid:[43]' }, { uids: '1001:1000:1000:1000' }]) {
        assert.notEqual(hash({ ...identity, ...change }), fingerprint);
    }
    const excluded = { ...identity, parent: 99, group: 99, session: 99 };
    for (const key of ['argv', 'environment', 'exe', 'path', 'toJSON']) {
        Object.defineProperty(excluded, key, { enumerable: true, get() { throw new Error('SECRET_CANARY'); } });
    }
    assert.equal(hash(excluded), fingerprint, 'excluded properties must never be read');
    for (const malformed of [null, [], {}, { ...identity, pid: 0 }, { ...identity, pid: 2147483648 },
        { ...identity, pid: '30' }, { ...identity, birth: '03000' }, { ...identity, birth: '1'.repeat(21) },
        { ...identity, namespace: 'pid:[042]' }, { ...identity, uids: '00:0:0:0' },
        { ...identity, uids: '4294967296:0:0:0' }, { ...identity, uids: { toString() { throw Error('SECRET_CANARY'); } } },
        Object.defineProperty({ ...identity }, 'pid', { get() { throw Error('SECRET_CANARY'); } })]) {
        assert.equal(hash(malformed), undefined);
    }
});

test('unknown summary retains only the first eligible subject independently of category counts', () => {
    const summary = diagnosticModule.createUnknownSummary();
    summary.add({ category: 'malformed', field: 'stat' });
    summary.add({ category: 'permission', field: 'environment', errno: 'EACCES' }, fingerprint);
    const first = summary.snapshot();
    assert.deepEqual(first.firstUnknownSubject, subject);
    first.firstUnknownSubject.subjectFingerprint = '0'.repeat(64);
    summary.add({ category: 'permission', field: 'environment', errno: 'EACCES' }, '1'.repeat(64));
    assert.deepEqual(summary.snapshot().firstUnknownSubject, subject);
    assert.equal(summary.snapshot().unknowns[1].count, 2);
    assert.equal(Object.hasOwn(summary.snapshot().unknowns[1], 'subjectFingerprint'), false);
    for (const category of ['io', 'unstable', 'malformed', 'truncated', 'deadline', 'unknown']) {
        for (const field of ['stat', 'namespace', 'status', 'argv', 'none']) summary.add({ category, field }, fingerprint);
    }
    assert.equal(summary.snapshot().unknowns.length, 24);
    assert.equal(summary.snapshot().unknownLoss, 7);
    assert.equal(summary.snapshot().unknowns[0].count, 2, 'the repeated malformed stat category coalesces');
    assert.deepEqual(summary.snapshot().firstUnknownSubject, subject);
    assert.notEqual(summary.snapshot().firstUnknownSubject, summary.snapshot().firstUnknownSubject);
});

test('nested subject closed schema rejects malformed, oversized and prototype-named fields', () => {
    assert.deepEqual(diagnosticPayload({ firstUnknownSubject: subject }), { firstUnknownSubject: subject });
    const diagnostics = createRepositoryDiagnostics();
    const invalid = [null, [], {}, { ...subject, basis: 'current-identity' }, { ...subject, field: 'argv' },
        { ...subject, subjectFingerprint: fingerprint.toUpperCase() }, { ...subject, subjectFingerprint: 'a'.repeat(10000) },
        { ...subject, pid: 30 }, { ...subject, argv: 'SECRET_CANARY' }, { ...subject, errno: 'SECRET_CANARY' },
        ...['constructor', '__proto__', 'toString', 'hasOwnProperty'].map(key => Object.fromEntries([...Object.entries(subject), [key, 'SECRET_CANARY']]))];
    for (const value of invalid) assert.equal(diagnostics.retain(id, { firstUnknownSubject: value }, true), false);
    assert.equal(diagnostics.snapshot().loss, invalid.length);
    assert.equal(diagnostics.snapshot().firstCause, null);
    assert.equal(diagnosticPayload({ unknowns: [{ category: 'permission', firstUnknownSubject: subject }] }), null);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /SECRET_CANARY/);
});

test('subject survives maximum observation envelopes, mutation, flood eviction and later emission', () => {
    let now = 0;
    const logs = [];
    const diagnostics = createRepositoryDiagnostics({ now: () => now, sink: (_type, payload) => logs.push(payload) });
    const original = { source: 'supervisor', phase: 'observation', reason: 'incomplete', state: 'settlement-barrier',
        workspace: 'a'.repeat(64), generation: 'b'.repeat(64), caller: 'agent-assertion', routeLease: true,
        action: 'uninstall_repo', graphReadiness: 'unavailable', deadline: Number.MAX_SAFE_INTEGER,
        elapsedMs: Number.MAX_SAFE_INTEGER, receivedAt: Number.MAX_SAFE_INTEGER, routerElapsedMs: Number.MAX_SAFE_INTEGER,
        records: 8192, members: 8192, writers: 8192, complete: false, unknownLoss: 2147483647,
        unknowns: Array.from({ length: 24 }, () => ({ category: 'disappearance-unconfirmed', field: 'environment', errno: 'EACCES', count: 2147483647 })),
        firstUnknownSubject: { ...subject } };
    assert.equal(diagnostics.retain(id, original, true), true);
    assert.ok(Buffer.byteLength(JSON.stringify(diagnostics.snapshot().firstCause)) <= 4096);
    original.firstUnknownSubject.subjectFingerprint = '0'.repeat(64);
    diagnostics.emit(); logs.length = 0;
    for (let i = 0; i < 1000; i += 1) diagnostics.retain(id, { ...original, firstUnknownSubject: { ...subject, subjectFingerprint: '1'.repeat(64) } }, true);
    assert.ok(diagnostics.snapshot().recent.length <= 32);
    assert.ok(diagnostics.snapshot().bytes <= 65536);
    assert.deepEqual(diagnostics.snapshot().firstCause.firstUnknownSubject, subject);
    diagnostics.emit(); assert.equal(logs.length, 0);
    now = 5000; diagnostics.emit();
    assert.deepEqual(logs[0].firstCause.firstUnknownSubject, subject);
    logs[0].firstCause.firstUnknownSubject.subjectFingerprint = '2'.repeat(64);
    assert.deepEqual(diagnostics.snapshot().firstCause.firstUnknownSubject, subject);
});

test('nested subject accessors retain only the values captured for validation', () => {
    for (const key of Object.keys(subject)) {
        for (const validReads of [1, 2]) {
            let reads = 0;
            const input = Object.defineProperty({ ...subject }, key, { enumerable: true,
                get() { return ++reads <= validReads ? subject[key] : 'CANARY_VALIDATION_READ_CHANGED'; } });
            const diagnostics = createRepositoryDiagnostics();
            assert.equal(diagnostics.retain(id, { firstUnknownSubject: input }, true), true);
            assert.deepEqual(diagnostics.snapshot().firstCause.firstUnknownSubject, subject);
            assert.equal(reads, 1, `read ${key} exactly once`);
            assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /CANARY/);
        }
    }
});

test('throwing nested subject accessors are rejected as diagnostic loss without throwing', () => {
    const diagnostics = createRepositoryDiagnostics();
    for (const key of Object.keys(subject)) {
        const input = Object.defineProperty({ ...subject }, key, { enumerable: true,
            get() { throw new Error('ACCESSOR_SECRET_CANARY'); } });
        assert.equal(diagnosticPayload({ firstUnknownSubject: input }), null);
        assert.equal(diagnostics.retain(id, { firstUnknownSubject: input }, true), false);
    }
    assert.equal(diagnostics.snapshot().loss, Object.keys(subject).length);
    assert.equal(diagnostics.snapshot().firstCause, null);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /CANARY/);
});

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
