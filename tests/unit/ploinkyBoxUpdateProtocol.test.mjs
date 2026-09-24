import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOperationRecord } from '../../cli/commands/updateOutcome.js';
import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { createMemoryUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';
import { fakeUpdateCore, verifiedRecord, fakeRestartCore } from '../helpers/fakeUpdateCore.mjs';

const CONTAINER_ID = 'a'.repeat(64);

function sink() {
    let text = '';
    return { isTTY: false, write(chunk) { text += String(chunk); }, value: () => text };
}

const dirty = () => createOperationRecord({
    phase: 'workspace-repository', id: 'demo', outcome: 'skipped', attempted: false, required: true,
    code: 'dirty-worktree', reason: 'local changes were preserved',
});
const optionalFailure = () => createOperationRecord({
    phase: 'default-skills', id: 'optional-skills', outcome: 'failed', required: false, code: 'fetch-failed',
});

function scenario(t, {
    graph = { running: true, configured: true },
    core = {},
    probe = () => ({ ok: true, pids: [] }),
    store = createMemoryUpdateHostState(),
    updateWorkspacePloinky = async () => null,
    action = 'reused',
    restartCore = null,
} = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-protocol-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky'));
    const identity = buildWorkspaceIdentity(root, { markerFound: true });
    const selection = agentLibFixture(identity.workspaceRoot);
    const events = [];
    const contexts = [];
    const exclusions = [];
    const ownership = () => ({
        state: 'owned',
        engine: { name: 'podman', identity: 'engine' },
        handles: { container: { id: CONTAINER_ID, runtime: { running: graph.running } } },
    });
    const prepared = {
        action,
        ownership: ownership(),
        hostPort: 8080,
        mediaHostPort: 7882,
        previousAgentLib: selection,
        validate() {},
        finalize() { events.push('finalize'); },
        async rollback() {
            events.push('rollback');
            return action === 'replaced'
                ? { action: 'restored', containerId: CONTAINER_ID, hostPort: 8080, mediaHostPort: 7882, agentLib: selection }
                : { action: 'reused-preserved', containerId: CONTAINER_ID, hostPort: 8080, mediaHostPort: 7882, agentLib: selection };
        },
    };
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager: {
            async acquire() {
                events.push('lock');
                return { assertHeld() {}, release() { events.push('release'); } };
            },
        },
        discover: () => ownership(),
        env: {},
        stdout: sink(),
        stderr: sink(),
        updateHostState: store,
        runner: {
            run() {},
            query: () => ({ ok: true, stdout: JSON.stringify({ initialized: true, routingConfigured: graph.configured }) }),
        },
        captureCoreStartArgv: () => ['start', 'agent', '8080'],
        updateWorkspacePloinky,
        updateAgentLib: async () => ({ selection, changed: false, previous: selection }),
        selectAgentLib: async () => ({ selection }),
        reconcile: async () => { events.push('reconcile'); return prepared; },
        runCoreCommand: async (_engine, _id, argv) => { events.push(['core', [...argv]]); },
        runRestartCore: restartCore || fakeRestartCore(async (_engine, _id, argv) => { events.push(['core', [...argv]]); }),
        runUpdateCore: fakeUpdateCore({
            onCall({ argv, options }) {
                contexts.push(options.reportContext);
                exclusions.push(options.updateExcludedRepoPath);
                events.push(['core', [...argv]]);
            },
            ...core,
        }),
        probeUpdateQuiescence: (options) => { events.push('probe'); return probe(options); },
        resolveHostReachableIpv4: async () => '',
        healthCheck: async () => { events.push('health'); },
        revalidateAgentLibSource() {},
        commitAgentLibSelection() { events.push('commit-agentlib'); },
        readAgentLibActive: () => null,
        restoreAgentLibActive() {},
    });
    return { supervisor, identity, events, contexts, exclusions, store, graph };
}

const coreCalls = events => events.filter(event => Array.isArray(event) && event[0] === 'core').map(event => event[1]);
const reportFiles = identity => {
    const directory = path.join(identity.workspaceRoot, '.ploinky', 'running', 'update-reports');
    return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
};

test('a complete report is read from the host spelling, merged, and removed', async (t) => {
    const fixture = scenario(t);
    const result = await fixture.supervisor.runUpdateTransaction(['update']);
    assert.equal(result.decision.exitCode, 0);
    assert.equal(result.activation.outcome, 'restarted');
    assert.deepEqual(coreCalls(fixture.events), [['update'], ['restart']]);
    assert.deepEqual(result.records.map(record => [record.phase, record.outcome]), [
        ['agentlib', 'unchanged'],
        ['registered-repository', 'unchanged'],
        ['activation', 'changed'],
    ]);
    const [context] = fixture.contexts;
    assert.deepEqual(context.workspace, { instance: fixture.identity.instance, workspaceRoot: fixture.identity.workspaceRoot });
    assert.equal(context.box.containerId, CONTAINER_ID);
    assert.deepEqual(context.request, { kind: 'all', folder: null, folderPath: null });
    assert.deepEqual(result.reportContext, context);
    assert.deepEqual(reportFiles(fixture.identity), []);
});

for (const [variant, code] of [
    ['none', 'report-missing'],
    ['duplicate', 'report-truncated'],
    ['truncated', 'report-truncated'],
    ['wrong-nonce', 'report-missing'],
    ['wrong-context', 'report-context-mismatch'],
    ['inconsistent', 'report-inconsistent'],
]) {
    test(`a ${variant} report is an uncertain failure that blocks activation`, async (t) => {
        const fixture = scenario(t, { core: { report: variant } });
        const result = await fixture.supervisor.runUpdateTransaction(['update']);
        const uncertain = result.records.find(record => record.id === 'in-box-update-report');
        assert.equal(uncertain.outcome, 'uncertain');
        assert.equal(uncertain.code, code);
        assert.equal(result.decision.exitCode, 1);
        assert.equal(result.decision.activationAllowed, false);
        assert.equal(result.activation.outcome, 'deferred');
        assert.deepEqual(coreCalls(fixture.events), [['update']], 'no restart after an unverified report');
        assert.notEqual(fixture.store.read('update-pending', fixture.identity.instance), null);
    });
}

test('a nonzero exit keeps a complete report and its records decide the result', async (t) => {
    const fixture = scenario(t, { core: { records: () => [verifiedRecord(), dirty()] } });
    const result = await fixture.supervisor.runUpdateTransaction(['update']);
    assert.equal(result.run.status, 1);
    assert.equal(result.records.some(record => record.id.startsWith('in-box-update')), false);
    assert.deepEqual(result.decision.blockedBy, [
        { phase: 'workspace-repository', id: 'demo', outcome: 'skipped', code: 'dirty-worktree' },
    ]);
    assert.equal(result.decision.errors.length, 0);
    assert.equal(result.decision.exitCode, 1);
});

test('an exit status that disagrees with the report is uncertain', async (t) => {
    const fixture = scenario(t, { core: { status: 2 } });
    const result = await fixture.supervisor.runUpdateTransaction(['update']);
    const runner = result.records.find(record => record.id === 'in-box-update-runner');
    assert.equal(runner.code, 'exit-status-mismatch');
    assert.equal(result.activation.outcome, 'deferred');
});

for (const [cause, signal] of [['timeout', 'SIGKILL'], ['exited', 'SIGTERM'], ['output-limit', 'SIGTERM']]) {
    test(`a ${cause}${signal ? `/${signal}` : ''} end is uncertain even with a complete report`, async (t) => {
        const fixture = scenario(t, { core: { cause, signal } });
        const result = await fixture.supervisor.runUpdateTransaction(['update']);
        const runner = result.records.find(record => record.id === 'in-box-update-runner');
        assert.equal(runner.outcome, 'uncertain');
        assert.equal(runner.code, cause === 'exited' ? 'signal' : cause);
        assert.equal(result.decision.exitCode, 1);
        assert.deepEqual(coreCalls(fixture.events), [['update']]);
    });
}

test('an unproven in-Box writer leaves a recovery barrier that blocks the next mutation', async (t) => {
    const store = createMemoryUpdateHostState();
    let stillRunning = true;
    const first = scenario(t, {
        store,
        core: { cause: 'timeout', quiescence: 'uncertain', quiescenceDetail: 'engine did not answer' },
        probe: () => (stillRunning ? { ok: true, pids: [12] } : { ok: true, pids: [] }),
    });
    await assert.rejects(first.supervisor.runUpdateTransaction(['update']), error => {
        assert.equal(error.code, 'PLOINKY_BOX_UPDATE_QUIESCENCE_UNCERTAIN');
        assert.equal(error.activation.outcome, 'recovery-required');
        assert.equal(error.updateRecords[0].outcome, 'uncertain');
        return true;
    });
    assert.equal(first.events.includes('rollback'), false, 'nothing touches a Box whose writer may run');
    const barrier = store.read('update-recovery', first.identity.instance);
    assert.equal(barrier.containerId, CONTAINER_ID);
    assert.equal(barrier.cause, 'timeout');
    assert.match(barrier.reportPath, /update-reports/);

    for (const run of [
        supervisor => supervisor.runUpdateTransaction(['update']),
        supervisor => supervisor.runRestartTransaction(['restart']),
    ]) {
        const next = scenario(t, { store, probe: () => ({ ok: true, pids: [12] }) });
        store.write('update-recovery', next.identity.instance, barrier);
        await assert.rejects(run(next.supervisor), { code: 'PLOINKY_BOX_UPDATE_RECOVERY_REQUIRED' });
        assert.deepEqual(next.events, ['lock', 'probe', 'release']);
    }

    stillRunning = false;
    const cleared = scenario(t, { store, probe: () => ({ ok: true, pids: [] }) });
    store.write('update-recovery', cleared.identity.instance, barrier);
    const result = await cleared.supervisor.runUpdateTransaction(['update']);
    assert.match(result.warnings.join('\n'), /confirmed stopped by the engine/);
    assert.equal(store.read('update-recovery', cleared.identity.instance), null);
});

test('an unanswerable engine probe keeps the barrier', async (t) => {
    const store = createMemoryUpdateHostState();
    const fixture = scenario(t, { store, probe: () => ({ ok: false, detail: 'engine unavailable' }) });
    store.write('update-recovery', fixture.identity.instance, {
        instance: fixture.identity.instance, containerId: CONTAINER_ID, nonce: 'b'.repeat(32), cause: 'signal:SIGINT',
    });
    await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']), /may still be running/);
    assert.notEqual(store.read('update-recovery', fixture.identity.instance), null);
});

// Aggregate results through the public host dispatch with a real supervisor.
async function dispatch(fixture, argv = ['update'], options = {}) {
    const output = sink();
    const errorOutput = sink();
    const results = [];
    const code = await runOuterCli(argv, {
        env: {},
        cwd: () => fixture.identity.workspaceRoot,
        input: { isTTY: false },
        output,
        errorOutput,
        supervisor: fixture.supervisor,
        detectInsideBox: () => false,
        updateHostState: createMemoryUpdateHostState(),
        updateHostSource: async () => ({ updated: false, repoPath: '/host/ploinky' }),
        onUpdateResult: result => results.push(result),
        ...options,
    });
    return { code, output: output.value(), errorOutput: errorOutput.value(), result: results.at(-1)?.result };
}

test('host dispatch: complete verified update exits zero and reports the restart', async (t) => {
    const fixture = scenario(t);
    const { code, output, result } = await dispatch(fixture);
    assert.equal(code, 0);
    assert.equal(result.status, 'complete');
    assert.match(output, /^Update complete\.$/m);
    assert.match(output, /workspace graph was restarted and the Router health check passed/);
    assert.deepEqual(result.records[0].phase, 'host-ploinky');
});

test('host dispatch: a preserved dirty required repository exits nonzero without activation', async (t) => {
    const fixture = scenario(t, { core: { records: () => [verifiedRecord(), dirty()] } });
    const { code, output, errorOutput, result } = await dispatch(fixture);
    assert.equal(code, 1);
    assert.equal(result.status, 'failed');
    assert.equal(result.activationAllowed, false);
    assert.match(output, /Update failed \(exit status 1\): not verified: workspace-repository demo: skipped \[dirty-worktree\]/);
    assert.match(output, /Activation deferred/);
    assert.match(output, /Activation was blocked by: workspace-repository demo \(dirty-worktree\)/);
    assert.doesNotMatch(output, /Update complete|restarted and/);
    assert.deepEqual(coreCalls(fixture.events), [['update']]);
    assert.notEqual(fixture.store.read('update-pending', fixture.identity.instance), null);
    assert.equal(errorOutput, '', 'the named phases replace the generic diagnosis hint');
});

test('host dispatch: an optional failure exits nonzero while the verified graph is activated', async (t) => {
    const fixture = scenario(t, { core: { records: () => [verifiedRecord(), optionalFailure()] } });
    const { code, output, result } = await dispatch(fixture);
    assert.equal(code, 1);
    assert.equal(result.status, 'partial');
    assert.equal(result.activationAllowed, true);
    assert.match(output, /Update partially failed \(exit status 1\): failed or uncertain: default-skills optional-skills: failed \[fetch-failed\]/);
    assert.match(output, /workspace graph was restarted/);
    assert.deepEqual(coreCalls(fixture.events), [['update'], ['restart']]);
});

test('host dispatch: relaunch then child success or failure is merged truthfully', async (t) => {
    for (const [records, expectedCode] of [[() => [verifiedRecord()], 0], [() => [dirty()], 1]]) {
        const fixture = scenario(t, { core: { records } });
        const store = createMemoryUpdateHostState();
        const parentOutput = sink();
        const childResults = [];
        let childOutput = '';
        const code = await runOuterCli(['update'], {
            env: {},
            cwd: () => fixture.identity.workspaceRoot,
            input: { isTTY: false },
            output: parentOutput,
            errorOutput: sink(),
            supervisor: fixture.supervisor,
            detectInsideBox: () => false,
            updateHostState: store,
            updateHostSource: async () => ({
                updated: true, repoPath: '/host/ploinky', before: '1'.repeat(40), after: '2'.repeat(40),
            }),
            async relaunch(_command, args, { env }) {
                const output = sink();
                const status = await runOuterCli(args.slice(1), {
                    env,
                    cwd: () => fixture.identity.workspaceRoot,
                    input: { isTTY: false },
                    output,
                    errorOutput: sink(),
                    supervisor: fixture.supervisor,
                    detectInsideBox: () => false,
                    updateHostState: store,
                    handoffParentPid: process.pid,
                    onUpdateResult: result => childResults.push(result.result),
                    updateHostSource: async () => { throw new Error('no second host pull'); },
                });
                childOutput = output.value();
                return status;
            },
        });
        assert.equal(code, expectedCode);
        const [result] = childResults;
        assert.deepEqual(
            [result.records[0].phase, result.records[0].outcome, result.records[0].after.revision],
            ['host-ploinky', 'changed', '2'.repeat(40)],
        );
        assert.equal(result.exitCode, expectedCode);
        assert.match(childOutput, /was updated from 111111111111 to 222222222222 before this relaunch/);
        if (expectedCode) {
            assert.match(parentOutput.value(), /updated CLI exited with status 1\. The host Ploinky checkout at \/host\/ploinky remains updated/);
        } else {
            assert.doesNotMatch(parentOutput.value(), /exited with status/);
        }
    }
});

function gitError(code, record) {
    return Object.assign(new Error(record.reason || 'git update did not complete'), { code, record });
}
const gitRecord = (phase, outcome, code) => ({
    phase, id: `/checkouts/${phase}`, outcome, code, reason: `${code} left the checkout untouched`,
    required: true, attempted: outcome !== 'skipped',
});

test('a preserved workspace Ploinky checkout is a required skip: nonzero, no activation, named', async (t) => {
    for (const shape of ['thrown', 'returned']) {
        const record = gitRecord('workspace-ploinky', 'skipped', 'dirty-worktree');
        const fixture = scenario(t, {
            updateWorkspacePloinky: shape === 'thrown'
                ? async () => { throw gitError('PLOINKY_BOX_WORKSPACE_PLOINKY_UPDATE_FAILED', record); }
                : async () => ({ found: true, updated: false, skipped: true, repoPath: record.id, record }),
        });
        const { code, output, result } = await dispatch(fixture);
        assert.equal(code, 1, shape);
        assert.equal(result.activationAllowed, false, shape);
        const named = result.records.find(entry => entry.phase === 'workspace-ploinky');
        assert.deepEqual([named.outcome, named.code, named.required], ['skipped', 'dirty-worktree', true], shape);
        assert.match(output, /workspace-ploinky \/checkouts\/workspace-ploinky: skipped \[dirty-worktree\]/, shape);
        assert.deepEqual(coreCalls(fixture.events), [['update']], `${shape}: the in-Box update still ran, no restart`);
    }
});

test('a failed or uncertain workspace Ploinky update is recorded and blocks activation', async (t) => {
    for (const outcome of ['failed', 'uncertain']) {
        const record = gitRecord('workspace-ploinky', outcome, 'fetch-failed');
        const fixture = scenario(t, {
            updateWorkspacePloinky: async () => { throw gitError('PLOINKY_BOX_WORKSPACE_PLOINKY_UPDATE_FAILED', record); },
        });
        const { code, result } = await dispatch(fixture);
        assert.equal(code, 1);
        assert.equal(result.activationAllowed, false);
        assert.equal(result.errors[0].phase, 'workspace-ploinky');
    }
});

test('a workspace Ploinky failure without an operation record still aborts the update', async (t) => {
    const fixture = scenario(t, { updateWorkspacePloinky: async () => { throw new Error('lock identity mismatch'); } });
    await assert.rejects(dispatch(fixture), /lock identity mismatch/);
    assert.deepEqual(coreCalls(fixture.events), []);
});

test('a preserved host checkout is reported without blocking activation or failing the update', async (t) => {
    const fixture = scenario(t);
    const record = gitRecord('host-ploinky', 'skipped', 'diverged');
    const { code, output, result } = await dispatch(fixture, ['update'], {
        updateHostSource: async () => { throw gitError('PLOINKY_BOX_HOST_UPDATE_FAILED', record); },
        relaunch() { throw new Error('a preserved host checkout never relaunches'); },
    });
    assert.equal(code, 0);
    assert.equal(result.status, 'complete-with-skips');
    assert.match(output, /Host Ploinky checkout at .* was not updated \(skipped: diverged\)/);
    assert.match(output, /Update complete with skips: host-ploinky \/checkouts\/host-ploinky: skipped \[diverged\]/);
    assert.deepEqual(coreCalls(fixture.events), [['update'], ['restart']]);
});

test('a failed host self-update makes the final status nonzero but does not block the in-Box graph', async (t) => {
    const fixture = scenario(t);
    const record = gitRecord('host-ploinky', 'failed', 'fetch-failed');
    const { code, output, result } = await dispatch(fixture, ['update'], {
        updateHostSource: async () => { throw gitError('PLOINKY_BOX_HOST_UPDATE_FAILED', record); },
    });
    assert.equal(code, 1);
    assert.equal(result.status, 'partial');
    assert.equal(result.activationAllowed, true);
    assert.match(output, /Update partially failed \(exit status 1\): failed or uncertain: host-ploinky/);
    assert.deepEqual(coreCalls(fixture.events), [['update'], ['restart']]);
});

test('a host self-update failure without an operation record still aborts before any Box work', async (t) => {
    const fixture = scenario(t);
    await assert.rejects(dispatch(fixture, ['update'], {
        updateHostSource: async () => { throw new Error('source lock identity mismatch'); },
    }), /source lock identity mismatch/);
    assert.deepEqual(fixture.events, []);
});

test('a thrown workspace Ploinky record still excludes that checkout from the in-Box pull', async (t) => {
    let fixture;
    fixture = scenario(t, {
        updateWorkspacePloinky: async () => {
            const repoPath = path.join(fixture.identity.workspaceRoot, 'ploinky');
            fs.mkdirSync(repoPath, { recursive: true });
            throw gitError('PLOINKY_BOX_WORKSPACE_PLOINKY_UPDATE_FAILED', {
                ...gitRecord('workspace-ploinky', 'skipped', 'dirty-worktree'),
                id: repoPath,
                details: { checkout: { path: repoPath } },
            });
        },
    });
    await fixture.supervisor.runUpdateTransaction(['update']);
    assert.deepEqual(fixture.exclusions, [`${fixture.identity.workspaceRoot}/ploinky`]);
});

test('a barrier that cannot be written still never rolls back a Box whose writer may run', async (t) => {
    const store = createMemoryUpdateHostState();
    const failing = {
        ...store,
        write(kind, name, record) {
            if (kind === 'update-recovery') throw new Error('host state is read-only');
            return store.write(kind, name, record);
        },
    };
    const fixture = scenario(t, { store: failing, core: { cause: 'timeout', quiescence: 'uncertain' } });
    await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']), error => {
        assert.equal(error.code, 'PLOINKY_BOX_UPDATE_QUIESCENCE_UNCERTAIN');
        assert.equal(error.activation.outcome, 'recovery-required');
        assert.match(error.message, /No durable recovery record could be written \(host state is read-only\)/);
        return true;
    });
    assert.equal(fixture.events.includes('rollback'), false);
    assert.equal(fixture.events.includes('finalize'), false);
});

test('the recovery barrier also blocks bind before any Box work', async (t) => {
    const store = createMemoryUpdateHostState();
    const fixture = scenario(t, { store, probe: () => ({ ok: true, pids: [9] }) });
    store.write('update-recovery', fixture.identity.instance, {
        instance: fixture.identity.instance, containerId: CONTAINER_ID, nonce: 'c'.repeat(32), cause: 'timeout',
    });
    await assert.rejects(fixture.supervisor.runBindTransaction(), { code: 'PLOINKY_BOX_UPDATE_RECOVERY_REQUIRED' });
    assert.deepEqual(fixture.events, ['lock', 'probe', 'release']);
});

// Follow-up: the restart subprocess, blocked admission without an active graph, status.

test('a restart that cannot be proven stopped leaves a restart barrier and is never rolled back', async (t) => {
    const store = createMemoryUpdateHostState();
    const fixture = scenario(t, {
        store,
        restartCore: fakeRestartCore(null, { cause: 'timeout', quiescence: 'uncertain' }),
    });
    await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']), error => {
        assert.equal(error.code, 'PLOINKY_BOX_UPDATE_QUIESCENCE_UNCERTAIN');
        assert.equal(error.activation.outcome, 'recovery-required');
        assert.match(error.message, /graph restart ended abnormally \(timeout\)/);
        return true;
    });
    assert.equal(fixture.events.includes('rollback'), false);
    assert.equal(fixture.events.includes('commit-agentlib'), false);
    const barrier = store.read('update-recovery', fixture.identity.instance);
    assert.equal(barrier.operation, 'restart');
    assert.match(barrier.marker, /^PLOINKY_UPDATE_OPERATION=[0-9a-f]{32}$/);
    const next = scenario(t, { store, probe: options => {
        assert.equal(options.marker, barrier.marker, 'the barrier is re-checked with the restart marker');
        return { ok: true, pids: [3] };
    } });
    store.write('update-recovery', next.identity.instance, barrier);
    await assert.rejects(next.supervisor.runUpdateTransaction(['update']), { code: 'PLOINKY_BOX_UPDATE_RECOVERY_REQUIRED' });
});

for (const [name, options] of [
    ['timed out', { cause: 'timeout' }],
    ['nonzero', { status: 4 }],
]) {
    test(`a ${name} restart whose end the engine confirmed rolls back and restores the prior graph`, async (t) => {
        const fixture = scenario(t, { restartCore: fakeRestartCore(null, options) });
        const { writeGraphSkillScope } = await import('../../ploinky-box/graphSkillScope.mjs');
        const { buildHostSkillScope } = await import('../../ploinky-box/skillScope.mjs');
        writeGraphSkillScope(fixture.identity, buildHostSkillScope(fixture.identity.workspaceRoot, fixture.identity.workspaceRoot), {
            assertHeld() {},
        });
        await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']), error => {
            assert.equal(error.code, 'PLOINKY_BOX_UPDATE_RESTART_FAILED');
            assert.equal(error.activation.outcome, 'restored');
            return true;
        });
        assert.equal(fixture.events.includes('rollback'), true);
        assert.equal(fixture.events.includes('commit-agentlib'), false);
        assert.deepEqual(coreCalls(fixture.events).at(-1), ['start', 'agent', '8080']);
        assert.equal(fixture.store.read('update-recovery', fixture.identity.instance), null);
    });
}

test('a required failure without an active graph never admits the candidate selection', async (t) => {
    for (const [action, expected] of [['reused', 'deferred'], ['created', 'deferred'], ['replaced', 'restored']]) {
        const fixture = scenario(t, {
            graph: { running: false, configured: false },
            action,
            core: { records: () => [verifiedRecord(), dirty()] },
        });
        const result = await fixture.supervisor.runUpdateTransaction(['update']);
        assert.equal(result.decision.activationAllowed, false, action);
        assert.equal(result.activation.outcome, expected, action);
        assert.equal(fixture.events.includes('commit-agentlib'), false, `${action}: prior selection stays in force`);
        assert.deepEqual(coreCalls(fixture.events), [['update']], action);
        assert.equal(fixture.events.includes(action === 'replaced' ? 'rollback' : 'finalize'), true, action);
        const pending = fixture.store.read('update-pending', fixture.identity.instance);
        assert.deepEqual(pending.entries.at(-1).blockedBy, [
            { phase: 'workspace-repository', id: 'demo', outcome: 'skipped', code: 'dirty-worktree' },
        ], action);
    }
    // A verified update without an active graph still admits the selection.
    const verified = scenario(t, { graph: { running: false, configured: false } });
    const result = await verified.supervisor.runUpdateTransaction(['update']);
    assert.equal(result.activation.outcome, 'not-required');
    assert.equal(verified.events.includes('commit-agentlib'), true);
});

test('update state inspection is read-only and names pending activation and recovery', async (t) => {
    const store = createMemoryUpdateHostState();
    const fixture = scenario(t, { store });
    store.write('update-pending', fixture.identity.instance, {
        reason: 'Activation was blocked because required update inputs were not verified.',
        entries: [{ recordedAt: '2026-09-24T10:00:00.000Z', blockedBy: [{ phase: 'workspace-repository', id: 'demo', code: 'dirty-worktree' }] }],
    });
    store.write('update-recovery', fixture.identity.instance, { operation: 'restart', cause: 'timeout', detail: 'engine unavailable' });
    const state = fixture.supervisor.inspectUpdateState();
    assert.deepEqual(fixture.events, [], 'no lock, probe, or engine call');
    const { formatUpdateStateLines } = await import('../../ploinky-box/supervisor.mjs');
    const lines = formatUpdateStateLines(state).join('\n');
    assert.match(lines, /Pending activation: Activation was blocked .*1 update recorded; last at 2026-09-24T10:00:00.000Z/);
    assert.match(lines, /blocked by: workspace-repository demo \(dirty-worktree\)/);
    assert.match(lines, /Update recovery required: an earlier restart may still be running in the Box \(timeout: engine unavailable\)/);
    assert.notEqual(store.read('update-recovery', fixture.identity.instance), null, 'status never clears a barrier');
    const broken = { ...store, read() { throw new Error('unreadable'); } };
    const unreadable = scenario(t, { store: broken }).supervisor.inspectUpdateState();
    assert.deepEqual(formatUpdateStateLines(unreadable), [
        'Update state could not be read: unreadable',
        'Update state could not be read: unreadable',
    ]);
});

test('host status reports pending activation and recovery without preparing or mutating', async (t) => {
    const store = createMemoryUpdateHostState();
    const fixture = scenario(t, { store });
    store.write('update-pending', fixture.identity.instance, { reason: 'updated sources may require activation', entries: [] });
    store.write('update-recovery', fixture.identity.instance, { operation: 'update', cause: 'signal:SIGINT' });
    const output = sink();
    const code = await runOuterCli(['status'], {
        env: {},
        cwd: () => fixture.identity.workspaceRoot,
        input: { isTTY: false },
        output,
        errorOutput: sink(),
        supervisor: fixture.supervisor,
        detectInsideBox: () => false,
        execute() { return 0; },
    });
    // The fixture Box fails image validation, so status itself exits 1; the
    // update state is still reported first.
    assert.equal(typeof code, 'number');
    assert.match(output.value(), /^Pending activation: updated sources may require activation/);
    assert.match(output.value(), /Update recovery required: an earlier update/);
    assert.equal(fixture.events.some(event => ['lock', 'reconcile', 'probe'].includes(event)), false);
    assert.notEqual(store.read('update-pending', fixture.identity.instance), null);
});

for (const report of ['none', 'truncated']) {
    test(`${report} report with surviving writers retains the recovery barrier without rollback`, async (t) => {
        const fixture = scenario(t, { core: { report }, probe: () => ({ ok: true, pids: [37] }) });
        await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']),
            { code: 'PLOINKY_BOX_UPDATE_QUIESCENCE_UNCERTAIN' });
        assert.ok(fixture.events.includes('probe'));
        assert.equal(fixture.events.includes('rollback'), false);
        assert.ok(fixture.store.read('update-recovery', fixture.identity.instance));
    });
}

for (const outcome of ['changed', 'failed', 'skipped']) {
    test(`delegated workspace Ploinky ${outcome} is reported from Core and controls activation`, async (t) => {
        const fixture = scenario(t, {
            updateWorkspacePloinky: async ({ identity }) => ({
                found: true, deferredToCore: true, updated: false,
                repoPath: path.join(identity.workspaceRoot, 'ploinky'),
                delegatedBoxRepoPath: path.join(identity.workspaceRoot, 'ploinky'),
            }),
            core: { records: ({ options }) => [createOperationRecord({
                phase: 'workspace-repository',
                id: options.reportContext.source.workspacePloinky.delegatedBoxRepoPath,
                outcome, required: false, code: outcome === 'skipped' ? 'dirty-worktree' : outcome,
                before: { head: 'before' }, after: { head: outcome === 'changed' ? 'after' : 'before' },
                details: { checkout: { path: options.reportContext.source.workspacePloinky.delegatedBoxRepoPath } },
            })] },
        });
        const result = await fixture.supervisor.runUpdateTransaction(['update']);
        assert.equal(fixture.exclusions[0], '', 'Core must be allowed to pull the delegated checkout');
        const record = result.records.find(entry => entry.phase === 'workspace-ploinky');
        assert.equal(record.outcome, outcome);
        assert.equal(record.required, true);
        assert.equal(result.workspacePloinky.deferredToCore, false);
        assert.equal(result.workspacePloinky.updated, outcome === 'changed');
        assert.equal(result.decision.activationAllowed, outcome === 'changed');
        assert.equal(result.decision.exitCode, outcome === 'changed' ? 0 : 1);
    });
}

for (const argv of [['update'], ['update', 'repo', 'demo']]) {
    test(`${argv.join(' ')} carries the saved and proposed skill scopes to Core`, async (t) => {
        const { writeGraphSkillScope } = await import('../../ploinky-box/graphSkillScope.mjs');
        const { buildHostSkillScope } = await import('../../ploinky-box/skillScope.mjs');
        const fixture = scenario(t);
        const previousFolder = path.join(fixture.identity.workspaceRoot, 'previous-launch');
        fs.mkdirSync(previousFolder);
        writeGraphSkillScope(fixture.identity,
            buildHostSkillScope(fixture.identity.workspaceRoot, previousFolder), { assertHeld() {} });
        const result = await fixture.supervisor.runUpdateTransaction(argv);
        assert.deepEqual(result.reportContext.source.skillScopes, {
            prior: previousFolder, proposed: fixture.identity.workspaceRoot, priorRequired: true,
        });
    });
}
