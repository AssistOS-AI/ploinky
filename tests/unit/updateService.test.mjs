import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    INTERACTIVE_PLOINKY_UPDATE_MESSAGE,
    PLOINKY_BOX_MARKER_PATH,
    updatePloinkySelf,
} from '../../cli/commands/updateService.js';
import { createOperationRecord } from '../../cli/commands/updateOutcome.js';
import { GitUpdateError } from '../../cli/utils/git/verifiedUpdate.js';
import { ploinkySourceLockIdentity } from '../../cli/utils/git/sourceLock.js';

function tempDir(prefix = 'ploinky-update-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 4));
}

test('interactive Ploinky self-update is deferred when upstream has a new version', async () => {
    const root = tempDir();
    const warnings = [];

    try {
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });

        const result = await updatePloinkySelf({
            repoPath: root,
            interactiveSession: true,
            logger: { warn(message) { warnings.push(message); } },
            checkUpdate() {
                return {
                    available: true,
                    head: 'old-head',
                    upstream: 'new-head',
                };
            },
            updateCheckout() {
                throw new Error('interactive update must not update the checkout');
            },
            sourceLockManager: {
                async acquire() { throw new Error('interactive update must not take the source lock'); },
            },
        });

        assert.equal(result.deferred, true);
        assert.equal(result.updateAvailable, true);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0], INTERACTIVE_PLOINKY_UPDATE_MESSAGE);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function fakeRecord(outcome, code, { before = 'old-head', after = 'new-head' } = {}) {
    return createOperationRecord({
        phase: 'host-ploinky', id: 'checkout', outcome, code, reason: code,
        before: { head: before }, after: { head: after },
    });
}

function recordingLockManager(events) {
    return {
        async acquire(identity) {
            events.push(['acquire', identity]);
            return {
                assertHeld(value) { events.push(['held', value]); },
                release() { events.push(['release', identity]); },
            };
        },
    };
}

test('non-interactive Ploinky self-update fast-forwards under the host source lock', async () => {
    const root = tempDir();
    const events = [];

    try {
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });
        const expected = ploinkySourceLockIdentity(root);

        const result = await updatePloinkySelf({
            repoPath: root,
            sourceLockManager: recordingLockManager(events),
            boxMarkerPath: path.join(root, 'not-a-box'),
            updateCheckout(options) {
                events.push(['update', options]);
                return fakeRecord('changed', 'fast-forward');
            },
        });

        assert.equal(result.updated, true);
        assert.equal(result.before, 'old-head');
        assert.equal(result.after, 'new-head');
        assert.equal(result.pullStrategy, 'fast-forward-only');
        assert.equal(result.record.outcome, 'changed');
        assert.deepEqual(events.map(entry => entry[0]), ['acquire', 'held', 'update', 'release']);
        assert.equal(events[0][1], expected.lockIdentity);
        assert.equal(events[2][1].repoPath, expected.canonicalRoot);
        assert.equal(events[2][1].phase, 'host-ploinky');
        assert.deepEqual(events[2][1].policy, { kind: 'generic' });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Ploinky self-update returns named skips, throws other outcomes with the record and always releases the source lock', async () => {
    const root = tempDir();

    try {
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });
        const events = [];
        const skipped = await updatePloinkySelf({
            repoPath: root,
            sourceLockManager: recordingLockManager(events),
            boxMarkerPath: path.join(root, 'not-a-box'),
            updateCheckout: () => fakeRecord('skipped', 'dirty-worktree'),
        });
        assert.equal(skipped.skipped, true);
        assert.equal(skipped.code, 'dirty-worktree');
        assert.equal(skipped.record.outcome, 'skipped');
        assert.equal(events.at(-1)[0], 'release');

        for (const outcome of ['failed', 'uncertain']) {
            const failureEvents = [];
            await assert.rejects(() => updatePloinkySelf({
                repoPath: root,
                sourceLockManager: recordingLockManager(failureEvents),
                boxMarkerPath: path.join(root, 'not-a-box'),
                updateCheckout: () => fakeRecord(outcome, 'fetch-failed'),
            }), error => {
                assert.ok(error instanceof GitUpdateError);
                assert.equal(error.record.outcome, outcome);
                return true;
            });
            assert.equal(failureEvents.at(-1)[0], 'release');
        }

        const thrownEvents = [];
        await assert.rejects(() => updatePloinkySelf({
            repoPath: root,
            sourceLockManager: recordingLockManager(thrownEvents),
            boxMarkerPath: path.join(root, 'not-a-box'),
            updateCheckout: () => { throw new Error('unexpected'); },
        }), /unexpected/);
        assert.equal(thrownEvents.at(-1)[0], 'release');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Ploinky self-update reuses a held source lock only for the same checkout', async () => {
    const root = tempDir();
    const other = tempDir();

    try {
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });
        const events = [];
        const lock = { assertHeld(value) { events.push(['held', value]); }, release() { events.push(['release']); } };
        const noAcquire = { async acquire() { throw new Error('a held lock must not be re-acquired'); } };
        const identity = ploinkySourceLockIdentity(root);
        const result = await updatePloinkySelf({
            repoPath: root,
            heldSourceLock: { lockIdentity: identity.lockIdentity, lock },
            sourceLockManager: noAcquire,
            boxMarkerPath: path.join(root, 'not-a-box'),
            updateCheckout: () => fakeRecord('unchanged', 'current', { after: 'old-head' }),
        });
        assert.equal(result.updated, false);
        assert.deepEqual(events, [['held', identity.lockIdentity]], 'a borrowed lock is not released by the self-update');

        await assert.rejects(() => updatePloinkySelf({
            repoPath: root,
            heldSourceLock: { lockIdentity: ploinkySourceLockIdentity(other).lockIdentity, lock },
            boxMarkerPath: path.join(root, 'not-a-box'),
            updateCheckout: () => fakeRecord('changed', 'fast-forward'),
        }), /source lock for a different checkout/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(other, { recursive: true, force: true });
    }
});

test('Ploinky self-update skips an installed checkout outside the selected folder before git', async () => {
    const root = tempDir('ploinky-update-scope-');
    const checkout = path.join(root, 'installed', 'ploinky');
    const scope = path.join(root, 'workspace');
    const warnings = [];
    const unexpected = () => {
        throw new Error('an out-of-scope checkout must not run git');
    };

    try {
        fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
        fs.mkdirSync(scope);
        const result = await updatePloinkySelf({
            repoPath: checkout,
            updateScopePath: scope,
            logger: { warn(message) { warnings.push(message); } },
            checkUpdate: unexpected,
            updateCheckout: unexpected,
            sourceLockManager: { acquire: unexpected },
        });

        assert.equal(result.skipped, true);
        assert.equal(result.scopeExcluded, true);
        assert.match(result.reason, /outside the selected update folder/);
        assert.equal(result.repoPath, fs.realpathSync.native(checkout));
        assert.equal(result.updateScopePath, fs.realpathSync.native(scope));
        assert.match(warnings[0], /Skipping Ploinky self-update/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Ploinky box self-update skips the read-only source before running git operations', async () => {
    const root = tempDir();
    const warnings = [];
    const unexpected = () => {
        throw new Error('boxed self-update must not inspect or mutate the source checkout');
    };

    try {
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });

        const result = await updatePloinkySelf({
            repoPath: root,
            interactiveSession: true,
            exists(filePath) {
                assert.equal(filePath, PLOINKY_BOX_MARKER_PATH);
                return true;
            },
            logger: { warn(message) { warnings.push(message); } },
            checkUpdate: unexpected,
            updateCheckout: unexpected,
            sourceLockManager: { acquire: unexpected },
        });

        assert.deepEqual(result, {
            skipped: true,
            boxed: true,
            reason: 'Ploinky source is mounted read-only inside ploinky-box',
            repoPath: root,
        });
        assert.deepEqual(warnings, [
            `Skipping Ploinky self-update inside ploinky-box: ${root} is mounted read-only.`,
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
