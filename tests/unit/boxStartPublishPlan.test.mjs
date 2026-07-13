import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const serviceUrl = pathToFileURL(path.join(repoRoot, 'cli/services/boxStartPublishPlan.js')).href;
const entryPath = path.join(repoRoot, 'container/box-start-publish-plan.mjs');

function workspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-service-'));
    fs.mkdirSync(path.join(root, '.ploinky', 'repos'), { recursive: true });
    return root;
}

function writeManifest(root, repo, agent, manifest) {
    const dir = path.join(root, '.ploinky', 'repos', repo, agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function runPlan(root, request, optionsSource = '{ bootRepos: [] }') {
    const script = `
const { createBoxStartPublishPlan } = await import(${JSON.stringify(serviceUrl)});
const result = await createBoxStartPublishPlan(${JSON.stringify(request)}, ${optionsSource});
process.stdout.write(JSON.stringify(result));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root,
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: root,
            PLOINKY_MASTER_KEY: '5'.repeat(64),
        },
        encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout);
}

test('authoritative plan includes selected graph plus enabled agents without registry mutation', () => {
    const root = workspace();
    try {
        writeManifest(root, 'app', 'root', {
            profiles: { default: { openPorts: ['127.0.0.1:9001:7001'] } },
            enable: [{ agent: 'deps/worker global', profile: 'lan' }],
        });
        writeManifest(root, 'deps', 'worker', {
            profiles: {
                default: { openPorts: ['127.0.0.1:9199:7199'] },
                lan: { openPorts: ['127.0.0.1:9002:7002/udp'] },
            },
        });
        writeManifest(root, 'extra', 'enabled', {
            profiles: { default: { openPorts: ['127.0.0.1:9003:7003'] } },
        });
        const registry = {
            _config: { static: { agent: 'app/root', port: 8080 } },
            extra_container: {
                type: 'agent', repoName: 'extra', agentName: 'enabled', profile: 'default',
            },
        };
        const registryPath = path.join(root, '.ploinky', 'agents.json');
        const before = JSON.stringify(registry, null, 2);
        fs.writeFileSync(registryPath, before);

        const plan = runPlan(root, {
            schemaVersion: 2,
            operation: 'start',
            root: 'app/root',
            profile: 'default',
            includeEnabled: true,
        });

        assert.deepEqual(plan.nodes.map((entry) => entry.agentRef), ['app/root', 'deps/worker', 'extra/enabled']);
        assert.equal(plan.nodes.find((entry) => entry.agentRef === 'deps/worker').profile, 'lan');
        for (const expected of [
            '127.0.0.1:9001:9001',
            '127.0.0.1:9002:9002/udp',
            '127.0.0.1:9003:9003',
        ]) assert.ok(plan.generatedPublishes.includes(expected));
        assert.equal(plan.claims.filter((claim) => claim.privateContainer.start === 7000).length, 3);
        assert.equal(fs.readFileSync(registryPath, 'utf8'), before);
        assert.equal(fs.existsSync(path.join(root, '.data')), false);
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'routing.json')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('effective-instance profile conflicts report both paths and profiles', () => {
    const root = workspace();
    try {
        writeManifest(root, 'app', 'root', {
            enable: ['graph/left', 'graph/right'],
            profiles: { default: {} },
        });
        writeManifest(root, 'graph', 'left', {
            enable: [{ agent: 'graph/shared', profile: 'dev' }],
            profiles: { default: {} },
        });
        writeManifest(root, 'graph', 'right', {
            enable: [{ agent: 'graph/shared', profile: 'prod' }],
            profiles: { default: {} },
        });
        writeManifest(root, 'graph', 'shared', {
            profiles: { default: {}, dev: {}, prod: {} },
        });
        const script = `
const { createBoxStartPublishPlan } = await import(${JSON.stringify(serviceUrl)});
try {
  await createBoxStartPublishPlan({ schemaVersion: 2, operation: 'start', root: 'app/root' }, { bootRepos: [] });
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error.message }));
}`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: root,
            env: { ...process.env, PLOINKY_WORKSPACE_ROOT: root, PLOINKY_MASTER_KEY: '5'.repeat(64) },
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.ok, false);
        assert.match(output.message, /conflicting profiles for effective instance graph\/shared#canonical/);
        assert.match(output.message, /profile 'dev'/);
        assert.match(output.message, /profile 'prod'/);
        assert.match(output.message, /graph\/left/);
        assert.match(output.message, /graph\/right/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('distinct aliases may select different profiles for one canonical agent', () => {
    const root = workspace();
    try {
        writeManifest(root, 'app', 'root', {
            enable: [
                { agent: 'graph/shared', alias: 'blue', profile: 'dev' },
                { agent: 'graph/shared', alias: 'green', profile: 'prod' },
            ],
            profiles: { default: {} },
        });
        writeManifest(root, 'graph', 'shared', {
            profiles: {
                default: {},
                dev: { openPorts: ['127.0.0.1:9101:7000'] },
                prod: { openPorts: ['127.0.0.1:9102:7000'] },
            },
        });
        const plan = runPlan(root, { schemaVersion: 2, operation: 'start', root: 'app/root' });
        assert.deepEqual(
            plan.nodes.filter((entry) => entry.agentRef === 'graph/shared').map(({ alias, profile }) => ({ alias, profile })),
            [{ alias: 'blue', profile: 'dev' }, { alias: 'green', profile: 'prod' }],
        );
        assert.ok(plan.generatedPublishes.includes('127.0.0.1:9101:9101'));
        assert.ok(plan.generatedPublishes.includes('127.0.0.1:9102:9102'));
        assert.equal(plan.claims.filter((claim) => claim.privateContainer.start === 7000).length, 3);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('targeted starting operations preserve saved alias and canonical profiles and container identities', () => {
    const root = workspace();
    try {
        writeManifest(root, 'demo', 'shared', {
            profiles: {
                default: { openPorts: ['127.0.0.1:18100:7000'] },
                dev: { openPorts: ['127.0.0.1:18101:7000'] },
                prod: { openPorts: ['127.0.0.1:18102:7000'] },
            },
        });
        writeManifest(root, 'demo', 'solo', {
            profiles: {
                default: { openPorts: ['127.0.0.1:18200:7000'] },
                dev: { openPorts: ['127.0.0.1:18201:7000'] },
                prod: { openPorts: ['127.0.0.1:18202:7000'] },
            },
        });
        writeManifest(root, 'demo', 'fresh', {
            profiles: {
                default: { openPorts: ['127.0.0.1:18500:7000'] },
                dev: { openPorts: ['127.0.0.1:18501:7000'] },
            },
        });
        fs.writeFileSync(path.join(root, '.ploinky', 'profile'), 'default\n');
        fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify({
            alias_container: {
                type: 'agent', repoName: 'demo', agentName: 'shared', alias: 'blue', profile: 'dev',
            },
            canonical_container: {
                type: 'agent', repoName: 'demo', agentName: 'solo', profile: 'prod',
            },
        }, null, 2));

        for (const operation of ['cli', 'shell', 'restart', 'reinstall']) {
            const aliasPlan = runPlan(root, {
                schemaVersion: 2,
                operation,
                root: 'blue',
                // Targeted public commands do not expose a profile option. Even
                // an internal request field must not override the saved record.
                profile: 'prod',
                includeEnabled: false,
            });
            assert.equal(aliasPlan.profile, 'dev', `${operation} alias profile`);
            assert.deepEqual(aliasPlan.nodes.map((node) => ({
                agentRef: node.agentRef,
                alias: node.alias,
                profile: node.profile,
                containerName: node.containerName,
                openPorts: node.openPorts,
            })), [{
                agentRef: 'demo/shared',
                alias: 'blue',
                profile: 'dev',
                containerName: 'alias_container',
                openPorts: ['127.0.0.1:18101:7000'],
            }]);
            assert.deepEqual(aliasPlan.generatedPublishes, ['127.0.0.1:18101:18101']);

            const canonicalPlan = runPlan(root, {
                schemaVersion: 2,
                operation,
                root: 'demo/solo',
                profile: 'dev',
                includeEnabled: false,
            });
            assert.equal(canonicalPlan.profile, 'prod', `${operation} canonical profile`);
            assert.deepEqual(canonicalPlan.nodes.map((node) => ({
                agentRef: node.agentRef,
                alias: node.alias,
                profile: node.profile,
                containerName: node.containerName,
                openPorts: node.openPorts,
            })), [{
                agentRef: 'demo/solo',
                alias: '',
                profile: 'prod',
                containerName: 'canonical_container',
                openPorts: ['127.0.0.1:18202:7000'],
            }]);
            assert.deepEqual(canonicalPlan.generatedPublishes, ['127.0.0.1:18202:18202']);
        }

        const explicitStartPlan = runPlan(root, {
            schemaVersion: 2,
            operation: 'start',
            root: 'demo/fresh',
            profile: 'dev',
            includeEnabled: true,
        });
        const staticNode = explicitStartPlan.nodes.find((node) => node.isStatic);
        assert.equal(explicitStartPlan.profile, 'dev');
        assert.equal(staticNode.profile, 'dev');
        assert.deepEqual(staticNode.openPorts, ['127.0.0.1:18501:7000']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('targeted canonical planning reports the same enabled-instance ambiguity as core', () => {
    const root = workspace();
    try {
        writeManifest(root, 'demo', 'shared', { profiles: { default: {} } });
        fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify({
            blue_container: {
                type: 'agent', repoName: 'demo', agentName: 'shared', alias: 'blue', profile: 'default',
            },
            green_container: {
                type: 'agent', repoName: 'demo', agentName: 'shared', alias: 'green', profile: 'default',
            },
        }, null, 2));

        assert.throws(
            () => runPlan(root, {
                schemaVersion: 2, operation: 'cli', root: 'demo/shared', includeEnabled: false,
            }),
            /Multiple containers found for agent 'demo\/shared'\. Use alias: blue, green/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function createBootRemote() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-remote-'));
    const bare = path.join(root, 'AchillesIDE.git');
    const work = path.join(root, 'work');
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main', work], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'config', 'user.email', 'tests@ploinky.invalid'], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'config', 'user.name', 'Ploinky Tests'], { stdio: 'ignore' });
    const explorer = path.join(work, 'explorer');
    const office = path.join(work, 'onlyOffice');
    fs.mkdirSync(explorer, { recursive: true });
    fs.mkdirSync(office, { recursive: true });
    fs.writeFileSync(path.join(explorer, 'manifest.json'), JSON.stringify({
        enable: ['onlyOffice global'], profiles: { default: {} },
    }));
    fs.writeFileSync(path.join(office, 'manifest.json'), JSON.stringify({
        profiles: { default: { openPorts: ['127.0.0.1:17002:7000'] } },
    }));
    execFileSync('git', ['-C', work, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'commit', '-m', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'checkout', '-b', 'ploinky-box'], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'commit', '--allow-empty', '-m', 'box'], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'remote', 'add', 'origin', bare], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'push', 'origin', 'main', 'ploinky-box'], { stdio: 'ignore' });
    execFileSync('git', ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' });
    return { root, bare };
}

function createDefaultOnlyRemote() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-fallback-remote-'));
    const bare = path.join(root, 'fallback.git');
    const work = path.join(root, 'work');
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main', work], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'config', 'user.email', 'tests@ploinky.invalid'], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'config', 'user.name', 'Ploinky Tests'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(work, 'README.md'), 'fallback fixture\n');
    execFileSync('git', ['-C', work, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'commit', '-m', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'remote', 'add', 'origin', bare], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'push', 'origin', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' });
    return { root, bare };
}

test('independent empty workspaces resolve bare, slash, and colon roots to the same branch graph', () => {
    const remote = createBootRemote();
    const roots = ['explorer', 'AchillesIDE/explorer', 'AchillesIDE:explorer'];
    const workspaces = [];
    try {
        const plans = roots.map((rootRef) => {
            const root = workspace();
            workspaces.push(root);
            const options = `{ bootRepos: [{ name: 'AchillesIDE', url: ${JSON.stringify(remote.bare)} }] }`;
            return runPlan(root, {
                schemaVersion: 2,
                operation: 'start',
                root: rootRef,
                profile: 'default',
                branchPolicy: { branch: 'ploinky-box', repoBranches: {}, fallback: 'fail', resetRepos: false },
            }, options);
        });
        const comparable = plans.map((plan) => ({
            root: plan.root,
            profile: plan.profile,
            nodes: plan.nodes.map(({ agentRef, profile, alias, repoCommit, openPorts }) => ({ agentRef, profile, alias, repoCommit, openPorts })),
            edges: plan.edges,
            claims: plan.claims.map(({ ownerRef, profile, alias, raw, protocol, boxSide, privateContainer }) => ({ ownerRef, profile, alias, raw, protocol, boxSide, privateContainer })),
            publishes: plan.publishes,
        }));
        assert.deepEqual(comparable[1], comparable[0]);
        assert.deepEqual(comparable[2], comparable[0]);
        assert.equal(comparable[0].root, 'AchillesIDE/explorer');
        assert.ok(comparable[0].publishes.includes('127.0.0.1:17002:17002'));
        assert.equal(comparable[0].claims.some((claim) => claim.privateContainer.start === 7000), true);
    } finally {
        for (const root of workspaces) fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(remote.root, { recursive: true, force: true });
    }
});

test('empty-workspace bare ambiguity inventories boot repos and fails before operational mutation', () => {
    const remote = createBootRemote();
    const root = workspace();
    try {
        const script = `
const { createBoxStartPublishPlan } = await import(${JSON.stringify(serviceUrl)});
try {
  await createBoxStartPublishPlan(
    { schemaVersion: 2, operation: 'start', root: 'explorer' },
    { bootRepos: [
      { name: 'AchillesIDE', url: ${JSON.stringify(remote.bare)} },
      { name: 'OtherIDE', url: ${JSON.stringify(remote.bare)} },
    ] },
  );
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error.message }));
}`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: root,
            env: { ...process.env, PLOINKY_WORKSPACE_ROOT: root, PLOINKY_MASTER_KEY: '5'.repeat(64) },
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const output = JSON.parse(result.stdout);
        assert.equal(output.ok, false);
        assert.match(output.message, /Agent name 'explorer' is ambiguous/);
        assert.match(output.message, /AchillesIDE:explorer/);
        assert.match(output.message, /OtherIDE:explorer/);
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'repos', 'AchillesIDE', 'explorer', 'manifest.json')), true);
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'repos', 'OtherIDE', 'explorer', 'manifest.json')), true);
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'agents.json')), false);
        assert.equal(fs.existsSync(path.join(root, '.ploinky', 'routing.json')), false);
        assert.equal(fs.existsSync(path.join(root, '.data')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(remote.root, { recursive: true, force: true });
    }
});

test('direct-node entry emits one compact JSON document with no prompt or log output', () => {
    const root = workspace();
    try {
        for (const repo of ['basic', 'AchillesIDE', 'AchillesCLI', 'copilot-agents']) {
            fs.mkdirSync(path.join(root, '.ploinky', 'repos', repo), { recursive: true });
        }
        writeManifest(root, 'AchillesIDE', 'explorer', {
            enable: ['AchillesIDE/cycle'],
            profiles: { default: {} },
        });
        writeManifest(root, 'AchillesIDE', 'cycle', {
            enable: ['AchillesIDE/explorer'],
            profiles: { default: {} },
        });
        const request = JSON.stringify({ schemaVersion: 2, operation: 'start', root: 'explorer' });
        const result = spawnSync(process.execPath, [entryPath], {
            cwd: root,
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: root,
                PLOINKY_MASTER_KEY: '5'.repeat(64),
                PLOINKY_DEBUG: '1',
                NODE_PATH: '',
            },
            input: request,
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout.trim().split('\n').length, 1);
        assert.equal(JSON.parse(result.stdout).root, 'AchillesIDE/explorer');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('direct-node entry suppresses branch-fallback chatter before its JSON response', () => {
    const root = workspace();
    const remote = createDefaultOnlyRemote();
    try {
        for (const repo of ['basic', 'AchillesIDE', 'AchillesCLI', 'copilot-agents']) {
            fs.mkdirSync(path.join(root, '.ploinky', 'repos', repo), { recursive: true });
        }
        writeManifest(root, 'AchillesIDE', 'explorer', {
            repos: {
                fallbackRepo: remote.bare,
            },
            profiles: { default: {} },
        });
        const request = JSON.stringify({
            schemaVersion: 2,
            operation: 'start',
            root: 'explorer',
            branchPolicy: {
                branch: 'ploinky-box',
                repoBranches: {},
                fallback: 'default',
                resetRepos: false,
            },
        });
        const result = spawnSync(process.execPath, [entryPath], {
            cwd: root,
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: root,
                PLOINKY_MASTER_KEY: '5'.repeat(64),
            },
            input: request,
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout.trim().split('\n').length, 1);
        assert.doesNotMatch(result.stdout, /\[repos\] Branch/);
        assert.equal(JSON.parse(result.stdout).root, 'AchillesIDE/explorer');
        assert.equal(
            fs.existsSync(path.join(root, '.ploinky', 'repos', 'fallbackRepo', 'README.md')),
            true,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(remote.root, { recursive: true, force: true });
    }
});

test('direct-node entry reserves stderr for planner failures', () => {
    const root = workspace();
    try {
        const result = spawnSync(process.execPath, [entryPath], {
            cwd: root,
            env: {
                ...process.env,
                PLOINKY_WORKSPACE_ROOT: root,
                PLOINKY_MASTER_KEY: '5'.repeat(64),
            },
            input: '{}',
            encoding: 'utf8',
        });
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^box start publish planner failed:/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
