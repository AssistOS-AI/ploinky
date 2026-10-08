// Code identity for warm tool workers (Agent/server/toolCodeIdentity.mjs and
// the thread that walks it, toolCodeIdentityThread.mjs). I1 drives a real
// pool; the other tests call the identity directly with an injected clock (on
// the thread, a clock offset), so freshly written fixture files are not racy
// unless a test says so. I1-I9 run on the main thread and, as "(thread)"
// variants, through the identity thread; I8b injects fs calls and runs on the
// main thread only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
    agentServerIdentityInputs,
    createCodeIdentity,
    createAgentServerCodeIdentity,
    formatIdentityMeasures,
} from '../../Agent/server/toolCodeIdentity.mjs';
import { createCodeIdentityThread, createAgentServerCodeIdentityThread } from '../../Agent/server/toolCodeIdentityThread.mjs';
import { createToolWorkerPools, shutdownToolWorkerPools } from '../../Agent/server/toolWorkerPool.mjs';

const LATER_MS = 60_000;
const later = () => Date.now() + LATER_MS;
const MODES = ['sync', 'thread'];
const THREAD_FIXTURE = new URL('../fixtures/toolCodeIdentityThreadFixture.mjs', import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sync variants keep their original names; thread variants add "(thread)".
function named(mode, name) {
    return mode === 'sync' ? name : name.replace(/^(I\d+b?):/, '$1 (thread):');
}

// An async identity read in the given mode. On the thread, the `later` clock
// becomes the same offset.
function makeIdentity(t, mode, { now, ...options }) {
    if (mode === 'sync') {
        const identity = createCodeIdentity({ ...options, ...(now ? { now } : {}) });
        return async (...args) => identity(...args);
    }
    assert.ok(now === undefined || now === later, 'the thread supports only the `later` clock');
    const client = createCodeIdentityThread({ ...options, clockOffsetMs: now === later ? LATER_MS : 0 });
    t.after(() => client.terminate());
    return async (...args) => (await client.read(...args)).identity;
}

function makeAgentServerIdentity(t, mode, { now, ...options }) {
    if (mode === 'sync') {
        const identity = createAgentServerCodeIdentity({ ...options, ...(now ? { now } : {}) });
        return async (poolName) => identity(poolName);
    }
    assert.ok(now === undefined || now === later, 'the thread supports only the `later` clock');
    const thread = createAgentServerCodeIdentityThread({ ...options, clockOffsetMs: now === later ? LATER_MS : 0 });
    t.after(() => thread.terminate());
    return async (poolName) => (await thread.codeIdentity(poolName)).identity;
}

function tempDir(t, prefix = 'tool-code-identity-') {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

function agentTree(t) {
    const root = tempDir(t);
    write(path.join(root, 'tools', 'tool.mjs'), 'export const a = 1;\n');
    write(path.join(root, 'lib', 'util.mjs'), 'export const b = 2;\n');
    write(path.join(root, 'shared', 'vendor', 'pkg', 'index.mjs'), 'export const v = 1;\n');
    write(path.join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    write(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(path.join(root, 'mcp-config.json'), '{}');
    return root;
}

function stagedTree(t) {
    const base = tempDir(t);
    const real = path.join(base, 'real');
    const staged = path.join(base, 'staged');
    write(path.join(real, 'tools', 'tool.mjs'), 'import "../lib.mjs";\n');
    write(path.join(real, 'lib.mjs'), 'export const x = 1;\n');
    fs.mkdirSync(staged);
    // The Podman staging layout: one symlink per top-level source entry.
    for (const name of fs.readdirSync(real)) fs.symlinkSync(path.join(real, name), path.join(staged, name));
    return { real, staged };
}

for (const mode of MODES) {
    test(named(mode, 'I2: an in-place edit of a file changes the identity'), async (t) => {
        const root = agentTree(t);
        const identity = makeIdentity(t, mode, { roots: [root], now: later });
        const before = await identity();
        assert.equal(await identity(), before, 'stable while nothing changes');
        fs.writeFileSync(path.join(root, 'lib', 'util.mjs'), 'export const b = 3333;\n');
        assert.notEqual(await identity(), before);
    });

    test(named(mode, 'I2b: a same-size in-place rewrite with the old mtime restored still changes the identity (ctime)'), async (t) => {
        const root = agentTree(t);
        const file = path.join(root, 'lib', 'util.mjs');
        // Whole seconds, so utimes can restore the exact same mtimeNs.
        const pinned = Math.floor(Date.now() / 1000) - 30;
        fs.utimesSync(file, pinned, pinned);
        const original = fs.statSync(file, { bigint: true });
        const identity = makeIdentity(t, mode, { roots: [root], now: later });
        const before = await identity();
        const until = Date.now() + 20;
        while (Date.now() < until) { /* let the clock move so the rewrite gets a new ctime */ }
        fs.writeFileSync(file, 'export const b = 9;\n');
        fs.utimesSync(file, pinned, pinned);
        const after = fs.statSync(file, { bigint: true });
        assert.equal(after.size, original.size);
        assert.equal(after.mtimeNs, original.mtimeNs);
        assert.equal(after.ino, original.ino);
        assert.notEqual(after.ctimeNs, original.ctimeNs);
        assert.notEqual(await identity(), before);
    });

    test(named(mode, 'I3: an atomic replace (write and rename) changes the identity'), async (t) => {
        const root = agentTree(t);
        const identity = makeIdentity(t, mode, { roots: [root], now: later });
        const before = await identity();
        const target = path.join(root, 'tools', 'tool.mjs');
        write(`${target}.tmp`, 'export const a = 1;\n');
        fs.renameSync(`${target}.tmp`, target);
        assert.notEqual(await identity(), before);
    });

    test(named(mode, 'I4: adding, deleting and renaming entries change the identity'), async (t) => {
        const root = agentTree(t);
        const identity = makeIdentity(t, mode, { roots: [root], now: later });
        const states = [await identity()];
        write(path.join(root, 'lib', 'deep', 'new.mjs'), 'export {};\n');
        states.push(await identity());
        fs.renameSync(path.join(root, 'lib', 'deep', 'new.mjs'), path.join(root, 'lib', 'deep', 'renamed.mjs'));
        states.push(await identity());
        fs.rmSync(path.join(root, 'lib', 'deep', 'renamed.mjs'));
        states.push(await identity());
        assert.equal(new Set(states).size, 4, 'each change produced a new identity');
    });

    test(named(mode, 'I5: edits behind the symlinks of a staged root change the identity'), async (t) => {
        const { real, staged } = stagedTree(t);
        const identity = makeIdentity(t, mode, { roots: [staged], now: later });
        const before = await identity();
        fs.writeFileSync(path.join(real, 'tools', 'tool.mjs'), 'import "../lib.mjs"; // edited\n');
        assert.notEqual(await identity(), before);
    });

    test(named(mode, 'I5b: a top-level file added to the real source behind a staged root is stamped, and so are its edits'), async (t) => {
        const { real, staged } = stagedTree(t);
        const identity = makeIdentity(t, mode, { roots: [staged], now: later });
        const before = await identity();
        write(path.join(real, 'lib2.mjs'), 'export const y = 1;\n');
        const added = await identity();
        assert.notEqual(added, before, 'a new top-level source file is part of the identity');
        fs.writeFileSync(path.join(real, 'lib2.mjs'), 'export const y = 22;\n');
        assert.notEqual(await identity(), added, 'an in-place edit of the new file changes the identity');
    });

    test(named(mode, 'I6: each step of a multi-file update has its own identity'), async (t) => {
        const root = agentTree(t);
        const identity = makeIdentity(t, mode, { roots: [root], now: later });
        const start = await identity();
        fs.writeFileSync(path.join(root, 'tools', 'tool.mjs'), 'export const a = 10;\n');
        const half = await identity();
        fs.writeFileSync(path.join(root, 'lib', 'util.mjs'), 'export const b = 20;\n');
        const done = await identity();
        assert.equal(new Set([start, half, done]).size, 3);
    });

    test(named(mode, 'I7: exclusions by name, dependency and generation sentinels'), async (t) => {
        const root = agentTree(t);
        const topology = path.join(tempDir(t), 'current.json');
        write(topology, '{"g":1}');
        const agentLib = tempDir(t);
        write(path.join(agentLib, 'lib', 'toolWorker.mjs'), 'export {};\n');
        const identity = makeAgentServerIdentity(t, mode, {
            codeDir: root,
            agentLibRoot: agentLib,
            env: { PLOINKY_EDGE_TOPOLOGY_FILE: topology },
            now: later,
        });
        let current = await identity('none');
        const changes = async (label, mutate, expectChange) => {
            mutate();
            const next = await identity('none');
            if (expectChange) assert.notEqual(next, current, `${label} should change the identity`);
            else assert.equal(next, current, `${label} should not change the identity`);
            current = next;
        };
        await changes('a write under .git/', () => write(path.join(root, '.git', 'index'), 'x'), false);
        await changes('a write inside node_modules/dep', () => fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 2;\n'), false);
        await changes('a write under shared/vendor/', () => fs.writeFileSync(path.join(root, 'shared', 'vendor', 'pkg', 'index.mjs'), 'export const v = 22;\n'), true);
        await changes('node_modules/.package-lock.json', () => write(path.join(root, 'node_modules', '.package-lock.json'), '{}'), true);
        await changes('a new edge generation', () => {
            write(`${topology}.next`, '{"g":2}');
            fs.renameSync(`${topology}.next`, topology);
        }, true);
        await changes('an Agent library edit', () => fs.writeFileSync(path.join(agentLib, 'lib', 'toolWorker.mjs'), 'export const z = 1;\n'), true);
    });

    test(named(mode, 'I7b: a non-image AgentLib grant is walked; an image grant is not'), async (t) => {
        const root = agentTree(t);
        const agentLib = tempDir(t);
        const lib = tempDir(t);
        write(path.join(lib, 'index.mjs'), 'export {};\n');
        const local = makeAgentServerIdentity(t, mode, { codeDir: root, agentLibRoot: agentLib, env: { PLOINKY_AGENTLIB_DIR: lib, PLOINKY_AGENTLIB_MODE: 'local' }, now: later });
        const image = makeAgentServerIdentity(t, mode, { codeDir: root, agentLibRoot: agentLib, env: { PLOINKY_AGENTLIB_DIR: lib, PLOINKY_AGENTLIB_MODE: 'image' }, now: later });
        const [localBefore, imageBefore] = [await local('p'), await image('p')];
        fs.writeFileSync(path.join(lib, 'index.mjs'), 'export const changed = 1;\n');
        assert.notEqual(await local('p'), localBefore);
        assert.equal(await image('p'), imageBefore);
    });

    test(named(mode, 'I8: a file added to a directory is seen on the next read (listing validated by the directory stamp)'), async (t) => {
        const root = agentTree(t);
        const identity = makeIdentity(t, mode, { roots: [root], now: later });
        const before = await identity();
        write(path.join(root, 'tools', 'second.mjs'), 'export {};\n');
        const after = await identity();
        assert.notEqual(after, before);
        assert.equal(after, await makeIdentity(t, mode, { roots: [root], now: later })(), 'cached listings match a fresh walk');
    });
}

test('I8b: a listing read while its directory stamp is racy is not reused after the stamp settles', (t) => {
    const root = agentTree(t);
    const tools = path.join(root, 'tools');
    const frozen = { mtimeNs: BigInt(Date.now()) * 1_000_000n };
    // The directory keeps the same stamp across the add (a coarse timestamp tick).
    const fixedStat = fs.statSync(tools, { bigint: true });
    const fsApi = {
        ...fs,
        statSync(p, options) {
            const stat = fs.statSync(p, options);
            if (p !== tools) return stat;
            return Object.assign(Object.create(Object.getPrototypeOf(fixedStat)), fixedStat, {
                mtimeNs: frozen.mtimeNs, ctimeNs: frozen.mtimeNs,
            });
        },
    };
    let clock = Number(frozen.mtimeNs / 1_000_000n) + 500;
    const identity = createCodeIdentity({ roots: [root], now: () => clock, fsApi });
    assert.throws(() => identity(), /changed less than 2000 ms ago/, 'the racy directory stamp makes the read throw');
    write(path.join(tools, 'late.mjs'), 'export {};\n');
    clock += 60_000;
    const settled = identity();
    const fresh = createCodeIdentity({ roots: [root], now: () => clock, fsApi })();
    assert.equal(settled, fresh, 'the entry added in the same tick is part of the identity');
});

for (const mode of MODES) {
    test(named(mode, 'I9: the racy guard, future stamps, symlink cycles and the entry limit'), async (t) => {
        const root = agentTree(t);
        const read = (options) => makeIdentity(t, mode, options)();
        await assert.rejects(read({ roots: [root] }), /changed less than 2000 ms ago/, 'just-written code is racy');
        assert.equal(typeof await read({ roots: [root], now: later }), 'string');
        assert.equal(typeof await read({ roots: [root], settleMs: 0 }), 'string');

        const future = new Date(Date.now() + 3_600_000);
        fs.utimesSync(path.join(root, 'lib', 'util.mjs'), future, future);
        await assert.rejects(read({ roots: [root], now: later }), /changed less than/, 'a future mtime is racy');
        fs.rmSync(path.join(root, 'lib', 'util.mjs'));

        fs.symlinkSync('..', path.join(root, 'lib', 'loop'));
        assert.equal(typeof await read({ roots: [root], now: later }), 'string', 'a symlink cycle terminates');
        fs.symlinkSync(path.join(root, 'missing-target'), path.join(root, 'lib', 'dangling'));
        assert.equal(typeof await read({ roots: [root], now: later }), 'string', 'a dangling symlink is stamped');

        await assert.rejects(read({ roots: [root], now: later, maxEntries: 3 }), /exceeds 3 entries/);
        await assert.rejects(read({ roots: [path.join(root, 'nope')], now: later }), /ENOENT/);
    });
}

test('onMeasure observes every root and the fixed files without changing the identity', (t) => {
    const root = agentTree(t);
    const other = agentTree(t);
    const extra = path.join(root, 'mcp-config.json');
    const measures = [];
    const plain = createCodeIdentity({ roots: [root, other], extraFiles: [extra], now: later })();
    const measured = createCodeIdentity({ roots: [root, other], extraFiles: [extra], now: later, onMeasure: (m) => measures.push(m) })();
    assert.equal(measured, plain);
    assert.deepEqual(measures.map((m) => m.index), [0, 1, -1]);
    assert.deepEqual(measures.map((m) => m.root), [root, other, 'files']);
    for (const m of measures) assert.ok(Number.isFinite(m.ms) && m.ms >= 0 && m.entries > 0, JSON.stringify(m));
    assert.equal(measures[0].entries, measures[1].entries, 'two identical trees have the same entry count');
    assert.equal(measures[2].entries, 1);
    const throwing = createCodeIdentity({ roots: [root, other], extraFiles: [extra], now: later, onMeasure: () => { throw new Error('observer'); } });
    assert.equal(throwing(), plain, 'a throwing observer never changes the identity');
});

// I1: a real pool with the real identity. The worker and the spawn fallback
// both load lib/answer.mjs; the original worker stays alive (long idle
// timeout, many calls allowed), so only the identity can retire it.
function runFallback(cli, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, signal: null, stdout, stderr }));
    });
}

for (const [mode, settleMs] of MODES.flatMap((m) => [[m, 2000], [m, 0]])) {
    const prefix = mode === 'sync' ? 'I1 (' : 'I1 (thread, ';
    test(`${prefix}settleMs ${settleMs}): an in-place code edit retires the warm worker; no call is served stale code`, async (t) => {
        const code = tempDir(t);
        write(path.join(code, 'lib', 'answer.mjs'), "export const answer = 'v1';\n");
        write(path.join(code, 'worker.mjs'), [
            "import { pathToFileURL } from 'node:url';",
            "import { answer } from './lib/answer.mjs';",
            'const { serveToolWorker } = await import(pathToFileURL(process.env.PLOINKY_TOOL_WORKER_MODULE).href);',
            "await serveToolWorker(({ stdout }) => { stdout.write(`worker:${answer}:${process.pid}`); return 0; });",
        ].join('\n'));
        write(path.join(code, 'cli.mjs'), "import { answer } from './lib/answer.mjs';\nprocess.stdout.write(`spawn:${answer}`);\n");
        const settle = () => new Promise((resolve) => setTimeout(resolve, settleMs + 150));
        if (settleMs) await settle();

        // The sync variant keeps a synchronous hook; the thread variant's resolves.
        const identity = mode === 'sync'
            ? createCodeIdentity({ roots: [code], settleMs })
            : makeIdentity(t, mode, { roots: [code], settleMs });
        const pools = createToolWorkerPools({
            toolWorkers: {
                fx: {
                    command: process.execPath, args: [path.join(code, 'worker.mjs')], cwd: code,
                    size: 1, idleTimeoutMs: 600_000, maxCallsPerWorker: 10_000,
                },
            },
        }, {
            buildCommandSpec: (entry) => ({ command: entry.command, args: entry.args, cwd: entry.cwd, env: {} }),
            log: () => {},
            codeIdentity: () => identity(),
        });
        t.after(() => shutdownToolWorkerPools({ pools, timeoutMs: 5000 }));
        const pool = pools.get('fx');
        const call = async () => (await pool.call({
            toolName: 'answer', payload: { tool: 'answer' }, fallback: () => runFallback(path.join(code, 'cli.mjs'), code),
        })).stdout;

        const first = await call();
        assert.match(first, /^worker:v1:\d+$/);
        const originalPid = Number(first.split(':')[2]);
        assert.equal(await call(), first, 'an unchanged tree reuses the worker');
        const recycledBefore = pool.stats().recycled;

        fs.writeFileSync(path.join(code, 'lib', 'answer.mjs'), "export const answer = 'v2';\n");
        if (settleMs) {
            assert.equal(await call(), 'spawn:v2', 'inside the racy window the call runs as a fresh process');
            await settle();
            process.kill(originalPid, 0); // the original worker is still alive at settleMs + 150 ms
        }
        const after = await call();
        assert.match(after, /^worker:v2:\d+$/, 'the warm worker never serves the old code');
        assert.notEqual(Number(after.split(':')[2]), originalPid);
        assert.ok(pool.stats().recycled > recycledBefore, 'the old worker was recycled for the identity change');
    });
}

// AC6: same inputs, same stamped entries, same hash on both threads; the
// per-pool command file travels with the request and is stamped by the thread.
test('AC6: the identity thread returns the main-thread hash and entry counts, including the pool command file', async (t) => {
    const root = agentTree(t);
    const agentLib = tempDir(t);
    write(path.join(agentLib, 'lib', 'toolWorker.mjs'), 'export {};\n');
    const lib = tempDir(t);
    write(path.join(lib, 'index.mjs'), 'export {};\n');
    const outside = tempDir(t);
    const command = path.join(outside, 'bin', 'tool-runner');
    write(command, '#!/bin/sh\n');
    const topology = path.join(outside, 'current.json');
    write(topology, '{"g":1}');
    const configPath = path.join(outside, 'mcp-config.json');
    write(configPath, '{}');
    const inputs = {
        codeDir: root,
        agentLibRoot: agentLib,
        configPath,
        manifestPath: path.join(outside, 'missing-manifest.json'),
        env: { PLOINKY_AGENTLIB_DIR: lib, PLOINKY_EDGE_TOPOLOGY_FILE: topology },
        poolCommand: (poolName) => (poolName === 'fx' ? command : 'relative-command'),
    };
    const { labels } = agentServerIdentityInputs(inputs);
    assert.deepEqual(labels, ['code', 'agent', 'agentlib']);
    let measures = [];
    const syncIdentity = createAgentServerCodeIdentity({ ...inputs, now: later, onMeasure: (m) => measures.push(m) });
    const sync = (poolName) => {
        measures = [];
        const identity = syncIdentity(poolName);
        return { identity, roots: formatIdentityMeasures(measures, labels) };
    };
    const thread = createAgentServerCodeIdentityThread({ ...inputs, clockOffsetMs: LATER_MS });
    t.after(() => thread.terminate());
    const entries = (roots) => roots.split(',').map((part) => `${part.split(':')[0]}/${part.split('/')[1]}`);

    const syncFx = sync('fx');
    const threadFx = await thread.codeIdentity('fx');
    assert.equal(threadFx.identity, syncFx.identity);
    assert.deepEqual(entries(threadFx.roots), entries(syncFx.roots));
    assert.deepEqual(entries(syncFx.roots).map((e) => e.split('/')[0]), ['code', 'agent', 'agentlib', 'files']);
    const syncOther = sync('other');
    assert.notEqual(syncOther.identity, syncFx.identity, 'the absolute pool command file is part of the identity');
    assert.equal(Number(entries(syncFx.roots)[3].split('/')[1]), Number(entries(syncOther.roots)[3].split('/')[1]) + 1);
    assert.equal((await thread.codeIdentity('other')).identity, syncOther.identity);

    fs.writeFileSync(command, '#!/bin/sh\necho changed\n');
    const syncAfter = sync('fx');
    assert.notEqual(syncAfter.identity, syncFx.identity, 'an edit of the pool command file changes the identity');
    assert.equal((await thread.codeIdentity('fx')).identity, syncAfter.identity, 'the thread stamps the command file it was sent');
});

test('F2: every thread request carries the pool name and its resolved command', async (t) => {
    const thread = createAgentServerCodeIdentityThread({
        codeDir: 'echo',
        agentLibRoot: '/agent-lib',
        env: {},
        poolCommand: (poolName) => (poolName === 'fx' ? '/opt/tools/run' : 'node'),
        threadUrl: THREAD_FIXTURE,
    });
    t.after(() => thread.terminate());
    const echo = (identity) => JSON.parse(identity.slice(identity.indexOf(':') + 1));
    assert.deepEqual(echo((await thread.codeIdentity('fx')).identity), { poolName: 'fx', command: '/opt/tools/run', extraFiles: ['/opt/tools/run'] });
    assert.deepEqual(echo((await thread.codeIdentity('rel')).identity), { poolName: 'rel', command: 'node', extraFiles: [] });
});

test('F1 (thread): a stalled request times out, the thread is replaced, and replies for other ids are dropped', async (t) => {
    const client = createCodeIdentityThread({ roots: ['stall'], threadUrl: THREAD_FIXTURE, timeoutMs: 500 });
    t.after(() => client.terminate());
    await assert.rejects(client.read(), /identity thread did not answer within 500ms/);
    assert.equal(client.stats().timeouts, 1);
    assert.equal(client.stats().running, false, 'the stalled thread was terminated');
    // The new thread first replies with request 1's id; that reply is dropped.
    assert.match((await client.read()).identity, /^fresh-2:/);
    assert.equal(client.stats().spawned, 2);
    assert.equal(client.stats().dropped, 1);
    await sleep(1100); // past the moment the stalled thread would have replied
    assert.match((await client.read()).identity, /^fresh-3:/);
    assert.equal(client.stats().dropped, 2);
    assert.equal(client.stats().pending, 0);
});

for (const [behaviour, pattern] of [['exit', /identity thread exited \(code 3\)/], ['throw', /identity thread failed: thread boom/]]) {
    test(`F1 (thread): a thread that fails (${behaviour}) rejects its request and the next request gets a new thread`, async (t) => {
        const client = createCodeIdentityThread({ roots: [behaviour], threadUrl: THREAD_FIXTURE, timeoutMs: 5000 });
        t.after(() => client.terminate());
        await assert.rejects(client.read(), pattern);
        assert.equal(client.stats().crashes, 1);
        assert.match((await client.read()).identity, /^fresh-2:/);
        assert.equal(client.stats().spawned, 2);
    });
}

test('identity thread: start is eager, terminate is idempotent and safe before start, later reads reject', async (t) => {
    const root = agentTree(t);
    const idle = createCodeIdentityThread({ roots: [root] });
    await idle.terminate();
    await idle.terminate();
    assert.equal(idle.stats().spawned, 0);
    await assert.rejects(idle.read(), /identity thread is closed/);

    const client = createCodeIdentityThread({ roots: [root], clockOffsetMs: LATER_MS });
    t.after(() => client.terminate());
    client.start();
    assert.deepEqual([client.stats().spawned, client.stats().running], [1, true]);
    assert.equal((await client.read()).identity, createCodeIdentity({ roots: [root], now: later })());
    assert.equal(client.stats().spawned, 1, 'the started thread served the read');
    await client.terminate();
    await client.terminate();
    await assert.rejects(client.read(), /identity thread is closed/);
});
