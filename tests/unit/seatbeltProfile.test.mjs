import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    buildSeatbeltProfile,
    collectLiteralPathAccess
} from '../../cli/sandbox/seatbelt/seatbeltProfile.js';

test('buildSeatbeltProfile does not emit duplicate exec permissions', () => {
    const profile = buildSeatbeltProfile({
        agentCodePath: '/tmp/code',
        agentLibPath: '/tmp/Agent',
        nodeModulesDir: '/tmp/node_modules',
        sharedDir: '/tmp/shared',
        cwd: '/tmp/workspace',
        skillsPath: null,
        codeReadOnly: false,
        skillsReadOnly: true,
        volumes: {}
    });

    assert.match(profile, /\(allow process-fork process-exec\*\)/);
    assert.doesNotMatch(profile, /process-exec process-exec\*/);
});

test('buildSeatbeltProfile grants root and parent literals for scoped paths', () => {
    const profile = buildSeatbeltProfile({
        agentCodePath: '/Users/alice/workspace/repo/agent',
        agentLibPath: '/Users/alice/tools/ploinky/Agent',
        nodeModulesDir: '/Users/alice/workspace/.ploinky/deps/agent/node_modules',
        agentWorkDir: '/Users/alice/workspace/.data/demo',
        sharedDir: '/Users/alice/workspace/.ploinky/shared',
        cwd: '/Users/alice/workspace',
        skillsPath: null,
        codeReadOnly: false,
        skillsReadOnly: true,
        volumes: {
            '.ploinky/repos/webassist/data': '/data',
            'workspace-data/uploads': '/uploads',
        },
        workspaceRoot: '/Users/alice/workspace',
        extraReadPaths: ['/opt/homebrew'],
        extraWritePaths: ['/Users/alice/workspace/.ploinky/logs'],
    });

    assert.ok(profile.includes('(literal "/")'));
    assert.ok(profile.includes('(literal "/Users")'));
    assert.ok(profile.includes('(literal "/Users/alice")'));
    assert.ok(profile.includes('(literal "/Users/alice/workspace")'));
    assert.ok(profile.includes('(literal "/dev/null")'));
    assert.ok(profile.includes('(subpath "/opt/homebrew")'));
    assert.ok(profile.includes('(subpath "/Users/alice/workspace/.ploinky/logs")'));
    assert.ok(profile.includes('(allow file-write* (subpath "/Users/alice/workspace/.ploinky/logs"))'));
    assert.ok(profile.includes('(subpath "/Users/alice/workspace/.ploinky/repos/webassist/data")'));
    assert.ok(profile.includes('(subpath "/Users/alice/workspace/workspace-data/uploads")'));
    assert.ok(profile.includes('(allow file-write* (subpath "/Users/alice/workspace/workspace-data/uploads"))'));
});

test('buildSeatbeltProfile protects read-only paths even under writable workspace', () => {
    const profile = buildSeatbeltProfile({
        agentCodePath: '/Users/alice/workspace/.ploinky/repos/AchillesIDE/explorer',
        agentLibPath: '/Users/alice/workspace/.ploinky/seatbelt-runtime/explorer/Agent-123',
        nodeModulesDir: '/Users/alice/workspace/.ploinky/deps/agents/AchillesIDE/explorer/seatbelt-darwin-arm64-node25/node_modules',
        agentWorkDir: '/Users/alice/workspace/.data/explorer',
        sharedDir: '/Users/alice/workspace/.ploinky/shared',
        cwd: '/Users/alice/workspace',
        skillsPath: '/Users/alice/workspace/.ploinky/skills/explorer',
        codeReadOnly: true,
        skillsReadOnly: true,
        volumes: {},
        extraWritePaths: ['/Users/alice/workspace/.ploinky/logs'],
    });

    assert.match(profile, /\(allow file-write\* \(subpath "\/Users\/alice\/workspace"\)\)/);
    assert.match(profile, /\(deny file-write\*/);
    assert.match(profile, /\(subpath "\/Users\/alice\/workspace\/\.ploinky\/repos\/AchillesIDE\/explorer"\)/);
    assert.match(profile, /\(subpath "\/Users\/alice\/workspace\/\.ploinky\/deps\/agents\/AchillesIDE\/explorer\/seatbelt-darwin-arm64-node25"\)/);
    assert.match(profile, /\(subpath "\/Users\/alice\/workspace\/\.ploinky\/seatbelt-runtime\/explorer\/Agent-123"\)/);
    assert.match(profile, /\(literal ".*\/\.ploinky\/\.secrets"\)/);
});

test('collectLiteralPathAccess orders root before scoped parent paths', () => {
    assert.deepEqual(
        collectLiteralPathAccess(['/Users/alice/workspace/agent']),
        ['/', '/Users', '/Users/alice', '/Users/alice/workspace', '/Users/alice/workspace/agent'],
    );
});

test('generated profile can launch a basic macOS command', { skip: process.platform !== 'darwin' }, () => {
    const sandboxProbe = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', '/bin/echo', 'ok'], {
        encoding: 'utf8',
    });
    if (sandboxProbe.status !== 0) {
        assert.fail(`sandbox-exec is unavailable: ${sandboxProbe.stderr || sandboxProbe.stdout}`);
    }

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-profile-'));
    const profile = buildSeatbeltProfile({
        agentCodePath: workspace,
        agentLibPath: workspace,
        nodeModulesDir: workspace,
        agentWorkDir: workspace,
        sharedDir: workspace,
        cwd: workspace,
        skillsPath: null,
        codeReadOnly: false,
        skillsReadOnly: true,
        volumes: {},
        extraReadPaths: ['/opt/homebrew'],
    });
    const profilePath = path.join(workspace, 'profile.sb');
    fs.writeFileSync(profilePath, profile, 'utf8');

    const result = spawnSync('sandbox-exec', ['-f', profilePath, '/bin/echo', 'ok'], {
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), 'ok');

    const devNullResult = spawnSync('sandbox-exec', ['-f', profilePath, '/bin/sh', '-lc', 'echo ok >/dev/null && echo ok'], {
        encoding: 'utf8',
    });
    assert.equal(devNullResult.status, 0, devNullResult.stderr || devNullResult.stdout);
    assert.equal(devNullResult.stdout.trim(), 'ok');
});

test('generated profile denies writes to read-only code, cache, and staged lib', { skip: process.platform !== 'darwin' }, () => {
    const sandboxProbe = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', '/bin/echo', 'ok'], {
        encoding: 'utf8',
    });
    if (sandboxProbe.status !== 0) {
        assert.fail(`sandbox-exec is unavailable: ${sandboxProbe.stderr || sandboxProbe.stdout}`);
    }

    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-profile-deny-')));
    const codeDir = path.join(workspace, '.ploinky', 'repos', 'repo', 'agent');
    const cacheDir = path.join(workspace, '.ploinky', 'deps', 'agents', 'repo', 'agent', 'seatbelt-darwin-arm64-node25');
    const nodeModulesDir = path.join(cacheDir, 'node_modules');
    const libDir = path.join(workspace, '.ploinky', 'seatbelt-runtime', 'agent', 'Agent-123');
    const agentWorkDir = path.join(workspace, '.ploinky', 'agents', 'agent');
    const sharedDir = path.join(workspace, '.ploinky', 'shared');
    const logsDir = path.join(workspace, '.ploinky', 'logs');
    try {
        for (const dir of [codeDir, nodeModulesDir, libDir, agentWorkDir, sharedDir, logsDir]) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(path.join(codeDir, 'README'), 'CODE');
        fs.writeFileSync(path.join(nodeModulesDir, 'MARKER'), 'CACHE');
        fs.writeFileSync(path.join(libDir, 'README'), 'LIB');

        const profile = buildSeatbeltProfile({
            agentCodePath: codeDir,
            agentLibPath: libDir,
            nodeModulesDir,
            agentWorkDir,
            sharedDir,
            cwd: workspace,
            skillsPath: null,
            codeReadOnly: true,
            skillsReadOnly: true,
            volumes: {},
            extraWritePaths: [logsDir],
        });
        const profilePath = path.join(workspace, 'profile.sb');
        fs.writeFileSync(profilePath, profile, 'utf8');

        const workspaceWrite = spawnSync('sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', `echo ok > ${path.join(workspace, 'user-file')}`], {
            cwd: workspace,
            encoding: 'utf8',
        });
        assert.equal(workspaceWrite.status, 0, workspaceWrite.stderr || workspaceWrite.stdout);
        assert.equal(fs.readFileSync(path.join(workspace, 'user-file'), 'utf8').trim(), 'ok');

        for (const target of [
            path.join(codeDir, 'README'),
            path.join(nodeModulesDir, 'MARKER'),
            path.join(libDir, 'README'),
        ]) {
            const result = spawnSync('sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', `echo TAMPERED > ${target}`], {
                cwd: workspace,
                encoding: 'utf8',
            });
            assert.notEqual(result.status, 0, `unexpected write success for ${target}`);
        }

        assert.equal(fs.readFileSync(path.join(codeDir, 'README'), 'utf8'), 'CODE');
        assert.equal(fs.readFileSync(path.join(nodeModulesDir, 'MARKER'), 'utf8'), 'CACHE');
        assert.equal(fs.readFileSync(path.join(libDir, 'README'), 'utf8'), 'LIB');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
