import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    pathContains,
    resolvePloinkyUpdateEligibility,
    resolvePloinkyUpdateScope,
} from '../../cli/commands/ploinkyUpdateScope.js';

test('path containment is segment-safe in both update directions', () => {
    assert.equal(pathContains('/projects/demo', '/projects/demo/ploinky'), true);
    assert.equal(pathContains('/projects/demo/ploinky', '/projects/demo/ploinky/src'), true);
    assert.equal(pathContains('/projects/demo', '/projects/demo-other/ploinky'), false);
});

test('the current folder, its Ploinky child, and a folder inside Ploinky are eligible', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-scope-'));
    const checkout = path.join(root, 'projects', 'ploinky');
    const nested = path.join(checkout, 'src');
    try {
        fs.mkdirSync(nested, { recursive: true });
        const parentPlan = resolvePloinkyUpdateEligibility({
            repoPath: checkout,
            updateScopePath: path.join(root, 'projects'),
        });
        assert.equal(parentPlan.eligible, true);

        const nestedPlan = resolvePloinkyUpdateEligibility({
            repoPath: checkout,
            updateScopePath: nested,
        });
        assert.equal(nestedPlan.eligible, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('canonical containment rejects a Ploinky symlink that escapes the selected folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-scope-symlink-'));
    const scope = path.join(root, 'workspace');
    const checkout = path.join(root, 'installed-ploinky');
    const alias = path.join(scope, 'ploinky');
    try {
        fs.mkdirSync(scope);
        fs.mkdirSync(checkout);
        fs.symlinkSync(checkout, alias, 'dir');
        const plan = resolvePloinkyUpdateEligibility({
            repoPath: alias,
            updateScopePath: scope,
        });
        assert.equal(plan.eligible, false);
        assert.equal(plan.checkoutRoot, fs.realpathSync.native(checkout));
        assert.match(plan.reason, /outside the selected update folder/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an explicit relative update folder resolves from the launch directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-scope-relative-'));
    const child = path.join(root, 'child');
    try {
        fs.mkdirSync(child);
        assert.equal(
            resolvePloinkyUpdateScope('child', { cwd: () => root }),
            fs.realpathSync.native(child),
        );
        assert.throws(
            () => resolvePloinkyUpdateScope('missing', { cwd: () => root }),
            /does not exist or cannot be resolved/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an absolute update folder does not require a readable launch directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-scope-absolute-'));
    try {
        assert.equal(
            resolvePloinkyUpdateScope(root, {
                cwd() { throw new Error('absolute paths must not consult cwd'); },
            }),
            fs.realpathSync.native(root),
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
