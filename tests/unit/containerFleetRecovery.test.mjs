import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-failed-container-recovery-'));
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = 'test-failed-container-recovery-master-key';
test.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

const { removeExactContainerAndDescriptor } = await import('../../cli/sandbox/docker/containerFleet.js');
const { NETWORK_LABELS } = await import('../../cli/sandbox/networkIdentity.js');
const { NETWORK_SCHEMA_VERSION } = await import('../../cli/sandbox/networkContract.js');
const {
    buildGeneratedRouterDescriptorEnv,
    signGeneratedRouterDescriptorEnvelope,
    writeGeneratedRouterDescriptorFile,
} = await import('../../cli/utils/security/generatedRouterDescriptor.js');

const NAME = 'ploinky_Example_failed_workspace';
const ID = 'a'.repeat(64);
const OTHER_ID = 'c'.repeat(64);
const WORKSPACE_HASH = 'workspace-exact';
const DESCRIPTOR_TARGET = '/run/ploinky/router-descriptor.json';
const principal = 'agent:Example/failed';
const launchEnvironment = {
    PLOINKY_AGENT_PRINCIPAL: principal,
    PLOINKY_AGENT_INSTANCE_ID: 'instance-exact',
    PLOINKY_AGENT_ENABLE_GENERATION: 'generation-exact',
};

function registry(overrides = {}) {
    return { type: 'agent', repoName: 'Example', agentName: 'failed', runtime: 'podman',
        instanceId: 'instance-exact', enableGeneration: 'generation-exact',
        config: { binds: [] }, ...overrides };
}

function runtimeRecord(overrides = {}) {
    return {
        Id: ID,
        Name: `/${NAME}`,
        Config: {
            Labels: {
                [NETWORK_LABELS.managed]: '1',
                [NETWORK_LABELS.resource]: 'agent',
                [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
                [NETWORK_LABELS.workspace]: WORKSPACE_HASH,
                [NETWORK_LABELS.contract]: 'b'.repeat(64),
                [NETWORK_LABELS.instanceId]: 'instance-exact',
                [NETWORK_LABELS.enableGeneration]: 'generation-exact',
            },
            Env: Object.entries(launchEnvironment).map(([key, value]) => `${key}=${value}`),
        },
        HostConfig: { Init: true }, Mounts: [], State: { Running: false, ExitCode: 1 },
        ...overrides,
    };
}

function engine(initial = runtimeRecord()) {
    let current = initial;
    let lockHeld = false;
    const inspections = [];
    const controls = [];
    const recovered = [];
    const options = {
        recoverIncompleteIdentity: true,
        fast: true,
        withLock(callback) {
            assert.equal(lockHeld, false);
            lockHeld = true;
            try { return callback(); } finally { lockHeld = false; }
        },
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
        inspect(runtime, identifier) {
            assert.equal(lockHeld, true);
            assert.equal(runtime, 'podman');
            inspections.push(identifier);
            return identifier === NAME || identifier === current?.Id ? current : null;
        },
        control(runtime, args) {
            assert.equal(lockHeld, true);
            assert.equal(runtime, 'podman');
            assert.equal(args.at(-1), ID, 'never signal or remove by mutable name');
            controls.push(args);
            if (args[0] === 'kill') current.State.Running = false;
            if (args[0] === 'rm') current = null;
            return { status: 0 };
        },
        onRecoveredIdentity(value) { recovered.push(value); },
        retireRelay() {},
        pause() {},
    };
    return { options, inspections, controls, recovered,
        set current(value) { current = value; },
        get current() { return current; },
        remove(record = registry()) { return removeExactContainerAndDescriptor(NAME, record, 'podman', options); } };
}

function descriptorFixture(payloadOverrides = {}) {
    const sourcePayload = JSON.parse(fs.readFileSync(
        new URL('../fixtures/router-descriptor/managed-envelope.json', import.meta.url), 'utf8',
    )).payload;
    const payload = {
        ...sourcePayload,
        agentPrincipal: principal,
        instanceId: 'instance-exact',
        generationId: 'generation-exact',
        launchId: crypto.randomUUID(),
        ...payloadOverrides,
    };
    const source = path.join(workspace, '.ploinky/run/router-descriptors', `${payload.launchId}.json`);
    const signed = signGeneratedRouterDescriptorEnvelope(payload);
    writeGeneratedRouterDescriptorFile(source, signed.bytes);
    const bind = { source, target: DESCRIPTOR_TARGET, ro: true, generatedRouterDescriptor: true };
    const current = runtimeRecord();
    current.Mounts = [{ Source: source, Destination: DESCRIPTOR_TARGET, RW: false }];
    current.Config.Env = Object.entries(buildGeneratedRouterDescriptorEnv(payload))
        .map(([key, value]) => `${key}=${value}`);
    return { source, bind, current, payload };
}

test('reinstall recovers an exited installation container with a missing ID and removes only its proved immutable ID', () => {
    const state = engine();
    assert.deepEqual(state.remove(), {
        found: true, stopped: true, removed: true, containerId: ID, recoveredIdentity: true,
    });
    assert.equal(state.inspections[0], NAME);
    assert.ok(state.inspections.slice(1).every((value) => value === ID));
    assert.deepEqual(state.controls, [['rm', '-f', ID]]);
    assert.equal(state.recovered[0].record.containerId, ID);
    assert.equal(state.recovered[0].record.runtime, 'podman');
});

test('reinstall resolves a matching legacy name or 12-hex prefix but preserves a conflicting prefix', () => {
    for (const containerId of [NAME, ID.slice(0, 12)]) {
        assert.equal(engine().remove(registry({ containerId })).removed, true);
    }
    const state = engine();
    assert.throws(() => state.remove(registry({ containerId: OTHER_ID.slice(0, 12) })), /container ID prefix/);
    assert.deepEqual(state.controls, []);
    assert.throws(() => state.remove(registry({ containerId: 'damaged-record' })), /malformed registry container ID/);
});

test('reinstall never replaces a conflicting full registry ID with the current named container', () => {
    const state = engine();
    assert.throws(() => state.remove(registry({ containerId: OTHER_ID })), /different named container/);
    assert.deepEqual(state.inspections, [OTHER_ID, NAME]);
    assert.deepEqual(state.controls, []);
    assert.deepEqual(state.recovered, []);
});

test('legacy recovery requires exact workspace, instance, generation, principal and runtime ownership', () => {
    const mutations = [
        (current) => { current.Name = '/foreign-agent'; },
        (current) => { current.Config.Labels[NETWORK_LABELS.workspace] = 'foreign-workspace'; },
        (current) => { current.Config.Labels[NETWORK_LABELS.instanceId] = 'foreign-instance'; },
        (current) => { current.Config.Labels[NETWORK_LABELS.enableGeneration] = 'foreign-generation'; },
        (current) => { current.Config.Labels[NETWORK_LABELS.managed] = '0'; },
        (current) => { current.HostConfig.Init = false; },
        (current) => { current.Config.Env[0] = 'PLOINKY_AGENT_PRINCIPAL=agent:Other/failed'; },
        (current) => { current.Config.Env.push(current.Config.Env[0]); },
        (current) => { current.Id = ID.slice(0, 12); },
    ];
    for (const mutate of mutations) {
        const current = runtimeRecord();
        mutate(current);
        const state = engine(current);
        assert.throws(() => state.remove(), /could not prove|launch identity|exact immutable ID/);
        assert.deepEqual(state.controls, []);
        assert.deepEqual(state.recovered, []);
    }
    assert.throws(() => engine().remove(registry({ runtime: 'docker' })), /recorded 'docker' container engine/);
    assert.throws(() => engine().remove(registry({ repoName: '' })), /repository and agent identity/);
});

test('recovery preserves a same-name replacement between discovery and immutable-ID reinspection', () => {
    const state = engine();
    const inspect = state.options.inspect;
    state.options.inspect = (runtime, identifier) => {
        const result = inspect(runtime, identifier);
        if (identifier === NAME && result?.Id === ID) state.current = runtimeRecord({ Id: OTHER_ID });
        return result;
    };
    assert.throws(() => state.remove(), /lost its exact container/);
    assert.equal(state.current.Id, OTHER_ID);
    assert.deepEqual(state.controls, []);
    assert.deepEqual(state.recovered, []);
});

test('an absent failed container is idempotent even after its recorded descriptor was already removed', () => {
    const state = engine();
    const fixture = descriptorFixture();
    fs.unlinkSync(fixture.source);
    state.current = null;
    const record = registry({ containerId: ID, config: { binds: [fixture.bind] } });
    for (const input of [record, registry(), record]) {
        assert.deepEqual(state.remove(input), { found: false, stopped: false, removed: false, state: 'absent' });
    }
    assert.deepEqual(state.controls, []);
});

test('an initial launch may prove the canonical name absent without adopting an unregistered live container', () => {
    const absent = engine(null);
    assert.equal(absent.remove({}).state, 'absent');
    assert.equal(absent.remove(null).state, 'absent');
    const present = engine();
    assert.throws(() => present.remove({}), /complete managed-agent registry identity/);
    assert.throws(() => present.remove(null), /complete managed-agent registry identity/);
    assert.deepEqual(present.controls, []);
});

test('recovery reconstructs a missing descriptor bind only from the exact signed launch and removes it after the container', () => {
    const fixture = descriptorFixture();
    const state = engine(fixture.current);
    const control = state.options.control;
    state.options.control = (runtime, args) => {
        assert.equal(fs.existsSync(fixture.source), true);
        return control(runtime, args);
    };
    assert.equal(state.remove().removed, true);
    assert.equal(fs.existsSync(fixture.source), false);
    assert.deepEqual(state.recovered[0].record.config.binds, [fixture.bind]);
    assert.equal(state.remove().state, 'absent');
});

test('recovery can repair only the descriptor bind when the immutable registry ID was retained', () => {
    const fixture = descriptorFixture();
    const state = engine(fixture.current);
    assert.equal(state.remove(registry({ containerId: ID })).removed, true);
    assert.ok(state.inspections.every((value) => value === ID));
    assert.equal(fs.existsSync(fixture.source), false);
});

test('recovery retains the descriptor and recovered identity when immutable-ID removal fails', () => {
    const fixture = descriptorFixture();
    const state = engine(fixture.current);
    state.options.control = () => ({ status: 1 });
    assert.throws(() => state.remove(), (error) => {
        assert.match(error.message, /could not prove exact container removal/);
        assert.equal(error.recoveredContainerId, ID);
        return true;
    });
    assert.equal(fs.existsSync(fixture.source), true);
    assert.equal(state.recovered[0].record.containerId, ID);
});

test('recovery preserves foreign, forged, writable, linked or mismatched descriptors before container control', () => {
    const mutations = [
        (fixture) => { fixture.current.Mounts[0].RW = true; },
        (fixture) => { fixture.current.Mounts.push({ ...fixture.current.Mounts[0] }); },
        (fixture) => { fixture.current.Config.Env = fixture.current.Config.Env.filter((entry) => !entry.startsWith('PLOINKY_ROUTER_ATTESTATION_ID=')); },
        (fixture) => { fs.appendFileSync(fixture.source, ' '); },
        (fixture) => {
            const envelope = JSON.parse(fs.readFileSync(fixture.source, 'utf8'));
            envelope.signature = 'A'.repeat(86);
            fs.writeFileSync(fixture.source, JSON.stringify(envelope));
        },
        (fixture) => { fs.chmodSync(fixture.source, 0o666); },
        (fixture) => {
            const moved = `${fixture.source}.target`;
            fs.renameSync(fixture.source, moved);
            fs.symlinkSync(moved, fixture.source);
        },
    ];
    for (const mutate of mutations) {
        const fixture = descriptorFixture();
        mutate(fixture);
        const state = engine(fixture.current);
        assert.throws(() => state.remove());
        assert.deepEqual(state.controls, []);
        assert.deepEqual(state.recovered, []);
        assert.equal(fs.existsSync(fixture.source), true);
    }
    const foreign = descriptorFixture({ instanceId: 'foreign-instance' });
    foreign.current.Config.Env = foreign.current.Config.Env.map((entry) => entry.startsWith('PLOINKY_AGENT_INSTANCE_ID=')
        ? 'PLOINKY_AGENT_INSTANCE_ID=instance-exact' : entry);
    const state = engine(foreign.current);
    assert.throws(() => state.remove(), /launch identity|exact launch/);
    assert.deepEqual(state.controls, []);
    assert.equal(fs.existsSync(foreign.source), true);
});

test('a descriptor replaced while recording recovery preserves the container and replacement artifact', () => {
    const fixture = descriptorFixture();
    const state = engine(fixture.current);
    state.options.onRecoveredIdentity = () => {
        fs.renameSync(fixture.source, `${fixture.source}.original`);
        fs.writeFileSync(fixture.source, 'replacement', { mode: 0o600 });
    };
    assert.throws(() => state.remove(), /artifact identity drift/);
    assert.deepEqual(state.controls, []);
    assert.equal(fs.readFileSync(fixture.source, 'utf8'), 'replacement');
});

test('absent runtime inspection retains a surviving descriptor without claiming its ownership', () => {
    const fixture = descriptorFixture();
    const state = engine(null);
    assert.equal(state.remove(registry({ containerId: ID, config: { binds: [fixture.bind] } })).state, 'absent');
    assert.equal(fs.existsSync(fixture.source), true);
    assert.deepEqual(state.controls, []);
});

test('real inspection adapter distinguishes absent containers from unavailable engines without exposing inspection contents', () => {
    const script = path.join(workspace, 'inspection-engine');
    const responseFile = path.join(workspace, 'inspection-engine-response.json');
    fs.writeFileSync(script, `#!/usr/bin/env node
import fs from 'node:fs';
const response = JSON.parse(fs.readFileSync(${JSON.stringify(responseFile)}, 'utf8'));
process.stdout.write(response.stdout || '');
process.stderr.write(response.stderr || '');
process.exit(response.status);
`, { mode: 0o700 });
    const remove = () => removeExactContainerAndDescriptor(NAME, registry({ runtime: undefined }), script, {
        recoverIncompleteIdentity: true,
        withLock: (callback) => callback(),
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH }),
    });
    for (const stderr of ['Error: No such object: example', 'Error: no container with name or ID example found: no such container']) {
        fs.writeFileSync(responseFile, JSON.stringify({ status: 1, stderr }));
        assert.equal(remove().state, 'absent');
    }
    fs.writeFileSync(responseFile, JSON.stringify({ status: 125, stderr: 'Cannot connect to the Podman socket' }));
    assert.throws(remove, /check that the recorded container engine is available/);
    fs.writeFileSync(responseFile, JSON.stringify({ status: 0, stdout: 'secret-inspection-environment-invalid-json' }));
    assert.throws(remove, (error) => {
        assert.equal(error.message, 'container inspection returned malformed JSON');
        assert.doesNotMatch(error.message, /secret-inspection/);
        return true;
    });
    fs.writeFileSync(responseFile, JSON.stringify({ status: 0, stdout: '[]' }));
    assert.throws(remove, /one exact container record/);
});
