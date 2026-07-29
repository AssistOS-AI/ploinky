import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    assertNoWaitLifecycleSnapshot,
    assertNoWaitRegistryRecord,
    cleanupNoWaitTaskOwnedCandidate,
    waitForNoWaitLifecycle,
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
            routerHostPort: 8080,
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
    assert.equal(lifecycle.routerHostPort, 8080);
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

test('no-wait failure cleanup removes only a runtime created by this launch', async () => {
    const cleaned = [];
    const cleanup = async (candidate) => cleaned.push(candidate.containerName);

    assert.equal(await cleanupNoWaitTaskOwnedCandidate({
        containerName: 'new-runtime',
        createdByThisLaunch: true,
    }, { cleanup }), true);
    assert.equal(await cleanupNoWaitTaskOwnedCandidate({
        containerName: 'reused-runtime',
        createdByThisLaunch: false,
    }, { cleanup }), false);
    assert.equal(await cleanupNoWaitTaskOwnedCandidate(null, { cleanup }), false);
    assert.deepEqual(cleaned, ['new-runtime']);
});
