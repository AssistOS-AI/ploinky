import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256 } from '../../ploinky-box/boundary/fingerprint.mjs';
import { BOX_LABELS, BOX_ROLES } from '../../ploinky-box/constants.mjs';
import {
    discoverBoxOwnership,
    volumeHandleMatches,
} from '../../ploinky-box/engine/discovery.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createOuterJournalStore } from '../../ploinky-box/lifecycle/outerJournal.mjs';

const CONTAINER_ID = 'a'.repeat(64);
const IMAGE_ID = 'b'.repeat(64);
const GENERATION = 'c'.repeat(64);
const MACHINE_ENGINE_ID = sha256(Buffer.from(JSON.stringify([
    'podman-machine',
    'v6.0.1',
    'podman-machine-default',
    'ssh://core@localhost/run/user/501/podman/podman.sock',
])));

function podmanInfo({ rootless = true, serviceIsRemote = true } = {}) {
    return {
        host: {
            id: 'podman-host',
            os: 'linux',
            security: { rootless },
            serviceIsRemote,
        },
        store: { graphRoot: '/graph', runRoot: '/run' },
        version: { APIVersion: '6.0.1' },
    };
}

function fixture(t) {
    const workspaceRoot = fs.realpathSync(fs.mkdtempSync(
        path.join(os.tmpdir(), 'ploinky-box-discovery-'),
    ));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    const identity = buildWorkspaceIdentity(workspaceRoot, { markerFound: false });
    const socketPath = path.join(
        workspaceRoot, 'podman', 'podman-machine-default-api.sock',
    );
    const connection = {
        name: 'podman-machine-default',
        identity: 'podman-machine-default',
        uri: 'ssh://core@localhost/run/user/501/podman/podman.sock',
        socketPath,
    };
    const labels = {
        [BOX_LABELS.pathHash]: identity.pathHash,
        [BOX_LABELS.role]: BOX_ROLES.container,
        [BOX_LABELS.imageRef]: IMAGE_ID,
        [BOX_LABELS.routerHostPort]: '18080',
        [BOX_LABELS.mediaHostPort]: '17882',
        [BOX_LABELS.releaseDescriptor]: '{"release":"phase10x"}',
        [BOX_LABELS.releaseGeneration]: GENERATION,
    };
    const outerJournal = createOuterJournalStore({ workspaceRoot });
    const initial = outerJournal.create({
        schemaVersion: 1,
        engine: {
            name: 'podman',
            identity: MACHINE_ENGINE_ID,
            apiVersion: 'v6.0.1',
            hostKind: 'podman-machine',
            connection,
        },
        workspace: {
            root: workspaceRoot,
            owner: identity.instance,
            pathHash: identity.pathHash,
        },
        transaction: { id: 'phase10x-discovery-transaction', generation: GENERATION },
        container: {
            name: `${identity.instance}-g-${GENERATION.slice(0, 16)}`,
            id: null,
            labels,
            image: {
                rawId: IMAGE_ID,
                reference: IMAGE_ID,
                releaseIdentity: {
                    generation: GENERATION,
                    descriptor: labels[BOX_LABELS.releaseDescriptor],
                },
            },
            creation: {
                ports: [
                    {
                        containerPort: '8080', protocol: 'tcp',
                        hostIp: '127.0.0.1', hostPort: '18080',
                    },
                    {
                        containerPort: '7882', protocol: 'udp',
                        hostIp: '0.0.0.0', hostPort: '17882',
                    },
                ],
                network: { mode: 'podman', networks: ['podman'] },
                mounts: [
                    {
                        type: 'bind', source: workspaceRoot, name: '',
                        destination: '/opt/ploinky', rw: false,
                    },
                    {
                        type: 'volume', source: '', name: identity.volumes.workspace,
                        destination: '/workspace', rw: true,
                    },
                    {
                        type: 'volume', source: '', name: identity.volumes.containers,
                        destination: '/home/podman/.local/share/containers', rw: true,
                    },
                    {
                        type: 'volume', source: '', name: identity.volumes.dependencies,
                        destination: '/opt/ploinky/node_modules', rw: true,
                    },
                ],
                volumes: Object.values(identity.volumes),
                devices: [
                    { hostPath: '/dev/fuse', containerPath: '/dev/fuse', permissions: 'rwm' },
                    { hostPath: '/dev/net/tun', containerPath: '/dev/net/tun', permissions: 'rwm' },
                ],
                tmpfs: { '/tmp': 'rw,nosuid,nodev,mode=1777,rprivate,tmpcopyup' },
                env: { PLOINKY_PUBLIC_AUTHORITY: '127.0.0.1:18080' },
                security: {
                    user: 'podman', init: true, privileged: false,
                    securityOptions: ['label=disable', 'unmask=all'],
                },
                command: ['/usr/local/bin/ploinky-box-entrypoint'],
                dependencies: [],
                autoRemove: false,
            },
        },
        predecessor: null,
        createdResources: { container: false, volumes: [] },
        phase: 'intent',
        revision: 0,
    });
    const published = outerJournal.publishContainerId({
        generation: GENERATION,
        containerId: null,
        revision: initial.revision,
    }, CONTAINER_ID);
    return {
        workspaceRoot, identity, connection, labels, outerJournal, published,
    };
}

function selectionRunner(connection, {
    connections = [{
        Name: connection.name,
        URI: connection.uri,
        Default: true,
        IsMachine: true,
    }],
} = {}) {
    const calls = [];
    return {
        calls,
        query(command, args) {
            calls.push([command, ...args]);
            if (command === 'podman' && args[0] === 'system') {
                return { ok: true, stdout: JSON.stringify(connections), stderr: '' };
            }
            throw new Error(`unsafe remote CLI call: ${[command, ...args].join(' ')}`);
        },
    };
}

function directClient(connection, records) {
    const requests = [];
    const unsafeCalls = [];
    return {
        identity: Object.freeze({
            engine: 'podman',
            engineIdentity: MACHINE_ENGINE_ID,
            connectionIdentity: connection.identity,
            connectionUri: connection.uri,
            socketPath: connection.socketPath,
            hostKind: 'podman-machine',
            apiVersion: 'v6.0.1',
        }),
        requests,
        unsafeCalls,
        async listContainers(options) {
            requests.push(structuredClone(options));
            assert.deepEqual(options, {
                all: true, sync: false, size: false, namespace: false,
            });
            return structuredClone(records);
        },
        async inspectContainer() {
            unsafeCalls.push('inspect');
            throw new Error('remote inspect is forbidden');
        },
        async runContainer() {
            unsafeCalls.push('run');
            throw new Error('remote run is forbidden');
        },
        async logsContainer() {
            unsafeCalls.push('logs');
            throw new Error('remote logs are forbidden');
        },
    };
}

function ownedRecord(state, overrides = {}) {
    return {
        Id: CONTAINER_ID,
        Names: [state.published.container.name],
        ImageID: IMAGE_ID,
        Image: IMAGE_ID,
        Labels: state.labels,
        State: 'running',
        Status: 'Up 1 minute',
        Pid: 1234,
        ...overrides,
    };
}

async function discoverMachine(state, client, overrides = {}) {
    return discoverBoxOwnership(state.identity, {
        platform: 'darwin',
        env: { TMPDIR: state.workspaceRoot },
        runner: selectionRunner(state.connection),
        hostClient: client,
        outerJournal: state.outerJournal,
        ...overrides,
    });
}

test('macOS happy path awaits one exact sync=false direct list and returns journal-owned handles', async (t) => {
    const state = fixture(t);
    const unrelated = {
        Id: 'f'.repeat(64),
        Names: ['unrelated'],
        ImageID: '9'.repeat(64),
        Image: 'unrelated',
        Labels: {},
        State: 'running',
        Status: 'Up',
        Pid: 88,
    };
    const client = directClient(state.connection, [ownedRecord(state), unrelated]);
    const runner = selectionRunner(state.connection);
    const factoryEngines = [];

    const result = await discoverBoxOwnership(state.identity, {
        platform: 'darwin',
        env: { TMPDIR: state.workspaceRoot },
        runner,
        outerJournal: state.outerJournal,
        hostClientFactory({ engine }) {
            factoryEngines.push(structuredClone(engine));
            return client;
        },
    });

    assert.equal(result.state, 'owned');
    assert.equal(result.handles.container.id, CONTAINER_ID);
    assert.equal(result.handles.container.connectionIdentity, state.connection.identity);
    assert.equal(result.handles.container.runtime.running, true);
    assert.deepEqual(result.handles.container.runtime.dependencies, []);
    assert.equal(result.handles.container.runtime.autoRemove, false);
    assert.deepEqual(Object.keys(result.handles.volumes), [
        'workspace', 'containers', 'dependencies',
    ]);
    assert.deepEqual(client.requests, [{
        all: true, sync: false, size: false, namespace: false,
    }]);
    assert.deepEqual(client.unsafeCalls, []);
    assert.deepEqual(runner.calls, [[
        'podman', 'system', 'connection', 'list', '--format', 'json',
    ]]);
    assert.deepEqual(factoryEngines, [{
        name: 'podman',
        identity: MACHINE_ENGINE_ID,
        apiVersion: 'v6.0.1',
        hostKind: 'podman-machine',
        connection: {
            name: state.connection.name,
            identity: state.connection.name,
            uri: state.connection.uri,
            socketPath: state.connection.socketPath,
        },
    }]);
    assert.equal(runner.calls.some((call) => call[1] === 'info'), false);
    assert.equal(result.hostClient, client);
    assert.equal(JSON.stringify(result).includes(state.workspaceRoot), true);
    assert.equal(JSON.stringify(result).includes('unrelated'), false);
});

test('absent direct inventory is mutation-free and cannot adopt names without a journal', async (t) => {
    const state = fixture(t);
    state.outerJournal.retire({
        generation: GENERATION,
        containerId: CONTAINER_ID,
        revision: state.published.revision,
    });
    const absentClient = directClient(state.connection, []);
    const absent = await discoverMachine(state, absentClient);
    assert.equal(absent.state, 'absent');
    assert.deepEqual(absentClient.unsafeCalls, []);

    const namedClient = directClient(state.connection, [ownedRecord(state)]);
    const incompatible = await discoverMachine(state, namedClient);
    assert.equal(incompatible.state, 'incompatible');
    assert.match(incompatible.message, /without its journal/);
    assert.deepEqual(namedClient.unsafeCalls, []);
});

test('remote discovery rejects an unavailable structured client instead of falling back to CLI', async (t) => {
    const state = fixture(t);
    const runner = selectionRunner(state.connection);
    let factories = 0;
    const result = await discoverBoxOwnership(state.identity, {
        platform: 'darwin',
        env: { TMPDIR: state.workspaceRoot },
        runner,
        hostClientFactory() {
            factories += 1;
            throw new Error('direct socket unavailable');
        },
        outerJournal: state.outerJournal,
    });
    assert.equal(result.state, 'unsupported');
    assert.match(result.message, /Structured Podman Machine socket transport is unavailable/);
    assert.equal(factories, 1);
    assert.equal(runner.calls.some((call) => (
        call[1] === 'container' || call[1] === 'volume'
    )), false);
});

test('client/engine/API/connection/socket identity drift fails before direct inventory', async (t) => {
    const state = fixture(t);
    for (const drift of [
        (client) => { client.identity = { ...client.identity, engineIdentity: '0'.repeat(64) }; },
        (client) => { client.identity = { ...client.identity, apiVersion: 'v6.0.2' }; },
        (client) => { client.identity = { ...client.identity, connectionIdentity: 'other' }; },
        (client) => { client.identity = { ...client.identity, socketPath: '/tmp/other.sock' }; },
    ]) {
        const client = directClient(state.connection, [ownedRecord(state)]);
        drift(client);
        const result = await discoverMachine(state, client);
        assert.match(`${result.state} ${result.message}`, /incompatible.*identity|incompatible.*socket/i);
        assert.deepEqual(client.requests, []);
        assert.deepEqual(client.unsafeCalls, []);
    }
});

test('journal/list ID, labels, cardinality, dependencies, and auto-remove mismatches fail closed', async (t) => {
    const state = fixture(t);
    const variants = [
        [[ownedRecord(state, { Id: 'short-id' })], /full 64-hex/i],
        [[ownedRecord(state, { ImageID: '9'.repeat(64) })], /image/i],
        [[ownedRecord(state, {
            Labels: { ...state.labels, [BOX_LABELS.pathHash]: '0'.repeat(12) },
        })], /labels|missing|ambiguous/i],
        [[ownedRecord(state), ownedRecord(state)], /duplicate|ambiguous/i],
        [[], /missing|ambiguous/i],
    ];
    for (const [records, pattern] of variants) {
        const client = directClient(state.connection, records);
        const result = await discoverMachine(state, client);
        assert.match(`${result.state} ${result.message}`, pattern);
        assert.deepEqual(client.unsafeCalls, []);
    }

    for (const [field, value] of [
        ['dependencies', [CONTAINER_ID]],
        ['autoRemove', true],
    ]) {
        const corrupt = structuredClone(state.outerJournal.read());
        corrupt.container.creation[field] = value;
        fs.writeFileSync(state.outerJournal.path, `${JSON.stringify(corrupt)}\n`, { mode: 0o600 });
        const client = directClient(state.connection, [ownedRecord(state)]);
        const result = await discoverMachine(state, client);
        assert.match(`${result.state} ${result.message}`, /dependencies|auto-remove|journal/i);
        assert.deepEqual(client.requests, []);
        fs.writeFileSync(state.outerJournal.path, `${JSON.stringify(state.published)}\n`, { mode: 0o600 });
    }
});

test('unsupported platform and unsafe Darwin connections stop before direct inventory', async (t) => {
    const state = fixture(t);
    const unsupportedRunner = selectionRunner(state.connection);
    const unsupported = await discoverBoxOwnership(state.identity, {
        platform: 'win32', runner: unsupportedRunner,
    });
    assert.equal(unsupported.state, 'unsupported');
    assert.deepEqual(unsupportedRunner.calls, []);

    const remoteEnvRunner = selectionRunner(state.connection);
    const remoteEnv = await discoverBoxOwnership(state.identity, {
        platform: 'darwin',
        env: { CONTAINER_HOST: 'ssh://elsewhere' },
        runner: remoteEnvRunner,
    });
    assert.equal(remoteEnv.state, 'unsupported');
    assert.deepEqual(remoteEnvRunner.calls, []);

    const arbitraryRunner = selectionRunner(state.connection, {
        connections: [{
            Name: 'remote', URI: 'ssh://elsewhere/run/podman.sock',
            Default: true, IsMachine: false,
        }],
    });
    const arbitrary = await discoverBoxOwnership(state.identity, {
        platform: 'darwin', env: {}, runner: arbitraryRunner,
    });
    assert.equal(arbitrary.state, 'unsupported');
    assert.match(arbitrary.message, /not an arbitrary remote/i);

    for (const uri of [
        `unix://${state.connection.socketPath}`,
        'ssh://core@elsewhere/run/user/501/podman/podman.sock',
        'ssh://core@localhost/tmp/podman.sock',
        'ssh://localhost/run/user/501/podman/podman.sock',
        'ssh://core@localhost/run/user/0/podman/podman.sock',
    ]) {
        const runner = selectionRunner(state.connection, {
            connections: [{
                Name: state.connection.name,
                URI: uri,
                Default: true,
                IsMachine: true,
            }],
        });
        let factoryCalls = 0;
        const result = await discoverBoxOwnership(state.identity, {
            platform: 'darwin',
            env: { TMPDIR: state.workspaceRoot },
            runner,
            hostClientFactory() { factoryCalls += 1; },
        });
        assert.equal(result.state, 'unsupported', uri);
        assert.match(result.message, /canonical local Podman Machine connection/, uri);
        assert.equal(factoryCalls, 0, uri);
        assert.equal(runner.calls.some((call) => call[1] === 'info'), false, uri);
    }
});

test('native Linux selection remains bounded to sync=false list and exact volume lookups', async (t) => {
    const state = fixture(t);
    const rootfulCalls = [];
    const rootful = await discoverBoxOwnership(state.identity, {
        platform: 'linux',
        env: {},
        runner: {
            query(command, args) {
                rootfulCalls.push([command, ...args]);
                if (command === 'podman' && args[0] === 'info') {
                    return {
                        ok: true,
                        stdout: JSON.stringify(podmanInfo({
                            rootless: false,
                            serviceIsRemote: false,
                        })),
                        stderr: '',
                    };
                }
                throw new Error(`unsafe rootful CLI call: ${[command, ...args].join(' ')}`);
            },
        },
    });
    assert.equal(rootful.state, 'unsupported');
    assert.deepEqual(rootfulCalls, [['podman', 'info', '--format', 'json']]);

    const calls = [];
    const runner = {
        query(command, args) {
            calls.push([command, ...args]);
            if (command === 'podman' && args[0] === 'info') {
                return {
                    ok: true,
                    stdout: JSON.stringify(podmanInfo({ serviceIsRemote: false })),
                    stderr: '',
                };
            }
            if (command === 'docker' && args[0] === 'info') {
                return { ok: false, stdout: '', stderr: '', error: { code: 'ENOENT' } };
            }
            if (command === 'podman' && args[0] === 'container' && args[1] === 'ls') {
                return { ok: true, stdout: '[]', stderr: '' };
            }
            if (command === 'podman' && args[0] === 'volume' && args[1] === 'inspect') {
                return { ok: false, stdout: '', stderr: 'no such volume', error: null };
            }
            throw new Error(`unexpected native selection call: ${[command, ...args].join(' ')}`);
        },
    };
    const result = await discoverBoxOwnership(state.identity, {
        platform: 'linux', env: {}, runner,
    });
    assert.equal(result.state, 'absent');
    assert.equal(result.engine.hostKind, 'native-linux');
    assert.equal(calls.some((call) => call.join(' ').includes('container ls --all --sync=false')), true);
    assert.equal(calls.some((call) => call[1] === 'container' && call[2] === 'inspect'), false);
    assert.equal(calls.some((call) => ['start', 'stop', 'rm', 'exec'].includes(call[2])), false);
});

test('journal-derived volume handles compare exact generation identity without private paths', async (t) => {
    const state = fixture(t);
    const client = directClient(state.connection, [ownedRecord(state)]);
    const first = await discoverMachine(state, client);
    const left = first.handles.volumes.workspace;
    const same = structuredClone(left);
    const changed = structuredClone(left);
    changed.fingerprint.journalGeneration = '0'.repeat(64);

    assert.equal(volumeHandleMatches(left, same), true);
    assert.equal(volumeHandleMatches(left, changed), false);
    assert.equal(JSON.stringify(left).includes(state.workspaceRoot), false);
    assert.deepEqual(left.fingerprint, {
        journalGeneration: GENERATION,
        transactionId: 'phase10x-discovery-transaction',
    });
});
