import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
    hostSourceLockIdentity,
    isPloinkySourceCheckout,
    updateHostPloinkySource,
    updateWorkspacePloinkySource,
} from '../../ploinky-box/command/hostUpdate.mjs';
import { updatePloinkySelf } from '../../cli/commands/updateService.js';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';

function seedPloinkySource(repoPath) {
    fs.mkdirSync(path.join(repoPath, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(repoPath, 'ploinky-box', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
        name: 'ploinky-cloud',
        bin: { ploinky: './bin/ploinky' },
    }));
    fs.writeFileSync(path.join(repoPath, 'bin', 'ploinky'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(repoPath, 'ploinky-box', 'bin', 'ploinky-box.mjs'), '// fixture\n');
}

test('host source update uses one canonical source lock and releases it after the pull', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-host-update-'));
    const alias = path.join(path.dirname(root), `${path.basename(root)}-alias`);
    const events = [];
    try {
        fs.symlinkSync(root, alias, 'dir');
        const expected = hostSourceLockIdentity(root);
        assert.deepEqual(hostSourceLockIdentity(alias), expected);
        const result = await updateHostPloinkySource({
            repositoryRoot: alias,
            updateScopeRoot: root,
            lockManager: {
                async acquire(identity) {
                    events.push(['acquire', identity]);
                    return {
                        assertHeld(value) { events.push(['held', value]); },
                        release() { events.push(['release', identity]); },
                    };
                },
            },
            updateSelf(options) {
                events.push(['update', options]);
                return { updated: true, before: 'old', after: 'new' };
            },
        });
        assert.equal(result.updated, true);
        assert.equal(result.canonicalRoot, fs.realpathSync.native(root));
        assert.deepEqual(events.map((entry) => entry[0]), ['acquire', 'held', 'update', 'release']);
        assert.equal(events[0][1], expected.lockIdentity);
        assert.equal(events[2][1].repoPath, expected.canonicalRoot);
        assert.equal(events[2][1].updateScopePath, expected.canonicalRoot);
        assert.equal(events[2][1].interactiveSession, false);
        assert.equal(events[2][1].phase, 'host-ploinky');
        assert.equal(events[2][1].heldSourceLock.lockIdentity, expected.lockIdentity,
            'the self-update reuses the held source lock instead of re-acquiring it');
    } finally {
        fs.rmSync(alias, { force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('host source update releases its lock on failure and rejects skipped updates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-host-update-failure-'));
    try {
        const dirty = { outcome: 'skipped', code: 'dirty-worktree', reason: 'uncommitted changes are present' };
        for (const updateSelf of [
            () => { throw new Error('pull failed'); },
            () => ({ skipped: true, reason: 'not a git repository' }),
            () => ({ skipped: true, code: 'dirty-worktree', reason: dirty.reason, record: dirty }),
        ]) {
            let released = false;
            await assert.rejects(() => updateHostPloinkySource({
                repositoryRoot: root,
                updateScopeRoot: root,
                lockManager: {
                    async acquire() {
                        return {
                            assertHeld() {},
                            release() { released = true; },
                        };
                    },
                },
                updateSelf,
            }), error => {
                if (updateSelf.toString().includes('dirty')) assert.equal(error.record, dirty);
                return true;
            });
            assert.equal(released, true);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('host source update pulls its configured upstream and is idempotent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-host-update-git-'));
    const remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    const checkout = path.join(root, 'checkout');
    const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lockManager = {
        async acquire(identity) {
            return {
                assertHeld(value) { assert.equal(value, identity); },
                release() {},
            };
        },
    };
    try {
        execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
        fs.mkdirSync(seed);
        git(seed, ['init']);
        git(seed, ['config', 'user.email', 'ploinky-test@example.invalid']);
        git(seed, ['config', 'user.name', 'Ploinky Test']);
        fs.writeFileSync(path.join(seed, 'version.txt'), 'one\n');
        git(seed, ['add', 'version.txt']);
        git(seed, ['commit', '-m', 'initial']);
        git(seed, ['branch', '-M', 'feature-agentlib']);
        git(seed, ['remote', 'add', 'origin', remote]);
        git(seed, ['push', '--set-upstream', 'origin', 'feature-agentlib']);
        execFileSync('git', ['clone', '--branch', 'feature-agentlib', remote, checkout], { stdio: 'ignore' });

        fs.writeFileSync(path.join(seed, 'version.txt'), 'two\n');
        git(seed, ['add', 'version.txt']);
        git(seed, ['commit', '-m', 'advance']);
        git(seed, ['push']);

        const options = {
            repositoryRoot: checkout,
            updateScopeRoot: checkout,
            lockManager,
            boxMarkerPath: path.join(root, 'not-a-box'),
        };
        const first = await updateHostPloinkySource(options);
        assert.equal(first.updated, true);
        assert.equal(first.pullStrategy, 'fast-forward-only');
        assert.equal(first.record.outcome, 'changed');
        assert.equal(fs.readFileSync(path.join(checkout, 'version.txt'), 'utf8'), 'two\n');
        assert.equal(
            String(git(checkout, ['rev-parse', 'HEAD'])).trim(),
            String(git(checkout, ['rev-parse', '@{u}'])).trim(),
        );

        const second = await updateHostPloinkySource(options);
        assert.equal(second.updated, false);
        assert.equal(second.record.code, 'current');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('host source update outside the selected folder skips before locking or running git', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-host-update-scope-'));
    const checkout = path.join(root, 'checkout');
    const scope = path.join(root, 'workspace');
    fs.mkdirSync(checkout);
    fs.mkdirSync(scope);
    try {
        const result = await updateHostPloinkySource({
            repositoryRoot: checkout,
            updateScopeRoot: scope,
            lockManager: {
                async acquire() {
                    throw new Error('an excluded checkout must not acquire a source lock');
                },
            },
            updateSelf() {
                throw new Error('an excluded checkout must not run git');
            },
        });
        assert.equal(result.skipped, true);
        assert.equal(result.scopeExcluded, true);
        assert.match(result.reason, /outside the selected update folder/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('workspace Ploinky update skips an absent checkout and avoids pulling the host checkout twice', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-workspace-update-skip-'));
    const workspaceRoot = path.join(root, 'workspace');
    const identity = {
        workspaceRoot,
        instance: 'ploinky-box-workspace-123456789abc',
    };
    const lock = {
        assertHeld(instance) {
            assert.equal(instance, identity.instance);
        },
    };
    try {
        fs.mkdirSync(workspaceRoot);
        const missing = await updateWorkspacePloinkySource({
            identity,
            lock,
            repositoryRoot: root,
            updateScopeRoot: workspaceRoot,
            updateSelf() {
                throw new Error('an absent checkout must not be pulled');
            },
        });
        assert.equal(missing.found, false);
        assert.equal(missing.skipped, true);

        const checkout = path.join(workspaceRoot, 'ploinky');
        fs.mkdirSync(checkout);
        execFileSync('git', ['init', '-q', checkout], { stdio: 'ignore' });
        seedPloinkySource(checkout);
        assert.equal(isPloinkySourceCheckout(checkout), true);
        const duplicate = await updateWorkspacePloinkySource({
            identity,
            lock,
            repositoryRoot: checkout,
            updateScopeRoot: workspaceRoot,
            updateSelf() {
                throw new Error('the host checkout must not be pulled twice');
            },
        });
        assert.equal(duplicate.found, true);
        assert.equal(duplicate.skipped, true);
        assert.equal(duplicate.duplicateOfHost, true);
        assert.equal(duplicate.boxRepoPath, path.join(workspaceRoot, 'ploinky'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('workspace Ploinky Git config is delegated without executing host hooks or acquiring source locks', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-workspace-delegation-')));
    const workspaceRoot = path.join(root, 'workspace');
    const checkout = path.join(workspaceRoot, 'ploinky');
    const hostSource = path.join(root, 'host-source');
    const marker = path.join(hostSource, 'hook-ran');
    try {
        fs.mkdirSync(checkout, { recursive: true });
        fs.mkdirSync(hostSource);
        execFileSync('git', ['init', '-q', checkout]);
        seedPloinkySource(checkout);
        const hook = path.join(workspaceRoot, 'monitor');
        fs.writeFileSync(hook, '#!/bin/sh\nprintf invoked > "' + marker + '"\nprintf "token\\0"\n', { mode: 0o700 });
        execFileSync('git', ['-C', checkout, 'config', 'core.fsmonitor', hook]);
        const before = fs.readFileSync(path.join(checkout, '.git', 'config'));
        const result = await updateWorkspacePloinkySource({
            identity: { workspaceRoot, instance: 'fixture' }, lock: { assertHeld() {} },
            repositoryRoot: hostSource, updateScopeRoot: workspaceRoot,
            sourceLockManager: { acquire() { throw new Error('host source mutation forbidden'); } },
        });
        assert.equal(result.deferredToCore, true);
        assert.equal(result.delegatedBoxRepoPath, checkout);
        assert.equal(result.boxRepoPath, undefined, 'delegation must never exclude the source from Core');
        assert.equal(fs.existsSync(marker), false);
        assert.deepEqual(fs.readFileSync(path.join(checkout, '.git', 'config')), before);
        // Dirty user files do not change the host's selection-only authority.
        fs.writeFileSync(path.join(checkout, 'user-edit'), 'preserve me');
        const again = await updateWorkspacePloinkySource({
            identity: { workspaceRoot, instance: 'fixture' }, lock: { assertHeld() {} },
            repositoryRoot: hostSource, updateScopeRoot: workspaceRoot,
        });
        assert.equal(again.deferredToCore, true);
        assert.equal(fs.readFileSync(path.join(checkout, 'user-edit'), 'utf8'), 'preserve me');
        assert.equal(fs.existsSync(marker), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('workspace update accepts a command launched inside Ploinky and rejects a symlink escape', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-workspace-update-scope-'));
    const workspaceRoot = path.join(root, 'workspace');
    const checkout = path.join(workspaceRoot, 'ploinky');
    const nested = path.join(checkout, 'src', 'nested');
    const outsideCheckout = path.join(root, 'outside-ploinky');
    const identity = {
        workspaceRoot,
        instance: 'ploinky-box-workspace-123456789abc',
    };
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); } };
    try {
        fs.mkdirSync(nested, { recursive: true });
        execFileSync('git', ['init', '-q', checkout], { stdio: 'ignore' });
        seedPloinkySource(checkout);
        fs.mkdirSync(outsideCheckout);
        execFileSync('git', ['init', '-q', outsideCheckout], { stdio: 'ignore' });
        seedPloinkySource(outsideCheckout);

        let updatedPath = '';
        const nestedResult = await updateWorkspacePloinkySource({
            identity,
            lock,
            repositoryRoot: outsideCheckout,
            updateScopeRoot: nested,
            updateSelf(options) {
                updatedPath = options.repoPath;
                return { updated: false };
            },
        });
        assert.equal(nestedResult.deferredToCore, true);
        assert.equal(nestedResult.delegatedBoxRepoPath, checkout);
        assert.equal(updatedPath, '', 'the host must not execute workspace Git');

        fs.rmSync(checkout, { recursive: true, force: true });
        fs.symlinkSync(outsideCheckout, checkout, 'dir');
        const escaped = await updateWorkspacePloinkySource({
            identity,
            lock,
            repositoryRoot: root,
            updateScopeRoot: workspaceRoot,
            updateSelf() {
                throw new Error('a symlink escape must not be updated');
            },
        });
        assert.equal(escaped.skipped, true);
        assert.match(escaped.reason, /not a real directory/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
