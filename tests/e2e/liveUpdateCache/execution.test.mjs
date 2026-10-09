import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { manifestFixture, expectationFixture, installPureGuards } from './test_support.mjs';
import { invokeOuterApi, updateArguments, createDiscardOutput, createStopLatch, createOwnedCustody,
    superviseOwnedUpdate, loadPinnedOuterApi, validatePublicWorkerProof } from './execution.mjs';
import { LIMITS } from './manifest.mjs';
import { buildUpdateResult } from '../../../cli/commands/updateOutcome.js';
installPureGuards();

function observation(manifest, operation, records) {
    const scoped = ['optional-negative', 'required-negative'].includes(operation) ? manifest.negativeScopes.optional : null;
    const context = { schema: 'ploinky-update-context', version: 1,
        workspace: { instance: manifest.workspace.instance, workspaceRoot: manifest.workspace.path },
        request: { kind: 'all', folder: scoped, folderPath: scoped },
        scope: scoped ? { relative: scoped.slice(manifest.workspace.path.length + 1), boxPath: scoped } : null,
        box: { containerId: manifest.box.id, engine: manifest.engine.identity, imageId: `sha256:${manifest.box.imageId}`, workspaceContainers: ['PRIVATE-CATALOG'] },
        source: { nonce: 'PRIVATE-NONCE', environment: 'PRIVATE-ENV' } };
    const result = buildUpdateResult({ command: updateArguments(manifest, operation), records, context });
    result.activation = { outcome: operation === 'required-negative' ? 'deferred' : 'restarted', activationAllowed: result.activationAllowed };
    return { result, failed: result.exitCode !== 0, activation: result.activation };
}
async function proofFixture(operation = 'normal-update') {
    const { value } = manifestFixture(), { expected, records } = expectationFixture(value, operation), obs = observation(value, operation, records);
    let calls = 0;
    const proof = await invokeOuterApi({ manifest: value, operation, expected }, { runOuterCli: async (args, options) => {
        calls++; assert.deepEqual(args, updateArguments(value, operation)); assert.deepEqual(Object.keys(options).sort(), ['errorOutput', 'onUpdateResult', 'output']);
        options.output.write('PRIVATE-LOG'); options.errorOutput.write('PRIVATE-TAIL'); options.onUpdateResult(obs); return obs.result.exitCode;
    } });
    return { value, expected, records, obs, proof, calls };
}
test('normal exit0 and both expected normal exit1 cases use one call and real default option surface', async () => {
    for (const operation of ['normal-update', 'optional-negative', 'required-negative', 'settling-update']) {
        const { proof, calls } = await proofFixture(operation); assert.equal(calls, 1); assert.equal(proof.returnedCode, operation.includes('negative') ? 1 : 0);
        assert.equal(proof.executionInterface, 'outer-cli-api'); assert.equal(proof.graphReadiness, 'UNPROVEN');
        assert.equal(/PRIVATE|nonce|environment|workspaceContainers/.test(JSON.stringify(proof)), false);
    }
});
test('missing/duplicate/error callback, exception/relaunch-like normal return refuse without second call', async () => {
    for (const mode of ['missing', 'duplicate', 'error', 'throw']) {
        const { value } = manifestFixture(), { expected, records } = expectationFixture(value), obs = observation(value, 'normal-update', records);
        let calls = 0; const latch = createStopLatch();
        await assert.rejects(invokeOuterApi({ manifest: value, operation: 'normal-update', expected }, { latch, runOuterCli: async (_args, options) => {
            calls++; if (mode === 'throw') throw new Error('PRIVATE-STACK');
            if (mode !== 'missing') options.onUpdateResult(mode === 'error' ? { ...obs, error: new Error('PRIVATE') } : obs);
            if (mode === 'duplicate') options.onUpdateResult(obs); return 0;
        } }));
        assert.equal(calls, 1); assert.equal(latch.snapshot().uncertain, true); assert.equal(JSON.stringify(latch.snapshot()).includes('PRIVATE'), false);
        await assert.rejects(invokeOuterApi({ manifest: value, operation: 'normal-update', expected }, { latch, runOuterCli: async () => { calls++; } })); assert.equal(calls, 1);
    }
});
test('context/image/request drift, not-required activation, unexpected uncertainty and wrong exit do not prove writers', async () => {
    for (const mutate of [obs => { obs.result.context.box.containerId = 'other'; }, obs => { obs.result.context.request.folder = '/other'; },
        obs => { obs.result.activation.outcome = 'not-required'; }, obs => { obs.result.records[0].outcome = 'uncertain'; }, obs => { obs.result.exitCode = 1; }]) {
        const { value } = manifestFixture(), { expected, records } = expectationFixture(value), obs = observation(value, 'normal-update', structuredClone(records)); mutate(obs);
        await assert.rejects(invokeOuterApi({ manifest: value, operation: 'normal-update', expected }, { runOuterCli: async (_args, options) => { options.onUpdateResult(obs); return 0; } }));
    }
});
test('output overflow latches at write time and expectation/operation failure refuses before API call', async () => {
    const { value } = manifestFixture(), { expected } = expectationFixture(value); let calls = 0;
    for (const [operation, expectation] of [['other', expected], ['normal-update', { ...expected, recordIds: ['PRIVATE'] }]]) {
        await assert.rejects(invokeOuterApi({ manifest: value, operation, expected: expectation }, { runOuterCli: async () => { calls++; } }));
    }
    assert.equal(calls, 0); const latch = createStopLatch();
    await assert.rejects(invokeOuterApi({ manifest: value, operation: 'normal-update', expected }, { latch, output: createDiscardOutput(4), runOuterCli: async (_args, options) => {
        options.output.write('PRIVATE-OVERFLOW'); assert.equal(latch.snapshot().uncertain, true); return 0;
    } }));
});
test('source API reader checks canonical exact bytes but refuses an unproved existing ESM import binding', async () => {
    const { value } = manifestFixture(), bytes = Buffer.from('api-source-bytes'); let imports = 0, closed = 0;
    const io = { realpathSync: file => file, openSync: () => 1, fstatSync: () => ({ isFile: () => true, dev: 1, ino: 2, size: bytes.length }),
        readSync: (_fd, buffer, offset) => { if (offset) return 0; bytes.copy(buffer); return bytes.length; }, closeSync: () => { closed++; } };
    const fn = async () => 0;
    await assert.rejects(loadPinnedOuterApi(value, { io, importModule: async () => { imports++; return { runOuterCli: fn }; } }), error => error.code === 'runtime-import-binding-unproven');
    assert.equal(imports, 0); assert.equal(closed, 1); io.realpathSync = () => '/foreign';
    await assert.rejects(loadPinnedOuterApi(value, { io, importModule: async () => { imports++; } })); assert.equal(imports, 0);
});

function fakeWorker(proof, value, { defaultOutput = 'PRIVATE-DEFAULT-WRITE', registrationError = false, close = true, code = proof.returnedCode } = {}) {
    const child = new EventEmitter(); child.pid = 10001; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdio = [null, child.stdout, child.stderr, new EventEmitter()];
    let clock = 0, deliveries = 0, launches = 0; const latch = createStopLatch(), custody = createOwnedCustody();
    const frame = Buffer.from(JSON.stringify({ type: 'UPDATE_RESULT', runId: value.runId, operation: proof.operation, proof }));
    const adapters = { latch, custody, launch: (node, args, options) => { launches++; assert.equal(node, value.host.node.path); assert.equal(options.cwd, value.workspace.path);
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'pipe']); assert.equal(args[1], '--owned-update'); return child; },
    register: handle => { assert.equal(custody.handles()[0], handle); assert.equal(handle.listenerCount('error'), 1); assert.equal(handle.listenerCount('close'), 1);
        for (const stream of [child.stdout, child.stderr, child.stdio[3]]) for (const type of ['data', 'error', 'end', 'close']) assert.equal(stream.listenerCount(type), 1);
        if (registrationError) throw new Error('PRIVATE-REGISTRATION'); return { pid: child.pid }; },
    current: () => null, now: () => clock, delay: async ms => { clock += close ? ms : LIMITS.commandMs; if (!deliveries++) {
        child.stdout.emit('data', Buffer.from(defaultOutput)); child.stdio[3].emit('data', frame);
        if (close) { for (const stream of [child.stdout, child.stderr, child.stdio[3]]) { stream.emit('end'); stream.emit('close'); } child.emit('close', code, null); }
    } } };
    return { child, adapters, launches: () => launches };
}
const inputs = (value, expected, operation) => ({ manifest: value, expected, operation,
    workerPath: path.join(value.candidate.root, 'tests/e2e/liveUpdateCache/execution.mjs'), workerInputPath: path.join(value.evidence.root, `${operation}_input_codex.json`) });
test('private physical pipes count default API bypass writes and settle fake close/FDs plus normal projected proof', async () => {
    const { value, expected, proof } = await proofFixture(); const w = fakeWorker(proof, value);
    const receipt = await superviseOwnedUpdate(inputs(value, expected, proof.operation), w.adapters);
    assert.equal(receipt.fulfilled, true); assert.equal(receipt.childClosed, true); assert.equal(receipt.pipesClosed, true); assert.equal(receipt.uncertain, false);
    assert(receipt.bytes > 0); assert.equal(JSON.stringify(receipt).includes('PRIVATE'), false); assert.equal(w.adapters.custody.snapshot()[0].settled, true);
});
test('registration failure retains returned handle before throw and monotonically blocks a later launch', async () => {
    const { value, expected, proof } = await proofFixture(), w = fakeWorker(proof, value, { registrationError: true });
    const receipt = await superviseOwnedUpdate(inputs(value, expected, proof.operation), w.adapters);
    assert.equal(receipt.reason, 'worker-setup-failed'); assert.equal(receipt.retained.pid, w.child.pid); assert.equal(w.adapters.custody.handles()[0], w.child);
    await assert.rejects(superviseOwnedUpdate(inputs(value, expected, proof.operation), w.adapters)); assert.equal(w.launches(), 1);
});
test('closed client cannot prove unknown incarnation/server; missing FD close, protocol or overflow retains handoff', async () => {
    for (const mode of ['incarnation', 'control-overflow', 'no-close', 'bad-proof', 'combined-bytes']) {
        const { value, expected, proof } = await proofFixture(); const changed = structuredClone(proof);
        if (mode === 'bad-proof') changed.result.context.boxEqual = false;
        if (mode === 'combined-bytes') changed.output.bytes = LIMITS.outputBytes;
        const w = fakeWorker(changed, value, { close: mode !== 'no-close' });
        if (mode === 'incarnation') w.adapters.current = () => ({ pid: w.child.pid });
        if (mode === 'control-overflow') w.adapters.delay = async () => {
            w.child.stdio[3].emit('data', Buffer.alloc(LIMITS.controlBytes + 1));
            for (const stream of [w.child.stdout, w.child.stderr, w.child.stdio[3]]) { stream.emit('end'); stream.emit('close'); }
            w.child.emit('close', 0, null);
        };
        const receipt = await superviseOwnedUpdate(inputs(value, expected, proof.operation), w.adapters);
        assert.equal(receipt.passed, false); assert.equal(receipt.uncertain, true); assert.equal(receipt.resourceDisposition, 'HANDOFF_REQUIRED');
        assert.equal(w.adapters.custody.snapshot()[0].settled, false);
    }
});
test('public worker projection rejects raw fields/status alteration and keeps graph independently UNPROVEN', async () => {
    const { proof, expected } = await proofFixture();
    for (const mutate of [p => { p.raw = 'PRIVATE'; }, p => { p.result.context.nonce = 'PRIVATE'; }, p => { p.result.status = 'partial'; }, p => { p.graphReadiness = 'ready'; }]) {
        const changed = structuredClone(proof); mutate(changed); assert.throws(() => validatePublicWorkerProof(changed, { operation: proof.operation, returnedCode: 0, expected }));
    }
});

test('default-skills record ids over two known repositories are accepted in an expectation, unknown ones are not', async () => {
    const { manifestFixture, expectationFixture } = await import('./test_support.mjs');
    const { value } = manifestFixture(), { expected } = expectationFixture(value), { validateExpectation } = await import('./execution.mjs');
    assert.doesNotThrow(() => validateExpectation({ ...expected, recordIds: [...expected.recordIds, 'AssistOSExplorer->AchillesCLI'] }, value));
    for (const id of ['AssistOSExplorer->unknown', 'unknown->AchillesCLI', 'a->b->c', '->AchillesCLI', 'AssistOSExplorer->']) {
        assert.throws(() => validateExpectation({ ...expected, recordIds: [...expected.recordIds, id] }, value), error => error.code === 'update-expectation', id);
    }
});
