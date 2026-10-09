import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { manifestFixture } from '../liveUpdateCache/test_support.mjs';
import { parseArgs, unverifiedRecords, assertOptionalActivationText, classifyUpdateReturn } from './run.mjs';
import { formatUpdateStatusLine } from '../../../ploinky-box/bin/ploinky-box.mjs';
import { buildUpdateResult, createOperationRecord } from '../../../cli/commands/updateOutcome.js';

const spawnSync = cp.spawnSync;
const here = path.dirname(fileURLToPath(import.meta.url));
const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'uc-continuation-'));
after(() => fs.rmSync(parent, { recursive: true, force: true }));

test('the manifest is a mandatory argument and every other option stays exact', () => {
    const base = ['--workspace', '/w', '--artifacts', '/a', '--manifest', '/m_codex.json'];
    assert.deepEqual(parseArgs(base), { workspace: '/w', artifacts: '/a', manifest: '/m_codex.json', generation: null, ploinky: path.join(here, '../../../bin/ploinky'), timeoutMs: 1_200_000 });
    assert.equal(parseArgs([...base, '--generation', 'sha256:abc']).generation, 'sha256:abc');
    assert.equal(parseArgs(['--help']), null); assert.equal(parseArgs([...base, '--timeout-ms', '5000']).timeoutMs, 5000);
    for (const bad of [[], ['--workspace', '/w', '--artifacts', '/a'], [...base, '--manifest', '/n'], [...base, '--bogus', 'x'], [...base, '--generation', 'bad value'], [...base, '--generation', '--timeout-ms'], [...base, '--timeout-ms', '10'], [...base, '--timeout-ms', '99999999'], ['--workspace', '--artifacts', '/a', '--manifest', '/m']]) {
        assert.throws(() => parseArgs(bad), error => /Usage:|--timeout-ms/.test(error.message));
    }
});

test('old line-308 acceptance alternative reproduces a false pass; the new predicate refuses it', () => {
    const notLive = 'Update partially failed (exit status 1):\nActivation not required; no configured running workspace required a restart.\n';
    const restarted = 'Update partially failed (exit status 1):\nActivation: the workspace graph was restarted and the Router health check passed.\n';
    // The predicate as it stood before this change.
    const oldPredicate = /Activation: the workspace graph was restarted and the Router health check passed\.|Activation not required; no configured running workspace required a restart\./;
    assert.match(notLive, oldPredicate, 'before: a deployment with no running graph satisfied the first-pass activation check');
    assert.throws(() => assertOptionalActivationText(notLive)); assert.doesNotThrow(() => assertOptionalActivationText(restarted));
    assert.throws(() => assertOptionalActivationText(`${restarted}Activation was blocked by: x.\n`)); assert.throws(() => assertOptionalActivationText('Update failed\n'));
});

test('record parsing keeps only the named outcome columns', () => {
    const rows = unverifiedRecords('  - registered-repository AAx: skipped (detached-head, optional)\n  - skills-manifest /w/s: failed (manifest-invalid, required (membership unknown))\nnoise PRIVATE\n');
    assert.deepEqual(rows, [{ phase: 'registered-repository', id: 'AAx', outcome: 'skipped', code: 'detached-head', membership: 'optional' },
        { phase: 'skills-manifest', id: '/w/s', outcome: 'failed', code: 'manifest-invalid', membership: 'required (membership unknown)' }]);
});

test('without a matching admitted manifest the runner refuses before creating any fixture, artifact or product import', () => {
    const home = path.join(parent, 'home'), workspace = path.join(home, 'work', 'testExplorerFresh'), candidate = path.join(parent, 'candidate');
    fs.mkdirSync(path.join(workspace, '.ploinky', 'repos'), { recursive: true }); fs.mkdirSync(path.join(candidate, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(candidate, 'bin', 'ploinky'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
    const evidence = path.join(parent, 'evidence'); fs.mkdirSync(evidence);
    const manifest = path.join(parent, 'manifest_codex.json'); fs.writeFileSync(manifest, JSON.stringify(manifestFixture().value), { mode: 0o600 });
    const before = fs.readdirSync(workspace).sort(), artifacts = path.join(parent, 'artifacts');
    const run = extra => spawnSync(process.execPath, [path.join(here, 'run.mjs'), '--workspace', workspace, '--artifacts', artifacts, '--ploinky', path.join(candidate, 'bin', 'ploinky'), ...extra],
        { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 30000 });
    for (const [label, args] of [['missing manifest', []], ['foreign workspace in the manifest', ['--manifest', manifest]], ['absent manifest file', ['--manifest', path.join(parent, 'none_codex.json')]]]) {
        const result = run(args); assert.notEqual(result.status, 0, label); assert.match(result.stderr, /Usage:|names another workspace|ENOENT|worker-file|manifest/i, label);
        assert.deepEqual(fs.readdirSync(workspace).sort(), before, `${label}: the workspace is unchanged`); assert.equal(fs.existsSync(artifacts), false, `${label}: no artifact directory`);
        assert.deepEqual(fs.readdirSync(path.join(workspace, '.ploinky', 'repos')), [], `${label}: no repository fixture`);
    }
});

test('source no longer contains detached process groups, signals or the not-live activation alternative', () => {
    const source = fs.readFileSync(path.join(here, 'run.mjs'), 'utf8');
    for (const forbidden of ['detached: true', 'process.kill', "'SIGKILL'", "'SIGTERM'", '-child.pid', "|Activation not required; no configured running workspace required a restart", 'spawn(ploinky']) assert.equal(source.includes(forbidden), false, forbidden);
    assert.match(source, /admitLive\(options\)[\s\S]*loadProduct\(cliRoot\)/, 'live admission precedes the product helper import and every fixture');
    assert.match(source, /allowedExitCodes: \[1\]/);
    assert.match(source, /live\.admit\(options\.generation \? \{ activeGeneration: options\.generation \} : \{\}\)/, 'admission uses the parent-admitted generation, not the manifest\'s pre-update one');
});

const clean = { owned: true, recoveryBarrier: false, stateReadErrors: 0 };
const exceptionOutput = (wording = 'Update failed before a new graph was activated; the previous workspace graph was left as it was. Source checkouts that were already pulled are not rolled back.') => {
    const failed = buildUpdateResult({ command: ['update', 'all', '/w'], records: [createOperationRecord({ phase: 'activation', id: 'update-transaction', outcome: 'failed', required: true, code: 'update-failed', reason: 'boom' })] });
    return `${formatUpdateStatusLine(failed)}\n${wording}\n`;
};

test('exit status 1 is a normal return only with the normal wording, no exception-path output and a clean recovery state', () => {
    const optional = 'Update partially failed (exit status 1): failed or uncertain: x.\nActivation: the workspace graph was restarted and the Router health check passed.\n';
    const required = 'Update failed (exit status 1): not verified: y.\nActivation deferred; the running workspace graph was not restarted. Updated sources may require activation: run `ploinky restart` to activate them.\nActivation was blocked by: z.\n';
    assert.deepEqual(classifyUpdateReturn({ label: 'optional-errors', output: optional, status: clean }), { normal: true, reasons: [] });
    assert.deepEqual(classifyUpdateReturn({ label: 'unknown-required-scope', output: required, status: clean }), { normal: true, reasons: [] });
    // The product's real exception-path output, produced by its own formatter, also exits 1 and must never be classed normal.
    for (const wording of [undefined, 'Update failed; reconstruction of the previous Box and graph configuration was attempted and passed its checks.', 'Update failed and the previous workspace state could not be fully reconstructed; recover it.',
        'Update did not start in this workspace: its mutation lock could not be acquired.', 'Update failed; the activation outcome could not be determined.']) {
        for (const label of ['optional-errors', 'unknown-required-scope']) {
            const result = classifyUpdateReturn({ label, output: exceptionOutput(wording), status: clean }); assert.equal(result.normal, false, `${label}: ${wording}`); assert.ok(result.reasons.includes('exception-path-output') || result.reasons.includes('normal-return-wording-absent'));
        }
    }
    assert.equal(classifyUpdateReturn({ label: 'optional-errors', output: `${exceptionOutput()}${optional}`, status: clean }).normal, false, 'wording mixed with an exception record is still refused');
    assert.deepEqual(classifyUpdateReturn({ label: 'optional-errors', output: required, status: clean }).reasons, ['normal-return-wording-absent'], 'the other pass wording is not accepted');
    for (const status of [{ ...clean, recoveryBarrier: true }, { ...clean, stateReadErrors: 1 }, { ...clean, owned: false }, undefined, { owned: true }]) {
        assert.equal(classifyUpdateReturn({ label: 'optional-errors', output: optional, status }).normal, false, JSON.stringify(status));
    }
    assert.equal(classifyUpdateReturn({ label: 'other', output: optional, status: clean }).normal, false);
});

test('fixtures are marked safe to clean only through the normal-return classification', () => {
    const source = fs.readFileSync(path.join(here, 'run.mjs'), 'utf8');
    assert.equal((source.match(/unsafeToClean = false/g) || []).length, 1, 'only the declaration initialises it to false'); assert.match(source, /unsafeToClean = !classification\.normal;/);
    assert.match(source, /const classification = classifyUpdateReturn\(\{ label, output, status \}\);[\s\S]*assert\.equal\(classification\.normal, true/);
    assert.match(source, /status = await admission\.workerHost\.status\(\)/);
});
