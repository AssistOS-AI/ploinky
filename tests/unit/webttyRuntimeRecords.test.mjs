import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RuntimeRecordStore } from '../../cli/server/webtty/runtimeRecords.mjs';

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

test('cleanup-unproven recovery evidence survives worker exit and fails closed on restart', async (t) => {
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
    assert.equal(recovery.ok, false);
    assert.equal(recovery.category, 'cleanup_unproven');
    assert.deepEqual(signals, []);
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
