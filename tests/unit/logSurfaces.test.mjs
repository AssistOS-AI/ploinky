// Active operator surfaces that must track the `logs` grammar: the Dashboard's
// client-side count validation and input constraints, the root README command
// list, and the code-derived lifecycle tables.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseLogCommandArgs } from '../../cli/commands/logCommands.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function readRepoFile(relative) {
    return fs.readFileSync(path.join(repoRoot, relative), 'utf8');
}

test('the Dashboard validates counts with the exact rule the CLI enforces', () => {
    const source = readRepoFile('cli/server/dashboard/dashboard.js');
    // The CLI's own acceptance rule is proven behaviourally in
    // cliLogsEntrypoint.test.mjs; the Dashboard must apply the identical one so
    // it can never offer a value the CLI will refuse.
    assert.match(source, /const MAX_LOG_LINES = 10000;/);
    assert.match(source, /const DEFAULT_LOG_LINES = 200;/);
    assert.match(source, /\/\^\[1-9\]\[0-9\]\*\$\//);
    assert.match(source, /Number\.isSafeInteger\(value\)/);
    assert.match(source, /value >= 1 && value <= MAX_LOG_LINES/);
    // An empty field falls back to the documented default rather than NaN.
    assert.match(source, /if \(!text\) return DEFAULT_LOG_LINES;/);
});

test('the CLI parser and the Dashboard agree on which counts are usable', () => {
    // One shared table, applied to the CLI parser here and pinned into the
    // Dashboard by the source contract above.
    const accepted = [['1', 1], ['200', 200], ['10000', 10000]];
    for (const [raw, expected] of accepted) {
        assert.equal(parseLogCommandArgs(['logs', 'last', raw]).lineCount, expected);
    }
    for (const rejected of ['0', '1.5', '007', '10001', '12abc']) {
        assert.throws(
            () => parseLogCommandArgs(['logs', 'last', rejected]),
            (error) => error.code === 'LOG_USAGE',
            `expected the CLI to reject ${rejected}`,
        );
    }
    // A blank count is not passed through at all; the CLI default applies.
    assert.equal(parseLogCommandArgs(['logs', 'last']).lineCount, 200);
});

test('the Dashboard never sends NaN or an unbounded count to the CLI', () => {
    const source = readRepoFile('cli/server/dashboard/dashboard.js');
    // The old partial parser forwarded '12abc' as 12 and an empty field as NaN.
    assert.equal(/parseInt\(logCount/.test(source), false);
    assert.match(source, /logs last \$\{n\}/);
    assert.match(source, /if \(n === null\)/);
});

test('the Dashboard log count input constrains its range in the browser', () => {
    const html = readRepoFile('cli/server/dashboard/dashboard.html');
    const input = html.split('\n').find((line) => line.includes('id="logCount"'));
    assert.ok(input, 'the Dashboard must expose a log count input');
    assert.match(input, /type="number"/);
    assert.match(input, /min="1"/);
    assert.match(input, /max="10000"/);
    assert.match(input, /step="1"/);
});

test('the Dashboard keeps its no-target Router request', () => {
    const source = readRepoFile('cli/server/dashboard/dashboard.js');
    // This change adds no agent selector; the Dashboard still asks for Router.
    assert.equal(/logs last \$\{n\} \w/.test(source), false);
});

test('the root README lists both log commands', () => {
    const readme = readRepoFile('README.md');
    assert.match(readme, /- `logs tail \[router\|<agent>\] \[--startup\]`/);
    assert.match(readme, /- `logs last \[<N>\] \[router\|<agent>\] \[--startup\]`/);
    assert.match(readme, /never creates, starts, or repairs/);
    assert.match(readme, /one reference per enabled record/);
    assert.match(readme, /Application bytes are intentionally passed through unredacted/);
    assert.match(readme, /bounded TERM\/KILL child cleanup/);
});

test('the overview documents the agent sources and the no-mutation guarantee', () => {
    const overview = readRepoFile('docs/ploinky-overview.md');
    assert.match(overview, /ploinky logs tail \[router\|<agent>\]/);
    assert.match(overview, /immutable-container-id ownership/);
    assert.match(overview, /process-specific Bubblewrap\/Seatbelt file/);
    assert.match(overview, /rechecks marker, registry generation, and runtime source/);
    assert.match(overview, /pre-cut sandbox processes require one restart/i);
    assert.match(overview, /never creates, starts, adopts, repairs, or removes/);
    // The old "Router logs are the only logs exposed" claim is gone.
    assert.equal(overview.includes('Router logs are the only logs exposed'), false);
});

test('the lifecycle generated-files table lists both new log families', () => {
    const lifecycle = readRepoFile('docs/code-derived-agent-lifecycle.md');
    assert.match(lifecycle, /`\.ploinky\/logs\/no-wait\/<container>\.<runId>\.log`/);
    assert.match(lifecycle, /`\.ploinky\/logs\/agents\/<container>\.<identityDigest>\.log`/);
    assert.match(lifecycle, /sha256\(instanceId NUL enableGeneration NUL decimalPid\)/);
    assert.match(lifecycle, /<container>\.current\.json/);
});

test('the lifecycle command table describes agent targets and the mutation boundary', () => {
    const lifecycle = readRepoFile('docs/code-derived-agent-lifecycle.md');
    assert.match(lifecycle, /rechecks the marker, registry generation, and source identity/);
    assert.match(lifecycle, /one round-trip-proved reference per enabled record/);
    assert.match(lifecycle, /Application bytes pass through intentionally unredacted/);
    assert.match(lifecycle, /bounded TERM\/KILL cleanup/);
    assert.match(lifecycle, /never writes registry, no-wait, or routing state/);
    // The superseded Router-only claim is gone.
    assert.equal(lifecycle.includes('Router is the only supported target'), false);
});

test('no generated HTML documentation was edited', () => {
    // Generated HTML is out of scope; the executable code and active Markdown
    // are the only documentation surfaces this change touches.
    const docsDir = path.join(repoRoot, 'docs');
    const generated = fs.readdirSync(docsDir).filter((name) => name.endsWith('.html'));
    for (const name of generated) {
        const html = fs.readFileSync(path.join(docsDir, name), 'utf8');
        assert.equal(html.includes('<container>.<runId>.log'), false, name);
        assert.equal(html.includes('<container>.<identityDigest>.log'), false, name);
    }
});
