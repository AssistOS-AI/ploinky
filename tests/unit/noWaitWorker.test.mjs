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
    assertNoWaitRegistryRecord,
    cleanupNoWaitTaskOwnedCandidate,
    launchNoWaitHostRuntime,
    resolveNoWaitWorkerLifecycleSnapshot,
    waitForNoWaitLifecycle,
    waitForNoWaitRouteActivation,
    waitForPriorWorker,
    writeStatus,
} from '../../cli/commands/noWaitWorker.js';

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
        assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), {
            state: 'starting',
            sequence,
        });
        assert.deepEqual(fs.readdirSync(statusDir), [`${containerName}.json`]);
    }
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('no-wait predecessor observes a complete atomically published terminal state', async (t) => {
    const { runningDir } = fixture(t);
    const containerName = 'ploinky_demo_predecessor';
    const target = path.join(runningDir, 'no-wait', `${containerName}.json`);
    writeStatus(containerName, { state: 'starting' }, { runningDir });
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
    const acquire = source.indexOf('await withWorkspaceMutationLease({');
    const lifecycle = source.indexOf('const lifecycle = await waitForNoWaitWorkerLifecycle', acquire);
    const activation = source.indexOf('await upsertRoute(', lifecycle);
    const release = source.indexOf('\n        });\n    } catch (err)', activation);
    assert.ok(acquire > 0, 'no-wait worker must acquire the shared workspace mutation lease');
    assert.ok(lifecycle > acquire, 'lifecycle capture must occur under the workspace mutation lease');
    assert.ok(activation > lifecycle, 'route activation must remain in the same critical section');
    assert.ok(release > activation, 'the workspace mutation callback must close only after route activation');
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
    };

    const lifecycle = assertNoWaitLifecycleSnapshot(active, identity);
    assert.equal(lifecycle.record.instanceId, 'instance-one');
    assert.equal(lifecycle.generationDigest, 'sha256:active-generation');
    assert.equal(lifecycle.selectorActivationId, 'activation-one');
    assert.equal(lifecycle.routerPort, 8080);
    assert.equal(lifecycle.routerHostPort, 19090);
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
        containerId: 'runtime-one',
    }, active.generation.agents.ploinky_demo_worker, identity));
    assert.throws(
        () => assertNoWaitRegistryRecord({
            ...active.generation.agents.ploinky_demo_worker,
            enableGeneration: 'different-enable-generation',
        }, active.generation.agents.ploinky_demo_worker, identity),
        /registry identity inconsistent/,
    );
});

test('queued no-wait launch adopts the exact ready runtime published by a foreground start', () => {
    const identity = {
        containerName: 'ploinky_demo_worker',
        repoName: 'demo',
        shortAgent: 'worker',
        alias: 'background',
        routeKey: 'background',
        agentPath: '/workspace/demo/worker',
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
});

test('queued no-wait launch rejects incomplete or foreign published targets', () => {
    const identity = {
        containerName: 'ploinky_demo_worker',
        repoName: 'demo',
        shortAgent: 'worker',
        alias: '',
        routeKey: 'worker',
        agentPath: '/workspace/demo/worker',
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

test('no-wait cleanup aborts the exact preparation after candidate cleanup', async () => {
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
    assert.deepEqual(events, ['cleanup:prepared-runtime', 'abort:prepared-exact']);
});

test('no-wait cleanup still aborts preparation when exact candidate removal fails', async () => {
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
    assert.deepEqual(events, ['cleanup', 'abort']);
});
