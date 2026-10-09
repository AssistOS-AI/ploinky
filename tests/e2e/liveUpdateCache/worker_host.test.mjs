import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { manifestFixture, expectationFixture, installPureGuards } from './test_support.mjs';
import { createFakeHost, byArgs } from './fake_host_support.mjs';
import { createWorkerHost, writeInputOnce } from './worker_host.mjs';
installPureGuards();

function memoryFs() {
    const files = new Map(), open = new Map(); let next = 10;
    const err = code => Object.assign(new Error(code), { code });
    return { files, openSync: (file, flags) => { const writing = (flags & 0o3) !== 0; if (writing) { if (files.has(file)) throw err('EEXIST'); files.set(file, Buffer.alloc(0)); } else if (!files.has(file)) throw err('ENOENT');
            const fd = next++; open.set(fd, { file, offset: 0 }); return fd; },
        fstatSync: fd => { const bytes = files.get(open.get(fd).file); return { isFile: () => true, nlink: 1, size: bytes.length, mode: 0o100600 }; },
        readSync: (fd, buffer, start, length) => { const state = open.get(fd), bytes = files.get(state.file), count = Math.min(length, bytes.length - state.offset); bytes.copy(buffer, start, state.offset, state.offset + count); state.offset += count; return count; },
        writeSync: (fd, bytes, offset, length) => { const state = open.get(fd); files.set(state.file, Buffer.concat([files.get(state.file), bytes.subarray(offset, offset + length)])); return length; }, closeSync: fd => { open.delete(fd); } };
}
function build(routes = [], overrides = {}) {
    const { value: manifest } = manifestFixture(), fake = createFakeHost(routes), fsIo = memoryFs();
    const observer = overrides.observer ?? { register: () => ({ id: 1 }), current: () => null };
    const host = createWorkerHost({ manifest, deps: { ...fake.deps, register: observer.register, current: observer.current }, io: fsIo, processEnv: { PATH: '/usr/bin', HOME: '/home/skutner', NODE_OPTIONS: '--require x', SECRET: 'PRIVATE-SENTINEL', XDG_RUNTIME_DIR: '/run/user/1000' } });
    return { manifest, fake, fsIo, host, routes };
}
const statusProof = { state: 'running-initialized', owned: true, initialized: true, routingConfigured: true, trackedAgents: 2, runningAgents: 2, pendingActivation: false, recoveryBarrier: false, stateReadErrors: 0 };
const worker = manifest => path.join(manifest.candidate.root, 'tests/e2e/liveUpdateCache/execution.mjs');

test('status runs the pinned Node on the fixed worker with a private environment and returns only the public proof', async () => {
    const routes = [{ match: byArgs('--owned-status'), reply: ({ args }) => ({ control: JSON.stringify({ type: 'STATUS_RESULT', runId: 'update-cache-20261004T120000Z-1234abcd_codex', proof: statusProof }), args }) }];
    const h = build(routes); const proof = await h.host.status();
    assert.deepEqual(proof, statusProof); const [launch] = h.fake.log;
    assert.equal(launch.bin, h.manifest.host.node.path); assert.deepEqual(launch.args, [worker(h.manifest), '--owned-status', path.join(h.manifest.evidence.root, 'status_input_codex.json')]);
    assert.deepEqual(launch.options.stdio, ['ignore', 'pipe', 'pipe', 'pipe']); assert.equal(launch.options.cwd, h.manifest.workspace.path);
    assert.deepEqual(Object.keys(launch.options.env).sort(), ['GIT_TERMINAL_PROMPT', 'HOME', 'LC_ALL', 'PATH', 'PLOINKY_WORKSPACE_ROOT', 'XDG_RUNTIME_DIR']);
    assert.equal(launch.options.env.PLOINKY_WORKSPACE_ROOT, h.manifest.workspace.path);
    const written = JSON.parse(h.fsIo.files.get(path.join(h.manifest.evidence.root, 'status_input_codex.json')));
    assert.deepEqual(Object.keys(written), ['schemaVersion', 'kind', 'runId', 'operation', 'manifest']); assert.deepEqual(written.manifest, h.manifest);
    await h.host.status(); assert.equal(h.fake.log.length, 2, 'the identical private input is reused, never rewritten');
});

test('status refuses failure frames, mismatched run identity, extra fields and a pass with the wrong exit status', async () => {
    const run = 'update-cache-20261004T120000Z-1234abcd_codex';
    for (const [label, reply, code] of [
        ['worker failure', { control: JSON.stringify({ type: 'WORKER_FAILURE', runId: run, operation: 'status', reason: 'node-unqualified' }), code: 2 }, 'worker-node-unqualified'],
        ['failure with exit 0', { control: JSON.stringify({ type: 'WORKER_FAILURE', runId: run, operation: 'status', reason: 'node-unqualified' }), code: 0 }, 'worker-result-binding'],
        ['other run', { control: JSON.stringify({ type: 'STATUS_RESULT', runId: 'other', proof: statusProof }) }, 'worker-result-binding'],
        ['extra proof field', { control: JSON.stringify({ type: 'STATUS_RESULT', runId: run, proof: { ...statusProof, env: 'PRIVATE' } }) }, 'live-status-proof'],
        ['exit 2 with a result', { control: JSON.stringify({ type: 'STATUS_RESULT', runId: run, proof: statusProof }), code: 2 }, 'worker-result-binding'],
        ['no frame', { code: 0 }, 'worker-control-json'], ['garbage', { control: 'not json' }, 'worker-control-json'], ['exit 1', { control: '{}', code: 1 }, 'command-exit-unexpected']]) {
        const h = build([{ match: byArgs('--owned-status'), reply: () => reply }]);
        await assert.rejects(h.host.status(), error => error.code === code, label);
    }
});

test('update writes one exclusive input, supervises the exact worker child and refuses reuse or a failure frame', async () => {
    const { value } = manifestFixture(), { expected } = expectationFixture(value);
    const h = build([{ match: byArgs('--owned-update'), reply: () => ({ control: JSON.stringify({ type: 'WORKER_FAILURE', runId: value.runId, operation: 'normal-update', reason: 'preload-configuration' }), code: 2 }) }]);
    await assert.rejects(h.host.update('normal-update', expected), error => error.code === 'worker-preload-configuration');
    const [launch] = h.fake.log; assert.equal(launch.bin, h.manifest.host.node.path);
    assert.deepEqual(launch.args, [worker(h.manifest), '--owned-update', path.join(h.manifest.evidence.root, 'normal-update_input_codex.json'), 'normal-update']);
    assert.deepEqual(launch.options.stdio, ['ignore', 'pipe', 'pipe', 'pipe']); assert.equal(Object.hasOwn(launch.options.env, 'NODE_OPTIONS'), false); assert.equal(launch.options.env.SECRET, undefined);
    const input = JSON.parse(h.fsIo.files.get(path.join(h.manifest.evidence.root, 'normal-update_input_codex.json')));
    assert.deepEqual(Object.keys(input), ['schemaVersion', 'kind', 'runId', 'operation', 'manifest', 'expected', 'admitted']); assert.deepEqual(input.expected, expected);
    assert.equal(h.fake.latch.snapshot().uncertain, true); await assert.rejects(h.host.update('normal-update', expected));
    assert.equal(h.fake.log.length, 1, 'no second launch after the first operation latched the run');
    await assert.rejects(build().host.update('unknown-op', expected), error => error.code === 'update-operation');
    await assert.rejects(build().host.update('normal-update', { errors: [], blockedBy: [], recordIds: ['not-allowed'] }), error => error.code === 'update-expectation');
    const again = build(); again.fsIo.files.set(path.join(again.manifest.evidence.root, 'normal-update_input_codex.json'), Buffer.from('x'));
    await assert.rejects(again.host.update('normal-update', expected), error => error.code === 'worker-input-conflict' || error.code === 'worker-input-write');
    assert.equal(again.fake.log.length, 0);
});

test('the observed vocabulary is written into the worker input and a hidden id never launches the worker', async () => {
    const { value } = manifestFixture(), { expected } = expectationFixture(value), pin = 'e'.repeat(64), withPin = { ...expected, recordIds: [...expected.recordIds, pin] };
    const h = build([{ match: byArgs('--owned-update'), reply: () => ({ control: JSON.stringify({ type: 'WORKER_FAILURE', runId: value.runId, operation: 'normal-update', reason: 'x' }), code: 2 }) }]);
    await assert.rejects(h.host.update('normal-update', withPin, [pin]));
    const input = JSON.parse(h.fsIo.files.get(path.join(h.manifest.evidence.root, 'normal-update_input_codex.json'))); assert.deepEqual(input.admitted, [pin]); assert.ok(input.expected.recordIds.includes(pin));
    const hidden = build(); await assert.rejects(hidden.host.update('normal-update', withPin), error => error.code === 'update-expectation'); assert.equal(hidden.fake.log.length, 0); assert.equal(hidden.fsIo.files.size, 0);
});

test('input files are created exclusively and an existing file must be byte-identical and private', () => {
    const io = memoryFs(); assert.equal(writeInputOnce(io, '/e/a_codex.json', Buffer.from('abc')), true); assert.equal(writeInputOnce(io, '/e/a_codex.json', Buffer.from('abc')), false);
    assert.throws(() => writeInputOnce(io, '/e/a_codex.json', Buffer.from('abd')), error => error.code === 'worker-input-conflict');
    assert.throws(() => writeInputOnce(io, '/e/a_codex.json', Buffer.from('abcd')), error => error.code === 'worker-input-conflict');
    assert.throws(() => writeInputOnce(io, '/e/b_codex.json', Buffer.alloc(0)), error => error.code === 'worker-input-size');
    const loose = { ...io, fstatSync: fd => ({ ...io.fstatSync(fd), mode: 0o100666 }) }; assert.throws(() => writeInputOnce(loose, '/e/a_codex.json', Buffer.from('abc')), error => error.code === 'worker-input-conflict');
});
