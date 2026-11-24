import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdateResult, createOperationRecord } from '../../cli/commands/updateOutcome.js';
import { formatUpdateSummary } from '../../cli/commands/updateSummary.js';

const record = (id, required, code = 'dirty-worktree') => createOperationRecord({
    phase: 'workspace-repository', id, required, code, outcome: 'skipped',
});

test('restart refusal lists required dirty repositories without blaming optional local edits', () => {
    const result = buildUpdateResult({ command: ['update'], records: [record('needed', true), record('staged', true, 'dirty-index'), record('unrelated', false)] });
    const output = formatUpdateSummary(result);
    assert.match(output, /Workspace restart skipped: these required repositories have uncommitted changes:\n  - needed\n  - staged\nCommit or stash/);
    assert.doesNotMatch(output, /Activation blocked|required \(membership unknown\)/);
});

test('unknown dependencies report the failed check rather than claiming repositories are required', () => {
    const result = buildUpdateResult({ command: ['update'], records: [record('unknown', null)] });
    result.graphErrors = ['manifest of Main/app: invalid JSON'];
    const output = formatUpdateSummary(result);
    assert.match(output, /could not determine whether/);
    assert.match(output, /Dependency check: manifest of Main\/app: invalid JSON/);
    assert.doesNotMatch(output, /these required repositories have uncommitted changes/);
});

test('optional dirty repositories do not produce a restart refusal', () => {
    const result = buildUpdateResult({ command: ['update'], records: [record('optional', false)] });
    assert.doesNotMatch(formatUpdateSummary(result), /Workspace restart skipped/);
});

test('host-driven phase hides normal delegation and statistics but preserves its records', async () => {
    const { printUpdateSummary } = await import('../../cli/commands/updateSummary.js');
    const { formatUpdateStatusLine } = await import('../../ploinky-box/bin/ploinky-box.mjs');
    const records = [
        createOperationRecord({ phase: 'host-ploinky', id: '/opt/ploinky', required: false, outcome: 'skipped', code: 'scope-excluded' }),
        createOperationRecord({ phase: 'agentlib', id: 'achillesAgentLib', required: false, outcome: 'deferred', code: 'owned-by-host' }),
    ];
    const result = buildUpdateResult({ command: ['update'], records });
    const output = [];
    printUpdateSummary(result, { hostPhase: true, log: line => output.push(line), error: line => output.push(line) });
    assert.deepEqual(output, []);
    assert.equal(formatUpdateStatusLine(result), 'Update complete.');
    assert.deepEqual(result.records, records);
});

test('internal phase keeps real problems visible even when optional', () => {
    const records = [record('dirty-project', false),
        createOperationRecord({ phase: 'agentlib', id: 'achillesAgentLib', required: false, outcome: 'failed', code: 'owned-by-host', reason: 'library verification failed' }),
        createOperationRecord({ phase: 'host-ploinky', id: '/opt/ploinky', required: true, outcome: 'skipped', code: 'scope-excluded' })];
    const result = buildUpdateResult({ command: ['update'], records });
    const text = formatUpdateSummary(result, { hostPhase: true });
    assert.match(text, /dirty-project: dirty-worktree/);
    assert.match(text, /library verification failed/);
    assert.match(text, /\/opt\/ploinky: scope-excluded/);
    assert.doesNotMatch(text, /In-Box update phase|Records:|Not verified:/);
    assert.equal(result.exitCode, 1);
});
