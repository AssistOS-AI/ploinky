import test from 'node:test';
import assert from 'node:assert/strict';

import {
    enableAgent,
    preferredHostPortForNetworkMode,
    verifyEnabledAgentStarted,
} from '../../cli/services/agents.js';
import { mergeRuntimeRoute } from '../../cli/services/routingFile.js';

test('enable agent forwards its selected explicit profile to the service launch', () => {
    assert.match(
        enableAgent.toString(),
        /ensureAgentService\([\s\S]*?profileName:\s*profileResolution\.resolvedProfileName/,
    );
});

test('enable keeps the prepared selector inactive until semantic readiness succeeds', () => {
    const source = enableAgent.toString();
    const prepare = source.indexOf('prepareAgentEnableBatch');
    const launch = source.indexOf('ensureAgentService');
    const readiness = source.indexOf('await waitForEnabledAgentReadiness');
    const activation = source.indexOf("reason: 'agent-enable-runtime-finalize'");
    assert.ok(prepare >= 0 && launch > prepare);
    assert.ok(readiness > launch);
    assert.ok(activation > readiness);
    assert.match(source, /preparationLease:\s*prepared\.preparedGeneration\?\.preparationLease/);
    assert.match(source, /preserveSelectedGeneration: true/);
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
        "Agent 'codexAgent' started successfully in container 'ploinky_codexAgent_test'."
    ]);
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

test('verifyEnabledAgentStarted fails clearly when startup returns no container', () => {
    assert.throws(() => verifyEnabledAgentStarted('codexAgent', '', {
        isRunning: () => true,
        waitRunning: () => true,
        log: () => {}
    }), /enable agent: failed to start 'codexAgent': no container was returned/);
});
