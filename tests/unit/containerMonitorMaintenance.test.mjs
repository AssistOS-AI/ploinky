import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-container-monitor-maintenance-'));
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const locks = await import(`../../cli/utils/runtime/maintenanceLocks.js?test=${Date.now()}`);
const { performContainerRestart } = await import(`../../cli/server/containerMonitor.js?test=${Date.now()}`);

test('scheduled watchdog restart defers when maintenance starts before execution', async () => {
    const containerName = 'maintenance-race-container';
    locks.createMaintenanceLock(containerName, { operation: 'reinstall' });

    const events = [];
    const monitor = {
        config: {},
        isShuttingDown: () => false,
        log(level, event, data) {
            events.push({ level, event, data });
        },
        targets: new Map(),
    };
    const target = {
        containerName,
        agentName: 'demo-agent',
        repoName: 'demo-repo',
        manifestPath: path.join(workspace, 'missing-manifest.json'),
        isRestarting: true,
        maintenanceDeferred: false,
    };

    await performContainerRestart(monitor, target, 'not_running');

    assert.equal(target.isRestarting, false);
    assert.equal(target.circuitBreakerTripped, undefined);
    assert.equal(locks.inspectMaintenanceLock(containerName).active, true);
    assert.deepEqual(
        events.map(({ event }) => event),
        ['container_restart_deferred_maintenance'],
    );
});
