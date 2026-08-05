import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
    hostSourceLockIdentity,
    updateHostPloinkySource,
} from '../../ploinky-box/command/hostUpdate.mjs';

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
        assert.equal(events[2][1].interactiveSession, false);
    } finally {
        fs.rmSync(alias, { force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('host source update releases its lock on failure and rejects skipped updates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-host-update-failure-'));
    try {
        for (const updateSelf of [
            () => { throw new Error('pull failed'); },
            () => ({ skipped: true, reason: 'not a git repository' }),
        ]) {
            let released = false;
            await assert.rejects(() => updateHostPloinkySource({
                repositoryRoot: root,
                lockManager: {
                    async acquire() {
                        return {
                            assertHeld() {},
                            release() { released = true; },
                        };
                    },
                },
                updateSelf,
            }));
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
        git(seed, ['branch', '-M', 'ploinky-proxy']);
        git(seed, ['remote', 'add', 'origin', remote]);
        git(seed, ['push', '--set-upstream', 'origin', 'ploinky-proxy']);
        execFileSync('git', ['clone', '--branch', 'ploinky-proxy', remote, checkout], { stdio: 'ignore' });

        fs.writeFileSync(path.join(seed, 'version.txt'), 'two\n');
        git(seed, ['add', 'version.txt']);
        git(seed, ['commit', '-m', 'advance']);
        git(seed, ['push']);

        const options = {
            repositoryRoot: checkout,
            lockManager,
            boxMarkerPath: path.join(root, 'not-a-box'),
        };
        const first = await updateHostPloinkySource(options);
        assert.equal(first.updated, true);
        assert.equal(fs.readFileSync(path.join(checkout, 'version.txt'), 'utf8'), 'two\n');
        assert.equal(
            String(git(checkout, ['rev-parse', 'HEAD'])).trim(),
            String(git(checkout, ['rev-parse', '@{u}'])).trim(),
        );

        const second = await updateHostPloinkySource(options);
        assert.equal(second.updated, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
