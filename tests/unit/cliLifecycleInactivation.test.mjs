import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { stopExactRouterForLifecycle } from '../../cli/commands/cli.js';

const cliSource = fs.readFileSync(new URL('../../cli/commands/cli.js', import.meta.url), 'utf8');
const workspaceSource = fs.readFileSync(new URL('../../cli/commands/workspaceUtil.js', import.meta.url), 'utf8');

function assertOrdered(source, labels) {
    let previous = -1;
    for (const label of labels) {
        const next = source.indexOf(label, previous + 1);
        assert.ok(next > previous, `expected '${label}' after the prior lifecycle step`);
        previous = next;
    }
}

test('whole-workspace and Router lifecycle commands inactivate edge authorization before stopping processes', () => {
    assertOrdered(cliSource, [
        "inactivateEdgeRoutingGeneration('cli-router-restart')",
        "const routerStopResult = stopExactRouterForLifecycle('restart router')",
        'killRouterIfRunning: () => routerStopResult',
    ]);
    assertOrdered(cliSource, [
        "inactivateEdgeRoutingGeneration('cli-workspace-restart')",
        "const routerStopResult = stopExactRouterForLifecycle('restart')",
        'const list = stopConfiguredAgents();',
        'await startWorkspace(',
        'killRouterIfRunning: () => routerStopResult',
    ]);
    assertOrdered(cliSource, [
        "inactivateEdgeRoutingGeneration('cli-workspace-shutdown')",
        "stopExactRouterForLifecycle('shutdown')",
        'const list = destroyWorkspaceContainers();',
    ]);
    assertOrdered(cliSource, [
        "inactivateEdgeRoutingGeneration('cli-workspace-stop')",
        "stopExactRouterForLifecycle('stop')",
        'const list = stopConfiguredAgents();',
    ]);
    assertOrdered(cliSource, [
        "inactivateEdgeRoutingGeneration('cli-workspace-destroy')",
        "stopExactRouterForLifecycle('destroy')",
        'await destroyAll();',
    ]);
    assert.doesNotMatch(cliSource, /killRouterIfRunning:\s*\(\)\s*=>\s*\{\s*\}/);
});

test('every CLI Router lifecycle accepts only an exact stop, absent owner, or cleared stale record', () => {
    for (const result of [
        { stopped: true, pid: 123, signal: 'SIGTERM' },
        { stopped: false, reason: 'absent' },
        { stopped: false, reason: 'stale-record', pid: 123 },
    ]) {
        let stopCalls = 0;
        assert.equal(stopExactRouterForLifecycle('test lifecycle', {
            stopRouter() {
                stopCalls += 1;
                return result;
            },
        }), result);
        assert.equal(stopCalls, 1);
    }

    for (const result of [
        { stopped: false, reason: 'ownership-unverified', error: new Error('corrupt owner') },
        { stopped: false, reason: 'term-signal-failed' },
        { stopped: false, reason: 'kill-signal-failed' },
        { stopped: false, reason: 'kill-timeout' },
        undefined,
    ]) {
        assert.throws(
            () => stopExactRouterForLifecycle('test lifecycle', {
                stopRouter: () => result,
            }),
            (error) => error?.code === 'PLOINKY_ROUTER_STOP_REFUSED',
        );
    }
});

test('start admits prepared repositories before persisting the fixed Router port in the inactive transaction', () => {
    assert.doesNotMatch(cliSource, /resolveAndPersistStartRouterPort/);
    const startWorkspaceSource = workspaceSource.slice(
        workspaceSource.indexOf('async function startWorkspace('),
        workspaceSource.indexOf('\nasync function stopWorkspace(', workspaceSource.indexOf('async function startWorkspace(')),
    );
    assert.ok(
        startWorkspaceSource.indexOf('preflightWorkspaceStartRuntimeCapabilities')
            > startWorkspaceSource.indexOf('prepareManifestRepositories'),
        'fresh dependency repositories must be acquired before complete-graph admission',
    );
    assertOrdered(workspaceSource, [
        'prepareDefaultBootRepositories',
        'prepareManifestRepositories',
        'const admittedStart = preflightWorkspaceStartRuntimeCapabilities',
        "await acquireWorkspaceMutationLease({\n    operation: 'workspace-start',\n  })",
        'assertWorkspaceGraphAdmissionsCurrent(admittedStart.admissions)',
        "inactivateEdgeRoutingGeneration('workspace-start-prepare'",
        'resolveAndPersistStartRouterPort(staticAgentArg, portArg, {',
        'coordinate: false',
        'ensureGraphNodesEnabled(dependencyGraph, reg, {',
        'executeHostHook(hookValue, hookEnv',
        'applyStartupConfigProvidersForGraph({',
        'ensureAgentService(shortAgentName',
    ]);
});

test('single restart and reinstall delegate physical replacement to the shared runtime manager', () => {
    assert.doesNotMatch(cliSource, /stopBwrapProcess/);
    assert.doesNotMatch(workspaceSource, /stopBwrapProcess/);

    const reinstallStart = workspaceSource.indexOf('async function reinstallAgent(agentName');
    const reinstallEnd = workspaceSource.indexOf('\nexport {', reinstallStart);
    const reinstall = workspaceSource.slice(reinstallStart, reinstallEnd);
    const ensureIndex = reinstall.indexOf('await ensureAgentService(');
    const readinessIndex = reinstall.indexOf('await waitForManifestReadiness(', ensureIndex);
    const activationIndex = reinstall.indexOf('await activatePreparedRuntimeAfterReadiness(', readinessIndex);
    const successIndex = reinstall.indexOf("console.log(`[reinstall] reinstalled", activationIndex);
    assert.ok(ensureIndex >= 0);
    assert.ok(readinessIndex > ensureIndex);
    assert.ok(activationIndex > readinessIndex);
    assert.ok(successIndex > activationIndex, 'reinstall success must follow readiness and exact leased activation');
    assert.doesNotMatch(reinstall, /routing update\/router start failed/);
    assert.match(reinstall, /catch \(e\) \{[\s\S]*?throw e;/);
});

test('sandbox ownership checks use exact runtime keys rather than short agent names', () => {
    assert.match(cliSource, /probeSelectedManualRuntime\(\s*agentRuntime,\s*containerName,/);
    assert.match(workspaceSource, /isSandboxRunning\(runtimeKey, \{/);
    assert.match(workspaceSource, /isSandboxRunningImpl\(existing\.key, \{/);
    assert.match(workspaceSource, /isSandboxRunningImpl\(containerName, \{/);
    assert.doesNotMatch(workspaceSource, /isBwrapProcessRunning\(containerName\);/);
    assert.match(workspaceSource, /instanceId:/);
    assert.match(workspaceSource, /enableGeneration:/);
});
