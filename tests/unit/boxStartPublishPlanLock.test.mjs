import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const serviceUrl = pathToFileURL(path.join(repoRoot, 'cli/services/boxStartPublishPlan.js')).href;

function isolatedWorkspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-plan-lock-'));
    fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
    return root;
}

function lockPath(root) {
    return path.join(root, '.ploinky', '.box-start-publish-plan.lock');
}

function spawnLocker(root, {
    id,
    holdMs = 0,
    fail = false,
    lockOptions = {},
} = {}) {
    const source = `
const { withBoxStartPublishPlanLock } = await import(${JSON.stringify(serviceUrl)});
try {
  await withBoxStartPublishPlanLock(async () => {
    process.stdout.write(${JSON.stringify(`${id}:acquired\n`)});
    await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
    ${fail ? `throw new Error(${JSON.stringify(`${id} callback failed`)});` : ''}
    process.stdout.write(${JSON.stringify(`${id}:finished\n`)});
  }, ${JSON.stringify(lockOptions)});
  process.stdout.write(${JSON.stringify(`${id}:released\n`)});
} catch (error) {
  process.stdout.write(${JSON.stringify(`${id}:error:`)} + error.message + '\\n');
  process.exitCode = 2;
}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        cwd: root,
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: root,
            PLOINKY_MASTER_KEY: '5'.repeat(64),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return {
        child,
        exited,
        stdout: () => stdout,
        stderr: () => stderr,
    };
}

async function waitFor(predicate, message, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(message);
}

function registerCleanup(t, roots, children = []) {
    t.after(() => {
        for (const child of children) {
            if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill('SIGKILL');
        }
        for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    });
}

test('same-workspace planners serialize for the complete callback', async (t) => {
    const root = isolatedWorkspace();
    const children = [];
    registerCleanup(t, [root], children);

    const first = spawnLocker(root, { id: 'first', holdMs: 350 });
    children.push(first);
    await waitFor(() => first.stdout().includes('first:acquired'), 'first planner did not acquire its lock');

    const second = spawnLocker(root, { id: 'second' });
    children.push(second);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(second.stdout().includes('second:acquired'), false, second.stdout());

    const firstResult = await first.exited;
    const secondResult = await second.exited;
    assert.equal(firstResult.code, 0, firstResult.stderr || firstResult.stdout);
    assert.equal(secondResult.code, 0, secondResult.stderr || secondResult.stdout);
    assert.match(firstResult.stdout, /first:acquired\nfirst:finished\nfirst:released/);
    assert.match(secondResult.stdout, /second:acquired\nsecond:finished\nsecond:released/);
    assert.equal(fs.existsSync(lockPath(root)), false);
});

test('different exact workspaces do not share a planner lock', async (t) => {
    const firstRoot = isolatedWorkspace();
    const secondRoot = isolatedWorkspace();
    const children = [];
    registerCleanup(t, [firstRoot, secondRoot], children);

    const first = spawnLocker(firstRoot, { id: 'first', holdMs: 500 });
    children.push(first);
    await waitFor(() => first.stdout().includes('first:acquired'), 'first workspace did not acquire');
    const second = spawnLocker(secondRoot, { id: 'second' });
    children.push(second);
    await waitFor(() => second.stdout().includes('second:acquired'), 'second workspace was incorrectly blocked');
    assert.equal(first.stdout().includes('first:finished'), false, first.stdout());

    const [firstResult, secondResult] = await Promise.all([first.exited, second.exited]);
    assert.equal(firstResult.code, 0, firstResult.stderr || firstResult.stdout);
    assert.equal(secondResult.code, 0, secondResult.stderr || secondResult.stdout);
});

test('a live owner produces a bounded timeout without stealing its lock', async (t) => {
    const root = isolatedWorkspace();
    const children = [];
    registerCleanup(t, [root], children);

    const owner = spawnLocker(root, { id: 'owner', holdMs: 450 });
    children.push(owner);
    await waitFor(() => owner.stdout().includes('owner:acquired'), 'owner did not acquire');
    const waiter = spawnLocker(root, {
        id: 'waiter',
        lockOptions: {
            timeoutMs: 120,
            retryMs: 20,
            staleGraceMs: 0,
            staleCheckMs: 20,
            probeTimeoutMs: 50,
        },
    });
    children.push(waiter);
    const waiterResult = await waiter.exited;
    assert.equal(waiterResult.code, 2, waiterResult.stderr || waiterResult.stdout);
    assert.match(waiterResult.stdout, /Timed out after 120ms waiting for workspace publication planner lock/);
    assert.equal(owner.stdout().includes('owner:finished'), false, owner.stdout());
    assert.equal(fs.existsSync(lockPath(root)), true);
    const ownerResult = await owner.exited;
    assert.equal(ownerResult.code, 0, ownerResult.stderr || ownerResult.stdout);
});

test('a dead owner socket is recovered after the stale grace period', async (t) => {
    const root = isolatedWorkspace();
    registerCleanup(t, [root]);
    const stalePath = lockPath(root);
    fs.mkdirSync(stalePath);
    fs.writeFileSync(path.join(stalePath, 'owner.json'), JSON.stringify({
        schemaVersion: 1,
        token: 'dead-owner',
        pid: 1,
        hostname: 'expired-planner-container',
        acquiredAt: '2000-01-01T00:00:00.000Z',
    }));
    const old = new Date('2000-01-01T00:00:00.000Z');
    fs.utimesSync(stalePath, old, old);

    const replacement = spawnLocker(root, {
        id: 'replacement',
        lockOptions: {
            timeoutMs: 1000,
            retryMs: 10,
            staleGraceMs: 10,
            staleCheckMs: 10,
            probeTimeoutMs: 25,
        },
    });
    const result = await replacement.exited;
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /replacement:acquired\nreplacement:finished\nreplacement:released/);
    assert.equal(fs.existsSync(stalePath), false);
});

test('an abandoned stale-recovery guard cannot block the workspace forever', async (t) => {
    const root = isolatedWorkspace();
    registerCleanup(t, [root]);
    const reaperPath = `${lockPath(root)}.reaper`;
    fs.mkdirSync(reaperPath);
    fs.writeFileSync(path.join(reaperPath, 'owner.json'), JSON.stringify({
        pid: 1,
        hostname: 'expired-reaper-container',
        acquiredAt: '2000-01-01T00:00:00.000Z',
    }));
    const old = new Date('2000-01-01T00:00:00.000Z');
    fs.utimesSync(reaperPath, old, old);

    const replacement = spawnLocker(root, {
        id: 'replacement',
        lockOptions: {
            timeoutMs: 1500,
            retryMs: 10,
            staleGraceMs: 10,
            staleCheckMs: 10,
            probeTimeoutMs: 25,
        },
    });
    const result = await replacement.exited;
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /replacement:acquired\nreplacement:finished\nreplacement:released/);
    assert.equal(fs.existsSync(reaperPath), false);
});

test('callback failure releases the planner lock in finally', async (t) => {
    const root = isolatedWorkspace();
    const children = [];
    registerCleanup(t, [root], children);
    const failed = spawnLocker(root, { id: 'failed', fail: true });
    children.push(failed);
    const failedResult = await failed.exited;
    assert.equal(failedResult.code, 2, failedResult.stderr || failedResult.stdout);
    assert.match(failedResult.stdout, /failed:error:failed callback failed/);
    assert.equal(fs.existsSync(lockPath(root)), false);

    const retry = spawnLocker(root, { id: 'retry' });
    children.push(retry);
    const retryResult = await retry.exited;
    assert.equal(retryResult.code, 0, retryResult.stderr || retryResult.stdout);
});

test('SIGTERM releases an acquired planner lock before process exit', async (t) => {
    const root = isolatedWorkspace();
    const children = [];
    registerCleanup(t, [root], children);
    const interrupted = spawnLocker(root, { id: 'interrupted', holdMs: 60_000 });
    children.push(interrupted);
    await waitFor(() => interrupted.stdout().includes('interrupted:acquired'), 'interrupted planner did not acquire');
    interrupted.child.kill('SIGTERM');
    const interruptedResult = await interrupted.exited;
    assert.equal(interruptedResult.code, 143, interruptedResult.stderr || interruptedResult.stdout);
    assert.equal(fs.existsSync(lockPath(root)), false);

    const retry = spawnLocker(root, { id: 'retry' });
    children.push(retry);
    const retryResult = await retry.exited;
    assert.equal(retryResult.code, 0, retryResult.stderr || retryResult.stdout);
});
