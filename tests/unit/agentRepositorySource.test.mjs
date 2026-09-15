import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const sourceUrl = new URL('../../cli/utils/agentRepositorySource.mjs', import.meta.url).href;
const utilsUrl = new URL('../../cli/utils/utils.js', import.meta.url).href;

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-repository-alias-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky/repos'), { recursive: true });
    return root;
}

function checkout(root, name, origin) {
    const directory = path.join(root, name);
    fs.mkdirSync(path.join(directory, 'explorer'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'explorer/manifest.json'), '{}');
    if (origin) {
        execFileSync('git', ['init', '-q', directory]);
        execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', origin]);
    }
    return directory;
}

function resolve(root, alias) {
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
        const source = await import(${JSON.stringify(sourceUrl)});
        const { findAgent } = await import(${JSON.stringify(utilsUrl)});
        let result;
        try { result = findAgent('explorer'); } catch (error) { result = { error: error.message }; }
        console.log(JSON.stringify({ owner: source.resolveAgentRepositoryName(source.resolveAgentRepositoryPath(${JSON.stringify(alias)}) + '/explorer'), names: source.listAgentRepositoryNames(), path: source.resolveAgentRepositoryPath(${JSON.stringify(alias)}), result }));
    `], { encoding: 'utf8', cwd: root, env: { ...process.env, PLOINKY_WORKSPACE_ROOT: root } }));
}

test('registered alias uses the workspace origin and does not duplicate the agent', t => {
    const root = fixture(t);
    checkout(root, '.ploinky/repos/AchillesIDE');
    const local = checkout(root, 'AssistOSExplorer', 'git@github.com:AssistOS-AI/AssistOSExplorer.git');
    const result = resolve(root, 'AchillesIDE');
    assert.deepEqual(result.names, ['AchillesIDE']);
    assert.equal(result.path, local);
    assert.equal(result.result.repo, 'AchillesIDE');
    assert.equal(result.owner, 'AchillesIDE');
    assert.equal(result.result.manifestPath, path.join(local, 'explorer/manifest.json'));
});

test('stored repository aliases also work without a cached checkout', t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, '.ploinky/repo_sources.json'), JSON.stringify({ custom: { url: 'https://example.com/team/editor.git' } }));
    const local = checkout(root, 'editor-development', 'ssh://git@example.com/team/editor.git');
    const result = resolve(root, 'custom');
    assert.deepEqual(result.names, ['custom']);
    assert.equal(result.path, local);
    assert.equal(result.result.repo, 'custom');
    assert.equal(result.owner, 'custom');
});

test('an unrelated repository with the same agent remains ambiguous', t => {
    const root = fixture(t);
    checkout(root, '.ploinky/repos/AchillesIDE');
    checkout(root, 'AssistOSExplorer', 'https://example.com/other/editor.git');
    const result = resolve(root, 'AchillesIDE');
    assert.deepEqual(result.names, ['AchillesIDE', 'AssistOSExplorer']);
    assert.equal(result.path, path.join(root, '.ploinky/repos/AchillesIDE'));
    assert.match(result.result.error, /ambiguous/);
});

test('same-name local checkouts keep the existing workspace preference', t => {
    const root = fixture(t);
    checkout(root, '.ploinky/repos/custom');
    const local = checkout(root, 'custom');
    const result = resolve(root, 'custom');
    assert.deepEqual(result.names, ['custom']);
    assert.equal(result.path, local);
});

function query(root, expression) {
    const reposUrl = new URL('../../cli/utils/repos.js', import.meta.url).href;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
        const repos = await import(${JSON.stringify(reposUrl)});
        const source = await import(${JSON.stringify(sourceUrl)});
        console.log(JSON.stringify(${expression}));
    `], { encoding: 'utf8', cwd: root, env: { ...process.env, PLOINKY_WORKSPACE_ROOT: root } }));
}

for (const cached of [false, true]) test(`manifest dependencies use the selected workspace source (cached=${cached})`, t => {
    const root = fixture(t);
    const local = checkout(root, 'parent');
    fs.writeFileSync(path.join(local, 'explorer/manifest.json'), JSON.stringify({ repos: { child: { url: 'https://example.com/current.git' } } }));
    if (cached) {
        const old = checkout(root, '.ploinky/repos/parent');
        fs.writeFileSync(path.join(old, 'explorer/manifest.json'), JSON.stringify({ repos: { child: { url: 'https://example.com/stale.git' } } }));
    }
    assert.equal(query(root, "repos.resolveRepoSource('child')").url, 'https://example.com/current.git');
});

for (const operation of ['addRepo', 'ensureRepoInstalled', 'installRepo']) test(`${operation} reuses and records a new alias without cloning or switching the local branch`, t => {
    const root = fixture(t);
    const url = 'https://example.com/team/editor.git';
    const local = checkout(root, 'editor-dev', url);
    const before = fs.readFileSync(path.join(local, '.git/HEAD'), 'utf8');
    const call = operation === 'installRepo'
        ? `repos.installRepo(${JSON.stringify(url)}, 'newAlias', 'requested-branch')`
        : operation === 'ensureRepoInstalled'
            ? `repos.ensureRepoInstalled('newAlias', ${JSON.stringify(url)}, { branch: 'requested-branch' })`
            : `repos.addRepo('newAlias', ${JSON.stringify(url)}, 'requested-branch')`;
    const result = query(root, `({ installed: ${call}, selected: source.resolveAgentRepositoryPath('newAlias'), names: source.listAgentRepositoryNames() })`);
    assert.equal(result.installed.path, local);
    assert.equal(result.selected, local);
    assert.deepEqual(result.names, ['newAlias']);
    assert.equal(fs.existsSync(path.join(root, '.ploinky/repos/newAlias')), false);
    assert.equal(fs.readFileSync(path.join(local, '.git/HEAD'), 'utf8'), before);
});


test('mount diagnostics resolve the alias of a workspace checkout', t => {
    const root = fixture(t);
    const local = checkout(root, 'AssistOSExplorer', 'https://github.com/AssistOS-AI/AssistOSExplorer.git');
    const registryUrl = new URL('../../cli/sandbox/docker/containerRegistry.js', import.meta.url).href;
    const expression = `(await import(${JSON.stringify(registryUrl)})).parseAgentInfoFromMounts([{ Destination: '/code', Source: ${JSON.stringify(path.join(local, 'explorer'))} }])`;
    assert.deepEqual(query(root, expression), { repoName: 'AchillesIDE', agentName: 'explorer' });
});

for (const cached of [false, true]) test(`installed and active lists include workspace aliases once (cached=${cached})`, t => {
    const root = fixture(t);
    checkout(root, 'AssistOSExplorer', 'https://github.com/AssistOS-AI/AssistOSExplorer.git');
    if (cached) checkout(root, '.ploinky/repos/AchillesIDE');
    checkout(root, '.ploinky/repos/managed');
    const result = query(root, '({ installed: repos.getInstalledRepos(), active: repos.getActiveRepos() })');
    assert.deepEqual(result.installed, ['AchillesIDE', 'managed']);
    assert.deepEqual(result.active, result.installed);
});

test('active lists filter enabled names against selected registered sources', t => {
    const root = fixture(t);
    checkout(root, 'AssistOSExplorer', 'https://github.com/AssistOS-AI/AssistOSExplorer.git');
    checkout(root, 'removed');
    checkout(root, '.ploinky/repos/inactive');
    fs.symlinkSync(path.join(root, 'missing-target'), path.join(root, '.ploinky/repos/broken'));
    fs.writeFileSync(path.join(root, '.ploinky/unregistered_agent_repos.json'), JSON.stringify(['removed']));
    fs.writeFileSync(path.join(root, '.ploinky/enabled_repos.json'), JSON.stringify(['missing', 'removed', 'AchillesIDE', 'broken']));
    const result = query(root, '({ installed: repos.getInstalledRepos(), active: repos.getActiveRepos() })');
    assert.deepEqual(result.installed, ['AchillesIDE', 'inactive']);
    assert.deepEqual(result.active, ['AchillesIDE']);
});

test('empty repository lists require no managed cache directory', t => {
    const root = fixture(t);
    fs.rmdirSync(path.join(root, '.ploinky/repos'));
    assert.deepEqual(query(root, '({ installed: repos.getInstalledRepos(), active: repos.getActiveRepos() })'), { installed: [], active: [] });
});
