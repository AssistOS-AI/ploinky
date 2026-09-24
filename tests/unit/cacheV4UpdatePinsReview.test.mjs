import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { refreshUpdateGitPins } from '../../cli/utils/dependencies/cacheV4/updatePins.mjs';
import { createCacheStore } from '../../cli/utils/dependencies/cacheV4/objectStore.mjs';
import { collectGitInputs, desiredPinsFor } from '../../cli/utils/dependencies/cacheV4/gitPins.mjs';
import { buildAgentInstallPlan } from '../../cli/utils/dependencies/cacheV4/installContract.mjs';
import { fakeLease, gitEnv, git, hostProvider, makeAgentLib, markerRemote, tempRoot } from './cacheV4Fixtures.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fixture(t) {
    const root = tempRoot(t, 'pin-update-review-');
    const env = gitEnv(root);
    const remote = markerRemote(root, env);
    const repo = path.join(root, 'checkout');
    fs.mkdirSync(path.join(repo, 'agent', 'code'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'agent', 'manifest.json'), '{"agent":"node index.js"}');
    fs.writeFileSync(path.join(repo, 'agent', 'package.json'), '{"dependencies":{"ignored-root":"github:should/not-query"}}');
    const packageFile = path.join(repo, 'agent', 'code', 'package.json');
    const spec = `${remote.url}#main`;
    fs.writeFileSync(packageFile, JSON.stringify({ name: 'agent', dependencies: { markerpkg: spec } }));
    const { lease, assertLease } = fakeLease();
    const store = createCacheStore({ workspaceRoot: root, depsDir: path.join(root, '.ploinky', 'deps'), assertLease });
    const registry = {
        _config: {},
        alias_a: { type: 'agent', repoName: 'Repo', agentName: 'agent', alias: 'a' },
        alias_b: { type: 'agent', repoName: 'Repo', agentName: 'agent', alias: 'b' },
        disabled_metadata: { type: 'catalog', repoName: 'Repo', agentName: 'agent' },
        unrelated: { type: 'agent', repoName: 'Other', agentName: 'agent' },
    };
    const deps = {
        workspaceRoot: root, readRegistry: () => registry,
        repositoryPath: name => name === 'Repo' ? repo : path.join(root, 'not-selected'),
        readGlobalPackage: () => ({ name: 'global', dependencies: {} }), readSdkBundle: () => null,
        store, assertLease, withLease: async (_options, callback) => callback(lease),
        discoveryOptions: { env },
    };
    const options = { repositoryNames: ['Repo'], sourceOutcomes: [{ phase: 'registered-repository', id: 'Repo', outcome: 'unchanged', details: { checkout: { path: repo } } }] };
    const refresh = extra => refreshUpdateGitPins({ ...options, ...extra }, deps);
    return { root, repo, env, remote, registry, packageFile, spec, store, refresh, deps, options };
}

test('update pins exact enabled aliases and code/ inputs; moved local Git ref changes actual install plan', async t => {
    const w = fixture(t);
    const first = await w.refresh();
    assert.equal(first.queriesRun, 1, 'aliases share one remote query');
    assert.equal(first.records.filter(record => record.outcome === 'changed').length, 2);
    assert.equal(Object.keys(w.store.readPins().pins).length, 2);
    assert.equal(fs.readdirSync(w.store.paths.objects).length, 0, 'update built no cache object');
    const source = path.relative(w.root, w.packageFile);
    const entries = collectGitInputs(JSON.parse(fs.readFileSync(w.packageFile)), { scope: 'registration', registration: 'alias_a', packageSource: source }).entries;
    assert.equal(desiredPinsFor(w.store.readPins().pins, entries)[0].commit, w.remote.first);
    const agentLib = makeAgentLib(w.root);
    const provider = hostProvider({ agentLib });
    const plan = () => buildAgentInstallPlan({ provider, globalPackage: { name: 'global', dependencies: {} },
        registration: 'alias_a', agentLibSelection: agentLib, pinState: w.store.readPins().pins,
        agentPackage: { selection: 'code', relativePath: source, sha256: 'f'.repeat(64), manifest: JSON.parse(fs.readFileSync(w.packageFile)) } });
    const key = plan().inputKey;
    const second = await w.refresh();
    assert.equal(second.changed, false);
    assert.equal(second.records.every(record => record.outcome === 'unchanged'), true);
    assert.equal(plan().inputKey, key);
    git(w.remote.remote, ['update-ref', 'refs/heads/main', w.remote.second], w.env);
    await w.refresh();
    assert.notEqual(plan().inputKey, key);
    assert.equal(plan().installManifest.dependencies.markerpkg, `${w.remote.url}#${w.remote.second}`);
});

test('failed Git resolution retains only the same original spec and reports a required failure', async t => {
    const w = fixture(t);
    await w.refresh();
    const initial = w.store.readPins().pins;
    w.deps.discoveryOptions.runGit = () => ({ status: 1, stderr: 'offline' });
    const failed = await w.refresh();
    assert.equal(failed.records.every(record => record.outcome === 'failed' && record.required === true), true);
    assert.deepEqual(w.store.readPins().pins, initial);
    assert.equal(failed.records.every(record => record.details.retainedPin), true);
    fs.writeFileSync(w.packageFile, JSON.stringify({ dependencies: { markerpkg: `${w.remote.url}#different` } }));
    const changed = await w.refresh();
    assert.equal(Object.keys(w.store.readPins().pins).length, 0, 'the old branch pin is not used for a changed spec');
    assert.equal(changed.records.some(record => record.details.retainedPin), false);
});

test('unverified source outcomes are not pinned, and unsupported forms are explicit warnings', async t => {
    const w = fixture(t);
    const skipped = await w.refresh({ sourceOutcomes: [{ phase: 'registered-repository', id: 'Repo', outcome: 'skipped' }] });
    assert.equal(skipped.queriesRun, 0);
    assert.equal(skipped.records.every(record => record.code === 'git-pin-source-not-verified'), true);
    assert.equal(fs.existsSync(w.store.paths.pins), false);
    fs.writeFileSync(w.packageFile, JSON.stringify({ dependencies: { markerpkg: `${w.remote.url}#semver:^1` } }));
    const unsupported = await w.refresh();
    assert.equal(unsupported.queriesRun, 0);
    assert.equal(unsupported.records.every(record => record.code === 'git-pin-unsupported' && record.required === false), true);
});

test('update seed pins use effective global input and share discovery with registration pins', async t => {
    const w = fixture(t);
    w.deps.readGlobalPackage = () => ({ name: 'global', dependencies: { globalgit: w.spec } });
    const result = await w.refresh();
    assert.equal(result.queriesRun, 1);
    assert.equal(Object.values(w.store.readPins().pins).filter(pin => pin.binding.scope === 'global').length, 1);
    assert.equal(Object.values(w.store.readPins().pins).filter(pin => pin.binding.scope === 'registration').length, 4);
});

test('empty or registry-only dependency inputs do not create pin/cache state', async t => {
    const w = fixture(t);
    fs.writeFileSync(w.packageFile, '{"dependencies":{"registry-package":"^1.0.0"}}');
    const result = await w.refresh();
    assert.equal(result.queriesRun, 0);
    assert.deepEqual(result.records, []);
    assert.equal(fs.existsSync(w.store.root), false);
    w.deps.readRegistry = () => ({ _config: {} });
    await w.refresh();
    assert.equal(fs.existsSync(w.store.root), false);
});

test('Box SDK declarations are removed before either seed or registration Git discovery', async t => {
    const w = fixture(t);
    w.deps.readGlobalPackage = () => ({ name: 'global', dependencies: { 'mcp-sdk': 'git+https://github.com/AssistOS-AI/MCPSDK.git#main' } });
    w.deps.readSdkBundle = () => ({ schema: 1, repository: { url: 'https://github.com/AssistOS-AI/MCPSDK.git', commit: 'a'.repeat(40) }, contentSha256: 'b'.repeat(64) });
    const result = await w.refresh();
    assert.equal(result.queriesRun, 1, 'only the local agent dependency is queried');
    assert.equal(Object.values(w.store.readPins().pins).some(pin => pin.name === 'mcp-sdk'), false);
});

// Exercise the real public update handlers. Git/npm/engine boundaries are
// isolated; only local repositories are used. The built-in host SDK's query
// is answered by the Git fixture without touching the network.
for (const form of ['repo', 'repos', 'all']) {
    test(`public update ${form} discovers pins without dependency preparation`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-pin-api-'));
        const workspace = path.join(root, 'workspace');
        const stub = path.join(root, 'stub');
        const runtimeRoot = path.join(root, 'runtime-root');
        const npmHome = path.join(root, 'npm-home');
        for (const directory of [workspace, stub, runtimeRoot, npmHome]) fs.mkdirSync(directory, { recursive: true });
        const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
        const engineLog = path.join(root, 'engine.log');
        fs.writeFileSync(path.join(stub, 'git.mjs'), `#!/usr/bin/env node\nimport {spawnSync} from 'node:child_process';\nconst a=process.argv.slice(2);\nif(a[0]==='ls-remote'&&a.includes('https://github.com/AssistOS-AI/MCPSDK.git')){process.stdout.write('${'a'.repeat(40)}\\trefs/heads/main\\n');process.exit(0);}\nif(a[0]==='ls-remote'&&!a.some(x=>x.startsWith('file://'))){process.stderr.write('nonlocal remote prohibited');process.exit(125);}\nconst r=spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);\n`);
        fs.chmodSync(path.join(stub, 'git.mjs'), 0o755);
        fs.symlinkSync('git.mjs', path.join(stub, 'git'));
        for (const name of ['podman', 'docker', 'npm']) {
            fs.writeFileSync(path.join(stub, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${engineLog}'\nexit 125\n`);
            fs.chmodSync(path.join(stub, name), 0o755);
        }
        const moduleUrl = relative => pathToFileURL(path.join(PROJECT, relative)).href;
        const script = `
            import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
            import {gitEnv,git,markerRemote} from ${JSON.stringify(moduleUrl('tests/unit/cacheV4Fixtures.mjs'))};
            const root=${JSON.stringify(root)},workspace=${JSON.stringify(workspace)}, env=gitEnv(root);
            const remote=markerRemote(root,env), source=path.join(root,'agent-source');
            function init(dir,files){fs.mkdirSync(dir,{recursive:true});git(dir,['init','-q','-b','main'],env);for(const [name,bytes] of Object.entries(files)){const f=path.join(dir,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,bytes);}git(dir,['add','.'],env);git(dir,['commit','-qm','fixture'],env);}
            init(source,{'agent/manifest.json':'{"agent":"node index.js","container":"node:20-alpine"}','agent/package.json':JSON.stringify({name:'agent',dependencies:{markerpkg:remote.url+'#main'}}),'agent/index.js':''});
            const repos=path.join(workspace,'.ploinky/repos');fs.mkdirSync(repos,{recursive:true});git(repos,['clone','-q',source,'UnitPinRepo'],env);
            for(const name of ['AchillesCopilotBasicSkills','DocumentationSkills','PloinkySkills']){const s=path.join(root,name);init(s,{'skills/example/SKILL.md':'# fixture'});git(repos,['clone','-q',s,name],env);}
            fs.writeFileSync(path.join(workspace,'.ploinky/agents.json'),JSON.stringify({first_alias:{type:'agent',repoName:'UnitPinRepo',agentName:'agent',alias:'first'},second_alias:{type:'agent',repoName:'UnitPinRepo',agentName:'agent',alias:'second'}}));
            const commands=await import(${JSON.stringify(moduleUrl('cli/commands/repoAgentCommands.js'))});
            const result=await (${form === 'repo' ? "commands.updateRepoResult('UnitPinRepo')" : form === 'repos' ? 'commands.updatePloinkyRepos({interactiveSession:true})' : 'commands.updateAllRepos(workspace,{interactiveSession:true})'});
            const pins=JSON.parse(fs.readFileSync(path.join(workspace,'.ploinky/deps/cache-v4/state/pins.json'))).pins;
            assert.equal(Object.values(pins).filter(p=>p.name==='markerpkg'&&p.commit===remote.first).length,2);
            assert.ok(result.records.some(r=>r.phase==='git-pin'&&r.outcome==='changed'));
            assert.deepEqual(fs.readdirSync(path.join(workspace,'.ploinky/deps/cache-v4/objects')),[]);
            console.log('PINS_API_OK');
        `;
        try {
            const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: workspace,
                env: { ...process.env, ...gitEnv(root), PATH: `${stub}${path.delimiter}${process.env.PATH}`,
                    PLOINKY_WORKSPACE_ROOT: workspace, PLOINKY_ROOT: runtimeRoot,
                    npm_config_cache: path.join(npmHome, 'cache'), npm_config_userconfig: path.join(npmHome, 'npmrc') },
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
            assert.match(output, /PINS_API_OK/);
            assert.equal(fs.existsSync(engineLog), false, 'no engine or npm process was launched');
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
}
