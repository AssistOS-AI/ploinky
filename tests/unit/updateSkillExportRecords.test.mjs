import test from 'node:test';
import assert from 'node:assert/strict';

import { skillExportRecoveryProblem } from '../../cli/utils/skills/exportTransaction.mjs';
import { buildCoreUpdateResult, defaultSkillsRecord, skillsManifestRecord } from '../../cli/commands/updateRecords.js';

const defaultRecord = managedExport => defaultSkillsRecord({
    repoName: 'consumer', defaultSkillsRepoName: 'skills', repoPath: '/workspace/consumer', managedExport,
});
const manifestRecord = managedExport => skillsManifestRecord({
    folder: '/workspace/project', manifestPath: '/workspace/project/ploinky-skills-manifest.json',
    label: 'project', result: { managedExport },
});

for (const [label, exported] of [
    ['pending transaction', { transaction: { id: 'pending', status: 'pending' } }],
    ['quarantined transaction', { transaction: { id: 'quarantined', status: 'quarantined', unexpected: [{ name: 'manifest' }] } }],
    ['quarantined recovery followed by a committed publication', { transaction: { id: 'new', status: 'committed' }, recovery: { transaction: 'old', status: 'quarantined' } }],
    ['pending recovery', { transaction: { id: 'new', status: 'unchanged' }, recovery: { transaction: 'old', status: 'pending' } }],
    ['quarantine diagnostic retained by an adapter', { transaction: { id: 'new', status: 'committed' }, diagnostics: [{ name: 'old', reason: 'transaction-quarantined' }] }],
]) {
    test(`${label} remains uncertain through both core result adapters`, () => {
        const problem = skillExportRecoveryProblem(exported);
        assert.equal(problem.code, 'SKILL_EXPORT_RECOVERY_REQUIRED');
        assert.match(problem.reason, /incomplete/);
        assert.deepEqual(problem.transaction, exported.transaction);
        assert.deepEqual(problem.recovery, exported.recovery || null);
        const records = [defaultRecord(exported), manifestRecord(exported)];
        for (const record of records) {
            assert.equal(record.outcome, 'uncertain');
            assert.equal(record.code, problem.code);
            assert.deepEqual(record.details.transaction, exported.transaction);
            assert.deepEqual(record.details.recovery, exported.recovery || null);
        }
        const result = buildCoreUpdateResult({ command: ['update'], records });
        assert.equal(result.exitCode, 1);
        assert.equal(result.activationAllowed, false);
        assert.equal(result.totals.uncertain, 2);
        assert.equal(result.errors.length, 2);
    });
}

for (const [label, exported, outcome] of [
    ['ordinary preserved output', { transaction: { status: 'unchanged' }, diagnostics: [{ name: 'mine', reason: 'edited-output-preserved' }] }, 'unchanged'],
    ['ordinary no-op', { transaction: { status: 'unchanged' }, recovery: { status: 'none' } }, 'unchanged'],
    ['completed recovery and publication', { installed: ['demo'], transaction: { status: 'committed' }, recovery: { status: 'rolled-forward' } }, 'changed'],
    ['completed rollback and no-op', { transaction: { status: 'unchanged' }, recovery: { status: 'rolled-back' } }, 'unchanged'],
]) {
    test(`${label} stays successful through both core result adapters`, () => {
        assert.equal(skillExportRecoveryProblem(exported), null);
        const records = [defaultRecord(exported), manifestRecord(exported)];
        for (const record of records) assert.equal(record.outcome, outcome);
        const result = buildCoreUpdateResult({ command: ['update'], records });
        assert.equal(result.exitCode, 0);
        assert.equal(result.activationAllowed, true);
        assert.deepEqual(result.errors, []);
    });
}

test('manifest records retain canonical source states from the actual sources field', () => {
    const sources = [
        { name: 'workspace-only', state: 'available', path: '/workspace/skills' },
        { name: 'prior-owner', state: 'retained', path: '/workspace/previous' },
        { name: 'missing', state: 'unavailable', reason: 'source-not-refreshed' },
    ];
    const record = skillsManifestRecord({
        folder: '/workspace/project', manifestPath: '/workspace/project/ploinky-skills-manifest.json', label: 'project',
        result: { sources, repos: [{ name: 'registered' }, { name: 'workspace-only' }], managedExport: { transaction: { status: 'unchanged' } } },
    });
    assert.deepEqual(record.details.sourceStates, sources);
    assert.deepEqual(record.details.sources, ['workspace-only', 'prior-owner', 'missing', 'registered']);
    sources[0].path = '/changed-after-record';
    assert.equal(record.details.sourceStates[0].path, '/workspace/skills', 'the record retains its evidence snapshot');
});

test('a thrown export that leaves its journal pending is uncertain, any other throw is failed', () => {
    const pending = Object.assign(new Error('Skill export recovery is required'), { code: 'SKILL_EXPORT_RECOVERY_REQUIRED' });
    const broken = Object.assign(new Error('source missing'), { code: 'SKILL_SOURCE_MISSING' });
    assert.equal(defaultSkillsRecord({ repoName: 'Target', defaultSkillsRepoName: 'Source', error: pending }).outcome, 'uncertain');
    assert.equal(defaultSkillsRecord({ repoName: 'Target', defaultSkillsRepoName: 'Source', error: broken }).outcome, 'failed');
    assert.equal(skillsManifestRecord({ folder: '/w/a', manifestPath: '/w/a/m.json', label: 'a', error: pending }).outcome, 'uncertain');
    assert.equal(skillsManifestRecord({ folder: '/w/a', manifestPath: '/w/a/m.json', label: 'a', error: broken }).outcome, 'failed');
});
