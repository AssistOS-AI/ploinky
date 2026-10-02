import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartupFailureRecorder } from '../../cli/server/webchat/startupFailure.js';

test('startup failure retains bounded redacted stderr and exit details once', () => {
    const records = [];
    const recorder = createStartupFailureRecorder(record => records.push(record));
    recorder.append('x'.repeat(10000));
    recorder.append('\nNetwork lifecycle is busy\nAuthorization: Bearer sensitive-value\npassword=hidden\n');
    recorder.failed({ pid: 12, code: 1, signal: null });
    recorder.failed({ pid: 12, code: 1, signal: null });
    assert.equal(records.length, 1);
    assert.equal(records[0].code, 1);
    assert.ok(records[0].stderr.length <= 4000);
    assert.match(records[0].stderr, /Network lifecycle is busy/);
    assert.doesNotMatch(records[0].stderr, /sensitive-value|hidden/);
});

test('successful startup discards diagnostics and never logs normal session closure', () => {
    const records = [];
    const recorder = createStartupFailureRecorder(record => records.push(record));
    recorder.append('startup warning');
    recorder.ready();
    recorder.append('conversation content');
    recorder.failed({ code: 0 });
    assert.deepEqual(records, []);
});

test('a short startup failure preserves the actual error', () => {
    const records = [];
    const recorder = createStartupFailureRecorder(record => records.push(record));
    recorder.append('Network lifecycle is busy\n');
    recorder.failed({ code: 1 });
    assert.match(records[0].stderr, /Network lifecycle is busy/);
});
