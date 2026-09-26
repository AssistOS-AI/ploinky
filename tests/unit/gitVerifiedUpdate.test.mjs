import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    GitUpdateError,
    parsePorcelainV2,
    resolveCheckoutIdentity,
    throwUnlessVerified,
    updateCheckoutFastForward,
} from '../../cli/utils/git/verifiedUpdate.js';
import { buildGitEnvironment, runGit } from '../../cli/utils/git/gitExec.js';
import {
    CHECKOUT_LOCK_NAME,
    acquireCheckoutLock,
    ownerIsProvenDead,
    readProcessScope,
} from '../../cli/utils/git/checkoutLock.js';

// New-API tests for the verified fast-forward contract. Every fixture uses a
// local bare remote under a scratch directory with isolated Git config.

function createFixture({ branch = 'main' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-git-verified-'));
    const globalConfig = path.join(root, 'gitconfig');
    fs.writeFileSync(globalConfig, '[user]\n\tname = Ploinky Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n');
    const env = {
        ...process.env,
        HOME: root,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: '1',
    };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
    const git = (cwd, ...args) => String(execFileSync('git', ['-C', cwd, ...args], {
        env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })).trim();
    const gitRaw = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
    const remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    const checkout = path.join(root, 'checkout');
    execFileSync('git', ['init', '-q', '--bare', remote], { env });
    fs.mkdirSync(seed);
    git(seed, 'init', '-q', '-b', branch);
    fs.writeFileSync(path.join(seed, 'a.txt'), 'a1\n');
    fs.writeFileSync(path.join(seed, 'b.txt'), 'b1\n');
    fs.writeFileSync(path.join(seed, 'c.txt'), 'c1\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'initial');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-q', '-u', 'origin', branch);
    execFileSync('git', ['clone', '-q', remote, checkout], { env });
    const commit = (cwd, file, content, message = `change ${file}`) => {
        fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        fs.writeFileSync(path.join(cwd, file), content);
        git(cwd, 'add', file);
        git(cwd, 'commit', '-q', '-m', message);
        return git(cwd, 'rev-parse', 'HEAD');
    };
    const advance = (file = 'b.txt', content = 'b2\n') => {
        const sha = commit(seed, file, content);
        git(seed, 'push', '-q');
        return sha;
    };
    const update = (options = {}) => updateCheckoutFastForward({
        repoPath: checkout,
        phase: 'workspace-repository',
        env,
        lockOptions: { waitMs: 300, retryMs: 20 },
        ...options,
    });
    return { root, env, git, gitRaw, remote, seed, checkout, commit, advance, update };
}

function cleanup(fixture) {
    fs.rmSync(fixture.root, { recursive: true, force: true });
}

function listTree(dir) {
    if (!fs.existsSync(dir)) return null;
    const out = {};
    const visit = (current, prefix) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(current, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) visit(full, rel);
            else out[rel] = fs.readFileSync(full).toString('base64');
        }
    };
    visit(dir, '');
    return out;
}

// Exact state that an update must preserve when it does not advance.
function snapshot(fixture, repo = fixture.checkout) {
    const { git } = fixture;
    const gitDir = git(repo, 'rev-parse', '--absolute-git-dir');
    const files = {};
    for (const name of fs.readdirSync(repo)) {
        if (name === '.git') continue;
        const full = path.join(repo, name);
        if (fs.statSync(full).isFile()) files[name] = fs.readFileSync(full, 'utf8');
    }
    return {
        head: fixture.gitRaw(repo, 'rev-parse', '-q', '--verify', 'HEAD').stdout.trim(),
        symbolic: fixture.gitRaw(repo, 'symbolic-ref', '-q', 'HEAD').stdout.trim(),
        index: git(repo, 'ls-files', '-s'),
        staged: git(repo, 'diff', '--cached', '--binary'),
        unstaged: git(repo, 'diff', '--binary'),
        untracked: git(repo, 'ls-files', '--others', '--exclude-standard'),
        stashes: git(repo, 'stash', 'list', '--format=%H'),
        files,
        rebaseMerge: listTree(path.join(gitDir, 'rebase-merge')),
        mergeHead: fs.existsSync(path.join(gitDir, 'MERGE_HEAD')),
        privateRefs: git(repo, 'for-each-ref', 'refs/ploinky-update'),
    };
}

function tracingExec(log, { after = null, override = null } = {}) {
    return (repoPath, args, options) => {
        log.push(args.join(' '));
        const forced = override?.(args);
        if (forced) return forced;
        const result = runGit(repoPath, args, options);
        after?.(args, result);
        return result;
    };
}

test('clean fast-forward advances HEAD, updates the tracking ref and leaves no private ref', () => {
    const fx = createFixture();
    try {
        const upstream = fx.advance();
        const before = fx.git(fx.checkout, 'rev-parse', 'HEAD');
        const record = fx.update();
        assert.equal(record.outcome, 'changed');
        assert.equal(record.code, 'fast-forward');
        assert.equal(record.phase, 'workspace-repository');
        assert.equal(record.before.head, before);
        assert.equal(record.after.head, upstream);
        assert.equal(record.details.fetch.oid, upstream);
        assert.equal(fx.git(fx.checkout, 'rev-parse', 'HEAD'), upstream);
        assert.equal(fx.git(fx.checkout, 'rev-parse', '@{u}'), upstream);
        assert.equal(fs.readFileSync(path.join(fx.checkout, 'b.txt'), 'utf8'), 'b2\n');
        assert.equal(snapshot(fx).privateRefs, '');
        assert.equal(fs.existsSync(path.join(fx.checkout, '.git', CHECKOUT_LOCK_NAME)), false, 'lock released');
    } finally {
        cleanup(fx);
    }
});

test('already current and local-ahead checkouts are verified unchanged', () => {
    const fx = createFixture();
    try {
        const current = fx.update();
        assert.equal(current.outcome, 'unchanged');
        assert.equal(current.code, 'current');

        const local = fx.commit(fx.checkout, 'local.txt', 'local\n');
        const ahead = fx.update();
        assert.equal(ahead.outcome, 'unchanged');
        assert.equal(ahead.code, 'local-ahead');
        assert.equal(fx.git(fx.checkout, 'rev-parse', 'HEAD'), local);
    } finally {
        cleanup(fx);
    }
});

test('diverged history is preserved and requires manual reconciliation', () => {
    const fx = createFixture();
    try {
        fx.advance('b.txt', 'upstream\n');
        fx.commit(fx.checkout, 'c.txt', 'local\n');
        const before = snapshot(fx);
        const record = fx.update();
        assert.equal(record.outcome, 'skipped');
        assert.equal(record.code, 'diverged');
        assert.deepEqual(snapshot(fx), before);
    } finally {
        cleanup(fx);
    }
});

test('registered policy rejects an upstream mismatch and a branch mismatch before fetching', () => {
    const fx = createFixture();
    try {
        fx.git(fx.seed, 'push', '-q', 'origin', 'main:other');
        fx.git(fx.checkout, 'fetch', '-q', 'origin');
        fx.git(fx.checkout, 'branch', '--set-upstream-to=origin/other', 'main');
        fx.advance();
        const log = [];
        const before = snapshot(fx);
        const mismatch = fx.update({ policy: { kind: 'registered' }, exec: tracingExec(log) });
        assert.equal(mismatch.outcome, 'skipped');
        assert.equal(mismatch.code, 'upstream-mismatch');
        assert.match(mismatch.reason, /Refusing to pull a different source or branch/);
        assert.equal(mismatch.attempted, false);

        const branch = fx.update({ policy: { kind: 'registered', branch: 'feature' }, exec: tracingExec(log) });
        assert.equal(branch.outcome, 'skipped');
        assert.equal(branch.code, 'branch-mismatch');
        assert.equal(log.some(entry => /^(fetch|merge) /.test(entry)), false, 'no fetch or merge was attempted');
        assert.deepEqual(snapshot(fx), before);

        const generic = fx.update();
        assert.equal(generic.outcome, 'unchanged', 'a generic checkout follows its configured upstream');
        assert.equal(generic.details.fetch.ref, 'refs/heads/other');
    } finally {
        cleanup(fx);
    }
});

test('detached HEAD and missing upstream are named skips', () => {
    const fx = createFixture();
    try {
        fx.advance();
        fx.git(fx.checkout, 'checkout', '-q', '--detach');
        const before = snapshot(fx);
        const detached = fx.update();
        assert.equal(detached.outcome, 'skipped');
        assert.equal(detached.code, 'detached-head');
        assert.deepEqual(snapshot(fx), before);

        fx.git(fx.checkout, 'checkout', '-q', '-b', 'local-only');
        const noUpstream = fx.update();
        assert.equal(noUpstream.outcome, 'skipped');
        assert.equal(noUpstream.code, 'no-upstream');
    } finally {
        cleanup(fx);
    }
});

test('dirty index and dirty worktree are preserved byte-for-byte with the staged/unstaged split intact', () => {
    const fx = createFixture();
    try {
        fx.advance('a.txt', 'upstream a\n');
        fs.writeFileSync(path.join(fx.checkout, 'a.txt'), 'staged a\n');
        fx.git(fx.checkout, 'add', 'a.txt');
        fs.writeFileSync(path.join(fx.checkout, 'a.txt'), 'staged a\nplus unstaged\n');
        const before = snapshot(fx);
        assert.notEqual(before.staged, '');
        assert.notEqual(before.unstaged, '');
        const staged = fx.update();
        assert.equal(staged.outcome, 'skipped');
        assert.equal(staged.code, 'dirty-index');
        assert.equal(staged.before.staged.count, 1);
        assert.equal(staged.before.unstaged.count, 1);
        assert.deepEqual(snapshot(fx), before);

        fx.git(fx.checkout, 'reset', '-q');
        const unstagedBefore = snapshot(fx);
        const unstaged = fx.update();
        assert.equal(unstaged.outcome, 'skipped');
        assert.equal(unstaged.code, 'dirty-worktree');
        assert.deepEqual(snapshot(fx), unstagedBefore);
    } finally {
        cleanup(fx);
    }
});

test('local merge.autostash and pull.rebase settings never turn a dirty checkout into an autostash', () => {
    const fx = createFixture();
    try {
        fx.git(fx.checkout, 'config', 'merge.autostash', 'true');
        fx.git(fx.checkout, 'config', 'rebase.autostash', 'true');
        fx.git(fx.checkout, 'config', 'pull.rebase', 'true');
        const upstream = fx.advance('b.txt', 'b2\n');
        fs.writeFileSync(path.join(fx.checkout, 'c.txt'), 'dirty c\n');
        const before = snapshot(fx);
        assert.equal(fx.update().code, 'dirty-worktree');
        assert.deepEqual(snapshot(fx), before);

        fx.git(fx.checkout, 'checkout', '--', 'c.txt');
        const clean = fx.update();
        assert.equal(clean.outcome, 'changed');
        assert.equal(fx.git(fx.checkout, 'rev-parse', 'HEAD'), upstream);
        assert.equal(snapshot(fx).stashes, '');
    } finally {
        cleanup(fx);
    }
});

test('untracked content is preserved; a would-be-overwritten untracked file fails without mutation', () => {
    const fx = createFixture();
    try {
        const first = fx.advance('b.txt', 'b2\n');
        fs.writeFileSync(path.join(fx.checkout, 'notes.txt'), 'my notes\n');
        const record = fx.update();
        assert.equal(record.outcome, 'changed');
        assert.equal(fx.git(fx.checkout, 'rev-parse', 'HEAD'), first);
        assert.equal(fs.readFileSync(path.join(fx.checkout, 'notes.txt'), 'utf8'), 'my notes\n');
        assert.equal(fx.git(fx.checkout, 'ls-files', '--others', '--exclude-standard'), 'notes.txt');

        fx.advance('new.txt', 'from upstream\n');
        fs.writeFileSync(path.join(fx.checkout, 'new.txt'), 'local untracked\n');
        const before = snapshot(fx);
        const blocked = fx.update();
        assert.equal(blocked.outcome, 'failed');
        assert.equal(blocked.code, 'untracked-would-be-overwritten');
        assert.match(blocked.reason, /new\.txt/);
        assert.deepEqual(snapshot(fx), before);
    } finally {
        cleanup(fx);
    }
});

test('a fast-forward that Git refuses is a failed outcome with HEAD and bytes preserved', () => {
    const fx = createFixture();
    try {
        fx.advance();
        const before = snapshot(fx);
        const record = fx.update({
            exec: tracingExec([], {
                override: args => (args.includes('merge') && args.includes('--ff-only')
                    ? { ok: false, status: 128, signal: null, stdout: '', stderr: 'fatal: refused', error: '', timedOut: false, argv: args }
                    : null),
            }),
        });
        assert.equal(record.outcome, 'failed');
        assert.equal(record.code, 'fast-forward-refused');
        assert.deepEqual({ ...snapshot(fx) }, before);
    } finally {
        cleanup(fx);
    }
});

test('existing stash entries keep their exact object IDs', () => {
    const fx = createFixture();
    try {
        fs.writeFileSync(path.join(fx.checkout, 'a.txt'), 'stash me\n');
        fx.git(fx.checkout, 'stash', 'push', '-q', '-m', 'user stash');
        const stashes = fx.git(fx.checkout, 'stash', 'list', '--format=%H');
        assert.notEqual(stashes, '');
        const upstream = fx.advance('a.txt', 'upstream a\n');
        const record = fx.update();
        assert.equal(record.outcome, 'changed');
        assert.equal(fx.git(fx.checkout, 'rev-parse', 'HEAD'), upstream);
        assert.equal(fx.git(fx.checkout, 'stash', 'list', '--format=%H'), stashes);
        assert.deepEqual(record.before.stashes, stashes.split('\n'));
        assert.deepEqual(record.after.stashes, stashes.split('\n'));
    } finally {
        cleanup(fx);
    }
});

test('a pre-existing rebase holding an autostash in its metadata is preserved as recovery-required', () => {
    const fx = createFixture();
    try {
        fx.advance('a.txt', 'upstream a\n');
        fx.commit(fx.checkout, 'a.txt', 'local a\n');
        fs.writeFileSync(path.join(fx.checkout, 'c.txt'), 'dirty c\n');
        const pulled = fx.gitRaw(fx.checkout, 'pull', '--rebase', '--autostash');
        assert.notEqual(pulled.status, 0, 'the fixture rebase stops on a conflict');
        const before = snapshot(fx);
        assert.ok(before.rebaseMerge, 'rebase metadata exists');
        assert.ok(Object.keys(before.rebaseMerge).includes('autostash'), 'autostash lives in rebase metadata');
        assert.equal(before.stashes, '', 'the autostash is not in the stash list');

        const record = fx.update();
        assert.equal(record.outcome, 'uncertain');
        assert.equal(record.code, 'recovery-required');
        assert.deepEqual(record.before.operations.autostash, ['rebase-merge/autostash']);
        assert.deepEqual(snapshot(fx), before);
    } finally {
        cleanup(fx);
    }
});

test('a merge that exits 0 but leaves operation state or unmerged entries is failed', () => {
    for (const hookBody of [
        // Operation state left behind by a hook (git merge itself cleans
        // MERGE_HEAD after post-merge, so use another operation marker).
        'git rev-parse HEAD > "$(git rev-parse --git-dir)/CHERRY_PICK_HEAD"\n',
        // Unmerged index entries (stages 1/2/3) left behind by a hook.
        'blob=$(git rev-parse HEAD:a.txt)\n'
            + 'printf "0 0000000000000000000000000000000000000000\\ta.txt\\n100644 %s 1\\ta.txt\\n100644 %s 2\\ta.txt\\n100644 %s 3\\ta.txt\\n" "$blob" "$blob" "$blob" | git update-index --index-info\n',
    ]) {
        const fx = createFixture();
        try {
            const upstream = fx.advance();
            const hook = path.join(fx.checkout, '.git', 'hooks', 'post-merge');
            fs.mkdirSync(path.dirname(hook), { recursive: true });
            fs.writeFileSync(hook, `#!/bin/sh\n${hookBody}`);
            fs.chmodSync(hook, 0o755);
            const record = fx.update();
            assert.equal(record.outcome, 'failed', hookBody);
            assert.equal(record.code, 'conflict-after-merge');
            assert.equal(fx.git(fx.checkout, 'rev-parse', 'HEAD'), upstream, 'the evidence records the advanced HEAD');
            assert.equal(record.after.head, upstream);
        } finally {
            cleanup(fx);
        }
    }
});

test('a concurrent edit between preflight and mutation fails without overwriting it', () => {
    const fx = createFixture();
    try {
        fx.advance('b.txt', 'b2\n');
        const head = fx.git(fx.checkout, 'rev-parse', 'HEAD');
        const log = [];
        const record = fx.update({
            exec: tracingExec(log, {
                after(args, result) {
                    if (args[0] === 'fetch' && result.ok) fs.writeFileSync(path.join(fx.checkout, 'a.txt'), 'concurrent edit\n');
                },
            }),
        });
        assert.equal(record.outcome, 'failed');
        assert.equal(record.code, 'concurrent-change');
        assert.equal(fx.git(fx.checkout, 'rev-parse', 'HEAD'), head);
        assert.equal(fs.readFileSync(path.join(fx.checkout, 'a.txt'), 'utf8'), 'concurrent edit\n');
        assert.equal(log.some(entry => entry.includes('--ff-only')), false);
    } finally {
        cleanup(fx);
    }
});

test('a failed fetch is a failed outcome with sanitized diagnostics; an unreachable probe is a named skip', () => {
    const fx = createFixture();
    try {
        fx.git(fx.checkout, 'remote', 'set-url', 'origin', 'http://user:s3cr3t-token@127.0.0.1:9/repo.git');
        const before = snapshot(fx);
        const fetched = fx.update({ fetchTimeoutMs: 20_000 });
        assert.equal(fetched.outcome, 'failed');
        assert.equal(fetched.code, 'fetch-failed');
        assert.doesNotMatch(JSON.stringify(fetched), /s3cr3t-token/);
        assert.deepEqual(snapshot(fx), before);

        const probed = fx.update({ probeRemote: true, fetchTimeoutMs: 20_000 });
        assert.equal(probed.outcome, 'skipped');
        assert.equal(probed.code, 'remote-unreachable');
        assert.doesNotMatch(JSON.stringify(probed), /s3cr3t-token/);
    } finally {
        cleanup(fx);
    }
});

test('a non-root directory inside another checkout is never treated as that checkout', () => {
    const fx = createFixture();
    try {
        const nested = path.join(fx.checkout, 'nested');
        fs.mkdirSync(nested);
        fx.advance();
        const log = [];
        const record = fx.update({ repoPath: nested, exec: tracingExec(log) });
        assert.equal(record.outcome, 'skipped');
        assert.equal(record.code, 'not-repository-root');
        assert.deepEqual(log, ['rev-parse --show-toplevel --absolute-git-dir --git-common-dir']);
    } finally {
        cleanup(fx);
    }
});

test('generated-state assessment runs before dirty classification and can preserve, restore or fail closed', () => {
    const fx = createFixture();
    try {
        const upstream = fx.advance('b.txt', 'b2\n');
        fs.writeFileSync(path.join(fx.checkout, 'a.txt'), 'generated\n');
        const seen = [];
        const preserved = fx.update({
            assessGeneratedState({ repoPath, preflight }) {
                seen.push([repoPath, preflight.status.unstaged]);
                return { status: 'preserve', code: 'generated-state-unproven', reason: 'no write receipt' };
            },
        });
        assert.equal(preserved.outcome, 'skipped');
        assert.equal(preserved.code, 'generated-state-unproven');
        assert.deepEqual(seen, [[fs.realpathSync(fx.checkout), ['a.txt']]]);

        const failed = fx.update({ assessGeneratedState() { throw new Error('boom'); } });
        assert.equal(failed.outcome, 'uncertain');
        assert.equal(failed.code, 'assessment-failed');
        assert.equal(fs.readFileSync(path.join(fx.checkout, 'a.txt'), 'utf8'), 'generated\n');

        const restored = fx.update({
            assessGeneratedState({ repoPath }) {
                fs.writeFileSync(path.join(repoPath, 'a.txt'), 'a1\n');
                return { status: 'restored', paths: ['a.txt'] };
            },
        });
        assert.equal(restored.outcome, 'changed');
        assert.deepEqual(restored.details.restoredGeneratedPaths, ['a.txt']);
        assert.equal(fx.git(fx.checkout, 'rev-parse', 'HEAD'), upstream);
    } finally {
        cleanup(fx);
    }
});

test('linked worktrees are separate checkouts that share one common-directory lock', () => {
    const fx = createFixture();
    try {
        fx.git(fx.seed, 'push', '-q', 'origin', 'main:feature');
        fx.git(fx.checkout, 'fetch', '-q', 'origin');
        const linked = path.join(fx.root, 'linked');
        fx.git(fx.checkout, 'worktree', 'add', '-q', '--track', '-b', 'feature', linked, 'origin/feature');
        const main = resolveCheckoutIdentity(fx.checkout, { env: fx.env });
        const other = resolveCheckoutIdentity(linked, { env: fx.env });
        assert.notEqual(main.canonical, other.canonical);
        assert.notEqual(main.gitDir, other.gitDir);
        assert.equal(main.commonDir, other.commonDir);

        const held = acquireCheckoutLock({ commonDir: main.commonDir, checkout: main.canonical, waitMs: 0 });
        assert.equal(held.ok, true);
        const busy = fx.update({ repoPath: linked });
        assert.equal(busy.outcome, 'uncertain');
        assert.equal(busy.code, 'lock-busy');
        assert.equal(busy.attempted, false);
        assert.equal(held.lock.release(), true);

        fx.commit(fx.seed, 'b.txt', 'feature b\n');
        fx.git(fx.seed, 'push', '-q', 'origin', 'main:feature');
        const record = fx.update({ repoPath: linked });
        assert.equal(record.outcome, 'changed');
        assert.equal(fx.git(linked, 'rev-parse', 'HEAD'), fx.git(fx.seed, 'rev-parse', 'HEAD'));
        assert.notEqual(fx.git(fx.checkout, 'rev-parse', 'HEAD'), fx.git(linked, 'rev-parse', 'HEAD'),
            'the main worktree was not moved by its linked worktree update');
    } finally {
        cleanup(fx);
    }
});

test('the checkout lock is reclaimed only from an affirmatively dead same-scope owner', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-checkout-lock-'));
    try {
        const scope = readProcessScope();
        const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
        const deadPid = Number(dead.stdout);
        const lockPath = path.join(root, CHECKOUT_LOCK_NAME);
        const writeOwner = owner => {
            fs.mkdirSync(lockPath, { recursive: true });
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                schema: 'ploinky-update-checkout-lock', version: 1, token: 'old-token', pid: deadPid, hostname: os.hostname(), ...owner,
            }));
        };

        // Another boot/namespace: PID absence is not proof.
        writeOwner({ scope: 'another-namespace' });
        const foreign = acquireCheckoutLock({ commonDir: root, waitMs: 60, retryMs: 20 });
        assert.equal(foreign.ok, false);
        assert.equal(foreign.code, 'lock-busy');
        assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token, 'old-token');

        // A live owner in the same scope is never reclaimed, whatever its age.
        fs.rmSync(lockPath, { recursive: true, force: true });
        writeOwner({ scope: scope?.scope || 'unknown', pid: process.pid, createdAt: '2000-01-01T00:00:00.000Z' });
        const live = acquireCheckoutLock({ commonDir: root, waitMs: 60, retryMs: 20 });
        assert.equal(live.code, 'lock-busy');

        // A malformed owner needs manual recovery.
        fs.rmSync(lockPath, { recursive: true, force: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), '{"not":"an owner"}');
        const malformed = acquireCheckoutLock({ commonDir: root, waitMs: 60, retryMs: 20 });
        assert.equal(malformed.code, 'lock-recovery-required');

        if (scope?.scope) {
            fs.rmSync(lockPath, { recursive: true, force: true });
            writeOwner({ scope: scope.scope });
            assert.equal(ownerIsProvenDead({ pid: deadPid, scope: scope.scope }), true);
            const reclaimed = acquireCheckoutLock({ commonDir: root, waitMs: 500, retryMs: 20 });
            assert.equal(reclaimed.ok, true);
            const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
            assert.equal(owner.pid, process.pid);
            assert.equal(owner.token, reclaimed.lock.token);

            // Release only while the token still matches.
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ ...owner, token: 'someone-else' }));
            assert.equal(reclaimed.lock.release(), false);
            assert.equal(fs.existsSync(lockPath), true, 'a lock with another token is not removed');
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a foreign-scope owner is reclaimed only when the host attests that its Box run ended', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-checkout-lock-box-'));
    try {
        const workspace = `ploinky-box-demo-${'d'.repeat(16)}`;
        const box = 'b'.repeat(64);
        const replaced = 'c'.repeat(64);
        const engine = 'engine-store';
        const lockPath = path.join(root, CHECKOUT_LOCK_NAME);
        const ownerFile = path.join(lockPath, 'owner.json');
        // The acquirer runs in a later run of the Box: another PID namespace.
        const processApi = {
            pid: process.pid,
            hostname: 'box',
            scope: () => ({ bootId: 'boot', pidNamespace: 'pid:[2]', scope: 'box-run-2' }),
            processStart: () => '',
            kill: () => { throw new Error('a foreign-scope owner is never signalled'); },
        };
        const writeOwner = (recorded, scope = 'box-run-1') => {
            fs.rmSync(lockPath, { recursive: true, force: true });
            fs.mkdirSync(lockPath);
            fs.writeFileSync(ownerFile, JSON.stringify({
                schema: 'ploinky-update-checkout-lock', version: 1, token: 'old-token', pid: 4242, scope, hostname: 'box', box: recorded,
            }));
        };
        const acquire = (boxRun, api = processApi) => acquireCheckoutLock({ commonDir: root, waitMs: 60, retryMs: 20, processApi: api, boxRun });
        const run = { workspace, containerId: box, engine, soleContainer: false };
        const staysBusy = (recorded, boxRun, why, api) => {
            writeOwner(recorded, api ? 'box-run-2' : 'box-run-1');
            assert.equal(acquire(boxRun, api).code, 'lock-busy', why);
            assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).token, 'old-token', why);
        };

        staysBusy({ workspace, containerId: box }, null, 'no attestation: a direct in-Box or a host writer');
        staysBusy(null, run, 'an owner that recorded no Box');
        staysBusy({ workspace: `ploinky-box-other-${'e'.repeat(16)}`, containerId: box }, run, 'another workspace');
        staysBusy({ workspace, containerId: replaced, engine }, run, 'another container that may still exist');
        staysBusy({ workspace, containerId: replaced, engine: 'another-engine' }, { ...run, soleContainer: true },
            'a container of another engine, which the listing cannot see');
        staysBusy({ workspace, containerId: replaced }, { ...run, soleContainer: true }, 'a binding without its engine');
        staysBusy({ workspace, containerId: 'not-a-container' }, { ...run, soleContainer: true }, 'a malformed binding');
        staysBusy({ workspace, containerId: box }, { workspace, containerId: 'short', soleContainer: true }, 'a malformed attestation');
        staysBusy({ workspace, containerId: box }, { ...run, soleContainer: true }, 'a live owner in this scope stays live',
            { ...processApi, kill: () => {} });

        // An earlier run of this same container: the Box was stopped and started, or the host rebooted.
        writeOwner({ workspace, containerId: box });
        assert.equal(ownerIsProvenDead(JSON.parse(fs.readFileSync(ownerFile, 'utf8')), processApi, run), true);
        const restarted = acquire(run);
        assert.equal(restarted.ok, true, restarted.reason);
        assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).box, { workspace, containerId: box, engine },
            'the new owner binds to its own Box run');
        assert.equal(restarted.lock.release(), true);

        // A replaced Box: the host saw the current container as the workspace's only container in this engine.
        writeOwner({ workspace, containerId: replaced, engine });
        const replacedBox = acquire({ ...run, soleContainer: true });
        assert.equal(replacedBox.ok, true, replacedBox.reason);
        assert.equal(replacedBox.lock.release(), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('throwUnlessVerified raises a typed error that carries the record', () => {
    const fx = createFixture();
    try {
        fx.git(fx.checkout, 'checkout', '-q', '--detach');
        const record = fx.update();
        assert.throws(() => throwUnlessVerified(record), error => {
            assert.ok(error instanceof GitUpdateError);
            assert.equal(error.record, record);
            assert.equal(error.code, 'PLOINKY_GIT_UPDATE_SKIPPED');
            return true;
        });
    } finally {
        cleanup(fx);
    }
});

test('Git environment is noninteractive and scrubbed of repository selectors', () => {
    const env = buildGitEnvironment({ GIT_DIR: '/x', GIT_WORK_TREE: '/y', GIT_INDEX_FILE: '/z', PATH: '/bin' });
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_WORK_TREE, undefined);
    assert.equal(env.GIT_INDEX_FILE, undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
    assert.equal(buildGitEnvironment({ GIT_SSH_COMMAND: 'custom' }).GIT_SSH_COMMAND, 'custom');
    assert.equal(buildGitEnvironment({}, { sshConfigured: true }).GIT_SSH_COMMAND, undefined);
    assert.equal(buildGitEnvironment({ GIT_SSH: '/bin/ssh-wrapper' }).GIT_SSH_COMMAND, undefined);
});

test('porcelain v2 parsing keeps staged, unstaged, untracked and unmerged paths distinct', () => {
    const output = [
        '1 M. N... 100644 100644 100644 abc abc staged file.txt',
        '1 .M N... 100644 100644 100644 abc abc unstaged.txt',
        '2 R. N... 100644 100644 100644 abc abc R100 renamed name.txt',
        'old name.txt',
        'u UU N... 100644 100644 100644 100644 a b c conflicted.txt',
        '? new file.txt',
        '',
    ].join('\0');
    assert.deepEqual(parsePorcelainV2(output), {
        staged: ['staged file.txt', 'renamed name.txt'],
        unstaged: ['unstaged.txt'],
        untracked: ['new file.txt'],
        unmerged: ['conflicted.txt'],
        ignored: [],
    });
});

test('an ignored user file that upstream starts tracking is never overwritten', () => {
    const fx = createFixture();
    try {
        fx.commit(fx.seed, '.gitignore', '.env\n');
        fx.git(fx.seed, 'push', '-q');
        assert.equal(fx.update().outcome, 'changed');
        fs.writeFileSync(path.join(fx.checkout, '.env'), 'USER_SECRET=mine\n');
        fs.writeFileSync(path.join(fx.seed, '.env'), 'UPSTREAM=1\n');
        fx.git(fx.seed, 'add', '-f', '.env');
        fx.git(fx.seed, 'commit', '-q', '-m', 'track env');
        fx.git(fx.seed, 'push', '-q');
        const head = fx.git(fx.checkout, 'rev-parse', 'HEAD');
        const record = fx.update();
        assert.equal(record.outcome, 'failed');
        assert.equal(record.code, 'fast-forward-refused');
        assert.equal(fx.git(fx.checkout, 'rev-parse', 'HEAD'), head);
        assert.equal(fs.readFileSync(path.join(fx.checkout, '.env'), 'utf8'), 'USER_SECRET=mine\n');
    } finally {
        cleanup(fx);
    }
});

test('an interrupted fast-forward that leaves a Git lock behind is recovery-required, not a clean refusal', () => {
    const fx = createFixture();
    try {
        fx.advance();
        const gitDir = fx.git(fx.checkout, 'rev-parse', '--absolute-git-dir');
        const record = fx.update({
            exec: tracingExec([], {
                override: args => {
                    if (!(args.includes('merge') && args.includes('--ff-only'))) return null;
                    fs.writeFileSync(path.join(gitDir, 'index.lock'), '');
                    return { ok: false, status: null, signal: 'SIGKILL', stdout: '', stderr: '', error: 'ETIMEDOUT', timedOut: true, argv: args };
                },
            }),
        });
        assert.equal(record.outcome, 'uncertain');
        assert.equal(record.code, 'recovery-required');
        assert.equal(fs.existsSync(path.join(gitDir, 'index.lock')), true, 'the lock is left for the user, never deleted');
    } finally {
        cleanup(fx);
    }
});

test('credentials in a URL-valued upstream remote never reach record evidence', () => {
    const fx = createFixture();
    try {
        const branch = fx.git(fx.checkout, 'symbolic-ref', '--short', 'HEAD');
        fx.git(fx.checkout, 'config', `branch.${branch}.remote`, `file://user:s3cret@localhost${fx.remote}`);
        const record = fx.update();
        const evidence = JSON.stringify({ before: record.before, after: record.after, details: record.details, reason: record.reason });
        assert.doesNotMatch(evidence, /s3cret/);
    } finally {
        cleanup(fx);
    }
});

for (const relation of ['current', 'local-ahead']) {
    test(`a ${relation} fetch cannot certify a concurrently dirty checkout`, () => {
        const fixture = createFixture();
        try {
            if (relation === 'local-ahead') fixture.commit(fixture.checkout, 'c.txt', 'local commit\n');
            const record = fixture.update({
                required: true,
                exec(repo, args, options) {
                    const result = runGit(repo, args, options);
                    if (args[0] === 'fetch' && result.ok) {
                        fs.writeFileSync(path.join(repo, 'a.txt'), 'concurrent user edit\n');
                    }
                    return result;
                },
            });
            assert.equal(record.outcome, 'failed');
            assert.equal(record.code, 'concurrent-change');
            assert.equal(record.after.unstaged.count, 1);
            assert.equal(fs.readFileSync(path.join(fixture.checkout, 'a.txt'), 'utf8'), 'concurrent user edit\n');
        } finally { cleanup(fixture); }
    });
}
