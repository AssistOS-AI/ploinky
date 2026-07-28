import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    buildBwrapArgs,
    buildBwrapInteractiveCommand,
    buildShellCommand,
    ensureBwrapAgentLibDir,
    resolveBwrapNodeRuntime,
} from '../../cli/sandbox/bwrap/bwrapServiceManager.js';

function tempDir(prefix = 'bwrap-args-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hasRoBind(args, source, target = source) {
    for (let index = 0; index < args.length - 2; index += 1) {
        if (args[index] === '--ro-bind' && args[index + 1] === source && args[index + 2] === target) {
            return true;
        }
    }
    return false;
}

function hasBind(args, source, target = source) {
    for (let index = 0; index < args.length - 2; index += 1) {
        if (args[index] === '--bind' && args[index + 1] === source && args[index + 2] === target) {
            return true;
        }
    }
    return false;
}

test('buildBwrapArgs overlays protected workspace paths read-only after cwd bind', () => {
    const root = tempDir();
    try {
        const agentCodePath = path.join(root, '.ploinky', 'repos', 'repo', 'agent');
        const cacheRoot = path.join(root, '.ploinky', 'deps', 'agents', 'repo', 'agent', 'bwrap-linux-x64-node25');
        const nodeModulesDir = path.join(cacheRoot, 'node_modules');
        const sharedDir = path.join(root, '.ploinky', 'shared');
        const agentLibPath = path.join(root, 'Agent');
        const agentHomeDir = path.join(root, '.data', 'demo');
        const nodeRuntimePath = path.join(root, 'node-runtime');
        for (const dir of [agentCodePath, nodeModulesDir, sharedDir, path.join(agentLibPath, 'node_modules'), agentHomeDir, nodeRuntimePath]) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const args = buildBwrapArgs({
            agentCodePath,
            agentLibPath,
            nodeModulesDir,
            sharedDir,
            cwd: root,
            agentHomeDir,
            nodeRuntimePath,
            skillsPath: null,
            envMap: {},
            codeReadOnly: true,
            skillsReadOnly: true,
            volumes: {},
        });

        assert.ok(hasRoBind(args, agentCodePath, '/code'));
        assert.ok(hasRoBind(args, cacheRoot));
        assert.ok(hasRoBind(args, agentCodePath));
        assert.ok(hasBind(args, root));
        assert.ok(hasBind(args, agentHomeDir, '/root'));
        assert.ok(hasRoBind(args, nodeRuntimePath, '/opt/ploinky-node'));
        assert.ok(args.indexOf('--bind') < args.lastIndexOf('--ro-bind'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('resolveBwrapNodeRuntime exposes the complete distribution containing node', () => {
    const root = tempDir('bwrap-node-runtime-');
    try {
        const nodePath = path.join(root, 'runtime', 'bin', 'node');
        fs.mkdirSync(path.dirname(nodePath), { recursive: true });
        fs.writeFileSync(nodePath, 'fake node\n');

        assert.deepEqual(resolveBwrapNodeRuntime(nodePath), {
            hostRuntimePath: fs.realpathSync(path.join(root, 'runtime')),
            sandboxRuntimePath: '/opt/ploinky-node',
            sandboxBinPath: '/opt/ploinky-node/bin',
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('buildBwrapArgs allows manifest volumes outside .ploinky', () => {
    const root = tempDir();
    try {
        const agentCodePath = path.join(root, '.ploinky', 'repos', 'repo', 'agent');
        const nodeModulesDir = path.join(root, '.ploinky', 'deps', 'agents', 'repo', 'agent', 'bwrap-linux-x64-node25', 'node_modules');
        const sharedDir = path.join(root, '.ploinky', 'shared');
        const agentLibPath = path.join(root, 'Agent');
        const agentHomeDir = path.join(root, '.data', 'demo');
        const dataDir = path.join(root, 'workspace-data', 'uploads');
        for (const dir of [agentCodePath, nodeModulesDir, sharedDir, path.join(agentLibPath, 'node_modules'), agentHomeDir, dataDir]) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const args = buildBwrapArgs({
            agentCodePath,
            agentLibPath,
            nodeModulesDir,
            sharedDir,
            cwd: root,
            agentHomeDir,
            skillsPath: null,
            envMap: {},
            codeReadOnly: true,
            skillsReadOnly: true,
            volumes: {
                [dataDir]: '/uploads',
            },
        });

        assert.ok(hasBind(args, dataDir, '/uploads'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('buildBwrapArgs enforces read-only manifest volume options', () => {
    const root = tempDir();
    try {
        const agentCodePath = path.join(root, '.ploinky', 'repos', 'repo', 'agent');
        const nodeModulesDir = path.join(root, '.ploinky', 'deps', 'agents', 'repo', 'agent', 'bwrap-linux-x64-node25', 'node_modules');
        const sharedDir = path.join(root, '.ploinky', 'shared');
        const agentLibPath = path.join(root, 'Agent');
        const secretDir = path.join(root, '.ploinky', 'data', 'secret');
        for (const dir of [agentCodePath, nodeModulesDir, sharedDir, path.join(agentLibPath, 'node_modules'), secretDir]) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const args = buildBwrapArgs({
            agentCodePath,
            agentLibPath,
            nodeModulesDir,
            sharedDir,
            cwd: root,
            skillsPath: null,
            envMap: {},
            codeReadOnly: true,
            skillsReadOnly: true,
            volumes: { [secretDir]: '/run/secret' },
            volumeOptions: { '/run/secret': { readOnly: true } },
        });

        assert.ok(hasRoBind(args, secretDir, '/run/secret'));
        assert.equal(hasBind(args, secretDir, '/run/secret'), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('buildBwrapArgs uses the persistent home as /root for isolated agents', () => {
    const root = tempDir();
    try {
        const agentCodePath = path.join(root, '.ploinky', 'repos', 'repo', 'agent');
        const nodeModulesDir = path.join(root, '.ploinky', 'deps', 'agent', 'node_modules');
        const sharedDir = path.join(root, '.ploinky', 'shared');
        const agentLibPath = path.join(root, 'Agent');
        const agentHomeDir = path.join(root, '.data', 'demoAlias');
        for (const dir of [agentCodePath, nodeModulesDir, sharedDir, path.join(agentLibPath, 'node_modules'), agentHomeDir]) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const args = buildBwrapArgs({
            agentCodePath,
            agentLibPath,
            nodeModulesDir,
            sharedDir,
            cwd: agentHomeDir,
            cwdMountTarget: '/root',
            agentHomeDir,
            skillsPath: null,
            envMap: {},
            codeReadOnly: false,
            skillsReadOnly: false,
            volumes: {},
        });

        assert.ok(hasBind(args, agentHomeDir, '/root'));
        assert.equal(hasBind(args, agentHomeDir, agentHomeDir), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('ensureBwrapAgentLibDir creates the nested dependency mount point outside the read-only source', () => {
    const root = tempDir('bwrap-agent-lib-');
    try {
        const sourceAgentLibPath = path.join(root, 'source', 'Agent');
        const sourceNodeModules = path.join(sourceAgentLibPath, 'node_modules');
        const nodeModulesDir = path.join(root, 'cache', 'node_modules');
        const runtimeRoot = path.join(root, 'runtime');
        fs.mkdirSync(path.join(sourceAgentLibPath, 'server'), { recursive: true });
        fs.mkdirSync(sourceNodeModules, { recursive: true });
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(path.join(sourceAgentLibPath, 'server', 'AgentServer.mjs'), 'export {};\n');
        fs.writeFileSync(path.join(sourceNodeModules, 'stale.txt'), 'must not be copied\n');

        const stagedAgentLibPath = ensureBwrapAgentLibDir('demo alias', nodeModulesDir, {
            sourceAgentLibPath,
            runtimeRoot,
        });

        assert.equal(fs.existsSync(path.join(stagedAgentLibPath, 'server', 'AgentServer.mjs')), true);
        assert.equal(fs.statSync(path.join(stagedAgentLibPath, 'node_modules')).isDirectory(), true);
        assert.equal(fs.existsSync(path.join(stagedAgentLibPath, 'node_modules', 'stale.txt')), false);
        assert.equal(fs.existsSync(path.join(sourceNodeModules, 'stale.txt')), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('buildBwrapInteractiveCommand forces interactive shell only for TTY shell sessions', () => {
    assert.equal(
        buildBwrapInteractiveCommand('/work', '/bin/sh', { forceInteractiveShell: true }),
        "cd '/work' && if command -v /bin/bash >/dev/null 2>&1; then exec /bin/bash -i; else exec /bin/sh -i; fi"
    );
    assert.equal(
        buildBwrapInteractiveCommand('/work', '/bin/sh', { forceInteractiveShell: false }),
        "cd '/work' && /bin/sh"
    );
});

test('buildBwrapInteractiveCommand preserves non-shell commands and quotes workdir', () => {
    assert.equal(
        buildBwrapInteractiveCommand("/tmp/it's-here", 'node /code/src/index.mjs', { forceInteractiveShell: true }),
        "cd '/tmp/it'\\''s-here' && node /code/src/index.mjs"
    );
});

test('buildShellCommand quotes argv for script pty wrapper', () => {
    assert.equal(
        buildShellCommand(['cmd', 'a b', "it's"]),
        "'cmd' 'a b' 'it'\\''s'"
    );
});
