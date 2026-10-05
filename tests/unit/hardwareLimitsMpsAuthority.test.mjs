import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

test('MPS authorization loss cannot publish a refusal or retire the original runtime', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-authority-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    const { reconcileExactHardwareInstance } = await import('../../cli/sandbox/hardwareLimits/reconcile.mjs');
    const record = { type: 'agent', repoName: 'demo', agentName: 'worker', instanceId: 'instance', enableGeneration: 'generation', containerId: 'a'.repeat(64) };
    const events = [];
    let checks = 0;
    await assert.rejects(reconcileExactHardwareInstance({ key: 'exact', record }, {
        origin: 'apply', expectedToken: { epoch: 'e'.repeat(32), revision: 1 }, authorize: () => ++checks === 1,
    }, {
        maintenance: (_key, _options, callback) => callback(), loadRegistry: () => ({ exact: record }),
        loadPlan: () => ({ runtime: 'podman', manifest: {}, runtimeAdmission: { descriptor: { hardwareGpu: { smPercent: 25 } } }, profileResolution: { network: { mode: 'default' } }, agentPath: workspace }),
        readPolicy: () => ({ token: { epoch: 'e'.repeat(32), revision: 1 } }), policyCheck: () => true,
        cleanupPrepared: () => {}, loadRouting: () => ({ routes: { worker: { container: 'exact' } } }),
        publishUnavailable: async () => { events.push('revoke'); }, retireUnavailable: () => { events.push('retire'); },
    }), { code: 'identity_changed' });
    assert.equal(checks, 2);
    assert.deepEqual(events, []);
});
