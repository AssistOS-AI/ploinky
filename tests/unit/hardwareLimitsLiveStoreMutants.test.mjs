// LIVE-C5 mutants of the HARNESS: each removes one guard of the lifecycle, custody or cleanup code, in a child process that loads the mutated module, and
// must make the offline test that guards it FAIL by that test's own assertion. A control run of the same test, unmutated, must pass: otherwise a failing
// child would be a setup problem (an import error, a patch that did not apply, a timeout) and earns no kill credit. The mutants of the PRODUCT's forward
// transition are in hardwareLimitsLiveStoreTransition.test.mjs. Nothing here starts a container.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { HARNESS_MUTANTS, ROOT, applyPatches, describeMutation } from '../hardware-limits/c5Mutation.mjs';
import { scratch } from '../hardware-limits/executorWorld.mjs';

const href = relative => pathToFileURL(path.join(ROOT, relative)).href;
const CONTRACT = href('tests/helpers/agentlibTestContract.mjs');
const GUARD = href('tests/helpers/engineSpawnGuard.mjs');
const REGISTER = href('tests/hardware-limits/c5MutationRegister.mjs');

function runTest(t, { file, pattern }, mutation) {
    const tmp = scratch(t, 'hwl-c5m-');
    const env = { ...process.env, TMPDIR: tmp };
    delete env.C5_MUTATION;
    delete env.NODE_TEST_CONTEXT;   // a nested `node --test` must report for itself, not as a child of this run
    if (mutation) env.C5_MUTATION = JSON.stringify(mutation);
    const child = spawnSync(process.execPath, ['--import', CONTRACT, '--import', GUARD, ...(mutation ? ['--import', REGISTER] : []), '--test', '--test-concurrency=1', '--test-reporter=tap', `--test-name-pattern=${pattern}`, file],
        { cwd: ROOT, env, encoding: 'utf8', timeout: 280000, maxBuffer: 16 * 1024 * 1024 });
    const output = `${child.stdout}\n${child.stderr}`;
    const count = name => Number((new RegExp(`^# ${name} (\\d+)`, 'm').exec(child.stdout) || [])[1]);
    return { status: child.status, signal: child.signal, output, tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped') };
}

for (const [name, spec] of Object.entries(HARNESS_MUTANTS)) {
    test(`X5.c5-harness-mutant-${name}-is-killed-by-the-test-that-guards-it-never-by-a-setup-failure`, t => {
        // The patch applies exactly once to the real source.
        const described = describeMutation(spec);
        assert.notEqual(described.sourceDigest, described.patchedDigest);
        // The control: the guarding test passes unmutated, exactly one test, nothing skipped.
        const control = runTest(t, spec.kill, null);
        assert.equal(control.status, 0, control.output.slice(-1500));
        assert.deepEqual([control.tests, control.pass, control.fail, control.skipped], [1, 1, 0, 0], control.output.slice(-800));
        // The mutant: the same test fails by its own assertion.
        const mutated = runTest(t, spec.kill, spec);
        assert.notEqual(mutated.status, 0, `the ${name} mutant survived`);
        assert.equal(mutated.signal, null);
        assert.equal(mutated.tests, 1, mutated.output.slice(-1500));
        assert.equal(mutated.fail, 1, mutated.output.slice(-1500));
        assert.match(mutated.output, /not ok 1 - X5\./);
        assert.match(mutated.output, /AssertionError|Expected|expected|did not|rejects|Missing expected rejection|code: 'ERR_ASSERTION'/);
        // Not an import failure, a syntax error, an unapplied patch or a timeout.
        assert.doesNotMatch(mutated.output, /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|mutation patch matches|ETIMEDOUT|timed out/);
        assert.equal(fs.existsSync(path.join(ROOT, spec.file)), true);
    });
}

test('X5.c5-harness-mutants-patch-text-matches-exactly-once-and-an-unmatched-patch-is-not-a-kill', t => {
    for (const spec of Object.values(HARNESS_MUTANTS)) {
        const source = fs.readFileSync(path.join(ROOT, spec.file), 'utf8');
        assert.notEqual(applyPatches(source, spec.patches), source, spec.name);
    }
    const unmatched = runTest(t, { file: 'tests/unit/hardwareLimitsLiveStoreLifecycle.test.mjs', pattern: 'evaluators-accept-only-the-typed-refusal' },
        { name: 'unapplied', file: 'tests/hardware-limits/liveStoreLifecycle.mjs', patches: [{ from: 'this text is not in the module', to: 'x' }] });
    assert.notEqual(unmatched.status, 0);
    assert.match(unmatched.output, /mutation patch matches 0 times/);
    assert.doesNotMatch(unmatched.output, /^\s*(not )?ok \d+ - X5\./m, 'the guarding test never ran, so nothing could be counted as a kill');
});
