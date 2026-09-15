import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import {
    collectCurrentWorkspaceDiagnostics, CURRENT_CONTAINER_TEMPLATE, CURRENT_REGISTRY_SCRIPT,
} from '../../ploinky-box/diagnose/current.mjs';

const BOX = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const NESTED = 'c'.repeat(64);
const PREFIX = ['container', 'exec', '--user', 'podman', '--workdir', '/workspace', BOX];

function fixture() {
    const status = { state: 'initialized', initialized: true, routingConfigured: true, trackedAgents: 2, runningAgents: 2, warnings: [] };
    const records = [{ name: 'ordinary-agent', containerId: AGENT }, { name: 'nested-agent', containerId: NESTED }];
    const containers = new Map(records.map((record) => [record.containerId, {
        Id: record.containerId, Name: record.name, Image: 'sha256:' + 'e'.repeat(64),
        State: { Running: true, Status: 'running', ExitCode: 0 },
        CapAdd: record.containerId === NESTED ? ['CAP_SYS_ADMIN', 'NET_ADMIN'] : [],
        Devices: record.containerId === NESTED ? [{ PathOnHost: '/dev/fuse', PathInContainer: '/dev/fuse' }] : [],
    }]));
    const info = { host: { security: { rootless: false }, networkBackend: 'netavark', secretCanary: 'unrelated-host-value' },
        store: { graphDriverName: 'overlay', graphRoot: '/data/podman/storage', runRoot: '/run/containers/storage', configFile: '/etc/containers/storage.conf', graphOptions: { 'overlay.mount_program': '/usr/bin/fuse-overlayfs' } } };
    const calls = [];
    const responses = new Map();
    const options = { containerId: BOX, runner: { query(file, args, settings) {
        assert.equal(file, 'podman');
        assert.equal(settings.timeoutMs, 10_000);
        assert.deepEqual(args.slice(0, PREFIX.length), PREFIX);
        const tail = args.slice(PREFIX.length);
        calls.push(tail);
        if (responses.has(tail.join(' '))) return responses.get(tail.join(' '));
        let value;
        if (tail[0] === 'node' && tail[1].endsWith('/readStatus.mjs')) value = status;
        else if (tail[0] === 'node' && tail[1] === '-e') {
            assert.equal(tail[2], CURRENT_REGISTRY_SCRIPT);
            value = records;
        } else if (tail[0] === 'podman' && tail[2] === 'inspect') {
            assert.equal(tail[4], CURRENT_CONTAINER_TEMPLATE);
            value = containers.get(tail[5]);
        } else if (tail[0] === 'podman' && tail[2] === 'exec') {
            assert.deepEqual(tail.slice(3), [NESTED, 'podman', 'info', '--format', 'json']);
            value = info;
        } else throw Error('Unexpected mutation');
        return { ok: true, status: 0, stdout: JSON.stringify(value) };
    } } };
    return { status, records, containers, info, calls, responses, options, run: () => collectCurrentWorkspaceDiagnostics(options) };
}

test('current graph and actual nested agent storage are inspected without starting workloads', () => {
    const state = fixture();
    const checks = state.run();
    assert.equal(checks.some((check) => check.status === 'fail'), false);
    assert.match(checks.find((check) => check.id === 'current.graph').detail, /2\/2 tracked agents running/);
    const nested = checks.find((check) => check.id === 'current.agent.1.podman');
    assert.equal(nested.status, 'pass');
    assert.match(nested.detail, /\/data\/podman\/storage/);
    assert.doesNotMatch(JSON.stringify(checks), /unrelated-host-value/);
    assert.equal(state.calls.filter((args) => args[0] === 'podman' && args[2] === 'exec').length, 1);
    assert.equal(state.calls.filter((args) => args.includes(NESTED) && args[2] === 'inspect').length, 2);
    assert.doesNotMatch(CURRENT_CONTAINER_TEMPLATE, /Config\.Env|Health|Labels/);
});

test('stopped and disappeared agents fail graph checks while independent existing agents still get inspected', () => {
    const state = fixture();
    state.status.runningAgents = 0;
    state.status.warnings = ['ordinary-agent disappeared during status inspection'];
    state.responses.set(['podman', 'container', 'inspect', '--format', CURRENT_CONTAINER_TEMPLATE, AGENT].join(' '), { ok: false, status: 125, stderr: 'no such container token=canary' });
    state.containers.get(NESTED).State = { Running: false, Status: 'exited', ExitCode: 17 };
    const checks = state.run();
    assert.equal(checks.find((check) => check.id === 'current.graph').status, 'fail');
    assert.equal(checks.find((check) => check.id === 'current.agent.0.identity').status, 'fail');
    assert.match(checks.find((check) => check.id === 'current.agent.1.state').detail, /state=exited.*exitCode=17/);
    assert.equal(checks.find((check) => check.id === 'current.agent.1.podman').status, 'skip');
    assert.doesNotMatch(JSON.stringify(checks), /token=canary/);
});

test('the current nested agent VFS setting is visible even if isolated probes use overlay', () => {
    const state = fixture();
    state.info.store.graphDriverName = 'vfs';
    const actual = state.run().find((check) => check.id === 'current.agent.1.podman');
    assert.equal(actual.status, 'warn');
    assert.match(actual.detail, /"driver":"vfs"/);
    assert.match(actual.next, /differs from the isolated overlay probe/);
});

test('name and immutable identity mismatches prevent entering a different agent', () => {
    const state = fixture();
    state.containers.get(NESTED).Name = 'other-agent';
    const checks = state.run();
    assert.equal(checks.find((check) => check.id === 'current.agent.1.identity').status, 'fail');
    assert.equal(state.calls.some((args) => args[0] === 'podman' && args[2] === 'exec'), false);
});

test('agent identity is revalidated immediately before its Podman query', () => {
    const state = fixture();
    const query = state.options.runner.query;
    let count = 0;
    state.options.runner.query = (file, args, options) => {
        if (args.at(-1) === NESTED && args.includes('inspect') && ++count === 2) state.containers.get(NESTED).State.Running = false;
        return query(file, args, options);
    };
    const checks = state.run();
    assert.match(checks.find((check) => check.id === 'current.agent.1.podman').detail, /changed before its engine query/);
    assert.equal(state.calls.some((args) => args[0] === 'podman' && args[2] === 'exec'), false);
});

test('mere capabilities without the nested engine fuse device do not select an agent for exec', () => {
    const state = fixture();
    state.containers.get(NESTED).Devices = [];
    const checks = state.run();
    assert.equal(checks.find((check) => check.id === 'current.nested').status, 'skip');
    assert.equal(state.calls.some((args) => args[0] === 'podman' && args[2] === 'exec'), false);
});

test('rootless Podman declared fuse mapping is recognized when inspected Devices is empty', () => {
    const state = fixture();
    state.containers.get(NESTED).Devices = [];
    state.containers.get(NESTED).DeclaredFuse = true;
    const checks = state.run();
    assert.equal(checks.find((check) => check.id === 'current.agent.1.podman').status, 'pass');
    assert.equal(state.calls.filter((args) => args[0] === 'podman' && args[2] === 'exec').length, 1);
});

test('malformed and duplicate filtered registries never lead to guessed container inspection', () => {
    for (const duplicate of [false, true]) {
        const state = fixture();
        if (duplicate) state.records.push(state.records[0]);
        else state.records[0].containerId = 'short';
        const checks = state.run();
        assert.equal(checks.find((check) => check.id === 'current.registry').status, 'fail');
        assert.equal(state.calls.some((args) => args[0] === 'podman'), false);
    }
});

test('empty inactive workspace is reported without inventing an agent deployment failure', () => {
    const state = fixture();
    Object.assign(state.status, { routingConfigured: false, trackedAgents: 0, runningAgents: 0 });
    state.responses.set(['node', '-e', CURRENT_REGISTRY_SCRIPT].join(' '), { ok: false, status: 1, stderr: 'Registry snapshot failed: ENOENT' });
    const checks = state.run();
    assert.equal(checks.find((check) => check.id === 'current.graph').status, 'warn');
    assert.equal(checks.find((check) => check.id === 'current.registry').status, 'skip');
});

test('registry snapshot script validates file type/size and emits only tracked canonical identities', () => {
    const registry = {
        ordinary: { type: 'agent', runtime: 'podman', containerId: AGENT, password: 'registry-secret', arbitrary: { value: 'sensitive' } },
        incomplete: { type: 'agent', runtime: 'podman', containerId: 'short' },
        otherRuntime: { type: 'agent', runtime: 'docker', containerId: NESTED },
        configuration: { type: 'config', runtime: 'podman', containerId: NESTED },
    };
    const bytes = Buffer.from(JSON.stringify(registry));
    let offset = 0, output = '', error = '', exitCode;
    const file = { isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false, dev: 1, ino: 2, size: bytes.length };
    const fsApi = {
        constants: { O_RDONLY: 0, O_NOFOLLOW: 1 },
        lstatSync: () => file, fstatSync: () => file, openSync: () => 5, closeSync: () => {},
        readSync(_fd, buffer, start, length) { const read = Math.min(length, bytes.length - offset); bytes.copy(buffer, start, offset, offset + read); offset += read; return read; },
    };
    const process = { set exitCode(value) { exitCode = value; } };
    const invoke = () => vm.runInNewContext(CURRENT_REGISTRY_SCRIPT, { require: () => fsApi, Buffer, process, console: { log: (value) => { output = value; }, error: (value) => { error = value; } } });
    invoke();
    assert.deepEqual(JSON.parse(output), [{ name: 'ordinary', containerId: AGENT }]);
    assert.doesNotMatch(output, /registry-secret|sensitive/);
    file.isSymbolicLink = () => true;
    invoke();
    assert.equal(exitCode, 1);
    assert.match(error, /not a regular directory/);
    file.isSymbolicLink = () => false;
    file.size = 1048577;
    invoke();
    assert.match(error, /at most 1 MiB/);
});

test('canonical outer Box identity is mandatory', () => {
    assert.throws(() => collectCurrentWorkspaceDiagnostics({ containerId: 'friendly-name' }), /canonical Box/);
});
