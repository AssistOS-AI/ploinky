import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    evaluateGpuIdleGate,
    evaluateSuiteRun,
    randomRunId,
    runCleanup,
} from '../hardware-limits/fixtures.mjs';
import { runSuite } from '../hardware-limits/verify.mjs';

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
