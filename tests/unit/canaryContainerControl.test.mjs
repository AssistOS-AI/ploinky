import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BOX_MARKER_CONTENT, BOX_MARKER_PATH } from '../../ploinky-box/constants.mjs';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-control-'));
const previous = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const { inspectCanaryContainer, removeCanaryContainer } = await import('../../cli/sandbox/docker/containerFleet.js');
const { NETWORK_LABELS, workspaceNetworkIdentity } = await import('../../cli/sandbox/networkIdentity.js');
const { NETWORK_SCHEMA_VERSION } = await import('../../cli/sandbox/networkContract.js');
test.after(() => {
    if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previous;
    fs.rmSync(workspace, { recursive: true, force: true });
});

const name = 'primary__canary';
const id = 'b'.repeat(64);
const rolloutId = 'rollout-fixture';
const record = { type: 'agent', canaryOf: 'alpha', runtime: 'podman', containerId: id,
    instanceId: 'instance', enableGeneration: 'generation', launchId: 'launch-fixture' };
const marker = path.join(workspace, 'box-marker');
const bin = path.join(workspace, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(marker, BOX_MARKER_CONTENT);
fs.writeFileSync(path.join(bin, 'podman'), '#!/bin/sh\nexit 125\n', { mode: 0o700 });

function engine(t) {
    const originalPath = process.env.PATH;
    process.env.PATH = bin + path.delimiter + originalPath;
    const lstat = fs.lstatSync;
    const read = fs.readFileSync;
    t.mock.method(fs, 'lstatSync', (file, ...args) => lstat(file === BOX_MARKER_PATH ? marker : file, ...args));
    t.mock.method(fs, 'readFileSync', (file, ...args) => read(file === BOX_MARKER_PATH ? marker : file, ...args));
    const state = {
        exists: 0,
        calls: [],
        inspected: {
            Id: id, Name: name, State: { Running: false }, HostConfig: { Init: true },
            Config: {
                Labels: {
                    [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'agent',
                    [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION, [NETWORK_LABELS.workspace]: workspaceNetworkIdentity().hash,
                    [NETWORK_LABELS.contract]: 'd'.repeat(64), [NETWORK_LABELS.instanceId]: record.instanceId,
                    [NETWORK_LABELS.enableGeneration]: record.enableGeneration,
                },
                Env: ['PLOINKY_CANARY=1', 'PLOINKY_CANARY_ROLLOUT=' + rolloutId, 'PLOINKY_LAUNCH_ID=' + record.launchId],
            },
        },
    };
    const spawn = childProcess.spawnSync;
    const control = t.mock.method(childProcess, 'spawnSync', (program, args, options) => {
        if (program !== 'podman') return spawn(program, args, options);
        state.calls.push(args);
        if (args[0] === 'container' && args[1] === 'exists') return { status: state.exists };
        if (args[0] === 'container' && args[1] === 'inspect') {
            if (state.inspectionFailure) {
                state.exists = state.afterInspection;
                return state.inspectionFailure;
            }
            return { status: 0, stdout: JSON.stringify([state.inspected]) };
        }
        assert.deepEqual(args, ['rm', '-f', id]);
        state.exists = 1;
        return { status: 0 };
    });
    syncBuiltinESMExports();
    t.after(() => {
        control.mock.restore();
        syncBuiltinESMExports();
        process.env.PATH = originalPath;
    });
    return state;
}

test('Podman existence exits 0, 1 and 125 distinguish an exited canary, absence and uncertain state', t => {
    const state = engine(t);
    for (const status of [0, 1, 125]) {
        state.exists = status;
        state.calls.length = 0;
        if (status === 125) assert.throws(() => inspectCanaryContainer('podman', id), /determine canary container existence/);
        else assert.deepEqual(inspectCanaryContainer('podman', id), status === 0 ? state.inspected : null);
        const expected = [['container', 'exists', id]];
        if (status === 0) expected.push(['container', 'inspect', id]);
        assert.deepEqual(state.calls, expected);
    }
});

test('teardown removes the exited canary by exact ID and proves absence after control', t => {
    const state = engine(t);
    assert.equal(removeCanaryContainer(name, record, { rolloutId }).removed, true);
    assert.deepEqual(state.calls.filter(args => args[0] !== 'container'), [['rm', '-f', id]]);
    assert.deepEqual(state.calls.at(-1), ['container', 'exists', id]);
    assert.ok(state.calls.every(args => args.at(-1) === id));
});

test('inspect exit 125 always refuses teardown, even if a later probe observes absence', t => {
    const state = engine(t);
    state.inspectionFailure = { status: 125, stderr: 'Error: no such container' };
    for (const afterInspection of [0, 125, 1]) {
        state.exists = 0;
        state.afterInspection = afterInspection;
        state.calls.length = 0;
        const remove = () => removeCanaryContainer(name, record, { rolloutId });
        assert.throws(remove, /container inspection failed/);
        assert.deepEqual(state.calls, [['container', 'exists', id], ['container', 'inspect', id]]);
        if (afterInspection === 1) {
            assert.equal(remove().found, false);
            assert.deepEqual(state.calls.at(-1), ['container', 'exists', id]);
        }
    }
});

test('a published record with no launch ID never adopts the live container launch ID', t => {
    const state = engine(t);
    assert.throws(() => removeCanaryContainer(name, { ...record, launchId: undefined }, { rolloutId }), /lacks its launch identity/);
    assert.deepEqual(state.calls, [['container', 'exists', id], ['container', 'inspect', id]]);
});

test('missing rollout IDs in both the request and environment cannot prove canary ownership', t => {
    const state = engine(t);
    state.inspected.Config.Env.splice(1, 1);
    assert.throws(() => removeCanaryContainer(name, record, {}), /rollout/);
    assert.ok(state.calls.every(args => args[0] === 'container'));
});

for (const [description, mutate, message] of [
    ['missing canary marker', env => env.shift(), /recorded canary rollout/],
    ['wrong rollout', env => { env[1] = 'PLOINKY_CANARY_ROLLOUT=other'; }, /recorded canary rollout/],
    ['missing launch ID', env => env.pop(), /launch binding/],
    ['wrong launch ID', env => { env[2] = 'PLOINKY_LAUNCH_ID=other'; }, /launch binding/],
]) {
    test('canary removal refuses ' + description + ' before any container control', t => {
        const state = engine(t);
        mutate(state.inspected.Config.Env);
        assert.throws(() => removeCanaryContainer(name, record, { rolloutId }), message);
        assert.deepEqual(state.calls, [['container', 'exists', id], ['container', 'inspect', id]]);
    });
}

test('an immutable primary ID in the canary registration never authorizes control', t => {
    const state = engine(t);
    const primaryId = 'a'.repeat(64);
    state.inspected.Id = primaryId;
    state.inspected.Name = 'primary';
    // Even copied canary environment and labels cannot turn the primary's
    // immutable ID and exact engine name into the registered secondary.
    assert.throws(() => removeCanaryContainer(name, { ...record, containerId: primaryId }, { rolloutId }), /immutable container identity/);
    assert.deepEqual(state.calls, [['container', 'exists', primaryId], ['container', 'inspect', primaryId]]);
});
