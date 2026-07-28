import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyEnabledAgentStarted } from '../../cli/utils/agents.js';

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
        isSandboxRunning: (agentName) => {
            assert.equal(agentName, 'opencodeAgent');
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
    let checkedAgent = '';

    assert.doesNotThrow(() => verifyEnabledAgentStarted('piAgent', 'ploinky_piAgent_test', {
        runtime: 'seatbelt',
        isRunning: () => assert.fail('container status must not be checked for seatbelt'),
        waitRunning: () => assert.fail('container startup must not be awaited for seatbelt'),
        isSandboxRunning: (agentName) => {
            checkedAgent = agentName;
            return true;
        },
        log: () => {}
    }));

    assert.equal(checkedAgent, 'piAgent');
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

test('verifyEnabledAgentStarted fails clearly when startup returns no runtime instance', () => {
    assert.throws(() => verifyEnabledAgentStarted('codexAgent', '', {
        isRunning: () => true,
        waitRunning: () => true,
        log: () => {}
    }), /enable agent: failed to start 'codexAgent': no runtime instance was returned/);
});
