import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseUpdateRequest, resolveUpdateFolderScope } from '../../cli/commands/updateRequest.js';
import { writeGraphSkillScope } from '../../ploinky-box/graphSkillScope.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';
import { buildHostSkillScope } from '../../ploinky-box/skillScope.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { ADMISSION_JOURNAL_KIND } from '../../ploinky-box/update/admission.mjs';
import { createMemoryUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';
import { fakeRestartCore, fakeUpdateCore, verifiedRecord } from '../helpers/fakeUpdateCore.mjs';
import { createOperationRecord } from '../../cli/commands/updateOutcome.js';

const CONTAINER_ID = 'a'.repeat(64);

function harness(t, {
    alias = false,
    graph: initialGraph = { running: false, configured: false },
    onAcquire = null,
    reconcileAction = 'reused',
    faults = {},
    store = createMemoryUpdateHostState(),
    lockManager: providedLockManager = null,
    active = 'old-active',
    priorArgv = ['start', 'agent', '8080'],
    inboxReadable = true,
    core = {},
    restartCore = null,
    launchRelative = '',
} = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-transaction-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'projects', 'nested'), { recursive: true });
    let selected = workspace;
    if (alias) {
        selected = path.join(root, 'selected-alias');
        fs.symlinkSync(workspace, selected, 'dir');
    }
    const identity = buildWorkspaceIdentity(selected, { markerFound: true });
    const selection = agentLibFixture(identity.workspaceRoot);
    const graph = { ...initialGraph };
    const events = [];
    const metadata = { active };
    let lockHeld = false;
    const ownership = () => ({
        state: 'owned',
        engine: { name: 'podman', identity: 'engine' },
        handles: { container: { id: CONTAINER_ID, runtime: { running: graph.running } } },
    });
    const lockManager = providedLockManager || {
        async acquire(instance) {
            events.push('lock');
            await onAcquire?.({ graph, identity, workspace, root, events, metadata });
            lockHeld = true;
            let released = false;
            return {
                assertHeld(expected) {
                    assert.equal(released, false);
                    assert.equal(expected, instance);
                },
                release() {
                    released = true;
                    lockHeld = false;
                    events.push('release');
                },
            };
        },
    };
    const prepared = {
        action: reconcileAction,
        ownership: ownership(),
        hostPort: 8080,
        mediaHostPort: 7882,
        previousAgentLib: selection,
        validate() { events.push('validate'); },
        finalize() {
            events.push('finalize');
            if (faults.finalizeSuccessor) metadata.active = 'successor-active';
            if (faults.finalize) throw new Error('candidate finalize failed');
        },
        async rollback() {
            events.push('rollback');
            return {
                action: reconcileAction === 'replaced' ? 'restored' : 'reused-preserved',
                containerId: CONTAINER_ID,
                hostPort: 8080,
                mediaHostPort: 7882,
                agentLib: selection,
            };
        },
    };
    async function coreCommand(_engine, containerId, argv, _hostPort, _mediaHostPort, _runner, options) {
        assert.equal(lockHeld || Boolean(providedLockManager), true, 'the core command runs under the lock');
        assert.equal(containerId, CONTAINER_ID);
        assert.equal(options.workspaceRoot, identity.workspaceRoot);
        events.push(['core', [...argv]]);
        if (faults.restart && argv[0] === 'restart') throw new Error('in-Box restart failed');
    }
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        launchCwd: path.join(identity.workspaceRoot, launchRelative),
        lockManager,
        discover: () => ownership(),
        repositoryRoot: root,
        env: {},
        stdout: { write() {} },
        stderr: { write() {} },
        updateHostState: store,
        runner: {
            run(_command, args) { events.push(`run:${args.at(-1)}`); },
            query() {
                events.push('inbox');
                if (!inboxReadable) return { ok: false, stdout: '', stderr: 'exec failed' };
                return { ok: true, stdout: JSON.stringify({ initialized: true, routingConfigured: graph.configured }) };
            },
        },
        captureCoreStartArgv: () => priorArgv,
        async updateWorkspacePloinky(options) {
            options.lock.assertHeld(identity.instance);
            events.push(['workspace-ploinky', options.updateScopeRoot]);
            return null;
        },
        async updateAgentLib() {
            events.push('update-agentlib');
            return { selection, changed: false, previous: null };
        },
        async selectAgentLib() {
            events.push('select-agentlib');
            return { selection };
        },
        async reconcile(options) {
            options.lock.assertHeld(identity.instance);
            events.push(['reconcile', options.allowReplacement ?? true]);
            if (faults.reconcile) throw new Error('reconcile failed');
            return prepared;
        },
        runCoreCommand: coreCommand,
        runRestartCore: restartCore || fakeRestartCore(coreCommand),
        runUpdateCore: fakeUpdateCore({
            onCall({ containerId, argv, options }) {
                assert.equal(lockHeld || Boolean(providedLockManager), true, 'the in-Box update runs under the lock');
                assert.equal(containerId, CONTAINER_ID);
                assert.equal(options.workspaceRoot, identity.workspaceRoot);
                events.push(['core', [...argv]]);
            },
            records: () => (faults.core
                ? [createOperationRecord({
                    phase: 'registered-repository', id: 'demo', outcome: 'failed', required: true, code: 'fetch-failed',
                })]
                : [verifiedRecord()]),
            ...core,
        }),
        resolveHostReachableIpv4: async () => '',
        async healthCheck() { events.push('health'); },
        revalidateAgentLibSource() { events.push('revalidate-agentlib'); },
        commitAgentLibSelection() {
            events.push('commit-agentlib');
            metadata.active = 'candidate-active';
        },
        readAgentLibActive: () => metadata.active,
        restoreAgentLibActive(_workspace, value) {
            events.push(['restore-active', value]);
            metadata.active = value;
        },
    });
    return { supervisor, identity, workspace, root, events, graph, metadata, store, selection };
}

const coreCalls = events => events.filter(event => Array.isArray(event) && event[0] === 'core').map(event => event[1]);

for (const argv of [['update'], ['update', 'all']]) {
    test(`bare nested ${argv.join(' ')} preserves the launch folder in the Box`, async (t) => {
        const fixture = harness(t, { alias: true, launchRelative: 'projects/nested' });
        const expected = path.join(fixture.identity.workspaceRoot, 'projects/nested');
        await fixture.supervisor.runUpdateTransaction(argv);
        assert.deepEqual(coreCalls(fixture.events), [['update', 'all', expected]]);
    });
}

function assertCoreInsideLock(events) {
    const lock = events.indexOf('lock');
    const release = events.lastIndexOf('release');
    const cores = events.map((event, index) => (Array.isArray(event) && event[0] === 'core' ? index : -1))
        .filter(index => index >= 0);
    assert.ok(cores.length > 0);
    assert.equal(events.filter(event => event === 'lock').length, 1);
    for (const index of cores) assert.ok(lock < index && index < release, 'core command inside the one lock');
}

test('every update form runs its actual core argv inside the one held lock', async (t) => {
    const cases = [
        ['bare', ['update'], {}, ws => ['update']],
        ['all', ['update', 'all'], {}, () => ['update']],
        ['debug', ['--debug', 'update'], {}, () => ['--debug', 'update']],
        ['folder', null, ({ workspace }) => ({ request: parseUpdateRequest([path.join(workspace, 'projects')]) }),
            ({ identity }) => ['update', 'all', `${identity.workspaceRoot}/projects`]],
        ['relative nested', null, ({ workspace }) => ({
            request: parseUpdateRequest(['all', 'nested'], { cwd: path.join(workspace, 'projects') }),
        }), ({ identity }) => ['update', 'all', `${identity.workspaceRoot}/projects/nested`]],
        ['workspace root folder', null, ({ workspace }) => ({ request: parseUpdateRequest(['all', workspace]) }),
            ({ identity }) => ['update', 'all', identity.workspaceRoot]],
        ['repos', null, () => ({ request: { kind: 'repos' }, branchPolicyArgs: ['--reset-repos'] }),
            () => ['update', 'repos', '--reset-repos']],
        ['repo', null, () => ({ request: { kind: 'repo', repoName: 'demo' } }), () => ['update', 'repo', 'demo']],
    ];
    for (const [name, argv, options, expected] of cases) {
        const fixture = harness(t);
        const resolved = typeof options === 'function' ? options(fixture) : options;
        const result = await fixture.supervisor.runUpdateTransaction(argv || ['update'], resolved);
        assert.deepEqual(coreCalls(fixture.events), [expected(fixture)], name);
        assert.deepEqual(result.coreArgv, expected(fixture), name);
        assertCoreInsideLock(fixture.events);
        assert.equal(fixture.events.at(-1), 'release', name);
    }
});

test('a folder reached through the canonical path runs against the Box mount spelling', async (t) => {
    const fixture = harness(t, { alias: true });
    const folder = path.join(fixture.workspace, 'projects', 'nested');
    const request = parseUpdateRequest(['all', folder]);
    const scope = resolveUpdateFolderScope(folder, fixture.identity.workspaceRoot);
    assert.notEqual(fixture.identity.workspaceRoot, fixture.workspace);
    await fixture.supervisor.runUpdateTransaction(['update', 'all', folder], {
        request,
        scope: { relative: scope.relative, canonicalFolder: scope.canonicalFolder },
    });
    assert.deepEqual(coreCalls(fixture.events), [['update', 'all', `${fixture.identity.workspaceRoot}/projects/nested`]]);
    // Host-side source selection keeps the canonical folder.
    assert.deepEqual(fixture.events.find(event => Array.isArray(event) && event[0] === 'workspace-ploinky'),
        ['workspace-ploinky', scope.canonicalFolder]);
});

test('a folder that changed or left the workspace while waiting for the lock is refused before mutation', async (t) => {
    for (const [name, change, code] of [
        ['retargeted', ({ workspace }) => {
            fs.renameSync(path.join(workspace, 'projects'), path.join(workspace, 'moved'));
            fs.symlinkSync(path.join(workspace, 'moved', 'nested'), path.join(workspace, 'projects'), 'dir');
        }, 'PLOINKY_UPDATE_SCOPE_CHANGED'],
        ['removed', ({ workspace }) => {
            fs.rmSync(path.join(workspace, 'projects'), { recursive: true });
        }, 'PLOINKY_UPDATE_SCOPE_MISSING'],
        ['escaped', ({ workspace, root }) => {
            fs.mkdirSync(path.join(root, 'outside'));
            fs.rmSync(path.join(workspace, 'projects'), { recursive: true });
            fs.symlinkSync(path.join(root, 'outside'), path.join(workspace, 'projects'), 'dir');
        }, 'PLOINKY_UPDATE_SCOPE_OUTSIDE'],
    ]) {
        const fixture = harness(t, { onAcquire: change });
        const folder = path.join(fixture.workspace, 'projects');
        const scope = resolveUpdateFolderScope(folder, fixture.identity.workspaceRoot);
        await assert.rejects(fixture.supervisor.runUpdateTransaction(['update', folder], {
            request: parseUpdateRequest([folder]),
            scope: { relative: scope.relative, canonicalFolder: scope.canonicalFolder },
        }), { code }, name);
        assert.deepEqual(fixture.events, ['lock', 'release'], name);
    }
});

test('the restart predicate is sampled after the lock is acquired and honors changes made while waiting', async (t) => {
    const started = harness(t, {
        graph: { running: false, configured: false },
        onAcquire: ({ graph }) => { graph.running = true; graph.configured = true; },
    });
    const restarted = await started.supervisor.runUpdateTransaction(['update']);
    assert.equal(restarted.activation.outcome, 'restarted');
    assert.deepEqual(coreCalls(started.events), [['update'], ['restart']]);
    const events = started.events;
    assert.ok(events.indexOf('lock') < events.indexOf('inbox'));
    assert.ok(events.indexOf('validate') < events.findIndex(event => Array.isArray(event) && event[1][0] === 'restart'));
    assert.ok(events.indexOf('health') < events.indexOf('commit-agentlib'));
    assert.ok(events.indexOf('commit-agentlib') < events.indexOf('finalize'));

    const stopped = harness(t, {
        graph: { running: true, configured: true },
        onAcquire: ({ graph }) => { graph.running = false; },
    });
    const result = await stopped.supervisor.runUpdateTransaction(['update']);
    assert.equal(result.activation.outcome, 'not-required');
    assert.deepEqual(coreCalls(stopped.events), [['update']]);
    assert.equal(stopped.events.includes('inbox'), false);
    assert.equal(stopped.events.includes('health'), false);

    const unconfigured = harness(t, {
        graph: { running: true, configured: true },
        onAcquire: ({ graph }) => { graph.configured = false; },
    });
    assert.equal((await unconfigured.supervisor.runUpdateTransaction(['update'])).activation.outcome, 'not-required');
    assert.deepEqual(coreCalls(unconfigured.events), [['update']]);
});

test('targeted forms defer activation, never restart or replace, and record pending activation durably', async (t) => {
    const active = harness(t, { graph: { running: true, configured: true } });
    const deferred = await active.supervisor.runUpdateTransaction(['update', 'repo', 'demo'], {
        request: { kind: 'repo', repoName: 'demo' },
    });
    assert.equal(deferred.activation.outcome, 'deferred');
    assert.deepEqual(coreCalls(active.events), [['update', 'repo', 'demo']]);
    assert.deepEqual(active.events.find(event => Array.isArray(event) && event[0] === 'reconcile'), ['reconcile', false]);
    for (const forbidden of ['update-agentlib', 'health', 'commit-agentlib']) {
        assert.equal(active.events.includes(forbidden), false, forbidden);
    }
    assert.ok(active.events.indexOf('finalize') < active.events.findIndex(event => Array.isArray(event) && event[0] === 'core'));
    const pending = active.store.read('update-pending', active.identity.instance);
    assert.equal(pending.schema, 'ploinky-update-pending-activation');
    assert.deepEqual(pending.entries.map(entry => entry.coreArgv), [['update', 'repo', 'demo']]);
    assert.match(pending.reason, /may require activation/);
    assert.equal(active.metadata.active, 'old-active', 'no admission metadata is written for targeted forms');

    // A later full activation clears the pending record only after settlement.
    await active.supervisor.runUpdateTransaction(['update']);
    assert.equal(active.store.read('update-pending', active.identity.instance), null);

    const idle = harness(t, { graph: { running: false, configured: false } });
    const repos = await idle.supervisor.runUpdateTransaction(['update', 'repos'], { request: { kind: 'repos' } });
    assert.equal(repos.activation.outcome, 'not-required');
    assert.equal(idle.store.read('update-pending', idle.identity.instance), null);
});

test('a targeted core failure is reported nonzero, never restarts, and records a blocked pending activation', async (t) => {
    const fixture = harness(t, { graph: { running: true, configured: true }, faults: { core: true } });
    const result = await fixture.supervisor.runUpdateTransaction(['update', 'repos'], { request: { kind: 'repos' } });
    assert.equal(result.decision.exitCode, 1);
    assert.equal(result.decision.activationAllowed, false);
    assert.equal(result.activation.outcome, 'deferred');
    const pending = fixture.store.read('update-pending', fixture.identity.instance);
    assert.deepEqual(pending.entries[0].blockedBy, [
        { phase: 'registered-repository', id: 'demo', outcome: 'failed', code: 'fetch-failed' },
    ]);
    assert.deepEqual(coreCalls(fixture.events), [['update', 'repos']]);
    assert.equal(fixture.events.at(-1), 'release');
    assert.equal(fixture.events.includes('rollback'), false);
});

test('a targeted form never finalizes a replacement Box', async (t) => {
    const fixture = harness(t, { graph: { running: true, configured: true }, reconcileAction: 'replaced' });
    await assert.rejects(fixture.supervisor.runUpdateTransaction(['update', 'repos'], { request: { kind: 'repos' } }),
        { code: 'PLOINKY_BOX_REPLACEMENT_REFUSED' });
    assert.equal(fixture.events.includes('rollback'), true);
    assert.equal(fixture.events.includes('finalize'), false);
    assert.deepEqual(coreCalls(fixture.events), []);
});

test('a failure after settlement is reported without rolling back the settled deployment', async (t) => {
    const store = createMemoryUpdateHostState();
    const failing = {
        ...store,
        remove(kind, name) {
            if (kind === 'update-pending') throw new Error('pending state unavailable');
            return store.remove(kind, name);
        },
    };
    const fixture = harness(t, { graph: { running: true, configured: true }, store: failing });
    const result = await fixture.supervisor.runUpdateTransaction(['update']);
    assert.equal(result.activation.outcome, 'restarted');
    assert.match(result.warnings.join('\n'), /pending activation record could not be cleared: pending state unavailable/);
    assert.equal(fixture.events.includes('rollback'), false);
    assert.equal(fixture.events.some(event => Array.isArray(event) && event[0] === 'restore-active'), false);
    assert.equal(fixture.metadata.active, 'candidate-active');
});

for (const prior of ['old-active', null]) {
    test(`a failed admission restores ${prior ? 'present' : 'absent'} prior metadata and reports a restored graph`, async (t) => {
        const fixture = harness(t, { graph: { running: true, configured: true }, faults: { finalize: true }, active: prior });
        writeGraphSkillScope(fixture.identity, buildHostSkillScope(fixture.identity.workspaceRoot, fixture.identity.workspaceRoot), {
            assertHeld() {},
        });
        await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']), error => {
            assert.match(error.message, /candidate finalize failed/);
            assert.equal(error.admission.outcome, 'recovered');
            assert.equal(error.activation.outcome, 'restored');
            return true;
        });
        assert.equal(fixture.metadata.active, prior);
        assert.deepEqual(fixture.store.list(ADMISSION_JOURNAL_KIND), []);
        // The prior graph was started again from the captured configuration.
        assert.deepEqual(coreCalls(fixture.events).at(-1), ['start', 'agent', '8080']);
    });
}

test('successor metadata written during admission is preserved and reported as recovery-required', async (t) => {
    const fixture = harness(t, {
        graph: { running: true, configured: true },
        faults: { finalize: true, finalizeSuccessor: true },
    });
    writeGraphSkillScope(fixture.identity, buildHostSkillScope(fixture.identity.workspaceRoot, fixture.identity.workspaceRoot), {
        assertHeld() {},
    });
    await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']), error => {
        assert.equal(error.admission.outcome, 'recovery-required');
        assert.equal(error.activation.outcome, 'recovery-required');
        assert.match(error.message, /agentlib-active: successor-preserved/);
        return true;
    });
    assert.equal(fixture.metadata.active, 'successor-active');
    const [journal] = fixture.store.list(ADMISSION_JOURNAL_KIND);
    assert.equal(fixture.store.read(ADMISSION_JOURNAL_KIND, journal).phase, 'recovery-required');
});

test('a failed restart without a restorable prior graph is recovery-required, not restored', async (t) => {
    const fixture = harness(t, { graph: { running: true, configured: true }, faults: { restart: true } });
    await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']), error => {
        assert.equal(error.activation.outcome, 'recovery-required');
        return true;
    });
    assert.equal(fixture.metadata.active, 'old-active');
});

test('a required in-Box failure blocks activation of a reused Box without any restart', async (t) => {
    const fixture = harness(t, { graph: { running: true, configured: true }, faults: { core: true } });
    const result = await fixture.supervisor.runUpdateTransaction(['update']);
    assert.equal(result.decision.exitCode, 1);
    assert.equal(result.activation.outcome, 'deferred');
    assert.deepEqual(coreCalls(fixture.events), [['update']], 'no mixed-version restart');
    assert.equal(fixture.events.includes('health'), false);
    assert.equal(fixture.events.includes('commit-agentlib'), false);
    assert.equal(fixture.events.includes('finalize'), true);
    assert.equal(fixture.metadata.active, 'old-active');
    assert.notEqual(fixture.store.read('update-pending', fixture.identity.instance), null);
});

test('a failure before any graph mutation reports the prior graph as preserved', async (t) => {
    const fixture = harness(t, { graph: { running: true, configured: true }, faults: { reconcile: true } });
    await assert.rejects(fixture.supervisor.runUpdateTransaction(['update']), error => {
        assert.equal(error.activation.outcome, 'preserved');
        assert.equal(error.activation.graphMutated, false);
        return true;
    });
    assert.deepEqual(coreCalls(fixture.events), []);
    assert.equal(fixture.metadata.active, 'old-active');
});

test('unresolved journals of other transactions are reported and retained', async (t) => {
    const store = createMemoryUpdateHostState();
    const fixture = harness(t, { store });
    const name = `${fixture.identity.instance}.0000000000000001`;
    store.write(ADMISSION_JOURNAL_KIND, name, { operation: 'restart', phase: 'admitting', createdAt: 'then' });
    const result = await fixture.supervisor.runUpdateTransaction(['update']);
    assert.deepEqual(result.unresolvedAdmissions, [{ name, operation: 'restart', phase: 'admitting', createdAt: 'then' }]);
    assert.deepEqual(store.list(ADMISSION_JOURNAL_KIND), [name]);
});

test('production lock managers select durable private host state for pending activation', async (t) => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-home-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const lockManager = createMutationLockManager({ homeDirectory: home });
    const probe = harness(t, { graph: { running: true, configured: true }, lockManager });
    // Rebuild the supervisor without an injected store so the default is used.
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => probe.identity,
        launchCwd: probe.identity.workspaceRoot,
        lockManager,
        discover: () => ({
            state: 'owned',
            engine: { name: 'podman', identity: 'engine' },
            handles: { container: { id: CONTAINER_ID, runtime: { running: true } } },
        }),
        env: {},
        stdout: { write() {} },
        stderr: { write() {} },
        runner: {
            run() {},
            query: () => ({ ok: true, stdout: JSON.stringify({ initialized: true, routingConfigured: true }) }),
        },
        captureCoreStartArgv: () => ['start', 'agent', '8080'],
        selectAgentLib: async () => ({ selection: probe.selection }),
        reconcile: async () => ({
            action: 'reused',
            ownership: { state: 'owned', engine: { name: 'podman' }, handles: { container: { id: CONTAINER_ID } } },
            hostPort: 8080,
            mediaHostPort: 7882,
            finalize() {},
        }),
        runCoreCommand: async () => {},
        runRestartCore: fakeRestartCore(),
        runUpdateCore: fakeUpdateCore(),
    });
    const result = await supervisor.runUpdateTransaction(['update', 'repos'], { request: { kind: 'repos' } });
    assert.equal(result.activation.outcome, 'deferred');
    const file = path.join(home, '.ploinky-box', 'update-pending', `${probe.identity.instance}.json`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).instance, probe.identity.instance);
});

test('a reporting failure after a settled restart never stops or restores the graph', async (t) => {
    const store = createMemoryUpdateHostState();
    const failing = {
        ...store,
        remove(kind, name) {
            if (kind === 'update-pending') throw new Error('pending state unavailable');
            return store.remove(kind, name);
        },
    };
    const fixture = harness(t, { graph: { running: true, configured: true }, store: failing });
    const events = [];
    let settled = false;
    const closedAfterSettlement = name => ({
        write() { if (settled) throw new Error(`${name} closed`); },
    });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => fixture.identity,
        launchCwd: fixture.identity.workspaceRoot,
        lockManager: {
            async acquire() {
                return { assertHeld() {}, release() { events.push('release'); } };
            },
        },
        discover: () => ({
            state: 'owned',
            engine: { name: 'podman', identity: 'engine' },
            handles: { container: { id: CONTAINER_ID, runtime: { running: true } } },
        }),
        env: {},
        stdout: closedAfterSettlement('stdout'),
        stderr: closedAfterSettlement('stderr'),
        updateHostState: failing,
        runner: { run(_command, args) { events.push(`run:${args.join(' ')}`); } },
        captureCoreStartArgv: () => ['start', 'agent', '8080'],
        selectAgentLib: async () => ({ selection: fixture.selection }),
        reconcile: async () => ({
            action: 'reused',
            ownership: { state: 'owned', engine: { name: 'podman' }, handles: { container: { id: CONTAINER_ID } } },
            hostPort: 8080,
            mediaHostPort: 7882,
            routerBinding: { address: '0.0.0.0', hostPort: 8080, hosts: ['host.example'] },
            finalize() { events.push('finalize'); settled = true; },
            async rollback() { events.push('rollback'); return { action: 'reused-preserved' }; },
        }),
        resolveHostReachableIpv4: async () => '',
        runCoreCommand: async (_engine, _id, argv) => { events.push(['core', argv]); },
        runRestartCore: fakeRestartCore(async (_engine, _id, argv) => { events.push(['core', argv]); }),
        healthCheck: async () => { events.push('health'); },
        revalidateAgentLibSource() {},
        commitAgentLibSelection() {},
        readAgentLibActive: () => null,
        restoreAgentLibActive() { events.push('restore-active'); },
    });
    const result = await supervisor.runRestartTransaction(['restart']);
    assert.equal(result.action, 'reused');
    assert.equal(events.includes('finalize'), true);
    for (const forbidden of ['rollback', 'restore-active']) assert.equal(events.includes(forbidden), false, forbidden);
    assert.equal(events.some(event => typeof event === 'string' && event.includes('ploinky-local stop')), false);
});

test('a disrupted active graph that could not be rebuilt is recovery-required, never restored', async (t) => {
    // routing.json exists (the graph is active) but has no captured start
    // command, so a replaced Box whose activation is blocked comes back
    // without its graph.
    const fixture = harness(t, {
        graph: { running: true, configured: true },
        reconcileAction: 'replaced',
        priorArgv: null,
        faults: { core: true },
    });
    const result = await fixture.supervisor.runUpdateTransaction(['update']);
    assert.equal(result.activation.outcome, 'recovery-required');
    assert.equal(result.decision.exitCode, 1);
    assert.equal(fixture.events.includes('rollback'), true);
    assert.deepEqual(coreCalls(fixture.events), [['update']]);
});

test('a blocked activation of a replaced Box reconstructs the prior Box and graph', async (t) => {
    const fixture = harness(t, {
        graph: { running: true, configured: true },
        reconcileAction: 'replaced',
        faults: { core: true },
    });
    writeGraphSkillScope(fixture.identity, buildHostSkillScope(fixture.identity.workspaceRoot, fixture.identity.workspaceRoot), {
        assertHeld() {},
    });
    const result = await fixture.supervisor.runUpdateTransaction(['update']);
    assert.equal(result.activation.outcome, 'restored');
    assert.deepEqual(coreCalls(fixture.events), [['update'], ['start', 'agent', '8080']]);
    assert.equal(fixture.metadata.active, 'old-active');
});

test('a full update that did not restart keeps a pending targeted activation', async (t) => {
    const fixture = harness(t, { graph: { running: true, configured: true } });
    await fixture.supervisor.runUpdateTransaction(['update', 'repos'], { request: { kind: 'repos' } });
    assert.notEqual(fixture.store.read('update-pending', fixture.identity.instance), null);
    fixture.graph.configured = false;
    const result = await fixture.supervisor.runUpdateTransaction(['update']);
    assert.equal(result.activation.outcome, 'not-required');
    assert.notEqual(fixture.store.read('update-pending', fixture.identity.instance), null,
        'nothing was activated, so the pending record stays');
});

test('an unreadable running graph defers activation instead of declaring it unneeded', async (t) => {
    const fixture = harness(t, { graph: { running: true, configured: true }, inboxReadable: false });
    const result = await fixture.supervisor.runUpdateTransaction(['update']);
    assert.equal(result.activation.outcome, 'deferred');
    assert.deepEqual(coreCalls(fixture.events), [['update']]);
    const pending = fixture.store.read('update-pending', fixture.identity.instance);
    assert.match(pending.reason, /could not be read/);

    const targeted = harness(t, { graph: { running: true, configured: true }, inboxReadable: false });
    const repo = await targeted.supervisor.runUpdateTransaction(['update', 'repo', 'demo'], {
        request: { kind: 'repo', repoName: 'demo' },
    });
    assert.equal(repo.activation.outcome, 'deferred');
});
