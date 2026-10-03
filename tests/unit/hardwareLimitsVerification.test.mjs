import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    buildRequiredCaseManifest,
    evaluateGpuIdleGate,
    evaluateSuiteRun,
    randomRunId,
    runCleanup,
} from '../hardware-limits/fixtures.mjs';
import { runSuite, prepareExplorerLayout, assertExplorerPloinkySibling, assertExplorerLayoutUnchanged } from '../hardware-limits/verify.mjs';

function synthetic(t, files) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-h-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
    return root;
}

const PASSING = `import test from 'node:test';
test('leaf.one', () => {});
test('leaf.two', () => {});
`;

async function run(t, files, options = {}) {
    const root = synthetic(t, files);
    const runId = randomRunId();
    const eventsPath = path.join(root, 'events.jsonl');
    const result = await runSuite({
        root,
        files: options.files || Object.keys(files).filter((name) => name.endsWith('.test.mjs')),
        runId,
        childId: 'h',
        eventsPath,
        required: options.required || [],
        baseline: options.baseline || null,
        deadlineMs: options.deadlineMs,
    });
    return { result, root, runId, eventsPath };
}

function requiredCase(file, name) {
    return { id: name, phase: 's0', repo: 'ploinky', file, name, kind: 'offline', requires: [], expected: 'pass' };
}

test('H.assertion-failure', async (t) => {
    const { result } = await run(t, {
        'a.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('leaf.bad', () => assert.equal(1, 2));\n`,
    });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.newFailures.length, 1);
    assert.equal(result.newFailures[0].testId, 'a.test.mjs::leaf.bad');
    assert.equal(result.streamComplete, true);
});

test('H.import-failure', async (t) => {
    const { result } = await run(t, {
        'a.test.mjs': `import './absent-module.mjs';\nimport test from 'node:test';\ntest('leaf.never', () => {});\n`,
    });
    assert.equal(result.verdict, 'FAIL');
    assert.ok(result.problems.some((problem) => problem.includes('failed to load or run')), result.problems.join('\n'));
});

test('H.missing-file', async (t) => {
    const { result } = await run(t, { 'a.test.mjs': PASSING }, { files: ['a.test.mjs', 'missing.test.mjs'] });
    assert.equal(result.verdict, 'FAIL');
    assert.ok(result.problems.some((problem) => problem.includes('missing.test.mjs')), result.problems.join('\n'));
});

test('H.signal', async (t) => {
    const { result } = await run(t, {
        'a.test.mjs': `import test from 'node:test';\ntest('leaf.hang', () => new Promise(() => {}));\n`,
    }, { deadlineMs: 1500 });
    assert.equal(result.verdict, 'FAIL');
    assert.ok(result.signal, 'the hung child must be reported as signalled');
    assert.ok(result.problems.some((problem) => problem.includes('signal')));
});

test('H.empty-stream', () => {
    const evaluation = evaluateSuiteRun({ exitCode: 0, signal: null, eventText: '', files: [] });
    assert.equal(evaluation.verdict, 'FAIL');
    assert.equal(evaluation.streamComplete, false);
});

test('H.truncated-stream', async (t) => {
    const { runId, eventsPath } = await run(t, { 'a.test.mjs': PASSING });
    const lines = fs.readFileSync(eventsPath, 'utf8').trimEnd().split('\n');
    const truncated = `${lines.slice(0, -1).join('\n')}\n`;
    const evaluation = evaluateSuiteRun({
        exitCode: 0, signal: null, eventText: truncated, runId, childId: 'h', files: ['a.test.mjs'],
    });
    assert.equal(evaluation.verdict, 'FAIL');
    assert.equal(evaluation.streamComplete, false);
    const partialLine = `${lines.join('\n').slice(0, -5)}`;
    const partial = evaluateSuiteRun({ exitCode: 0, signal: null, eventText: partialLine, runId, childId: 'h' });
    assert.equal(partial.verdict, 'FAIL');
});

test('H.missing-required', async (t) => {
    const { result } = await run(t, { 'a.test.mjs': PASSING }, {
        required: [requiredCase('a.test.mjs', 'leaf.one'), requiredCase('a.test.mjs', 'leaf.absent')],
    });
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(result.cases.map((entry) => entry.result), ['pass', 'missing']);
});

test('H.required-skip', async (t) => {
    const { result } = await run(t, {
        'a.test.mjs': `import test from 'node:test';\ntest('leaf.skip', { skip: 'not yet' }, () => {});\n`,
    }, { required: [requiredCase('a.test.mjs', 'leaf.skip')] });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.cases[0].result, 'fail');
    assert.match(result.cases[0].reason, /skip/);
});

test('H.required-todo', async (t) => {
    const { result } = await run(t, {
        'a.test.mjs': `import test from 'node:test';\ntest('leaf.todo', { todo: true }, () => {});\n`,
    }, { required: [requiredCase('a.test.mjs', 'leaf.todo')] });
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.cases[0].reason, /todo/);
});

test('H.removed-baseline', async (t) => {
    const baseline = new Map([['a.test.mjs::leaf.one', 'pass'], ['a.test.mjs::leaf.removed', 'pass']]);
    const { result } = await run(t, { 'a.test.mjs': PASSING }, { baseline });
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(result.removed, ['a.test.mjs::leaf.removed']);
});

test('H.complete-pass', async (t) => {
    const baseline = new Map([['a.test.mjs::leaf.one', 'pass']]);
    const { result } = await run(t, { 'a.test.mjs': PASSING }, {
        required: [requiredCase('a.test.mjs', 'leaf.one'), requiredCase('a.test.mjs', 'leaf.two')],
        baseline,
    });
    assert.equal(result.verdict, 'PASS', result.problems.join('\n'));
    assert.equal(result.streamComplete, true);
    assert.equal(result.discovered, 2);
});

test('H.scratch-home', async (t) => {
    // R9: a test child gets a scratch HOME inside the runner's owned temp
    // tree, never the invoking user's real one.
    const probe = `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
test('leaf.home', () => {
    const tmp = fs.realpathSync(process.env.TMPDIR);
    assert.notEqual(process.env.HOME, ${JSON.stringify(os.homedir())});
    assert.equal(path.dirname(fs.realpathSync(process.env.HOME)), tmp);
    assert.deepEqual(fs.readdirSync(process.env.HOME), []);
    fs.writeFileSync(path.join(process.env.HOME, 'written-by-test'), 'x');
});
`;
    const { result } = await run(t, { 'a.test.mjs': probe }, { required: [requiredCase('a.test.mjs', 'leaf.home')] });
    assert.equal(result.verdict, 'PASS', result.problems.join('\n'));
    assert.equal(fs.existsSync(path.join(os.homedir(), 'written-by-test')), false, 'nothing reached the real HOME');
});

function cleanupOperations(calls, failures = {}) {
    const operation = (name) => async () => {
        calls.push(name);
        if (failures[name]) throw Object.assign(new Error(`${name} failed`), { code: 'E_TEST' });
        return { artifact: `${name}.json` };
    };
    return {
        'stop-owned-work': operation('stop-owned-work'),
        'revalidate-identity': operation('revalidate-identity'),
        'destroy-box': operation('destroy-box'),
        'remove-host-records': operation('remove-host-records'),
        'remove-workspace-tree': operation('remove-workspace-tree'),
        'verify-absent': operation('verify-absent'),
    };
}

test('H.cleanup-destroy-failure', async () => {
    const calls = [];
    const result = await runCleanup(cleanupOperations(calls, { 'destroy-box': true }));
    assert.equal(result.state, 'cleanup-required');
    assert.deepEqual(calls, ['stop-owned-work', 'revalidate-identity', 'destroy-box']);
    assert.ok(!calls.includes('remove-workspace-tree'));
    assert.equal(result.steps.find((step) => step.id === 'remove-host-records').state, 'not-run');
});

test('H.cleanup-identity-failure', async () => {
    const calls = [];
    const result = await runCleanup(cleanupOperations(calls, { 'revalidate-identity': true }));
    assert.equal(result.state, 'cleanup-required');
    assert.deepEqual(calls, ['stop-owned-work', 'revalidate-identity']);
    assert.ok(!calls.includes('destroy-box'));
});

test('H.cleanup-original-and-cleanup-errors', async () => {
    const calls = [];
    const original = Object.assign(new Error('assertion in live block'), { code: 'E_ORIGINAL' });
    const result = await runCleanup(cleanupOperations(calls, { 'verify-absent': true }), { originalError: original });
    assert.equal(result.originalError.code, 'E_ORIGINAL');
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].step, 'verify-absent');
    assert.equal(result.state, 'cleanup-required');
});

const BOOT = 'boot-1';
const BOX = '/sys/fs/cgroup/user.slice/libpod-box';

function ownedRecord(hostPid, startIdentity = `start-${hostPid}`) {
    return { hostPid, bootId: BOOT, startIdentity, role: 'mps-client' };
}

function observer(map) {
    return (pid) => map.get(pid) || null;
}

const okQuery = (stdout) => ({ ok: true, status: 0, signal: null, stdout });
const idleActivity = { supported: true, foreign: [] };

test('H.pid-12-34-not-123-934', () => {
    const observed = new Map([
        [12, { hostPid: 12, bootId: BOOT, startIdentity: 'start-12', cgroup: `${BOX}/ploinky/agents/libpod-a` }],
        [34, { hostPid: 34, bootId: BOOT, startIdentity: 'start-34', cgroup: `${BOX}/ploinky/core` }],
    ]);
    const owned = [ownedRecord(12), ownedRecord(34)];
    const busy = evaluateGpuIdleGate({
        query: okQuery('12\n34\n123\n934\n'), activity: idleActivity, owned, observe: observer(observed),
        bootId: BOOT, boxCgroupPrefix: BOX,
    });
    assert.deepEqual(busy, { state: 'blocked', reason: 'gpu_busy', foreign: [123, 934] });
    const idle = evaluateGpuIdleGate({
        query: okQuery('12\n34\n'), activity: idleActivity, owned, observe: observer(observed),
        bootId: BOOT, boxCgroupPrefix: BOX,
    });
    assert.deepEqual(idle, { state: 'idle' });
});

test('H.pid-reuse', () => {
    const observed = new Map([
        [12, { hostPid: 12, bootId: BOOT, startIdentity: 'start-REUSED', cgroup: `${BOX}/ploinky/core` }],
    ]);
    const result = evaluateGpuIdleGate({
        query: okQuery('12\n'), activity: idleActivity, owned: [ownedRecord(12)], observe: observer(observed),
        bootId: BOOT, boxCgroupPrefix: BOX,
    });
    assert.equal(result.state, 'blocked');
    assert.equal(result.reason, 'owned_provenance_unproved');
});

test('H.query-error', () => {
    for (const query of [
        { ok: false, status: 1, stdout: '' },
        { ok: true, status: 9, stdout: '' },
        { ok: true, status: 0, signal: 'SIGKILL', stdout: '' },
        { ok: true, status: 0, timedOut: true, stdout: '' },
    ]) {
        const result = evaluateGpuIdleGate({ query, activity: idleActivity, initial: true });
        assert.deepEqual(result, { state: 'blocked', reason: 'query_error' });
    }
});

test('H.malformed-pids', () => {
    for (const stdout of ['12\nabc\n', '12 34\n', '-5\n', '0\n', '1.5\n', '99999999999\n']) {
        const result = evaluateGpuIdleGate({ query: okQuery(stdout), activity: idleActivity, initial: true });
        assert.deepEqual(result, { state: 'blocked', reason: 'malformed_output' }, stdout);
    }
});

test('H.initial-busy', () => {
    const result = evaluateGpuIdleGate({ query: okQuery('4242\n'), activity: idleActivity, initial: true });
    assert.deepEqual(result, { state: 'blocked', reason: 'gpu_busy', foreign: [4242] });
    assert.deepEqual(evaluateGpuIdleGate({ query: okQuery(''), activity: idleActivity, initial: true }), { state: 'idle' });
});

test('H.graphics-unknown-blocked', () => {
    assert.deepEqual(
        evaluateGpuIdleGate({ query: okQuery(''), activity: null, initial: true }),
        { state: 'blocked', reason: 'activity_unknown' },
    );
    assert.deepEqual(
        evaluateGpuIdleGate({ query: okQuery(''), activity: { supported: false }, initial: true }),
        { state: 'blocked', reason: 'activity_unknown' },
    );
    assert.deepEqual(
        evaluateGpuIdleGate({ query: okQuery(''), activity: { supported: true, foreign: ['Xorg:777'] }, initial: true }),
        { state: 'blocked', reason: 'gpu_busy', foreign: ['Xorg:777'] },
    );
});

test('H.duplicate-leaf-title-under-two-parents', async (t) => {
    const header = "import test, { describe } from 'node:test';\n";
    // A failing leaf followed by a passing leaf with the same title under
    // another parent: the failure keeps its own identity and is reported.
    const unrequired = await run(t, { 'a.test.mjs': `${header}describe('A', () => { test('leaf', () => { throw new Error('real failure'); }); });\ndescribe('B', () => { test('leaf', () => {}); });\n` });
    assert.equal(unrequired.result.verdict, 'FAIL');
    assert.deepEqual(unrequired.result.newFailures.map((entry) => entry.testId), ['a.test.mjs::A > leaf']);
    assert.equal(unrequired.result.inventory.get('a.test.mjs::B > leaf'), 'pass');
    // A required title shared by a failing and a passing leaf never passes.
    for (const order of [['throw new Error(\'required broken\')', ''], ['', 'throw new Error(\'required broken\')']]) {
        const { result } = await run(t, { 'a.test.mjs': `${header}describe('A', () => { test('REQ.x', () => { ${order[0]} }); });\ndescribe('B', () => { test('REQ.x', () => { ${order[1]} }); });\n` },
            { required: [requiredCase('a.test.mjs', 'REQ.x')] });
        assert.equal(result.verdict, 'FAIL');
        assert.equal(result.cases[0].result, 'fail');
        assert.match(result.cases[0].reason, /ambiguous/);
        assert.equal(result.newFailures.length, 1);
    }
    // A repeated identity (same title under the same parent) is a harness problem.
    const repeated = await run(t, { 'a.test.mjs': `${header}test('leaf', () => { throw new Error('first'); });\ntest('leaf', () => {});\n` });
    assert.equal(repeated.result.verdict, 'FAIL');
    assert.ok(repeated.result.problems.some((problem) => /duplicate test identity: a\.test\.mjs::leaf/.test(problem)), repeated.result.problems.join('\n'));
    assert.equal(repeated.result.newFailures.length, 1, 'the earlier failure is not replaced by the later pass');
});

test('H.p3-explorer-sibling-is-the-configured-ploinky-candidate', async (t) => {
    const { spawnSync } = await import('node:child_process');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-layout-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    // An Explorer candidate whose test imports Ploinky as its sibling, next to
    // an unrelated 'ploinky' directory (the layout V3 found).
    const explorer = path.join(root, 'side', 'explorer-candidate');
    write(path.join(explorer, 'explorer/tests/unit/layout.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { identity } from '../../../../ploinky/identity.mjs';\ntest('layout.leaf', () => assert.equal(identity, 'configured'));\n");
    write(path.join(explorer, 'package.json'), '{"type":"module"}\n');
    const gitIn = (cwd, ...args) => { const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    gitIn(explorer, 'init', '-q'); gitIn(explorer, 'add', '-A'); gitIn(explorer, 'commit', '-q', '-m', 'fixture');
    const digest = `git-tree:${gitIn(explorer, 'rev-parse', 'HEAD^{tree}')}`;
    write(path.join(root, 'side', 'ploinky', 'identity.mjs'), "export const identity = 'unrelated';\n");
    const candidate = path.join(root, 'candidates', 'ploinky-candidate');
    write(path.join(candidate, 'identity.mjs'), "export const identity = 'configured';\n");
    assert.throws(() => assertExplorerPloinkySibling(explorer, candidate), /not the configured Ploinky candidate/);
    // Staged: the configured candidate becomes the sibling and the test passes.
    const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence);
    const layout = prepareExplorerLayout({ explorerRoot: explorer, explorerDigest: digest, ploinkyRoot: candidate, stageParent: evidence, runId: 'a'.repeat(32) });
    assert.equal(layout.staged, true);
    assert.equal(fs.realpathSync(path.join(path.dirname(layout.root), 'ploinky')), candidate);
    const run = await runSuite({ root: layout.root, files: ['explorer/tests/unit/layout.test.js'], runId: randomRunId(), childId: 'layout', eventsPath: path.join(evidence, 'events.jsonl'),
        required: [requiredCase('explorer/tests/unit/layout.test.js', 'layout.leaf')] });
    assert.equal(run.verdict, 'PASS', JSON.stringify(run.cases));
    // The unrelated sibling in place would have failed the same test.
    const inPlace = await runSuite({ root: explorer, files: ['explorer/tests/unit/layout.test.js'], runId: randomRunId(), childId: 'in-place', eventsPath: path.join(evidence, 'in-place.jsonl'),
        required: [requiredCase('explorer/tests/unit/layout.test.js', 'layout.leaf')] });
    assert.equal(inPlace.verdict, 'FAIL');
    // Refusals: an existing stage, and a staged copy that differs from the digest.
    assert.throws(() => prepareExplorerLayout({ explorerRoot: explorer, explorerDigest: digest, ploinkyRoot: candidate, stageParent: evidence, runId: 'a'.repeat(32) }), /existing Explorer layout stage/);
    assert.throws(() => prepareExplorerLayout({ explorerRoot: explorer, explorerDigest: `sha256:${'0'.repeat(64)}`, ploinkyRoot: candidate, stageParent: evidence, runId: 'b'.repeat(32) }), /differs from the configured candidate digest/);
    assert.equal(fs.existsSync(path.join(evidence, `explorer-layout-${'b'.repeat(32)}`)), false, 'a refused stage is removed');
    // In place when the sibling already is the configured candidate.
    const correct = prepareExplorerLayout({ explorerRoot: explorer, explorerDigest: digest, ploinkyRoot: path.join(root, 'side', 'ploinky'), stageParent: evidence, runId: 'c'.repeat(32) });
    assert.deepEqual(correct, { root: explorer, staged: false, stage: null });
    // A suite that mutates the staged copy invalidates the run.
    assert.doesNotThrow(() => assertExplorerLayoutUnchanged(layout));
    fs.writeFileSync(path.join(layout.root, 'explorer/drift.mjs'), 'changed');
    assert.throws(() => assertExplorerLayoutUnchanged(layout), /candidate source changed/);
});

// N19: the spawn calls themselves are recorded. Hashing never pipes bytes into
// a child (no `input`, no piped or inherited stdin), and the archive goes
// through a task-owned file: putting `git hash-object --stdin` or a tar stdin
// pipe back would be seen here, not only through the results.
test('H.baseline-stage-spawn-calls-never-use-stdin', async (t) => {
    const { createBaselineStage } = await import('../hardware-limits/verify.mjs');
    const childProcess = (await import('node:child_process')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-stage-calls-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
    const git = (args) => { const result = childProcess.spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    git(['init', '-q']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n'); fs.writeFileSync(path.join(repo, 'b.bin'), Buffer.alloc(4096, 3));
    git(['add', '-A']); git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'fixture']);
    const revision = git(['rev-parse', 'HEAD']);
    const calls = [];
    const original = childProcess.spawnSync;
    const recorded = function recordedSpawnSync(...args) { calls.push(args); return original.apply(this, args); };
    childProcess.spawnSync = recorded; syncBuiltinESMExports();
    try { assert.deepEqual(createBaselineStage(repo, revision, path.join(root, 'stage')), { checked: 2 }); }
    finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
    assert.ok(calls.length >= 3, `the stage ran child processes: ${calls.length}`);
    for (const [program, argv, options = {}] of calls) {
        const label = `${program} ${argv.join(' ')}`;
        assert.equal(Object.hasOwn(options, 'input'), false, `${label}: no input option`);
        assert.notEqual(options.stdio?.[0], 'pipe', `${label}: stdin is not piped`);
        assert.notEqual(options.stdio?.[0], 'inherit', `${label}: stdin is not inherited`);
        assert.equal(argv.includes('--stdin'), false, `${label}: no --stdin`);
        assert.equal(argv.includes('--stdin-paths'), false, `${label}: no --stdin-paths`);
        assert.equal(argv.includes('-'), false, `${label}: no standard-input operand`);
    }
    const archive = calls.find(([program, argv]) => program === 'git' && argv.includes('archive'));
    assert.ok(archive && archive[1].includes('-o'), 'the archive is written to a task-owned file');
    const extract = calls.find(([program]) => program === 'tar');
    assert.ok(extract && extract[1].includes('-f'), 'tar reads that file, not standard input');
    assert.equal(calls.some(([, argv]) => argv.includes('hash-object')), false, 'blob ids are computed in process');
});

// Staging never feeds a child through stdin (spawnSync stdin piping stalls
// intermittently on macOS): blob ids are computed in process and must equal
// git's own, and a staged revision is verified file by file.
test('H.baseline-stage-hashes-without-stdin', async (t) => {
    const { gitBlobId, createBaselineStage } = await import('../hardware-limits/verify.mjs');
    const { spawnSync } = await import('node:child_process');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-stage-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
    const run = (args) => { const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    run(['init', '-q']);
    const files = { 'large.bin': Buffer.alloc(109548, 7), 'empty.txt': Buffer.alloc(0), 'nested/text.txt': Buffer.from('line\r\nwith crlf\n') };
    for (const [name, bytes] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), bytes); }
    for (const [name, bytes] of Object.entries(files)) assert.equal(gitBlobId(bytes), run(['hash-object', '--no-filters', name]), name);
    run(['add', '-A']); run(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'fixture']);
    const revision = run(['rev-parse', 'HEAD']);
    const stage = path.join(root, 'stage');
    assert.deepEqual(createBaselineStage(repo, revision, stage), { checked: 3 });
    assert.equal(fs.existsSync(`${stage}.archive.tar`), false, 'the task-owned archive is removed');
    assert.deepEqual(fs.readFileSync(path.join(stage, 'large.bin')), files['large.bin']);
    // A tiny deadline is reported clearly, not as a hang.
    assert.throws(() => createBaselineStage(repo, revision, path.join(root, 'stage-timeout'), { timeoutMs: 1 }), /timed out after 1 ms|failed/);
});

// R22 (R5): the p5 calibration leaves are the tests of local-llm/tests/vllm-mps-calibration.test.mjs at local-llms e572c1a, the 21 older ones plus the 6 that
// f502797 added (the accelerator total) and the 3 that e572c1a added (the anchored rules). A test left out of the manifest is never required.
test('H.the-p5-calibration-leaves-include-the-tests-added-for-the-accelerator-total-and-the-anchored-rules', () => {
    const file = 'local-llm/tests/vllm-mps-calibration.test.mjs';
    const leaves = buildRequiredCaseManifest().cases.filter((entry) => entry.phase === 'p5' && entry.repo === 'local-llms' && entry.file === file);
    const names = leaves.map((entry) => entry.name);
    assert.equal(new Set(names).size, names.length, 'no title is listed twice');
    assert.equal(names.length, 30);
    for (const name of [
        'CAL.the-real-vllm-0-30-0-statement-was-refused-by-the-old-rule-and-the-real-tree-excerpts-qualify-with-exactly-the-mem-utils-line',
        'CAL.a-denominator-from-a-constant-or-the-device-properties-in-the-real-tree-is-blocked-even-with-the-sleep-mode-line-present',
        'CAL.a-statement-counts-only-in-its-reviewed-file-class-and-method',
        'CAL.the-enclosing-python-scope-is-read-from-the-indentation-of-the-executable-code',
        'CAL.only-the-accelerator-total-in-its-reviewed-position-and-executable-code-is-a-sizing-statement',
        'CAL.the-accelerator-api-is-measured-under-both-limits-and-recorded-raw-next-to-the-cuda-and-driver-views',
        'CAL.the-accelerator-view-must-agree-exactly-with-the-cuda-views-and-with-the-driver-under-each-limit',
        'CAL.an-unavailable-accelerator-api-is-a-blocking-prerequisite-with-a-clear-message',
        'CAL.the-torch-query-runs-and-records-the-accelerator-pair-or-its-error',
    ]) assert.ok(names.includes(name), name);
});
