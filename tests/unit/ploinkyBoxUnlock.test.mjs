import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { routeOuterCommand } from '../../ploinky-box/command/route.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { LIVENESS } from '../../ploinky-box/lockLiveness.mjs';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';
import { formatUnlockReport, unlockWorkspace } from '../../ploinky-box/unlock.mjs';
import { recoverStaleStoreLock } from '../../cli/sandbox/hardwareLimits/storeLock.mjs';

// `ploinky unlock` (plan D4, Step 7). Each lock is removed only when its
// holder is classified stale, or cannot be classified and is named exactly by
// --force-holder, and only after the decision is repeated under the reclaim
// guard. Live holders, leftovers and malformed or ownerless locks are kept and
// listed, and the command exits 1.

const MACHINE = 'm'.repeat(32);
const FOREIGN = 'f'.repeat(32);
// Above every PID limit: kill(pid, 0) reports ESRCH.
const DEAD_PID = 2147483646;

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-unlock-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    return { root, workspace, identity: buildWorkspaceIdentity(workspace) };
}

const lockPathOf = (workspace) => path.join(workspace, '.ploinky-box', 'locks', 'workspace.lock');
const guardPathOf = (workspace) => `${lockPathOf(workspace)}.reclaim`;

// Classification by PID: `dead` stale, `undetermined` unclassifiable, others live.
// `flip` maps a PID to the verdicts of successive classifications.
function fakeLiveness({ dead = [], undetermined = [], flip = {} } = {}) {
    const local = { hostname: 'test-host', machineId: MACHINE, bootId: '11111111-1111-4111-8111-111111111111', pidNamespace: 'pid:[1]' };
    const calls = new Map();
    return {
        localIdentity: () => local,
        selfFields: () => ({ ...local, pid: 4242, processStart: 'linux:4242' }),
        processStart: (value) => `linux:${value}`,
        classify(owner) {
            if (flip[owner.pid]) {
                const index = calls.get(owner.pid) || 0;
                calls.set(owner.pid, index + 1);
                const state = flip[owner.pid][Math.min(index, flip[owner.pid].length - 1)];
                return { state, reason: `flip ${index}` };
            }
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

function plantDirectory(directory, record, extra = []) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (record !== undefined) {
        fs.writeFileSync(path.join(directory, 'owner.json'),
            typeof record === 'string' ? record : `${JSON.stringify(record)}\n`, { mode: 0o600 });
    }
    for (const name of extra) fs.writeFileSync(path.join(directory, name), 'leftover\n');
    return directory;
}

function storeLockPathOf(identity) {
    return path.join(identity.workspaceRoot, '.ploinky-box', 'hardware-limits', identity.instance, 'store', 'write.lock');
}

function plantStoreLock(identity, record) {
    const lockPath = storeLockPathOf(identity);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, typeof record === 'string' ? record : `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return lockPath;
}

function storeOwner(overrides = {}) {
    return { token: 'a'.repeat(32), pid: DEAD_PID, hostname: os.hostname(), domain: 'host', operation: 'set_agent_limits',
        acquiredAt: new Date(0).toISOString(), ...overrides };
}

async function unlock(identity, liveness, { forceHolder = null, box = 'absent' } = {}) {
    return unlockWorkspace({
        identity,
        lockManager: createMutationLockManager({ liveness, retryMs: 1, timeoutMs: 200 }),
        observeBoxState: () => ({ state: box }),
        forceHolder,
    });
}

const states = (report) => report.items.map((entry) => `${entry.kind}:${entry.state}`);

test('nothing to unlock: nothing is created and the command succeeds', async (t) => {
    const { workspace, identity } = fixture(t);
    const report = await unlock(identity, fakeLiveness());
    assert.deepEqual(states(report), ['reclaim-guard:absent', 'workspace-lock:absent', 'store-lock:absent']);
    assert.equal(report.exitCode, 0);
    assert.deepEqual(fs.readdirSync(workspace), [], 'unlock never creates the host state skeleton');
    assert.match(formatUnlockReport(report), /No stuck lock remains/);
});

test('a stale workspace lock is reclaimed; a live holder is never removed, even when named', async (t) => {
    const { workspace, identity } = fixture(t);
    plantDirectory(lockPathOf(workspace), owner({ pid: 101 }));
    const removed = await unlock(identity, fakeLiveness({ dead: [101] }));
    assert.deepEqual(states(removed), ['reclaim-guard:absent', 'workspace-lock:removed', 'store-lock:absent']);
    assert.equal(removed.exitCode, 0);
    assert.equal(fs.existsSync(lockPathOf(workspace)), false);
    assert.deepEqual(fs.readdirSync(path.dirname(lockPathOf(workspace))), [], 'no guard or debris is left');

    plantDirectory(lockPathOf(workspace), owner({ pid: 102 }));
    for (const forceHolder of [null, `102@${MACHINE}`]) {
        const kept = await unlock(identity, fakeLiveness(), { forceHolder });
        assert.equal(kept.exitCode, 1);
        assert.equal(kept.items[1].state, 'kept');
        assert.match(kept.items[1].reason, /held by a running command/);
        assert.equal(JSON.parse(fs.readFileSync(path.join(lockPathOf(workspace), 'owner.json'), 'utf8')).pid, 102);
    }
});

test('an unclassified holder is kept unless --force-holder names it exactly', async (t) => {
    const { workspace, identity } = fixture(t);
    plantDirectory(lockPathOf(workspace), owner({ pid: 123, machineId: FOREIGN }));
    const liveness = fakeLiveness({ undetermined: [123] });

    const plain = await unlock(identity, liveness);
    assert.equal(plain.exitCode, 1);
    assert.match(plain.items[1].reason, /cannot be classified \(it is held on another machine\)/);
    assert.match(formatUnlockReport(plain), new RegExp(`Next: If pid 123 on test-host is no longer running, run: ploinky unlock --force-holder 123@${FOREIGN}`));

    for (const wrong of [`124@${FOREIGN}`, `123@${MACHINE}`, '123@test-host']) {
        const mismatch = await unlock(identity, liveness, { forceHolder: wrong });
        assert.equal(mismatch.exitCode, 1, wrong);
        assert.match(mismatch.items[1].reason, /does not name its holder/);
        assert.equal(fs.existsSync(path.join(lockPathOf(workspace), 'owner.json')), true);
    }

    const forced = await unlock(identity, liveness, { forceHolder: `123@${FOREIGN}` });
    assert.equal(forced.exitCode, 0);
    assert.equal(forced.items[1].state, 'removed');
    assert.match(forced.items[1].reason, /forced: --force-holder/);
    assert.equal(fs.existsSync(lockPathOf(workspace)), false);
});

test('a holder without a machine identity is named by its hostname', async (t) => {
    const { workspace, identity } = fixture(t);
    plantDirectory(lockPathOf(workspace), owner({ pid: 125, machineId: null }));
    const liveness = fakeLiveness({ undetermined: [125] });
    assert.equal((await unlock(identity, liveness, { forceHolder: '125@test-host' })).items[1].state, 'removed');
});

test('the decision is repeated under the reclaim guard: a holder that becomes live is kept', async (t) => {
    const { workspace, identity } = fixture(t);
    plantDirectory(lockPathOf(workspace), owner({ pid: 130 }));
    const report = await unlock(identity, fakeLiveness({ flip: { 130: [LIVENESS.stale, LIVENESS.live] } }));
    assert.equal(report.exitCode, 1);
    assert.equal(report.items[1].state, 'kept');
    assert.match(report.items[1].reason, /changed while it was being removed/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockPathOf(workspace), 'owner.json'), 'utf8')).pid, 130);
    assert.equal(fs.existsSync(guardPathOf(workspace)), false, 'the guard this command took is released');
});

test('leftovers, ownerless and malformed locks are listed with manual steps and never removed', async (t) => {
    const { workspace, identity } = fixture(t);
    const lockPath = lockPathOf(workspace);
    const liveness = fakeLiveness({ dead: [140], undetermined: [141] });

    plantDirectory(lockPath, owner({ pid: 140 }), ['candidate-0123456789abcdef.cid']);
    let report = await unlock(identity, liveness);
    assert.equal(report.exitCode, 1);
    assert.match(report.items[1].reason, /still holds files that may be needed for recovery/);
    assert.deepEqual(report.items[1].contents, ['candidate-0123456789abcdef.cid', 'owner.json']);
    assert.match(formatUnlockReport(report), /It holds: candidate-0123456789abcdef\.cid, owner\.json/);
    assert.match(formatUnlockReport(report), /remove it by hand: rm -r -- '/);
    assert.deepEqual(fs.readdirSync(lockPath).sort(), ['candidate-0123456789abcdef.cid', 'owner.json']);
    fs.rmSync(lockPath, { recursive: true });

    // Forcing a named holder does not override leftovers either.
    plantDirectory(lockPath, owner({ pid: 141, machineId: FOREIGN }), ['journal.json']);
    report = await unlock(identity, liveness, { forceHolder: `141@${FOREIGN}` });
    assert.equal(report.exitCode, 1);
    assert.deepEqual(fs.readdirSync(lockPath).sort(), ['journal.json', 'owner.json']);
    fs.rmSync(lockPath, { recursive: true });

    plantDirectory(lockPath, undefined, ['journal.json']);
    report = await unlock(identity, liveness);
    assert.equal(report.exitCode, 1);
    assert.match(report.items[1].reason, /no owner record/);
    assert.deepEqual(fs.readdirSync(lockPath), ['journal.json']);
    fs.rmSync(lockPath, { recursive: true });

    plantDirectory(lockPath, '{"schema":"ploinky-lock","version":1,"pid":140}');
    report = await unlock(identity, liveness, { forceHolder: `140@${MACHINE}` });
    assert.equal(report.exitCode, 1);
    assert.match(report.items[1].reason, /cannot be attributed/);
    assert.deepEqual(fs.readdirSync(lockPath), ['owner.json']);
});

test('a crashed reclaim guard is removed only when its owner is stale or named, then the lock is handled', async (t) => {
    const { workspace, identity } = fixture(t);
    const guardPath = guardPathOf(workspace);
    plantDirectory(lockPathOf(workspace), owner({ pid: 150 }));

    // A live reclaimer: both stay, and the lock is not touched behind its back.
    plantDirectory(guardPath, owner({ pid: 151 }));
    let report = await unlock(identity, fakeLiveness({ dead: [150] }));
    assert.deepEqual(states(report), ['reclaim-guard:kept', 'workspace-lock:kept', 'store-lock:absent']);
    assert.match(report.items[1].reason, /reclaim guard is still in place/);
    assert.equal(fs.existsSync(path.join(lockPathOf(workspace), 'owner.json')), true);
    fs.rmSync(guardPath, { recursive: true });

    // An unclassified reclaimer needs its own exact name.
    plantDirectory(guardPath, owner({ pid: 152, machineId: FOREIGN }));
    report = await unlock(identity, fakeLiveness({ dead: [150], undetermined: [152] }));
    assert.equal(report.items[0].state, 'kept');
    assert.match(formatUnlockReport(report), new RegExp(`ploinky unlock --force-holder 152@${FOREIGN}`));
    report = await unlock(identity, fakeLiveness({ dead: [150], undetermined: [152] }), { forceHolder: `152@${FOREIGN}` });
    assert.deepEqual(states(report), ['reclaim-guard:removed', 'workspace-lock:removed', 'store-lock:absent']);
    assert.equal(report.exitCode, 0);
    assert.equal(fs.existsSync(guardPath), false);
    assert.equal(fs.existsSync(lockPathOf(workspace)), false);

    // A dead reclaimer's guard goes; leftovers or a missing record keep it.
    plantDirectory(lockPathOf(workspace), owner({ pid: 150 }));
    plantDirectory(guardPath, owner({ pid: 153 }));
    report = await unlock(identity, fakeLiveness({ dead: [150, 153] }));
    assert.deepEqual(states(report), ['reclaim-guard:removed', 'workspace-lock:removed', 'store-lock:absent']);
    assert.deepEqual(fs.readdirSync(path.dirname(guardPath)), []);

    plantDirectory(guardPath, owner({ pid: 153 }), ['stray']);
    report = await unlock(identity, fakeLiveness({ dead: [153] }));
    assert.equal(report.items[0].state, 'kept');
    assert.match(report.items[0].reason, /holds more than its owner record/);
    assert.deepEqual(fs.readdirSync(guardPath).sort(), ['owner.json', 'stray']);
    fs.rmSync(guardPath, { recursive: true });

    plantDirectory(guardPath);
    report = await unlock(identity, fakeLiveness({ dead: [153] }));
    assert.equal(report.exitCode, 1);
    assert.match(report.items[0].reason, /no owner record/);
    assert.equal(fs.existsSync(guardPath), true);
});

test('the hardware store lock is recovered only under the workspace lock with the Box stopped or absent', async (t) => {
    const { workspace, identity } = fixture(t);
    const storeLock = plantStoreLock(identity, storeOwner());
    const store = path.dirname(storeLock);

    // Its holder is proven dead, but the Box runs: kept.
    let report = await unlock(identity, fakeLiveness(), { box: 'running' });
    assert.equal(report.items[2].state, 'kept');
    assert.match(report.items[2].reason, /not proven stopped or absent/);
    assert.equal(fs.existsSync(storeLock), true);

    // The workspace lock is held by a running command: the store is not touched.
    plantDirectory(lockPathOf(workspace), owner({ pid: 160 }));
    report = await unlock(identity, fakeLiveness());
    assert.equal(report.items[2].state, 'kept');
    assert.match(report.items[2].reason, /workspace lock is still in place/);
    assert.equal(fs.existsSync(storeLock), true);
    fs.rmSync(lockPathOf(workspace), { recursive: true });

    report = await unlock(identity, fakeLiveness());
    assert.deepEqual(states(report), ['reclaim-guard:absent', 'workspace-lock:absent', 'store-lock:removed']);
    assert.equal(report.exitCode, 0);
    assert.equal(fs.existsSync(storeLock), false);
    const moved = fs.readdirSync(store);
    assert.equal(moved.length, 1);
    assert.match(moved[0], /^write\.lock\.stale-/);
    assert.equal(fs.existsSync(lockPathOf(workspace)), false, 'the workspace lock it took is released');
});

test('a store lock whose holder cannot be proven dead needs its exact PID@HOST; malformed ones stay', async (t) => {
    const { identity } = fixture(t);
    const foreign = storeOwner({ hostname: 'other-host', pid: 77 });
    const storeLock = plantStoreLock(identity, foreign);

    let report = await unlock(identity, fakeLiveness());
    assert.equal(report.exitCode, 1);
    assert.match(report.items[2].reason, /not this host/);
    assert.match(formatUnlockReport(report), /ploinky unlock --force-holder 77@other-host/);
    report = await unlock(identity, fakeLiveness(), { forceHolder: '78@other-host' });
    assert.equal(report.items[2].state, 'kept');
    assert.equal(fs.existsSync(storeLock), true);
    // Named exactly, but the Box is paused: still kept.
    report = await unlock(identity, fakeLiveness(), { forceHolder: '77@other-host', box: 'paused' });
    assert.equal(report.items[2].state, 'kept');
    report = await unlock(identity, fakeLiveness(), { forceHolder: '77@other-host' });
    assert.equal(report.items[2].state, 'removed');
    assert.equal(fs.existsSync(storeLock), false);

    for (const malformed of ['', '{"token":"short"}']) {
        plantStoreLock(identity, malformed);
        report = await unlock(identity, fakeLiveness(), { forceHolder: '77@other-host' });
        assert.equal(report.exitCode, 1);
        assert.equal(report.items[2].state, 'kept');
        assert.match(formatUnlockReport(report), /remove it by hand: rm -- '/);
        assert.equal(fs.readFileSync(storeLock, 'utf8'), malformed, 'the malformed lock is left exactly as found');
        fs.rmSync(storeLock);
    }
});

test('unlock parses one optional --force-holder PID@MACHINE and refuses everything else', () => {
    const route = (argv) => routeOuterCommand(parseOuterArguments(argv));
    assert.deepEqual({ ...route(['unlock']) }, { kind: 'unlock', forceHolder: null });
    assert.deepEqual({ ...route(['unlock', '--force-holder', `123@${FOREIGN}`]) }, { kind: 'unlock', forceHolder: `123@${FOREIGN}` });
    assert.equal(route(['--debug', 'unlock', '--force-holder', '9@host.local']).forceHolder, '9@host.local');
    for (const argv of [
        ['unlock', 'now'],
        ['unlock', '--force-holder'],
        ['unlock', '--force-holder', 'abc@host'],
        ['unlock', '--force-holder', '0@host'],
        ['unlock', '--force-holder', '12'],
        ['unlock', '--force-holder', '12@a@b'],
        ['unlock', '--force-holder', '12@a b'],
        ['unlock', '--force-holder', '12@host', '--force-holder', '12@host'],
        ['unlock', '--force-holder=12@host'],
        ['--dry-run', 'unlock'],
        ['--allow-host-process', '5', 'unlock'],
        ['--port', '18080', 'unlock'],
        ['--udp-port', '17882', 'unlock'],
    ]) {
        assert.throws(() => route(argv), { code: 'PLOINKY_BOX_ARGUMENT_INVALID' }, argv.join(' '));
    }
});

test('unlock inside a Box is refused without forwarding into the core', async () => {
    for (const argv of [['unlock'], ['unlock', '--force-holder', '1@x'], ['--', 'unlock']]) {
        let written = '';
        const code = await runOuterCli(argv, {
            errorOutput: { write: (chunk) => { written += chunk; } },
            detectInsideBox: () => true,
            cwd() { throw new Error('No workspace lookup is needed inside the Box'); },
            execute() { throw new Error('Do not forward unlock into the core'); },
        });
        assert.equal(code, 1, argv.join(' '));
        assert.match(written, /ploinky unlock must run on the physical host, outside the Box/);
    }
});

test('the host CLI prints the unlock report and exits with its code', async () => {
    for (const exitCode of [0, 1]) {
        let printed = '';
        const calls = [];
        const code = await runOuterCli(['unlock', '--force-holder', '5@m'], {
            env: {},
            output: { write: (chunk) => { printed += chunk; } },
            errorOutput: { write() {} },
            detectInsideBox: () => false,
            cwd: () => '/tmp',
            supervisor: {
                async runUnlock(options) {
                    calls.push(options);
                    return {
                        exitCode,
                        items: [{ kind: 'workspace-lock', path: '/w/.ploinky-box/locks/workspace.lock', state: exitCode ? 'kept' : 'removed', reason: 'r' }],
                    };
                },
            },
        });
        assert.equal(code, exitCode);
        assert.deepEqual(calls, [{ forceHolder: '5@m' }]);
        assert.match(printed, exitCode ? /Workspace lock .*: kept: r\./ : /Workspace lock .*: removed \(r\)\./);
    }
});

// D4 busy hint: whatever the busy error tells the operator to run is what
// `ploinky unlock` then does for that holder.
test('every busy hint names the unlock command that actually resolves (or refuses) that holder', async (t) => {
    const { workspace, identity } = fixture(t);
    const busy = (liveness) => createMutationLockManager({ liveness, retryMs: 1, timeoutMs: 20 })
        .acquire(identity.instance, { workspaceRoot: workspace }).then(() => assert.fail('acquired'), (error) => error);

    // Live holder: unlock never removes it.
    plantDirectory(lockPathOf(workspace), owner({ pid: 170 }));
    let error = await busy(fakeLiveness());
    assert.equal(error.lockBusy, true);
    assert.match(error.message, /`ploinky unlock` never removes a lock whose holder is running/);
    assert.equal((await unlock(identity, fakeLiveness())).items[1].state, 'kept');
    fs.rmSync(lockPathOf(workspace), { recursive: true });

    // Unclassified holder: the printed force command removes it.
    plantDirectory(lockPathOf(workspace), owner({ pid: 171, machineId: FOREIGN }));
    error = await busy(fakeLiveness({ undetermined: [171] }));
    const hinted = /`ploinky unlock --force-holder ([^`]+)`/.exec(error.message)?.[1];
    assert.equal(hinted, `171@${FOREIGN}`);
    assert.equal((await unlock(identity, fakeLiveness({ undetermined: [171] }), { forceHolder: hinted })).items[1].state, 'removed');

    // A dead holder behind a crashed reclaim guard: plain unlock clears both.
    plantDirectory(lockPathOf(workspace), owner({ pid: 172 }));
    plantDirectory(guardPathOf(workspace), owner({ pid: 173 }));
    error = await busy(fakeLiveness({ dead: [172, 173] }));
    assert.match(error.message, /Its holder is gone; if the command stays busy, run `ploinky unlock` in the workspace/);
    const report = await unlock(identity, fakeLiveness({ dead: [172, 173] }));
    assert.deepEqual(states(report), ['reclaim-guard:removed', 'workspace-lock:removed', 'store-lock:absent']);

    // An ownerless lock: unlock lists it and keeps it.
    plantDirectory(lockPathOf(workspace), undefined, ['journal.json']);
    error = await busy(fakeLiveness());
    assert.match(error.message, /`ploinky unlock` in the workspace shows what it holds and how to remove it by hand/);
    const listed = await unlock(identity, fakeLiveness());
    assert.equal(listed.items[1].state, 'kept');
    assert.deepEqual(listed.items[1].contents, ['journal.json']);
});

// The Box writes the store lock record, and entry names in a lock directory
// are arbitrary bytes: nothing of them may drive the operator's terminal.
test('Box-written lock fields reach the unlock report without control characters', async (t) => {
    const { workspace, identity } = fixture(t);
    const controls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
    const lineCount = (report) => 1 + report.items.length
        + report.items.reduce((count, entry) => count + (entry.contents?.length ? 1 : 0) + (entry.steps?.length || 0), 0);

    // The store lock record, through the store's own refusal text.
    const evil = 'h\u001b]52;c;Y3VybCBldmlsfHNo\u0007\u001b[2K\rFORGED LINE';
    const storeLock = plantStoreLock(identity, storeOwner({ pid: '7\u001b[31m', hostname: evil, operation: 'op\u001b[8m\u009b' }));
    let report = await unlock(identity, fakeLiveness(), { box: 'running' });
    assert.equal(report.items[2].state, 'kept');
    let text = formatUnlockReport(report);
    assert.doesNotMatch(text, controls, JSON.stringify(text));
    assert.equal(text.split('\n').filter(Boolean).length, lineCount(report), 'nothing embedded in a field adds a line');
    assert.match(text, /h\?\]52;c;Y3VybCBldmlsfHNo\?\?\[2K\?FORGED LINE/, 'the text itself is kept, only made inert');
    fs.rmSync(storeLock);

    // Entry names inside a lock directory.
    plantDirectory(lockPathOf(workspace), owner({ pid: 180 }), ['x\u001b[2K\rforged-entry']);
    report = await unlock(identity, fakeLiveness({ dead: [180] }));
    text = formatUnlockReport(report);
    assert.doesNotMatch(text, controls, JSON.stringify(text));
    assert.equal(text.split('\n').filter(Boolean).length, lineCount(report));
    assert.match(text, /It holds: owner\.json, x\?\[2K\?forged-entry/);
});

// The guard is removed only if it is still the directory and the record that
// were judged: a record swapped in after the judgement keeps it.
test('a reclaim guard whose owner record changes after it was judged is kept', async (t) => {
    const { workspace, identity } = fixture(t);
    const guardOwner = path.join(guardPathOf(workspace), 'owner.json');
    plantDirectory(guardPathOf(workspace), owner({ pid: 190 }));
    const swapped = `${JSON.stringify(owner({ pid: 190, startedAt: new Date(1).toISOString() }))}\n`;
    let reads = 0;
    const fsApi = {
        ...fs,
        readFileSync(target, ...rest) {
            const value = fs.readFileSync(target, ...rest);
            if (target === guardOwner && ++reads === 1) fs.writeFileSync(guardOwner, swapped);
            return value;
        },
    };
    const report = await unlockWorkspace({
        identity,
        lockManager: createMutationLockManager({ liveness: fakeLiveness({ dead: [190] }), retryMs: 1, timeoutMs: 200 }),
        observeBoxState: () => ({ state: 'absent' }),
        fsApi,
    });
    assert.equal(reads >= 2, true, 'the record was read again before removal');
    assert.equal(report.items[0].state, 'kept');
    assert.match(report.items[0].reason, /changed while it was inspected/);
    assert.equal(fs.readFileSync(guardOwner, 'utf8'), swapped);
});

test('unlock --help shows the help, and a force value with control characters is refused', async () => {
    const route = (argv) => routeOuterCommand(parseOuterArguments(argv));
    for (const argv of [['unlock', '--help'], ['unlock', '-h'], ['unlock', '--force-holder', '1@x', '--help']]) {
        assert.equal(route(argv).kind, 'help', argv.join(' '));
    }
    let printed = '';
    const code = await runOuterCli(['unlock', '--help'], {
        env: {}, output: { write: (chunk) => { printed += chunk; } }, errorOutput: { write() {} },
        detectInsideBox: () => false, cwd: () => '/tmp',
        supervisor: { runUnlock() { throw new Error('help must not unlock'); } },
    });
    assert.equal(code, 0);
    assert.match(printed, /ploinky unlock \[--force-holder PID@MACHINE\]/);
    assert.throws(() => route(['unlock', '--force-holder', '12@h\u001bx']), { code: 'PLOINKY_BOX_ARGUMENT_INVALID' });
    assert.throws(() => route(['unlock', '--force-holder', '12@h\u0085x']), { code: 'PLOINKY_BOX_ARGUMENT_INVALID' });
});

// `ploinky limits clear` and lifecycle commands print the store's own refusal
// text: the holder fields in it are sanitized where that text is built.
test('the store lock refusal text carries no control characters from the Box-written record', async (t) => {
    const { identity } = fixture(t);
    const storeLock = plantStoreLock(identity, storeOwner({ pid: 77, hostname: 'h\u001b]52;c;eA==\u0007\r\u009bX', operation: 'op\u001b[8m' }));
    for (const box of ['running', 'absent']) {
        let error = null;
        try {
            recoverStaleStoreLock({
                storeRoot: path.dirname(storeLock), hostLock: { assertHeld() {} }, instance: identity.instance,
                inspectBox: () => ({ state: box }),
            });
        } catch (caught) { error = caught; }
        assert.equal(error?.code, 'store_busy', box);
        assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f-\u009f]/, JSON.stringify(error.message));
        assert.match(error.message, /op\?\[8m \(pid 77 on host h\?\]52;c;eA==\?\?\?X\)/);
    }
});
