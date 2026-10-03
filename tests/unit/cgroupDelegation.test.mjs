import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { prepareCgroupDelegation } from '../../ploinky-box/entrypoint/cgroupDelegation.mjs';
import {
    assertPreparationSourceIsolated,
    parsePreparationResult,
    prepareBoxGeneration,
} from '../../ploinky-box/hardwareLimits/status.mjs';
import { FakeCgroupFs, SELF_PID, preparedCgroupFs } from '../hardware-limits/fakeCgroupFs.mjs';

const SCRIPT_URL = new URL('../../ploinky-box/entrypoint/cgroupDelegation.mjs', import.meta.url);
const ROOT = '/sys/fs/cgroup';

function prepare(fake, overrides = {}) {
    return prepareCgroupDelegation({
        argv: ['prepare'],
        getuid: () => 0,
        fsApi: fake,
        sleep: async () => {},
        ...overrides,
    });
}

function assertNoMutation(fake, before) {
    assert.equal(fake.snapshot(), before);
    assert.deepEqual(fake.writes, []);
    assert.deepEqual(fake.chowns, []);
    assert.deepEqual(fake.mkdirs, []);
}

function assertResultShape(result) {
    assert.deepEqual(Object.keys(result).sort(), ['already', 'controllers', 'missing', 'movedPids', 'nsdelegate', 'reason', 'schema', 'structurallyPrepared']);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8 * 1024);
    assert.equal(parsePreparationResult(JSON.stringify(result)).structurallyPrepared, result.structurallyPrepared);
}

test('CG.uid', async () => {
    const fake = new FakeCgroupFs();
    const before = fake.snapshot();
    const { exitCode, result } = await prepare(fake, { getuid: () => 1000 });
    assert.equal(exitCode, 10);
    assert.equal(result.structurallyPrepared, false);
    assertResultShape(result);
    assertNoMutation(fake, before);
    // Extra arguments are rejected before any read or write.
    const extra = await prepare(fake, { argv: ['prepare', '--force'] });
    assert.notEqual(extra.exitCode, 0);
    assertNoMutation(fake, before);
});

test('CG.cgroup-v1', async () => {
    const fake = new FakeCgroupFs({ mount: { fstype: 'cgroup' } });
    const before = fake.snapshot();
    const { exitCode, result } = await prepare(fake);
    assert.equal(exitCode, 2);
    assert.match(result.reason, /not a cgroup2 mount/);
    assertNoMutation(fake, before);
});

test('CG.readonly', async () => {
    for (const mount of [{ mountRw: false }, { superRw: false }]) {
        const fake = new FakeCgroupFs({ mount });
        const before = fake.snapshot();
        const { exitCode, result } = await prepare(fake);
        assert.equal(exitCode, 3, JSON.stringify(mount));
        assert.match(result.reason, /not writable/);
        assertNoMutation(fake, before);
    }
});

test('CG.nsdelegate', async () => {
    const fake = new FakeCgroupFs({ mount: { nsdelegate: false } });
    const before = fake.snapshot();
    const { exitCode, result } = await prepare(fake);
    assert.equal(exitCode, 5);
    assert.equal(result.nsdelegate, false);
    assertNoMutation(fake, before);
});

function sourceWithoutComments() {
    return fs.readFileSync(SCRIPT_URL, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((line) => line.replace(/^\s*\/\/.*$/, '')).join('\n');
}

test('CG.no-subprocess', () => {
    const source = sourceWithoutComments();
    for (const forbidden of [/child_process/, /\bspawn(Sync)?\s*\(/, /\bexec(File)?(Sync)?\s*\(/, /\bfork\s*\(/, /process\.binding/, /\bWorker\b/, /\bimport\s*\(/, /\brequire\s*\(/, /podman/i, /\/bin\/(ba)?sh/]) {
        assert.doesNotMatch(source, forbidden, String(forbidden));
    }
    // Every path the script touches is fixed: no argv/env-derived path input.
    assert.doesNotMatch(source, /process\.env/);
    assert.match(source, /argv\.length !== 1 \|\| argv\[0\] !== 'prepare'/);
});

test('CG.node-imports-only', () => {
    const source = sourceWithoutComments();
    const specifiers = [...source.matchAll(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    assert.ok(specifiers.length > 0);
    const allowed = new Set(['node:fs', 'node:process', 'node:timers/promises']);
    for (const specifier of specifiers) assert.ok(allowed.has(specifier), `unexpected import ${specifier}`);
    assert.doesNotMatch(source, /\bexport\s+\*\s+from|\bexport\s+\{[^}]*\}\s+from/);
});

// `node -e SOURCE ARG` makes process.argv[1] the first ARG. The helper decides "run directly" from it, so an argument that is not a
// script path (a URL, as a test or a tool passes when it imports the module) must be an import, never a crash and never a run.
test('CG.a-first-argument-that-is-not-a-script-path-is-an-import-and-a-script-path-still-runs-directly', () => {
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', "await import(process.argv[1]); process.stdout.write('imported');", SCRIPT_URL.href], { encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, 'imported', 'the helper did not run and printed nothing');
    // Run by its script path it still runs: a wrong invocation answers with its usage refusal as one JSON line and a failing status.
    const direct = spawnSync(process.execPath, [fileURLToPath(SCRIPT_URL), 'bogus'], { encoding: 'utf8' });
    assert.equal(direct.status, 1, direct.stderr);
    const result = JSON.parse(direct.stdout.trim());
    assert.equal(result.structurallyPrepared, false);
    assert.match(result.reason, /the only accepted invocation is `prepare`/);
});

function installation(t) {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-cg-src-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const repositoryRoot = path.join(base, 'install', 'ploinky');
    const entrypoint = path.join(repositoryRoot, 'ploinky-box', 'entrypoint');
    fs.mkdirSync(entrypoint, { recursive: true });
    const script = path.join(entrypoint, 'cgroupDelegation.mjs');
    fs.copyFileSync(SCRIPT_URL, script);
    const workspace = path.join(base, 'workspace');
    fs.mkdirSync(workspace);
    return { base, repositoryRoot, script, workspace };
}

test('CG.writable-source-refused', async (t) => {
    const fixture = installation(t);
    // Disjoint installation is accepted.
    assert.equal(assertPreparationSourceIsolated({ repositoryRoot: fixture.repositoryRoot, writableSources: [fixture.workspace] }).script, fixture.script);
    // An installation inside a writable workspace/cache is refused, in either containment direction.
    assert.throws(() => assertPreparationSourceIsolated({ repositoryRoot: fixture.repositoryRoot, writableSources: [fixture.base] }),
        /overlaps writable Box source.*outside the deployed workspace and caches/);
    assert.throws(() => assertPreparationSourceIsolated({ repositoryRoot: fixture.repositoryRoot, writableSources: [path.join(fixture.repositoryRoot, 'ploinky-box')] }),
        /overlaps writable Box source/);
    // An installation that canonically lives in the workspace is refused even
    // when the host refers to it through an outside alias.
    const inside = path.join(fixture.workspace, 'ploinky');
    fs.cpSync(fixture.repositoryRoot, inside, { recursive: true });
    const alias = path.join(fixture.base, 'alias-ploinky');
    fs.symlinkSync(inside, alias);
    assert.throws(() => assertPreparationSourceIsolated({ repositoryRoot: alias, writableSources: [fixture.workspace] }), /overlaps writable Box source/);
    // A hard link (workspace-writable alias of the same inode) is refused.
    const hardlink = path.join(fixture.workspace, 'prep.mjs');
    fs.linkSync(fixture.script, hardlink);
    assert.throws(() => assertPreparationSourceIsolated({ repositoryRoot: fixture.repositoryRoot, writableSources: [] }), /not one canonical regular file/);
    fs.rmSync(hardlink);
    // A symlinked script is refused.
    fs.renameSync(fixture.script, `${fixture.script}.real`);
    fs.symlinkSync(`${fixture.script}.real`, fixture.script);
    assert.throws(() => assertPreparationSourceIsolated({ repositoryRoot: fixture.repositoryRoot, writableSources: [] }), /not one canonical regular file/);
    // The root exec is never reached when isolation fails.
    const calls = [];
    await assert.rejects(prepareBoxGeneration({
        engine: { name: 'podman' },
        containerId: 'a'.repeat(64),
        runner: { query: (command, args) => { calls.push(args); return { ok: true, stdout: 'crun' }; } },
        repositoryRoot: fixture.repositoryRoot,
        writableSources: [],
    }), /not one canonical regular file/);
    assert.equal(calls.some((args) => args.includes('exec')), false);
});

test('CG.writable-source-refused uses the fixed root exec form when isolated', async (t) => {
    const fixture = installation(t);
    const runnerFor = (outerRuntime, calls) => ({
        query: (command, args, options) => {
            calls.push({ command, args, options });
            if (args[0] === 'container' && args[1] === 'inspect') return { ok: true, status: 0, stdout: `${outerRuntime}\n` };
            if (args[0] === 'info') return { ok: true, status: 0, stdout: 'crun\n' };
            return { ok: true, status: 0, stdout: JSON.stringify({ schema: 1, structurallyPrepared: true, already: false, controllers: ['cpu'], missing: [], movedPids: 2, nsdelegate: true, reason: null }) };
        },
    });
    // The exact Box's own OCI runtime is checked first; a non-crun Box is never prepared.
    const refusedCalls = [];
    const unverified = await prepareBoxGeneration({
        engine: { name: 'podman' }, containerId: 'a'.repeat(64), runner: runnerFor('runc', refusedCalls),
        repositoryRoot: fixture.repositoryRoot, writableSources: [fixture.workspace],
    });
    assert.equal(unverified.structurallyPrepared, false);
    assert.match(unverified.reason, /^runtime_unverified: the Box runs runc, not crun \(observed crun\/runc\)/);
    assert.equal(refusedCalls.some((call) => call.args.includes('exec')), false);
    const calls = [];
    const result = await prepareBoxGeneration({
        engine: { name: 'podman' },
        containerId: 'a'.repeat(64),
        runner: runnerFor('/usr/bin/crun', calls),
        repositoryRoot: fixture.repositoryRoot,
        writableSources: [fixture.workspace],
    });
    assert.equal(result.structurallyPrepared, true);
    assert.deepEqual(calls[0].args, ['container', 'inspect', '--format', '{{.OCIRuntime}}', 'a'.repeat(64)]);
    assert.deepEqual(calls[2].args, [
        'container', 'exec', '--user', 'root', '--workdir', '/', '--env', 'NODE_OPTIONS=', '--env', 'NODE_PATH=',
        'a'.repeat(64), '/usr/local/bin/node', '/opt/ploinky/ploinky-box/entrypoint/cgroupDelegation.mjs', 'prepare',
    ]);
    assert.equal(calls[2].options.timeoutMs, 30_000);
    await assert.rejects(prepareBoxGeneration({ engine: { name: 'podman' }, containerId: 'ploinky-box-name', runner: { query() {} }, repositoryRoot: fixture.repositoryRoot }), /exact immutable Box ID/);
});

test('CG.root-procs-owned-root', async () => {
    const fake = new FakeCgroupFs();
    const { exitCode, result } = await prepare(fake);
    assert.equal(exitCode, 0, result.reason);
    assert.equal(fake.lstatSync(`${ROOT}/cgroup.procs`).uid, 0);
    assert.equal(fake.lstatSync(ROOT).uid, 0);
    assert.equal(fake.chowns.some((target) => target === ROOT || target.startsWith(`${ROOT}/cgroup.`)), false);
});

test('CG.core-owned-root', async () => {
    const fake = new FakeCgroupFs();
    const { exitCode } = await prepare(fake);
    assert.equal(exitCode, 0);
    assert.equal(fake.lstatSync(`${ROOT}/ploinky/core`).uid, 0);
    assert.equal(fake.lstatSync(`${ROOT}/ploinky/core/cgroup.procs`).uid, 0);
    assert.equal(fake.chowns.some((target) => target.startsWith(`${ROOT}/ploinky/core`)), false);
    // Root creates only /ploinky and /ploinky/core, never agents/system.
    assert.deepEqual(fake.mkdirs.map((entry) => entry.path), [`${ROOT}/ploinky`, `${ROOT}/ploinky/core`]);
});

test('CG.only-ploinky-chowned', async () => {
    const fake = new FakeCgroupFs();
    const { exitCode } = await prepare(fake);
    assert.equal(exitCode, 0);
    assert.deepEqual(fake.chowns, [
        `${ROOT}/ploinky`,
        `${ROOT}/ploinky/cgroup.procs`,
        `${ROOT}/ploinky/cgroup.subtree_control`,
        `${ROOT}/ploinky/cgroup.threads`,
    ]);
    for (const target of fake.chowns) assert.equal(fake.lstatSync(target).uid, 1000);
});

test('CG.pid1-and-self-moved', async () => {
    const fake = new FakeCgroupFs({ rootPids: [1, SELF_PID, 77, 78] });
    // PID 78 exits between the read and the move (ESRCH is the only ignored error).
    fake.hooks.beforeWrite = (rel, file, data, self) => {
        if (file === 'cgroup.procs' && data === '78') {
            self.groups.get('/').procs.delete(78);
            self.pidGroup.delete(78);
        }
        return null;
    };
    const { exitCode, result } = await prepare(fake);
    assert.equal(exitCode, 0, result.reason);
    assert.equal(fake.pidGroup.get(1), '/ploinky/core');
    assert.equal(fake.pidGroup.get(SELF_PID), '/ploinky/core');
    assert.equal(fake.groups.get('/').procs.size, 0);
    assert.equal(fake.groups.get('/ploinky').procs.size, 0);
    assert.equal(result.movedPids, 3);
    assert.deepEqual(result.controllers, ['cpu', 'memory', 'pids']);
    assert.deepEqual(result.missing, []);
    // io is available but never enabled.
    assert.equal(fake.writes.some((entry) => entry.data === '+io'), false);
    assertResultShape(result);
});

test('CG.root-busy', async () => {
    const fake = new FakeCgroupFs();
    let next = 1000;
    fake.hooks.beforeRead = (rel, file, self) => {
        if (rel === '/' && file === 'cgroup.procs') self.placePid(next++, '/');
    };
    let sleeps = 0;
    const { exitCode, result } = await prepare(fake, { sleep: async () => { sleeps += 1; } });
    assert.equal(exitCode, 4);
    assert.match(result.reason, /tasks remain in the namespace root/);
    assert.equal(sleeps, 50);
    // Fails before enabling any controller or delegating anything.
    assert.equal(fake.writes.some((entry) => entry.path.endsWith('cgroup.subtree_control')), false);
    assert.deepEqual(fake.chowns, []);
});

test('CG.partial-retry', async () => {
    // A failed first attempt (chown I/O error) leaves partial setup; the retry completes it.
    const fake = new FakeCgroupFs();
    let failOnce = true;
    fake.hooks.beforeChown = () => {
        if (!failOnce) return null;
        failOnce = false;
        return Object.assign(new Error('EIO'), { code: 'EIO' });
    };
    const first = await prepare(fake);
    assert.equal(first.exitCode, 6);
    assert.equal(first.result.structurallyPrepared, false);
    fake.selfPid = 5151;
    fake.placePid(5151, '/');
    const second = await prepare(fake);
    assert.equal(second.exitCode, 0, second.result.reason);
    assert.equal(second.result.already, false);
    assert.equal(fake.lstatSync(`${ROOT}/ploinky`).uid, 1000);

    // A prepared Box with a running agent leaf whose /ploinky lost pids: the
    // retry enables pids again without touching or moving the agent leaf.
    const prepared = preparedCgroupFs({ controllers: ['cpu', 'memory'] });
    prepared.actorUid = 1000;
    prepared.addGroup('/ploinky/agents', { uid: 1000 });
    prepared.addGroup(`/ploinky/agents/libpod-${'c'.repeat(64)}`, { uid: 1000 });
    const leaf = prepared.groups.get(`/ploinky/agents/libpod-${'c'.repeat(64)}`);
    leaf.values.set('memory.max', '536870912');
    leaf.values.set('memory.swap.max', '0');
    prepared.placePid(900, `/ploinky/agents/libpod-${'c'.repeat(64)}`);
    prepared.selfPid = 6000;
    prepared.placePid(6000, '/');
    const leafBefore = JSON.stringify([[...leaf.procs], [...leaf.values]]);
    const retry = await prepare(prepared);
    assert.equal(retry.exitCode, 0, retry.result.reason);
    assert.deepEqual(retry.result.controllers, ['cpu', 'memory', 'pids']);
    assert.equal(JSON.stringify([[...leaf.procs], [...leaf.values]]), leafBefore);
    assert.equal(prepared.pidGroup.get(900), `/ploinky/agents/libpod-${'c'.repeat(64)}`);
    assert.equal(prepared.writes.some((entry) => entry.path.includes('/ploinky/agents')), false);
});

test('CG.idempotent-core-self', async () => {
    const fake = preparedCgroupFs();
    // The caller is itself already inside /ploinky/core: not required to be outside /ploinky.
    assert.equal(fake.pidGroup.get(SELF_PID), '/ploinky/core');
    const before = fake.snapshot();
    const { exitCode, result } = await prepare(fake);
    assert.equal(exitCode, 0);
    assert.equal(result.already, true);
    assert.equal(result.structurallyPrepared, true);
    assert.deepEqual(result.controllers, ['cpu', 'memory', 'pids']);
    assertNoMutation(fake, before);
});

test('CG.empty-controller-structural-success', async () => {
    const fake = new FakeCgroupFs({ controllers: [] });
    const { exitCode, result } = await prepare(fake);
    assert.equal(exitCode, 0, result.reason);
    assert.equal(result.structurallyPrepared, true);
    assert.deepEqual(result.controllers, []);
    assert.deepEqual(result.missing.map((entry) => entry.controller), ['cpu', 'memory', 'pids']);
    assert.equal(fake.pidGroup.get(1), '/ploinky/core');
    assert.equal(fake.lstatSync(`${ROOT}/ploinky`).uid, 1000);
    // A controller whose write does not take effect is reported, never claimed.
    const partial = new FakeCgroupFs();
    partial.hooks.ignoreEnable = (rel, controller) => rel === '/ploinky' && controller === 'memory';
    const reported = await prepare(partial);
    assert.equal(reported.exitCode, 0);
    assert.deepEqual(reported.result.controllers, ['cpu', 'pids']);
    assert.deepEqual(reported.result.missing, [{ controller: 'memory', reason: '/ploinky not enabled after write' }]);
});
