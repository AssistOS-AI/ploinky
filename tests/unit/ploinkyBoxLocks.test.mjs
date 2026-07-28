import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    createMutationLockManager,
    withWorkspaceMutationLock,
} from '../../ploinky-box/locks.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-lock-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('mutation locks use private modes and serialize concurrent owners', async (t) => {
    const root = fixture(t);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const identity = buildWorkspaceIdentity(workspace);
    const manager = createMutationLockManager({ homeDirectory: root, retryMs: 2 });
    const order = [];

    const first = (async () => {
        const lock = await manager.acquire(identity.instance);
        order.push('first-acquired');
        await delay(30);
        order.push('first-release');
        lock.release();
    })();
    await delay(5);
    const second = (async () => {
        const lock = await manager.acquire(identity.instance);
        order.push('second-acquired');
        lock.release();
    })();
    await Promise.all([first, second]);

    assert.deepEqual(order, ['first-acquired', 'first-release', 'second-acquired']);
    assert.equal(fs.statSync(manager.stateRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(manager.locksRoot).mode & 0o777, 0o700);
});

test('same-host proven-dead locks recover but foreign-host locks do not', async (t) => {
    const root = fixture(t);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const identity = buildWorkspaceIdentity(workspace);
    const lockRoot = path.join(root, '.ploinky-box', 'locks', `${identity.instance}.lock`);
    fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lockRoot, 'owner.json'), `${JSON.stringify({
        hostname: 'local-test',
        pid: 999999,
        instance: identity.instance,
        startedAt: new Date(0).toISOString(),
    })}\n`, { mode: 0o600 });
    const manager = createMutationLockManager({
        homeDirectory: root,
        hostname: 'local-test',
        kill() { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); },
        retryMs: 1,
        timeoutMs: 20,
    });
    const recovered = await manager.acquire(identity.instance);
    recovered.release();

    fs.mkdirSync(lockRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(lockRoot, 'owner.json'), `${JSON.stringify({
        hostname: 'another-host',
        pid: 123,
        instance: identity.instance,
        startedAt: new Date(0).toISOString(),
    })}\n`, { mode: 0o600 });
    await assert.rejects(() => manager.acquire(identity.instance), /Timed out waiting/);
    assert.equal(fs.existsSync(lockRoot), true);
});

test('lock roots reject symlinks and mutation transactions acquire only once', async (t) => {
    const root = fixture(t);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    fs.symlinkSync(workspace, path.join(root, '.ploinky-box'), 'dir');
    const unsafe = createMutationLockManager({ homeDirectory: root, timeoutMs: 5 });
    await assert.rejects(() => unsafe.acquire(identity.instance), /not a real directory/);
    fs.unlinkSync(path.join(root, '.ploinky-box'));

    const manager = createMutationLockManager({ homeDirectory: root });
    let acquisitions = 0;
    const value = await withWorkspaceMutationLock({
        resolveIdentity: () => identity,
        lockManager: {
            async acquire(instance) {
                acquisitions += 1;
                return manager.acquire(instance);
            },
        },
        execute(resolved, lock) {
            lock.assertHeld(resolved.instance);
            return 'done';
        },
    });
    assert.equal(value, 'done');
    assert.equal(acquisitions, 1);
});

test('bounded identity handoff releases the provisional lock before parent mutation', async (t) => {
    const root = fixture(t);
    const parent = path.join(root, 'parent');
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });
    const provisional = buildWorkspaceIdentity(child);
    const resolved = buildWorkspaceIdentity(parent, { markerFound: true });
    const events = [];
    let resolutions = 0;
    const result = await withWorkspaceMutationLock({
        resolveIdentity() {
            resolutions += 1;
            return resolutions === 1 ? provisional : resolved;
        },
        lockManager: {
            async acquire(instance) {
                events.push(`acquire:${instance}`);
                let released = false;
                return {
                    assertHeld() { assert.equal(released, false); },
                    release() {
                        assert.equal(released, false);
                        released = true;
                        events.push(`release:${instance}`);
                    },
                };
            },
        },
        execute(identity) {
            events.push(`mutate:${identity.instance}`);
        },
    });
    assert.equal(result, undefined);
    assert.deepEqual(events, [
        `acquire:${provisional.instance}`,
        `release:${provisional.instance}`,
        `acquire:${resolved.instance}`,
        `mutate:${resolved.instance}`,
        `release:${resolved.instance}`,
    ]);
});
