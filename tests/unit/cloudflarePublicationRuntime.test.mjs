import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createEdgePublicationRouteCoordinator,
    createExternalHostnameProbe,
    startCloudflarePublicationRuntime,
} from '../../ploinky-box/cloudflared/runtime.mjs';

const GENERATION = `sha256:${'a'.repeat(64)}`;

test('edge publication coordinator commits only exact captured desired semantics and states', async () => {
    const desired = { hosts: {} };
    const calls = [];
    const committed = [];
    const edgeOps = {
        load() {
            return {
                selector: { generation: GENERATION },
                generation: { desired },
            };
        },
        inactivate(reason) { calls.push(['inactivate', reason]); },
        apply(options) {
            calls.push(['apply', options.publicationState, options.expectedGeneration]);
            return {
                selector: { generation: GENERATION, activationId: 'activation-ready' },
                generation: { desired },
            };
        },
    };
    const coordinator = createEdgePublicationRouteCoordinator({
        workspaceRoot: '/fixture',
        edgeOps,
        onCommit: (id) => committed.push(id),
    });
    await coordinator.inactivate({ configurationGeneration: GENERATION, reason: 'test' });
    await coordinator.commit({
        mode: 'local-only',
        publicationState: 'ready',
        configurationGeneration: GENERATION,
        hosts: {},
    });
    assert.deepEqual(calls, [['inactivate', 'test'], ['apply', 'ready', GENERATION]]);
    assert.deepEqual(committed, ['activation-ready']);
    await assert.rejects(() => coordinator.commit({
        mode: 'cloudflare',
        publicationState: 'ready',
        configurationGeneration: GENERATION,
        hosts: {},
    }), /does not match captured desired semantics/);
});

test('edge publication coordinator retries only a busy pre-mutation apply and commits once', async () => {
    const desired = { hosts: {} };
    const busy = Object.assign(new Error('edge generation apply is already in progress'), {
        code: 'EDGE_GENERATION_BUSY',
    });
    const calls = [];
    const waits = [];
    const committed = [];
    let applyAttempts = 0;
    const edgeOps = {
        load() {
            return {
                selector: { generation: GENERATION },
                generation: { desired },
            };
        },
        inactivate(reason) { calls.push(['inactivate', reason]); },
        apply(options) {
            applyAttempts += 1;
            calls.push(['apply', options.publicationState, options.expectedGeneration]);
            if (applyAttempts < 3) throw busy;
            return {
                selector: { generation: GENERATION, activationId: 'activation-ready' },
                generation: { desired },
            };
        },
    };
    const coordinator = createEdgePublicationRouteCoordinator({
        workspaceRoot: '/fixture',
        edgeOps,
        edgeApplyBusyRetryAttempts: 3,
        edgeApplyBusyRetryDelayMs: 7,
        sleep: async (delayMs) => { waits.push(delayMs); },
        onCommit: (id) => committed.push(id),
    });

    await coordinator.inactivate({ configurationGeneration: GENERATION, reason: 'test' });
    await coordinator.commit({
        mode: 'local-only',
        publicationState: 'ready',
        configurationGeneration: GENERATION,
        hosts: {},
    });

    assert.equal(applyAttempts, 3);
    assert.deepEqual(waits, [7, 7]);
    assert.deepEqual(
        calls.filter(([operation]) => operation === 'inactivate'),
        [['inactivate', 'test']],
        'a transient busy apply must not trigger fail-closed inactivation',
    );
    assert.deepEqual(committed, ['activation-ready']);
});

test('edge publication coordinator fails closed after bounded busy retries', async () => {
    const desired = { hosts: {} };
    const busy = Object.assign(new Error('edge generation apply is already in progress'), {
        code: 'EDGE_GENERATION_BUSY',
    });
    const inactivations = [];
    let applyAttempts = 0;
    let waits = 0;
    const edgeOps = {
        load() {
            return {
                selector: { generation: GENERATION },
                generation: { desired },
            };
        },
        inactivate(reason) { inactivations.push(reason); },
        apply() {
            applyAttempts += 1;
            throw busy;
        },
    };
    const coordinator = createEdgePublicationRouteCoordinator({
        workspaceRoot: '/fixture',
        edgeOps,
        edgeApplyBusyRetryAttempts: 3,
        edgeApplyBusyRetryDelayMs: 0,
        sleep: async () => { waits += 1; },
    });

    await coordinator.inactivate({ configurationGeneration: GENERATION, reason: 'test' });
    await assert.rejects(
        coordinator.commit({
            mode: 'local-only',
            publicationState: 'ready',
            configurationGeneration: GENERATION,
            hosts: {},
        }),
        (error) => error === busy,
    );
    assert.equal(applyAttempts, 3);
    assert.equal(waits, 2);
    assert.deepEqual(inactivations, ['test', 'publication-commit-failed']);
});

test('edge publication coordinator does not retry generation or connector identity drift', async () => {
    const desired = {
        cloudflare: { tunnelTokenSecret: 'publication/cloudflare-connector' },
        hosts: { 'app.example.test': { routeKey: 'app' } },
    };
    const changedDesired = {
        cloudflare: { tunnelTokenSecret: 'publication/different-connector' },
        hosts: desired.hosts,
    };
    const busy = Object.assign(new Error('edge generation apply is already in progress'), {
        code: 'EDGE_GENERATION_BUSY',
    });
    let applyAttempts = 0;
    let waits = 0;
    const inactivations = [];
    const edgeOps = {
        load() {
            return {
                selector: { generation: GENERATION },
                generation: { desired },
            };
        },
        inactivate(reason) { inactivations.push(reason); },
        apply() {
            applyAttempts += 1;
            if (applyAttempts === 1) throw busy;
            return {
                selector: { generation: GENERATION, activationId: 'activation-drifted' },
                generation: { desired: changedDesired },
            };
        },
    };
    const coordinator = createEdgePublicationRouteCoordinator({
        workspaceRoot: '/fixture',
        edgeOps,
        edgeApplyBusyRetryAttempts: 5,
        sleep: async () => { waits += 1; },
    });

    await coordinator.inactivate({ configurationGeneration: GENERATION, reason: 'test' });
    await assert.rejects(
        coordinator.commit({
            mode: 'cloudflare',
            publicationState: 'ready',
            configurationGeneration: GENERATION,
            hosts: desired.hosts,
        }),
        /edge sources changed before publication commit/,
    );
    assert.equal(applyAttempts, 2);
    assert.equal(waits, 1);
    assert.deepEqual(inactivations, ['test', 'publication-commit-failed']);
});

test('edge publication coordinator fails immediately when a busy retry observes generation drift', async () => {
    const desired = { hosts: {} };
    const busy = Object.assign(new Error('edge generation apply is already in progress'), {
        code: 'EDGE_GENERATION_BUSY',
    });
    const race = Object.assign(new Error('edge routing sources no longer match'), {
        code: 'EDGE_GENERATION_RACE',
    });
    let applyAttempts = 0;
    let waits = 0;
    const edgeOps = {
        load() {
            return {
                selector: { generation: GENERATION },
                generation: { desired },
            };
        },
        inactivate() {},
        apply(options) {
            assert.equal(options.expectedGeneration, GENERATION);
            applyAttempts += 1;
            if (applyAttempts === 1) throw busy;
            throw race;
        },
    };
    const coordinator = createEdgePublicationRouteCoordinator({
        workspaceRoot: '/fixture',
        edgeOps,
        edgeApplyBusyRetryAttempts: 5,
        sleep: async () => { waits += 1; },
    });

    await coordinator.inactivate({ configurationGeneration: GENERATION, reason: 'test' });
    await assert.rejects(
        coordinator.commit({
            mode: 'local-only',
            publicationState: 'ready',
            configurationGeneration: GENERATION,
            hosts: {},
        }),
        (error) => error === race,
    );
    assert.equal(applyAttempts, 2);
    assert.equal(waits, 1);
});

test('edge publication coordinator permits error only for the exact captured Cloudflare generation', async () => {
    const hosts = {
        'app.example.test': {
            agent: 'repo/app',
        },
    };
    const desired = {
        cloudflare: {
            tunnelTokenSecret: 'publication/cloudflare-connector',
        },
        hosts,
    };
    const applied = [];
    const edgeOps = {
        load() {
            return {
                selector: { generation: GENERATION },
                generation: { desired },
            };
        },
        inactivate() {},
        apply(options) {
            applied.push(options);
            return {
                selector: { generation: GENERATION, activationId: 'activation-error' },
                generation: { desired },
            };
        },
    };
    const coordinator = createEdgePublicationRouteCoordinator({
        workspaceRoot: '/fixture',
        edgeOps,
    });
    await coordinator.inactivate({ configurationGeneration: GENERATION, reason: 'test' });
    await coordinator.commit({
        mode: 'cloudflare',
        publicationState: 'error',
        configurationGeneration: GENERATION,
        hosts,
    });
    assert.equal(applied.at(-1).publicationState, 'error');

    await assert.rejects(() => coordinator.commit({
        mode: 'cloudflare',
        publicationState: 'error',
        configurationGeneration: `sha256:${'b'.repeat(64)}`,
        hosts,
    }), /outside its captured immutable generation/);
    await assert.rejects(() => coordinator.commit({
        mode: 'local-only',
        publicationState: 'error',
        configurationGeneration: GENERATION,
        hosts,
    }), /does not match captured desired semantics/);
    await assert.rejects(() => coordinator.commit({
        mode: 'cloudflare',
        publicationState: 'error',
        configurationGeneration: GENERATION,
        hosts: {},
    }), /does not match captured desired semantics/);
});

test('edge publication coordinator commits API-managed empty hosts as local-only teardown', async () => {
    const desired = {
        cloudflare: {
            accountId: 'account',
            zoneId: 'zone',
            tunnelName: 'qa',
            apiTokenSecret: 'publication/cloudflare-api',
            deleteTunnelOnTeardown: true,
        },
        hosts: {},
    };
    const applied = [];
    const edgeOps = {
        load() {
            return {
                selector: { generation: GENERATION },
                generation: { desired },
            };
        },
        inactivate() {},
        apply(options) {
            applied.push(options);
            return {
                selector: { generation: GENERATION, activationId: 'activation-local-only' },
                generation: { desired },
            };
        },
    };
    const coordinator = createEdgePublicationRouteCoordinator({
        workspaceRoot: '/fixture',
        edgeOps,
    });

    await coordinator.inactivate({ configurationGeneration: GENERATION, reason: 'teardown' });
    await coordinator.commit({
        mode: 'local-only',
        publicationState: 'ready',
        configurationGeneration: GENERATION,
        hosts: {},
    });

    assert.equal(applied.at(-1).publicationState, 'ready');
});

test('edge publication coordinator rejects error for a captured local-only generation', async () => {
    const desired = { hosts: {} };
    const edgeOps = {
        load() {
            return {
                selector: { generation: GENERATION },
                generation: { desired },
            };
        },
        inactivate() {},
        apply() { assert.fail('local-only error must not apply'); },
    };
    const coordinator = createEdgePublicationRouteCoordinator({
        workspaceRoot: '/fixture',
        edgeOps,
    });
    await coordinator.inactivate({ configurationGeneration: GENERATION, reason: 'test' });
    await assert.rejects(() => coordinator.commit({
        mode: 'local-only',
        publicationState: 'error',
        configurationGeneration: GENERATION,
        hosts: {},
    }), /does not match captured desired semantics/);
});

test('publication retry rejects a different inactive selected candidate before remote reconciliation', async () => {
    const newerGeneration = `sha256:${'b'.repeat(64)}`;
    let inactive = false;
    let selectedGeneration = GENERATION;
    let inactivationCount = 0;
    const desired = { hosts: {} };
    const edgeOps = {
        load() {
            if (inactive) throw Object.assign(new Error('inactive'), { code: 'EDGE_GENERATION_INACTIVE' });
            return { selector: { generation: selectedGeneration }, generation: { desired } };
        },
        selection() {
            return {
                selector: {
                    state: 'inactive',
                    generation: selectedGeneration,
                    previousGeneration: GENERATION,
                },
            };
        },
        inactivate() {
            inactivationCount += 1;
            inactive = true;
        },
        apply() { assert.fail('stale inactive selection must never be applied'); },
    };
    const coordinator = createEdgePublicationRouteCoordinator({ workspaceRoot: '/fixture', edgeOps });
    await coordinator.inactivate({ configurationGeneration: GENERATION, reason: 'initial' });
    selectedGeneration = newerGeneration;
    await assert.rejects(
        () => coordinator.inactivate({ configurationGeneration: GENERATION, reason: 'retry' }),
        /not the exact selected inactive generation/,
    );
    assert.equal(inactivationCount, 1);
});

test('external hostname proof requires exact inactive generation response through HTTPS host', async () => {
    const seen = [];
    const probe = createExternalHostnameProbe({
        fetchImpl: async (url, options) => {
            seen.push({ url, options });
            return new Response(JSON.stringify({ error: 'HOST_SELECTOR_INACTIVE' }), {
                status: 503,
                headers: { 'X-Ploinky-Edge-Generation': GENERATION },
            });
        },
    });
    assert.deepEqual(await probe({
        hostname: 'app.example.test',
        configurationGeneration: GENERATION,
    }), { ok: true, status: 503 });
    assert.match(seen[0].url, /^https:\/\/app\.example\.test\//);
    assert.equal(seen[0].options.redirect, 'manual');

    const wrong = createExternalHostnameProbe({
        fetchImpl: async () => new Response(JSON.stringify({ error: 'HOST_SELECTOR_INACTIVE' }), {
            status: 503,
            headers: { 'X-Ploinky-Edge-Generation': `sha256:${'b'.repeat(64)}` },
        }),
    });
    assert.equal((await wrong({
        hostname: 'app.example.test',
        configurationGeneration: GENERATION,
    })).ok, false);
});

test('runtime startup replaces stale persisted readiness before scanning a generation', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-publication-runtime-stale-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const statusFile = path.join(workspace, 'status.json');
    fs.writeFileSync(statusFile, JSON.stringify({
        mode: 'cloudflare',
        management: 'connector-only',
        state: 'ready',
        connectorState: 'running',
        configurationGeneration: GENERATION,
        desiredDigest: `sha256:${'b'.repeat(64)}`,
        hostnames: ['stale.example.test'],
    }));
    const inactive = Object.assign(new Error('inactive'), { code: 'EDGE_GENERATION_INACTIVE' });
    const runtime = startCloudflarePublicationRuntime({
        workspaceRoot: workspace,
        statusFile,
        pollIntervalMs: 60_000,
        loadActive: () => { throw inactive; },
        routeCoordinatorFactory: () => ({ inactivate() {}, commit() {} }),
        controllerFactory: () => ({
            reconcile: async () => assert.fail('inactive startup must not reconcile'),
            getStatus: () => ({ state: 'fixture' }),
            stop: async () => {},
        }),
        probeHostname: async () => ({ ok: true }),
        audit: () => {},
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(statusFile, 'utf8')), {
        mode: 'local-only',
        management: null,
        state: 'unstarted',
        connectorState: 'absent',
        configurationGeneration: '',
        desiredDigest: '',
        hostnames: [],
    });
    await runtime.stop();
});

test('publication runtime reconciles each successful selected activation once and stops its one controller', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-publication-runtime-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    let selected = null;
    let reconciliations = 0;
    const inputs = [];
    let stops = 0;
    const inactive = Object.assign(new Error('inactive'), { code: 'EDGE_GENERATION_INACTIVE' });
    const runtime = startCloudflarePublicationRuntime({
        workspaceRoot: workspace,
        statusFile: path.join(workspace, 'status.json'),
        pollIntervalMs: 60_000,
        loadActive: () => {
            if (!selected) throw inactive;
            return selected;
        },
        routeCoordinatorFactory: () => ({ inactivate() {}, commit() {} }),
        controllerFactory: () => ({
            reconcile: async (input) => {
                reconciliations += 1;
                inputs.push(structuredClone(input));
            },
            getStatus: () => ({ state: 'fixture' }),
            stop: async () => { stops += 1; },
        }),
        probeHostname: async () => ({ ok: true }),
        audit: () => {},
    });
    selected = {
        selector: {
            generation: GENERATION,
            activationId: 'activation-one',
            publicationState: 'ready',
        },
        generation: { desired: { hosts: {} } },
    };
    await runtime.scan();
    await runtime.scan();
    assert.equal(reconciliations, 1);
    selected = {
        ...selected,
        selector: { ...selected.selector, activationId: 'activation-two' },
    };
    await runtime.scan();
    assert.equal(reconciliations, 2);
    assert.equal(inputs[0].selectedPublicationState, 'ready');
    assert.deepEqual(runtime.getStatus(), { state: 'fixture' });
    await runtime.stop();
    assert.equal(stops, 1);
});

test('workspace start contention defers publication without consuming the selected activation', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-publication-runtime-start-race-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    let selected = null;
    let workspaceBusy = true;
    let reconciliations = 0;
    let releases = 0;
    const inactive = Object.assign(new Error('inactive'), { code: 'EDGE_GENERATION_INACTIVE' });
    const runtime = startCloudflarePublicationRuntime({
        workspaceRoot: workspace,
        statusFile: path.join(workspace, 'status.json'),
        pollIntervalMs: 60_000,
        loadActive: () => {
            if (!selected) throw inactive;
            return selected;
        },
        createWorkspaceLease: () => {
            if (workspaceBusy) {
                throw Object.assign(new Error('workspace start active'), {
                    code: 'PLOINKY_WORKSPACE_MUTATION_BUSY',
                });
            }
            return { token: 'publication-lease', operation: 'cloudflare-publication:activation-race' };
        },
        releaseWorkspaceLease: (lease) => {
            assert.equal(lease.token, 'publication-lease');
            releases += 1;
            return true;
        },
        routeCoordinatorFactory: () => ({ inactivate() {}, commit() {} }),
        controllerFactory: () => ({
            reconcile: async () => { reconciliations += 1; },
            getStatus: () => ({ state: 'fixture' }),
            stop: async () => {},
        }),
        probeHostname: async () => ({ ok: true }),
        audit: () => {},
    });
    selected = {
        selector: {
            generation: GENERATION,
            activationId: 'activation-race',
            publicationState: 'reconciling',
        },
        generation: { desired: { cloudflare: { tunnelId: 'fixture' }, hosts: {} } },
    };

    await runtime.scan();
    assert.equal(reconciliations, 0, 'publication must not mutate while workspace start owns the lease');
    workspaceBusy = false;
    await runtime.scan();
    assert.equal(reconciliations, 1, 'the unconsumed activation must reconcile after workspace start releases');
    assert.equal(releases, 1);
    await runtime.stop();
});

test('invalid selected-generation cleanup holds the shared workspace lease', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-publication-runtime-invalid-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    let heldLease = null;
    let invalidations = 0;
    const runtime = startCloudflarePublicationRuntime({
        workspaceRoot: workspace,
        statusFile: path.join(workspace, 'status.json'),
        pollIntervalMs: 60_000,
        loadActive: () => {
            throw Object.assign(new Error('corrupt generation'), { code: 'EDGE_GENERATION_CORRUPT' });
        },
        createWorkspaceLease: ({ operation }) => {
            assert.equal(heldLease, null);
            heldLease = { token: `lease-${invalidations}`, operation };
            return heldLease;
        },
        releaseWorkspaceLease: (lease) => {
            assert.equal(lease, heldLease);
            heldLease = null;
            return true;
        },
        inactivateInvalidGeneration: (reason) => {
            assert.ok(heldLease, 'invalid-generation inactivation must run inside the workspace lease');
            assert.equal(reason, 'publication-generation-invalid');
            invalidations += 1;
        },
        routeCoordinatorFactory: () => ({ inactivate() {}, commit() {} }),
        controllerFactory: () => ({
            reconcile: async () => assert.fail('corrupt generation must not reconcile'),
            getStatus: () => ({ state: 'fixture' }),
            stop: async () => {},
        }),
        probeHostname: async () => ({ ok: true }),
        audit: () => {},
    });
    await runtime.scan();
    assert.ok(invalidations >= 1);
    assert.equal(heldLease, null);
    await runtime.stop();
});

test('publication holds the shared workspace lease through the complete asynchronous reconciliation', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-publication-runtime-lease-span-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    let selected = null;
    let heldLease = null;
    let releaseReconcile;
    let markStarted;
    const reconcileStarted = new Promise((resolve) => { markStarted = resolve; });
    const continueReconcile = new Promise((resolve) => { releaseReconcile = resolve; });
    const acquire = ({ operation }) => {
        if (heldLease) {
            throw Object.assign(new Error('workspace mutation active'), {
                code: 'PLOINKY_WORKSPACE_MUTATION_BUSY',
            });
        }
        heldLease = { token: 'publication-span', operation };
        return heldLease;
    };
    const runtime = startCloudflarePublicationRuntime({
        workspaceRoot: workspace,
        statusFile: path.join(workspace, 'status.json'),
        pollIntervalMs: 60_000,
        loadActive: () => {
            if (!selected) throw Object.assign(new Error('inactive'), { code: 'EDGE_GENERATION_INACTIVE' });
            return selected;
        },
        createWorkspaceLease: acquire,
        releaseWorkspaceLease: (lease) => {
            assert.equal(lease, heldLease);
            heldLease = null;
            return true;
        },
        routeCoordinatorFactory: () => ({ inactivate() {}, commit() {} }),
        controllerFactory: () => ({
            reconcile: async () => {
                markStarted();
                await continueReconcile;
            },
            getStatus: () => ({ state: 'fixture' }),
            stop: async () => {},
        }),
        probeHostname: async () => ({ ok: true }),
        audit: () => {},
    });
    selected = {
        selector: {
            generation: GENERATION,
            activationId: 'activation-span',
            publicationState: 'reconciling',
        },
        generation: { desired: { cloudflare: { tunnelId: 'fixture' }, hosts: {} } },
    };

    const scan = runtime.scan();
    await reconcileStarted;
    assert.match(heldLease.operation, /^cloudflare-publication:/);
    assert.throws(
        () => acquire({ operation: 'workspace-start' }),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY',
    );
    releaseReconcile();
    await scan;
    assert.equal(heldLease, null);
    await runtime.stop();
});

test('publication runtime retries a failed selected activation without changing desired mode', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-publication-runtime-retry-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    let selected = null;
    const inputs = [];
    const reasons = [];
    const inactive = Object.assign(new Error('inactive'), { code: 'EDGE_GENERATION_INACTIVE' });
    let releaseRetry;
    const retryCompleted = new Promise(resolve => { releaseRetry = resolve; });
    const runtime = startCloudflarePublicationRuntime({
        workspaceRoot: workspace,
        statusFile: path.join(workspace, 'status.json'),
        pollIntervalMs: 60_000,
        retryInitialDelayMs: 1,
        retryMaximumDelayMs: 2,
        loadActive: () => {
            if (!selected) throw inactive;
            return selected;
        },
        routeCoordinatorFactory: () => ({ inactivate() {}, commit() {} }),
        controllerFactory: () => ({
            reconcile: async (input, options) => {
                inputs.push(structuredClone(input));
                reasons.push(options?.reason);
                if (inputs.length === 1) {
                    // The real controller inactivates the selector before it
                    // reports a failed reconciliation. Retry must retain its
                    // captured desired state even though active loading now
                    // fails closed.
                    selected = null;
                    throw Object.assign(new Error('transient fixture failure'), { code: 'TRANSIENT_FIXTURE' });
                }
                releaseRetry();
            },
            getStatus: () => ({ state: 'fixture' }),
            stop: async () => {},
        }),
        probeHostname: async () => ({ ok: true }),
        audit: () => {},
    });
    selected = {
        selector: {
            generation: GENERATION,
            activationId: 'activation-retry',
            publicationState: 'reconciling',
        },
        generation: {
            desired: {
                cloudflare: { tunnelId: 'fixture-tunnel' },
                hosts: { 'app.example.test': { routeKey: 'demo' } },
            },
        },
    };
    await runtime.scan();
    await Promise.race([
        retryCompleted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('retry did not run')), 1_000)),
    ]);
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs[1], inputs[0]);
    assert.deepEqual(reasons, ['selected-edge-generation', 'selected-edge-generation-retry']);
    assert.equal(inputs[1].selectedPublicationState, 'reconciling');
    assert.deepEqual(inputs[1].cloudflare, { tunnelId: 'fixture-tunnel' });
    await runtime.stop();
});

test('publication runtime follows connector error commits across bounded retry activations', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-publication-runtime-error-retry-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const desired = {
        cloudflare: {
            tunnelTokenSecret: 'publication/cloudflare-connector',
        },
        hosts: {
            'app.example.test': {
                agent: 'repo/app',
            },
        },
    };
    let selected = {
        selector: {
            generation: GENERATION,
            activationId: 'activation-initial',
            publicationState: 'reconciling',
        },
        generation: { desired },
    };
    let attempts = 0;
    let completed;
    const completion = new Promise((resolve) => { completed = resolve; });
    const runtime = startCloudflarePublicationRuntime({
        workspaceRoot: workspace,
        statusFile: path.join(workspace, 'status.json'),
        pollIntervalMs: 60_000,
        retryInitialDelayMs: 1,
        retryMaximumDelayMs: 2,
        loadActive: () => selected,
        routeCoordinatorFactory: () => ({ inactivate() {}, commit() {} }),
        controllerFactory: () => ({
            reconcile: async () => {
                attempts += 1;
                if (attempts < 3) {
                    selected = {
                        ...selected,
                        selector: {
                            ...selected.selector,
                            activationId: `activation-error-${attempts}`,
                            publicationState: 'error',
                        },
                    };
                    throw Object.assign(new Error('connector fixture failed'), {
                        code: 'CLOUDFLARE_HOST_PROBE_FAILED',
                    });
                }
                completed();
            },
            getStatus: () => ({ state: 'fixture' }),
            stop: async () => {},
        }),
        probeHostname: async () => ({ ok: true }),
        audit: () => {},
    });
    await runtime.scan();
    await Promise.race([
        completion,
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('error-activation retry did not converge')),
            1_000,
        )),
    ]);
    assert.equal(attempts, 3);
    await runtime.stop();
});

test('publication runtime retries a failed handled reconciling activation without a later route activation', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-publication-runtime-reconciling-retry-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const desired = {
        cloudflare: {
            tunnelTokenSecret: 'publication/cloudflare-connector',
        },
        hosts: {
            'app.example.test': {
                agent: 'repo/app',
            },
        },
    };
    let selected = {
        selector: {
            generation: GENERATION,
            activationId: 'activation-initial',
            publicationState: 'reconciling',
        },
        generation: { desired },
    };
    let rememberActivation = () => {};
    let attempts = 0;
    const reasons = [];
    const audits = [];
    let completed;
    const completion = new Promise((resolve) => { completed = resolve; });
    const runtime = startCloudflarePublicationRuntime({
        workspaceRoot: workspace,
        statusFile: path.join(workspace, 'status.json'),
        pollIntervalMs: 60_000,
        retryInitialDelayMs: 1,
        retryMaximumDelayMs: 2,
        loadActive: () => selected,
        routeCoordinatorFactory: ({ onCommit }) => {
            rememberActivation = onCommit;
            return { inactivate() {}, commit() {} };
        },
        controllerFactory: () => ({
            reconcile: async (_input, options) => {
                attempts += 1;
                reasons.push(options?.reason);
                if (attempts < 3) {
                    selected = {
                        ...selected,
                        selector: {
                            ...selected.selector,
                            activationId: `activation-reconciling-commit-${attempts}`,
                            publicationState: 'reconciling',
                        },
                    };
                    rememberActivation(selected.selector.activationId);
                    throw Object.assign(new Error('external hostname proof failed'), {
                        code: 'CLOUDFLARE_HOST_PROBE_FAILED',
                    });
                }
                completed();
            },
            getStatus: () => ({ state: 'fixture' }),
            stop: async () => {},
        }),
        probeHostname: async () => ({ ok: true }),
        audit: (event, value) => audits.push({ event, value }),
    });
    await runtime.scan();
    await Promise.race([
        completion,
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('handled reconciling activation retry did not run')),
            1_000,
        )),
    ]);
    assert.equal(attempts, 3);
    assert.deepEqual(reasons, [
        'selected-edge-generation',
        'selected-edge-generation-retry',
        'selected-edge-generation-retry',
    ]);
    assert.deepEqual(
        audits
            .filter((entry) => entry.event === 'cloudflare-publication-runtime-error')
            .map((entry) => entry.value.retryAttempt ?? null),
        [null, 1],
    );
    await runtime.stop();
});

test('a newer selected activation cancels an older scheduled publication retry', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-publication-runtime-supersede-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    let selected = null;
    const activationInputs = [];
    const inactive = Object.assign(new Error('inactive'), { code: 'EDGE_GENERATION_INACTIVE' });
    const runtime = startCloudflarePublicationRuntime({
        workspaceRoot: workspace,
        statusFile: path.join(workspace, 'status.json'),
        pollIntervalMs: 60_000,
        retryInitialDelayMs: 50,
        retryMaximumDelayMs: 50,
        loadActive: () => {
            if (!selected) throw inactive;
            return selected;
        },
        routeCoordinatorFactory: () => ({ inactivate() {}, commit() {} }),
        controllerFactory: () => ({
            reconcile: async (input) => {
                activationInputs.push(input.configurationGeneration);
                if (input.configurationGeneration === GENERATION) throw new Error('old activation failed');
            },
            getStatus: () => ({ state: 'fixture' }),
            stop: async () => {},
        }),
        probeHostname: async () => ({ ok: true }),
        audit: () => {},
    });
    selected = {
        selector: { generation: GENERATION, activationId: 'activation-old', publicationState: 'reconciling' },
        generation: { desired: { cloudflare: { tunnelId: 'old' }, hosts: {} } },
    };
    await runtime.scan();
    const newerGeneration = `sha256:${'b'.repeat(64)}`;
    selected = {
        selector: { generation: newerGeneration, activationId: 'activation-new', publicationState: 'reconciling' },
        generation: { desired: { cloudflare: { tunnelId: 'new' }, hosts: {} } },
    };
    await runtime.scan();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(activationInputs, [GENERATION, newerGeneration]);
    await runtime.stop();
});
