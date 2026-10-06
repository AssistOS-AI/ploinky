import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readOriginFromGitConfig } from '../../cli/utils/repositoryOriginConfig.mjs';

const execute = childProcess.execFileSync;
const gitEnvironment = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
function oracle(directory) {
    try {
        return execute('git', ['-C', directory, 'config', '--get', 'remote.origin.url'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnvironment(),
        }).replace(/\n$/, '');
    } catch { return ''; }
}
function fixture(t, config) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-config-'));
    execute('git', ['init', '-q', root], { env: gitEnvironment() });
    fs.writeFileSync(path.join(root, '.git/config'), config);
    const overridden = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GIT_CONFIG') || key === 'GIT_DIR' || key === 'GIT_TEST_ASSUME_DIFFERENT_OWNER'));
    for (const key of Object.keys(overridden)) delete process.env[key];
    let spawns = 0;
    // Only the oracle/subprocess receives isolation variables. The parser's
    // environment stays ordinary, so a zero-spawn assertion exercises parsing.
    const mocked = t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
        if (command === 'git') spawns += 1;
        return execute(command, args, { ...options, env: gitEnvironment() });
    });
    syncBuiltinESMExports();
    t.after(() => {
        mocked.mock.restore();
        syncBuiltinESMExports();
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('GIT_CONFIG') || key === 'GIT_DIR' || key === 'GIT_TEST_ASSUME_DIFFERENT_OWNER') delete process.env[key];
        }
        Object.assign(process.env, overridden);
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, spawns: () => spawns };
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
for (const [name, config] of cases) test(`origin parser matches Git without spawning: ${name}`, t => {
    const { root, spawns } = fixture(t, config);
    assert.equal(readOriginFromGitConfig(root), oracle(root));
    assert.equal(spawns(), 0);
});

for (const [name, config] of [
    ['include', plain + '[include]\npath = extra\n'],
    ['conditional include', plain + '[includeIf "gitdir:**"]\npath = extra\n'],
    ['missing origin', '[core]\nfilemode = true\n'],
    ['bad escape after origin', plain + '[core]\nvalue = bad\\q\n'],
    ['bad header after origin', plain + '[bad header]\n'],
    ['unterminated quote', plain + 'url = "broken\n'],
    ['worktree config', plain + '[extensions]\nworktreeConfig = true\n'],
]) test(`origin reader delegates to Git: ${name}`, t => {
    const { root, spawns } = fixture(t, config);
    fs.writeFileSync(path.join(root, '.git/extra'), '[remote "origin"]\nurl = included\n');
    fs.writeFileSync(path.join(root, '.git/config.worktree'), '[remote "origin"]\nurl = worktree\n');
    assert.equal(readOriginFromGitConfig(root), oracle(root));
    assert.equal(spawns(), 1);
});

test('gitdir file uses Git for linked worktrees and submodules', t => {
    const { root, spawns } = fixture(t, plain);
    fs.renameSync(path.join(root, '.git'), path.join(root, 'actual-git'));
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: actual-git\n');
    assert.equal(readOriginFromGitConfig(root), oracle(root));
    assert.equal(readOriginFromGitConfig(root), 'https://example.test/team/repo.git');
    assert.equal(spawns(), 2);
});

for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG', 'GIT_DIR']) {
    test(`environment override delegates to Git: ${key}`, t => {
        const { root, spawns } = fixture(t, plain);
        process.env[key] = key === 'GIT_DIR' ? path.join(root, '.git') : key === 'GIT_CONFIG_GLOBAL' || key === 'GIT_CONFIG' ? '/dev/null' : '';
        assert.equal(readOriginFromGitConfig(root), oracle(root));
        assert.equal(spawns(), 1);
    });
}

for (const relative of ['', '.git']) test(`ownership refusal is retained for ${relative || 'repository'}`, t => {
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
    assert.equal(spawns(), 1);
});
