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

/**
 * A workspace with a code tree that has no node_modules or skills directory,
 * the way a start-only agent's source looks. `deps` selects the dependency
 * generation: the empty per-agent fallback (start-only, no package.json) or a
 * store payload (package.json with dependencies).
 */
function fixture(prefix, { deps = false } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    const agentCodePath = path.join(root, '.ploinky', 'repos', 'repo', 'agent', 'code');
    const sharedDir = path.join(root, '.data', 'shared');
    const agentLibPath = path.join(root, 'Agent');
    const agentHomeDir = path.join(root, '.data', 'lifecycle');
    const nodeModulesDir = deps
        ? path.join(root, '.ploinky', 'deps', 'store', 'objects', '11111111-2222-4333-8444-555555555555', 'payload', 'node_modules')
        : path.join(agentHomeDir, 'node_modules');
    for (const dir of [
        agentCodePath, sharedDir, path.join(agentLibPath, 'node_modules'), agentHomeDir, nodeModulesDir,
        path.join(root, '.ploinky', 'data'),
    ]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(agentCodePath, 'server.js'), 'setInterval(() => {}, 1000);\n');
    fs.writeFileSync(path.join(nodeModulesDir, 'dependency-sentinel'), 'prepared');
    fs.writeFileSync(path.join(root, '.ploinky', 'controller-sentinel'), 'controller');
    return { root, agentCodePath, sharedDir, agentLibPath, agentHomeDir, nodeModulesDir };
}

function argsFor(layout, overrides = {}) {
    return buildBwrapArgs({
        workspaceRoot: layout.root,
        agentCodePath: layout.agentCodePath,
        agentLibGrant: grantFor(layout.root),
        agentLibPath: layout.agentLibPath,
        nodeModulesDir: layout.nodeModulesDir,
        sharedDir: layout.sharedDir,
        cwd: layout.root,
        cwdMountTarget: '/root',
        agentHomeDir: layout.agentHomeDir,
        skillsPath: null,
        envMap: {},
        codeReadOnly: true,
        skillsReadOnly: true,
        volumes: {},
        ...overrides,
    });
}

for (const [label, deps] of [['start-only agent without package.json', false], ['agent with a dependency-store payload', true]]) {
    test(`read-only /code gets a real empty node_modules mount point for a ${label}`, () => {
        const layout = fixture('bwrap-code-mount-', { deps });
        try {
            const mountPoint = path.join(layout.agentCodePath, 'node_modules');
            assert.equal(fs.existsSync(mountPoint), false, 'precondition: the source tree has no node_modules');
            const args = argsFor(layout);
            const stat = fs.lstatSync(mountPoint);
            assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'the mount point is a real directory');
            assert.deepEqual(fs.readdirSync(mountPoint), [], 'the mount point stays empty');
            const all = mounts(args);
            const code = all.find(mount => mount.target === '/code');
            const nested = all.find(mount => mount.target === '/code/node_modules');
            assert.deepEqual([code.readOnly, code.source], [true, layout.agentCodePath]);
            assert.deepEqual([nested.readOnly, nested.source], [true, layout.nodeModulesDir]);
            assert.ok(nested.index > code.index, 'the nested bind follows the read-only /code bind');
        } finally {
            fs.rmSync(layout.root, { recursive: true, force: true });
        }
    });
}

test('read-only /code gets a skills mount point when the code tree has no skills directory', () => {
    const layout = fixture('bwrap-code-skills-');
    try {
        const skillsPath = path.join(layout.root, '.ploinky', 'repos', 'repo', 'agent', 'skills');
        fs.mkdirSync(skillsPath, { recursive: true });
        const args = argsFor(layout, { skillsPath });
        const mountPoint = path.join(layout.agentCodePath, 'skills');
        assert.deepEqual([fs.lstatSync(mountPoint).isDirectory(), fs.readdirSync(mountPoint)], [true, []]);
        const skills = mounts(args).find(mount => mount.target === '/code/skills');
        assert.deepEqual([skills.readOnly, skills.source], [true, skillsPath]);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('an existing real node_modules directory is mounted over without being modified', () => {
    const layout = fixture('bwrap-code-existing-', { deps: true });
    try {
        const mountPoint = path.join(layout.agentCodePath, 'node_modules');
        fs.mkdirSync(path.join(mountPoint, 'shipped'), { recursive: true });
        fs.writeFileSync(path.join(mountPoint, 'shipped', 'index.js'), 'shipped');
        argsFor(layout);
        assert.deepEqual(fs.readdirSync(mountPoint), ['shipped']);
        assert.equal(fs.readFileSync(path.join(mountPoint, 'shipped', 'index.js'), 'utf8'), 'shipped');
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('a symlinked node_modules is refused and left in place instead of being followed', () => {
    const layout = fixture('bwrap-code-symlink-', { deps: true });
    try {
        const mountPoint = path.join(layout.agentCodePath, 'node_modules');
        for (const target of [layout.nodeModulesDir, path.join(layout.root, 'missing')]) {
            fs.rmSync(mountPoint, { force: true, recursive: true });
            fs.symlinkSync(target, mountPoint, 'dir');
            assert.throws(() => argsFor(layout), /node_modules cannot be mounted over it|is not a directory/);
            assert.equal(fs.lstatSync(mountPoint).isSymbolicLink(), true);
            assert.equal(fs.readlinkSync(mountPoint), target);
        }
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('a writable /code leaves the source tree alone because bwrap creates the mount point itself', () => {
    const layout = fixture('bwrap-code-writable-');
    try {
        const args = argsFor(layout, { codeReadOnly: false });
        assert.equal(fs.existsSync(path.join(layout.agentCodePath, 'node_modules')), false);
        const code = mounts(args).find(mount => mount.target === '/code');
        assert.equal(code.readOnly, false);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

for (const deps of [false, true]) {
    test(`real bwrap starts a ${deps ? 'dependency-store' : 'start-only'} layout with read-only /code and node_modules`, { skip: !hasUsableBwrap() }, () => {
        const layout = fixture('bwrap-code-live-', { deps });
        try {
            const skillsPath = path.join(layout.root, '.ploinky', 'repos', 'repo', 'agent', 'skills');
            fs.mkdirSync(skillsPath, { recursive: true });
            fs.writeFileSync(path.join(skillsPath, 'skill-sentinel'), 'skill');
            const args = argsFor(layout, { skillsPath });
            const probe = [
                'set -eu',
                'test "$(cat /code/server.js)" = "setInterval(() => {}, 1000);"',
                'test -d /code/node_modules',
                `test "$(cat /code/node_modules/dependency-sentinel)" = prepared`,
                'test "$(cat /code/skills/skill-sentinel)" = skill',
                'if touch /code/escaped 2>/dev/null; then exit 81; fi',
                'if touch /code/node_modules/escaped 2>/dev/null; then exit 82; fi',
                'if touch /code/skills/escaped 2>/dev/null; then exit 83; fi',
                'if mkdir /code/new-dir 2>/dev/null; then exit 84; fi',
                'if rm -rf /code/node_modules 2>/dev/null; then exit 85; fi',
                'test "$HOME" = /home/agent',
                'echo BWRAP_CODE_MOUNTS_OK',
            ].join('; ');
            const result = spawnSync('bwrap', [...args, '/bin/sh', '-c', probe], { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr || result.stdout);
            assert.match(result.stdout, /BWRAP_CODE_MOUNTS_OK/);
            for (const name of ['escaped', 'new-dir']) {
                assert.equal(fs.existsSync(path.join(layout.agentCodePath, name)), false);
            }
            assert.equal(fs.existsSync(path.join(layout.nodeModulesDir, 'escaped')), false);
            assert.equal(fs.existsSync(path.join(skillsPath, 'escaped')), false);
            assert.deepEqual(fs.readdirSync(path.join(layout.agentCodePath, 'node_modules')), []);
        } finally {
            fs.rmSync(layout.root, { recursive: true, force: true });
        }
    });
}
