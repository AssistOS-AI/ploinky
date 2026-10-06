import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import {
    ToolWorkerPool,
    TOOL_WORKER_MODULE_PATH,
    createToolWorkerPools,
    shutdownToolWorkerPools,
} from '../../Agent/server/toolWorkerPool.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const WORKER_FIXTURE = path.join(FIXTURES, 'toolWorkerFixture.mjs');
const HOST_FIXTURE = path.join(FIXTURES, 'toolWorkerPoolHost.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dirCleanups = new Map();

// One ordered cleanup per test: stop every pool first (so no worker still
// runs in or writes to the directory), then remove the directory.
function makeDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-worker-pool-'));
    const cleanups = [];
    dirCleanups.set(dir, cleanups);
    t.after(async () => {
        for (const cleanup of cleanups) await cleanup();
        dirCleanups.delete(dir);
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    return dir;
}

function onCleanup(dir, cleanup) {
    dirCleanups.get(dir).push(cleanup);
}

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') return false;
        throw error;
    }
}

async function waitUntil(predicate, timeoutMs, intervalMs = 10) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate()) return true;
        if (Date.now() >= deadline) return false;
        await sleep(intervalMs);
    }
}

function readPids(file) {
    return fs.readFileSync(file, 'utf8').trim().split(/\s+/).map(Number);
}

// Last-resort cleanup so a failing assertion never leaks a fixture process.
function killOnExit(t, pids) {
    t.after(() => {
        for (const pid of pids) {
            try {
                process.kill(pid, 'SIGKILL');
            } catch (_) {
                // gone
            }
        }
    });
}

function makePool(t, dir, options = {}) {
    const logs = [];
    const { env, ...rest } = options;
    const pool = new ToolWorkerPool('fixture', {
        command: process.execPath,
        args: [WORKER_FIXTURE],
        cwd: dir,
        env: { FIXTURE_LOADS_LOG: path.join(dir, 'loads.log'), ...env },
        log: (line) => logs.push(line),
        ...rest,
    });
    onCleanup(dir, () => pool.shutdown({ timeoutMs: 5000 }));
    return { pool, logs };
}

async function callTool(pool, input, { toolEnv, ...extra } = {}) {
    const result = await pool.call({
        toolName: 'fixture_tool',
        toolEnv: toolEnv || { TOOL_NAME: 'fixture_tool' },
        payload: { tool: 'fixture_tool', input, metadata: {} },
        ...extra,
    });
    // End-of-call markers are stripped from every result.
    for (const stream of ['stdout', 'stderr']) {
        assert.ok(!String(result[stream]).includes('PLOINKY_TOOL_WORKER_END'), `${stream} carries a marker`);
    }
    return result;
}

function loads(dir) {
    const file = path.join(dir, 'loads.log');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

async function echoPid(pool, extra) {
    const result = await callTool(pool, { mode: 'echo' }, extra);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout).pid;
}

test('T1: 100 calls at concurrency 10 load at most size workers and match their requests', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 2 });
    const results = new Array(100);
    let next = 0;
    async function runner() {
        while (next < 100) {
            const index = next++;
            results[index] = await callTool(pool, { mode: 'echo', id: index });
        }
    }
    await Promise.all(Array.from({ length: 10 }, runner));
    for (let index = 0; index < 100; index += 1) {
        assert.equal(results[index].code, 0, results[index].stderr);
        assert.equal(results[index].signal, null);
        assert.equal(JSON.parse(results[index].stdout).id, index);
    }
    assert.ok(loads(dir).length <= 2, `worker loads: ${loads(dir).length}`);
});

test('T2: a call timeout kills the worker process group and the next call gets a new worker', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1, callTimeoutMs: 200 });
    // The warm-up call leaves a tool child in the worker's process group, so
    // the group kill is checked even if the busy machine delays the hang
    // handler past the 200 ms timeout.
    const lingerFile = path.join(dir, 'linger.pids');
    const warm = await callTool(pool, { mode: 'spawnChild', pidFile: lingerFile }, { timeoutMs: 10_000 });
    assert.equal(warm.code, 0, warm.stderr);
    const [warmPid, lingeringChildPid] = readPids(lingerFile);
    killOnExit(t, [warmPid, lingeringChildPid]);
    assert.equal(pidAlive(lingeringChildPid), true);
    const hangFile = path.join(dir, 'hang.pids');

    const started = Date.now();
    const result = await callTool(pool, { mode: 'hang', ms: 5000, pidFile: hangFile });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `timeout resolved after ${elapsed}ms`);
    assert.notEqual(result.code, 0);
    assert.equal(result.signal, null);
    // Exact text: a timeout while still waiting for a worker would read "... waiting for a worker".
    assert.equal(result.stderr, 'tool worker call timed out after 200ms\n');

    const groupPids = [warmPid, lingeringChildPid];
    if (fs.existsSync(hangFile)) {
        const [hangWorkerPid, hangChildPid] = readPids(hangFile);
        killOnExit(t, [hangChildPid]);
        assert.equal(hangWorkerPid, warmPid);
        groupPids.push(hangChildPid);
    }
    assert.ok(await waitUntil(() => !pidAlive(warmPid), 1000), 'worker pid still alive');
    assert.ok(await waitUntil(() => groupPids.every((pid) => !pidAlive(pid)), 1000),
        `tool children in the worker group still alive: ${groupPids.filter(pidAlive).join(',')}`);

    const nextPid = await echoPid(pool, { timeoutMs: 10_000 });
    assert.notEqual(nextPid, warmPid);
});

test('T3: process.exit inside a call fails that call once and the pool respawns', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1 });
    const counterFile = path.join(dir, 'counter');
    const firstPid = await echoPid(pool);
    const result = await callTool(pool, { mode: 'exit', counterFile });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /worker exited/);
    await sleep(200);
    assert.equal(fs.readFileSync(counterFile, 'utf8'), 'x', 'the call ran exactly once (never retried)');
    const nextPid = await echoPid(pool);
    assert.notEqual(nextPid, firstPid);
    assert.equal(pool.stats().crashes, 1);
});

test('T4: workers are recycled after maxCallsPerWorker calls', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1, maxCallsPerWorker: 3 });
    const pids = [];
    for (let index = 0; index < 7; index += 1) pids.push(await echoPid(pool));
    assert.equal(new Set(pids).size, 3, `pids: ${pids.join(',')}`);
    assert.deepEqual(pids.slice(0, 3), [pids[0], pids[0], pids[0]]);
    assert.deepEqual(pids.slice(3, 6), [pids[3], pids[3], pids[3]]);
});

test('T5: a reported rss above maxRssBytes recycles the worker after every call', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1, maxRssBytes: 1 });
    const pids = [];
    for (let index = 0; index < 3; index += 1) pids.push(await echoPid(pool));
    assert.equal(new Set(pids).size, 3, `pids: ${pids.join(',')}`);
});

test('T6: a call that mutates process.env is recycled and never leaks into the next call', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1 });
    const a = await callTool(pool, { mode: 'setEnv' }, { toolEnv: { TOOL_NAME: 'a' } });
    assert.equal(a.code, 0, a.stderr);
    assert.equal(JSON.parse(a.stdout).leak, '1');
    const b = await callTool(pool, { mode: 'echo' }, { toolEnv: { TOOL_NAME: 'b' } });
    assert.equal(b.code, 0, b.stderr);
    const seen = JSON.parse(b.stdout);
    assert.equal(seen.leak, null);
    assert.equal(seen.toolEnvName, 'b');
    assert.equal(seen.processToolName, null, 'toolEnv is passed to the handler, not merged into process.env');
    assert.notEqual(seen.pid, JSON.parse(a.stdout).pid);
});

test('T6b: a call that changes process.cwd() is recycled', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1 });
    const a = await callTool(pool, { mode: 'chdir' });
    assert.equal(a.code, 0, a.stderr);
    const b = JSON.parse((await callTool(pool, { mode: 'echo' })).stdout);
    assert.notEqual(b.pid, JSON.parse(a.stdout).pid);
    assert.equal(fs.realpathSync(b.cwd), fs.realpathSync(dir));
});

test('T7: stdout/stderr are captured per call and late writes never reach another call', async (t) => {
    const dir = makeDir(t);
    const { pool, logs } = makePool(t, dir, { size: 1 });
    const out = await callTool(pool, { mode: 'output' });
    assert.equal(out.code, 0);
    assert.equal(out.stdout, 'x\ny');
    assert.equal(out.stderr, 'e');

    const a = await callTool(pool, { mode: 'lateWrite' });
    assert.equal(a.stdout, 'A');
    const b = await callTool(pool, { mode: 'slow', ms: 200, text: 'B' });
    assert.equal(b.stdout, 'B');
    assert.equal(b.stderr, '');
    assert.ok(!b.stdout.includes('LATE-WRITE'));
    assert.ok(await waitUntil(() => logs.some((line) => line.includes('LATE-WRITE')), 1000),
        `a write after its call ended goes to the worker log; log: ${JSON.stringify(logs)} b: ${JSON.stringify(b)}`);
});

test('T8: a handler reading process.stdin sees EOF instead of protocol frames', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1 });
    await echoPid(pool);
    const started = Date.now();
    const result = await callTool(pool, { mode: 'stdin' }, { timeoutMs: 5000 });
    assert.ok(Date.now() - started < 1000, `stdin call took ${Date.now() - started}ms`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'stdin-bytes=0');
});

test('T9: process.exitCode becomes the call exit code and is reset afterwards', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1 });
    const failed = await callTool(pool, { mode: 'exitCode' });
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, 'set exitCode');
    const next = await callTool(pool, { mode: 'echo' });
    assert.equal(next.code, 0);
});

test('T10: an unhandled rejection inside a call fails it and recycles the worker', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1 });
    const firstPid = await echoPid(pool);
    const result = await callTool(pool, { mode: 'reject' });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unhandled rejection during call: fixture rejection/);
    assert.notEqual(await echoPid(pool), firstPid);
});

test('T10b: an uncaught exception inside a call fails it and recycles the worker', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1 });
    const firstPid = await echoPid(pool);
    const result = await callTool(pool, { mode: 'uncaught' });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /uncaught exception during call: fixture uncaught/);
    assert.notEqual(await echoPid(pool), firstPid);
});

for (const [mode, label] of [['lateThrow', 'uncaught exception'], ['fireAndForget', 'unhandled rejection']]) {
    test(`F1: a late ${label} from an ended call never kills the call that is running`, async (t) => {
        const dir = makeDir(t);
        const { pool, logs } = makePool(t, dir, { size: 1 });
        const file = path.join(dir, 'b.txt');
        const runsFile = path.join(dir, 'b.runs');
        const a = await callTool(pool, { mode });
        assert.equal(a.code, 0, a.stderr);
        const b = await callTool(pool, { mode: 'slowWrite', ms: 300, file, runsFile });
        assert.equal(b.code, 0, b.stderr);
        assert.equal(fs.readFileSync(file, 'utf8'), 'part1+part2', 'B ran to completion');
        assert.equal(fs.readFileSync(runsFile, 'utf8'), 'r', 'B ran exactly once');
        const aPid = JSON.parse(a.stdout).pid;
        assert.equal(JSON.parse(b.stdout).pid, aPid, 'B ran in the worker that A used');
        assert.ok(logs.some((line) => line.includes(`${label} outside a call`)), JSON.stringify(logs));
        assert.notEqual(await echoPid(pool), aPid, 'the worker is recycled after B');
    });
}

test('a reply sent just before a fatal error outside a call is still delivered', async (t) => {
    const dir = makeDir(t);
    const { pool, logs } = makePool(t, dir, { size: 1 });
    for (let index = 0; index < 20; index += 1) {
        const result = await callTool(pool, { mode: 'throwAfterReply', bytes: 200_000 });
        assert.equal(result.code, 0, `call ${index}: ${result.stderr}`);
        assert.equal(result.stdout.length, 200_000);
    }
});

test('a fatal error outside any call exits the worker with code 70', async (t) => {
    const dir = makeDir(t);
    const { pool, logs } = makePool(t, dir, { size: 1 });
    const result = await callTool(pool, { mode: 'lateThrow' });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(await waitUntil(() => logs.some((line) => line.includes('exited unexpectedly (code 70, signal null)')), 3000),
        JSON.stringify(logs));
    assert.ok(logs.some((line) => line.includes('uncaught exception outside a call: late from A')));
});

test('D1: a call that already replied never runs again when its worker exits before its markers arrive', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1, env: { FIXTURE_DELAY_STDOUT_MS: '50' } });
    const runsFile = path.join(dir, 'runs');
    const result = await callTool(pool, { mode: 'countThenLateThrowOnce', runsFile }, { timeoutMs: 10_000 });
    await sleep(300);
    assert.equal(fs.readFileSync(runsFile, 'utf8'), 'r', `handler runs for one call; result ${JSON.stringify(result)}`);
    // The worker exited before its end markers reached the pipe, so the call
    // cannot be completed; it fails instead of running a second time.
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /worker exited/);
    assert.equal(pool.stats().spawned, 1);
});

test('a non-zero process.exitCode becomes the call exit code over the returned code', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1 });
    const result = await callTool(pool, { mode: 'exitCodeAndReturn' });
    assert.equal(result.code, 5);
});

test('a handler throw fails only that call and keeps the worker', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1 });
    const firstPid = await echoPid(pool);
    const result = await callTool(pool, { mode: 'throw' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /fixture handler failure/);
    assert.equal(await echoPid(pool), firstPid);
});

test('T11: a full wait queue fails fast as saturated', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1, maxQueue: 2 });
    const accepted = [1, 2, 3].map((index) => callTool(pool, { mode: 'slow', ms: 500, text: `call-${index}` }));
    const started = Date.now();
    const rejected = await callTool(pool, { mode: 'slow', ms: 500, text: 'call-4' });
    assert.ok(Date.now() - started < 100, `saturation took ${Date.now() - started}ms`);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /saturated/);
    const done = await Promise.all(accepted);
    assert.deepEqual(done.map((result) => result.stdout), ['call-1', 'call-2', 'call-3']);
});

test('T12: a reply larger than maxFrameBytes fails the call and recycles the worker', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1, maxFrameBytes: 64 * 1024 });
    const firstPid = await echoPid(pool);
    const result = await callTool(pool, { mode: 'big', bytes: 200 * 1024 });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /exceeds maxFrameBytes/);
    assert.notEqual(await echoPid(pool), firstPid);
});

test('T13: shutdown with a call in flight leaves no worker process alive', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1 });
    const pidFile = path.join(dir, 'hang.pids');
    const inFlight = callTool(pool, { mode: 'hang', ms: 30_000, pidFile });
    assert.ok(await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').includes('\n'), 5000));
    const [workerPid, toolChildPid] = readPids(pidFile);
    killOnExit(t, [workerPid, toolChildPid]);

    const outcome = await pool.shutdown({ timeoutMs: 3000 });
    assert.equal(outcome.clean, true);
    assert.equal(pidAlive(workerPid), false, 'worker pid alive after shutdown');
    assert.equal(pidAlive(toolChildPid), false, 'tool child alive after shutdown');
    const result = await inFlight;
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /shutting down/);
    assert.equal(pool.stats().workers, 0);
    const after = await callTool(pool, { mode: 'echo' });
    assert.match(after.stderr, /shutting down/);
});

test('T14: three deaths before ready degrade the pool to the spawn fallback', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1, env: { FIXTURE_DIE_BEFORE_READY: '1' } });
    let fallbacks = 0;
    const fallback = async () => {
        fallbacks += 1;
        return { code: 0, signal: null, stdout: 'from-spawn-fallback', stderr: '' };
    };
    const first = await callTool(pool, { mode: 'echo' }, { fallback });
    assert.equal(first.stdout, 'from-spawn-fallback');
    assert.equal(loads(dir).length, 3);
    assert.equal(pool.stats().degraded, true);

    const second = await callTool(pool, { mode: 'echo' }, { fallback });
    assert.equal(second.stdout, 'from-spawn-fallback');
    assert.equal(fallbacks, 2);
    assert.equal(loads(dir).length, 3, 'a degraded pool spawns no workers');

    const noFallback = await callTool(pool, { mode: 'echo' });
    assert.notEqual(noFallback.code, 0);
    assert.match(noFallback.stderr, /degraded/);
});

test('T14b: workers that hang until readyTimeoutMs still degrade the pool (fake clock)', async (t) => {
    const dir = makeDir(t);
    // 1 real ms = 150 pool ms: readyTimeoutMs 100 (a real timer) spans 15 s of
    // pool time, the plan default, so three hangs take 45 s of pool time.
    const t0 = Date.now();
    const now = () => t0 + (Date.now() - t0) * 150;
    const { pool } = makePool(t, dir, { size: 1, readyTimeoutMs: 100, now, env: { FIXTURE_HANG_BEFORE_READY: '1' } });
    let fallbacks = 0;
    const fallback = async () => {
        fallbacks += 1;
        return { code: 0, signal: null, stdout: 'from-spawn-fallback', stderr: '' };
    };
    const first = await callTool(pool, { mode: 'echo' }, { fallback, timeoutMs: 10_000 });
    assert.equal(first.stdout, 'from-spawn-fallback', JSON.stringify(first));
    assert.equal(pool.stats().spawned, 3);
    assert.equal(pool.stats().degraded, true);
    assert.equal(fallbacks, 1);

    // Degraded mode ends after 60 s of pool time; the pool then spawns again.
    assert.ok(await waitUntil(() => !pool.isDegraded(), 3000), 'degraded mode never ended');
    const again = await callTool(pool, { mode: 'echo' }, { fallback, timeoutMs: 10_000 });
    assert.equal(again.stdout, 'from-spawn-fallback');
    assert.equal(pool.stats().spawned, 6);
    assert.equal(fallbacks, 2);
});

test('a throwing spawn fallback resolves as a failed call instead of rejecting', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1, env: { FIXTURE_DIE_BEFORE_READY: '1' } });
    const fallback = async () => {
        throw new Error('spawn failed: ENOENT');
    };
    const queued = await callTool(pool, { mode: 'echo' }, { fallback });
    assert.equal(queued.code, 1);
    assert.match(queued.stderr, /spawn fallback failed: spawn failed: ENOENT/);
    assert.equal(pool.stats().degraded, true);
    const direct = await callTool(pool, { mode: 'echo' }, { fallback });
    assert.equal(direct.code, 1);
    assert.match(direct.stderr, /spawn fallback failed/);
});

test('timeouts above the 2^31-1 ms timer limit are clamped instead of firing at once', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1, callTimeoutMs: 2 ** 32, idleTimeoutMs: 2 ** 32, readyTimeoutMs: 2 ** 32 });
    assert.equal(pool.callTimeoutMs, 2 ** 31 - 1);
    const first = await callTool(pool, { mode: 'slow', ms: 50, text: 'ok' });
    assert.equal(first.code, 0, first.stderr);
    const perCall = await callTool(pool, { mode: 'slow', ms: 50, text: 'ok' }, { timeoutMs: 2 ** 40 });
    assert.equal(perCall.code, 0, perCall.stderr);
    await sleep(100);
    assert.equal(pool.stats().workers, 1, 'the idle timer must not fire at once');
});

test('F3: output of tool children that inherit fd 1/2 belongs to the call, not the log', async (t) => {
    const dir = makeDir(t);
    const { pool, logs } = makePool(t, dir, { size: 1 });
    const result = await callTool(pool, { mode: 'inheritChild' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'before\nCHILD-STDOUT\nafter\n');
    assert.equal(result.stderr, 'CHILD-STDERR-SECRET\n');
    await sleep(100);
    assert.ok(!logs.some((line) => line.includes('CHILD-')), JSON.stringify(logs));
});

test('F3: a tracked background child of an ended call never writes into the next call', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1 });
    const a = await callTool(pool, { mode: 'bgTrackedChild' });
    assert.equal(a.code, 0, a.stderr);
    const b = await callTool(pool, { mode: 'slow', ms: 500, text: 'B' });
    assert.equal(b.stdout, 'B');
    assert.equal(b.stderr, '');
    assert.notEqual(JSON.parse((await callTool(pool, { mode: 'echo' })).stdout).pid, JSON.parse(a.stdout).pid,
        'a call that leaves child processes running is recycled');
});

test('F3: output that arrives while a worker is idle is logged and the worker replaced', async (t) => {
    const dir = makeDir(t);
    const { pool, logs } = makePool(t, dir, { size: 1 });
    const a = await callTool(pool, { mode: 'bgUntrackedChild' });
    assert.equal(a.code, 0, a.stderr);
    assert.ok(await waitUntil(() => logs.some((line) => line.includes('BG-UNTRACKED-LATE')), 3000), JSON.stringify(logs));
    const b = await callTool(pool, { mode: 'echo' });
    assert.ok(!b.stdout.includes('BG-UNTRACKED-LATE'));
    assert.notEqual(JSON.parse(b.stdout).pid, JSON.parse(a.stdout).pid, 'the idle worker that produced output was replaced');
});

test('tool children cannot reach the worker channel through fd 3', async (t) => {
    const dir = makeDir(t);
    const { pool, logs } = makePool(t, dir, { size: 1 });
    const firstPid = await echoPid(pool);
    const probe = await callTool(pool, { mode: 'probeFd3' });
    assert.equal(probe.code, 0, probe.stderr);
    const seen = JSON.parse(probe.stdout);
    for (const [label, report] of Object.entries(seen)) {
        assert.notEqual(report.fstat, 'socket', `${label}: fd 3 of a tool child is a socket: ${JSON.stringify(report)}`);
        assert.notEqual(report.write, 'ok', `${label}: a tool child wrote to fd 3: ${JSON.stringify(report)}`);
    }
    assert.equal(await echoPid(pool), firstPid, 'the worker was not disturbed');
    assert.ok(!logs.some((line) => line.includes('protocol error')), JSON.stringify(logs));
});

test('the handshake socket rejects a peer without the bootstrap token', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1, env: { FIXTURE_DELAY_BEFORE_SERVE_MS: '400' } });
    const pending = callTool(pool, { mode: 'echo' }, { timeoutMs: 10_000 });
    const starting = [...pool.workers][0];
    assert.ok(await waitUntil(() => starting.child && starting.socketPath, 3000));
    const socketPath = starting.socketPath;
    assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
    const intruder = net.createConnection(socketPath);
    intruder.on('error', () => {});
    await new Promise((resolve) => intruder.once('connect', resolve));
    intruder.write(`${JSON.stringify({ v: 1, type: 'hello', token: 'f'.repeat(64) })}\n`);
    const closed = await Promise.race([
        new Promise((resolve) => intruder.once('close', () => resolve(true))),
        sleep(2000).then(() => false),
    ]);
    assert.equal(closed, true, 'the pool kept a peer that failed the handshake');
    const result = await pending;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).pid, starting.pid);
    assert.equal(fs.existsSync(path.dirname(socketPath)), false, 'the socket directory is removed after the handshake');
});

test('D2: workers that fail right after ready degrade the pool within a bounded number of spawns', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1, env: { FIXTURE_THROW_AFTER_READY: '1' } });
    let fallbacks = 0;
    const fallback = async () => {
        fallbacks += 1;
        return { code: 0, signal: null, stdout: 'from-spawn-fallback', stderr: '' };
    };
    // Put back once after the first worker died, then failed: it never ran.
    const first = await callTool(pool, { mode: 'echo' }, { fallback, timeoutMs: 10_000 });
    assert.notEqual(first.code, 0, JSON.stringify(first));
    assert.match(first.stderr, /exited twice before starting the call/);
    assert.equal(pool.stats().spawned, 2);
    // The third worker that exits without completing a call degrades the pool.
    const second = await callTool(pool, { mode: 'echo' }, { fallback, timeoutMs: 10_000 });
    assert.equal(second.stdout, 'from-spawn-fallback', JSON.stringify(second));
    assert.equal(pool.stats().degraded, true);
    assert.equal(pool.stats().spawned, 3);
    assert.equal(fallbacks, 1);
});

function codeStamp(file) {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function codeVersion(result) {
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
}

test('fresh code: a change to the tool code is visible on the very next call', async (t) => {
    const dir = makeDir(t);
    const codeFile = path.join(dir, 'tool-code.txt');
    fs.writeFileSync(codeFile, 'v1');
    const { pool, logs } = makePool(t, dir, { size: 1, env: { FIXTURE_CODE_FILE: codeFile }, codeIdentity: () => codeStamp(codeFile) });
    const first = codeVersion(await callTool(pool, { mode: 'codeVersion' }));
    assert.equal(first.version, 'v1');
    assert.equal(codeVersion(await callTool(pool, { mode: 'codeVersion' })).pid, first.pid, 'unchanged code keeps the warm worker');

    fs.writeFileSync(codeFile, 'v2');
    const second = codeVersion(await callTool(pool, { mode: 'codeVersion' }));
    assert.equal(second.version, 'v2');
    assert.notEqual(second.pid, first.pid);
    assert.ok(logs.some((line) => line.includes('tool code changed; replacing the worker')));
});

test('fresh code: a worker that is busy when the code changes is replaced after its call', async (t) => {
    const dir = makeDir(t);
    const codeFile = path.join(dir, 'tool-code.txt');
    fs.writeFileSync(codeFile, 'v1');
    const { pool } = makePool(t, dir, { size: 1, env: { FIXTURE_CODE_FILE: codeFile }, codeIdentity: () => codeStamp(codeFile) });
    const busy = callTool(pool, { mode: 'codeVersion', ms: 400 });
    assert.ok(await waitUntil(() => pool.stats().busy === 1, 5000));
    const queued = callTool(pool, { mode: 'codeVersion' });
    fs.writeFileSync(codeFile, 'v2-longer');
    const busyResult = codeVersion(await busy);
    assert.equal(busyResult.version, 'v1', 'the running call finishes on the code it started with');
    const next = codeVersion(await queued);
    assert.equal(next.version, 'v2-longer');
    assert.notEqual(next.pid, busyResult.pid);
});

test('fresh code: a failing codeIdentity hook sends calls to the spawn fallback', async (t) => {
    const dir = makeDir(t);
    const { pool, logs } = makePool(t, dir, {
        size: 1,
        codeIdentity: () => {
            throw new Error('tool command missing');
        },
    });
    const fallback = async () => ({ code: 0, signal: null, stdout: 'from-spawn-fallback', stderr: '' });
    const result = await callTool(pool, { mode: 'echo' }, { fallback });
    assert.equal(result.stdout, 'from-spawn-fallback');
    const noFallback = await callTool(pool, { mode: 'echo' });
    assert.notEqual(noFallback.code, 0);
    assert.match(noFallback.stderr, /code identity could not be read/);
    assert.ok(logs.some((line) => line.includes('codeIdentity failed (tool command missing)')));
});

test('stray output split inside a multibyte character is logged intact', async (t) => {
    const dir = makeDir(t);
    const { pool, logs } = makePool(t, dir, { size: 1, env: { FIXTURE_SPLIT_UTF8_BEFORE_SERVE: '1' } });
    assert.equal((await callTool(pool, { mode: 'echo' })).code, 0);
    assert.ok(logs.some((line) => line.endsWith(' caf\u00e9-\u00e9')), JSON.stringify(logs));
    assert.ok(!logs.some((line) => line.includes('\ufffd')), JSON.stringify(logs));
});

test('T15: SIGKILL of the host process ends its workers within 2 s', async (t) => {
    const dir = makeDir(t);
    const pidDir = path.join(dir, 'pids');
    fs.mkdirSync(pidDir);
    const host = spawn(process.execPath, [HOST_FIXTURE, path.join(dir, 'loads.log'), pidDir], { stdio: 'ignore' });
    killOnExit(t, [host.pid]);
    const files = ['a.pids', 'b.pids'].map((name) => path.join(pidDir, name));
    const ready = await waitUntil(
        () => files.every((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('\n')),
        10_000,
    );
    assert.ok(ready, 'host fixture never started both workers');
    const pids = files.flatMap(readPids);
    killOnExit(t, pids);
    assert.equal(new Set(pids).size, 4);
    for (const pid of pids) assert.equal(pidAlive(pid), true);

    const exited = new Promise((resolve) => host.once('exit', resolve));
    process.kill(host.pid, 'SIGKILL');
    await exited;
    const started = Date.now();
    const gone = await waitUntil(() => pids.every((pid) => !pidAlive(pid)), 2000);
    assert.ok(gone, `still alive after ${Date.now() - started}ms: ${pids.filter(pidAlive).join(',')}`);
});

test('idle workers are reaped after idleTimeoutMs', async (t) => {
    const dir = makeDir(t);
    const { pool } = makePool(t, dir, { size: 1, idleTimeoutMs: 150 });
    const pid = await echoPid(pool);
    assert.ok(await waitUntil(() => pool.stats().workers === 0 && !pidAlive(pid), 2000));
    assert.notEqual(await echoPid(pool), pid);
});

test('frames are never logged, even on protocol errors', async (t) => {
    const dir = makeDir(t);
    const { pool, logs } = makePool(t, dir, { size: 1, maxFrameBytes: 4096 });
    const secret = 'SECRET-TOKEN-tool-worker-xyz';
    const metadata = { invocationToken: secret };
    const ok = await pool.call({ toolName: 'fixture_tool', payload: { input: { mode: 'echo' }, metadata } });
    assert.equal(ok.code, 0);
    const big = await pool.call({ toolName: 'fixture_tool', payload: { input: { mode: 'big', bytes: 8192 }, metadata } });
    assert.match(big.stderr, /exceeds maxFrameBytes/);
    const oversizeCall = await pool.call({ toolName: 'fixture_tool', payload: { input: { pad: 'p'.repeat(8192) }, metadata } });
    assert.match(oversizeCall.stderr, /call frame exceeds maxFrameBytes/);
    await pool.shutdown({ timeoutMs: 3000 });
    assert.ok(logs.length > 0, 'the pool logged its recycle');
    for (const line of logs) assert.ok(!line.includes(secret), `log line leaks a frame: ${line}`);
});

test('createToolWorkerPools builds declared pools and shutdownToolWorkerPools ends them', async (t) => {
    const dir = makeDir(t);
    const logs = [];
    const seenSpecs = [];
    const buildCommandSpec = (entry, defaultCwd) => {
        seenSpecs.push(defaultCwd);
        if (typeof entry.command !== 'string') return null;
        return { command: entry.command, args: entry.args || [], cwd: entry.cwd || defaultCwd, env: entry.env || {} };
    };
    const pools = createToolWorkerPools({
        tools: [],
        toolWorkers: {
            fixture: {
                command: process.execPath,
                args: [WORKER_FIXTURE],
                cwd: dir,
                env: { FIXTURE_LOADS_LOG: path.join(dir, 'loads.log') },
                size: 1,
                maxQueue: 0,
            },
            broken: { size: 1 },
        },
    }, { buildCommandSpec, defaultCwd: dir, log: (line) => logs.push(line) });
    onCleanup(dir, () => shutdownToolWorkerPools({ timeoutMs: 5000 }));
    assert.deepEqual([...pools.keys()], ['fixture']);
    assert.ok(logs.some((line) => line.includes("'broken'")));
    assert.ok(path.isAbsolute(TOOL_WORKER_MODULE_PATH) && fs.existsSync(TOOL_WORKER_MODULE_PATH));

    const pool = pools.get('fixture');
    assert.equal(pool.size, 1);
    assert.equal(pool.callTimeoutMs, 300_000);
    const result = await pool.call({ toolName: 'fixture_tool', toolEnv: { TOOL_NAME: 'x' }, payload: { input: { mode: 'echo' } } });
    assert.equal(result.code, 0, result.stderr);
    const workerPid = JSON.parse(result.stdout).pid;
    assert.equal(fs.realpathSync(JSON.parse(result.stdout).cwd), fs.realpathSync(dir));

    const outcome = await shutdownToolWorkerPools({ timeoutMs: 5000 });
    assert.equal(outcome.clean, true);
    assert.equal(pidAlive(workerPid), false);
    assert.equal(createToolWorkerPools({ tools: [] }, { buildCommandSpec }).size, 0);
});
