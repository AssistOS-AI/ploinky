import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { createMemoryUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';
import { PERMISSIVE_HOST_STATE_GUARD } from '../helpers/hostStateFixture.mjs';

// Q30 AC5: H1 and H13 written against seams that exist before Q30 and with
// raw JSON fixtures, so the same file runs at the base (where the host stops
// and rolls back a graph that is already serving) and on the candidate
// (where the graph is kept). The first assertion names the defect.

const BOX = 'a'.repeat(64);

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

function sealed(body) {
    const digest = `sha256:${crypto.createHash('sha256').update(Buffer.from(JSON.stringify(stableValue(body)))).digest('hex')}`;
    return { ...body, selectorDigest: digest };
}

function identityOf(selector) {
    return { state: selector.state, generation: selector.generation ?? null, activationId: selector.activationId, selectorDigest: selector.selectorDigest };
}

function scenario(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-q30-base-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const edge = path.join(workspace, '.ploinky', 'data', 'edge-routing');
    fs.mkdirSync(edge, { recursive: true, mode: 0o700 });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const selection = agentLibFixture(workspace);
    const stopCalls = [];
    const events = [];
    const health = { failures: [] };
    const writeSelector = (selector) => fs.writeFileSync(path.join(edge, 'active.json'), JSON.stringify(selector), { mode: 0o600 });
    // The in-Box restart: inactivate, write the intent (when the host passed
    // a context), rename the new selector in, then end with `status`.
    const inBoxRestart = (status) => async (_engine, _id, argv, _hostPort, _mediaPort, _runner, options) => {
        events.push(['core', [...argv]]);
        const predecessor = sealed({
            schemaVersion: 1, state: 'inactive', generation: `sha256:${'0'.repeat(64)}`,
            previousGeneration: `sha256:${'0'.repeat(64)}`, reason: 'cli-workspace-restart',
            activationId: crypto.randomUUID(), changedAt: new Date().toISOString(),
        });
        writeSelector(predecessor);
        const intended = sealed({
            schemaVersion: 1, state: 'active', generation: `sha256:${'1'.repeat(64)}`, publicationState: 'ready',
            activationId: crypto.randomUUID(), activatedAt: new Date().toISOString(),
        });
        const context = options?.activationContext;
        if (context) {
            const activations = path.join(edge, 'activations');
            fs.mkdirSync(activations, { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(activations, `${context.operationId}.intent.json`), `${JSON.stringify({
                schema: 'ploinky-activation-intent', version: 1, operationId: context.operationId, context,
                intended: identityOf(intended), predecessor: identityOf(predecessor), policyStaged: false,
                recordedAt: new Date().toISOString(),
            })}\n`, { mode: 0o600 });
        }
        writeSelector(intended);
        return {
            cause: 'exited', status, signal: null, clientExited: true, escalation: null,
            tails: { stdout: '', stderr: status ? 'start: workspace activated; settlement requires recovery' : '' },
            quiescence: { state: 'confirmed', method: 'fixture' },
        };
    };
    const prepared = {
        action: 'reused',
        ownership: { state: 'owned', engine: { name: 'podman', identity: 'engine' }, handles: { container: { id: BOX, runtime: { running: true } } } },
        hostPort: 8080,
        mediaHostPort: 7882,
        previousAgentLib: selection,
        validate() {},
        finalize() {},
        async rollback() {
            events.push('rollback');
            return { action: 'reused-preserved', containerId: BOX, hostPort: 8080, mediaHostPort: 7882, agentLib: selection };
        },
    };
    const build = (status) => createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => identity,
        launchCwd: workspace,
        lockManager: { async acquire() { return { assertHeld() {}, release() {} }; } },
        discover: () => ({ state: 'owned', engine: { name: 'podman', identity: 'engine' }, handles: { container: { id: BOX, runtime: { running: false } } } }),
        repositoryRoot: root,
        env: {},
        stdout: { write() { return true; } },
        stderr: { write() { return true; } },
        updateHostState: createMemoryUpdateHostState(),
        runner: {
            run(_command, args) { if (args.includes('/opt/ploinky/bin/ploinky-local') && args.at(-1) === 'stop') stopCalls.push(args); },
            query: () => ({ ok: true, stdout: JSON.stringify({ initialized: true, routingConfigured: true }) }),
        },
        captureCoreStartArgv: () => ['start', 'agent', '8080'],
        selectAgentLib: async () => ({ selection }),
        reconcile: async () => prepared,
        runRestartCore: inBoxRestart(status),
        runCoreCommand: async (_engine, _id, argv) => { events.push(['restore', [...argv]]); },
        probeUpdateQuiescence: () => ({ ok: true, pids: [] }),
        createCancellation: () => ({ arm() {}, async dispose() {}, async signalReceived() { return null; } }),
        resolveHostReachableIpv4: async () => '',
        healthCheck: async () => {
            const failure = health.failures.shift();
            if (failure) throw failure;
        },
        revalidateAgentLibSource() {},
        commitAgentLibSelection() {},
        readAgentLibActive: () => null,
        restoreAgentLibActive() {},
    });
    return { build, stopCalls, events, health };
}

async function failedRestart(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    return null;
}

test('H1: a restart whose in-Box command exits nonzero after publication keeps the graph', async (t) => {
    const fixture = scenario(t);
    const error = await failedRestart(fixture.build(1).runRestartTransaction(['restart']));
    assert.deepEqual(fixture.stopCalls, [], 'Q30: host must not stop a kept graph');
    assert.equal(fixture.events.includes('rollback'), false, 'Q30: host must not roll back a kept graph');
    assert.equal(error?.code, 'PLOINKY_BOX_ACTIVATION_RECOVERY_REQUIRED');
    assert.equal(error.activation.outcome, 'kept-activated');
});

test('H13: a clean in-Box exit followed by a failed health check keeps the graph', async (t) => {
    const fixture = scenario(t);
    fixture.health.failures.push(new Error('Router health failed'));
    const error = await failedRestart(fixture.build(0).runRestartTransaction(['restart']));
    assert.deepEqual(fixture.stopCalls, [], 'Q30: host must not stop a kept graph');
    assert.equal(fixture.events.includes('rollback'), false, 'Q30: host must not roll back a kept graph');
    assert.equal(error?.code, 'PLOINKY_BOX_ACTIVATION_RECOVERY_REQUIRED');
    assert.equal(error.activation.outcome, 'kept-activated');
});
