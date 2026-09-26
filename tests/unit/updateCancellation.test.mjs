import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CHECKOUT_LOCK_NAME, acquireCheckoutLock } from '../../cli/utils/git/checkoutLock.js';
import { createUpdateReportNonce, readUpdateReport } from '../../cli/commands/updateOutcome.js';

// Operator cancellation of a real `ploinky update` writer.
//
// The host cancels the in-Box writer with SIGTERM and escalates to SIGKILL
// only after a grace period: its engine probe signals every process that
// carries the operation marker, so the writer and its Git children receive
// SIGTERM together. The writer here runs the real update command in its own
// process group against local checkouts whose fetch goes through a fake SSH
// transport, so each test can hold a real `git fetch` while the checkout lock
// is held and deliver real signals.

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = relative => pathToFileURL(path.join(PROJECT, relative)).href;
const REPOS = ['Alpha', 'Beta'];
const REPORT_CONTEXT = { fixture: 'update-cancellation' };

function createWorkspace(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-cancel-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const gitEnv = {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_TERMINAL_PROMPT: '0',
    };
    const git = (cwd, ...args) => {
        const result = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
        return result.stdout.trim();
    };
    const workspace = path.join(root, 'workspace');
    const markers = path.join(root, 'markers');
    const runtimeRoot = path.join(root, 'runtime-root');
    for (const directory of [path.join(workspace, '.ploinky', 'repos'), markers, runtimeRoot]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    const repos = {};
    for (const name of REPOS) {
        const seed = path.join(root, `${name}-seed`);
        const bare = path.join(root, `${name}.git`);
        git(root, 'init', '-q', '-b', 'main', seed);
        fs.writeFileSync(path.join(seed, 'file.txt'), `${name} 1\n`);
        git(seed, 'add', '.');
        git(seed, 'commit', '-qm', 'first');
        git(root, 'clone', '-q', '--bare', seed, bare);
        const checkout = path.join(workspace, '.ploinky', 'repos', name);
        git(root, 'clone', '-q', bare, checkout);
        // The upstream advances, so a completed update moves the checkout.
        fs.writeFileSync(path.join(seed, 'file.txt'), `${name} 2\n`);
        git(seed, 'commit', '-qam', 'second');
        git(seed, 'push', '-q', bare, 'main');
        git(checkout, 'remote', 'set-url', 'origin', `ssh://fixture.invalid${bare}`);
        repos[name] = { checkout, before: git(checkout, 'rev-parse', 'HEAD'), upstream: git(bare, 'rev-parse', 'main') };
    }
    // Simple-variant SSH: the last argument is the remote command. It records
    // which repository's fetch started, holds it, then serves it locally.
    const ssh = path.join(root, 'fake-ssh');
    fs.writeFileSync(ssh, [
        '#!/bin/sh',
        'for last; do :; done',
        'repo=$(printf \'%s\\n\' "$last" | cut -d"\'" -f2)',
        'echo $$ > "$FIXTURE_MARKERS/$(basename "$repo" .git).started"',
        'sleep "$FIXTURE_FETCH_DELAY"',
        'exec git upload-pack "$repo"',
        '',
    ].join('\n'), { mode: 0o755 });
    return { root, workspace, markers, runtimeRoot, ssh, repos, git };
}

// The CLI entry returns the record-derived exit status of the update.
const updateScript = args => `
    const { runUpdateCommand } = await import(${JSON.stringify(moduleUrl('cli/commands/updateCommand.js'))});
    console.log('UPDATE_STARTED');
    const result = await runUpdateCommand(${JSON.stringify(args)});
    process.exitCode = result.exitCode;
`;

// A host-driven in-Box writer: the Box marker is simulated for
// isInsideBoxRuntime() only.
const inBoxUpdateScript = args => `
    const fs = (await import('node:fs')).default;
    const statSync = fs.statSync;
    fs.statSync = (target, options) => (target === '/etc/ploinky-box'
        ? { isFile: () => true, isDirectory: () => false }
        : statSync(target, options));
    ${updateScript(args)}
`;

function startWriter(t, ws, { script, fetchDelaySeconds = 30, context = REPORT_CONTEXT }) {
    const nonce = createUpdateReportNonce();
    const env = {
        ...process.env,
        HOME: ws.root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: ws.ssh,
        GIT_SSH_VARIANT: 'simple',
        FIXTURE_MARKERS: ws.markers,
        FIXTURE_FETCH_DELAY: String(fetchDelaySeconds),
        PLOINKY_WORKSPACE_ROOT: ws.workspace,
        PLOINKY_ROOT: ws.runtimeRoot,
        PLOINKY_UPDATE_REPORT_NONCE: nonce,
        PLOINKY_UPDATE_REPORT_CONTEXT: JSON.stringify(context),
    };
    delete env.GIT_SSH;
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ws.workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    });
    return { child, nonce, exited, output: () => output };
}

async function waitFor(what, predicate, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = predicate();
        if (value) return value;
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
        await delay(20);
    }
}

async function settle(writer, timeoutMs = 30_000) {
    const exit = await Promise.race([writer.exited, delay(timeoutMs).then(() => null)]);
    if (!exit) {
        try { process.kill(-writer.child.pid, 'SIGKILL'); } catch (_) {}
        assert.fail(`the writer did not stop within ${timeoutMs} ms:\n${writer.output()}`);
    }
    return exit;
}

function startedFetches(ws) {
    return fs.readdirSync(ws.markers).filter(name => name.endsWith('.started')).map(name => name.slice(0, -'.started'.length)).sort();
}

function processGone(pid) {
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return error.code === 'ESRCH';
    }
}

// Nothing the fixture started may still write when the checkouts are judged.
async function fixtureQuiet(ws) {
    for (const name of startedFetches(ws)) {
        const pid = Number(fs.readFileSync(path.join(ws.markers, `${name}.started`), 'utf8'));
        await waitFor(`fetch transport ${pid} to end`, () => processGone(pid), 15_000);
    }
}

function checkoutState(ws, name) {
    const { checkout } = ws.repos[name];
    const gitDir = path.join(checkout, '.git');
    return {
        head: ws.git(checkout, 'rev-parse', 'HEAD'),
        lockEntries: fs.readdirSync(gitDir).filter(entry => entry.startsWith(CHECKOUT_LOCK_NAME)).sort(),
        gitLocks: ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock', 'refs/heads/main.lock']
            .filter(entry => fs.existsSync(path.join(gitDir, entry))),
        privateRefs: ws.git(checkout, 'for-each-ref', '--format=%(refname)', 'refs/ploinky-update').split('\n').filter(Boolean),
    };
}

function workspaceLeasePresent(ws) {
    return fs.existsSync(path.join(ws.workspace, '.ploinky', 'running', 'workspace-start.json'));
}

async function signalDuringFetch(t, { args, target }) {
    const ws = createWorkspace(t);
    const writer = startWriter(t, ws, { script: updateScript(args), fetchDelaySeconds: target === 'group' ? 30 : 2 });
    const [started] = await waitFor('a repository fetch to start', () => {
        const names = startedFetches(ws);
        return names.length ? names : null;
    });
    assert.deepEqual(checkoutState(ws, started).lockEntries, [CHECKOUT_LOCK_NAME],
        'the signal lands while the writer holds the checkout lock');
    process.kill(target === 'group' ? -writer.child.pid : writer.child.pid, 'SIGTERM');
    const exit = await settle(writer);
    await fixtureQuiet(ws);
    const other = REPOS.find(name => name !== started);
    return { ws, writer, exit, started, other };
}

function assertCancelledReport(ws, writer, started, outcome) {
    const report = readUpdateReport(path.join(ws.workspace, '.ploinky'), writer.nonce, { expectedContext: REPORT_CONTEXT });
    assert.equal(report.ok, true, `the host accepts the cancelled writer's report: ${report.code} ${report.reason}\n${writer.output()}`);
    const { records } = report.result;
    const cancelled = records.filter(record => record.phase === 'command' && record.code === 'cancelled');
    assert.equal(cancelled.length, 1, JSON.stringify(records));
    assert.equal(cancelled[0].outcome, 'failed');
    assert.match(cancelled[0].reason, /SIGTERM/);
    assert.equal(report.result.activationAllowed, false, 'a cancelled update never activates');
    assert.equal(report.result.exitCode, 1);
    const repositories = records.filter(record => record.phase === 'registered-repository');
    assert.deepEqual(repositories.map(record => [record.id, record.outcome]), [[started, outcome]],
        'only the repository that had started is reported');
}

for (const [form, args] of [['all', []], ['repos', ['repos']]]) {
    test(`update ${form}: SIGTERM to the whole operation mid-fetch stops the writer and releases its checkout lock`, async (t) => {
        const { ws, writer, exit, started, other } = await signalDuringFetch(t, { args, target: 'group' });
        assert.deepEqual(exit, { code: 1, signal: null }, `the writer stops on its own with a failed update:\n${writer.output()}`);
        for (const name of REPOS) {
            assert.deepEqual(checkoutState(ws, name), {
                head: ws.repos[name].before, lockEntries: [], gitLocks: [], privateRefs: [],
            }, `${name} carries no lock, private ref or moved HEAD`);
        }
        assert.deepEqual(startedFetches(ws), [started], `${other} was never started after the cancellation`);
        assert.equal(workspaceLeasePresent(ws), false, 'the workspace mutation lease is released');
        assertCancelledReport(ws, writer, started, 'failed');
    });
}

test('SIGTERM to the writer alone lets the started checkout finish and starts nothing else', async (t) => {
    const { ws, writer, exit, started, other } = await signalDuringFetch(t, { args: [], target: 'writer' });
    assert.deepEqual(exit, { code: 1, signal: null }, `the writer stops on its own with a failed update:\n${writer.output()}`);
    assert.deepEqual(checkoutState(ws, started), {
        head: ws.repos[started].upstream, lockEntries: [], gitLocks: [], privateRefs: [],
    }, 'the fast-forward that had started completes and releases its lock');
    assert.deepEqual(checkoutState(ws, other), {
        head: ws.repos[other].before, lockEntries: [], gitLocks: [], privateRefs: [],
    }, `${other} is untouched`);
    assert.deepEqual(startedFetches(ws), [started]);
    assert.equal(workspaceLeasePresent(ws), false);
    assertCancelledReport(ws, writer, started, 'changed');
});

// SIGKILL cannot be handled: the lock stays behind, bound to its dead owner,
// and the next update in the same process scope reclaims it. Outside the Box
// no writer binds a lock to a Box run, whatever context it was handed.
test('a SIGKILLed writer leaves its checkout lock to the next same-scope update', async (t) => {
    const ws = createWorkspace(t);
    const writer = startWriter(t, ws, {
        script: updateScript(['repos']),
        context: {
            workspace: { instance: `ploinky-box-fixture-${'f'.repeat(16)}` },
            box: { containerId: 'b'.repeat(64), runningContainers: ['b'.repeat(64)] },
        },
    });
    const [started] = await waitFor('a repository fetch to start', () => {
        const names = startedFetches(ws);
        return names.length ? names : null;
    });
    process.kill(-writer.child.pid, 'SIGKILL');
    const exit = await settle(writer);
    await fixtureQuiet(ws);
    assert.equal(exit.signal, 'SIGKILL');
    const { checkout } = ws.repos[started];
    const lockPath = path.join(checkout, '.git', CHECKOUT_LOCK_NAME);
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, writer.child.pid);
    assert.equal(owner.box, null, 'a writer outside the Box never records a Box binding');
    assert.equal(readUpdateReport(path.join(ws.workspace, '.ploinky'), writer.nonce).code, 'report-missing');
    const next = acquireCheckoutLock({ commonDir: path.join(checkout, '.git'), checkout, waitMs: 2_000 });
    assert.equal(next.ok, true, next.reason);
    assert.equal(next.lock.release(), true);
    assert.deepEqual(checkoutState(ws, started).lockEntries, []);
});

// A handler that finished every step: nothing after its last checkpoint turns
// the event loop.
const finishedHandler = body => `async (_folder, { command }) => {
    ${body}
    return buildCoreUpdateResult({ command, records: [createOperationRecord({
        phase: 'registered-repository', id: 'Alpha', outcome: 'unchanged', required: true,
    })] });
}`;
const stubPrelude = () => `
    const fs = await import('node:fs');
    const { runUpdateCommand } = await import(${JSON.stringify(moduleUrl('cli/commands/updateCommand.js'))});
    const { buildCoreUpdateResult } = await import(${JSON.stringify(moduleUrl('cli/commands/updateRecords.js'))});
    const { createOperationRecord } = await import(${JSON.stringify(moduleUrl('cli/commands/updateOutcome.js'))});
`;

function assertCancelledBeforeActivation(ws, writer) {
    const report = readUpdateReport(path.join(ws.workspace, '.ploinky'), writer.nonce, { expectedContext: REPORT_CONTEXT });
    assert.equal(report.ok, true, `${report.code} ${report.reason}\n${writer.output()}`);
    assert.deepEqual(report.result.records.map(record => [record.phase, record.id, record.outcome, record.code]), [
        ['registered-repository', 'Alpha', 'unchanged', ''],
        ['command', 'update', 'failed', 'cancelled'],
    ]);
    assert.match(report.result.records[1].reason, /SIGTERM before activation/);
    assert.equal(report.result.activationAllowed, false, 'every step finished, yet a cancelled update never activates');
}

// The host's TERM batch can miss a Git child the writer spawns right after it,
// and the host then SIGKILLs the writer when its TERM grace (shortened here)
// ends. The lock outlives that Box run; after the Box restarts, only the
// host's attestation can prove its owner dead.
test('a lock left by a SIGKILLed host-driven writer is reclaimed in the next Box run only with the host attestation', async (t) => {
    const ws = createWorkspace(t);
    const workspace = `ploinky-box-fixture-${'f'.repeat(16)}`;
    const containerId = 'b'.repeat(64);
    const context = {
        schema: 'ploinky-update-context', version: 1,
        workspace: { instance: workspace, workspaceRoot: ws.workspace },
        box: { containerId, engine: 'engine-store', action: 'reused', imageId: null, runningContainers: [containerId] },
    };
    const writer = startWriter(t, ws, { script: inBoxUpdateScript(['repos']), context });
    const [started] = await waitFor('a repository fetch to start', () => {
        const names = startedFetches(ws);
        return names.length ? names : null;
    });
    process.kill(writer.child.pid, 'SIGTERM');
    await delay(1_500);
    assert.equal(processGone(writer.child.pid), false, 'the writer is still inside the Git command when the grace ends');
    process.kill(-writer.child.pid, 'SIGKILL');
    const exit = await settle(writer);
    await fixtureQuiet(ws);
    assert.equal(exit.signal, 'SIGKILL');

    const { checkout } = ws.repos[started];
    const commonDir = path.join(checkout, '.git');
    const owner = JSON.parse(fs.readFileSync(path.join(commonDir, CHECKOUT_LOCK_NAME, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, writer.child.pid);
    // The next Box run has another PID namespace.
    const nextRun = {
        pid: process.pid,
        hostname: os.hostname(),
        scope: () => ({ bootId: 'boot', pidNamespace: 'pid:[next-run]', scope: JSON.stringify(['linux', 'boot', 'pid:[next-run]']) }),
        processStart: () => '',
        kill: (pid, signal) => process.kill(pid, signal),
    };
    const unattested = acquireCheckoutLock({ commonDir, checkout, waitMs: 200, retryMs: 20, processApi: nextRun });
    assert.equal(unattested.code, 'lock-busy', 'without the host attestation a foreign-scope owner is never proven dead');
    const reclaimed = acquireCheckoutLock({
        commonDir, checkout, waitMs: 2_000, processApi: nextRun, boxRun: { workspace, containerId, engine: 'engine-store', soleRunning: true },
    });
    assert.equal(reclaimed.ok, true, `the next run of the same Box container reclaims it: ${reclaimed.reason}`);
    assert.deepEqual(owner.box, { workspace, containerId, engine: 'engine-store' }, 'the killed owner had recorded the exact Box run it ran in');
    assert.equal(reclaimed.lock.release(), true);
    assert.deepEqual(checkoutState(ws, started), {
        head: ws.repos[started].before, lockEntries: [], gitLocks: [], privateRefs: [],
    }, 'the reclaimed checkout is untouched');
});

test('a signal after the last update step still blocks activation, and the update returns its signals', async (t) => {
    const ws = createWorkspace(t);
    const writer = startWriter(t, ws, { script: `${stubPrelude()}
        const listeners = () => ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
        const before = listeners();
        let during = null;
        const result = await runUpdateCommand([], { handlers: { updateAllRepos: ${finishedHandler(`
            during = listeners();
            process.kill(process.pid, 'SIGTERM');
        `)} } });
        console.log('LISTENERS ' + JSON.stringify({ before, during, after: listeners() }));
        process.exitCode = result.exitCode;
    ` });
    const exit = await settle(writer);
    assert.deepEqual(exit, { code: 1, signal: null }, writer.output());
    const { before, during, after } = JSON.parse(/LISTENERS (.*)/.exec(writer.output())[1]);
    assert.deepEqual(during, before.map(count => count + 1), 'the update owns SIGINT and SIGTERM while it runs');
    assert.deepEqual(after, before, 'and hands them back when it returns');
    assertCancelledBeforeActivation(ws, writer);
});

test('an external signal during synchronous work after the last checkpoint still blocks activation', async (t) => {
    const ws = createWorkspace(t);
    const marker = path.join(ws.root, 'tail-started');
    const writer = startWriter(t, ws, { script: `${stubPrelude()}
        const result = await runUpdateCommand([], { handlers: { updateAllRepos: ${finishedHandler(`
            fs.writeFileSync(${JSON.stringify(marker)}, 'tail');
            const until = Date.now() + 1_500;
            while (Date.now() < until) {}
        `)} } });
        process.exitCode = result.exitCode;
    ` });
    await waitFor('the synchronous tail to start', () => fs.existsSync(marker));
    process.kill(writer.child.pid, 'SIGTERM');
    const exit = await settle(writer);
    assert.deepEqual(exit, { code: 1, signal: null }, writer.output());
    assertCancelledBeforeActivation(ws, writer);
});

test('a signal after the update decided its result still ends the process by its default action', async (t) => {
    const ws = createWorkspace(t);
    const writer = startWriter(t, ws, { script: `${stubPrelude()}
        let signalled = false;
        // The summary is printed after the result was decided and published.
        const log = (...values) => {
            if (!signalled) {
                signalled = true;
                process.kill(process.pid, 'SIGTERM');
            }
            console.log(...values);
        };
        const result = await runUpdateCommand([], { log, handlers: { updateAllRepos: ${finishedHandler('')} } });
        console.log('UPDATE_RETURNED ' + result.exitCode);
    ` });
    const exit = await settle(writer);
    assert.deepEqual(exit, { code: null, signal: 'SIGTERM' }, writer.output());
    assert.doesNotMatch(writer.output(), /UPDATE_RETURNED/, 'nothing after the update, such as activation, runs');
    const report = readUpdateReport(path.join(ws.workspace, '.ploinky'), writer.nonce, { expectedContext: REPORT_CONTEXT });
    assert.equal(report.ok, true, 'the report published before the signal stays valid');
    assert.equal(report.result.exitCode, 0);
});

// A checkpoint reached from an I/O callback runs inside the poll phase, where
// one setImmediate would resume before the pending signal is delivered.
test('a checkpoint reached from an I/O callback still sees a signal received during that callback', async (t) => {
    const ws = createWorkspace(t);
    const writer = startWriter(t, ws, { script: `
        const fs = await import('node:fs');
        const { createUpdateCancellation } = await import(${JSON.stringify(moduleUrl('cli/commands/updateCancellation.js'))});
        const outcomes = [];
        for (let trial = 0; trial < 5; trial += 1) {
            const cancellation = createUpdateCancellation();
            cancellation.arm();
            outcomes.push(await new Promise(resolve => fs.readFile(${JSON.stringify(fileURLToPath(import.meta.url))}, () => {
                process.kill(process.pid, 'SIGTERM');
                cancellation.checkpoint('the next step').then(() => resolve('missed'), error => resolve(error.code));
            })));
            await cancellation.dispose({ reported: true });
        }
        console.log('OUTCOMES ' + JSON.stringify(outcomes));
    ` });
    const exit = await settle(writer);
    assert.deepEqual(exit, { code: 0, signal: null }, writer.output());
    assert.deepEqual(JSON.parse(/OUTCOMES (.*)/.exec(writer.output())[1]), Array(5).fill('PLOINKY_UPDATE_CANCELLED'));
});

// Before it holds the workspace lease the update has nothing to release, so
// Ctrl+C must not wait for another operation's lease to become free.
test('a signal while the update still waits for the workspace lease keeps its default action', async (t) => {
    const ws = createWorkspace(t);
    const holder = spawn(process.execPath, ['--input-type=module', '-e', `
        const { createWorkspaceMutationLease } = await import(${JSON.stringify(moduleUrl('cli/utils/runtime/maintenanceLocks.js'))});
        createWorkspaceMutationLease({ operation: 'fixture-holder' });
        console.log('HELD');
        setInterval(() => {}, 1_000);
    `], { cwd: ws.workspace, env: { ...process.env, PLOINKY_WORKSPACE_ROOT: ws.workspace }, stdio: ['ignore', 'pipe', 'inherit'] });
    t.after(() => {
        try { holder.kill('SIGKILL'); } catch (_) {}
    });
    let holderOutput = '';
    holder.stdout.on('data', (chunk) => { holderOutput += chunk; });
    await waitFor('the fixture operation to hold the workspace lease', () => holderOutput.includes('HELD'));
    const leasePath = path.join(ws.workspace, '.ploinky', 'running', 'workspace-start.json');
    const heldLease = fs.readFileSync(leasePath, 'utf8');

    const writer = startWriter(t, ws, { script: updateScript([]) });
    await waitFor('the update to start', () => writer.output().includes('UPDATE_STARTED'));
    await delay(300);
    process.kill(writer.child.pid, 'SIGTERM');
    const exit = await settle(writer, 5_000);
    assert.deepEqual(exit, { code: null, signal: 'SIGTERM' });
    assert.equal(fs.readFileSync(leasePath, 'utf8'), heldLease, "the other operation's lease is untouched");
    assert.deepEqual(startedFetches(ws), []);
    assert.equal(readUpdateReport(path.join(ws.workspace, '.ploinky'), writer.nonce).code, 'report-missing');
});
