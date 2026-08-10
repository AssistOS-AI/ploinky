import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
    guardSpawnedChild,
    waitForChildSpawn,
} from '../../cli/utils/childSpawn.js';

function childWithPid(pid) {
    const child = new EventEmitter();
    child.pid = pid;
    return child;
}

test('an asynchronous spawn error rejects instead of becoming uncaught', async () => {
    const child = childWithPid(undefined);
    const waiting = waitForChildSpawn(child, { label: 'detached worker' });
    const cause = Object.assign(new Error('ENOENT: worker executable missing'), { code: 'ENOENT' });
    child.emit('error', cause);
    await assert.rejects(waiting, (error) => (
        error.code === 'CHILD_SPAWN_FAILED'
        && error.cause === cause
        && /detached worker failed to spawn/.test(error.message)
    ));
    assert.equal(child.listenerCount('spawn'), 0);
    assert.equal(child.listenerCount('error'), 0);
});

test('spawn confirmation requires a positive pid and retains a late-error guard', async () => {
    const child = childWithPid(4321);
    const late = [];
    const waiting = waitForChildSpawn(child, {
        label: 'no-wait worker',
        onLateError: (error) => late.push(error.message),
    });
    child.emit('spawn');
    assert.equal(await waiting, 4321);
    assert.equal(child.listenerCount('error'), 1);
    child.emit('error', new Error('late channel failure'));
    assert.deepEqual(late, ['late channel failure']);
    assert.equal(child.listenerCount('error'), 0);

    const missingPid = childWithPid(undefined);
    const rejected = waitForChildSpawn(missingPid, { label: 'missing-pid worker' });
    missingPid.emit('spawn');
    await assert.rejects(rejected, (error) => error.code === 'CHILD_SPAWN_FAILED');
    // A later native error still has a listener after the caller has unwound.
    assert.equal(missingPid.listenerCount('error'), 1);
    missingPid.emit('error', new Error('late ENOENT'));
});

test('synchronous pid guards consume pending errors on both failure and success paths', () => {
    const missingPid = childWithPid(undefined);
    const observed = [];
    assert.throws(
        () => guardSpawnedChild(missingPid, {
            label: 'sandbox child',
            onError: (error) => observed.push(error.message),
        }),
        (error) => error.code === 'CHILD_SPAWN_FAILED',
    );
    assert.equal(missingPid.listenerCount('error'), 1);
    missingPid.emit('error', new Error('async EACCES'));
    assert.deepEqual(observed, ['async EACCES']);

    const launched = childWithPid(9876);
    assert.equal(guardSpawnedChild(launched, {
        onError: (error) => observed.push(error.message),
    }), 9876);
    launched.emit('error', new Error('late runtime error'));
    assert.deepEqual(observed, ['async EACCES', 'late runtime error']);
});
