import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-maintenance-locks-'));
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const locks = await import(`../../cli/utils/runtime/maintenanceLocks.js?test=${Date.now()}`);

function lockFile(containerName) {
    return path.join(workspace, '.ploinky', 'running', 'maintenance', `${containerName}.json`);
}

test('maintenance lock is active while owner pid is alive', () => {
    const containerName = 'demo-container';
    locks.createMaintenanceLock(containerName, { operation: 'restart' });

    const result = locks.inspectMaintenanceLock(containerName);
    assert.equal(result.active, true);
    assert.equal(result.stale, false);
    assert.equal(result.lock.operation, 'restart');
});

test('maintenance lock creation is atomic and does not overwrite an active owner', () => {
    const containerName = 'atomic-container';
    const first = locks.createMaintenanceLock(containerName, { operation: 'reinstall' });

    assert.throws(
        () => locks.createMaintenanceLock(containerName, { operation: 'cli-start' }),
        (error) => error?.code === 'EEXIST',
    );
    assert.equal(locks.inspectMaintenanceLock(containerName).lock.lockId, first.lockId);
    assert.equal(locks.removeMaintenanceLock(containerName, { lockId: first.lockId }), true);
});

test('maintenance lock release cannot remove a different owner lock', () => {
    const containerName = 'owned-container';
    const lock = locks.createMaintenanceLock(containerName, { operation: 'restart' });

    assert.equal(locks.removeMaintenanceLock(containerName, { lockId: 'different-owner' }), false);
    assert.equal(locks.inspectMaintenanceLock(containerName).active, true);
    assert.equal(locks.removeMaintenanceLock(containerName, { lockId: lock.lockId }), true);
});

test('withMaintenanceLock waits for the current owner before entering', async () => {
    const containerName = 'serialized-container';
    const events = [];
    let releaseFirst;
    let markFirstEntered;
    const firstEntered = new Promise((resolve) => { markFirstEntered = resolve; });
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

    const first = locks.withMaintenanceLock(containerName, {
        operation: 'reinstall',
        retryIntervalMs: 5,
    }, async () => {
        events.push('first-enter');
        markFirstEntered();
        await firstGate;
        events.push('first-exit');
    });
    await firstEntered;

    const second = locks.withMaintenanceLock(containerName, {
        operation: 'cli-start',
        retryIntervalMs: 5,
    }, async () => {
        events.push('second-enter');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events, ['first-enter']);

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first-enter', 'first-exit', 'second-enter']);
});

test('withMaintenanceLock removes the lock in finally', async () => {
    const containerName = 'finally-container';
    await locks.withMaintenanceLock(containerName, { operation: 'reinstall' }, async () => {
        assert.equal(fs.existsSync(lockFile(containerName)), true);
    });

    assert.equal(fs.existsSync(lockFile(containerName)), false);
});

test('expired maintenance lock is treated as stale and removed', () => {
    const containerName = 'expired-container';
    locks.createMaintenanceLock(containerName, { operation: 'restart', ttlMs: -1 });

    const result = locks.inspectMaintenanceLock(containerName);
    assert.equal(result.active, false);
    assert.equal(result.stale, true);
    assert.equal(fs.existsSync(lockFile(containerName)), false);
});
