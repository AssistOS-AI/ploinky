// `default-skills <repo>` resolves an absent source repository, clones it into
// .ploinky/repos, records its source and exports from the checkout. That is one
// workspace mutation: the command waits for another owner, refuses past its
// bounded wait without writing, and reuses the lease of an update that already
// holds it. The source is a local bare Git remote; lease helpers, repository
// files and the production CLI entry are real.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliEntry = path.join(repoRoot, 'cli', 'index.js');
const originalCwd = process.cwd();
const originalEnv = { PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT };
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-default-skills-lease-')));
const workspace = path.join(scratch, 'workspace');
const consumer = path.join(scratch, 'consumer');
const remote = path.join(scratch, 'remote.git');
fs.mkdirSync(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const { handleDefaultSkillsCommand } = await import('../../cli/commands/skillsCommands.js');
// Always a promise, so a handler that completes or throws synchronously is
// judged by what it did rather than by its return shape.
const defaultSkills = (...args) => Promise.resolve().then(() => handleDefaultSkillsCommand(...args));
const locks = await import('../../cli/utils/runtime/maintenanceLocks.js');

const { WORKSPACE_START_LOCK_PATH } = locks;
const PLOINKY = path.join(workspace, '.ploinky');
const REPO_NAME = 'LocalSkills';
const CLONE_DIR = path.join(PLOINKY, 'repos', REPO_NAME);
const REPO_SOURCES_FILE = path.join(PLOINKY, 'repo_sources.json');
const USER_FILE = path.join(consumer, 'notes.txt');
const USER_GITIGNORE = path.join(consumer, '.gitignore');
const EXPORTED_SKILL = path.join(consumer, '.agents', 'skills', 's1', 'SKILL.md');
// The watcher below replaces these; helpers read through the originals.
const real = { existsSync: fs.existsSync, readFileSync: fs.readFileSync };

test.after(() => {
    process.chdir(originalCwd);
    if (originalEnv.PLOINKY_WORKSPACE_ROOT === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = originalEnv.PLOINKY_WORKSPACE_ROOT;
    fs.rmSync(scratch, { recursive: true, force: true });
});

test.beforeEach((t) => { t.mock.method(console, 'log', () => {}); });

function git(args, cwd) {
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'ignore' });
}

// The owned local remote the absent repository is cloned from.
function createRemote() {
    const work = path.join(scratch, 'remote-work');
    git(['init', '--bare', remote], scratch);
    git(['init', work], scratch);
    fs.mkdirSync(path.join(work, 'skills', 's1'), { recursive: true });
    fs.writeFileSync(path.join(work, 'skills', 's1', 'SKILL.md'), '# s1\n');
    git(['add', '.'], work);
    git(['commit', '-m', 'skills'], work);
    git(['push', remote, 'HEAD:refs/heads/main'], work);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
    fs.rmSync(work, { recursive: true, force: true });
}
createRemote();

function fixture() {
    fs.rmSync(PLOINKY, { recursive: true, force: true });
    if (!fs.existsSync(path.join(workspace, 'achillesAgentLib'))) writeAgentLibCheckout(path.join(workspace, 'achillesAgentLib'));
    // Default boot repositories exist so bootstrap never clones.
    for (const repoName of ['AchillesIDE', 'AchillesCLI', 'copilot-agents']) {
        fs.mkdirSync(path.join(PLOINKY, 'repos', repoName), { recursive: true });
    }
    fs.writeFileSync(REPO_SOURCES_FILE, JSON.stringify({ [REPO_NAME]: { url: `file://${remote}` } }, null, 2));
    fs.writeFileSync(path.join(PLOINKY, 'enabled_repos.json'), '[]');
    fs.writeFileSync(path.join(PLOINKY, 'agents.json'), '{}');
    fs.rmSync(consumer, { recursive: true, force: true });
    fs.mkdirSync(consumer);
    fs.writeFileSync(USER_FILE, 'my notes\n');
    fs.writeFileSync(USER_GITIGNORE, 'node_modules/\n');
    const before = new Map([REPO_SOURCES_FILE, USER_FILE, USER_GITIGNORE].map((file) => [file, fs.readFileSync(file)]));
    return {
        assertUntouched() {
            assert.equal(real.existsSync(CLONE_DIR), false, 'the absent repository is not cloned');
            for (const [file, bytes] of before) assert.deepEqual(real.readFileSync(file), bytes, `${file} is byte-identical`);
            assert.equal(real.existsSync(path.join(consumer, '.agents')), false, 'no skills are exported');
            assert.equal(real.existsSync(path.join(consumer, '.claude')), false);
        },
    };
}

function readLease() {
    return real.existsSync(WORKSPACE_START_LOCK_PATH) ? JSON.parse(real.readFileSync(WORKSPACE_START_LOCK_PATH, 'utf8')) : null;
}

function assertInstalled() {
    assert.ok(fs.existsSync(path.join(CLONE_DIR, 'skills', 's1', 'SKILL.md')), 'the repository was cloned from its recorded source');
    assert.equal(JSON.parse(fs.readFileSync(REPO_SOURCES_FILE, 'utf8'))[REPO_NAME].url, `file://${remote}`);
    assert.equal(fs.readFileSync(EXPORTED_SKILL, 'utf8'), '# s1\n');
    assert.equal(fs.readFileSync(USER_FILE, 'utf8'), 'my notes\n', 'the user file is preserved');
    assert.match(fs.readFileSync(USER_GITIGNORE, 'utf8'), /^node_modules\/\n/, 'the user .gitignore line is preserved');
}

// Records the lease on disk at each check of whether the checkout exists (the
// selection and the pre-clone check) and at each export write into the consumer.
function watchMutations(t) {
    const events = [];
    const originals = {};
    const inConsumer = (target) => {
        const resolved = path.resolve(String(target));
        return resolved === consumer || resolved.startsWith(`${consumer}${path.sep}`);
    };
    originals.existsSync = fs.existsSync;
    fs.existsSync = function existsSync(target, ...rest) {
        if (typeof target === 'string' && path.resolve(target) === CLONE_DIR) events.push({ kind: 'checkout-check', lease: readLease() });
        return originals.existsSync.call(this, target, ...rest);
    };
    for (const method of ['writeFileSync', 'renameSync', 'symlinkSync', 'mkdirSync', 'linkSync']) {
        originals[method] = fs[method];
        fs[method] = function watched(...args) {
            const target = method === 'writeFileSync' || method === 'mkdirSync' ? args[0] : args[1];
            if (typeof target === 'string' && inConsumer(target)) events.push({ kind: 'export-write', lease: readLease() });
            return originals[method].apply(this, args);
        };
    }
    t.after(() => { Object.assign(fs, originals); });
    return events;
}

// Another operation of the same process that owns the lease in its own async
// chain, not in the command's.
function concurrentOwner(operation) {
    const lease = locks.createWorkspaceMutationLease({ operation });
    let finish;
    const holding = new Promise((resolve) => { finish = resolve; });
    const run = locks.runWithWorkspaceMutationLease(lease, async () => {
        await holding;
        assert.equal(locks.releaseWorkspaceMutationLease(lease), true);
    });
    return {
        lease,
        async release() {
            finish();
            await run;
        },
    };
}

function settledState(promise) {
    const state = { settled: false };
    promise.then(() => { state.settled = true; }, () => { state.settled = true; });
    return state;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const operation of ['agent-enable', 'update']) {
    test(`default-skills waits for a concurrent ${operation} before cloning an absent repository under its own lease`, { timeout: 30_000 }, async (t) => {
        const f = fixture();
        process.chdir(consumer);
        const events = watchMutations(t);
        const owner = concurrentOwner(operation);

        const pending = defaultSkills([REPO_NAME]);
        const state = settledState(pending);
        await pause(400);
        assert.equal(state.settled, false, `default-skills must wait for the concurrent ${operation}`);
        f.assertUntouched();
        assert.deepEqual(events, [], 'nothing is selected or written while the owner holds the lease');
        assert.equal(readLease()?.token, owner.lease.token);

        await owner.release();
        await pending;
        assertInstalled();
        assert.ok(events.filter((event) => event.kind === 'checkout-check').length >= 2, 'selection and pre-clone checks observed');
        assert.ok(events.some((event) => event.kind === 'export-write'), 'export writes observed');
        for (const { lease } of events) {
            assert.equal(lease?.operation, 'repositories-prepare');
            assert.equal(lease.ownerPid, process.pid);
            assert.notEqual(lease.token, owner.lease.token);
        }
        assert.equal(new Set(events.map(({ lease }) => lease.token)).size, 1, 'one lease covers selection, clone, record and export');
        assert.equal(fs.existsSync(WORKSPACE_START_LOCK_PATH), false, 'the command released its lease');
    });
}

test('default-skills refuses past its bounded wait and leaves the source record, checkout and user files unchanged', { timeout: 30_000 }, async (t) => {
    const f = fixture();
    process.chdir(consumer);
    const events = watchMutations(t);
    const owner = concurrentOwner('update');
    try {
        await assert.rejects(defaultSkills([REPO_NAME], { workspaceLeaseWaitMs: 300 }),
            (error) => error?.code === 'workspace_mutation_lock_timeout');
        f.assertUntouched();
        assert.deepEqual(events, [], 'nothing is selected or written');
        assert.equal(readLease()?.token, owner.lease.token, 'the owner keeps its exact lease');
    } finally {
        await owner.release();
    }
    assert.equal(fs.existsSync(WORKSPACE_START_LOCK_PATH), false);
});

test('default-skills argument errors never take the workspace lease', { timeout: 30_000 }, async () => {
    const f = fixture();
    process.chdir(consumer);
    const owner = concurrentOwner('update');
    try {
        await assert.rejects(defaultSkills([], { workspaceLeaseWaitMs: 300 }), /Usage: default-skills/);
        await assert.rejects(defaultSkills([REPO_NAME, '--bogus'], { workspaceLeaseWaitMs: 300 }), /Unknown flag/);
        f.assertUntouched();
    } finally {
        await owner.release();
    }
});

test('default-skills inside an update that already holds the lease reuses that exact lease and leaves it held', { timeout: 30_000 }, async (t) => {
    fixture();
    process.chdir(consumer);
    const events = watchMutations(t);
    const outer = locks.createWorkspaceMutationLease({ operation: 'update' });
    try {
        // Acquiring instead of reusing would time out after 300ms: this same pid holds the lease.
        await locks.runWithWorkspaceMutationLease(outer, () => defaultSkills([REPO_NAME], { workspaceLeaseWaitMs: 300 }));
        assertInstalled();
        assert.ok(events.filter((event) => event.kind === 'checkout-check').length >= 2);
        assert.ok(events.some((event) => event.kind === 'export-write'));
        assert.deepEqual([...new Set(events.map(({ lease }) => lease?.token))], [outer.token]);
        assert.equal(readLease()?.token, outer.token, 'the nested command did not release the outer lease');
    } finally {
        assert.equal(locks.releaseWorkspaceMutationLease(outer), true);
    }
    assert.equal(fs.existsSync(WORKSPACE_START_LOCK_PATH), false);
});

function runCli(args) {
    const child = spawn(process.execPath, [cliEntry, ...args], {
        cwd: consumer,
        env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspace, PLOINKY_MASTER_KEY: '7'.repeat(64) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '' };
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    const exited = new Promise((resolve) => child.on('close', (code) => resolve({ code, ...output })));
    const state = { exited: false };
    exited.then(() => { state.exited = true; });
    return { exited, state };
}

const HOLD_MS = 2_500;

test('ploinky-local default-skills waits for another process that owns the workspace lease', { timeout: 60_000 }, async () => {
    // Without an owner the same command finishes well inside HOLD_MS, so a
    // command still running after HOLD_MS under an owner is waiting for the lease.
    fixture();
    const started = Date.now();
    const baseline = await runCli(['default-skills', REPO_NAME]).exited;
    const elapsed = Date.now() - started;
    assert.equal(baseline.code, 0, `${baseline.stdout}\n${baseline.stderr}`);
    assertInstalled();
    assert.ok(elapsed < HOLD_MS, `unowned default-skills took ${elapsed}ms; the hold window cannot prove waiting`);

    const f = fixture();
    const lease = locks.createWorkspaceMutationLease({ operation: 'agent-enable' });
    let run;
    try {
        run = runCli(['default-skills', REPO_NAME]);
        await pause(HOLD_MS);
        assert.equal(run.state.exited, false, 'default-skills must wait for the lease owner');
        f.assertUntouched();
    } finally {
        assert.equal(locks.releaseWorkspaceMutationLease(lease), true);
    }
    const result = await run.exited;
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Installed 1 skill\(s\) from 'LocalSkills'/);
    assertInstalled();
    assert.equal(fs.existsSync(WORKSPACE_START_LOCK_PATH), false, 'the command released its lease');
});
