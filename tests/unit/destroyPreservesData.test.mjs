import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('destroyAll clears dependency cache and preserves agent data', async () => {
    const originalCwd = process.cwd();
    const originalWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-destroy-'));
    try {
        process.chdir(workspace);
        process.env.PLOINKY_WORKSPACE_ROOT = workspace;
        fs.mkdirSync(path.join(workspace, '.ploinky', 'deps', 'agents', 'repo', 'agent'), { recursive: true });
        fs.mkdirSync(path.join(workspace, '.data', 'agent'), { recursive: true });
        fs.writeFileSync(path.join(workspace, '.data', 'agent', 'user-state.txt'), 'keep');
        fs.writeFileSync(path.join(workspace, '.ploinky', 'agents.json'), '{}');

        const moduleSuffix = `?test=${Date.now()}`;
        const sessionControlUrl = new URL('../../cli/commands/sessionControl.js', import.meta.url);
        const { destroyAll } = await import(`${sessionControlUrl.href}${moduleSuffix}`);

        await destroyAll();

        assert.ok(!fs.existsSync(path.join(workspace, '.ploinky', 'deps')));
        assert.equal(fs.readFileSync(path.join(workspace, '.data', 'agent', 'user-state.txt'), 'utf8'), 'keep');
    } finally {
        process.chdir(originalCwd);
        if (originalWorkspaceRoot === undefined) {
            delete process.env.PLOINKY_WORKSPACE_ROOT;
        } else {
            process.env.PLOINKY_WORKSPACE_ROOT = originalWorkspaceRoot;
        }
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
