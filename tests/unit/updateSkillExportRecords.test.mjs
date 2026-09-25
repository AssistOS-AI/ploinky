import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { currentSkillExportIdentity, readSkillExportTransactionState, skillExportRecoveryProblem } from '../../cli/utils/skills/exportTransaction.mjs';
import { syncManagedSkillExports } from '../../cli/utils/skills/managedExports.js';
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

// Real exporter state: a pre-commit failure is labelled by what its rollback
// left behind, through the Ploinky export entry point both core adapters use.
function exportFixture(t, label) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `update-export-${label}-`)));
    const folder = path.join(root, 'consumer');
    const skills = path.join(folder, '.agents', 'skills');
    t.after(() => {
        try { fs.chmodSync(skills, 0o755); } catch (_) {}
        fs.rmSync(root, { recursive: true, force: true });
    });
    for (const version of ['v1', 'v2']) {
        fs.mkdirSync(path.join(root, version, 'demo'), { recursive: true });
        fs.writeFileSync(path.join(root, version, 'demo', 'SKILL.md'), `# demo ${version}\n`);
    }
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'user notes\n');
    const sync = (version, afterMove = null, lock = {}) => syncManagedSkillExports({
        folder, owner: 'defaults:skills', afterMove, lock: { waitMs: 0, ...lock },
        sources: [{ name: 'demo', path: path.join(root, version, 'demo'), source: { name: 'skills' } }],
    });
    sync('v1');
    const thrown = (afterMove, lock = {}) => {
        try { sync('v2', afterMove, lock); } catch (error) { return error; }
        assert.fail('the export was expected to throw');
    };
    const records = error => [
        defaultSkillsRecord({ repoName: 'consumer', defaultSkillsRepoName: 'skills', repoPath: folder, error }),
        skillsManifestRecord({ folder, manifestPath: path.join(folder, 'ploinky-skills-manifest.json'), label: 'consumer', error }),
    ];
    const state = () => readSkillExportTransactionState(folder);
    const lockPath = path.join(folder, '.agents', '.ploinky-skill-exports.lock');
    // A stray file in the freshly created lock directory makes its release
    // fail (ENOTEMPTY) whatever the export itself does.
    const strayLock = { liveness: { current: () => {
        if (fs.existsSync(lockPath)) fs.writeFileSync(path.join(lockPath, 'stray'), 'stray\n');
        return currentSkillExportIdentity();
    } } };
    return { root, folder, skills, sync, thrown, records, state, lockPath, strayLock };
}

const injected = () => Object.assign(new Error('injected failure after move'), { code: 'INJECTED' });

test('a pre-commit export failure whose rollback stops is uncertain, keeps the original error and is recovered next time',
    { skip: process.getuid?.() === 0 ? 'a read-only directory does not stop root' : false }, t => {
        const f = exportFixture(t, 'pending');
        const error = f.thrown(() => {
            fs.chmodSync(f.skills, 0o555);
            throw injected();
        });
        fs.chmodSync(f.skills, 0o755);
        assert.equal(error.code, 'SKILL_EXPORT_RECOVERY_REQUIRED');
        assert.equal(error.cause.code, 'INJECTED');
        assert.equal(error.rollbackError.code, 'EACCES');
        assert.equal(f.state().pending?.transaction, error.transaction, 'the journal stays pending');
        for (const record of f.records(error)) {
            assert.equal(record.outcome, 'uncertain');
            assert.equal(record.code, 'SKILL_EXPORT_RECOVERY_REQUIRED');
            assert.match(record.reason, /injected failure after move.*EACCES.*remains pending/s);
            assert.equal(record.details.errorCode, 'SKILL_EXPORT_RECOVERY_REQUIRED');
            assert.deepEqual(record.details.recovery, { status: 'pending', transaction: error.transaction });
        }
        const result = buildCoreUpdateResult({ command: ['update'], records: f.records(error) });
        assert.equal(result.totals.uncertain, 2);
        assert.equal(result.exitCode, 1);
        assert.equal(result.activationAllowed, false);
        assert.equal(fs.readFileSync(path.join(f.folder, 'notes.txt'), 'utf8'), 'user notes\n');
        const next = f.sync('v2');
        assert.equal(next.recovery.status, 'rolled-back');
        assert.equal(fs.realpathSync(path.join(f.skills, 'demo')), path.join(f.root, 'v2', 'demo'));
        assert.equal(f.state().pending, null);
    });

test('a pre-commit export failure whose rollback quarantines output is uncertain and keeps the user bytes', t => {
    const f = exportFixture(t, 'quarantine');
    const error = f.thrown(({ destination }) => {
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'user.txt'), 'user bytes\n');
        throw injected();
    });
    assert.equal(error.code, 'INJECTED', 'the original error is rethrown');
    assert.equal(error.skillExportRecovery.status, 'quarantined');
    const state = f.state();
    assert.equal(state.pending, null);
    assert.deepEqual(state.quarantined.map(item => item.transaction), [error.skillExportRecovery.transaction]);
    for (const record of f.records(error)) {
        assert.equal(record.outcome, 'uncertain');
        assert.equal(record.code, 'SKILL_EXPORT_RECOVERY_REQUIRED');
        assert.match(record.reason, /^injected failure after move; skill export transaction .* was quarantined/);
        assert.equal(record.details.errorCode, 'INJECTED');
        assert.deepEqual(record.details.recovery, { status: 'quarantined', transaction: error.skillExportRecovery.transaction });
    }
    assert.equal(fs.readFileSync(path.join(f.skills, 'demo', 'user.txt'), 'utf8'), 'user bytes\n');
    const next = f.sync('v2');
    assert.ok(next.diagnostics.some(item => item.name === 'demo' && item.reason === 'edited-output-preserved'));
    assert.equal(fs.readFileSync(path.join(f.skills, 'demo', 'user.txt'), 'utf8'), 'user bytes\n');
});

test('a pre-commit export failure that rolls back cleanly stays failed with its own code', t => {
    const f = exportFixture(t, 'clean');
    const error = f.thrown(() => { throw injected(); });
    assert.equal(error.code, 'INJECTED');
    assert.equal(error.skillExportRecovery.status, 'rolled-back');
    assert.deepEqual(f.state(), { pending: null, quarantined: [], lock: 'free' });
    assert.equal(fs.realpathSync(path.join(f.skills, 'demo')), path.join(f.root, 'v1', 'demo'), 'the prior output is restored');
    for (const record of f.records(error)) {
        assert.equal(record.outcome, 'failed');
        assert.equal(record.code, 'INJECTED');
        assert.equal(record.reason, 'injected failure after move');
        assert.deepEqual(record.details.recovery, { status: 'rolled-back', transaction: error.skillExportRecovery.transaction });
    }
    assert.equal(f.sync('v2').installed[0], 'demo');
});

// A lock release failure never replaces the outcome already in flight, and a
// release failure after settled outputs is failed, not a recovery.
function stopRollback(f) {
    const backups = path.join(f.folder, '.agents', '.ploinky-export-backups');
    const aside = path.join(f.root, 'backups-aside');
    return {
        afterMove: () => {
            fs.renameSync(backups, aside);
            fs.writeFileSync(backups, 'not a directory\n');
            throw injected();
        },
        restore: () => { fs.rmSync(backups); fs.renameSync(aside, backups); },
    };
}

test('a pending export whose lock release also fails stays uncertain with both problems', t => {
    const f = exportFixture(t, 'pending-release');
    const stop = stopRollback(f);
    const error = f.thrown(stop.afterMove, f.strayLock);
    stop.restore();
    assert.equal(error.code, 'SKILL_EXPORT_RECOVERY_REQUIRED');
    assert.equal(error.skillExportRecovery.status, 'pending');
    assert.equal(error.cause.code, 'INJECTED');
    assert.equal(error.lockReleaseError.code, 'ENOTEMPTY');
    for (const record of f.records(error)) {
        assert.equal(record.outcome, 'uncertain');
        assert.equal(record.code, 'SKILL_EXPORT_RECOVERY_REQUIRED');
        assert.equal(record.details.lockReleaseCode, 'ENOTEMPTY');
        assert.match(record.reason, /remains pending for recovery.*export lock could not be released either/s);
    }
    assert.equal(f.state().pending?.transaction, error.transaction);
    fs.rmSync(f.lockPath, { recursive: true });
    assert.equal(f.sync('v2').recovery.status, 'rolled-back');
    assert.equal(fs.readFileSync(path.join(f.folder, 'notes.txt'), 'utf8'), 'user notes\n');
});

test('an export whose journal cannot be observed after its rollback stopped is uncertain, never failed', t => {
    const f = exportFixture(t, 'unknown');
    const agents = path.join(f.folder, '.agents');
    const aside = path.join(f.root, 'agents-aside');
    const error = f.thrown(() => {
        fs.renameSync(agents, aside);
        fs.writeFileSync(agents, 'not a directory\n');
        throw injected();
    });
    fs.rmSync(agents);
    fs.renameSync(aside, agents);
    assert.equal(error.skillExportRecovery.status, 'unknown');
    for (const record of f.records(error)) {
        assert.equal(record.outcome, 'uncertain');
        assert.equal(record.code, 'SKILL_EXPORT_RECOVERY_REQUIRED');
        assert.deepEqual(record.details.recovery, { status: 'unknown', transaction: error.transaction });
        assert.equal(record.details.lockReleaseCode, 'ENOTDIR');
        assert.match(record.reason, /injected failure after move.*journal state could not be read/s);
    }
    assert.equal(f.state().pending?.transaction, error.transaction);
    fs.rmSync(f.lockPath, { recursive: true });
    assert.equal(f.sync('v2').recovery.status, 'rolled-back');
});

test('a quarantined export whose lock release also fails stays uncertain and keeps the user bytes', t => {
    const f = exportFixture(t, 'quarantine-release');
    const error = f.thrown(({ destination }) => {
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'user.txt'), 'user bytes\n');
        throw injected();
    }, f.strayLock);
    assert.equal(error.code, 'INJECTED');
    assert.equal(error.lockReleaseError.code, 'ENOTEMPTY');
    for (const record of f.records(error)) {
        assert.equal(record.outcome, 'uncertain');
        assert.deepEqual([record.details.errorCode, record.details.lockReleaseCode], ['INJECTED', 'ENOTEMPTY']);
    }
    assert.equal(f.state().quarantined.length, 1);
    assert.equal(fs.readFileSync(path.join(f.skills, 'demo', 'user.txt'), 'utf8'), 'user bytes\n');
});

test('a clean rollback whose lock release fails stays failed with its own error first', t => {
    const f = exportFixture(t, 'clean-release');
    const error = f.thrown(() => { throw injected(); }, f.strayLock);
    assert.equal(error.code, 'INJECTED');
    assert.equal(error.skillExportRecovery.status, 'rolled-back');
    for (const record of f.records(error)) {
        assert.equal(record.outcome, 'failed');
        assert.equal(record.code, 'INJECTED');
        assert.equal(record.details.lockReleaseCode, 'ENOTEMPTY');
        assert.match(record.reason, /^injected failure after move; its export lock could not be released either/);
    }
    assert.deepEqual(f.state().quarantined, []);
    assert.equal(f.state().pending, null);
    assert.equal(fs.realpathSync(path.join(f.skills, 'demo')), path.join(f.root, 'v1', 'demo'));
});

test('a committed export whose lock release fails is failed with its settled transaction, not uncertain', t => {
    const f = exportFixture(t, 'committed-release');
    const error = f.thrown(null, f.strayLock);
    assert.equal(error.code, 'SKILL_EXPORT_LOCK_RELEASE_FAILED');
    assert.equal(error.cause.code, 'ENOTEMPTY');
    for (const record of f.records(error)) {
        assert.equal(record.outcome, 'failed');
        assert.equal(record.code, 'SKILL_EXPORT_LOCK_RELEASE_FAILED');
        assert.equal(record.details.transaction.status, 'committed');
        assert.match(record.reason, /stay blocked.*outputs are settled \(transaction committed\)/s);
    }
    assert.equal(fs.realpathSync(path.join(f.skills, 'demo')), path.join(f.root, 'v2', 'demo'));
    assert.throws(() => f.sync('v2'), { code: 'SKILL_EXPORT_LOCK_OWNERLESS' });
});

test('a lock release failure after a recovery that quarantined output stays uncertain', t => {
    const f = exportFixture(t, 'recovery-release');
    const stop = stopRollback(f);
    f.thrown(stop.afterMove);
    stop.restore();
    // The user fills the vacated destination before recovery runs.
    fs.mkdirSync(path.join(f.skills, 'demo'));
    fs.writeFileSync(path.join(f.skills, 'demo', 'user.txt'), 'user bytes\n');
    let error = null;
    try { f.sync('v2', null, f.strayLock); } catch (thrown) { error = thrown; }
    assert.equal(error?.code, 'SKILL_EXPORT_LOCK_RELEASE_FAILED');
    assert.equal(error.skillExportResult.recovery.status, 'quarantined');
    for (const record of f.records(error)) {
        assert.equal(record.outcome, 'uncertain');
        assert.equal(record.code, 'SKILL_EXPORT_RECOVERY_REQUIRED');
        assert.equal(record.details.errorCode, 'SKILL_EXPORT_LOCK_RELEASE_FAILED');
        assert.match(record.reason, /incomplete: .*recovery quarantined.*lock could not be released/s);
    }
    assert.equal(fs.readFileSync(path.join(f.skills, 'demo', 'user.txt'), 'utf8'), 'user bytes\n');
});
