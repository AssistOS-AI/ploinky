import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveDashboardCommandTimeoutMs,
    shouldDetachDashboardCommand,
    terminateDashboardCommand,
} from '../../cli/server/handlers/dashboard.js';

test('dashboard gives targeted and whole-workspace restarts the public lifecycle budget', () => {
    assert.equal(resolveDashboardCommandTimeoutMs(['restart']), 16 * 60_000);
    assert.equal(resolveDashboardCommandTimeoutMs(['restart', 'onlyOffice']), 16 * 60_000);
});

test('dashboard retains the short budget for non-lifecycle control commands', () => {
    assert.equal(resolveDashboardCommandTimeoutMs(['status']), 30_000);
    assert.equal(resolveDashboardCommandTimeoutMs(['list', 'agents']), 30_000);
    assert.equal(resolveDashboardCommandTimeoutMs(['restart-status']), 30_000);
    assert.equal(resolveDashboardCommandTimeoutMs([]), 30_000);
});

test('dashboard isolates Unix commands and terminates the complete lifecycle process group', () => {
    assert.equal(shouldDetachDashboardCommand('linux'), true);
    assert.equal(shouldDetachDashboardCommand('darwin'), true);
    assert.equal(shouldDetachDashboardCommand('win32'), false);

    const signals = [];
    let directKills = 0;
    const outcome = terminateDashboardCommand({
        pid: 4242,
        kill() { directKills += 1; },
    }, {
        platform: 'linux',
        killProcess(pid, signal) { signals.push([pid, signal]); },
    });

    assert.equal(outcome, 'group');
    assert.deepEqual(signals, [[-4242, 'SIGTERM']]);
    assert.equal(directKills, 0);
});

test('dashboard falls back to direct termination when process-group signaling is unavailable', () => {
    const signals = [];
    const proc = {
        pid: 4242,
        kill(signal) { signals.push(['direct', signal]); },
    };
    const outcome = terminateDashboardCommand(proc, {
        platform: 'linux',
        killProcess() { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    });

    assert.equal(outcome, 'process');
    assert.deepEqual(signals, [['direct', 'SIGTERM']]);
    assert.equal(terminateDashboardCommand(null, { platform: 'win32' }), 'failed');
});
