import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BOX_MARKER_PATH, BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';
import { registerCanaryPreparation, assertNoCanaryPreparations } from '../../cli/sandbox/canary/preparation.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { retireDestroyedBoxNoWaitMarkers, retireQuiescentBoxWorkspaceStartLock } from '../../ploinky-box/noWaitCleanup.mjs';

function fixture(t) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-preparation-'));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const workspace = path.join(scratch, 'workspace');
    const running = path.join(workspace, '.ploinky', 'running');
    fs.mkdirSync(running, { recursive: true });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); } };
    const file = owner => path.join(running, `canary-preparation-${owner}-${randomUUID()}`);
    const box = file('box-' + identity.pathHash);
    const native = file('native');
    return { scratch, workspace, running, identity, lock, box, native };
}

for (const owner of ['native', 'box']) {
    test('a ' + owner + ' preparation registers a private empty marker and releases it on completion', t => {
        const f = fixture(t);
        const boxMarkerPath = path.join(f.scratch, 'box-marker');
        if (owner === 'box') fs.writeFileSync(boxMarkerPath, BOX_MARKER_CONTENT);
        for (const method of ['lstatSync', 'readFileSync']) {
            const original = fs[method];
            t.mock.method(fs, method, (file, ...args) => original(file === BOX_MARKER_PATH ? boxMarkerPath : file, ...args));
        }
        const release = registerCanaryPreparation(f.workspace);
        const [name] = fs.readdirSync(f.running);
        const boundOwner = owner === 'box' ? 'box-' + f.identity.pathHash : owner;
        assert.ok(name.startsWith('canary-preparation-' + boundOwner + '-'));
        const before = fs.lstatSync(path.join(f.running, name));
        assert.equal(before.size, 0);
        assert.equal(before.nlink, 1);
        assert.equal(before.mode & 0o7777, 0o600);
        assert.throws(() => assertNoCanaryPreparations(f.workspace), /preparation is pending/);
        release();
        assert.deepEqual(fs.readdirSync(f.running), []);
        assert.doesNotThrow(() => assertNoCanaryPreparations(f.workspace));
    });
}

test('two Box workspace spellings sharing one running directory may retire only their own preparation', t => {
    const f = fixture(t);
    const alias = path.join(f.scratch, 'alias');
    fs.symlinkSync(f.workspace, alias);
    const other = buildWorkspaceIdentity(alias, { markerFound: true });
    assert.notEqual(other.pathHash, f.identity.pathHash);
    const aliasMarker = path.join(f.running, 'canary-preparation-box-' + other.pathHash + '-' + randomUUID());
    const unboundMarker = path.join(f.running, 'canary-preparation-box-' + randomUUID());
    for (const file of [f.box, aliasMarker, unboundMarker]) fs.writeFileSync(file, '', { mode: 0o600 });
    retireQuiescentBoxWorkspaceStartLock(f);
    assert.equal(fs.existsSync(f.box), false);
    assert.equal(fs.existsSync(aliasMarker), true);
    assert.throws(() => assertNoCanaryPreparations(f.workspace), /preparation is pending/);
    const lock = { assertHeld(instance) { assert.equal(instance, other.instance); } };
    retireQuiescentBoxWorkspaceStartLock({ identity: other, lock });
    assert.equal(fs.existsSync(aliasMarker), false);
    assert.equal(fs.existsSync(unboundMarker), true);
    assert.throws(() => assertNoCanaryPreparations(alias), /preparation is pending/);
});

for (const cleanup of [retireQuiescentBoxWorkspaceStartLock, retireDestroyedBoxNoWaitMarkers]) {
    test(`${cleanup.name} retires an owner-write-only legacy lock without opening it`, t => {
        const f = fixture(t);
        const file = path.join(f.running, 'workspace-start.json');
        fs.writeFileSync(file, 'ordinary legacy lock');
        fs.chmodSync(file, 0o200);
        const open = fs.openSync;
        t.mock.method(fs, 'openSync', (target, ...args) => {
            assert.notEqual(target, file, 'owner-write-only legacy lock must not be opened');
            return open(target, ...args);
        });
        cleanup(f);
        assert.equal(fs.existsSync(file), false);
    });

    test(`${cleanup.name} retains native and unbound canary writers while preserving ordinary lease retirement`, t => {
        const f = fixture(t);
        const file = path.join(f.running, 'workspace-start.json');
        for (const canaryOwner of ['native', undefined]) {
            const value = JSON.stringify({ operation: 'canary-start', canaryOwner });
            fs.writeFileSync(file, value, { mode: 0o600 });
            cleanup(f);
            assert.equal(fs.readFileSync(file, 'utf8'), value);
        }
        fs.writeFileSync(file, JSON.stringify({ operation: 'workspace-start', canaryOwner: 'native' }));
        cleanup(f);
        assert.equal(fs.existsSync(file), false);
    });

    test(`${cleanup.name} retires only exact Box preparation markers and retains native ownership`, t => {
        const f = fixture(t);
        const other = path.join(f.running, 'canary-preparation-box-unrelated');
        for (const file of [f.box, f.native, other]) fs.writeFileSync(file, '', { mode: 0o600 });
        assert.throws(() => cleanup({ ...f, lock: null }), /mutation lock/);
        assert.ok(fs.existsSync(f.box));
        cleanup(f);
        assert.equal(fs.existsSync(f.box), false);
        assert.ok(fs.existsSync(f.native));
        assert.ok(fs.existsSync(other));
        assert.throws(() => assertNoCanaryPreparations(f.workspace), /preparation is pending/);
        fs.unlinkSync(f.native);
        assert.doesNotThrow(() => assertNoCanaryPreparations(f.workspace));
    });
}

for (const component of ['.ploinky', '.ploinky/running']) {
    test('Box preparation cleanup refuses a redirected ' + component + ' ancestor', t => {
        const f = fixture(t);
        const source = path.join(f.workspace, component);
        const external = path.join(f.scratch, 'external');
        fs.writeFileSync(f.box, '', { mode: 0o600 });
        fs.renameSync(source, external);
        fs.symlinkSync(external, source);
        assert.throws(() => retireQuiescentBoxWorkspaceStartLock(f), /redirected/);
        assert.equal(fs.statSync(f.box).size, 0);
    });
}

test('quiescent cleanup refuses unsafe marker identities', t => {
    for (const kind of ['symlink', 'hardlink', 'mode', 'payload']) {
        const f = fixture(t);
        const other = path.join(f.scratch, 'other');
        fs.writeFileSync(other, '', { mode: 0o600 });
        if (kind === 'symlink') fs.symlinkSync(other, f.box);
        else if (kind === 'hardlink') fs.linkSync(other, f.box);
        else {
            fs.writeFileSync(f.box, kind === 'payload' ? 'foreign' : '', { mode: 0o600 });
            if (kind === 'mode') fs.chmodSync(f.box, 0o644);
        }
        assert.throws(() => retireQuiescentBoxWorkspaceStartLock(f), /Unsafe canary preparation marker/);
        assert.ok(fs.lstatSync(f.box));
    }
});

test('Box cleanup never unlinks a replacement marker written during its quiescence checks', t => {
    const f = fixture(t);
    fs.writeFileSync(f.box, '', { mode: 0o600 });
    let calls = 0;
    const lock = { assertHeld() {
        if (++calls === 2) {
            fs.renameSync(f.box, f.box + '.original');
            fs.writeFileSync(f.box, '', { mode: 0o600 });
        }
    } };
    assert.throws(() => retireQuiescentBoxWorkspaceStartLock({ identity: f.identity, lock }), /marker changed/);
    assert.ok(fs.existsSync(f.box));
});

test('a live preparation never unlinks a replacement marker or a substituted running directory', t => {
    for (const substitution of ['marker', 'directory']) {
        const f = fixture(t);
        const release = registerCanaryPreparation(f.workspace);
        const [name] = fs.readdirSync(f.running);
        const marker = path.join(f.running, name);
        if (substitution === 'marker') fs.renameSync(marker, marker + '.original');
        else {
            fs.renameSync(f.running, f.running + '.original');
            fs.mkdirSync(f.running);
        }
        fs.writeFileSync(marker, '', { mode: 0o600 });
        assert.throws(release, /changed/);
        assert.ok(fs.existsSync(marker));
    }
});
