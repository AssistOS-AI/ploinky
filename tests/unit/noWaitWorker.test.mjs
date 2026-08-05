import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    assertNoWaitAdoptableLifecycleSnapshot,
    assertNoWaitAdoptionStillCurrent,
    assertNoWaitLifecycleRebase,
    assertNoWaitLifecycleSnapshot,
    assertNoWaitPodmanAdoptionOwnership,
    assertNoWaitRegistryRecord,
    cleanupNoWaitTaskOwnedCandidate,
    launchNoWaitHostRuntime,
    resolveNoWaitWorkerLifecycleSnapshot,
    recoverNoWaitTaskOwnedCandidate,
    waitForNoWaitLifecycle,
    waitForNoWaitReadiness,
    waitForNoWaitRouteActivation,
    waitForPriorWorker as waitForPriorWorkerRaw,
    withActiveNoWaitWorkerLifecycleLease,
    writeStatus as writeStatusRaw,
} from '../../cli/commands/noWaitWorker.js';

const STATUS_CONTAINER_ID = '9'.repeat(64);

function exactStatusIdentity(containerName, overrides = {}) {
    return {
        runtime: 'podman',
        containerName,
        instanceId: `instance-${containerName}`,
        enableGeneration: `generation-${containerName}`,
        containerId: STATUS_CONTAINER_ID,
        ...overrides,
    };
}

function exactStatus(containerName, payload = {}) {
    const waitForStatusFile = payload.waitForStatusFile;
    const predecessorName = waitForStatusFile
        ? path.basename(waitForStatusFile, '.json')
        : '';
    return {
        ...exactStatusIdentity(containerName),
        ...(predecessorName ? {
            waitForIdentity: exactStatusIdentity(predecessorName),
        } : {}),
        ...payload,
    };
}

function writeStatus(containerName, payload, options) {
    return writeStatusRaw(containerName, exactStatus(containerName, payload), options);
}

function waitForPriorWorker(statusPath, options = {}) {
    const containerName = path.basename(statusPath, '.json');
    return waitForPriorWorkerRaw(statusPath, {
        expectedIdentity: exactStatusIdentity(containerName),
        ...options,
    });
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-no-wait-worker-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runningDir = path.join(root, 'running');
    return { root, runningDir };
}

test('no-wait status replacement is atomic and leaves no temporary file', (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_worker';
    const statusDir = path.join(runningDir, 'no-wait');
    const target = path.join(statusDir, `${containerName}.json`);

    for (let sequence = 0; sequence < 50; sequence += 1) {
        writeStatus(containerName, { state: 'starting', sequence }, { runningDir });
        assert.deepEqual(
            JSON.parse(fs.readFileSync(target, 'utf8')),
            exactStatus(containerName, { state: 'starting', sequence }),
        );
        assert.deepEqual(fs.readdirSync(statusDir), [`${containerName}.json`]);
    }
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('no-wait status publication rejects missing, coerced, and mixed runtime identity', (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_identity';
    const exact = exactStatus(containerName, { state: 'starting' });
    const invalidStatuses = [
        { state: 'starting' },
        { ...exact, state: 'Starting' },
        { ...exact, runtime: ' podman' },
        { ...exact, containerName: `${containerName}-stale` },
        { ...exact, instanceId: new String(exact.instanceId) },
        { ...exact, containerId: 'short-id' },
    ];
    for (const status of invalidStatuses) {
        assert.throws(
            () => writeStatusRaw(containerName, status, { runningDir }),
            /exact no-wait status identity/,
        );
    }
    const { containerId: _unavailableContainerId, ...freshPodmanStatus } = exact;
    assert.doesNotThrow(
        () => writeStatusRaw(containerName, freshPodmanStatus, { runningDir }),
        'a fresh Podman generation has no immutable container ID before its first launch',
    );
});

test('no-wait predecessor rejects a status from a different lifecycle identity', async (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_identity_predecessor';
    const target = path.join(runningDir, 'no-wait', `${containerName}.json`);
    writeStatus(containerName, { state: 'running' }, { runningDir });

    await assert.rejects(
        () => waitForPriorWorkerRaw(target, {
            runningDir,
            expectedIdentity: exactStatusIdentity(containerName, {
                enableGeneration: 'stale-generation',
            }),
        }),
        /predecessor status identity mismatch/,
    );
});

test('no-wait predecessor permits only a fresh Podman running status to attach its immutable container ID', async (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_fresh_predecessor';
    const target = path.join(runningDir, 'no-wait', `${containerName}.json`);
    const withContainerId = exactStatusIdentity(containerName);
    const { containerId: _unavailableContainerId, ...withoutContainerId } = withContainerId;

    writeStatusRaw(containerName, { ...withoutContainerId, state: 'running' }, { runningDir });
    await assert.rejects(
        () => waitForPriorWorkerRaw(target, {
            runningDir,
            expectedIdentity: withContainerId,
        }),
        /predecessor status identity mismatch/,
    );

    writeStatusRaw(containerName, { ...withContainerId, state: 'running' }, { runningDir });
    await assert.doesNotReject(
        () => waitForPriorWorkerRaw(target, {
            runningDir,
            expectedIdentity: withoutContainerId,
        }),
    );

    writeStatusRaw(containerName, { ...withContainerId, state: 'starting' }, { runningDir });
    await assert.rejects(
        () => waitForPriorWorkerRaw(target, {
            runningDir,
            expectedIdentity: withoutContainerId,
        }),
        /predecessor status identity mismatch/,
    );
});

test('no-wait predecessor chain rejects a mixed-generation nested status', async (t) => {
    const { runningDir } = fixture(t);
    const target = path.join(runningDir, 'no-wait', 'identity-successor.json');
    writeStatus('identity-predecessor', { state: 'running' }, { runningDir });
    writeStatus('identity-successor', {
        state: 'starting',
        sequencePhase: 'waiting-predecessor',
        waitForStatusFile: 'identity-predecessor.json',
        waitForIdentity: exactStatusIdentity('identity-predecessor', {
            enableGeneration: 'foreign-generation',
        }),
    }, { runningDir });

    await assert.rejects(
        () => waitForPriorWorker(target, { runningDir }),
        /predecessor status identity mismatch/,
    );
});

test('no-wait predecessor observes a complete atomically published terminal state', async (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_predecessor';
    const target = path.join(runningDir, 'no-wait', `${containerName}.json`);
    writeStatus(containerName, {
        state: 'starting',
        sequencePhase: 'active',
        sequencePhaseStartedAtMs: Date.now(),
    }, { runningDir });
    let polls = 0;

    const status = await waitForPriorWorker(target, {
        runningDir,
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        async sleepFn() {
            polls += 1;
            writeStatus(containerName, { state: 'running' }, { runningDir });
        },
    });

    assert.equal(polls, 1);
    assert.deepEqual(status, { state: 'running' });
});

test('no-wait predecessor rejects a mixed-generation starting status without a sequence phase', async (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_legacy_predecessor';
    const target = path.join(runningDir, 'no-wait', `${containerName}.json`);
    writeStatus(containerName, { state: 'starting' }, { runningDir });

    await assert.rejects(
        () => waitForPriorWorker(target, { runningDir }),
        /missing its exact sequence phase/,
    );
});

test('no-wait predecessor returns a terminal failure without exposing its details', async (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_failed';
    const target = path.join(runningDir, 'no-wait', `${containerName}.json`);
    writeStatus(containerName, {
        state: 'failed',
        error: { message: 'sensitive worker detail' },
    }, { runningDir });

    const status = await waitForPriorWorker(target, { runningDir });

    assert.deepEqual(status, { state: 'failed' });
});

test('no-wait predecessor permits one bounded terminal-publication grace window', async (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_slow_predecessor';
    const target = path.join(runningDir, 'no-wait', `${containerName}.json`);
    writeStatus(containerName, {
        state: 'starting',
        sequencePhase: 'active',
        sequencePhaseStartedAtMs: 0,
    }, { runningDir });
    let now = 0;

    const status = await waitForPriorWorker(target, {
        runningDir,
        timeoutMs: 1_000,
        terminalPublicationGraceMs: 500,
        pollIntervalMs: 100,
        nowFn: () => now,
        async sleepFn(intervalMs) {
            now += intervalMs;
            if (now === 1_200) {
                writeStatus(containerName, { state: 'running' }, { runningDir });
            }
        },
    });

    assert.equal(now, 1_200);
    assert.deepEqual(status, { state: 'running' });
});

test('no-wait predecessor terminal-publication grace remains bounded and fail-closed', async (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_stuck_predecessor';
    const target = path.join(runningDir, 'no-wait', `${containerName}.json`);
    writeStatus(containerName, {
        state: 'starting',
        sequencePhase: 'active',
        sequencePhaseStartedAtMs: 0,
    }, { runningDir });
    let now = 0;

    await assert.rejects(
        () => waitForPriorWorker(target, {
            runningDir,
            timeoutMs: 1_000,
            terminalPublicationGraceMs: 500,
            pollIntervalMs: 100,
            nowFn: () => now,
            async sleepFn(intervalMs) {
                now += intervalMs;
            },
        }),
        /timed out waiting for no-wait predecessor status/,
    );
    assert.equal(now, 1_500);
});

test('no-wait predecessor reports failure published during the bounded grace window', async (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_late_failed_predecessor';
    const target = path.join(runningDir, 'no-wait', `${containerName}.json`);
    writeStatus(containerName, {
        state: 'starting',
        sequencePhase: 'active',
        sequencePhaseStartedAtMs: 0,
    }, { runningDir });
    let now = 0;

    const status = await waitForPriorWorker(target, {
        runningDir,
        timeoutMs: 1_000,
        terminalPublicationGraceMs: 500,
        pollIntervalMs: 100,
        nowFn: () => now,
        async sleepFn(intervalMs) {
            now += intervalMs;
            if (now === 1_100) {
                writeStatus(containerName, { state: 'failed' }, { runningDir });
            }
        },
    });

    assert.equal(now, 1_100);
    assert.deepEqual(status, { state: 'failed' });
});

test('no-wait predecessor budget follows the one active worker across a cumulative sequence', async (t) => {
    const { runningDir } = fixture(t);
    const statusDir = path.join(runningDir, 'no-wait');
    const target = path.join(statusDir, 'target.json');
    writeStatus('first', {
        state: 'starting',
        sequencePhase: 'active',
        sequencePhaseStartedAtMs: 0,
    }, { runningDir });
    writeStatus('second', {
        state: 'starting',
        sequencePhase: 'waiting-predecessor',
        waitForStatusFile: 'first.json',
    }, { runningDir });
    writeStatus('target', {
        state: 'starting',
        sequencePhase: 'waiting-predecessor',
        waitForStatusFile: 'second.json',
    }, { runningDir });
    let now = 0;

    const status = await waitForPriorWorker(target, {
        runningDir,
        timeoutMs: 1_000,
        terminalPublicationGraceMs: 500,
        pollIntervalMs: 100,
        nowFn: () => now,
        async sleepFn(intervalMs) {
            now += intervalMs;
            if (now === 900) {
                writeStatus('first', { state: 'running', finishedAtMs: now }, { runningDir });
            }
            if (now === 1_000) {
                writeStatus('second', {
                    state: 'starting',
                    sequencePhase: 'active',
                    sequencePhaseStartedAtMs: now,
                }, { runningDir });
            }
            if (now === 1_800) {
                writeStatus('second', { state: 'running', finishedAtMs: now }, { runningDir });
            }
            if (now === 1_900) {
                writeStatus('target', {
                    state: 'starting',
                    sequencePhase: 'active',
                    sequencePhaseStartedAtMs: now,
                }, { runningDir });
            }
            if (now === 2_700) {
                writeStatus('target', { state: 'running', finishedAtMs: now }, { runningDir });
            }
        },
    });

    assert.equal(now, 2_700, 'the exact active-phase deadline must not truncate valid progress');
    assert.deepEqual(status, { state: 'running' });
});

test('no-wait predecessor active phase remains independently bounded and fail-closed', async (t) => {
    const { runningDir } = fixture(t);
    const target = path.join(runningDir, 'no-wait', 'stuck-active.json');
    writeStatus('stuck-active', {
        state: 'starting',
        sequencePhase: 'active',
        sequencePhaseStartedAtMs: 0,
    }, { runningDir });
    let now = 0;

    await assert.rejects(
        () => waitForPriorWorker(target, {
            runningDir,
            timeoutMs: 1_000,
            terminalPublicationGraceMs: 500,
            pollIntervalMs: 100,
            nowFn: () => now,
            async sleepFn(intervalMs) { now += intervalMs; },
        }),
        /timed out waiting for no-wait predecessor status/,
    );
    assert.equal(now, 1_500);
});

test('no-wait predecessor chain rejects cycles instead of extending a wait', async (t) => {
    const { runningDir } = fixture(t);
    const target = path.join(runningDir, 'no-wait', 'cycle-a.json');
    writeStatus('cycle-a', {
        state: 'starting',
        sequencePhase: 'waiting-predecessor',
        waitForStatusFile: 'cycle-b.json',
    }, { runningDir });
    writeStatus('cycle-b', {
        state: 'starting',
        sequencePhase: 'waiting-predecessor',
        waitForStatusFile: 'cycle-a.json',
    }, { runningDir });

    await assert.rejects(
        () => waitForPriorWorker(target, { runningDir }),
        /status chain contains a cycle/,
    );
});

test('no-wait predecessor chain rejects traversal references', async (t) => {
    const { runningDir } = fixture(t);
    const target = path.join(runningDir, 'no-wait', 'traversal.json');
    writeStatus('traversal', {
        state: 'starting',
        sequencePhase: 'waiting-predecessor',
        waitForStatusFile: '../foreign.json',
    }, { runningDir });

    await assert.rejects(
        () => waitForPriorWorker(target, { runningDir }),
        /waiting phase has an invalid status reference/,
    );
});

test('no-wait predecessor chain rejects a stale terminal handoff', async (t) => {
    const { runningDir } = fixture(t);
    const target = path.join(runningDir, 'no-wait', 'waiting.json');
    writeStatus('finished', {
        state: 'running',
        finishedAtMs: 0,
    }, { runningDir });
    writeStatus('waiting', {
        state: 'starting',
        sequencePhase: 'waiting-predecessor',
        waitForStatusFile: 'finished.json',
    }, { runningDir });
    let now = 600;

    await assert.rejects(
        () => waitForPriorWorker(target, {
            runningDir,
            timeoutMs: 1_000,
            terminalPublicationGraceMs: 500,
            nowFn: () => now,
            async sleepFn(intervalMs) { now += intervalMs; },
        }),
        /timed out waiting for no-wait predecessor status/,
    );
    assert.equal(now, 600);
});

test('no-wait predecessor rejects a path outside the status directory', async (t) => {
    const { root, runningDir } = fixture(t);
    await assert.rejects(
        () => waitForPriorWorker(path.join(root, 'foreign.json'), { runningDir }),
        /must be an exact file/,
    );
});

test('no-wait runtime holds the workspace mutation lease through route activation', () => {
    const source = fs.readFileSync(
        path.resolve('cli/commands/noWaitWorker.js'),
        'utf8',
    );
    const acquire = source.indexOf(
        'await withActiveNoWaitWorkerLifecycleLease(expectedIdentity, async (lifecycle) => {',
    );
    const activation = source.indexOf('await upsertRoute(', acquire);
    const release = source.indexOf('\n        });\n    } catch (err)', activation);
    assert.ok(acquire > 0, 'no-wait worker must acquire the shared workspace mutation lease');
    assert.ok(activation > acquire, 'route activation must remain in the same critical section');
    assert.ok(release > activation, 'the workspace mutation callback must close only after route activation');
});

test('no-wait worker never owns the workspace lease while waiting for an active generation', async () => {
    const identity = { containerName: 'ploinky_demo_worker', routeKey: 'background' };
    const lifecycle = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-ready',
    };
    let now = 0;
    let loads = 0;
    let leaseHeld = false;
    let leaseCalls = 0;
    const result = await withActiveNoWaitWorkerLifecycleLease(identity, async (locked) => {
        assert.equal(leaseHeld, true);
        assert.deepEqual(locked, lifecycle);
        return 'launched';
    }, {
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        nowFn: () => now,
        loadFn() {
            loads += 1;
            if (loads <= 2) {
                assert.equal(leaseHeld, false, 'inactive selector polling must occur without the lease');
                throw Object.assign(new Error('publication inactive'), {
                    code: 'EDGE_GENERATION_INACTIVE',
                });
            }
            return lifecycle;
        },
        async withLeaseFn(options, callback) {
            assert.match(options.operation, /^no-wait-runtime:/);
            leaseCalls += 1;
            leaseHeld = true;
            try {
                return await callback();
            } finally {
                leaseHeld = false;
            }
        },
        async sleepFn(delayMs) {
            assert.equal(leaseHeld, false, 'publication recovery delay must not retain the lease');
            now += delayMs;
        },
    });

    assert.equal(result, 'launched');
    assert.equal(leaseCalls, 1);
    assert.equal(leaseHeld, false);
});

test('retryable publication recovery reacquires between exact worker lease attempts', async () => {
    const identity = { containerName: 'ploinky_demo_worker', routeKey: 'background' };
    const beforeFailure = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-reconciling',
    };
    const afterRecovery = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-ready',
    };
    let now = 0;
    let state = 'before-failure';
    let leaseHeld = false;
    let acquisitions = 0;
    let releases = 0;
    let launches = 0;
    const result = await withActiveNoWaitWorkerLifecycleLease(identity, async (lifecycle) => {
        launches += 1;
        assert.equal(leaseHeld, true);
        assert.deepEqual(lifecycle, afterRecovery);
        return lifecycle.selectorActivationId;
    }, {
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        nowFn: () => now,
        loadFn() {
            if (state === 'inactive') {
                throw Object.assign(new Error('publication retry pending'), {
                    code: 'EDGE_GENERATION_INACTIVE',
                });
            }
            return state === 'before-failure' ? beforeFailure : afterRecovery;
        },
        async withLeaseFn(_options, callback) {
            acquisitions += 1;
            leaseHeld = true;
            if (acquisitions === 1) state = 'inactive';
            try {
                return await callback();
            } finally {
                leaseHeld = false;
                releases += 1;
            }
        },
        async sleepFn(delayMs) {
            assert.equal(leaseHeld, false, 'publication must be able to reacquire between worker attempts');
            now += delayMs;
            if (state === 'inactive') state = 'recovered';
        },
    });

    assert.equal(result, 'activation-ready');
    assert.equal(acquisitions, 2);
    assert.equal(releases, 2);
    assert.equal(launches, 1);
    assert.equal(leaseHeld, false);
});

test('selector change inside the lease releases and retries the exact lifecycle capture', async () => {
    const identity = { containerName: 'ploinky_demo_worker', routeKey: 'background' };
    const initial = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-reconciling',
    };
    const ready = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-ready',
    };
    let current = initial;
    let acquisitions = 0;
    let releases = 0;
    let launches = 0;
    let now = 0;
    await withActiveNoWaitWorkerLifecycleLease(identity, async (lifecycle) => {
        launches += 1;
        assert.deepEqual(lifecycle, ready);
    }, {
        timeoutMs: 1_000,
        pollIntervalMs: 10,
        nowFn: () => now,
        loadFn: () => current,
        async withLeaseFn(_options, callback) {
            acquisitions += 1;
            if (acquisitions === 1) current = ready;
            try {
                return await callback();
            } finally {
                releases += 1;
            }
        },
        async sleepFn(delayMs) { now += delayMs; },
    });

    assert.equal(acquisitions, 2);
    assert.equal(releases, 2);
    assert.equal(launches, 1);
});

test('inactive selector polling fails closed within one bound without acquiring a lease', async () => {
    let now = 0;
    let leaseCalls = 0;
    await assert.rejects(
        () => withActiveNoWaitWorkerLifecycleLease(
            { containerName: 'ploinky_demo_worker', routeKey: 'background' },
            async () => assert.fail('inactive selector must not launch'),
            {
                timeoutMs: 1_000,
                pollIntervalMs: 250,
                nowFn: () => now,
                loadFn() {
                    throw Object.assign(new Error('publication inactive'), {
                        code: 'EDGE_GENERATION_INACTIVE',
                    });
                },
                async withLeaseFn() { leaseCalls += 1; },
                async sleepFn(delayMs) { now += delayMs; },
            },
        ),
        (error) => error?.code === 'NO_WAIT_EDGE_LEASE_TIMEOUT',
    );
    assert.equal(now, 1_000);
    assert.equal(leaseCalls, 0);
});

test('no-wait launch waits for the staged edge generation to become active', async () => {
    const expected = { generationDigest: 'sha256:active' };
    const identity = { routeKey: 'background' };
    let attempts = 0;

    const lifecycle = await waitForNoWaitLifecycle(identity, {
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        loadFn(receivedIdentity) {
            attempts += 1;
            assert.equal(receivedIdentity, identity);
            if (attempts < 3) {
                const error = new Error('edge routing generation is inactive');
                error.code = 'EDGE_GENERATION_INACTIVE';
                throw error;
            }
            return expected;
        },
        async sleepFn() {},
    });

    assert.equal(attempts, 3);
    assert.equal(lifecycle, expected);
});

test('no-wait launch does not retry a corrupt active edge generation', async () => {
    let attempts = 0;
    await assert.rejects(
        () => waitForNoWaitLifecycle({ routeKey: 'background' }, {
            timeoutMs: 1_000,
            pollIntervalMs: 1,
            loadFn() {
                attempts += 1;
                const error = new Error('active generation is corrupt');
                error.code = 'EDGE_GENERATION_CORRUPT';
                throw error;
            },
            async sleepFn() {},
        }),
        /active generation is corrupt/,
    );
    assert.equal(attempts, 1);
});

test('no-wait route activation rebinds to the same generation after a Router restart', async () => {
    const identity = { routeKey: 'background' };
    const lifecycle = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-after-restart',
    };
    let attempts = 0;

    const rebound = await waitForNoWaitRouteActivation(
        identity,
        { generation: 'sha256:active', activationId: 'activation-before-restart' },
        {
            timeoutMs: 1_000,
            pollIntervalMs: 1,
            loadFn() {
                attempts += 1;
                if (attempts < 2) {
                    const error = new Error('edge routing generation is inactive');
                    error.code = 'EDGE_GENERATION_INACTIVE';
                    throw error;
                }
                return lifecycle;
            },
            async sleepFn() {},
        },
    );

    assert.equal(attempts, 2);
    assert.equal(rebound, lifecycle);
});

test('no-wait route activation rejects a different generation after restart', async () => {
    await assert.rejects(
        () => waitForNoWaitRouteActivation(
            { routeKey: 'background' },
            { generation: 'sha256:launch' },
            {
                loadFn() {
                    return {
                        generationDigest: 'sha256:replacement',
                        selectorActivationId: 'activation-two',
                    };
                },
            },
        ),
        /generation changed before route activation/,
    );
});

test('no-wait route activation rebases only across an unchanged staged lifecycle', async () => {
    const identity = { routeKey: 'background' };
    const initial = {
        targetState: 'staged',
        generationDigest: 'sha256:launch',
        selectorActivationId: 'activation-one',
        record: {
            type: 'agent',
            instanceId: 'instance-one',
            enableGeneration: 'enable-one',
        },
        route: {
            container: 'ploinky_demo_worker',
            hostPath: '/workspace/demo/worker',
        },
        manifest: {
            container: 'node:24',
        },
        routerPort: 8080,
        routerHostPort: 19090,
    };
    const rebound = {
        ...initial,
        generationDigest: 'sha256:unrelated-route-update',
        selectorActivationId: 'activation-two',
    };

    assert.equal(
        await waitForNoWaitRouteActivation(
            identity,
            { generation: initial.generationDigest },
            {
                expectedLifecycle: initial,
                loadFn: () => rebound,
            },
        ),
        rebound,
    );
    assert.equal(assertNoWaitLifecycleRebase(initial, rebound, identity), rebound);

    await assert.rejects(
        () => waitForNoWaitRouteActivation(
            identity,
            { generation: initial.generationDigest },
            {
                expectedLifecycle: initial,
                loadFn: () => ({
                    ...rebound,
                    manifest: {
                        ...rebound.manifest,
                        container: 'node:25',
                    },
                }),
            },
        ),
        /lifecycle changed before route activation/,
    );
});

test('no-wait host launch retries an inactive locked read after releasing the apply lock', async () => {
    const identity = { routeKey: 'liveKitServerAgent' };
    const initial = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-before-apply',
    };
    const rebound = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-after-apply',
    };
    let loadCalls = 0;
    let lockHeld = false;
    let lockCalls = 0;
    let sleeps = 0;
    let launches = 0;

    const result = await launchNoWaitHostRuntime(identity, initial, async () => {
        launches += 1;
        assert.equal(lockHeld, false);
        return { containerName: 'livekit-runtime' };
    }, {
        loadFn(receivedIdentity) {
            loadCalls += 1;
            assert.equal(receivedIdentity, identity);
            if (loadCalls === 1) {
                const error = new Error('edge routing generation is inactive');
                error.code = 'EDGE_GENERATION_INACTIVE';
                throw error;
            }
            return rebound;
        },
        async withApplyLockFn(callback) {
            lockCalls += 1;
            lockHeld = true;
            try {
                return await callback();
            } finally {
                lockHeld = false;
            }
        },
        async sleepFn() {
            sleeps += 1;
            assert.equal(lockHeld, false);
        },
    });

    assert.deepEqual(result, { containerName: 'livekit-runtime' });
    assert.equal(loadCalls, 3);
    assert.equal(lockCalls, 2);
    assert.equal(sleeps, 1);
    assert.equal(launches, 1);
});

test('no-wait host launch rejects a replacement generation without launching a runtime', async () => {
    const initial = {
        generationDigest: 'sha256:launch',
        selectorActivationId: 'activation-before-apply',
    };
    let loadCalls = 0;
    let lockCalls = 0;
    let launches = 0;

    await assert.rejects(
        () => launchNoWaitHostRuntime(
            { routeKey: 'liveKitServerAgent' },
            initial,
            () => {
                launches += 1;
            },
            {
                loadFn() {
                    loadCalls += 1;
                    if (loadCalls === 1) {
                        const error = new Error('edge routing generation is inactive');
                        error.code = 'EDGE_GENERATION_INACTIVE';
                        throw error;
                    }
                    return {
                        generationDigest: 'sha256:replacement',
                        selectorActivationId: 'activation-after-apply',
                    };
                },
                async withApplyLockFn(callback) {
                    lockCalls += 1;
                    return callback();
                },
                async sleepFn() {},
            },
        ),
        /generation changed before host launch/,
    );
    assert.equal(loadCalls, 2);
    assert.equal(lockCalls, 1);
    assert.equal(launches, 0);
});

test('no-wait host launch requires one unchanged selector inside each apply lock', async () => {
    const initial = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-before-lock',
    };
    let launches = 0;

    await assert.rejects(
        () => launchNoWaitHostRuntime(
            { routeKey: 'liveKitServerAgent' },
            initial,
            () => {
                launches += 1;
            },
            {
                loadFn() {
                    return {
                        generationDigest: 'sha256:active',
                        selectorActivationId: 'activation-inside-lock',
                    };
                },
                async withApplyLockFn(callback) {
                    return callback();
                },
            },
        ),
        /activation changed before host launch/,
    );
    assert.equal(launches, 0);
});

test('no-wait host launch never retries an inactive error after runtime creation starts', async () => {
    const inactive = new Error('runtime launch reported inactive');
    inactive.code = 'EDGE_GENERATION_INACTIVE';
    const initial = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-one',
    };
    let launches = 0;
    let sleeps = 0;

    await assert.rejects(
        () => launchNoWaitHostRuntime(
            { routeKey: 'liveKitServerAgent' },
            initial,
            () => {
                launches += 1;
                throw inactive;
            },
            {
                loadFn() {
                    return initial;
                },
                async withApplyLockFn(callback) {
                    return callback();
                },
                async sleepFn() {
                    sleeps += 1;
                },
            },
        ),
        (error) => error === inactive,
    );
    assert.equal(launches, 1);
    assert.equal(sleeps, 0);
});

test('no-wait host launch retries only inactivity and times out within one bounded window', async () => {
    const initial = {
        generationDigest: 'sha256:active',
        selectorActivationId: 'activation-one',
    };
    let now = 0;
    let loadCalls = 0;
    let lockCalls = 0;

    await assert.rejects(
        () => launchNoWaitHostRuntime(
            { routeKey: 'liveKitServerAgent' },
            initial,
            () => assert.fail('runtime must not launch while the edge is inactive'),
            {
                timeoutMs: 1_000,
                pollIntervalMs: 250,
                loadFn() {
                    loadCalls += 1;
                    const error = new Error('edge routing generation is inactive');
                    error.code = 'EDGE_GENERATION_INACTIVE';
                    throw error;
                },
                async withApplyLockFn(callback) {
                    lockCalls += 1;
                    return callback();
                },
                async sleepFn(ms) {
                    now += ms;
                },
                nowFn() {
                    return now;
                },
            },
        ),
        (error) => (
            error?.code === 'NO_WAIT_HOST_LAUNCH_TIMEOUT'
            && error?.cause?.code === 'EDGE_GENERATION_INACTIVE'
        ),
    );
    assert.equal(now, 1_000);
    assert.equal(loadCalls, 4);
    assert.equal(lockCalls, 1);

    const busy = new Error('edge generation apply is already in progress');
    busy.code = 'EDGE_GENERATION_BUSY';
    let busySleeps = 0;
    await assert.rejects(
        () => launchNoWaitHostRuntime(
            { routeKey: 'liveKitServerAgent' },
            initial,
            () => assert.fail('runtime must not launch without the apply lock'),
            {
                loadFn() {
                    return initial;
                },
                withApplyLockFn() {
                    throw busy;
                },
                async sleepFn() {
                    busySleeps += 1;
                },
            },
        ),
        (error) => error === busy,
    );
    assert.equal(busySleeps, 0);
});

test('no-wait launch accepts only its exact active target-less identity', () => {
    const active = {
        selector: {
            generation: 'sha256:active-generation',
            activationId: 'activation-one',
        },
        generation: {
            agents: {
                ploinky_demo_worker: {
                    type: 'agent',
                    repoName: 'demo',
                    agentName: 'worker',
                    alias: 'background',
                    instanceId: 'instance-one',
                    enableGeneration: 'enable-one',
                    runtime: 'podman',
                    containerId: 'c'.repeat(64),
                },
            },
            routing: {
                port: 8080,
                routes: {
                    background: {
                        container: 'ploinky_demo_worker',
                        repo: 'demo',
                        agent: 'worker',
                        alias: 'background',
                        hostPath: '/workspace/demo/worker',
                    },
                },
            },
            manifests: {
                background: {
                    container: 'node:24',
                },
            },
            routerHostPort: 19090,
        },
    };
    const identity = {
        containerName: 'ploinky_demo_worker',
        repoName: 'demo',
        shortAgent: 'worker',
        alias: 'background',
        routeKey: 'background',
        agentPath: '/workspace/demo/worker',
        runtime: 'podman',
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        containerId: 'c'.repeat(64),
    };

    const lifecycle = assertNoWaitLifecycleSnapshot(active, identity);
    assert.equal(lifecycle.record.instanceId, 'instance-one');
    assert.equal(lifecycle.generationDigest, 'sha256:active-generation');
    assert.equal(lifecycle.selectorActivationId, 'activation-one');
    assert.equal(lifecycle.routerPort, 8080);
    assert.equal(lifecycle.routerHostPort, 19090);
    const { containerId: _freshContainerId, ...freshIdentity } = identity;
    const { containerId: _freshRecordContainerId, ...freshRecord } = active.generation.agents.ploinky_demo_worker;
    assert.doesNotThrow(() => assertNoWaitLifecycleSnapshot({
        ...active,
        generation: {
            ...active.generation,
            agents: { ploinky_demo_worker: freshRecord },
        },
    }, freshIdentity));
    for (const changedIdentity of [
        { ...identity, instanceId: 'foreign-instance' },
        { ...identity, enableGeneration: 'foreign-generation' },
        { ...identity, containerId: 'd'.repeat(64) },
    ]) {
        assert.throws(
            () => assertNoWaitLifecycleSnapshot(active, changedIdentity),
            /exact selected runtime|exact immutable runtime identity/,
        );
    }
    assert.throws(
        () => assertNoWaitLifecycleSnapshot({
            generation: {
                ...active.generation,
                routing: {
                    routes: {
                        background: {
                            ...active.generation.routing.routes.background,
                            hostPort: 43123,
                        },
                    },
                },
            },
        }, identity),
        /target-less staged route/,
    );
    assert.doesNotThrow(() => assertNoWaitRegistryRecord({
        ...active.generation.agents.ploinky_demo_worker,
        runtime: 'podman',
        containerId: 'c'.repeat(64),
    }, active.generation.agents.ploinky_demo_worker, identity));
    assert.throws(
        () => assertNoWaitRegistryRecord({
            ...active.generation.agents.ploinky_demo_worker,
            enableGeneration: 'different-enable-generation',
        }, active.generation.agents.ploinky_demo_worker, identity),
        /registry identity inconsistent/,
    );
    assert.throws(
        () => assertNoWaitRegistryRecord({
            ...active.generation.agents.ploinky_demo_worker,
            repoName: { toString: () => 'demo' },
            containerId: 'c'.repeat(64),
        }, active.generation.agents.ploinky_demo_worker, identity),
        /registry identity inconsistent/,
    );
    assert.throws(
        () => assertNoWaitRegistryRecord({
            ...active.generation.agents.ploinky_demo_worker,
            containerId: { toString: () => 'c'.repeat(64) },
        }, active.generation.agents.ploinky_demo_worker, identity),
        /registry identity inconsistent/,
    );
    assert.throws(
        () => assertNoWaitRegistryRecord({
            ...active.generation.agents.ploinky_demo_worker,
            instanceId: { toString: () => 'instance-one' },
            containerId: 'c'.repeat(64),
        }, active.generation.agents.ploinky_demo_worker, identity),
        /registry identity inconsistent/,
    );
    for (const invalidRuntime of ['', 'container', 'docker', ' podman', 'podman ']) {
        assert.throws(
            () => assertNoWaitLifecycleSnapshot({
                ...active,
                generation: {
                    ...active.generation,
                    agents: {
                        ploinky_demo_worker: {
                            ...active.generation.agents.ploinky_demo_worker,
                            runtime: invalidRuntime,
                        },
                    },
                },
            }, identity),
            /exact selected runtime/,
        );
    }
    for (const [field, value] of [
        ['instanceId', ' instance-one'],
        ['enableGeneration', 'enable-one '],
    ]) {
        assert.throws(
            () => assertNoWaitLifecycleSnapshot({
                ...active,
                generation: {
                    ...active.generation,
                    agents: {
                        ploinky_demo_worker: {
                            ...active.generation.agents.ploinky_demo_worker,
                            [field]: value,
                        },
                    },
                },
            }, identity),
            /staged registry identity/,
        );
    }
    const { containerId: _ignoredRuntimeContainerId, ...sandboxIdentity } = identity;
    assert.throws(
        () => assertNoWaitLifecycleSnapshot(active, { ...sandboxIdentity, runtime: 'bwrap' }),
        /exact selected runtime/,
    );
    assert.throws(
        () => assertNoWaitLifecycleSnapshot({
            ...active,
            generation: {
                ...active.generation,
                routing: {
                    routes: {
                        background: {
                            ...active.generation.routing.routes.background,
                            hostPath: '/workspace/demo/worker/..',
                        },
                    },
                },
            },
        }, identity),
        /exact staged route identity/,
    );
    assert.throws(
        () => assertNoWaitRegistryRecord({
            ...active.generation.agents.ploinky_demo_worker,
            runtime: 'bwrap',
        }, active.generation.agents.ploinky_demo_worker, identity),
        /registry identity inconsistent/,
    );
    for (const runtime of ['bwrap', 'seatbelt']) {
        const { containerId: _ignoredContainerId, ...podmanStaged } = active.generation.agents.ploinky_demo_worker;
        const staged = {
            ...podmanStaged,
            runtime,
        };
        const { containerId: _ignoredIdentityContainerId, ...baseIdentity } = identity;
        assert.doesNotThrow(() => assertNoWaitLifecycleSnapshot({
            ...active,
            generation: {
                ...active.generation,
                agents: { ploinky_demo_worker: staged },
            },
        }, { ...baseIdentity, runtime }));
        assert.doesNotThrow(() => assertNoWaitRegistryRecord(
            staged,
            staged,
            { ...baseIdentity, runtime },
        ));
    }
});

test('no-wait registry validation treats an omitted alias as the exact empty alias', () => {
    const staged = {
        type: 'agent',
        repoName: 'demo',
        agentName: 'worker',
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        profile: null,
        runMode: 'service',
        projectPath: '/workspace',
        develRepo: false,
        runtime: 'podman',
    };
    assert.doesNotThrow(() => assertNoWaitRegistryRecord({
        ...staged,
        containerId: 'c'.repeat(64),
    }, staged, {
        containerName: 'ploinky_demo_worker',
        repoName: 'demo',
        shortAgent: 'worker',
        alias: '',
    }));
});

test('queued no-wait launch adopts the exact ready runtime published by a foreground start', () => {
    const identity = {
        containerName: 'ploinky_demo_worker',
        repoName: 'demo',
        shortAgent: 'worker',
        alias: 'background',
        routeKey: 'background',
        agentPath: '/workspace/demo/worker',
        runtime: 'podman',
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        containerId: 'a'.repeat(64),
    };
    const ready = {
        selector: {
            generation: 'sha256:foreground-start',
            activationId: 'activation-one',
        },
        generation: {
            agents: {
                ploinky_demo_worker: {
                    type: 'agent',
                    repoName: 'demo',
                    agentName: 'worker',
                    alias: 'background',
                    instanceId: 'instance-one',
                    enableGeneration: 'enable-one',
                    runtime: 'podman',
                    containerId: 'a'.repeat(64),
                },
            },
            routing: {
                port: 8080,
                routes: {
                    background: {
                        container: 'ploinky_demo_worker',
                        repo: 'demo',
                        agent: 'worker',
                        alias: 'background',
                        hostPath: '/workspace/demo/worker',
                        hostPort: 43123,
                    },
                },
            },
            manifests: {
                background: {
                    container: 'node:24',
                },
            },
            routerHostPort: 19090,
        },
    };

    const lifecycle = resolveNoWaitWorkerLifecycleSnapshot(ready, identity);
    assert.equal(lifecycle.targetState, 'ready');
    assert.equal(lifecycle.route.hostPort, 43123);
    assert.equal(lifecycle.record.containerId, 'a'.repeat(64));
    assert.equal(assertNoWaitPodmanAdoptionOwnership(lifecycle, [{
        containerName: 'ploinky_demo_worker',
        runtime: 'podman',
        containerId: 'a'.repeat(64),
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        ownershipVerified: true,
        state: { running: true },
    }]), lifecycle);
    assert.equal(
        assertNoWaitAdoptionStillCurrent(lifecycle, {
            ...lifecycle,
            generationDigest: 'sha256:unrelated-route-update',
            selectorActivationId: 'activation-two',
        }, identity).selectorActivationId,
        'activation-two',
    );

    const changedTarget = assertNoWaitAdoptableLifecycleSnapshot({
        ...ready,
        selector: {
            generation: 'sha256:replacement',
            activationId: 'activation-three',
        },
        generation: {
            ...ready.generation,
            routing: {
                ...ready.generation.routing,
                routes: {
                    background: {
                        ...ready.generation.routing.routes.background,
                        hostPort: 43124,
                    },
                },
            },
        },
    }, identity);
    assert.throws(
        () => assertNoWaitAdoptionStillCurrent(lifecycle, changedTarget, identity),
        /adopted runtime changed/,
    );
    assert.throws(
        () => assertNoWaitAdoptionStillCurrent(lifecycle, {
            ...lifecycle,
            record: {
                ...lifecycle.record,
                enableGeneration: 'replacement-enable-generation',
            },
        }, identity),
        /adopted runtime changed/,
    );
    assert.throws(
        () => assertNoWaitAdoptionStillCurrent(lifecycle, {
            ...lifecycle,
            manifest: {
                ...lifecycle.manifest,
                container: 'node:25',
            },
        }, identity),
        /adopted runtime changed/,
    );
    for (const change of [
        { ownershipVerified: false },
        { containerId: 'b'.repeat(64) },
        { instanceId: 'replacement-instance' },
        { enableGeneration: 'replacement-generation' },
        { runtime: 'docker' },
        { state: { running: false } },
    ]) {
        assert.throws(
            () => assertNoWaitPodmanAdoptionOwnership(lifecycle, [{
                containerName: 'ploinky_demo_worker',
                runtime: 'podman',
                containerId: 'a'.repeat(64),
                instanceId: 'instance-one',
                enableGeneration: 'enable-one',
                ownershipVerified: true,
                state: { running: true },
                ...change,
            }]),
            /exact rootless Podman ownership/,
        );
    }
});

test('queued no-wait launch rejects incomplete or foreign published targets', () => {
    const identity = {
        containerName: 'ploinky_demo_worker',
        repoName: 'demo',
        shortAgent: 'worker',
        alias: '',
        routeKey: 'worker',
        agentPath: '/workspace/demo/worker',
        runtime: 'podman',
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
        containerId: 'b'.repeat(64),
    };
    const active = {
        selector: {
            generation: 'sha256:active',
            activationId: 'activation-one',
        },
        generation: {
            agents: {
                ploinky_demo_worker: {
                    type: 'agent',
                    repoName: 'demo',
                    agentName: 'worker',
                    alias: '',
                    instanceId: 'instance-one',
                    enableGeneration: 'enable-one',
                    runtime: 'podman',
                    containerId: 'b'.repeat(64),
                },
            },
            routing: {
                routes: {
                    worker: {
                        container: 'ploinky_demo_worker',
                        repo: 'demo',
                        agent: 'worker',
                        hostPath: '/workspace/demo/worker',
                        hostPort: 0,
                    },
                },
            },
            manifests: {
                worker: {
                    container: 'node:24',
                },
            },
        },
    };

    assert.throws(
        () => resolveNoWaitWorkerLifecycleSnapshot(active, identity),
        /cannot adopt an existing target/,
    );
    assert.throws(
        () => resolveNoWaitWorkerLifecycleSnapshot({
            ...active,
            generation: {
                ...active.generation,
                routing: {
                    routes: {
                        worker: {
                            ...active.generation.routing.routes.worker,
                            hostPort: 43123,
                            container: 'ploinky_foreign_worker',
                        },
                    },
                },
            },
        }, identity),
        /exact staged route identity/,
    );
    assert.throws(
        () => resolveNoWaitWorkerLifecycleSnapshot({
            ...active,
            generation: {
                ...active.generation,
                agents: {
                    ploinky_demo_worker: {
                        ...active.generation.agents.ploinky_demo_worker,
                        runtime: 'docker',
                    },
                },
                routing: {
                    routes: {
                        worker: {
                            ...active.generation.routing.routes.worker,
                            hostPort: 43123,
                        },
                    },
                },
            },
        }, identity),
        /exact selected runtime/,
    );
});

test('sandbox no-wait readiness never executes an OCI script probe', async () => {
    for (const runtime of ['bwrap', 'seatbelt']) {
        let containerProbeCalls = 0;
        await assert.rejects(
            () => waitForNoWaitReadiness({
                manifest: {
                    start: 'node server.mjs',
                    health: { readiness: { script: 'ready.sh' } },
                },
                shortAgent: 'worker',
                containerName: 'ploinky_demo_worker',
                hostPort: 43123,
                runtimeResult: {
                    registryRecord: {
                        runtime,
                        instanceId: 'instance-one',
                        enableGeneration: 'enable-one',
                    },
                },
                networkMode: 'host',
                generationDigest: 'sha256:active',
                selectedRuntime: runtime,
            }, {
                runContainerScriptReadinessFn() {
                    containerProbeCalls += 1;
                    return { status: 'success' };
                },
            }),
            (error) => error?.code === 'PLOINKY_SANDBOX_SCRIPT_READINESS_UNSUPPORTED',
        );
        assert.equal(containerProbeCalls, 0);
    }
});

test('Podman no-wait script readiness pins both exec and running probes to Podman', async () => {
    const runningCalls = [];
    let scriptCalls = 0;
    const containerId = 'c'.repeat(64);
    await waitForNoWaitReadiness({
        manifest: {
            start: 'node server.mjs',
            health: { readiness: { script: 'ready.sh' } },
        },
        shortAgent: 'worker',
        containerName: 'ploinky_demo_worker',
        runtimeResult: {
            containerId,
            registryRecord: {
                runtime: 'podman',
                containerId,
                instanceId: 'instance-one',
                enableGeneration: 'enable-one',
            },
        },
        networkMode: 'default',
        generationDigest: 'sha256:active',
        selectedRuntime: 'podman',
    }, {
        runContainerScriptReadinessFn(agentName, containerName, probe, options) {
            scriptCalls += 1;
            assert.equal(agentName, 'worker');
            assert.equal(containerName, 'ploinky_demo_worker');
            assert.equal(probe.script, 'ready.sh');
            assert.equal(options.runtime, 'podman');
            assert.equal(options.containerId, containerId);
            assert.equal(options.instanceId, 'instance-one');
            assert.equal(options.enableGeneration, 'enable-one');
            assert.equal(options.isContainerRunningImpl(containerName, { timeoutMs: 321 }), true);
            return { status: 'success' };
        },
        isContainerRunningFn(containerName, options) {
            runningCalls.push({ containerName, options });
            return true;
        },
    });
    assert.equal(scriptCalls, 1);
    assert.deepEqual(runningCalls, [{
        containerName: 'ploinky_demo_worker',
        options: {
            timeoutMs: 321,
            runtime: 'podman',
            containerId,
            instanceId: 'instance-one',
            enableGeneration: 'enable-one',
        },
    }]);
});

test('no-wait failure cleanup removes only a runtime created by this launch', async () => {
    const cleaned = [];
    const aborted = [];
    const cleanup = async (candidate) => cleaned.push(candidate.containerName);
    const abortPreparation = async (lease) => aborted.push(lease.leaseId);

    assert.equal(await cleanupNoWaitTaskOwnedCandidate({
        containerName: 'new-runtime',
        createdByThisLaunch: true,
    }, { cleanup, abortPreparation }), true);
    assert.equal(await cleanupNoWaitTaskOwnedCandidate({
        containerName: 'reused-runtime',
        createdByThisLaunch: false,
    }, { cleanup, abortPreparation }), false);
    assert.equal(await cleanupNoWaitTaskOwnedCandidate({
        containerName: 'prepared-adoption',
        requiresEdgeActivation: true,
        preparationLease: { leaseId: 'exact-lease' },
    }, { cleanup, abortPreparation }), true);
    assert.equal(await cleanupNoWaitTaskOwnedCandidate(null, { cleanup, abortPreparation }), false);
    assert.deepEqual(cleaned, ['new-runtime', 'prepared-adoption']);
    assert.deepEqual(aborted, ['exact-lease']);
});

test('no-wait cleanup aborts the exact preparation before candidate cleanup', async () => {
    const events = [];
    const preparationLease = { leaseId: 'prepared-exact' };
    await cleanupNoWaitTaskOwnedCandidate({
        containerName: 'prepared-runtime',
        requiresEdgeActivation: true,
        preparationLease,
    }, {
        cleanup(candidate) {
            events.push(`cleanup:${candidate.containerName}`);
        },
        abortPreparation(received) {
            assert.equal(received, preparationLease);
            events.push(`abort:${received.leaseId}`);
        },
    });
    assert.deepEqual(events, ['abort:prepared-exact', 'cleanup:prepared-runtime']);
});

test('no-wait cleanup reports candidate removal failure only after preparation abort', async () => {
    const events = [];
    const preparationLease = { leaseId: 'prepared-cleanup-failure' };
    await assert.rejects(cleanupNoWaitTaskOwnedCandidate({
        containerName: 'prepared-runtime',
        requiresEdgeActivation: true,
        preparationLease,
    }, {
        cleanup() {
            events.push('cleanup');
            throw new Error('cleanup failed');
        },
        abortPreparation(received) {
            assert.equal(received, preparationLease);
            events.push('abort');
        },
    }), /cleanup failed/);
    assert.deepEqual(events, ['abort', 'cleanup']);
});

test('no-wait cleanup preserves the exact candidate when preparation abort fails', async () => {
    const preparationLease = { leaseId: 'prepared-abort-failure' };
    const originalFailure = new Error('no-wait launch failed');
    const abortFailure = new Error('durable abort failed');
    let cleanupCalls = 0;

    await assert.rejects(cleanupNoWaitTaskOwnedCandidate({
        containerName: 'preserved-no-wait-runtime',
        requiresEdgeActivation: true,
        preparationLease,
        cleanupReceipt: { operationId: 'preserved-no-wait-cleanup' },
    }, {
        originalFailure,
        cleanup() { cleanupCalls += 1; },
        abortPreparation(received, options) {
            assert.equal(received, preparationLease);
            assert.deepEqual(options, { reason: 'no-wait-task-runtime-failed' });
            throw abortFailure;
        },
    }), (error) => (
        error?.code === 'PLOINKY_RECOVERY_ABORT_FAILED'
        && error.cause === abortFailure
        && error.originalFailure === originalFailure
        && error.ploinkyRestartCandidate?.containerName === 'preserved-no-wait-runtime'
        && error.ploinkyRestartCandidate?.preparationAbortFailed === true
    ));

    assert.equal(cleanupCalls, 0);
});

test('no-wait recovery propagates abort failure without retrying abort or cleanup', async () => {
    const preparationLease = { leaseId: 'prepared-abort-propagation' };
    const originalFailure = new Error('no-wait launch failed');
    let abortCalls = 0;
    let cleanupCalls = 0;
    const candidate = {
        containerName: 'preserved-no-wait-runtime',
        requiresEdgeActivation: true,
        preparationLease,
    };

    const recoveryFailure = await recoverNoWaitTaskOwnedCandidate(candidate, originalFailure, {
        abortPreparation() {
            abortCalls += 1;
            throw new Error('durable abort failed');
        },
        cleanup() { cleanupCalls += 1; },
    });
    assert.equal(recoveryFailure.code, 'PLOINKY_RECOVERY_ABORT_FAILED');
    assert.equal(recoveryFailure.originalFailure, originalFailure);
    assert.equal(recoveryFailure.ploinkyRestartCandidate.containerName, candidate.containerName);

    const propagated = await recoverNoWaitTaskOwnedCandidate(candidate, recoveryFailure, {
        abortPreparation() { abortCalls += 1; },
        cleanup() { cleanupCalls += 1; },
    });
    assert.equal(propagated, recoveryFailure);
    assert.equal(abortCalls, 1);
    assert.equal(cleanupCalls, 0);
});

test('no-wait recovery reports cleanup failure after one successful abort', async () => {
    const originalFailure = new Error('no-wait launch failed');
    const events = [];
    const failure = await recoverNoWaitTaskOwnedCandidate({
        containerName: 'cleanup-failed-no-wait-runtime',
        requiresEdgeActivation: true,
        preparationLease: { leaseId: 'prepared-cleanup-propagation' },
    }, originalFailure, {
        abortPreparation() { events.push('abort'); },
        cleanup(candidate) {
            events.push('cleanup');
            assert.equal(candidate.preparationAbortedBeforeCleanup, true);
            throw new Error('runtime removal failed');
        },
    });

    assert.equal(failure, originalFailure);
    assert.match(failure.message, /runtime removal failed/);
    assert.equal(failure.ploinkyRestartCandidate.preparationAbortedBeforeCleanup, true);
    assert.deepEqual(events, ['abort', 'cleanup']);

    const replayed = await recoverNoWaitTaskOwnedCandidate(
        failure.ploinkyRestartCandidate,
        failure,
        {
            abortPreparation() { events.push('abort-replay'); },
            cleanup(candidate) {
                events.push('cleanup-replay');
                assert.equal(candidate.preparationAbortedBeforeCleanup, true);
                throw new Error('runtime removal still failed');
            },
        },
    );
    assert.equal(replayed, failure);
    assert.deepEqual(events, ['abort', 'cleanup', 'cleanup-replay']);
});

test('no-wait successful recovery replay neither aborts nor cleans the exact candidate twice', async () => {
    const originalFailure = new Error('no-wait launch failed');
    const candidate = Object.freeze({
        containerName: 'successfully-cleaned-no-wait-runtime',
        requiresEdgeActivation: true,
        preparationLease: Object.freeze({ leaseId: 'successful-no-wait-recovery' }),
        cleanupReceipt: Object.freeze({ operationId: 'successful-no-wait-cleanup' }),
    });
    const events = [];
    const options = {
        abortPreparation() { events.push('abort'); },
        cleanup() { events.push('cleanup'); },
    };

    assert.equal(
        await recoverNoWaitTaskOwnedCandidate(candidate, originalFailure, options),
        originalFailure,
    );
    assert.equal(
        await recoverNoWaitTaskOwnedCandidate(candidate, originalFailure, options),
        originalFailure,
    );
    assert.deepEqual(events, ['abort', 'cleanup']);
    assert.equal(originalFailure.ploinkyRestartCandidate.preparationAbortedBeforeCleanup, true);
    assert.equal(originalFailure.ploinkyRestartCandidate.exactCleanupPerformed, true);
    assert.equal(Object.isFrozen(originalFailure.ploinkyRestartCandidate), true);
});
