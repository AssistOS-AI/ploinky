import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The image phase as wired by runUpdateCommand: the real deadline and the real workspace lease.
const originalCwd = process.cwd();
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-image-wiring-')));
const originalRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const { runUpdateCommand } = await import('../../cli/commands/updateCommand.js');
const { IMAGE_PHASE_BUDGET_MS } = await import('../../cli/commands/updateImagePhase.js');
const { WORKSPACE_START_LOCK_PATH } = await import('../../cli/utils/runtime/maintenanceLocks.js');
const { buildUpdateResult, createOperationRecord } = await import('../../cli/commands/updateOutcome.js');

test.after(() => {
    process.chdir(originalCwd);
    if (originalRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = originalRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

const REF = 'docker.io/assistos/roboteam-agent:runtime';
const OLD = `sha256:${'1'.repeat(64)}`;
const NEW = `sha256:${'2'.repeat(64)}`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const quiet = () => {};
const readLease = () => (fs.existsSync(WORKSPACE_START_LOCK_PATH) ? JSON.parse(fs.readFileSync(WORKSPACE_START_LOCK_PATH, 'utf8')) : null);

function run(extra) {
    const calls = { heads: 0, pulls: [], tags: [] };
    const sessionOptions = {
        runtime: 'podman', env: {}, execArgv: [], readRepoDigests: () => [],
        fetchImpl: async () => {
            calls.heads += 1;
            return { status: 200, headers: { get: () => DIGEST }, json: async () => ({}) };
        },
        readImageId: (_rt, ref) => (ref.includes('@') ? (calls.pulls.includes(ref) ? NEW : null)
            : (calls.tags.length ? NEW : OLD)),
        pull: (ref) => { calls.pulls.push(ref); },
        spawn: (_rt, args) => { calls.tags.push({ args, lease: readLease() }); return { status: 0 }; },
        ...extra.sessionOptions,
    };
    const result = runUpdateCommand([], {
        env: {}, insideBox: false, leaseWaitMs: 0, log: quiet, error: quiet,
        handlers: {
            updateAllRepos: async () => buildUpdateResult({
                records: [createOperationRecord({ phase: 'workspace-repository', id: 'A', outcome: 'changed', required: false })],
            }),
        },
        refreshImages: async ({ session }) => { await session.refresh(REF, { agents: ['r/a'] }); return session.results(); },
        imageSessionOptions: sessionOptions,
        ...extra.options,
    });
    return { result, calls };
}

test('wiring: the update budget reaches the session (a nearly used-up budget defers without any registry call)', async () => {
    const { result, calls } = run({ options: { startedAtMs: Date.now() - IMAGE_PHASE_BUDGET_MS + 30_000 } });
    const records = (await result).records.filter((record) => record.phase === 'image');
    assert.deepEqual(records.map((record) => record.code), ['image-refresh-deferred']);
    assert.equal(calls.heads + calls.pulls.length, 0);
});

test('wiring: with a fresh budget the digest is pulled', async () => {
    const { result, calls } = run({});
    assert.equal((await result).records.at(-1).code, 'image-refreshed');
    assert.equal(calls.pulls.length, 1);
});

test('wiring: the tag move runs under the real workspace lease, which is released afterwards', async () => {
    const { result, calls } = run({});
    await result;
    assert.equal(calls.tags.length, 1);
    assert.equal(calls.tags[0].lease?.operation, 'update-image-retag', 'the lease was held while the tag moved');
    assert.equal(readLease(), null, 'and released after the update');
});
