import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectSelectedMachine, pullableImageReference, pullMissingBoxImage, startSelectedMachine } from '../../ploinky-box/repair/automatic.mjs';

const ok = (value = '') => ({ ok: true, status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
const missing = () => ({ ok: false, status: 1, stdout: '', stderr: '' });

test('image repair downloads only the configured absent image and verifies it without restarting containers', async () => {
    const calls = []; let cached = false;
    const runner = {
        query(file, args) { calls.push([file, args]); assert.deepEqual(args, ['image', 'exists', 'registry.example.test/team/box:stable']); return cached ? ok() : missing(); },
        async stream(file, args, options) {
            calls.push([file, args]); assert.deepEqual(args, ['pull', 'registry.example.test/team/box:stable']);
            assert.equal(options.timeoutMs, 300000); cached = true; return ok('done');
        },
    };
    const report = await pullMissingBoxImage({ runner, env: { PLOINKY_BOX_IMAGE: 'registry.example.test/team/box:stable' }, inspectHost: () => ({ engineUsable: true }) });
    assert.equal(report.status, 'applied');
    assert.equal(calls.length, 3);
    assert.equal(calls.some(([file, args]) => file !== 'podman' || args.includes('start') || args.includes('rm')), false);
});

test('an image that is already cached is not refreshed or replaced', async () => {
    const report = await pullMissingBoxImage({ runner: { query: () => ok(), stream() { assert.fail('Cached image must not be pulled'); } },
        env: {}, inspectHost: () => ({ engineUsable: true }) });
    assert.equal(report.status, 'skipped');
});

test('changed host prerequisites and invalid/local image references cannot trigger a pull', async () => {
    const runner = { query() { assert.fail('No engine mutation expected'); }, stream() { assert.fail('No pull expected'); } };
    assert.equal((await pullMissingBoxImage({ runner, inspectHost: () => ({ engineUsable: false }) })).status, 'skipped');
    for (const value of ['--help', 'sha256:' + 'a'.repeat(64), 'registry/password@host/repo', 'repo;echo injected', 'https://host/repo',
        'dir:/tmp/box', 'docker-archive:/tmp/box.tar', 'oci-archive:/tmp/box.tar', 'docker-daemon:example.com/box',
        'dir:5000/box', 'docker://example.com/box', 'containers-storage:localhost/box', 'team/box']) {
        assert.equal(pullableImageReference(value), false);
        await assert.rejects(pullMissingBoxImage({ runner, env: { PLOINKY_BOX_IMAGE: value }, inspectHost: () => ({ engineUsable: true }) }));
    }
});

test('registry image validation accepts explicit registries and valid tags while refusing ambiguous names', () => {
    for (const value of [
        'docker.io/assistos/ploinky-box:latest', 'registry.example.test/team/box:Latest',
        'registry:5000/team/box:Build_123', 'localhost/box', 'localhost:5000/box',
        '[::1]:5000/team/box', '192.0.2.10:5000/team/box',
        'example.com/team/a__b--c.d:Tag', 'example.com/box@sha256:' + 'a'.repeat(64),
        'example.com/box:Tag@sha256:' + 'a'.repeat(64),
    ]) assert.equal(pullableImageReference(value), true, value);
    for (const value of [
        'box', 'team/box', 'example.com:abc/box', 'example.com:/box', 'example.com:0/box',
        'example.com:65536/box', 'example..com/box', '-example.com/box', '[::invalid]/box',
        'example.com/', 'example.com/Team/box', 'example.com/team//box', 'example.com/../box',
        'example.com/box:', 'example.com/box:Tag:extra', 'example.com/box:Tag/extra',
        'example.com/box@sha256:abc', 'example.com/box@sha256:' + 'a'.repeat(64) + '@extra',
    ]) assert.equal(pullableImageReference(value), false, value);
});

test('image failures are bounded and redacted, and ambiguous cache failures are not treated as absence', async () => {
    const failed = await pullMissingBoxImage({ env: {}, inspectHost: () => ({ engineUsable: true }),
        runner: { query: missing, stream: async () => ({ ok: false, status: 125, stderr: 'password=private registry unavailable' }) } });
    assert.equal(failed.status, 'failed'); assert.equal(failed.exitCode, 125);
    assert.doesNotMatch(failed.detail, /private/);
    await assert.rejects(pullMissingBoxImage({ env: {}, inspectHost: () => ({ engineUsable: true }), runner: {
        query: () => ({ ok: false, status: 125, stderr: 'database unavailable' }), stream() { assert.fail('Cache failure is not an absent image'); },
    } }), /database unavailable/);
});

function machine() {
    const calls = [];
    const state = { name: 'chosen-machine', rootful: false, state: 'stopped', defaults: 1,
        uri: 'ssh://account@127.0.0.1:2222/run/user/1000/podman/podman.sock',
        identity: '/private/machine-identity', created: '2026-01-01T00:00:00Z', memory: 4096 };
    const runner = {
        query(file, args) {
            calls.push([file, args]);
            if (args[0] === 'system') return ok(Array.from({ length: state.defaults }, () => ({ Default: true, IsMachine: true,
                Name: state.name, URI: state.uri, Identity: state.identity })));
            if (args[1] === 'list') return ok([{ Name: state.name, Running: state.state === 'running' }]);
            if (args[1] === 'inspect') return ok([{ Name: state.name, Rootful: state.rootful, State: state.state,
                Created: state.created, Resources: { Memory: state.memory } }]);
            assert.fail('Unexpected machine query');
        },
        async stream(file, args, options) {
            calls.push([file, args]); assert.deepEqual(args, ['machine', 'start', state.name]);
            assert.equal(options.timeoutMs, 180000); state.state = 'running'; return ok();
        },
    };
    const options = { runner, platform: 'darwin', env: {} };
    options.expectedMachine = inspectSelectedMachine(options).machineIdentity;
    return { state, runner, calls, options };
}

test('only an existing selected stopped rootless Machine is eligible for automatic startup', async () => {
    const f = machine();
    const assessment = inspectSelectedMachine(f.options);
    assert.equal(assessment.check.repairEligible, true);
    const result = await startSelectedMachine(f.options);
    assert.equal(result.status, 'applied');
    assert.equal(f.calls.filter(([, args]) => args[1] === 'start').length, 1);
    assert.equal(f.calls.some(([file, args]) => file !== 'podman' || args.includes('init') || args.includes('set') || args.includes('--rootful')), false);
});

test('rootful, ambiguous, changing and unselected Machine states are never automatically started', async () => {
    for (const patch of [{ rootful: true }, { defaults: 2 }, { state: 'starting' }, { name: '--unsafe' }]) {
        const f = machine(); Object.assign(f.state, patch);
        assert.equal((await startSelectedMachine(f.options)).status, 'skipped');
        assert.equal(f.calls.some(([, args]) => args[1] === 'start'), false);
    }
    const f = machine(); inspectSelectedMachine(f.options); f.state.rootful = true;
    assert.equal((await startSelectedMachine(f.options)).status, 'skipped');
    assert.equal(f.calls.some(([, args]) => args[1] === 'start'), false);
});

test('a different selected Machine, changed connection, or replaced same-name Machine is not started', async () => {
    for (const patch of [
        { name: 'other-machine' }, { uri: 'ssh://other@private-host/run/podman/podman.sock' },
        { identity: '/private/replaced-key' }, { created: '2026-02-01T00:00:00Z' }, { memory: 8192 },
    ]) {
        const f = machine(); Object.assign(f.state, patch);
        const result = await startSelectedMachine(f.options);
        assert.equal(result.status, 'skipped');
        assert.match(result.detail, /changed or could not be verified/);
        assert.equal(f.calls.some(([, args]) => args[1] === 'start'), false);
        assert.doesNotMatch(JSON.stringify(result), /private-host|replaced-key/);
    }
});

test('Machine startup requires the earlier assessment and never exposes connection details', async () => {
    const f = machine();
    const assessment = inspectSelectedMachine(f.options);
    assert.match(assessment.check.machineIdentity.fingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(assessment), /ssh:\/\/|account|machine-identity/);
    const result = await startSelectedMachine({ ...f.options, expectedMachine: undefined });
    assert.equal(result.status, 'skipped');
    assert.equal(f.calls.some(([, args]) => args[1] === 'start'), false);
    f.state.created = undefined;
    assert.equal(inspectSelectedMachine(f.options).check.repairEligible, false);
});

test('post-start verification rejects connection or settings changes even under the same Machine name', async () => {
    for (const patch of [{ uri: 'ssh://changed@private-host/run/podman/podman.sock' }, { identity: '/private/changed-key' }, { memory: 8192 }]) {
        const f = machine();
        const stream = f.runner.stream;
        f.runner.stream = async (...args) => { const result = await stream(...args); Object.assign(f.state, patch); return result; };
        const result = await startSelectedMachine(f.options);
        assert.equal(result.status, 'failed');
        assert.match(result.detail, /original connection and settings/);
        assert.equal(f.calls.filter(([, args]) => args[1] === 'start').length, 1);
        assert.doesNotMatch(JSON.stringify(result), /private-host|changed-key/);
    }
});

test('native Linux and remote endpoint overrides never trigger Machine repair', async () => {
    const runner = { query() { assert.fail('Unsupported Machine context must not run commands'); } };
    for (const options of [{ platform: 'linux', env: {} }, { platform: 'darwin', env: { CONTAINER_HOST: 'ssh://private-host' } }]) {
        const result = await startSelectedMachine({ runner, ...options });
        assert.equal(result.status, 'skipped'); assert.doesNotMatch(JSON.stringify(result), /private-host/);
    }
});
