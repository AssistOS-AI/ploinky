import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initializeBoxGitTransport } from '../../ploinky-box/lib/gitTransport.mjs';
import { BOX_MARKER_CONTENT, BOX_MARKER_PATH } from '../../ploinky-box/constants.mjs';
import { launchCli } from '../../cli/index.js';

// Lifecycle hook modules resolve workspace paths when imported.
const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'box-git-transport-'));
const priorWorkspace = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const { executeHostHook } = await import('../../cli/utils/runtime/lifecycleHooks.js');
test.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    if (priorWorkspace === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = priorWorkspace;
});

function fixture(t) {
    const root = fs.mkdtempSync(path.join(workspace, 'fixture-'));
    const config = path.join(root, 'gitconfig');
    fs.writeFileSync(config, '[http]\n\tversion = HTTP/2\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_CONFIG_')));
    Object.assign(env, {
        PLOINKY_WORKSPACE_ROOT: root,
        HOME: root,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_PARAMETERS: "'test.inherited=kept' 'http.version=HTTP/2'",
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'test.counted',
        GIT_CONFIG_VALUE_0: 'also-kept',
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, config, env };
}

function gitValue(name, { root, env }) {
    const result = spawnSync('git', ['config', '--get', name], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function boxMarker(t, root, content = BOX_MARKER_CONTENT) {
    const marker = path.join(root, 'box-marker');
    fs.writeFileSync(marker, content);
    for (const name of ['lstatSync', 'readFileSync']) {
        const original = fs[name];
        t.mock.method(fs, name, (filename, ...args) => original(filename === BOX_MARKER_PATH ? marker : filename, ...args));
    }
}

test('Box Git transport is inherited by real Git children, retains other parameters and is idempotent', (t) => {
    const f = fixture(t);
    const originalConfig = fs.readFileSync(f.config, 'utf8');
    assert.equal(gitValue('http.version', f), 'HTTP/2');
    initializeBoxGitTransport({ env: f.env, insideBox: true });
    assert.equal(gitValue('http.version', f), 'HTTP/1.1');
    assert.equal(gitValue('test.inherited', f), 'kept');
    assert.equal(gitValue('test.counted', f), 'also-kept');
    const configured = f.env.GIT_CONFIG_PARAMETERS;
    for (let count = 0; count < 100; count += 1) initializeBoxGitTransport({ env: f.env, insideBox: true });
    assert.equal(f.env.GIT_CONFIG_PARAMETERS, configured);
    assert.equal(fs.readFileSync(f.config, 'utf8'), originalConfig);
});

test('outside the Box, initialization leaves both the environment and Git transport unchanged', (t) => {
    const f = fixture(t);
    const before = { ...f.env };
    assert.equal(initializeBoxGitTransport({ env: f.env, insideBox: false }), f.env);
    assert.deepEqual(f.env, before);
    assert.equal(gitValue('http.version', f), 'HTTP/2');
});

test('a malformed Box marker fails before any Git environment mutation', (t) => {
    const f = fixture(t);
    boxMarker(t, f.root, 'not-a-box');
    const before = { ...f.env };
    assert.throws(() => initializeBoxGitTransport({ env: f.env }), { code: 'PLOINKY_BOX_MARKER_INVALID' });
    assert.deepEqual(f.env, before);
});

test('the Box launcher configures transport before bootstrap and an executable lifecycle hook', async (t) => {
    const f = fixture(t);
    boxMarker(t, f.root);
    const previousEnv = process.env;
    process.env = f.env;
    t.after(() => { process.env = previousEnv; });
    const hook = path.join(f.root, 'preinstall.sh');
    const output = path.join(f.root, 'hook-result');
    fs.writeFileSync(hook, '#!/bin/sh\ngit config --get http.version > "$HOOK_RESULT"\ngit config --get test.inherited >> "$HOOK_RESULT"\n');
    const originalConfig = fs.readFileSync(f.config, 'utf8');
    let bootstrapped = false;
    let hookRan = false;
    const code = await launchCli(['start', 'fixture'], {
        bootstrapAgentLibImpl: async ({ env }) => {
            assert.equal(gitValue('http.version', { root: f.root, env }), 'HTTP/1.1');
            bootstrapped = true;
            return { owned: false };
        },
        importCoreImpl: async () => ({
            runCoreCli: async () => {
                assert.equal(bootstrapped, true);
                const result = executeHostHook(hook, { HOOK_RESULT: output }, { cwd: f.root });
                assert.equal(result.success, true, result.message);
                hookRan = true;
                return 0;
            },
        }),
    });
    assert.equal(code, 0);
    assert.equal(hookRan, true);
    assert.equal(fs.readFileSync(output, 'utf8'), 'HTTP/1.1\nkept\n');
    assert.equal(fs.readFileSync(f.config, 'utf8'), originalConfig);
});
