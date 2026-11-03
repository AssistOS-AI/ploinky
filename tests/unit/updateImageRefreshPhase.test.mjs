import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-image-')));
const originalRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const { runUpdateCommand } = await import('../../cli/commands/updateCommand.js');
const { UpdateCancelledError } = await import('../../cli/commands/updateCancellation.js');
const { buildUpdateResult, createOperationRecord } = await import('../../cli/commands/updateOutcome.js');

test.after(() => {
    process.chdir(originalCwd);
    if (originalRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = originalRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

const quiet = () => {};
const gitRecord = () => createOperationRecord({ phase: 'workspace-repository', id: 'Alpha', outcome: 'changed', required: false });

function harness({ refreshImages, env = {} } = {}) {
    const calls = { handlers: 0, refresh: 0 };
    const logs = [];
    const run = (args = []) => runUpdateCommand(args, {
        env,
        insideBox: false,
        leaseWaitMs: 0,
        log: (line) => logs.push(String(line)),
        error: quiet,
        handlers: {
            updateAllRepos: async () => { calls.handlers += 1; return buildUpdateResult({ records: [gitRecord()] }); },
            updatePloinkyRepos: async () => { calls.handlers += 1; return buildUpdateResult({ records: [gitRecord()] }); },
            updateRepoResult: async () => { calls.handlers += 1; return buildUpdateResult({ records: [gitRecord()] }); },
        },
        ...(refreshImages ? { refreshImages: async (input) => { calls.refresh += 1; return refreshImages(input); } } : {}),
    });
    return { run, calls, logs };
}

test('an invalid PLOINKY_IMAGE_REFRESH fails the update before any repository mutation or lease', async () => {
    const { run, calls } = harness({ env: { PLOINKY_IMAGE_REFRESH: 'bogus' }, refreshImages: async () => [] });
    const result = await run();
    assert.equal(calls.handlers, 0);
    assert.equal(calls.refresh, 0);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.records.map((record) => [record.phase, record.outcome]), [['command', 'failed']]);
    assert.match(result.records[0].reason, /PLOINKY_IMAGE_REFRESH/);
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky', 'run', 'workspace-start.lock')), false);
});

test('image records are appended after the git records; a failed pull stays exit 0 and activation stays allowed', async () => {
    const { run, calls, logs } = harness({
        refreshImages: async () => [
            { action: 'refreshed', canonical: 'docker.io/o/a:1', agents: ['r/a'], beforeId: 'sha256:1', afterId: 'sha256:2' },
            { action: 'pull-failed', canonical: 'docker.io/o/b:1', agents: ['r/b'], reason: 'boom' },
        ],
    });
    const result = await run();
    assert.equal(calls.handlers, 1);
    assert.deepEqual(result.records.map((record) => [record.phase, record.code]), [
        ['workspace-repository', ''],
        ['image', 'image-refreshed'],
        ['image', 'image-pull-failed'],
    ]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.activationAllowed, true);
    assert.ok(logs.some((line) => /Refreshed images take effect after `ploinky restart`/.test(line)));
});

test('policy off and update repos skip the image phase entirely', async () => {
    const off = harness({ env: { PLOINKY_IMAGE_REFRESH: 'off' }, refreshImages: async () => [] });
    await off.run();
    assert.equal(off.calls.refresh, 0);
    const repos = harness({ refreshImages: async () => [] });
    await repos.run(['repos']);
    assert.equal(repos.calls.refresh, 0);
});

test('a workspace without a static agent has nothing to refresh (default image phase)', async () => {
    const { run } = harness();
    const result = await run();
    assert.equal(result.exitCode, 0);
    assert.equal(result.records.some((record) => record.phase === 'image'), false);
});

test('a refresh that throws is a warning, not a failed update', async () => {
    const { run, logs } = harness({ refreshImages: async () => { throw new Error('graph exploded'); } });
    const result = await run();
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.records.map((record) => record.phase), ['workspace-repository']);
    assert.ok(logs.some((line) => /image refresh skipped \(graph exploded\)/.test(line)));
});

test('cancellation during the image phase keeps the git records and ends with a cancelled record', async () => {
    const { run } = harness({
        refreshImages: async () => { throw new UpdateCancelledError('SIGTERM', 'image', [gitRecord()]); },
    });
    const result = await run();
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.records.map((record) => [record.phase, record.code]), [
        ['workspace-repository', ''],
        ['command', 'cancelled'],
    ]);
});
