import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    INTERACTIVE_PLOINKY_UPDATE_MESSAGE,
    PLOINKY_BOX_MARKER_PATH,
    checkGitUpstreamUpdate,
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

const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Unit Test',
    GIT_AUTHOR_EMAIL: 'unit@example.invalid',
    GIT_COMMITTER_NAME: 'Unit Test',
    GIT_COMMITTER_EMAIL: 'unit@example.invalid',
};

function git(cwd, ...args) {
    return String(execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
}

function commitFile(checkout, name, content) {
    fs.writeFileSync(path.join(checkout, name), content);
    git(checkout, 'add', name);
    git(checkout, 'commit', '-q', '-m', name);
    return git(checkout, 'rev-parse', 'HEAD');
}

test('interactive upstream check reads the remote without writing a ref', () => {
    const root = tempDir('ploinky-upstream-check-');
    try {
        const remote = path.join(root, 'remote.git');
        const checkout = path.join(root, 'checkout');
        const other = path.join(root, 'other');
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: GIT_ENV });
        execFileSync('git', ['clone', '-q', remote, other], { env: GIT_ENV, stdio: 'ignore' });
        git(other, 'checkout', '-q', '-b', 'main');
        commitFile(other, 'a.txt', 'one\n');
        git(other, 'push', '-q', 'origin', 'main');
        execFileSync('git', ['clone', '-q', '-b', 'main', remote, checkout], { env: GIT_ENV, stdio: 'ignore' });

        const current = checkGitUpstreamUpdate(checkout);
        assert.equal(current.available, false);
        assert.equal(current.head, current.upstream);
        assert.equal(current.upstreamRef, 'origin/main');

        const tracking = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
        const newer = commitFile(other, 'b.txt', 'two\n');
        git(other, 'push', '-q', 'origin', 'main');
        const ahead = checkGitUpstreamUpdate(checkout);
        assert.equal(ahead.available, true, 'a missing upstream commit is a newer version');
        assert.equal(ahead.upstream, newer);
        assert.equal(git(checkout, 'rev-parse', 'refs/remotes/origin/main'), tracking, 'the remote-tracking ref was not written');
        assert.throws(() => git(checkout, 'cat-file', '-e', newer), undefined, 'no object was fetched');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('interactive upstream check is bounded when the remote transport hangs', async () => {
    const root = tempDir('ploinky-upstream-hang-');
    const pidFile = path.join(root, 'transport.pid');
    try {
        const checkout = path.join(root, 'checkout');
        execFileSync('git', ['init', '-q', '-b', 'main', checkout], { env: GIT_ENV });
        commitFile(checkout, 'a.txt', 'one\n');
        git(checkout, 'remote', 'add', 'origin', 'ssh://ploinky-hang.invalid/repo.git');
        git(checkout, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
        git(checkout, 'branch', '--set-upstream-to=origin/main', 'main');
        // The transport records its PID, detaches from Git's stderr and never answers.
        const transport = path.join(root, 'hanging-ssh');
        fs.writeFileSync(transport, `#!/bin/sh\necho $$ > "${pidFile}"\nexec 2>/dev/null\nexec sleep 60\n`);
        fs.chmodSync(transport, 0o755);

        const moduleUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../cli/commands/updateService.js')).href;
        const started = Date.now();
        const outcome = await new Promise(resolve => {
            execFile(process.execPath, ['--input-type=module', '-e', `
                const { checkGitUpstreamUpdate } = await import(${JSON.stringify(moduleUrl)});
                try {
                    checkGitUpstreamUpdate(${JSON.stringify(checkout)}, { timeoutMs: 1500 });
                    process.stdout.write('RETURNED');
                } catch (error) {
                    process.stdout.write('THREW:' + error.message);
                }
            `], {
                env: { ...GIT_ENV, GIT_SSH_COMMAND: transport, GIT_SSH_VARIANT: 'simple' },
                encoding: 'utf8',
                timeout: 20_000,
                killSignal: 'SIGKILL',
            }, (error, stdout) => resolve({ error, stdout: String(stdout || '') }));
        });
        const elapsed = Date.now() - started;

        assert.equal(outcome.error, null, `the probe process finished on its own: ${outcome.error?.message}`);
        assert.match(outcome.stdout, /^THREW:Ploinky upstream check failed: .*ls-remote.*: timed out/s);
        assert.ok(elapsed < 15_000, `the hanging remote was bounded (${elapsed} ms)`);
        assert.ok(fs.existsSync(pidFile), 'the probe reached the hanging transport');
    } finally {
        if (fs.existsSync(pidFile)) {
            const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
            if (Number.isInteger(pid) && pid > 0) {
                try { process.kill(pid, 'SIGKILL'); } catch (_) {}
            }
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
