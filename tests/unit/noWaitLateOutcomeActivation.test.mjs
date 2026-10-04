// M-NW-01: the worker's terminal `failed` status write. Visible at the run-scoped
// rename, durable at the directory fsync after it; the timestamp contract of a
// terminal status; and the rule that a canonical failure never suppresses the
// run-scoped write. The kill leaves run a real worker write in a child process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { initializeFreshEdgeRoutingSources } from '../../cli/sandbox/edgeGeneration.js';
import { readHardwareAvailabilityPolicy } from '../../cli/sandbox/hardwareAvailabilityStore.mjs';
import { NO_WAIT_TERMINAL_TIMESTAMP_INVALID, validateNoWaitTerminalTimestamps } from '../../cli/commands/noWaitProtocol.js';
import { writeNoWaitWorkerStatus } from '../../cli/commands/noWaitWorker.js';
import { fsError, spyFs } from './hardwareAvailabilityFixtures.mjs';

const DRIVER = path.resolve(import.meta.dirname, 'noWaitLateOutcomeActivationDriver.mjs');
const ROOT = path.resolve(import.meta.dirname, '../..');
const href = (relative) => pathToFileURL(path.join(ROOT, relative)).href;
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const CONTAINER = 'ploinky_fixtures_worker';
const RUN_STARTED_AT_MS = 1_700_000_000_000;

function identity(containerName = CONTAINER) {
    return {
        containerName,
        instanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        enableGeneration: 'ffffffff-1111-4222-8333-444444444444',
        repoName: 'fixtures',
        shortAgent: 'worker',
        alias: '',
        routeKey: 'worker',
        runId: RUN_ID,
        runStartedAtMs: RUN_STARTED_AT_MS,
        waveIndex: 0,
        statusFile: `${containerName}.${RUN_ID}.json`,
    };
}

function failedPayload(finishedAtMs = Date.now() - 100) {
    const startedAtMs = RUN_STARTED_AT_MS + 10;
    return {
        containerName: CONTAINER,
        pid: process.pid,
        state: 'failed',
        sequencePhase: 'active',
        phase: 'admission',
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        sequencePhaseStartedAt: new Date(startedAtMs).toISOString(),
        sequencePhaseStartedAtMs: startedAtMs,
        finishedAt: new Date(finishedAtMs).toISOString(),
        finishedAtMs,
        error: { message: 'refused by the fixture' },
    };
}

function runningRoot(t) {
    const runningDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nw1-status-')));
    t.after(() => fs.rmSync(runningDir, { recursive: true, force: true }));
    const statusDir = path.join(runningDir, 'no-wait');
    return {
        runningDir,
        statusDir,
        canonical: path.join(statusDir, `${CONTAINER}.json`),
        runScoped: path.join(statusDir, `${CONTAINER}.${RUN_ID}.json`),
    };
}

function write(layout, payload, extra = {}) {
    return writeNoWaitWorkerStatus(CONTAINER, payload, {
        identity: identity(),
        runId: RUN_ID,
        runStartedAtMs: RUN_STARTED_AT_MS,
        waveIndex: 0,
        statusFile: layout.runScoped,
        runningDir: layout.runningDir,
        ...extra,
    });
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const leftovers = (layout) => fs.readdirSync(layout.statusDir).filter((name) => name.endsWith('.tmp'));
function silence(t) {
    const lines = [];
    t.mock.method(console, 'error', (line) => { lines.push(String(line)); });
    return lines;
}

test('NW1.D2-failed-status-writes-are-fsynced-and-the-run-scoped-rename-commits', (t) => {
    const layout = runningRoot(t);
    // A non-terminal status keeps its exact calls: no fsync at all, canonical then run-scoped.
    const starting = spyFs();
    const document = write(layout, { state: 'starting', sequencePhase: 'active' }, { fsApi: starting.api });
    assert.equal(document.state, 'starting', 'a non-terminal write still returns its document');
    assert.deepEqual(starting.calls.filter((call) => call.op === 'fsync'), []);
    assert.deepEqual(starting.calls.filter((call) => call.op === 'rename').map((call) => call.to), [layout.canonical, layout.runScoped]);

    // A terminal status: per file fsync(temp fd) -> rename (visibility) -> fsync(directory) (durability); canonical first.
    let directoryFsyncs = 0;
    const failed = spyFs({
        fsyncSync: (descriptor, resolved) => {
            fs.fsyncSync(descriptor);
            if (resolved === layout.statusDir) {
                directoryFsyncs += 1;
                const until = Date.now() + 30;
                while (Date.now() < until) { /* a slow directory fsync separates the two timestamps */ }
            }
        },
    });
    const before = Date.now();
    const report = write(layout, failedPayload(), { fsApi: failed.api });
    const after = Date.now();
    const sequence = failed.calls
        .filter((call) => call.op === 'rename' || call.op === 'fsync')
        .map((call) => {
            if (call.op === 'rename') return `rename:${path.basename(call.to)}`;
            return call.path === layout.statusDir ? 'fsync:directory' : `fsync:${path.basename(call.path).replace(/\.\d+\.[0-9a-f-]{36}\.tmp$/, '.tmp')}`;
        });
    assert.deepEqual(sequence, [
        `fsync:${CONTAINER}.json.tmp`, `rename:${CONTAINER}.json`, 'fsync:directory',
        `fsync:${CONTAINER}.${RUN_ID}.json.tmp`, `rename:${CONTAINER}.${RUN_ID}.json`, 'fsync:directory',
    ]);
    assert.equal(directoryFsyncs, 2);
    assert.deepEqual(leftovers(layout), []);
    for (const file of [layout.canonical, layout.runScoped]) assert.equal(readJson(file).state, 'failed');

    // The terminal report: visible right after the run-scoped rename, durable right after its successful directory fsync.
    assert.deepEqual(Object.keys(report).sort(), ['durableAtMs', 'finishedAtMs', 'statusFile', 'visibleAtMs']);
    assert.equal(report.finishedAtMs, readJson(layout.runScoped).finishedAtMs);
    assert.equal(report.statusFile, `${CONTAINER}.${RUN_ID}.json`);
    assert.ok(before <= report.visibleAtMs && report.visibleAtMs <= report.durableAtMs && report.durableAtMs <= after, JSON.stringify({ before, report, after }));
    assert.ok(report.durableAtMs - report.visibleAtMs >= 25, 'visibleAtMs precedes the directory fsync, durableAtMs follows it');
    assert.equal(Object.hasOwn(report, 'durabilityError'), false);
});

test('NW1.D2-terminal-timestamps-are-validated', () => {
    const NOW = 1_700_000_100_000;
    const status = (overrides = {}) => ({ ...failedPayload(NOW - 5000), runStartedAtMs: RUN_STARTED_AT_MS, ...overrides });
    const invalid = (value, label, nowMs = NOW) => assert.throws(() => validateNoWaitTerminalTimestamps(value, { nowMs }), (error) => (
        error.code === NO_WAIT_TERMINAL_TIMESTAMP_INVALID && error instanceof Error
    ), label);
    const withMs = (field, value, isoField) => status({ [field]: value, ...(isoField ? { [isoField]: new Date(value).toISOString() } : {}) });

    // T5: the result is exactly the status's own finishedAtMs; nothing is re-stamped.
    const good = status();
    const snapshot = JSON.stringify(good);
    assert.equal(validateNoWaitTerminalTimestamps(good, { nowMs: NOW }).finishedAtMs, good.finishedAtMs);
    assert.equal(JSON.stringify(good), snapshot);
    assert.notEqual(validateNoWaitTerminalTimestamps(good, { nowMs: NOW }).finishedAtMs, NOW);

    // T1: safe integers greater than zero, own properties only.
    for (const bad of [0, -1, 1.5, '1700000000000', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
        for (const field of ['finishedAtMs', 'startedAtMs', 'sequencePhaseStartedAtMs', 'runStartedAtMs']) {
            invalid(status({ [field]: bad }), `${field}=${String(bad)}`);
        }
    }
    invalid(status({ finishedAtMs: Number.MAX_SAFE_INTEGER, finishedAt: 'x' }), 'MAX_SAFE_INTEGER (its ISO text cannot exist)');
    invalid(status({ finishedAtMs: Number.MAX_SAFE_INTEGER, finishedAt: new Date(NOW).toISOString() }), 'MAX_SAFE_INTEGER with a plausible ISO text');
    for (const field of ['finishedAtMs', 'startedAtMs', 'sequencePhaseStartedAtMs', 'runStartedAtMs']) {
        const missing = status();
        delete missing[field];
        invalid(missing, `missing ${field}`);
        invalid(Object.assign(Object.create({ [field]: status()[field] }), (() => { const own = status(); delete own[field]; return own; })()), `inherited ${field}`);
    }
    invalid(null, 'null status');
    invalid([], 'array status');

    // T2: each ISO field equals toISOString() of its millisecond value exactly.
    invalid(status({ finishedAt: new Date(good.finishedAtMs + 1).toISOString() }), 'finishedAt off by 1 ms');
    invalid(status({ startedAt: '2023-11-14T22:13:20Z' }), 'startedAt without milliseconds');
    invalid(status({ sequencePhaseStartedAt: undefined }), 'missing sequencePhaseStartedAt');
    invalid(status({ finishedAt: 1_700_000_095_000 }), 'finishedAt is a number');
    const inheritedIso = status();
    const inheritedBase = { finishedAt: inheritedIso.finishedAt };
    delete inheritedIso.finishedAt;
    invalid(Object.assign(Object.create(inheritedBase), inheritedIso), 'inherited finishedAt');

    // T3: runStartedAtMs <= startedAtMs <= sequencePhaseStartedAtMs <= finishedAtMs.
    invalid(withMs('runStartedAtMs', good.startedAtMs + 1), 'runStartedAtMs after startedAtMs');
    invalid(withMs('startedAtMs', good.sequencePhaseStartedAtMs + 1, 'startedAt'), 'startedAtMs after sequencePhaseStartedAtMs');
    invalid(withMs('sequencePhaseStartedAtMs', good.finishedAtMs + 1, 'sequencePhaseStartedAt'), 'sequencePhaseStartedAtMs after finishedAtMs');
    const equal = status({ startedAtMs: RUN_STARTED_AT_MS, startedAt: new Date(RUN_STARTED_AT_MS).toISOString(), sequencePhaseStartedAtMs: RUN_STARTED_AT_MS, sequencePhaseStartedAt: new Date(RUN_STARTED_AT_MS).toISOString() });
    assert.equal(validateNoWaitTerminalTimestamps(equal, { nowMs: NOW }).finishedAtMs, equal.finishedAtMs, 'equal times are ordered');

    // T4: finishedAtMs <= now + 1000.
    const at = (offset) => status({ finishedAtMs: NOW + offset, finishedAt: new Date(NOW + offset).toISOString() });
    assert.equal(validateNoWaitTerminalTimestamps(at(999), { nowMs: NOW }).finishedAtMs, NOW + 999);
    assert.equal(validateNoWaitTerminalTimestamps(at(1000), { nowMs: NOW }).finishedAtMs, NOW + 1000);
    invalid(at(1001), 'now+1001');
    invalid(at(86_400_000), 'a day ahead');
});

test('NW1.D2-a-failed-run-scoped-directory-fsync-leaves-the-status-visible-and-reports-it-not-durable', (t) => {
    const lines = silence(t);
    const layout = runningRoot(t);
    let lastRename = null;
    const spy = spyFs({
        renameSync: (from, to) => { lastRename = to; return fs.renameSync(from, to); },
        fsyncSync: (descriptor, resolved) => {
            if (resolved === layout.statusDir && lastRename === layout.runScoped) throw fsError('EIO');
            return fs.fsyncSync(descriptor);
        },
    });
    const report = write(layout, failedPayload(), { fsApi: spy.api });
    // The write neither throws nor aborts: the status is visible and reported not durable.
    assert.equal(readJson(layout.runScoped).state, 'failed');
    assert.equal(readJson(layout.canonical).state, 'failed');
    assert.deepEqual(Object.keys(report).sort(), ['durabilityError', 'finishedAtMs', 'statusFile', 'visibleAtMs']);
    assert.equal(report.durabilityError, 'EIO');
    assert.equal(Object.hasOwn(report, 'durableAtMs'), false, 'a failed fsync records no durableAtMs');
    assert.ok(Number.isSafeInteger(report.visibleAtMs));
    assert.equal(spy.calls.filter((call) => call.op === 'rename' && call.to === layout.runScoped).length, 1, 'the visible status is never rewritten');
    assert.deepEqual(leftovers(layout), []);
    assert.equal(lines.filter((line) => /visible but not durable/.test(line)).length, 1);

    // A directory fsync failure of the CANONICAL file is only logged, and the run-scoped write is still durable.
    const second = runningRoot(t);
    let renamed = null;
    const canonicalFailure = spyFs({
        renameSync: (from, to) => { renamed = to; return fs.renameSync(from, to); },
        fsyncSync: (descriptor, resolved) => {
            if (resolved === second.statusDir && renamed === second.canonical) throw fsError('EIO');
            return fs.fsyncSync(descriptor);
        },
    });
    const durable = write(second, failedPayload(), { fsApi: canonicalFailure.api });
    assert.ok(Number.isSafeInteger(durable.durableAtMs));
    assert.equal(Object.hasOwn(durable, 'durabilityError'), false);
});

test('NW1.S-a-failed-canonical-write-does-not-suppress-the-run-scoped-terminal-write', (t) => {
    const cases = {
        'the canonical rename fails': (layout) => ({ renameSync: (from, to) => { if (to === layout.canonical) throw fsError('EIO'); return fs.renameSync(from, to); } }),
        'the canonical temp write fails': (layout) => ({ writeFileSync: (target, data, options, resolved) => { if (resolved?.startsWith(`${layout.canonical}.`)) throw fsError('ENOSPC'); return fs.writeFileSync(target, data, options); } }),
        'the canonical temp fsync fails': (layout) => ({ fsyncSync: (descriptor, resolved) => { if (resolved?.startsWith(`${layout.canonical}.`)) throw fsError('EIO'); return fs.fsyncSync(descriptor); } }),
        'the canonical directory fsync fails': (layout) => {
            let renamed = null;
            return {
                renameSync: (from, to) => { renamed = to; return fs.renameSync(from, to); },
                fsyncSync: (descriptor, resolved) => { if (resolved === layout.statusDir && renamed === layout.canonical) throw fsError('EIO'); return fs.fsyncSync(descriptor); },
            };
        },
    };
    for (const [label, build] of Object.entries(cases)) {
        const lines = silence(t);
        const layout = runningRoot(t);
        // The prior non-terminal statuses.
        write(layout, { state: 'starting', sequencePhase: 'active' });
        const report = write(layout, failedPayload(), { fsApi: spyFs(build(layout)).api });
        assert.equal(readJson(layout.runScoped).state, 'failed', `${label}: the run-scoped terminal status is written`);
        assert.ok(Number.isSafeInteger(report.durableAtMs), label);
        assert.equal(lines.filter((line) => /canonical failed status could not be written durably/.test(line)).length, 1, label);
        assert.deepEqual(leftovers(layout), [], label);
        t.mock.restoreAll();
    }
    // Only a failure of the run-scoped rename throws, and then nothing is visible under that name.
    const layout = runningRoot(t);
    write(layout, { state: 'starting', sequencePhase: 'active' });
    assert.throws(() => write(layout, failedPayload(), {
        fsApi: spyFs({ renameSync: (from, to) => { if (to === layout.runScoped) throw fsError('EIO'); return fs.renameSync(from, to); } }).api,
    }), (error) => error.code === 'EIO' && error.visible !== true);
    assert.equal(readJson(layout.runScoped).state, 'starting');
    assert.deepEqual(leftovers(layout), []);
});

function driverArgs(options) {
    return [
        '--import', href('tests/helpers/agentlibTestContract.mjs'),
        '--import', href('tests/helpers/engineSpawnGuard.mjs'),
        ...(process.env.C5_MUTATION ? ['--import', href('tests/hardware-limits/c5MutationRegister.mjs')] : []),
        DRIVER,
        JSON.stringify(options),
    ];
}

async function killWorkerAt(t, layout, pauseAt) {
    const signalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw1-sig-'));
    t.after(() => fs.rmSync(signalDir, { recursive: true, force: true }));
    const child = spawn(process.execPath, driverArgs({
        containerName: CONTAINER, runId: RUN_ID, runningDir: layout.runningDir, signalDir, pauseAt, identity: identity(), payload: failedPayload(),
    }), { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    let early = null;
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => { early = { code, signal }; resolve(early); }));
    const marker = path.join(signalDir, `paused.${pauseAt}`);
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(marker)) {
        if (early) throw new Error(`the worker ended before pausing at ${pauseAt}: ${JSON.stringify(early)}\n${output}`);
        if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`the worker did not reach ${pauseAt}\n${output}`); }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.kill('SIGKILL');
    assert.equal((await exited).signal, 'SIGKILL');
}

// There is no resolver or reconciler in this slice: the invariant is on the statuses and the policy.
function policyOf(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nw1-ws-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { paths } = initializeFreshEdgeRoutingSources({ workspaceRoot: root });
    return { read: () => readHardwareAvailabilityPolicy({ paths }) };
}

test('NW1.D2-sigkill-before-the-run-scoped-commit-leaves-no-typed-denial', async (t) => {
    // The worker is killed after the run-scoped temp is fsynced, strictly before its renameSync.
    const layout = runningRoot(t);
    write(layout, { state: 'running', sequencePhase: 'active', pid: process.pid });
    const policy = policyOf(t);
    const before = policy.read();
    await killWorkerAt(t, layout, 'beforeRunScopedRename');
    assert.equal(readJson(layout.runScoped).state, 'running', 'the run-scoped name still holds the non-terminal status');
    assert.equal(readJson(layout.canonical).state, 'failed');
    const temps = leftovers(layout);
    assert.equal(temps.length, 1);
    assert.ok(temps[0].startsWith(`${CONTAINER}.${RUN_ID}.json.`), 'only the run-scoped temp is left, under no status name');
    assert.equal(readJson(path.join(layout.statusDir, temps[0])).state, 'failed', 'the fsynced temp is not a commit');
    assert.deepEqual(policy.read(), before);
    assert.deepEqual(policy.read().entries, {});

    // Before the canonical rename nothing at all is terminal.
    const early = runningRoot(t);
    write(early, { state: 'running', sequencePhase: 'active', pid: process.pid });
    await killWorkerAt(t, early, 'beforeCanonicalRename');
    assert.equal(readJson(early.canonical).state, 'running');
    assert.equal(readJson(early.runScoped).state, 'running');
});

test('NW1.D2-sigkill-between-the-canonical-and-run-scoped-renames-is-not-a-terminal-commit', async (t) => {
    const layout = runningRoot(t);
    write(layout, { state: 'running', sequencePhase: 'active', pid: process.pid });
    const policy = policyOf(t);
    const before = policy.read();
    await killWorkerAt(t, layout, 'betweenRenames');
    assert.equal(readJson(layout.canonical).state, 'failed', 'the canonical file is renamed first and is only diagnostic');
    assert.equal(readJson(layout.runScoped).state, 'running', 'the run-scoped file is the authoritative one and is not terminal');
    assert.deepEqual(leftovers(layout), []);
    assert.deepEqual(policy.read(), before);
    assert.deepEqual(policy.read().entries, {});
});
