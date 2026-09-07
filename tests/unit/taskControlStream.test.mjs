import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskControlStream } from '../../Agent/server/taskControlStream.mjs';

test('control frames survive chunk boundaries without leaking handles into logs', () => {
    let log = '';
    const frames = [];
    const stream = createTaskControlStream((text) => { log += text; }, (frame) => frames.push(frame));
    const bytes = Buffer.from('început\n@@PLOINKY_TASK_CONTROL@@{"handle":"private"}\ncontinuă');
    for (const byte of bytes) stream.push(Buffer.from([byte]));
    stream.finish();
    assert.equal(log, 'început\ncontinuă');
    assert.deepEqual(frames, [{ handle: 'private' }]);
});

test('ordinary partial lines stream immediately and embedded prefixes remain logs', () => {
    let log = '';
    const stream = createTaskControlStream((text) => { log += text; }, () => assert.fail('not a frame'));
    stream.push('working');
    assert.equal(log, 'working');
    stream.push(' @@PLOINKY_TASK_CONTROL@@{}\n');
    stream.finish();
    assert.equal(log, 'working @@PLOINKY_TASK_CONTROL@@{}\n');
});
