// Worker handshake sockets must live where a Unix socket can be connected to.
// In a nested Podman container /tmp is fuse-overlayfs: listen succeeds but
// connect fails with EACCES, so every warm worker died and the pool degraded.
// The pool now probes each candidate base once per process and uses the first
// one that connects; with none, it degrades at once and spawns nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ToolWorkerPool,
    createToolWorkerSocketDirectories,
    toolWorkerSocketBases,
} from '../../Agent/server/toolWorkerPool.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const WORKER_FIXTURE = path.join(FIXTURES, 'toolWorkerFixture.mjs');

// Short private bases: socket paths must stay under the sun_path limit.
function base(t, label) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', `twsd-${label}-`)));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// Real net, except that connecting to a socket under a refused base fails
// asynchronously with EACCES, as on fuse-overlayfs.
function refusingNet(refusedBases, counts = { servers: 0, connects: 0 }) {
    return {
        counts,
        createServer: (...args) => {
            counts.servers += 1;
            return net.createServer(...args);
        },
        createConnection: (socketPath) => {
            counts.connects += 1;
            if (!refusedBases.some((refused) => socketPath.startsWith(`${refused}${path.sep}`))) {
                return net.createConnection(socketPath);
            }
            const socket = new net.Socket();
            setImmediate(() => socket.emit('error', Object.assign(new Error(`connect EACCES ${socketPath}`), { code: 'EACCES' })));
            return socket;
        },
    };
}

function entries(dir) {
    return fs.readdirSync(dir);
}

const okFallback = async () => ({ code: 0, signal: null, stdout: 'from-spawn-fallback', stderr: '' });

function fixturePool(t, { socketDirectories, size = 1 }) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twsd-work-'));
    const logs = [];
    const pool = new ToolWorkerPool('fixture', {
        command: process.execPath,
        args: [WORKER_FIXTURE],
        cwd: work,
        env: { FIXTURE_LOADS_LOG: path.join(work, 'loads.log') },
        size,
        log: (line) => logs.push(line),
        socketDirectories,
    });
    t.after(async () => {
        await pool.shutdown({ timeoutMs: 5000 });
        fs.rmSync(work, { recursive: true, force: true });
    });
    const loads = () => (fs.existsSync(path.join(work, 'loads.log'))
        ? fs.readFileSync(path.join(work, 'loads.log'), 'utf8').split('\n').filter(Boolean)
        : []);
    return { pool, logs, loads };
}

function echo(pool, extra = {}) {
    return pool.call({
        toolName: 'fixture_tool',
        toolEnv: { TOOL_NAME: 'fixture_tool' },
        payload: { tool: 'fixture_tool', input: { mode: 'echo' }, metadata: {} },
        timeoutMs: 10_000,
        ...extra,
    });
}

test('candidate bases: an absolute override first, then os.tmpdir(), /dev/shm and /tmp, without duplicates', () => {
    const defaults = [...new Set([os.tmpdir(), '/dev/shm', '/tmp'].map((entry) => path.resolve(entry)))];
    assert.deepEqual(toolWorkerSocketBases({}), defaults);
    assert.deepEqual(toolWorkerSocketBases({ PLOINKY_TOOL_WORKER_SOCKET_DIR: '/run/ptw' }), ['/run/ptw', ...defaults]);
    assert.deepEqual(toolWorkerSocketBases({ PLOINKY_TOOL_WORKER_SOCKET_DIR: 'relative/dir' }), defaults, 'a relative override is ignored');
    assert.deepEqual(toolWorkerSocketBases({ PLOINKY_TOOL_WORKER_SOCKET_DIR: '' }), defaults);
    assert.deepEqual(toolWorkerSocketBases({ PLOINKY_TOOL_WORKER_SOCKET_DIR: '/tmp/' }),
        [...new Set(['/tmp', ...defaults])], 'an override equal to a default appears once, first');
});

test('a base whose socket refuses connections (EACCES) is skipped for the next one, which is then remembered', async (t) => {
    const refused = base(t, 'refused');
    const usable = base(t, 'usable');
    const netApi = refusingNet([refused]);
    const directories = createToolWorkerSocketDirectories({ bases: () => [refused, usable], netApi });
    assert.equal(directories.current(), null);
    assert.equal(await directories.resolve(), usable);
    assert.equal(directories.current(), usable);
    assert.deepEqual(netApi.counts, { servers: 2, connects: 2 });
    assert.deepEqual(entries(refused), [], 'the probe removes its directory');
    assert.deepEqual(entries(usable), []);
    // Remembered for this process: no further probes.
    assert.equal(await directories.resolve(), usable);
    assert.deepEqual(netApi.counts, { servers: 2, connects: 2 });
    // Concurrent resolutions after an invalidation share one probe pass.
    directories.invalidate(usable);
    assert.equal(directories.current(), null);
    const results = await Promise.all([directories.resolve(), directories.resolve(), directories.resolve()]);
    assert.deepEqual(results, [usable, usable, usable]);
    assert.deepEqual(netApi.counts, { servers: 4, connects: 4 });
    directories.invalidate('/somewhere/else');
    assert.equal(directories.current(), usable, 'invalidating another base keeps the remembered one');
});

test('when no base can connect, resolution names every base tried and remembers nothing', async (t) => {
    const refusedA = base(t, 'a');
    const refusedB = base(t, 'b');
    const missing = path.join(refusedA, 'missing');
    const tooLong = path.join(refusedB, 'x'.repeat(120));
    fs.mkdirSync(tooLong);
    const netApi = refusingNet([refusedA, refusedB]);
    const directories = createToolWorkerSocketDirectories({ bases: () => [refusedA, missing, tooLong, refusedB], netApi });
    await assert.rejects(directories.resolve(), (error) => {
        assert.equal(error.code, 'TOOL_WORKER_SOCKET_UNAVAILABLE');
        assert.match(error.message, new RegExp(`${refusedA} \\(connect EACCES\\)`));
        assert.match(error.message, new RegExp(`${missing} \\(ENOENT\\)`));
        assert.match(error.message, /exceeds 100 bytes/);
        assert.match(error.message, new RegExp(`${refusedB} \\(connect EACCES\\)`));
        return true;
    });
    assert.equal(directories.current(), null);
    assert.deepEqual(entries(refusedA), [], 'no probe directory is left behind');
    assert.equal(fs.existsSync(missing), false);
    assert.deepEqual(entries(refusedB), [path.basename(tooLong)]);
    assert.deepEqual(entries(tooLong), [], 'an over-long probe directory is removed');
    await assert.rejects(directories.resolve(), { code: 'TOOL_WORKER_SOCKET_UNAVAILABLE' });
    assert.equal(netApi.counts.connects, 4, 'a failed resolution probes again next time');
});

test('a probe that never connects times out instead of hanging', async (t) => {
    const silent = base(t, 'silent');
    const netApi = {
        createServer: (...args) => net.createServer(...args),
        createConnection: () => new net.Socket(),
    };
    const directories = createToolWorkerSocketDirectories({ bases: () => [silent], netApi, probeTimeoutMs: 50 });
    await assert.rejects(directories.resolve(), /no connection within 50ms/);
    assert.deepEqual(entries(silent), []);
});

test('the pool runs a real worker through the first base that connects', async (t) => {
    const refused = base(t, 'refused');
    const usable = base(t, 'usable');
    const socketDirectories = createToolWorkerSocketDirectories({ bases: () => [refused, usable], netApi: refusingNet([refused]) });
    const { pool, logs, loads } = fixturePool(t, { socketDirectories });
    const pending = echo(pool);
    const worker = [...pool.workers][0];
    const result = await pending;
    assert.equal(result.code, 0, `${result.stderr} ${JSON.stringify(logs)}`);
    assert.equal(JSON.parse(result.stdout).pid, worker.pid);
    assert.ok(worker.socketPath.startsWith(`${usable}${path.sep}ptw-`), worker.socketPath);
    assert.equal(loads().length, 1);
    assert.equal(pool.stats().degraded, false);
    assert.deepEqual(entries(refused), []);
    assert.deepEqual(entries(usable), [], 'the handshake directory is removed once the worker connected');
});

test('the PLOINKY_TOOL_WORKER_SOCKET_DIR override is used when it connects', async (t) => {
    const override = base(t, 'override');
    const previous = process.env.PLOINKY_TOOL_WORKER_SOCKET_DIR;
    process.env.PLOINKY_TOOL_WORKER_SOCKET_DIR = override;
    t.after(() => {
        if (previous === undefined) delete process.env.PLOINKY_TOOL_WORKER_SOCKET_DIR;
        else process.env.PLOINKY_TOOL_WORKER_SOCKET_DIR = previous;
    });
    const socketDirectories = createToolWorkerSocketDirectories();
    const { pool } = fixturePool(t, { socketDirectories });
    const pending = echo(pool);
    const worker = [...pool.workers][0];
    const result = await pending;
    assert.equal(result.code, 0, result.stderr);
    assert.ok(worker.socketPath.startsWith(`${override}${path.sep}ptw-`), worker.socketPath);
    assert.equal(socketDirectories.current(), override);
});

test('with no connectable base the pool degrades at once, logs one line and never starts a worker process', async (t) => {
    const refusedA = base(t, 'a');
    const refusedB = base(t, 'b');
    const netApi = refusingNet([refusedA, refusedB]);
    const socketDirectories = createToolWorkerSocketDirectories({ bases: () => [refusedA, refusedB], netApi });
    const { pool, logs, loads } = fixturePool(t, { socketDirectories, size: 3 });

    const results = await Promise.all([echo(pool, { fallback: okFallback }), echo(pool, { fallback: okFallback }), echo(pool, { fallback: okFallback })]);
    assert.deepEqual(results.map((result) => result.stdout), ['from-spawn-fallback', 'from-spawn-fallback', 'from-spawn-fallback']);
    assert.deepEqual(loads(), [], 'no worker process was started');
    const stats = pool.stats();
    assert.equal(stats.degraded, true);
    assert.equal(stats.workers, 0);
    assert.deepEqual(stats.pids, []);
    assert.equal(stats.crashes, 0);
    assert.equal(stats.fallbacks, 3);
    const unavailable = logs.filter((line) => line.includes('no directory where a tool worker socket can be connected'));
    assert.equal(unavailable.length, 1, JSON.stringify(logs));
    assert.match(unavailable[0], new RegExp(`tried ${refusedA} \\(connect EACCES\\), ${refusedB} \\(connect EACCES\\); degraded for 60000ms \\(spawn fallback\\)`));
    assert.ok(!logs.some((line) => /consecutive workers exited/.test(line)), 'no unproductive-death degradation on top');
    assert.equal(pool.unproductiveDeaths, 0, 'abandoned starts without a socket are not worker deaths');
    assert.equal(netApi.counts.connects, 2, 'one probe pass for all queued calls');

    // While degraded: fallback directly, no probe, no further log line.
    const later = await echo(pool, { fallback: okFallback });
    assert.equal(later.stdout, 'from-spawn-fallback');
    assert.equal(netApi.counts.connects, 2);
    assert.equal(logs.filter((line) => line.includes('no directory')).length, 1);
    const noFallback = await echo(pool);
    assert.notEqual(noFallback.code, 0);
    assert.match(noFallback.stderr, /degraded/);
});

test('when degradation ends the pool probes again and recovers once a base connects', async (t) => {
    const flaky = base(t, 'flaky');
    const refused = [flaky];
    const netApi = refusingNet(refused);
    const socketDirectories = createToolWorkerSocketDirectories({ bases: () => [flaky], netApi });
    let clock = Date.now();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twsd-work-'));
    const logs = [];
    const pool = new ToolWorkerPool('fixture', {
        command: process.execPath, args: [WORKER_FIXTURE], cwd: work, size: 1,
        env: { FIXTURE_LOADS_LOG: path.join(work, 'loads.log') },
        log: (line) => logs.push(line), now: () => clock, socketDirectories,
    });
    t.after(async () => {
        await pool.shutdown({ timeoutMs: 5000 });
        fs.rmSync(work, { recursive: true, force: true });
    });
    assert.equal((await echo(pool, { fallback: okFallback })).stdout, 'from-spawn-fallback');
    assert.equal(pool.isDegraded(), true);
    refused.length = 0; // The base becomes connectable.
    clock += 60_001;
    const recovered = await echo(pool, { fallback: okFallback });
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.notEqual(recovered.stdout, 'from-spawn-fallback');
    assert.equal(socketDirectories.current(), flaky);
});

test('shutdown while the socket base is being probed leaves no worker behind', async (t) => {
    const usable = base(t, 'usable');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const socketDirectories = {
        current: () => null,
        invalidate: () => {},
        resolve: () => gate.then(() => usable),
    };
    const { pool, loads } = fixturePool(t, { socketDirectories });
    const pending = echo(pool);
    assert.equal(pool.workers.size, 1);
    const stopped = pool.shutdown({ timeoutMs: 5000 });
    release();
    assert.match((await pending).stderr, /shutting down/);
    assert.deepEqual(await stopped, { clean: true });
    assert.equal(pool.workers.size, 0);
    assert.deepEqual(loads(), []);
    assert.deepEqual(entries(usable), []);
});

// A probe-passing base where every worker process exits before it connects
// (as with connect EACCES in toolWorker.mjs): the base must not be trusted
// across degradation cycles.
test('a worker that exits before connecting makes the pool re-probe, and degradation forgets the base', async (t) => {
    const usable = base(t, 'stale');
    const netApi = refusingNet([]);
    const socketDirectories = createToolWorkerSocketDirectories({ bases: () => [usable], netApi });
    let clock = Date.now();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twsd-work-'));
    const logs = [];
    const pool = new ToolWorkerPool('fixture', {
        command: process.execPath, args: [WORKER_FIXTURE], cwd: work, size: 1,
        env: { FIXTURE_LOADS_LOG: path.join(work, 'loads.log'), FIXTURE_DIE_BEFORE_READY: '1' },
        log: (line) => logs.push(line), now: () => clock, socketDirectories,
    });
    t.after(async () => {
        await pool.shutdown({ timeoutMs: 5000 });
        fs.rmSync(work, { recursive: true, force: true });
    });

    assert.equal((await echo(pool, { fallback: okFallback })).stdout, 'from-spawn-fallback');
    assert.equal(pool.isDegraded(), true);
    assert.equal(pool.stats().spawned, 3);
    assert.equal(netApi.counts.connects, 3, 'every spawn after a worker that never connected probed again');
    const reprobes = logs.filter((line) => line.includes(`worker exited before connecting to its socket under ${usable}`));
    assert.equal(reprobes.length, 3, JSON.stringify(logs));
    assert.equal(socketDirectories.current(), null, 'degradation forgets the remembered base');

    clock += 60_001;
    assert.equal((await echo(pool, { fallback: okFallback })).stdout, 'from-spawn-fallback');
    assert.equal(netApi.counts.connects, 6, 'the next window probes again from the start');
    assert.equal(pool.stats().spawned, 6);
});

test('a worker that connected and later goes away never makes the pool re-probe', async (t) => {
    const usable = base(t, 'steady');
    const netApi = refusingNet([]);
    const socketDirectories = createToolWorkerSocketDirectories({ bases: () => [usable], netApi });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twsd-work-'));
    const logs = [];
    const pool = new ToolWorkerPool('fixture', {
        command: process.execPath, args: [WORKER_FIXTURE], cwd: work, size: 1, maxCallsPerWorker: 1,
        env: { FIXTURE_LOADS_LOG: path.join(work, 'loads.log') },
        log: (line) => logs.push(line), socketDirectories,
    });
    t.after(async () => {
        await pool.shutdown({ timeoutMs: 5000 });
        fs.rmSync(work, { recursive: true, force: true });
    });
    for (let index = 0; index < 3; index += 1) {
        const result = await echo(pool);
        assert.equal(result.code, 0, result.stderr);
    }
    assert.ok(pool.stats().spawned >= 3, 'each call recycled its worker');
    assert.equal(netApi.counts.connects, 1);
    assert.equal(socketDirectories.current(), usable);
    assert.ok(!logs.some((line) => line.includes('probing socket directories again')), JSON.stringify(logs));
});

// A directories object that records what the pool asks of it.
function countingDirectories(initial, good) {
    let remembered = initial;
    const calls = { invalidate: [], resolve: 0 };
    return {
        calls,
        current: () => remembered,
        invalidate(entry) {
            calls.invalidate.push(entry);
            if (remembered === entry) remembered = null;
        },
        resolve() {
            calls.resolve += 1;
            remembered = good;
            return Promise.resolve(good);
        },
    };
}

test('a mkdtemp failure under the remembered base invalidates it and the next spawn re-probes', async (t) => {
    const good = base(t, 'good');
    const vanished = path.join(good, 'vanished');
    const directories = countingDirectories(vanished, good);
    const { pool, logs } = fixturePool(t, { socketDirectories: directories });
    const result = await echo(pool);
    assert.equal(result.code, 0, `${result.stderr} ${JSON.stringify(logs)}`);
    assert.deepEqual(directories.calls.invalidate, [vanished]);
    assert.equal(directories.calls.resolve, 1);
    assert.equal(directories.current(), good);
    assert.ok(logs.some((line) => /cannot create a worker socket: .*ENOENT/.test(line)), JSON.stringify(logs));
});

test('a listen error under the remembered base invalidates it and the next spawn re-probes', async (t) => {
    const good = base(t, 'good');
    const directories = countingDirectories(good, good);
    let failures = 1;
    const netApi = {
        createServer: (...args) => {
            const server = net.createServer(...args);
            if (failures > 0) {
                failures -= 1;
                server.listen = () => {
                    setImmediate(() => server.emit('error', Object.assign(new Error('listen EACCES'), { code: 'EACCES' })));
                    return server;
                };
            }
            return server;
        },
        createConnection: (...args) => net.createConnection(...args),
    };
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twsd-work-'));
    const logs = [];
    const pool = new ToolWorkerPool('fixture', {
        command: process.execPath, args: [WORKER_FIXTURE], cwd: work, size: 1,
        env: { FIXTURE_LOADS_LOG: path.join(work, 'loads.log') },
        log: (line) => logs.push(line), socketDirectories: directories, netApi,
    });
    t.after(async () => {
        await pool.shutdown({ timeoutMs: 5000 });
        fs.rmSync(work, { recursive: true, force: true });
    });
    const result = await echo(pool);
    assert.equal(result.code, 0, `${result.stderr} ${JSON.stringify(logs)}`);
    assert.deepEqual(directories.calls.invalidate, [good]);
    assert.equal(directories.calls.resolve, 1);
    assert.ok(logs.some((line) => /worker socket error: listen EACCES/.test(line)), JSON.stringify(logs));
    assert.deepEqual(entries(good), [], 'the failed socket directory is removed');
});

test('degradation by workers that connected but died before a call also forgets the remembered base', async (t) => {
    const usable = base(t, 'connected');
    const netApi = refusingNet([]);
    const socketDirectories = createToolWorkerSocketDirectories({ bases: () => [usable], netApi });
    let clock = Date.now();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'twsd-work-'));
    const logs = [];
    const pool = new ToolWorkerPool('fixture', {
        command: process.execPath, args: [WORKER_FIXTURE], cwd: work, size: 1,
        env: { FIXTURE_LOADS_LOG: path.join(work, 'loads.log'), FIXTURE_THROW_AFTER_READY: '1' },
        log: (line) => logs.push(line), now: () => clock, socketDirectories,
    });
    t.after(async () => {
        await pool.shutdown({ timeoutMs: 5000 });
        fs.rmSync(work, { recursive: true, force: true });
    });
    for (let attempt = 0; attempt < 3 && !pool.isDegraded(); attempt += 1) {
        await echo(pool, { fallback: okFallback });
    }
    assert.equal(pool.isDegraded(), true, JSON.stringify(logs));
    assert.equal(pool.stats().spawned, 3);
    assert.equal(netApi.counts.connects, 1, 'workers that connected never forced a re-probe');
    assert.ok(!logs.some((line) => line.includes('probing socket directories again')), JSON.stringify(logs));
    assert.equal(socketDirectories.current(), null, 'degradation forgets the remembered base');
    clock += 60_001;
    await echo(pool, { fallback: okFallback });
    assert.equal(netApi.counts.connects, 2, 'the next window probes again');
});
