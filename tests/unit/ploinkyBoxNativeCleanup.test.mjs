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
    const common = {
        engine: 'podman',
        engineIdentity: 'rootless-engine-1',
        pathHash: workspaceIdentity.pathHash,
    };
    const volume = (name, role, fingerprint) => ({
        kind: 'volume',
        ...common,
        name,
        role,
        labels: { pathHash: workspaceIdentity.pathHash, role },
        fingerprint: { mountpoint: `/volumes/${name}`, createdAt: fingerprint },
    });
    return {
        container: {
            kind: 'container',
            ...common,
            id: 'a'.repeat(64),
            name: workspaceIdentity.instance,
            labels: { pathHash: workspaceIdentity.pathHash, role: 'box' },
        },
        volumes: {
            workspace: volume(`${workspaceIdentity.instance}-workspace`, 'workspace', 'one'),
            containers: volume(`${workspaceIdentity.instance}-containers`, 'containers', 'two'),
            dependencies: volume(`${workspaceIdentity.instance}-ploinky-deps`, 'ploinky-deps', 'three'),
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
            if (argv[0] === 'volume' && argv[1] === 'inspect') {
                return { ok: false, stdout: '', stderr: 'no such volume' };
            }
            if (argv[0] === 'container' && argv[1] === 'ls') {
                return { ok: true, stdout: '[]', stderr: '' };
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
        inspectVolume: (_engine, _identity, key) => ({
            state: 'owned',
            handle: capturedHandles.volumes[key],
        }),
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
        inspectVolume: state.inspectVolume,
        withLock: state.withLock,
    };
}

test('transactional cleanup uses immutable ID and non-forced named-volume removal', async () => {
    const state = harness();
    const result = await cleanupNativeHarnessResources(cleanupInput(state));
    assert.equal(result.removedContainerId, 'a'.repeat(64));
    assert.equal(result.removedVolumes.length, 3);
    const removalCalls = state.calls.filter(({ argv }) => argv[1] === 'rm');
    assert.deepEqual(removalCalls[0].argv.slice(0, 2), ['container', 'rm']);
    assert.equal(removalCalls[0].argv.at(-1), 'a'.repeat(64));
    assert.equal(removalCalls[0].argv.includes('--volumes'), false);
    assert.equal(removalCalls[0].argv.includes('-v'), false);
    for (const call of removalCalls.slice(1)) {
        assert.deepEqual(call.argv.slice(0, 2), ['volume', 'rm']);
        assert.equal(call.argv.includes('--force'), false);
        assert.equal(call.argv.includes('-f'), false);
    }
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

test('changed volume fingerprint refuses named-volume deletion', async () => {
    const state = harness();
    state.inspectVolume = (_engine, _identity, key) => ({
        state: 'owned',
        handle: {
            ...state.capturedHandles.volumes[key],
            fingerprint: { mountpoint: '/changed', createdAt: 'different' },
        },
    });
    await assert.rejects(
        cleanupNativeHarnessResources(cleanupInput(state)),
        /volume .* changed/,
    );
    assert.equal(state.calls.some(({ argv }) => argv[0] === 'volume' && argv[1] === 'rm'), false);
});

test('foreign consumer and malformed inventory both preserve named volumes', async (t) => {
    for (const [name, stdout, pattern] of [
        ['foreign consumer', '[{"Id":"foreign"}]', /active or foreign consumers/],
        ['malformed inventory', '{not-json', /inventory .* malformed/],
    ]) {
        await t.test(name, async () => {
            const state = harness();
            const baseQuery = state.runner.query.bind(state.runner);
            state.runner.query = (engine, argv) => {
                if (argv[0] === 'container' && argv[1] === 'ls') {
                    state.calls.push({ engine, argv });
                    return { ok: true, stdout, stderr: '' };
                }
                return baseQuery(engine, argv);
            };
            await assert.rejects(cleanupNativeHarnessResources(cleanupInput(state)), pattern);
            assert.equal(
                state.calls.some(({ argv }) => argv[0] === 'volume' && argv[1] === 'rm'),
                false,
            );
        });
    }
});

test('attach-after-inventory race becomes a safe in-use failure without force', async () => {
    const state = harness();
    const baseQuery = state.runner.query.bind(state.runner);
    state.runner.query = (engine, argv) => {
        if (argv[0] === 'volume' && argv[1] === 'rm') {
            state.calls.push({ engine, argv });
            return { ok: false, stdout: '', stderr: 'volume is being used' };
        }
        return baseQuery(engine, argv);
    };
    await assert.rejects(
        cleanupNativeHarnessResources(cleanupInput(state)),
        /became in-use/,
    );
    const volumeRemoval = state.calls.find(({ argv }) => argv[0] === 'volume' && argv[1] === 'rm');
    assert.ok(volumeRemoval);
    assert.equal(volumeRemoval.argv.includes('--force'), false);
    assert.equal(volumeRemoval.argv.includes('-f'), false);
});
