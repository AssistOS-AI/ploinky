import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    buildSeatbeltEntryCommand,
    ensureSeatbeltCodeNodeModules,
} from '../../cli/sandbox/seatbelt/seatbeltServiceManager.js';

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
