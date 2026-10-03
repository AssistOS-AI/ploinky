import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    activeDescriptorPath, buildImageSelection, readActiveDescriptor, writeActiveDescriptor,
} from '../../agentlib/source.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';
import { fakeUpdateCore, fakeRestartCore } from '../helpers/fakeUpdateCore.mjs';

const BUILD_COMMIT = 'a'.repeat(40);

function fixture(t, {
    corrupt = false, existingBox = false, bundleCommit = BUILD_COMMIT, env = {}, repositoryRoot,
} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-image-supervisor-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const identity = buildWorkspaceIdentity(workspace, { markerFound: false });
    const bundle = {
        packageName: 'ploinky-agent-lib', packageVersion: '1.2.3',
        provenance: { repository: 'https://example.invalid/AchillesAgentLib.git', branch: 'master', commit: bundleCommit, packageVersion: '1.2.3' },
        supplyingImageId: `sha256:${'f'.repeat(64)}`,
    };
    const engine = { name: 'podman', identity: 'engine' };
    const ownership = existingBox
        ? { state: 'owned', engine, handles: { container: { id: 'existing', runtime: { imageId: bundle.supplyingImageId, running: false } } } }
        : { state: 'absent', engine, handles: {} };
    const preparedOwnership = {
        ...ownership, state: 'owned', handles: { container: { id: 'candidate', runtime: { imageId: bundle.supplyingImageId } } },
    };
    const calls = [];
    const loads = [];
    let selections = [];
    let lockNumber = 0;
    const supervisor = createBoxSupervisor({
        checkHostPrerequisites: () => {}, env, platform: 'darwin',
        ...(repositoryRoot ? { repositoryRoot } : {}),
        resolveIdentity: () => identity, launchCwd: workspace,
        discover: () => ownership,
        lockManager: { async acquire() {
            const lockPath = path.join(root, `lock-${lockNumber++}`);
            fs.mkdirSync(lockPath);
            return { path: lockPath, assertHeld() {}, release() {} };
        } },
        loadAgentLibImage: async (options) => { loads.push(options); calls.push('load-image'); return bundle; },
        updateWorkspacePloinky: async () => ({ changed: false }),
        runner: {
            run(_command, args) { calls.push(args.join(' ')); },
            query(_command, args) {
                calls.push(args.join(' '));
                assert.equal(args[0], 'exec');
                if (corrupt) return { ok: false, status: 1, stderr: 'ploinky-box library check failed: the package is gone\n' };
                return { ok: true, stdout: JSON.stringify({ packageName: bundle.packageName, packageVersion: bundle.packageVersion, provenance: bundle.provenance }) };
            },
        },
        reconcile: async ({ agentLib }) => {
            selections.push(agentLib);
            calls.push('reconcile');
            return { action: 'created', ownership: preparedOwnership, hostPort: 8080, mediaHostPort: 7882,
                finalize() { calls.push('finalize'); }, rollback() { calls.push('rollback'); } };
        },
        readEdgeDesired: () => null,
        resolveHostReachableIpv4: async () => '192.168.1.12',
        startCore: async () => { calls.push('core'); },
        runCoreCommand: async () => { calls.push('core'); },
        runRestartCore: fakeRestartCore(async () => { calls.push('core'); }),
        runUpdateCore: fakeUpdateCore({ onCall() { calls.push('core'); } }),
        healthCheck: async () => { calls.push('health'); },
        stdout: { write() {} }, stderr: { write() {} },
    });
    return { supervisor, workspace, bundle, calls, selections, loads };
}

for (const [operation, run] of [
    ['start', supervisor => supervisor.runStartTransaction(['start', 'fixture'])],
    ['restart', supervisor => supervisor.runRestartTransaction(['restart'])],
    ['update', supervisor => supervisor.runUpdateTransaction(['update'])],
]) {
    test(`${operation} refreshes the Box image before selection only when it creates the Box`, async t => {
        for (const [existingBox, refresh] of [[false, true], [true, false]]) {
            const state = fixture(t, { existingBox });
            await run(state.supervisor);
            assert.deepEqual(state.loads.map(options => [options.imageRef, options.refresh, options.allowPull]),
                [['docker.io/assistos/ploinky-box:latest', refresh, undefined]]);
        }
    });

    test(`${operation} uses the image when no local source exists and persists admission after the package is confirmed in the running Box`, async t => {
        const state = fixture(t);
        const result = await run(state.supervisor);
        assert.equal(result.agentLib.mode, 'image');
        assert.equal(result.agentLib.supplyingImageId, state.bundle.supplyingImageId);
        assert.equal(Object.hasOwn(result.agentLib, 'contentFingerprint'), false, 'an image source has no content fingerprint');
        assert.equal(readActiveDescriptor(state.workspace).mode, 'image');
        assert.equal(readActiveDescriptor(state.workspace).supplyingImageId, state.bundle.supplyingImageId);
        assert.deepEqual(fs.readdirSync(path.join(state.workspace, '.ploinky', 'agentlib')), ['active.json']);
        assert.equal(fs.existsSync(path.join(state.workspace, 'achillesAgentLib')), false);
        assert.ok(state.calls.indexOf('load-image') < state.calls.indexOf('reconcile'));
        assert.ok(state.calls.indexOf('health') < state.calls.findIndex(call => call.startsWith('exec candidate')));
        assert.equal(state.calls.at(-1), 'finalize');
    });
}

test('an invalid local source never reaches the image loader or Box reconciliation', async t => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, 'achillesAgentLib'));
    await assert.rejects(state.supervisor.runStartTransaction(['start', 'fixture']), /package.json/);
    assert.deepEqual(state.calls, []);
});

test('adding and removing a local checkout switches the selected source on subsequent starts', async t => {
    const state = fixture(t);
    await state.supervisor.runStartTransaction(['start', 'fixture']);
    writeAgentLibCheckout(path.join(state.workspace, 'achillesAgentLib'));
    await state.supervisor.runStartTransaction(['start', 'fixture']);
    fs.rmSync(path.join(state.workspace, 'achillesAgentLib'), { recursive: true });
    await state.supervisor.runStartTransaction(['start', 'fixture']);
    assert.deepEqual(state.selections.map(selection => selection.mode), ['image', 'local', 'image']);
    assert.equal(state.calls.filter(call => call === 'load-image').length, 2);
});

test('an unusable package in the running Box rolls back without persisting a successful selection', async t => {
    const state = fixture(t, { corrupt: true });
    await assert.rejects(state.supervisor.runStartTransaction(['start', 'fixture']), /missing or failed inspection/);
    assert.equal(readActiveDescriptor(state.workspace), null);
    assert.equal(state.calls.includes('finalize'), false);
    assert.equal(state.calls.at(-1), 'rollback');
});

test('H1 an image built from any revision is selected, confirmed and admitted with its commit only as provenance', async t => {
    for (const commit of ['9'.repeat(40), null]) {
        const state = fixture(t, { bundleCommit: commit });
        const result = await state.supervisor.runStartTransaction(['start', 'fixture']);
        assert.equal(result.agentLib.provenance.commit, commit);
        assert.equal(readActiveDescriptor(state.workspace).provenance.commit, commit);
        const exec = state.calls.find(call => call.startsWith('exec candidate'));
        assert.match(exec, /inspect achillesAgentLib$/);
        assert.doesNotMatch(exec, /expected-commit/);
    }
});

test('H2 the loaders receive no pin policy or lock checkout, only the engine, image and streams', async t => {
    for (const env of [{}, { PLOINKY_AGENTLIB_STRICT_PIN: '1' }]) {
        const state = fixture(t, { env, repositoryRoot: '/fake/root' });
        await state.supervisor.runStartTransaction(['start', 'fixture']);
        for (const removed of ['pinPolicy', 'repositoryRoot', 'lockCommit', 'expectedCommit']) {
            assert.equal(Object.hasOwn(state.loads[0], removed), false, removed);
        }
    }
});

test('H3 the removed strict-pin setting has no effect on start, whatever its value', async t => {
    for (const value of ['1', '0', 'yes', '']) {
        const state = fixture(t, { env: { PLOINKY_AGENTLIB_STRICT_PIN: value } });
        await state.supervisor.runStartTransaction(['start', 'fixture']);
        assert.equal(state.calls.includes('load-image'), true, value);
        assert.equal(state.calls.includes('reconcile'), true, value);
    }
});

// A present active descriptor is authority state: the current validator judges it
// before the host selects a source, loads the image or mutates anything.
const UNSUPPORTED_ACTIVE_DESCRIPTORS = {
    'a managed-mode descriptor': () => JSON.stringify({
        schemaVersion: 1, workspacePathHash: 'h', mode: 'managed', sourceRelativePath: '.ploinky/agentlib/generations/x',
        sourceId: { device: '1', inode: '2' }, contentFingerprint: 'a'.repeat(64), selectedAt: '2026-01-01T00:00:00.000Z',
        remoteUrl: 'https://example.invalid/lib.git',
    }),
    'an image descriptor of the previous shape': () => JSON.stringify({
        schemaVersion: 1, workspacePathHash: 'h', mode: 'image', sourceRelativePath: 'image',
        sourceId: { device: '1', inode: '2' }, contentFingerprint: 'a'.repeat(64), selectedAt: '2026-01-01T00:00:00.000Z',
        imageId: `sha256:${'a'.repeat(64)}`, resolvedCommit: 'b'.repeat(40),
    }),
    'an image descriptor without its supplying image': (selection) => JSON.stringify({
        ...selection, supplyingImageId: undefined, sourceId: { library: 'achillesAgentLib' },
    }),
    'malformed JSON': () => '{"schemaVersion": 1,',
};

for (const [operation, run] of [
    ['start', supervisor => supervisor.runStartTransaction(['start', 'fixture'])],
    ['restart', supervisor => supervisor.runRestartTransaction(['restart'])],
    ['update', supervisor => supervisor.runUpdateTransaction(['update'])],
]) {
    test(`${operation} rejects an unsupported active descriptor by file before any image load or mutation`, async t => {
        for (const [description, render] of Object.entries(UNSUPPORTED_ACTIVE_DESCRIPTORS)) {
            for (const existingBox of [false, true]) {
                const state = fixture(t, { existingBox });
                const descriptor = activeDescriptorPath(state.workspace);
                const bytes = render(buildImageSelection({
                    workspaceRoot: state.workspace, supplyingImageId: state.bundle.supplyingImageId,
                }));
                fs.mkdirSync(path.dirname(descriptor), { recursive: true });
                fs.writeFileSync(descriptor, bytes);
                await assert.rejects(run(state.supervisor), error => {
                    assert.equal(error.code, 'PLOINKY_AGENTLIB_DESCRIPTOR_INVALID', description);
                    assert.ok(error.message.includes(descriptor), `${description}: ${error.message}`);
                    return true;
                }, `${operation} ${description} existingBox=${existingBox}`);
                assert.deepEqual(state.loads, [], `${operation} ${description}: the image was loaded`);
                assert.deepEqual(state.calls, [], `${operation} ${description}: the Box or graph was touched`);
                assert.equal(fs.readFileSync(descriptor, 'utf8'), bytes, `${operation} ${description}: the descriptor was changed`);
                assert.deepEqual(fs.readdirSync(path.dirname(descriptor)), ['active.json']);
            }
        }
    });
}

test('destroy --delete-cache still removes unsupported selection state without interpreting it', async t => {
    for (const [description, render] of Object.entries(UNSUPPORTED_ACTIVE_DESCRIPTORS)) {
        const state = fixture(t);
        const descriptor = activeDescriptorPath(state.workspace);
        fs.mkdirSync(path.dirname(descriptor), { recursive: true });
        fs.writeFileSync(descriptor, render(buildImageSelection({
            workspaceRoot: state.workspace, supplyingImageId: state.bundle.supplyingImageId,
        })));
        const result = await state.supervisor.runDestroyTransaction(null, { deleteCache: true });
        assert.deepEqual(result.deletedAgentLibPaths, [path.dirname(descriptor)], description);
        assert.equal(fs.existsSync(path.dirname(descriptor)), false, description);
        assert.deepEqual(state.loads, [], `${description}: destroy loaded the image`);
        assert.deepEqual(state.calls, [], `${description}: destroy touched the engine or graph`);
    }
});

test('an absent active descriptor still initializes the workspace and a valid one is read back on the next start', async t => {
    const state = fixture(t);
    assert.equal(readActiveDescriptor(state.workspace), null);
    await state.supervisor.runStartTransaction(['start', 'fixture']);
    const written = fs.readFileSync(activeDescriptorPath(state.workspace), 'utf8');
    await state.supervisor.runRestartTransaction(['restart']);
    assert.equal(readActiveDescriptor(state.workspace).supplyingImageId, state.bundle.supplyingImageId);
    assert.equal(state.loads.length, 2, 'both transactions selected the image again');
    assert.equal(JSON.parse(written).mode, 'image');
});

test('a failed admission puts back the exact prior descriptor bytes, without interpreting them', async t => {
    const state = fixture(t, { corrupt: true });
    const prior = buildImageSelection({
        workspaceRoot: state.workspace, supplyingImageId: `sha256:${'1'.repeat(64)}`,
    });
    writeActiveDescriptor(state.workspace, prior);
    const before = fs.readFileSync(activeDescriptorPath(state.workspace), 'utf8');
    await assert.rejects(state.supervisor.runStartTransaction(['start', 'fixture']), /missing or failed inspection/);
    assert.equal(fs.readFileSync(activeDescriptorPath(state.workspace), 'utf8'), before);
    assert.equal(state.calls.at(-1), 'rollback');
});
