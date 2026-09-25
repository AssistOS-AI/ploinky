import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Mutation-gap regression: a real Marketplace enable Worker that takes a real
// workspace mutation lease and then exits abnormally must leave that exact
// lease retained for recovery through the production retention path (no
// injected `retainLease`). The scenario runs in a child process because the
// lease location is fixed by PLOINKY_WORKSPACE_ROOT when config.js loads.
// The Worker process is this test's own child; nothing outlives it.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = rel => pathToFileURL(path.join(projectRoot, rel)).href;

test('a real Worker that exits abnormally while holding a real workspace lease leaves it retained as recovery-required', () => {
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-marketplace-lease-')));
    try {
        const workspaceRoot = path.join(scratch, 'workspace');
        const home = path.join(scratch, 'home');
        fs.mkdirSync(path.join(workspaceRoot, '.ploinky'), { recursive: true });
        fs.mkdirSync(home, { recursive: true });
        const tokenFile = path.join(scratch, 'lease-token');
        const leaseFile = path.join(workspaceRoot, '.ploinky', 'running', 'workspace-start.json');
        const script = String.raw`
            import fs from 'node:fs';
            const { runMarketplaceEnableWorker } = await import(${JSON.stringify(moduleUrl('cli/server/marketplaceEnableWorker.js'))});
            let rejected = null;
            try {
                await runMarketplaceEnableWorker({ agentRef: 'repo/agent', mode: 'global' }, {
                    workerUrl: new URL(${JSON.stringify(moduleUrl('tests/fixtures/marketplace-enable-lease-crash-worker.mjs'))}),
                    timeoutMs: 20000,
                });
            } catch (error) {
                rejected = { code: error.code || null, recoveryRequired: error.recoveryRequired === true, message: error.message };
            }
            // Retention may complete after the rejection; wait briefly for it.
            const leaseFile = ${JSON.stringify(leaseFile)};
            const read = () => { try { return JSON.parse(fs.readFileSync(leaseFile, 'utf8')); } catch (_) { return null; } };
            const deadline = Date.now() + 3000;
            while (read()?.recoveryRequired !== true && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
            const lease = read();
            const locks = await import(${JSON.stringify(moduleUrl('cli/utils/runtime/maintenanceLocks.js'))});
            let next = null;
            try { locks.releaseWorkspaceMutationLease(locks.createWorkspaceMutationLease({ operation: 'next' })); next = 'acquired'; }
            catch (error) { next = error.code || String(error); }
            process.stdout.write('RESULT:' + JSON.stringify({ rejected, lease, next, ownerPid: process.pid }) + '\n');
        `;
        const env = { ...process.env, HOME: home, PLOINKY_WORKSPACE_ROOT: workspaceRoot, PLOINKY_TEST_LEASE_TOKEN_FILE: tokenFile };
        delete env.PLOINKY_ROOT;
        // A file, not --input-type/-e: Worker threads inherit execArgv.
        const driver = path.join(scratch, 'driver.mjs');
        fs.writeFileSync(driver, script);
        const output = execFileSync(process.execPath, [driver], {
            cwd: workspaceRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
        });
        const line = output.split('\n').find(entry => entry.startsWith('RESULT:'));
        assert.ok(line, output);
        const result = JSON.parse(line.slice('RESULT:'.length));
        const token = fs.readFileSync(tokenFile, 'utf8');

        assert.equal(result.rejected?.code, 'PLOINKY_MARKETPLACE_ENABLE_WORKER_FAILED');
        assert.match(result.rejected.message, /exited before completion \(1\)/);
        assert.ok(result.lease, 'the lease file was not removed');
        assert.equal(result.lease.token, token, 'the exact worker lease is the one retained');
        assert.equal(result.lease.ownerPid, result.ownerPid);
        assert.match(result.lease.operation, /^marketplace-enable:[0-9a-f-]{36}$/);
        assert.equal(result.lease.recoveryRequired, true, 'the default retention path marked the lease recovery-required');
        assert.match(result.lease.recoveryReason, /without descendant quiescence/);
        assert.equal(result.rejected.recoveryRequired, true);
        assert.equal(result.next, 'PLOINKY_WORKSPACE_MUTATION_RECOVERY_REQUIRED', 'a later mutation is refused until recovery');
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});
