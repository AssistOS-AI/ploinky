import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
    __MISSING_CWD_MESSAGE,
    materializeIdentityAnchor,
    resolveWorkspaceIdentity,
    workspacePathHash,
} from '../../ploinky-box/identity.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-identity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function currentResolver({ cwd, explicitRoot = '' }) {
    const configUrl = pathToFileURL(path.join(repositoryRoot, 'cli/utils/config.js')).href;
    const script = [
        `import { PLOINKY_WORKSPACE_ROOT } from ${JSON.stringify(configUrl)};`,
        'process.stdout.write(PLOINKY_WORKSPACE_ROOT);',
    ].join('\n');
    const env = { ...process.env };
    if (explicitRoot) {
        env.PLOINKY_WORKSPACE_ROOT = explicitRoot;
    } else {
        delete env.PLOINKY_WORKSPACE_ROOT;
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd,
        env,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

test('resolver matches explicit, fallback, marker, and nearest-marker behavior', (t) => {
    const root = fixture(t);
    const explicit = path.join(root, 'explicit');
    const outer = path.join(root, 'outer');
    const inner = path.join(outer, 'inner');
    const child = path.join(inner, 'child');
    fs.mkdirSync(explicit);
    fs.mkdirSync(path.join(outer, '.ploinky'), { recursive: true });
    fs.mkdirSync(path.join(inner, '.ploinky'), { recursive: true });
    fs.mkdirSync(child);

    assert.equal(resolveWorkspaceIdentity({
        env: { PLOINKY_WORKSPACE_ROOT: explicit },
        cwd: () => child,
    }).workspaceRoot, explicit);
    assert.equal(resolveWorkspaceIdentity({
        env: { PLOINKY_WORKSPACE_ROOT: path.join(root, 'missing') },
        cwd: () => child,
    }).workspaceRoot, inner);
    assert.equal(resolveWorkspaceIdentity({ env: {}, cwd: () => outer }).workspaceRoot, outer);
    assert.equal(resolveWorkspaceIdentity({ env: {}, cwd: () => child }).workspaceRoot, inner);
    const currentFromChild = currentResolver({ cwd: child });
    assert.equal(resolveWorkspaceIdentity({
        env: {},
        cwd: () => currentFromChild,
    }).workspaceRoot, currentFromChild);
    assert.equal(currentResolver({ cwd: child, explicitRoot: explicit }), explicit);
});

test('markerless resolution is read-only and produces opaque deterministic names', (t) => {
    const root = fixture(t);
    const workspace = path.join(root, 'A secret workspace!');
    fs.mkdirSync(workspace);
    const before = fs.readdirSync(workspace);

    const identity = resolveWorkspaceIdentity({ env: {}, cwd: () => workspace });

    assert.deepEqual(fs.readdirSync(workspace), before);
    assert.equal(identity.markerFound, false);
    assert.match(identity.instance, /^ploinky-box-a-secret-workspace-[a-f0-9]{12}$/);
    assert.equal(identity.pathHash, workspacePathHash(workspace));
    assert.equal(identity.instance.includes(root), false);
    assert.equal(identity.volumes, undefined);
    assert.equal(identity.legacyVolumes, undefined);
    assert.equal(identity.anchorPath, path.join(workspace, '.ploinky'));
    assert.equal(identity.boxDataRoot, path.join(workspace, '.ploinky', 'box'));
    assert.deepEqual(identity.dataPaths, {
        dependencies: path.join(workspace, '.ploinky', 'box', 'dependencies'),
        images: path.join(workspace, '.ploinky', 'box', 'images'),
    });
    // Versionless semantic identity: workspace-backed persistence adds no
    // generation or schema suffix to any public path.
    for (const dataPath of Object.values(identity.dataPaths)) {
        assert.doesNotMatch(dataPath, /-v[0-9]+$|-gen[0-9]*$/);
    }
    assert.equal(Object.isFrozen(identity.dataPaths), true);
    assert.throws(() => { identity.dataPaths.images = '/tmp/elsewhere'; }, TypeError);
});

test('invalid explicit roots and symlink strings retain current resolver semantics', (t) => {
    const root = fixture(t);
    const target = path.join(root, 'target');
    const link = path.join(root, 'linked-workspace');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'dir');

    const identity = resolveWorkspaceIdentity({
        env: { PLOINKY_WORKSPACE_ROOT: link },
        cwd: () => root,
    });
    assert.equal(identity.workspaceRoot, currentResolver({ cwd: root, explicitRoot: link }));
    assert.equal(identity.workspaceRoot, link);
});

test('missing cwd reproduces the current diagnostic without mutating', () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    assert.throws(
        () => resolveWorkspaceIdentity({ env: {}, cwd: () => { throw missing; } }),
        (error) => error.message === __MISSING_CWD_MESSAGE,
    );
});

test('anchor materialization requires the matching lock and rejects unsafe targets', (t) => {
    const root = fixture(t);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    fs.chmodSync(workspace, 0o775);
    const identity = resolveWorkspaceIdentity({ env: {}, cwd: () => workspace });
    const lock = {
        assertHeld(instance) {
            assert.equal(instance, identity.instance);
        },
    };

    assert.throws(() => materializeIdentityAnchor(identity, null), /requires its mutation lock/);
    const created = materializeIdentityAnchor(identity, lock);
    assert.equal(created.created, true);
    assert.equal(created.path, path.join(workspace, '.ploinky'));
    assert.equal(created.rootFingerprint.mode & 0o777, 0o755);
    assert.equal(created.anchorFingerprint.mode & 0o777, 0o700);
    assert.equal(fs.statSync(workspace).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(workspace, '.ploinky')).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(path.join(workspace, '.ploinky')), []);
    const refreshed = resolveWorkspaceIdentity({ env: {}, cwd: () => workspace });
    assert.equal(materializeIdentityAnchor(refreshed, lock).created, false);

    fs.rmdirSync(path.join(workspace, '.ploinky'));
    fs.writeFileSync(path.join(workspace, '.ploinky'), 'foreign');
    assert.throws(() => materializeIdentityAnchor(refreshed, lock), /not a directory/);
    fs.unlinkSync(path.join(workspace, '.ploinky'));
    fs.symlinkSync(root, path.join(workspace, '.ploinky'), 'dir');
    assert.throws(() => materializeIdentityAnchor(refreshed, lock), /not a directory/);
});

test('permission materialization removes write bits without adding user permissions', (t) => {
    const root = fixture(t);
    const workspace = path.join(root, 'workspace');
    const anchor = path.join(workspace, '.ploinky');
    fs.mkdirSync(anchor, { recursive: true });
    fs.chmodSync(workspace, 0o700);
    fs.chmodSync(anchor, 0o775);
    const identity = resolveWorkspaceIdentity({ env: {}, cwd: () => workspace });
    const result = materializeIdentityAnchor(identity, { assertHeld() {} });

    assert.equal(result.created, false);
    assert.equal(fs.statSync(workspace).mode & 0o777, 0o700);
    assert.equal(fs.statSync(anchor).mode & 0o777, 0o700);
});

test('anchor materialization fails closed on a concurrent EEXIST', (t) => {
    const root = fixture(t);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const identity = resolveWorkspaceIdentity({ env: {}, cwd: () => workspace });
    const error = Object.assign(new Error('changed'), { code: 'EEXIST' });
    assert.throws(() => materializeIdentityAnchor(identity, {
        assertHeld() {},
    }, {
        mkdirSync() { throw error; },
    }), /changed concurrently/);
});
