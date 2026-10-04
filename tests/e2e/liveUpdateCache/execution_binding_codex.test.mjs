import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { manifestFixture, expectationFixture, installPureGuards } from './test_support_codex.mjs';
import * as current from './execution_codex.mjs';
import { validateManifest } from './manifest_codex.mjs';
import { buildUpdateResult } from '../../../cli/commands/updateOutcome.js';
installPureGuards();
const oldRoot = new URL('../../../../../evidence/lane-update-cache/execution_checkpoint_20261004_codex/review_delta1_codex/candidate/tests/e2e/liveUpdateCache/', import.meta.url);
const old = await import(new URL('execution_codex.mjs', oldRoot));
const oldManifest = await import(new URL('manifest_codex.mjs', oldRoot));

test('ancestor evidence root or individually protected evidence destinations cannot launder source/workspace ownership', () => {
    for (const protectedTree of ['candidate', 'workspace']) {
        const { value } = manifestFixture(); value.evidence.root = '/home/skutner/work';
        value.evidence.receipt = path.join(protectedTree === 'candidate' ? value.candidate.root : value.workspace.path, 'receipt_codex.json');
        assert.equal(oldManifest.validateManifest(value), value); assert.throws(() => validateManifest(value), error => error.code === 'evidence-root' || error.code === 'evidence-files');
    }
    const { value } = manifestFixture(); assert.equal(validateManifest(value), value);
    value.evidence.sourceManifest = path.join(value.candidate.repositories[3].path, 'source_codex.json'); assert.throws(() => validateManifest(value));
});
async function asyncBinding(subject, mutate, cancel = false) {
    const { value } = manifestFixture(), initial = structuredClone(value), { expected, records } = expectationFixture(value);
    const context = { schema: 'ploinky-update-context', version: 1, workspace: { instance: value.workspace.instance, workspaceRoot: value.workspace.path },
        request: { kind: 'all', folder: null, folderPath: null }, scope: null, box: { containerId: value.box.id, engine: value.engine.identity, imageId: value.box.imageId } };
    const result = buildUpdateResult({ command: ['update'], records, context }); result.activation = { outcome: 'restarted', activationAllowed: true };
    const proof = await current.invokeOuterApi({ manifest: initial, operation: 'normal-update', expected }, { runOuterCli: async (_args, options) => {
        options.onUpdateResult({ result, failed: false, activation: result.activation }); return 0;
    } });
    const child = new EventEmitter(); child.pid = 10001; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdio = [null, child.stdout, child.stderr, new EventEmitter()];
    const latch = subject.createStopLatch(), custody = subject.createOwnedCustody(); let clock = 0, launches = 0, sent = false;
    const input = { manifest: value, operation: 'normal-update', expected,
        workerPath: path.join(value.candidate.root, 'tests/e2e/liveUpdateCache/execution_codex.mjs'), workerInputPath: path.join(value.evidence.root, 'normal-update_input_codex.json') };
    const adapters = { latch, custody, now: () => clock, launch: () => { launches++; return child; },
        register: (_child, metadata) => { assert.equal(metadata.runId, initial.runId); return { pid: child.pid }; }, current: () => null,
        delay: async ms => { clock += ms; if (!sent) { sent = true;
            if (mutate) value.runId = value.runId.replace('1234abcd', 'fedcba98');
            child.stdio[3].emit('data', Buffer.from(JSON.stringify({ type: 'UPDATE_RESULT', runId: value.runId, operation: 'normal-update', proof })));
            for (const stream of [child.stdout, child.stderr, child.stdio[3]]) { stream.emit('end'); stream.emit('close'); } child.emit('close', 0, null);
            if (cancel) latch.stop('caller-cancelled');
        } } };
    const receipt = await subject.superviseOwnedUpdate(input, adapters);
    return { receipt, custody, launches: () => launches, again: () => subject.superviseOwnedUpdate({ ...input, manifest: initial }, adapters) };
}
test('sealed per-launch run/expectation binding rejects later-mutated caller identity and preserves normal/cancelled outcomes', async () => {
    const before = await asyncBinding(old, true), after = await asyncBinding(current, true);
    assert.equal(before.receipt.fulfilled, true); assert.equal(before.custody.snapshot()[0].runId.includes('1234abcd'), true);
    assert.equal(after.receipt.reason, 'worker-result-binding'); assert.equal(after.receipt.resourceDisposition, 'HANDOFF_REQUIRED'); assert.equal(after.custody.snapshot()[0].settled, false);
    await assert.rejects(after.again()); assert.equal(after.launches(), 1);
    const normal = await asyncBinding(current, false); assert.equal(normal.receipt.fulfilled, true); assert.equal(normal.custody.snapshot()[0].settled, true);
    const cancellation = await asyncBinding(current, false, true); assert.equal(cancellation.receipt.resourceDisposition, 'HANDOFF_REQUIRED'); assert.equal(cancellation.custody.snapshot()[0].settled, false);
});
function pathIO(replace) {
    const bytes = Buffer.from('api-source-bytes'); let offset = 0, closed = 0, swapped = false, imports = 0;
    const good = async () => 0, bad = async () => { throw new Error('PRIVATE-UNPINNED'); };
    const io = { realpathSync: file => file, openSync: () => 1, fstatSync: () => ({ isFile: () => true, dev: 1, ino: 2, size: bytes.length }),
        readSync(_fd, buffer, start, length) { const count = Math.min(length, bytes.length - offset); bytes.copy(buffer, start, offset, offset + count); offset += count; return count; },
        closeSync() { closed++; if (replace) swapped = true; } };
    return { io, importModule: async () => { imports++; return { runOuterCli: swapped ? bad : good }; }, bad, facts: () => ({ closed, imports }) };
}
test('verified descriptor cannot authorize unchecked ESM path re-open; replacement and unchanged paths refuse before import', async () => {
    const { value } = manifestFixture(), before = pathIO(true);
    assert.equal(await old.loadPinnedOuterApi(value, before), before.bad); assert.deepEqual(before.facts(), { closed: 1, imports: 1 });
    for (const replace of [true, false]) {
        const after = pathIO(replace);
        await assert.rejects(current.loadPinnedOuterApi(value, after), error => error.code === 'runtime-import-binding-unproven');
        assert.deepEqual(after.facts(), { closed: 1, imports: 0 });
    }
});
