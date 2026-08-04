import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    BWRAP_LAUNCH_LIMITS,
    BWRAP_RECORD_TYPES,
    TRUSTED_SERVICE_ENV,
    acquireProviderHomeLease,
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
    withProviderHomeLease,
} from '../../Agent/lib/providerSandbox.mjs';

const TOKEN_A = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);
const FIXED_NOW = Date.parse('2026-08-04T12:00:00.000Z');

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

function basePolicy(overrides = {}) {
    return buildTrustedServicePolicy({
        runtimeKey: 'coding-agent_alias-1',
        command: ['node', '/Agent/server/AgentServer.mjs'],
        nodeRuntimePath: '/usr/local',
        agentRuntimePath: '/opt/ploinky/Agent',
        codePath: '/workspace/.ploinky/deps/coding-agent/code',
        codeDependenciesPath: '/workspace/.ploinky/deps/coding-agent/code-node-modules',
        agentDependenciesPath: '/opt/ploinky/node_modules',
        ...overrides,
    });
}

function leaseRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-home-lease-'));
    fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
        ownerStartIdentity: 'linux-proc:boot:100',
        ownerToken: TOKEN_A,
        ...overrides,
    };
}

function leaseDeps(state = { state: 'live', startIdentity: 'linux-proc:boot:100' }) {
    return {
        inspectProcessIdentity: () => state,
        randomBytes: () => Buffer.alloc(32, 1),
        now: () => FIXED_NOW,
    };
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
    const policy = basePolicy({
        environment: {
            PORT: '7000',
            PLOINKY_AGENT_PRINCIPAL: 'agent:alias-1:generation-1',
        },
    });
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.records), true);
    assert.equal(Object.isFrozen(policy.env), true);
    assert.equal(policy.env.HOME, '/home/agent');
    assert.equal(policy.env.XDG_CACHE_HOME, '/tmp/cache');
    assert.equal(policy.env.PATH, '/opt/ploinky-node/bin:/usr/bin:/bin');
    assert.equal(policy.env.PATH.includes('/home/agent'), false);
    assert.equal(policy.env.PORT, '7000');

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

test('trusted service dynamic env is deterministic, bounded, and cannot weaken fixed values or mounts', () => {
    const left = basePolicy({ environment: { Z_VALUE: 'last', A_VALUE: 'first' } });
    const right = basePolicy({ environment: { A_VALUE: 'first', Z_VALUE: 'last' } });
    assert.deepEqual(encodeBwrapLaunchDescriptor(left.records), encodeBwrapLaunchDescriptor(right.records));
    assert.deepEqual(left.env, { ...TRUSTED_SERVICE_ENV, A_VALUE: 'first', Z_VALUE: 'last' });
    assert.doesNotThrow(() => basePolicy({ environment: { HOME: TRUSTED_SERVICE_ENV.HOME } }));
    assert.throws(() => basePolicy({ environment: { HOME: '/root' } }), /cannot override HOME/);
    assert.throws(() => basePolicy({ environment: { 'BAD-NAME': 'x' } }), /name BAD-NAME is invalid/);
    assert.throws(() => basePolicy({ environment: { PORT: 7000 } }), /must be a string/);
    assert.throws(() => basePolicy({ environment: { PLOINKY_MASTER_KEY: 'must-not-cross' } }), /is forbidden/);
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
        'ownerStartIdentity', 'ownerToken', 'role', 'schemaVersion',
    ]);
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
            ownerStartIdentity: 'linux-proc:boot:200',
            ownerToken: TOKEN_B,
            generation: 'generation:2',
        }),
        leaseDeps({ state: 'dead' }),
    );
    assert.equal(afterDeath.recoveredStaleOwner.reason, 'dead');
    assert.equal(afterDeath.recoveredStaleOwner.ownerPid, deadOwner.ownerPid);
    releaseProviderHomeLease(afterDeath);

    const reusedRoot = leaseRoot(t);
    acquireProviderHomeLease(leaseInput(reusedRoot), leaseDeps());
    const afterReuse = acquireProviderHomeLease(
        leaseInput(reusedRoot, {
            ownerPid: 5252,
            ownerStartIdentity: 'linux-proc:boot:200',
            ownerToken: TOKEN_B,
        }),
        leaseDeps({ state: 'live', startIdentity: 'linux-proc:boot:999' }),
    );
    assert.equal(afterReuse.recoveredStaleOwner.reason, 'pid-reused');
    releaseProviderHomeLease(afterReuse);

    const unknownRoot = leaseRoot(t);
    const unknown = acquireProviderHomeLease(leaseInput(unknownRoot), leaseDeps());
    assert.throws(
        () => acquireProviderHomeLease(leaseInput(unknownRoot, { ownerToken: TOKEN_B }), leaseDeps({ state: 'unknown' })),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY' && error.owner?.uncertain === true,
    );
    releaseProviderHomeLease(unknown);

    const unprovedRoot = leaseRoot(t);
    const unproved = acquireProviderHomeLease(leaseInput(unprovedRoot), leaseDeps());
    assert.throws(
        () => acquireProviderHomeLease(leaseInput(unprovedRoot, { ownerToken: TOKEN_B }), leaseDeps({ state: 'live', startIdentity: '' })),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_BUSY' && error.owner?.uncertain === true,
    );
    releaseProviderHomeLease(unproved);
});

test('HOME lease exact removal never unlinks a successor at the primary path', (t) => {
    const root = leaseRoot(t);
    const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
    const successorRecord = {
        ...JSON.parse(fs.readFileSync(first.leasePath, 'utf8')),
        generation: 'generation:2',
        ownerPid: 5252,
        ownerStartIdentity: 'linux-proc:boot:200',
        ownerToken: TOKEN_B,
    };
    const successorRaw = `${JSON.stringify(successorRecord)}\n`;
    let successorPublished = false;
    const racingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'renameSync') {
                return (source, destination) => {
                    target.renameSync(source, destination);
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

test('HOME lease acquisition recovers a crashed exact-removal operation only after owner death', (t) => {
    const root = leaseRoot(t);
    const first = acquireProviderHomeLease(leaseInput(root), leaseDeps());
    const crashingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'renameSync') {
                return (source, destination) => {
                    target.renameSync(source, destination);
                    throw new Error('simulated releaser crash after atomic rename');
                };
            }
            return Reflect.get(target, property, receiver);
        },
    });
    assert.throws(
        () => releaseProviderHomeLease(first, { ...leaseDeps(), fs: crashingFs }),
        /simulated releaser crash/,
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
        ownerStartIdentity: 'linux-proc:boot:200',
        ownerToken: TOKEN_B,
        generation: 'generation:2',
    }), leaseDeps({ state: 'dead' }));
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.operation-')), false);
    assert.equal(releaseProviderHomeLease(recovered), true);
});

test('malformed, noncanonical, and symlink lease state fails closed without recovery', (t) => {
    const malformedRoot = leaseRoot(t);
    const malformedPath = path.join(malformedRoot, 'agent_alias-1.lease.json');
    fs.writeFileSync(malformedPath, '{"schemaVersion":1}\n', { mode: 0o600 });
    assert.throws(
        () => acquireProviderHomeLease(leaseInput(malformedRoot), leaseDeps({ state: 'dead' })),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
    );
    assert.equal(fs.existsSync(malformedPath), true);

    const symlinkRoot = leaseRoot(t);
    const outside = path.join(symlinkRoot, 'outside');
    fs.writeFileSync(outside, 'do-not-remove', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(symlinkRoot, 'agent_alias-1.lease.json'));
    assert.throws(
        () => acquireProviderHomeLease(leaseInput(symlinkRoot), leaseDeps({ state: 'dead' })),
        (error) => error?.code === 'PLOINKY_PROVIDER_HOME_LEASE_INVALID',
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'do-not-remove');
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
