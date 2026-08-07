import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleSystemCommand } from '../../cli/commands/llmSystemCommands.js';

test('external commands use PATH without requiring which', {
    skip: process.platform === 'win32' ? 'fixture requires an unprivileged executable symlink' : false,
}, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-system-command-'));
    const executable = path.join(root, 'ploinky-path-command');
    fs.symlinkSync(process.execPath, executable);

    const hadPath = Object.hasOwn(process.env, 'PATH');
    const originalPath = process.env.PATH;
    process.env.PATH = root;
    t.after(() => {
        if (hadPath) process.env.PATH = originalPath;
        else delete process.env.PATH;
        fs.rmSync(root, { recursive: true, force: true });
    });

    const lookup = spawnSync('which', ['ploinky-path-command'], { stdio: 'ignore' });
    assert.equal(lookup.error?.code, 'ENOENT', 'fixture PATH must not contain which');
    assert.equal(await handleSystemCommand('ploinky-path-command', [
        '--eval', 'process.exit(0)',
    ]), true);
    assert.equal(await handleSystemCommand('ploinky-definitely-absent-command'), false);
});
