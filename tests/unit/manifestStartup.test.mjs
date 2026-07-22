import assert from 'node:assert/strict';
import test from 'node:test';

import {
    finalizeStartupRoutes,
    partitionAdditionalStartupAgents,
    removeInactiveManualRoutes,
    resolveManifestStartup,
    shouldMonitorManifestRuntime,
} from '../../cli/utils/runtime/manifestStartup.js';

test('manifest startup defaults to automatic and accepts only explicit supported values', () => {
    assert.equal(resolveManifestStartup({}), 'automatic');
    assert.equal(resolveManifestStartup({ startup: 'automatic' }), 'automatic');
    assert.equal(resolveManifestStartup({ startup: 'manual' }), 'manual');
    assert.throws(() => resolveManifestStartup({ startup: 'manuel' }), /automatic.*manual/);
    assert.throws(() => resolveManifestStartup({ startup: false }), /automatic.*manual/);
});

test('additional startup partitions manual agents without overriding dependency nodes', () => {
    const registry = {
        automaticAgent: { repoName: 'repo', agentName: 'automaticAgent' },
        activeManual: { repoName: 'repo', agentName: 'activeManual', alias: 'active' },
        inactiveManual: { repoName: 'repo', agentName: 'inactiveManual' },
        manualDependency: { repoName: 'repo', agentName: 'manualDependency' },
    };
    const manifests = {
        automaticAgent: {},
        activeManual: { startup: 'manual' },
        inactiveManual: { startup: 'manual' },
        manualDependency: { startup: 'manual' },
    };

    const result = partitionAdditionalStartupAgents({
        registry,
        names: Object.keys(registry),
        graphRegistryNames: new Set(['manualDependency']),
        loadManifest: (record) => manifests[record.agentName],
        isRuntimeRunning: (name) => name === 'activeManual',
    });

    assert.deepEqual(result, {
        automatic: ['automaticAgent'],
        activeManual: [{ name: 'activeManual', routeKey: 'active' }],
        inactiveManual: [{ name: 'inactiveManual', routeKey: 'inactiveManual' }],
    });
});

test('watchdog monitors automatic agents and explicitly routed manual agents', () => {
    assert.equal(shouldMonitorManifestRuntime({}), true);
    assert.equal(shouldMonitorManifestRuntime({ startup: 'automatic' }), true);
    assert.equal(shouldMonitorManifestRuntime({ startup: 'manual' }), false);
    assert.equal(shouldMonitorManifestRuntime({ startup: 'manual' }, { hasRoute: true }), true);
});

test('general startup removes only routes for stopped manual agents', () => {
    const routes = {
        automaticAgent: { hostPort: 7101 },
        inactiveManual: { hostPort: 7102 },
        active: { hostPort: 7103 },
    };

    assert.deepEqual(removeInactiveManualRoutes(routes, [
        { name: 'inactiveManual', routeKey: 'inactiveManual' },
    ]), {
        automaticAgent: { hostPort: 7101 },
        active: { hostPort: 7103 },
    });
    assert.ok(routes.inactiveManual, 'the input routing snapshot must not be mutated');
});

test('startup finalization preserves newer routes persisted by no-wait workers', () => {
    const routes = finalizeStartupRoutes({
        soulGateway: { hostPort: 43196 },
        inactiveManual: { hostPort: 7102 },
    }, {
        soulGateway: { hostPort: 30549 },
        currentWorker: { hostPort: 7103 },
    }, [
        { name: 'inactiveManual', routeKey: 'inactiveManual' },
    ]);

    assert.deepEqual(routes, {
        soulGateway: { hostPort: 30549 },
        currentWorker: { hostPort: 7103 },
    });
});
