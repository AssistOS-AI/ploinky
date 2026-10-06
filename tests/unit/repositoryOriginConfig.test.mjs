import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readOriginFromGitConfig, readOriginFromGitConfigAsync } from '../../cli/utils/repositoryOriginConfig.mjs';
import { workspaceRepositoryPath, prefetchWorkspaceRepositoryOrigins } from '../../cli/utils/repositorySource.mjs';
import { runWithRepositoryResolutionScope } from '../../cli/utils/repositoryResolutionScope.mjs';

const execute = childProcess.execFileSync;
const gitEnvironment = () => ({ ...process.env });
function oracle(directory) {
    try {
        return execute('git', ['-C', directory, 'config', '--get', 'remote.origin.url'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnvironment(),
        }).replace(/\n$/, '');
    } catch { return ''; }
}
function fixture(t, config) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-config-'));
    const root = path.join(base, 'checkout');
    const relevant = key => key.startsWith('GIT_') || key === 'HOME' || key === 'XDG_CONFIG_HOME';
    const overridden = Object.fromEntries(Object.entries(process.env).filter(([key]) => relevant(key)));
    for (const key of Object.keys(overridden)) delete process.env[key];
    process.env.HOME = path.join(base, 'home');
    process.env.XDG_CONFIG_HOME = path.join(base, 'xdg');
    fs.mkdirSync(process.env.HOME);
    fs.mkdirSync(path.join(process.env.XDG_CONFIG_HOME, 'git'), { recursive: true });
    execute('git', ['init', '-q', root], { env: gitEnvironment() });
    fs.writeFileSync(path.join(root, '.git/config'), config);
    let spawns = 0;
    // Reader and oracle see the same private HOME/XDG and repository-selection
    // environment. Do not hide effective-config failures behind /dev/null.
    const mocked = t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
        if (command === 'git') spawns += 1;
        return execute(command, args, { ...options, env: gitEnvironment() });
    });
    syncBuiltinESMExports();
    t.after(() => {
        mocked.mock.restore();
        syncBuiltinESMExports();
        for (const key of Object.keys(process.env)) {
            if (relevant(key)) delete process.env[key];
        }
        Object.assign(process.env, overridden);
        fs.rmSync(base, { recursive: true, force: true });
    });
    return { root, base, spawns: () => spawns };
}

const plain = '[remote "origin"]\nurl = https://example.test/team/repo.git\n';
const cases = [
    ['plain', plain],
    ['section and key case', '[REMOTE "origin"]\nURL = git@example.test:team/repo.git\n'],
    ['subsection is case sensitive', '[remote "Origin"]\nurl = wrong\n' + plain],
    ['last value', plain + 'url = last\n'],
    ['legacy header last', plain + '[REMOTE.ORIGIN]\nurl = legacy\n'],
    ['modern header last', '[remote.origin]\nurl = legacy\n' + plain],
    ['BOM and CRLF', '\uFEFF' + plain.replaceAll('\n', '\r\n')],
    ['quoted whitespace', '[remote "origin"]\nurl = "  a b  "\n'],
    ['quoted comments', '[remote "origin"]\nurl = "a#b;c" # ignored\n'],
    ['unquoted comments', '[remote "origin"]\nurl = a b  ; ignored\n'],
    ['escapes', '[remote "origin"]\nurl = "a\\tb\\nc\\bd\\\"e\\\\f"\n'],
    ['continuation', '[remote "origin"]\nurl = https://example.test/\\\nteam/repo.git\n'],
    ['quoted continuation', '[remote "origin"]\nurl = "a\\\nb"\n'],
    ['escaped subsection', '[remote "ori\\gin"]\nurl = escaped\n'],
    ['inline variable', '[remote "origin"] url = inline\n'],
    ['empty URL', '[remote "origin"]\nurl =\n'],
];
for (const [name, config] of cases) test(`sync and async origin readers match Git: ${name}`, async t => {
    const { root, spawns } = fixture(t, config);
    assert.equal(readOriginFromGitConfig(root), oracle(root));
    assert.equal(await readOriginFromGitConfigAsync(root), oracle(root));
    assert.equal(spawns(), 1, 'async reader never invokes synchronous Git');
});

for (const [name, config] of [
    ['include', plain + '[include]\npath = extra\n'],
    ['conditional include', plain + '[includeIf "gitdir:**"]\npath = extra\n'],
    ['missing origin', '[core]\nfilemode = true\n'],
    ['bad escape after origin', plain + '[core]\nvalue = bad\\q\n'],
    ['bad header after origin', plain + '[bad header]\n'],
    ['unterminated quote', plain + 'url = "broken\n'],
    ['worktree config', plain + '[extensions]\nworktreeConfig = true\n'],
]) test(`origin reader delegates to Git: ${name}`, async t => {
    const { root, spawns } = fixture(t, config);
    fs.writeFileSync(path.join(root, '.git/extra'), '[remote "origin"]\nurl = included\n');
    fs.writeFileSync(path.join(root, '.git/config.worktree'), '[remote "origin"]\nurl = worktree\n');
    assert.equal(readOriginFromGitConfig(root), oracle(root));
    assert.equal(await readOriginFromGitConfigAsync(root), oracle(root));
    assert.equal(spawns(), 1);
});

test('gitdir file uses Git for linked worktrees and submodules', async t => {
    const { root, spawns } = fixture(t, plain);
    fs.renameSync(path.join(root, '.git'), path.join(root, 'actual-git'));
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: actual-git\n');
    assert.equal(readOriginFromGitConfig(root), oracle(root));
    assert.equal(readOriginFromGitConfig(root), 'https://example.test/team/repo.git');
    assert.equal(await readOriginFromGitConfigAsync(root), oracle(root));
    assert.equal(spawns(), 2);
});

for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG', 'GIT_DIR']) {
    test(`environment override delegates to Git: ${key}`, async t => {
        const { root, spawns } = fixture(t, plain);
        process.env[key] = key === 'GIT_DIR' ? path.join(root, '.git') : key === 'GIT_CONFIG_GLOBAL' || key === 'GIT_CONFIG' ? '/dev/null' : '';
        assert.equal(readOriginFromGitConfig(root), oracle(root));
        assert.equal(await readOriginFromGitConfigAsync(root), oracle(root));
        assert.equal(spawns(), 1);
    });
}

for (const relative of ['', '.git']) test(`ownership refusal is retained for ${relative || 'repository'}`, async t => {
    const { root, spawns } = fixture(t, plain);
    const lstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (target, ...options) => {
        const stat = lstat(target, ...options);
        if (target === path.join(root, relative)) stat.uid = process.geteuid() + 1;
        return stat;
    });
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
    assert.equal(oracle(root), '', 'Git refuses this untrusted checkout');
    assert.equal(readOriginFromGitConfig(root), '');
    assert.equal(await readOriginFromGitConfigAsync(root), '');
    assert.equal(spawns(), 1);
});

test('safe.directory grants remain Git-authoritative', async t => {
    const { root } = fixture(t, plain);
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
    fs.writeFileSync(path.join(process.env.HOME, '.gitconfig'), `[safe]\ndirectory = ${root}\n`);
    assert.equal(oracle(root), 'https://example.test/team/repo.git');
    assert.equal(readOriginFromGitConfig(root), oracle(root));
    assert.equal(await readOriginFromGitConfigAsync(root), oracle(root));
});

const registered = 'https://example.test/team/registered.git';
const alternate = 'https://example.test/team/alternate.git';
for (const name of ['plain', 'stray-config', 'missing-head', 'invalid-head', 'missing-objects', 'missing-refs', 'future-repository-format', 'unknown-extension', 'bad-core-bare', 'global-malformed', 'xdg-malformed', 'global-include-malformed', 'global-overridden-valid', 'common-dir-alternate']) {
    test(`identity regression oracle and alias selection: ${name}`, async t => {
        const { root, base } = fixture(t, `[remote "origin"]\nurl = ${registered}\n`);
        const git = path.join(root, '.git');
        if (name === 'stray-config') {
            for (const entry of fs.readdirSync(git)) if (entry !== 'config') fs.rmSync(path.join(git, entry), { recursive: true, force: true });
        }
        for (const [caseName, entry] of [['missing-head', 'HEAD'], ['missing-objects', 'objects'], ['missing-refs', 'refs']]) {
            if (name === caseName) fs.rmSync(path.join(git, entry), { recursive: true, force: true });
        }
        if (name === 'invalid-head') fs.writeFileSync(path.join(git, 'HEAD'), 'invalid head\n');
        if (name === 'future-repository-format') fs.appendFileSync(path.join(git, 'config'), '[core]\nrepositoryformatversion = 999\n');
        if (name === 'unknown-extension') fs.appendFileSync(path.join(git, 'config'), '[core]\nrepositoryformatversion = 1\n[extensions]\nunknownthing = true\n');
        if (name === 'bad-core-bare') fs.appendFileSync(path.join(git, 'config'), '[core]\nbare = invalid\n');
        if (name === 'global-malformed') fs.writeFileSync(path.join(process.env.HOME, '.gitconfig'), '[broken\n');
        if (name === 'xdg-malformed') fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME, 'git/config'), '[broken\n');
        if (name === 'global-include-malformed') {
            fs.writeFileSync(path.join(process.env.HOME, 'broken'), '[broken\n');
            fs.writeFileSync(path.join(process.env.HOME, '.gitconfig'), '[include]\npath = broken\n');
        }
        if (name === 'global-overridden-valid') fs.writeFileSync(path.join(process.env.HOME, '.gitconfig'), '[remote "origin"]\nurl = https://example.test/global.git\n');
        if (name === 'common-dir-alternate') {
            const common = path.join(base, '.alternate');
            execute('git', ['init', '--bare', '-q', common], { env: gitEnvironment() });
            fs.appendFileSync(path.join(common, 'config'), `[remote "origin"]\nurl = ${alternate}\n`);
            process.env.GIT_COMMON_DIR = common;
        }
        const expected = ['plain', 'global-overridden-valid'].includes(name) ? registered : name === 'common-dir-alternate' ? alternate : '';
        assert.equal(oracle(root), expected);
        assert.equal(readOriginFromGitConfig(root), expected);
        assert.equal(await readOriginFromGitConfigAsync(root), expected);
        const select = url => workspaceRepositoryPath('registered-alias', { workspaceRoot: base, url });
        assert.equal(select(registered), expected === registered ? root : null);
        await runWithRepositoryResolutionScope(async () => {
            await prefetchWorkspaceRepositoryOrigins(base);
            assert.equal(select(registered), expected === registered ? root : null);
            assert.equal(select(alternate), expected === alternate ? root : null);
        });
    });
}
