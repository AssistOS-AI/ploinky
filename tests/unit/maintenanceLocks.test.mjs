import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';

const workspace = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-maintenance-locks-')),
);
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
process.env.PLOINKY_WORKSPACE_ROOT = workspace;

const locks = await import(`../../cli/utils/runtime/maintenanceLocks.js?test=${Date.now()}`);
const maintenanceLocksModuleHref = new URL('../../cli/utils/runtime/maintenanceLocks.js', import.meta.url).href;

function runIsolatedLockScenario(source) {
    const isolatedWorkspace = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-maintenance-lineage-')),
    );
    fs.mkdirSync(path.join(isolatedWorkspace, '.ploinky'), { mode: 0o755 });
    try {
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import path from 'node:path';
            const locks = await import(${JSON.stringify(maintenanceLocksModuleHref)});
            ${source}
        `], {
            cwd: path.dirname(new URL(import.meta.url).pathname),
            encoding: 'utf8',
            env: { ...process.env, PLOINKY_WORKSPACE_ROOT: isolatedWorkspace },
            timeout: 30_000,
        });
        assert.equal(
            result.status,
            0,
            `isolated lock scenario failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
    } finally {
        fs.rmSync(isolatedWorkspace, { recursive: true, force: true });
    }
}

function lockFile(containerName) {
    return path.join(workspace, '.ploinky', 'running', 'locks', 'maintenance', `${containerName}.json`);
}

const TOKEN_A = '11111111-1111-4111-8111-111111111111';
const TOKEN_B = '22222222-2222-4222-8222-222222222222';
const TOKEN_C = '33333333-3333-4333-8333-333333333333';
const IDENTITY_A = 'linux-proc:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:101';
const IDENTITY_B = 'linux-proc:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:202';
const IDENTITY_CURRENT = 'linux-proc:cccccccc-cccc-4ccc-8ccc-cccccccccccc:303';
const CURRENT_UID = process.getuid();

function exactRecordBytes(record) {
    return `${JSON.stringify(record)}\n`;
}

function writeExactRecord(filePath, record) {
    fs.writeFileSync(filePath, exactRecordBytes(record), { flag: 'wx', mode: 0o600 });
}

function releaseArtifacts(filePath) {
    return fs.readdirSync(path.dirname(filePath))
        .filter((name) => name.startsWith(`${path.basename(filePath)}.operation-`));
}

function renewalArtifacts(filePath) {
    return fs.readdirSync(path.dirname(filePath))
        .filter((name) => name.startsWith(`${path.basename(filePath)}.renewal-`));
}

function publicationArtifacts(filePath) {
    return fs.readdirSync(path.dirname(filePath))
        .filter((name) => name.startsWith(`${path.basename(filePath)}.publication-`));
}

function artifactContentId(record) {
    return createHash('sha256').update(exactRecordBytes(record)).digest('hex').slice(0, 32);
}

function snapshotLockPaths(filePaths) {
    return [...filePaths]
        .sort()
        .map((filePath) => {
            const stat = fs.lstatSync(filePath);
            return {
                name: path.basename(filePath),
                bytes: fs.readFileSync(filePath).toString('hex'),
                dev: stat.dev,
                ino: stat.ino,
                nlink: stat.nlink,
            };
        });
}

function lockNamespacePaths(filePath) {
    const basename = path.basename(filePath);
    return fs.readdirSync(path.dirname(filePath))
        .filter((name) => name === basename || name.startsWith(`${basename}.`))
        .map((name) => path.join(path.dirname(filePath), name));
}

function snapshotLockNamespace(filePath) {
    return snapshotLockPaths(lockNamespacePaths(filePath));
}

function removeLockPaths(filePaths) {
    for (const filePath of filePaths) fs.rmSync(filePath, { force: true });
}

function installWorkspaceRenewalState(previous, phase) {
    const filePath = locks.WORKSPACE_START_LOCK_PATH;
    const contentId = artifactContentId(previous);
    const claimPath = `${filePath}.renewal-${contentId}.claim`;
    const candidatePath = `${filePath}.renewal-${contentId}.candidate`;
    const quarantinePath = `${filePath}.renewal-${contentId}.quarantine`;
    const renewed = {
        ...previous,
        expiresAt: new Date(Date.parse(previous.expiresAt) + 60_000).toISOString(),
    };

    writeExactRecord(claimPath, previous);
    fs.linkSync(claimPath, quarantinePath);
    writeExactRecord(candidatePath, renewed);
    if (phase === 'N4') fs.linkSync(candidatePath, filePath);

    return {
        previous,
        renewed,
        claimPath,
        candidatePath,
        quarantinePath,
        paths: phase === 'N4'
            ? [filePath, claimPath, candidatePath, quarantinePath]
            : [claimPath, candidatePath, quarantinePath],
    };
}

function identified(processIdentity, processUid = CURRENT_UID) {
    return { state: 'identified', processIdentity, processUid };
}

function provenDeadOwner(record, overrides = {}) {
    return {
        ...record,
        ownerPid: 0x7fffffff,
        ownerUid: CURRENT_UID,
        ownerStartIdentity: IDENTITY_A,
        ...overrides,
    };
}

function appliedThenEioFs(method, matches) {
    const property = `${method}Sync`;
    const state = { injected: false };
    const faultingFs = new Proxy(fs, {
        get(target, requested, receiver) {
            if (requested === property) {
                return (...args) => {
                    const inject = !state.injected && matches(...args);
                    const result = target[property](...args);
                    if (inject) {
                        state.injected = true;
                        throw Object.assign(new Error(`injected applied ${method} EIO`), { code: 'EIO' });
                    }
                    return result;
                };
            }
            return Reflect.get(target, requested, receiver);
        },
    });
    return { faultingFs, state };
}

function appliedThenProofEioFs(method, matches, proofPath) {
    const property = `${method}Sync`;
    const state = { injected: false, proofInjected: false };
    const faultingFs = new Proxy(fs, {
        get(target, requested, receiver) {
            if (requested === property) {
                return (...args) => {
                    const inject = !state.injected && matches(...args);
                    const result = target[property](...args);
                    if (inject) {
                        state.injected = true;
                        throw Object.assign(new Error(`injected applied ${method} EIO`), { code: 'EIO' });
                    }
                    return result;
                };
            }
            if (requested === 'lstatSync') {
                return (targetPath, ...args) => {
                    if (state.injected && !state.proofInjected && targetPath === proofPath) {
                        state.proofInjected = true;
                        throw Object.assign(new Error('injected proof lstat EIO'), { code: 'EIO' });
                    }
                    return target.lstatSync(targetPath, ...args);
                };
            }
            return Reflect.get(target, requested, receiver);
        },
    });
    return { faultingFs, state };
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

test('workspace renewal pins but never mutates the old inode and excludes exact release', () => {
    const lease = locks.createWorkspaceMutationLease({ operation: 'renewal-release-race' });
    const oldBytes = fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH, 'utf8');
    let releaseWasExcluded = false;
    let replacementObserved = false;
    const renewed = locks.renewWorkspaceMutationLease(lease, {
        ttlMs: 48 * 60 * 60 * 1000,
    }, {
        afterRenewalClaim({ claimPath }) {
            assert.equal(fs.readFileSync(claimPath, 'utf8'), oldBytes);
            assert.throws(
                () => locks.releaseWorkspaceMutationLease(lease),
                (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY',
            );
            assert.equal(fs.readFileSync(claimPath, 'utf8'), oldBytes);
            assert.equal(fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH, 'utf8'), oldBytes);
            releaseWasExcluded = true;
        },
        afterRenewalReplace({ claimPath }) {
            assert.equal(fs.readFileSync(claimPath, 'utf8'), oldBytes);
            assert.notEqual(fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH, 'utf8'), oldBytes);
            replacementObserved = true;
        },
    });
    assert.equal(renewed, true);
    assert.equal(releaseWasExcluded, true);
    assert.equal(replacementObserved, true);
    assert.deepEqual(renewalArtifacts(locks.WORKSPACE_START_LOCK_PATH), []);
    assert.equal(locks.inspectWorkspaceStartLock().lock.token, lease.token);
    assert.equal(locks.releaseWorkspaceMutationLease(lease), true);
});

test('completed live renewal stays BUSY and exact until dead-owner recovery', (t) => {
    const filePath = locks.WORKSPACE_START_LOCK_PATH;
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));
    const lease = locks.createWorkspaceMutationLease({
        operation: 'interrupted-renewal',
        ttlMs: -1,
    });
    const oldExpiresAt = lease.expiresAt;
    const result = locks.renewWorkspaceMutationLease(lease, { ttlMs: 60_000 }, {
        afterRenewalReplace() { throw new Error('simulated crash after renewal replacement'); },
    });
    assert.equal(result, false);
    assert.equal(renewalArtifacts(locks.WORKSPACE_START_LOCK_PATH).length, 3);
    const renewedRecord = JSON.parse(fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH, 'utf8'));
    assert.equal(renewedRecord.token, lease.token);
    assert.ok(Date.parse(renewedRecord.expiresAt) > Date.parse(oldExpiresAt));

    const before = snapshotLockNamespace(filePath);
    assert.throws(
        () => locks.inspectWorkspaceStartLock(),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY'
            && error.owner?.token === lease.token,
    );
    assert.deepEqual(snapshotLockNamespace(filePath), before);

    let inspections = 0;
    const recovered = locks.inspectWorkspaceStartLock({
        inspectProcessIdentity() {
            inspections += 1;
            if (inspections === 1) return { state: 'dead' };
            return identified(renewedRecord.ownerStartIdentity, renewedRecord.ownerUid);
        },
    });
    assert.equal(recovered.active, true);
    assert.equal(recovered.lock.token, lease.token);
    assert.equal(recovered.renewalOverdue, false);
    assert.deepEqual(renewalArtifacts(locks.WORKSPACE_START_LOCK_PATH), []);
    assert.equal(locks.releaseWorkspaceMutationLease(lease), true);
});

test('acquisition recovers only a stable exact dead-owner publication', async (t) => {
    const containerName = 'stable-dead-publication';
    const filePath = lockFile(containerName);
    const seed = locks.createMaintenanceLock(containerName, { operation: 'publication-seed' });
    assert.equal(locks.removeMaintenanceLock(containerName, seed.token), true);
    const stale = provenDeadOwner(seed, {
        operation: 'dead-publication-owner',
        token: TOKEN_B,
    });
    const claimPath = `${filePath}.publication-${artifactContentId(stale)}.claim`;
    writeExactRecord(claimPath, stale);
    const before = snapshotLockNamespace(filePath);
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));

    const startedAt = Date.now();
    const acquired = await locks.acquireMaintenanceLock(containerName, {
        operation: 'after-dead-publication',
        waitTimeoutMs: 500,
        retryIntervalMs: 10,
    });
    assert.ok(Date.now() - startedAt >= 90);
    assert.notDeepEqual(snapshotLockNamespace(filePath), before);
    assert.deepEqual(publicationArtifacts(filePath), []);
    assert.equal(acquired.operation, 'after-dead-publication');
    assert.equal(locks.removeMaintenanceLock(containerName, acquired.token), true);
});

test('acquisition recovers a stable exact dead-owner renewal before publishing', async (t) => {
    const filePath = locks.WORKSPACE_START_LOCK_PATH;
    const seed = locks.createWorkspaceMutationLease({ operation: 'renewal-seed' });
    assert.equal(locks.releaseWorkspaceMutationLease(seed), true);
    const stale = provenDeadOwner(seed, {
        operation: 'dead-renewal-owner',
        token: TOKEN_B,
    });
    installWorkspaceRenewalState(stale, 'N4');
    const before = snapshotLockNamespace(filePath);
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));

    const acquired = await locks.acquireWorkspaceMutationLease({
        operation: 'after-dead-renewal',
        waitTimeoutMs: 500,
        retryIntervalMs: 10,
    });
    assert.notDeepEqual(snapshotLockNamespace(filePath), before);
    assert.deepEqual(renewalArtifacts(filePath), []);
    assert.equal(acquired.operation, 'after-dead-renewal');
    assert.equal(locks.releaseWorkspaceMutationLease(acquired), true);
});

test('acquisition never steals a stable live renewal transaction', async (t) => {
    const filePath = locks.WORKSPACE_START_LOCK_PATH;
    const lease = locks.createWorkspaceMutationLease({ operation: 'live-renewal-acquire-owner' });
    assert.equal(locks.renewWorkspaceMutationLease(lease, { ttlMs: 60_000 }, {
        afterRenewalReplace() { throw new Error('pause live renewal after replacement'); },
    }), false);
    const before = snapshotLockNamespace(filePath);
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));

    await assert.rejects(
        () => locks.acquireWorkspaceMutationLease({
            operation: 'must-not-steal-live-renewal',
            waitTimeoutMs: 140,
            retryIntervalMs: 10,
        }),
        (error) => error?.code === 'workspace_mutation_lock_timeout',
    );
    assert.deepEqual(snapshotLockNamespace(filePath), before);
});

test('acquisition resets dead-publication stability when the exact fingerprint changes', async (t) => {
    const containerName = 'changing-dead-publication';
    const filePath = lockFile(containerName);
    const seed = locks.createMaintenanceLock(containerName, { operation: 'changing-seed' });
    assert.equal(locks.removeMaintenanceLock(containerName, seed.token), true);
    const first = provenDeadOwner(seed, {
        operation: 'first-dead-publication',
        token: TOKEN_B,
    });
    const second = provenDeadOwner(seed, {
        operation: 'second-dead-publication',
        token: TOKEN_C,
    });
    const firstClaimPath = `${filePath}.publication-${artifactContentId(first)}.claim`;
    const secondClaimPath = `${filePath}.publication-${artifactContentId(second)}.claim`;
    writeExactRecord(firstClaimPath, first);
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));

    let replacementSnapshot = null;
    const replacement = new Promise((resolve, reject) => {
        setTimeout(() => {
            try {
                fs.unlinkSync(firstClaimPath);
                writeExactRecord(secondClaimPath, second);
                replacementSnapshot = snapshotLockNamespace(filePath);
                resolve();
            } catch (error) {
                reject(error);
            }
        }, 50);
    });
    await assert.rejects(
        () => locks.acquireMaintenanceLock(containerName, {
            operation: 'must-not-use-first-fingerprint',
            waitTimeoutMs: 140,
            retryIntervalMs: 10,
        }),
        (error) => error?.code === 'maintenance_lock_timeout',
    );
    await replacement;
    assert.ok(replacementSnapshot);
    assert.deepEqual(snapshotLockNamespace(filePath), replacementSnapshot);
});

test('maintenance acquisition cannot recover stale publication evidence after its deadline', async (t) => {
    const containerName = 'deadline-dead-publication';
    const filePath = lockFile(containerName);
    const seed = locks.createMaintenanceLock(containerName, { operation: 'deadline-seed' });
    assert.equal(locks.removeMaintenanceLock(containerName, seed.token), true);
    const stale = provenDeadOwner(seed, {
        operation: 'deadline-dead-owner',
        token: TOKEN_B,
    });
    const claimPath = `${filePath}.publication-${artifactContentId(stale)}.claim`;
    writeExactRecord(claimPath, stale);
    const before = snapshotLockNamespace(filePath);
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));

    await assert.rejects(
        () => locks.acquireMaintenanceLock(containerName, {
            operation: 'deadline-loser',
            waitTimeoutMs: 50,
            retryIntervalMs: 120,
        }),
        (error) => error?.code === 'maintenance_lock_timeout',
    );
    assert.deepEqual(snapshotLockNamespace(filePath), before);
});

test('workspace acquisition cannot recover stale publication evidence after its deadline', async (t) => {
    const filePath = locks.WORKSPACE_START_LOCK_PATH;
    const seed = locks.createWorkspaceMutationLease({ operation: 'deadline-workspace-seed' });
    assert.equal(locks.releaseWorkspaceMutationLease(seed), true);
    const stale = provenDeadOwner(seed, {
        operation: 'deadline-workspace-dead-owner',
        token: TOKEN_B,
    });
    const claimPath = `${filePath}.publication-${artifactContentId(stale)}.claim`;
    writeExactRecord(claimPath, stale);
    const before = snapshotLockNamespace(filePath);
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));

    await assert.rejects(
        () => locks.acquireWorkspaceMutationLease({
            operation: 'deadline-workspace-loser',
            waitTimeoutMs: 50,
            retryIntervalMs: 120,
        }),
        (error) => error?.code === 'workspace_mutation_lock_timeout',
    );
    assert.deepEqual(snapshotLockNamespace(filePath), before);
});

test('a retry that crosses its deadline during classification cannot recover either lock kind', () => {
    for (const kind of ['maintenance', 'workspace']) {
        runIsolatedLockScenario(`
            const kind = ${JSON.stringify(kind)};
            const { createHash } = await import('node:crypto');
            const containerName = 'classification-deadline';
            const seed = kind === 'maintenance'
                ? locks.createMaintenanceLock(containerName, { operation: 'deadline-seed' })
                : locks.createWorkspaceMutationLease({ operation: 'deadline-seed' });
            if (kind === 'maintenance') {
                assert.equal(locks.removeMaintenanceLock(containerName, seed.token), true);
            } else {
                assert.equal(locks.releaseWorkspaceMutationLease(seed), true);
            }
            const stale = {
                ...seed,
                operation: 'classification-dead-owner',
                ownerPid: 0x7fffffff,
                token: '22222222-2222-4222-8222-222222222222',
            };
            const bytes = JSON.stringify(stale) + '\\n';
            const contentId = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
            const filePath = kind === 'maintenance'
                ? path.join(
                    path.dirname(locks.WORKSPACE_START_LOCK_PATH),
                    'maintenance',
                    containerName + '.json',
                )
                : locks.WORKSPACE_START_LOCK_PATH;
            const claimPath = filePath + '.publication-' + contentId + '.claim';
            fs.writeFileSync(claimPath, bytes, { flag: 'wx', mode: 0o600 });
            const targetDirectory = path.dirname(filePath);
            const originalReaddirSync = fs.readdirSync;
            let targetReads = 0;
            fs.readdirSync = function(targetPath, ...args) {
                if (path.resolve(targetPath) === path.resolve(targetDirectory)) {
                    targetReads += 1;
                    if (targetReads === 2) {
                        const releaseAt = Date.now() + 1_100;
                        while (Date.now() < releaseAt) {}
                    }
                }
                return originalReaddirSync.call(this, targetPath, ...args);
            };
            try {
                await assert.rejects(
                    () => kind === 'maintenance'
                        ? locks.acquireMaintenanceLock(containerName, {
                            operation: 'deadline-loser',
                            waitTimeoutMs: 1_000,
                            retryIntervalMs: 40,
                        })
                        : locks.acquireWorkspaceMutationLease({
                            operation: 'deadline-loser',
                            waitTimeoutMs: 1_000,
                            retryIntervalMs: 40,
                        }),
                    (error) => error?.code === (kind === 'maintenance'
                        ? 'maintenance_lock_timeout'
                        : 'workspace_mutation_lock_timeout'),
                );
            } finally {
                fs.readdirSync = originalReaddirSync;
            }
            assert.ok(targetReads >= 2);
            assert.equal(fs.readFileSync(claimPath, 'utf8'), bytes);
            assert.equal(fs.existsSync(filePath), false);
        `);
    }
});

test('acquisition never auto-recovers exact-release evidence from lock-owner death alone', async (t) => {
    const containerName = 'dead-owner-live-releaser';
    const filePath = lockFile(containerName);
    const seed = locks.createMaintenanceLock(containerName, { operation: 'release-seed' });
    assert.equal(locks.removeMaintenanceLock(containerName, seed.token), true);
    const stale = provenDeadOwner(seed, {
        operation: 'authority-owned-by-dead-process',
        token: TOKEN_B,
    });
    writeExactRecord(filePath, stale);
    const claimPath = `${filePath}.operation-${artifactContentId(stale)}.claim`;
    fs.linkSync(filePath, claimPath);
    const before = snapshotLockNamespace(filePath);
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));

    await assert.rejects(
        () => locks.acquireMaintenanceLock(containerName, {
            operation: 'must-not-steal-live-releaser',
            waitTimeoutMs: 140,
            retryIntervalMs: 10,
        }),
        (error) => error?.code === 'maintenance_lock_timeout',
    );
    assert.deepEqual(snapshotLockNamespace(filePath), before);
});

test('creation preserves exact-release evidence that appears after its first admission snapshot', () => {
    for (const kind of ['maintenance', 'workspace']) {
        const containerName = `post-admission-release-${kind}`;
        const filePath = kind === 'maintenance'
            ? lockFile(containerName)
            : locks.WORKSPACE_START_LOCK_PATH;
        const seed = kind === 'maintenance'
            ? locks.createMaintenanceLock(containerName, { operation: 'post-admission-seed' })
            : locks.createWorkspaceMutationLease({ operation: 'post-admission-seed' });
        if (kind === 'maintenance') {
            assert.equal(locks.removeMaintenanceLock(containerName, seed.token), true);
        } else {
            assert.equal(locks.releaseWorkspaceMutationLease(seed), true);
        }
        const stale = provenDeadOwner(seed, {
            operation: 'post-admission-dead-owner',
            token: TOKEN_B,
        });
        writeExactRecord(filePath, stale);
        const claimPath = `${filePath}.operation-${artifactContentId(stale)}.claim`;
        let installed = false;
        let before = null;
        const dependencyOverrides = {
            afterAcquisitionAdmission() {
                if (installed) return;
                installed = true;
                fs.linkSync(filePath, claimPath);
                before = snapshotLockNamespace(filePath);
            },
        };
        try {
            assert.throws(
                () => kind === 'maintenance'
                    ? locks.createMaintenanceLock(
                        containerName,
                        { operation: 'post-admission-loser' },
                        dependencyOverrides,
                    )
                    : locks.createWorkspaceMutationLease(
                        { operation: 'post-admission-loser' },
                        dependencyOverrides,
                    ),
                (error) => error?.code === (kind === 'maintenance'
                    ? 'PLOINKY_MAINTENANCE_BUSY'
                    : 'PLOINKY_WORKSPACE_MUTATION_BUSY')
                    && error.concurrentLockArtifacts === true,
            );
            assert.equal(installed, true);
            assert.ok(before);
            assert.deepEqual(snapshotLockNamespace(filePath), before);
        } finally {
            removeLockPaths(lockNamespacePaths(filePath));
        }
    }
});

test('renewal accepts exact applied-EIO candidate link, primary retirement, and final claim unlink', () => {
    const cases = [
        {
            name: 'candidate-link',
            method: 'link',
            matches: (_source, destination) => destination.startsWith(
                `${locks.WORKSPACE_START_LOCK_PATH}.renewal-`,
            ) && destination.endsWith('.candidate'),
        },
        {
            name: 'primary-retirement-unlink',
            method: 'unlink',
            matches: (targetPath) => targetPath === locks.WORKSPACE_START_LOCK_PATH,
        },
        {
            name: 'final-claim-unlink',
            method: 'unlink',
            matches: (targetPath) => targetPath.startsWith(
                `${locks.WORKSPACE_START_LOCK_PATH}.renewal-`,
            ) && targetPath.endsWith('.claim'),
        },
    ];
    for (const testCase of cases) {
        const lease = locks.createWorkspaceMutationLease({ operation: `applied-eio-${testCase.name}` });
        const previousExpiresAt = lease.expiresAt;
        const { faultingFs, state } = appliedThenEioFs(testCase.method, testCase.matches);
        assert.equal(locks.renewWorkspaceMutationLease(
            lease,
            { ttlMs: 48 * 60 * 60 * 1000 },
            { fs: faultingFs },
        ), true, testCase.name);
        assert.equal(state.injected, true, testCase.name);
        assert.notEqual(lease.expiresAt, previousExpiresAt, testCase.name);
        assert.equal(locks.inspectWorkspaceStartLock().lock.token, lease.token, testCase.name);
        assert.deepEqual(renewalArtifacts(locks.WORKSPACE_START_LOCK_PATH), [], testCase.name);
        assert.equal(locks.releaseWorkspaceMutationLease(lease), true, testCase.name);
    }
});

test('renewal preserves recoverable evidence when applied-EIO proof also fails', (t) => {
    const filePath = locks.WORKSPACE_START_LOCK_PATH;
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));
    const cases = [
        {
            name: 'candidate-link-proof',
            method: 'link',
            matches: (_source, destination) => destination.startsWith(
                `${locks.WORKSPACE_START_LOCK_PATH}.renewal-`,
            ) && destination.endsWith('.candidate'),
        },
        {
            name: 'primary-retirement-proof',
            method: 'unlink',
            matches: (targetPath) => targetPath === locks.WORKSPACE_START_LOCK_PATH,
        },
    ];
    for (const testCase of cases) {
        const lease = locks.createWorkspaceMutationLease({ operation: testCase.name });
        const originalFs = fs;
        let proofPath;
        const matches = (...args) => {
            const matched = testCase.matches(...args);
            if (matched) proofPath = args.at(-1);
            return matched;
        };
        const state = { injected: false, proofInjected: false };
        const property = `${testCase.method}Sync`;
        const faultingFs = new Proxy(originalFs, {
            get(target, requested, receiver) {
                if (requested === property) {
                    return (...args) => {
                        const inject = !state.injected && matches(...args);
                        const result = target[property](...args);
                        if (inject) {
                            state.injected = true;
                            throw Object.assign(new Error('injected applied mutation EIO'), { code: 'EIO' });
                        }
                        return result;
                    };
                }
                if (requested === 'lstatSync') {
                    return (targetPath, ...args) => {
                        if (state.injected && !state.proofInjected && targetPath === proofPath) {
                            state.proofInjected = true;
                            throw Object.assign(new Error('injected proof lstat EIO'), { code: 'EIO' });
                        }
                        return target.lstatSync(targetPath, ...args);
                    };
                }
                return Reflect.get(target, requested, receiver);
            },
        });
        assert.equal(locks.renewWorkspaceMutationLease(
            lease,
            { ttlMs: 48 * 60 * 60 * 1000 },
            { fs: faultingFs },
        ), false, testCase.name);
        assert.equal(state.injected, true, testCase.name);
        assert.equal(state.proofInjected, true, testCase.name);
        const before = snapshotLockNamespace(filePath);
        assert.throws(
            () => locks.inspectWorkspaceStartLock(),
            (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY'
                && error.owner?.token === lease.token,
            testCase.name,
        );
        assert.deepEqual(snapshotLockNamespace(filePath), before, testCase.name);
        const recovered = locks.inspectWorkspaceStartLock({
            inspectProcessIdentity: () => ({ state: 'dead' }),
        });
        assert.equal(recovered.active, false, testCase.name);
        assert.deepEqual(renewalArtifacts(filePath), [], testCase.name);
        assert.equal(fs.existsSync(filePath), false, testCase.name);
    }
});

test('workspace renewal never overwrites a successor installed after its old-owner claim', () => {
    const lease = locks.createWorkspaceMutationLease({ operation: 'renewal-old-owner' });
    const successor = { ...lease, operation: 'renewal-successor', token: TOKEN_B };
    const renewed = locks.renewWorkspaceMutationLease(lease, { ttlMs: 48 * 60 * 60 * 1000 }, {
        afterRenewalClaim() {
            fs.unlinkSync(locks.WORKSPACE_START_LOCK_PATH);
            writeExactRecord(locks.WORKSPACE_START_LOCK_PATH, successor);
        },
    });
    assert.equal(renewed, false);
    assert.equal(fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH, 'utf8'), exactRecordBytes(successor));
    assert.equal(fs.lstatSync(locks.WORKSPACE_START_LOCK_PATH).nlink, 1);
    assert.deepEqual(renewalArtifacts(locks.WORKSPACE_START_LOCK_PATH), []);
    assert.equal(locks.renewWorkspaceMutationLease(lease), false);
    assert.equal(locks.releaseWorkspaceMutationLease(lease), false);
    assert.equal(locks.inspectWorkspaceStartLock().lock.token, successor.token);
    assert.equal(locks.releaseWorkspaceMutationLease(successor), true);
});

test('workspace renewal P3 collision stays bounded and fail-closed until displaced P2 is reused', () => {
    let displacedReused = false;
    let raced = false;
    let restoreRaced = false;
    const inspectExactOwner = (pid) => {
        if (pid === process.pid) return identified(IDENTITY_CURRENT);
        if (pid === 43_003) return identified(displacedReused ? IDENTITY_B : IDENTITY_A);
        if (pid === 44_004) return identified(IDENTITY_B);
        return { state: 'dead' };
    };
    const dependencyOverrides = { inspectProcessIdentity: inspectExactOwner };
    const lease = locks.createWorkspaceMutationLease(
        { operation: 'renewal-p1' },
        dependencyOverrides,
    );
    const displacedP2 = {
        ...lease,
        operation: 'renewal-p2',
        ownerPid: 43_003,
        ownerStartIdentity: IDENTITY_A,
        token: TOKEN_B,
    };
    const canonicalP3 = {
        ...lease,
        operation: 'renewal-p3',
        ownerPid: 44_004,
        ownerStartIdentity: IDENTITY_B,
        token: TOKEN_C,
    };
    const racingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    if (!raced && source === locks.WORKSPACE_START_LOCK_PATH
                        && destination.startsWith(`${locks.WORKSPACE_START_LOCK_PATH}.renewal-`)
                        && destination.endsWith('.quarantine')) {
                        target.unlinkSync(locks.WORKSPACE_START_LOCK_PATH);
                        writeExactRecord(locks.WORKSPACE_START_LOCK_PATH, displacedP2);
                        raced = true;
                    }
                    if (!restoreRaced && source.startsWith(`${locks.WORKSPACE_START_LOCK_PATH}.renewal-`)
                        && source.endsWith('.quarantine')
                        && destination === locks.WORKSPACE_START_LOCK_PATH) {
                        writeExactRecord(locks.WORKSPACE_START_LOCK_PATH, canonicalP3);
                        restoreRaced = true;
                    }
                    target.linkSync(source, destination);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.equal(locks.renewWorkspaceMutationLease(
        lease,
        { ttlMs: 48 * 60 * 60 * 1000 },
        { fs: racingFs, ...dependencyOverrides },
    ), false);
    assert.equal(raced, true);
    assert.equal(restoreRaced, true);
    assert.equal(fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH, 'utf8'), exactRecordBytes(canonicalP3));
    const durableCollision = renewalArtifacts(locks.WORKSPACE_START_LOCK_PATH);
    assert.equal(durableCollision.length, 3);
    const collisionSnapshot = snapshotLockNamespace(locks.WORKSPACE_START_LOCK_PATH);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.throws(
            () => locks.inspectWorkspaceStartLock(dependencyOverrides),
            (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY'
                && error.owner?.token === displacedP2.token,
        );
        assert.deepEqual(snapshotLockNamespace(locks.WORKSPACE_START_LOCK_PATH), collisionSnapshot);
    }
    for (const exactOwner of [lease, displacedP2, canonicalP3]) {
        assert.throws(
            () => locks.releaseWorkspaceMutationLease(exactOwner, dependencyOverrides),
            (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY'
                && error.owner?.token === displacedP2.token,
        );
        assert.deepEqual(snapshotLockNamespace(locks.WORKSPACE_START_LOCK_PATH), collisionSnapshot);
    }
    assert.throws(
        () => locks.renewWorkspaceMutationLease(lease, {}, dependencyOverrides),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY'
            && error.owner?.token === displacedP2.token,
    );
    assert.deepEqual(snapshotLockNamespace(locks.WORKSPACE_START_LOCK_PATH), collisionSnapshot);

    displacedReused = true;
    const cleanupOrder = ['quarantine', 'candidate', 'claim'];
    const injectedCleanup = new Set();
    const cleanupFaultFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'unlinkSync') {
                return (targetPath) => {
                    const suffix = cleanupOrder.find((candidate) => targetPath.startsWith(
                        `${locks.WORKSPACE_START_LOCK_PATH}.renewal-`,
                    ) && targetPath.endsWith(`.${candidate}`));
                    target.unlinkSync(targetPath);
                    if (suffix && !injectedCleanup.has(suffix)) {
                        injectedCleanup.add(suffix);
                        throw Object.assign(new Error(`injected ${suffix} cleanup EIO`), { code: 'EIO' });
                    }
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const recovered = locks.inspectWorkspaceStartLock({ fs: cleanupFaultFs, ...dependencyOverrides });
    assert.deepEqual([...injectedCleanup], cleanupOrder);
    assert.deepEqual(renewalArtifacts(locks.WORKSPACE_START_LOCK_PATH), []);
    assert.equal(recovered.active, true);
    assert.equal(recovered.lock.token, canonicalP3.token);
    assert.deepEqual(renewalArtifacts(locks.WORKSPACE_START_LOCK_PATH), []);
    assert.equal(locks.releaseWorkspaceMutationLease(canonicalP3, dependencyOverrides), true);
    const fresh = locks.createWorkspaceMutationLease({ operation: 'renewal-fresh' }, dependencyOverrides);
    assert.equal(locks.releaseWorkspaceMutationLease(fresh, dependencyOverrides), true);
});

test('malformed workspace leases fail closed permanently instead of using a tolerant stale reader', (t) => {
    t.after(() => fs.rmSync(locks.WORKSPACE_START_LOCK_PATH, { force: true }));
    fs.mkdirSync(path.dirname(locks.WORKSPACE_START_LOCK_PATH), { recursive: true });
    fs.writeFileSync(locks.WORKSPACE_START_LOCK_PATH, '{malformed', { mode: 0o600 });
    assert.throws(
        () => locks.inspectWorkspaceStartLock(),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID',
    );
    const stale = new Date(Date.now() - 6_000);
    fs.utimesSync(locks.WORKSPACE_START_LOCK_PATH, stale, stale);
    assert.throws(
        () => locks.createWorkspaceMutationLease(),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID',
    );
    assert.equal(fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH, 'utf8'), '{malformed');
});

test('with-lock helpers surface exact-release failure and preserve replacement owners', async () => {
    const containerName = 'replacement-container';
    const filePath = lockFile(containerName);
    let replacement;
    await assert.rejects(
        () => locks.withMaintenanceLock(containerName, { operation: 'first' }, async () => {
            const current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            replacement = { ...current, token: TOKEN_B };
            fs.unlinkSync(filePath);
            writeExactRecord(filePath, replacement);
        }),
        (error) => error?.code === 'maintenance_lock_release_failed',
    );
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).token, replacement.token);
    assert.equal(locks.removeMaintenanceLock(containerName, replacement.token), true);

    let workspaceReplacement;
    await assert.rejects(
        () => locks.withWorkspaceMutationLease({ operation: 'helper-release-race' }, async () => {
            const current = JSON.parse(fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH, 'utf8'));
            workspaceReplacement = { ...current, token: TOKEN_B };
            fs.unlinkSync(locks.WORKSPACE_START_LOCK_PATH);
            writeExactRecord(locks.WORKSPACE_START_LOCK_PATH, workspaceReplacement);
        }),
        (error) => error?.code === 'workspace_mutation_lock_release_failed',
    );
    assert.equal(
        JSON.parse(fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH, 'utf8')).token,
        workspaceReplacement.token,
    );
    assert.equal(locks.releaseWorkspaceMutationLease(workspaceReplacement), true);
});

test('exact-token release rejects a valid foreign token without touching either lock kind', () => {
    const containerName = 'exact-token-container';
    const maintenance = locks.createMaintenanceLock(containerName, { operation: 'restart' });
    assert.equal(locks.removeMaintenanceLock(containerName, TOKEN_B), false);
    assert.equal(locks.inspectMaintenanceLock(containerName).lock.token, maintenance.token);
    assert.equal(locks.removeMaintenanceLock(containerName, maintenance.token.toUpperCase()), false);
    assert.equal(locks.removeMaintenanceLock(containerName, maintenance.token), true);

    const workspaceLease = locks.createWorkspaceMutationLease({ operation: 'exact-token-workspace' });
    assert.equal(locks.releaseWorkspaceMutationLease({ ...workspaceLease, token: TOKEN_B }), false);
    assert.equal(locks.inspectWorkspaceStartLock().lock.token, workspaceLease.token);
    assert.equal(locks.releaseWorkspaceMutationLease(workspaceLease), true);
});

test('maintenance release never unlinks a successor published after source retirement', () => {
    const containerName = 'successor-after-rename';
    const filePath = lockFile(containerName);
    const first = locks.createMaintenanceLock(containerName, { operation: 'first' });
    let successor;
    const released = locks.removeMaintenanceLock(containerName, first.token, {
        afterPrimaryRelease({ released: oldRecord }) {
            successor = { ...oldRecord, token: TOKEN_B, operation: 'successor' };
            writeExactRecord(filePath, successor);
        },
    });
    assert.equal(released, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(successor));
    assert.deepEqual(releaseArtifacts(filePath), []);
    assert.equal(locks.removeMaintenanceLock(containerName, successor.token), true);
});

test('exact release accepts a final private unlink that applies before EIO', () => {
    const containerName = 'release-final-unlink-applied-eio';
    const filePath = lockFile(containerName);
    const lock = locks.createMaintenanceLock(containerName, { operation: 'release-applied-eio' });
    const { faultingFs, state } = appliedThenEioFs(
        'unlink',
        (targetPath) => targetPath.startsWith(`${filePath}.operation-`)
            && targetPath.endsWith('.claim'),
    );
    assert.equal(locks.removeMaintenanceLock(containerName, lock.token, { fs: faultingFs }), true);
    assert.equal(state.injected, true);
    assert.equal(fs.existsSync(filePath), false);
    assert.deepEqual(releaseArtifacts(filePath), []);
});

test('exact release replays a committed final unlink when its proof also fails', () => {
    const containerName = 'release-final-unlink-proof-eio';
    const filePath = lockFile(containerName);
    const lock = locks.createMaintenanceLock(containerName, { operation: 'release-proof-eio' });
    let claimPath;
    const state = { injected: false, proofInjected: false };
    const faultingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'unlinkSync') {
                return (targetPath) => {
                    const inject = !state.injected
                        && targetPath.startsWith(`${filePath}.operation-`)
                        && targetPath.endsWith('.claim');
                    const result = target.unlinkSync(targetPath);
                    if (inject) {
                        claimPath = targetPath;
                        state.injected = true;
                        throw Object.assign(new Error('injected final unlink EIO'), { code: 'EIO' });
                    }
                    return result;
                };
            }
            if (property === 'lstatSync') {
                return (targetPath, ...args) => {
                    if (state.injected && !state.proofInjected && targetPath === claimPath) {
                        state.proofInjected = true;
                        throw Object.assign(new Error('injected final unlink proof EIO'), { code: 'EIO' });
                    }
                    return target.lstatSync(targetPath, ...args);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.equal(locks.removeMaintenanceLock(containerName, lock.token, { fs: faultingFs }), true);
    assert.equal(state.injected, true);
    assert.equal(state.proofInjected, true);
    assert.equal(fs.existsSync(filePath), false);
    assert.deepEqual(releaseArtifacts(filePath), []);
});

test('workspace release never unlinks a successor published after source retirement', () => {
    const first = locks.createWorkspaceMutationLease({ operation: 'first-workspace-owner' });
    let successor;
    const released = locks.releaseWorkspaceMutationLease(first, {
        afterPrimaryRelease({ released: oldRecord }) {
            successor = { ...oldRecord, token: TOKEN_B, operation: 'successor-workspace-owner' };
            writeExactRecord(locks.WORKSPACE_START_LOCK_PATH, successor);
        },
    });
    assert.equal(released, true);
    assert.equal(fs.readFileSync(locks.WORKSPACE_START_LOCK_PATH, 'utf8'), exactRecordBytes(successor));
    assert.deepEqual(releaseArtifacts(locks.WORKSPACE_START_LOCK_PATH), []);
    assert.equal(locks.releaseWorkspaceMutationLease(successor), true);
});

test('hard-link publication reports EEXIST and preserves the concurrent exact owner', () => {
    const containerName = 'publication-eexist';
    const filePath = lockFile(containerName);
    let successor;
    assert.throws(
        () => locks.createMaintenanceLock(containerName, { operation: 'candidate' }, {
            beforePublish({ record }) {
                successor = { ...record, token: TOKEN_B, operation: 'concurrent-successor' };
                writeExactRecord(filePath, successor);
            },
        }),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
            && error.owner?.token === successor.token
            && error.owner?.operation === successor.operation,
    );
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(successor));
    assert.equal(locks.removeMaintenanceLock(containerName, successor.token), true);
});

test('publication loser recognizes an exact winner before its private claim retires', () => {
    const containerName = 'publication-in-flight-winner';
    const filePath = lockFile(containerName);
    let successor;
    let successorClaimPath = '';
    let injected = false;
    const racingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    if (!injected
                        && destination === filePath
                        && source.startsWith(`${filePath}.publication-`)) {
                        injected = true;
                        const candidate = JSON.parse(target.readFileSync(source, 'utf8'));
                        successor = {
                            ...candidate,
                            token: TOKEN_B,
                            operation: 'concurrent-in-flight-winner',
                        };
                        const bytes = exactRecordBytes(successor);
                        const contentId = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
                        successorClaimPath = `${filePath}.publication-${contentId}.claim`;
                        writeExactRecord(successorClaimPath, successor);
                        target.linkSync(successorClaimPath, filePath);
                    }
                    return target.linkSync(source, destination);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });

    assert.throws(
        () => locks.createMaintenanceLock(
            containerName,
            { operation: 'losing-candidate' },
            { fs: racingFs },
        ),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
            && error.owner?.token === successor.token
            && error.owner?.operation === successor.operation,
    );
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(successor));
    assert.deepEqual(publicationArtifacts(filePath), [path.basename(successorClaimPath)]);

    // Finish the simulated winning publication, then release its canonical
    // authority through the normal exact-token path.
    fs.unlinkSync(successorClaimPath);
    assert.equal(locks.removeMaintenanceLock(containerName, successor.token), true);
    assert.deepEqual(publicationArtifacts(filePath), []);
});

function retiringWinnerClaimFs(filePath, { token, operation }) {
    const state = {
        installed: false,
        retiredAfterOpen: false,
        successor: null,
        successorClaimPath: '',
    };
    const racingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    if (!state.installed
                        && destination === filePath
                        && source.startsWith(`${filePath}.publication-`)) {
                        state.installed = true;
                        const candidate = JSON.parse(target.readFileSync(source, 'utf8'));
                        state.successor = { ...candidate, token, operation };
                        const bytes = exactRecordBytes(state.successor);
                        const contentId = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
                        state.successorClaimPath = `${filePath}.publication-${contentId}.claim`;
                        writeExactRecord(state.successorClaimPath, state.successor);
                        target.linkSync(state.successorClaimPath, filePath);
                    }
                    return target.linkSync(source, destination);
                };
            }
            if (property === 'openSync') {
                return (targetPath, ...args) => {
                    const descriptor = target.openSync(targetPath, ...args);
                    if (!state.retiredAfterOpen && targetPath === state.successorClaimPath) {
                        target.unlinkSync(state.successorClaimPath);
                        state.retiredAfterOpen = true;
                    }
                    return descriptor;
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    return { racingFs, state };
}

test('maintenance publication reports settling BUSY when a winner retires its claim after open', (t) => {
    const containerName = 'publication-winner-retires-after-open';
    const filePath = lockFile(containerName);
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));
    const { racingFs, state } = retiringWinnerClaimFs(filePath, {
        token: TOKEN_B,
        operation: 'retiring-maintenance-winner',
    });

    assert.throws(
        () => locks.createMaintenanceLock(
            containerName,
            { operation: 'losing-maintenance-candidate' },
            { fs: racingFs },
        ),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
            && error.concurrentLockArtifacts === true,
    );
    assert.equal(state.installed, true);
    assert.equal(state.retiredAfterOpen, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(state.successor));
    assert.equal(fs.lstatSync(filePath).nlink, 1);
    assert.deepEqual(publicationArtifacts(filePath), []);
    assert.equal(locks.removeMaintenanceLock(containerName, state.successor.token), true);
});

test('workspace publication reports settling BUSY when a winner retires its claim after open', (t) => {
    const filePath = locks.WORKSPACE_START_LOCK_PATH;
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));
    const { racingFs, state } = retiringWinnerClaimFs(filePath, {
        token: TOKEN_C,
        operation: 'retiring-workspace-winner',
    });

    assert.throws(
        () => locks.createWorkspaceMutationLease(
            { operation: 'losing-workspace-candidate' },
            { fs: racingFs },
        ),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY'
            && error.concurrentLockArtifacts === true,
    );
    assert.equal(state.installed, true);
    assert.equal(state.retiredAfterOpen, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(state.successor));
    assert.equal(fs.lstatSync(filePath).nlink, 1);
    assert.deepEqual(publicationArtifacts(filePath), []);
    assert.equal(locks.releaseWorkspaceMutationLease(state.successor), true);
});

function pausedPublicationClaim(filePath, candidate, { token, operation }) {
    const successor = { ...candidate, token, operation };
    const bytes = exactRecordBytes(successor);
    const contentId = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const claimPath = `${filePath}.publication-${contentId}.claim`;
    writeExactRecord(claimPath, successor);
    return { claimPath, successor };
}

test('publication admission preserves live workspace renewal N3 as exact BUSY evidence', (t) => {
    const filePath = locks.WORKSPACE_START_LOCK_PATH;
    let renewal;
    let before = null;
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));

    assert.throws(
        () => locks.createWorkspaceMutationLease(
            { operation: 'losing-renewal-n3-admission' },
            {
                beforePublicationAdmission({ record }) {
                    const previous = {
                        ...record,
                        operation: 'live-renewal-n3-owner',
                        token: TOKEN_B,
                    };
                    renewal = installWorkspaceRenewalState(previous, 'N3');
                    const claim = fs.lstatSync(renewal.claimPath);
                    const quarantine = fs.lstatSync(renewal.quarantinePath);
                    assert.equal(fs.existsSync(filePath), false);
                    assert.equal(claim.nlink, 2);
                    assert.equal(quarantine.nlink, 2);
                    assert.equal(claim.dev, quarantine.dev);
                    assert.equal(claim.ino, quarantine.ino);
                    assert.equal(fs.lstatSync(renewal.candidatePath).nlink, 1);
                    before = snapshotLockNamespace(filePath);
                },
            },
        ),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY'
            && error.owner?.token === TOKEN_B,
    );
    assert.ok(before);
    assert.deepEqual(snapshotLockNamespace(filePath), before);
    assert.throws(
        () => locks.inspectWorkspaceStartLock(),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY'
            && error.owner?.token === TOKEN_B,
    );
    assert.deepEqual(snapshotLockNamespace(filePath), before);
});

test('publication admission preserves live workspace renewal N4 as exact BUSY evidence', (t) => {
    const filePath = locks.WORKSPACE_START_LOCK_PATH;
    let renewal;
    let before = null;
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));

    assert.throws(
        () => locks.createWorkspaceMutationLease(
            { operation: 'losing-renewal-n4-admission' },
            {
                beforePublicationAdmission({ record }) {
                    const previous = {
                        ...record,
                        operation: 'live-renewal-n4-owner',
                        token: TOKEN_B,
                    };
                    renewal = installWorkspaceRenewalState(previous, 'N4');
                    const claim = fs.lstatSync(renewal.claimPath);
                    const quarantine = fs.lstatSync(renewal.quarantinePath);
                    const candidate = fs.lstatSync(renewal.candidatePath);
                    const canonical = fs.lstatSync(filePath);
                    assert.equal(claim.nlink, 2);
                    assert.equal(quarantine.nlink, 2);
                    assert.equal(claim.dev, quarantine.dev);
                    assert.equal(claim.ino, quarantine.ino);
                    assert.equal(candidate.nlink, 2);
                    assert.equal(canonical.nlink, 2);
                    assert.equal(candidate.dev, canonical.dev);
                    assert.equal(candidate.ino, canonical.ino);
                    before = snapshotLockNamespace(filePath);
                },
            },
        ),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY'
            && error.owner?.token === TOKEN_B,
    );
    assert.ok(before);
    assert.deepEqual(snapshotLockNamespace(filePath), before);
    assert.throws(
        () => locks.inspectWorkspaceStartLock(),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY'
            && error.owner?.token === TOKEN_B,
    );
    assert.deepEqual(snapshotLockNamespace(filePath), before);
});

test('maintenance publication admission reports a live paused publisher as busy', () => {
    const containerName = 'publication-admission-maintenance';
    const filePath = lockFile(containerName);
    let paused;
    assert.throws(
        () => locks.createMaintenanceLock(
            containerName,
            { operation: 'losing-admission-candidate' },
            {
                beforePublicationAdmission({ record }) {
                    paused = pausedPublicationClaim(filePath, record, {
                        token: TOKEN_B,
                        operation: 'paused-maintenance-publisher',
                    });
                },
            },
        ),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
            && error.owner?.token === paused.successor.token,
    );
    assert.equal(fs.readFileSync(paused.claimPath, 'utf8'), exactRecordBytes(paused.successor));
    assert.equal(fs.existsSync(filePath), false);
    fs.unlinkSync(paused.claimPath);
});

test('workspace publication admission preserves an exact live claim as busy', (t) => {
    const filePath = locks.WORKSPACE_START_LOCK_PATH;
    let paused;
    let before = null;
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));
    assert.throws(
        () => locks.createWorkspaceMutationLease(
            { operation: 'losing-workspace-admission' },
            {
                beforePublicationAdmission({ record }) {
                    paused = pausedPublicationClaim(filePath, record, {
                        token: TOKEN_C,
                        operation: 'paused-workspace-publisher',
                    });
                    assert.equal(fs.existsSync(filePath), false);
                    assert.equal(fs.lstatSync(paused.claimPath).nlink, 1);
                    before = snapshotLockNamespace(filePath);
                },
            },
        ),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY'
            && error.owner?.token === TOKEN_C,
    );
    assert.ok(before);
    assert.deepEqual(snapshotLockNamespace(filePath), before);
    assert.equal(fs.readFileSync(paused.claimPath, 'utf8'), exactRecordBytes(paused.successor));
    assert.equal(fs.existsSync(filePath), false);
});

test('publication collision preserves foreign live workspace renewal N4 evidence', (t) => {
    const filePath = locks.WORKSPACE_START_LOCK_PATH;
    let renewal;
    let before = null;
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));

    assert.throws(
        () => locks.createWorkspaceMutationLease(
            { operation: 'publication-colliding-with-renewal-n4' },
            {
                beforePublish({ record }) {
                    const previous = {
                        ...record,
                        operation: 'foreign-live-renewal-n4',
                        token: TOKEN_B,
                    };
                    renewal = installWorkspaceRenewalState(previous, 'N4');
                    before = snapshotLockPaths(renewal.paths);
                },
            },
        ),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY'
            && error.owner?.token === TOKEN_B,
    );
    assert.ok(before);
    assert.deepEqual(snapshotLockPaths(renewal.paths), before);
    assert.deepEqual(publicationArtifacts(filePath), []);
    assert.throws(
        () => locks.inspectWorkspaceStartLock(),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_BUSY'
            && error.owner?.token === TOKEN_B,
    );
    assert.deepEqual(snapshotLockPaths(renewal.paths), before);
});

test('publication collision reports an exact concurrent release as busy', () => {
    const containerName = 'publication-collides-release';
    const filePath = lockFile(containerName);
    let successor;
    let operationClaimPath;
    assert.throws(
        () => locks.createMaintenanceLock(
            containerName,
            { operation: 'losing-publication' },
            {
                beforePublish({ record }) {
                    successor = {
                        ...record,
                        token: TOKEN_B,
                        operation: 'releasing-successor',
                    };
                    writeExactRecord(filePath, successor);
                    const contentId = createHash('sha256')
                        .update(exactRecordBytes(successor))
                        .digest('hex')
                        .slice(0, 32);
                    operationClaimPath = `${filePath}.operation-${contentId}.claim`;
                    fs.linkSync(filePath, operationClaimPath);
                },
            },
        ),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
            && error.owner?.token === successor.token,
    );
    assert.equal(fs.lstatSync(filePath).nlink, 2);
    assert.deepEqual(publicationArtifacts(filePath), []);
    assert.deepEqual(releaseArtifacts(filePath), [path.basename(operationClaimPath)]);
    fs.unlinkSync(operationClaimPath);
    assert.equal(locks.removeMaintenanceLock(containerName, successor.token), true);
});

test('exact release admission preserves another exact release as busy', (t) => {
    const containerName = 'release-admission-busy';
    const filePath = lockFile(containerName);
    const lock = locks.createMaintenanceLock(containerName, { operation: 'release-owner' });
    let operationClaimPath;
    let before = null;
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));
    assert.throws(
        () => locks.removeMaintenanceLock(containerName, lock.token, {
            beforeExactReleaseAdmission({ snapshot }) {
                const contentId = createHash('sha256').update(snapshot.raw).digest('hex').slice(0, 32);
                operationClaimPath = `${filePath}.operation-${contentId}.claim`;
                fs.linkSync(filePath, operationClaimPath);
                before = snapshotLockNamespace(filePath);
            },
        }),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
            && error.owner?.token === lock.token,
    );
    assert.ok(before);
    assert.deepEqual(snapshotLockNamespace(filePath), before);
    assert.equal(fs.lstatSync(filePath).nlink, 2);
    assert.deepEqual(releaseArtifacts(filePath), [path.basename(operationClaimPath)]);
    fs.unlinkSync(operationClaimPath);
    assert.equal(locks.removeMaintenanceLock(containerName, lock.token), true);
});

test('exact release admission preserves live post-retirement evidence as busy', (t) => {
    const containerName = 'release-admission-post-retirement';
    const filePath = lockFile(containerName);
    const lock = locks.createMaintenanceLock(containerName, { operation: 'release-owner' });
    let claimPath;
    let quarantinePath;
    let before = null;
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));

    assert.throws(
        () => locks.removeMaintenanceLock(containerName, lock.token, {
            beforeExactReleaseAdmission({ snapshot }) {
                const contentId = createHash('sha256').update(snapshot.raw).digest('hex').slice(0, 32);
                claimPath = `${filePath}.operation-${contentId}.claim`;
                quarantinePath = `${filePath}.operation-${contentId}.quarantine`;
                fs.linkSync(filePath, claimPath);
                fs.linkSync(filePath, quarantinePath);
                fs.unlinkSync(filePath);
                const claim = fs.lstatSync(claimPath);
                const quarantine = fs.lstatSync(quarantinePath);
                assert.equal(claim.nlink, 2);
                assert.equal(quarantine.nlink, 2);
                assert.equal(claim.dev, quarantine.dev);
                assert.equal(claim.ino, quarantine.ino);
                assert.equal(fs.existsSync(filePath), false);
                before = snapshotLockNamespace(filePath);
            },
        }),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
            && error.owner?.token === lock.token,
    );
    assert.ok(before);
    assert.deepEqual(snapshotLockNamespace(filePath), before);
    assert.throws(
        () => locks.inspectMaintenanceLock(containerName),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
            && error.owner?.token === lock.token,
    );
    assert.deepEqual(snapshotLockNamespace(filePath), before);
});

test('publication admission preserves an extra-hardlink shape as exact INVALID evidence', (t) => {
    const filePath = locks.WORKSPACE_START_LOCK_PATH;
    const extraPath = `${filePath}.extra-hardlink`;
    let paused;
    let before = null;
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));

    assert.throws(
        () => locks.createWorkspaceMutationLease(
            { operation: 'must-not-admit-extra-hardlink' },
            {
                beforePublicationAdmission({ record }) {
                    paused = pausedPublicationClaim(filePath, record, {
                        token: TOKEN_B,
                        operation: 'extra-hardlink-publisher',
                    });
                    fs.linkSync(paused.claimPath, extraPath);
                    assert.equal(fs.lstatSync(paused.claimPath).nlink, 2);
                    assert.equal(fs.lstatSync(extraPath).nlink, 2);
                    before = snapshotLockNamespace(filePath);
                },
            },
        ),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID',
    );
    assert.ok(before);
    assert.deepEqual(snapshotLockNamespace(filePath), before);
});

test('publication admission preserves mixed transaction families as exact INVALID evidence', (t) => {
    const filePath = locks.WORKSPACE_START_LOCK_PATH;
    let before = null;
    t.after(() => removeLockPaths(lockNamespacePaths(filePath)));

    assert.throws(
        () => locks.createWorkspaceMutationLease(
            { operation: 'must-not-admit-mixed-families' },
            {
                beforePublicationAdmission({ record }) {
                    const releasing = {
                        ...record,
                        operation: 'mixed-family-releaser',
                        token: TOKEN_B,
                    };
                    const publishing = {
                        ...record,
                        operation: 'mixed-family-publisher',
                        token: TOKEN_C,
                    };
                    const releaseClaimPath = `${filePath}.operation-${artifactContentId(releasing)}.claim`;
                    const publicationClaimPath = `${filePath}.publication-${artifactContentId(publishing)}.claim`;
                    writeExactRecord(filePath, releasing);
                    fs.linkSync(filePath, releaseClaimPath);
                    writeExactRecord(publicationClaimPath, publishing);
                    assert.equal(fs.lstatSync(filePath).nlink, 2);
                    assert.equal(fs.lstatSync(releaseClaimPath).nlink, 2);
                    assert.equal(fs.lstatSync(publicationClaimPath).nlink, 1);
                    before = snapshotLockNamespace(filePath);
                },
            },
        ),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID',
    );
    assert.ok(before);
    assert.deepEqual(snapshotLockNamespace(filePath), before);
});

test('publication admission keeps malformed transaction evidence invalid', () => {
    const containerName = 'publication-admission-malformed';
    const filePath = lockFile(containerName);
    const malformedPath = `${filePath}.publication-not-content-exact.claim`;
    assert.throws(
        () => locks.createMaintenanceLock(
            containerName,
            { operation: 'must-not-publish' },
            {
                beforePublicationAdmission() {
                    fs.writeFileSync(malformedPath, '{}\n', { flag: 'wx', mode: 0o600 });
                },
            },
        ),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_LOCK_INVALID'
            && /malformed publication state/.test(error.message),
    );
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(fs.readFileSync(malformedPath, 'utf8'), '{}\n');
    fs.unlinkSync(malformedPath);
});

test('publication returns its committed exact lock when final claim unlink reports EIO after applying', () => {
    const containerName = 'publication-final-unlink-eio';
    const filePath = lockFile(containerName);
    let injected = false;
    const faultingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'unlinkSync') {
                return (targetPath) => {
                    if (!injected && targetPath.startsWith(`${filePath}.publication-`)
                        && targetPath.endsWith('.claim') && target.existsSync(filePath)) {
                        target.unlinkSync(targetPath);
                        injected = true;
                        throw Object.assign(new Error('injected final publication unlink EIO'), { code: 'EIO' });
                    }
                    return target.unlinkSync(targetPath);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const lock = locks.createMaintenanceLock(
        containerName,
        { operation: 'committed-publication' },
        { fs: faultingFs },
    );
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(lock));
    assert.equal(fs.lstatSync(filePath).nlink, 1);
    assert.deepEqual(publicationArtifacts(filePath), []);
    assert.equal(locks.inspectMaintenanceLock(containerName).lock.token, lock.token);
    assert.equal(locks.removeMaintenanceLock(containerName, lock.token), true);
});

test('publication accepts an exact canonical hard link that applies before EIO', () => {
    const containerName = 'publication-canonical-link-applied-eio';
    const filePath = lockFile(containerName);
    const { faultingFs, state } = appliedThenEioFs(
        'link',
        (_source, destination) => destination === filePath,
    );
    const lock = locks.createMaintenanceLock(
        containerName,
        { operation: 'canonical-link-applied-eio' },
        { fs: faultingFs },
    );
    assert.equal(state.injected, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(lock));
    assert.deepEqual(publicationArtifacts(filePath), []);
    assert.equal(locks.removeMaintenanceLock(containerName, lock.token), true);
});

test('publication preserves recognized evidence when canonical-link proof also fails', () => {
    const containerName = 'publication-canonical-link-proof-eio';
    const filePath = lockFile(containerName);
    const { faultingFs, state } = appliedThenProofEioFs(
        'link',
        (_source, destination) => destination === filePath,
        filePath,
    );
    assert.throws(
        () => locks.createMaintenanceLock(
            containerName,
            { operation: 'canonical-link-proof-eio' },
            { fs: faultingFs },
        ),
        (error) => error?.code === 'EIO'
            && error.lockTransitionApplied === true
            && error.lockDurabilityUncertain === true,
    );
    assert.equal(state.injected, true);
    assert.equal(state.proofInjected, true);
    assert.equal(fs.existsSync(filePath), true);
    assert.equal(publicationArtifacts(filePath).length, 1);
    const exact = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.throws(
        () => locks.inspectMaintenanceLock(containerName),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
            && error.owner?.token === exact.token,
    );
    const recovered = locks.inspectMaintenanceLock(containerName, {
        inspectProcessIdentity: () => ({ state: 'dead' }),
    });
    assert.equal(recovered.active, false);
    assert.deepEqual(publicationArtifacts(filePath), []);
    assert.equal(fs.existsSync(filePath), false);
});

test('post-link publication EIO removes the unreturned exact candidate authority', () => {
    const containerName = 'publication-post-link-eio';
    const filePath = lockFile(containerName);
    let canonicalLinked = false;
    let injected = false;
    const faultingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    target.linkSync(source, destination);
                    if (destination === filePath) canonicalLinked = true;
                };
            }
            if (property === 'openSync') {
                return (targetPath, ...args) => {
                    if (canonicalLinked && targetPath === filePath && !injected) {
                        injected = true;
                        throw Object.assign(new Error('injected post-link EIO'), { code: 'EIO' });
                    }
                    return target.openSync(targetPath, ...args);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.throws(
        () => locks.createMaintenanceLock(containerName, { operation: 'candidate' }, { fs: faultingFs }),
        (error) => error?.code === 'EIO',
    );
    assert.equal(injected, true);
    assert.equal(fs.existsSync(filePath), false);
    assert.deepEqual(publicationArtifacts(filePath), []);
    assert.equal(locks.inspectMaintenanceLock(containerName).active, false);
});

test('post-link publication failure never deletes a concurrently published successor', () => {
    const containerName = 'publication-post-link-successor';
    const filePath = lockFile(containerName);
    let canonicalLinked = false;
    let injected = false;
    let successor;
    const faultingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    target.linkSync(source, destination);
                    if (destination === filePath) canonicalLinked = true;
                };
            }
            if (property === 'openSync') {
                return (targetPath, ...args) => {
                    if (canonicalLinked && targetPath === filePath && !injected) {
                        injected = true;
                        target.unlinkSync(filePath);
                        writeExactRecord(filePath, successor);
                        throw Object.assign(new Error('injected successor EIO'), { code: 'EIO' });
                    }
                    return target.openSync(targetPath, ...args);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.throws(
        () => locks.createMaintenanceLock(containerName, { operation: 'candidate' }, {
            fs: faultingFs,
            beforePublish({ record }) {
                successor = { ...record, operation: 'successor', token: TOKEN_B };
            },
        }),
        (error) => error?.code === 'EIO',
    );
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(successor));
    assert.equal(fs.lstatSync(filePath).nlink, 1);
    assert.deepEqual(publicationArtifacts(filePath), []);
    assert.equal(locks.removeMaintenanceLock(containerName, successor.token), true);
});

test('publication cleanup restores a successor installed after its candidate snapshot', () => {
    const containerName = 'publication-pre-rename-successor';
    const filePath = lockFile(containerName);
    let canonicalLinked = false;
    let injected = false;
    let raced = false;
    let successor;
    const racingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    if (!raced && source === filePath
                        && destination.startsWith(`${filePath}.publication-`)
                        && destination.endsWith('.quarantine')) {
                        target.unlinkSync(filePath);
                        writeExactRecord(filePath, successor);
                        raced = true;
                    }
                    target.linkSync(source, destination);
                    if (destination === filePath) canonicalLinked = true;
                };
            }
            if (property === 'openSync') {
                return (targetPath, ...args) => {
                    if (canonicalLinked && targetPath === filePath && !injected) {
                        injected = true;
                        throw Object.assign(new Error('injected post-link EIO'), { code: 'EIO' });
                    }
                    return target.openSync(targetPath, ...args);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.throws(
        () => locks.createMaintenanceLock(containerName, { operation: 'candidate' }, {
            fs: racingFs,
            beforePublish({ record }) {
                successor = { ...record, operation: 'successor', token: TOKEN_B };
            },
        }),
        (error) => error?.code === 'EIO' && !error.publicationRecoveryError,
    );
    assert.equal(raced, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(successor));
    assert.equal(fs.lstatSync(filePath).nlink, 1);
    assert.deepEqual(publicationArtifacts(filePath), []);
    assert.equal(locks.inspectMaintenanceLock(containerName).lock.token, successor.token);
    assert.equal(locks.removeMaintenanceLock(containerName, successor.token), true);
});

test('publication restoration EEXIST remains bounded and fail-closed until the displaced owner is reused', () => {
    const containerName = 'publication-restore-eexist';
    const filePath = lockFile(containerName);
    let canonicalLinked = false;
    let injected = false;
    let raced = false;
    let restoreRaced = false;
    let displacedReused = false;
    let displacedSuccessor;
    let canonicalSuccessor;
    const inspectExactOwner = (pid) => {
        if (pid === process.pid) return identified(IDENTITY_CURRENT);
        if (pid === 41_001) {
            return identified(displacedReused ? IDENTITY_B : IDENTITY_A);
        }
        if (pid === 42_002) return identified(IDENTITY_B);
        return { state: 'dead' };
    };
    const lockDependencies = { inspectProcessIdentity: inspectExactOwner };
    const racingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    if (!raced && source === filePath
                        && destination.startsWith(`${filePath}.publication-`)
                        && destination.endsWith('.quarantine')) {
                        target.unlinkSync(filePath);
                        writeExactRecord(filePath, displacedSuccessor);
                        raced = true;
                    }
                    if (!restoreRaced && source.startsWith(`${filePath}.publication-`)
                        && source.endsWith('.quarantine') && destination === filePath) {
                        writeExactRecord(filePath, canonicalSuccessor);
                        restoreRaced = true;
                    }
                    target.linkSync(source, destination);
                    if (destination === filePath) canonicalLinked = true;
                };
            }
            if (property === 'openSync') {
                return (targetPath, ...args) => {
                    if (canonicalLinked && targetPath === filePath && !injected) {
                        injected = true;
                        throw Object.assign(new Error('injected post-link EIO'), { code: 'EIO' });
                    }
                    return target.openSync(targetPath, ...args);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.throws(
        () => locks.createMaintenanceLock(containerName, { operation: 'candidate' }, {
            fs: racingFs,
            ...lockDependencies,
            beforePublish({ record }) {
                displacedSuccessor = {
                    ...record,
                    operation: 'displaced-successor',
                    ownerPid: 41_001,
                    ownerStartIdentity: IDENTITY_A,
                    token: TOKEN_B,
                };
                canonicalSuccessor = {
                    ...record,
                    operation: 'canonical-successor',
                    ownerPid: 42_002,
                    ownerStartIdentity: IDENTITY_B,
                    token: TOKEN_C,
                };
            },
        }),
        (error) => error?.code === 'EIO'
            && error.publicationRecoveryError?.code === 'PLOINKY_MAINTENANCE_BUSY'
            && error.publicationRecoveryError?.owner?.token === displacedSuccessor.token,
    );
    assert.equal(raced, true);
    assert.equal(restoreRaced, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(canonicalSuccessor));
    assert.equal(fs.lstatSync(filePath).nlink, 1);
    const durableCollision = publicationArtifacts(filePath);
    assert.equal(durableCollision.length, 2);
    assert.ok(durableCollision.some((name) => name.endsWith('.claim')));
    assert.ok(durableCollision.some((name) => name.endsWith('.quarantine')));
    const collisionSnapshot = snapshotLockNamespace(filePath);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.throws(
            () => locks.inspectMaintenanceLock(containerName, lockDependencies),
            (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
                && error.owner?.token === displacedSuccessor.token,
        );
        assert.deepEqual(snapshotLockNamespace(filePath), collisionSnapshot);
    }
    assert.throws(
        () => locks.removeMaintenanceLock(containerName, displacedSuccessor.token, lockDependencies),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
            && error.owner?.token === displacedSuccessor.token,
    );
    assert.deepEqual(snapshotLockNamespace(filePath), collisionSnapshot);
    assert.throws(
        () => locks.removeMaintenanceLock(containerName, canonicalSuccessor.token, lockDependencies),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
            && error.owner?.token === displacedSuccessor.token,
    );
    assert.deepEqual(snapshotLockNamespace(filePath), collisionSnapshot);
    assert.throws(
        () => locks.createMaintenanceLock(containerName, { operation: 'must-not-enter' }, lockDependencies),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_LOCK_INVALID',
    );
    assert.deepEqual(snapshotLockNamespace(filePath), collisionSnapshot);

    displacedReused = true;
    const recovered = locks.inspectMaintenanceLock(containerName, lockDependencies);
    assert.equal(recovered.active, true);
    assert.equal(recovered.lock.token, canonicalSuccessor.token);
    assert.deepEqual(publicationArtifacts(filePath), []);
    assert.equal(locks.removeMaintenanceLock(containerName, canonicalSuccessor.token, lockDependencies), true);
    const fresh = locks.createMaintenanceLock(containerName, { operation: 'fresh' }, lockDependencies);
    assert.equal(locks.removeMaintenanceLock(containerName, fresh.token, lockDependencies), true);
});

test('pre-release claim mismatch removes only the private claim and leaves the successor exact', () => {
    const containerName = 'release-claim-mismatch';
    const filePath = lockFile(containerName);
    const first = locks.createMaintenanceLock(containerName, { operation: 'first' });
    const successor = { ...first, operation: 'successor', token: TOKEN_B };
    let raced = false;
    const racingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    if (!raced && source === filePath
                        && destination.startsWith(`${filePath}.operation-`)
                        && destination.endsWith('.claim')) {
                        target.unlinkSync(filePath);
                        writeExactRecord(filePath, successor);
                        raced = true;
                    }
                    target.linkSync(source, destination);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.equal(locks.removeMaintenanceLock(containerName, first.token, { fs: racingFs }), false);
    assert.equal(raced, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(successor));
    assert.equal(fs.lstatSync(filePath).nlink, 1);
    assert.deepEqual(releaseArtifacts(filePath), []);
    assert.equal(locks.inspectMaintenanceLock(containerName).lock.token, successor.token);
    assert.equal(locks.removeMaintenanceLock(containerName, successor.token), true);
});

test('exact release restores a successor installed immediately before quarantine publication', () => {
    const containerName = 'release-pre-rename-successor';
    const filePath = lockFile(containerName);
    const first = locks.createMaintenanceLock(containerName, { operation: 'release-p1' });
    const successor = { ...first, operation: 'release-p2', token: TOKEN_B };
    let raced = false;
    const racingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    if (!raced && source === filePath
                        && destination.startsWith(`${filePath}.operation-`)
                        && destination.endsWith('.quarantine')) {
                        target.unlinkSync(filePath);
                        writeExactRecord(filePath, successor);
                        raced = true;
                    }
                    target.linkSync(source, destination);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.equal(locks.removeMaintenanceLock(containerName, first.token, { fs: racingFs }), false);
    assert.equal(raced, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(successor));
    assert.equal(fs.lstatSync(filePath).nlink, 1);
    assert.deepEqual(releaseArtifacts(filePath), []);
    assert.equal(locks.removeMaintenanceLock(containerName, first.token), false);
    assert.equal(locks.inspectMaintenanceLock(containerName).lock.token, successor.token);
    assert.equal(locks.removeMaintenanceLock(containerName, successor.token), true);
});

test('no-clobber quarantine publication never overwrites an independently created owner', () => {
    const containerName = 'release-quarantine-no-clobber';
    const filePath = lockFile(containerName);
    const first = locks.createMaintenanceLock(containerName, { operation: 'release-p1' });
    const canonicalP2 = {
        ...first,
        operation: 'release-p2',
        ownerPid: 47_007,
        ownerStartIdentity: IDENTITY_A,
        token: TOKEN_B,
    };
    const quarantineP3 = {
        ...first,
        operation: 'release-p3',
        ownerPid: 48_008,
        ownerStartIdentity: IDENTITY_B,
        token: TOKEN_C,
    };
    let quarantinePath;
    const racingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    if (!quarantinePath && source === filePath
                        && destination.startsWith(`${filePath}.operation-`)
                        && destination.endsWith('.quarantine')) {
                        target.unlinkSync(filePath);
                        writeExactRecord(filePath, canonicalP2);
                        writeExactRecord(destination, quarantineP3);
                        quarantinePath = destination;
                    }
                    return target.linkSync(source, destination);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.throws(
        () => locks.removeMaintenanceLock(containerName, first.token, { fs: racingFs }),
        (error) => error?.code === 'EEXIST' && error.lockTransitionApplied === true,
    );
    assert.ok(quarantinePath);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(canonicalP2));
    assert.equal(fs.readFileSync(quarantinePath, 'utf8'), exactRecordBytes(quarantineP3));
    assert.equal(releaseArtifacts(filePath).length, 2);
    const recovered = locks.inspectMaintenanceLock(containerName, {
        inspectProcessIdentity: () => ({ state: 'dead' }),
    });
    assert.equal(recovered.active, false);
    assert.equal(fs.existsSync(filePath), false);
    assert.deepEqual(releaseArtifacts(filePath), []);
});

test('exact release P3 collision stays bounded and fail-closed until displaced P2 is reused', () => {
    const containerName = 'release-p3-collision';
    const filePath = lockFile(containerName);
    let displacedReused = false;
    let raced = false;
    let restoreRaced = false;
    const inspectExactOwner = (pid) => {
        if (pid === process.pid) return identified(IDENTITY_CURRENT);
        if (pid === 45_005) return identified(displacedReused ? IDENTITY_B : IDENTITY_A);
        if (pid === 46_006) return identified(IDENTITY_B);
        return { state: 'dead' };
    };
    const dependencyOverrides = { inspectProcessIdentity: inspectExactOwner };
    const first = locks.createMaintenanceLock(
        containerName,
        { operation: 'release-p1' },
        dependencyOverrides,
    );
    const displacedP2 = {
        ...first,
        operation: 'release-p2',
        ownerPid: 45_005,
        ownerStartIdentity: IDENTITY_A,
        token: TOKEN_B,
    };
    const canonicalP3 = {
        ...first,
        operation: 'release-p3',
        ownerPid: 46_006,
        ownerStartIdentity: IDENTITY_B,
        token: TOKEN_C,
    };
    const racingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    if (!raced && source === filePath
                        && destination.startsWith(`${filePath}.operation-`)
                        && destination.endsWith('.quarantine')) {
                        target.unlinkSync(filePath);
                        writeExactRecord(filePath, displacedP2);
                        raced = true;
                    }
                    if (!restoreRaced && source.startsWith(`${filePath}.operation-`)
                        && source.endsWith('.quarantine') && destination === filePath) {
                        writeExactRecord(filePath, canonicalP3);
                        restoreRaced = true;
                    }
                    target.linkSync(source, destination);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.throws(
        () => locks.removeMaintenanceLock(containerName, first.token, {
            fs: racingFs,
            ...dependencyOverrides,
        }),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
            && error.owner?.token === displacedP2.token,
    );
    assert.equal(raced, true);
    assert.equal(restoreRaced, true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(canonicalP3));
    const durableCollision = releaseArtifacts(filePath);
    assert.equal(durableCollision.length, 2);
    const collisionSnapshot = snapshotLockNamespace(filePath);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.throws(
            () => locks.inspectMaintenanceLock(containerName, dependencyOverrides),
            (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
                && error.owner?.token === displacedP2.token,
        );
        assert.deepEqual(snapshotLockNamespace(filePath), collisionSnapshot);
    }
    for (const exactOwner of [first, displacedP2, canonicalP3]) {
        assert.throws(
            () => locks.removeMaintenanceLock(containerName, exactOwner.token, dependencyOverrides),
            (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY'
                && error.owner?.token === displacedP2.token,
        );
        assert.deepEqual(snapshotLockNamespace(filePath), collisionSnapshot);
    }
    assert.throws(
        () => locks.createMaintenanceLock(containerName, { operation: 'must-not-enter' }, dependencyOverrides),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_LOCK_INVALID',
    );
    assert.deepEqual(snapshotLockNamespace(filePath), collisionSnapshot);

    displacedReused = true;
    const cleanupOrder = ['quarantine', 'claim'];
    const injectedCleanup = new Set();
    const cleanupFaultFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'unlinkSync') {
                return (targetPath) => {
                    const suffix = cleanupOrder.find((candidate) => targetPath.startsWith(
                        `${filePath}.operation-`,
                    ) && targetPath.endsWith(`.${candidate}`));
                    target.unlinkSync(targetPath);
                    if (suffix && !injectedCleanup.has(suffix)) {
                        injectedCleanup.add(suffix);
                        throw Object.assign(new Error(`injected ${suffix} cleanup EIO`), { code: 'EIO' });
                    }
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const recovered = locks.inspectMaintenanceLock(containerName, {
        fs: cleanupFaultFs,
        ...dependencyOverrides,
    });
    assert.deepEqual([...injectedCleanup], cleanupOrder);
    assert.deepEqual(releaseArtifacts(filePath), []);
    assert.equal(recovered.active, true);
    assert.equal(recovered.lock.token, canonicalP3.token);
    assert.deepEqual(releaseArtifacts(filePath), []);
    assert.equal(locks.removeMaintenanceLock(containerName, canonicalP3.token, dependencyOverrides), true);
    const fresh = locks.createMaintenanceLock(
        containerName,
        { operation: 'release-fresh' },
        dependencyOverrides,
    );
    assert.equal(locks.removeMaintenanceLock(containerName, fresh.token, dependencyOverrides), true);
});

test('lock store directories require exact private mode 0700', () => {
    const maintenanceDirectory = path.dirname(lockFile('unsafe-directory-mode'));
    const runningDirectory = path.dirname(locks.WORKSPACE_START_LOCK_PATH);
    const maintenanceMode = fs.lstatSync(maintenanceDirectory).mode & 0o777;
    const runningMode = fs.lstatSync(runningDirectory).mode & 0o777;
    try {
        for (const mode of [0o755, 0o777]) {
            fs.chmodSync(maintenanceDirectory, mode);
            assert.throws(
                () => locks.createMaintenanceLock('unsafe-directory-mode'),
                (error) => /LOCK_INVALID$/.test(error?.code || ''),
            );
            assert.equal(fs.existsSync(lockFile('unsafe-directory-mode')), false);
        }
        fs.chmodSync(maintenanceDirectory, maintenanceMode);

        for (const mode of [0o755, 0o777]) {
            fs.chmodSync(runningDirectory, mode);
            assert.throws(
                () => locks.inspectWorkspaceStartLock(),
                (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID',
            );
        }
    } finally {
        fs.chmodSync(maintenanceDirectory, maintenanceMode);
        fs.chmodSync(runningDirectory, runningMode);
    }
});

test('missing O_DIRECTORY fails before publishing any lock authority', () => {
    const containerName = 'missing-o-directory';
    const filePath = lockFile(containerName);
    const unsupportedFs = { ...fs, constants: { ...fs.constants, O_DIRECTORY: 0 } };
    assert.throws(
        () => locks.createMaintenanceLock(containerName, {}, { fs: unsupportedFs }),
        (error) => /LOCK_INVALID$/.test(error?.code || ''),
    );
    assert.equal(fs.existsSync(filePath), false);
    assert.deepEqual(publicationArtifacts(filePath), []);
});

test('missing O_NOFOLLOW rejects lock reads before creating authority', () => {
    const containerName = 'missing-o-nofollow';
    const filePath = lockFile(containerName);
    const unsupportedFs = { ...fs, constants: { ...fs.constants, O_NOFOLLOW: 0 } };
    assert.throws(
        () => locks.createMaintenanceLock(containerName, {}, { fs: unsupportedFs }),
        (error) => /LOCK_INVALID$/.test(error?.code || ''),
    );
    assert.equal(fs.existsSync(filePath), false);
    assert.deepEqual(publicationArtifacts(filePath), []);
});

test('directory fsync failure preserves recognized fail-closed publication evidence', () => {
    const containerName = 'directory-fsync-failure';
    const filePath = lockFile(containerName);
    let injected = false;
    const faultingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'fsyncSync') {
                return (descriptor) => {
                    if (!injected && target.fstatSync(descriptor).isDirectory()) {
                        injected = true;
                        throw Object.assign(new Error('injected directory fsync EIO'), { code: 'EIO' });
                    }
                    return target.fsyncSync(descriptor);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.throws(
        () => locks.createMaintenanceLock(containerName, {}, { fs: faultingFs }),
        (error) => error?.code === 'EIO'
            && error.lockTransitionApplied === true
            && error.lockDurabilityUncertain === true,
    );
    assert.equal(injected, true);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(publicationArtifacts(filePath).length, 1);
    assert.throws(
        () => locks.inspectMaintenanceLock(containerName),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY',
    );
    const recovered = locks.inspectMaintenanceLock(containerName, {
        inspectProcessIdentity: () => ({ state: 'dead' }),
    });
    assert.equal(recovered.active, false);
    assert.deepEqual(publicationArtifacts(filePath), []);
});

test('interrupted exact release preserves a live owner and retires artifacts only after proven death', () => {
    const containerName = 'interrupted-release';
    const filePath = lockFile(containerName);
    const first = locks.createMaintenanceLock(containerName, { operation: 'first' });
    assert.throws(
        () => locks.removeMaintenanceLock(containerName, first.token, {
            afterPrimaryRelease() { throw new Error('simulated crash after rename'); },
        }),
        /simulated crash after rename/,
    );
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(releaseArtifacts(filePath).length, 2);
    assert.throws(
        () => locks.inspectMaintenanceLock(containerName),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_BUSY',
    );
    assert.equal(releaseArtifacts(filePath).length, 2);

    const recovered = locks.inspectMaintenanceLock(containerName, {
        inspectProcessIdentity: () => ({ state: 'dead' }),
    });
    assert.equal(recovered.active, false);
    assert.equal(recovered.stale, true);
    assert.deepEqual(releaseArtifacts(filePath), []);
});

test('interrupted recovery preserves a live canonical successor while retiring only the dead old owner', () => {
    const containerName = 'interrupted-with-successor';
    const filePath = lockFile(containerName);
    const first = locks.createMaintenanceLock(containerName, { operation: 'old-owner' }, {
        inspectProcessIdentity: () => identified(IDENTITY_A),
    });
    let successor;
    assert.throws(
        () => locks.removeMaintenanceLock(containerName, first.token, {
            afterPrimaryRelease({ released: oldRecord }) {
                successor = {
                    ...oldRecord,
                    operation: 'live-successor',
                    ownerPid: 5252,
                    ownerStartIdentity: IDENTITY_B,
                    token: TOKEN_B,
                };
                writeExactRecord(filePath, successor);
                throw new Error('simulated cleanup interruption');
            },
        }),
        /simulated cleanup interruption/,
    );
    const state = locks.inspectMaintenanceLock(containerName, {
        inspectProcessIdentity(pid) {
            return pid === 5252 ? identified(IDENTITY_B) : { state: 'dead' };
        },
    });
    assert.equal(state.active, true);
    assert.equal(state.lock.token, successor.token);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(successor));
    assert.deepEqual(releaseArtifacts(filePath), []);
    assert.equal(locks.removeMaintenanceLock(containerName, successor.token), true);
});

test('symlink, public mode, extra link, malformed, and noncanonical records fail closed', (t) => {
    const symlinkName = 'unsafe-symlink';
    const symlinkPath = lockFile(symlinkName);
    const outside = path.join(workspace, 'outside-lock-target');
    fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
    fs.writeFileSync(outside, 'do-not-touch', { mode: 0o600 });
    fs.symlinkSync(outside, symlinkPath);
    assert.throws(
        () => locks.inspectMaintenanceLock(symlinkName),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_LOCK_INVALID',
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'do-not-touch');
    fs.unlinkSync(symlinkPath);

    const modeName = 'unsafe-mode';
    const modeLock = locks.createMaintenanceLock(modeName, { operation: 'mode-test' });
    fs.chmodSync(lockFile(modeName), 0o640);
    assert.throws(
        () => locks.inspectMaintenanceLock(modeName),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_LOCK_INVALID',
    );
    fs.chmodSync(lockFile(modeName), 0o600);
    assert.equal(locks.removeMaintenanceLock(modeName, modeLock.token), true);

    const linkedName = 'unsafe-hard-link';
    const linkedLock = locks.createMaintenanceLock(linkedName, { operation: 'link-test' });
    const alias = `${lockFile(linkedName)}.alias`;
    fs.linkSync(lockFile(linkedName), alias);
    assert.throws(
        () => locks.inspectMaintenanceLock(linkedName),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_LOCK_INVALID',
    );
    fs.unlinkSync(alias);
    assert.equal(locks.removeMaintenanceLock(linkedName, linkedLock.token), true);

    const malformedName = 'unsafe-malformed';
    const malformedPath = lockFile(malformedName);
    fs.writeFileSync(malformedPath, '{broken', { flag: 'wx', mode: 0o600 });
    assert.throws(
        () => locks.createMaintenanceLock(malformedName),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_LOCK_INVALID',
    );
    assert.equal(fs.readFileSync(malformedPath, 'utf8'), '{broken');
    fs.unlinkSync(malformedPath);

    const noncanonicalName = 'unsafe-noncanonical';
    const noncanonicalPath = lockFile(noncanonicalName);
    const noncanonicalLock = locks.createMaintenanceLock(noncanonicalName, { operation: 'json-test' });
    fs.writeFileSync(noncanonicalPath, JSON.stringify(noncanonicalLock, null, 2), { mode: 0o600 });
    assert.throws(
        () => locks.inspectMaintenanceLock(noncanonicalName),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_LOCK_INVALID',
    );
    t.after(() => fs.rmSync(noncanonicalPath, { force: true }));
});

test('callback and release failures are both exposed by withMaintenanceLock', async () => {
    const containerName = 'callback-and-release-failure';
    const filePath = lockFile(containerName);
    let replacement;
    await assert.rejects(
        () => locks.withMaintenanceLock(containerName, { operation: 'combined-failure' }, async () => {
            const current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            replacement = { ...current, token: TOKEN_A };
            fs.unlinkSync(filePath);
            writeExactRecord(filePath, replacement);
            throw new Error('callback also failed');
        }),
        (error) => error?.code === 'maintenance_lock_release_failed'
            && error.callbackError?.message === 'callback also failed',
    );
    assert.equal(locks.removeMaintenanceLock(containerName, replacement.token), true);
});

test('replacement written before release remains untouched on token mismatch', async () => {
    const containerName = 'replacement-before-release';
    const filePath = lockFile(containerName);
    const lock = locks.createMaintenanceLock(containerName, { operation: 'first' });
    const replacement = { ...lock, token: TOKEN_B, operation: 'replacement' };
    fs.unlinkSync(filePath);
    writeExactRecord(filePath, replacement);
    assert.equal(locks.removeMaintenanceLock(containerName, lock.token), false);
    assert.equal(fs.readFileSync(filePath, 'utf8'), exactRecordBytes(replacement));
    assert.equal(locks.removeMaintenanceLock(containerName, replacement.token), true);
});

test('legacy exact authority paths deny mixed-generation lock use without parsing or migration', () => {
    const runningDir = path.join(workspace, '.ploinky', 'running');
    const legacyMaintenanceDir = path.join(runningDir, 'maintenance');
    const legacyMaintenancePath = path.join(legacyMaintenanceDir, 'legacy-maintenance.json');
    fs.mkdirSync(legacyMaintenanceDir, { recursive: true });
    fs.writeFileSync(legacyMaintenancePath, 'legacy-bytes', { mode: 0o600 });
    assert.throws(
        () => locks.createMaintenanceLock('legacy-maintenance', { operation: 'must-deny' }),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_LOCK_INVALID'
            && /legacy lock authority/.test(error.message),
    );
    assert.throws(
        () => locks.inspectMaintenanceLock('legacy-maintenance'),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_LOCK_INVALID',
    );
    assert.throws(
        () => locks.removeMaintenanceLock('legacy-maintenance', TOKEN_A),
        (error) => error?.code === 'PLOINKY_MAINTENANCE_LOCK_INVALID',
    );
    assert.equal(fs.readFileSync(legacyMaintenancePath, 'utf8'), 'legacy-bytes');
    fs.unlinkSync(legacyMaintenancePath);

    const legacyWorkspacePath = path.join(runningDir, 'workspace-start.json');
    fs.writeFileSync(legacyWorkspacePath, 'legacy-workspace-bytes', { mode: 0o600 });
    assert.throws(
        () => locks.createWorkspaceMutationLease({ operation: 'must-deny-legacy-workspace' }),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID'
            && /legacy lock authority/.test(error.message),
    );
    assert.throws(
        () => locks.inspectWorkspaceStartLock(),
        (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID',
    );
    assert.equal(fs.readFileSync(legacyWorkspacePath, 'utf8'), 'legacy-workspace-bytes');
    fs.unlinkSync(legacyWorkspacePath);
});

test('maintenance authority rejects a symlinked or permissive private lock parent', () => {
    const runningDir = path.join(workspace, '.ploinky', 'running');
    const lockRoot = path.join(runningDir, 'locks');
    const preservedRoot = path.join(runningDir, 'locks-preserved-for-topology-test');
    const redirectedRoot = path.join(runningDir, 'redirected-locks');
    fs.renameSync(lockRoot, preservedRoot);
    fs.mkdirSync(path.join(redirectedRoot, 'maintenance'), { recursive: true, mode: 0o700 });
    fs.chmodSync(redirectedRoot, 0o700);
    fs.chmodSync(path.join(redirectedRoot, 'maintenance'), 0o700);
    fs.symlinkSync(redirectedRoot, lockRoot);
    try {
        assert.throws(
            () => locks.createMaintenanceLock('symlinked-store', { operation: 'must-deny' }),
            (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID',
        );
        assert.equal(fs.existsSync(path.join(redirectedRoot, 'maintenance', 'symlinked-store.json')), false);
    } finally {
        fs.unlinkSync(lockRoot);
        fs.rmSync(redirectedRoot, { recursive: true });
        fs.renameSync(preservedRoot, lockRoot);
    }

    fs.chmodSync(lockRoot, 0o777);
    try {
        assert.throws(
            () => locks.createMaintenanceLock('permissive-store', { operation: 'must-deny' }),
            (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID',
        );
        assert.equal(fs.existsSync(path.join(lockRoot, 'maintenance', 'permissive-store.json')), false);
    } finally {
        fs.chmodSync(lockRoot, 0o700);
    }
});

test('clean-break topology initialization supports both lock-store operation orders', () => {
    for (const firstKind of ['maintenance', 'workspace']) {
        runIsolatedLockScenario(`
            const firstKind = ${JSON.stringify(firstKind)};
            if (firstKind === 'maintenance') {
                const first = locks.createMaintenanceLock('order-test', { operation: 'maintenance-first' });
                assert.equal(locks.removeMaintenanceLock('order-test', first.token), true);
                const second = locks.createWorkspaceMutationLease({ operation: 'workspace-second' });
                assert.equal(locks.releaseWorkspaceMutationLease(second), true);
            } else {
                const first = locks.createWorkspaceMutationLease({ operation: 'workspace-first' });
                assert.equal(locks.releaseWorkspaceMutationLease(first), true);
                const second = locks.createMaintenanceLock('order-test', { operation: 'maintenance-second' });
                assert.equal(locks.removeMaintenanceLock('order-test', second.token), true);
            }
            const lineageNames = fs.readdirSync(process.env.PLOINKY_WORKSPACE_ROOT)
                .filter((name) => name.startsWith('.ploinky-lock-store-lineage-'));
            assert.equal(lineageNames.length, 2);
            for (const name of lineageNames) {
                assert.equal(fs.lstatSync(path.join(process.env.PLOINKY_WORKSPACE_ROOT, name)).mode & 0o777, 0o600);
            }
        `);
    }
});

test('workspace-root lineage rejects fresh replacements of every mutable topology component', () => {
    const cases = [
        { kind: 'workspace', component: 'ploinky' },
        { kind: 'workspace', component: 'running' },
        { kind: 'workspace', component: 'locks' },
        { kind: 'maintenance', component: 'ploinky' },
        { kind: 'maintenance', component: 'running' },
        { kind: 'maintenance', component: 'locks' },
        { kind: 'maintenance', component: 'maintenance' },
    ];
    for (const testCase of cases) {
        runIsolatedLockScenario(`
            const kind = ${JSON.stringify(testCase.kind)};
            const componentName = ${JSON.stringify(testCase.component)};
            const locksDirectory = path.dirname(locks.WORKSPACE_START_LOCK_PATH);
            const runningDirectory = path.dirname(locksDirectory);
            const ploinkyDirectory = path.dirname(runningDirectory);
            const maintenanceDirectory = path.join(locksDirectory, 'maintenance');
            const terminalDirectory = kind === 'workspace' ? locksDirectory : maintenanceDirectory;
            const first = kind === 'workspace'
                ? locks.createWorkspaceMutationLease({ operation: componentName + '-first' })
                : locks.createMaintenanceLock('lineage-replacement', { operation: componentName + '-first' });
            const authorityPath = kind === 'workspace'
                ? locks.WORKSPACE_START_LOCK_PATH
                : path.join(maintenanceDirectory, 'lineage-replacement.json');
            const component = {
                ploinky: ploinkyDirectory,
                running: runningDirectory,
                locks: locksDirectory,
                maintenance: maintenanceDirectory,
            }[componentName];
            const displaced = component + '.displaced-lineage-test';
            const terminalIdentity = fs.statSync(terminalDirectory);
            let replaced = false;
            const replacementFs = new Proxy(fs, {
                get(target, property, receiver) {
                    if (property === 'fsyncSync') {
                        return (descriptor) => {
                            const descriptorStat = target.fstatSync(descriptor);
                            if (!replaced && descriptorStat.isDirectory()
                                && descriptorStat.dev === terminalIdentity.dev
                                && descriptorStat.ino === terminalIdentity.ino) {
                                replaced = true;
                                target.renameSync(component, displaced);
                                const freshTerminal = path.join(component, path.relative(component, terminalDirectory));
                                target.mkdirSync(freshTerminal, { recursive: true, mode: 0o700 });
                                const freshLocks = path.join(
                                    component,
                                    path.relative(component, locksDirectory),
                                );
                                if (target.existsSync(freshLocks)) target.chmodSync(freshLocks, 0o700);
                                const freshMaintenance = path.join(
                                    component,
                                    path.relative(component, maintenanceDirectory),
                                );
                                if (target.existsSync(freshMaintenance)) target.chmodSync(freshMaintenance, 0o700);
                            }
                            return target.fsyncSync(descriptor);
                        };
                    }
                    return Reflect.get(target, property, receiver);
                },
            });
            let transitionError;
            try {
                if (kind === 'workspace') locks.releaseWorkspaceMutationLease(first, { fs: replacementFs });
                else locks.removeMaintenanceLock('lineage-replacement', first.token, { fs: replacementFs });
            } catch (error) {
                transitionError = error;
            }
            assert.equal(replaced, true);
            assert.equal(transitionError?.code, 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID');
            assert.equal(transitionError?.lockTransitionApplied, true);
            assert.equal(transitionError?.lockDurabilityUncertain, true);
            const displacedAuthority = path.join(displaced, path.relative(component, authorityPath));
            assert.equal(fs.existsSync(displacedAuthority), true);
            assert.equal(
                fs.readdirSync(path.dirname(displacedAuthority))
                    .some((name) => name.startsWith(path.basename(displacedAuthority) + '.operation-')),
                true,
            );
            assert.equal(fs.existsSync(authorityPath), false);
            let secondError;
            try {
                if (kind === 'workspace') {
                    locks.createWorkspaceMutationLease({ operation: componentName + '-second' });
                } else {
                    locks.createMaintenanceLock('lineage-replacement', { operation: componentName + '-second' });
                }
            } catch (error) {
                secondError = error;
            }
            assert.equal(secondError?.code, 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID');
            assert.match(secondError?.message || '', /workspace-root-bound lineage/);
            assert.equal(fs.existsSync(displacedAuthority), true);
            assert.equal(fs.existsSync(authorityPath), false);
        `);
    }
});

test('a transition validates durable lineage against the same pins used for mutation', () => {
    runIsolatedLockScenario(`
        const lease = locks.createWorkspaceMutationLease({ operation: 'same-pin-validation' });
        const locksDirectory = path.dirname(locks.WORKSPACE_START_LOCK_PATH);
        const runningDirectory = path.dirname(locksDirectory);
        const displacedRunning = runningDirectory + '.displaced-before-lineage-read';
        const [lineageName] = fs.readdirSync(process.env.PLOINKY_WORKSPACE_ROOT)
            .filter((name) => name.startsWith('.ploinky-lock-store-lineage-'));
        const lineagePath = path.join(process.env.PLOINKY_WORKSPACE_ROOT, lineageName);
        let replaced = false;
        const replacementFs = new Proxy(fs, {
            get(target, property, receiver) {
                if (property === 'openSync') {
                    return (targetPath, ...args) => {
                        if (!replaced && targetPath === lineagePath) {
                            replaced = true;
                            target.renameSync(runningDirectory, displacedRunning);
                            target.mkdirSync(locksDirectory, { recursive: true, mode: 0o700 });
                            target.chmodSync(locksDirectory, 0o700);
                        }
                        return target.openSync(targetPath, ...args);
                    };
                }
                return Reflect.get(target, property, receiver);
            },
        });
        assert.throws(
            () => locks.releaseWorkspaceMutationLease(lease, { fs: replacementFs }),
            (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID'
                && /topology changed/.test(error.message),
        );
        assert.equal(replaced, true);
        const displacedAuthority = path.join(
            displacedRunning,
            path.relative(runningDirectory, locks.WORKSPACE_START_LOCK_PATH),
        );
        assert.equal(fs.existsSync(displacedAuthority), true);
        assert.deepEqual(
            fs.readdirSync(path.dirname(displacedAuthority))
                .filter((name) => name.startsWith(path.basename(displacedAuthority) + '.operation-')),
            [],
        );
        assert.equal(fs.existsSync(locks.WORKSPACE_START_LOCK_PATH), false);
        assert.throws(
            () => locks.createWorkspaceMutationLease({ operation: 'after-same-pin-replacement' }),
            (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID'
                && /workspace-root-bound lineage/.test(error.message),
        );
        assert.equal(fs.existsSync(displacedAuthority), true);
    `);
});

test('pre-existing and partially initialized clean-break stores fail closed without adoption', () => {
    runIsolatedLockScenario(`
        const locksDirectory = path.dirname(locks.WORKSPACE_START_LOCK_PATH);
        fs.mkdirSync(locksDirectory, { recursive: true, mode: 0o700 });
        fs.chmodSync(locksDirectory, 0o700);
        assert.throws(
            () => locks.createWorkspaceMutationLease({ operation: 'preexisting-root' }),
            (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID'
                && /has no durable/.test(error.message),
        );
        assert.equal(fs.existsSync(locks.WORKSPACE_START_LOCK_PATH), false);
        assert.deepEqual(
            fs.readdirSync(process.env.PLOINKY_WORKSPACE_ROOT)
                .filter((name) => name.startsWith('.ploinky-lock-store-lineage-')),
            [],
        );
    `);

    runIsolatedLockScenario(`
        const rootLease = locks.createWorkspaceMutationLease({ operation: 'initialize-root-only' });
        assert.equal(locks.releaseWorkspaceMutationLease(rootLease), true);
        const locksDirectory = path.dirname(locks.WORKSPACE_START_LOCK_PATH);
        const maintenanceDirectory = path.join(locksDirectory, 'maintenance');
        fs.mkdirSync(maintenanceDirectory, { mode: 0o700 });
        assert.throws(
            () => locks.createMaintenanceLock('preexisting-nested', { operation: 'must-deny' }),
            (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID'
                && /has no durable/.test(error.message),
        );
        assert.equal(fs.existsSync(path.join(maintenanceDirectory, 'preexisting-nested.json')), false);
        assert.equal(
            fs.readdirSync(process.env.PLOINKY_WORKSPACE_ROOT)
                .filter((name) => name.startsWith('.ploinky-lock-store-lineage-')).length,
            1,
        );
    `);

    runIsolatedLockScenario(`
        let writeFaultInjected = false;
        const partialLineageFs = new Proxy(fs, {
            get(target, property, receiver) {
                if (property === 'writeSync') {
                    return (descriptor, buffer, offset, length, position) => {
                        const written = target.writeSync(
                            descriptor,
                            buffer,
                            offset,
                            Math.min(8, length),
                            position,
                        );
                        writeFaultInjected = true;
                        throw Object.assign(new Error('simulated lineage initialization crash'), { code: 'EIO' });
                    };
                }
                return Reflect.get(target, property, receiver);
            },
        });
        assert.throws(
            () => locks.createWorkspaceMutationLease(
                { operation: 'partial-lineage-write' },
                { fs: partialLineageFs },
            ),
            (error) => error?.code === 'EIO',
        );
        assert.equal(writeFaultInjected, true);
        const lineageNames = fs.readdirSync(process.env.PLOINKY_WORKSPACE_ROOT)
            .filter((name) => name.startsWith('.ploinky-lock-store-lineage-'));
        assert.equal(lineageNames.length, 1);
        const lineagePath = path.join(process.env.PLOINKY_WORKSPACE_ROOT, lineageNames[0]);
        const partialBytes = fs.readFileSync(lineagePath);
        assert.equal(partialBytes.length, 8);
        assert.throws(
            () => locks.createWorkspaceMutationLease({ operation: 'after-partial-lineage' }),
            (error) => error?.code === 'PLOINKY_WORKSPACE_MUTATION_LOCK_INVALID'
                && /malformed/.test(error.message),
        );
        assert.deepEqual(fs.readFileSync(lineagePath), partialBytes);
        assert.equal(fs.existsSync(locks.WORKSPACE_START_LOCK_PATH), false);
    `);
});
