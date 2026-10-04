// Mutants of the D4 setter check (D-R25-P-01): each removes or weakens one part of the check in a child process that loads the mutated module, and must
// make the control in hardwareLimitsD4Setter.test.mjs that guards it FAIL by its own assertion. A control run of the same test, unmutated, must pass
// first, so that a failing child is never a setup problem (an import error, a patch that did not apply, a timeout). The patching machinery is the
// existing one (an exact patch that must match once, applied as the module loads); nothing on disk changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { ROOT, applyPatches, describeMutation } from '../hardware-limits/c5Mutation.mjs';

const href = (relative) => pathToFileURL(path.join(ROOT, relative)).href;
const CONTRACT = href('tests/helpers/agentlibTestContract.mjs');
const GUARD = href('tests/helpers/engineSpawnGuard.mjs');
const REGISTER = href('tests/hardware-limits/c5MutationRegister.mjs');

const STORE = 'cli/sandbox/hardwareLimits/store.mjs';
const ROUTES = 'cli/server/authHandlers/hardwareLimitsRoutes.mjs';
const CONTROLS = 'tests/unit/hardwareLimitsD4Setter.test.mjs';
const CALL = '            admitProposed({ agentRef, entry: validated.entry, agents: new Map(agents) });\n';
const WIRING = ', admitProposed: ({ agentRef, agents }) => refuseUnenforceableProposal({ agentRef, agents, context, getInstalled, getRegistry, admit }) })';
const LOOP = 'for (const record of [{}, ...records]) {\n        let admission;';
const COMMIT_RETURN = '        return committedResult(result, { effective: validated });';
const MAIN = { file: CONTROLS, pattern: 'D4S\\.a-host-network-nested-podman-agent-is-refused' };

export const D4_MUTANTS = Object.freeze({
    'store-never-calls-the-admission': { name: 'store-never-calls-the-admission', file: STORE, kill: MAIN, patches: [{ from: CALL, to: '' }] },
    'store-admits-after-the-commit': { name: 'store-admits-after-the-commit', file: STORE, kill: MAIN, patches: [
        { from: CALL, to: '' },
        { from: COMMIT_RETURN, to: `        admitProposed({ agentRef, entry: validated.entry, agents: new Map(agents) });\n${COMMIT_RETURN}` },
    ] },
    'store-does-not-audit-the-refusal': { name: 'store-does-not-audit-the-refusal', file: STORE, kill: MAIN, patches: [
        { from: "recordRefusedAttempt({ paths, fsApi, now, actor, action: 'set', ref:", to: "void ({ paths, fsApi, now, actor, action: 'set', ref:" },
    ] },
    'route-does-not-pass-the-admission': { name: 'route-does-not-pass-the-admission', file: ROUTES, kill: MAIN, patches: [{ from: WIRING, to: ' })' }] },
    'route-admits-the-stored-overrides-not-the-proposal': { name: 'route-admits-the-stored-overrides-not-the-proposal', file: ROUTES, kill: MAIN, patches: [
        { from: 'const proposed = { ...context, overrides: agents };', to: 'const proposed = { ...context };' },
    ] },
    'route-skips-the-default-record': { name: 'route-skips-the-default-record', file: ROUTES,
        kill: { file: CONTROLS, pattern: 'D4S\\.the-default-record-alone-refuses' }, patches: [{ from: LOOP, to: 'for (const record of [...records]) {\n        let admission;' }] },
    'route-skips-the-registry-instances': { name: 'route-skips-the-registry-instances', file: ROUTES,
        kill: { file: CONTROLS, pattern: 'D4S\\.a-profile-that-only-one-registry-instance-selects' }, patches: [{ from: LOOP, to: 'for (const record of [{}]) {\n        let admission;' }] },
    'route-propagates-every-refusal': { name: 'route-propagates-every-refusal', file: ROUTES,
        kill: { file: CONTROLS, pattern: 'D4S\\.only-the-d4-refusal-propagates' }, patches: [
            { from: "if (refusal?.reasonCode === 'host_network_nested_podman') throw", to: 'if (refusal) throw' },
        ] },
    'route-propagates-an-admission-failure': { name: 'route-propagates-an-admission-failure', file: ROUTES,
        kill: { file: CONTROLS, pattern: 'D4S\\.a-record-that-cannot-be-admitted-is-skipped' }, patches: [
            { from: 'catch (_) { continue; }', to: 'catch (error) { throw error; }' },
        ] },
});

function runTest(tmp, { file, pattern }, mutation) {
    const env = { ...process.env, TMPDIR: tmp };
    delete env.C5_MUTATION;
    delete env.NODE_TEST_CONTEXT;   // a nested `node --test` reports for itself, not as a child of this run
    if (mutation) env.C5_MUTATION = JSON.stringify(mutation);
    const child = spawnSync(process.execPath, ['--import', CONTRACT, '--import', GUARD, ...(mutation ? ['--import', REGISTER] : []), '--test', '--test-concurrency=1', '--test-reporter=tap', `--test-name-pattern=${pattern}`, file],
        { cwd: ROOT, env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    const output = `${child.stdout}\n${child.stderr}`;
    const count = (name) => Number((new RegExp(`^# ${name} (\\d+)`, 'm').exec(child.stdout) || [])[1]);
    return { status: child.status, signal: child.signal, output, tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped') };
}

for (const [name, spec] of Object.entries(D4_MUTANTS)) {
    test(`D4M.${name}-is-killed-by-the-control-that-guards-it-never-by-a-setup-failure`, (t) => {
        const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-d4m-')));
        t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
        // The patch applies exactly once to the real source and changes it.
        const described = describeMutation(spec);
        assert.notEqual(described.sourceDigest, described.patchedDigest);
        // The control: the guarding test passes unmutated, exactly one test, nothing skipped.
        const control = runTest(tmp, spec.kill, null);
        assert.equal(control.status, 0, control.output.slice(-1500));
        assert.deepEqual([control.tests, control.pass, control.fail, control.skipped], [1, 1, 0, 0], control.output.slice(-800));
        // The mutant: the same test fails by its own assertion.
        const mutated = runTest(tmp, spec.kill, spec);
        assert.notEqual(mutated.status, 0, `the ${name} mutant survived`);
        assert.equal(mutated.signal, null);
        assert.equal(mutated.tests, 1, mutated.output.slice(-1500));
        assert.equal(mutated.fail, 1, mutated.output.slice(-1500));
        assert.match(mutated.output, /not ok 1 - D4S\./);
        assert.match(mutated.output, /AssertionError|Expected|expected|did not|rejects|Missing expected rejection|code: 'ERR_ASSERTION'/);
        // Not an import failure, a syntax error, an unapplied patch or a timeout.
        assert.doesNotMatch(mutated.output, /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|mutation patch matches|ETIMEDOUT|timed out/);
    });
}

test('D4M.every-patch-text-matches-the-real-source-exactly-once-and-an-unmatched-patch-is-not-a-kill', () => {
    for (const spec of Object.values(D4_MUTANTS)) {
        const source = fs.readFileSync(path.join(ROOT, spec.file), 'utf8');
        assert.notEqual(applyPatches(source, spec.patches), source, spec.name);
    }
    assert.throws(() => applyPatches(fs.readFileSync(path.join(ROOT, ROUTES), 'utf8'), [{ from: 'this text is not in the route module', to: '' }]), /matches 0 times/);
});
