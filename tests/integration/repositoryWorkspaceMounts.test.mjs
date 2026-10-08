import '../helpers/isolatedWorkspaceRoot.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { appendControllerStateGuards } from '../../cli/sandbox/docker/agentServiceManager.js';

// Opt-in, local-image-only Podman check. It uses disposable repositories and
// no network, credentials, application containers, or deployment operations.
const image = process.env.PLOINKY_TEST_REPOSITORY_IMAGE;

for (const target of ['/workspace', '/root']) {
    test(`real Podman: Git operations work under ${target}/.ploinky/repos without exposing controller state`, {
        skip: !image && 'PLOINKY_TEST_REPOSITORY_IMAGE must select a local image with Node and Git',
        timeout: 30000,
    }, t => {
        const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repository-podman-check-')));
        t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
        const repo = path.join(workspace, '.ploinky', 'repos', 'demo');
        const code = path.join(repo, 'agent');
        const dependencies = path.join(workspace, '.ploinky', 'deps');
        for (const directory of [code, dependencies, path.join(workspace, '.ploinky', 'data'), path.join(workspace, '.data')]) {
            fs.mkdirSync(directory, { recursive: true });
        }
        fs.writeFileSync(path.join(code, 'source.txt'), 'immutable code');
        fs.writeFileSync(path.join(dependencies, 'dependency.txt'), 'immutable dependency');
        fs.writeFileSync(path.join(workspace, '.ploinky', 'data', 'synthetic-secret'), 'not visible');

        const args = ['run', '--rm', '--pull=never', '--network=none', '--ipc=none', '--user', '0:0',
            '-v', `${workspace}:${target}:z`, '-v', `${code}:/code:z,ro`,
            '-v', `${code}:${target}/.ploinky/repos/demo/agent:z,ro`];
        appendControllerStateGuards(args, 'podman', { workspaceRoot: workspace, canonicalRuntimeWorkspaceGuards: false });
        const script = `
            const fs = require('node:fs');
            const assert = require('node:assert/strict');
            const { execFileSync } = require('node:child_process');
            const root = process.argv[1];
            const repo = root + '/.ploinky/repos/demo';
            const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' }).trim();
            git('init', '--initial-branch=main');
            git('config', 'user.name', 'Repository test');
            git('config', 'user.email', 'repository-test@example.invalid');
            assert.equal(git('config', '--local', '--get', 'user.name'), 'Repository test');
            fs.writeFileSync(repo + '/change.txt', 'first');
            git('add', 'change.txt');
            git('commit', '-m', 'Test repository write');
            fs.writeFileSync(repo + '/change.txt', 'second');
            git('checkout', '--', 'change.txt');
            assert.equal(fs.readFileSync(repo + '/change.txt', 'utf8'), 'first');
            for (const file of [root + '/.ploinky/blocked', root + '/.ploinky/deps/dependency.txt',
                root + '/.ploinky/data/blocked', '/code/source.txt', repo + '/agent/source.txt']) {
                assert.throws(() => fs.writeFileSync(file, 'blocked'), error => error.code === 'EROFS');
            }
            assert.deepEqual(fs.readdirSync(root + '/.ploinky/data'), []);
            fs.writeFileSync(root + '/.data/agent-test', 'writable');
            console.log('Git identity/stage/commit/checkout passed; controller, code and dependencies protected');
        `;
        const result = spawnSync('podman', [...args, '--entrypoint', '/usr/local/bin/node', image, '-e', script, target], {
            encoding: 'utf8', timeout: 25000,
        });
        assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /Git identity\/stage\/commit\/checkout passed/);
        assert.equal(fs.readFileSync(path.join(workspace, '.ploinky', 'data', 'synthetic-secret'), 'utf8'), 'not visible');
        assert.equal(fs.readFileSync(path.join(dependencies, 'dependency.txt'), 'utf8'), 'immutable dependency');
        assert.equal(fs.readFileSync(path.join(code, 'source.txt'), 'utf8'), 'immutable code');
    });
}
