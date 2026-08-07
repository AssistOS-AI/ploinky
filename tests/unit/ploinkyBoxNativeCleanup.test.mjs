import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupNativeHarnessResources } from '../e2e/ploinkyBox/nativeHelpers.mjs';

function identity(overrides = {}) {
    return {
        workspaceRoot: '/tmp/test-owned-workspace',
        instance: 'ploinky-box-test-owned-aaaaaaaaaaaa',
        pathHash: 'aaaaaaaaaaaa',
        rootFingerprint: { device: '1', inode: '2', mode: 16832, symlinkTarget: null },
        ...overrides,
    };
}

function handles(workspaceIdentity) {
    return {
        container: {
            kind: 'container',
            engine: 'podman',
            engineIdentity: 'rootless-engine-1',
            pathHash: workspaceIdentity.pathHash,
            id: 'a'.repeat(64),
            name: workspaceIdentity.instance,
            labels: { pathHash: workspaceIdentity.pathHash, role: 'box' },
        },
    };
}

function harness(overrides = {}) {
    const expectedIdentity = identity();
    const capturedHandles = handles(expectedIdentity);
    const calls = [];
    let discoverCalls = 0;
    const runner = {
        query(engine, argv) {
            calls.push({ engine, argv });
            if (argv[0] === 'container' && argv[1] === 'inspect') {
                return { ok: false, stdout: '', stderr: 'no such container' };
            }
            return { ok: true, stdout: '', stderr: '' };
        },
    };
    const lock = {
        assertHeld(instance) {
            assert.equal(instance, expectedIdentity.instance);
        },
    };
    return {
        expectedIdentity,
        capturedHandles,
        calls,
        runner,
        lockManager: {},
        resolveIdentity: () => expectedIdentity,
        discover: () => {
            discoverCalls += 1;
            return {
                state: 'owned',
                engine: { name: 'podman', identity: 'rootless-engine-1' },
                handles: capturedHandles,
            };
        },
        withLock: async ({ execute }) => execute(expectedIdentity, lock),
        get discoverCalls() { return discoverCalls; },
        ...overrides,
    };
}

function cleanupInput(state) {
    return {
        resolveIdentity: state.resolveIdentity,
        expectedIdentity: state.expectedIdentity,
        runner: state.runner,
        lockManager: state.lockManager,
        discover: state.discover,
        withLock: state.withLock,
    };
}

test('transactional cleanup removes the outer container by immutable ID only', async () => {
    const state = harness();
    const result = await cleanupNativeHarnessResources(cleanupInput(state));
    assert.equal(result.removedContainerId, 'a'.repeat(64));
    assert.equal(result.removedVolumes, undefined);
    const removalCalls = state.calls.filter(({ argv }) => argv[1] === 'rm');
    assert.equal(removalCalls.length, 1);
    assert.deepEqual(removalCalls[0].argv.slice(0, 2), ['container', 'rm']);
    assert.equal(removalCalls[0].argv.at(-1), 'a'.repeat(64));
    assert.equal(removalCalls[0].argv.includes('--volumes'), false);
    assert.equal(removalCalls[0].argv.includes('-v'), false);
});

test('cleanup issues no engine volume command at all', async () => {
    const state = harness();
    await cleanupNativeHarnessResources(cleanupInput(state));
    assert.equal(state.calls.some(({ argv }) => argv[0] === 'volume'), false);
    assert.equal(state.calls.some(({ argv }) => argv.some(
        (value) => String(value).startsWith('volume='),
    )), false);
});

test('an absent Box needs no removal at all', async () => {
    const state = harness({
        discover: () => ({ state: 'absent', handles: null }),
    });
    const result = await cleanupNativeHarnessResources(cleanupInput(state));
    assert.equal(result.action, 'absent');
    assert.equal(result.removedContainerId, null);
    assert.deepEqual(state.calls, []);
});

test('lock contention performs no discovery or destructive operation', async () => {
    const state = harness({
        withLock: async () => {
            throw new Error('lock contention');
        },
    });
    await assert.rejects(cleanupNativeHarnessResources(cleanupInput(state)), /lock contention/);
    assert.equal(state.discoverCalls, 0);
    assert.deepEqual(state.calls, []);
});

test('workspace identity replacement refuses container removal', async () => {
    const state = harness();
    let resolutions = 0;
    state.resolveIdentity = () => {
        resolutions += 1;
        return resolutions === 1 ? identity({ workspaceRoot: '/tmp/replaced' }) : state.expectedIdentity;
    };
    await assert.rejects(
        cleanupNativeHarnessResources(cleanupInput(state)),
        /Workspace identity changed/,
    );
    assert.equal(state.calls.some(({ argv }) => argv[1] === 'rm'), false);
});

test('container replacement refuses immutable-ID deletion', async () => {
    const state = harness();
    let discovery = 0;
    state.discover = () => {
        discovery += 1;
        const currentHandles = discovery === 1
            ? state.capturedHandles
            : {
                ...state.capturedHandles,
                container: { ...state.capturedHandles.container, id: 'b'.repeat(64) },
            };
        return {
            state: 'owned',
            engine: { name: 'podman', identity: 'rootless-engine-1' },
            handles: currentHandles,
        };
    };
    await assert.rejects(
        cleanupNativeHarnessResources(cleanupInput(state)),
        /container changed/,
    );
    assert.equal(state.calls.some(({ argv }) => argv[1] === 'rm'), false);
});

test('an engine handoff between discovery and removal refuses deletion', async () => {
    const state = harness();
    let discovery = 0;
    state.discover = () => {
        discovery += 1;
        return {
            state: 'owned',
            engine: {
                name: 'podman',
                identity: discovery === 1 ? 'rootless-engine-1' : 'rootless-engine-2',
            },
            handles: state.capturedHandles,
        };
    };
    await assert.rejects(
        cleanupNativeHarnessResources(cleanupInput(state)),
        /engine or ownership changed before container removal/,
    );
    assert.equal(state.calls.some(({ argv }) => argv[1] === 'rm'), false);
});

test('an unproven container absence after removal fails closed', async () => {
    const state = harness();
    const baseQuery = state.runner.query.bind(state.runner);
    state.runner.query = (engine, argv) => {
        if (argv[0] === 'container' && argv[1] === 'inspect') {
            state.calls.push({ engine, argv });
            return { ok: true, stdout: '[{"Id":"still-here"}]', stderr: '' };
        }
        return baseQuery(engine, argv);
    };
    await assert.rejects(
        cleanupNativeHarnessResources(cleanupInput(state)),
        /absence could not be proven/,
    );
});
