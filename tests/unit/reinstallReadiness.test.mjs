import test from 'node:test';
import assert from 'node:assert/strict';

import {
    reinstallAgent,
    startWorkspace,
    waitForManifestReadiness,
} from '../../cli/commands/workspaceUtil.js';

function scriptManifest() {
    return {
        start: 'postgres',
        health: {
            readiness: {
                script: 'healthcheck.sh',
                failureThreshold: 1,
            },
        },
    };
}

test('reinstall readiness accepts hostPort zero when the recreated container script succeeds', async () => {
    const calls = [];
    await waitForManifestReadiness({
        key: 'reinstall-database',
        label: 'database',
        kind: 'reinstall',
        manifest: scriptManifest(),
        route: { container: 'database-recreated', hostPort: 0 },
    }, {
        runContainerScriptReadinessImpl(agentName, containerName, probe) {
            calls.push({ agentName, containerName, probe });
            return { status: 'success', detail: 'ready' };
        },
    });

    assert.deepEqual(calls.map(({ agentName, containerName, probe }) => ({
        agentName,
        containerName,
        script: probe.script,
    })), [{
        agentName: 'database',
        containerName: 'database-recreated',
        script: 'healthcheck.sh',
    }]);
});

test('reinstall readiness fails when the recreated container script exhausts its threshold', async () => {
    await assert.rejects(waitForManifestReadiness({
        key: 'reinstall-database',
        label: 'database',
        kind: 'reinstall',
        manifest: scriptManifest(),
        route: { container: 'database-recreated', hostPort: 0 },
    }, {
        runContainerScriptReadinessImpl() {
            return { status: 'failed', reason: 'exit 2', detail: 'database unavailable' };
        },
    }), (error) => (
        error?.code === 'PLOINKY_READINESS_FAILED'
        && /database.*exit 2.*database unavailable/i.test(error.message)
    ));
});

test('reinstall readiness retains MCP and TCP host-port dispatch', async () => {
    const calls = [];
    for (const protocol of ['mcp', 'tcp']) {
        await waitForManifestReadiness({
            key: `reinstall-${protocol}`,
            label: protocol,
            kind: 'reinstall',
            manifest: { readiness: { protocol } },
            route: { container: `${protocol}-container`, hostPort: 31000 },
        }, {
            waitForAgentReadyImpl(route, options) {
                calls.push({ route, protocol: options.protocol });
                return true;
            },
        });
    }

    assert.deepEqual(calls, [
        { route: { container: 'mcp-container', hostPort: 31000 }, protocol: 'mcp' },
        { route: { container: 'tcp-container', hostPort: 31000 }, protocol: 'tcp' },
    ]);
});

test('reinstall MCP readiness can succeed after the former 15 second fallback', async () => {
    const observedElapsedMs = 15001;
    let observedOptions = null;

    await waitForManifestReadiness({
        key: 'restart-roboteam',
        label: 'roboTeamAgent',
        kind: 'reinstall',
        manifest: {
            readiness: {
                protocol: 'mcp',
                timeoutSeconds: 45,
            },
        },
        route: { container: 'roboteam-successor', hostPort: 31000 },
    }, {
        waitForAgentReadyImpl(_route, options) {
            observedOptions = options;
            return observedElapsedMs < options.timeoutMs;
        },
    });

    assert.equal(observedOptions.timeoutMs, 45000);
    assert.equal(observedOptions.protocol, 'mcp');
});

test('manual targeted restart constructs relay-aware readiness before commit', async () => {
    const source = await import('node:fs').then(({ readFileSync }) => readFileSync(
        new URL('../../cli/commands/cli.js', import.meta.url),
        'utf8',
    ));
    const targetedStart = source.indexOf('const transition = await prepareTargetedAgentRestart');
    const readiness = source.indexOf('await waitForManifestReadiness({', targetedStart);
    const relayRoute = source.indexOf('route: buildRelayReadinessRoute({', readiness);
    const commit = source.indexOf('await commitTargetedAgentRestart({', relayRoute);

    assert.ok(targetedStart >= 0, 'targeted restart transition must exist');
    assert.ok(readiness > targetedStart, 'targeted restart must wait for readiness');
    assert.ok(relayRoute > readiness, 'targeted restart must use the relay-aware readiness route');
    assert.ok(commit > relayRoute, 'targeted restart commits only after relay-aware readiness');
});

test('reinstall and workspace restart paths both use the shared blocking readiness dispatcher', () => {
    const reinstallSource = reinstallAgent.toString();
    const readiness = reinstallSource.indexOf('await waitForManifestReadiness');
    const activation = reinstallSource.indexOf('await activatePreparedRuntimeAfterReadiness', readiness);
    const success = reinstallSource.indexOf('console.log(`[reinstall] reinstalled', activation);

    assert.ok(readiness >= 0, 'reinstall must wait for manifest readiness');
    assert.ok(activation > readiness, 'prepared activation must follow successful readiness');
    assert.ok(success > activation, 'success must be logged only after generation activation');
    assert.match(reinstallSource, /catch \(e\) \{[\s\S]*?throw e;/);
    assert.match(startWorkspace.toString(), /waitForReadinessEntries/);
});
