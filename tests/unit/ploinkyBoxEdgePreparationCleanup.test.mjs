import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { retireQuiescentBoxEdgePreparation } from '../../ploinky-box/edgePreparationCleanup.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-cleanup-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspaceRoot = path.join(root, 'workspace');
    const directory = path.join(workspaceRoot, '.ploinky', 'data', 'edge-routing');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const identity = buildWorkspaceIdentity(workspaceRoot, { markerFound: true });
    const leasePath = path.join(directory, 'preparation-lease.json');
    fs.writeFileSync(leasePath, '{corrupt unfinished preparation', { mode: 0o600 });
    let checks = 0;
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); checks += 1; } };
    return { root, workspaceRoot, directory, identity, leasePath, lock,
        checks: () => checks,
        cleanup: (options = {}) => retireQuiescentBoxEdgePreparation({ identity, lock, ...options }) };
}

test('quiescent cleanup retires only preparation lease without needing a running directory', (t) => {
    const f = fixture(t);
    const preserved = ['active.json', 'desired.json', 'sources.json', 'apply.lock', 'generations/old.json'];
    for (const name of preserved) {
        const target = path.join(f.directory, name);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, `keep ${name}`);
    }
    assert.equal(fs.existsSync(path.join(f.workspaceRoot, '.ploinky', 'running')), false);
    f.cleanup();
    assert.equal(fs.existsSync(f.leasePath), false);
    assert.equal(f.checks(), 2);
    for (const name of preserved) assert.equal(fs.readFileSync(path.join(f.directory, name), 'utf8'), `keep ${name}`);
    f.cleanup();
});

test('missing lease and missing state directories are idempotent', (t) => {
    for (const relative of ['.ploinky', '.ploinky/data', '.ploinky/data/edge-routing', '.ploinky/data/edge-routing/preparation-lease.json']) {
        const f = fixture(t);
        fs.rmSync(path.join(f.workspaceRoot, relative), { recursive: true });
        f.cleanup();
        f.cleanup();
        assert.equal(fs.existsSync(path.join(f.workspaceRoot, relative)), false);
    }
});

test('cleanup follows directory links but rejects replaced roots and symlinked leases', (t) => {
    for (const relative of ['', '.ploinky', '.ploinky/data', '.ploinky/data/edge-routing', '.ploinky/data/edge-routing/preparation-lease.json']) {
        const f = fixture(t);
        const target = path.join(f.workspaceRoot, relative);
        const outside = path.join(f.root, 'outside');
        fs.renameSync(target, outside);
        fs.symlinkSync(outside, target);
        if (!relative || relative.endsWith('.json')) {
            assert.throws(f.cleanup, /identity changed|secure owned/);
            assert.equal(fs.existsSync(f.leasePath), true);
        } else {
            f.cleanup();
            assert.equal(fs.existsSync(f.leasePath), false);
        }
        assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
    }
});

test('cleanup rejects writable files, nonregular leases, hardlinks and oversized leases', (t) => {
    for (const kind of ['file', 'hardlink', 'directory', 'oversize']) {
        const f = fixture(t);
        if (kind === 'file') fs.chmodSync(f.leasePath, 0o777);
        if (kind === 'hardlink') fs.linkSync(f.leasePath, path.join(f.root, 'other-lease'));
        if (kind === 'directory') { fs.unlinkSync(f.leasePath); fs.mkdirSync(f.leasePath); }
        if (kind === 'oversize') fs.truncateSync(f.leasePath, 1024 * 1024 + 1);
        assert.throws(f.cleanup, /secure owned/);
        assert.equal(fs.existsSync(f.leasePath), true);
    }
});

test('owned shared workspace roots retain their existing mode contract', (t) => {
    for (const hasState of [true, false]) {
        const f = fixture(t);
        fs.chmodSync(f.workspaceRoot, 0o775);
        const identity = buildWorkspaceIdentity(f.workspaceRoot, { markerFound: true });
        if (!hasState) fs.rmSync(path.join(f.workspaceRoot, '.ploinky'), { recursive: true });
        f.cleanup({ identity });
        assert.equal(fs.existsSync(f.leasePath), false);
        assert.equal(fs.statSync(f.workspaceRoot).mode & 0o777, 0o775);
    }
});

test('cleanup requires held lock and exact original root identity', (t) => {
    const f = fixture(t);
    assert.throws(() => f.cleanup({ lock: null }), /workspace mutation lock/);
    assert.throws(() => f.cleanup({ lock: { assertHeld() { throw new Error('lock lost'); } } }), /lock lost/);
    fs.renameSync(f.workspaceRoot, path.join(f.root, 'original'));
    fs.mkdirSync(f.workspaceRoot, { mode: 0o700 });
    assert.throws(f.cleanup, /identity changed/);
    assert.equal(fs.existsSync(path.join(f.root, 'original', '.ploinky', 'data', 'edge-routing', 'preparation-lease.json')), true);
});

test('cleanup rejects foreign ownership of the lease file', (t) => {
    if (typeof process.getuid !== 'function') return;
    const originalLstat = fs.lstatSync;
    for (const relative of ['.ploinky/data/edge-routing/preparation-lease.json']) {
        const f = fixture(t);
        const target = path.join(f.workspaceRoot, relative);
        const mocked = t.mock.method(fs, 'lstatSync', (candidate, ...args) => {
            const stat = originalLstat(candidate, ...args);
            if (candidate === target) stat.uid = process.getuid() + 1;
            return stat;
        });
        try {
            assert.throws(f.cleanup, /secure owned/);
            assert.equal(fs.existsSync(f.leasePath), true);
        } finally { mocked.mock.restore(); }
    }
});

test('cleanup rejects root and state directory replacement at final lock check', (t) => {
    for (const relative of ['', '.ploinky', '.ploinky/data', '.ploinky/data/edge-routing']) {
        const f = fixture(t);
        let checks = 0;
        const target = path.join(f.workspaceRoot, relative);
        const retained = path.join(f.root, 'retained');
        assert.throws(() => f.cleanup({ lock: { assertHeld() {
            if (++checks !== 2) return;
            fs.renameSync(target, retained);
            fs.mkdirSync(f.directory, { recursive: true, mode: 0o700 });
            fs.writeFileSync(f.leasePath, 'replacement', { mode: 0o600 });
        } } }), /identity changed|directories changed/);
        assert.equal(fs.readFileSync(f.leasePath, 'utf8'), 'replacement');
        assert.equal(fs.existsSync(path.join(retained, path.relative(target, f.leasePath))), true);
    }
});

test('cleanup rejects new, modified, replaced or removed leases at final lock check', (t) => {
    for (const kind of ['new', 'modified', 'replacement', 'removed', 'symlink', 'lock-lost']) {
        const f = fixture(t);
        if (kind === 'new') fs.unlinkSync(f.leasePath);
        let checks = 0;
        assert.throws(() => f.cleanup({ lock: { assertHeld() {
            if (++checks !== 2) return;
            if (kind === 'lock-lost') throw new Error('lock lost');
            if (kind === 'replacement' || kind === 'symlink') fs.renameSync(f.leasePath, `${f.leasePath}.old`);
            if (kind === 'removed') fs.unlinkSync(f.leasePath);
            else if (kind === 'symlink') fs.symlinkSync(`${f.leasePath}.old`, f.leasePath);
            else fs.writeFileSync(f.leasePath, 'changed', { mode: 0o600 });
        } } }), /lease changed|secure owned|lock lost/);
        if (kind !== 'removed') assert.equal(fs.existsSync(f.leasePath), true);
    }
});
