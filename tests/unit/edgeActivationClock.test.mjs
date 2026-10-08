// The activation clock and the routing-mutation reader behind the startup
// probe's skip rule. The observer must give every activation a fresh token
// (an identical re-apply reproduces the generation id), never disclose the
// activation id, and never throw; the reader must report 'idle' only on
// positive evidence and never change the files it reads.
import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    __testables,
    observeEdgeActivation,
    readRoutingMutationState,
} from '../../cli/server/edgeActivationClock.js';
import { RUNNING_DIR } from '../../cli/utils/config.js';
import { WORKSPACE_MUTATION_LEASE_PATH, WORKSPACE_START_LOCK_PATH } from '../../cli/utils/runtime/maintenanceLocks.js';
import { resolveEdgeGenerationPaths } from '../../cli/sandbox/edgeGeneration.js';
import { makeWorld } from './hardwareAvailabilityResolverFixtures.mjs';

const TOKEN = /^[A-Za-z0-9_-]{12}\.[1-9][0-9]{0,15}$/;
const GEN_A = `sha256:${'a'.repeat(64)}`;
const GEN_B = `sha256:${'b'.repeat(64)}`;

function lease(id = GEN_A, activationId = 'activation-one', revision = 'rev-1') {
    return { id, activationId, effective: { revision } };
}

function clock(start = 100) {
    const state = { value: start };
    return { now: () => state.value, set: (value) => { state.value = value; } };
}

test('R-A1: the same activation keeps its token and its age grows with the Router clock', () => {
    __testables.reset();
    const time = clock(100);
    const first = observeEdgeActivation(lease(), time);
    assert.match(first.activation, TOKEN);
    assert.equal(first.activeForMs, 0);
    time.set(1100);
    assert.deepEqual(observeEdgeActivation(lease(), time), { activation: first.activation, activeForMs: 1000 });
    time.set(100 + 2499.9);
    assert.equal(observeEdgeActivation(lease(), time).activeForMs, 2499, 'floored, never rounded up');
    time.set(100 + 2500);
    assert.equal(observeEdgeActivation(lease(), time).activeForMs, 2500);
    time.set(100 + Number.MAX_SAFE_INTEGER / 2);
    assert.ok(Number.isSafeInteger(observeEdgeActivation(lease(), time).activeForMs));
});

test('R-A2: a new activation id or hardware revision gets a new token at age 0', () => {
    __testables.reset();
    const time = clock(100);
    const first = observeEdgeActivation(lease(), time);
    time.set(5000);
    const reactivated = observeEdgeActivation(lease(GEN_A, 'activation-two'), time);
    assert.notEqual(reactivated.activation, first.activation);
    assert.equal(reactivated.activeForMs, 0);
    time.set(9000);
    const revised = observeEdgeActivation(lease(GEN_A, 'activation-two', 'rev-2'), time);
    assert.notEqual(revised.activation, reactivated.activation);
    assert.equal(revised.activeForMs, 0);
    const withoutRevision = observeEdgeActivation({ id: GEN_A, activationId: 'activation-two' }, time);
    assert.notEqual(withoutRevision.activation, revised.activation);
});

test('R-A3: keys A, B, A give three distinct tokens', () => {
    __testables.reset();
    const time = clock(100);
    const tokens = [lease(GEN_A, 'x'), lease(GEN_B, 'y'), lease(GEN_A, 'x')]
        .map((entry) => observeEdgeActivation(entry, time).activation);
    assert.equal(new Set(tokens).size, 3);
});

test('R-A4: an invalid lease returns null and leaves the slot unchanged', () => {
    __testables.reset();
    const time = clock(100);
    const first = observeEdgeActivation(lease(), time);
    const hostile = new Proxy({}, { get() { throw new Error('hostile lease'); } });
    for (const invalid of [
        null,
        undefined,
        {},
        'sha256:x',
        { id: GEN_A },
        { id: GEN_A, activationId: '' },
        { id: GEN_A, activationId: 42 },
        { id: 'sha256:ABC', activationId: 'x' },
        { id: `${GEN_A} `, activationId: 'x' },
        hostile,
    ]) {
        assert.equal(observeEdgeActivation(invalid, time), null);
    }
    time.set(700);
    assert.deepEqual(observeEdgeActivation(lease(), time), { activation: first.activation, activeForMs: 600 });
    // A clock that fails or returns no number is not an observation either.
    assert.equal(observeEdgeActivation(lease(), { now: () => { throw new Error('clock'); } }), null);
    assert.equal(observeEdgeActivation(lease(), { now: () => Number.NaN }), null);
    assert.equal(observeEdgeActivation(lease(), { now: () => '700' }), null);
    assert.deepEqual(observeEdgeActivation(lease(), time), { activation: first.activation, activeForMs: 600 });
});

test('R-A5: a clock rewind starts a new token', () => {
    __testables.reset();
    const time = clock(5000);
    const first = observeEdgeActivation(lease(), time);
    time.set(4999);
    const rewound = observeEdgeActivation(lease(), time);
    assert.notEqual(rewound.activation, first.activation);
    assert.equal(rewound.activeForMs, 0);
});

test('R-A6: a real identical-sources re-apply keeps the generation id but gets a new token at age 0', (t) => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
    __testables.reset();
    const world = makeWorld(t);
    const time = clock(100);
    const before = world.lease();
    const first = observeEdgeActivation(before, time);
    time.set(4000);
    assert.equal(observeEdgeActivation(world.lease(), time).activeForMs, 3900);
    const reapplied = world.apply('reapply-same-generation');
    assert.equal(reapplied, before.id, 'unchanged sources select the same generation id');
    const after = world.lease();
    assert.equal(after.id, before.id);
    const second = observeEdgeActivation(after, time);
    assert.notEqual(second.activation, first.activation);
    assert.equal(second.activeForMs, 0);
    for (const secret of [before.activationId, after.activationId]) {
        assert.equal(JSON.stringify([first, second]).includes(secret), false, 'the activation id is never emitted');
    }
});

test('R-A9: a fresh module instance (a Router restart) uses a different token prefix', async () => {
    __testables.reset();
    const current = observeEdgeActivation(lease(), clock(1));
    const fresh = await import(`../../cli/server/edgeActivationClock.js?restart=${randomUUID()}`);
    const restarted = fresh.observeEdgeActivation(lease(), clock(1));
    assert.match(restarted.activation, TOKEN);
    assert.notEqual(restarted.activation.split('.')[0], current.activation.split('.')[0]);
    assert.notEqual(fresh.__testables.nonce(), __testables.nonce());
});

test('idempotency and interleaving: repeated observations keep one token; alternating activations never age', () => {
    __testables.reset();
    const time = clock(0);
    const first = observeEdgeActivation(lease(), time);
    for (let index = 1; index <= 100; index += 1) {
        time.set(index);
        assert.equal(observeEdgeActivation(lease(), time).activation, first.activation);
    }
    assert.equal(first.activation.split('.')[1], '1');
    const seen = new Set();
    for (let index = 0; index < 50; index += 1) {
        time.set(1000 + (index * 100));
        const a = observeEdgeActivation(lease(GEN_A, 'a'), time);
        const b = observeEdgeActivation(lease(GEN_B, 'b'), time);
        assert.equal(a.activeForMs, 0);
        assert.equal(b.activeForMs, 0, 'B never reports an age it did not hold the slot for');
        seen.add(a.activation);
        seen.add(b.activation);
    }
    assert.equal(seen.size, 100);
});

function tempWorkspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-mutation-state-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runningDir = path.join(root, '.ploinky', 'running');
    const edgeDir = path.join(root, '.ploinky', 'data', 'edge-routing');
    fs.mkdirSync(runningDir, { recursive: true });
    fs.mkdirSync(edgeDir, { recursive: true });
    return {
        root,
        runningDir,
        edgeDir,
        leaseFile: path.join(runningDir, 'workspace-start.json'),
        preparationLeaseFile: path.join(edgeDir, 'preparation-lease.json'),
    };
}

function readerOptions(ws, extra = {}) {
    return {
        runningDir: ws.runningDir,
        leaseFile: ws.leaseFile,
        preparationLeaseFile: ws.preparationLeaseFile,
        ...extra,
    };
}

test('R-A10: the composite reader is idle only when every signal is positively absent', (t) => {
    const ws = tempWorkspace(t);
    assert.equal(readRoutingMutationState(readerOptions(ws)), 'idle', 'no lease, no preparation, no no-wait directory');

    fs.writeFileSync(ws.leaseFile, '{}');
    assert.equal(readRoutingMutationState(readerOptions(ws)), 'busy', 'workspace lease present');
    fs.rmSync(ws.leaseFile);

    fs.writeFileSync(ws.preparationLeaseFile, '{}');
    assert.equal(readRoutingMutationState(readerOptions(ws)), 'busy', 'preparation lease present');
    fs.rmSync(ws.preparationLeaseFile);

    fs.mkdirSync(ws.leaseFile);
    assert.equal(readRoutingMutationState(readerOptions(ws)), 'busy', 'lease path is a directory');
    fs.rmdirSync(ws.leaseFile);

    fs.symlinkSync(path.join(ws.root, 'missing-target'), ws.leaseFile);
    assert.equal(readRoutingMutationState(readerOptions(ws)), 'busy', 'a dangling symlink is present');
    fs.rmSync(ws.leaseFile);

    assert.equal(readRoutingMutationState(readerOptions(ws, { runningDir: path.join(ws.root, 'absent') })), 'busy',
        'running directory missing');
    const runningFile = path.join(ws.root, 'running-file');
    fs.writeFileSync(runningFile, 'x');
    assert.equal(readRoutingMutationState(readerOptions(ws, { runningDir: runningFile })), 'busy', 'running directory is a file');
    const runningLink = path.join(ws.root, 'running-link');
    fs.symlinkSync(ws.runningDir, runningLink);
    assert.equal(readRoutingMutationState(readerOptions(ws, { runningDir: runningLink })), 'busy', 'running directory is a symlink');

    // The real no-wait scan runs against the same running directory.
    fs.mkdirSync(path.join(ws.runningDir, 'no-wait'));
    assert.equal(readRoutingMutationState(readerOptions(ws)), 'idle');
    fs.writeFileSync(path.join(ws.runningDir, 'no-wait', 'ploinky_fixtures_x.current.json'), '{');
    assert.equal(readRoutingMutationState(readerOptions(ws)), 'busy', 'an unverifiable marker');
    assert.equal(readRoutingMutationState(readerOptions(ws)), 'busy');
    assert.equal(fs.existsSync(path.join(ws.runningDir, 'no-wait', 'ploinky_fixtures_x.current.json')), true);
});

test('R-A11: lstat errors, a busy or failing no-wait scan, and unresolvable paths are busy', (t) => {
    const ws = tempWorkspace(t);
    const idleScan = () => ({ busy: false, reason: 'settled' });
    assert.equal(readRoutingMutationState(readerOptions(ws, { inspectNoWait: idleScan })), 'idle');
    for (const code of ['EACCES', 'EIO', 'ELOOP', undefined]) {
        for (const failing of [ws.runningDir, ws.leaseFile, ws.preparationLeaseFile]) {
            const lstat = (file) => {
                if (file === failing) throw Object.assign(new Error('injected'), code ? { code } : {});
                return fs.lstatSync(file);
            };
            assert.equal(readRoutingMutationState(readerOptions(ws, { lstat, inspectNoWait: idleScan })), 'busy',
                `${code} on ${path.basename(failing)}`);
        }
    }
    const calls = [];
    assert.equal(readRoutingMutationState(readerOptions(ws, {
        inspectNoWait: (options) => { calls.push(options); return { busy: true, reason: 'live-worker' }; },
    })), 'busy');
    assert.deepEqual(calls, [{ runningDir: ws.runningDir }], 'the scan reads the same running directory');
    assert.equal(readRoutingMutationState(readerOptions(ws, { inspectNoWait: () => { throw new Error('scan'); } })), 'busy');
    for (const odd of [undefined, null, {}, { busy: 'false' }, { busy: 0 }]) {
        assert.equal(readRoutingMutationState(readerOptions(ws, { inspectNoWait: () => odd })), 'busy', JSON.stringify(odd));
    }
    for (const bad of [{ leaseFile: '' }, { leaseFile: 'relative/workspace-start.json' }, { preparationLeaseFile: 42 }, { runningDir: '' }]) {
        assert.equal(readRoutingMutationState(readerOptions(ws, { ...bad, inspectNoWait: idleScan })), 'busy', JSON.stringify(bad));
    }
    const source = fs.readFileSync(new URL('../../cli/server/edgeActivationClock.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /inspectWorkspaceStartLock|unlinkSync|rmSync|writeFileSync|renameSync/);
});

test('the default reader watches this workspace\'s mutation lease, preparation lease and running directory', () => {
    assert.equal(WORKSPACE_MUTATION_LEASE_PATH, WORKSPACE_START_LOCK_PATH);
    assert.equal(WORKSPACE_MUTATION_LEASE_PATH, path.join(RUNNING_DIR, 'workspace-start.json'));
    const preparation = resolveEdgeGenerationPaths().preparationLeaseFile;
    assert.equal(path.dirname(path.dirname(path.dirname(preparation))), path.dirname(RUNNING_DIR));
    // Write only inside the private root isolatedWorkspaceRoot.mjs created;
    // a root the runner chose may be a real workspace.
    if (!path.basename(path.dirname(path.dirname(RUNNING_DIR))).startsWith('ploinky-test-workspace-')) {
        assert.ok(['idle', 'busy'].includes(readRoutingMutationState()));
        return;
    }
    const cleanup = [];
    try {
        if (!fs.existsSync(RUNNING_DIR)) {
            assert.equal(readRoutingMutationState(), 'busy', 'no running directory yet');
            fs.mkdirSync(RUNNING_DIR, { recursive: true });
            cleanup.push(RUNNING_DIR);
        }
        assert.equal(readRoutingMutationState(), 'idle');
        fs.writeFileSync(WORKSPACE_MUTATION_LEASE_PATH, '{}');
        cleanup.push(WORKSPACE_MUTATION_LEASE_PATH);
        assert.equal(readRoutingMutationState(), 'busy');
        fs.rmSync(WORKSPACE_MUTATION_LEASE_PATH);
        fs.mkdirSync(path.dirname(preparation), { recursive: true });
        fs.writeFileSync(preparation, '{}');
        cleanup.push(preparation);
        assert.equal(readRoutingMutationState(), 'busy');
    } finally {
        for (const entry of cleanup.reverse()) fs.rmSync(entry, { recursive: true, force: true });
    }
});

function snapshotTree(root) {
    const entries = [];
    const walk = (directory) => {
        for (const name of fs.readdirSync(directory).sort()) {
            const file = path.join(directory, name);
            const stat = fs.lstatSync(file);
            entries.push([path.relative(root, file), stat.ino, stat.mode, stat.mtimeMs, stat.size,
                stat.isFile() ? fs.readFileSync(file, 'utf8') : null]);
            if (stat.isDirectory()) walk(file);
        }
    };
    walk(root);
    return entries;
}

test('AC-A14: 50 reader calls leave running/ and data/edge-routing/ unchanged, including a dead owner\'s lease', async (t) => {
    const ws = tempWorkspace(t);
    const deadPid = await new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
        child.once('exit', () => resolve(child.pid));
    });
    const noWaitDir = path.join(ws.runningDir, 'no-wait');
    fs.mkdirSync(noWaitDir);
    const runId = randomUUID();
    const runStartedAtMs = Date.now() - 5_000;
    const identity = {
        containerName: 'ploinky_fixtures_probe', instanceId: 'probe-instance', enableGeneration: 'probe-generation',
        repoName: 'fixtures', shortAgent: 'probe', alias: '', routeKey: 'probe', runId, runStartedAtMs, waveIndex: 0,
        statusFile: `ploinky_fixtures_probe.${runId}.json`,
    };
    fs.writeFileSync(path.join(noWaitDir, 'ploinky_fixtures_probe.current.json'), JSON.stringify(identity));
    fs.writeFileSync(path.join(noWaitDir, identity.statusFile), JSON.stringify({
        ...identity, state: 'starting', sequencePhase: 'active', sequencePhaseStartedAtMs: runStartedAtMs + 10, pid: deadPid,
    }));
    fs.writeFileSync(path.join(ws.edgeDir, 'active.json'), '{"state":"active"}');
    const before = { running: snapshotTree(ws.runningDir), edge: snapshotTree(ws.edgeDir) };

    // The real scan proves the dead pid stale; inside its deadline that is busy.
    for (let index = 0; index < 50; index += 1) assert.equal(readRoutingMutationState(readerOptions(ws)), 'busy');
    fs.writeFileSync(ws.leaseFile, JSON.stringify({ pid: deadPid, token: 'stale-owner', expiresAt: 0 }));
    fs.writeFileSync(ws.preparationLeaseFile, JSON.stringify({ pid: deadPid }));
    const withLeases = { running: snapshotTree(ws.runningDir), edge: snapshotTree(ws.edgeDir) };
    for (let index = 0; index < 50; index += 1) assert.equal(readRoutingMutationState(readerOptions(ws)), 'busy');
    assert.deepEqual({ running: snapshotTree(ws.runningDir), edge: snapshotTree(ws.edgeDir) }, withLeases,
        'a dead owner\'s leases are reported busy and never cleaned');
    fs.rmSync(ws.leaseFile);
    fs.rmSync(ws.preparationLeaseFile);
    assert.deepEqual({ running: snapshotTree(ws.runningDir), edge: snapshotTree(ws.edgeDir) }, before);
});

test('AC-A15: the clock module does not import noWaitWorker.js directly', () => {
    const source = fs.readFileSync(new URL('../../cli/server/edgeActivationClock.js', import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
        .map((match) => match[1] || match[2]);
    assert.ok(specifiers.includes('../commands/noWaitWorkerLiveness.js'));
    assert.equal(specifiers.some((specifier) => /noWaitWorker\.js$/.test(specifier)), false);
});
