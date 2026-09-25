import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    applyEdgeRoutingGeneration,
    inactivateEdgeRoutingGeneration,
    initializeFreshEdgeRoutingSources,
    loadActiveEdgeRoutingGeneration,
    readEdgeRoutingSelection,
    withEdgeGenerationApplyLock,
} from '../../cli/sandbox/edgeGeneration.js';
import {
    ROUTER_SUPERVISOR_ID_ENV,
    readRouterSupervisorId,
    routerSupervisorEnvironment,
} from '../../cli/server/routerSupervisorIdentity.js';
import {
    readRouterRestartHandoff,
    routerRestartHandoffFile,
    writeRouterRestartHandoff,
} from '../../ploinky-box/cloudflared/routerRestartHandoff.mjs';
import { createCloudflarePublicationController } from '../../ploinky-box/cloudflared/publicationController.mjs';
import {
    createEdgePublicationRouteCoordinator,
    startCloudflarePublicationRuntime,
} from '../../ploinky-box/cloudflared/runtime.mjs';

const NETWORK_CAPABILITY = Object.freeze({ fixture: 'network-lifecycle' });

// Real edge-generation files; only the process-global network lock is
// replaced so these tests never touch a workspace outside their fixture.
function fixtureEdgeOps() {
    return {
        apply: applyEdgeRoutingGeneration,
        inactivate: inactivateEdgeRoutingGeneration,
        load: loadActiveEdgeRoutingGeneration,
        selection: readEdgeRoutingSelection,
        withApplyLock: withEdgeGenerationApplyLock,
        withNetworkLifecycleLock: (callback) => callback(NETWORK_CAPABILITY),
    };
}

function createLocalWorkspace(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-restart-restore-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'fixture-apply' });
    assert.equal(applied.selector.state, 'active');
    assert.equal(applied.selector.publicationState, 'ready');
    return { workspace, generation: applied.selector.generation, activationId: applied.selector.activationId };
}

function writeJson(target, value) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function createConnectorOnlyWorkspace(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-restart-cloudflare-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const agentDir = path.join(ploinkyDir, 'repos', 'fixtures', 'alpha');
    writeJson(path.join(agentDir, 'manifest.json'), {
        routerAccess: { httpRoutes: [{ path: '/public.html', access: 'public' }] },
    });
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        routes: {
            alpha: {
                repo: 'fixtures',
                agent: 'alpha',
                container: 'alpha-container',
                hostPath: agentDir,
                hostPort: null,
            },
        },
    });
    writeJson(path.join(ploinkyDir, 'agents.json'), {
        'alpha-container': {
            type: 'agent',
            repoName: 'fixtures',
            agentName: 'alpha',
            instanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
            profile: 'default',
            auth: { mode: 'sso' },
        },
    });
    writeJson(path.join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), {
        hosts: {
            'alpha.example.test': { agent: 'fixtures/alpha', routerSurfaces: [] },
        },
        cloudflare: { tunnelTokenSecret: 'publication/test-connector' },
    });
    writeJson(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), {
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    });
    return workspace;
}

function selectorOf(workspace) {
    return readEdgeRoutingSelection({ workspaceRoot: workspace }).selector;
}

function leaseFixture() {
    const fixture = {
        busy: false,
        acquisitions: 0,
        releases: 0,
        create: ({ operation }) => {
            if (fixture.busy) {
                throw Object.assign(new Error('busy'), { code: 'PLOINKY_WORKSPACE_MUTATION_BUSY' });
            }
            fixture.acquisitions += 1;
            return { token: `lease-${fixture.acquisitions}`, operation };
        },
        release: () => {
            fixture.releases += 1;
            return true;
        },
    };
    return fixture;
}

// A Watchdog process gives every Router child it spawns the same supervisor
// id; `supervisorId` models which Watchdog lifetime a Router belongs to.
function startRuntime(workspace, {
    supervisorId = null,
    lease = leaseFixture(),
    audits = [],
    controllerFactory,
} = {}) {
    const runtime = startCloudflarePublicationRuntime({
        ...(controllerFactory ? { controllerFactory } : {}),
        retryInitialDelayMs: 60_000,
        workspaceRoot: workspace,
        statusFile: path.join(workspace, '.ploinky', 'run', 'cloudflare-publication-status.json'),
        pollIntervalMs: 60_000,
        createWorkspaceLease: lease.create,
        releaseWorkspaceLease: lease.release,
        inspectWorkspaceLease: () => ({ active: false }),
        routeCoordinatorFactory: (options) => createEdgePublicationRouteCoordinator({
            ...options,
            edgeOps: fixtureEdgeOps(),
        }),
        probeHostname: async () => ({ ok: false }),
        audit: (event, value) => audits.push({ event, value: structuredClone(value) }),
        routerSupervisorId: supervisorId,
    });
    return { runtime, audits, lease };
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function startServingRuntime(workspace, generation, options = {}) {
    const started = startRuntime(workspace, options);
    await waitFor(async () => {
        await started.runtime.scan();
        const status = started.runtime.getStatus();
        return status.state === 'local-only' && status.configurationGeneration === generation;
    }, 'the Router controller to serve the selected generation');
    return started;
}

test('every Router child of one Watchdog carries that Watchdog supervisor id', () => {
    const lifetime = crypto.randomUUID();
    const child = routerSupervisorEnvironment({
        KEEP: 'value',
        [ROUTER_SUPERVISOR_ID_ENV]: crypto.randomUUID(),
    }, lifetime);
    assert.equal(child.KEEP, 'value');
    assert.equal(child[ROUTER_SUPERVISOR_ID_ENV], lifetime, 'an inherited supervisor id is replaced');
    assert.equal(readRouterSupervisorId(child), lifetime);
    assert.throws(() => routerSupervisorEnvironment({}, 'not-a-uuid'), TypeError);
    assert.equal(readRouterSupervisorId({ [ROUTER_SUPERVISOR_ID_ENV]: 'forged' }), null);
    assert.equal(readRouterSupervisorId({}), null);
});

test('a Router stop withdraws its exact generation and a replacement from the same Watchdog restores it', async (t) => {
    const { workspace, generation, activationId } = createLocalWorkspace(t);
    const lifetime = crypto.randomUUID();
    const first = await startServingRuntime(workspace, generation, { supervisorId: lifetime });
    await first.runtime.stop();

    const stopped = selectorOf(workspace);
    assert.equal(stopped.state, 'inactive');
    assert.equal(stopped.reason, 'cloudflare-controller-stop');
    assert.equal(stopped.previousGeneration, generation);
    assert.throws(
        () => loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }),
        (error) => error.code === 'EDGE_GENERATION_INACTIVE',
    );
    const handoffFile = routerRestartHandoffFile(workspace);
    const handoff = readRouterRestartHandoff(handoffFile);
    assert.equal(handoff.routerSupervisorId, lifetime);
    assert.equal(handoff.generation, generation);
    assert.equal(handoff.restorePublicationState, 'ready');
    assert.equal(handoff.inactiveActivationId, stopped.activationId);
    assert.equal(handoff.inactiveSelectorDigest, stopped.selectorDigest);
    assert.equal(fs.statSync(handoffFile).mode & 0o777, 0o600);

    const second = await startServingRuntime(workspace, generation, { supervisorId: lifetime });
    const restored = loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace });
    assert.equal(restored.selector.generation, generation);
    assert.equal(restored.selector.publicationState, 'ready');
    assert.notEqual(restored.selector.activationId, activationId);
    assert.notEqual(restored.selector.activationId, stopped.activationId);
    assert.equal(readRouterRestartHandoff(handoffFile), null);
    assert.deepEqual(
        second.audits.filter((entry) => entry.event.startsWith('cloudflare-router-restart')).map((entry) => entry.event),
        ['cloudflare-router-restart-restore-pending', 'cloudflare-router-restart-restored'],
    );
    assert.equal(second.lease.acquisitions >= 1 && second.lease.acquisitions === second.lease.releases, true);

    // The replacement serves the restored generation, so its own restart
    // hands the same exact generation to the next replacement.
    await second.runtime.stop();
    assert.equal(readRouterRestartHandoff(handoffFile).routerSupervisorId, lifetime);
    const third = await startServingRuntime(workspace, generation, { supervisorId: lifetime });
    assert.equal(loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }).selector.generation, generation);
    await third.runtime.stop();
});

test('a new supervision lifetime never restores a stop from a previous Router lifetime', async (t) => {
    const { workspace, generation } = createLocalWorkspace(t);
    const first = await startServingRuntime(workspace, generation, { supervisorId: crypto.randomUUID() });
    await first.runtime.stop();
    const stopped = selectorOf(workspace);
    const handoffFile = routerRestartHandoffFile(workspace);
    assert.ok(readRouterRestartHandoff(handoffFile));

    const unrelated = startRuntime(workspace, { supervisorId: crypto.randomUUID() });
    await unrelated.runtime.scan();
    assert.deepEqual(selectorOf(workspace), stopped);
    assert.equal(readRouterRestartHandoff(handoffFile), null);
    assert.equal(
        unrelated.audits.find((entry) => entry.event === 'cloudflare-router-restart-restore-skipped')?.value.reason,
        'other-supervision-lifetime',
    );
    await unrelated.runtime.stop();
    assert.deepEqual(selectorOf(workspace), stopped, 'a Router that never served must not rewrite the selector');

    // A Router started without any Watchdog supervisor id never restores.
    applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'fixture-reapply' });
    const served = await startServingRuntime(workspace, generation, { supervisorId: crypto.randomUUID() });
    await served.runtime.stop();
    const shutdown = selectorOf(workspace);
    assert.ok(readRouterRestartHandoff(handoffFile));
    const initial = startRuntime(workspace);
    await initial.runtime.scan();
    assert.deepEqual(selectorOf(workspace), shutdown);
    assert.equal(readRouterRestartHandoff(handoffFile), null);
    await initial.runtime.stop();
    assert.deepEqual(selectorOf(workspace), shutdown);
});

test('a stop leaves an inactive failure selector untouched and hands nothing to restore', async (t) => {
    const { workspace, generation } = createLocalWorkspace(t);
    const lifetime = crypto.randomUUID();
    const first = await startServingRuntime(workspace, generation, { supervisorId: lifetime });
    // A real publication failure withdraws authorization while the Router
    // keeps running; its reason must survive the later Router stop.
    const failed = inactivateEdgeRoutingGeneration('cloudflare-error', { workspaceRoot: workspace });
    await first.runtime.stop();
    assert.deepEqual(selectorOf(workspace), failed);
    assert.equal(readRouterRestartHandoff(routerRestartHandoffFile(workspace)), null);

    const replacement = startRuntime(workspace, { supervisorId: lifetime });
    await replacement.runtime.scan();
    assert.deepEqual(selectorOf(workspace), failed);
    await replacement.runtime.stop();
    assert.deepEqual(selectorOf(workspace), failed);
});

test('a stop leaves a selected inactive candidate intact', async (t) => {
    const { workspace, generation } = createLocalWorkspace(t);
    const first = await startServingRuntime(workspace, generation, { supervisorId: crypto.randomUUID() });
    const candidate = applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'fixture-prepare',
        activate: false,
    });
    assert.equal(candidate.selector.state, 'inactive');
    assert.equal(candidate.selector.generation, generation);
    await first.runtime.stop();
    assert.deepEqual(selectorOf(workspace), candidate.selector);
    assert.equal(readRouterRestartHandoff(routerRestartHandoffFile(workspace)), null);
});

test('sources changed after the stop keep the generation inactive', async (t) => {
    const { workspace, generation } = createLocalWorkspace(t);
    const lifetime = crypto.randomUUID();
    const first = await startServingRuntime(workspace, generation, { supervisorId: lifetime });
    await first.runtime.stop();
    const stopped = selectorOf(workspace);
    fs.writeFileSync(path.join(workspace, '.ploinky', 'routing.json'), '{\n  "routes": {}\n}\n');

    const replacement = startRuntime(workspace, { supervisorId: lifetime });
    await replacement.runtime.scan();
    assert.deepEqual(selectorOf(workspace), stopped);
    const skipped = replacement.audits.find((entry) => entry.event === 'cloudflare-router-restart-restore-skipped');
    assert.equal(skipped?.value.reason, 'restore-failed');
    assert.equal(skipped?.value.code, 'EDGE_GENERATION_RACE');
    assert.equal(readRouterRestartHandoff(routerRestartHandoffFile(workspace)), null);
    await replacement.runtime.stop();
});

test('another selector decision after the stop supersedes the restore', async (t) => {
    const { workspace, generation } = createLocalWorkspace(t);
    const lifetime = crypto.randomUUID();
    const first = await startServingRuntime(workspace, generation, { supervisorId: lifetime });
    await first.runtime.stop();
    const operator = inactivateEdgeRoutingGeneration('cli-workspace-stop', { workspaceRoot: workspace });

    const replacement = startRuntime(workspace, { supervisorId: lifetime });
    await replacement.runtime.scan();
    assert.deepEqual(selectorOf(workspace), operator);
    assert.equal(
        replacement.audits.find((entry) => entry.event === 'cloudflare-router-restart-restore-skipped')?.value.reason,
        'superseded',
    );
    await replacement.runtime.stop();
});

test('a pending restore survives replacements that exit before restoring', async (t) => {
    const { workspace, generation } = createLocalWorkspace(t);
    const lifetime = crypto.randomUUID();
    const first = await startServingRuntime(workspace, generation, { supervisorId: lifetime });
    await first.runtime.stop();
    const stopped = selectorOf(workspace);
    const handoffFile = routerRestartHandoffFile(workspace);
    const handoff = readRouterRestartHandoff(handoffFile);

    // A replacement that exits before its listeners are ready never starts a
    // publication runtime and leaves the record exactly as it found it. The
    // next replacement of the same Watchdog must still restore it.
    const busy = leaseFixture();
    busy.busy = true;
    const second = startRuntime(workspace, { supervisorId: lifetime, lease: busy });
    await second.runtime.scan();
    await second.runtime.scan();
    assert.deepEqual(selectorOf(workspace), stopped, 'a busy workspace must defer, not consume, the restore');
    assert.deepEqual(readRouterRestartHandoff(handoffFile), handoff);
    await second.runtime.stop();
    assert.deepEqual(selectorOf(workspace), stopped);
    assert.deepEqual(readRouterRestartHandoff(handoffFile), handoff);

    const third = await startServingRuntime(workspace, generation, { supervisorId: lifetime });
    assert.equal(loadActiveEdgeRoutingGeneration({ workspaceRoot: workspace }).selector.generation, generation);
    assert.equal(readRouterRestartHandoff(handoffFile), null);
    await third.runtime.stop();
});

test('a Cloudflare generation is restored only as reconciling and an error generation is never restorable', async (t) => {
    const workspace = createConnectorOnlyWorkspace(t);
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'fixture-cloudflare-apply',
        publicationState: 'ready',
    });
    assert.equal(applied.generation.compiled.publication.mode, 'cloudflare');
    const stops = [];
    const coordinator = createEdgePublicationRouteCoordinator({
        workspaceRoot: workspace,
        edgeOps: fixtureEdgeOps(),
        onStopInactivation: (value) => stops.push(value),
    });
    const stopped = await coordinator.inactivateForStop({ configurationGeneration: applied.selector.generation });
    assert.equal(stopped.restorePublicationState, 'reconciling');
    assert.equal(stops.length, 1);
    assert.equal(
        await coordinator.inactivateForStop({ configurationGeneration: applied.selector.generation }),
        null,
        'a repeated stop must not rewrite the inactive selector',
    );

    const handoffFile = routerRestartHandoffFile(workspace);
    const handoff = writeRouterRestartHandoff(handoffFile, {
        routerSupervisorId: crypto.randomUUID(),
        generation: stopped.generation,
        restorePublicationState: stopped.restorePublicationState,
        inactiveActivationId: stopped.inactiveSelector.activationId,
        inactiveSelectorDigest: stopped.inactiveSelector.selectorDigest,
        stoppedAt: new Date().toISOString(),
    }, { trustedRoot: workspace });
    const restored = await coordinator.restoreRouterStop(handoff);
    assert.equal(restored.selector.generation, applied.selector.generation);
    assert.equal(restored.selector.publicationState, 'reconciling');
    await assert.rejects(
        coordinator.restoreRouterStop(handoff),
        (error) => error.code === 'CLOUDFLARE_ROUTER_RESTART_SUPERSEDED',
    );

    const failed = applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'fixture-cloudflare-error',
        publicationState: 'error',
    });
    const errorStop = await coordinator.inactivateForStop({ configurationGeneration: failed.selector.generation });
    assert.equal(errorStop.restorePublicationState, null);
});

test('a Router restart after a real Cloudflare publication failure stays fail-closed', async (t) => {
    const workspace = createConnectorOnlyWorkspace(t);
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'fixture-cloudflare-apply' });
    assert.equal(applied.selector.publicationState, 'reconciling');
    const connector = {
        async start() { throw new Error('the connector must not start without its credential'); },
        async stop() {},
        isRunning: () => false,
    };
    // The connector credential handle is unresolved, so publication fails
    // exactly as a real misconfigured or revoked tunnel token does.
    const controllerFactory = (options) => createCloudflarePublicationController({
        ...options,
        connector,
        secretStore: { readAll: () => ({}) },
    });
    const audits = [];
    const lifetime = crypto.randomUUID();
    const first = startRuntime(workspace, { audits, controllerFactory, supervisorId: lifetime });
    await waitFor(async () => {
        await first.runtime.scan();
        return audits.some((entry) => entry.event === 'cloudflare-error'
            && entry.value.code === 'CLOUDFLARE_CONNECTOR_SECRET_UNRESOLVED');
    }, 'the Cloudflare publication failure');
    const failed = selectorOf(workspace);
    assert.equal(failed.generation, applied.selector.generation);
    assert.equal(failed.publicationState, 'error');

    await first.runtime.stop();
    const stopped = selectorOf(workspace);
    assert.equal(stopped.state, 'inactive');
    assert.equal(readRouterRestartHandoff(routerRestartHandoffFile(workspace)), null);

    const replacement = startRuntime(workspace, { supervisorId: lifetime, controllerFactory });
    await replacement.runtime.scan();
    assert.deepEqual(selectorOf(workspace), stopped);
    await replacement.runtime.stop();
    assert.deepEqual(selectorOf(workspace), stopped);
});

test('a stop never rewrites an inactive failure captured by the publication coordinator', async (t) => {
    const workspace = createConnectorOnlyWorkspace(t);
    const applied = applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'fixture-cloudflare-apply',
        publicationState: 'ready',
    });
    const stops = [];
    const coordinator = createEdgePublicationRouteCoordinator({
        workspaceRoot: workspace,
        edgeOps: fixtureEdgeOps(),
        onStopInactivation: (value) => stops.push(value),
    });
    const configurationGeneration = applied.selector.generation;
    await coordinator.inactivate({ configurationGeneration, reason: 'selected-edge-generation' });
    await coordinator.inactivate({ configurationGeneration, reason: 'cloudflare-error' });
    const failed = selectorOf(workspace);
    assert.equal(failed.reason, 'cloudflare-error');
    assert.equal(await coordinator.inactivateForStop({ configurationGeneration }), null);
    assert.deepEqual(selectorOf(workspace), failed);
    assert.deepEqual(stops, []);
});

test('a replacement Router re-proves a restored Cloudflare generation before it is ready again', async (t) => {
    const workspace = createConnectorOnlyWorkspace(t);
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'fixture-cloudflare-apply' });
    const generation = applied.selector.generation;
    const probes = [];
    function publishingController() {
        let running = false;
        const connector = {
            starts: 0,
            async start() { connector.starts += 1; running = true; },
            async stop() { running = false; },
            isRunning: () => running,
        };
        const factory = (options) => createCloudflarePublicationController({
            ...options,
            connector,
            secretStore: { readAll: () => ({ 'publication/test-connector': 'fixture-connector-token' }) },
            probeHostname: async ({ hostname, configurationGeneration }) => {
                probes.push({ hostname, configurationGeneration });
                return { ok: true };
            },
        });
        return { connector, factory };
    }
    async function waitForReady(started) {
        await waitFor(async () => {
            await started.runtime.scan();
            const selector = selectorOf(workspace);
            return started.runtime.getStatus().state === 'ready'
                && selector.state === 'active'
                && selector.publicationState === 'ready';
        }, 'the Cloudflare publication to become ready');
    }

    const lifetime = crypto.randomUUID();
    const firstPublisher = publishingController();
    const first = startRuntime(workspace, { supervisorId: lifetime, controllerFactory: firstPublisher.factory });
    await waitForReady(first);
    assert.equal(firstPublisher.connector.starts, 1);
    await first.runtime.stop();
    assert.equal(firstPublisher.connector.isRunning(), false);
    assert.equal(selectorOf(workspace).state, 'inactive');
    assert.equal(readRouterRestartHandoff(routerRestartHandoffFile(workspace)).restorePublicationState, 'reconciling');

    const secondPublisher = publishingController();
    const second = startRuntime(workspace, { supervisorId: lifetime, controllerFactory: secondPublisher.factory });
    await waitForReady(second);
    const restored = second.audits.find((entry) => entry.event === 'cloudflare-router-restart-restored');
    assert.equal(restored?.value.generation, generation);
    assert.equal(restored?.value.publicationState, 'reconciling', 'public hosts must stay closed until re-proven');
    assert.equal(secondPublisher.connector.starts, 1, 'the replacement must start its own connector');
    assert.equal(probes.filter((entry) => entry.configurationGeneration === generation).length, 2);
    assert.equal(selectorOf(workspace).generation, generation);
    await second.runtime.stop();
});
