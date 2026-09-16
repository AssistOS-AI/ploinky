import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createRouterBindingStore } from '../../ploinky-box/routerBinding.mjs';
import { inspectBindingPermissions, repairBindingPermissions } from '../../ploinky-box/repair/bindingPermissions.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-binding-repair-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const homeDirectory = path.join(root, 'home');
    const workspaceRoot = path.join(root, 'workspace');
    fs.mkdirSync(homeDirectory, { mode: 0o700 });
    fs.mkdirSync(workspaceRoot, { mode: 0o700 });
    const identity = buildWorkspaceIdentity(workspaceRoot);
    const store = createRouterBindingStore({ homeDirectory });
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); } };
    const options = { identity, homeDirectory, lock };
    const target = store.pathFor(identity);
    const write = (mode = 0o600) => {
        store.write(identity, { address: '127.0.0.1', hostPort: 8080 }, lock);
        fs.chmodSync(target, mode);
        return fs.readFileSync(target);
    };
    return { root, options, target, store, write };
}

test('permission repair tightens only a valid selected binding, preserving its bytes and owner access', (t) => {
    const { options, target, write, store } = fixture(t);
    const bytes = write(0o644);
    const sibling = path.join(store.directory, 'unrelated.json');
    fs.writeFileSync(sibling, 'untouched', { mode: 0o644 });
    const [check] = inspectBindingPermissions(options);
    assert.equal(check.code, 'BINDING_SHARED_READ');
    assert.equal(check.repairEligible, true);
    assert.equal(check.status, 'fail');
    const result = repairBindingPermissions(options);
    assert.equal(result.status, 'applied');
    assert.deepEqual(result.operation, { file: 'chmod', args: ['go-rwx', '--', target] });
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(target), bytes);
    assert.equal(fs.statSync(sibling).mode & 0o777, 0o644);
    assert.equal(inspectBindingPermissions(options)[0].status, 'pass');
});

test('owner-read-only binding repair never grants owner write permission', (t) => {
    const { options, target, write } = fixture(t);
    write(0o444);
    assert.equal(repairBindingPermissions(options).status, 'applied');
    assert.equal(fs.statSync(target).mode & 0o777, 0o400);
});

test('private and absent binding records need no repair or new state', (t) => {
    const { options, target, write, store } = fixture(t);
    assert.equal(inspectBindingPermissions(options)[0].status, 'skip');
    assert.equal(repairBindingPermissions(options).status, 'skipped');
    assert.equal(fs.existsSync(store.directory), false);
    const bytes = write();
    const before = fs.statSync(target);
    assert.equal(repairBindingPermissions(options).status, 'skipped');
    assert.equal(fs.statSync(target).ctimeMs, before.ctimeMs);
    assert.deepEqual(fs.readFileSync(target), bytes);
    fs.unlinkSync(target);
    assert.equal(inspectBindingPermissions(options)[0].status, 'skip');
});

test('shared-writable binding contents are never trusted or repaired', (t) => {
    const { options, target, write } = fixture(t);
    for (const mode of [0o620, 0o602, 0o666]) {
        write(mode);
        assert.equal(inspectBindingPermissions(options)[0].code, 'BINDING_SHARED_WRITE');
        assert.equal(inspectBindingPermissions(options)[0].repairEligible, false);
        assert.throws(() => repairBindingPermissions(options), { code: 'BINDING_SHARED_WRITE' });
        assert.equal(fs.statSync(target).mode & 0o777, mode);
    }
});

test('symlink and hardlinked records are never repaired', (t) => {
    const { options, target, write } = fixture(t);
    write(0o644);
    const other = `${target}.other`;
    fs.linkSync(target, other);
    assert.equal(inspectBindingPermissions(options)[0].code, 'BINDING_UNSAFE_PATH');
    assert.throws(() => repairBindingPermissions(options), { code: 'BINDING_UNSAFE_PATH' });
    fs.unlinkSync(target);
    fs.symlinkSync(other, target);
    assert.equal(inspectBindingPermissions(options)[0].code, 'BINDING_UNSAFE_PATH');
    assert.throws(() => repairBindingPermissions(options), { code: 'BINDING_UNSAFE_PATH' });
    assert.equal(fs.statSync(other).mode & 0o777, 0o644);
});

test('unsafe parent directories and directory aliases block repair without chmod', (t) => {
    const { options, target, write, store } = fixture(t);
    write(0o644);
    for (const directory of [options.homeDirectory, path.dirname(store.directory), store.directory]) {
        fs.chmodSync(directory, 0o722);
        assert.equal(inspectBindingPermissions(options)[0].code, 'BINDING_UNSAFE_PATH');
        assert.throws(() => repairBindingPermissions(options), { code: 'BINDING_UNSAFE_PATH' });
        assert.equal(fs.statSync(directory).mode & 0o777, 0o722);
        fs.chmodSync(directory, 0o700);
    }
    fs.renameSync(store.directory, `${store.directory}.other`);
    fs.symlinkSync(`${store.directory}.other`, store.directory);
    assert.equal(inspectBindingPermissions(options)[0].code, 'BINDING_UNSAFE_PATH');
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
});

test('binding state exposed through a writable workspace alias is rejected', (t) => {
    const { options, write, store } = fixture(t);
    write(0o644);
    const alias = path.join(options.identity.workspaceRoot, 'cache-alias');
    fs.symlinkSync(store.directory, alias);
    const changed = { ...options, identity: { ...options.identity, dataPaths: { unsafe: alias } } };
    assert.equal(inspectBindingPermissions(changed)[0].code, 'BINDING_UNSAFE_PATH');
    assert.throws(() => repairBindingPermissions(changed), { code: 'BINDING_UNSAFE_PATH' });
});

test('foreign file ownership is reported without attempting a repair', (t) => {
    const { options, target, write } = fixture(t);
    write(0o644);
    const fsApi = { ...fs, lstatSync(filename) {
        const stat = fs.lstatSync(filename);
        if (filename === target) stat.uid += 1;
        return stat;
    } };
    assert.equal(inspectBindingPermissions({ ...options, fsApi })[0].code, 'BINDING_FOREIGN_OWNER');
    assert.throws(() => repairBindingPermissions({ ...options, fsApi }), { code: 'BINDING_FOREIGN_OWNER' });
});

test('invalid JSON, schema, workspace, and oversized records require manual review', (t) => {
    const { options, target, write } = fixture(t);
    const original = JSON.parse(write(0o644));
    for (const bytes of ['{', JSON.stringify({ ...original, extra: true }),
        JSON.stringify({ ...original, workspaceRoot: '/another-workspace' }),
        JSON.stringify({ ...original, hostPort: 70000 }), ' '.repeat(4097)]) {
        fs.writeFileSync(target, bytes);
        const [check] = inspectBindingPermissions(options);
        assert.equal(check.code, 'BINDING_INVALID_RECORD');
        assert.equal(check.repairEligible, false);
        assert.throws(() => repairBindingPermissions(options), { code: 'BINDING_INVALID_RECORD' });
        assert.equal(fs.statSync(target).mode & 0o777, 0o644);
    }
});

test('unreadable binding state is reported without exposing error text', (t) => {
    const { options, write } = fixture(t);
    write(0o644);
    const fsApi = { ...fs, openSync() { throw Object.assign(new Error('sensitive failure'), { code: 'EACCES' }); } };
    const [check] = inspectBindingPermissions({ ...options, fsApi });
    assert.equal(check.code, 'BINDING_UNREADABLE');
    assert.equal(check.repairEligible, false);
    assert.doesNotMatch(JSON.stringify(check), /sensitive failure/);
});

test('binding repair requires the selected workspace mutation lock', (t) => {
    const { options, target, write } = fixture(t);
    write(0o644);
    assert.throws(() => repairBindingPermissions({ ...options, lock: undefined }), { code: 'BINDING_LOCK_REQUIRED' });
    assert.throws(() => repairBindingPermissions({ ...options, lock: { assertHeld() { throw new Error('wrong workspace'); } } }), /wrong workspace/);
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
});

test('replacement between snapshot and repair descriptor open is detected before chmod', (t) => {
    const { options, target, write } = fixture(t);
    const bytes = write(0o644);
    let opens = 0;
    const fsApi = { ...fs, openSync(filename, flags) {
        if (filename === target && ++opens === 2) {
            fs.renameSync(target, `${target}.original`);
            fs.writeFileSync(target, bytes, { mode: 0o644 });
        }
        return fs.openSync(filename, flags);
    }, fchmodSync() { assert.fail('must not chmod a replaced file'); } };
    assert.throws(() => repairBindingPermissions({ ...options, fsApi }), { code: 'BINDING_UNSAFE_PATH' });
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
    assert.equal(fs.statSync(`${target}.original`).mode & 0o777, 0o644);
});

test('a newly shared-writable record is rejected on fresh repair inspection', (t) => {
    const { options, target, write } = fixture(t);
    write(0o644);
    assert.equal(inspectBindingPermissions(options)[0].repairEligible, true);
    fs.chmodSync(target, 0o666);
    assert.throws(() => repairBindingPermissions(options), { code: 'BINDING_SHARED_WRITE' });
    assert.equal(fs.statSync(target).mode & 0o777, 0o666);
});

test('replacement during descriptor chmod is reported and never changes the replacement', (t) => {
    const { options, target, write } = fixture(t);
    const bytes = write(0o644);
    const fsApi = { ...fs, fchmodSync(descriptor, mode) {
        fs.renameSync(target, `${target}.original`);
        fs.writeFileSync(target, bytes, { mode: 0o644 });
        fs.fchmodSync(descriptor, mode);
    } };
    assert.throws(() => repairBindingPermissions({ ...options, fsApi }), { code: 'BINDING_UNSAFE_PATH' });
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
});

test('content edits during permission repair cannot be reported as success', (t) => {
    const { options, target, write } = fixture(t);
    write(0o644);
    const fsApi = { ...fs, fchmodSync(descriptor, mode) {
        fs.fchmodSync(descriptor, mode);
        fs.writeFileSync(target, '{}');
    } };
    assert.throws(() => repairBindingPermissions({ ...options, fsApi }), { code: 'BINDING_UNSAFE_PATH' });
});
