import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AGENT_LIB_PATH,
    enableAgent,
    preferredHostPortForNetworkMode,
    recoverFailedAgentEnableCandidate,
    verifyEnabledAgentStarted,
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

test('enable agent holds the canonical workspace mutation lease through prepare, readiness, and commit', () => {
    const source = enableAgent.toString();
    const lease = source.indexOf("withWorkspaceMutationLease({ operation: 'agent-enable' }");
    const prepare = source.indexOf('prepareAgentEnableBatch');
    const readiness = source.indexOf('await waitForEnabledAgentReadiness');
    const commit = source.indexOf('commitAdditiveEdgeRoutingGeneration');
    assert.ok(lease >= 0);
    assert.ok(prepare > lease);
    assert.ok(readiness > prepare);
    assert.ok(commit > readiness);
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

test('enable-agent failure recovery aborts before exact candidate cleanup', () => {
    const preparationLease = Object.freeze({ transactionId: 'enable-recovery-order' });
    const candidate = Object.freeze({
        containerName: 'enable-candidate',
        preparationLease,
        cleanupReceipt: Object.freeze({ operationId: 'enable-cleanup' }),
    });
    const events = [];

    recoverFailedAgentEnableCandidate(candidate, preparationLease, new Error('launch failed'), {
        abortPreparation(lease, options) {
            assert.equal(lease, preparationLease);
            assert.deepEqual(options, { reason: 'agent-enable-start-failed' });
            events.push('abort');
        },
        cleanupCandidate(received) {
            assert.notEqual(received, candidate);
            assert.equal(received.preparationAbortedBeforeCleanup, true);
            assert.equal(received.preparationAbortFailed, false);
            assert.equal(Object.isFrozen(received), true);
            events.push('cleanup');
        },
    });

    assert.deepEqual(events, ['abort', 'cleanup']);
});

test('enable-agent cleanup failure re-entry never aborts the retired preparation twice', () => {
    const preparationLease = Object.freeze({ transactionId: 'enable-cleanup-replay' });
    const candidate = Object.freeze({
        containerName: 'enable-cleanup-replay-candidate',
        preparationLease,
        cleanupReceipt: Object.freeze({ operationId: 'enable-cleanup-replay-receipt' }),
    });
    const originalFailure = new Error('launch failed');
    let abortCalls = 0;
    let cleanupCalls = 0;
    const options = {
        abortPreparation() { abortCalls += 1; },
        cleanupCandidate(received) {
            cleanupCalls += 1;
            assert.equal(received.preparationAbortedBeforeCleanup, true);
            assert.equal(received.preparationAbortFailed, false);
            throw new Error('exact cleanup failed');
        },
    };

    recoverFailedAgentEnableCandidate(candidate, preparationLease, originalFailure, options);
    recoverFailedAgentEnableCandidate(
        originalFailure.ploinkyRestartCandidate,
        preparationLease,
        originalFailure,
        options,
    );

    assert.equal(abortCalls, 1);
    assert.equal(cleanupCalls, 2);
    assert.equal(originalFailure.ploinkyRestartCandidate.preparationAbortedBeforeCleanup, true);
});

test('enable-agent successful recovery replay neither aborts nor cleans the exact candidate twice', () => {
    const preparationLease = Object.freeze({ transactionId: 'enable-successful-replay' });
    const candidate = Object.freeze({
        containerName: 'enable-successful-replay-candidate',
        preparationLease,
        cleanupReceipt: Object.freeze({ operationId: 'enable-successful-replay-cleanup' }),
    });
    const originalFailure = new Error('launch failed');
    let abortCalls = 0;
    let cleanupCalls = 0;
    const options = {
        abortPreparation() { abortCalls += 1; },
        cleanupCandidate() { cleanupCalls += 1; },
    };

    recoverFailedAgentEnableCandidate(candidate, preparationLease, originalFailure, options);
    recoverFailedAgentEnableCandidate(candidate, preparationLease, originalFailure, options);

    assert.equal(abortCalls, 1);
    assert.equal(cleanupCalls, 1);
    assert.equal(originalFailure.ploinkyRestartCandidate.preparationAbortedBeforeCleanup, true);
    assert.equal(originalFailure.ploinkyRestartCandidate.exactCleanupPerformed, true);
    assert.equal(Object.isFrozen(originalFailure.ploinkyRestartCandidate), true);
});

test('enable-agent abort failure preserves candidate and propagates recovery code', () => {
    const preparationLease = Object.freeze({ transactionId: 'enable-abort-failure' });
    const candidate = Object.freeze({
        containerName: 'preserved-enable-candidate',
        preparationLease,
        cleanupReceipt: Object.freeze({ operationId: 'preserved-enable-cleanup' }),
    });
    const originalFailure = new Error('launch failed');
    const abortFailure = new Error('durable abort failed');
    let cleanupCalls = 0;

    assert.throws(() => recoverFailedAgentEnableCandidate(
        candidate,
        preparationLease,
        originalFailure,
        {
            abortPreparation() { throw abortFailure; },
            cleanupCandidate() { cleanupCalls += 1; },
        },
    ), (error) => (
        error?.code === 'PLOINKY_RECOVERY_ABORT_FAILED'
        && error.cause === abortFailure
        && error.originalFailure === originalFailure
        && error.ploinkyRestartCandidate?.containerName === candidate.containerName
        && error.ploinkyRestartCandidate?.preparationAbortFailed === true
    ));

    assert.equal(cleanupCalls, 0);
});

test('batch-prepare recovery surfaces an outstanding lease abort failure without runtime cleanup', () => {
    const preparationLease = Object.freeze({ transactionId: 'batch-prepare-abort-failure' });
    const originalFailure = new Error('generation candidate rejected');
    const abortFailure = new Error('selector abort fsync failed');
    let cleanupCalls = 0;

    assert.throws(() => recoverFailedAgentEnableCandidate(
        null,
        preparationLease,
        originalFailure,
        {
            reason: 'agent-enable-batch-prepare-failed',
            operation: 'prepare-agent-enable-batch recovery',
            abortPreparation(lease, options) {
                assert.equal(lease, preparationLease);
                assert.deepEqual(options, { reason: 'agent-enable-batch-prepare-failed' });
                throw abortFailure;
            },
            cleanupCandidate() { cleanupCalls += 1; },
        },
    ), (error) => (
        error?.code === 'PLOINKY_RECOVERY_ABORT_FAILED'
        && error.cause === abortFailure
        && error.originalFailure === originalFailure
        && /prepare-agent-enable-batch recovery/.test(error.message)
    ));

    assert.equal(cleanupCalls, 0);
});

test('enable recovery never retries an already surfaced preparation-abort failure', () => {
    const recoveryFailure = new Error('enable preparation abort already failed');
    recoveryFailure.code = 'PLOINKY_RECOVERY_ABORT_FAILED';
    let abortCalls = 0;
    let cleanupCalls = 0;

    assert.throws(() => recoverFailedAgentEnableCandidate({
        containerName: 'preserved-enable-candidate',
        preparationLease: Object.freeze({ transactionId: 'already-failed-enable-abort' }),
        cleanupReceipt: Object.freeze({ operationId: 'preserved-enable-cleanup' }),
    }, null, recoveryFailure, {
        abortPreparation() { abortCalls += 1; },
        cleanupCandidate() { cleanupCalls += 1; },
    }), (error) => error === recoveryFailure);
    assert.equal(abortCalls, 0);
    assert.equal(cleanupCalls, 0);
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
