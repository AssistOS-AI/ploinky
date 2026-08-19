import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const readRepoFile = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

test('operator documentation exposes log commands for Router and agents', () => {
    const sources = [
        readRepoFile('README.md'),
        readRepoFile('docs/ploinky-overview.md'),
        readRepoFile('docs/code-derived-agent-lifecycle.md'),
    ].join('\n');
    assert.match(sources, /logs tail \[router\|agent\]/);
    assert.match(sources, /logs last \[<N>\] \[router\|agent\]/);
});

test('observability specs assign Router and Policy files to Ploinky and maintenance scheduling to workspaceMonitorAgent', () => {
    const observability = readRepoFile('docs/specs/DS011-observability.md');
    assert.match(observability, /Ploinky durably appends Router output/);
    assert.match(observability, /workspaceMonitorAgent.*schedules daily UTC maintenance/);
    assert.match(observability, /Retention defaults to 7 days/);
    assert.match(observability, /\.ploinky\/logs\/router\.log|policy-audit\.log/);
});

test('lifecycle generated-files table documents Router and Policy log files', () => {
    const lifecycle = readRepoFile('docs/code-derived-agent-lifecycle.md');
    assert.match(lifecycle, /`\.ploinky\/logs\/no-wait\/<container>\.<runId>\.log`/);
    assert.match(lifecycle, /`\.ploinky\/logs\/agents\/<container>\.<identityDigest>\.log`/);
    assert.match(lifecycle, /\.ploinky\/logs\/router\.log/);
    assert.match(lifecycle, /policy-audit\.log/);
});
