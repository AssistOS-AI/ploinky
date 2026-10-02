import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
