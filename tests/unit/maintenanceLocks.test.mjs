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
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY',
    );
    assert.equal(locks.inspectMaintenanceLock(containerName).lock.token, first.token);
    assert.equal(locks.removeMaintenanceLock(containerName, first.token), true);
});

test('maintenance lock release cannot remove a different owner lock', () => {
    const containerName = 'owned-container';
    const lock = locks.createMaintenanceLock(containerName, { operation: 'restart' });

    assert.equal(locks.removeMaintenanceLock(containerName, 'different-owner'), false);
    assert.equal(locks.inspectMaintenanceLock(containerName).active, true);
    assert.equal(locks.removeMaintenanceLock(containerName, lock.token), true);
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

test('an expired lease remains active while its owner pid is alive', () => {
    const containerName = 'expired-container';
    const lock = locks.createMaintenanceLock(containerName, { operation: 'restart', ttlMs: -1 });

    const result = locks.inspectMaintenanceLock(containerName);
    assert.equal(result.active, true);
    assert.equal(result.stale, false);
    assert.equal(result.renewalOverdue, true);
    assert.equal(locks.removeMaintenanceLock(containerName, lock.token), true);
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

test('expired workspace lease is not reaped while the owner is alive and can renew', () => {
    const expired = locks.createWorkspaceStartLock({ ttlMs: -1 });
    const result = locks.inspectWorkspaceStartLock();
    assert.equal(result.active, true);
    assert.equal(result.stale, false);
    assert.equal(result.renewalOverdue, true);
    assert.equal(result.lock.token, expired.token);
    assert.throws(() => locks.createWorkspaceStartLock(), /workspace start is already active/);
    assert.equal(locks.renewWorkspaceMutationLease(expired, { ttlMs: 60_000 }), true);
    assert.equal(locks.inspectWorkspaceStartLock().renewalOverdue, false);
    assert.equal(locks.releaseWorkspaceStartLock(expired), true);
});

test('fresh malformed workspace leases fail closed and become recoverable only after the stale grace', () => {
    fs.mkdirSync(path.dirname(locks.WORKSPACE_START_LOCK_PATH), { recursive: true });
    fs.writeFileSync(locks.WORKSPACE_START_LOCK_PATH, '{malformed', { mode: 0o600 });
    const fresh = locks.inspectWorkspaceStartLock();
    assert.equal(fresh.active, true);
    assert.equal(fresh.recoveryPending, true);
    assert.throws(
        () => locks.createWorkspaceMutationLease(),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY',
    );

    const stale = new Date(Date.now() - 6_000);
    fs.utimesSync(locks.WORKSPACE_START_LOCK_PATH, stale, stale);
    const recovered = locks.inspectWorkspaceStartLock();
    assert.equal(recovered.active, false);
    assert.equal(recovered.stale, true);
    assert.equal(fs.existsSync(locks.WORKSPACE_START_LOCK_PATH), false);
});

test('token comparison preserves a replacement maintenance lock', async () => {
    const containerName = 'replacement-container';
    const filePath = lockFile(containerName);
    const replacement = { token: 'replacement-token', ownerPid: process.pid, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await locks.withMaintenanceLock(containerName, { operation: 'first' }, async () => {
        fs.unlinkSync(filePath);
        fs.writeFileSync(filePath, JSON.stringify(replacement), { mode: 0o600 });
    });
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).token, replacement.token);
    assert.equal(locks.removeMaintenanceLock(containerName, replacement.token), true);
});
