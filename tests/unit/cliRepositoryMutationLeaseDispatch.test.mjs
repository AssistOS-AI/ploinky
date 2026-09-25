// The production `ploinky-local` command path (cli/index.js) serializes
// repository commands on the workspace mutation lease across processes: while
// another process owns the lease, `uninstall repo` and `enable repo` wait and
// mutate nothing, then complete after it is released.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliEntry = path.join(repoRoot, 'cli', 'index.js');
const originalEnv = { PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT };
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cli-repo-dispatch-')));
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const locks = await import('../../cli/utils/runtime/maintenanceLocks.js');

const PLOINKY = path.join(workspace, '.ploinky');
const REPO_DIR = path.join(PLOINKY, 'repos', 'fixtures');
const ENABLED_REPOS_FILE = path.join(PLOINKY, 'enabled_repos.json');

test.after(() => {
    if (originalEnv.PLOINKY_WORKSPACE_ROOT === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = originalEnv.PLOINKY_WORKSPACE_ROOT;
    fs.rmSync(workspace, { recursive: true, force: true });
});

function fixture() {
    fs.rmSync(PLOINKY, { recursive: true, force: true });
    if (!fs.existsSync(path.join(workspace, 'achillesAgentLib'))) writeAgentLibCheckout(path.join(workspace, 'achillesAgentLib'));
    // Default boot repositories exist so bootstrap never clones.
    for (const repoName of ['AchillesIDE', 'AchillesCLI', 'copilot-agents']) {
        fs.mkdirSync(path.join(PLOINKY, 'repos', repoName), { recursive: true });
    }
    for (const repoName of ['fixtures', 'others']) {
        fs.mkdirSync(path.join(PLOINKY, 'repos', repoName, 'probe'), { recursive: true });
        fs.writeFileSync(path.join(PLOINKY, 'repos', repoName, 'probe', 'manifest.json'), '{}');
    }
    fs.writeFileSync(ENABLED_REPOS_FILE, JSON.stringify(['fixtures'], null, 2));
    fs.writeFileSync(path.join(PLOINKY, 'routing.json'), JSON.stringify({ routes: {} }));
    fs.writeFileSync(path.join(PLOINKY, 'agents.json'), '{}');
    fs.mkdirSync(path.join(PLOINKY, 'data', 'router-security'), { recursive: true });
    fs.writeFileSync(path.join(PLOINKY, 'data', 'router-security', 'policy-state.json'),
        JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }));
    fs.mkdirSync(path.join(PLOINKY, 'data', 'edge-routing'), { recursive: true });
    fs.writeFileSync(path.join(PLOINKY, 'data', 'edge-routing', 'desired.json'), JSON.stringify({ hosts: {} }));
}

function runCli(args) {
    const child = spawn(process.execPath, [cliEntry, ...args], {
        cwd: workspace,
        env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace, PLOINKY_MASTER_KEY: '7'.repeat(64) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '' };
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    const exited = new Promise((resolve) => child.on('close', (code) => resolve({ code, ...output })));
    const state = { exited: false };
    exited.then(() => { state.exited = true; });
    return { child, exited, state };
}

const HOLD_MS = 2_500;

// Without a lease owner the same command finishes well inside HOLD_MS, so a
// command still running after HOLD_MS under an owner is waiting for the lease.
async function unownedBaseline(args, assertDone) {
    fixture();
    const started = Date.now();
    const result = await runCli(args).exited;
    const elapsed = Date.now() - started;
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assertDone(result);
    assert.ok(elapsed < HOLD_MS, `unowned ${args.join(' ')} took ${elapsed}ms; the hold window cannot prove waiting`);
}

async function whileAnotherProcessOwnsTheLease(args, { assertWaiting, assertDone }) {
    await unownedBaseline(args, assertDone);
    fixture();
    const lease = locks.createWorkspaceMutationLease({ operation: 'agent-enable' });
    let run;
    try {
        run = runCli(args);
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
        assert.equal(run.state.exited, false, `${args.join(' ')} must wait for the lease owner`);
        assertWaiting();
    } finally {
        assert.equal(locks.releaseWorkspaceMutationLease(lease), true);
    }
    const result = await run.exited;
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assertDone(result);
    assert.equal(fs.existsSync(locks.WORKSPACE_START_LOCK_PATH), false, 'the command released its lease');
}

test('ploinky-local uninstall repo waits for another process that owns the workspace lease', { timeout: 60_000 }, async () => {
    await whileAnotherProcessOwnsTheLease(['uninstall', 'repo', 'fixtures'], {
        assertWaiting() {
            assert.ok(fs.existsSync(path.join(REPO_DIR, 'probe', 'manifest.json')), 'the checkout survives while the lease is owned');
            assert.deepEqual(JSON.parse(fs.readFileSync(ENABLED_REPOS_FILE, 'utf8')), ['fixtures']);
        },
        assertDone(result) {
            assert.match(result.stdout, /Repository 'fixtures' uninstalled/);
            assert.equal(fs.existsSync(REPO_DIR), false);
            assert.deepEqual(JSON.parse(fs.readFileSync(ENABLED_REPOS_FILE, 'utf8')), []);
        },
    });
});

test('ploinky-local enable repo waits for another process that owns the workspace lease', { timeout: 60_000 }, async () => {
    await whileAnotherProcessOwnsTheLease(['enable', 'repo', 'others'], {
        assertWaiting() {
            assert.deepEqual(JSON.parse(fs.readFileSync(ENABLED_REPOS_FILE, 'utf8')), ['fixtures']);
        },
        assertDone(result) {
            assert.match(result.stdout, /Repository 'others' enabled/);
            assert.deepEqual(JSON.parse(fs.readFileSync(ENABLED_REPOS_FILE, 'utf8')), ['fixtures', 'others']);
        },
    });
});
