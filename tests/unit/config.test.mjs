import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const configUrl = pathToFileURL(path.join(repoRoot, 'cli/utils/config.js')).href;

test('config resolves workspace root from parent .ploinky', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-config-'));
    const child = path.join(root, 'child');
    const rootRealpath = fs.realpathSync(root);

    try {
        fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
        fs.mkdirSync(child, { recursive: true });

        const script = `
            import { PLOINKY_WORKSPACE_ROOT, PLOINKY_DIR, initEnvironment } from ${JSON.stringify(configUrl)};
            const fs = await import('node:fs');
            const path = await import('node:path');
            initEnvironment();
            console.log(JSON.stringify({
                workspaceRoot: PLOINKY_WORKSPACE_ROOT,
                ploinkyDir: PLOINKY_DIR,
                cwdPloinkyExists: fs.existsSync('./.ploinky'),
                dataExists: fs.existsSync(path.join(PLOINKY_WORKSPACE_ROOT, '.data')),
                legacyAgentsDirExists: fs.existsSync(path.join(PLOINKY_WORKSPACE_ROOT, '.ploinky', 'agents')),
                agentsFileExists: fs.existsSync(path.join(PLOINKY_WORKSPACE_ROOT, '.ploinky', 'agents.json')),
            }));
        `;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: child,
            encoding: 'utf8',
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);

        const outputLine = result.stdout.trim().split('\n').at(-1);
        const output = JSON.parse(outputLine);

        assert.equal(output.workspaceRoot, rootRealpath);
        assert.equal(output.ploinkyDir, path.join(rootRealpath, '.ploinky'));
        assert.equal(output.cwdPloinkyExists, false);
        assert.equal(output.dataExists, true);
        assert.equal(output.legacyAgentsDirExists, false);
        assert.equal(output.agentsFileExists, false);
        assert.equal(fs.existsSync(path.join(child, '.ploinky')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('config reports deleted current directory clearly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-config-missing-cwd-'));
    const child = path.join(root, 'child');

    try {
        fs.mkdirSync(child, { recursive: true });
        const script = `
            import fs from 'node:fs';
            process.chdir(${JSON.stringify(child)});
            fs.rmSync(${JSON.stringify(child)}, { recursive: true, force: true });
            await import(${JSON.stringify(`${configUrl}?missing-cwd=${Date.now()}`)});
        `;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: root,
            encoding: 'utf8',
        });

        assert.equal(result.status, 1);
        assert.match(result.stderr, /current directory because it no longer exists/);
        assert.match(result.stderr, /cd -P <workspace>/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
