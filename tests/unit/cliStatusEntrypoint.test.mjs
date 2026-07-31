import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { launchCli } from '../../cli/index.js';

function treeHash(root) {
    const hash = crypto.createHash('sha256');
    function walk(directory, relative = '') {
        for (const name of fs.readdirSync(directory).sort()) {
            const target = path.join(directory, name);
            const next = path.join(relative, name);
            const stat = fs.lstatSync(target);
            hash.update(`${next}\0${stat.mode}\0`);
            if (stat.isDirectory()) walk(target, next);
            else if (stat.isFile()) hash.update(fs.readFileSync(target));
            else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(target));
        }
    }
    walk(root);
    return hash.digest('hex');
}

test('status dispatches to its read-only renderer before core initialization', async () => {
    const calls = [];
    const code = await launchCli(['status'], {
        statusWorkspaceImpl: async () => calls.push('status'),
        importCoreImpl: async () => {
            throw new Error('core initialization must not be imported');
        },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, ['status']);
});

test('status renders master-compatible runtime details without changing workspace state', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-status-entrypoint-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ploinky = path.join(root, '.ploinky');
    fs.mkdirSync(path.join(ploinky, 'repos'), { recursive: true });
    fs.writeFileSync(path.join(ploinky, 'routing.json'), '{"port":8080}\n');
    fs.writeFileSync(path.join(ploinky, 'agents.json'), JSON.stringify({
        ploinky_example: {
            type: 'agent',
            runtime: 'podman',
            agentName: 'exampleAgent',
            repoName: 'exampleRepo',
            containerImage: 'example/image:latest',
            createdAt: '2026-07-31T00:00:00.000Z',
            projectPath: '/workspace',
        },
    }));
    const before = treeHash(root);
    for (let invocation = 0; invocation < 2; invocation += 1) {
        const result = spawnSync(process.execPath, [
            path.resolve(import.meta.dirname, '../../cli/index.js'),
            'status',
        ], {
            cwd: root,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: '/usr/bin:/bin',
                NO_COLOR: '1',
                PLOINKY_WORKSPACE_ROOT: root,
            },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Workspace status:/);
        assert.match(result.stdout, /Agent runtimes:/);
        assert.match(result.stdout, /ploinky_example \[stopped\] \[podman\]/);
        assert.match(result.stdout, /agent: exampleAgent  repo: exampleRepo/);
        assert.equal(treeHash(root), before);
    }
});
