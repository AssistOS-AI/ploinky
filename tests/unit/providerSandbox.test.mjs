import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import {
    __testables as credentialContextTestables,
    createContainerAgentCredentialContext,
} from '../../Agent/lib/agentCredentialContext.mjs';
import {
    BWRAP_LAUNCH_LIMITS,
    BWRAP_RECORD_TYPES,
    PROVIDER_SANDBOX_HELPER,
    PROVIDER_SANDBOX_MODES,
    PROVIDER_SANDBOX_PROVIDERS,
    TRUSTED_SERVICE_ENV,
    acquireProviderHomeLease,
    buildProviderSandboxLaunch,
    buildProviderSandboxPolicy,
    buildTrustedServicePolicy,
    createArgRecord,
    createDevRecord,
    createHomeRecord,
    createPreexecBarrierRecord,
    createProcRecord,
    createReadOnlyDataFileRecord,
    createReadOnlyPathRecord,
    createTmpfsRecord,
    createWorkspaceRecord,
    encodeBwrapLaunchDescriptor,
    releaseProviderHomeLease,
    runProviderSandboxReadiness,
    spawnProviderSandbox,
    withProviderHomeLease,
} from '../../Agent/lib/providerSandbox.mjs';
import { buildBwrapAgentCredential } from '../../cli/sandbox/bwrap/bwrapAgentCredential.js';

const TOKEN_A = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);
const FIXED_NOW = Date.parse('2026-08-04T12:00:00.000Z');
const CURRENT_UID = typeof process.getuid === 'function' ? process.getuid() : 501;
const BOOT_A = '11111111-1111-4111-8111-111111111111';
const BOOT_B = '22222222-2222-4222-8222-222222222222';
const BOOT_C = '33333333-3333-4333-8333-333333333333';
const IDENTITY_A = `linux-proc:${BOOT_A}:100`;
const IDENTITY_B = `linux-proc:${BOOT_B}:200`;
const IDENTITY_C = `linux-proc:${BOOT_C}:300`;
const PROVIDER_PRINCIPAL = 'agent:AchillesCLI/coding-agent';
const PROVIDER_INSTANCE = 'coding-agent_alias-1';
const PROVIDER_GENERATION = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const PROVIDER_BROKER_KEY = 'c'.repeat(43);
const PROVIDER_BROKER_URL = 'http://127.0.0.1:43123/v1';

function identified(processIdentity = IDENTITY_A, processUid = CURRENT_UID) {
    return { state: 'identified', processIdentity, processUid };
}

function parseDescriptor(descriptor) {
    assert.equal(descriptor.subarray(0, 8).toString('ascii'), 'PLBWLP01');
    assert.equal(descriptor.readUInt32BE(12), 0);
    const declared = descriptor.readUInt32BE(8);
    const records = [];
    let offset = 16;
    for (let index = 0; index < declared; index += 1) {
        assert.equal(descriptor[offset + 1], 0);
        assert.equal(descriptor.readUInt16BE(offset + 2), 0);
        const length = descriptor.readUInt32BE(offset + 4);
        records.push({
            type: descriptor[offset],
            payload: descriptor.subarray(offset + 8, offset + 8 + length),
        });
        offset += 8 + length;
    }
    assert.equal(offset, descriptor.length);
    return records;
}

function providerCredentialContext() {
    const generated = buildBwrapAgentCredential({
        principalId: PROVIDER_PRINCIPAL,
        instanceId: PROVIDER_INSTANCE,
        enableGeneration: PROVIDER_GENERATION,
        runtimeKey: PROVIDER_INSTANCE,
        routeKey: 'coding-agent',
        router: {
            physicalOrigin: 'http://127.0.0.1:8080',
            requestAuthority: '127.0.0.1:18080',
            host: '127.0.0.1',
            port: 8080,
        },
        admission: {
            runtimeKind: 'bwrap',
            manifestDigest: `sha256:${'1'.repeat(64)}`,
            capabilityDigest: `sha256:${'2'.repeat(64)}`,
            networkHash: `sha256:${'3'.repeat(64)}`,
        },
    }, {
        now: Math.floor(Date.now() / 1000) - 10,
        randomBytes: () => Buffer.alloc(32, 7),
        buildCredentialEnv: () => ({
            PLOINKY_AGENT_SECRET: 'a'.repeat(64),
            PLOINKY_AGENT_PRIVATE_SECRET: 'b'.repeat(64),
            PLOINKY_AGENT_API_KEY: `${PROVIDER_PRINCIPAL}|fixture-signature`,
            PLOINKY_AGENT_API_PUBLIC_KEY: Buffer.alloc(32, 8).toString('base64url'),
        }),
    });
    return credentialContextTestables.createBwrapContextFromRead({
        descriptor: generated.descriptor,
        publicAttestation: generated.publicAttestation,
    });
}

function containerCredentialContext(t) {
    const fixtureRoot = path.resolve('tests/fixtures/router-descriptor');
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-container-context-'));
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    const descriptorFile = path.join(temporaryRoot, 'router-descriptor.json');
    fs.copyFileSync(path.join(fixtureRoot, 'public-envelope.json'), descriptorFile);
    fs.chmodSync(descriptorFile, 0o600);
    const env = JSON.parse(fs.readFileSync(
        path.join(fixtureRoot, 'public-environment.json'),
        'utf8',
    ));
    env.PLOINKY_ROUTER_DESCRIPTOR_FILE = descriptorFile;
    env.PLOINKY_AGENT_SECRET = 'a'.repeat(64);
    env.PLOINKY_AGENT_PRIVATE_SECRET = 'b'.repeat(64);
    return createContainerAgentCredentialContext(env);
}

function providerTaskInput(overrides = {}) {
    return {
        mode: PROVIDER_SANDBOX_MODES.TASK,
        provider: PROVIDER_SANDBOX_PROVIDERS.OPENCODE,
        credentialContext: providerCredentialContext(),
        workdir: 'projects/alpha',
        command: ['/home/agent/.opencode/bin/opencode', 'run'],
        environment: {
            PLOINKY_TASK_BROKER_URL: PROVIDER_BROKER_URL,
            PLOINKY_TASK_BROKER_KEY: PROVIDER_BROKER_KEY,
        },
        ...overrides,
    };
}

function recordIndex(records, predicate) {
    const index = records.findIndex(predicate);
    assert.notEqual(index, -1);
    return index;
}

function basePolicy(overrides = {}) {
    return buildTrustedServicePolicy({
        runtimeKey: 'coding-agent_alias-1',
        command: ['node', '/Agent/server/AgentServer.mjs'],
        nodeRuntimePath: '/usr/local',
        agentRuntimePath: '/opt/ploinky/Agent',
        codePath: '/workspace/.ploinky/deps/coding-agent/code',
        codeDependenciesPath: '/workspace/.ploinky/deps/coding-agent/code-node-modules',
        agentDependenciesPath: '/opt/ploinky/node_modules',
        identity: {
            principalId: 'agent:repo/coding-agent',
            instanceId: 'coding-agent_alias-1',
            enableGeneration: 'generation:1',
        },
        agentName: 'coding-agent',
        repoName: 'repo',
        listenPort: 7000,
        ...overrides,
    });
}

function leaseRoot(t) {
    const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'provider-home-lease-workspace-'));
    fs.chmodSync(workspace, 0o700);
    const ploinky = path.join(workspace, '.ploinky');
    const run = path.join(ploinky, 'run');
    fs.mkdirSync(ploinky, { mode: 0o700 });
    fs.mkdirSync(run, { mode: 0o700 });
    const root = path.join(run, 'provider-home-leases');
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    return root;
}

function leaseInput(root, overrides = {}) {
    return {
        homeKey: 'agent_alias-1',
        generation: 'generation:1',
        role: 'provider-task',
        metadata: { provider: 'codex', task: 7 },
        leaseRoot: root,
        ownerPid: 4242,
        ownerToken: TOKEN_A,
        ...overrides,
    };
}

function leaseDeps(state = identified()) {
    const inspect = typeof state === 'function' ? state : () => state;
    return {
        inspectProcessIdentity: inspect,
        randomBytes: () => Buffer.alloc(32, 1),
        now: () => FIXED_NOW,
        getUid: () => CURRENT_UID,
    };
}

function createP1P2P3RemovalRace(t) {
    const root = leaseRoot(t);
    const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
    const base = JSON.parse(fs.readFileSync(first.leasePath, 'utf8'));
    const p2 = {
        ...base,
        generation: 'generation:2',
        ownerPid: 5252,
        ownerStartIdentity: IDENTITY_B,
        ownerToken: TOKEN_B,
    };
    const p3 = {
        ...base,
        generation: 'generation:3',
        ownerPid: 6262,
        ownerStartIdentity: IDENTITY_C,
        ownerToken: 'd'.repeat(43),
    };
    const p2Raw = `${JSON.stringify(p2)}\n`;
    const p3Raw = `${JSON.stringify(p3)}\n`;
    let raced = false;
    const racingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    if (!raced && source === first.leasePath && destination.endsWith('.quarantine')) {
                        target.unlinkSync(source);
                        target.writeFileSync(source, p2Raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
                        target.linkSync(source, destination);
                        target.unlinkSync(source);
                        target.writeFileSync(source, p3Raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
                        raced = true;
                        return;
                    }
                    return target.linkSync(source, destination);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.throws(
        () => releaseProviderHomeLease(first, { ...leaseDeps(), fs: racingFs }),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
    );
    assert.equal(raced, true);
    assert.equal(fs.readFileSync(first.leasePath, 'utf8'), p3Raw);
    assert.equal(fs.readdirSync(root).filter((name) => name.includes('.operation-')).length, 2);
    return { root, first, p2, p3, p3Raw };
}

test('typed records encode the exact deterministic PLBWLP01 wire ABI', () => {
    const records = [
        createWorkspaceRecord('rw'),
        createHomeRecord('agent-1'),
        createReadOnlyPathRecord('/opt/source', '/opt/runtime', 'directory'),
        createReadOnlyDataFileRecord('/etc/hosts', '/etc/hosts'),
        createProcRecord(),
        createDevRecord(),
        createPreexecBarrierRecord(4, 5),
        createArgRecord('--'),
        createArgRecord('/bin/true'),
    ];
    const first = encodeBwrapLaunchDescriptor(records);
    const second = encodeBwrapLaunchDescriptor(records);
    assert.deepEqual(first, second);
    const parsed = parseDescriptor(first);
    assert.deepEqual(parsed.map(({ type }) => type), [2, 4, 5, 12, 8, 9, 11, 1, 1]);
    assert.deepEqual(parsed[0].payload, Buffer.from([2]));
    assert.equal(parsed[1].payload.toString(), '.data/agent-1');
    assert.equal(parsed[2].payload[0], 1);
    assert.equal(parsed[2].payload.readUInt16BE(1), Buffer.byteLength('/opt/source'));
    assert.equal(parsed[2].payload.readUInt16BE(3), Buffer.byteLength('/opt/runtime'));
    assert.equal(parsed[6].payload.readUInt32BE(0), 4);
    assert.equal(parsed[6].payload.readUInt32BE(4), 5);
    assert.equal(parsed[7].payload.toString(), '--');
    assert.equal(parsed[8].payload.toString(), '/bin/true');
});

test('read-only data records admit only the shared exact system mapping pairs', () => {
    const validMappings = [
        ['/etc/resolv.conf', '/etc/resolv.conf'],
        ['/etc/hosts', '/etc/hosts'],
        ['/etc/passwd', '/etc/passwd'],
        ['/etc/group', '/etc/group'],
        ['/etc/authselect/nsswitch.conf', '/etc/nsswitch.conf'],
        ['/etc/ld.so.cache', '/etc/ld.so.cache'],
    ];
    for (const [source, target] of validMappings) {
        assert.deepEqual(createReadOnlyDataFileRecord(source, target), {
            type: 'RO_DATA_PATH',
            source,
            target,
        });
    }
    for (const [source, target] of [
        ['/etc/shadow', '/etc/shadow'],
        ['/tmp/arbitrary', '/etc/hosts'],
        ['/etc/hosts', '/etc/shadow'],
        ['/etc/hosts', '/etc/resolv.conf'],
        ['/etc/authselect/nsswitch.conf', '/etc/authselect/nsswitch.conf'],
    ]) {
        assert.throws(
            () => createReadOnlyDataFileRecord(source, target),
            { code: 'PLOINKY_MOUNT_DESTINATION_UNSUPPORTED' },
        );
    }
});

test('encoder rejects unknown fields, raw bind/fd injection, duplicates, invalid order, and bounds', () => {
    assert.throws(
        () => encodeBwrapLaunchDescriptor([{ type: 'ARG', value: '--', injected: true }, createArgRecord('true')]),
        /unknown field injected/,
    );
    for (const option of ['--bind', '--ro-bind-fd=9', '--ro-bind-data', '--seccomp']) {
        assert.throws(
            () => encodeBwrapLaunchDescriptor([createArgRecord(option), createArgRecord('--'), createArgRecord('true')]),
            (error) => error?.code === 'PLOINKY_BWRAP_OPTION_FORBIDDEN',
        );
    }
    assert.throws(
        () => encodeBwrapLaunchDescriptor([
            createWorkspaceRecord('rw'),
            createWorkspaceRecord('ro'),
            createArgRecord('--'),
            createArgRecord('true'),
        ]),
        (error) => error?.code === 'PLOINKY_BWRAP_DUPLICATE_MOUNT',
    );
    assert.throws(
        () => encodeBwrapLaunchDescriptor([createArgRecord('--'), createArgRecord('true'), createProcRecord()]),
        /mount records are forbidden/,
    );
    assert.throws(
        () => encodeBwrapLaunchDescriptor([
            createTmpfsRecord('/tmp'),
            createTmpfsRecord('/tmp/cache'),
            createTmpfsRecord('/tmp'),
            createArgRecord('--'),
            createArgRecord('true'),
        ]),
        /duplicate mount/,
    );
    assert.throws(
        () => encodeBwrapLaunchDescriptor([
            ...Array.from({ length: BWRAP_LAUNCH_LIMITS.records - 1 }, () => createArgRecord('x')),
            createArgRecord('--'),
            createArgRecord('true'),
        ]),
        /record count/,
    );
    const large = 'x'.repeat(BWRAP_LAUNCH_LIMITS.argumentBytes);
    assert.throws(
        () => encodeBwrapLaunchDescriptor([
            ...Array.from({ length: 20 }, () => createArgRecord(large)),
            createArgRecord('--'),
            createArgRecord('true'),
        ]),
        (error) => error?.code === 'PLOINKY_BWRAP_PROTOCOL_TOO_LARGE',
    );
});

test('trusted service policy is fixed, frozen, explicit-network, and ends with command argv', () => {
    const policy = basePolicy();
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.records), true);
    assert.equal(Object.isFrozen(policy.env), true);
    assert.equal(policy.env.HOME, '/home/agent');
    assert.equal(policy.env.XDG_CACHE_HOME, '/tmp/cache');
    assert.equal(policy.env.PATH, '/opt/ploinky-node/bin:/usr/bin:/bin');
    assert.equal(policy.env.PATH.includes('/home/agent'), false);
    assert.equal(policy.env.PORT, '7000');
    assert.equal(policy.env.PLOINKY_RUNTIME, 'bwrap');
    assert.equal(policy.env.PLOINKY_AGENT_BIND_HOST, '127.0.0.1');
    assert.equal(policy.env.PLOINKY_AGENT_PRINCIPAL, 'agent:repo/coding-agent');
    assert.equal(policy.env.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_PRINCIPAL, 'generated');
    assert.equal(policy.env.PLOINKY_CONTAINER_NAME, undefined);
    assert.equal(policy.env.PLOINKY_CONTAINER_ID, undefined);

    const workspace = policy.records.filter((record) => record.type === 'WORKSPACE');
    const home = policy.records.filter((record) => record.type === 'HOME');
    assert.deepEqual(workspace, [createWorkspaceRecord('rw')]);
    assert.deepEqual(home, [createHomeRecord('coding-agent_alias-1')]);
    assert.equal(policy.records.some((record) => record.type === 'TMPFS' && record.target === '/tmp'), true);
    assert.equal(policy.records.some((record) => record.type === 'TMPFS' && record.target === '/run'), true);
    assert.equal(policy.records.some((record) => record.type === 'PROC'), true);
    assert.equal(policy.records.some((record) => record.type === 'DEV'), true);
    assert.ok(policy.records.some((record) => (
        record.type === 'RO_DATA_PATH'
        && record.source === '/etc/authselect/nsswitch.conf'
        && record.target === '/etc/nsswitch.conf'
    )));
    assert.equal(policy.records.some((record) => record.source === '/etc/nsswitch.conf'), false);
    for (const target of ['/etc/resolv.conf', '/etc/hosts', '/etc/passwd', '/etc/group', '/etc/nsswitch.conf', '/etc/ld.so.cache']) {
        assert.equal(policy.records.some((record) => record.type === 'RO_DATA_PATH' && record.target === target), true, target);
    }

    const args = policy.records.filter((record) => record.type === 'ARG').map((record) => record.value);
    for (const required of ['--share-net', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--clearenv']) {
        assert.equal(args.includes(required), true, required);
    }
    assert.deepEqual(args.slice(-3), ['--', 'node', '/Agent/server/AgentServer.mjs']);
    assert.deepEqual(policy.command, ['node', '/Agent/server/AgentServer.mjs']);
    assert.doesNotThrow(() => parseDescriptor(encodeBwrapLaunchDescriptor(policy.records)));

    const serialized = JSON.stringify(policy.records);
    for (const forbidden of ['/root', '/shared', 'podman.sock', 'docker.sock', '/home/podman']) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    for (const exactTarget of ['/opt/ploinky-node', '/Agent', '/code', '/code/node_modules', '/Agent/node_modules']) {
        assert.equal(policy.records.some((record) => record.type === 'RO_PATH' && record.target === exactTarget), true, exactTarget);
    }
});

test('trusted service credential transport is singular, fd-only, and unavailable to generic records', () => {
    const policy = basePolicy({ credentialFd: 4 });
    const credentialDirectoryIndex = policy.records.findIndex((record) => (
        record.type === 'DIR' && record.target === '/run/ploinky-agent'
    ));
    const credentialArgs = policy.records
        .filter((record) => record.type === 'ARG')
        .map((record) => record.value);
    const credentialArgIndex = credentialArgs.indexOf('--perms');

    assert.ok(credentialDirectoryIndex >= 0);
    assert.ok(credentialArgIndex >= 0);
    assert.deepEqual(
        credentialArgs.slice(credentialArgIndex, credentialArgIndex + 5),
        ['--perms', '0400', '--ro-bind-data', '4', '/run/ploinky-agent/credential.json'],
    );
    assert.equal(credentialArgs.filter((value) => value === '--ro-bind-data').length, 1);
    assert.equal(JSON.stringify(policy.records).includes('credential.json'), true);
    assert.doesNotThrow(() => encodeBwrapLaunchDescriptor(policy.records));

    for (const credentialFd of [3, 4.5, '4', Number.MAX_SAFE_INTEGER]) {
        assert.throws(
            () => basePolicy({ credentialFd }),
            (error) => error?.code === 'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
        );
    }
    assert.throws(
        () => encodeBwrapLaunchDescriptor([
            createArgRecord('--perms'),
            createArgRecord('0400'),
            createArgRecord('--ro-bind-data'),
            createArgRecord('4'),
            createArgRecord('/run/ploinky-agent/credential.json'),
            createArgRecord('--'),
            createArgRecord('/bin/true'),
        ]),
        (error) => error?.code === 'PLOINKY_BWRAP_CREDENTIAL_TRANSPORT_INVALID',
    );
});

test('trusted service dynamic env is deterministic, bounded, and cannot weaken fixed values or mounts', () => {
    const left = basePolicy({ environment: { Z_VALUE: 'last', A_VALUE: 'first' } });
    const right = basePolicy({ environment: { A_VALUE: 'first', Z_VALUE: 'last' } });
    assert.deepEqual(encodeBwrapLaunchDescriptor(left.records), encodeBwrapLaunchDescriptor(right.records));
    assert.equal(left.env.A_VALUE, 'first');
    assert.equal(left.env.Z_VALUE, 'last');
    assert.equal(left.env.HOME, TRUSTED_SERVICE_ENV.HOME);
    assert.equal(left.env.PORT, '7000');
    assert.equal(left.env.PLOINKY_AGENT_ID, 'agent:repo/coding-agent');
    for (const name of [
        'HOME',
        'PORT',
        'PLOINKY_RUNTIME',
        'PLOINKY_AGENT_PRIVATE_SECRET',
        'PLOINKY_AGENT_API_KEY',
        'PLOINKY_ROUTER_URL',
        'PLOINKY_AGENT_CREDENTIAL_FILE',
        'PLOINKY_ENV_SOURCE_PLOINKY_AGENT_ID',
        'PLOINKY_CONTAINER_NAME',
        'PLOINKY_AGENT_BIND_HOST',
    ]) {
        assert.throws(
            () => basePolicy({ environment: { [name]: name === 'HOME' ? TRUSTED_SERVICE_ENV.HOME : 'attacker' } }),
            (error) => error?.code === 'PLOINKY_BWRAP_SERVICE_ENV_RESERVED'
                && error.message.includes(name)
                && !error.message.includes('attacker'),
            name,
        );
    }
    assert.doesNotThrow(() => basePolicy({ environment: {
        PLOINKY_AGENT_CLIENT_ID: 'client-id',
        PLOINKY_AGENT_CLIENT_SECRET: 'client-secret',
    } }));
    assert.throws(() => basePolicy({ environment: { 'BAD-NAME': 'x' } }), /name BAD-NAME is invalid/);
    assert.throws(() => basePolicy({ environment: { ORDINARY_VALUE: 7000 } }), /must be a string/);
    assert.throws(() => basePolicy({ volumes: { '/engine': '/engine' } }), /unknown field volumes/);
    assert.throws(() => basePolicy({ sharedDir: '/workspace/.ploinky/shared' }), /unknown field sharedDir/);
});

test('exclusive HOME lease uses canonical wx state and reports a live exact owner busy', (t) => {
    const root = leaseRoot(t);
    const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
    assert.equal(first.homeKey, 'agent_alias-1');
    assert.equal(first.leaseRoot, root);
    assert.equal(fs.statSync(first.leasePath).mode & 0o777, 0o600);
    const raw = fs.readFileSync(first.leasePath, 'utf8');
    assert.equal(raw.endsWith('\n'), true);
    assert.deepEqual(Object.keys(JSON.parse(raw)), [
        'acquiredAt', 'generation', 'homeKey', 'metadata', 'ownerPid',
        'ownerStartIdentity', 'ownerToken', 'ownerUid', 'role', 'schemaVersion',
    ]);
    assert.equal(JSON.parse(raw).schemaVersion, 2);
    assert.equal(JSON.parse(raw).ownerUid, CURRENT_UID);
    assert.throws(
        () => acquireProviderHomeLease(leaseInput(root, { ownerToken: TOKEN_B, role: 'interactive-cli' }), leaseDeps()),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY'
            && error.owner?.ownerPid === 4242
            && error.owner?.ownerToken === undefined,
    );
    assert.throws(
        () => releaseProviderHomeLease({ ...first, ownerToken: TOKEN_B }),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_NOT_OWNER',
    );
    assert.equal(fs.existsSync(first.leasePath), true);
    assert.equal(releaseProviderHomeLease(first), true);
    assert.equal(fs.existsSync(first.leasePath), false);
});

test('HOME lease recovery requires proof of dead or PID-reused ownership', (t) => {
    const deadRoot = leaseRoot(t);
    const deadOwner = acquireProviderHomeLease(leaseInput(deadRoot), leaseDeps());
    const afterDeath = acquireProviderHomeLease(
        leaseInput(deadRoot, {
            ownerPid: 5252,
            ownerToken: TOKEN_B,
            generation: 'generation:2',
        }),
        leaseDeps((pid) => pid === 5252 ? identified(IDENTITY_B) : { state: 'dead' }),
    );
    assert.equal(afterDeath.recoveredStaleOwner.reason, 'dead');
    assert.equal(afterDeath.recoveredStaleOwner.ownerPid, deadOwner.ownerPid);
    releaseProviderHomeLease(afterDeath);

    const reusedRoot = leaseRoot(t);
    acquireProviderHomeLease(leaseInput(reusedRoot), leaseDeps());
    const afterReuse = acquireProviderHomeLease(
        leaseInput(reusedRoot, {
            ownerPid: 5252,
            ownerToken: TOKEN_B,
        }),
        leaseDeps(() => identified(IDENTITY_B)),
    );
    assert.equal(afterReuse.recoveredStaleOwner.reason, 'pid-reused');
    releaseProviderHomeLease(afterReuse);

    const unknownRoot = leaseRoot(t);
    const unknown = acquireProviderHomeLease(leaseInput(unknownRoot), leaseDeps());
    assert.throws(
        () => acquireProviderHomeLease(
            leaseInput(unknownRoot, { ownerPid: 5252, ownerToken: TOKEN_B }),
            leaseDeps((pid) => pid === 5252 ? identified(IDENTITY_B) : { state: 'unknown' }),
        ),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY' && error.owner?.uncertain === true,
    );
    releaseProviderHomeLease(unknown);

    const uidDivergedRoot = leaseRoot(t);
    const uidDiverged = acquireProviderHomeLease(leaseInput(uidDivergedRoot), leaseDeps());
    assert.throws(
        () => acquireProviderHomeLease(
            leaseInput(uidDivergedRoot, { ownerPid: 5252, ownerToken: TOKEN_B }),
            leaseDeps((pid) => pid === 5252 ? identified(IDENTITY_B) : { state: 'uid-diverged', processUid: CURRENT_UID }),
        ),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY' && error.owner?.uncertain === true,
    );
    releaseProviderHomeLease(uidDiverged);

    const uidMismatchRoot = leaseRoot(t);
    const uidMismatch = acquireProviderHomeLease(leaseInput(uidMismatchRoot), leaseDeps());
    assert.throws(
        () => acquireProviderHomeLease(
            leaseInput(uidMismatchRoot, { ownerPid: 5252, ownerToken: TOKEN_B }),
            leaseDeps((pid) => pid === 5252
                ? identified(IDENTITY_B)
                : identified(IDENTITY_A, CURRENT_UID + 1)),
        ),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY' && error.owner?.uncertain === true,
    );
    releaseProviderHomeLease(uidMismatch);
});

test('HOME lease exact removal never unlinks a successor at the primary path', (t) => {
    const root = leaseRoot(t);
    const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
    const successorRecord = {
        ...JSON.parse(fs.readFileSync(first.leasePath, 'utf8')),
        generation: 'generation:2',
        ownerPid: 5252,
        ownerStartIdentity: IDENTITY_B,
        ownerToken: TOKEN_B,
    };
    const successorRaw = `${JSON.stringify(successorRecord)}\n`;
    let successorPublished = false;
    const racingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'unlinkSync') {
                return (source) => {
                    target.unlinkSync(source);
                    if (source !== first.leasePath) return;
                    target.writeFileSync(source, successorRaw, {
                        encoding: 'utf8',
                        flag: 'wx',
                        mode: 0o600,
                    });
                    successorPublished = true;
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });

    assert.equal(releaseProviderHomeLease(first, { ...leaseDeps(), fs: racingFs }), true);
    assert.equal(successorPublished, true);
    assert.equal(fs.readFileSync(first.leasePath, 'utf8'), successorRaw);
    assert.equal(releaseProviderHomeLease({ ...first, ...successorRecord }), true);
});

test('HOME lease exact removal never clobbers an independent quarantine collision', (t) => {
    const root = leaseRoot(t);
    const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
    const firstRaw = fs.readFileSync(first.leasePath, 'utf8');
    const displacedRecord = {
        ...JSON.parse(firstRaw),
        generation: 'generation:2',
        ownerPid: 5252,
        ownerStartIdentity: IDENTITY_B,
        ownerToken: TOKEN_B,
    };
    const displacedRaw = `${JSON.stringify(displacedRecord)}\n`;
    let quarantinePath = '';
    const collisionFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    if (!quarantinePath && source === first.leasePath && destination.endsWith('.quarantine')) {
                        quarantinePath = destination;
                        target.writeFileSync(destination, displacedRaw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
                    }
                    return target.linkSync(source, destination);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });

    assert.throws(
        () => releaseProviderHomeLease(first, { ...leaseDeps(), fs: collisionFs }),
        (error) => error?.code === 'EEXIST' && error.providerLeaseTransitionApplied === true,
    );
    assert.equal(fs.readFileSync(first.leasePath, 'utf8'), firstRaw);
    assert.equal(fs.readFileSync(quarantinePath, 'utf8'), displacedRaw);
    assert.equal(fs.readdirSync(root).filter((name) => name.includes('.operation-')).length, 2);

    assert.throws(
        () => acquireProviderHomeLease(leaseInput(root, {
            ownerPid: 7373,
            ownerToken: 'e'.repeat(43),
            generation: 'generation:3',
        }), leaseDeps((pid) => pid === 5252 ? identified(IDENTITY_B) : identified(IDENTITY_A))),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY' && error.owner?.ownerPid === 5252,
    );
    const recovered = acquireProviderHomeLease(leaseInput(root, {
        ownerPid: 7373,
        ownerToken: 'e'.repeat(43),
        generation: 'generation:3',
    }), leaseDeps((pid) => pid === 7373 ? identified(IDENTITY_A) : { state: 'dead' }));
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.operation-')), false);
    assert.equal(releaseProviderHomeLease(recovered), true);
});

test('HOME lease publication and release accept applied EIO only after exact durable proof', (t) => {
    const publicationRoot = leaseRoot(t);
    let publicationInjected = false;
    const publicationFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    target.linkSync(source, destination);
                    if (!publicationInjected && source.includes('.publication-') && destination.endsWith('.lease.json')) {
                        publicationInjected = true;
                        const error = new Error('simulated applied publication link EIO');
                        error.code = 'EIO';
                        throw error;
                    }
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const published = acquireProviderHomeLease(leaseInput(publicationRoot), { ...leaseDeps(), fs: publicationFs });
    assert.equal(publicationInjected, true);
    assert.equal(fs.statSync(published.leasePath).nlink, 1);
    assert.equal(releaseProviderHomeLease(published), true);

    for (const transition of ['quarantine-link', 'canonical-unlink']) {
        const root = leaseRoot(t);
        const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
        let injected = false;
        const appliedFs = new Proxy(fs, {
            get(target, property, receiver) {
                if (property === 'linkSync' && transition === 'quarantine-link') {
                    return (source, destination) => {
                        target.linkSync(source, destination);
                        if (!injected && source === first.leasePath && destination.endsWith('.quarantine')) {
                            injected = true;
                            const error = new Error('simulated applied quarantine link EIO');
                            error.code = 'EIO';
                            throw error;
                        }
                    };
                }
                if (property === 'unlinkSync' && transition === 'canonical-unlink') {
                    return (targetPath) => {
                        target.unlinkSync(targetPath);
                        if (!injected && targetPath === first.leasePath) {
                            injected = true;
                            const error = new Error('simulated applied canonical unlink EIO');
                            error.code = 'EIO';
                            throw error;
                        }
                    };
                }
                return Reflect.get(target, property, receiver);
            },
        });
        assert.equal(releaseProviderHomeLease(first, { ...leaseDeps(), fs: appliedFs }), true);
        assert.equal(injected, true);
        assert.equal(fs.existsSync(first.leasePath), false);
        assert.equal(fs.readdirSync(root).some((name) => name.includes('.operation-')), false);
    }
});

test('HOME lease applied mutation plus proof EIO preserves exact recovery authority', (t) => {
    for (const transition of ['quarantine-link', 'canonical-unlink']) {
        const root = leaseRoot(t);
        const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
        let mutationInjected = false;
        let proofInjected = false;
        let proofTarget = '';
        const proofFailureFs = new Proxy(fs, {
            get(target, property, receiver) {
                if (property === 'linkSync' && transition === 'quarantine-link') {
                    return (source, destination) => {
                        target.linkSync(source, destination);
                        if (!mutationInjected && source === first.leasePath && destination.endsWith('.quarantine')) {
                            mutationInjected = true;
                            proofTarget = destination;
                            const error = new Error('simulated applied quarantine link EIO');
                            error.code = 'EIO';
                            throw error;
                        }
                    };
                }
                if (property === 'unlinkSync' && transition === 'canonical-unlink') {
                    return (targetPath) => {
                        target.unlinkSync(targetPath);
                        if (!mutationInjected && targetPath === first.leasePath) {
                            mutationInjected = true;
                            proofTarget = targetPath;
                            const error = new Error('simulated applied canonical unlink EIO');
                            error.code = 'EIO';
                            throw error;
                        }
                    };
                }
                if (property === 'lstatSync') {
                    return (targetPath, ...args) => {
                        if (mutationInjected && !proofInjected && targetPath === proofTarget) {
                            proofInjected = true;
                            const error = new Error('simulated transition proof EIO');
                            error.code = 'EIO';
                            throw error;
                        }
                        return target.lstatSync(targetPath, ...args);
                    };
                }
                return Reflect.get(target, property, receiver);
            },
        });

        assert.throws(
            () => releaseProviderHomeLease(first, { ...leaseDeps(), fs: proofFailureFs }),
            (error) => error?.code === 'EIO'
                && error.providerLeaseTransitionApplied === true
                && error.providerLeaseDurabilityUncertain === true,
        );
        assert.equal(mutationInjected, true);
        assert.equal(proofInjected, true);
        assert.equal(fs.readdirSync(root).filter((name) => name.includes('.operation-')).length, 2);
        assert.throws(
            () => acquireProviderHomeLease(leaseInput(root, { ownerToken: TOKEN_B }), leaseDeps()),
            (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY' && error.owner?.ownerPid === 4242,
        );
        const recovered = acquireProviderHomeLease(leaseInput(root, {
            ownerPid: 5252,
            ownerToken: TOKEN_B,
            generation: 'generation:2',
        }), leaseDeps((pid) => pid === 5252 ? identified(IDENTITY_B) : { state: 'dead' }));
        assert.equal(fs.readdirSync(root).some((name) => name.includes('.operation-')), false);
        assert.equal(releaseProviderHomeLease(recovered), true);
    }
});

test('HOME lease pins the exact private store across permission and symlink replacement races', (t) => {
    for (const drift of ['store-permissions', 'parent-permissions', 'symlink-replacement']) {
        const root = leaseRoot(t);
        const parent = path.dirname(root);
        const displacedRoot = `${root}.displaced`;
        t.after(() => fs.rmSync(displacedRoot, { recursive: true, force: true }));
        const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
        let injected = false;
        const driftingFs = new Proxy(fs, {
            get(target, property, receiver) {
                if (property === 'fsyncSync') {
                    return (descriptor) => {
                        if (!injected && target.fstatSync(descriptor).isDirectory()) {
                            injected = true;
                            if (drift === 'store-permissions') {
                                target.chmodSync(root, 0o755);
                            } else if (drift === 'parent-permissions') {
                                target.chmodSync(parent, 0o777);
                            } else {
                                target.renameSync(root, displacedRoot);
                                target.symlinkSync(displacedRoot, root);
                            }
                        }
                        return target.fsyncSync(descriptor);
                    };
                }
                return Reflect.get(target, property, receiver);
            },
        });

        assert.throws(
            () => releaseProviderHomeLease(first, { ...leaseDeps(), fs: driftingFs }),
            (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID'
                && error.providerLeaseTransitionApplied === true
                && error.providerLeaseDurabilityUncertain === true,
        );
        assert.equal(injected, true);
        if (drift === 'store-permissions') {
            assert.equal(fs.readdirSync(root).filter((name) => name.includes('.operation-')).length, 1);
            fs.chmodSync(root, 0o700);
        } else if (drift === 'parent-permissions') {
            assert.equal(fs.readdirSync(root).filter((name) => name.includes('.operation-')).length, 1);
            fs.chmodSync(parent, 0o700);
        } else {
            assert.equal(fs.lstatSync(root).isSymbolicLink(), true);
            assert.equal(fs.readdirSync(displacedRoot).filter((name) => name.includes('.operation-')).length, 1);
            fs.unlinkSync(root);
            fs.renameSync(displacedRoot, root);
        }
        assert.throws(
            () => acquireProviderHomeLease(leaseInput(root, { ownerToken: TOKEN_B }), leaseDeps()),
            (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY' && error.owner?.ownerPid === 4242,
        );
        assert.equal(fs.readdirSync(root).some((name) => name.includes('.operation-')), false);
        assert.equal(releaseProviderHomeLease(first), true);
    }
});

test('HOME lease durable lineage rejects a fresh same-UID replacement store across calls', (t) => {
    const root = leaseRoot(t);
    const displacedRoot = `${root}.split-brain`;
    t.after(() => fs.rmSync(displacedRoot, { recursive: true, force: true }));
    const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
    const rootIdentity = fs.statSync(root);
    let replaced = false;
    const replacementFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'fsyncSync') {
                return (descriptor) => {
                    const descriptorStat = target.fstatSync(descriptor);
                    if (!replaced && descriptorStat.isDirectory()
                        && descriptorStat.dev === rootIdentity.dev
                        && descriptorStat.ino === rootIdentity.ino) {
                        replaced = true;
                        target.renameSync(root, displacedRoot);
                        target.mkdirSync(root, { mode: 0o700 });
                    }
                    return target.fsyncSync(descriptor);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });

    assert.throws(
        () => releaseProviderHomeLease(first, { ...leaseDeps(), fs: replacementFs }),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID'
            && error.providerLeaseTransitionApplied === true
            && error.providerLeaseDurabilityUncertain === true,
    );
    assert.equal(replaced, true);
    assert.equal(fs.existsSync(path.join(displacedRoot, path.basename(first.leasePath))), true);
    assert.equal(fs.readdirSync(displacedRoot).filter((name) => name.includes('.operation-')).length, 1);
    assert.deepEqual(fs.readdirSync(root), []);

    assert.throws(
        () => acquireProviderHomeLease(leaseInput(root, {
            ownerPid: 5252,
            ownerToken: TOKEN_B,
            generation: 'generation:2',
        }), leaseDeps(identified(IDENTITY_B))),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID'
            && /durable workspace lineage/.test(error.message),
    );
    assert.deepEqual(fs.readdirSync(root), []);

    fs.rmdirSync(root);
    fs.renameSync(displacedRoot, root);
    assert.throws(
        () => acquireProviderHomeLease(leaseInput(root, { ownerToken: TOKEN_B }), leaseDeps()),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY' && error.owner?.ownerPid === 4242,
    );
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.operation-')), false);
    assert.equal(releaseProviderHomeLease(first), true);
});

test('HOME lease workspace lineage rejects replaced run and .ploinky subtrees across calls', (t) => {
    for (const replacedComponent of ['run', '.ploinky']) {
        const root = leaseRoot(t);
        const run = path.dirname(root);
        const ploinky = path.dirname(run);
        const targetPath = replacedComponent === 'run' ? run : ploinky;
        const displacedPath = `${targetPath}.displaced`;
        t.after(() => fs.rmSync(displacedPath, { recursive: true, force: true }));
        const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
        const rootIdentity = fs.statSync(root);
        let replaced = false;
        const replacementFs = new Proxy(fs, {
            get(target, property, receiver) {
                if (property === 'fsyncSync') {
                    return (descriptor) => {
                        const descriptorStat = target.fstatSync(descriptor);
                        if (!replaced && descriptorStat.isDirectory()
                            && descriptorStat.dev === rootIdentity.dev
                            && descriptorStat.ino === rootIdentity.ino) {
                            replaced = true;
                            target.renameSync(targetPath, displacedPath);
                            if (replacedComponent === '.ploinky') {
                                target.mkdirSync(ploinky, { mode: 0o700 });
                            }
                            target.mkdirSync(run, { mode: 0o700 });
                            target.mkdirSync(root, { mode: 0o700 });
                        }
                        return target.fsyncSync(descriptor);
                    };
                }
                return Reflect.get(target, property, receiver);
            },
        });

        assert.throws(
            () => releaseProviderHomeLease(first, { ...leaseDeps(), fs: replacementFs }),
            (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID'
                && error.providerLeaseTransitionApplied === true
                && error.providerLeaseDurabilityUncertain === true,
        );
        assert.equal(replaced, true);
        assert.deepEqual(fs.readdirSync(root), []);
        assert.throws(
            () => acquireProviderHomeLease(leaseInput(root, {
                ownerPid: 5252,
                ownerToken: TOKEN_B,
                generation: 'generation:2',
            }), leaseDeps(identified(IDENTITY_B))),
            (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID'
                && /durable workspace lineage/.test(error.message),
        );
        assert.deepEqual(fs.readdirSync(root), []);

        fs.rmSync(targetPath, { recursive: true });
        fs.renameSync(displacedPath, targetPath);
        assert.throws(
            () => acquireProviderHomeLease(leaseInput(root, { ownerToken: TOKEN_B }), leaseDeps()),
            (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY' && error.owner?.ownerPid === 4242,
        );
        assert.equal(releaseProviderHomeLease(first), true);
    }
});

test('HOME lease rejects missing or deleted workspace lineage for an existing store', (t) => {
    const uninitializedRoot = leaseRoot(t);
    fs.mkdirSync(uninitializedRoot, { mode: 0o700 });
    assert.throws(
        () => acquireProviderHomeLease(leaseInput(uninitializedRoot), leaseDeps()),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID'
            && /lineage is missing/.test(error.message),
    );
    assert.deepEqual(fs.readdirSync(uninitializedRoot), []);

    const initializedRoot = leaseRoot(t);
    const first = acquireProviderHomeLease(leaseInput(initializedRoot), leaseDeps());
    const workspace = path.dirname(path.dirname(path.dirname(initializedRoot)));
    const marker = path.join(workspace, '.ploinky-provider-home-leases-lineage.json');
    const markerRaw = fs.readFileSync(marker);
    fs.unlinkSync(marker);
    assert.throws(
        () => acquireProviderHomeLease(leaseInput(initializedRoot, {
            ownerPid: 5252,
            ownerToken: TOKEN_B,
            generation: 'generation:2',
        }), leaseDeps(identified(IDENTITY_B))),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID'
            && /lineage is missing/.test(error.message),
    );
    assert.equal(fs.existsSync(first.leasePath), true);
    fs.writeFileSync(marker, markerRaw, { flag: 'wx', mode: 0o600 });
    assert.equal(releaseProviderHomeLease(first), true);
});

test('HOME lease accepts only the exact workspace state topology', (t) => {
    const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'provider-home-invalid-topology-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    for (const invalidRoot of [
        path.join(workspace, 'provider-home-leases'),
        path.join(workspace, '.ploinky', 'provider-home-leases'),
        path.join(workspace, '.ploinky', 'running', 'provider-home-leases'),
        path.join(workspace, '.ploinky', 'run', 'leases'),
    ]) {
        assert.throws(
            () => acquireProviderHomeLease(leaseInput(invalidRoot), leaseDeps()),
            (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID'
                && /exact workspace/.test(error.message),
            invalidRoot,
        );
    }
});

test('HOME lease partial lineage initialization fails closed across later calls', (t) => {
    const root = leaseRoot(t);
    let injected = false;
    const partialLineageFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'writeSync') {
                return (descriptor, buffer, offset, length, position) => {
                    if (!injected) {
                        injected = true;
                        target.writeSync(descriptor, buffer, offset, Math.min(17, length), position);
                        const error = new Error('simulated partial lineage write');
                        error.code = 'EIO';
                        throw error;
                    }
                    return target.writeSync(descriptor, buffer, offset, length, position);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });

    assert.throws(
        () => acquireProviderHomeLease(leaseInput(root), { ...leaseDeps(), fs: partialLineageFs }),
        (error) => error?.code === 'EIO',
    );
    assert.equal(injected, true);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.throws(
        () => acquireProviderHomeLease(leaseInput(root), leaseDeps()),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID'
            && /lineage is (?:malformed|not canonical)/.test(error.message),
    );
    assert.deepEqual(fs.readdirSync(root), []);
});

test('HOME lease claim race removes only its private claim and preserves the successor', (t) => {
    const root = leaseRoot(t);
    const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
    const successorRecord = {
        ...JSON.parse(fs.readFileSync(first.leasePath, 'utf8')),
        generation: 'generation:2',
        ownerPid: 5252,
        ownerStartIdentity: IDENTITY_B,
        ownerToken: TOKEN_B,
    };
    const successorRaw = `${JSON.stringify(successorRecord)}\n`;
    let raced = false;
    const racingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    if (!raced && source === first.leasePath && destination.endsWith('.claim')) {
                        target.unlinkSync(source);
                        target.writeFileSync(source, successorRaw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
                        raced = true;
                    }
                    return target.linkSync(source, destination);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });

    assert.throws(
        () => releaseProviderHomeLease(first, { ...leaseDeps(), fs: racingFs }),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_CHANGED',
    );
    assert.equal(raced, true);
    assert.equal(fs.readFileSync(first.leasePath, 'utf8'), successorRaw);
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.operation-')), false);
    assert.equal(releaseProviderHomeLease({ ...first, ...successorRecord }), true);
});

test('HOME lease P1/P2/P3 removal race preserves canonical P3 and blocks on quarantined P2', (t) => {
    const { root, first, p3Raw } = createP1P2P3RemovalRace(t);

    const liveP2 = (pid) => {
        if (pid === 7373) return identified(IDENTITY_A);
        if (pid === 5252) return identified(IDENTITY_B);
        if (pid === 6262) return identified(IDENTITY_C);
        return identified(IDENTITY_A);
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.throws(
            () => acquireProviderHomeLease(leaseInput(root, {
                ownerPid: 7373,
                ownerToken: 'e'.repeat(43),
                generation: 'generation:4',
            }), leaseDeps(liveP2)),
            (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY'
                && error.owner?.ownerPid === 5252,
        );
        assert.equal(fs.readFileSync(first.leasePath, 'utf8'), p3Raw);
        assert.equal(fs.readdirSync(root).filter((name) => name.includes('.operation-')).length, 2);
    }

    const recovered = acquireProviderHomeLease(leaseInput(root, {
        ownerPid: 7373,
        ownerToken: 'e'.repeat(43),
        generation: 'generation:4',
    }), leaseDeps((pid) => pid === 7373 ? identified(IDENTITY_A) : { state: 'dead' }));
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.operation-')), false);
    assert.equal(recovered.recoveredStaleOwner.ownerPid, 6262);
    assert.equal(releaseProviderHomeLease(recovered), true);
});

test('HOME lease P1/P2 cleanup accepts applied EIO at either artifact unlink without touching P3', (t) => {
    for (const appliedEioAt of [1, 2]) {
        const { root, first, p3Raw } = createP1P2P3RemovalRace(t);
        const interruptedArtifacts = new Set(
            fs.readdirSync(root)
                .filter((name) => name.includes('.operation-'))
                .map((name) => path.join(root, name)),
        );
        let operationUnlinks = 0;
        let p3Proofs = 0;
        const crashingFs = new Proxy(fs, {
            get(target, property, receiver) {
                if (property === 'unlinkSync') {
                    return (candidatePath) => {
                        target.unlinkSync(candidatePath);
                        if (interruptedArtifacts.has(candidatePath)) {
                            operationUnlinks += 1;
                            assert.equal(target.readFileSync(first.leasePath, 'utf8'), p3Raw);
                            p3Proofs += 1;
                            if (operationUnlinks === appliedEioAt) {
                                const error = new Error(`simulated applied EIO after operation unlink ${appliedEioAt}`);
                                error.code = 'EIO';
                                throw error;
                            }
                        }
                    };
                }
                return Reflect.get(target, property, receiver);
            },
        });
        const recovered = acquireProviderHomeLease(leaseInput(root, {
            ownerPid: 7373,
            ownerToken: 'e'.repeat(43),
            generation: 'generation:4',
        }), {
            ...leaseDeps((pid) => pid === 7373 ? identified(IDENTITY_A) : { state: 'dead' }),
            fs: crashingFs,
        });
        assert.equal(operationUnlinks, 2);
        assert.equal(p3Proofs, 2);
        assert.equal(fs.readdirSync(root).some((name) => name.includes('.operation-')), false);
        assert.equal(recovered.recoveredStaleOwner.ownerPid, 6262);
        assert.equal(releaseProviderHomeLease(recovered), true);
    }
});

test('HOME lease recovery removes a lone private claim without disturbing canonical authority', (t) => {
    const root = leaseRoot(t);
    const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
    const canonicalRaw = fs.readFileSync(first.leasePath, 'utf8');
    let interrupted = false;
    let proofFailed = false;
    const interruptedFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'linkSync') {
                return (source, destination) => {
                    if (!interrupted && source === first.leasePath && destination.endsWith('.quarantine')) {
                        interrupted = true;
                        const error = new Error('simulated failure before no-clobber quarantine publication');
                        error.code = 'EIO';
                        throw error;
                    }
                    return target.linkSync(source, destination);
                };
            }
            if (property === 'lstatSync') {
                return (targetPath, ...args) => {
                    if (interrupted && !proofFailed && targetPath.endsWith('.quarantine')) {
                        proofFailed = true;
                        const error = new Error('simulated quarantine proof EIO');
                        error.code = 'EIO';
                        throw error;
                    }
                    return target.lstatSync(targetPath, ...args);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.throws(
        () => releaseProviderHomeLease(first, { ...leaseDeps(), fs: interruptedFs }),
        (error) => error?.code === 'EIO',
    );
    const artifacts = fs.readdirSync(root).filter((name) => name.includes('.operation-'));
    assert.equal(artifacts.length, 1);
    assert.match(artifacts[0], /\.claim$/);
    assert.equal(fs.readFileSync(first.leasePath, 'utf8'), canonicalRaw);

    assert.throws(
        () => acquireProviderHomeLease(leaseInput(root, {
            ownerPid: 7373,
            ownerToken: 'e'.repeat(43),
            generation: 'generation:4',
        }), leaseDeps()),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY'
            && error.owner?.ownerPid === 4242,
    );
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.operation-')), false);
    assert.equal(fs.readFileSync(first.leasePath, 'utf8'), canonicalRaw);
    assert.equal(releaseProviderHomeLease(first), true);
});

test('HOME lease partial publication never creates malformed canonical state and is recoverable', (t) => {
    const root = leaseRoot(t);
    let injected = false;
    let writes = 0;
    const partialFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'writeSync') {
                return (descriptor, bytes, offset, length, position) => {
                    writes += 1;
                    if (writes === 1) {
                        return target.writeSync(descriptor, bytes, offset, length, position);
                    }
                    if (!injected) {
                        injected = true;
                        target.writeSync(descriptor, bytes, offset, Math.min(17, length), position);
                        const error = new Error('simulated publication EIO');
                        error.code = 'EIO';
                        throw error;
                    }
                    return target.writeSync(descriptor, bytes, offset, length, position);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });

    assert.throws(
        () => acquireProviderHomeLease(leaseInput(root), { ...leaseDeps(), fs: partialFs }),
        (error) => error?.code === 'EIO',
    );
    const canonical = path.join(root, 'agent_alias-1.lease.json');
    assert.equal(fs.existsSync(canonical), false);
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.publication-')), true);

    const recovered = acquireProviderHomeLease(leaseInput(root), leaseDeps());
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(recovered.leasePath, 'utf8')));
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.publication-')), false);
    assert.equal(releaseProviderHomeLease(recovered), true);
});

test('HOME lease returns committed ownership when publication-artifact cleanup fails', (t) => {
    const root = leaseRoot(t);
    let crashed = false;
    const crashingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'unlinkSync') {
                return (targetPath) => {
                    if (!crashed && targetPath.includes('.publication-')) {
                        crashed = true;
                        throw new Error('simulated publisher crash after link');
                    }
                    return target.unlinkSync(targetPath);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const committed = acquireProviderHomeLease(leaseInput(root), { ...leaseDeps(), fs: crashingFs });
    assert.equal(crashed, true);
    const canonical = path.join(root, 'agent_alias-1.lease.json');
    assert.equal(fs.statSync(canonical).nlink, 2);
    assert.equal(releaseProviderHomeLease(committed), true);
    assert.equal(fs.existsSync(canonical), false);
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.publication-')), false);
});

test('HOME lease returns exact ownership after the committed-publication cleanup fsync fails', (t) => {
    const root = leaseRoot(t);
    const initialized = acquireProviderHomeLease(leaseInput(root), leaseDeps());
    assert.equal(releaseProviderHomeLease(initialized), true);
    const rootIdentity = fs.statSync(root);
    let directoryFsyncs = 0;
    let injected = false;
    const cleanupFsyncFailure = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'fsyncSync') {
                return (descriptor) => {
                    const descriptorStat = target.fstatSync(descriptor);
                    if (descriptorStat.isDirectory()
                        && descriptorStat.dev === rootIdentity.dev
                        && descriptorStat.ino === rootIdentity.ino) {
                        directoryFsyncs += 1;
                        if (directoryFsyncs === 2) {
                            injected = true;
                            const error = new Error('simulated cleanup directory fsync failure');
                            error.code = 'EIO';
                            throw error;
                        }
                    }
                    return target.fsyncSync(descriptor);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const committed = acquireProviderHomeLease(leaseInput(root), {
        ...leaseDeps(),
        fs: cleanupFsyncFailure,
    });
    assert.equal(injected, true);
    assert.equal(directoryFsyncs, 2);
    const canonical = JSON.parse(fs.readFileSync(committed.leasePath, 'utf8'));
    assert.equal(canonical.ownerToken, committed.ownerToken);
    assert.equal(fs.statSync(committed.leasePath).nlink, 1);
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.publication-')), false);
    assert.equal(releaseProviderHomeLease(committed), true);
});

test('HOME lease acquisition recovers a crashed exact-removal operation only after owner death', (t) => {
    const root = leaseRoot(t);
    const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
    const crashingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'unlinkSync') {
                return (targetPath) => {
                    if (targetPath.endsWith('.quarantine')) {
                        throw new Error('simulated releaser crash after primary release');
                    }
                    return target.unlinkSync(targetPath);
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.throws(
        () => releaseProviderHomeLease(first, { ...leaseDeps(), fs: crashingFs }),
        /simulated releaser crash after primary release/,
    );
    assert.equal(fs.existsSync(first.leasePath), false);
    assert.equal(
        fs.readdirSync(root).filter((name) => name.includes('.operation-')).length,
        2,
    );

    assert.throws(
        () => acquireProviderHomeLease(leaseInput(root, { ownerToken: TOKEN_B }), leaseDeps()),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY',
    );
    const recovered = acquireProviderHomeLease(leaseInput(root, {
        ownerPid: 5252,
        ownerToken: TOKEN_B,
        generation: 'generation:2',
    }), leaseDeps((pid) => pid === 5252 ? identified(IDENTITY_B) : { state: 'dead' }));
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.operation-')), false);
    assert.equal(releaseProviderHomeLease(recovered), true);
});

test('malformed, noncanonical, and symlink lease state fails closed without recovery', (t) => {
    const malformedRoot = leaseRoot(t);
    const malformedLease = acquireProviderHomeLease(leaseInput(malformedRoot), leaseDeps());
    assert.equal(releaseProviderHomeLease(malformedLease), true);
    const malformedPath = path.join(malformedRoot, 'agent_alias-1.lease.json');
    fs.writeFileSync(malformedPath, '{"schemaVersion":1}\n', { mode: 0o600 });
    assert.throws(
        () => acquireProviderHomeLease(leaseInput(malformedRoot), leaseDeps()),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
    );
    assert.equal(fs.existsSync(malformedPath), true);

    const symlinkRoot = leaseRoot(t);
    const symlinkLease = acquireProviderHomeLease(leaseInput(symlinkRoot), leaseDeps());
    assert.equal(releaseProviderHomeLease(symlinkLease), true);
    const outside = path.join(symlinkRoot, 'outside');
    fs.writeFileSync(outside, 'do-not-remove', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(symlinkRoot, 'agent_alias-1.lease.json'));
    assert.throws(
        () => acquireProviderHomeLease(leaseInput(symlinkRoot), leaseDeps()),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'do-not-remove');
});

test('HOME lease clean break rejects caller identities, schema v1, and unbootbound schema v2 records', (t) => {
    const inputRoot = leaseRoot(t);
    assert.throws(
        () => acquireProviderHomeLease({
            ...leaseInput(inputRoot),
            ownerStartIdentity: IDENTITY_A,
        }, leaseDeps()),
        /unknown field ownerStartIdentity/,
    );
    assert.equal(fs.existsSync(inputRoot), false);

    const v1Root = leaseRoot(t);
    const v1Lease = acquireProviderHomeLease(leaseInput(v1Root), leaseDeps());
    const v1Record = JSON.parse(fs.readFileSync(v1Lease.leasePath, 'utf8'));
    v1Record.schemaVersion = 1;
    delete v1Record.ownerUid;
    fs.writeFileSync(v1Lease.leasePath, `${JSON.stringify(v1Record)}\n`, { mode: 0o600 });
    assert.throws(
        () => acquireProviderHomeLease(leaseInput(v1Root, { ownerToken: TOKEN_B }), leaseDeps()),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
    );
    assert.equal(JSON.parse(fs.readFileSync(v1Lease.leasePath, 'utf8')).schemaVersion, 1);

    const unboundRoot = leaseRoot(t);
    const unboundLease = acquireProviderHomeLease(leaseInput(unboundRoot), leaseDeps());
    const unboundRecord = JSON.parse(fs.readFileSync(unboundLease.leasePath, 'utf8'));
    unboundRecord.ownerStartIdentity = 'linux-proc:100';
    fs.writeFileSync(unboundLease.leasePath, `${JSON.stringify(unboundRecord)}\n`, { mode: 0o600 });
    assert.throws(
        () => acquireProviderHomeLease(leaseInput(unboundRoot, { ownerToken: TOKEN_B }), leaseDeps()),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
    );
    assert.equal(fs.readFileSync(unboundLease.leasePath, 'utf8').includes('linux-proc:100'), true);
});

test('HOME lease requires a boot-bound same-UID acquisition identity', (t) => {
    for (const state of [
        { state: 'unknown' },
        { state: 'uid-diverged', processUid: CURRENT_UID },
        identified('linux-proc:100'),
        identified(IDENTITY_A, CURRENT_UID + 1),
    ]) {
        const root = leaseRoot(t);
        assert.throws(
            () => acquireProviderHomeLease(leaseInput(root), leaseDeps(state)),
            (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
        );
        assert.equal(fs.existsSync(root), false);
    }
});

test('different HOME keys proceed independently and callback release runs on failure', async (t) => {
    const root = leaseRoot(t);
    const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
    const second = acquireProviderHomeLease(leaseInput(root, {
        homeKey: 'agent_alias-2',
        ownerToken: TOKEN_B,
    }), leaseDeps());
    assert.notEqual(first.leasePath, second.leasePath);
    releaseProviderHomeLease(first);
    releaseProviderHomeLease(second);

    const callbackInput = leaseInput(root, { homeKey: 'callback-agent' });
    await assert.rejects(
        () => withProviderHomeLease(callbackInput, async (lease) => {
            assert.equal(fs.existsSync(lease.leasePath), true);
            throw new Error('callback failed');
        }, leaseDeps()),
        /callback failed/,
    );
    assert.equal(fs.existsSync(path.join(root, 'callback-agent.lease.json')), false);
});

test('provider task policy derives HOME and generation only from the bwrap credential context and orders isolation mounts', (t) => {
    const policy = buildProviderSandboxPolicy(providerTaskInput({
        environment: {
            PLOINKY_TASK_BROKER_URL: PROVIDER_BROKER_URL,
            PLOINKY_TASK_BROKER_KEY: PROVIDER_BROKER_KEY,
            LANG: 'C.UTF-8',
        },
    }));

    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.records), true);
    assert.deepEqual(policy.identity, {
        runtimeKey: PROVIDER_INSTANCE,
        generation: PROVIDER_GENERATION,
    });
    assert.equal(policy.cwd, '/workspace/projects/alpha');
    assert.equal(policy.env.HOME, '/home/agent');
    assert.equal(policy.env.PWD, policy.cwd);
    assert.equal(policy.env.PATH, '/home/agent/.opencode/bin:/opt/ploinky-node/bin:/usr/bin:/bin');

    const workspace = recordIndex(policy.records, (record) => record.type === 'WORKSPACE');
    const ploinkyMask = recordIndex(policy.records, (record) => (
        record.type === 'TMPFS' && record.target === '/workspace/.ploinky'
    ));
    const dataMask = recordIndex(policy.records, (record) => (
        record.type === 'TMPFS' && record.target === '/workspace/.data'
    ));
    const workdir = recordIndex(policy.records, (record) => record.type === 'WORKDIR');
    const home = recordIndex(policy.records, (record) => record.type === 'HOME');
    const executable = recordIndex(policy.records, (record) => (
        record.type === 'RO_PATH' && record.target === '/home/agent/.opencode/bin/opencode'
    ));
    const privateProc = recordIndex(policy.records, (record) => record.type === 'PROC');
    const clearenv = recordIndex(policy.records, (record) => record.type === 'ARG' && record.value === '--clearenv');

    assert.equal(policy.records[workspace].mode, 'ro');
    assert.deepEqual(policy.records[workdir], { type: 'WORKDIR', path: 'projects/alpha' });
    assert.deepEqual(policy.records[home], { type: 'HOME', runtimeKey: PROVIDER_INSTANCE });
    assert.ok(workspace < ploinkyMask && ploinkyMask < dataMask && dataMask < workdir);
    assert.ok(workdir < home && home < executable && executable < privateProc && privateProc < clearenv);
    assert.equal(policy.records.filter((record) => record.type === 'WORKSPACE').length, 1);
    assert.equal(policy.records.filter((record) => record.type === 'WORKDIR').length, 1);
    assert.equal(policy.records.filter((record) => record.type === 'HOME').length, 1);
    assert.equal(policy.records.some((record) => record.type === 'TMPFS' && record.target === '/workspace'), false);
    assert.doesNotThrow(() => parseDescriptor(encodeBwrapLaunchDescriptor(policy.records)));

    const serialized = JSON.stringify(policy);
    for (const secret of ['a'.repeat(64), 'b'.repeat(64), `${PROVIDER_PRINCIPAL}|fixture-signature`]) {
        assert.equal(serialized.includes(secret), false);
    }
    assert.throws(
        () => buildProviderSandboxPolicy(providerTaskInput({
            credentialContext: {
                runtime: { runtimeKey: 'attacker-home' },
                identity: { enableGeneration: 'attacker-generation' },
                assertActive() {},
            },
        })),
        (error) => error?.code === 'PLOINKY_AGENT_CREDENTIAL_CONTEXT_REQUIRED',
    );
    assert.throws(
        () => buildProviderSandboxPolicy(providerTaskInput({
            credentialContext: containerCredentialContext(t),
        })),
        (error) => error?.code === 'PLOINKY_PROVIDER_CONTEXT_INVALID',
    );
});

test('provider readiness uses an empty private workspace, fixed harmless command, and no task capability', () => {
    const policy = buildProviderSandboxPolicy({
        mode: PROVIDER_SANDBOX_MODES.READINESS,
        provider: PROVIDER_SANDBOX_PROVIDERS.PI,
        credentialContext: providerCredentialContext(),
    });

    const workspaceMask = recordIndex(policy.records, (record) => (
        record.type === 'TMPFS' && record.target === '/workspace'
    ));
    const readinessDir = recordIndex(policy.records, (record) => (
        record.type === 'DIR' && record.target === '/workspace/readiness'
    ));
    const home = recordIndex(policy.records, (record) => record.type === 'HOME');
    const privateProc = recordIndex(policy.records, (record) => record.type === 'PROC');
    assert.ok(workspaceMask < readinessDir && readinessDir < home && home < privateProc);
    assert.equal(policy.records.some((record) => record.type === 'WORKSPACE'), false);
    assert.equal(policy.records.some((record) => record.type === 'WORKDIR'), false);
    assert.equal(policy.records.some((record) => record.target === '/workspace/.ploinky'), false);
    assert.equal(policy.records.some((record) => record.target === '/workspace/.data'), false);
    assert.equal(policy.cwd, '/workspace/readiness');
    assert.equal(policy.workdir, null);
    assert.equal(policy.env.PLOINKY_TASK_BROKER_URL, undefined);
    assert.equal(policy.env.PLOINKY_TASK_BROKER_KEY, undefined);
    assert.deepEqual(policy.command, ['/home/agent/.local/bin/pi', '--version']);
    assert.equal(JSON.stringify(policy.records).includes('/bin/sh'), false);

    assert.throws(
        () => buildProviderSandboxPolicy({
            mode: PROVIDER_SANDBOX_MODES.READINESS,
            provider: PROVIDER_SANDBOX_PROVIDERS.PI,
            credentialContext: providerCredentialContext(),
            workdir: 'real-project',
        }),
        (error) => error?.code === 'PLOINKY_WORKDIR_INVALID',
    );
    assert.throws(
        () => buildProviderSandboxPolicy({
            mode: PROVIDER_SANDBOX_MODES.READINESS,
            provider: PROVIDER_SANDBOX_PROVIDERS.PI,
            credentialContext: providerCredentialContext(),
            command: ['/bin/sh', '-c', 'touch /workspace/real-project'],
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_READINESS_INVALID',
    );
    assert.throws(
        () => buildProviderSandboxPolicy({
            mode: PROVIDER_SANDBOX_MODES.READINESS,
            provider: PROVIDER_SANDBOX_PROVIDERS.PI,
            credentialContext: providerCredentialContext(),
            environment: {
                PLOINKY_TASK_BROKER_URL: PROVIDER_BROKER_URL,
                PLOINKY_TASK_BROKER_KEY: PROVIDER_BROKER_KEY,
            },
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_READINESS_INVALID',
    );
});

test('provider workdir validation rejects roots and protected state while reconstructing only managed-repo parents', () => {
    for (const [workdir, code] of [
        ['/workspace', 'PLOINKY_WORKDIR_ROOT_FORBIDDEN'],
        ['', 'PLOINKY_WORKDIR_ROOT_FORBIDDEN'],
        ['.', 'PLOINKY_WORKDIR_ROOT_FORBIDDEN'],
        ['/', 'PLOINKY_WORKDIR_INVALID'],
        ['/tmp/project', 'PLOINKY_WORKDIR_INVALID'],
        ['.data/provider', 'PLOINKY_WORKDIR_INVALID'],
        ['.ploinky', 'PLOINKY_WORKDIR_INVALID'],
        ['.ploinky/run/provider', 'PLOINKY_WORKDIR_INVALID'],
        ['.ploinky/repos', 'PLOINKY_WORKDIR_INVALID'],
        ['project/../secret', 'PLOINKY_PATH_INVALID'],
        ['project//secret', 'PLOINKY_PATH_INVALID'],
        ['project/', 'PLOINKY_PATH_INVALID'],
        ['project\0secret', 'PLOINKY_WORKDIR_INVALID'],
    ]) {
        assert.throws(
            () => buildProviderSandboxPolicy(providerTaskInput({ workdir })),
            (error) => error?.code === code,
            workdir,
        );
    }

    const managed = buildProviderSandboxPolicy(providerTaskInput({
        workdir: '/workspace/.ploinky/repos/AchillesCLI/packages/agent one',
    }));
    assert.equal(managed.workdir, '.ploinky/repos/AchillesCLI/packages/agent one');
    assert.deepEqual(
        managed.records
            .filter((record) => record.type === 'DIR' && record.target.startsWith('/workspace/.ploinky'))
            .map((record) => record.target),
        [
            '/workspace/.ploinky/repos',
            '/workspace/.ploinky/repos/AchillesCLI',
            '/workspace/.ploinky/repos/AchillesCLI/packages',
        ],
    );
    assert.deepEqual(
        managed.records.find((record) => record.type === 'WORKDIR'),
        { type: 'WORKDIR', path: '.ploinky/repos/AchillesCLI/packages/agent one' },
    );
});

test('provider profiles pin immutable executable roots and refuse caller-selected paths', () => {
    const profiles = [
        {
            provider: PROVIDER_SANDBOX_PROVIDERS.OPENCODE,
            executable: '/home/agent/.opencode/bin/opencode',
            roots: ['/home/agent/.opencode/bin/opencode'],
        },
        {
            provider: PROVIDER_SANDBOX_PROVIDERS.PI,
            executable: '/home/agent/.local/bin/pi',
            roots: [
                '/home/agent/.local/bin/pi',
                '/home/agent/.local/lib/node_modules/@earendil-works/pi-coding-agent',
            ],
        },
        {
            provider: PROVIDER_SANDBOX_PROVIDERS.CODEX,
            executable: '/home/agent/.local/bin/codex',
            roots: [
                '/home/agent/.local/bin/codex',
                '/home/agent/.local/lib/node_modules/@openai/codex',
            ],
        },
    ];
    for (const { provider, executable, roots } of profiles) {
        const policy = buildProviderSandboxPolicy(providerTaskInput({
            provider,
            command: [executable, '--help'],
        }));
        assert.deepEqual(policy.command, [executable, '--help']);
        assert.deepEqual(
            policy.records
                .filter((record) => record.type === 'RO_PATH' && record.target.startsWith('/home/agent/'))
                .map((record) => record.target),
            roots,
        );
        assert.throws(
            () => buildProviderSandboxPolicy(providerTaskInput({
                provider,
                command: ['/workspace/attacker-provider', '--help'],
            })),
            (error) => error?.code === 'PLOINKY_PROVIDER_COMMAND_INVALID',
        );
    }
    assert.throws(
        () => buildProviderSandboxPolicy({ ...providerTaskInput(), immutableRoots: ['/workspace'] }),
        /unknown field immutableRoots/,
    );
    assert.throws(
        () => buildProviderSandboxPolicy({ ...providerTaskInput(), helper: '/usr/bin/bwrap' }),
        /unknown field helper/,
    );
});

test('provider environment is scoped-broker-only, clearenv-based, and rejects inherited credential canaries', () => {
    const policy = buildProviderSandboxPolicy(providerTaskInput({
        environment: {
            PLOINKY_TASK_BROKER_URL: PROVIDER_BROKER_URL,
            PLOINKY_TASK_BROKER_KEY: PROVIDER_BROKER_KEY,
            PLOINKY_PROVIDER_MODEL: 'provider/model',
            PLOINKY_PROVIDER_TASK_ID: 'task-1',
            TERM: 'xterm-256color',
        },
    }));
    assert.equal(policy.env.PLOINKY_TASK_BROKER_URL, PROVIDER_BROKER_URL);
    assert.equal(policy.env.PLOINKY_TASK_BROKER_KEY, PROVIDER_BROKER_KEY);
    assert.equal(policy.env.PLOINKY_AGENT_SECRET, undefined);
    assert.equal(policy.env.PLOINKY_AGENT_CREDENTIAL_FILE, undefined);
    assert.equal(policy.env.OPENAI_API_KEY, undefined);
    assert.equal(
        policy.records.some((record) => record.type === 'ARG' && record.value === '--clearenv'),
        true,
    );

    for (const environment of [
        {},
        { PLOINKY_TASK_BROKER_URL: PROVIDER_BROKER_URL },
        { PLOINKY_TASK_BROKER_KEY: PROVIDER_BROKER_KEY },
    ]) {
        assert.throws(
            () => buildProviderSandboxPolicy(providerTaskInput({ environment })),
            (error) => error?.code === 'PLOINKY_PROVIDER_BROKER_REQUIRED',
        );
    }
    for (const url of [
        'https://127.0.0.1:43123/v1',
        'http://localhost:43123/v1',
        'http://0.0.0.0:43123/v1',
        'http://127.0.0.1:43123/',
        'http://127.0.0.1:43123/v1?secret=x',
        'http://user@127.0.0.1:43123/v1',
    ]) {
        assert.throws(
            () => buildProviderSandboxPolicy(providerTaskInput({
                environment: {
                    PLOINKY_TASK_BROKER_URL: url,
                    PLOINKY_TASK_BROKER_KEY: PROVIDER_BROKER_KEY,
                },
            })),
            (error) => error?.code === 'PLOINKY_PROVIDER_BROKER_INVALID',
            url,
        );
    }
    for (const name of [
        'PLOINKY_AGENT_SECRET',
        'PLOINKY_ROUTER_URL',
        'PLOINKY_MASTER_KEY',
        'PLOINKY_AGENT_CREDENTIAL_FILE',
        'OPENAI_API_KEY',
        'AWS_SECRET_ACCESS_KEY',
        'NODE_OPTIONS',
        'HOME',
        'PATH',
        'PROVIDER_SANDBOX_TEST_CANARY',
    ]) {
        assert.throws(
            () => buildProviderSandboxPolicy(providerTaskInput({
                environment: {
                    PLOINKY_TASK_BROKER_URL: PROVIDER_BROKER_URL,
                    PLOINKY_TASK_BROKER_KEY: PROVIDER_BROKER_KEY,
                    [name]: 'inherited-canary',
                },
            })),
            (error) => error?.code === 'PLOINKY_PROVIDER_ENV_INVALID'
                && error.message.includes(name)
                && !error.message.includes('inherited-canary'),
            name,
        );
    }
});

test('provider launch is a fixed helper with an fd3 descriptor and no path fallback', () => {
    const launch = buildProviderSandboxLaunch({
        ...providerTaskInput(),
        preexecBarrier: { readyFd: 4, releaseFd: 5 },
    });
    assert.equal(Object.isFrozen(launch), true);
    assert.equal(launch.helper, PROVIDER_SANDBOX_HELPER);
    assert.equal(launch.helper, '/usr/local/libexec/ploinky-bwrap-launch');
    assert.deepEqual(launch.args, []);
    assert.deepEqual(launch.descriptor, encodeBwrapLaunchDescriptor(launch.records));
    assert.equal(launch.descriptor.includes(Buffer.from('/usr/bin/bwrap')), false);
    const records = parseDescriptor(launch.descriptor);
    assert.equal(records.filter((record) => record.type === BWRAP_RECORD_TYPES.PREEXEC_BARRIER).length, 1);
    const barrier = records.find((record) => record.type === BWRAP_RECORD_TYPES.PREEXEC_BARRIER);
    assert.equal(barrier.payload.readUInt32BE(0), 4);
    assert.equal(barrier.payload.readUInt32BE(4), 5);
});

test('provider spawn writes fd3 before R, acquires lease and capability before G, then cleans both on close', async () => {
    const events = [];
    const descriptorChunks = [];
    const releaseChunks = [];
    const readyStream = new PassThrough();
    const descriptorStream = new Writable({
        write(chunk, _encoding, callback) {
            descriptorChunks.push(Buffer.from(chunk));
            callback();
        },
        final(callback) {
            events.push('fd3:descriptor');
            callback();
            queueMicrotask(() => {
                events.push('fd4:R');
                readyStream.end(Buffer.from('R'));
            });
        },
    });
    const releaseStream = new Writable({
        write(chunk, _encoding, callback) {
            releaseChunks.push(Buffer.from(chunk));
            callback();
        },
        final(callback) {
            events.push('fd5:G');
            callback();
        },
    });
    const child = Object.assign(new EventEmitter(), {
        pid: 62001,
        exitCode: null,
        signalCode: null,
        stdio: [null, null, null, descriptorStream, readyStream, releaseStream],
        kill() { events.push('kill'); },
    });
    const lease = Object.freeze({ id: 'exact-provider-home-lease' });
    let spawnedOptions;
    let childClosed = false;

    const running = await spawnProviderSandbox(providerTaskInput(), {
        stdio: ['ignore', 'pipe', 'pipe'],
        leaseRoot: '/workspace/.ploinky/run/provider-home-leases',
        leaseMetadata: { taskId: 'task-1' },
        async activateCapability(details) {
            events.push('capability:activate');
            assert.equal(details.childPid, child.pid);
            assert.equal(details.provider, PROVIDER_SANDBOX_PROVIDERS.OPENCODE);
            assert.equal(details.mode, PROVIDER_SANDBOX_MODES.TASK);
            assert.equal(details.workdir, 'projects/alpha');
            assert.deepEqual(details.identity, {
                runtimeKey: PROVIDER_INSTANCE,
                generation: PROVIDER_GENERATION,
            });
        },
        async deactivateCapability() {
            events.push('capability:deactivate');
        },
        async afterExit(details) {
            events.push('after-exit');
            assert.equal(details.code, 0);
            assert.equal(details.signal, null);
            assert.equal(details.child, child);
            assert.equal(details.launch.provider, 'opencode');
            return { sessionId: 'session-under-home-lease' };
        },
    }, {
        spawn(helper, args, options) {
            events.push('spawn');
            assert.equal(helper, PROVIDER_SANDBOX_HELPER);
            assert.deepEqual(args, []);
            spawnedOptions = options;
            return child;
        },
        acquireProviderHomeLease(input) {
            events.push('lease:acquire');
            assert.deepEqual(input, {
                homeKey: PROVIDER_INSTANCE,
                generation: PROVIDER_GENERATION,
                role: 'provider-task',
                metadata: {
                    mode: 'task',
                    provider: 'opencode',
                    taskId: 'task-1',
                    workdir: 'projects/alpha',
                },
                leaseRoot: '/workspace/.ploinky/run/provider-home-leases',
                ownerPid: child.pid,
            });
            return lease;
        },
        releaseProviderHomeLease(received) {
            events.push('lease:release');
            assert.equal(received, lease);
            return true;
        },
        inspectProcessIdentity() {
            return childClosed ? { state: 'dead' } : identified(IDENTITY_A);
        },
        getUid: () => CURRENT_UID,
    });

    assert.deepEqual(spawnedOptions, {
        cwd: '/',
        env: {},
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    assert.deepEqual(events, [
        'spawn',
        'fd3:descriptor',
        'fd4:R',
        'lease:acquire',
        'capability:activate',
        'fd5:G',
    ]);
    assert.equal(Buffer.concat(releaseChunks).toString('ascii'), 'G');
    const descriptor = Buffer.concat(descriptorChunks);
    assert.deepEqual(descriptor, running.launch.descriptor);
    assert.equal(parseDescriptor(descriptor).some((record) => (
        record.type === BWRAP_RECORD_TYPES.PREEXEC_BARRIER
        && record.payload.readUInt32BE(0) === 4
        && record.payload.readUInt32BE(4) === 5
    )), true);

    child.exitCode = 0;
    childClosed = true;
    child.emit('close', 0, null);
    assert.deepEqual(await running.completion, {
        code: 0,
        signal: null,
        afterExit: { sessionId: 'session-under-home-lease' },
    });
    assert.deepEqual(events.slice(-3), [
        'capability:deactivate',
        'after-exit',
        'lease:release',
    ]);
    assert.equal(events.includes('kill'), false);
});

test('provider spawn retries delayed boot-bound identity capture before publishing ownership', async () => {
    const readyStream = new PassThrough();
    const descriptorStream = new Writable({
        write(_chunk, _encoding, callback) { callback(); },
        final(callback) {
            callback();
            queueMicrotask(() => readyStream.end(Buffer.from('R')));
        },
    });
    const releaseStream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const child = Object.assign(new EventEmitter(), {
        pid: 63001,
        exitCode: null,
        signalCode: null,
        stdio: [null, null, null, descriptorStream, readyStream, releaseStream],
    });
    let inspections = 0;
    let closed = false;
    const lease = Object.freeze({ id: 'delayed-identity-lease' });
    const handle = await spawnProviderSandbox(providerTaskInput(), {}, {
        spawn: () => child,
        inspectProcessIdentity() {
            inspections += 1;
            if (closed) return { state: 'dead' };
            return inspections < 3 ? { state: 'unknown' } : identified(IDENTITY_A);
        },
        getUid: () => CURRENT_UID,
        identityCaptureAttempts: 4,
        identityCaptureRetryMs: 1,
        acquireProviderHomeLease: () => lease,
        releaseProviderHomeLease: () => true,
    });
    assert.equal(inspections >= 3, true);
    assert.equal(handle.ownership.processIdentity, IDENTITY_A);
    closed = true;
    child.exitCode = 0;
    child.emit('close', 0, null);
    assert.deepEqual(await handle.completion, { code: 0, signal: null });
});

test('unverified identity capture returns a durable retained handle and never signals an unknown PID', async () => {
    const child = Object.assign(new EventEmitter(), {
        pid: 63501,
        exitCode: null,
        signalCode: null,
        stdio: [null, null, null, new PassThrough(), new PassThrough(), new PassThrough()],
    });
    const signals = [];
    await assert.rejects(
        spawnProviderSandbox(providerTaskInput(), {}, {
            spawn: () => child,
            inspectProcessIdentity: () => ({ state: 'unknown' }),
            getUid: () => CURRENT_UID,
            identityCaptureAttempts: 2,
            identityCaptureRetryMs: 1,
            killGraceMs: 1,
            signalProcessGroup: (_pid, signal) => signals.push(signal),
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_PROCESS_IDENTITY_UNVERIFIED'
            && error.ownershipRetained === true
            && error.retainedProcess?.pid === child.pid
            && error.retainedProcess?.child === child
            && error.evidence?.terminalObserved === false
            && error.evidence?.transportClosed === true,
    );
    assert.deepEqual(signals, []);
});

test('EPIPE after ownership activation retains HOME and capability when exact termination is unproven', async () => {
    const events = [];
    const readyStream = new PassThrough();
    const descriptorStream = new Writable({
        write(_chunk, _encoding, callback) { callback(); },
        final(callback) {
            callback();
            queueMicrotask(() => readyStream.end(Buffer.from('R')));
        },
    });
    const releaseStream = new Writable({
        write(_chunk, _encoding, callback) { callback(); },
        final(callback) {
            const error = new Error('simulated release EPIPE');
            error.code = 'EPIPE';
            callback(error);
        },
    });
    const child = Object.assign(new EventEmitter(), {
        pid: 64001,
        exitCode: null,
        signalCode: null,
        stdio: [null, null, null, descriptorStream, readyStream, releaseStream],
    });
    const lease = Object.freeze({ id: 'retained-lease' });

    await assert.rejects(
        spawnProviderSandbox(providerTaskInput(), {
            activateCapability() { events.push('capability:activate'); },
            deactivateCapability() { events.push('capability:deactivate'); },
        }, {
            spawn: () => child,
            inspectProcessIdentity: () => identified(IDENTITY_A),
            getUid: () => CURRENT_UID,
            termGraceMs: 1,
            killGraceMs: 1,
            signalProcessGroup(_pid, signal) {
                events.push(signal);
                if (signal === 'SIGKILL') {
                    const error = new Error('simulated kill failure');
                    error.code = 'EIO';
                    throw error;
                }
            },
            acquireProviderHomeLease() { events.push('lease:acquire'); return lease; },
            releaseProviderHomeLease() { events.push('lease:release'); return true; },
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_TERMINATION_UNPROVEN'
            && error.ownershipRetained === true
            && error.cause?.code === 'PLOINKY_PROVIDER_PREEXEC_BARRIER_FAILED'
            && error.evidence?.phase === 'kill',
    );
    assert.deepEqual(events, [
        'lease:acquire',
        'capability:activate',
        'SIGTERM',
        'SIGKILL',
    ]);
});

test('readiness timeout reports only after TERM reverify KILL, terminal close, and lease cleanup', async () => {
    const events = [];
    const readyStream = new PassThrough();
    const descriptorStream = new Writable({
        write(_chunk, _encoding, callback) { callback(); },
        final(callback) {
            callback();
            queueMicrotask(() => readyStream.end(Buffer.from('R')));
        },
    });
    const releaseStream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    let dead = false;
    const child = Object.assign(new EventEmitter(), {
        pid: 65001,
        exitCode: null,
        signalCode: null,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdio: [null, new PassThrough(), new PassThrough(), descriptorStream, readyStream, releaseStream],
    });
    child.stdout = child.stdio[1];
    child.stderr = child.stdio[2];
    const lease = Object.freeze({ id: 'readiness-timeout-lease' });

    await assert.rejects(
        runProviderSandboxReadiness({
            provider: PROVIDER_SANDBOX_PROVIDERS.OPENCODE,
            credentialContext: providerCredentialContext(),
            timeoutMs: 5,
            dependencyOverrides: {
                spawn: () => child,
                inspectProcessIdentity: () => dead ? { state: 'dead' } : identified(IDENTITY_A),
                getUid: () => CURRENT_UID,
                termGraceMs: 1,
                killGraceMs: 20,
                signalProcessGroup(_pid, signal) {
                    events.push(signal);
                    if (signal === 'SIGKILL') {
                        dead = true;
                        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
                    }
                },
                acquireProviderHomeLease() { events.push('lease:acquire'); return lease; },
                releaseProviderHomeLease() { events.push('lease:release'); return true; },
            },
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_READINESS_TIMEOUT'
            && Array.isArray(error.terminationEvidence),
    );
    assert.deepEqual(events, ['lease:acquire', 'SIGTERM', 'SIGKILL', 'lease:release']);
});

test('readiness deadline covers a helper that never sends retained-fd readiness', async () => {
    const events = [];
    const readyStream = new PassThrough();
    const descriptorStream = new Writable({
        write(_chunk, _encoding, callback) { callback(); },
    });
    const releaseStream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    let dead = false;
    const child = Object.assign(new EventEmitter(), {
        pid: 65101,
        exitCode: null,
        signalCode: null,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdio: [null, new PassThrough(), new PassThrough(), descriptorStream, readyStream, releaseStream],
    });
    child.stdout = child.stdio[1];
    child.stderr = child.stdio[2];

    await assert.rejects(
        runProviderSandboxReadiness({
            provider: PROVIDER_SANDBOX_PROVIDERS.OPENCODE,
            credentialContext: providerCredentialContext(),
            timeoutMs: 5,
            dependencyOverrides: {
                spawn: () => child,
                inspectProcessIdentity: () => dead ? { state: 'dead' } : identified(IDENTITY_A),
                getUid: () => CURRENT_UID,
                termGraceMs: 1,
                killGraceMs: 20,
                signalProcessGroup(_pid, signal) {
                    events.push(signal);
                    if (signal === 'SIGKILL') {
                        dead = true;
                        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
                    }
                },
                acquireProviderHomeLease() {
                    events.push('lease:acquire');
                    return Object.freeze({ id: 'must-not-acquire' });
                },
            },
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_READINESS_TIMEOUT'
            && Array.isArray(error.terminationEvidence),
    );
    assert.deepEqual(events, ['SIGTERM', 'SIGKILL']);
});

test('retained-fd readiness close without end is typed and exactly cleaned', async () => {
    const events = [];
    const readyStream = new PassThrough();
    const descriptorStream = new Writable({
        write(_chunk, _encoding, callback) { callback(); },
        final(callback) {
            callback();
            queueMicrotask(() => readyStream.destroy());
        },
    });
    const releaseStream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    let dead = false;
    const child = Object.assign(new EventEmitter(), {
        pid: 65201,
        exitCode: null,
        signalCode: null,
        stdio: [null, new PassThrough(), new PassThrough(), descriptorStream, readyStream, releaseStream],
    });

    await assert.rejects(
        runProviderSandboxReadiness({
            provider: PROVIDER_SANDBOX_PROVIDERS.OPENCODE,
            credentialContext: providerCredentialContext(),
            timeoutMs: 100,
            dependencyOverrides: {
                spawn: () => child,
                inspectProcessIdentity: () => dead ? { state: 'dead' } : identified(IDENTITY_A),
                getUid: () => CURRENT_UID,
                termGraceMs: 20,
                killGraceMs: 20,
                signalProcessGroup(_pid, signal) {
                    events.push(signal);
                    if (signal === 'SIGTERM') {
                        dead = true;
                        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
                    }
                },
                acquireProviderHomeLease() {
                    events.push('lease:acquire');
                    return Object.freeze({ id: 'must-not-acquire' });
                },
            },
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_PREEXEC_BARRIER_FAILED'
            && Array.isArray(error.terminationEvidence),
    );
    assert.deepEqual(events, ['SIGTERM']);
});

test('readiness timeout retains its live lease when exact cleanup cannot be proven', async () => {
    const events = [];
    const readyStream = new PassThrough();
    const descriptorStream = new Writable({
        write(_chunk, _encoding, callback) { callback(); },
        final(callback) {
            callback();
            queueMicrotask(() => readyStream.end(Buffer.from('R')));
        },
    });
    const releaseStream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const child = Object.assign(new EventEmitter(), {
        pid: 65301,
        exitCode: null,
        signalCode: null,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdio: [null, new PassThrough(), new PassThrough(), descriptorStream, readyStream, releaseStream],
    });
    child.stdout = child.stdio[1];
    child.stderr = child.stdio[2];
    const lease = Object.freeze({ id: 'retained-readiness-lease' });

    await assert.rejects(
        runProviderSandboxReadiness({
            provider: PROVIDER_SANDBOX_PROVIDERS.OPENCODE,
            credentialContext: providerCredentialContext(),
            timeoutMs: 5,
            dependencyOverrides: {
                spawn: () => child,
                inspectProcessIdentity: () => identified(IDENTITY_A),
                getUid: () => CURRENT_UID,
                termGraceMs: 1,
                killGraceMs: 1,
                signalProcessGroup(_pid, signal) {
                    events.push(signal);
                    if (signal === 'SIGKILL') {
                        const error = new Error('simulated readiness kill failure');
                        error.code = 'EIO';
                        throw error;
                    }
                },
                acquireProviderHomeLease() {
                    events.push('lease:acquire');
                    return lease;
                },
                releaseProviderHomeLease() {
                    events.push('lease:release');
                    return true;
                },
            },
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_TERMINATION_UNPROVEN'
            && error.ownershipRetained === true
            && error.evidence?.phase === 'kill',
    );
    assert.deepEqual(events, ['lease:acquire', 'SIGTERM', 'SIGKILL']);
});
