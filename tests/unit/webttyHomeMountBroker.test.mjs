import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    createHomeMountBroker,
    validateHomeHelperOwnership,
    validateHomeMountReceipt,
} from '../../cli/server/webtty/homeMountBroker.mjs';

const HELPER = fileURLToPath(new URL('../../cli/server/webtty/homeMountHelper.py', import.meta.url));
const PODMAN = '/usr/bin/podman';
const PYTHON = '/usr/bin/python3';
const UID = 1000;
const ident = (ino) => ({ dev: '1', ino: String(ino) });
const proof = { root: ident(10), mountNamespace: ident(11), userNamespace: ident(12), mountOwner: ident(13) };
const target = { runtime: 'podman', containerId: 'a'.repeat(64), translatedCwd: '/workspace' };
const sessionId = 'x'.repeat(32);
const NONCE = 'N'.repeat(32);
const settle = () => new Promise((resolve) => setImmediate(resolve));

// A fake /proc: the target init plus every helper tree the fake spawn creates.
function processTable() {
    const procs = new Map();
    const table = {
        procs,
        signals: [],
        onSignal: null,
        add(entry) { procs.set(entry.pid, { state: 'S', uid: UID, ...entry }); },
        readIdentity: async (pid) => (procs.has(pid) ? { ...procs.get(pid), cmdline: [...procs.get(pid).cmdline] } : null),
        listSessionMembers: async (sid) => [...procs.values()]
            .filter((entry) => entry.session === sid && entry.state !== 'Z')
            .map(({ pid, state, pgrp, session, startToken }) => ({ pid, state, pgrp, session, startToken })),
        scanNonce: async (nonce) => [...procs.values()].filter((entry) => entry.cmdline.includes(nonce))
            .map((entry) => ({ ...entry, cmdline: [...entry.cmdline] })),
        signal(pid, name) {
            assert.ok(Number.isSafeInteger(pid) && pid > 1, 'only positive exact PIDs are signalled');
            table.signals.push([pid, name]);
            table.onSignal?.(pid, name);
        },
    };
    table.add({ pid: 123, pgrp: 1, session: 1, startToken: 'linux-proc:456', cmdline: ['/sbin/init'] });
    return table;
}

function helperTree(table, pid, nonce, encoded, { uid = UID } = {}) {
    const podmanArgv = [PODMAN, 'unshare', PYTHON, '-I', '-S', HELPER, nonce, encoded];
    table.add({ pid, pgrp: pid, session: pid, startToken: `linux-proc:${pid}0`, cmdline: podmanArgv, uid });
    table.add({ pid: pid + 1, pgrp: pid, session: pid, startToken: `linux-proc:${pid + 1}0`, cmdline: podmanArgv, uid });
    table.add({ pid: pid + 2, pgrp: pid, session: pid, startToken: `linux-proc:${pid + 2}0`,
        cmdline: [PYTHON, '-I', '-S', HELPER, nonce, encoded], uid });
    return [pid, pid + 1, pid + 2];
}

function fixture(t, {
    mode = 'normal', releaseFailure = false, badDirectory = false, closeStatus = 0,
    extraMember = null, leaderOverride = null, spawnThrows = false, noPid = false, lingerAfterExit = false,
    onHelper = null,
} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-broker-unit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stat = fs.statSync(root, { bigint: true });
    const home = { absolutePath: root, identity: { dev: String(stat.dev), ino: String(stat.ino) } };
    const table = processTable();
    const actions = [];
    const log = [];
    const states = [];
    const spawns = [];
    let nextPid = 500;
    let childClosed = false;
    const spawnImpl = (binary, args, options) => {
        log.push('spawn');
        spawns.push({ binary, args, options });
        if (spawnThrows) throw new Error('spawn failed');
        const config = JSON.parse(Buffer.from(args.at(-1), 'base64url'));
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        const send = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
        let tree = [];
        let exited = false;
        const exit = (code, signal) => {
            if (exited) return;
            exited = true;
            if (!lingerAfterExit) for (const pid of tree) table.procs.delete(pid);
            process.nextTick(() => { childClosed = true; child.emit('close', code, signal); });
        };
        child.stdin = new Writable({
            final(done) { if (mode === 'normal') exit(1, null); done(); },
            write(chunk, encoding, done) {
                const { action } = JSON.parse(chunk.toString());
                actions.push(action);
                log.push(`send:${action}`);
                if (action === 'create') send({ phase: 'directory', identity: badDirectory ? { ...ident(20), path: '/run/other' } : ident(20) });
                if (action === 'clone') send({ phase: 'prepared', mountId: '30' });
                if (action === 'attach') send({ phase: 'attached' });
                if (action === 'finish') { send({ phase: 'closed' }); exit(closeStatus, null); }
                if (action === 'proceed') { send({ phase: releaseFailure ? 'error' : 'closed' }); exit(releaseFailure ? 1 : 0, null); }
                if (action === 'abort' && mode === 'normal') exit(1, null);
                done();
            },
        });
        if (noPid) {
            process.nextTick(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
            return child;
        }
        child.pid = nextPid;
        nextPid += 10;
        tree = helperTree(table, child.pid, args[5], args[6]);
        if (extraMember) {
            table.add({ pid: child.pid + 3, pgrp: child.pid, session: child.pid, startToken: `linux-proc:${child.pid + 3}0`,
                ...extraMember(args[5], args[6]) });
            tree.push(child.pid + 3);
        }
        if (leaderOverride) Object.assign(table.procs.get(child.pid), leaderOverride);
        table.onSignal = (pid, name) => {
            if (!tree.includes(pid) || mode === 'ignoreKill') return;
            // A lingering member exits on its own signal; the child has already closed.
            if (lingerAfterExit) { table.procs.delete(pid); return; }
            if (mode === 'normal' || name === 'SIGKILL') exit(null, name);
        };
        process.nextTick(() => {
            if (mode !== 'normal') return;
            send({ phase: 'identity', target: proof });
        });
        void config;
        return child;
    };
    const recordState = onHelper || (async (state) => true);
    const helperCallback = async (state) => {
        states.push(state);
        log.push(state ? (state.pid ? 'record:pid' : 'record:nonce') : 'record:null');
        return recordState(state);
    };
    const scanNonce = async (nonce) => { log.push('scan'); return table.scanNonce(nonce); };
    const broker = createHomeMountBroker({
        spawnImpl,
        inspectTarget: async () => ({ id: target.containerId, running: true, initPid: 123 }),
        readIdentity: table.readIdentity,
        listSessionMembers: table.listSessionMembers,
        scanNonce,
        signal: table.signal,
        uid: UID,
        graceMs: 1,
        delay: settle,
        timeoutMs: mode === 'normal' ? 10_000 : 20,
    });
    return {
        broker, home, actions, log, states, spawns, table, onHelper: helperCallback,
        childClosed: () => childClosed,
        getOptions: () => spawns.at(-1)?.options,
        getConfig: () => JSON.parse(Buffer.from(spawns.at(-1).args.at(-1), 'base64url')),
    };
}

function prepareArgs(f, overrides = {}) {
    return {
        target, home: f.home, sessionId, onHelper: f.onHelper,
        onIntent: async () => true, onDirectory: async () => true,
        onPrepared: async () => true, onAttached: async () => true,
        ...overrides,
    };
}

function attachedReceipt(source = ident(15)) {
    return { version: 1, stage: 'attached', target: { containerId: target.containerId, initPid: 123, initStart: 'linux-proc:456', ...proof }, source, destination: { path: `/run/ploinky-webtty-home-${sessionId}`, ...ident(20) }, mountId: '30' };
}

test('broker durably journals each stage before allowing the next mutation', async (t) => {
    const f = fixture(t);
    const { broker, actions, getOptions } = f;
    const journal = [];
    let allowPrepared;
    const pending = new Promise((resolve) => { allowPrepared = resolve; });
    let preparedSeen;
    const seen = new Promise((resolve) => { preparedSeen = resolve; });
    const result = broker.prepare(prepareArgs(f, {
        onIntent: async (receipt) => { journal.push(receipt); assert.deepEqual(actions, []); return true; },
        onDirectory: async (receipt) => { journal.push(receipt); assert.deepEqual(actions, ['create']); return true; },
        onPrepared: async (receipt) => { journal.push(receipt); preparedSeen(); await pending; return true; },
        onAttached: async (receipt) => { journal.push(receipt); assert.deepEqual(actions, ['create', 'clone', 'attach']); return true; },
    }));
    await seen;
    assert.deepEqual(actions, ['create', 'clone']);
    allowPrepared();
    const value = await result;
    assert.deepEqual(journal.map((entry) => entry.stage), ['intent', 'directory', 'prepared', 'attached']);
    assert.equal(value.receipt.stage, 'attached');
    assert.equal(value.home, `/run/ploinky-webtty-home-${sessionId}`);
    assert.deepEqual(actions, ['create', 'clone', 'attach', 'finish']);
    assert.deepEqual(Object.keys(getOptions().env).sort(), ['HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'USER']);
    assert.equal(JSON.stringify(getOptions().env).includes('ROUTER'), false);
    // Exact argv with a fresh nonce in its own element, as a new session.
    const [{ binary, args }] = f.spawns;
    assert.equal(binary, PODMAN);
    assert.equal(getOptions().detached, true);
    assert.deepEqual(args.slice(0, 5), ['unshare', PYTHON, '-I', '-S', HELPER]);
    assert.equal(args.length, 7);
    assert.match(args[5], /^[A-Za-z0-9_-]{32}$/);
    // Ownership: nonce before spawn, verified leader before any command, cleared after proven exit.
    assert.deepEqual(f.states, [
        { nonce: args[5], operation: 'prepare' },
        { nonce: args[5], operation: 'prepare', pid: 500, startToken: 'linux-proc:5000', uid: UID },
        null,
    ]);
    assert.deepEqual(f.log.slice(0, 4), ['record:nonce', 'spawn', 'record:pid', 'send:create']);
    assert.equal(f.log.at(-1), 'record:null');
    assert.deepEqual(f.table.signals, []);
});

test('T1: a helper that never emits identity is TERM/KILLed by verified PID and its exit is proven', async (t) => {
    const f = fixture(t, { mode: 'stall' });
    await assert.rejects(f.broker.prepare(prepareArgs(f)), (error) => {
        assert.equal(error.code, 'WEBTTY_HOME_PROJECTION_UNPROVEN');
        assert.equal(error.reason, undefined);
        assert.equal(error.message, 'helper response timed out');
        return true;
    });
    assert.deepEqual(f.actions, []);
    const killCalls = f.table.signals.length;
    assert.ok(killCalls >= 1, `killCalls=${killCalls}`);
    assert.equal(f.childClosed(), true);
    assert.deepEqual(f.table.signals.slice(0, 3).map(([, name]) => name), ['SIGTERM', 'SIGTERM', 'SIGTERM']);
    assert.ok(f.table.signals.some(([, name]) => name === 'SIGKILL'));
    assert.ok(f.table.signals.every(([pid]) => [500, 501, 502].includes(pid)));
    assert.deepEqual(await f.table.listSessionMembers(500), []);
    assert.equal(f.states.filter((state) => state === null).length, 1);
    assert.equal(f.states.at(-1), null);
});

test('T2: a helper that survives SIGKILL is helper_exit_unproven and ownership is retained', async (t) => {
    const f = fixture(t, { mode: 'ignoreKill' });
    await assert.rejects(f.broker.prepare(prepareArgs(f)), (error) => {
        assert.equal(error.code, 'WEBTTY_HOME_PROJECTION_UNPROVEN');
        assert.equal(error.reason, 'helper_exit_unproven');
        assert.equal(error.cause.message, 'helper response timed out');
        return true;
    });
    assert.ok(f.table.signals.some(([, name]) => name === 'SIGKILL'));
    assert.equal(f.states.includes(null), false);
    assert.equal(f.states.at(-1).pid, 500);
});

test('T3: an unverifiable session member blocks every signal and the exit stays unproven', async (t) => {
    for (const [name, extraMember] of [
        ['mismatched uid', (nonce, encoded) => ({ uid: 0, cmdline: [PYTHON, '-I', '-S', HELPER, nonce, encoded] })],
        ['missing nonce', () => ({ cmdline: ['/usr/bin/newuidmap', '500'] })],
        ['nonce at another position', (nonce, encoded) => ({ cmdline: [PYTHON, '-S', HELPER, nonce, encoded] })],
    ]) {
        const f = fixture(t, { mode: 'stall', extraMember });
        await assert.rejects(f.broker.prepare(prepareArgs(f)), { code: 'WEBTTY_HOME_PROJECTION_UNPROVEN', reason: 'helper_exit_unproven' }, name);
        assert.deepEqual(f.table.signals, [], name);
        assert.equal(f.states.includes(null), false, name);
    }
});

test('T4: no helper is spawned unless pre-spawn ownership is durably recorded', async (t) => {
    for (const [name, onHelper] of [
        ['refused', async () => false],
        ['failed', async () => { throw new Error('disk full'); }],
    ]) {
        const f = fixture(t, { onHelper });
        await assert.rejects(f.broker.prepare(prepareArgs(f)), { code: 'WEBTTY_HOME_PROJECTION_UNPROVEN' }, name);
        assert.deepEqual(f.spawns, [], name);
        assert.deepEqual(f.states.map((state) => Object.keys(state).sort()), [['nonce', 'operation']], name);
    }
    const missing = fixture(t);
    await assert.rejects(missing.broker.prepare(prepareArgs(missing, { onHelper: undefined })), { code: 'WEBTTY_HOME_PROJECTION_UNPROVEN' });
    await assert.rejects(missing.broker.release({ target, receipt: attachedReceipt() }), { code: 'WEBTTY_HOME_PROJECTION_UNPROVEN' });
    assert.deepEqual(missing.spawns, []);
});

test('T5: a post-spawn identity mismatch stops the helper before any command', async (t) => {
    const f = fixture(t, { leaderOverride: { session: 1 } });
    await assert.rejects(f.broker.prepare(prepareArgs(f)), (error) => {
        assert.equal(error.message, 'home projection helper identity unproven');
        assert.equal(error.reason, undefined);
        return true;
    });
    assert.deepEqual(f.actions, []);
    assert.deepEqual(f.table.signals, []);
    // The unverified leader is never recorded; the exit is proven by a nonce scan.
    assert.deepEqual(f.log, ['record:nonce', 'spawn', 'scan', 'record:null']);

    const stuck = fixture(t, { mode: 'stall', leaderOverride: { session: 1 } });
    await assert.rejects(stuck.broker.prepare(prepareArgs(stuck)), { code: 'WEBTTY_HOME_PROJECTION_UNPROVEN', reason: 'helper_exit_unproven' });
    assert.deepEqual(stuck.actions, []);
    assert.deepEqual(stuck.table.signals, []);
    assert.equal(stuck.states.includes(null), false);
});

test('T6: validate and release send no mutating command before the verified leader is recorded', async (t) => {
    for (const action of ['validate', 'release']) {
        const f = fixture(t);
        const receipt = attachedReceipt(f.home.identity);
        assert.equal(await f.broker[action]({ target, home: f.home, receipt, onHelper: f.onHelper }), true, action);
        assert.deepEqual(f.log, ['record:nonce', 'spawn', 'record:pid', 'send:proceed', 'record:null'], action);
        assert.deepEqual(f.states[1], { nonce: f.spawns[0].args[5], operation: action, pid: 500, startToken: 'linux-proc:5000', uid: UID }, action);
        assert.deepEqual(Object.keys(f.getConfig()).sort(), ['operation', 'receipt'], action);
    }
    const refused = fixture(t, { onHelper: async (state) => !state?.pid });
    await assert.rejects(refused.broker.release({ target, receipt: attachedReceipt(), onHelper: refused.onHelper }), { code: 'WEBTTY_HOME_PROJECTION_UNPROVEN' });
    assert.equal(refused.log.includes('send:proceed'), false);
    assert.deepEqual(refused.table.signals, []);
    assert.equal(refused.log.at(-1), 'record:null');
});

test('T7: nonce-only reclamation signals exact matches, accepts absence and fails closed on scan errors', async (t) => {
    const f = fixture(t);
    const encoded = Buffer.from('{"operation":"prepare"}').toString('base64url');
    const tree = helperTree(f.table, 700, NONCE, encoded);
    f.table.onSignal = (pid) => { for (const member of tree) f.table.procs.delete(member); assert.ok(tree.includes(pid)); };
    assert.equal(await f.broker.reclaimHelper({ ownership: { nonce: NONCE, operation: 'prepare' }, uid: UID }), true);
    assert.deepEqual(f.table.signals.map(([, name]) => name), ['SIGTERM']);
    assert.equal(await f.broker.reclaimHelper({ ownership: { nonce: NONCE, operation: 'prepare' }, uid: UID }), true);
    assert.equal(f.table.signals.length, 1);

    const failing = createHomeMountBroker({
        scanNonce: async () => { throw Object.assign(new Error('proc-scan-timeout'), { code: 'WEBTTY_PROCESS_IDENTITY_UNPROVEN' }); },
        signal: () => assert.fail('nothing may be signalled'), uid: UID, graceMs: 1, delay: settle,
    });
    await assert.rejects(failing.reclaimHelper({ ownership: { nonce: NONCE, operation: 'validate' }, uid: UID }), { code: 'WEBTTY_HOME_PROJECTION_UNPROVEN', reason: 'helper_exit_unproven' });

    // Native-observed case: SIGTERM killed the podman leader and re-exec child,
    // the stopped python survives alone in its (still reserved) session. It is
    // a verified member and must be TERM- then KILL-reclaimed.
    const orphan = fixture(t);
    orphan.table.add({ pid: 802, pgrp: 800, session: 800, startToken: 'linux-proc:8020', cmdline: [PYTHON, '-I', '-S', HELPER, NONCE, encoded] });
    orphan.table.onSignal = (pid, name) => { if (name === 'SIGKILL') orphan.table.procs.delete(pid); };
    assert.equal(await orphan.broker.reclaimHelper({ ownership: { nonce: NONCE, operation: 'prepare' }, uid: UID }), true);
    assert.deepEqual(orphan.table.signals.map(([pid, name]) => `${name}:${pid}`), ['SIGTERM:802', 'SIGKILL:802']);

    // A leaderless session that also holds an unverified process is never signalled.
    const mixed = fixture(t);
    mixed.table.add({ pid: 812, pgrp: 810, session: 810, startToken: 'linux-proc:8120', cmdline: [PYTHON, '-I', '-S', HELPER, NONCE, encoded] });
    mixed.table.add({ pid: 813, pgrp: 810, session: 810, startToken: 'linux-proc:8130', cmdline: ['/bin/sh'] });
    await assert.rejects(mixed.broker.reclaimHelper({ ownership: { nonce: NONCE, operation: 'prepare' }, uid: UID }), { reason: 'helper_exit_unproven' });
    assert.deepEqual(mixed.table.signals, []);

    // A nonce match owned by another uid, or a session leader without the podman shape, blocks everything.
    const foreign = fixture(t);
    foreign.table.add({ pid: 822, pgrp: 820, session: 820, uid: UID + 1, startToken: 'linux-proc:8220', cmdline: [PYTHON, '-I', '-S', HELPER, NONCE, encoded] });
    await assert.rejects(foreign.broker.reclaimHelper({ ownership: { nonce: NONCE, operation: 'prepare' }, uid: UID }), { reason: 'helper_exit_unproven' });
    assert.deepEqual(foreign.table.signals, []);
    const fakeLeader = fixture(t);
    fakeLeader.table.add({ pid: 830, pgrp: 830, session: 830, startToken: 'linux-proc:8300', cmdline: [PYTHON, '-I', '-S', HELPER, NONCE, encoded] });
    await assert.rejects(fakeLeader.broker.reclaimHelper({ ownership: { nonce: NONCE, operation: 'prepare' }, uid: UID }), { reason: 'helper_exit_unproven' });
    assert.deepEqual(fakeLeader.table.signals, []);

    // A recorded leader with its session still alive is reclaimed by exact PID.
    const recorded = fixture(t);
    const owned = helperTree(recorded.table, 900, NONCE, encoded);
    recorded.table.onSignal = (pid, name) => { if (name === 'SIGKILL') recorded.table.procs.delete(pid); };
    assert.equal(await recorded.broker.reclaimHelper({ ownership: { nonce: NONCE, operation: 'release', pid: 900, startToken: 'linux-proc:9000', uid: UID }, uid: UID }), true);
    assert.deepEqual(recorded.table.signals.map(([pid, name]) => `${name}:${pid}`), [
        ...owned.map((pid) => `SIGTERM:${pid}`), ...owned.map((pid) => `SIGKILL:${pid}`),
    ]);
    await assert.rejects(recorded.broker.reclaimHelper({ ownership: { nonce: NONCE, operation: 'release', pid: 900, startToken: 'linux-proc:9000', uid: UID }, uid: UID + 1 }), { reason: 'helper_exit_unproven' });
});

test('T8: a recycled leader PID is never signalled and its old session is proven empty', async (t) => {
    const f = fixture(t);
    const ownership = { nonce: NONCE, operation: 'prepare', pid: 700, startToken: 'linux-proc:7000', uid: UID };
    f.table.add({ pid: 700, pgrp: 650, session: 650, startToken: 'linux-proc:9999', cmdline: ['/usr/bin/sleep', '60'] });
    assert.equal(await f.broker.reclaimHelper({ ownership, uid: UID }), true);
    // A recycled PID that leads an unrelated session of its own is ignored too.
    f.table.procs.get(700).session = 700;
    f.table.procs.get(700).pgrp = 700;
    f.table.add({ pid: 701, pgrp: 700, session: 700, startToken: 'linux-proc:7010', cmdline: ['/bin/sh'] });
    assert.equal(await f.broker.reclaimHelper({ ownership, uid: UID }), true);
    assert.deepEqual(f.table.signals, []);
    // A nonce-bearing process in a recycled leader's session is contradictory evidence.
    f.table.add({ pid: 702, pgrp: 700, session: 700, startToken: 'linux-proc:7020', cmdline: [PYTHON, '-I', '-S', HELPER, NONCE, 'e30'] });
    await assert.rejects(f.broker.reclaimHelper({ ownership, uid: UID }), { reason: 'helper_exit_unproven' });
    assert.deepEqual(f.table.signals, []);
});

test('R5: a spawn failure clears nonce-only ownership only after a nonce scan shows nothing', async (t) => {
    for (const option of ['spawnThrows', 'noPid']) {
        const f = fixture(t, { [option]: true });
        await assert.rejects(f.broker.prepare(prepareArgs(f)), (error) => {
            assert.equal(error.message, 'helper could not start');
            assert.equal(error.reason, undefined);
            return true;
        }, option);
        assert.deepEqual(f.log, ['record:nonce', 'spawn', 'scan', 'record:null'], option);
    }
    const scanFailure = fixture(t, { spawnThrows: true });
    const broker = createHomeMountBroker({
        spawnImpl: () => { throw new Error('spawn failed'); },
        inspectTarget: async () => ({ id: target.containerId, running: true, initPid: 123 }),
        readIdentity: scanFailure.table.readIdentity,
        scanNonce: async () => { throw new Error('proc-scan-limit'); },
        uid: UID, graceMs: 1, delay: settle,
    });
    await assert.rejects(broker.prepare(prepareArgs(scanFailure)), { reason: 'helper_exit_unproven' });
    assert.deepEqual(scanFailure.states.map((state) => state && Object.keys(state).length), [2]);
});

test('a clean exit with a surviving session member is reclaimed and reported as a failure', async (t) => {
    const f = fixture(t, { lingerAfterExit: true });
    await assert.rejects(f.broker.release({ target, receipt: attachedReceipt(), onHelper: f.onHelper }), (error) => {
        assert.equal(error.message, 'home projection helper session survived');
        assert.equal(error.reason, undefined);
        return true;
    });
    assert.deepEqual(f.table.signals.map(([pid, name]) => `${name}:${pid}`), ['SIGTERM:500', 'SIGTERM:501', 'SIGTERM:502']);
    assert.equal(f.states.filter((state) => state === null).length, 1);
});

test('helper ownership validation accepts only the nonce-only and complete shapes', () => {
    assert.ok(validateHomeHelperOwnership({ nonce: NONCE, operation: 'prepare' }));
    assert.ok(validateHomeHelperOwnership({ nonce: NONCE, operation: 'release', pid: 2, startToken: 'linux-proc:1', uid: 0 }));
    for (const value of [
        null,
        { nonce: NONCE },
        { nonce: 'short', operation: 'prepare' },
        { nonce: NONCE, operation: 'recover' },
        { nonce: NONCE, operation: 'prepare', pid: 2 },
        { nonce: NONCE, operation: 'prepare', pid: 1, startToken: 'linux-proc:1', uid: 0 },
        { nonce: NONCE, operation: 'prepare', pid: 2, startToken: 'proc:1', uid: 0 },
        { nonce: NONCE, operation: 'prepare', pid: 2, startToken: 'linux-proc:1', uid: -1 },
        { nonce: NONCE, operation: 'prepare', extra: true },
    ]) {
        assert.throws(() => validateHomeHelperOwnership(value), { code: 'WEBTTY_HOME_PROJECTION_UNPROVEN' });
    }
});

test('failed durable prepared receipt aborts before attach', async (t) => {
    const f = fixture(t);
    await assert.rejects(f.broker.prepare(prepareArgs(f, { onPrepared: async () => false })), { code: 'WEBTTY_HOME_PROJECTION_UNPROVEN' });
    assert.deepEqual(f.actions, ['create', 'clone', 'abort']);
    assert.equal(f.states.at(-1), null);
});

test('receipt validation rejects extra fields, altered identity and skipped stages', () => {
    const intent = { version: 1, stage: 'intent', target: { containerId: target.containerId, initPid: 123, initStart: 'linux-proc:456', ...proof }, source: ident(15), destination: { path: `/run/ploinky-webtty-home-${sessionId}` } };
    const directory = { ...intent, stage: 'directory', destination: { ...intent.destination, ...ident(20) } };
    assert.equal(validateHomeMountReceipt(directory, { previous: intent }), directory);
    assert.throws(() => validateHomeMountReceipt({ ...intent, unexpected: true }));
    assert.throws(() => validateHomeMountReceipt({ ...directory, destination: { ...directory.destination, ino: '21' } }, { previous: directory }));
    assert.throws(() => validateHomeMountReceipt({ ...directory, stage: 'attached', mountId: '30' }, { previous: directory }));
    assert.throws(() => validateHomeMountReceipt({ ...intent, destination: { path: '/run/../etc' } }));
});

test('release does not require a source path and propagates cleanup refusal', async (t) => {
    const f = fixture(t, { releaseFailure: true });
    await assert.rejects(f.broker.release({ target, receipt: attachedReceipt(), onHelper: f.onHelper }), { code: 'WEBTTY_HOME_PROJECTION_UNPROVEN' });
    assert.equal(f.states.at(-1), null);
});

test('a release identity that does not match the receipt target is never told to proceed', async (t) => {
    const f = fixture(t);
    const receipt = attachedReceipt();
    const other = { ...receipt, target: { ...receipt.target, mountOwner: ident(99) } };
    await assert.rejects(f.broker.release({ target, receipt: other, onHelper: f.onHelper }), { message: 'helper target does not match receipt' });
    assert.deepEqual(f.actions, ['abort']);
});

test('malformed helper directory cannot redirect a mount', async (t) => {
    const f = fixture(t, { badDirectory: true });
    await assert.rejects(f.broker.prepare(prepareArgs(f)), { code: 'WEBTTY_HOME_PROJECTION_UNPROVEN' });
    assert.deepEqual(f.actions, ['create', 'abort']);
});

test('release succeeds without the original source and helper exit must be clean', async (t) => {
    const f = fixture(t);
    const receipt = attachedReceipt(f.home.identity);
    fs.rmSync(f.home.absolutePath, { recursive: true });
    assert.equal(await f.broker.release({ target, receipt, onHelper: f.onHelper }), true);
    assert.deepEqual(Object.keys(f.getConfig()).sort(), ['operation', 'receipt']);
    const failed = fixture(t, { closeStatus: 1 });
    await assert.rejects(failed.broker.prepare(prepareArgs(failed)), { code: 'WEBTTY_HOME_PROJECTION_UNPROVEN', message: 'helper cleanup unproven' });
    assert.equal(failed.states.at(-1), null);
});
