import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    buildUpdateResult,
    createOperationRecord,
    createUpdateReportNonce,
    decideUpdateStatus,
    readUpdateReport,
    sanitizeReason,
    summarizeOperations,
    updateReportPath,
    writeUpdateReport,
} from '../../cli/commands/updateOutcome.js';

const record = (outcome, required = false, extra = {}) => createOperationRecord({
    phase: 'registered-repository', id: `repo-${outcome}-${String(required)}`, outcome, required, ...extra,
});

test('complete verified success exits zero and allows activation', () => {
    const decision = decideUpdateStatus([record('changed', true), record('unchanged', true)]);
    assert.deepEqual([decision.status, decision.exitCode, decision.activationAllowed], ['complete', 0, true]);
});

test('optional failures stay nonzero while the verified graph may still activate', () => {
    const decision = decideUpdateStatus([record('changed', true), record('failed', false)]);
    assert.deepEqual([decision.status, decision.exitCode, decision.activationAllowed], ['partial', 1, true]);
    assert.deepEqual(decision.errors.map(entry => entry.outcome), ['failed']);
});

test('a required preserved skip with no failure still blocks activation and exits nonzero', () => {
    const decision = decideUpdateStatus([record('changed', true), record('skipped', true, { code: 'dirty-worktree' })]);
    assert.deepEqual([decision.status, decision.exitCode, decision.activationAllowed], ['failed', 1, false]);
    assert.deepEqual(decision.blockedBy, [{ phase: 'registered-repository', id: 'repo-skipped-true', outcome: 'skipped', code: 'dirty-worktree' }]);
    assert.deepEqual(decision.errors, []);
});

test('unknown graph membership is treated as required', () => {
    const decision = decideUpdateStatus([record('deferred', null)]);
    assert.equal(decision.activationAllowed, false);
    assert.equal(decision.exitCode, 1);
});

test('optional deliberate skips are named without failing the command', () => {
    const decision = decideUpdateStatus([record('changed', true), record('skipped', false)]);
    assert.deepEqual([decision.status, decision.exitCode, decision.activationAllowed], ['complete-with-skips', 0, true]);
});

test('records validate phase and outcome, and totals derive from records', () => {
    assert.throws(() => createOperationRecord({ phase: 'nope', id: 'x', outcome: 'changed' }), /phase/);
    assert.throws(() => createOperationRecord({ phase: 'agentlib', id: 'x', outcome: 'ok' }), /outcome/);
    const records = [record('changed'), record('skipped'), record('failed')];
    assert.deepEqual(summarizeOperations(records), {
        total: 3, attempted: 2, changed: 1, unchanged: 0, skipped: 1, deferred: 0, failed: 1, uncertain: 0,
    });
    assert.equal(record('skipped').attempted, false);
});

test('reasons drop URL credentials and control characters', () => {
    assert.equal(sanitizeReason('fetch https://user:token@example.test/repo.git failed\u0007'),
        'fetch https://example.test/repo.git failed');
});

test('the report round-trips once and every malformed variant is uncertain', t => {
    const ploinkyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-report-'));
    t.after(() => fs.rmSync(ploinkyDir, { recursive: true, force: true }));
    const context = { workspace: '/w', scope: 'all', generation: 'g1' };
    const result = buildUpdateResult({ command: ['update'], records: [record('changed', true)], context, agentLib: { changed: false } });
    const nonce = createUpdateReportNonce();
    assert.equal(readUpdateReport(ploinkyDir, nonce).code, 'report-missing');
    writeUpdateReport(ploinkyDir, nonce, result);
    assert.throws(() => writeUpdateReport(ploinkyDir, nonce, result), { code: 'EEXIST' }, 'duplicate publication fails');
    const read = readUpdateReport(ploinkyDir, nonce, { expectedContext: context });
    assert.equal(read.ok, true);
    assert.deepEqual(read.result.agentLib, { changed: false });
    assert.equal(readUpdateReport(ploinkyDir, nonce, { expectedContext: { ...context, generation: 'g2' } }).code, 'report-context-mismatch');

    const filename = updateReportPath(ploinkyDir, nonce);
    const original = fs.readFileSync(filename, 'utf8');
    fs.writeFileSync(filename, original.slice(0, 20));
    assert.equal(readUpdateReport(ploinkyDir, nonce).code, 'report-truncated');
    fs.writeFileSync(filename, original + original);
    assert.equal(readUpdateReport(ploinkyDir, nonce).code, 'report-truncated');
    const envelope = JSON.parse(original);
    fs.writeFileSync(filename, `${JSON.stringify({ ...envelope, nonce: createUpdateReportNonce() })}\n`);
    assert.equal(readUpdateReport(ploinkyDir, nonce).code, 'report-nonce-mismatch');
    fs.writeFileSync(filename, `${JSON.stringify({ ...envelope, result: { ...envelope.result, exitCode: 0, activationAllowed: true, records: [{ ...envelope.result.records[0], outcome: 'failed' }] } })}\n`);
    assert.equal(readUpdateReport(ploinkyDir, nonce).code, 'report-inconsistent');
    assert.equal(readUpdateReport(ploinkyDir, 'not-a-nonce').code, 'report-nonce-invalid');
});
