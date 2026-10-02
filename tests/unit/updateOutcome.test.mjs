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
import { skillsManifestRecord } from '../../cli/commands/updateRecords.js';

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

// Host aggregation: the host recomputes the decision from the in-Box records
// (readUpdateReport) and again over its own records plus the core's. Source
// failures reach it as ordinary failed/uncertain skills-manifest records, so
// no host code knows about skill sources.
function sourceFailureRecord({ required, sourceOutcome = 'failed' }) {
    const base = skillsManifestRecord({
        folder: '/workspace/project', manifestPath: '/workspace/project/ploinky-skills-manifest.json', label: 'project',
        result: {
            skills: [], managedExport: { transaction: { status: 'unchanged' } },
            sourceStates: [{ name: 'Missing', checkoutPath: '/workspace/.ploinky/repos/Missing', state: 'retained',
                sourceOutcome, code: 'source-unavailable', reason: 'fatal: repository does not exist' }],
        },
    });
    return createOperationRecord({ ...base, required });
}

for (const [sourceOutcome, expectedOutcome] of [['failed', 'failed'], ['uncertain', 'uncertain']]) {
    test(`a ${sourceOutcome} skill source crosses the host report and host aggregation unchanged (required)`, t => {
        const ploinkyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-report-source-'));
        t.after(() => fs.rmSync(ploinkyDir, { recursive: true, force: true }));
        const core = [record('changed', true), sourceFailureRecord({ required: true, sourceOutcome })];
        assert.equal(core[1].outcome, expectedOutcome);
        const context = { workspace: '/w', scope: 'all', generation: 'g1' };
        const result = buildUpdateResult({ command: ['update'], records: core, context });
        assert.deepEqual([result.exitCode, result.activationAllowed, result.status], [1, false, 'failed']);
        const nonce = createUpdateReportNonce();
        writeUpdateReport(ploinkyDir, nonce, result);
        const read = readUpdateReport(ploinkyDir, nonce, { expectedContext: context });
        assert.equal(read.ok, true, 'the host recomputation matches the core decision');
        const hostRecords = [
            createOperationRecord({ phase: 'host-ploinky', id: '/host', outcome: 'unchanged', required: false }),
            ...read.result.records,
        ];
        const aggregated = decideUpdateStatus(hostRecords);
        assert.equal(aggregated.activationAllowed, false, 'a required source failure never reaches the restart');
        assert.equal(aggregated.exitCode, 1);
        assert.deepEqual(aggregated.blockedBy.map(entry => [entry.phase, entry.outcome, entry.code]),
            [['skills-manifest', expectedOutcome, core[1].code]]);
        assert.deepEqual(aggregated.errors.map(entry => entry.outcome), [expectedOutcome]);
        assert.equal(read.result.records[1].details.sourceStates[0].sourceOutcome, sourceOutcome, 'source evidence survives the report');
    });
}

test('an optional failed skill source stays nonzero through the host report while activation stays allowed', t => {
    const ploinkyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-report-source-'));
    t.after(() => fs.rmSync(ploinkyDir, { recursive: true, force: true }));
    const context = { workspace: '/w', scope: 'all', generation: 'g1' };
    const result = buildUpdateResult({ command: ['update'], records: [record('changed', true), sourceFailureRecord({ required: false })], context });
    assert.deepEqual([result.exitCode, result.activationAllowed, result.status], [1, true, 'partial']);
    const nonce = createUpdateReportNonce();
    writeUpdateReport(ploinkyDir, nonce, result);
    const read = readUpdateReport(ploinkyDir, nonce, { expectedContext: context });
    assert.equal(read.ok, true);
    const aggregated = decideUpdateStatus(read.result.records);
    assert.deepEqual([aggregated.exitCode, aggregated.activationAllowed, aggregated.status], [1, true, 'partial']);
});

test('unknown membership keeps a failed skill source conservative through aggregation', () => {
    const aggregated = decideUpdateStatus([record('changed', true), sourceFailureRecord({ required: null })]);
    assert.deepEqual([aggregated.exitCode, aggregated.activationAllowed], [1, false]);
});
