import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizeFailure } from '../hardware-limits/reporter.mjs';
import { runSuite } from '../hardware-limits/verify.mjs';

async function execute(t, body, options = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-signature-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'cause.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict';\ntest('same title', () => { ${body} });\n`);
    return runSuite({ root, files: ['cause.test.mjs'], runId: 'signature-run', childId: 'signature-child', eventsPath: path.join(root, 'events.jsonl'), ...options });
}
const key = 'cause.test.mjs::same title';

test('HS.same title different failure cause is a new failure through real native runSuite', async (t) => {
    const baseline = await execute(t, `throw new Error('baseline fixture missing')`);
    assert.equal(baseline.verdict, 'FAIL'); assert.match(baseline.failureSignatures.get(key).signature, /^[a-f0-9]{64}$/);
    const candidate = await execute(t, `throw new Error('new authorization regression')`, { baseline: baseline.inventory, knownBaselineFailures: baseline.failureSignatures });
    assert.equal(candidate.verdict, 'FAIL'); assert.equal(candidate.baselineFailures.length, 0);
    assert.equal(candidate.newFailures.length, 1); assert.equal(candidate.newFailures[0].reason, 'baseline failure diagnostic changed');
});
test('HS.exact repeated diagnostic with complete proof remains comparable', async (t) => {
    const baseline = await execute(t, `throw new Error('baseline fixture missing')`);
    const candidate = await execute(t, `throw new Error('baseline fixture missing')`, { baseline: baseline.inventory, knownBaselineFailures: baseline.failureSignatures });
    assert.equal(candidate.verdict, 'PASS'); assert.equal(candidate.baselineFailures.length, 1); assert.equal(candidate.newFailures.length, 0);
});
test('HS.legacy ID-only baseline cannot waive missing diagnostic evidence', async (t) => {
    const candidate = await execute(t, `throw new Error('new authorization regression')`, { knownBaselineFailures: new Set([key]) });
    assert.equal(candidate.verdict, 'FAIL'); assert.equal(candidate.newFailures[0].reason, 'baseline failure diagnostic proof unavailable');
});
test('HS.assertion values distinguish equal custom messages', async (t) => {
    const baseline = await execute(t, `assert.equal(1, 2, 'same custom message')`);
    const candidate = await execute(t, `assert.equal(3, 2, 'same custom message')`, { knownBaselineFailures: baseline.failureSignatures });
    assert.equal(candidate.verdict, 'FAIL'); assert.equal(candidate.newFailures[0].reason, 'baseline failure diagnostic changed');
});
test('HS.required feature leaf cannot be waived even with identical baseline failure', async (t) => {
    const baseline = await execute(t, `throw new Error('fixture missing')`);
    const candidate = await execute(t, `throw new Error('fixture missing')`, { knownBaselineFailures: baseline.failureSignatures, required: [{ id: 'new-feature', file: 'cause.test.mjs', name: 'same title' }] });
    assert.equal(candidate.verdict, 'FAIL'); assert.equal(candidate.cases[0].result, 'fail');
});
test('HS.normalizes only exact owned path prefixes and omits stack locations', () => {
    const one = new Error('file /source-a/path and /temp-a/fixture/item not found'); one.stack = 'irrelevant at /source-a/file:12:5';
    const two = new Error('file /source-b/path and /temp-b/fixture/item not found'); two.stack = 'irrelevant at /source-b/file:900:1';
    const left = summarizeFailure(one, { root: '/source-a', tmpdir: '/temp-a' });
    const right = summarizeFailure(two, { root: '/source-b', tmpdir: '/temp-b' });
    assert.equal(left.signature, right.signature);
    assert.notEqual(left.signature, summarizeFailure(new Error('file /source-a/other and /temp-a/fixture/item not found'), { root: '/source-a', tmpdir: '/temp-a' }).signature);
    assert.notEqual(summarizeFailure(new Error('status 401')).signature, summarizeFailure(new Error('status 403')).signature);
});
test('HS.message truncation never hides a changed diagnostic suffix', () => {
    const prefix = 'x'.repeat(3000); const one = summarizeFailure(new Error(prefix + 'one')); const two = summarizeFailure(new Error(prefix + 'two'));
    assert.equal(one.message, two.message); assert.notEqual(one.signature, two.signature);
});
test('HS.oversized and cyclic diagnostic proof is unavailable rather than comparable', async (t) => {
    const huge = summarizeFailure(new Error('x'.repeat(70000))); assert.equal(huge.signature, null); assert.equal(huge.proofUnavailable, true);
    const cyclic = new Error('cycle'); cyclic.cause = cyclic; assert.equal(summarizeFailure(cyclic).signature, null);
    const candidate = await execute(t, `throw new Error('x'.repeat(70000))`, { knownBaselineFailures: new Map([[key, huge]]) });
    assert.equal(candidate.verdict, 'FAIL'); assert.equal(candidate.newFailures[0].reason, 'baseline failure diagnostic proof unavailable');
});

test('HS.typed assertion diagnostics cannot collide with lookalike object values', () => {
    const one = Object.assign(new Error('custom'), { actual: undefined, expected: 1 });
    const two = Object.assign(new Error('custom'), { actual: { undefined: true }, expected: 1 });
    assert.notEqual(summarizeFailure(one).signature, summarizeFailure(two).signature);
});


test('only verified mkdtemp components under the exact run TMPDIR lose random suffixes', () => {
    const locations = { tmpdir: '/owned/tmp' };
    const proof = (message) => summarizeFailure(new Error(message), locations).signature;
    for (const prefix of ['ploinky-relay-', 'ploinky-directory-permissions-']) {
        assert.equal(proof('/owned/tmp/' + prefix + 'aB12cD/child'), proof('/owned/tmp/' + prefix + 'Z98xyQ/child'));
        assert.notEqual(proof('/owned/tmp/' + prefix + 'aB12cD/child'), proof('/owned/tmp/' + prefix + 'Z98xyQ/other'));
        assert.notEqual(proof('/outside/' + prefix + 'aB12cD/child'), proof('/outside/' + prefix + 'Z98xyQ/child'));
    }
    assert.notEqual(proof('/owned/tmp/unrecognized-aB12cD/child'), proof('/owned/tmp/unrecognized-Z98xyQ/child'));
    assert.notEqual(proof('<TMP>/ploinky-relay-aB12cD/child'), proof('<TMP>/ploinky-relay-Z98xyQ/child'));
    assert.notEqual(proof('509 !== 1533 /owned/tmp/ploinky-relay-aB12cD/child'), proof('500 !== 1533 /owned/tmp/ploinky-relay-Z98xyQ/child'));
});

test('HS.proc-pid-normalization', async (t) => {
    const proof = (message, extra = {}) => summarizeFailure(Object.assign(new Error(message), extra)).signature;
    // The known Linux-only failure: same file, a different PID on every run.
    const enoent = (pid) => proof(`ENOENT: no such file or directory, open '/proc/${pid}/oom_score_adj'`, { code: 'ENOENT', errno: -2, syscall: 'open', path: `/proc/${pid}/oom_score_adj` });
    assert.equal(enoent(43132), enoent(7));
    assert.equal(proof('cannot read /proc/12'), proof('cannot read /proc/345'));
    // The rest of the diagnostic stays significant.
    assert.notEqual(proof("open '/proc/43132/oom_score_adj'"), proof("open '/proc/43132/status'"));
    assert.notEqual(proof("open '/proc/43132/oom_score_adj'"), proof("open '/proc/self/oom_score_adj'"));
    assert.notEqual(proof('/proc/12/stat 509'), proof('/proc/12/stat 500'));
    assert.notEqual(proof('pid 12 exited'), proof('pid 34 exited'));
    // Only an absolute /proc/<digits> component: not a nested path, a
    // non-numeric component or a number with a suffix.
    assert.notEqual(proof('/data/proc/12/x'), proof('/data/proc/34/x'));
    assert.notEqual(proof('/proc/12a/x'), proof('/proc/34a/x'));
    assert.notEqual(proof('/proc/12.5/x'), proof('/proc/34.5/x'));
    // Through the real runner: a known baseline failure whose only change is
    // its PID stays a baseline failure, while a changed file is a new failure.
    const body = (file) => `import test from 'node:test';\nimport fs from 'node:fs';\ntest('pid-bound', () => { fs.readFileSync('/proc/' + process.pid + '/absent-${file}'); });\n`;
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-pid-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'cause.test.mjs'), body('oom_score_adj'));
    const baseline = await runSuite({ root, files: ['cause.test.mjs'], runId: 'pid-run', childId: 'baseline', eventsPath: path.join(root, 'baseline.jsonl') });
    const known = new Map([...baseline.failureSignatures].filter(([, value]) => value));
    assert.equal(known.size, 1);
    const again = await runSuite({ root, files: ['cause.test.mjs'], runId: 'pid-run', childId: 'again', eventsPath: path.join(root, 'again.jsonl'), baseline: baseline.inventory, knownBaselineFailures: known });
    assert.equal(again.newFailures.length, 0, JSON.stringify(again.newFailures));
    assert.equal(again.baselineFailures.length, 1);
    fs.writeFileSync(path.join(root, 'cause.test.mjs'), body('status'));
    const changed = await runSuite({ root, files: ['cause.test.mjs'], runId: 'pid-run', childId: 'changed', eventsPath: path.join(root, 'changed.jsonl'), baseline: baseline.inventory, knownBaselineFailures: known });
    assert.equal(changed.newFailures.length, 1);
    assert.equal(changed.newFailures[0].reason, 'baseline failure diagnostic changed');
});

// The unit-test isolation guard the runner preloads: a test process that
// would run a container engine fails, directly, through a wrapper, through a
// shell line or in a descendant Node process, even when the code under test
// swallowed the refusal; a test-owned fake under the test temporary
// directory is fine. A harmless sentinel named podman, first on PATH, records
// any invocation that got through.
test('HS.engine-spawn-guard-fails-a-suite-that-starts-an-engine', async (t) => {
    const { engineSpawnGuardFor } = await import('../hardware-limits/verify.mjs');
    const guard = engineSpawnGuardFor(fileURLToPath(new URL('../..', import.meta.url)));
    assert.ok(guard, 'the candidate ships the guard');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-guard-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sentinelBin = path.join(root, 'sentinel-bin'); fs.mkdirSync(sentinelBin);
    const ledger = path.join(root, 'sentinel.log');
    fs.writeFileSync(path.join(sentinelBin, 'podman'), `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(ledger)}\nexit 0\n`, { mode: 0o755 });
    const header = "import test from 'node:test'; import { execFile, execFileSync, execSync, spawnSync } from 'node:child_process'; import { promisify } from 'node:util';";
    const suites = {
        'swallowed.test.mjs': "test('swallows an engine query', async () => { try { await promisify(execFile)('podman', ['ps']); } catch (_) {} });",
        'env-wrapper.test.mjs': "test('runs the engine through env', () => { try { execFileSync('/usr/bin/env', ['podman', 'ps']); } catch (_) {} });",
        'shell-line.test.mjs': "test('runs the engine in a shell line', () => { try { execSync('true && podman ps'); } catch (_) {} try { execFileSync('/bin/sh', ['-c', 'podman ps']); } catch (_) {} });",
        'descendant-node.test.mjs': "test('runs the engine in a Node child', () => { spawnSync(process.execPath, ['-e', \"try { require('node:child_process').execFileSync('podman', ['ps']); } catch (_) {}\"]); });",
        'descendant-native.test.mjs': "test('runs the engine in a native child script', () => { spawnSync('/bin/sh', ['-c', 'x=podman; $x ps']); });",
    };
    for (const [file, body] of Object.entries(suites)) fs.writeFileSync(path.join(root, file), `${header}\n${body}\n`);
    fs.writeFileSync(path.join(root, 'clean.test.mjs'), `${header} import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
test('runs only git, a lookup and a test-owned fake', () => {
    if (spawnSync('git', ['--version']).status !== 0) throw new Error('git');
    execSync('command -v podman || true');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-')); const fake = path.join(dir, 'podman');
    fs.writeFileSync(fake, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });
    if (spawnSync(fake, ['ps']).status !== 0) throw new Error('fake');
});\n`);
    const run = (file) => runSuite({ root, files: [file], runId: 'guard-run', childId: file.replace('.test.mjs', ''), eventsPath: path.join(root, `${file}.jsonl`), preload: guard,
        extraEnv: { PATH: `${sentinelBin}:/usr/bin:/bin` } });
    for (const file of Object.keys(suites)) {
        const result = await run(file);
        assert.equal(result.verdict, 'FAIL', file);
        assert.equal(result.exitCode, 1, file);
    }
    assert.equal(fs.existsSync(ledger), false, `no guarded program ran: ${fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : ''}`);
    assert.equal((await run('clean.test.mjs')).verdict, 'PASS');
});
