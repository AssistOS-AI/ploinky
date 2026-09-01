import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AGENT_LIB_PATH,
    enableAgent,
    preferredHostPortForNetworkMode,
    verifyEnabledAgentStarted,
    waitForEnabledAgentReadiness,
} from '../../cli/utils/agents.js';
import { mergeRuntimeRoute } from '../../cli/server/routingFile.js';

test('enable mounts the tracked Agent runtime from the Ploinky checkout', () => {
    assert.equal(
        AGENT_LIB_PATH,
        new URL('../../Agent', import.meta.url).pathname.replace(/\/$/, ''),
    );
});

test('enable agent forwards its selected explicit profile to the service launch', () => {
    assert.match(
        enableAgent.toString(),
        /ensureAgentService\([\s\S]*?profileName:\s*profileResolution\.resolvedProfileName/,
    );
});

test('enable keeps the predecessor active until semantic readiness succeeds', () => {
    const source = enableAgent.toString();
    const prepare = source.indexOf('prepareAgentEnableBatch');
    const launch = source.indexOf('ensureAgentService');
    const readiness = source.indexOf('await waitForEnabledAgentReadiness');
    const activation = source.indexOf('commitAdditiveEdgeRoutingGeneration');
    assert.ok(prepare >= 0 && launch > prepare);
    assert.ok(readiness > launch);
    assert.ok(activation > readiness);
    assert.match(source, /preparationLease:\s*prepared\.preparedGeneration\?\.preparationLease/);
    assert.doesNotMatch(source, /inactivateEdgeRoutingGeneration/);
});

test('enable transition to none neither prefers nor retains the old routed host port', () => {
    const existing = { container: 'old', hostPort: 32001, serviceTargets: { '9000': 32002 } };
    assert.equal(preferredHostPortForNetworkMode(existing, 'none'), undefined);
    assert.deepEqual(mergeRuntimeRoute(existing, { container: 'new' }), { container: 'new' });
    const source = enableAgent.toString();
    assert.match(source, /preferredHostPort,/);
    assert.match(source, /prepareAgentEnableBatch/);
    assert.match(source, /profileResolution\.network\.mode === 'none'/);
    assert.match(source, /mergeRuntimeRoute/);
});

test('verifyEnabledAgentStarted logs when the enabled agent container is running', () => {
    const logs = [];

    assert.doesNotThrow(() => verifyEnabledAgentStarted('codexAgent', 'ploinky_codexAgent_test', {
        isRunning: () => true,
        waitRunning: () => false,
        log: (message) => logs.push(message)
    }));

    assert.deepEqual(logs, [
        "Agent 'codexAgent' started successfully with container runtime 'ploinky_codexAgent_test'."
    ]);
});

test('verifyEnabledAgentStarted checks the sandbox PID for a bwrap agent', () => {
    const logs = [];

    assert.doesNotThrow(() => verifyEnabledAgentStarted('opencodeAgent', 'ploinky_opencodeAgent_test', {
        runtime: 'bwrap',
        isRunning: () => assert.fail('container status must not be checked for bwrap'),
        waitRunning: () => assert.fail('container startup must not be awaited for bwrap'),
        isSandboxRunning: (runtimeInstanceName) => {
            assert.equal(runtimeInstanceName, 'ploinky_opencodeAgent_test');
            return true;
        },
        log: (message) => logs.push(message)
    }));

    assert.deepEqual(logs, [
        "Agent 'opencodeAgent' started successfully with bwrap runtime 'ploinky_opencodeAgent_test'."
    ]);
});

test('verifyEnabledAgentStarted reports a bwrap process that exits during startup', () => {
    assert.throws(() => verifyEnabledAgentStarted('opencodeAgent', 'ploinky_opencodeAgent_test', {
        runtime: 'bwrap',
        isSandboxRunning: () => false,
        log: () => {}
    }), /enable agent: failed to start 'opencodeAgent': bwrap process 'opencodeAgent' exited during startup/);
});

test('verifyEnabledAgentStarted checks the shared sandbox PID tracker for seatbelt', () => {
    let checkedRuntime = '';

    assert.doesNotThrow(() => verifyEnabledAgentStarted('piAgent', 'ploinky_piAgent_test', {
        runtime: 'seatbelt',
        isRunning: () => assert.fail('container status must not be checked for seatbelt'),
        waitRunning: () => assert.fail('container startup must not be awaited for seatbelt'),
        isSandboxRunning: (runtimeInstanceName) => {
            checkedRuntime = runtimeInstanceName;
            return true;
        },
        log: () => {}
    }));

    assert.equal(checkedRuntime, 'ploinky_piAgent_test');
});

test('verifyEnabledAgentStarted waits briefly before failing a non-running container', () => {
    let waitCalls = 0;
    let waitAttempts = 0;
    let waitDelayMs = 0;

    assert.throws(() => verifyEnabledAgentStarted('codexAgent', 'ploinky_codexAgent_test', {
        isRunning: () => false,
        waitRunning: (_containerName, attempts, delayMs) => {
            waitCalls += 1;
            waitAttempts = attempts;
            waitDelayMs = delayMs;
            return false;
        },
        log: () => {}
    }), /enable agent: failed to start 'codexAgent': container 'ploinky_codexAgent_test' exited during startup/);

    assert.equal(waitCalls, 1);
    assert.equal(waitAttempts, 40);
    assert.equal(waitDelayMs, 250);
});

test('verifyEnabledAgentStarted fails clearly when startup returns no runtime instance', () => {
    assert.throws(() => verifyEnabledAgentStarted('codexAgent', '', {
        isRunning: () => true,
        waitRunning: () => true,
        log: () => {}
    }), /enable agent: failed to start 'codexAgent': no runtime instance was returned/);
});

test('enabled agent readiness stops immediately when the exact container exits', async () => {
    const exactContainerId = 'a'.repeat(64);
    let observedTarget = '';
    let readinessOptions = null;

    await assert.rejects(
        waitForEnabledAgentReadiness('searchAgent', {
            readiness: { protocol: 'mcp', port: 7000, timeoutSeconds: 180 },
        }, {
            containerName: 'ploinky_proxies_searchAgent_workspace_deadbeef',
            containerId: exactContainerId,
            registryRecord: {
                runtime: 'podman',
                containerId: exactContainerId,
                instanceId: 'instance-1',
                enableGeneration: 'generation-1',
                repoName: 'proxies',
                agentName: 'searchAgent',
            },
        }, {
            containerWaitRunning: (target, attempts, delayMs, options) => {
                observedTarget = target;
                assert.equal(attempts, 1);
                assert.equal(delayMs, 1);
                assert.equal(options.runtime, 'podman');
                assert.equal(options.throwOnControlPlaneTimeout, true);
                return false;
            },
            waitUntilReady: async (_route, options) => {
                readinessOptions = options;
                return options.beforeProbe();
            },
        }),
        /podman runtime 'ploinky_proxies_searchAgent_workspace_deadbeef' exited before readiness protocol 'mcp' succeeded/,
    );

    assert.equal(observedTarget, exactContainerId);
    assert.equal(typeof readinessOptions.beforeProbe, 'function');
    assert.equal(readinessOptions.timeoutMs, 180000);
});

test('enabled agent readiness tolerates an inconclusive runtime control-plane timeout', async () => {
    const timeout = Object.assign(new Error('inspect timed out'), { code: 'ETIMEDOUT' });
    let probes = 0;

    await assert.doesNotReject(waitForEnabledAgentReadiness('searchAgent', {
        readiness: { protocol: 'mcp', port: 7000 },
    }, {
        containerName: 'search-agent',
        containerId: 'b'.repeat(64),
        registryRecord: {
            runtime: 'podman',
            containerId: 'b'.repeat(64),
            instanceId: 'instance-2',
            enableGeneration: 'generation-2',
            repoName: 'proxies',
            agentName: 'searchAgent',
        },
    }, {
        containerWaitRunning: () => {
            throw timeout;
        },
        waitUntilReady: async (_route, options) => {
            probes += 1;
            assert.equal(options.beforeProbe(), true);
            return true;
        },
    }));

    assert.equal(probes, 1);
});
