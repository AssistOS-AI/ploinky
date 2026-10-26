import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { linkInstallDeclarations, prepareLinkedRepositories, preflightLinkedRepositories } from '../../cli/utils/linkInstall.mjs';
import { preflightStartLinkedRepositories } from '../../cli/commands/workspaceUtil.js';

const url = 'https://git.example.test/team/Library.git';
const manifest = { 'link-install': [url] };
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.test'];

function git(cwd, ...args) {
    return String(execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
}

// A hermetic world: one bare "remote" with branches main and feature, reached
// through insteadOf so the declared HTTPS URL resolves to a local directory.
function world(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'link-branch-')));
    const bare = path.join(base, 'remote.git');
    const seed = path.join(base, 'seed');
    const workspace = path.join(base, 'workspace');
    fs.mkdirSync(workspace);
    git(base, 'init', '--bare', '-b', 'main', bare);
    git(base, 'init', '-b', 'main', seed);
    fs.writeFileSync(path.join(seed, 'file.txt'), 'main\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'main');
    git(seed, 'checkout', '-b', 'feature');
    fs.writeFileSync(path.join(seed, 'file.txt'), 'feature\n');
    git(seed, 'commit', '-am', 'feature');
    git(seed, 'push', bare, 'main', 'feature');
    const config = path.join(base, 'gitconfig');
    fs.writeFileSync(config, `[url "${bare}"]\n\tinsteadOf = ${url}\n`);
    const previous = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    t.after(() => {
        for (const [key, value] of [['GIT_CONFIG_GLOBAL', previous.global], ['GIT_CONFIG_NOSYSTEM', previous.nosystem]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        fs.rmSync(base, { recursive: true, force: true });
    });
    const logs = [];
    const options = (branch, fallback = 'default', extra = {}) => ({
        workspaceRoot: workspace,
        branchPolicy: { branch, repoBranches: {}, fallback, resetRepos: false },
        log: message => logs.push(message),
        ...extra,
    });
    const checkout = (branch) => {
        const directory = path.join(workspace, 'Library');
        git(base, 'clone', '--branch', branch, url, directory);
        return directory;
    };
    const snapshot = directory => ({
        head: git(directory, 'rev-parse', 'HEAD'),
        branch: git(directory, 'rev-parse', '--abbrev-ref', 'HEAD'),
        status: git(directory, 'status', '--porcelain'),
        refs: git(directory, 'for-each-ref'),
        file: fs.readFileSync(path.join(directory, 'file.txt'), 'utf8'),
    });
    return { base, workspace, logs, options, checkout, snapshot };
}

test('a missing repository is cloned at the requested branch when the remote has it', t => {
    const w = world(t);
    const [mount] = prepareLinkedRepositories(manifest, w.options('feature'));
    assert.equal(git(mount.source, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
    assert.equal(fs.readFileSync(path.join(mount.source, 'file.txt'), 'utf8'), 'feature\n');
    assert.equal(git(mount.source, 'config', '--get', 'remote.origin.url'), url);
    assert.deepEqual(fs.readdirSync(w.workspace), ['Library']);
});

test('fallback default clones the default branch and logs when the branch is absent on the remote', t => {
    const w = world(t);
    const [mount] = prepareLinkedRepositories(manifest, w.options('nope'));
    assert.equal(git(mount.source, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(w.logs.length, 1);
    assert.match(w.logs[0], /Branch 'nope' not found on remote for 'Library'; falling back to default branch/);
});

test('fallback fail aborts naming the repository and branch, leaving no clone behind', t => {
    const w = world(t);
    assert.throws(() => prepareLinkedRepositories(manifest, w.options('nope', 'fail')),
        /Branch 'nope' does not exist on remote for repo 'Library'\. Aborting \(--branch-fallback fail\)/);
    assert.deepEqual(fs.readdirSync(w.workspace), []);
});

test('an existing checkout on the requested branch is accepted without changes', t => {
    const w = world(t);
    const directory = w.checkout('feature');
    fs.writeFileSync(path.join(directory, 'local-edit'), 'keep');
    const before = w.snapshot(directory);
    const [mount] = prepareLinkedRepositories(manifest, w.options('feature'));
    assert.equal(mount.source, directory);
    assert.deepEqual(w.snapshot(directory), before);
});

test('an existing checkout on another branch is refused and left untouched', t => {
    const w = world(t);
    const directory = w.checkout('main');
    fs.writeFileSync(path.join(directory, 'local-edit'), 'keep');
    const before = w.snapshot(directory);
    assert.throws(() => prepareLinkedRepositories(manifest, w.options('feature')),
        /link-install repository Library is on 'main', not requested branch 'feature'; switch it yourself \(Ploinky never modifies workspace checkouts\)/);
    assert.deepEqual(w.snapshot(directory), before);
    assert.equal(fs.readFileSync(path.join(directory, 'local-edit'), 'utf8'), 'keep');
});

test('a detached HEAD does not count as the requested branch', t => {
    const w = world(t);
    const directory = w.checkout('feature');
    git(directory, 'checkout', '--detach');
    const before = w.snapshot(directory);
    assert.throws(() => prepareLinkedRepositories(manifest, w.options('feature')),
        /link-install repository Library is on 'detached HEAD', not requested branch 'feature'/);
    assert.deepEqual(w.snapshot(directory), before);
});

test('an existing checkout is accepted as-is with fallback default when the branch is absent on the remote', t => {
    const w = world(t);
    const directory = w.checkout('main');
    const before = w.snapshot(directory);
    const [mount] = prepareLinkedRepositories(manifest, w.options('nope'));
    assert.equal(mount.source, directory);
    assert.deepEqual(w.snapshot(directory), before);
    assert.equal(w.logs.length, 1);
    assert.match(w.logs[0], /Branch 'nope' not found on remote for 'Library'; keeping the existing checkout/);
});

test('an existing checkout is refused with fallback fail when the branch is absent on the remote', t => {
    const w = world(t);
    const directory = w.checkout('main');
    const before = w.snapshot(directory);
    assert.throws(() => prepareLinkedRepositories(manifest, w.options('nope', 'fail')),
        /Branch 'nope' does not exist on remote for repo 'Library'\. Aborting \(--branch-fallback fail\)/);
    assert.deepEqual(w.snapshot(directory), before);
});

test('without a branch no remote is queried and no branch is checked', t => {
    const w = world(t);
    const directory = w.checkout('main');
    const before = w.snapshot(directory);
    const calls = [];
    const execFile = (command, args, opts) => { calls.push(args); return execFileSync(command, args, opts); };
    const [mount] = prepareLinkedRepositories(manifest, {
        workspaceRoot: w.workspace, execFile,
        branchPolicy: { branch: null, repoBranches: {}, fallback: 'fail', resetRepos: false },
    });
    assert.equal(mount.source, directory);
    assert.equal(calls.some(args => args.includes('ls-remote') || args.includes('symbolic-ref') || args.includes('fetch')), false);
    assert.deepEqual(w.snapshot(directory), before);
    // The documented default call shape has no policy at all.
    prepareLinkedRepositories(manifest, { workspaceRoot: w.workspace, execFile });
    assert.equal(calls.some(args => args.includes('ls-remote')), false);
});

test('a remote that cannot be queried is reported as such and follows the fallback policy', t => {
    const w = world(t);
    const directory = w.checkout('main');
    const before = w.snapshot(directory);
    const seen = [];
    const execFile = (command, args, opts) => {
        if (args.includes('ls-remote')) {
            seen.push(opts);
            throw new Error('network down');
        }
        return execFileSync(command, args, opts);
    };
    prepareLinkedRepositories(manifest, w.options('feature', 'default', { execFile }));
    assert.deepEqual(w.snapshot(directory), before);
    assert.equal(w.logs.length, 1);
    assert.match(w.logs[0], /Could not query the remote for 'Library' to check branch 'feature'; keeping the existing checkout/);
    assert.doesNotMatch(w.logs[0], /not found on remote/);
    assert.throws(() => prepareLinkedRepositories(manifest, w.options('feature', 'fail', { execFile })),
        /Could not query the remote of repo 'Library' for branch 'feature'\. Aborting \(--branch-fallback fail\)/);
    assert.equal(seen.length, 2);
    for (const opts of seen) {
        assert.equal(opts.timeout, 120000);
        assert.equal(opts.env.GIT_TERMINAL_PROMPT, '0');
    }
});

test('start preflight covers blocking and no-wait nodes, queries once and stops on a mismatch', t => {
    const w = world(t);
    const node = (id, value) => ({ id, manifest: value });
    const policy = { branch: 'feature', fallback: 'default', repoBranches: {}, resetRepos: false };
    const admitted = {
        graph: { nodes: new Map([['explorer', node('explorer', {})], ['robo-no-wait', node('robo-no-wait', manifest)]]) },
        additionalNodes: [node('extra', manifest)],
    };
    // Every admitted node's manifest reaches the preflight, no-wait ones included.
    const captured = [];
    preflightStartLinkedRepositories(admitted, {
        workspaceRoot: w.workspace, branchPolicy: policy,
        preflight: manifests => { captured.push(...manifests); return []; },
    });
    assert.deepEqual(captured, [{}, manifest, manifest]);
    // Real preflight: the no-wait node's repository is cloned at the branch, queried once.
    const calls = [];
    const execFile = (command, args, opts) => { calls.push(args); return execFileSync(command, args, opts); };
    preflightStartLinkedRepositories(admitted, { workspaceRoot: w.workspace, branchPolicy: policy, execFile });
    const directory = path.join(w.workspace, 'Library');
    assert.equal(git(directory, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
    assert.equal(calls.filter(args => args.includes('ls-remote')).length, 1);
    assert.equal(calls.filter(args => args.includes('clone')).length, 1);
    // A later mismatch on the same graph stops the start and leaves the checkout alone.
    git(directory, 'checkout', 'main');
    const before = w.snapshot(directory);
    assert.throws(() => preflightStartLinkedRepositories(admitted, { workspaceRoot: w.workspace, branchPolicy: policy }),
        /is on 'main', not requested branch 'feature'/);
    assert.deepEqual(w.snapshot(directory), before);
    // Fail policy aborts the start when the branch is absent.
    assert.throws(() => preflightStartLinkedRepositories(admitted, { workspaceRoot: w.workspace,
        branchPolicy: { ...policy, branch: 'nope', fallback: 'fail' } }), /Aborting \(--branch-fallback fail\)/);
    // Without --branch the preflight does nothing.
    assert.deepEqual(preflightStartLinkedRepositories(admitted, { workspaceRoot: w.workspace, branchPolicy: null, execFile }), []);
    assert.deepEqual(preflightLinkedRepositories([manifest], { workspaceRoot: w.workspace }), []);
});

test('refs in link-install URLs are still rejected', () => {
    for (const value of [`${url}#feature`, `${url}?ref=feature`, `${url}#refs/heads/feature`]) {
        assert.throws(() => linkInstallDeclarations({ 'link-install': [value] }), /without embedded credentials or refs|Invalid/);
    }
});
