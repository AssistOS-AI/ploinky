import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { updateCheckoutFastForward } from '../../cli/utils/git/verifiedUpdate.js';
import { runGit } from '../../cli/utils/git/gitExec.js';

// Mutation-gap regressions for the verified fast-forward contract: checkout
// changes observed only after the fetch (branch switch, upstream change), a
// clean in-progress operation, a pre-existing Git lock and a staged-only
// change. Every fixture uses a local bare remote under a scratch directory
// with isolated Git config.

function createFixture({ branch = 'main' } = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-git-mutation-gaps-')));
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

const headOf = (fx, ref) => fx.gitRaw(fx.checkout, 'rev-parse', '-q', '--verify', ref).stdout.trim();

test('a branch switch after the fetch is a concurrent change and moves neither branch', () => {
    const fx = createFixture();
    try {
        const upstream = fx.advance();
        const before = fx.git(fx.checkout, 'rev-parse', 'HEAD');
        const record = fx.update({
            exec: tracingExec([], { after(args, result) {
                if (args[0] === 'fetch' && result.ok) fx.git(fx.checkout, 'checkout', '-q', '-b', 'user-topic');
            } }),
        });
        assert.equal(record.outcome, 'failed');
        assert.equal(record.code, 'concurrent-change');
        assert.equal(headOf(fx, 'refs/heads/user-topic'), before, 'the user branch was not advanced');
        assert.equal(headOf(fx, 'refs/heads/main'), before, 'main was not advanced');
        assert.notEqual(upstream, before);
        assert.equal(fx.git(fx.checkout, 'symbolic-ref', 'HEAD'), 'refs/heads/user-topic');
    } finally { cleanup(fx); }
});

test('a clean on-branch bisect in progress is refused as recovery-required with BISECT_LOG and HEAD unchanged', () => {
    const fx = createFixture();
    try {
        fx.advance();
        fx.git(fx.checkout, 'bisect', 'start');
        const head = fx.git(fx.checkout, 'rev-parse', 'HEAD');
        const before = snapshot(fx);
        const gitDir = fx.git(fx.checkout, 'rev-parse', '--absolute-git-dir');
        const bisectLog = fs.readFileSync(path.join(gitDir, 'BISECT_LOG'), 'utf8');
        const record = fx.update();
        assert.equal(record.outcome, 'uncertain');
        assert.equal(record.code, 'recovery-required');
        assert.equal(record.attempted, false);
        assert.deepEqual(snapshot(fx), before);
        assert.equal(fs.readFileSync(path.join(gitDir, 'BISECT_LOG'), 'utf8'), bisectLog);
        assert.equal(fx.git(fx.checkout, 'rev-parse', 'HEAD'), head);
    } finally { cleanup(fx); }
});

test('a staged-only change is preserved with its exact index blob and worktree bytes', () => {
    const fx = createFixture();
    try {
        fx.advance('b.txt', 'b2\n');
        fs.writeFileSync(path.join(fx.checkout, 'c.txt'), 'staged only\n');
        fx.git(fx.checkout, 'add', 'c.txt');
        const before = snapshot(fx);
        assert.equal(before.unstaged, '');
        const blob = fx.git(fx.checkout, 'rev-parse', ':c.txt');
        const record = fx.update();
        assert.equal(record.outcome, 'skipped');
        assert.equal(record.code, 'dirty-index');
        assert.deepEqual(snapshot(fx), before);
        assert.equal(fx.git(fx.checkout, 'rev-parse', ':c.txt'), blob);
    } finally { cleanup(fx); }
});

test('a pre-existing foreign index.lock is kept byte-exact, reported as git-lock-present and no fetch runs', () => {
    const fx = createFixture();
    try {
        fx.advance();
        const gitDir = fx.git(fx.checkout, 'rev-parse', '--absolute-git-dir');
        fs.writeFileSync(path.join(gitDir, 'index.lock'), 'foreign');
        const head = fx.git(fx.checkout, 'rev-parse', 'HEAD');
        const log = [];
        const record = fx.update({ exec: tracingExec(log) });
        assert.equal(record.outcome, 'uncertain');
        assert.equal(record.code, 'git-lock-present');
        assert.equal(fs.readFileSync(path.join(gitDir, 'index.lock'), 'utf8'), 'foreign');
        assert.equal(fx.git(fx.checkout, 'rev-parse', 'HEAD'), head);
        assert.equal(log.some(entry => /^(fetch|merge) /.test(entry)), false);
    } finally { cleanup(fx); }
});

test('an upstream reconfiguration after the fetch is a concurrent change and moves no branch', () => {
    const fx = createFixture();
    try {
        fx.advance();
        fx.git(fx.seed, 'push', '-q', 'origin', 'main:other');
        const head = fx.git(fx.checkout, 'rev-parse', 'HEAD');
        const record = fx.update({
            exec: tracingExec([], { after(args, result) {
                if (args[0] === 'fetch' && result.ok) fx.git(fx.checkout, 'config', 'branch.main.merge', 'refs/heads/other');
            } }),
        });
        assert.equal(record.outcome, 'failed');
        assert.equal(record.code, 'concurrent-change');
        assert.equal(fx.git(fx.checkout, 'rev-parse', 'HEAD'), head);
        assert.equal(headOf(fx, 'refs/heads/main'), head, 'main was not advanced');
        assert.equal(fx.git(fx.checkout, 'config', 'branch.main.merge'), 'refs/heads/other', 'the new upstream is kept');
    } finally { cleanup(fx); }
});
