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
import { initializeWorkspaceMasterKey } from '../../ploinky-box/entrypoint/initialize-workspace.mjs';
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
            '.data/webassist/data': '/data',
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
    assert.ok(profile.includes('(subpath "/Users/alice/workspace/.data/webassist/data")'));
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
    assert.match(profile, /\(deny file-read\*[\s\S]*\(subpath "\/Users\/alice\/workspace\/\.ploinky\/data"\)/);
    assert.doesNotMatch(profile, /\.ploinky\/shared/);
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
    // Controller secrets live in the controller-state root, which is neither
    // readable nor writable; no separate per-file literal is needed.
    assert.match(profile, /\(deny file-write\*[\s\S]*\(subpath ".*\/\.ploinky\/data"\)/);
    assert.match(profile, /\(deny file-read\*[\s\S]*\(subpath ".*\/\.ploinky\/data"\)/);
    assert.doesNotMatch(profile, /\.secrets/);
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
    try {
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
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
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

test('generated profile makes both canonical aliases of the controller state root opaque to every operation', { skip: process.platform !== 'darwin' }, () => {
    const sandboxProbe = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', '/bin/echo', 'ok'], {
        encoding: 'utf8',
    });
    if (sandboxProbe.status !== 0) {
        assert.fail(`sandbox-exec is unavailable: ${sandboxProbe.stderr || sandboxProbe.stdout}`);
    }

    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-state-alias-')));
    const canonicalStateData = path.join(workspace, 'state-data-target');
    const stateRoot = path.join(workspace, '.ploinky', 'data');
    const agentWorkDir = path.join(workspace, '.data', 'agent');
    const sharedDir = path.join(workspace, '.data', 'shared');
    try {
        fs.mkdirSync(path.dirname(stateRoot), { recursive: true });
        fs.mkdirSync(canonicalStateData, { recursive: true });
        fs.mkdirSync(agentWorkDir, { recursive: true });
        fs.mkdirSync(sharedDir, { recursive: true });
        fs.writeFileSync(path.join(canonicalStateData, 'sentinel'), 'SECRET');
        fs.symlinkSync(canonicalStateData, stateRoot, 'dir');
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
        assert.match(profile, new RegExp(`\\(subpath ${JSON.stringify(canonicalStateData).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\)`));
        const profilePath = path.join(workspace, 'profile.sb');
        fs.writeFileSync(profilePath, profile, 'utf8');

        for (const target of [stateRoot, canonicalStateData]) {
            const list = spawnSync('sandbox-exec', ['-f', profilePath, '/bin/ls', '-A', target], {
                cwd: workspace,
                encoding: 'utf8',
            });
            assert.notEqual(list.status, 0, `unexpected controller-state list success through ${target}`);
            const read = spawnSync('sandbox-exec', ['-f', profilePath, '/bin/cat', path.join(target, 'sentinel')], {
                cwd: workspace,
                encoding: 'utf8',
            });
            assert.notEqual(read.status, 0, `unexpected controller-state read success through ${target}`);
            const write = spawnSync('sandbox-exec', [
                '-f', profilePath, '/bin/sh', '-c', 'echo exposed > "$1"', 'probe', path.join(target, 'created'),
            ], {
                cwd: workspace,
                encoding: 'utf8',
            });
            assert.notEqual(write.status, 0, `unexpected controller-state write success through ${target}`);
            const mkdir = spawnSync('sandbox-exec', [
                '-f', profilePath, '/bin/mkdir', path.join(target, 'created-dir'),
            ], {
                cwd: workspace,
                encoding: 'utf8',
            });
            assert.notEqual(mkdir.status, 0, `unexpected controller-state mkdir success through ${target}`);
        }
        assert.equal(fs.existsSync(path.join(canonicalStateData, 'created')), false);
        assert.equal(fs.existsSync(path.join(canonicalStateData, 'created-dir')), false);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('buildSeatbeltProfile pins the controller root and its ancestors read-only and keeps controller state opaque', () => {
    const profile = buildSeatbeltProfile({
        agentLibGrant: seatbeltGrantFor('/Users/alice/workspace'),
        agentCodePath: '/Users/alice/workspace/.ploinky/repos/repo/agent',
        agentLibPath: '/Users/alice/workspace/.ploinky/seatbelt-runtime/agent/Agent-1',
        nodeModulesDir: '/Users/alice/workspace/.ploinky/deps/store/node_modules',
        agentWorkDir: '/Users/alice/workspace/.data/agent',
        sharedDir: '/Users/alice/workspace/.data/shared',
        cwd: '/Users/alice/workspace',
        skillsPath: null,
        codeReadOnly: false,
        skillsReadOnly: true,
        volumes: { '.': '/workspace' },
        workspaceRoot: '/Users/alice/workspace',
    });
    const controllerDeny = profile.slice(profile.indexOf('; Controller root is read-only'));
    assert.match(controllerDeny, /\(deny file-write\*\n    \(subpath "\/Users\/alice\/workspace\/\.ploinky"\)/);
    for (const ancestor of ['/Users/alice/workspace', '/Users/alice', '/Users']) {
        assert.ok(controllerDeny.includes(`    (literal "${ancestor}")`), ancestor);
    }
    // Writable code inside the controller root is re-granted after the root
    // denial, but its own root entry stays pinned.
    assert.ok(profile.lastIndexOf('(allow file-write* (subpath "/Users/alice/workspace/.ploinky/repos/repo/agent"))')
        > profile.indexOf('; Controller root is read-only'));
    assert.match(profile, /\(deny file-write\*\n    \(literal "\/Users\/alice\/workspace\/\.ploinky\/repos\/repo\/agent"\)\n\)/);
    const readDeny = profile.slice(profile.indexOf('(deny file-read*'));
    assert.ok(readDeny.includes('(subpath "/Users/alice/workspace/.ploinky/data")'));
    assert.doesNotMatch(readDeny, /\(subpath "\/Users\/alice\/workspace\/\.ploinky"\)/,
        'the rest of the controller root stays readable, as it is in containers');
});

function seatbeltControllerFixture({ codeWritable = false, symlinkedControllerRoot = false } = {}) {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-controller-')));
    const at = (...segments) => path.join(workspace, ...segments);
    const seed = {
        '.ploinky/agents.json': '{"synthetic":true}',
        '.ploinky/data/master-key': 'SYNTHETIC-MASTER-KEY\n',
        '.ploinky/data/.secrets': 'SYNTHETIC_SECRET=1\n',
        '.ploinky/running/router.pid': '1',
        '.ploinky/run/lease': 'L',
        '.ploinky/repos/repo/agent/README': 'CODE',
        '.ploinky/repos/repo/agent/node_modules/marker': 'NM',
        '.ploinky/repos/other/agent/README': 'OTHER',
        '.data/agent/.keep': '',
        '.data/shared/.keep': '',
        'project-file': 'PROJECT',
    };
    for (const [relative, content] of Object.entries(seed)) {
        fs.mkdirSync(path.dirname(at(relative)), { recursive: true });
        fs.writeFileSync(at(relative), content);
    }
    if (symlinkedControllerRoot) {
        // `.ploinky` resolves into the writable workspace, so only rules on the
        // canonical spelling protect it.
        fs.renameSync(at('.ploinky'), at('controller-real'));
        fs.symlinkSync(at('controller-real'), at('.ploinky'), 'dir');
    }
    const grant = seatbeltGrantFor(workspace, { create: true });
    const profile = buildSeatbeltProfile({
        agentLibGrant: grant,
        agentCodePath: at('.ploinky', 'repos', 'repo', 'agent'),
        agentLibPath: grant.sourceDir,
        nodeModulesDir: at('.ploinky', 'deps', 'store', 'node_modules'),
        agentWorkDir: at('.data', 'agent'),
        sharedDir: at('.data', 'shared'),
        cwd: workspace,
        skillsPath: null,
        codeReadOnly: !codeWritable,
        skillsReadOnly: true,
        volumes: { '.': '/workspace' },
        workspaceRoot: workspace,
    });
    const profilePath = path.join(workspace, 'profile.sb');
    fs.writeFileSync(profilePath, profile, 'utf8');
    const run = (script, ...args) => spawnSync('sandbox-exec', [
        '-f', profilePath, '/bin/sh', '-c', script, 'probe', ...args,
    ], { cwd: workspace, encoding: 'utf8', timeout: 10_000 });
    return { workspace, at, run };
}

const RENAME_SCRIPT = 'exec /usr/bin/perl -e \'rename($ARGV[0], $ARGV[1]) or die "$!\\n"\' "$1" "$2"';

function assertSandboxDenied(result, label) {
    assert.notEqual(result.status, 0, `unexpected success: ${label}`);
    assert.match(`${result.stderr}${result.stdout}`, /Operation not permitted/, label);
}

function requireSandboxExec() {
    const probe = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', '/bin/echo', 'ok'], { encoding: 'utf8' });
    if (probe.status !== 0) assert.fail(`sandbox-exec is unavailable: ${probe.stderr || probe.stdout}`);
}

for (const symlinkedControllerRoot of [false, true]) {
    const variant = symlinkedControllerRoot ? ' through a symlinked controller root' : '';
    test(`generated profile with a broad workspace volume keeps controller state immutable${variant}`, { skip: process.platform !== 'darwin' }, () => {
        requireSandboxExec();
        const fixture = seatbeltControllerFixture({ symlinkedControllerRoot });
        const { workspace, at, run } = fixture;
        const renameTarget = path.join('/tmp', `seatbelt-controller-rename-${process.pid}-${Date.now()}`);
        try {
            const projectWrite = run('printf more >> "$1" && mkdir "$2" && printf new > "$3"',
                at('project-file'), at('new-dir'), at('.data', 'agent', 'state'));
            assert.equal(projectWrite.status, 0, projectWrite.stderr);
            assert.equal(fs.readFileSync(at('project-file'), 'utf8'), 'PROJECTmore');
            const registryRead = run('cat "$1"', at('.ploinky', 'agents.json'));
            assert.equal(registryRead.status, 0, registryRead.stderr);

            const controllerPaths = ['agents.json', 'data/master-key', 'data/.secrets', 'running/router.pid', 'run/lease', 'repos/repo/agent/README']
                .map(relative => at('.ploinky', relative));
            if (symlinkedControllerRoot) controllerPaths.push(at('controller-real', 'agents.json'));
            const before = new Map(controllerPaths.map(target => [target, fs.readFileSync(target, 'utf8')]));
            for (const target of controllerPaths) {
                assertSandboxDenied(run('printf TAMPER >> "$1"', target), `write ${target}`);
            }
            for (const target of [at('.ploinky', 'data', 'master-key'), at('.ploinky', 'data', '.secrets')]) {
                assertSandboxDenied(run('cat "$1"', target), `read ${target}`);
            }
            assertSandboxDenied(run('printf X > "$1"', at('.ploinky', 'forged')), 'create a controller entry');
            assertSandboxDenied(run('mkdir "$1"', at('.ploinky', 'running', 'forged')), 'create a running entry');
            assertSandboxDenied(run('rm "$1"', at('.ploinky', 'data', 'master-key')), 'unlink master-key');
            assertSandboxDenied(run('ln "$1" "$2"', at('.ploinky', 'agents.json'), at('registry-link')), 'hard-link the registry');
            assertSandboxDenied(run(RENAME_SCRIPT, at('.ploinky'), at('moved')), 'rename the controller root');
            assertSandboxDenied(run(RENAME_SCRIPT, at('.ploinky', 'running'), at('moved')), 'rename running state');
            assertSandboxDenied(run(RENAME_SCRIPT, at('.ploinky', 'data'), at('moved')), 'rename controller-state root');
            assertSandboxDenied(run(RENAME_SCRIPT, workspace, renameTarget), 'rename the workspace root');
            if (symlinkedControllerRoot) {
                assertSandboxDenied(run(RENAME_SCRIPT, at('controller-real'), at('moved')), 'rename the canonical controller root');
            }

            for (const [target, content] of before) assert.equal(fs.readFileSync(target, 'utf8'), content, target);
            assert.equal(fs.existsSync(at('.ploinky', 'forged')), false);
            assert.equal(fs.existsSync(at('registry-link')), false);
            assert.equal(fs.existsSync(renameTarget), false);
        } finally {
            fs.rmSync(renameTarget, { recursive: true, force: true });
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });
}

test('generated profile keeps writable agent code writable without reopening the controller root', { skip: process.platform !== 'darwin' }, () => {
    requireSandboxExec();
    for (const symlinkedControllerRoot of [false, true]) {
        const { workspace, at, run } = seatbeltControllerFixture({ codeWritable: true, symlinkedControllerRoot });
        const canonicalCode = symlinkedControllerRoot ? at('controller-real', 'repos', 'repo', 'agent') : at('.ploinky', 'repos', 'repo', 'agent');
        try {
            const codeWrite = run('printf %s -edited >> "$1" && printf new > "$2"', path.join(canonicalCode, 'README'), path.join(canonicalCode, 'added'));
            assert.equal(codeWrite.status, 0, codeWrite.stderr);
            assert.equal(fs.readFileSync(path.join(canonicalCode, 'README'), 'utf8'), 'CODE-edited');
            for (const target of [
                path.join(canonicalCode, 'node_modules', 'marker'),
                at('.ploinky', 'repos', 'other', 'agent', 'README'),
                at('.ploinky', 'agents.json'),
            ]) {
                assertSandboxDenied(run('printf TAMPER >> "$1"', target), `write ${target}`);
            }
            assertSandboxDenied(run(RENAME_SCRIPT, canonicalCode, at('moved-code')), 'rename the writable code root');
            assert.equal(fs.readFileSync(path.join(canonicalCode, 'node_modules', 'marker'), 'utf8'), 'NM');
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    }
});

test('buildSeatbeltProfile keeps a dangling protected link lexical and overrides write grants inside the controller root', () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-dangling-')));
    try {
        const codeDir = path.join(workspace, '.ploinky', 'repos', 'repo', 'agent');
        const logsDir = path.join(workspace, '.ploinky', 'logs');
        fs.mkdirSync(codeDir, { recursive: true });
        fs.symlinkSync(path.join(workspace, '.ploinky', 'deps', 'store', 'collected', 'node_modules'), path.join(codeDir, 'node_modules'));
        const profile = buildSeatbeltProfile({
            agentLibGrant: seatbeltGrantFor(workspace),
            agentCodePath: codeDir,
            agentLibPath: path.join(workspace, 'Agent'),
            nodeModulesDir: path.join(workspace, '.ploinky', 'deps', 'store', 'node_modules'),
            agentWorkDir: path.join(workspace, '.data', 'agent'),
            sharedDir: path.join(workspace, '.data', 'shared'),
            cwd: workspace,
            skillsPath: null,
            codeReadOnly: true,
            skillsReadOnly: true,
            volumes: {},
            workspaceRoot: workspace,
            extraWritePaths: [logsDir],
        });
        assert.ok(profile.includes(`(subpath ${JSON.stringify(path.join(codeDir, 'node_modules'))})`));
        // A caller-supplied write path inside the controller root is granted
        // first and then overridden by the controller root denial.
        assert.ok(profile.indexOf(`(allow file-write* (subpath ${JSON.stringify(logsDir)}))`)
            < profile.indexOf('; Controller root is read-only'));
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

// Seatbelt has no mount namespace: controller secrets are unreadable only
// because they live inside the read-denied controller-state root. The retired
// spelling beside it is readable through the broad workspace grant.
test('generated profile denies reads of the master key and encrypted stores but not of their retired spelling', { skip: process.platform !== 'darwin' }, () => {
    const sandboxProbe = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', '/bin/echo', 'ok'], {
        encoding: 'utf8',
    });
    if (sandboxProbe.status !== 0) {
        assert.fail(`sandbox-exec is unavailable: ${sandboxProbe.stderr || sandboxProbe.stdout}`);
    }

    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-controller-secrets-')));
    const agentWorkDir = path.join(workspace, '.data', 'agent');
    const sharedDir = path.join(workspace, '.data', 'shared');
    try {
        const { path: keyPath } = initializeWorkspaceMasterKey({ workspaceRoot: workspace });
        const names = ['master-key', '.secrets', 'ploinky_subject_identity_ed25519_v1.enc'];
        for (const name of names.slice(1)) {
            fs.writeFileSync(path.join(path.dirname(keyPath), name), 'synthetic\n', { mode: 0o600 });
        }
        for (const name of names) {
            fs.writeFileSync(path.join(workspace, '.ploinky', name), 'synthetic retired\n', { mode: 0o600 });
        }
        fs.mkdirSync(agentWorkDir, { recursive: true });
        fs.mkdirSync(sharedDir, { recursive: true });
        fs.writeFileSync(path.join(workspace, 'project-file'), 'PROJECT');
        const agentLibSourceGrant = seatbeltGrantFor(workspace, { create: true });
        const profilePath = path.join(workspace, 'profile.sb');
        fs.writeFileSync(profilePath, buildSeatbeltProfile({
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
        }), 'utf8');
        const readable = target => spawnSync('sandbox-exec', [
            '-f', profilePath, '/bin/sh', '-c', 'test -r "$1" && /bin/cat "$1" >/dev/null', 'probe', target,
        ], { cwd: workspace, encoding: 'utf8' }).status === 0;

        assert.equal(readable(path.join(workspace, 'project-file')), true);
        for (const name of names) {
            assert.equal(readable(path.join(path.dirname(keyPath), name)), false, `${name} is readable`);
            assert.equal(readable(path.join(workspace, '.ploinky', name)), true, `retired ${name} control`);
        }
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
