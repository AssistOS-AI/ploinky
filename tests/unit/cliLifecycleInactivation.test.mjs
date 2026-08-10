import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const cliSource = fs.readFileSync(new URL('../../cli/commands/cli.js', import.meta.url), 'utf8');
const workspaceSource = fs.readFileSync(new URL('../../cli/commands/workspaceUtil.js', import.meta.url), 'utf8');

function read(relativePath) {
    return fs.readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

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
        "inactivateEdgeRoutingGeneration('cli-workspace-stop')",
        'killRouterIfRunning({ strict: true });',
        'const list = stopConfiguredAgents({ strict: true });',
    ]);
    assertOrdered(cliSource, [
        'await waitForNoWaitWorkersToSettle();',
        "operation: 'agentlib-source-transition-stop'",
        'assertNoLiveNoWaitWorkers();',
        'initializeFreshEdgeRoutingSources();',
        "inactivateEdgeRoutingGeneration('cli-agentlib-source-transition-stop')",
        'killRouterIfRunning({ strict: true });',
        'const removed = stopConfiguredAgents({ strict: true, remove: true });',
        'assertNoLiveNoWaitWorkers();',
    ]);
    const containerFleet = read('cli/sandbox/docker/containerFleet.js');
    assert.match(
        containerFleet,
        /strict && listRunningContainerNames\(\{ runtime \}\)\.has\(name\)/,
    );
    assert.match(
        containerFleet,
        /strict && hasInvalidBwrapPidRecord\(name\)/,
    );
    const bwrapFleet = read('cli/sandbox/bwrap/bwrapFleet.js');
    assertOrdered(bwrapFleet, [
        'terminationBlocked: orphanedGroup,',
        "process.kill(entry.pid, 'SIGKILL')",
        'if (isExactBwrapProcess(entry) || isBwrapProcessGroupAlive(entry.pid)) continue;',
        'clearBwrapPidIfExact(entry);',
    ]);
    const sessionControl = read('cli/commands/sessionControl.js');
    assertOrdered(sessionControl, [
        'portResolutionError = error;',
        'if (strict) port = INITIAL_ROUTER_PORT;',
        'const initialListenerPids = findPids();',
        "error.code = 'PLOINKY_ROUTER_PID_AUTHORITY_MISSING';",
        'if (!stopped && !portResolutionError)',
        '...findPids()',
    ]);
    assert.match(
        sessionControl,
        /strict\s*&& initialListenerPids\.length > 0\s*&& \(!persistedPidValid \|\| !isPidAlive\(persistedPid\)\)/,
    );
    assert.ok(
        sessionControl.indexOf('try { fs.unlinkSync(pidFile); }')
            > sessionControl.indexOf("error.code = 'PLOINKY_ROUTER_QUIESCENCE_FAILED';"),
        'the Watchdog PID authority must be retained until the full shutdown barrier succeeds',
    );
    assertOrdered(cliSource, [
        "inactivateEdgeRoutingGeneration('cli-workspace-destroy')",
        'killRouterIfRunning();',
        'await destroyAll();',
    ]);
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
        'createWorkspaceStartLock()',
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

test('sandbox ownership checks use exact runtime keys rather than short agent names', () => {
    assert.match(cliSource, /isBwrapProcessRunning\(containerName, \{/);
    assert.match(workspaceSource, /isSandboxRunningImpl\(existing\.key, \{/);
    assert.match(workspaceSource, /isBwrapProcessRunning\(containerName, \{/);
    for (const source of [cliSource, workspaceSource]) {
        assert.match(source, /instanceId:/);
        assert.match(source, /enableGeneration:/);
    }
});
