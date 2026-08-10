import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runLogCommand } from '../../cli/commands/logCommands.js';
import { proveExactOciLogSource } from '../../cli/sandbox/docker/containerOwnership.js';
import { NETWORK_LABELS } from '../../cli/sandbox/networkIdentity.js';
import { NETWORK_SCHEMA_VERSION } from '../../cli/sandbox/networkContract.js';

const CONTAINER = 'ploinky_demo_shared';
const RUN_A = '11111111-2222-4333-8444-555555555555';
const RUN_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const CONTAINER_ID = 'a'.repeat(64);
const CONTRACT_HASH = 'b'.repeat(64);
const WORKSPACE_HASH = 'c1d2e3f40506';
const INSTANCE_ID = 'instance-0001';
const ENABLE_GENERATION = 'generation-0001';
const RUN_STARTED_AT_MS = 1_760_000_000_000;
const NOW_MS = RUN_STARTED_AT_MS + 1_000;

function collector() {
    const chunks = [];
    return {
        chunks,
        write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
        text() { return Buffer.concat(chunks).toString('utf8'); },
    };
}

function harness(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-log-commands-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const logsDir = path.join(root, 'logs');
    const runningDir = path.join(root, 'running');
    fs.mkdirSync(path.join(logsDir, 'no-wait'), { recursive: true });
    fs.mkdirSync(path.join(runningDir, 'no-wait'), { recursive: true });
    return { root, logsDir, runningDir };
}

function agentRecord(overrides = {}) {
    return {
        [CONTAINER]: {
            type: 'agent',
            runtime: 'podman',
            containerId: CONTAINER_ID,
            instanceId: INSTANCE_ID,
            enableGeneration: ENABLE_GENERATION,
            repoName: 'demo',
            agentName: 'shared',
            ...overrides,
        },
    };
}

function inspectedContainer({ labels = {}, running = true } = {}) {
    return {
        Id: CONTAINER_ID,
        Name: `/${CONTAINER}`,
        State: { Running: running },
        HostConfig: { Init: true },
        Config: {
            Labels: {
                [NETWORK_LABELS.managed]: '1',
                [NETWORK_LABELS.resource]: 'agent',
                [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
                [NETWORK_LABELS.workspace]: WORKSPACE_HASH,
                [NETWORK_LABELS.contract]: CONTRACT_HASH,
                [NETWORK_LABELS.instanceId]: INSTANCE_ID,
                [NETWORK_LABELS.enableGeneration]: ENABLE_GENERATION,
                ...labels,
            },
        },
    };
}

function writeMarker(runningDir, { runId = RUN_A, waveIndex = 0, ...overrides } = {}) {
    fs.writeFileSync(
        path.join(runningDir, 'no-wait', `${CONTAINER}.current.json`),
        JSON.stringify({
            runId,
            runStartedAtMs: RUN_STARTED_AT_MS,
            statusFile: `${CONTAINER}.${runId}.json`,
            waveIndex,
            createdAt: new Date(RUN_STARTED_AT_MS).toISOString(),
            ...overrides,
        }),
    );
}

function writeStatus(runningDir, { runId = RUN_A, state = 'starting', ...overrides } = {}) {
    fs.writeFileSync(
        path.join(runningDir, 'no-wait', `${CONTAINER}.${runId}.json`),
        JSON.stringify({
            containerName: CONTAINER,
            state,
            sequencePhase: 'active',
            sequencePhaseStartedAtMs: RUN_STARTED_AT_MS,
            sequencePhaseStartedAt: new Date(RUN_STARTED_AT_MS).toISOString(),
            runId,
            runStartedAtMs: RUN_STARTED_AT_MS,
            waveIndex: 0,
            pid: 4242,
            ...overrides,
        }),
    );
}

function writeStartupLog(logsDir, { runId = RUN_A, body = 'startup line one\n' } = {}) {
    fs.writeFileSync(path.join(logsDir, 'no-wait', `${CONTAINER}.${runId}.log`), body);
}

function appendStartupLog(logsDir, { runId = RUN_A, body }) {
    fs.appendFileSync(path.join(logsDir, 'no-wait', `${CONTAINER}.${runId}.log`), body);
}

// Records the exact spawn arguments and emits application output before the
// terminal close, so each test controls the interleaving deterministically.
function fakeRuntimeSpawn(events, { chunks = ['application output\n'], code = 0 } = {}) {
    return (command, args) => {
        events.push([command, ...args]);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => {
            for (const chunk of chunks) child.stdout.emit('data', Buffer.from(chunk));
            child.emit('close', code, null);
        });
        return child;
    };
}

function baseOptions({ logsDir, runningDir }, overrides = {}) {
    return {
        output: collector(),
        errorOutput: collector(),
        logsDir,
        runningDir,
        nowMs: () => NOW_MS,
        readRegistrySnapshot: () => agentRecord(),
        proveOciSource: () => ({ runtime: 'podman', containerId: CONTAINER_ID, running: true }),
        proveWorkerProcess: () => ({ proof: 'test' }),
        sleepImpl: async () => {},
        ...overrides,
    };
}

test('logs last prefers a verified runtime over a live starting run', async (t) => {
    const env = harness(t);
    writeMarker(env.runningDir);
    writeStatus(env.runningDir, { state: 'starting' });
    writeStartupLog(env.logsDir);

    const events = [];
    const options = baseOptions(env, { spawnImpl: fakeRuntimeSpawn(events) });
    const code = await runLogCommand(['logs', 'last', '5', CONTAINER], options);

    assert.equal(code, 0);
    assert.deepEqual(events, [['podman', 'logs', '--tail', '5', CONTAINER_ID]]);
    assert.equal(options.output.text(), 'application output\n');
    // The startup file exists but must not be selected for `last`.
    assert.equal(options.output.text().includes('startup line one'), false);
});

test('runtime-first selection fences the registry again after ownership proof', async (t) => {
    const env = harness(t);
    let registryReads = 0;
    const options = baseOptions(env, {
        readRegistrySnapshot: () => {
            registryReads += 1;
            return registryReads >= 3
                // Even a coercible/case-only field replacement is not the
                // exact persisted source that passed ownership proof.
                ? agentRecord({ containerId: CONTAINER_ID.toUpperCase() })
                : agentRecord();
        },
        spawnImpl: () => { throw new Error('a changed runtime source must not be opened'); },
    });

    const code = await runLogCommand(['logs', 'last', '5', CONTAINER], options);

    assert.equal(code, 1);
    assert.equal(registryReads, 3);
    assert.match(options.errorOutput.text(), /changed during source acquisition/);
    assert.equal(options.output.text(), '');
});

test('logs last shows the current startup suffix when no runtime is provable', async (t) => {
    const env = harness(t);
    writeMarker(env.runningDir);
    writeStatus(env.runningDir, { state: 'starting' });
    writeStartupLog(env.logsDir, { body: 'startup line one\nstartup line two\n' });

    const options = baseOptions(env, {
        proveOciSource: () => { throw new Error('the recorded container for x no longer exists'); },
        spawnImpl: () => { throw new Error('no runtime child may be spawned'); },
    });
    const code = await runLogCommand(['logs', 'last', '5', CONTAINER], options);

    assert.equal(code, 0);
    assert.equal(options.output.text(), 'startup line one\nstartup line two\n');
});

test('a running publication with an unprovable runtime is a protocol failure', async (t) => {
    const env = harness(t);
    writeMarker(env.runningDir);
    writeStatus(env.runningDir, { state: 'running' });
    writeStartupLog(env.logsDir);

    const options = baseOptions(env, {
        proveOciSource: () => { throw new Error('the recorded container no longer exists'); },
        spawnImpl: () => { throw new Error('no runtime child may be spawned'); },
    });
    const code = await runLogCommand(['logs', 'last', '5', CONTAINER], options);

    assert.equal(code, 1);
    assert.match(options.errorOutput.text(), /published 'running' but its runtime could not be proved/);
    // No retry: the registry is read for the proof exactly once.
    assert.equal(options.output.text(), '');
});

test('logs last on a failed current run shows the suffix and a bounded failure summary', async (t) => {
    const env = harness(t);
    writeMarker(env.runningDir);
    writeStatus(env.runningDir, {
        state: 'failed',
        phase: 'readiness',
        error: { message: 'probe never became ready', stack: 'Error: probe never became ready\n    at x' },
        secretEnvironment: { TOKEN: 'super-secret-value' },
    });
    writeStartupLog(env.logsDir, { body: 'startup diagnostics\n' });

    const options = baseOptions(env, {
        proveOciSource: () => { throw new Error('no container'); },
    });
    const code = await runLogCommand(['logs', 'last', '5', CONTAINER], options);

    assert.equal(code, 1);
    assert.equal(options.output.text(), 'startup diagnostics\n');
    assert.match(options.errorOutput.text(), /phase: readiness — probe never became ready/);
    // Only already-bounded, redacted fields reach the operator.
    assert.equal(options.errorOutput.text().includes('super-secret-value'), false);
    assert.equal(options.errorOutput.text().includes('at x'), false);
});

test('logs tail follows the startup log then hands off once to the proved runtime', async (t) => {
    const env = harness(t);
    writeMarker(env.runningDir);
    writeStatus(env.runningDir, { state: 'starting' });
    writeStartupLog(env.logsDir, { body: 'startup line one\n' });

    const events = [];
    let polls = 0;
    const options = baseOptions(env, {
        spawnImpl: fakeRuntimeSpawn(events),
        sleepImpl: async () => {
            polls += 1;
            if (polls === 1) appendStartupLog(env.logsDir, { body: 'startup line two\n' });
            if (polls === 2) writeStatus(env.runningDir, { state: 'running' });
        },
    });
    const code = await runLogCommand(['logs', 'tail', CONTAINER], options);

    assert.equal(code, 0);
    const text = options.output.text();
    // Startup output first, then the runtime's own output after the handoff.
    assert.match(text, /startup line one\nstartup line two\napplication output\n$/);
    assert.deepEqual(events, [['podman', 'logs', '--follow', '--tail', '10', CONTAINER_ID]]);
    assert.match(options.errorOutput.text(), /is running; following its application output/);
    // Internal handoff cancellation is never reported as operator cancellation.
    assert.equal(options.errorOutput.text().includes('130'), false);
});

test('tail waits for the exact bound startup file and never falls through to a predecessor runtime', async (t) => {
    const env = harness(t);
    writeMarker(env.runningDir);
    writeStatus(env.runningDir, { state: 'starting' });
    let waits = 0;
    let proofs = 0;
    const options = baseOptions(env, {
        proveOciSource: () => {
            proofs += 1;
            return { runtime: 'podman', containerId: CONTAINER_ID, running: true };
        },
        spawnImpl: fakeRuntimeSpawn([]),
        sleepImpl: async () => {
            waits += 1;
            if (waits === 1) writeStartupLog(env.logsDir, { body: 'late startup\n' });
            else if (waits === 2) writeStatus(env.runningDir, { state: 'running' });
        },
    });
    const code = await runLogCommand(['logs', 'tail', CONTAINER], options);
    assert.equal(code, 0);
    assert.match(options.output.text(), /^late startup\napplication output\n$/);
    assert.equal(proofs, 1, 'runtime ownership is proved only at handoff');
});

test('opening a startup descriptor is fenced by a fresh marker and registry observation before bytes', async (t) => {
    const env = harness(t);
    writeMarker(env.runningDir);
    writeStatus(env.runningDir, { state: 'starting' });
    let waits = 0;
    let registryReads = 0;
    const options = baseOptions(env, {
        readRegistrySnapshot: () => { registryReads += 1; return agentRecord(); },
        proveOciSource: () => { throw new Error('a superseded run must not prove a runtime'); },
        sleepImpl: async () => {
            waits += 1;
            writeStartupLog(env.logsDir, { body: 'must not escape\n' });
            writeMarker(env.runningDir, { runId: RUN_B });
        },
    });
    const code = await runLogCommand(['logs', 'tail', CONTAINER], options);
    assert.equal(code, 1);
    assert.equal(options.output.text(), '');
    assert.match(options.errorOutput.text(), /superseded/);
    assert.ok(registryReads >= 2, 'each completed bound observation rereads the registry');
});

test('handoff reobserves the bound run after ownership proof and rejects a changed source identity', async (t) => {
    const env = harness(t);
    writeMarker(env.runningDir);
    writeStatus(env.runningDir, { state: 'starting' });
    writeStartupLog(env.logsDir, { body: 'startup\n' });
    let polls = 0;
    let registryReads = 0;
    let ownershipProofs = 0;
    const options = baseOptions(env, {
        readRegistrySnapshot: () => {
            registryReads += 1;
            return registryReads >= 5
                ? agentRecord({ containerId: 'd'.repeat(64) })
                : agentRecord();
        },
        proveOciSource: () => {
            ownershipProofs += 1;
            return { runtime: 'podman', containerId: CONTAINER_ID, running: true };
        },
        spawnImpl: () => { throw new Error('a changed handoff source must not spawn'); },
        sleepImpl: async () => {
            polls += 1;
            if (polls === 1) writeStatus(env.runningDir, { state: 'running' });
        },
    });
    const code = await runLogCommand(['logs', 'tail', CONTAINER], options);
    assert.equal(code, 1);
    assert.equal(ownershipProofs, 1);
    assert.match(options.errorOutput.text(), /changed during the final handoff fence/);
});

test('sandbox handoff pins one descriptor before the final observation fence', async (t) => {
    const env = harness(t);
    writeMarker(env.runningDir);
    writeStatus(env.runningDir, { state: 'running', pid: 4242 });
    fs.mkdirSync(path.join(env.logsDir, 'agents'));
    const target = path.join(env.logsDir, 'agents', 'pinned.log');
    const replacement = path.join(env.logsDir, 'agents', 'replacement.log');
    fs.writeFileSync(target, 'proved inode\n');
    fs.writeFileSync(replacement, 'replacement inode\n');

    const controller = new AbortController();
    let registryReads = 0;
    const options = baseOptions(env, {
        signal: controller.signal,
        readRegistrySnapshot: () => {
            registryReads += 1;
            if (registryReads === 3) fs.renameSync(replacement, target);
            return agentRecord({ runtime: 'bwrap', pid: 4242, containerId: undefined });
        },
        proveSandboxSource: () => ({
            runtime: 'bwrap',
            pid: 4242,
            fileSpec: { trustedRoot: env.logsDir, relativeSegments: ['agents', 'pinned.log'] },
        }),
        spawnImpl: () => { throw new Error('a sandbox source must not spawn a runtime child'); },
        sleepImpl: async () => { controller.abort(); },
    });
    const code = await runLogCommand(['logs', 'tail', CONTAINER], options);

    assert.equal(code, 0);
    assert.equal(options.output.text(), 'proved inode\n');
    assert.equal(options.output.text().includes('replacement inode'), false);
});

test('logs tail on a followed failure returns 1 and never falls back to a runtime', async (t) => {
    const env = harness(t);
    writeMarker(env.runningDir);
    writeStatus(env.runningDir, { state: 'starting' });
    writeStartupLog(env.logsDir, { body: 'startup line one\n' });

    let polls = 0;
    const options = baseOptions(env, {
        spawnImpl: () => { throw new Error('a followed failure must not open a runtime'); },
        sleepImpl: async () => {
            polls += 1;
            if (polls === 1) {
                writeStatus(env.runningDir, {
                    state: 'failed',
                    phase: 'launch',
                    error: { message: 'image pull failed' },
                });
            }
        },
    });
    const code = await runLogCommand(['logs', 'tail', CONTAINER], options);

    assert.equal(code, 1);
    assert.match(options.errorOutput.text(), /phase: launch — image pull failed/);
});

test('a superseding marker stops the follower before any handoff', async (t) => {
    const env = harness(t);
    writeMarker(env.runningDir);
    writeStatus(env.runningDir, { state: 'starting' });
    writeStartupLog(env.logsDir, { body: 'startup line one\n' });

    let polls = 0;
    const options = baseOptions(env, {
        spawnImpl: () => { throw new Error('a superseded run must not open a runtime'); },
        sleepImpl: async () => {
            polls += 1;
            if (polls === 1) {
                // A newer start publishes its own marker under the same key.
                writeMarker(env.runningDir, { runId: RUN_B });
                writeStatus(env.runningDir, { runId: RUN_B, state: 'running' });
            }
        },
    });
    const code = await runLogCommand(['logs', 'tail', CONTAINER], options);

    assert.equal(code, 1);
    assert.match(options.errorOutput.text(), /superseded the observed no-wait run/);
});

test('a changed or removed registry tuple stops the follower before handoff', async (t) => {
    for (const [label, snapshots] of [
        ['changed generation', [agentRecord(), agentRecord({ enableGeneration: 'generation-0002' })]],
        ['removed record', [agentRecord(), {}]],
    ]) {
        const env = harness(t);
        writeMarker(env.runningDir);
        writeStatus(env.runningDir, { state: 'starting' });
        writeStartupLog(env.logsDir, { body: 'startup line one\n' });

        let reads = 0;
        let polls = 0;
        const options = baseOptions(env, {
            readRegistrySnapshot: () => {
                reads += 1;
                return reads === 1 ? snapshots[0] : snapshots[1];
            },
            spawnImpl: () => { throw new Error(`${label}: no runtime may be opened`) },
            sleepImpl: async () => {
                polls += 1;
                if (polls === 1) writeStatus(env.runningDir, { state: 'running' });
            },
        });
        const code = await runLogCommand(['logs', 'tail', CONTAINER], options);

        assert.equal(code, 1, label);
        assert.match(
            options.errorOutput.text(),
            /(generation for .* changed during observation|is no longer an enabled agent)/,
            label,
        );
    }
});

test('a foreign run id, container, wave, or phase in the status fails closed', async (t) => {
    const cases = [
        ['foreign run id in status', { runId: RUN_B }],
        ['foreign container', { containerName: 'ploinky_other' }],
        ['foreign wave', { waveIndex: 3 }],
        ['foreign run start', { runStartedAtMs: RUN_STARTED_AT_MS + 5 }],
        ['invalid state', { state: 'bogus' }],
        ['running outside active phase', { state: 'running', sequencePhase: 'waiting-barrier' }],
        ['string run start', { runStartedAtMs: String(RUN_STARTED_AT_MS) }],
    ];
    for (const [label, overrides] of cases) {
        const env = harness(t);
        writeMarker(env.runningDir);
        // Always write the status under the marker's own run-scoped name so
        // the mismatch is inside the document, not in the filename.
        fs.writeFileSync(
            path.join(env.runningDir, 'no-wait', `${CONTAINER}.${RUN_A}.json`),
            JSON.stringify({
                containerName: CONTAINER,
                state: 'starting',
                sequencePhase: 'active',
                sequencePhaseStartedAtMs: RUN_STARTED_AT_MS,
                runId: RUN_A,
                runStartedAtMs: RUN_STARTED_AT_MS,
                waveIndex: 0,
                pid: 4242,
                ...overrides,
            }),
        );
        writeStartupLog(env.logsDir);

        const options = baseOptions(env, {
            proveOciSource: () => { throw new Error('no container'); },
        });
        const code = await runLogCommand(['logs', 'last', '5', CONTAINER], options);
        assert.equal(code, 1, label);
    }
});

test('a malformed run marker fails closed without probing any log', async (t) => {
    const cases = [
        ['not an object', '[]'],
        ['no run id', JSON.stringify({ runStartedAtMs: RUN_STARTED_AT_MS, waveIndex: 0, statusFile: 'x.json' })],
        ['string run start', JSON.stringify({
            runId: RUN_A, runStartedAtMs: String(RUN_STARTED_AT_MS), waveIndex: 0,
            statusFile: `${CONTAINER}.${RUN_A}.json`,
        })],
        ['foreign status file', JSON.stringify({
            runId: RUN_A, runStartedAtMs: RUN_STARTED_AT_MS, waveIndex: 0,
            statusFile: `${CONTAINER}.${RUN_B}.json`,
        })],
        ['status path escape', JSON.stringify({
            runId: RUN_A, runStartedAtMs: RUN_STARTED_AT_MS, waveIndex: 0,
            statusFile: `../../${CONTAINER}.${RUN_A}.json`,
        })],
        ['negative wave', JSON.stringify({
            runId: RUN_A, runStartedAtMs: RUN_STARTED_AT_MS, waveIndex: -1,
            statusFile: `${CONTAINER}.${RUN_A}.json`,
        })],
    ];
    for (const [label, body] of cases) {
        const env = harness(t);
        fs.writeFileSync(path.join(env.runningDir, 'no-wait', `${CONTAINER}.current.json`), body);
        writeStartupLog(env.logsDir);
        const options = baseOptions(env);
        const code = await runLogCommand(['logs', 'tail', CONTAINER], options);
        assert.equal(code, 1, label);
        assert.equal(options.output.text(), '', label);
    }
});

test('a dead pid, reused pid, or wrong worker argv fails closed', async (t) => {
    for (const label of ['not running', 'reused pid', 'wrong command']) {
        const env = harness(t);
        writeMarker(env.runningDir);
        writeStatus(env.runningDir, { state: 'starting' });
        writeStartupLog(env.logsDir);

        const options = baseOptions(env, {
            proveOciSource: () => { throw new Error('no container'); },
            proveWorkerProcess: ({ pid, workerScriptPath, identity }) => {
                // The observer must always ask for identity, not just liveness.
                assert.equal(pid, 4242, label);
                assert.ok(workerScriptPath.endsWith('/noWaitWorker.js'), label);
                assert.equal(identity.container, CONTAINER, label);
                assert.equal(identity.runId, RUN_A, label);
                const error = new Error(`worker process 4242 ${label}`);
                error.code = label === 'not running'
                    ? 'PROCESS_IDENTITY_STALE'
                    : 'PROCESS_IDENTITY_UNPROVEN';
                throw error;
            },
        });
        const code = await runLogCommand(['logs', 'last', '5', CONTAINER], options);
        assert.equal(code, 1, label);
        assert.match(options.errorOutput.text(), new RegExp(label), label);
    }
});

test('only a stale dead worker may yield to a coexisting proved runtime', async (t) => {
    for (const [label, errorCode, expectedCode, expectedRuntimeEvents] of [
        ['dead worker', 'PROCESS_IDENTITY_STALE', 0, 1],
        ['foreign live worker', 'PROCESS_IDENTITY_UNPROVEN', 1, 0],
    ]) {
        const env = harness(t);
        writeMarker(env.runningDir);
        writeStatus(env.runningDir, { state: 'starting' });
        writeStartupLog(env.logsDir, { body: 'must not be selected\n' });
        const events = [];
        const options = baseOptions(env, {
            spawnImpl: fakeRuntimeSpawn(events),
            proveWorkerProcess: () => {
                const error = new Error(label);
                error.code = errorCode;
                throw error;
            },
        });

        assert.equal(await runLogCommand(['logs', 'tail', CONTAINER], options), expectedCode, label);
        assert.equal(events.length, expectedRuntimeEvents, label);
        if (expectedCode === 1) assert.match(options.errorOutput.text(), /foreign live worker/);
    }
});

test('--startup never opens runtime output and stops at the terminal state', async (t) => {
    const running = harness(t);
    writeMarker(running.runningDir);
    writeStatus(running.runningDir, { state: 'starting' });
    writeStartupLog(running.logsDir, { body: 'startup line one\n' });
    let polls = 0;
    const runningOptions = baseOptions(running, {
        spawnImpl: () => { throw new Error('--startup must never open a runtime') },
        proveOciSource: () => { throw new Error('--startup must never prove a runtime') },
        sleepImpl: async () => {
            polls += 1;
            if (polls === 1) writeStatus(running.runningDir, { state: 'running' });
        },
    });
    assert.equal(await runLogCommand(['logs', 'tail', CONTAINER, '--startup'], runningOptions), 0);
    assert.match(runningOptions.output.text(), /startup line one/);

    const failed = harness(t);
    writeMarker(failed.runningDir);
    writeStatus(failed.runningDir, {
        state: 'failed', phase: 'launch', error: { message: 'boom' },
    });
    writeStartupLog(failed.logsDir, { body: 'startup line one\n' });
    const failedOptions = baseOptions(failed, {
        spawnImpl: () => { throw new Error('--startup must never open a runtime') },
        proveOciSource: () => { throw new Error('--startup must never prove a runtime') },
    });
    assert.equal(await runLogCommand(['logs', 'last', CONTAINER, '--startup'], failedOptions), 1);
    assert.match(failedOptions.errorOutput.text(), /phase: launch — boom/);

    const absent = harness(t);
    const absentOptions = baseOptions(absent, {
        spawnImpl: () => { throw new Error('--startup must never open a runtime') },
        proveOciSource: () => { throw new Error('--startup must never prove a runtime') },
    });
    assert.equal(await runLogCommand(['logs', 'tail', CONTAINER, '--startup'], absentOptions), 1);
    assert.match(absentOptions.errorOutput.text(), /no current no-wait run/);
});

test('a stale terminal status never outranks a verified runtime', async (t) => {
    const env = harness(t);
    writeMarker(env.runningDir);
    writeStatus(env.runningDir, {
        state: 'failed', phase: 'launch', error: { message: 'a previous generation failed' },
    });
    writeStartupLog(env.logsDir, { body: 'stale startup\n' });

    const events = [];
    const options = baseOptions(env, { spawnImpl: fakeRuntimeSpawn(events) });
    const code = await runLogCommand(['logs', 'last', '5', CONTAINER], options);

    assert.equal(code, 0);
    assert.equal(options.output.text(), 'application output\n');
    assert.deepEqual(events, [['podman', 'logs', '--tail', '5', CONTAINER_ID]]);
});

test('with no current run the tail follows a verified runtime immediately', async (t) => {
    const env = harness(t);
    const events = [];
    const options = baseOptions(env, { spawnImpl: fakeRuntimeSpawn(events) });
    const code = await runLogCommand(['logs', 'tail', CONTAINER], options);

    assert.equal(code, 0);
    assert.deepEqual(events, [['podman', 'logs', '--follow', '--tail', '10', CONTAINER_ID]]);
});

test('an ambiguous or unknown reference lists usable references and reads nothing', async (t) => {
    const env = harness(t);
    const unknownOptions = baseOptions(env, {
        readRegistrySnapshot: () => agentRecord(),
        proveOciSource: () => { throw new Error('an unresolved reference must not reach a runtime') },
    });
    assert.equal(await runLogCommand(['logs', 'last', 'absentAgent'], unknownOptions), 1);
    assert.match(unknownOptions.errorOutput.text(), /is not one enabled agent/);
    assert.match(unknownOptions.errorOutput.text(), /enabled agents: demo\/shared/);

    const ambiguousOptions = baseOptions(env, {
        readRegistrySnapshot: () => ({
            first_container: { type: 'agent', repoName: 'demo', agentName: 'twin', alias: 'blue' },
            second_container: { type: 'agent', repoName: 'demo', agentName: 'twin', alias: 'green' },
        }),
        proveOciSource: () => { throw new Error('an ambiguous reference must not reach a runtime') },
    });
    assert.equal(await runLogCommand(['logs', 'last', 'demo/twin'], ambiguousOptions), 1);
    assert.match(ambiguousOptions.errorOutput.text(), /Use one of: blue, green/);
});

test('a pre-cut sandbox record reports that a restart is required', async (t) => {
    const env = harness(t);
    // A pre-cut record persists the runtime, tuple, and pid, but its launch
    // wrote only the ambiguous legacy filename, so the derived process-specific
    // file was never created.
    const options = baseOptions(env, {
        readRegistrySnapshot: () => agentRecord({
            runtime: 'bwrap',
            containerId: undefined,
            pid: 4242,
        }),
    });
    const code = await runLogCommand(['logs', 'last', '5', CONTAINER], options);
    assert.equal(code, 1);
    assert.match(options.errorOutput.text(), /restart the agent to produce one/);
});

test('a sandbox record without a finalized pid derives no path at all', async (t) => {
    const env = harness(t);
    const options = baseOptions(env, {
        readRegistrySnapshot: () => agentRecord({ runtime: 'seatbelt', containerId: undefined }),
    });
    const code = await runLogCommand(['logs', 'last', '5', CONTAINER], options);
    assert.equal(code, 1);
    assert.match(options.errorOutput.text(), /requires one positive finalized process id/);
});

test('an unsupported recorded runtime is rejected before any spawn', async (t) => {
    const env = harness(t);
    const options = baseOptions(env, {
        readRegistrySnapshot: () => agentRecord({ runtime: 'host' }),
        spawnImpl: () => { throw new Error('an unsupported runtime must not spawn') },
    });
    const code = await runLogCommand(['logs', 'last', '5', CONTAINER], options);
    assert.equal(code, 1);
    assert.match(options.errorOutput.text(), /records no runtime whose logs can be read/);
});

test('the command drives the real ownership predicate by immutable id only', async (t) => {
    const env = harness(t);
    const inspections = [];
    const events = [];
    const options = baseOptions(env, { spawnImpl: fakeRuntimeSpawn(events) });
    // The default `proveOciSource` is the shared predicate; drive it with an
    // injected inspector so this asserts the wiring, not a stubbed proof.
    const code = await runLogCommand(['logs', 'last', '5', CONTAINER], {
        ...options,
        proveOciSource: (containerName, record) => proveExactOciLogSource(containerName, record, {
            inspect: (runtime, identifier) => {
                inspections.push([runtime, identifier]);
                return inspectedContainer({ running: false });
            },
            workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
        }),
    });
    assert.equal(code, 0);
    // A stopped but proved container is retrievable, addressed by its id.
    assert.deepEqual(inspections, [['podman', CONTAINER_ID]]);
    assert.deepEqual(events, [['podman', 'logs', '--tail', '5', CONTAINER_ID]]);
});

test('the real ownership predicate rejects a staged predecessor through the command', async (t) => {
    const env = harness(t);
    const options = baseOptions(env, {
        // Staging rotates the record tuple while the container still carries
        // the predecessor's labels.
        readRegistrySnapshot: () => agentRecord({ enableGeneration: 'generation-0002' }),
        spawnImpl: () => { throw new Error('a staged predecessor must not be opened'); },
        proveOciSource: (containerName, record) => proveExactOciLogSource(containerName, record, {
            inspect: () => inspectedContainer(),
            workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
        }),
    });
    const code = await runLogCommand(['logs', 'last', '5', CONTAINER], options);
    assert.equal(code, 1);
    assert.match(options.errorOutput.text(), /managed ownership labels/);
});

test('tampered persisted failure fields cannot inject lines, controls, or credentials', async (t) => {
    const env = harness(t);
    writeMarker(env.runningDir);
    writeStatus(env.runningDir, {
        state: 'failed',
        phase: 'launch\nAuthorization: Bearer phase-secret',
        error: {
            message: 'Authorization: Bearer status-secret\r\nforged-line\u001b[31m token=hunter2',
        },
    });
    writeStartupLog(env.logsDir, { body: 'application bytes remain unchanged\n' });
    const options = baseOptions(env, {
        proveOciSource: () => { throw new Error('no current runtime'); },
    });

    const code = await runLogCommand(['logs', 'last', '5', CONTAINER], options);
    assert.equal(code, 1);
    const diagnostic = options.errorOutput.text();
    for (const leaked of ['phase-secret', 'status-secret', 'hunter2', '\u001b', '\r']) {
        assert.equal(diagnostic.includes(leaked), false, `leaked ${JSON.stringify(leaked)}`);
    }
    assert.equal(diagnostic.trimEnd().split('\n').length, 1, 'persisted fields must not forge a second line');
    assert.doesNotMatch(diagnostic, /phase: launch/);
});

test('hostile registry diagnostics are capped, redacted, and suggestion-bounded', async (t) => {
    const env = harness(t);
    const registry = {};
    for (let index = 0; index < 100; index += 1) {
        const alias = index === 0
            ? `aaa-token=registry-secret\u001b[31m`
            : `ref_${String(index).padStart(3, '0')}_${'x'.repeat(500)}`;
        registry[`container_${index}`] = {
            type: 'agent',
            repoName: `repo_${index}`,
            agentName: `agent_${index}`,
            alias,
        };
    }
    const options = baseOptions(env, { readRegistrySnapshot: () => registry });
    const target = 'missing\r\nAuthorization: Bearer request-secret';
    assert.equal(await runLogCommand(['logs', 'last', target], options), 1);

    const diagnostic = options.errorOutput.text();
    for (const leaked of ['registry-secret', 'request-secret', '\u001b', '\r']) {
        assert.equal(diagnostic.includes(leaked), false, `leaked ${JSON.stringify(leaked)}`);
    }
    const lines = diagnostic.trimEnd().split('\n');
    assert.equal(lines.length, 2, 'the target and suggestion diagnostics each occupy one line');
    assert.ok(lines.every((line) => line.length <= 4_000));
    assert.ok(lines[1].endsWith('…'), 'the diagnostic ceiling must truncate explicitly');
});
