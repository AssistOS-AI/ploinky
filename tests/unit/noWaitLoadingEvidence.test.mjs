import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

import {
    captureRequiredState,
    inspectRunnerState,
    recordLatchedIntegrationPass,
    runEvidenceStep,
    verifyNoWaitEvidenceBundle,
} from '../release/noWaitLoadingEvidence.mjs';

function command(name, args, cwd) {
    const result = spawnSync(name, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${name} ${args.join(' ')}\n${result.stderr}`);
    return String(result.stdout || '').trim();
}

function gitFixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'no-wait-evidence-git-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    command('git', ['init'], root);
    command('git', ['config', 'user.email', 'no-wait-evidence@example.invalid'], root);
    command('git', ['config', 'user.name', 'No Wait Evidence Test'], root);
    fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
    command('git', ['add', 'README.md'], root);
    command('git', ['commit', '-m', 'Create evidence fixture'], root);
    command('git', ['remote', 'add', 'canonical', 'https://github.com/AssistOS-AI/AssistOSExplorer.git'], root);
    const head = command('git', ['rev-parse', 'HEAD'], root);
    command('git', ['update-ref', 'refs/remotes/canonical/main', head], root);
    return {
        root,
        head,
        remoteName: 'canonical',
        remoteUrl: 'https://github.com/AssistOS-AI/AssistOSExplorer.git',
        expectedRef: 'refs/remotes/canonical/main',
    };
}

test('required state capture is atomic and refuses an empty artifact', async (t) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'no-wait-state-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const populated = path.join(root, 'fixture-state.env');
    await captureRequiredState({
        outputPath: populated,
        command: [process.execPath, '-e', "process.stdout.write('fixture=ready\\n')"],
        cwd: root,
    });
    assert.equal(fs.readFileSync(populated, 'utf8'), 'fixture=ready\n');
    assert.ok(fs.statSync(`${populated}.command.txt`).size > 0);

    const empty = path.join(root, 'cleanup-state.env');
    await assert.rejects(
        captureRequiredState({
            outputPath: empty,
            command: [process.execPath, '-e', ''],
            cwd: root,
        }),
        /produced an empty artifact/,
    );
    assert.equal(fs.existsSync(empty), false);

    const stderrOnly = path.join(root, 'stderr-only.env');
    await assert.rejects(
        captureRequiredState({
            outputPath: stderrOnly,
            command: [process.execPath, '-e', "process.stderr.write('not state\\n')"],
            cwd: root,
        }),
        /produced an empty artifact/,
    );
    assert.equal(fs.existsSync(stderrOnly), false);
});

test('gate wrapper records a clean exact runner and redacts sensitive smoke values', async (t) => {
    const runner = gitFixture(t);
    const bundle = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'no-wait-feature-bundle-'));
    t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
    await captureRequiredState({
        outputPath: path.join(bundle, 'fixture-state.env'),
        command: [process.execPath, '-e', "process.stdout.write('fixture=fresh\\n')"],
        cwd: runner.root,
    });
    const secret = 'not-for-evidence';
    await runEvidenceStep({
        bundleDir: bundle,
        kind: 'feature',
        step: 'playwright',
        runnerRoot: runner.root,
        expectedSha: runner.head,
        remoteName: runner.remoteName,
        expectedRemoteUrl: runner.remoteUrl,
        expectedRef: runner.expectedRef,
        requiredArtifacts: ['fixture-state.env'],
        command: [process.execPath, '-e', "process.stdout.write('1 passed\\n')", secret],
        cwd: runner.root,
        env: {
            ...process.env,
            SMOKE_RUN_ID: 'no-wait-test',
            SMOKE_ARTIFACT_DIR: path.join(bundle, 'playwright'),
            SMOKE_PASSWORD: secret,
        },
    });

    const commandEvidence = fs.readFileSync(path.join(bundle, 'playwright', 'command.txt'), 'utf8');
    const runnerEvidence = fs.readFileSync(path.join(bundle, 'playwright', 'runner-state.txt'), 'utf8');
    assert.doesNotMatch(commandEvidence, new RegExp(secret));
    assert.match(commandEvidence, /"SMOKE_PASSWORD": "<redacted>"/);
    assert.match(commandEvidence, /"SMOKE_RUN_ID": "no-wait-test"/);
    assert.match(runnerEvidence, new RegExp(`\\$ git rev-parse HEAD\\n${runner.head}`));
    assert.match(runnerEvidence, /\$ git status --short\n\n/);
    assert.match(runnerEvidence, /verdict=PASS/);
});

test('feature bundle verification fails closed on empty cleanup state', async (t) => {
    const runner = gitFixture(t);
    const bundle = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'no-wait-complete-bundle-'));
    t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
    await captureRequiredState({
        outputPath: path.join(bundle, 'fixture-state.env'),
        command: [process.execPath, '-e', "process.stdout.write('fixture=fresh\\n')"],
        cwd: runner.root,
    });
    await runEvidenceStep({
        bundleDir: bundle,
        kind: 'feature',
        step: 'playwright',
        runnerRoot: runner.root,
        expectedSha: runner.head,
        remoteName: runner.remoteName,
        expectedRemoteUrl: runner.remoteUrl,
        expectedRef: runner.expectedRef,
        requiredArtifacts: ['fixture-state.env'],
        command: [process.execPath, '-e', "process.stdout.write('1 passed\\n')"],
        cwd: runner.root,
        env: {
            ...process.env,
            SMOKE_RUN_ID: 'no-wait-complete-test',
            SMOKE_ARTIFACT_DIR: path.join(bundle, 'playwright'),
        },
    });
    const resultsDirectory = path.join(bundle, 'playwright', 'test-results');
    fs.mkdirSync(resultsDirectory, { recursive: true });
    fs.writeFileSync(path.join(resultsDirectory, 'results.json'), '{"status":"passed"}\n');
    const cleanup = path.join(bundle, 'cleanup-state.env');
    await captureRequiredState({
        outputPath: cleanup,
        command: [process.execPath, '-e', "process.stdout.write('resources=absent\\n')"],
        cwd: runner.root,
    });
    assert.equal(verifyNoWaitEvidenceBundle({ bundleDir: bundle, kind: 'feature' }).kind, 'feature');

    fs.truncateSync(cleanup, 0);
    assert.throws(
        () => verifyNoWaitEvidenceBundle({ bundleDir: bundle, kind: 'feature' }),
        /must be one non-empty regular file/,
    );
    fs.writeFileSync(cleanup, ' \n');
    assert.throws(
        () => verifyNoWaitEvidenceBundle({ bundleDir: bundle, kind: 'feature' }),
        /must not contain only whitespace/,
    );
});

test('release gate refuses to execute without retained attestation and readiness evidence', async (t) => {
    const runner = gitFixture(t);
    const bundle = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'no-wait-release-bundle-'));
    t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
    await captureRequiredState({
        outputPath: path.join(bundle, 'fixture-state.env'),
        command: [process.execPath, '-e', "process.stdout.write('fixture=fresh\\n')"],
        cwd: runner.root,
    });
    const executionMarker = path.join(bundle, 'gate-executed');
    await assert.rejects(
        runEvidenceStep({
            bundleDir: bundle,
            kind: 'release',
            step: 'onlyoffice',
            runnerRoot: runner.root,
            expectedSha: runner.head,
            remoteName: runner.remoteName,
            expectedRemoteUrl: runner.remoteUrl,
            expectedRef: runner.expectedRef,
            command: [
                process.execPath,
                '-e',
                `require('node:fs').writeFileSync(${JSON.stringify(executionMarker)}, 'executed')`,
            ],
            cwd: runner.root,
            env: {
                ...process.env,
                SMOKE_RUN_ID: 'missing-attestation',
                SMOKE_ARTIFACT_DIR: path.join(bundle, 'onlyoffice'),
            },
        }),
        /attestation-readiness\.txt.*is missing/,
    );
    assert.equal(fs.existsSync(executionMarker), false);
});

test('runner and live-latch records reject dirty source and bind a clean pass to HEAD', (t) => {
    const runner = gitFixture(t);
    const snapshot = inspectRunnerState({
        runnerRoot: runner.root,
        expectedSha: runner.head,
        remoteName: runner.remoteName,
        expectedRemoteUrl: runner.remoteUrl,
        expectedRef: runner.expectedRef,
    });
    assert.deepEqual(snapshot.failures, []);

    const passPath = path.join(runner.root, '..', `latched-pass-${path.basename(runner.root)}.json`);
    t.after(() => fs.rmSync(passPath, { force: true }));
    recordLatchedIntegrationPass({ outputPath: passPath, repositoryRoot: runner.root });
    const pass = JSON.parse(fs.readFileSync(passPath, 'utf8'));
    assert.equal(pass.gitRevParseHead, runner.head);
    assert.equal(pass.gitStatusShort, '');
    assert.equal(pass.result, 'PASS');

    fs.writeFileSync(path.join(runner.root, 'dirty.txt'), 'dirty\n');
    const dirtySnapshot = inspectRunnerState({
        runnerRoot: runner.root,
        expectedSha: runner.head,
        remoteName: runner.remoteName,
        expectedRemoteUrl: runner.remoteUrl,
        expectedRef: runner.expectedRef,
    });
    assert.match(dirtySnapshot.failures.join(' '), /not clean/);
    assert.throws(
        () => recordLatchedIntegrationPass({
            outputPath: `${passPath}.dirty`,
            repositoryRoot: runner.root,
        }),
        /requires a clean repository status/,
    );
});
