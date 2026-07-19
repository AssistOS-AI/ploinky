import test from 'node:test';
import assert from 'node:assert/strict';

import {
    reinstallAgent,
    startWorkspace,
    waitForManifestReadiness,
} from '../../cli/services/workspaceUtil.js';

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
