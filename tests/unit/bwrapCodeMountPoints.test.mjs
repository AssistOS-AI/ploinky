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

// A manifest volume whose container target is below /code, as webAssist
// declares for its debuglogs directory, needs the same mount point.
test('a webAssist-like /code volume gets a mount point in a read-only /code', () => {
    const layout = fixture('bwrap-code-volume-', { deps: false });
    try {
        const moduleUrl = new URL('../../cli/sandbox/bwrap/bwrapServiceManager.js', import.meta.url).href;
        const script = `
            const { buildBwrapArgs } = await import(${JSON.stringify(moduleUrl)});
            process.stdout.write(JSON.stringify(buildBwrapArgs(JSON.parse(process.env.BWRAP_TEST_OPTIONS))));
        `;
        const options = {
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
            // Relative to the workspace root, exactly as the manifest writes it.
            volumes: { '.data/webAssist/debuglogs': '/code/debuglogs', '.data/webAssist/nested': '/code/a/b/c/' },
        };
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: layout.root,
            env: { ...process.env, PLOINKY_WORKSPACE_ROOT: layout.root, BWRAP_TEST_OPTIONS: JSON.stringify(options) },
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        const all = mounts(JSON.parse(result.stdout));
        const code = all.find(mount => mount.target === '/code');
        for (const [rel, host] of [['debuglogs', 'debuglogs'], ['a/b/c', 'nested']]) {
            const mountPoint = path.join(layout.agentCodePath, rel);
            assert.deepEqual([fs.lstatSync(mountPoint).isDirectory(), fs.readdirSync(mountPoint)], [true, []], rel);
            const volume = all.find(mount => mount.target === `/code/${rel}`);
            assert.deepEqual([volume.readOnly, volume.source], [false, path.join(layout.root, '.data', 'webAssist', host)]);
            assert.ok(volume.index > code.index, 'the volume bind follows the read-only /code bind');
        }
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('a /code volume refuses a symlink or file at any component and leaves it in place', () => {
    const layout = fixture('bwrap-code-volume-refuse-');
    try {
        const outside = path.join(layout.root, 'outside');
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(layout.agentCodePath, 'linked'), 'dir');
        fs.writeFileSync(path.join(layout.agentCodePath, 'plain-file'), 'file');
        const volume = path.join(layout.root, 'volume-data');
        fs.mkdirSync(volume);
        for (const target of ['/code/linked/inside', '/code/linked', '/code/plain-file', '/code/plain-file/inside']) {
            assert.throws(() => argsFor(layout, { volumes: { [volume]: target } }), /is not a directory/, target);
        }
        assert.equal(fs.lstatSync(path.join(layout.agentCodePath, 'linked')).isSymbolicLink(), true);
        assert.deepEqual(fs.readdirSync(outside), [], 'nothing is created through the symlink');
        assert.equal(fs.readFileSync(path.join(layout.agentCodePath, 'plain-file'), 'utf8'), 'file');
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('a /code volume may not target the reserved dependency mount, even through normalization', () => {
    const layout = fixture('bwrap-code-volume-reserved-');
    try {
        const volume = path.join(layout.root, 'volume-data');
        fs.mkdirSync(volume);
        for (const target of ['/code/node_modules', '/code/node_modules/', '/code/node_modules/pkg', '/code/a/../node_modules/x']) {
            for (const codeReadOnly of [true, false]) {
                assert.throws(() => argsFor(layout, { codeReadOnly, volumes: { [volume]: target } }),
                    /reserved \/code\/node_modules/, `${target} codeReadOnly=${codeReadOnly}`);
            }
        }
        // Names that merely start with the same letters are ordinary targets.
        argsFor(layout, { volumes: { [volume]: '/code/node_modules_cache' } });
        assert.equal(fs.lstatSync(path.join(layout.agentCodePath, 'node_modules_cache')).isDirectory(), true);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('a writable /code leaves the tree alone for /code volumes too', () => {
    const layout = fixture('bwrap-code-volume-rw-');
    try {
        const volume = path.join(layout.root, 'volume-data');
        fs.mkdirSync(volume);
        argsFor(layout, { codeReadOnly: false, volumes: { [volume]: '/code/debuglogs' } });
        assert.equal(fs.existsSync(path.join(layout.agentCodePath, 'debuglogs')), false);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('real bwrap starts with a /code volume whose mount point was absent', { skip: !hasUsableBwrap() }, () => {
    const layout = fixture('bwrap-code-volume-live-');
    try {
        const volume = path.join(layout.root, 'workspace-data', 'debuglogs');
        fs.mkdirSync(volume, { recursive: true });
        fs.writeFileSync(path.join(volume, 'volume-sentinel'), 'volume');
        const args = argsFor(layout, { volumes: { [volume]: '/code/debuglogs' } });
        const probe = [
            'set -eu',
            'test "$(cat /code/debuglogs/volume-sentinel)" = volume',
            'touch /code/debuglogs/written',
            'if touch /code/escaped 2>/dev/null; then exit 81; fi',
            'if touch /code/other-dir 2>/dev/null; then exit 82; fi',
            'echo BWRAP_CODE_VOLUME_OK',
        ].join('; ');
        const result = spawnSync('bwrap', [...args, '/bin/sh', '-c', probe], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /BWRAP_CODE_VOLUME_OK/);
        assert.equal(fs.existsSync(path.join(volume, 'written')), true);
        assert.equal(fs.existsSync(path.join(layout.agentCodePath, 'escaped')), false);
        assert.deepEqual(fs.readdirSync(path.join(layout.agentCodePath, 'debuglogs')), []);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

// The volume policy supports file volumes; the mount point has to be a file.
function fileVolume(layout, name = 'config.json', content = 'volume') {
    const dir = path.join(layout.root, 'workspace-data');
    fs.mkdirSync(dir, { recursive: true });
    const host = path.join(dir, name);
    fs.writeFileSync(host, content);
    return host;
}

test('a file volume onto a file the agent ships builds args and leaves that file untouched', () => {
    const layout = fixture('bwrap-code-filevol-shipped-');
    try {
        const shipped = path.join(layout.agentCodePath, 'config.json');
        fs.writeFileSync(shipped, 'shipped');
        const host = fileVolume(layout);
        const args = argsFor(layout, { volumes: { [host]: '/code/config.json' } });
        assert.equal(fs.readFileSync(shipped, 'utf8'), 'shipped');
        assert.equal(fs.lstatSync(shipped).isFile(), true);
        const volume = mounts(args).find(mount => mount.target === '/code/config.json');
        assert.deepEqual([volume.readOnly, volume.source], [false, host]);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('a file volume onto an absent target gets an empty regular file below real directories', () => {
    const layout = fixture('bwrap-code-filevol-absent-');
    try {
        const host = fileVolume(layout);
        const args = argsFor(layout, { volumes: { [host]: '/code/conf/app/config.json' } });
        const mountPoint = path.join(layout.agentCodePath, 'conf', 'app', 'config.json');
        const stat = fs.lstatSync(mountPoint);
        assert.deepEqual([stat.isFile(), stat.isSymbolicLink(), stat.size], [true, false, 0]);
        for (const directory of ['conf', 'conf/app']) {
            assert.equal(fs.lstatSync(path.join(layout.agentCodePath, directory)).isDirectory(), true, directory);
        }
        assert.ok(mounts(args).some(mount => mount.target === '/code/conf/app/config.json' && mount.source === host));
        // A second launch finds the mount point and changes nothing.
        argsFor(layout, { volumes: { [host]: '/code/conf/app/config.json' } });
        assert.equal(fs.statSync(mountPoint).size, 0);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('a file volume refuses a directory or symlink at its target, and a directory volume refuses a file', () => {
    const layout = fixture('bwrap-code-filevol-mismatch-');
    try {
        const host = fileVolume(layout);
        const outside = path.join(layout.root, 'outside.json');
        fs.writeFileSync(outside, 'outside');
        fs.mkdirSync(path.join(layout.agentCodePath, 'dir-target'));
        fs.symlinkSync(outside, path.join(layout.agentCodePath, 'link-target'));
        assert.throws(() => argsFor(layout, { volumes: { [host]: '/code/dir-target' } }), /is not a regular file/);
        assert.throws(() => argsFor(layout, { volumes: { [host]: '/code/link-target' } }), /is not a regular file/);
        assert.equal(fs.lstatSync(path.join(layout.agentCodePath, 'link-target')).isSymbolicLink(), true);
        assert.equal(fs.readFileSync(outside, 'utf8'), 'outside', 'nothing is written through the symlink');
        fs.writeFileSync(path.join(layout.agentCodePath, 'file-target'), 'file');
        const dirVolume = path.join(layout.root, 'workspace-data', 'a-directory');
        fs.mkdirSync(dirVolume, { recursive: true });
        assert.throws(() => argsFor(layout, { volumes: { [dirVolume]: '/code/file-target' } }), /is not a directory/);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});

test('real bwrap starts with file volumes over a shipped file and over an absent target', { skip: !hasUsableBwrap() }, () => {
    const layout = fixture('bwrap-code-filevol-live-');
    try {
        fs.writeFileSync(path.join(layout.agentCodePath, 'shipped.json'), 'shipped');
        const shippedVolume = fileVolume(layout, 'shipped.json', 'volume-shipped');
        const absentVolume = fileVolume(layout, 'absent.json', 'volume-absent');
        const args = argsFor(layout, {
            volumes: { [shippedVolume]: '/code/shipped.json', [absentVolume]: '/code/conf/absent.json' },
        });
        const probe = [
            'set -eu',
            'test "$(cat /code/shipped.json)" = volume-shipped',
            'test "$(cat /code/conf/absent.json)" = volume-absent',
            'echo written > /code/conf/absent.json',
            'if touch /code/escaped 2>/dev/null; then exit 81; fi',
            'echo BWRAP_FILE_VOLUMES_OK',
        ].join('; ');
        const result = spawnSync('bwrap', [...args, '/bin/sh', '-c', probe], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /BWRAP_FILE_VOLUMES_OK/);
        assert.equal(fs.readFileSync(absentVolume, 'utf8').trim(), 'written');
        assert.equal(fs.readFileSync(path.join(layout.agentCodePath, 'shipped.json'), 'utf8'), 'shipped');
        assert.equal(fs.statSync(path.join(layout.agentCodePath, 'conf', 'absent.json')).size, 0);
    } finally {
        fs.rmSync(layout.root, { recursive: true, force: true });
    }
});
