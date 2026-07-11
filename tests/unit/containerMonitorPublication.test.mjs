import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { performContainerRestart } from '../../cli/server/containerMonitor.js';

test('monitor publication denial is nonfatal, starts nothing, logs, and schedules backoff', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-publish-'));
    try {
        const manifestPath = path.join(root, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({
            profiles: { default: { openPorts: ['127.0.0.1:17000:7000'] } },
        }));
        const events = [];
        const scheduled = [];
        let ensureCalls = 0;
        const monitor = {
            config: { INITIAL_BACKOFF_MS: 5 },
            targets: new Map(),
            isShuttingDown: () => false,
            log(level, event, data) { events.push({ level, event, data }); },
            ensureAgentService() {
                ensureCalls += 1;
                const error = new Error('run the one-shot host command');
                error.code = 'PLOINKY_OUTER_PUBLICATION_REQUIRED';
                throw error;
            },
            scheduleContainerRestart(_monitor, _target, reason) { scheduled.push(reason); },
        };
        const target = {
            containerName: 'agent_container',
            agentName: 'onlyOffice',
            repoName: 'AchillesIDE',
            alias: null,
            type: 'agent',
            manifestPath,
            isRestarting: true,
            lastError: null,
        };

        await performContainerRestart(monitor, target, 'not_running');

        assert.equal(ensureCalls, 1);
        assert.equal(target.isRestarting, false);
        assert.equal(target.lastError, 'run the one-shot host command');
        assert.deepEqual(scheduled, ['publication_denied']);
        assert.equal(events.some((entry) => entry.event === 'container_restart_publication_denied'), true);
        assert.equal(events.some((entry) => entry.event === 'container_restart_success'), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
