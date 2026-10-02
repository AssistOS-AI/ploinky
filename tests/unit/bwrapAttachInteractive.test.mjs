// attachBwrapInteractive builds its sandbox arguments from the same pieces as
// the service path. The production function runs in a child process against a
// temporary workspace under bwrapAttachHostHooks.mjs, which records the
// argv it would hand to /usr/bin/bwrap instead of launching Bubblewrap.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';
import { wiringWorkspace } from './dependencyStoreWiringHarness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const HOOKS_URL = pathToFileURL(path.join(HERE, 'bwrapAttachHostHooks.mjs')).href;
const MANAGER_URL = pathToFileURL(path.join(ROOT, 'cli/sandbox/bwrap/bwrapServiceManager.js')).href;
const GRANT_URL = pathToFileURL(path.join(ROOT, 'cli/sandbox/agentLibGrant.js')).href;
const RUNTIME_KEY_URL = pathToFileURL(path.join(ROOT, 'cli/utils/dependencies/dependencyRuntimeKey.js')).href;
const ROUTER_URL = pathToFileURL(path.join(ROOT, 'cli/sandbox/routerPort.js')).href;

const CONTAINER = 'ploinky_repo_demo';
const MANIFEST = { 'lite-sandbox': true, start: 'node index.js', network: { mode: 'host' }, readiness: { protocol: 'none' } };

function attach(t, projectPathFor, { agentLibInWorkspace = false } = {}) {
    const w = wiringWorkspace(t, { runtime: 'bwrap', manifest: MANIFEST, packageJson: null, prefix: 'bwrap-attach-' });
    const projectPath = projectPathFor(w);
    fs.mkdirSync(path.join(w.ws, '.ploinky'), { recursive: true });
    // Workspace structure links the agent's code tree here before any sandbox starts.
    fs.mkdirSync(path.join(w.ws, '.ploinky', 'code'), { recursive: true });
    fs.symlinkSync(path.join(w.agentDir, 'code'), path.join(w.ws, '.ploinky', 'code', 'demo'), 'dir');
    fs.writeFileSync(path.join(w.ws, '.ploinky', 'agents.json'), JSON.stringify({
        [CONTAINER]: {
            type: 'agent', runtime: 'bwrap', repoName: 'repo', agentName: 'demo', runMode: 'isolated',
            profile: 'default', instanceId: 'inst-1', enableGeneration: 'gen-1', projectPath,
        },
    }));
    const capture = path.join(w.root, 'bwrap-capture.jsonl');
    // A selected source inside the writable workspace bind is reachable through
    // that bind too, so the interactive sandbox must shadow the alias.
    const agentLibEnv = agentLibInWorkspace
        ? (() => {
            const dir = path.join(w.ws, 'achillesAgentLib');
            writeAgentLibCheckout(dir);
            return { PLOINKY_AGENTLIB_DIR: dir, PLOINKY_TEST_AGENTLIB_DIR: dir };
        })()
        : {};
    const script = `
        import { register } from 'node:module';
        register(${JSON.stringify(HOOKS_URL)});
        const manager = await import(${JSON.stringify(MANAGER_URL)});
        const { agentLibGrant, agentLibGrantEnv } = await import(${JSON.stringify(GRANT_URL)});
        const { detectHostRuntimeKey } = await import(${JSON.stringify(RUNTIME_KEY_URL)});
        const { buildRouterEndpoint } = await import(${JSON.stringify(ROUTER_URL)});
        const grant = agentLibGrant(detectHostRuntimeKey('bwrap'));
        const code = manager.attachBwrapInteractive('demo', ${JSON.stringify(MANIFEST)}, ${JSON.stringify(w.agentDir)},
            ${JSON.stringify(projectPath)}, '/bin/sh', {
                containerName: ${JSON.stringify(CONTAINER)},
                routerEndpoint: buildRouterEndpoint('host', 8080),
            });
        console.log(JSON.stringify({ code, grant, grantEnv: agentLibGrantEnv(grant) }));
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: w.ws,
        env: { ...w.env, ...agentLibEnv, PLOINKY_MASTER_KEY: 'ab'.repeat(32), BWRAP_ATTACH_CAPTURE: capture },
        encoding: 'utf8',
        timeout: 120_000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
    const launches = fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(launches.length, 1, 'the interactive session launches one sandbox');
    return { w, projectPath, result, args: launches[0].args };
}

function mounts(args) {
    const found = [];
    for (let index = 0; index < args.length - 2; index += 1) {
        if (args[index] === '--bind' || args[index] === '--ro-bind') {
            found.push({ index, readOnly: args[index] === '--ro-bind', source: args[index + 1], target: args[index + 2] });
            index += 2;
        }
    }
    return found;
}

function setenvs(args) {
    const env = new Map();
    for (let index = 0; index < args.length - 2; index += 1) {
        if (args[index] === '--setenv') env.set(args[index + 1], args[index + 2]);
    }
    return env;
}

test('attachBwrapInteractive grants the selected AgentLib source and its environment like the service path', (t) => {
    const { w, result, args } = attach(t, (workspace) => path.join(workspace.ws, '.data', 'demo'));
    assert.equal(result.code, 0);
    const { grant } = result;
    const all = mounts(args);
    assert.deepEqual(
        all.filter(mount => mount.target === grant.runtimePath).map(({ readOnly, source }) => [readOnly, source]),
        [[true, grant.sourceDir]],
        'the selected source is bound read-only at its runtime path',
    );
    const env = setenvs(args);
    for (const [name, value] of Object.entries(result.grantEnv)) {
        assert.equal(env.get(name), String(value), `${name} reaches the interactive sandbox`);
    }
    assert.equal(env.get('HOME'), '/root');
    assert.deepEqual(all.filter(mount => mount.target === '/root').map(mount => mount.source),
        [path.join(w.ws, '.data', 'demo')]);
});

test('attachBwrapInteractive gives a static agent the workspace at /root and HOME at /home/agent', (t) => {
    const { w, result, args } = attach(t, (workspace) => workspace.ws);
    assert.equal(result.code, 0);
    const all = mounts(args);
    assert.deepEqual(all.filter(mount => mount.target === '/root').map(mount => mount.source), [w.ws]);
    assert.deepEqual(all.filter(mount => mount.target === '/home/agent').map(mount => mount.source),
        [path.join(w.ws, '.data', 'demo')]);
    assert.equal(setenvs(args).get('HOME'), '/home/agent');
    const controller = all.filter(mount => mount.target === '/root/.ploinky');
    assert.deepEqual(controller.map(({ readOnly, source }) => [readOnly, source]), [[true, path.join(w.ws, '.ploinky')]]);
    const { grant } = result;
    assert.ok(all.some(mount => mount.readOnly && mount.source === grant.sourceDir && mount.target === grant.runtimePath));
});

test('attachBwrapInteractive shadows a writable alias of the selected AgentLib source read-only', (t) => {
    const { w, result, args } = attach(t, (workspace) => workspace.ws, { agentLibInWorkspace: true });
    assert.equal(result.code, 0);
    const { grant } = result;
    assert.equal(grant.sourceDir, path.join(w.ws, 'achillesAgentLib'));
    const all = mounts(args);
    const workspaceBind = all.find(mount => mount.target === '/root');
    const shadow = all.find(mount => mount.target === '/root/achillesAgentLib');
    assert.ok(workspaceBind && shadow, 'the workspace bind and the alias shadow are both present');
    assert.deepEqual([shadow.readOnly, shadow.source], [true, grant.sourceDir]);
    assert.ok(shadow.index > workspaceBind.index, 'the shadow follows the writable workspace bind');
});
