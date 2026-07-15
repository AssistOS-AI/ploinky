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
        let releasedLease = null;
        const routerEndpoint = Object.freeze({ mode: 'default', host: 'host.containers.internal', port: 8123, url: 'http://host.containers.internal:8123' });
        const monitor = {
            config: { INITIAL_BACKOFF_MS: 5 },
            targets: new Map(),
            isShuttingDown: () => false,
            log(level, event, data) { events.push({ level, event, data }); },
            createWorkspaceMutationLease: () => ({ token: 'monitor-lease' }),
            releaseWorkspaceMutationLease: (lease) => { releasedLease = lease; },
            resolveRouterEndpoint: () => routerEndpoint,
            ensureAgentService(_agentName, _manifest, _agentDir, options) {
                ensureCalls += 1;
                assert.equal(options.networkLockWaitMs, 0);
                assert.equal(options.routerEndpoint, routerEndpoint);
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
        assert.equal(releasedLease?.token, 'monitor-lease');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('monitor acquires the common workspace lease and defers without mutation on contention', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-lease-'));
    try {
        const manifestPath = path.join(root, 'manifest.json');
        fs.writeFileSync(manifestPath, '{}');
        let ensureCalls = 0;
        const events = [];
        const busy = new Error('workspace start active');
        busy.code = 'PLOINKY_WORKSPACE_MUTATION_BUSY';
        const monitor = {
            targets: new Map(),
            isShuttingDown: () => false,
            log(level, event, data) { events.push({ level, event, data }); },
            createWorkspaceMutationLease() { throw busy; },
            resolveRouterEndpoint: () => Object.freeze({ mode: 'default', host: 'host.containers.internal', port: 8123, url: 'http://host.containers.internal:8123' }),
            ensureAgentService() { ensureCalls += 1; },
        };
        const target = {
            containerName: 'agent_container',
            agentName: 'demo',
            repoName: 'repo',
            alias: null,
            type: 'agent',
            manifestPath,
            isRestarting: true,
        };
        await performContainerRestart(monitor, target, 'not_running');
        assert.equal(ensureCalls, 0);
        assert.equal(target.isRestarting, false);
        assert.equal(events.some((entry) => entry.event === 'container_restart_deferred_workspace_start'), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('monitor resolves the router endpoint before acquiring a mutation lease', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-port-'));
    try {
        const manifestPath = path.join(root, 'manifest.json');
        fs.writeFileSync(manifestPath, '{}');
        let leaseCalls = 0;
        let ensureCalls = 0;
        const invalidPort = new Error('routing.json.port: expected an unsigned decimal port in the range 1..65535');
        const monitor = {
            targets: new Map(),
            isShuttingDown: () => false,
            log() {},
            resolveRouterEndpoint() { throw invalidPort; },
            createWorkspaceMutationLease() { leaseCalls += 1; return {}; },
            ensureAgentService() { ensureCalls += 1; },
        };
        const target = {
            containerName: 'agent_container',
            agentName: 'demo',
            repoName: 'repo',
            alias: null,
            type: 'agent',
            manifestPath,
            isRestarting: true,
        };

        await assert.rejects(
            performContainerRestart(monitor, target, 'not_running'),
            (error) => error === invalidPort,
        );
        assert.equal(leaseCalls, 0);
        assert.equal(ensureCalls, 0);
        assert.equal(target.isRestarting, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
