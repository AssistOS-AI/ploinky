import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDiagnostic, diagnosticLevel, updateDiagnosticLevel, diagnosticColorEnabled } from '../../cli/utils/diagnostics.js';

test('TTY warnings are yellow and failures red, with distinct icons', () => {
    const options = { stream: { isTTY: true }, env: {} };
    assert.equal(formatDiagnostic('local edits', 'warning', options), '\x1b[33m⚠ local edits\x1b[0m');
    assert.equal(formatDiagnostic('pull failed', 'error', options), '\x1b[31m✖ pull failed\x1b[0m');
});
test('redirected output and NO_COLOR omit ANSI; host color choice reaches piped container output', () => {
    assert.equal(formatDiagnostic('warning', 'warning', { stream: { isTTY: false }, env: {} }), '⚠ warning');
    assert.equal(diagnosticColorEnabled({ stream: {}, env: { PLOINKY_DIAGNOSTIC_COLOR: '1' } }), true);
    assert.equal(diagnosticColorEnabled({ stream: { isTTY: true }, env: { NO_COLOR: '', PLOINKY_DIAGNOSTIC_COLOR: '1' } }), false);
});
test('blocked restarts are warnings even with nonzero exit; failed operations are errors', () => {
    const skipped = { outcome: 'skipped', code: 'dirty-worktree' };
    assert.equal(diagnosticLevel(skipped), 'warning');
    assert.equal(updateDiagnosticLevel({ status: 'failed', exitCode: 1, records: [skipped] }), 'warning');
    assert.equal(updateDiagnosticLevel({ status: 'failed', records: [{ outcome: 'failed' }] }), 'error');
    assert.equal(updateDiagnosticLevel({ status: 'complete', records: [] }), null);
});

test('restart blockers remain yellow alongside a red update failure', async t => {
    const { printUpdateSummary } = await import('../../cli/commands/updateSummary.js');
    const previous = process.env.PLOINKY_DIAGNOSTIC_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    process.env.PLOINKY_DIAGNOSTIC_COLOR = '1';
    delete process.env.NO_COLOR;
    t.after(() => {
        if (previous === undefined) delete process.env.PLOINKY_DIAGNOSTIC_COLOR;
        else process.env.PLOINKY_DIAGNOSTIC_COLOR = previous;
        if (previousNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = previousNoColor;
    });
    const lines = [];
    printUpdateSummary({ status: 'failed', exitCode: 1, blockedBy: [{}], records: [
        { id: 'fetch', phase: 'command', required: false, outcome: 'failed', reason: 'fetch failed' },
        { id: 'local-repo', phase: 'workspace-repository', required: true, outcome: 'skipped', code: 'dirty-worktree' },
    ] }, { error: text => lines.push(text), log: text => lines.push(text) });
    assert.ok(lines[0].startsWith('\x1b[31m✖'));
    assert.ok(lines[1].startsWith('\x1b[33m⚠ Workspace restart skipped'));
});
