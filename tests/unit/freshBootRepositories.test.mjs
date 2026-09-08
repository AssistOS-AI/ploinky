import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const expectedRepos = ['AchillesCLI', 'AchillesIDE', 'copilot-agents'];

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-fresh-boot-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const remotes = path.join(root, 'remotes');
    fs.mkdirSync(workspace);
    fs.mkdirSync(remotes);
    // Rewrite every predefined source to a local Git fixture. A missing fixture
    // fails locally rather than reaching the network or a saved checkout.
    const env = {
        ...process.env,
        PLOINKY_WORKSPACE_ROOT: workspace,
        PLOINKY_MASTER_KEY: '5'.repeat(64),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.${remotes}/.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/AssistOS-AI/',
        GIT_ALLOW_PROTOCOL: 'file',
    };
    for (const name of ['AssistOSExplorer', 'AchillesCLI', 'copilot-agents', 'Basic']) {
        const source = path.join(remotes, `${name}.git`);
        fs.mkdirSync(source);
        const git = (args) => execFileSync('git', args, { cwd: source, env, stdio: 'ignore' });
        git(['init', '-q', '-b', 'main']);
        if (name === 'AssistOSExplorer') {
            fs.mkdirSync(path.join(source, 'explorer'));
            fs.writeFileSync(path.join(source, 'explorer', 'manifest.json'), JSON.stringify({
                container: 'node:20',
                // Stop the real start path at graph resolution, before any
                // runtime/network mutation, after repository preparation.
                enable: ['fixtureMissingService'],
            }));
            git(['add', '.']);
        }
        git(['-c', 'user.name=Ploinky Fixture', '-c', 'user.email=fixture@example.invalid',
            'commit', '-q', '--allow-empty', '-m', 'Local boot fixture']);
    }
    const fakeBin = path.join(root, 'bin');
    fs.mkdirSync(fakeBin);
    for (const command of ['podman', 'docker']) {
        fs.writeFileSync(path.join(fakeBin, command), '#!/bin/sh\necho unexpected-runtime-call >&2\nexit 99\n', { mode: 0o755 });
    }
    env.PATH = `${fakeBin}${path.delimiter}${env.PATH}`;
    return { workspace, env };
}

function run(f, args) {
    if (args[0] === path.join(repoRoot, 'cli/index.js')) {
        // The suite supplies the validated AgentLib contract, as the Box host
        // does. Exercise CLI dispatch and real repository preparation without
        // staging a second, unrelated AgentLib checkout for every fixture.
        args = ['--input-type=module', '-e', `
            const { launchCli } = await import(${JSON.stringify(new URL('../../cli/index.js', import.meta.url).href)});
            try {
                const result = await launchCli(${JSON.stringify(args.slice(1))}, {
                    bootstrapAgentLibImpl: async () => ({ owned: false }),
                });
                if (Number.isInteger(result)) process.exitCode = result;
            } catch (error) {
                console.error(error.message);
                process.exitCode = 1;
            }
        `];
    }
    const result = spawnSync(process.execPath, args, {
        cwd: f.workspace, env: f.env, encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /unexpected-runtime-call/);
    return result;
}

function assertDefaultRepos(f) {
    const state = path.join(f.workspace, '.ploinky');
    assert.deepEqual(fs.readdirSync(path.join(state, 'repos')).sort(), expectedRepos);
    const sources = JSON.parse(fs.readFileSync(path.join(state, 'repo_sources.json'), 'utf8'));
    assert.deepEqual(Object.keys(sources).sort(), expectedRepos);
    const enabledPath = path.join(state, 'enabled_repos.json');
    const enabled = fs.existsSync(enabledPath) ? JSON.parse(fs.readFileSync(enabledPath, 'utf8')) : [];
    assert.equal(enabled.includes('basic'), false);
    assert.equal(enabled.includes('webmeetInfra'), false);
}

test('initialization and repeated bootstrap seed only default repositories in an empty workspace', (t) => {
    const f = fixture(t);
    const script = `
        const { initEnvironment } = await import(${JSON.stringify(new URL('../../cli/utils/config.js', import.meta.url).href)});
        const { bootstrap, prepareDefaultBootRepositories } = await import(${JSON.stringify(new URL('../../cli/commands/ploinkyboot.js', import.meta.url).href)});
        initEnvironment();
        bootstrap();
        bootstrap();
        prepareDefaultBootRepositories({ staticAgent: 'explorer' });
    `;
    const result = run(f, ['--input-type=module', '-e', script]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assertDefaultRepos(f);
    assert.equal((result.stdout.match(/repository cloned successfully/g) || []).length, 3);
});

test('fresh start explorer prepares its sources without installing or registering basic', (t) => {
    const f = fixture(t);
    const result = run(f, [path.join(repoRoot, 'cli/index.js'), 'start', 'explorer']);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /fixtureMissingService/);
    assertDefaultRepos(f);
    assert.equal(fs.existsSync(path.join(f.workspace, '.ploinky', 'agents.json')), false);
});

test('explicit install and enable basic survive subsequent automatic bootstrap', (t) => {
    const f = fixture(t);
    for (const args of [['install', 'repo', 'basic'], ['enable', 'repo', 'basic'], ['list', 'repos']]) {
        const result = run(f, [path.join(repoRoot, 'cli/index.js'), ...args]);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
    const state = path.join(f.workspace, '.ploinky');
    assert.deepEqual(fs.readdirSync(path.join(state, 'repos')).sort(), [...expectedRepos, 'basic'].sort());
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'enabled_repos.json'), 'utf8')), ['basic']);
    const sources = JSON.parse(fs.readFileSync(path.join(state, 'repo_sources.json'), 'utf8'));
    assert.equal(sources.basic.url, 'https://github.com/AssistOS-AI/Basic.git');
});
