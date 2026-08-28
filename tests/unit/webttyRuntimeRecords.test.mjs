import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    listLinuxSessionMembers,
    RuntimeRecordStore,
} from '../../cli/server/webtty/runtimeRecords.mjs';

function workerIdentity() {
    return { pid: 201, startToken: 'linux-proc:101', uid: process.getuid?.() ?? 0 };
}

function observedWorker(marker, overrides = {}) {
    return {
        ...workerIdentity(),
        pgrp: 201,
        session: 201,
        cmdline: ['node', `--ploinky-webtty-marker=${marker}`],
        ...overrides,
    };
}

function ptyIdentity() {
    return {
        pid: 301,
        startToken: 'linux-proc:202',
        uid: process.getuid?.() ?? 0,
        pgrp: 301,
        session: 301,
    };
}

async function markPtyReady(store, handle) {
    await store.markPtyStarting(handle);
    await store.update(handle, {
        ...handle.record,
        pty: ptyIdentity(),
        ptyState: 'pty-ready',
    });
}

function procStat(pid, {
    state = 'S', pgrp = pid, session = pid, startToken = '12345',
} = {}) {
    const fields = [
        state, '1', String(pgrp), String(session), '34816', String(pgrp),
        '0', '0', '0', '0', '0', '0', '0', '0', '0', '20', '0', '1', '0', startToken,
    ];
    return `${pid} (command ) with parens) ${fields.join(' ')}`;
}

test('Linux session enumeration returns live members and ignores zombies and other sessions', async (t) => {
    const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-proc-'));
    t.after(() => fs.rm(procRoot, { recursive: true, force: true }));
    for (const [pid, stat] of [
        [301, procStat(301, { state: 'Z', session: 301 })],
        [302, procStat(302, { pgrp: 302, session: 301, startToken: '12346' })],
        [401, procStat(401, { session: 401, startToken: '12347' })],
    ]) {
        await fs.mkdir(path.join(procRoot, String(pid)));
        await fs.writeFile(path.join(procRoot, String(pid), 'stat'), stat);
    }
    await fs.writeFile(path.join(procRoot, 'not-a-pid'), 'ignored');

    assert.deepEqual(await listLinuxSessionMembers(301, { procRoot }), [{
        pid: 302,
        state: 'S',
        pgrp: 302,
        session: 301,
        startToken: 'linux-proc:12346',
    }]);
});

test('dead cleanup-unproven worker-only records self-heal on restart', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const signals = [];
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        signal: (...args) => signals.push(args),
        graceMs: 1,
    });
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    await store.markCleanupUnproven(handle);

    const restartedStore = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        signal: (...args) => signals.push(args),
        graceMs: 1,
    });
    const recovery = await restartedStore.recover();
    assert.deepEqual(recovery, {
        ok: true,
        evidence: ['dead_unproven_record_removed'],
    });
    assert.deepEqual(signals, []);
    assert.equal((await fs.readdir(directory)).length, 0);
});

test('dead cleanup-unproven PTY records self-heal only after the whole terminal session is empty', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listSessionMembers: async () => [],
        signal: () => assert.fail('dead identities must never be signaled'),
        graceMs: 1,
        delay: async () => {},
    });
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    await markPtyReady(store, handle);
    await store.markCleanupUnproven(handle);

    assert.deepEqual(await store.recover(), {
        ok: true,
        evidence: ['dead_unproven_record_removed'],
    });
    assert.deepEqual(await fs.readdir(directory), []);
});

test('cleanup-unproven PTY records remain fail-closed while a terminal-session member survives', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const member = {
        pid: 302, state: 'S', pgrp: 302, session: 301, startToken: 'linux-proc:203',
    };
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listSessionMembers: async () => [member],
        signal: () => assert.fail('ambiguous descendants must never be signaled'),
        graceMs: 1,
        delay: async () => {},
    });
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    await markPtyReady(store, handle);
    await store.markCleanupUnproven(handle);

    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'cleanup_unproven');
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('proven records are not removed while a terminal-session descendant survives', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        listSessionMembers: async () => [{
            pid: 302, state: 'S', pgrp: 302, session: 301, startToken: 'linux-proc:203',
        }],
        signal: () => assert.fail('an unverified descendant group must never be signaled'),
        graceMs: 1,
        delay: async () => {},
    });
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    await markPtyReady(store, handle);

    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'process_cleanup_unconfirmed');
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('dead proven records are removed without signaling recycled numeric process ids', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const signals = [];
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        signal: (...args) => signals.push(args),
        graceMs: 1,
    });
    await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    assert.deepEqual(await store.recover(), {
        ok: true,
        evidence: ['dead_record_removed'],
    });
    assert.deepEqual(signals, []);
    assert.deepEqual(await fs.readdir(directory), []);
});

test('unknown cleanup state is ambiguous evidence and never normalized away', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        signal: () => assert.fail('ambiguous evidence must never be signaled'),
        graceMs: 1,
    });
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    const recordPath = path.join(directory, handle.fileName);
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    record.cleanupState = 'looks-safe-but-is-unknown';
    await fs.writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });

    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'record_unprovable');
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('crash after init admission but before ready PTY evidence remains fail-closed', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => null,
        signal: () => assert.fail('unknown startup PTY must never be signaled by numeric PID'),
        graceMs: 1,
    });
    const handle = await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker: 'worker-marker-abcdefghijklmnopqrstuvwx',
        worker: workerIdentity(),
    });
    assert.equal(await store.markPtyStarting(handle), true);

    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'pty_startup_unproven');
    assert.equal((await fs.readdir(directory)).length, 1);
});

test('worker TERM refuses a PID recycled between inspection and immediate revalidation', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const marker = 'worker-marker-abcdefghijklmnopqrstuvwx';
    const observed = [
        observedWorker(marker),
        observedWorker(marker),
        observedWorker(marker, { startToken: 'linux-proc:recycled' }),
    ];
    const signals = [];
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => observed.shift() || null,
        signal: (...args) => signals.push(args),
        graceMs: 1,
    });
    await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker,
        worker: workerIdentity(),
    });
    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'worker_term_revalidation_failed');
    assert.deepEqual(signals, []);
});

test('worker KILL refuses a PID recycled after TERM grace', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ploinky-webtty-records-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const marker = 'worker-marker-abcdefghijklmnopqrstuvwx';
    const observed = [
        observedWorker(marker),
        observedWorker(marker),
        observedWorker(marker),
        observedWorker(marker),
        observedWorker(marker, { startToken: 'linux-proc:recycled' }),
    ];
    const signals = [];
    const store = new RuntimeRecordStore({
        directory,
        readIdentity: async () => observed.shift() || null,
        signal: (...args) => signals.push(args),
        graceMs: 1,
    });
    await store.create({
        routerEpoch: 'router-epoch-abcdefghijklmnop',
        marker,
        worker: workerIdentity(),
    });
    const recovery = await store.recover();
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'worker_force_revalidation_failed');
    assert.deepEqual(signals, [[201, 'SIGTERM']]);
});
