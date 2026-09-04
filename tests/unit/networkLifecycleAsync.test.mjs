import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    acquireNetworkLifecycleLock,
    assertNetworkLifecycleCapability,
    withNetworkLifecycleLock,
    withNetworkLifecycleLockAsync,
} from '../../cli/sandbox/networkLifecycle.js';

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-network-async-wait-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { lockPath: path.join(dir, 'network.lock'), waitMs: 1000, pollMs: 10 };
}

test('async network wait serializes against a real different-process live lock owner', { timeout: 3000 }, async (t) => {
    const options = fixture(t);
    const moduleUrl = new URL('../../cli/sandbox/networkLifecycle.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { acquireNetworkLifecycleLock } from ${JSON.stringify(moduleUrl)};
        const owner = acquireNetworkLifecycleLock({ lockPath: process.argv[1] });
        process.stdout.write('locked\\n');
        process.stdin.once('data', () => { owner.release(); process.stdin.destroy(); });
    `, options.lockPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    t.after(async () => { if (child.exitCode === null) child.kill(); await closed; });
    await once(child.stdout, 'data');
    assert.equal(JSON.parse(fs.readFileSync(options.lockPath)).pid, child.pid);
    let entered = false;
    const waiter = withNetworkLifecycleLockAsync((capability) => {
        entered = true;
        assertNetworkLifecycleCapability(capability, options);
        return 'attached';
    }, options);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(entered, false);
    child.stdin.end('release');
    assert.equal(await waiter, 'attached');
    assert.deepEqual(await closed, [0, null]);
    assert.equal(fs.existsSync(options.lockPath), false);
});

test('async network wait never retries a callback failure with a contention code', async (t) => {
    const options = fixture(t);
    let calls = 0;
    const failure = Object.assign(new Error('mutation failed, not acquisition'), { code: 'PLOINKY_NETWORK_LIFECYCLE_BUSY' });
    await assert.rejects(withNetworkLifecycleLockAsync(() => {
        calls += 1;
        throw failure;
    }, options), (error) => error === failure);
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(options.lockPath), false);
});

test('async network wait preserves path-bound reentrancy and invalidates released capabilities', async (t) => {
    const options = fixture(t);
    let captured;
    await withNetworkLifecycleLockAsync(async (capability) => {
        captured = capability;
        assert.equal(await withNetworkLifecycleLockAsync((inner) => inner, options), capability);
        assert.equal(withNetworkLifecycleLock((inner) => inner, options), capability);
        await assert.rejects(withNetworkLifecycleLockAsync(() => assert.fail('wrong path'), {
            ...options, lockPath: `${options.lockPath}-other`, capability,
        }), { code: 'PLOINKY_NETWORK_LIFECYCLE_CAPABILITY_REQUIRED' });
    }, options);
    await assert.rejects(withNetworkLifecycleLockAsync(() => assert.fail('expired capability'), {
        ...options, capability: captured,
    }), { code: 'PLOINKY_NETWORK_LIFECYCLE_CAPABILITY_REQUIRED' });
});

test('async network wait revalidates a successor owner and cannot release or steal its lock', async (t) => {
    const options = fixture(t);
    const first = acquireNetworkLifecycleLock(options);
    let entered = false;
    const waiter = withNetworkLifecycleLockAsync(() => { entered = true; }, options);
    fs.unlinkSync(options.lockPath);
    const successor = acquireNetworkLifecycleLock(options);
    first.release();
    try {
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(entered, false);
        assert.equal(JSON.parse(fs.readFileSync(options.lockPath)).token, successor.token);
    } finally {
        successor.release();
    }
    await waiter;
    assert.equal(entered, true);
    assert.equal(fs.existsSync(options.lockPath), false);
});

test('async network wait fails immediately for zero budget and never steals a live owner', async (t) => {
    const options = fixture(t);
    const owner = acquireNetworkLifecycleLock(options);
    try {
        await assert.rejects(withNetworkLifecycleLockAsync(() => assert.fail('contended callback'), {
            ...options, waitMs: 0,
        }), { code: 'PLOINKY_NETWORK_LIFECYCLE_BUSY' });
        assert.equal(JSON.parse(fs.readFileSync(options.lockPath)).token, owner.token);
    } finally {
        owner.release();
    }
});

test('async network wait rejects unbounded and malformed budgets before acquiring a lock', async (t) => {
    const options = fixture(t);
    for (const waitMs of [-1, NaN, Infinity, 'not-a-number']) {
        await assert.rejects(withNetworkLifecycleLockAsync(() => assert.fail('invalid budget'), {
            ...options, waitMs,
        }), RangeError);
        assert.equal(fs.existsSync(options.lockPath), false);
    }
    await assert.rejects(withNetworkLifecycleLockAsync(() => assert.fail('invalid poll'), {
        ...options, pollMs: Infinity,
    }), RangeError);
    await assert.rejects(withNetworkLifecycleLockAsync(null, options), /requires a callback/);
});
