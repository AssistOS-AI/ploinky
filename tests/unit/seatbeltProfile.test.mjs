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
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';

// Every seatbelt profile is generated for one selected achillesAgentLib source:
// with no mount namespace, the read grant and the overriding write denial are
// what confine it.
function seatbeltGrantFor(workspaceRoot, { create = false } = {}) {
    const contract = create
        ? agentLibFixture(workspaceRoot)
        : {
            sourceDir: `${workspaceRoot}/achillesAgentLib`,
            mode: 'local',
            fingerprint: 'a1'.repeat(32),
            sourceIdHash: 'b2'.repeat(32),
        };
    return {
        sourceDir: contract.sourceDir,
        runtimePath: contract.sourceDir,
        mode: contract.mode,
        fingerprint: contract.fingerprint,
        commit: '',
        sourceIdHash: contract.sourceIdHash,
        namespaced: false,
    };
}

test('buildSeatbeltProfile does not emit duplicate exec permissions', () => {
    const profile = buildSeatbeltProfile({
        agentLibGrant: seatbeltGrantFor('/tmp'),
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
        agentLibGrant: seatbeltGrantFor('/Users/alice/workspace'),
        agentCodePath: '/Users/alice/workspace/repo/agent',
        agentLibPath: '/Users/alice/tools/ploinky/Agent',
        nodeModulesDir: '/Users/alice/workspace/.ploinky/deps/agent/node_modules',
        agentWorkDir: '/Users/alice/workspace/.data/demo',
        sharedDir: '/Users/alice/workspace/.data/shared',
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

test('buildSeatbeltProfile does not grant writes to read-only manifest volumes', () => {
    const profile = buildSeatbeltProfile({
        agentLibGrant: seatbeltGrantFor('/Users/alice/workspace'),
        agentCodePath: '/Users/alice/workspace/.ploinky/repos/repo/agent',
        agentLibPath: '/Users/alice/workspace/Agent',
        nodeModulesDir: '/Users/alice/workspace/.ploinky/deps/node_modules',
        agentWorkDir: '/Users/alice/workspace/.data/agent',
        sharedDir: '/Users/alice/workspace/.data/shared',
        cwd: '/Users/alice/workspace',
        skillsPath: null,
        codeReadOnly: true,
        skillsReadOnly: true,
        volumes: {
            '.data/secret': '/run/secret',
        },
        volumeOptions: {
            '/run/secret': { readOnly: true },
        },
        workspaceRoot: '/Users/alice/workspace',
    });

    assert.match(profile, /\(subpath "\/Users\/alice\/workspace\/\.data\/secret"\)/);
    assert.doesNotMatch(profile, /\(allow file-write\* \(subpath "\/Users\/alice\/workspace\/\.data\/secret"\)\)/);
    assert.match(profile, /\(deny file-write\*[\s\S]*\(subpath "\/Users\/alice\/workspace\/\.data\/secret"\)/);
    assert.match(profile, /\(deny file-write\*[\s\S]*\(subpath "\/Users\/alice\/workspace\/\.ploinky\/data"\)/);
    assert.match(profile, /\(deny file-read\*[\s\S]*\(subpath "\/Users\/alice\/workspace\/\.ploinky\/shared"\)/);
});

test('buildSeatbeltProfile protects read-only paths even under writable workspace', () => {
    const profile = buildSeatbeltProfile({
        agentLibGrant: seatbeltGrantFor('/Users/alice/workspace'),
        agentCodePath: '/Users/alice/workspace/.ploinky/repos/AchillesIDE/explorer',
        agentLibPath: '/Users/alice/workspace/.ploinky/seatbelt-runtime/explorer/Agent-123',
        nodeModulesDir: '/Users/alice/workspace/.ploinky/deps/agents/AchillesIDE/explorer/seatbelt-darwin-arm64-node25/node_modules',
        agentWorkDir: '/Users/alice/workspace/.data/explorer',
        sharedDir: '/Users/alice/workspace/.data/shared',
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
        agentLibGrant: seatbeltGrantFor(workspace),
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
    const agentWorkDir = path.join(workspace, '.data', 'agent');
    const sharedDir = path.join(workspace, '.data', 'shared');
    const logsDir = path.join(workspace, '.ploinky', 'logs');
    try {
        for (const dir of [codeDir, nodeModulesDir, libDir, agentWorkDir, sharedDir, logsDir]) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(path.join(codeDir, 'README'), 'CODE');
        fs.writeFileSync(path.join(nodeModulesDir, 'MARKER'), 'CACHE');
        fs.writeFileSync(path.join(libDir, 'README'), 'LIB');
        // A real selected source inside the workspace: the workspace itself is
        // writable, so only the path-based denial keeps it read-only.
        const agentLibSourceGrant = seatbeltGrantFor(workspace, { create: true });
        fs.writeFileSync(path.join(agentLibSourceGrant.sourceDir, 'MARKER'), 'AGENTLIB');

        const profile = buildSeatbeltProfile({
            agentLibGrant: agentLibSourceGrant,
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
            path.join(agentLibSourceGrant.sourceDir, 'MARKER'),
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
        assert.equal(
            fs.readFileSync(path.join(agentLibSourceGrant.sourceDir, 'MARKER'), 'utf8'),
            'AGENTLIB',
            'the selected achillesAgentLib source must survive a write attempt through the writable workspace',
        );
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('generated profile makes both canonical aliases of legacy data roots opaque to every operation', { skip: process.platform !== 'darwin' }, () => {
    const sandboxProbe = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', '/bin/echo', 'ok'], {
        encoding: 'utf8',
    });
    if (sandboxProbe.status !== 0) {
        assert.fail(`sandbox-exec is unavailable: ${sandboxProbe.stderr || sandboxProbe.stdout}`);
    }

    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-legacy-alias-')));
    const canonicalLegacyData = path.join(workspace, 'legacy-data-target');
    const canonicalLegacyShared = path.join(workspace, 'legacy-shared-target');
    const oldDataRoot = path.join(workspace, '.ploinky', 'data');
    const oldSharedRoot = path.join(workspace, '.ploinky', 'shared');
    const agentWorkDir = path.join(workspace, '.data', 'agent');
    const sharedDir = path.join(workspace, '.data', 'shared');
    try {
        fs.mkdirSync(path.dirname(oldDataRoot), { recursive: true });
        fs.mkdirSync(canonicalLegacyData, { recursive: true });
        fs.mkdirSync(canonicalLegacyShared, { recursive: true });
        fs.mkdirSync(agentWorkDir, { recursive: true });
        fs.mkdirSync(sharedDir, { recursive: true });
        fs.writeFileSync(path.join(canonicalLegacyData, 'sentinel'), 'SECRET');
        fs.writeFileSync(path.join(canonicalLegacyShared, 'sentinel'), 'SECRET');
        fs.symlinkSync(canonicalLegacyData, oldDataRoot, 'dir');
        fs.symlinkSync(canonicalLegacyShared, oldSharedRoot, 'dir');
        const agentLibSourceGrant = seatbeltGrantFor(workspace, { create: true });
        const profile = buildSeatbeltProfile({
            agentLibGrant: agentLibSourceGrant,
            agentCodePath: workspace,
            agentLibPath: agentLibSourceGrant.sourceDir,
            nodeModulesDir: path.join(workspace, 'node_modules'),
            agentWorkDir,
            sharedDir,
            cwd: workspace,
            skillsPath: null,
            codeReadOnly: false,
            skillsReadOnly: true,
            volumes: {},
            workspaceRoot: workspace,
        });
        assert.match(profile, new RegExp(`\\(subpath ${JSON.stringify(canonicalLegacyData).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\)`));
        assert.match(profile, new RegExp(`\\(subpath ${JSON.stringify(canonicalLegacyShared).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\)`));
        const profilePath = path.join(workspace, 'profile.sb');
        fs.writeFileSync(profilePath, profile, 'utf8');

        for (const target of [oldDataRoot, canonicalLegacyData, oldSharedRoot, canonicalLegacyShared]) {
            const list = spawnSync('sandbox-exec', ['-f', profilePath, '/bin/ls', '-A', target], {
                cwd: workspace,
                encoding: 'utf8',
            });
            assert.notEqual(list.status, 0, `unexpected legacy-root list success through ${target}`);
            const read = spawnSync('sandbox-exec', ['-f', profilePath, '/bin/cat', path.join(target, 'sentinel')], {
                cwd: workspace,
                encoding: 'utf8',
            });
            assert.notEqual(read.status, 0, `unexpected legacy-root read success through ${target}`);
            const write = spawnSync('sandbox-exec', [
                '-f', profilePath, '/bin/sh', '-c', 'echo exposed > "$1"', 'probe', path.join(target, 'created'),
            ], {
                cwd: workspace,
                encoding: 'utf8',
            });
            assert.notEqual(write.status, 0, `unexpected legacy-root write success through ${target}`);
            const mkdir = spawnSync('sandbox-exec', [
                '-f', profilePath, '/bin/mkdir', path.join(target, 'created-dir'),
            ], {
                cwd: workspace,
                encoding: 'utf8',
            });
            assert.notEqual(mkdir.status, 0, `unexpected legacy-root mkdir success through ${target}`);
        }
        assert.equal(fs.existsSync(path.join(canonicalLegacyData, 'created')), false);
        assert.equal(fs.existsSync(path.join(canonicalLegacyData, 'created-dir')), false);
        assert.equal(fs.existsSync(path.join(canonicalLegacyShared, 'created')), false);
        assert.equal(fs.existsSync(path.join(canonicalLegacyShared, 'created-dir')), false);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
