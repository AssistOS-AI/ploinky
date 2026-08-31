#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    captureAgentSessionSnapshot,
    listAgentMarkerProcesses,
    readAgentBoxProcessIdentity,
} from '../../cli/server/webtty/agentProcessIdentity.mjs';
import { fixedAgentShellWrapperArgv } from '../../cli/server/webtty/agentRuntime.mjs';
import { inspectExactAgentTarget } from '../../cli/server/webtty/agentTerminalWorker.mjs';
import { AgentWebttyWorkerClient } from '../../cli/server/webtty/agentWorkerClient.mjs';
import {
    RuntimeRecordStore,
    listExactAgentStartupPodmanClients,
    readLinuxProcessIdentity,
} from '../../cli/server/webtty/runtimeRecords.mjs';

const PODMAN = '/usr/bin/podman';
const AGENT_IMAGE = 'docker.io/assistos/ploinky-node@sha256:d7b9594f73c8f9eead6c5b1717e504bf6c65458e27daf77bb6022085c82faf03';
const AGENT_DIGEST = 'sha256:d7b9594f73c8f9eead6c5b1717e504bf6c65458e27daf77bb6022085c82faf03';
const WAIT_MS = 15_000;
const MAX_TRANSCRIPT_BYTES = 256 * 1024;
const ABSENT = /(?:no such|not found|does not exist|no container with name or id)/i;
const STALE_READINESS_CHALLENGE = 's'.repeat(43);
const FORGED_READINESS_COMMAND = `( ${[
    'IFS= read -r forged_stat < /proc/$$/stat',
    'forged_tail=${forged_stat##*) }',
    "IFS=' \t'",
    'set -- $forged_tail',
    'forged_start=${20}',
    'forged_uid=',
    "while read -r forged_key forged_value forged_rest; do [ \"$forged_key\" = 'Uid:' ] && { forged_uid=$forged_value; break; }; done < /proc/$$/status",
    `printf '__PLOINKY_AGENT_READY__%s|${STALE_READINESS_CHALLENGE}|%s|%s|%s|%s|%s\\n' "$PLOINKY_WEBTTY_MARKER" "$$" "$3" "$4" "$forged_uid" "$forged_start"`,
].join('; ')} )`;
const FORGED_ENV_PATH = '/tmp/ploinky-webtty-forged-env';
const sessions = [];
const foreignExecs = [];

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function boundedWait(operation, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(null), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runPodman(args, { ok = true, timeoutMs = 120_000 } = {}) {
    const result = spawnSync(PODMAN, args, {
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 4 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
    });
    const observed = Object.freeze({
        ok: result.status === 0,
        status: Number.isInteger(result.status) ? result.status : null,
        signal: result.signal || null,
        errorCode: result.error?.code || null,
        stdout: String(result.stdout || '').trim(),
        stderr: String(result.stderr || '').trim(),
    });
    if (ok) assert.equal(observed.ok, true,
        `${PODMAN} ${args.join(' ')} failed: ${JSON.stringify(observed)}`);
    return observed;
}

function spawnForeignForegroundExec({ target, session, runId }) {
    const releaseToken = `foreign_release_${runId}_${crypto.randomBytes(8).toString('hex')}`;
    const argv = [
        'container', 'exec', '--interactive',
        '--user', '1000:1000',
        '--workdir', '/tmp',
        target.containerId,
        '/bin/sh', '-c',
        'IFS= read -r value; [ "$value" = "$1" ]',
        'ploinky-foreign-exec', releaseToken,
    ];
    assert.equal(argv.some((value) => value.includes(session.marker)), false,
        'foreign exec argv must not contain the WebTTY marker');
    const child = spawn(PODMAN, argv, {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '', error: null };
    const appendBounded = (key, chunk) => {
        if (output.error) return;
        output[key] += String(chunk || '');
        if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)
            > MAX_TRANSCRIPT_BYTES) {
            output.error = new Error('foreign Podman client output exceeded its bound');
        }
    };
    child.stdout.on('data', (chunk) => appendBounded('stdout', chunk));
    child.stderr.on('data', (chunk) => appendBounded('stderr', chunk));
    child.stdin.on('error', (error) => {
        if (error?.code !== 'EPIPE') output.error = error;
    });
    const closed = new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        child.once('error', (error) => finish({ code: null, signal: null, error }));
        child.once('close', (code, signal) => finish({ code, signal: signal || null, error: null }));
    });
    const fixture = {
        child,
        closed,
        output,
        argv: Object.freeze([...argv]),
        releaseToken,
        clientProcess: null,
        execId: null,
        released: false,
    };
    foreignExecs.push(fixture);
    return fixture;
}

async function captureForeignForegroundExec({ target, session, runId }) {
    const fixture = spawnForeignForegroundExec({ target, session, runId });
    assert.equal(Number.isSafeInteger(fixture.child.pid) && fixture.child.pid > 1, true);
    fixture.clientProcess = await waitFor(async () => {
        if (fixture.output.error) throw fixture.output.error;
        if (fixture.child.exitCode !== null) {
            throw new Error(`foreign Podman client exited early: ${fixture.output.stderr}`);
        }
        const identity = await readLinuxProcessIdentity(fixture.child.pid);
        if (!identity) return null;
        assert.deepEqual(identity.cmdline, [PODMAN, ...fixture.argv]);
        return identity;
    }, 'foreign Podman client exact identity');
    fixture.execId = await waitFor(() => {
        if (fixture.output.error) throw fixture.output.error;
        const inspected = exactTarget(target.containerId);
        assert.equal(inspected.absent, false);
        assert.equal(inspected.running, true);
        const baseline = new Set(session.prepared.startupEvidence.baselineExecIds);
        const additions = inspected.execIds.filter((execId) => !baseline.has(execId));
        if (additions.length === 0) return null;
        assert.equal(additions.length, 1,
            'foreign fixture must create exactly one post-baseline exec');
        return additions[0];
    }, 'foreign exec admission');
    assert.match(fixture.execId, /^[a-f0-9]{64}$/);
    return fixture;
}

async function releaseForeignForegroundExec(fixture) {
    if (fixture.released) return;
    const current = fixture.clientProcess
        ? await readLinuxProcessIdentity(fixture.clientProcess.pid)
        : null;
    if (current) {
        assert.equal(current.startToken, fixture.clientProcess.startToken,
            'foreign Podman client PID changed before exact release');
        assert.deepEqual(current.cmdline, [PODMAN, ...fixture.argv]);
    }
    if (fixture.child.exitCode === null && !fixture.child.stdin.destroyed) {
        fixture.child.stdin.end(`${fixture.releaseToken}\n`);
    }
    const exit = await boundedWait(fixture.closed, WAIT_MS);
    assert.notEqual(exit, null, 'foreign Podman client did not exit after exact release');
    assert.equal(exit.error, null, exit.error?.message);
    assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null },
        `foreign Podman client failed: ${fixture.output.stderr}`);
    assert.equal(fixture.output.error, null, fixture.output.error?.message);
    if (fixture.clientProcess) {
        await waitFor(
            () => exactProcessGone(fixture.clientProcess),
            'foreign Podman client exact exit',
        );
    }
    fixture.released = true;
}

function parseSingleJson(result, label) {
    assert.equal(result.ok, true, `${label} failed: ${result.stderr}`);
    const values = JSON.parse(result.stdout);
    assert.equal(Array.isArray(values), true, `${label} must return an array`);
    assert.equal(values.length, 1, `${label} must return one exact record`);
    return values[0];
}

function assertAbsent(result, label) {
    assert.equal(result.ok, false, `${label} unexpectedly exists`);
    assert.equal(result.signal, null, `${label} inspection was interrupted`);
    assert.equal(result.errorCode, null, `${label} inspection did not execute`);
    assert.match(`${result.stderr}\n${result.stdout}`, ABSENT,
        `${label} absence was not proven`);
}

async function waitFor(check, label, timeoutMs = WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        try {
            const value = await check();
            if (value) return value;
            last = value;
        } catch (error) {
            last = error;
        }
        await delay(40);
    }
    throw new Error(`${label} timed out: ${last instanceof Error ? last.message : String(last)}`);
}

async function exactProcessGone(expected) {
    const current = await readLinuxProcessIdentity(expected.pid);
    return !current || current.startToken !== expected.startToken;
}

function exactTarget(containerId) {
    return inspectExactAgentTarget(containerId);
}

function createTarget({ imageId, name, runId, fallbackShell = false }) {
    const args = [
        'container', 'create',
        '--name', name,
        '--label', `io.assistos.ploinky.webtty-production-test=${runId}`,
        '--env', `PROMPT_COMMAND=${FORGED_READINESS_COMMAND}`,
        '--env', `ENV=${FORGED_ENV_PATH}`,
    ];
    if (fallbackShell) args.push('--user', '0:0');
    args.push(
        imageId,
        '/bin/sh', '-c', [
            'umask 077',
            `printf '%s\\n' "$1" > ${FORGED_ENV_PATH}`,
            `chmod 0444 ${FORGED_ENV_PATH}`,
            ...(fallbackShell ? ['mv /bin/bash /tmp/ploinky-webtty-hidden-bash'] : []),
            'trap "exit 0" TERM INT',
            'while :; do sleep 300; done',
        ].join('; '),
        'ploinky-webtty-fixture',
        FORGED_READINESS_COMMAND,
    );
    const result = runPodman(args);
    const containerId = result.stdout;
    assert.match(containerId, /^[a-f0-9]{64}$/);
    runPodman(['container', 'start', containerId]);
    const inspection = parseSingleJson(
        runPodman(['container', 'inspect', containerId]),
        `container ${containerId}`,
    );
    assert.equal(inspection.Id, containerId);
    assert.equal(inspection.Name, name);
    assert.equal(inspection.Image, imageId);
    assert.equal(inspection.Config?.Labels?.['io.assistos.ploinky.webtty-production-test'], runId);
    assert.equal(inspection.Config?.Env?.includes(
        `PROMPT_COMMAND=${FORGED_READINESS_COMMAND}`,
    ), true);
    assert.equal(inspection.Config?.Env?.includes(`ENV=${FORGED_ENV_PATH}`), true);
    assert.equal(inspection.State?.Running, true);
    assert.deepEqual(inspection.ExecIDs || [], []);
    if (fallbackShell) {
        runPodman([
            'container', 'exec', containerId, '/bin/sh', '-c',
            'while [ -e /bin/bash ]; do sleep 0.01; done; [ -x /bin/sh ]',
        ]);
    }
    return Object.freeze({
        containerId,
        imageId,
        name,
        runId,
        fallbackShell,
        bashAbsenceProvenBeforeExec: fallbackShell,
    });
}

function removeTargetExact(target, { requireNoExec = false } = {}) {
    if (!target) return;
    const before = runPodman(['container', 'inspect', target.containerId], { ok: false });
    if (!before.ok) {
        assertAbsent(before, `container ${target.containerId}`);
        return;
    }
    const inspection = parseSingleJson(before, `container ${target.containerId}`);
    assert.equal(inspection.Id, target.containerId);
    assert.equal(inspection.Name, target.name);
    assert.equal(inspection.Image, target.imageId);
    assert.equal(
        inspection.Config?.Labels?.['io.assistos.ploinky.webtty-production-test'],
        target.runId,
    );
    if (requireNoExec) assert.deepEqual(inspection.ExecIDs || [], [],
        `container ${target.containerId} retained an exec record`);
    runPodman(['container', 'rm', '--force', '--time', '0', target.containerId]);
    assertAbsent(
        runPodman(['container', 'inspect', target.containerId], { ok: false }),
        `container ${target.containerId}`,
    );
}

function createTranscript(client) {
    const state = {
        output: '',
        outputError: null,
        terminalErrors: [],
        clientErrors: [],
        terminalExit: null,
    };
    client.on('output', (message) => {
        if (state.outputError) return;
        if (Buffer.byteLength(state.output) + Buffer.byteLength(message.data) > MAX_TRANSCRIPT_BYTES) {
            state.outputError = new Error('production worker transcript exceeded its bound');
            return;
        }
        state.output += message.data;
    });
    client.on('terminal-error', (message) => state.terminalErrors.push(message.category));
    client.on('error-category', (message) => state.clientErrors.push(message.category));
    client.on('terminal-exit', (message) => { state.terminalExit = message; });
    return state;
}

async function waitForOutput(state, expected, label) {
    return waitFor(() => {
        if (state.outputError) throw state.outputError;
        return state.output.includes(expected) ? expected : null;
    }, label);
}

async function waitForOutputPattern(state, pattern, label) {
    return waitFor(() => {
        if (state.outputError) throw state.outputError;
        return state.output.match(pattern);
    }, label);
}

function recordTarget(target, ordinal) {
    return Object.freeze({
        runtime: 'podman',
        containerId: target.containerId,
        containerName: target.name,
        instanceId: `production-instance-${ordinal}`,
        enableGeneration: `production-generation-${ordinal}`,
    });
}

async function prepareSession({ target, directory, runId, ordinal }) {
    const terminalId = `production_terminal_${runId}_${ordinal}`;
    const marker = `production_marker_${runId}_${ordinal}`;
    const client = new AgentWebttyWorkerClient({ terminalId });
    const transcript = createTranscript(client);
    const session = {
        client,
        transcript,
        directory,
        target,
        marker,
        expectedShellPath: target.fallbackShell ? '/bin/sh' : '/bin/bash',
        worker: null,
        store: null,
        handle: null,
        prepared: null,
        ready: null,
    };
    sessions.push(session);
    try {
        session.worker = await client.spawn();
        session.store = new RuntimeRecordStore({ directory });
        session.handle = await session.store.create({
            routerEpoch: `production_router_${runId}`,
            marker,
            targetKind: 'agent',
            target: recordTarget(target, ordinal),
            worker: session.worker,
        });
        session.prepared = await client.prepare({
            runtime: 'podman',
            containerId: target.containerId,
            targetUser: '1000:1000',
            translatedCwd: '/tmp',
            marker,
            cols: 80,
            rows: 24,
        });
        assert.equal(await session.store.markAgentPtyStarting(
            session.handle,
            session.prepared.startupEvidence,
        ), true);
        assert.equal(session.handle.record.ptyState, 'pty-starting');
        return session;
    } catch (error) {
        try { await client.close(); } catch (_) { }
        if (!await client.waitForExit(WAIT_MS)) {
            try { await client.signalExactWorker('SIGKILL'); } catch (_) { }
            await client.waitForExit(WAIT_MS);
        }
        if (fs.existsSync(directory)) {
            try { await new RuntimeRecordStore({ directory }).recover(); } catch (_) { }
        }
        throw error;
    }
}

async function startReady(session, { persist = true } = {}) {
    const ready = await session.client.start();
    session.ready = ready;
    assert.match(ready.recoveryEvidence.execId, /^[a-f0-9]{64}$/);
    assert.equal(ready.recoveryEvidence.innerProcess.innerUid, 1000);
    if (persist) {
        await session.store.update(session.handle, {
            ...session.handle.record,
            agent: ready.recoveryEvidence,
            ptyState: 'pty-ready',
        });
        assert.equal(session.handle.record.ptyState, 'pty-ready');
    }
    const staleFrame = await waitForOutputPattern(
        session.transcript,
        new RegExp(
            `__PLOINKY_AGENT_READY__${escapeRegExp(session.marker)}\\|${STALE_READINESS_CHALLENGE}\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)`,
        ),
        `${session.expectedShellPath} stale pre-spawn readiness frame`,
    );
    assert.equal(staleFrame[1], staleFrame[2]);
    assert.equal(
        Number(staleFrame[3]),
        ready.recoveryEvidence.innerProcess.innerSessionId,
    );
    assert.equal(staleFrame[4], '1000');
    assert.match(staleFrame[5], /^[1-9][0-9]*$/);
    assert.equal(JSON.stringify(ready).includes(STALE_READINESS_CHALLENGE), false);
    session.challengeProof = Object.freeze({
        injection: session.expectedShellPath === '/bin/bash' ? 'PROMPT_COMMAND' : 'ENV',
        staleFrameObserved: true,
        staleFrameHadExactNumericIdentityShape: true,
        postSpawnChallengeAbsentFromRecoveryEvidence: true,
    });
    return ready;
}

async function assertMarkerIdentity(session, ready) {
    const evidence = ready.recoveryEvidence.innerProcess;
    const identity = await readAgentBoxProcessIdentity(evidence.boxPid);
    assert.equal(identity.startToken, evidence.boxStartToken);
    assert.equal(identity.innerUid, 1000);
    assert.deepEqual(identity.argv, fixedAgentShellWrapperArgv(
        session.marker,
        session.expectedShellPath,
    ));
    const matches = await listAgentMarkerProcesses(evidence, session.marker);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].pid, evidence.boxPid);
    assert.deepEqual(matches[0].argv, fixedAgentShellWrapperArgv(
        session.marker,
        session.expectedShellPath,
    ));
    return Object.freeze({
        boxPid: identity.pid,
        innerUid: identity.innerUid,
        argv: [...identity.argv],
    });
}

async function killWorker(session) {
    assert.equal(await session.client.signalExactWorker('SIGKILL'), true);
    assert.equal(await session.client.waitForExit(WAIT_MS), true);
    await waitFor(
        () => exactProcessGone(session.worker),
        `worker ${session.worker.pid} exit`,
    );
}

async function assertExactResidueGone({ target, session, ready, targetAbsent = false }) {
    assert.equal(await exactProcessGone(session.worker), true);
    assert.equal(await exactProcessGone(ready.recoveryEvidence.clientProcess), true,
        'exact production Podman client must be gone');
    const inspected = exactTarget(target.containerId);
    if (targetAbsent) {
        assert.equal(inspected.absent, true);
        return;
    }
    assert.equal(inspected.absent, false);
    assert.equal(inspected.running, true);
    assert.equal(inspected.execIds.includes(ready.recoveryEvidence.execId), false);
    assert.deepEqual(await listAgentMarkerProcesses(
        ready.recoveryEvidence.innerProcess,
        session.marker,
    ), []);
}

async function runCleanSession({ target, directory, runId, ordinal }) {
    const session = await prepareSession({ target, directory, runId, ordinal });
    const ready = await startReady(session);
    const markerProof = await assertMarkerIdentity(session, ready);
    const ioA = `__PRODUCTION_IO_${crypto.randomBytes(5).toString('hex')}`;
    const ioB = `_${crypto.randomBytes(5).toString('hex')}__`;
    const expectedIo = `${ioA}${ioB}|1000|/tmp`;
    const ioCommand = [
        `ploinky_a=${JSON.stringify(ioA)}`,
        `ploinky_b=${JSON.stringify(ioB)}`,
        'printf \'%s%s|%s|%s\\n\' "$ploinky_a" "$ploinky_b" "$(id -u)" "$PWD"',
    ].join('; ') + '\r';
    assert.equal(ioCommand.includes(expectedIo), false,
        'application result must not be present in the echoed input');
    await session.client.input(ioCommand);
    await waitForOutput(session.transcript, expectedIo, 'echo-resistant application I/O');

    await session.client.resize(101, 33);
    const resizeA = `__PRODUCTION_SIZE_${crypto.randomBytes(5).toString('hex')}`;
    const resizeB = `_${crypto.randomBytes(5).toString('hex')}__`;
    const expectedResize = `${resizeA}${resizeB}|33|101`;
    const resizeCommand = [
        `ploinky_a=${JSON.stringify(resizeA)}`,
        `ploinky_b=${JSON.stringify(resizeB)}`,
        'set -- $(stty size)',
        'printf \'%s%s|%s|%s\\n\' "$ploinky_a" "$ploinky_b" "$1" "$2"',
    ].join('; ') + '\r';
    assert.equal(resizeCommand.includes(expectedResize), false,
        'resize result must not be present in the echoed input');
    await session.client.input(resizeCommand);
    await waitForOutput(session.transcript, expectedResize, 'production resize roundtrip');

    await session.client.close();
    const exit = await waitFor(
        () => session.transcript.terminalExit,
        'production worker controlled terminal exit',
    );
    assert.equal(exit.cleanupProven, true);
    assert.equal(await session.client.waitForExit(WAIT_MS), true);
    assert.deepEqual(session.transcript.terminalErrors, []);
    assert.deepEqual(session.transcript.clientErrors, []);
    assert.equal(await session.store.confirmReclaimed(session.handle.record, { waitForExit: true }), true);
    assert.equal(await session.store.remove(session.handle), true);
    assert.deepEqual(fs.readdirSync(directory), []);
    await assertExactResidueGone({ target, session, ready });
    return Object.freeze({
        markerProof,
        readinessChallenge: session.challengeProof,
        io: { uid: 1000, cwd: '/tmp', echoResistant: true },
        resize: { cols: 101, rows: 33, echoResistant: true },
        cleanupProven: exit.cleanupProven,
        execId: ready.recoveryEvidence.execId,
    });
}

async function recoverStartingCrash({ target, directory, runId, ordinal }) {
    const session = await prepareSession({ target, directory, runId, ordinal });
    const ready = await startReady(session, { persist: false });
    assert.equal(session.handle.record.ptyState, 'pty-starting');
    const markerProof = await assertMarkerIdentity(session, ready);
    const inspected = exactTarget(target.containerId);
    assert.deepEqual(
        inspected.execIds.filter((id) => !session.prepared.startupEvidence.baselineExecIds.includes(id)),
        [ready.recoveryEvidence.execId],
    );
    assert.equal((await listExactAgentStartupPodmanClients(
        session.prepared.startupEvidence,
        session.worker.uid,
    )).length, 1);
    await killWorker(session);
    const recovery = await new RuntimeRecordStore({ directory }).recover();
    assert.deepEqual(recovery, {
        ok: true,
        evidence: ['verified_agent_startup_reclaimed'],
        agentAvailable: true,
        quarantinedTargets: [],
    });
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.deepEqual(await listExactAgentStartupPodmanClients(
        session.prepared.startupEvidence,
        session.worker.uid,
    ), []);
    await assertExactResidueGone({ target, session, ready });
    return Object.freeze({
        durableStateAtCrash: 'pty-starting',
        markerProof,
        readinessChallenge: session.challengeProof,
        execId: ready.recoveryEvidence.execId,
        recoveryCategory: recovery.evidence[0],
        recordRemoved: true,
    });
}

async function preserveForeignExecDuringStartingRecovery({
    target,
    directory,
    runId,
    ordinal,
}) {
    const session = await prepareSession({ target, directory, runId, ordinal });
    assert.equal(session.handle.record.ptyState, 'pty-starting');
    assert.equal(session.ready, null,
        'foreign-exec isolation must not start the WebTTY target PTY');
    const foreign = await captureForeignForegroundExec({ target, session, runId });
    assert.equal(
        (await listAgentMarkerProcesses(
            session.prepared.startupEvidence.containerInitProcess,
            session.marker,
        )).length,
        0,
        'foreign exec must not create a WebTTY marker process',
    );
    assert.deepEqual(await listExactAgentStartupPodmanClients(
        session.prepared.startupEvidence,
        session.worker.uid,
    ), [], 'foreign Podman argv must not match the exact WebTTY startup client');

    await killWorker(session);
    const initialRecovery = await new RuntimeRecordStore({ directory }).recover();
    assert.deepEqual(initialRecovery, {
        ok: true,
        evidence: ['agent_startup_exec_unowned'],
        agentAvailable: true,
        quarantinedTargets: [{
            target: session.handle.record.target,
            category: 'agent_startup_exec_unowned',
        }],
    });
    assert.deepEqual(fs.readdirSync(directory), [session.handle.fileName],
        'unowned foreign exec must retain the exact recovery record');
    const retainedRecord = JSON.parse(fs.readFileSync(
        path.join(directory, session.handle.fileName),
        'utf8',
    ));
    assert.equal(retainedRecord.ptyState, 'pty-starting');
    assert.deepEqual(retainedRecord.agentStartup, session.prepared.startupEvidence);

    const foreignAfterRecovery = await readLinuxProcessIdentity(foreign.clientProcess.pid);
    assert.notEqual(foreignAfterRecovery, null,
        'foreign Podman client must survive WebTTY recovery');
    assert.equal(foreignAfterRecovery.startToken, foreign.clientProcess.startToken);
    assert.equal(foreignAfterRecovery.pgrp, foreign.clientProcess.pgrp);
    assert.equal(foreignAfterRecovery.session, foreign.clientProcess.session);
    assert.equal(foreignAfterRecovery.uid, foreign.clientProcess.uid);
    assert.deepEqual(foreignAfterRecovery.cmdline, [PODMAN, ...foreign.argv]);
    assert.equal(foreign.child.exitCode, null);
    const retainedTarget = exactTarget(target.containerId);
    assert.equal(retainedTarget.absent, false);
    assert.equal(retainedTarget.running, true);
    assert.deepEqual(
        retainedTarget.execIds.filter(
            (execId) => !session.prepared.startupEvidence.baselineExecIds.includes(execId),
        ),
        [foreign.execId],
        'target-scoped quarantine must leave the exact foreign exec unchanged',
    );
    assert.equal(
        (await listAgentMarkerProcesses(
            session.prepared.startupEvidence.containerInitProcess,
            session.marker,
        )).length,
        0,
    );

    await releaseForeignForegroundExec(foreign);
    await waitFor(() => {
        const inspected = exactTarget(target.containerId);
        if (inspected.absent || !inspected.running) return null;
        return inspected.execIds.includes(foreign.execId) ? null : true;
    }, 'foreign exec exact record drain');
    const finalRecovery = await new RuntimeRecordStore({ directory }).recover();
    assert.deepEqual(finalRecovery, {
        ok: true,
        evidence: ['verified_agent_startup_reclaimed'],
        agentAvailable: true,
        quarantinedTargets: [],
    });
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.equal(await exactProcessGone(session.worker), true);
    assert.equal(await exactProcessGone(foreign.clientProcess), true);
    assert.deepEqual(await listExactAgentStartupPodmanClients(
        session.prepared.startupEvidence,
        session.worker.uid,
    ), []);
    return Object.freeze({
        durableStateAtCrash: 'pty-starting',
        webttyPtyStarted: false,
        execId: foreign.execId,
        foreignArgvDistinctAndMarkerFree: true,
        initialRecoveryCategory: initialRecovery.evidence[0],
        initialRecoveryTargetScoped: true,
        recordRetainedDuringQuarantine: true,
        foreignExecAliveAfterRecovery: true,
        foreignExecIdentityUnchanged: true,
        exactAbsenceBeforeSelfHeal: true,
        finalRecoveryCategory: finalRecovery.evidence[0],
        recordRemoved: true,
    });
}

async function recoverReadyCrash({ target, directory, runId, ordinal }) {
    const session = await prepareSession({ target, directory, runId, ordinal });
    const ready = await startReady(session);
    const markerProof = await assertMarkerIdentity(session, ready);
    const childA = `__PRODUCTION_CHILD_${crypto.randomBytes(5).toString('hex')}`;
    const childB = `_${crypto.randomBytes(5).toString('hex')}__`;
    const command = [
        'set -m',
        'sleep 300 & ploinky_child=$!',
        `ploinky_a=${JSON.stringify(childA)}`,
        `ploinky_b=${JSON.stringify(childB)}`,
        'printf \'%s%s|%s\\n\' "$ploinky_a" "$ploinky_b" "$ploinky_child"',
        'fg %1',
    ].join('; ') + '\r';
    await session.client.input(command);
    const childPrefix = `${childA}${childB}|`;
    assert.equal(command.includes(childPrefix), false);
    await waitForOutput(session.transcript, childPrefix, 'foreground child admission');
    const beforeMembers = await waitFor(async () => {
        const members = await captureAgentSessionSnapshot(ready.recoveryEvidence.innerProcess);
        return members.length >= 3 ? members : null;
    }, 'foreground descendant session membership');
    await killWorker(session);
    const recovery = await new RuntimeRecordStore({ directory }).recover();
    assert.deepEqual(recovery, {
        ok: true,
        evidence: ['verified_agent_reclaimed'],
        agentAvailable: true,
        quarantinedTargets: [],
    });
    assert.deepEqual(fs.readdirSync(directory), []);
    for (const member of beforeMembers) {
        const current = await readLinuxProcessIdentity(member.pid);
        assert.equal(
            current?.startToken === member.startToken,
            false,
            `exact foreground-session PID ${member.pid} survived recovery`,
        );
    }
    await assertExactResidueGone({ target, session, ready });
    return Object.freeze({
        durableStateAtCrash: 'pty-ready',
        markerProof,
        readinessChallenge: session.challengeProof,
        foregroundSessionMembers: beforeMembers.length,
        execId: ready.recoveryEvidence.execId,
        recoveryCategory: recovery.evidence[0],
        recordRemoved: true,
    });
}

async function recoverRemovedTarget({ target, directory, runId, ordinal }) {
    const session = await prepareSession({ target, directory, runId, ordinal });
    const ready = await startReady(session);
    const markerProof = await assertMarkerIdentity(session, ready);
    await killWorker(session);
    runPodman(['container', 'stop', '--time', '1', target.containerId]);
    const stopped = await waitFor(() => {
        const inspected = exactTarget(target.containerId);
        return !inspected.absent && !inspected.running ? inspected : null;
    }, 'exact target stop');
    // Podman may retain a stopped exec record until explicit exec cleanup or
    // container removal. The lifecycle contract is that force-removing this
    // exact immutable target terminates the session and that restart recovery
    // proves every recorded process gone; it does not require Podman to erase
    // its stopped exec bookkeeping automatically.
    const exactExecRetainedAtStop = stopped.execIds.includes(ready.recoveryEvidence.execId);
    removeTargetExact(target);
    const recovery = await new RuntimeRecordStore({ directory }).recover();
    assert.deepEqual(recovery, {
        ok: true,
        evidence: ['dead_record_removed'],
        agentAvailable: true,
        quarantinedTargets: [],
    });
    assert.deepEqual(fs.readdirSync(directory), []);
    await assertExactResidueGone({ target, session, ready, targetAbsent: true });
    return Object.freeze({
        durableStateAtCrash: 'pty-ready',
        markerProof,
        readinessChallenge: session.challengeProof,
        execId: ready.recoveryEvidence.execId,
        exactExecRetainedAtStop,
        targetStoppedBeforeRemoval: true,
        targetRemovedBeforeRecovery: true,
        recoveryCategory: recovery.evidence[0],
        recordRemoved: true,
    });
}

async function runFallbackChallengeSession({ target, directory, runId, ordinal }) {
    const session = await prepareSession({ target, directory, runId, ordinal });
    const ready = await startReady(session);
    const markerProof = await assertMarkerIdentity(session, ready);
    assert.equal(target.bashAbsenceProvenBeforeExec, true);
    assert.equal(session.expectedShellPath, '/bin/sh');
    assert.equal(session.challengeProof.injection, 'ENV');
    await session.client.close();
    const exit = await waitFor(
        () => session.transcript.terminalExit,
        'fallback worker controlled terminal exit',
    );
    assert.equal(exit.cleanupProven, true);
    assert.equal(await session.client.waitForExit(WAIT_MS), true);
    assert.deepEqual(session.transcript.terminalErrors, []);
    assert.deepEqual(session.transcript.clientErrors, []);
    assert.equal(await session.store.confirmReclaimed(
        session.handle.record,
        { waitForExit: true },
    ), true);
    assert.equal(await session.store.remove(session.handle), true);
    assert.deepEqual(fs.readdirSync(directory), []);
    await assertExactResidueGone({ target, session, ready });
    return Object.freeze({
        markerProof,
        bashAbsenceProvenBeforeExec: true,
        readinessChallenge: session.challengeProof,
        cleanupProven: true,
        execId: ready.recoveryEvidence.execId,
    });
}

function sourceDigests() {
    return Object.freeze({
        driver: crypto.createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'),
        agentWorkerClient: crypto.createHash('sha256').update(fs.readFileSync(
            new URL('../../cli/server/webtty/agentWorkerClient.mjs', import.meta.url),
        )).digest('hex'),
        agentTerminalWorker: crypto.createHash('sha256').update(fs.readFileSync(
            new URL('../../cli/server/webtty/agentTerminalWorker.mjs', import.meta.url),
        )).digest('hex'),
        agentProcessIdentity: crypto.createHash('sha256').update(fs.readFileSync(
            new URL('../../cli/server/webtty/agentProcessIdentity.mjs', import.meta.url),
        )).digest('hex'),
        agentRuntime: crypto.createHash('sha256').update(fs.readFileSync(
            new URL('../../cli/server/webtty/agentRuntime.mjs', import.meta.url),
        )).digest('hex'),
        runtimeRecords: crypto.createHash('sha256').update(fs.readFileSync(
            new URL('../../cli/server/webtty/runtimeRecords.mjs', import.meta.url),
        )).digest('hex'),
    });
}

async function cleanupSessions(runtimeRoot) {
    const errors = [];
    for (const session of sessions) {
        try {
            if (!session.client.exited) {
                await session.client.close();
                if (!await session.client.waitForExit(WAIT_MS)) {
                    await session.client.signalExactWorker('SIGKILL');
                    assert.equal(await session.client.waitForExit(WAIT_MS), true);
                }
            }
        } catch (error) {
            errors.push(`worker cleanup: ${error.message}`);
        }
    }
    for (const foreign of foreignExecs) {
        try {
            if (!foreign.released) await releaseForeignForegroundExec(foreign);
        } catch (error) {
            errors.push(`foreign exec cleanup: ${error.message}`);
        }
    }
    if (fs.existsSync(runtimeRoot)) {
        for (const entry of fs.readdirSync(runtimeRoot)) {
            const directory = path.join(runtimeRoot, entry);
            try {
                const stat = fs.lstatSync(directory);
                assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true);
                const recovery = await new RuntimeRecordStore({ directory }).recover();
                assert.equal(recovery.ok, true, JSON.stringify(recovery));
            } catch (error) {
                errors.push(`record cleanup ${entry}: ${error.message}`);
            }
        }
    }
    for (const session of sessions) {
        if (!session.worker) continue;
        try {
            assert.equal(await exactProcessGone(session.worker), true,
                `worker ${session.worker.pid} survived final cleanup`);
        } catch (error) {
            errors.push(error.message);
        }
    }
    return errors;
}

function imageInventory() {
    runPodman(['image', 'pull', AGENT_IMAGE], { timeoutMs: 10 * 60_000 });
    const image = parseSingleJson(runPodman(['image', 'inspect', AGENT_IMAGE]), AGENT_IMAGE);
    assert.match(image.Id, /^[a-f0-9]{64}$/);
    assert.equal(image.Digest, AGENT_DIGEST);
    assert.match(image.Config?.User || '', /^(?:1000(?::1000)?|node)$/);
    const info = JSON.parse(runPodman(['info', '--format', 'json']).stdout);
    assert.equal(info.host?.security?.rootless ?? info.Host?.Security?.Rootless, true);
    return Object.freeze({
        imageId: image.Id,
        digest: image.Digest,
        configuredUser: image.Config.User,
        rootless: true,
    });
}

async function main() {
    const config = JSON.parse(Buffer.from(process.argv[2] || '', 'base64url').toString('utf8'));
    assert.deepEqual(config, { agentImage: AGENT_IMAGE });
    assert.equal(process.getuid(), 1000);
    const runId = `prod_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
    const inventory = imageInventory();
    const runtimeRoot = fs.mkdtempSync(path.join('/tmp', `webtty-production-${runId}-`));
    fs.chmodSync(runtimeRoot, 0o700);
    const targets = [];
    const evidence = {};
    let primaryError = null;
    try {
        for (const [ordinal, name, execute] of [
            ['clean', `prod-clean-${runId}`, runCleanSession],
            ['starting', `prod-starting-${runId}`, recoverStartingCrash],
            ['foreign', `prod-foreign-${runId}`, preserveForeignExecDuringStartingRecovery],
            ['ready', `prod-ready-${runId}`, recoverReadyCrash],
            ['removed', `prod-removed-${runId}`, recoverRemovedTarget],
            ['fallback', `prod-fallback-${runId}`, runFallbackChallengeSession],
        ]) {
            process.stderr.write(`webtty-production-stage:${ordinal}\n`);
            const target = createTarget({
                imageId: inventory.imageId,
                name,
                runId,
                fallbackShell: ordinal === 'fallback',
            });
            targets.push(target);
            const directory = path.join(runtimeRoot, ordinal);
            evidence[ordinal] = await execute({
                target,
                directory,
                runId,
                ordinal,
            });
            if (ordinal !== 'removed') removeTargetExact(target, { requireNoExec: true });
        }
        const remaining = JSON.parse(runPodman([
            'container', 'list', '--all',
            '--filter', `label=io.assistos.ploinky.webtty-production-test=${runId}`,
            '--format', 'json',
        ]).stdout || '[]');
        assert.deepEqual(remaining, []);
        for (const target of targets) {
            assertAbsent(
                runPodman(['container', 'inspect', target.containerId], { ok: false }),
                `container ${target.containerId}`,
            );
        }
        for (const directory of fs.readdirSync(runtimeRoot)) {
            assert.deepEqual(fs.readdirSync(path.join(runtimeRoot, directory)), []);
        }
        for (const foreign of foreignExecs) {
            assert.equal(foreign.released, true);
            assert.equal(await exactProcessGone(foreign.clientProcess), true,
                'exact foreign Podman client survived the final audit');
        }
        return Object.freeze({
            schema: 'ploinky-webtty-agent-production-lifecycle/v1',
            runId,
            sources: sourceDigests(),
            agent: inventory,
            cases: evidence,
            cleanup: {
                labeledContainers: 0,
                recoveryRecords: 0,
                exactWorkers: 0,
                exactClients: 0,
                markerProcesses: 0,
                execRecords: 0,
            },
        });
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        const cleanupErrors = await cleanupSessions(runtimeRoot);
        for (const target of targets.reverse()) {
            try { removeTargetExact(target); } catch (error) { cleanupErrors.push(error.message); }
        }
        try {
            fs.rmSync(runtimeRoot, { recursive: true, force: false });
            assert.equal(fs.existsSync(runtimeRoot), false);
        } catch (error) {
            cleanupErrors.push(error.message);
        }
        if (cleanupErrors.length) {
            const detail = `production lifecycle cleanup failed:\n${cleanupErrors.join('\n')}`;
            if (primaryError) primaryError.message += `\n${detail}`;
            else throw new Error(detail);
        }
    }
}

main().then(
    (evidence) => process.stdout.write(`${JSON.stringify(evidence)}\n`),
    (error) => {
        process.stderr.write(`${error?.stack || error}\n`);
        process.exitCode = 1;
    },
);
