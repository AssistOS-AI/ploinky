import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { retireDestroyedBoxNoWaitMarkers } from '../../ploinky-box/noWaitCleanup.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-marker-cleanup-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspaceRoot = path.join(root, 'workspace');
    const markerDirectory = path.join(workspaceRoot, '.ploinky', 'running', 'no-wait');
    fs.mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
    const identity = buildWorkspaceIdentity(workspaceRoot, { markerFound: true });
    const containerName = 'ploinky_demo_worker';
    const runId = '11111111-2222-4333-8444-555555555555';
    const markerPath = path.join(markerDirectory, `${containerName}.current.json`);
    const marker = {
        containerName, instanceId: 'obsolete-instance', enableGeneration: 'obsolete-generation',
        repoName: 'demo', shortAgent: 'worker', alias: '', routeKey: 'worker',
        runId, runStartedAtMs: 1_700_000_000_000, waveIndex: 0,
        statusFile: `${containerName}.${runId}.json`,
    };
    const write = (value = marker) => fs.writeFileSync(markerPath, JSON.stringify(value), { mode: 0o600 });
    write();
    let lockChecks = 0;
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); lockChecks += 1; } };
    return { root, workspaceRoot, markerDirectory, markerPath, marker, identity, lock, write,
        cleanup: (options = {}) => retireDestroyedBoxNoWaitMarkers({ identity, lock, ...options }),
        lockChecks: () => lockChecks };
}

test('destroy cleanup removes only fixed markers and confines workspace env changes to its child', (t) => {
    const f = fixture(t);
    const parentEnvironment = { root: process.env.PLOINKY_WORKSPACE_ROOT, cwd: process.env.PLOINKY_CWD };
    const history = [f.marker.statusFile, 'worker.json', 'worker.log', 'unrelated.txt'];
    for (const name of history) fs.writeFileSync(path.join(f.markerDirectory, name), `keep ${name}`);
    f.cleanup();
    assert.equal(fs.existsSync(f.markerPath), false);
    for (const name of history) assert.equal(fs.readFileSync(path.join(f.markerDirectory, name), 'utf8'), `keep ${name}`);
    assert.deepEqual({ root: process.env.PLOINKY_WORKSPACE_ROOT, cwd: process.env.PLOINKY_CWD }, parentEnvironment);
    assert.equal(f.lockChecks(), 2);
    f.cleanup();
});

test('destroy cleanup rejects foreign-container and malformed current markers without exposing contents', (t) => {
    for (const override of [{ containerName: 'foreign_container' }, { runId: 'malformed' }]) {
        const f = fixture(t);
        f.write({ ...f.marker, ...override, sensitive: 'private-fixture-content' });
        assert.throws(f.cleanup, (error) => error.code === 'PLOINKY_BOX_NO_WAIT_CLEANUP_FAILED'
            && !error.message.includes('private-fixture-content'));
        assert.equal(fs.existsSync(f.markerPath), true);
    }
});

test('destroy cleanup refuses symlinked marker and every symlinked state ancestor', (t) => {
    for (const relative of ['.ploinky', '.ploinky/running', '.ploinky/running/no-wait', null]) {
        const f = fixture(t);
        const selected = relative ? path.join(f.workspaceRoot, relative) : f.markerPath;
        const outside = path.join(f.root, 'outside');
        fs.renameSync(selected, outside);
        fs.symlinkSync(outside, selected);
        const contentBefore = fs.readFileSync(relative
            ? path.join(outside, path.relative(selected, f.markerPath)) : outside, 'utf8');
        assert.throws(f.cleanup, /no-wait/);
        assert.equal(fs.lstatSync(selected).isSymbolicLink(), true);
        assert.equal(fs.readFileSync(relative
            ? path.join(outside, path.relative(selected, f.markerPath)) : outside, 'utf8'), contentBefore);
    }
});

test('destroy cleanup rejects writable state directories and current files', (t) => {
    for (const choose of [(f) => f.markerDirectory, (f) => f.markerPath]) {
        const f = fixture(t);
        fs.chmodSync(choose(f), 0o777);
        assert.throws(f.cleanup, /no-wait/);
        assert.equal(fs.existsSync(f.markerPath), true);
    }
});

test('destroy cleanup requires its exact lock and unchanged workspace root before starting the child', (t) => {
    const f = fixture(t);
    assert.throws(() => f.cleanup({ lock: null }), /mutation lock/);
    const moved = path.join(f.root, 'original');
    fs.renameSync(f.workspaceRoot, moved);
    fs.mkdirSync(f.workspaceRoot, { mode: 0o700 });
    assert.throws(() => f.cleanup({ spawn: () => assert.fail('must not spawn after root replacement') }), /identity changed/);
    assert.equal(fs.existsSync(path.join(moved, '.ploinky', 'running', 'no-wait', path.basename(f.markerPath))), true);
});

test('destroy cleanup bounds subprocess execution and fails closed on timeout', (t) => {
    const f = fixture(t);
    assert.throws(() => f.cleanup({ spawn: (command, args, options) => {
        assert.equal(command, process.execPath);
        assert.equal(args[1], f.workspaceRoot);
        assert.equal(options.cwd, f.workspaceRoot);
        assert.equal(options.env.PLOINKY_WORKSPACE_ROOT, f.workspaceRoot);
        assert.equal(options.env.PLOINKY_CWD, f.workspaceRoot);
        assert.equal(options.timeout, 30_000);
        assert.equal(options.killSignal, 'SIGKILL');
        assert.equal(options.maxBuffer, 16 * 1024);
        return { status: null, error: new Error('timed out') };
    } }), /cleanup failed/);
    assert.equal(fs.existsSync(f.markerPath), true);
});
