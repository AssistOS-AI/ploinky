import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { noWaitRunScopedLogPath } from '../../cli/commands/noWaitPaths.js';
import {
    createNoWaitRunBinding,
    observeBoundNoWaitRun,
    readNoWaitRunMarker,
} from '../../cli/commands/noWaitLogObserver.js';

const RUN_A = '11111111-2222-4333-8444-555555555555';
const RUN_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const CONTAINER = 'ploinky_demo_shared';
const INSTANCE_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GENERATION_A = '11111111-aaaa-4bbb-8ccc-dddddddddddd';
const INSTANCE_B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const GENERATION_B = '22222222-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function identity(overrides = {}) {
    const runId = overrides.runId ?? RUN_A;
    return {
        containerName: CONTAINER,
        instanceId: overrides.instanceId ?? INSTANCE_A,
        enableGeneration: overrides.enableGeneration ?? GENERATION_A,
        repoName: 'demo',
        shortAgent: 'shared',
        alias: '',
        routeKey: 'shared',
        runId,
        runStartedAtMs: overrides.runStartedAtMs ?? 10_000,
        waveIndex: overrides.waveIndex ?? 0,
        statusFile: `${CONTAINER}.${runId}.json`,
        ...overrides,
    };
}

function recordFor(runIdentity = identity()) {
    return {
        type: 'agent',
        instanceId: runIdentity.instanceId,
        enableGeneration: runIdentity.enableGeneration,
        repoName: runIdentity.repoName,
        agentName: runIdentity.shortAgent,
        ...(runIdentity.alias ? { alias: runIdentity.alias } : {}),
    };
}

function writeMarker(runningDir, runIdentity = identity()) {
    fs.mkdirSync(path.join(runningDir, 'no-wait'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
        path.join(runningDir, 'no-wait', `${CONTAINER}.current.json`),
        JSON.stringify(runIdentity),
        { mode: 0o600 },
    );
}

function writeStatus(runningDir, state, runIdentity = identity(), overrides = {}) {
    const active = state !== 'starting' || overrides.sequencePhase !== 'waiting-barrier';
    fs.writeFileSync(
        path.join(runningDir, 'no-wait', runIdentity.statusFile),
        JSON.stringify({
            state,
            sequencePhase: active ? 'active' : 'waiting-barrier',
            sequencePhaseStartedAtMs: runIdentity.runStartedAtMs,
            pid: 4242,
            ...runIdentity,
            ...overrides,
        }),
        { mode: 0o600 },
    );
}

function workspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-nowait-logs-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

// Mirrors the producer in `spawnNoWaitWorker`: create the directory, then open
// the run-scoped file exclusively at 0600 for combined stdout/stderr.
function createRunScopedLog(logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    const descriptor = fs.openSync(logFile, 'wx', 0o600);
    return {
        stdio: ['ignore', descriptor, descriptor],
        close() { try { fs.closeSync(descriptor); } catch (_) {} },
    };
}

test('the run-scoped log name carries the exact container and run id', () => {
    const logsDir = '/workspace/.ploinky/logs';
    assert.equal(
        noWaitRunScopedLogPath(CONTAINER, RUN_A, { logsDir }),
        path.join(logsDir, 'no-wait', `${CONTAINER}.${RUN_A}.log`),
    );
});

test('two runs of one agent never resolve to one log file', () => {
    const logsDir = '/workspace/.ploinky/logs';
    const first = noWaitRunScopedLogPath(CONTAINER, RUN_A, { logsDir });
    const second = noWaitRunScopedLogPath(CONTAINER, RUN_B, { logsDir });
    assert.notEqual(first, second);
    // The former shared name is gone; nothing derives `<container>.log`.
    assert.equal(first.endsWith(`${CONTAINER}.log`), false);
    assert.equal(second.endsWith(`${CONTAINER}.log`), false);
});

test('the log name shares one run identity with the marker and status names', () => {
    const logsDir = '/workspace/.ploinky/logs';
    const logFile = path.basename(noWaitRunScopedLogPath(CONTAINER, RUN_A, { logsDir }));
    const statusFile = `${CONTAINER}.${RUN_A}.json`;
    assert.equal(logFile.replace(/\.log$/, ''), statusFile.replace(/\.json$/, ''));
});

test('a foreign container name or run id is rejected before any path is built', () => {
    const rejected = [
        ['', RUN_A],
        ['../escape', RUN_A],
        ['nested/name', RUN_A],
        [CONTAINER, ''],
        [CONTAINER, 'not-a-uuid'],
        [CONTAINER, '11111111-2222-3333-8444-555555555555'],
        [CONTAINER, `${RUN_A}/../../etc`],
    ];
    for (const [containerName, runId] of rejected) {
        assert.throws(
            () => noWaitRunScopedLogPath(containerName, runId),
            /requires an exact container name and run id/,
            `expected rejection for ${containerName} / ${runId}`,
        );
    }
});

test('the producer creates one exclusive 0600 file per run and never appends across runs', (t) => {
    const root = workspace(t);
    const logsDir = path.join(root, '.ploinky', 'logs');

    const first = noWaitRunScopedLogPath(CONTAINER, RUN_A, { logsDir });
    const firstHandle = createRunScopedLog(first);
    fs.writeSync(firstHandle.stdio[1], 'run-a startup\n');
    firstHandle.close();

    const second = noWaitRunScopedLogPath(CONTAINER, RUN_B, { logsDir });
    const secondHandle = createRunScopedLog(second);
    fs.writeSync(secondHandle.stdio[1], 'run-b startup\n');
    secondHandle.close();

    assert.equal((fs.statSync(first).mode & 0o777), 0o600);
    assert.equal((fs.statSync(second).mode & 0o777), 0o600);
    // Neither run can observe the other's output.
    assert.equal(fs.readFileSync(first, 'utf8'), 'run-a startup\n');
    assert.equal(fs.readFileSync(second, 'utf8'), 'run-b startup\n');

    // Exclusive creation makes a repeated run id a failure, not an append.
    assert.throws(() => createRunScopedLog(first), (error) => error.code === 'EEXIST');
    assert.equal(fs.readFileSync(first, 'utf8'), 'run-a startup\n');
});

test('one descriptor carries both worker streams', (t) => {
    const root = workspace(t);
    const logsDir = path.join(root, '.ploinky', 'logs');
    const handle = createRunScopedLog(noWaitRunScopedLogPath(CONTAINER, RUN_A, { logsDir }));
    t.after(() => handle.close());
    assert.equal(handle.stdio[0], 'ignore');
    assert.equal(handle.stdio[1], handle.stdio[2]);
});

test('the producer no longer downgrades a log-open failure to ignored stdio', async () => {
    const source = await fs.promises.readFile(
        new URL('../../cli/commands/workspaceUtil.js', import.meta.url),
        'utf8',
    );
    const producer = source.slice(
        source.indexOf('function createRunScopedLogStdio'),
        source.indexOf('function createAppendLogStdio'),
    );
    assert.ok(producer.length > 0, 'the run-scoped producer helper must exist');
    // The watchdog keeps its append-and-fall-back helper; the no-wait producer
    // must fail loudly so the caller publishes a terminal spawn-failure status.
    assert.equal(producer.includes("stdio: 'ignore'"), false);
    assert.match(producer, /openSync\(logFile, 'wx', 0o600\)/);

    const spawnBlock = source.slice(
        source.indexOf('const logStdio = createRunScopedLogStdio(logFile);'),
        source.indexOf('// The run identity and its derived file names'),
    );
    // A spawn failure still closes the parent descriptor.
    assert.match(spawnBlock, /finally\s*\{\s*\n\s*logStdio\.closeParentFds\(\);/);
    assert.ok(
        spawnBlock.indexOf('createRunScopedLogStdio(logFile)')
            < spawnBlock.indexOf('writeNoWaitRunMarker'),
        'the log descriptor exists before marker publication',
    );
    assert.ok(
        spawnBlock.indexOf('writeNoWaitRunMarker') < spawnBlock.indexOf('child = spawn('),
        'the marker is published before the worker is spawned',
    );
    assert.ok(
        spawnBlock.indexOf('child = spawn(') < spawnBlock.indexOf('await waitForChildSpawn('),
        'the producer must await the native asynchronous spawn contract',
    );
    assert.ok(
        spawnBlock.indexOf('await waitForChildSpawn(') < spawnBlock.indexOf('child.unref()'),
        'the producer must not detach before spawn is confirmed',
    );
});

test('a marker without status expires at startup grace, not a cumulative wave deadline', (t) => {
    const root = workspace(t);
    const runningDir = path.join(root, '.ploinky', 'running');
    const runIdentity = identity({ waveIndex: 900 });
    writeMarker(runningDir, runIdentity);
    const record = recordFor(runIdentity);
    const marker = readNoWaitRunMarker(CONTAINER, { runningDir });
    assert.throws(
        () => createNoWaitRunBinding(CONTAINER, { ...record, instanceId: 123 }, marker),
        (error) => error.code === 'NO_WAIT_RUN_SUPERSEDED',
    );
    const binding = createNoWaitRunBinding(CONTAINER, record, marker);
    const timeouts = {
        startupGraceMs: 1_000,
        activeTimeoutMs: 99_000,
        terminalPublicationGraceMs: 99_000,
    };
    const readRegistrySnapshot = () => ({ [CONTAINER]: record });

    const pending = observeBoundNoWaitRun(binding, {
        runningDir,
        nowMs: 11_000,
        timeouts,
        readRegistrySnapshot,
    });
    assert.equal(pending.state, 'pending');
    assert.throws(
        () => observeBoundNoWaitRun(binding, {
            runningDir,
            nowMs: 11_001,
            timeouts,
            readRegistrySnapshot,
        }),
        (error) => error.code === 'NO_WAIT_OBSERVATION_STALE'
            && /startup deadline/.test(error.message),
    );
});

test('a future, overflowing, or non-canonical current marker fails closed instead of remaining pending', (t) => {
    const root = workspace(t);
    const runningDir = path.join(root, '.ploinky', 'running');
    const record = recordFor();
    const readRegistrySnapshot = () => ({ [CONTAINER]: record });
    writeMarker(runningDir, identity({ runStartedAtMs: 20_000 }));
    const marker = readNoWaitRunMarker(CONTAINER, { runningDir });
    const binding = createNoWaitRunBinding(CONTAINER, record, marker);
    assert.throws(
        () => observeBoundNoWaitRun(binding, {
            runningDir,
            nowMs: 10_000,
            timeouts: {
                startupGraceMs: 1_000,
                activeTimeoutMs: 1_000,
                terminalPublicationGraceMs: 1_000,
            },
            readRegistrySnapshot,
        }),
        (error) => error.code === 'NO_WAIT_OBSERVATION_INVALID'
            && /implausible future start/.test(error.message),
    );

    writeMarker(runningDir, identity({ runStartedAtMs: Number.MAX_SAFE_INTEGER }));
    const overflowing = createNoWaitRunBinding(
        CONTAINER,
        record,
        readNoWaitRunMarker(CONTAINER, { runningDir }),
    );
    assert.throws(
        () => observeBoundNoWaitRun(overflowing, {
            runningDir,
            nowMs: Number.MAX_SAFE_INTEGER,
            timeouts: {
                startupGraceMs: 1,
                activeTimeoutMs: 1_000,
                terminalPublicationGraceMs: 1_000,
            },
            readRegistrySnapshot,
        }),
        /invalid clock or startup budget|implausible future start/,
    );

    writeMarker(runningDir, identity({
        runId: RUN_B.toUpperCase(),
        statusFile: `${CONTAINER}.${RUN_B.toUpperCase()}.json`,
    }));
    assert.throws(
        () => readNoWaitRunMarker(CONTAINER, { runningDir }),
        (error) => error.code === 'NO_WAIT_OBSERVATION_INVALID'
            && /canonical UUID/.test(error.message),
    );
});

test('generation-A evidence is rejected against generation B for every lifecycle publication shape', (t) => {
    const root = workspace(t);
    const runningDir = path.join(root, '.ploinky', 'running');
    const runA = identity();
    const recordA = recordFor(runA);
    const recordB = recordFor(identity({
        instanceId: INSTANCE_B,
        enableGeneration: GENERATION_B,
    }));
    const cases = [
        ['marker-only pending', null, {}],
        ['starting', 'starting', {}],
        ['running', 'running', {}],
        ['failed', 'failed', { phase: 'launch' }],
        ['spawn-failure', 'failed', { phase: 'spawn' }],
    ];
    for (const [label, state, statusOverrides] of cases) {
        fs.rmSync(runningDir, { recursive: true, force: true });
        writeMarker(runningDir, runA);
        if (state) writeStatus(runningDir, state, runA, statusOverrides);
        const marker = readNoWaitRunMarker(CONTAINER, { runningDir });
        assert.throws(
            () => createNoWaitRunBinding(CONTAINER, recordB, marker),
            (error) => error.code === 'NO_WAIT_RUN_SUPERSEDED',
            `${label} must not bind generation-A evidence onto record B`,
        );

        const binding = createNoWaitRunBinding(CONTAINER, recordA, marker);
        assert.throws(
            () => observeBoundNoWaitRun(binding, {
                runningDir,
                nowMs: 10_500,
                timeouts: {
                    startupGraceMs: 1_000,
                    activeTimeoutMs: 1_000,
                    terminalPublicationGraceMs: 1_000,
                },
                requireWorkerProcess: false,
                readRegistrySnapshot: () => ({ [CONTAINER]: recordB }),
            }),
            (error) => error.code === 'NO_WAIT_RUN_SUPERSEDED',
            `${label} must fail the final generation fence`,
        );
    }

    // Statusless means an already-bound A observation loses its status before
    // the final record fence. It still cannot be converted into pending B.
    fs.rmSync(runningDir, { recursive: true, force: true });
    writeMarker(runningDir, runA);
    const statuslessBinding = createNoWaitRunBinding(
        CONTAINER,
        recordA,
        readNoWaitRunMarker(CONTAINER, { runningDir }),
    );
    assert.throws(
        () => observeBoundNoWaitRun(statuslessBinding, {
            runningDir,
            nowMs: 10_500,
            timeouts: {
                startupGraceMs: 1_000,
                activeTimeoutMs: 1_000,
                terminalPublicationGraceMs: 1_000,
            },
            readRegistrySnapshot: () => ({ [CONTAINER]: recordB }),
        }),
        (error) => error.code === 'NO_WAIT_RUN_SUPERSEDED',
    );
});

test('every status identity field is byte-for-byte fenced against the marker', (t) => {
    const root = workspace(t);
    const runningDir = path.join(root, '.ploinky', 'running');
    const runIdentity = identity();
    const record = recordFor(runIdentity);
    const mutations = {
        containerName: 'ploinky_demo_other',
        instanceId: INSTANCE_B,
        enableGeneration: GENERATION_B,
        repoName: 'other',
        shortAgent: 'other',
        alias: 'blue',
        routeKey: 'blue',
        runId: RUN_B,
        runStartedAtMs: 10_001,
        waveIndex: 1,
        statusFile: `${CONTAINER}.${RUN_B}.json`,
    };
    for (const [field, value] of Object.entries(mutations)) {
        fs.rmSync(runningDir, { recursive: true, force: true });
        writeMarker(runningDir, runIdentity);
        writeStatus(runningDir, 'running', runIdentity, { [field]: value });
        const binding = createNoWaitRunBinding(
            CONTAINER,
            record,
            readNoWaitRunMarker(CONTAINER, { runningDir }),
        );
        assert.throws(
            () => observeBoundNoWaitRun(binding, {
                runningDir,
                nowMs: 10_500,
                requireWorkerProcess: false,
                readRegistrySnapshot: () => ({ [CONTAINER]: record }),
            }),
            (error) => error.code === 'NO_WAIT_OBSERVATION_INVALID',
            `${field} mismatch must be rejected`,
        );
    }
});
