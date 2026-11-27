import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyLeaseOperation } from '../../cli/sandbox/activationRecords.mjs';
import { startCloudflarePublicationRuntime } from '../../ploinky-box/cloudflared/runtime.mjs';
import { performContainerRestart } from '../../cli/server/containerMonitor.js';

// Q30 live probe failure: under a held activation barrier the in-Box Router
// crashed in a loop. Its publication scan's lease was refused with M9 and the
// rejection escaped `void scan()` as an unhandled rejection. Long-lived
// processes must treat a barrier refusal like busy: defer and retry, never
// crash; publishing the active selector's routes is part of serving.

const GENERATION = `sha256:${'a'.repeat(64)}`;

function refusal() {
    return Object.assign(new Error('This workspace has an unsettled activation (restart cb31f65a); refused. [PLOINKY_ACTIVATION_RECOVERY_REQUIRED]'),
        { code: 'PLOINKY_ACTIVATION_RECOVERY_REQUIRED' });
}

test('publishing the active selector serves the kept version, so its lease is admitted under the marker', () => {
    assert.equal(classifyLeaseOperation('cloudflare-publication:a7fc6acf-fe5e-4376-bdc1-d5d1a7fa75b6'), 'admit');
    assert.equal(classifyLeaseOperation('cloudflare-publication:invalid-generation'), 'admit');
    assert.equal(classifyLeaseOperation('cloudflare-publication:router-restart-restore'), 'admit');
});

test('a refused publication lease defers the scan; nothing rejects and it publishes once the lease is free', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-q30-publication-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    let refused = true;
    let reconciliations = 0;
    const audits = [];
    const runtime = startCloudflarePublicationRuntime({
        workspaceRoot: workspace,
        statusFile: path.join(workspace, 'status.json'),
        pollIntervalMs: 60_000,
        loadActive: () => ({
            selector: { generation: GENERATION, activationId: 'activation-kept', publicationState: 'reconciling' },
            generation: { desired: { cloudflare: { tunnelId: 'fixture' }, hosts: {} } },
        }),
        createWorkspaceLease: () => {
            if (refused) throw refusal();
            return { token: 'publication-lease', operation: 'cloudflare-publication:activation-kept' };
        },
        releaseWorkspaceLease: () => true,
        routeCoordinatorFactory: () => ({ inactivate() {}, commit() {} }),
        controllerFactory: () => ({
            reconcile: async () => { reconciliations += 1; },
            getStatus: () => ({ state: 'fixture' }),
            stop: async () => {},
        }),
        probeHostname: async () => ({ ok: true }),
        audit: (event, value) => audits.push({ event, value }),
    });
    // The start-up scan ran already; let its promise settle.
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.scan();
    await runtime.scan();
    assert.equal(reconciliations, 0, 'no publication while the lease is refused');
    assert.deepEqual(unhandled, [], 'no unhandled rejection');
    assert.ok(audits.some((entry) => entry.event === 'cloudflare-workspace-lease-deferred'
        && entry.value.code === 'PLOINKY_ACTIVATION_RECOVERY_REQUIRED'), 'the deferral is audited');
    refused = false;
    await runtime.scan();
    assert.equal(reconciliations, 1, 'it publishes once the lease is admitted');
    await runtime.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
});

test('an unexpected scan failure is audited instead of escaping as an unhandled rejection', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-q30-publication-throw-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    const audits = [];
    const runtime = startCloudflarePublicationRuntime({
        workspaceRoot: workspace,
        statusFile: path.join(workspace, 'status.json'),
        pollIntervalMs: 60_000,
        loadActive: () => ({
            selector: { generation: GENERATION, activationId: 'activation-throw', publicationState: 'reconciling' },
            generation: { desired: { cloudflare: { tunnelId: 'fixture' }, hosts: {} } },
        }),
        createWorkspaceLease: () => { throw Object.assign(new Error('lease store exploded'), { code: 'EIO' }); },
        releaseWorkspaceLease: () => true,
        routeCoordinatorFactory: () => ({ inactivate() {}, commit() {} }),
        controllerFactory: () => ({ reconcile: async () => {}, getStatus: () => ({ state: 'fixture' }), stop: async () => {} }),
        probeHostname: async () => ({ ok: true }),
        audit: (event, value) => audits.push({ event, value }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, [], 'the start-up scan did not crash the process');
    assert.ok(audits.some((entry) => entry.event === 'cloudflare-publication-scan-failed' && entry.value.code === 'EIO'));
    await runtime.stop();
});

test('the Watchdog defers a restart whose lease the activation barrier refuses', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-q30-watchdog-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, '{}');
    let ensureCalls = 0;
    const events = [];
    const monitor = {
        readEdgeRoutingSelection: () => ({ selector: { state: 'inactive' } }),
        targets: new Map(),
        isShuttingDown: () => false,
        log(level, event, data) { events.push({ level, event, data }); },
        createWorkspaceMutationLease() { throw refusal(); },
        resolveRouterEndpoint: () => Object.freeze({ mode: 'default', host: 'host.containers.internal', port: 8123, url: 'http://host.containers.internal:8123' }),
        ensureAgentService() { ensureCalls += 1; },
    };
    const target = {
        containerName: 'agent_container', agentName: 'demo', repoName: 'repo', alias: null,
        type: 'agent', manifestPath, isRestarting: true,
    };
    await performContainerRestart(monitor, target, 'not_running');
    assert.equal(ensureCalls, 0);
    assert.equal(target.isRestarting, false);
    assert.ok(events.some((entry) => entry.event === 'container_restart_deferred_activation_recovery'));
});

// --- Delta review 2: R1 and R3 ------------------------------------------------

function publicationRuntime(t, { createWorkspaceLease, reconcile = async () => {}, pollIntervalMs = 60_000 }) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-q30-publication-r-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const audits = [];
    const runtime = startCloudflarePublicationRuntime({
        workspaceRoot: workspace,
        statusFile: path.join(workspace, 'status.json'),
        pollIntervalMs,
        retryInitialDelayMs: 1,
        retryMaximumDelayMs: 4,
        loadActive: () => ({
            selector: { generation: GENERATION, activationId: 'activation-retry', publicationState: 'reconciling' },
            generation: { desired: { cloudflare: { tunnelId: 'fixture' }, hosts: {} } },
        }),
        createWorkspaceLease,
        releaseWorkspaceLease: () => true,
        routeCoordinatorFactory: () => ({ inactivate() {}, commit() {} }),
        controllerFactory: () => ({ reconcile, getStatus: () => ({ state: 'fixture' }), stop: async () => {} }),
        probeHostname: async () => ({ ok: true }),
        audit: (event, value) => audits.push({ event, value }),
    });
    t.after(() => runtime.stop());
    return { runtime, audits };
}

async function until(predicate, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return true;
}

test('R1: a retry whose lease fails unexpectedly is retried again and then publishes', async (t) => {
    let leaseCalls = 0;
    let reconciliations = 0;
    const { audits } = publicationRuntime(t, {
        // The scan's lease succeeds; the first retry's lease hits a transient EIO.
        createWorkspaceLease: () => {
            leaseCalls += 1;
            if (leaseCalls === 2) throw Object.assign(new Error('transient lease read failure'), { code: 'EIO' });
            return { token: `lease-${leaseCalls}`, operation: 'cloudflare-publication:activation-retry' };
        },
        reconcile: async () => {
            reconciliations += 1;
            if (reconciliations === 1) throw Object.assign(new Error('publication failed once'), { code: 'CLOUDFLARE_API' });
        },
    });
    assert.equal(await until(() => reconciliations >= 2), true, 'the stalled retry was rescheduled and published');
    assert.ok(leaseCalls >= 3);
    assert.ok(audits.some((entry) => entry.event === 'cloudflare-workspace-lease-error' && entry.value.code === 'EIO'));
});

test('R3: a persistent scan error is audited once, not on every poll', async (t) => {
    const { audits } = publicationRuntime(t, {
        createWorkspaceLease: () => { throw Object.assign(new Error('lease store unreadable'), { code: 'EACCES' }); },
        pollIntervalMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    const failures = audits.filter((entry) => entry.event === 'cloudflare-publication-scan-failed');
    assert.equal(failures.length, 1, `audited ${failures.length} times`);
});

test('R3: a barrier deferral is audited again after an intervening busy lease', async (t) => {
    const outcomes = ['refused', 'busy', 'refused'];
    const { runtime, audits } = publicationRuntime(t, {
        createWorkspaceLease: () => {
            const outcome = outcomes.shift() || 'refused';
            if (outcome === 'busy') throw Object.assign(new Error('busy'), { code: 'PLOINKY_WORKSPACE_MUTATION_BUSY' });
            throw refusal();
        },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.scan();
    await runtime.scan();
    assert.equal(audits.filter((entry) => entry.event === 'cloudflare-workspace-lease-deferred').length, 2);
});
