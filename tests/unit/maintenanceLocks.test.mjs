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

test('replacement candidate names share their predecessor maintenance identity', () => {
    const predecessorName = 'stable-runtime';
    const candidateName = `${predecessorName}__candidate_123456789abc`;
    const first = locks.createMaintenanceLock(predecessorName, { operation: 'cli-start' });

    assert.equal(locks.inspectMaintenanceLock(candidateName).active, true);
    assert.throws(
        () => locks.createMaintenanceLock(candidateName, { operation: 'restart' }),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY',
    );
    assert.equal(locks.removeMaintenanceLock(candidateName, first.token), true);
    assert.equal(locks.inspectMaintenanceLock(predecessorName).active, false);
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

test('no-wait workspace mutation waits for its parent workspace-start owner', async () => {
    const first = locks.createWorkspaceStartLock();
    let entered = false;
    const waiting = locks.withWorkspaceMutationLease({
        operation: 'no-wait-runtime:test',
        waitTimeoutMs: 1_000,
        retryIntervalMs: 5,
    }, async () => {
        entered = true;
        assert.equal(locks.inspectWorkspaceStartLock().lock.operation, 'no-wait-runtime:test');
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(entered, false);
    assert.equal(locks.inspectWorkspaceStartLock().lock.token, first.token);
    assert.equal(locks.releaseWorkspaceStartLock(first), true);

    await waiting;
    assert.equal(locks.inspectWorkspaceStartLock().active, false);
});

test('no-wait route activation waits for Cloudflare publication and never overlaps it', async () => {
    const events = [];
    let releasePublication;
    let publicationEntered;
    const entered = new Promise((resolve) => { publicationEntered = resolve; });
    const gate = new Promise((resolve) => { releasePublication = resolve; });

    const publication = locks.withWorkspaceMutationLease({
        operation: 'cloudflare-publication:test',
        retryIntervalMs: 5,
    }, async () => {
        events.push('publication-enter');
        publicationEntered();
        await gate;
        events.push('publication-exit');
    });
    await entered;

    const noWait = locks.withWorkspaceMutationLease({
        operation: 'no-wait-runtime:test',
        waitTimeoutMs: 1_000,
        retryIntervalMs: 5,
    }, async () => {
        events.push('route-activation-enter');
        events.push('route-activation-exit');
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events, ['publication-enter']);
    releasePublication();
    await Promise.all([publication, noWait]);
    assert.deepEqual(events, [
        'publication-enter',
        'publication-exit',
        'route-activation-enter',
        'route-activation-exit',
    ]);
});

test('two no-wait route activations cannot enter concurrently', async () => {
    const events = [];
    let releaseFirst;
    let firstEntered;
    const entered = new Promise((resolve) => { firstEntered = resolve; });
    const gate = new Promise((resolve) => { releaseFirst = resolve; });

    const first = locks.withWorkspaceMutationLease({
        operation: 'no-wait-runtime:first',
        retryIntervalMs: 5,
    }, async () => {
        events.push('first-enter');
        firstEntered();
        await gate;
        events.push('first-exit');
    });
    await entered;
    const second = locks.withWorkspaceMutationLease({
        operation: 'no-wait-runtime:second',
        waitTimeoutMs: 1_000,
        retryIntervalMs: 5,
    }, async () => {
        events.push('second-enter');
        events.push('second-exit');
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events, ['first-enter']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first-enter', 'first-exit', 'second-enter', 'second-exit']);
});

test('workspace mutation contention times out fail-closed within its bound', async () => {
    const owner = locks.createWorkspaceMutationLease({ operation: 'cloudflare-publication:stuck' });
    await assert.rejects(
        () => locks.acquireWorkspaceMutationLease({
            operation: 'no-wait-runtime:bounded',
            waitTimeoutMs: 0,
            retryIntervalMs: 1,
        }),
        (error) => error?.code === 'workspace_mutation_lock_timeout',
    );
    assert.equal(locks.inspectWorkspaceStartLock().lock.token, owner.token);
    assert.equal(locks.releaseWorkspaceMutationLease(owner), true);
});

test('workspace mutation callback releases its lease on success and failure', async () => {
    await locks.withWorkspaceMutationLease({ operation: 'no-wait-success' }, async () => {
        assert.equal(locks.inspectWorkspaceStartLock().active, true);
    });
    assert.equal(locks.inspectWorkspaceStartLock().active, false);

    await assert.rejects(
        () => locks.withWorkspaceMutationLease({ operation: 'no-wait-failure' }, async () => {
            assert.equal(locks.inspectWorkspaceStartLock().active, true);
            throw new Error('adversarial route activation failure');
        }),
        /adversarial route activation failure/,
    );
    assert.equal(locks.inspectWorkspaceStartLock().active, false);
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


function mockLinuxOwnerIdentity(t) {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    t.after(() => Object.defineProperty(process, 'platform', platform));
    const identity = { bootId: 'test-boot', namespace: 'pid:[1234]', startTicks: '100' };
    const readFileSync = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', function (filePath, ...args) {
        if (filePath === '/proc/sys/kernel/random/boot_id') {
            if (!identity.bootId) throw new Error('boot identity unavailable');
            return identity.bootId;
        }
        if (filePath === `/proc/${process.pid}/stat`) {
            if (!identity.startTicks) throw new Error('process identity unavailable');
            return `${process.pid} (test (worker)) S ${Array(18).fill('0').join(' ')} ${identity.startTicks}`;
        }
        return readFileSync.call(this, filePath, ...args);
    });
    const readlinkSync = fs.readlinkSync;
    t.mock.method(fs, 'readlinkSync', function (filePath, ...args) {
        if (filePath === '/proc/self/ns/pid') {
            if (!identity.namespace) throw new Error('namespace unavailable');
            return identity.namespace;
        }
        return readlinkSync.call(this, filePath, ...args);
    });
    t.after(() => fs.rmSync(locks.WORKSPACE_START_LOCK_PATH, { force: true }));
    return identity;
}

test('workspace lease reclaims a reused PID only when its birth differs in the same scope', (t) => {
    const identity = mockLinuxOwnerIdentity(t);
    const old = locks.createWorkspaceMutationLease({ operation: 'no-wait-activate:old', ttlMs: -1 });
    assert.equal(old.ownerIdentity.startIdentity, 'linux-proc:100');
    assert.deepEqual(JSON.parse(old.ownerIdentity.scope), ['linux', 'test-boot', 'pid:[1234]']);
    identity.startTicks = '200';
    const recovered = locks.inspectWorkspaceStartLock();
    assert.equal(recovered.active, false);
    assert.equal(recovered.stale, true);
    const replacement = locks.createWorkspaceStartLock();
    assert.equal(replacement.ownerIdentity.startIdentity, 'linux-proc:200');
    assert.equal(locks.releaseWorkspaceMutationLease(old), false);
    assert.equal(locks.inspectWorkspaceStartLock().lock.token, replacement.token);
    assert.equal(locks.releaseWorkspaceStartLock(replacement), true);
});

test('matching workspace owner birth remains protected after expiry', (t) => {
    mockLinuxOwnerIdentity(t);
    const owner = locks.createWorkspaceStartLock({ ttlMs: -1 });
    const state = locks.inspectWorkspaceStartLock();
    assert.equal(state.active, true);
    assert.equal(state.renewalOverdue, true);
    assert.equal(state.lock.token, owner.token);
});

test('unavailable or different workspace owner scope and birth fail closed', (t) => {
    const identity = mockLinuxOwnerIdentity(t);
    const owner = locks.createWorkspaceStartLock({ ttlMs: -1 });
    for (const unavailableField of ['startTicks', 'bootId', 'namespace']) {
        const saved = identity[unavailableField];
        identity[unavailableField] = '';
        assert.equal(locks.inspectWorkspaceStartLock().active, true, unavailableField);
        identity[unavailableField] = saved;
    }
    identity.startTicks = '200';
    identity.namespace = 'pid:[another-box]';
    assert.equal(locks.inspectWorkspaceStartLock().active, true);
    identity.namespace = 'pid:[1234]';
    identity.bootId = 'another-boot';
    assert.equal(locks.inspectWorkspaceStartLock().active, true);
    assert.equal(JSON.parse(fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH, 'utf8')).token, owner.token);
});

test('a lease created without a birth identity never reaps a live PID', (t) => {
    const identity = mockLinuxOwnerIdentity(t);
    identity.startTicks = '';
    const owner = locks.createWorkspaceStartLock({ ttlMs: -1 });
    identity.startTicks = '200';
    assert.equal(locks.inspectWorkspaceStartLock().active, true);
    assert.equal(locks.releaseWorkspaceStartLock(owner), true);
});

test('legacy live PID leases remain protected and dead PID leases recover', (t) => {
    mockLinuxOwnerIdentity(t);
    const owner = locks.createWorkspaceStartLock({ ttlMs: -1 });
    delete owner.ownerIdentity;
    fs.writeFileSync(locks.WORKSPACE_START_LOCK_PATH, JSON.stringify(owner));
    assert.equal(locks.inspectWorkspaceStartLock().active, true);
    owner.ownerPid = 2_147_483_647;
    fs.writeFileSync(locks.WORKSPACE_START_LOCK_PATH, JSON.stringify(owner));
    assert.equal(locks.inspectWorkspaceStartLock().active, false);
});

test('workspace start waits for no-wait activation before acquiring its own lease', async () => {
    const activation = locks.createWorkspaceMutationLease({ operation: 'no-wait-activate:worker' });
    let acquired = false;
    const waiting = locks.acquireWorkspaceMutationLease({
        operation: 'workspace-start', waitTimeoutMs: 1_000, retryIntervalMs: 5,
    }).then((lease) => { acquired = true; return lease; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(acquired, false);
    assert.equal(locks.inspectWorkspaceStartLock().lock.token, activation.token);
    assert.equal(locks.releaseWorkspaceMutationLease(activation), true);
    const start = await waiting;
    assert.equal(start.operation, 'workspace-start');
    assert.notEqual(start.token, activation.token);
    assert.equal(locks.releaseWorkspaceMutationLease(start), true);
});

test('workspace start timeout preserves an ongoing no-wait activation', async () => {
    const activation = locks.createWorkspaceMutationLease({ operation: 'no-wait-activate:worker' });
    await assert.rejects(
        () => locks.acquireWorkspaceMutationLease({ operation: 'workspace-start', waitTimeoutMs: 0 }),
        (error) => error.code === 'workspace_mutation_lock_timeout',
    );
    assert.equal(locks.inspectWorkspaceStartLock().lock.token, activation.token);
    assert.equal(locks.releaseWorkspaceMutationLease(activation), true);
});


test('stale owner recovery preserves a concurrent replacement lease', (t) => {
    const identity = mockLinuxOwnerIdentity(t);
    const stale = locks.createWorkspaceMutationLease({ operation: 'no-wait-activate:old' });
    identity.startTicks = '200';
    const replacement = {
        ...stale,
        token: 'concurrent-owner-token',
        ownerIdentity: { ...stale.ownerIdentity, startIdentity: 'linux-proc:200' },
    };
    const readFileSync = fs.readFileSync;
    let replaced = false;
    t.mock.method(fs, 'readFileSync', function (filePath, ...args) {
        if (!replaced && filePath === `/proc/${process.pid}/stat`) {
            replaced = true;
            fs.writeFileSync(locks.WORKSPACE_START_LOCK_PATH, JSON.stringify(replacement));
        }
        return readFileSync.call(this, filePath, ...args);
    });
    const state = locks.inspectWorkspaceStartLock();
    assert.equal(replaced, true);
    assert.equal(state.active, true);
    assert.equal(state.lock.token, replacement.token);
    assert.equal(locks.releaseWorkspaceMutationLease(stale), false);
});

test('scoped workspace lease recovers a dead owner but preserves inconclusive liveness', (t) => {
    mockLinuxOwnerIdentity(t);
    const owner = locks.createWorkspaceStartLock();
    t.mock.method(process, 'kill', () => { throw Object.assign(new Error('probe unavailable'), { code: 'EIO' }); });
    assert.equal(locks.inspectWorkspaceStartLock().active, true);
    t.mock.method(process, 'kill', () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
    assert.equal(locks.inspectWorkspaceStartLock().active, false);
    assert.equal(fs.existsSync(locks.WORKSPACE_START_LOCK_PATH), false);
});
