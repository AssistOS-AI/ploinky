import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalAgentLibRemote } from '../../agentlib/contract.mjs';
import { readActiveDescriptor } from '../../agentlib/source.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';
import { fakeUpdateCore, fakeRestartCore } from '../helpers/fakeUpdateCore.mjs';

function fixture(t, {
    corrupt = false, existingBox = false, bundleCommit = canonicalAgentLibRemote().commit, env = {}, repositoryRoot,
} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-image-supervisor-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const identity = buildWorkspaceIdentity(workspace, { markerFound: false });
    const bundle = {
        schemaVersion: 1, commit: bundleCommit,
        fingerprint: 'e'.repeat(64), imageId: `sha256:${'f'.repeat(64)}`,
    };
    const engine = { name: 'podman', identity: 'engine' };
    const ownership = existingBox
        ? { state: 'owned', engine, handles: { container: { id: 'existing', runtime: { imageId: bundle.imageId, running: false } } } }
        : { state: 'absent', engine, handles: {} };
    const preparedOwnership = {
        ...ownership, state: 'owned', handles: { container: { id: 'candidate', runtime: { imageId: bundle.imageId } } },
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
                return { ok: true, stdout: JSON.stringify({ ...bundle, ...(corrupt ? { fingerprint: '0'.repeat(64) } : {}) }) };
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

    test(`${operation} uses the image when no local source exists and persists admission after actual bundle verification`, async t => {
        const state = fixture(t);
        const result = await run(state.supervisor);
        assert.equal(result.agentLib.mode, 'image');
        assert.equal(result.agentLib.imageId, state.bundle.imageId);
        assert.equal(readActiveDescriptor(state.workspace).mode, 'image');
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

test('running bundle drift rolls back without persisting a successful selection', async t => {
    const state = fixture(t, { corrupt: true });
    await assert.rejects(state.supervisor.runStartTransaction(['start', 'fixture']), /fingerprint changed/);
    assert.equal(readActiveDescriptor(state.workspace), null);
    assert.equal(state.calls.includes('finalize'), false);
    assert.equal(state.calls.at(-1), 'rollback');
});

test('H1 a bundle commit that differs from the lock is selected, verified and admitted', async t => {
    const other = '9'.repeat(40);
    const state = fixture(t, { bundleCommit: other });
    const result = await state.supervisor.runStartTransaction(['start', 'fixture']);
    assert.equal(result.agentLib.resolvedCommit, other);
    assert.equal(readActiveDescriptor(state.workspace).resolvedCommit, other);
    const exec = state.calls.find(call => call.startsWith('exec candidate'));
    assert.ok(exec.endsWith(`--expected-commit ${other}`), exec);
});

test('H2 the loaders receive the pin policy and the checkout that owns the lock', async t => {
    for (const [env, policy] of [[{}, 'warn'], [{ PLOINKY_AGENTLIB_STRICT_PIN: '1' }, 'strict']]) {
        const state = fixture(t, { env, repositoryRoot: '/fake/root' });
        await state.supervisor.runStartTransaction(['start', 'fixture']);
        assert.equal(state.loads[0].pinPolicy, policy);
        assert.equal(state.loads[0].repositoryRoot, '/fake/root');
    }
});

test('H3 an invalid strict-pin value stops start before image selection or reconciliation', async t => {
    const state = fixture(t, { env: { PLOINKY_AGENTLIB_STRICT_PIN: 'yes' } });
    await assert.rejects(state.supervisor.runStartTransaction(['start', 'fixture']), { code: 'PLOINKY_BOX_ARGUMENT_INVALID' });
    assert.equal(state.calls.includes('load-image'), false);
    assert.equal(state.calls.includes('reconcile'), false);
});
