import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Behavioral regressions for `ploinky update` Git safety. These scenarios use
// only entry points that also exist at the baseline (registered `updateRepo`,
// `updateWorkspacePloinkySource`, `updateAllRepos`) and assert the resulting
// repository state: HEAD, the index/worktree split, worktree bytes, stash
// object IDs and operation metadata. Outcomes are captured with try/catch so a
// thrown or returned result is judged by state, not by call shape.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = rel => pathToFileURL(path.join(projectRoot, rel)).href;

const PRELUDE = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const scratch = process.env.PLOINKY_TEST_SCRATCH;
const workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const git = (cwd, ...args) => String(execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
})).trim();
const gitRaw = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
function writeFile(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}
function makeRemote(name, files) {
    const remote = path.join(scratch, name + '.git');
    const seed = path.join(scratch, name + '-seed');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    fs.mkdirSync(seed, { recursive: true });
    git(seed, 'init', '-q', '-b', 'main');
    for (const [rel, content] of Object.entries(files)) writeFile(path.join(seed, rel), content);
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'initial');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-q', '-u', 'origin', 'main');
    return { remote, seed };
}
function clone(remote, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    execFileSync('git', ['clone', '-q', remote, dest]);
}
function commitPush(seed, rel, content, refspec = null) {
    writeFile(path.join(seed, rel), content);
    git(seed, 'add', rel);
    git(seed, 'commit', '-q', '-m', 'change ' + rel);
    if (refspec) git(seed, 'push', '-q', 'origin', refspec);
    else git(seed, 'push', '-q');
    return git(seed, 'rev-parse', 'HEAD');
}
function listTree(dir) {
    if (!fs.existsSync(dir)) return null;
    const out = {};
    const visit = (current, prefix) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(current, entry.name);
            const rel = prefix ? prefix + '/' + entry.name : entry.name;
            if (entry.isDirectory()) visit(full, rel);
            else out[rel] = fs.readFileSync(full).toString('base64');
        }
    };
    visit(dir, '');
    return out;
}
function snapshot(repo) {
    const gitDir = git(repo, 'rev-parse', '--absolute-git-dir');
    const files = {};
    for (const name of fs.readdirSync(repo)) {
        const full = path.join(repo, name);
        if (name !== '.git' && fs.statSync(full).isFile()) files[name] = fs.readFileSync(full, 'utf8');
    }
    return {
        head: gitRaw(repo, 'rev-parse', '-q', '--verify', 'HEAD').stdout.trim(),
        symbolic: gitRaw(repo, 'symbolic-ref', '-q', 'HEAD').stdout.trim(),
        index: git(repo, 'ls-files', '-s'),
        unmerged: git(repo, 'ls-files', '-u'),
        staged: git(repo, 'diff', '--cached', '--binary'),
        unstaged: git(repo, 'diff', '--binary'),
        stashes: git(repo, 'stash', 'list', '--format=%H'),
        files,
        rebaseMerge: listTree(path.join(gitDir, 'rebase-merge')),
        rebaseApply: listTree(path.join(gitDir, 'rebase-apply')),
    };
}
async function capture(operation) {
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = () => {};
    try {
        return { value: await operation() };
    } catch (error) {
        return { error: String(error?.message || error), code: error?.code || null, recordOutcome: error?.record?.outcome || null };
    } finally {
        Object.assign(console, original);
    }
}
function traceLines() {
    const file = process.env.PLOINKY_TEST_GIT_TRACE;
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}
function done(value) {
    process.stdout.write('RESULT:' + JSON.stringify(value) + '\n');
}
`;

function runScenario(body, { workspaceAlias = false } = {}) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-git-safety-'));
    try {
        const home = path.join(scratch, 'home');
        const workspaceReal = path.join(scratch, 'workspace');
        const runtimeRoot = path.join(scratch, 'runtime-root');
        const bin = path.join(scratch, 'bin');
        for (const dir of [home, workspaceReal, runtimeRoot, bin]) fs.mkdirSync(dir, { recursive: true });
        let workspaceRoot = workspaceReal;
        if (workspaceAlias) {
            workspaceRoot = path.join(scratch, 'workspace-alias');
            fs.symlinkSync(workspaceReal, workspaceRoot, 'dir');
        }
        const globalConfig = path.join(scratch, 'gitconfig');
        fs.writeFileSync(globalConfig, '[user]\n\tname = Ploinky Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n');
        const realGit = String(execFileSync('which', ['git'], { encoding: 'utf8' })).trim();
        const wrapper = path.join(bin, 'git');
        fs.writeFileSync(wrapper, [
            '#!/bin/sh',
            'printf \'%s\\n\' "$*" >> "$PLOINKY_TEST_GIT_TRACE"',
            // Unit fixtures never reach the network (for example a default
            // skills source that would otherwise be cloned from its URL).
            'for arg in "$@"; do case "$arg" in http://*|https://*|ssh://*|git@*) echo "network Git access is not allowed in this test: $arg" >&2; exit 97;; esac; done',
            `exec "${realGit}" "$@"`,
            '',
        ].join('\n'));
        fs.chmodSync(wrapper, 0o755);
        const script = `${PRELUDE}\nconst workspaceReal = ${JSON.stringify(workspaceReal)};\n${body}`;
        const env = {
            ...process.env,
            HOME: home,
            GIT_CONFIG_GLOBAL: globalConfig,
            GIT_CONFIG_NOSYSTEM: '1',
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            PLOINKY_TEST_SCRATCH: scratch,
            PLOINKY_TEST_GIT_TRACE: path.join(scratch, 'git-trace.log'),
            PLOINKY_WORKSPACE_ROOT: workspaceRoot,
            PLOINKY_ROOT: runtimeRoot,
        };
        for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'PLOINKY_UPDATED_WORKSPACE_CHECKOUT']) delete env[name];
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: workspaceReal,
            env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const line = output.split('\n').find(entry => entry.startsWith('RESULT:'));
        assert.ok(line, `scenario produced a result:\n${output}`);
        return JSON.parse(line.slice('RESULT:'.length));
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

const REGISTERED_SETUP = String.raw`
const { REPOS_DIR } = await import(${JSON.stringify(moduleUrl('cli/utils/config.js'))});
const repos = await import(${JSON.stringify(moduleUrl('cli/utils/repos.js'))});
const { remote, seed } = makeRemote('registered', { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' });
const checkout = path.join(REPOS_DIR, 'UnitGitSafety');
clone(remote, checkout);
`;

test('a registered update never autostashes a dirty edit that conflicts with upstream', () => {
    const result = runScenario(`${REGISTERED_SETUP}
        commitPush(seed, 'a.txt', 'upstream a\\n');
        writeFile(path.join(checkout, 'a.txt'), 'local a\\n');
        const before = snapshot(checkout);
        const outcome = await capture(() => repos.updateRepo('UnitGitSafety', { stdio: 'ignore' }));
        done({ before, after: snapshot(checkout), outcome });
    `);
    assert.equal(result.after.head, result.before.head, 'HEAD did not move');
    assert.equal(result.after.files['a.txt'], 'local a\n', 'the local edit bytes are intact');
    assert.equal(result.after.unmerged, '', 'no conflict entries were created');
    assert.equal(result.after.stashes, result.before.stashes, 'no autostash was left behind');
    assert.deepEqual(result.after, result.before);
    assert.ok(result.outcome.error, 'the preserved update is reported, not silently successful');
});

test('a registered update keeps the staged/unstaged split instead of rewriting it', () => {
    const result = runScenario(`${REGISTERED_SETUP}
        commitPush(seed, 'a.txt', 'upstream a\\n');
        writeFile(path.join(checkout, 'b.txt'), 'staged b\\n');
        git(checkout, 'add', 'b.txt');
        writeFile(path.join(checkout, 'c.txt'), 'unstaged c\\n');
        const before = snapshot(checkout);
        const outcome = await capture(() => repos.updateRepo('UnitGitSafety', { stdio: 'ignore' }));
        done({ before, after: snapshot(checkout), outcome });
    `);
    assert.notEqual(result.before.staged, '');
    assert.equal(result.after.staged, result.before.staged, 'the staged change is still staged');
    assert.equal(result.after.unstaged, result.before.unstaged, 'the unstaged change is still unstaged');
    assert.deepEqual(result.after, result.before);
});

test('a registered update never rebases diverged local history', () => {
    const result = runScenario(`${REGISTERED_SETUP}
        commitPush(seed, 'a.txt', 'upstream a\\n');
        writeFile(path.join(checkout, 'c.txt'), 'local commit\\n');
        git(checkout, 'add', 'c.txt');
        git(checkout, 'commit', '-q', '-m', 'local');
        const before = snapshot(checkout);
        const outcome = await capture(() => repos.updateRepo('UnitGitSafety', { stdio: 'ignore' }));
        done({ before, after: snapshot(checkout), outcome });
    `);
    assert.equal(result.after.head, result.before.head, 'the local commit was not rewritten');
    assert.deepEqual(result.after, result.before);
});

test('a registered update preserves a rebase whose autostash lives only in rebase metadata', () => {
    const result = runScenario(`${REGISTERED_SETUP}
        commitPush(seed, 'a.txt', 'upstream a\\n');
        writeFile(path.join(checkout, 'a.txt'), 'local a\\n');
        git(checkout, 'commit', '-q', '-am', 'local a');
        writeFile(path.join(checkout, 'c.txt'), 'dirty c\\n');
        const pulled = gitRaw(checkout, 'pull', '--rebase', '--autostash');
        const before = snapshot(checkout);
        const outcome = await capture(() => repos.updateRepo('UnitGitSafety', { stdio: 'ignore' }));
        done({ pulledStatus: pulled.status, before, after: snapshot(checkout), outcome });
    `);
    assert.notEqual(result.pulledStatus, 0);
    assert.ok(result.before.rebaseMerge && 'autostash' in result.before.rebaseMerge, 'fixture holds an autostash in rebase metadata');
    assert.deepEqual(result.after, result.before);
    assert.ok(result.outcome.error);
});

test('a registered update keeps existing stash object IDs', () => {
    const result = runScenario(`${REGISTERED_SETUP}
        writeFile(path.join(checkout, 'a.txt'), 'stash me\\n');
        git(checkout, 'stash', 'push', '-q', '-m', 'user stash');
        const upstream = commitPush(seed, 'b.txt', 'upstream b\\n');
        const before = snapshot(checkout);
        const outcome = await capture(() => repos.updateRepo('UnitGitSafety', { stdio: 'ignore' }));
        done({ upstream, before, after: snapshot(checkout), outcome });
    `);
    assert.notEqual(result.before.stashes, '');
    assert.equal(result.after.stashes, result.before.stashes);
    assert.equal(result.after.head, result.upstream, 'a clean checkout still advances');
    assert.equal(result.outcome.error, undefined);
});

test('a non-empty managed directory without .git is preserved, not deleted and recloned', () => {
    const result = runScenario(String.raw`
        const { REPOS_DIR } = await import(${JSON.stringify(moduleUrl('cli/utils/config.js'))});
        const repos = await import(${JSON.stringify(moduleUrl('cli/utils/repos.js'))});
        const { remote } = makeRemote('source', { 'README.md': '# source\n' });
        writeFile(path.join(REPOS_DIR, 'Provider', 'agent', 'manifest.json'), JSON.stringify({ repos: { UnitNonGit: remote } }));
        const target = path.join(REPOS_DIR, 'UnitNonGit');
        writeFile(path.join(target, 'notes.txt'), 'user data\n');
        const outcome = await capture(() => repos.updateRepo('UnitNonGit', { stdio: 'ignore' }));
        done({
            outcome,
            notes: fs.existsSync(path.join(target, 'notes.txt')) ? fs.readFileSync(path.join(target, 'notes.txt'), 'utf8') : null,
            git: fs.existsSync(path.join(target, '.git')),
        });
    `);
    assert.equal(result.notes, 'user data\n', 'user content survives');
    assert.equal(result.git, false, 'the directory was not replaced by a clone');
    assert.ok(result.outcome.error);
});

test('a dirty workspace Ploinky checkout is preserved instead of autostashed', () => {
    const result = runScenario(String.raw`
        const { updateWorkspacePloinkySource } = await import(${JSON.stringify(moduleUrl('ploinky-box/command/hostUpdate.mjs'))});
        const { updatePloinkySelf } = await import(${JSON.stringify(moduleUrl('cli/commands/updateService.js'))});
        const files = {
            'package.json': JSON.stringify({ name: 'ploinky-cloud', bin: { ploinky: './bin/ploinky' } }),
            'bin/ploinky': '#!/bin/sh\n',
            'ploinky-box/bin/ploinky-box.mjs': '// fixture\n',
            'remote.txt': 'one\n',
            'local.txt': 'clean\n',
        };
        const { remote, seed } = makeRemote('ploinky', files);
        const checkout = path.join(workspaceReal, 'ploinky');
        clone(remote, checkout);
        commitPush(seed, 'remote.txt', 'two\n');
        writeFile(path.join(checkout, 'local.txt'), 'dirty local edit\n');
        const installed = path.join(scratch, 'installed-ploinky');
        fs.mkdirSync(installed);
        const identity = { workspaceRoot: workspaceReal, instance: 'ploinky-box-workspace-123456789abc' };
        const before = snapshot(checkout);
        const outcome = await capture(() => updateWorkspacePloinkySource({
            identity,
            lock: { assertHeld() {} },
            repositoryRoot: installed,
            updateScopeRoot: workspaceReal,
            updateSelf: options => updatePloinkySelf({ ...options, boxMarkerPath: path.join(scratch, 'not-a-box') }),
        }));
        done({ before, after: snapshot(checkout), outcome });
    `);
    assert.equal(result.after.head, result.before.head);
    assert.equal(result.after.files['local.txt'], 'dirty local edit\n');
    assert.equal(result.after.files['remote.txt'], 'one\n');
    assert.deepEqual(result.after, result.before);
});

const WORKSPACE_AGENT_SETUP = String.raw`
const commands = await import(${JSON.stringify(moduleUrl('cli/commands/repoAgentCommands.js'))});
const { remote, seed } = makeRemote('agents', {
    'demo/manifest.json': JSON.stringify({ container: 'node:20-alpine', agent: 'node index.js' }),
    'a.txt': 'a1\n',
});
const checkout = path.join(workspaceReal, 'agentsrepo');
clone(remote, checkout);
const isCheckoutLine = line => [checkout, fs.realpathSync(checkout), path.join(workspaceRoot, 'agentsrepo')]
    .some(location => line.startsWith('-C ' + location + ' '));
// Read-only inspection (status, rev-parse, stash list, config) is allowed.
const mutatingLine = line => / (?:pull|fetch|merge|rebase|reset|checkout|stash (?:push|pop|apply|drop|save|store))(?: |$)/.test(line);
`;

test('a registered update that is refused is not retried through the generic workspace loop', () => {
    const result = runScenario(`${WORKSPACE_AGENT_SETUP}
        git(seed, 'push', '-q', 'origin', 'main:other');
        commitPush(seed, 'a.txt', 'other branch content\\n', 'HEAD:other');
        git(checkout, 'fetch', '-q', 'origin');
        git(checkout, 'branch', '--set-upstream-to=origin/other', 'main');
        const before = snapshot(checkout);
        fs.rmSync(process.env.PLOINKY_TEST_GIT_TRACE, { force: true });
        const outcome = await capture(() => commands.updateAllRepos(workspaceReal, { interactiveSession: true }));
        const pulls = traceLines().filter(line => isCheckoutLine(line) && mutatingLine(line));
        done({ before, after: snapshot(checkout), outcome: { error: outcome.error || null }, pulls });
    `);
    assert.equal(result.after.head, result.before.head, 'the refused registered checkout did not move');
    assert.equal(result.after.index, result.before.index);
    assert.equal(result.after.staged, result.before.staged);
    assert.equal(result.after.files['a.txt'], result.before.files['a.txt']);
    assert.deepEqual(result.pulls, [], 'no fetch, pull or merge reached the refused checkout');
});

test('one checkout reached through two workspace spellings is updated exactly once', () => {
    const result = runScenario(`${WORKSPACE_AGENT_SETUP}
        const upstream = commitPush(seed, 'a.txt', 'upstream a\\n');
        fs.rmSync(process.env.PLOINKY_TEST_GIT_TRACE, { force: true });
        const outcome = await capture(() => commands.updateAllRepos(workspaceReal, { interactiveSession: true }));
        const pulls = traceLines().filter(line => isCheckoutLine(line) && / (?:pull|fetch)(?: |$)/.test(line));
        done({ upstream, head: git(checkout, 'rev-parse', 'HEAD'), outcome: { error: outcome.error || null }, pulls });
    `, { workspaceAlias: true });
    assert.equal(result.outcome.error, null);
    assert.equal(result.head, result.upstream);
    assert.equal(result.pulls.length, 1, `exactly one network update for the physical checkout:\n${result.pulls.join('\n')}`);
});
