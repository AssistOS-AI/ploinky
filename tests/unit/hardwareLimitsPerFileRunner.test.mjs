// The hardware-limits registered runner runs every offline test file in its own
// child, serially, under a deadline derived from that file's registered
// required cases (verify.mjs runSuitePerFile / fileDeadlineMs). These tests use
// real native node:test children over synthetic files; the verdict rules they
// pin are the ones a whole-suite run already had.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { evaluateSuiteRun, randomRunId } from '../hardware-limits/fixtures.mjs';
import { runBoundedProcess } from '../hardware-limits/liveProcess.mjs';
import {
    DEFAULT_DEADLINE_POLICY,
    FILE_BASE_DEADLINE_MS,
    MAX_CHILD_DEADLINE_MS,
    PER_CASE_DEADLINE_MS,
    fileDeadlineMs,
    runSuite,
    runSuitePerFile,
} from '../hardware-limits/verify.mjs';

// Small enough to run quickly, large enough for a child's start-up.
const SMALL = Object.freeze({ baseMs: 4000, perCaseMs: 2000, maxMs: 60000 });

const pass = (...names) => `import test from 'node:test';\n${names.map((name) => `test(${JSON.stringify(name)}, () => {});`).join('\n')}\n`;

function synthetic(t, files) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-pf-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
    return root;
}

function requiredCase(file, name) {
    return { id: `${file}-${name}`.replace(/[^A-Za-z0-9_.-]/g, '-'), phase: 'p0', repo: 'ploinky', file, name, kind: 'offline', requires: [], expected: 'pass' };
}

async function perFile(t, files, required, options = {}) {
    const root = synthetic(t, files);
    const runId = randomRunId();
    const eventsPathFor = (file, index) => path.join(root, `events.${index}.${file}.jsonl`);
    const result = await runSuitePerFile({
        root,
        files: options.files || Object.keys(files).filter((name) => name.endsWith('.test.mjs')).sort(),
        runId,
        childId: 'pf',
        eventsPathFor,
        required,
        deadlinePolicy: options.deadlinePolicy || SMALL,
        run: options.run,
    });
    return { result, root, runId, eventsPathFor };
}

const child = (result, file) => result.children.find((entry) => entry.file === file);

test('PF.all-leaves-pass-gives-pass-with-a-record-per-file', async (t) => {
    const required = [requiredCase('a.test.mjs', 'a.one'), requiredCase('a.test.mjs', 'a.two'), requiredCase('b.test.mjs', 'b.one')];
    const { result } = await perFile(t, {
        'a.test.mjs': pass('a.one', 'a.two'),
        'b.test.mjs': pass('b.one'),
        'c.test.mjs': pass('c.regression'),
    }, required);
    assert.equal(result.verdict, 'PASS', result.problems.join('\n'));
    assert.equal(result.streamComplete, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.discovered, 4);
    assert.deepEqual(result.cases.map((entry) => entry.result), ['pass', 'pass', 'pass']);
    assert.deepEqual(result.children.map((entry) => entry.file), ['a.test.mjs', 'b.test.mjs', 'c.test.mjs']);
    assert.equal(new Set(result.eventsPaths).size, 3, 'each file has its own events stream');
    for (const path_ of result.eventsPaths) assert.ok(fs.existsSync(path_));
    const expected = { 'a.test.mjs': 2, 'b.test.mjs': 1, 'c.test.mjs': 0 };
    for (const record of result.children) {
        assert.equal(record.requiredCases, expected[record.file]);
        assert.equal(record.requiredPassed, expected[record.file]);
        assert.equal(record.deadlineMs, SMALL.baseMs + expected[record.file] * SMALL.perCaseMs);
        assert.equal(record.verdict, 'PASS');
        assert.equal(record.signal, null);
        assert.equal(record.exitCode, 0);
        assert.equal(record.streamComplete, true);
        assert.ok(Number.isFinite(Date.parse(record.startedAt)) && Number.isFinite(Date.parse(record.endedAt)));
        assert.ok(Date.parse(record.endedAt) >= Date.parse(record.startedAt));
        assert.equal(record.elapsedMs, Date.parse(record.endedAt) - Date.parse(record.startedAt));
    }
    assert.deepEqual(result.children.map((entry) => entry.discovered), [2, 1, 1]);
    // Serial: a file starts only after the previous one has ended (concurrency 1).
    for (let index = 1; index < result.children.length; index += 1) {
        assert.ok(Date.parse(result.children[index].startedAt) >= Date.parse(result.children[index - 1].endedAt));
    }
});

test('PF.deadline-formula-is-per-file-case-count-with-the-documented-constants', () => {
    assert.equal(FILE_BASE_DEADLINE_MS, 20 * 60 * 1000);
    assert.equal(PER_CASE_DEADLINE_MS, 300 * 1000);
    assert.equal(MAX_CHILD_DEADLINE_MS, 18_000_000);
    assert.equal(fileDeadlineMs(0), 1_200_000);
    assert.equal(fileDeadlineMs(1), 1_500_000);
    assert.equal(fileDeadlineMs(2), 1_800_000);
    assert.equal(fileDeadlineMs(18), 6_600_000);
    assert.ok(fileDeadlineMs(3) > fileDeadlineMs(2) && fileDeadlineMs(2) > fileDeadlineMs(1) && fileDeadlineMs(1) > fileDeadlineMs(0));
    // 94 cases (hardwareAvailabilityMutants) would exceed 5 hours: capped.
    assert.equal(fileDeadlineMs(94), 18_000_000);
    assert.equal(fileDeadlineMs(1000), 18_000_000);
    assert.equal(fileDeadlineMs(5, SMALL), 14000);
    assert.throws(() => fileDeadlineMs(-1));
    assert.throws(() => fileDeadlineMs(1.5));
    assert.deepEqual({ ...DEFAULT_DEADLINE_POLICY }, { baseMs: 1_200_000, perCaseMs: 300_000, maxMs: 18_000_000 });
});

test('PF.the-cap-is-exactly-the-bounded-process-limit', async () => {
    const refusing = () => { throw Object.assign(new Error('stub'), { code: 'STUB' }); };
    const options = { cwd: '/', env: {}, spawnProcess: refusing };
    const accepted = await runBoundedProcess('/bin/true', [], { ...options, deadlineMs: MAX_CHILD_DEADLINE_MS });
    assert.equal(accepted.errorCode, 'STUB', 'the cap itself is a valid deadline');
    assert.throws(() => runBoundedProcess('/bin/true', [], { ...options, deadlineMs: MAX_CHILD_DEADLINE_MS + 1 }), /Invalid bounded process invocation/);
});

test('PF.each-file-records-the-deadline-of-its-own-case-count-with-the-default-policy', async (t) => {
    const required = [
        requiredCase('one.test.mjs', 'one.a'),
        requiredCase('two.test.mjs', 'two.a'), requiredCase('two.test.mjs', 'two.b'),
    ];
    const { result } = await perFile(t, {
        'none.test.mjs': pass('none.a'),
        'one.test.mjs': pass('one.a'),
        'two.test.mjs': pass('two.a', 'two.b'),
    }, required, { deadlinePolicy: DEFAULT_DEADLINE_POLICY });
    assert.equal(result.verdict, 'PASS', result.problems.join('\n'));
    assert.deepEqual(result.children.map((entry) => [entry.file, entry.deadlineMs]), [
        ['none.test.mjs', 1_200_000], ['one.test.mjs', 1_500_000], ['two.test.mjs', 1_800_000],
    ]);
});

test('PF.a-slow-file-with-many-required-cases-gets-time-in-proportion-to-them', async (t) => {
    // Three required leaves of 2.5 s each (7.5 s) exceed the 4 s base but fit
    // 4 s + 3 * 2 s. A deadline that ignored the case count would kill it.
    const slow = `import test from 'node:test';
const wait = () => new Promise((resolve) => setTimeout(resolve, 2500));
test('slow.one', wait);
test('slow.two', wait);
test('slow.three', wait);
`;
    const required = ['slow.one', 'slow.two', 'slow.three'].map((name) => requiredCase('slow.test.mjs', name));
    const { result } = await perFile(t, { 'slow.test.mjs': slow }, required);
    assert.equal(result.verdict, 'PASS', result.problems.join('\n'));
    assert.equal(result.children[0].deadlineMs, 10000);
    assert.ok(result.children[0].elapsedMs > SMALL.baseMs, 'the file really ran longer than the base alone');
    assert.equal(result.children[0].signal, null);
});

test('PF.a-timed-out-file-fails-its-leaves-are-missing-and-the-other-files-still-run', async (t) => {
    const required = [requiredCase('hang.test.mjs', 'hang.leaf'), requiredCase('ok.test.mjs', 'ok.leaf')];
    const { result } = await perFile(t, {
        'hang.test.mjs': `import test from 'node:test';\ntest('hang.leaf', () => new Promise(() => {}));\n`,
        'ok.test.mjs': pass('ok.leaf'),
    }, required);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.streamComplete, false);
    assert.equal(result.signal, 'deadline');
    assert.deepEqual(result.cases.map((entry) => [entry.file, entry.result]), [['hang.test.mjs', 'missing'], ['ok.test.mjs', 'pass']]);
    assert.ok(result.problems.some((problem) => problem === 'hang.test.mjs: test child terminated by signal deadline'), result.problems.join('\n'));
    assert.ok(result.problems.some((problem) => problem.startsWith('hang.test.mjs: no tests were discovered')), result.problems.join('\n'));
    const hang = child(result, 'hang.test.mjs');
    const ok = child(result, 'ok.test.mjs');
    assert.equal(hang.signal, 'deadline');
    assert.equal(hang.verdict, 'FAIL');
    assert.equal(hang.deadlineMs, 6000);
    assert.ok(hang.elapsedMs >= 6000, `the hung child ran to its deadline (${hang.elapsedMs} ms)`);
    assert.equal(ok.verdict, 'PASS');
    assert.equal(ok.signal, null);
    assert.equal(ok.requiredPassed, 1);
    assert.ok(Date.parse(ok.startedAt) >= Date.parse(hang.endedAt), 'the next file ran after the timed-out one');
});

test('PF.a-timed-out-file-without-required-cases-fails-on-the-base-deadline', async (t) => {
    // A regression file registers no required case: its timeout is still a failure.
    const required = [requiredCase('ok.test.mjs', 'ok.leaf')];
    const { result } = await perFile(t, {
        'hang.test.mjs': `import test from 'node:test';\ntest('regression.hang', () => new Promise(() => {}));\n`,
        'ok.test.mjs': pass('ok.leaf'),
    }, required);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.signal, 'deadline');
    assert.deepEqual(result.cases.map((entry) => entry.result), ['pass']);
    assert.equal(child(result, 'hang.test.mjs').deadlineMs, SMALL.baseMs);
    assert.equal(child(result, 'hang.test.mjs').verdict, 'FAIL');
    assert.equal(child(result, 'ok.test.mjs').verdict, 'PASS');
    assert.ok(result.problems.some((problem) => problem === 'hang.test.mjs: test child terminated by signal deadline'), result.problems.join('\n'));
});

test('PF.a-missing-required-leaf-fails', async (t) => {
    const required = [requiredCase('a.test.mjs', 'a.one'), requiredCase('a.test.mjs', 'a.absent'), requiredCase('b.test.mjs', 'b.one')];
    const { result } = await perFile(t, { 'a.test.mjs': pass('a.one'), 'b.test.mjs': pass('b.one') }, required);
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(result.cases.map((entry) => entry.result), ['pass', 'missing', 'pass']);
    assert.equal(child(result, 'a.test.mjs').verdict, 'FAIL');
    assert.equal(child(result, 'b.test.mjs').verdict, 'PASS');
});

test('PF.a-required-case-whose-file-has-no-child-is-missing-and-fails', async (t) => {
    const required = [requiredCase('a.test.mjs', 'a.one'), requiredCase('gone.test.mjs', 'gone.one')];
    const { result } = await perFile(t, { 'a.test.mjs': pass('a.one') }, required, { files: ['a.test.mjs'] });
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(result.cases.map((entry) => entry.result), ['pass', 'missing']);
});

test('PF.a-duplicate-leaf-fails', async (t) => {
    const required = [requiredCase('d.test.mjs', 'dup.leaf'), requiredCase('b.test.mjs', 'b.one')];
    const { result } = await perFile(t, { 'd.test.mjs': pass('dup.leaf', 'dup.leaf'), 'b.test.mjs': pass('b.one') }, required);
    assert.equal(result.verdict, 'FAIL');
    assert.ok(result.problems.some((problem) => problem.startsWith('d.test.mjs: duplicate test identity')), result.problems.join('\n'));
    // The evaluation reports the repeated identity as a problem; that alone fails the child and the run.
    assert.equal(child(result, 'd.test.mjs').verdict, 'FAIL');
    assert.equal(child(result, 'b.test.mjs').verdict, 'PASS');
    assert.equal(result.cases[1].result, 'pass');
});

test('PF.a-skipped-or-todo-required-leaf-fails', async (t) => {
    const required = [requiredCase('s.test.mjs', 's.skip'), requiredCase('t.test.mjs', 't.todo'), requiredCase('b.test.mjs', 'b.one')];
    const { result } = await perFile(t, {
        's.test.mjs': `import test from 'node:test';\ntest('s.skip', { skip: 'no' }, () => {});\n`,
        't.test.mjs': `import test from 'node:test';\ntest('t.todo', { todo: true }, () => {});\n`,
        'b.test.mjs': pass('b.one'),
    }, required);
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(result.cases.map((entry) => entry.result), ['fail', 'fail', 'pass']);
    assert.match(result.cases[0].reason, /skip/);
    assert.match(result.cases[1].reason, /todo/);
});

test('PF.a-failing-leaf-fails-and-is-counted', async (t) => {
    const required = [requiredCase('f.test.mjs', 'f.bad'), requiredCase('b.test.mjs', 'b.one')];
    const { result } = await perFile(t, {
        'f.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('f.bad', () => assert.equal(1, 2));\n`,
        'b.test.mjs': pass('b.one'),
    }, required);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.newFailures.length, 1);
    assert.equal(result.newFailures[0].testId, 'f.test.mjs::f.bad');
    assert.notEqual(result.exitCode, 0);
});

test('PF.a-child-killed-by-a-signal-fails-and-the-other-files-still-run', async (t) => {
    // The test file kills its parent, the native test runner child.
    const required = [requiredCase('k.test.mjs', 'k.leaf'), requiredCase('ok.test.mjs', 'ok.leaf')];
    const { result } = await perFile(t, {
        'k.test.mjs': `import test from 'node:test';\ntest('k.leaf', () => { process.kill(process.ppid, 'SIGKILL'); return new Promise(() => {}); });\n`,
        'ok.test.mjs': pass('ok.leaf'),
    }, required);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(result.streamComplete, false);
    assert.ok(result.problems.some((problem) => problem === 'k.test.mjs: test child terminated by signal SIGKILL'), result.problems.join('\n'));
    assert.notEqual(result.cases[0].result, 'pass');
    assert.equal(child(result, 'k.test.mjs').signal, 'SIGKILL');
    assert.equal(child(result, 'ok.test.mjs').verdict, 'PASS');
    assert.equal(result.cases[1].result, 'pass');
});

test('PF.a-stream-without-a-stream-complete-record-fails-even-with-exit-0-and-no-signal', async (t) => {
    const required = [requiredCase('a.test.mjs', 'a.one'), requiredCase('b.test.mjs', 'b.one')];
    const truncating = async (options) => {
        const real = await runSuite(options);
        if (!options.files.includes('a.test.mjs')) return real;
        const lines = fs.readFileSync(options.eventsPath, 'utf8').trimEnd().split('\n');
        assert.equal(JSON.parse(lines.at(-1)).event, 'stream-complete');
        const eventText = `${lines.slice(0, -1).join('\n')}\n`;
        fs.writeFileSync(options.eventsPath, eventText);
        const evaluation = evaluateSuiteRun({
            exitCode: 0, signal: null, eventText, runId: options.runId, childId: options.childId,
            files: options.files, required: options.required,
        });
        return { ...evaluation, exitCode: 0, signal: null, stderrTail: '' };
    };
    const { result } = await perFile(t, { 'a.test.mjs': pass('a.one'), 'b.test.mjs': pass('b.one') }, required, { run: truncating });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.streamComplete, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.ok(result.problems.some((problem) => problem.startsWith('a.test.mjs: event stream has no final stream-complete record')), result.problems.join('\n'));
    assert.equal(child(result, 'a.test.mjs').streamComplete, false);
    assert.equal(child(result, 'b.test.mjs').streamComplete, true);
    assert.equal(child(result, 'b.test.mjs').verdict, 'PASS');
});

test('PF.a-stale-events-file-never-stands-in-for-a-child', async (t) => {
    const required = [requiredCase('a.test.mjs', 'a.one')];
    const root = synthetic(t, { 'a.test.mjs': pass('a.one') });
    const eventsPath = path.join(root, 'events.jsonl');
    fs.writeFileSync(eventsPath, 'stale\n');
    const observed = [];
    const result = await runSuitePerFile({
        root, files: ['a.test.mjs'], runId: randomRunId(), childId: 'pf', eventsPathFor: () => eventsPath, required,
        deadlinePolicy: SMALL,
        run: async (options) => { observed.push(fs.existsSync(options.eventsPath)); return runSuite(options); },
    });
    assert.deepEqual(observed, [false]);
    assert.equal(result.verdict, 'PASS', result.problems.join('\n'));
});

// The `offline` command itself: a candidate with several files yields one
// child, one events stream and one report record per file.
function offlineFixture(t, files, required) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-pfo-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const evidence = path.join(root, 'evidence');
    fs.mkdirSync(evidence, { mode: 0o700 });
    const roots = Object.fromEntries(['ploinky', 'localLlms', 'explorer', 'images'].map((name) => {
        const dir = path.join(root, `offline-${name}`);
        fs.mkdirSync(dir);
        return [name, dir];
    }));
    for (const [file, body] of Object.entries(files)) {
        const target = path.join(roots.explorer, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body);
    }
    const sha = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
    const digest = (dir) => {
        const rows = [];
        const walk = (directory, relative = '') => {
            for (const name of fs.readdirSync(directory).sort()) {
                const target = path.join(directory, name);
                const rel = relative ? `${relative}/${name}` : name;
                const stat = fs.lstatSync(target);
                if (stat.isDirectory()) walk(target, rel);
                else if (stat.isFile()) rows.push(`${rel}\0${sha(fs.readFileSync(target)).slice(7)}`);
            }
        };
        walk(dir);
        return sha(rows.join('\n'));
    };
    const cases = { schema: 1, cases: required.map(([file, name]) => ({ id: name, phase: 'p3', repo: 'explorer', file, name, kind: 'offline', requires: [], expected: 'pass' })) };
    const casesPath = path.join(evidence, 'cases_claude.json');
    fs.writeFileSync(casesPath, JSON.stringify(cases), { mode: 0o600 });
    const config = {
        schema: 1, runId: randomRunId(), createdAt: new Date().toISOString(), documentSuffix: 'claude',
        node: { absoluteExecutable: fs.realpathSync(process.execPath), version: process.version },
        repos: {}, dependencies: [], evidenceRoot: evidence, casesPath, casesDigest: sha(fs.readFileSync(casesPath)), engine: null, ssh: null,
    };
    for (const [name, dir] of Object.entries(roots)) {
        config.repos[name] = { baselineRevision: '0'.repeat(40), baselineExport: dir, baselineStage: dir, candidateRoot: name === 'images' ? null : dir, sourceDigest: digest(dir), instructionDigests: {} };
    }
    const configPath = path.join(evidence, 'config_claude.json');
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    return { configPath, evidence };
}

const P3_FILES = {
    'tests/source.test.mjs': pass('source.one', 'source.two'),
    'explorer/tests/unit/settingsAccount.test.js': pass('legacy.settings'),
    'workspaceMonitorAgent/tests/currentSnapshot.test.mjs': pass('legacy.monitor'),
    'tests/smoke/lib/box-evidence.test.mjs': pass('legacy.smoke'),
};

test('PF.offline-command-reports-one-child-per-file', async (t) => {
    const f = offlineFixture(t, P3_FILES, [['tests/source.test.mjs', 'source.one'], ['tests/source.test.mjs', 'source.two']]);
    const { main } = await import('../hardware-limits/verify.mjs');
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    let code;
    try { code = await main(['offline', '--config', f.configPath, '--phase', 'p3']); } finally { process.stderr.write = stderr; }
    assert.equal(code, 0);
    const report = JSON.parse(fs.readFileSync(path.join(f.evidence, 'report_offline-p3_claude.json'), 'utf8'));
    assert.equal(report.verdict, 'PASS');
    assert.equal(report.counts.requiredCases, 2);
    assert.equal(report.counts.requiredPassed, 2);
    assert.equal(report.counts.discovered, 5);
    assert.equal(report.streamComplete, true);
    const [suite] = report.suites;
    assert.equal(suite.children.length, 4);
    assert.deepEqual(suite.children.map((entry) => [entry.file, entry.requiredCases, entry.deadlineMs]), [
        ['explorer/tests/unit/settingsAccount.test.js', 0, 1_200_000],
        ['tests/smoke/lib/box-evidence.test.mjs', 0, 1_200_000],
        ['tests/source.test.mjs', 2, 1_800_000],
        ['workspaceMonitorAgent/tests/currentSnapshot.test.mjs', 0, 1_200_000],
    ]);
    for (const record of suite.children) {
        assert.equal(record.signal, null);
        assert.equal(record.exitCode, 0);
        assert.ok(record.startedAt && record.endedAt);
    }
    assert.equal(report.artifacts.length, 4);
    assert.equal(new Set(report.artifacts).size, 4);
    for (const artifact of report.artifacts) assert.ok(fs.existsSync(artifact), artifact);
});

test('PF.offline-command-fails-when-one-file-lacks-its-required-leaf', async (t) => {
    const f = offlineFixture(t, P3_FILES, [['tests/source.test.mjs', 'source.one'], ['tests/source.test.mjs', 'source.absent']]);
    const { main } = await import('../hardware-limits/verify.mjs');
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    let code;
    try { code = await main(['offline', '--config', f.configPath, '--phase', 'p3']); } finally { process.stderr.write = stderr; }
    assert.equal(code, 1);
    const report = JSON.parse(fs.readFileSync(path.join(f.evidence, 'report_offline-p3_claude.json'), 'utf8'));
    assert.equal(report.verdict, 'FAIL');
    assert.deepEqual(report.cases.map((entry) => entry.result), ['pass', 'missing']);
    assert.equal(report.suites[0].children.filter((entry) => entry.verdict === 'PASS').length, 3);
    assert.equal(report.suites[0].children.find((entry) => entry.file === 'tests/source.test.mjs').verdict, 'FAIL');
});
