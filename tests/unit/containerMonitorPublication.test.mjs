import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { performContainerRestart } from '../../cli/server/containerMonitor.js';

function restartTarget(manifestPath, overrides = {}) {
    return {
        containerName: 'agent_container',
        agentName: 'demo',
        repoName: 'repo',
        alias: null,
        type: 'agent',
        runtime: 'container',
        manifestPath,
        isRestarting: true,
        lastError: null,
        ...overrides,
    };
}

function preparedRestartResult(overrides = {}) {
    return {
        containerName: 'agent_container',
        hostPort: 43123,
        serviceTargets: { 3001: 43124 },
        registryRecord: {
            type: 'agent',
            repoName: 'repo',
            agentName: 'demo',
            instanceId: 'instance-v2',
            enableGeneration: 'enable-v2',
            config: { ports: [{ containerPort: 7000, hostPort: 43123 }] },
        },
        requiresEdgeActivation: true,
        preparationLease: Object.freeze({
            transactionId: 'restart-lease',
            preparedGeneration: 'sha256:prepared',
            lifecycleBindingDigest: 'sha256:lifecycle',
        }),
        ...overrides,
    };
}

function nextTurn() {
    return new Promise((resolve) => setImmediate(resolve));
}

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

test('monitor resolves the router endpoint under the workspace mutation lease', async () => {
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
        assert.equal(leaseCalls, 1);
        assert.equal(ensureCalls, 0);
        assert.equal(target.isRestarting, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('monitor rejects manifest bytes changed during ensure before readiness or activation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-manifest-race-'));
    try {
        const manifestPath = path.join(root, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ readiness: { protocol: 'none' }, profile: 'before' }));
        const result = preparedRestartResult();
        const events = [];
        const monitor = {
            config: {},
            targets: new Map(),
            isShuttingDown: () => false,
            log(_level, event) { events.push(event); },
            createWorkspaceMutationLease: () => ({ token: 'workspace' }),
            releaseWorkspaceMutationLease() { events.push('workspace-release'); },
            resolveRouterEndpoint: () => Object.freeze({
                mode: 'default',
                host: 'host.containers.internal',
                port: 8080,
                url: 'http://host.containers.internal:8080',
            }),
            ensureAgentService() {
                events.push('ensure');
                fs.writeFileSync(manifestPath, JSON.stringify({ readiness: { protocol: 'none' }, profile: 'after' }));
                return result;
            },
            waitForAgentReady() { assert.fail('changed launch input must fail before readiness'); },
            mergeRoutingConfig() { assert.fail('changed launch input must not mutate routes'); },
            applyEdgeRoutingGeneration() { assert.fail('changed launch input must not activate'); },
            abortEdgeRoutingPreparation(lease) {
                events.push('preparation-abort');
                assert.equal(lease, result.preparationLease);
            },
            cleanupFailedRuntime(containerName) {
                events.push(`candidate-cleanup:${containerName}`);
            },
        };
        const target = restartTarget(manifestPath);

        await assert.rejects(
            performContainerRestart(monitor, target, 'manifest-race'),
            { code: 'PLOINKY_RESTART_MANIFEST_CHANGED' },
        );
        assert.deepEqual(events.slice(0, 3), [
            'ensure',
            'preparation-abort',
            'candidate-cleanup:agent_container',
        ]);
        assert.equal(events.includes('container_restart_success'), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('monitor waits for exact semantic readiness before committing the returned registry and preparation lease', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-ready-'));
    try {
        const manifestPath = path.join(root, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ readiness: { protocol: 'mcp' } }));
        const result = preparedRestartResult();
        const events = [];
        let savedAgents = null;
        let savedRouting = null;
        let releaseReadiness;
        const readinessGate = new Promise((resolve) => { releaseReadiness = resolve; });
        const monitor = {
            config: {},
            targets: new Map(),
            isShuttingDown: () => false,
            log(_level, event) { events.push(event); },
            createWorkspaceMutationLease() { events.push('workspace-lease'); return { token: 'workspace' }; },
            releaseWorkspaceMutationLease(lease) {
                assert.equal(lease.token, 'workspace');
                events.push('workspace-release');
            },
            resolveRouterEndpoint: () => Object.freeze({
                mode: 'default',
                host: 'host.containers.internal',
                port: 8080,
                url: 'http://host.containers.internal:8080',
            }),
            ensureAgentService() { events.push('ensure'); return result; },
            async waitForAgentReady(route, options) {
                events.push('readiness-start');
                assert.deepEqual(route, { hostPort: 43123 });
                assert.equal(options.protocol, 'mcp');
                return readinessGate;
            },
            loadAgents() {
                events.push('registry-load');
                return {
                    agent_container: {
                        type: 'agent',
                        repoName: 'repo',
                        agentName: 'demo',
                        instanceId: 'instance-v2',
                        enableGeneration: 'enable-v2',
                    },
                };
            },
            saveAgents(agents, options) {
                events.push('registry-save');
                assert.deepEqual(options, { coordinate: false });
                savedAgents = structuredClone(agents);
            },
            async mergeRoutingConfig(mutator, options) {
                events.push('route-merge-start');
                assert.deepEqual(options, { coordinate: false });
                const config = await mutator({ routes: {} });
                savedRouting = structuredClone(config);
                events.push('route-candidate-written');
            },
            applyEdgeRoutingGeneration(options) {
                events.push('generation-apply');
                assert.equal(options.preparationLease, result.preparationLease);
                assert.equal(options.reason, 'watchdog-runtime-ready:demo');
                return { selector: { state: 'active' } };
            },
            abortEdgeRoutingPreparation() {
                assert.fail('successful restart must commit, not abort, its preparation');
            },
            cleanupFailedRuntime() {
                assert.fail('successful restart must not clean its runtime');
            },
        };
        const target = restartTarget(manifestPath);
        monitor.targets.set(target.containerName, target);

        const pending = performContainerRestart(monitor, target, 'not_running');
        await nextTurn();
        assert.equal(events.includes('registry-save'), false);
        assert.equal(events.includes('route-merge-start'), false);
        assert.equal(events.includes('generation-apply'), false);

        releaseReadiness(true);
        await pending;

        assert.deepEqual(savedAgents.agent_container, result.registryRecord);
        assert.deepEqual(savedRouting.routes.demo, {
            container: 'agent_container',
            hostPath: root,
            repo: 'repo',
            agent: 'demo',
            hostPort: 43123,
            serviceTargets: { 3001: 43124 },
        });
        assert.ok(events.indexOf('readiness-start') < events.indexOf('registry-save'));
        assert.ok(events.indexOf('route-candidate-written') < events.indexOf('generation-apply'));
        assert.ok(events.indexOf('generation-apply') < events.indexOf('container_restart_success'));
        assert.equal(events.includes('container_restart_failed'), false);
        assert.equal(target.isRestarting, false);
        assert.equal(target.lastError, null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('monitor readiness failure aborts the exact preparation, applies no route, and propagates without success', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-ready-fail-'));
    try {
        const manifestPath = path.join(root, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({
            start: 'node server.mjs',
            health: { readiness: { script: 'healthcheck.sh' } },
        }));
        const result = preparedRestartResult();
        const events = [];
        const monitor = {
            config: {},
            targets: new Map(),
            isShuttingDown: () => false,
            log(_level, event) { events.push(event); },
            createWorkspaceMutationLease: () => ({ token: 'workspace' }),
            releaseWorkspaceMutationLease() { events.push('workspace-release'); },
            resolveRouterEndpoint: () => Object.freeze({
                mode: 'default',
                host: 'host.containers.internal',
                port: 8080,
                url: 'http://host.containers.internal:8080',
            }),
            ensureAgentService() { events.push('ensure'); return result; },
            runContainerScriptReadiness(agentName, containerName, readiness) {
                events.push('readiness');
                assert.equal(agentName, 'demo');
                assert.equal(containerName, 'agent_container');
                assert.deepEqual(readiness, { script: 'healthcheck.sh' });
                return { status: 'failed', reason: 'exit 1', detail: 'not ready' };
            },
            mergeRoutingConfig() { assert.fail('readiness failure must not mutate the route candidate'); },
            saveAgents() { assert.fail('readiness failure must not commit the returned registry record'); },
            applyEdgeRoutingGeneration() { assert.fail('readiness failure must not apply a generation'); },
            abortEdgeRoutingPreparation(lease, options) {
                events.push('preparation-abort');
                assert.equal(lease, result.preparationLease);
                assert.equal(options.reason, 'watchdog-runtime-failed:not_running');
                return { selector: { state: 'inactive' } };
            },
            cleanupFailedRuntime(containerName) {
                events.push('candidate-cleanup');
                assert.equal(containerName, 'agent_container');
            },
        };
        const target = restartTarget(manifestPath);

        await assert.rejects(
            performContainerRestart(monitor, target, 'not_running'),
            /watchdog readiness script failed \(exit 1, output='not ready'\)/,
        );

        assert.deepEqual(events.slice(0, 4), ['ensure', 'readiness', 'preparation-abort', 'candidate-cleanup']);
        assert.equal(events.includes('container_restart_failed'), true);
        assert.equal(events.includes('container_restart_success'), false);
        assert.equal(target.isRestarting, false);
        assert.match(target.lastError, /readiness script failed/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('monitor apply failure aborts the exact preparation, cleans only the failed candidate, and propagates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-apply-fail-'));
    try {
        const manifestPath = path.join(root, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ readiness: { protocol: 'none' } }));
        const result = preparedRestartResult({ hostPort: null, serviceTargets: null });
        const events = [];
        const applyError = new Error('selector commit failed');
        const monitor = {
            config: {},
            targets: new Map(),
            isShuttingDown: () => false,
            log(_level, event) { events.push(event); },
            createWorkspaceMutationLease: () => ({ token: 'workspace' }),
            releaseWorkspaceMutationLease() {},
            resolveRouterEndpoint: () => Object.freeze({
                mode: 'default',
                host: 'host.containers.internal',
                port: 8080,
                url: 'http://host.containers.internal:8080',
            }),
            ensureAgentService: () => result,
            loadAgents: () => ({
                agent_container: {
                    type: 'agent',
                    repoName: 'repo',
                    agentName: 'demo',
                    instanceId: 'instance-v2',
                    enableGeneration: 'enable-v2',
                },
            }),
            saveAgents() { events.push('registry-save'); },
            async mergeRoutingConfig(mutator, options) {
                assert.deepEqual(options, { coordinate: false });
                await mutator({ routes: {} });
                events.push('route-candidate-written');
            },
            applyEdgeRoutingGeneration(options) {
                events.push('generation-apply');
                assert.equal(options.preparationLease, result.preparationLease);
                throw applyError;
            },
            abortEdgeRoutingPreparation(lease) {
                events.push('preparation-abort');
                assert.equal(lease, result.preparationLease);
                return { selector: { state: 'inactive' } };
            },
            cleanupFailedRuntime(containerName) {
                events.push(`candidate-cleanup:${containerName}`);
            },
        };
        const target = restartTarget(manifestPath);

        await assert.rejects(
            performContainerRestart(monitor, target, 'not_running'),
            (error) => error === applyError,
        );

        assert.deepEqual(events.slice(0, 5), [
            'registry-save',
            'route-candidate-written',
            'generation-apply',
            'preparation-abort',
            'candidate-cleanup:agent_container',
        ]);
        assert.equal(events.includes('container_restart_failed'), true);
        assert.equal(events.includes('container_restart_success'), false);
        assert.equal(target.isRestarting, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('monitor accepts a healthy exact reuse race without readiness, mutation, or generation apply', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-reuse-'));
    try {
        const manifestPath = path.join(root, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ readiness: { protocol: 'mcp' } }));
        const events = [];
        const monitor = {
            config: {},
            targets: new Map(),
            isShuttingDown: () => false,
            log(_level, event) { events.push(event); },
            createWorkspaceMutationLease: () => ({ token: 'workspace' }),
            releaseWorkspaceMutationLease() {},
            resolveRouterEndpoint: () => Object.freeze({
                mode: 'default',
                host: 'host.containers.internal',
                port: 8080,
                url: 'http://host.containers.internal:8080',
            }),
            ensureAgentService: () => ({
                containerName: 'agent_container',
                registryRecord: {
                    type: 'agent',
                    repoName: 'repo',
                    agentName: 'demo',
                    instanceId: 'unchanged-instance',
                    enableGeneration: 'unchanged-generation',
                },
            }),
            waitForAgentReady() { assert.fail('healthy reuse must not run replacement readiness'); },
            mergeRoutingConfig() { assert.fail('healthy reuse must not mutate routes'); },
            saveAgents() { assert.fail('healthy reuse must not mutate the registry'); },
            applyEdgeRoutingGeneration() { assert.fail('healthy reuse must not apply a generation'); },
            abortEdgeRoutingPreparation() { assert.fail('healthy reuse has no preparation to abort'); },
            cleanupFailedRuntime() { assert.fail('healthy reuse must not be cleaned'); },
        };
        const target = restartTarget(manifestPath);

        await performContainerRestart(monitor, target, 'not_running');

        assert.equal(events.includes('container_restart_reused_running'), true);
        assert.equal(events.includes('container_restart_success'), false);
        assert.equal(events.includes('container_restart_failed'), false);
        assert.equal(target.isRestarting, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('monitor rejects a malformed ensure result instead of reporting healthy reuse', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-monitor-invalid-ensure-'));
    try {
        const manifestPath = path.join(root, 'manifest.json');
        fs.writeFileSync(manifestPath, '{}');
        const events = [];
        const monitor = {
            config: {},
            targets: new Map(),
            isShuttingDown: () => false,
            log(_level, event) { events.push(event); },
            createWorkspaceMutationLease: () => ({ token: 'workspace' }),
            releaseWorkspaceMutationLease() {},
            resolveRouterEndpoint: () => Object.freeze({
                mode: 'default',
                host: 'host.containers.internal',
                port: 8080,
                url: 'http://host.containers.internal:8080',
            }),
            ensureAgentService: () => null,
            cleanupFailedRuntime() { assert.fail('no returned candidate exists to clean'); },
        };
        const target = restartTarget(manifestPath);

        await assert.rejects(
            performContainerRestart(monitor, target, 'not_running'),
            /mismatched exact registry identity/,
        );

        assert.equal(events.includes('container_restart_failed'), true);
        assert.equal(events.includes('container_restart_reused_running'), false);
        assert.equal(events.includes('container_restart_success'), false);
        assert.equal(target.isRestarting, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('sandbox monitor liveness keys the PID record by exact container name', () => {
    const source = fs.readFileSync(new URL('../../cli/server/containerMonitor.js', import.meta.url), 'utf8');
    assert.match(source, /isBwrapProcessRunning\(target\.containerName, \{/);
    assert.match(source, /instanceId: target\.instanceId/);
    assert.match(source, /enableGeneration: target\.enableGeneration/);
    assert.doesNotMatch(source, /isBwrapProcessRunning\(target\.agentName\)/);
});

test('semantic ownership probes recur, inactivate on failure, and force an exact replacement', () => {
    const source = fs.readFileSync(
        new URL('../../cli/server/containerMonitor.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /CONTINUOUS_PROBE_INTERVAL_MS/);
    assert.match(source, /now - target\.probeLastSuccessAt >= continuousProbeIntervalMs/);
    assert.match(source, /inactivate\(`continuous-runtime-probe-failed:\$\{target\.containerName\}`\)/);
    assert.match(source, /scheduleContainerRestart\(monitor, target, 'semantic_probe_failed'\)/);
    assert.match(source, /forceRecreate: reason === 'semantic_probe_failed'/);
});
