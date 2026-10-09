import test from 'node:test';
import assert from 'node:assert/strict';
import { installPureGuards } from './test_support.mjs';
import { createMemoryFs } from './fake_fs_support.mjs';
import { createRecoveryLog } from './recovery.mjs';
installPureGuards();

const runId = 'update-cache-20261004T120000Z-1234abcd_codex', root = '/home/skutner/work/evidence/run';
test('each record is a new exclusive private file carrying only nonsecret identities, in order, never rewritten', () => {
    const io = createMemoryFs({ [`${root}/.keep`]: '' }), log = createRecoveryLog({ root, runId, io });
    assert.equal(log.record('fixture-server', { container: { id: 'a'.repeat(64) }, fixtureRoot: { dev: 1, ino: 2 } }), 'recovery_001_fixture-server_codex.json');
    assert.equal(log.record('failure', { phase: 'U4', reason: 'update-records-incomplete' }), 'recovery_002_failure_codex.json');
    const first = JSON.parse(io.files.get(`${root}/recovery_001_fixture-server_codex.json`)); assert.deepEqual(Object.keys(first), ['schemaVersion', 'kind', 'runId', 'label', 'sequence', 'value']); assert.equal(first.sequence, 1); assert.equal(first.runId, runId);
    assert.deepEqual(log.written(), ['recovery_001_fixture-server_codex.json', 'recovery_002_failure_codex.json']);
    // A second log over the same root cannot overwrite an earlier record.
    assert.throws(() => createRecoveryLog({ root, runId, io }).record('fixture-server', {}), error => error.code === 'recovery-write'); assert.equal(JSON.parse(io.files.get(`${root}/recovery_001_fixture-server_codex.json`)).value.container.id, 'a'.repeat(64));
});

test('credential-like fields, non-plain values, oversize records and malformed labels are refused before any file is created', () => {
    const io = createMemoryFs({}), log = createRecoveryLog({ root, runId, io }); let cyc = {}; cyc.self = cyc;
    for (const value of [{ token: 'x' }, { nested: { Password: 'x' } }, { list: [{ apiKey: 'x' }] }, { env: {} }, { environment: 'x' }, { when: new Date() }, { fn: () => 1 }, { big: 'x'.repeat(5000) }, { many: new Array(300).fill(1) }, { deep: JSON.parse('{"a":'.repeat(14) + '1' + '}'.repeat(14)) }, cyc]) {
        assert.throws(() => log.record('x-label', value), error => /^recovery-/.test(error.code) || error instanceof RangeError, JSON.stringify(Object.keys(value ?? {})));
    }
    for (const label of ['', 'Bad', '1a', 'a b', 'x'.repeat(42)]) assert.throws(() => log.record(label, {}), error => error.code === 'recovery-label');
    assert.equal(io.files.size, 0);
    assert.throws(() => createRecoveryLog({ root: 'relative', runId, io }), error => error.code === 'recovery-adapters');
});
