import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { UPDATE_REPORT_NONCE_ENV } from '../../cli/commands/updateOutcome.js';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';
import { createRouterBindingStore } from '../../ploinky-box/routerBinding.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { ADMISSION_JOURNAL_KIND, runJournaledAdmission } from '../../ploinky-box/update/admission.mjs';
import { createMemoryUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';
import { verifiedRecord } from '../helpers/fakeUpdateCore.mjs';
import { createUpdateBoxScenario, SCENARIO_CONTAINER_ID, scenarioCoreCalls } from '../helpers/updateBoxScenario.mjs';

// Mutation-gap regressions for the Box update transaction:
// - the supervisor wired to the production bounded update runner probes for
//   in-Box writers even after a successful exit;
// - an admission restore that returns without restoring is not "restored";
// - a failed start admission restores the saved Router binding bytes;
// - two update transactions on one real mutation lock never interleave.

const FAKE_ENGINE_SCRIPT = fileURLToPath(new URL('../fixtures/fake-engine-update-exec.mjs', import.meta.url));

function scratch(t, prefix) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

test('the production update runner probes after a successful exit: a writer that outlived the command blocks activation and restart', async (t) => {
    const root = scratch(t, 'ploinky-update-real-runner-');
    const workspace = path.join(root, 'workspace');
    const pidFile = path.join(root, 'writer.pid');
    const engineLog = path.join(root, 'engine.log');
    const engine = path.join(root, 'fake-engine');
    // The supervisor spawns this path as the engine client with an allowlisted
    // environment, so the fixture settings travel inside the launcher itself.
    fs.writeFileSync(engine, [
        '#!/bin/sh',
        `FAKE_ENGINE_WORKSPACE=${shellQuote(workspace)} FAKE_ENGINE_LOG=${shellQuote(engineLog)} `
            + `FAKE_ENGINE_DETACHED_PID_FILE=${shellQuote(pidFile)} `
            + `exec ${shellQuote(process.execPath)} ${shellQuote(FAKE_ENGINE_SCRIPT)} "$@"`,
        '',
    ].join('\n'));
    fs.chmodSync(engine, 0o755);
    let spawnedWriter = null;
    const writerPid = () => {
        if (spawnedWriter === null && fs.existsSync(pidFile)) spawnedWriter = Number(fs.readFileSync(pidFile, 'utf8'));
        return spawnedWriter;
    };
    t.after(() => {
        // Only the exact descendant this test's fixture spawned. The pid is
        // cached because the scratch cleanup may already have removed its file.
        const pid = writerPid();
        if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
    });

    const queries = [];
    let graphConfigured = true;
    const runner = {
        run() {},
        query(_command, args) {
            queries.push([...args]);
            if (args[0] === 'container' && args[1] === 'inspect') return { ok: true, stdout: 'true\n' };
            if (args[0] === 'container' && args[1] === 'exec' && args.includes('kill')) {
                const flag = args.find(arg => /^-[A-Z]+$/.test(arg));
                const signal = flag.slice(1);
                const pids = args.slice(args.indexOf(flag) + 1).map(Number);
                for (const pid of pids) if (pid === writerPid() && isAlive(pid)) process.kill(pid, `SIG${signal}`);
                return { ok: true, stdout: '' };
            }
            if (args[0] === 'container' && args[1] === 'exec' && args.includes('-e')) {
                assert.equal(args.at(-1).startsWith(`${UPDATE_REPORT_NONCE_ENV}=`), true, 'the probe targets this nonce');
                const pid = writerPid();
                return { ok: true, stdout: JSON.stringify(pid && isAlive(pid) ? [pid] : []) };
            }
            return { ok: true, stdout: JSON.stringify({ initialized: true, routingConfigured: graphConfigured }) };
        },
    };
    const fixture = createUpdateBoxScenario({
        root,
        workspace,
        engineName: engine,
        runner,
        runUpdateCore: null,
        graph: { running: true, configured: true },
    });

    const result = await fixture.supervisor.runUpdateTransaction(['update']);
    writerPid();

    const launches = fs.readFileSync(engineLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(launches.map(entry => entry.coreArgv), [['update']], 'the real runner spawned the engine client once');
    const runnerRecord = result.records.find(record => record.id === 'in-box-update-runner');
    assert.ok(runnerRecord, `a runner record names the outlived writer: ${JSON.stringify(result.records)}`);
    assert.equal(runnerRecord.outcome, 'uncertain');
    assert.equal(runnerRecord.code, 'writer-outlived-command');
    assert.equal(result.run.cause, 'writer-outlived-command');
    assert.equal(result.run.status, 0, 'the engine client itself exited 0 after a valid report');
    assert.equal(result.decision.activationAllowed, false);
    assert.equal(result.decision.exitCode, 1);
    assert.notEqual(result.activation.outcome, 'restarted');
    assert.deepEqual(scenarioCoreCalls(fixture.events), [], 'no in-Box restart after an unverified report snapshot');
    assert.equal(fixture.events.includes('health'), false);
    assert.equal(fixture.events.includes('commit-agentlib'), false);
    const pid = writerPid();
    assert.ok(Number.isInteger(pid), 'the fixture left a detached writer');
    assert.ok(queries.some(args => args.includes('kill') && args.includes('-TERM') && args.includes(String(pid))),
        'the runner escalated against the surviving writer');
    assert.equal(isAlive(pid), false, 'the surviving writer was stopped');
    // Quiescence was confirmed after TERM, so no recovery barrier is left.
    assert.equal(fixture.store.read('update-recovery', fixture.identity.instance), null);
});

test('an admission restore that returns normally but leaves the candidate is restore-unverified, recovery-required and keeps the journal', async () => {
    const store = createMemoryUpdateHostState();
    const identity = { instance: 'ploinky-box-gaps-0123456789ab', workspaceRoot: '/workspace/gaps' };
    const values = { restoring: { v: 'prior-a' }, silent: { v: 'prior-b' } };
    const item = (name, restores) => ({
        name,
        read: () => values[name],
        write: () => { values[name] = { v: `candidate-${name}` }; },
        restore: (prior) => { if (restores) values[name] = prior; },
    });
    const transactionId = '00000000000000aa';
    await assert.rejects(runJournaledAdmission({
        identity,
        store,
        operation: 'update',
        transactionId,
        items: [item('restoring', true), item('silent', false)],
        settle: async () => { throw new Error('candidate finalize failed'); },
    }), (error) => {
        assert.match(error.message, /candidate finalize failed/);
        assert.equal(error.admission.outcome, 'recovery-required');
        assert.deepEqual(error.admission.results.map(result => [result.name, result.outcome]), [
            ['silent', 'restore-unverified'],
            ['restoring', 'restored'],
        ]);
        assert.match(error.message, /silent: restore-unverified/);
        assert.match(error.message, /was retained/);
        return true;
    });
    assert.deepEqual(values.restoring, { v: 'prior-a' });
    assert.deepEqual(values.silent, { v: 'candidate-silent' }, 'the unrestored candidate is left as observed');
    const name = `${identity.instance}.${transactionId}`;
    assert.deepEqual(store.list(ADMISSION_JOURNAL_KIND), [name], 'the journal is retained for recovery');
    const journal = store.read(ADMISSION_JOURNAL_KIND, name);
    assert.equal(journal.phase, 'recovery-required');
    assert.deepEqual(journal.recovery.results.map(result => result.outcome), ['restore-unverified', 'restored']);
});

test('a failed start admission restores the prior saved Router binding bytes exactly', async (t) => {
    const root = scratch(t, 'ploinky-update-router-binding-');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const selection = agentLibFixture(identity.workspaceRoot);
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const bindingStore = createRouterBindingStore({ homeDirectory: home });
    const heldLock = { assertHeld(instance) { assert.equal(instance, identity.instance); } };
    bindingStore.write(identity, { address: '127.0.0.1', hostPort: 8083 }, heldLock);
    const stateDir = path.join(home, '.ploinky-box');
    const bindingFiles = () => {
        const files = {};
        const visit = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) visit(full);
                else if (!full.includes(`${path.sep}locks${path.sep}`)) files[path.relative(stateDir, full)] = fs.readFileSync(full).toString('base64');
            }
        };
        visit(stateDir);
        return files;
    };
    const before = bindingFiles();
    assert.equal(Object.keys(before).length, 1, 'one saved binding file');

    const events = [];
    const ownership = {
        state: 'owned',
        engine: { name: 'podman', identity: 'engine' },
        handles: { container: { id: SCENARIO_CONTAINER_ID, runtime: { running: true } } },
    };
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        platform: 'linux',
        env: {},
        repositoryRoot: root,
        stdout: { write() { return true; } },
        stderr: { write() { return true; } },
        checkHostPrerequisites: () => {},
        lockManager: {
            async acquire() {
                events.push('lock');
                return { assertHeld() {}, release() { events.push('release'); } };
            },
        },
        discover: () => ownership,
        updateHostState: createMemoryUpdateHostState(),
        routerBindingStore: bindingStore,
        readNetworkInterfaces: () => ({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }),
        readHostname: () => 'fixture-host',
        runner: {
            run(_command, args) { events.push(`run:${args.at(-1)}`); },
            async stream() { return { ok: true, status: 0, stdout: '', stderr: '' }; },
            query() { return { ok: true, stdout: JSON.stringify({ initialized: true, routingConfigured: true }) }; },
        },
        captureCoreStartArgv: () => ['start', 'agent', '8080'],
        selectAgentLib: async () => ({ selection }),
        readEdgeDesired: () => null,
        async reconcile(options) {
            events.push(['reconcile', options.routerBinding?.address, options.routerBinding?.hostPort]);
            return {
                action: 'reused',
                ownership,
                hostPort: options.routerBinding.hostPort,
                mediaHostPort: 7882,
                routerBinding: options.routerBinding,
                previousAgentLib: selection,
                validate() {},
                finalize() { events.push('finalize'); throw new Error('candidate finalize failed'); },
                async rollback() {
                    events.push('rollback');
                    return { action: 'reused-preserved', containerId: SCENARIO_CONTAINER_ID, hostPort: 8083, mediaHostPort: 7882, agentLib: selection };
                },
            };
        },
        startCore: async (_engine, _id, argv) => { events.push(['start-core', [...argv]]); },
        runCoreCommand: async (_engine, _id, argv) => { events.push(['core', [...argv]]); },
        resolveHostReachableIpv4: async () => '',
        healthCheck: async () => { events.push('health'); },
        revalidateAgentLibSource() {},
        commitAgentLibSelection() {},
        readAgentLibActive: () => null,
        restoreAgentLibActive() {},
    });

    await assert.rejects(supervisor.runStartTransaction(['start', 'agent', '8080'], { explicitPort: 8090 }), (error) => {
        assert.match(error.message, /candidate finalize failed/);
        assert.equal(error.admission?.outcome, 'recovered', JSON.stringify(error.admission));
        assert.deepEqual(error.admission.results.find(result => result.name === 'router-binding'),
            { name: 'router-binding', outcome: 'restored' });
        return true;
    });
    assert.deepEqual(events.find(event => Array.isArray(event) && event[0] === 'reconcile'), ['reconcile', '127.0.0.1', 8090],
        'the candidate used a different saved port, so the binding was an admission item');
    assert.ok(events.includes('finalize'));
    assert.deepEqual(bindingFiles(), before, 'the saved Router binding file is byte-identical to the prior one');
    assert.deepEqual({ ...bindingStore.read(identity) }, { address: '127.0.0.1', hostPort: 8083, containerPort: 8080 });
});

function gatedScenario(root, name, { lockManager, timeline, gate }) {
    return createUpdateBoxScenario({
        root: path.join(root, name),
        workspace: path.join(root, 'workspace'),
        lockManager,
        graph: { running: false, configured: false },
        core: {
            async onCall() {
                timeline.push(`${name}:start`);
                await gate?.promise;
                timeline.push(`${name}:end`);
            },
            records: () => [verifiedRecord()],
        },
    });
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('condition was not reached in time');
        await delay(10);
    }
}

test('two overlapping update transactions on one real mutation lock never interleave their in-Box updates', async (t) => {
    const root = scratch(t, 'ploinky-update-overlap-');
    fs.mkdirSync(path.join(root, 'first'), { recursive: true });
    fs.mkdirSync(path.join(root, 'second'), { recursive: true });
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const timeline = [];
    const gate = deferred();
    const first = gatedScenario(root, 'first', {
        lockManager: createMutationLockManager({ homeDirectory: home, retryMs: 10, timeoutMs: 10_000 }), timeline, gate,
    });
    const second = gatedScenario(root, 'second', {
        lockManager: createMutationLockManager({ homeDirectory: home, retryMs: 10, timeoutMs: 10_000 }), timeline,
    });
    assert.equal(first.identity.instance, second.identity.instance, 'both transactions target one workspace');

    const running = first.supervisor.runUpdateTransaction(['update']);
    await waitFor(() => timeline.includes('first:start'));
    const waiting = second.supervisor.runUpdateTransaction(['update']);
    await delay(300);
    assert.deepEqual(timeline, ['first:start'], 'the second update waits while the first holds the lock');
    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([running, waiting]);
    assert.deepEqual(timeline, ['first:start', 'first:end', 'second:start', 'second:end']);
    assert.equal(firstResult.decision.exitCode, 0);
    assert.equal(secondResult.decision.exitCode, 0);
});

test('an overlapping update that cannot get the real mutation lock in time is refused before any in-Box update', async (t) => {
    const root = scratch(t, 'ploinky-update-overlap-refused-');
    fs.mkdirSync(path.join(root, 'first'), { recursive: true });
    fs.mkdirSync(path.join(root, 'second'), { recursive: true });
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const timeline = [];
    const gate = deferred();
    const first = gatedScenario(root, 'first', {
        lockManager: createMutationLockManager({ homeDirectory: home, retryMs: 10, timeoutMs: 10_000 }), timeline, gate,
    });
    const second = gatedScenario(root, 'second', {
        lockManager: createMutationLockManager({ homeDirectory: home, retryMs: 10, timeoutMs: 250 }), timeline,
    });
    const running = first.supervisor.runUpdateTransaction(['update']);
    try {
        await waitFor(() => timeline.includes('first:start'));
        await assert.rejects(second.supervisor.runUpdateTransaction(['update']), (error) => {
            assert.equal(error.code, 'PLOINKY_BOX_LOCK_FAILED');
            assert.match(error.message, /Timed out waiting for mutation lock/);
            assert.match(error.message, new RegExp(`Another Ploinky command \\(pid ${process.pid} on `), 'the holder is named');
            assert.equal(error.workspaceTransactionStarted, false, 'the refusal says the transaction never started');
            assert.equal(error.lockBusy, true, 'the refusal names a busy lock');
            return true;
        });
        assert.deepEqual(timeline, ['first:start'], 'the refused update never started its in-Box update');
        assert.deepEqual(second.events, [], 'the refused update did nothing under the lock');
    } finally {
        gate.resolve();
    }
    const result = await running;
    assert.equal(result.decision.exitCode, 0);
    assert.deepEqual(timeline, ['first:start', 'first:end']);
});
