// Old-vs-current differential proof (failing-before) lives in evidence/lane-update-cache/execution_checkpoint_20261004_codex/ (untracked, outside the repository).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { manifestFixture, expectationFixture, installPureGuards } from './test_support.mjs';
import * as current from './execution.mjs';
import { LIMITS, parseManifestBytes } from './manifest.mjs';
import { readManifestFile } from './run.mjs';
import { buildUpdateResult } from '../../../cli/commands/updateOutcome.js';
installPureGuards();

async function baseProof() {
    const { value } = manifestFixture(), { expected, records } = expectationFixture(value);
    expected.recordIds.push('ploinky'); records.unshift({ phase: 'host-ploinky', id: 'ploinky', outcome: 'unchanged', required: true, code: '' });
    const context = { schema: 'ploinky-update-context', version: 1, workspace: { instance: value.workspace.instance, workspaceRoot: value.workspace.path },
        request: { kind: 'all', folder: null, folderPath: null }, scope: null, box: { containerId: value.box.id, engine: value.engine.identity, imageId: value.box.imageId } };
    const result = buildUpdateResult({ command: ['update'], records, context }); result.activation = { outcome: 'restarted', activationAllowed: true };
    const proof = await current.invokeOuterApi({ manifest: value, operation: 'normal-update', expected }, { runOuterCli: async (_args, options) => {
        options.onUpdateResult({ result, failed: false, activation: result.activation }); return 0;
    } });
    return { value, expected, proof };
}
function worker(subject, fixture, { text, delayedClose = false, slowCurrent = false } = {}) {
    const child = new EventEmitter(); child.pid = 10001; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdio = [null, child.stdout, child.stderr, new EventEmitter()];
    let clock = 0, sent = false, reads = 0, launches = 0; const latch = subject.createStopLatch(), custody = subject.createOwnedCustody();
    const normal = JSON.stringify({ type: 'UPDATE_RESULT', runId: fixture.value.runId, operation: 'normal-update', proof: fixture.proof });
    const adapters = { latch, custody, now: () => clock, launch() { launches++; return child; }, register: () => ({ pid: child.pid }),
        current() { reads++; if (slowCurrent) clock = LIMITS.commandMs + 1; return null; },
        delay: async ms => { clock += delayedClose ? LIMITS.commandMs + 1 : ms;
            if (!sent) { sent = true; child.stdio[3].emit('data', Buffer.from(text ?? normal));
                for (const stream of [child.stdout, child.stderr, child.stdio[3]]) { stream.emit('end'); stream.emit('close'); } child.emit('close', 0, null); }
        } };
    const input = { manifest: fixture.value, operation: 'normal-update', expected: fixture.expected,
        workerPath: path.join(fixture.value.candidate.root, 'tests/e2e/liveUpdateCache/execution.mjs'),
        workerInputPath: path.join(fixture.value.evidence.root, 'normal-update_input_codex.json') };
    return { input, adapters, launches: () => launches, reads: () => reads, child };
}
test('corrupted FD3 omits/duplicates success or carries hex-like code: exact old settles, corrected handoff blocks later launch', async () => {
    for (const corruption of ['missing', 'duplicate', 'hex']) {
        const fixture = await baseProof(), altered = structuredClone(fixture.proof);
        if (corruption === 'missing') altered.result.records.shift();
        if (corruption === 'duplicate') altered.result.records.push({ ...altered.result.records[0] });
        if (corruption === 'hex') altered.result.records[0].code = 'abcdef0123456789abcdef01';
        const text = JSON.stringify({ type: 'UPDATE_RESULT', runId: fixture.value.runId, operation: 'normal-update', proof: altered });
        const after = worker(current, fixture, { text });
        const receipt = await current.superviseOwnedUpdate(after.input, after.adapters);
        assert.equal(receipt.resourceDisposition, 'HANDOFF_REQUIRED'); assert.equal(receipt.uncertain, true); assert.equal(after.adapters.custody.snapshot()[0].settled, false);
        await assert.rejects(current.superviseOwnedUpdate(after.input, after.adapters)); assert.equal(after.launches(), 1);
        assert.equal(JSON.stringify(receipt).includes('abcdef0123456789abcdef01'), false);
    }
});
test('duplicate and escaped-equivalent FD3 keys cannot overwrite an invalid value into a valid proof', async () => {
    const fixture = await baseProof(), normal = JSON.stringify({ type: 'UPDATE_RESULT', runId: fixture.value.runId, operation: 'normal-update', proof: fixture.proof });
    for (const replacement of ['"fulfilled":false,"fulfilled":true', '"fulfilled":false,"fulfill\\u0065d":true']) {
        const text = normal.replace('"fulfilled":true', replacement), after = worker(current, fixture, { text });
        const receipt = await current.superviseOwnedUpdate(after.input, after.adapters);
        assert.equal(receipt.reason, 'worker-control-json'); assert.equal(after.adapters.custody.snapshot()[0].settled, false); assert.equal(receipt.uncertain, true);
    }
});
test('valid close/proof delivered after command deadline or slow existing incarnation read cannot settle success', async () => {
    for (const options of [{ delayedClose: true }, { slowCurrent: true }]) {
        const fixture = await baseProof(), after = worker(current, fixture, options);
        const receipt = await current.superviseOwnedUpdate(after.input, after.adapters);
        assert.equal(receipt.reason, 'worker-deadline'); assert.equal(receipt.retained.childClosed, true); assert.equal(receipt.retained.pipesClosed, true);
        assert.equal(after.adapters.custody.snapshot()[0].settled, false); assert.equal(receipt.resourceDisposition, 'HANDOFF_REQUIRED');
        await assert.rejects(current.superviseOwnedUpdate(after.input, after.adapters)); assert.equal(after.launches(), 1);
    }
});

function growingIO(cap) {
    const bytes = Buffer.alloc(cap + 64, 65); let observed = 0, offset = 0, closes = 0, requested = 0, wholeRead = false;
    const io = { realpathSync: file => file, openSync: () => 1,
        fstatSync: () => ({ isFile: () => true, nlink: 1, mode: 0o100600, uid: 1000, dev: 1, ino: 2, size: observed++ ? bytes.length : 16 }),
        readFileSync() { wholeRead = true; requested = bytes.length; return bytes; },
        readSync(_fd, buffer, start, length) { requested += length; const count = Math.min(length, bytes.length - offset); bytes.copy(buffer, start, offset, offset + count); offset += count; return count; },
        closeSync() { closes++; } };
    return { io, facts: () => ({ closes, requested, wholeRead }) };
}
test('post-stat growth bounds actual descriptor requests at cap+1, closes once and imports no API', async () => {
    const fixture = manifestFixture();
    {
        const grown = growingIO(LIMITS.readBytes); let imports = 0;
        await assert.rejects(current.loadPinnedOuterApi(fixture.value, { io: grown.io, importModule: async () => { imports++; return {}; } }));
        assert.equal(imports, 0); assert.equal(grown.facts().closes, 1);
        assert.equal(grown.facts().wholeRead, false); assert(grown.facts().requested <= LIMITS.readBytes + 1);
    }
    {
        const grown = growingIO(LIMITS.manifestBytes); assert.throws(() => readManifestFile('/owned/manifest_codex.json', grown.io)); assert.equal(grown.facts().closes, 1);
        assert.equal(grown.facts().wholeRead, false); assert(grown.facts().requested <= LIMITS.manifestBytes + 1);
    }
});
test('complete timely proof and unchanged bounded manifest/API source preserve normal success', async () => {
    const fixture = await baseProof(), after = worker(current, fixture);
    const receipt = await current.superviseOwnedUpdate(after.input, after.adapters);
    assert.equal(receipt.fulfilled, true); assert.equal(after.adapters.custody.snapshot()[0].settled, true);
    assert.deepEqual(parseManifestBytes(Buffer.from(JSON.stringify(fixture.value))), fixture.value);
    const ioFor = bytes => { let offset = 0, closed = 0;
        const io = { realpathSync: file => file, openSync: () => 1,
            fstatSync: () => ({ isFile: () => true, nlink: 1, mode: 0o100600, uid: 1000, dev: 1, ino: 2, size: bytes.length }),
            readSync(_fd, buffer, start, length) { const count = Math.min(length, bytes.length - offset); bytes.copy(buffer, start, offset, offset + count); offset += count; return count; },
            closeSync() { closed++; } };
        return { io, closed: () => closed };
    };
    const manifestIO = ioFor(Buffer.from(JSON.stringify(fixture.value)));
    assert.deepEqual(parseManifestBytes(readManifestFile('/owned/manifest_codex.json', manifestIO.io)), fixture.value); assert.equal(manifestIO.closed(), 1);
    const sourceIO = ioFor(Buffer.from('api-source-bytes')); let imports = 0; const api = async () => 0;
    await assert.rejects(current.loadPinnedOuterApi(fixture.value, { io: sourceIO.io, importModule: async () => { imports++; return { runOuterCli: api }; } }), error => error.code === 'runtime-import-binding-unproven');
    assert.equal(imports, 0); assert.equal(sourceIO.closed(), 1);
});
