import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    applySeatbeltRuntimeEnvironment,
    buildSeatbeltEntryCommand,
    buildSeatbeltRuntimeBinds,
    ensureSeatbeltCodeNodeModules,
    resolveSeatbeltRuntimeLayout,
} from '../../cli/sandbox/seatbelt/seatbeltServiceManager.js';
import { getAgentWorkDir } from '../../cli/utils/workspaceStructure.js';

function tempDir(prefix = 'seatbelt-service-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('ensureSeatbeltCodeNodeModules repairs broken managed symlink', () => {
    const root = tempDir();
    try {
        const agentCodePath = path.join(root, 'agent');
        const cachePath = path.join(root, 'cache', 'node_modules');
        const missingTarget = path.join(root, 'missing', 'node_modules');
        fs.mkdirSync(agentCodePath, { recursive: true });
        fs.mkdirSync(cachePath, { recursive: true });
        fs.symlinkSync(missingTarget, path.join(agentCodePath, 'node_modules'), 'dir');

        const linkPath = ensureSeatbeltCodeNodeModules('demo', agentCodePath, cachePath);

        assert.equal(linkPath, path.join(agentCodePath, 'node_modules'));
        assert.equal(fs.realpathSync(linkPath), fs.realpathSync(cachePath));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('ensureSeatbeltCodeNodeModules rejects real node_modules directory', () => {
    const root = tempDir();
    try {
        const agentCodePath = path.join(root, 'agent');
        const cachePath = path.join(root, 'cache', 'node_modules');
        fs.mkdirSync(path.join(agentCodePath, 'node_modules'), { recursive: true });
        fs.mkdirSync(cachePath, { recursive: true });
        fs.writeFileSync(path.join(agentCodePath, 'node_modules', 'LOCAL_MARKER'), 'local');

        assert.throws(
            () => ensureSeatbeltCodeNodeModules('demo', agentCodePath, cachePath),
            /not the Ploinky-managed dependency-cache symlink/,
        );
        assert.equal(fs.existsSync(path.join(agentCodePath, 'node_modules', 'LOCAL_MARKER')), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('buildSeatbeltEntryCommand runs start hook before explicit agent command', () => {
    const command = buildSeatbeltEntryCommand('demo', {
        start: 'node /code/bootstrap.js',
        agent: 'node /code/server.js',
    }, {}, {
        agentCodePath: '/tmp/workspace/.ploinky/repos/repo/demo',
        agentLibPath: '/tmp/workspace/.ploinky/seatbelt-runtime/demo/Agent-123',
    });

    assert.equal(
        command,
        'cd /tmp/workspace/.ploinky/repos/repo/demo && (node /tmp/workspace/.ploinky/repos/repo/demo/bootstrap.js &) && exec node /tmp/workspace/.ploinky/repos/repo/demo/server.js',
    );
});

test('Seatbelt keeps shared workspace cwd separate from stable per-alias homes', () => {
    const cwd = '/tmp/shared-seatbelt-workspace';
    const first = resolveSeatbeltRuntimeLayout({
        agentName: 'demo',
        alias: 'first-demo',
        cwd,
    });
    const second = resolveSeatbeltRuntimeLayout({
        agentName: 'demo',
        alias: 'second-demo',
        cwd,
    });
    const replacement = resolveSeatbeltRuntimeLayout({
        agentName: 'demo',
        alias: 'first-demo',
        cwd,
    });
    const unaliased = resolveSeatbeltRuntimeLayout({ agentName: 'demo', cwd });

    assert.equal(first.cwd, cwd);
    assert.equal(second.cwd, cwd);
    assert.equal(first.agentWorkDir, getAgentWorkDir('first-demo'));
    assert.equal(second.agentWorkDir, getAgentWorkDir('second-demo'));
    assert.notEqual(first.agentWorkDir, second.agentWorkDir);
    assert.deepEqual(replacement, first);
    assert.equal(unaliased.agentWorkDir, getAgentWorkDir('demo'));

    const env = applySeatbeltRuntimeEnvironment({}, first);
    assert.deepEqual(env, {
        WORKSPACE_PATH: cwd,
        HOME: getAgentWorkDir('first-demo'),
    });

    assert.deepEqual(buildSeatbeltRuntimeBinds(first), [
        { source: getAgentWorkDir('first-demo'), target: getAgentWorkDir('first-demo') },
        { source: cwd, target: cwd },
    ]);
    const samePath = Object.freeze({ ...first, cwd: first.agentWorkDir });
    assert.deepEqual(buildSeatbeltRuntimeBinds(samePath), [
        { source: first.agentWorkDir, target: first.agentWorkDir },
    ]);
});
