import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MASTER_KEY = '5'.repeat(64);

test('local CLI session headers carry an admin user session cookie', async (t) => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'ploinky-client-session-'));
    mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });

    const previousWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    process.env.PLOINKY_MASTER_KEY = MASTER_KEY;
    t.after(() => {
        if (previousWorkspaceRoot === undefined) {
            delete process.env.PLOINKY_WORKSPACE_ROOT;
        } else {
            process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspaceRoot;
        }
        if (previousMasterKey === undefined) {
            delete process.env.PLOINKY_MASTER_KEY;
        } else {
            process.env.PLOINKY_MASTER_KEY = previousMasterKey;
        }
        rmSync(workspace, { recursive: true, force: true });
    });

    const nonce = `${Date.now()}-${Math.random()}`;
    const clientModule = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/commands/client.js')).href}?test=${nonce}`);
    const localService = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/auth/localService.js')).href}?test=${nonce}`);

    const headers = clientModule.buildLocalCliSessionHeaders();
    assert.match(headers.cookie, /^ploinky_jwt=/);

    const token = headers.cookie.slice('ploinky_jwt='.length);
    const payload = localService.verifySessionJwt(token);
    assert.equal(payload.usr.username, 'admin');
    assert.deepEqual(payload.usr.roles, ['user', 'admin']);
});
