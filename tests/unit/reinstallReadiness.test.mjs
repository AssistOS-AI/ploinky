import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildWorkspaceRuntimeRegistry,
    cleanupFailedPreparedRuntime,
    cleanupWorkspaceRuntimeCandidates,
    reinstallAgent,
    shouldTrackWorkspaceRuntimeCandidate,
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

test('workspace start tracks exact bwrap candidates without requiring a Docker container id', () => {
    const bwrapCandidate = {
        requiresEdgeActivation: true,
        preparationLease: Object.freeze({ preparedGeneration: 'generation-one' }),
        containerName: 'bwrap-agent',
        registryRecord: Object.freeze({
            runtime: 'bwrap',
            instanceId: 'instance-one',
            enableGeneration: 'enable-one',
        }),
        cleanupReceipt: Object.freeze({ phase: 'candidate-observed' }),
    };

    assert.equal(shouldTrackWorkspaceRuntimeCandidate(bwrapCandidate), true);
    assert.equal(shouldTrackWorkspaceRuntimeCandidate({
        ...bwrapCandidate,
        cleanupReceipt: undefined,
    }), false);
    assert.match(startWorkspace.toString(), /shouldTrackWorkspaceRuntimeCandidate\(runtimeResult\)/);

    const cleaned = [];
    const aborted = [];
    const candidates = [bwrapCandidate];
    cleanupWorkspaceRuntimeCandidates(candidates, new Error('readiness failed'), {
        abortEdgeRoutingPreparationImpl(lease) {
            aborted.push(lease);
        },
        cleanupExactAgentRuntimeCandidateImpl(candidate) {
            cleaned.push(candidate);
        },
    });
    assert.deepEqual(aborted, [bwrapCandidate.preparationLease]);
    assert.deepEqual(cleaned, [{
        ...bwrapCandidate,
        preparationAbortFailed: false,
        preparationAbortedBeforeCleanup: true,
    }]);
    assert.equal(Object.isFrozen(cleaned[0]), true);
    assert.deepEqual(candidates, []);
    assert.match(startWorkspace.toString(), /cleanupWorkspaceRuntimeCandidates\(workspaceRuntimeCandidates, e, \{/);
});

test('workspace recovery aborts one exact preparation before cleaning every tracked candidate', () => {
    const preparationLease = Object.freeze({ transactionId: 'workspace-preparation' });
    const candidates = ['one', 'two'].map((suffix) => ({
        requiresEdgeActivation: true,
        preparationLease,
        containerName: `candidate-${suffix}`,
        containerId: `id-${suffix}`,
        registryRecord: {
            type: 'agent',
            instanceId: `instance-${suffix}`,
            enableGeneration: `generation-${suffix}`,
        },
        cleanupReceipt: Object.freeze({ operationId: `cleanup-${suffix}` }),
    }));
    const events = [];

    cleanupWorkspaceRuntimeCandidates(candidates, new Error('workspace launch failed'), {
        preparationLease,
        abortEdgeRoutingPreparationImpl(lease, options) {
            assert.equal(lease, preparationLease);
            assert.deepEqual(options, { reason: 'workspace-start-failed' });
            events.push('abort');
        },
        cleanupExactAgentRuntimeCandidateImpl(candidate) {
            events.push(`cleanup:${candidate.containerName}`);
        },
    });

    assert.deepEqual(events, ['abort', 'cleanup:candidate-two', 'cleanup:candidate-one']);
    assert.deepEqual(candidates, []);
});

test('workspace recovery derives and aborts every candidate preparation before any cleanup', () => {
    const events = [];
    const firstLease = Object.freeze({ transactionId: 'workspace-derived-first' });
    const secondLease = Object.freeze({ transactionId: 'workspace-derived-second' });
    const candidate = (containerName, preparationLease) => ({
        requiresEdgeActivation: true,
        preparationLease,
        containerName,
        registryRecord: {
            type: 'agent',
            instanceId: `${containerName}-instance`,
            enableGeneration: `${containerName}-generation`,
        },
        cleanupReceipt: Object.freeze({ operationId: `${containerName}-cleanup` }),
    });
    const candidates = [
        candidate('derived-first', firstLease),
        candidate('derived-second', secondLease),
    ];

    cleanupWorkspaceRuntimeCandidates(candidates, new Error('workspace failed'), {
        abortEdgeRoutingPreparationImpl(lease) {
            events.push(`abort:${lease.transactionId}`);
        },
        cleanupExactAgentRuntimeCandidateImpl(runtimeCandidate) {
            events.push(`cleanup:${runtimeCandidate.containerName}`);
        },
    });

    assert.deepEqual(events, [
        'abort:workspace-derived-first',
        'abort:workspace-derived-second',
        'cleanup:derived-second',
        'cleanup:derived-first',
    ]);
    assert.deepEqual(candidates, []);
});

test('workspace successful recovery replay neither aborts nor cleans exact candidates twice', () => {
    const preparationLease = Object.freeze({ transactionId: 'workspace-successful-replay' });
    const candidate = Object.freeze({
        requiresEdgeActivation: true,
        preparationLease,
        containerName: 'workspace-successful-replay-candidate',
        containerId: 'workspace-successful-replay-id',
        registryRecord: Object.freeze({
            type: 'agent',
            instanceId: 'workspace-successful-replay-instance',
            enableGeneration: 'workspace-successful-replay-generation',
        }),
        cleanupReceipt: Object.freeze({ operationId: 'workspace-successful-replay-cleanup' }),
    });
    const originalFailure = new Error('workspace launch failed');
    const events = [];
    const options = {
        preparationLease,
        abortEdgeRoutingPreparationImpl() { events.push('abort'); },
        cleanupExactAgentRuntimeCandidateImpl() { events.push('cleanup'); },
    };

    cleanupWorkspaceRuntimeCandidates([candidate], originalFailure, options);
    cleanupWorkspaceRuntimeCandidates([candidate], originalFailure, options);

    assert.deepEqual(events, ['abort', 'cleanup']);
    assert.equal(originalFailure.ploinkyRestartCandidate.preparationAbortedBeforeCleanup, true);
    assert.equal(originalFailure.ploinkyRestartCandidate.exactCleanupPerformed, true);
    assert.equal(Object.isFrozen(originalFailure.ploinkyRestartCandidate), true);
});

test('workspace recovery preserves all candidates and propagates when exact abort fails', () => {
    const preparationLease = Object.freeze({ transactionId: 'workspace-abort-failure' });
    const candidate = {
        requiresEdgeActivation: true,
        preparationLease,
        containerName: 'preserved-workspace-candidate',
        registryRecord: {
            type: 'agent',
            instanceId: 'preserved-instance',
            enableGeneration: 'preserved-generation',
        },
        cleanupReceipt: Object.freeze({ operationId: 'preserved-cleanup' }),
    };
    const candidates = [candidate];
    const originalFailure = new Error('workspace launch failed');
    const abortFailure = new Error('durable abort write failed');
    let cleanupCalls = 0;

    assert.throws(() => cleanupWorkspaceRuntimeCandidates(candidates, originalFailure, {
        preparationLease,
        abortEdgeRoutingPreparationImpl() { throw abortFailure; },
        cleanupExactAgentRuntimeCandidateImpl() { cleanupCalls += 1; },
    }), (error) => (
        error?.code === 'PLOINKY_RECOVERY_ABORT_FAILED'
        && error.cause === abortFailure
        && error.originalFailure === originalFailure
        && Object.isFrozen(error.ploinkyRestartCandidates)
        && error.ploinkyRestartCandidates?.length === 1
        && Object.isFrozen(error.ploinkyRestartCandidates[0])
        && error.ploinkyRestartCandidates[0].containerName === candidate.containerName
        && error.ploinkyRestartCandidates[0].preparationAbortFailed === true
        && error.ploinkyRestartCandidate === error.ploinkyRestartCandidates[0]
    ));

    assert.equal(cleanupCalls, 0);
    assert.deepEqual(candidates, [candidate]);
});

test('workspace recovery records cleanup errors only after successful abort', () => {
    const preparationLease = Object.freeze({ transactionId: 'workspace-cleanup-failure' });
    const candidate = {
        requiresEdgeActivation: true,
        preparationLease,
        containerName: 'cleanup-failing-candidate',
        registryRecord: {
            type: 'agent',
            instanceId: 'cleanup-instance',
            enableGeneration: 'cleanup-generation',
        },
        cleanupReceipt: Object.freeze({ operationId: 'cleanup-failure-receipt' }),
    };
    const originalFailure = new Error('workspace launch failed');
    const events = [];

    cleanupWorkspaceRuntimeCandidates([candidate], originalFailure, {
        preparationLease,
        abortEdgeRoutingPreparationImpl() { events.push('abort'); },
        cleanupExactAgentRuntimeCandidateImpl(received) {
            events.push('cleanup');
            assert.equal(received.preparationAbortedBeforeCleanup, true);
            assert.equal(received.preparationAbortFailed, false);
            assert.equal(Object.isFrozen(received), true);
            throw new Error('injected exact cleanup failure');
        },
    });

    assert.deepEqual(events, ['abort', 'cleanup']);
    assert.match(originalFailure.message, /exact workspace candidate cleanup: injected exact cleanup failure/);
    cleanupFailedPreparedRuntime(null, originalFailure, 'workspace-cleanup-replay', {
        abortEdgeRoutingPreparationImpl() { events.push('abort-replay'); },
        cleanupExactAgentRuntimeCandidateImpl(received) {
            events.push('cleanup-replay');
            assert.equal(received.preparationAbortedBeforeCleanup, true);
            throw new Error('cleanup replay still failed');
        },
    });
    assert.deepEqual(events, ['abort', 'cleanup', 'cleanup-replay']);
});

test('workspace recovery never retries a surfaced preparation-abort failure', () => {
    const recoveryFailure = new Error('workspace preparation abort already failed');
    recoveryFailure.code = 'PLOINKY_RECOVERY_ABORT_FAILED';
    let abortCalls = 0;
    let cleanupCalls = 0;
    const candidates = [{
        requiresEdgeActivation: true,
        preparationLease: Object.freeze({ transactionId: 'already-failed-workspace-abort' }),
        containerName: 'preserved-workspace-candidate',
        registryRecord: {
            type: 'agent',
            instanceId: 'preserved-workspace-instance',
            enableGeneration: 'preserved-workspace-generation',
        },
        cleanupReceipt: Object.freeze({ operationId: 'preserved-workspace-cleanup' }),
    }, {
        requiresEdgeActivation: true,
        preparationLease: Object.freeze({ transactionId: 'second-failed-workspace-abort' }),
        containerName: 'second-preserved-workspace-candidate',
        registryRecord: {
            type: 'agent',
            instanceId: 'second-preserved-workspace-instance',
            enableGeneration: 'second-preserved-workspace-generation',
        },
        cleanupReceipt: Object.freeze({ operationId: 'second-preserved-workspace-cleanup' }),
    }];
    const latestCandidate = Object.freeze({
        requiresEdgeActivation: true,
        preparationLease: Object.freeze({ transactionId: 'latest-failed-workspace-abort' }),
        containerName: 'latest-preserved-workspace-candidate',
        registryRecord: Object.freeze({
            type: 'agent',
            instanceId: 'latest-preserved-workspace-instance',
            enableGeneration: 'latest-preserved-workspace-generation',
        }),
        cleanupReceipt: Object.freeze({ operationId: 'latest-preserved-workspace-cleanup' }),
        preparationAbortFailed: true,
        preparationAbortedBeforeCleanup: false,
    });
    Object.defineProperty(recoveryFailure, 'ploinkyRestartCandidate', {
        configurable: true,
        enumerable: false,
        writable: false,
        value: latestCandidate,
    });

    assert.throws(() => cleanupWorkspaceRuntimeCandidates(candidates, recoveryFailure, {
        abortEdgeRoutingPreparationImpl() { abortCalls += 1; },
        cleanupExactAgentRuntimeCandidateImpl() { cleanupCalls += 1; },
    }), (error) => error === recoveryFailure);
    assert.equal(abortCalls, 0);
    assert.equal(cleanupCalls, 0);
    assert.equal(candidates.length, 2);
    assert.equal(Object.isFrozen(recoveryFailure.ploinkyRestartCandidates), true);
    assert.deepEqual(
        recoveryFailure.ploinkyRestartCandidates.map((candidate) => candidate.containerName).sort(),
        [
            'latest-preserved-workspace-candidate',
            'preserved-workspace-candidate',
            'second-preserved-workspace-candidate',
        ],
    );
    assert.equal(
        recoveryFailure.ploinkyRestartCandidate.containerName,
        'latest-preserved-workspace-candidate',
    );
});

test('failed launch recovery aborts before cleaning the exact immutable candidate attached to the error', () => {
    const preparationLease = Object.freeze({
        transactionId: 'failed-launch-transaction',
        preparedGeneration: 'failed-launch-generation',
    });
    const candidate = Object.freeze({
        containerName: 'failed-launch-agent',
        registryRecord: Object.freeze({
            type: 'agent',
            runtime: 'container',
            instanceId: 'failed-launch-instance',
            enableGeneration: 'failed-launch-enable-generation',
        }),
        cleanupReceipt: Object.freeze({ operationId: 'failed-launch-cleanup' }),
        preparationLease,
    });
    const launchError = new Error('launch failed before returning a result');
    Object.defineProperty(launchError, 'ploinkyRestartCandidate', {
        configurable: true,
        enumerable: false,
        writable: false,
        value: candidate,
    });
    const calls = [];

    cleanupFailedPreparedRuntime(null, launchError, 'test-failed-launch', {
        cleanupExactAgentRuntimeCandidateImpl(receivedCandidate) {
            calls.push({ operation: 'cleanup', candidate: receivedCandidate });
        },
        abortEdgeRoutingPreparationImpl(receivedLease, options) {
            calls.push({ operation: 'abort', lease: receivedLease, options });
        },
    });

    assert.deepEqual(calls, [
        {
            operation: 'abort',
            lease: preparationLease,
            options: { reason: 'test-failed-launch' },
        },
        {
            operation: 'cleanup',
            candidate: {
                ...candidate,
                preparationAbortFailed: false,
                preparationAbortedBeforeCleanup: true,
            },
        },
    ]);
    assert.equal(Object.isFrozen(calls[1].candidate), true);
});

test('failed launch recovery preserves the immutable candidate when exact preparation abort fails', () => {
    const preparationLease = Object.freeze({
        transactionId: 'failed-abort-transaction',
        preparedGeneration: 'failed-abort-generation',
    });
    const candidate = Object.freeze({
        containerName: 'preserved-failed-agent',
        registryRecord: Object.freeze({
            type: 'agent',
            runtime: 'container',
            instanceId: 'preserved-instance',
            enableGeneration: 'preserved-enable-generation',
        }),
        cleanupReceipt: Object.freeze({ operationId: 'preserved-cleanup' }),
        preparationLease,
    });
    const launchError = new Error('launch failed');
    const abortFailure = new Error('abort write failed');
    let cleanupCalls = 0;

    assert.throws(() => cleanupFailedPreparedRuntime(
        candidate,
        launchError,
        'test-abort-failed',
        {
            abortEdgeRoutingPreparationImpl(receivedLease, options) {
                assert.equal(receivedLease, preparationLease);
                assert.deepEqual(options, { reason: 'test-abort-failed' });
                throw abortFailure;
            },
            cleanupExactAgentRuntimeCandidateImpl() {
                cleanupCalls += 1;
            },
        },
    ), (error) => (
        error?.code === 'PLOINKY_RECOVERY_ABORT_FAILED'
        && error.cause === abortFailure
        && error.originalFailure === launchError
        && Object.isFrozen(error.ploinkyRestartCandidate)
        && error.ploinkyRestartCandidate?.containerName === candidate.containerName
        && error.ploinkyRestartCandidate?.preparationAbortFailed === true
        && error.ploinkyRestartCandidate?.exactCleanupPerformed === false
        && /preserving its failed runtime candidate/.test(error.message)
    ));

    assert.equal(cleanupCalls, 0);
});

test('workspace runtime registry preserves the newly persisted saved-start configuration', () => {
    const stalePreflightRegistry = {
        existing_agent: { agentName: 'existing' },
    };
    const currentConfig = {
        static: { agent: 'testAgent', port: 8080 },
    };

    const runtimeRegistry = buildWorkspaceRuntimeRegistry(stalePreflightRegistry, currentConfig);
    assert.deepEqual(runtimeRegistry, {
        ...stalePreflightRegistry,
        _config: currentConfig,
    });
    assert.notEqual(runtimeRegistry._config, currentConfig);
    assert.match(
        startWorkspace.toString(),
        /buildWorkspaceRuntimeRegistry\(lockedStart\.registry, cfg0\)/,
    );
});
