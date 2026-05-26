import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    buildBwrapArgs,
    buildBwrapInteractiveCommand,
    buildShellCommand,
} from '../../cli/services/bwrap/bwrapServiceManager.js';

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

test('buildBwrapArgs overlays protected workspace paths read-only after cwd bind', () => {
    const root = tempDir();
    try {
        const agentCodePath = path.join(root, '.ploinky', 'repos', 'repo', 'agent');
        const cacheRoot = path.join(root, '.ploinky', 'deps', 'agents', 'repo', 'agent', 'bwrap-linux-x64-node25');
        const nodeModulesDir = path.join(cacheRoot, 'node_modules');
        const sharedDir = path.join(root, '.ploinky', 'shared');
        const agentLibPath = path.join(root, 'Agent');
        for (const dir of [agentCodePath, nodeModulesDir, sharedDir, agentLibPath]) {
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
            volumes: {},
        });

        assert.ok(hasRoBind(args, agentCodePath, '/code'));
        assert.ok(hasRoBind(args, cacheRoot));
        assert.ok(hasRoBind(args, agentCodePath));
        assert.ok(args.indexOf('--bind') < args.lastIndexOf('--ro-bind'));
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
