import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyEnabledAgentStarted } from '../../cli/services/agents.js';

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

    assert.throws(() => verifyEnabledAgentStarted('codexAgent', 'ploinky_codexAgent_test', {
        isRunning: () => false,
        waitRunning: () => {
            waitCalls += 1;
            return false;
        },
        log: () => {}
    }), /enable agent: failed to start 'codexAgent': container 'ploinky_codexAgent_test' exited during startup/);

    assert.equal(waitCalls, 1);
});

test('verifyEnabledAgentStarted fails clearly when startup returns no container', () => {
    assert.throws(() => verifyEnabledAgentStarted('codexAgent', '', {
        isRunning: () => true,
        waitRunning: () => true,
        log: () => {}
    }), /enable agent: failed to start 'codexAgent': no container was returned/);
});
