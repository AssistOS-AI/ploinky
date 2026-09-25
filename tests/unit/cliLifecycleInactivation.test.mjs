import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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

function sliceBetween(source, startLabel, endLabel) {
    const start = source.indexOf(startLabel);
    const end = source.indexOf(endLabel, start);
    assert.ok(start >= 0 && end > start, `expected a block from '${startLabel}' to '${endLabel}'`);
    return source.slice(start, end);
}

test('whole-workspace and Router lifecycle commands inactivate edge authorization before stopping processes', () => {
    assertOrdered(cliSource, [
        "inactivateEdgeRoutingGeneration('cli-router-restart')",
        'killRouterIfRunning();',
    ]);
    assertOrdered(cliSource, [
        "inactivateEdgeRoutingGeneration('cli-workspace-restart')",
        'killRouterIfRunning();',
        'const list = stopConfiguredAgents();',
        'await startWorkspace(',
    ]);
    assertOrdered(cliSource, [
        "inactivateEdgeRoutingGeneration('cli-workspace-shutdown')",
        'killRouterIfRunning();',
        'const list = destroyWorkspaceContainers();',
    ]);
    assertOrdered(cliSource, [
        'retireAbandonedStartPreparationBeforeStop();',
        "inactivateEdgeRoutingGenerationForStop('cli-workspace-stop')",
        'killRouterIfRunning();',
        'const list = stopConfiguredAgents();',
    ]);
    assertOrdered(cliSource, [
        "inactivateEdgeRoutingGeneration('cli-workspace-destroy')",
        'killRouterIfRunning();',
        'await destroyAll();',
    ]);
});

test('restarts settle earlier no-wait workers and a stopped start preparation before replacing its selector or stopping processes', () => {
    // The restart inactivation replaces the only selector that binds a stopped
    // start's preparation, and its stop cannot see a no-wait worker's
    // half-created runtime; either refusal must happen before any stop.
    assertOrdered(sliceBetween(cliSource, "'restart router: start is not configured", "'[restart] RoutingServer restarted.'"), [
        'await settleWorkspaceBeforeRestart();',
        "inactivateEdgeRoutingGeneration('cli-router-restart')",
        'killRouterIfRunning();',
        'await startWorkspace(',
    ]);
    assertOrdered(sliceBetween(cliSource, "'restart: start is not configured", "'[restart] Done.'"), [
        'await settleWorkspaceBeforeRestart();',
        "inactivateEdgeRoutingGeneration('cli-workspace-restart')",
        'killRouterIfRunning();',
        'const list = stopConfiguredAgents();',
        'await startWorkspace(',
    ]);
    assertOrdered(sliceBetween(workspaceSource, 'async function settleWorkspaceBeforeRestart(', '\n}\n'), [
        "await acquireSettledWorkspaceMutationLease({ operation: 'workspace-restart' })",
        'runWithWorkspaceMutationLease(workspaceMutationLease',
        'withNetworkLifecycleLockReclaimingStoppedOwner(',
        'retireAbandonedWorkspaceStartPreparation({',
        'releaseWorkspaceMutationLease(workspaceMutationLease)',
    ]);
});

test('stop retires a stopped start preparation only before its own selector rewrite and never waits on a live owner', () => {
    const stopBlock = sliceBetween(cliSource, "case 'stop': {", "case 'destroy':");
    assertOrdered(stopBlock, [
        'retireAbandonedStartPreparationBeforeStop();',
        "inactivateEdgeRoutingGenerationForStop('cli-workspace-stop')",
    ]);
    assert.doesNotMatch(stopBlock, /await retireAbandonedStartPreparationBeforeStop/,
        'the stop retirement is synchronous and has no outcome that can refuse the stop');
    const helper = sliceBetween(workspaceSource, 'function retireAbandonedStartPreparationBeforeStop(', '\n}\n');
    assertOrdered(helper, [
        "createWorkspaceMutationLease({ operation: 'workspace-stop' })",
        'runWithWorkspaceMutationLease(workspaceMutationLease',
        'withNetworkLifecycleLockReclaimingStoppedOwner(retire)',
    ]);
    assert.doesNotMatch(helper, /acquireWorkspaceMutationLease|withWorkspaceMutationLease/,
        'stop never waits for the workspace lease');
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
        "await acquireSettledWorkspaceMutationLease({ operation: 'workspace-start' })",
        'assertWorkspaceGraphAdmissionsCurrent(admittedStart.admissions)',
        'retireAbandonedWorkspaceStartPreparation({',
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

    const reinstallStart = workspaceSource.indexOf('async function reinstallAgent(agentName)');
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

test('managed single-agent restart drains before replacement and publishes only after readiness', () => {
    const restartStart = cliSource.indexOf('// Recreate through the managed transaction');
    const restartEnd = cliSource.indexOf("console.log('✓ Agent restarted.');", restartStart);
    const restart = cliSource.slice(restartStart, restartEnd);

    assertOrdered(restart, [
        'await prepareTargetedAgentRestart({',
        'targetedRestart: transition.targetedRestart',
        'await waitForManifestReadiness({',
        'await commitTargetedAgentRestart({',
    ]);
    assert.match(restart, /catch \(error\) \{[\s\S]*cleanupFailedTargetedAgentRestart\(result, error\)/);
    assert.doesNotMatch(restart, /activatePreparedRuntimeAfterReadiness/);
});

test('sandbox ownership checks use exact runtime keys rather than short agent names', () => {
    assert.match(cliSource, /isBwrapProcessRunning\(containerName, \{/);
    assert.match(workspaceSource, /isSandboxRunningImpl\(existing\.key, \{/);
    for (const source of [cliSource, workspaceSource]) {
        assert.match(source, /instanceId:/);
        assert.match(source, /enableGeneration:/);
    }
});
