// Code identity for warm tool workers (Agent/server/toolCodeIdentity.mjs).
// I1 drives a real pool; the other tests call the identity directly with an
// injected clock, so freshly written fixture files are not racy unless a test
// says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createCodeIdentity, createAgentServerCodeIdentity } from '../../Agent/server/toolCodeIdentity.mjs';
import { createToolWorkerPools, shutdownToolWorkerPools } from '../../Agent/server/toolWorkerPool.mjs';

const later = () => Date.now() + 60_000;

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

test('I2: an in-place edit of a file changes the identity', (t) => {
    const root = agentTree(t);
    const identity = createCodeIdentity({ roots: [root], now: later });
    const before = identity();
    assert.equal(identity(), before, 'stable while nothing changes');
    fs.writeFileSync(path.join(root, 'lib', 'util.mjs'), 'export const b = 3333;\n');
    assert.notEqual(identity(), before);
});

test('I2b: a same-size in-place rewrite with the old mtime restored still changes the identity (ctime)', (t) => {
    const root = agentTree(t);
    const file = path.join(root, 'lib', 'util.mjs');
    // Whole seconds, so utimes can restore the exact same mtimeNs.
    const pinned = Math.floor(Date.now() / 1000) - 30;
    fs.utimesSync(file, pinned, pinned);
    const original = fs.statSync(file, { bigint: true });
    const identity = createCodeIdentity({ roots: [root], now: later });
    const before = identity();
    const until = Date.now() + 20;
    while (Date.now() < until) { /* let the clock move so the rewrite gets a new ctime */ }
    fs.writeFileSync(file, 'export const b = 9;\n');
    fs.utimesSync(file, pinned, pinned);
    const after = fs.statSync(file, { bigint: true });
    assert.equal(after.size, original.size);
    assert.equal(after.mtimeNs, original.mtimeNs);
    assert.equal(after.ino, original.ino);
    assert.notEqual(after.ctimeNs, original.ctimeNs);
    assert.notEqual(identity(), before);
});

test('I3: an atomic replace (write and rename) changes the identity', (t) => {
    const root = agentTree(t);
    const identity = createCodeIdentity({ roots: [root], now: later });
    const before = identity();
    const target = path.join(root, 'tools', 'tool.mjs');
    write(`${target}.tmp`, 'export const a = 1;\n');
    fs.renameSync(`${target}.tmp`, target);
    assert.notEqual(identity(), before);
});

test('I4: adding, deleting and renaming entries change the identity', (t) => {
    const root = agentTree(t);
    const identity = createCodeIdentity({ roots: [root], now: later });
    const states = [identity()];
    write(path.join(root, 'lib', 'deep', 'new.mjs'), 'export {};\n');
    states.push(identity());
    fs.renameSync(path.join(root, 'lib', 'deep', 'new.mjs'), path.join(root, 'lib', 'deep', 'renamed.mjs'));
    states.push(identity());
    fs.rmSync(path.join(root, 'lib', 'deep', 'renamed.mjs'));
    states.push(identity());
    assert.equal(new Set(states).size, 4, 'each change produced a new identity');
});

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

test('I5: edits behind the symlinks of a staged root change the identity', (t) => {
    const { real, staged } = stagedTree(t);
    const identity = createCodeIdentity({ roots: [staged], now: later });
    const before = identity();
    fs.writeFileSync(path.join(real, 'tools', 'tool.mjs'), 'import "../lib.mjs"; // edited\n');
    assert.notEqual(identity(), before);
});

test('I5b: a top-level file added to the real source behind a staged root is stamped, and so are its edits', (t) => {
    const { real, staged } = stagedTree(t);
    const identity = createCodeIdentity({ roots: [staged], now: later });
    const before = identity();
    write(path.join(real, 'lib2.mjs'), 'export const y = 1;\n');
    const added = identity();
    assert.notEqual(added, before, 'a new top-level source file is part of the identity');
    fs.writeFileSync(path.join(real, 'lib2.mjs'), 'export const y = 22;\n');
    assert.notEqual(identity(), added, 'an in-place edit of the new file changes the identity');
});

test('I6: each step of a multi-file update has its own identity', (t) => {
    const root = agentTree(t);
    const identity = createCodeIdentity({ roots: [root], now: later });
    const start = identity();
    fs.writeFileSync(path.join(root, 'tools', 'tool.mjs'), 'export const a = 10;\n');
    const half = identity();
    fs.writeFileSync(path.join(root, 'lib', 'util.mjs'), 'export const b = 20;\n');
    const done = identity();
    assert.equal(new Set([start, half, done]).size, 3);
});

test('I7: exclusions by name, dependency and generation sentinels', (t) => {
    const root = agentTree(t);
    const topology = path.join(tempDir(t), 'current.json');
    write(topology, '{"g":1}');
    const agentLib = tempDir(t);
    write(path.join(agentLib, 'lib', 'toolWorker.mjs'), 'export {};\n');
    const identity = createAgentServerCodeIdentity({
        codeDir: root,
        agentLibRoot: agentLib,
        env: { PLOINKY_EDGE_TOPOLOGY_FILE: topology },
        now: later,
    });
    let current = identity('none');
    const changes = (label, mutate, expectChange) => {
        mutate();
        const next = identity('none');
        if (expectChange) assert.notEqual(next, current, `${label} should change the identity`);
        else assert.equal(next, current, `${label} should not change the identity`);
        current = next;
    };
    changes('a write under .git/', () => write(path.join(root, '.git', 'index'), 'x'), false);
    changes('a write inside node_modules/dep', () => fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 2;\n'), false);
    changes('a write under shared/vendor/', () => fs.writeFileSync(path.join(root, 'shared', 'vendor', 'pkg', 'index.mjs'), 'export const v = 22;\n'), true);
    changes('node_modules/.package-lock.json', () => write(path.join(root, 'node_modules', '.package-lock.json'), '{}'), true);
    changes('a new edge generation', () => {
        write(`${topology}.next`, '{"g":2}');
        fs.renameSync(`${topology}.next`, topology);
    }, true);
    changes('an Agent library edit', () => fs.writeFileSync(path.join(agentLib, 'lib', 'toolWorker.mjs'), 'export const z = 1;\n'), true);
});

test('I7b: a non-image AgentLib grant is walked; an image grant is not', (t) => {
    const root = agentTree(t);
    const agentLib = tempDir(t);
    const lib = tempDir(t);
    write(path.join(lib, 'index.mjs'), 'export {};\n');
    const local = createAgentServerCodeIdentity({ codeDir: root, agentLibRoot: agentLib, env: { PLOINKY_AGENTLIB_DIR: lib, PLOINKY_AGENTLIB_MODE: 'local' }, now: later });
    const image = createAgentServerCodeIdentity({ codeDir: root, agentLibRoot: agentLib, env: { PLOINKY_AGENTLIB_DIR: lib, PLOINKY_AGENTLIB_MODE: 'image' }, now: later });
    const [localBefore, imageBefore] = [local('p'), image('p')];
    fs.writeFileSync(path.join(lib, 'index.mjs'), 'export const changed = 1;\n');
    assert.notEqual(local('p'), localBefore);
    assert.equal(image('p'), imageBefore);
});

test('I8: a file added to a directory is seen on the next read (listing validated by the directory stamp)', (t) => {
    const root = agentTree(t);
    const identity = createCodeIdentity({ roots: [root], now: later });
    const before = identity();
    write(path.join(root, 'tools', 'second.mjs'), 'export {};\n');
    const after = identity();
    assert.notEqual(after, before);
    assert.equal(after, createCodeIdentity({ roots: [root], now: later })(), 'cached listings match a fresh walk');
});

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

test('I9: the racy guard, future stamps, symlink cycles and the entry limit', (t) => {
    const root = agentTree(t);
    assert.throws(() => createCodeIdentity({ roots: [root] })(), /changed less than 2000 ms ago/, 'just-written code is racy');
    assert.equal(typeof createCodeIdentity({ roots: [root], now: later })(), 'string');
    assert.equal(typeof createCodeIdentity({ roots: [root], settleMs: 0 })(), 'string');

    const future = new Date(Date.now() + 3_600_000);
    fs.utimesSync(path.join(root, 'lib', 'util.mjs'), future, future);
    assert.throws(() => createCodeIdentity({ roots: [root], now: later })(), /changed less than/, 'a future mtime is racy');
    fs.rmSync(path.join(root, 'lib', 'util.mjs'));

    fs.symlinkSync('..', path.join(root, 'lib', 'loop'));
    assert.equal(typeof createCodeIdentity({ roots: [root], now: later })(), 'string', 'a symlink cycle terminates');
    fs.symlinkSync(path.join(root, 'missing-target'), path.join(root, 'lib', 'dangling'));
    assert.equal(typeof createCodeIdentity({ roots: [root], now: later })(), 'string', 'a dangling symlink is stamped');

    assert.throws(() => createCodeIdentity({ roots: [root], now: later, maxEntries: 3 })(), /exceeds 3 entries/);
    assert.throws(() => createCodeIdentity({ roots: [path.join(root, 'nope')], now: later })(), /ENOENT/);
});

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

for (const settleMs of [2000, 0]) {
    test(`I1 (settleMs ${settleMs}): an in-place code edit retires the warm worker; no call is served stale code`, async (t) => {
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

        const identity = createCodeIdentity({ roots: [code], settleMs });
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
