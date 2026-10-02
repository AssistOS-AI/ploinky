import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildBwrapArgs } from '../../cli/sandbox/bwrap/bwrapServiceManager.js';
import { AGENTLIB_STABLE_MOUNT_PATH } from '../../agentlib/contract.mjs';
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';

function hasUsableBwrap() {
    const probe = spawnSync('bwrap', [
        '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '/bin/true',
    ], { stdio: 'ignore' });
    return probe.status === 0;
}

function grantFor(root) {
    const contract = agentLibFixture(root);
    return {
        sourceDir: contract.sourceDir,
        runtimePath: AGENTLIB_STABLE_MOUNT_PATH,
        mode: contract.mode,
        fingerprint: contract.fingerprint,
        commit: '',
        sourceIdHash: contract.sourceIdHash,
        namespaced: true,
    };
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

function setenvValues(args, name) {
    const values = [];
    for (let index = 0; index < args.length - 2; index += 1) {
        if (args[index] === '--setenv' && args[index + 1] === name) values.push(args[index + 2]);
    }
    return values;
}

function fixture(prefix) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    const agentCodePath = path.join(root, '.ploinky', 'repos', 'repo', 'agent');
    const nodeModulesDir = path.join(root, '.ploinky', 'deps', 'store', 'objects', '11111111-2222-4333-8444-555555555555', 'payload', 'node_modules');
    const sharedDir = path.join(root, '.data', 'shared');
    const agentLibPath = path.join(root, 'Agent');
    const agentHomeDir = path.join(root, '.data', 'lifecycle');
    for (const dir of [
        agentCodePath, nodeModulesDir, sharedDir, path.join(agentLibPath, 'node_modules'),
        agentHomeDir, path.join(root, '.ploinky', 'data'),
    ]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(root, '.ploinky', 'controller-sentinel'), 'controller');
    fs.writeFileSync(path.join(root, '.ploinky', 'data', 'sentinel'), 'controller');
    fs.writeFileSync(path.join(root, 'workspace-marker'), 'workspace');
    return { root, agentCodePath, nodeModulesDir, sharedDir, agentLibPath, agentHomeDir };
}

function argsFor(layout, overrides = {}) {
    return buildBwrapArgs({
        workspaceRoot: layout.root,
        agentCodePath: layout.agentCodePath,
        agentLibGrant: grantFor(layout.root),
        agentLibPath: layout.agentLibPath,
        nodeModulesDir: layout.nodeModulesDir,
        sharedDir: layout.sharedDir,
        skillsPath: null,
        envMap: {},
        codeReadOnly: true,
        skillsReadOnly: true,
        volumes: {},
        ...overrides,
    });
}

test('static isolated bwrap agent binds the workspace at /root and its private home at /home/agent', () => {
    const layout = fixture('bwrap-static-home-');
    try {
        const args = argsFor(layout, {
            cwd: layout.root,
            cwdMountTarget: '/root',
            agentHomeDir: layout.agentHomeDir,
            envMap: { HOME: '/root' },
        });
        const all = mounts(args);

        const atRoot = all.filter(mount => mount.target === '/root');
        assert.equal(atRoot.length, 1, 'exactly one bind targets /root');
        assert.deepEqual([atRoot[0].readOnly, atRoot[0].source], [false, layout.root]);

        const atHome = all.filter(mount => mount.target === '/home/agent');
        assert.equal(atHome.length, 1, 'exactly one bind targets /home/agent');
        assert.deepEqual([atHome[0].readOnly, atHome[0].source], [false, layout.agentHomeDir]);

        assert.equal(all.some(mount => mount.source === layout.agentHomeDir && mount.target === '/root'), false,
            'the per-instance home must not shadow the workspace at /root');
        assert.deepEqual(setenvValues(args, 'HOME'), ['/home/agent']);

        const dirIndex = args.findIndex((value, index) => value === '--dir' && args[index + 1] === '/home/agent');
        assert.ok(dirIndex >= 0, 'the /home/agent mount point is created explicitly');
        assert.ok(dirIndex < atHome[0].index, 'the mount point exists before the home bind');

        const targets = all.map(mount => mount.target);
        assert.equal(new Set(targets.filter(target => target === '/root' || target === '/home/agent')).size, 2);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('static isolated bwrap agent keeps the controller guards under the /root workspace bind', () => {
    const layout = fixture('bwrap-static-guards-');
    try {
        const args = argsFor(layout, {
            cwd: layout.root,
            cwdMountTarget: '/root',
            agentHomeDir: layout.agentHomeDir,
        });
        const all = mounts(args);
        const controller = all.filter(mount => mount.target === '/root/.ploinky');
        assert.equal(controller.length, 1);
        assert.deepEqual([controller[0].readOnly, controller[0].source], [true, path.join(layout.root, '.ploinky')]);

        const state = all.filter(mount => mount.target === '/root/.ploinky/data');
        assert.equal(state.length, 1);
        assert.equal(state[0].readOnly, true);
        assert.notEqual(state[0].source, path.join(layout.root, '.ploinky', 'data'),
            'controller state is masked by an empty guard, not exposed');
        assert.ok(state[0].index > controller[0].index, 'the state mask follows the controller parent pin');
        assert.ok(state[0].index > all.find(mount => mount.target === '/root').index,
            'the guards follow the workspace bind');

        assert.equal(all.some(mount => mount.target.startsWith('/home/agent/.ploinky')), false);
        // The selected AgentLib source lives inside the workspace; its writable
        // alias under /root must be shadowed read-only after the workspace bind.
        const grant = grantFor(layout.root);
        const shadow = all.find(mount => mount.target === '/root/achillesAgentLib');
        assert.ok(shadow, 'the AgentLib alias under /root is shadowed');
        assert.deepEqual([shadow.readOnly, shadow.source], [true, grant.sourceDir]);
        assert.ok(shadow.index > all.find(mount => mount.target === '/root').index);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('normal isolated bwrap agent keeps one /root home bind and HOME=/root', () => {
    const layout = fixture('bwrap-isolated-home-');
    try {
        const args = argsFor(layout, {
            cwd: layout.agentHomeDir,
            cwdMountTarget: '/root',
            agentHomeDir: layout.agentHomeDir,
            envMap: { HOME: '/root' },
        });
        const all = mounts(args);
        const atRoot = all.filter(mount => mount.target === '/root');
        assert.equal(atRoot.length, 1);
        assert.deepEqual([atRoot[0].readOnly, atRoot[0].source], [false, layout.agentHomeDir]);
        assert.equal(all.some(mount => mount.target === '/home/agent'), false);
        assert.equal(args.includes('/home/agent'), false);
        assert.deepEqual(setenvValues(args, 'HOME'), ['/root']);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('global bwrap agent keeps its host-path project bind and the /root home bind', () => {
    const layout = fixture('bwrap-global-home-');
    try {
        const args = argsFor(layout, {
            cwd: layout.root,
            agentHomeDir: layout.agentHomeDir,
            envMap: { HOME: '/root' },
        });
        const all = mounts(args);
        assert.deepEqual(all.filter(mount => mount.target === layout.root).map(mount => mount.source), [layout.root]);
        assert.deepEqual(all.filter(mount => mount.target === '/root').map(mount => mount.source), [layout.agentHomeDir]);
        assert.equal(all.some(mount => mount.target === '/home/agent'), false);
        assert.deepEqual(setenvValues(args, 'HOME'), ['/root']);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('real bwrap static layout shows the workspace at /root and a writable HOME', { skip: !hasUsableBwrap() }, () => {
    const layout = fixture('bwrap-static-live-');
    try {
        const args = argsFor(layout, {
            cwd: layout.root,
            cwdMountTarget: '/root',
            agentHomeDir: layout.agentHomeDir,
        });
        const probe = [
            'set -eu',
            'test "$HOME" = /home/agent',
            'test "$(cat /root/workspace-marker)" = workspace',
            'test "$(cat /root/.ploinky/controller-sentinel)" = controller',
            'test -z "$(ls -A /root/.ploinky/data)"',
            'if touch /root/.ploinky/escaped 2>/dev/null; then exit 74; fi',
            'if touch /root/.ploinky/data/escaped 2>/dev/null; then exit 75; fi',
            'touch "$HOME/persisted"',
            'test -f /root/.data/lifecycle/persisted',
            'touch /root/project-write',
            'echo BWRAP_STATIC_HOME_OK',
        ].join('; ');
        const result = spawnSync('bwrap', [...args, '/bin/sh', '-c', probe], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /BWRAP_STATIC_HOME_OK/);
        assert.equal(fs.existsSync(path.join(layout.agentHomeDir, 'persisted')), true);
        assert.equal(fs.existsSync(path.join(layout.root, 'project-write')), true);
        assert.equal(fs.existsSync(path.join(layout.root, '.ploinky', 'escaped')), false);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});
