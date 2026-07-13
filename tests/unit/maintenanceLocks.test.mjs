import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-maintenance-locks-'));
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const locks = await import(`../../cli/services/maintenanceLocks.js?test=${Date.now()}`);

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

test('workspace start lock excludes concurrent startup and releases only by token', () => {
    const lock = locks.createWorkspaceStartLock();
    const result = locks.inspectWorkspaceStartLock();
    assert.equal(result.active, true);
    assert.equal(result.lock.ownerPid, process.pid);
    assert.throws(() => locks.createWorkspaceStartLock(), /workspace start is already active/);
    assert.equal(locks.releaseWorkspaceStartLock({ ...lock, token: 'foreign' }), false);
    assert.equal(locks.inspectWorkspaceStartLock().active, true);
    assert.equal(locks.releaseWorkspaceStartLock(lock), true);
    assert.equal(fs.existsSync(locks.WORKSPACE_START_LOCK_PATH), false);
});

test('expired workspace start lock is reaped before a new owner acquires it', () => {
    const expired = locks.createWorkspaceStartLock({ ttlMs: -1 });
    const result = locks.inspectWorkspaceStartLock();
    assert.equal(result.active, false);
    assert.equal(result.stale, true);
    assert.equal(result.lock.token, expired.token);

    const replacement = locks.createWorkspaceStartLock();
    assert.notEqual(replacement.token, expired.token);
    assert.equal(locks.releaseWorkspaceStartLock(replacement), true);
});
