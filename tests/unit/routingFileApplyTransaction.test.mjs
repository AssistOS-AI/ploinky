import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-routing-transaction-'));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const previousRouterHostPort = process.env.PLOINKY_ROUTER_HOST_PORT;
const previousMediaHostPort = process.env.PLOINKY_MEDIA_HOST_PORT;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

const edge = await import('../../cli/sandbox/edgeGeneration.js');
const routing = await import('../../cli/server/routingFile.js');

test.after(() => {
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    if (previousRouterHostPort === undefined) delete process.env.PLOINKY_ROUTER_HOST_PORT;
    else process.env.PLOINKY_ROUTER_HOST_PORT = previousRouterHostPort;
    if (previousMediaHostPort === undefined) delete process.env.PLOINKY_MEDIA_HOST_PORT;
    else process.env.PLOINKY_MEDIA_HOST_PORT = previousMediaHostPort;
    fs.rmSync(workspace, { recursive: true, force: true });
});

test('routing merge retains one apply capability from mutation through commit', async () => {
    const initialized = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    edge.applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'routing-transaction-predecessor',
    });

    // Reproduce the observed bind-mount failure: the first release reports no
    // error but leaves the exact apply lock in place. A split mutation/apply
    // transaction then tries to reacquire its own lock and fails busy. One
    // retained capability can still commit safely before its final release.
    const originalUnlinkSync = fs.unlinkSync;
    let suppressedApplyRelease = false;
    fs.unlinkSync = function unlinkSyncWithOneStrandedApplyLock(target, ...args) {
        if (!suppressedApplyRelease && path.resolve(String(target)) === initialized.paths.applyLockFile) {
            suppressedApplyRelease = true;
            return undefined;
        }
        return originalUnlinkSync.call(this, target, ...args);
    };
    try {
        const merged = await routing.mergeRoutingConfig((current) => ({
            ...current,
            transactionProof: 'committed',
        }), {
            reason: 'routing-transaction-regression',
        });
        assert.equal(merged.transactionProof, 'committed');
        assert.equal(suppressedApplyRelease, true);
        assert.equal(fs.existsSync(initialized.paths.applyLockFile), true);
        assert.equal(
            edge.loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace })
                .generation.routing.transactionProof,
            'committed',
        );
    } finally {
        fs.unlinkSync = originalUnlinkSync;
        try { originalUnlinkSync(initialized.paths.applyLockFile); } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
});
