import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS, BOX_ROLES } from '../../ploinky-box/constants.mjs';
import { sha256 } from '../../ploinky-box/boundary/fingerprint.mjs';
import { discoverBoxOwnership } from '../../ploinky-box/engine/discovery.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createOuterJournalStore } from '../../ploinky-box/lifecycle/outerJournal.mjs';

const CONTAINER_ID = 'a'.repeat(64);
const IMAGE_ID = 'b'.repeat(64);
const GENERATION = 'c'.repeat(64);
const MACHINE_NAME = 'podman-machine-default';
const MACHINE_URI = 'ssh://core@localhost:53421/run/user/501/podman/podman.sock';
const MACHINE_SOCKET = '/private/tmp/podman/podman-machine-default-api.sock';
const ENGINE_ID = sha256(Buffer.from(JSON.stringify([
    'podman-machine', 'v6.0.1', MACHINE_NAME, MACHINE_URI,
])));

function fixture(t) {
    const workspaceRoot = fs.realpathSync(fs.mkdtempSync(
        path.join(os.tmpdir(), 'ploinky-direct-discovery-'),
    ));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    const identity = buildWorkspaceIdentity(workspaceRoot, { markerFound: false });
    const labels = {
        [BOX_LABELS.pathHash]: identity.pathHash,
        [BOX_LABELS.role]: BOX_ROLES.container,
        [BOX_LABELS.imageRef]: IMAGE_ID,
        [BOX_LABELS.routerHostPort]: '18080',
        [BOX_LABELS.mediaHostPort]: '17882',
        [BOX_LABELS.releaseDescriptor]: '{"release":"phase10x"}',
        [BOX_LABELS.releaseGeneration]: GENERATION,
    };
    const connection = {
        name: MACHINE_NAME,
        identity: MACHINE_NAME,
        uri: MACHINE_URI,
        socketPath: MACHINE_SOCKET,
    };
    const journal = createOuterJournalStore({ workspaceRoot });
    const initial = journal.create({
        schemaVersion: 1,
        engine: {
            name: 'podman', identity: ENGINE_ID, apiVersion: 'v6.0.1',
            hostKind: 'podman-machine', connection,
        },
        workspace: { root: workspaceRoot, owner: identity.instance, pathHash: identity.pathHash },
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
                    { containerPort: '8080', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: '18080' },
                    { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: '17882' },
                ],
                network: { mode: 'podman', networks: ['podman'] },
                mounts: [
                    { type: 'bind', source: workspaceRoot, name: '', destination: '/opt/ploinky', rw: false },
                    { type: 'volume', source: '', name: identity.volumes.workspace, destination: '/workspace', rw: true },
                    { type: 'volume', source: '', name: identity.volumes.containers, destination: '/home/podman/.local/share/containers', rw: true },
                    { type: 'volume', source: '', name: identity.volumes.dependencies, destination: '/opt/ploinky/node_modules', rw: true },
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
    const published = journal.publishContainerId({
        generation: GENERATION, containerId: null, revision: initial.revision,
    }, CONTAINER_ID);
    return { workspaceRoot, identity, labels, connection, journal, published };
}

function runnerFixture(connection) {
    const calls = [];
    return {
        calls,
        query(command, args) {
            calls.push([command, ...args]);
            if (command === 'podman' && args[0] === 'system') {
                return {
                    ok: true,
                    stdout: JSON.stringify([{
                        Name: connection.name,
                        URI: connection.uri,
                        Default: true,
                        IsMachine: true,
                    }]),
                    stderr: '',
                };
            }
            if (command === 'docker' && args[0] === 'info') {
                return { ok: false, stdout: '', stderr: '', error: { code: 'ENOENT' } };
            }
            throw new Error(`forbidden CLI call: ${[command, ...args].join(' ')}`);
        },
    };
}

function directClient(connection, records) {
    const requests = [];
    const events = [];
    return {
        engineIdentity: ENGINE_ID,
        apiVersion: 'v6.0.1',
        connection,
        requests,
        events,
        async listContainers(options) {
            requests.push({ operation: 'listContainers', options: structuredClone(options) });
            assert.deepEqual(options, {
                all: true, sync: false, size: false, namespace: false,
            });
            return structuredClone(records);
        },
        async inspectContainer() {
            events.push({ operation: 'inspect' });
            throw new Error('inspect is forbidden');
        },
    };
}

function ownedRecord(identity, labels, overrides = {}) {
    return {
        Id: CONTAINER_ID,
        Names: [`${identity.instance}-g-${GENERATION.slice(0, 16)}`],
        ImageID: IMAGE_ID,
        Image: IMAGE_ID,
        Labels: labels,
        State: 'running',
        Status: 'Up 1 minute',
        Pid: 1234,
        ...overrides,
    };
}

test('macOS ownership discovery uses one explicit sync=false list and zero inspect', async (t) => {
    const state = fixture(t);
    const runner = runnerFixture(state.connection);
    const client = directClient(state.connection, [
        ownedRecord(state.identity, state.labels),
        {
            Id: 'f'.repeat(64), Names: ['unrelated'], ImageID: '9'.repeat(64),
            Image: 'unrelated', Labels: {}, State: 'running', Status: 'Up', Pid: 88,
        },
    ]);

    const result = await discoverBoxOwnership(state.identity, {
        platform: 'darwin', env: { TMPDIR: '/private/tmp' }, runner, hostClient: client, outerJournal: state.journal,
    });

    assert.equal(result.state, 'owned');
    assert.equal(result.handles.container.id, CONTAINER_ID);
    assert.equal(result.handles.container.runtime.running, true);
    assert.deepEqual(result.handles.container.runtime.dependencies, []);
    assert.equal(result.handles.container.runtime.autoRemove, false);
    assert.deepEqual(client.requests, [{
        operation: 'listContainers',
        options: { all: true, sync: false, size: false, namespace: false },
    }]);
    assert.deepEqual(client.events, []);
    assert.equal(runner.calls.some((call) => call.includes('inspect')), false);
    assert.equal(runner.calls.some((call) => ['start', 'stop', 'rm'].includes(call[1])), false);
    assert.deepEqual(result.engine.connection, state.connection);
});

test('engine, API, connection, and socket identity drift fails before container observation', async (t) => {
    const state = fixture(t);
    for (const drift of [
        (client) => { client.engineIdentity = '0'.repeat(64); },
        (client) => { client.apiVersion = 'v6.0.2'; },
        (client) => { client.connection = { ...client.connection, identity: 'other' }; },
        (client) => { client.connection = { ...client.connection, socketPath: '/private/tmp/other.sock' }; },
    ]) {
        const client = directClient(state.connection, [
            ownedRecord(state.identity, state.labels),
        ]);
        drift(client);
        const result = await discoverBoxOwnership(state.identity, {
            platform: 'darwin', env: { TMPDIR: '/private/tmp' }, runner: runnerFixture(state.connection),
            hostClient: client, outerJournal: state.journal,
        });
        assert.match(`${result.state} ${result.message}`, /identity|socket/i);
        assert.deepEqual(client.requests, []);
        assert.deepEqual(client.events, []);
    }
});

test('journal/list mismatch, duplicate, short, missing, dependencies, and auto-remove fail closed', async (t) => {
    const state = fixture(t);
    const variants = [
        [ownedRecord(state.identity, state.labels, { Id: 'a'.repeat(12) }), /full 64-hex/i],
        [ownedRecord(state.identity, state.labels, { ImageID: '9'.repeat(64) }), /image/i],
        [ownedRecord(state.identity, { ...state.labels, [BOX_LABELS.pathHash]: '0'.repeat(12) }), /labels/i],
        [
            [
                ownedRecord(state.identity, state.labels),
                ownedRecord(state.identity, state.labels),
            ],
            /duplicate|ambiguous/i,
        ],
    ];
    for (const [input, pattern] of variants) {
        const records = Array.isArray(input) ? input : [input];
        const client = directClient(state.connection, records);
        const result = await discoverBoxOwnership(state.identity, {
            platform: 'darwin', env: { TMPDIR: '/private/tmp' }, runner: runnerFixture(state.connection),
            hostClient: client, outerJournal: state.journal,
        });
        assert.match(`${result.state} ${result.message}`, pattern);
        assert.deepEqual(client.events, []);
    }

    const missingState = fixture(t);
    missingState.journal.retire({
        generation: GENERATION, containerId: CONTAINER_ID,
        revision: missingState.published.revision,
    });
    const missing = await discoverBoxOwnership(missingState.identity, {
        platform: 'darwin', env: { TMPDIR: '/private/tmp' }, runner: runnerFixture(missingState.connection),
        hostClient: directClient(missingState.connection, [
            ownedRecord(missingState.identity, missingState.labels),
        ]),
        outerJournal: missingState.journal,
    });
    assert.match(`${missing.state} ${missing.message}`, /journal/i);

    for (const field of ['dependencies', 'autoRemove']) {
        const corrupt = structuredClone(state.journal.read());
        corrupt.container.creation[field] = field === 'dependencies' ? [CONTAINER_ID] : true;
        fs.writeFileSync(state.journal.path, `${JSON.stringify(corrupt)}\n`, { mode: 0o600 });
        const result = await discoverBoxOwnership(state.identity, {
            platform: 'darwin', env: { TMPDIR: '/private/tmp' }, runner: runnerFixture(state.connection),
            hostClient: directClient(state.connection, [ownedRecord(state.identity, state.labels)]),
            outerJournal: state.journal,
        });
        assert.match(`${result.state} ${result.message}`, /dependencies|auto-remove|journal/i);
        fs.writeFileSync(state.journal.path, `${JSON.stringify(state.published)}\n`, { mode: 0o600 });
    }
});

test('an unpublished intent cannot adopt an exact-name container and absence is mutation-free', async (t) => {
    const state = fixture(t);
    state.journal.retire({
        generation: GENERATION, containerId: CONTAINER_ID, revision: state.published.revision,
    });
    const fresh = fixture(t);
    fresh.journal.retire({
        generation: GENERATION, containerId: CONTAINER_ID, revision: fresh.published.revision,
    });

    const absentClient = directClient(state.connection, []);
    const absent = await discoverBoxOwnership(state.identity, {
        platform: 'darwin', env: { TMPDIR: '/private/tmp' }, runner: runnerFixture(state.connection),
        hostClient: absentClient, outerJournal: state.journal,
    });
    assert.equal(absent.state, 'absent');
    assert.deepEqual(absentClient.events, []);

    const intentOnly = fixture(t);
    const current = intentOnly.journal.read();
    intentOnly.journal.retire({
        generation: GENERATION, containerId: CONTAINER_ID, revision: current.revision,
    });
    const unpublished = structuredClone(intentOnly.published);
    unpublished.container.id = null;
    unpublished.phase = 'intent';
    unpublished.createdResources.container = false;
    unpublished.revision = 0;
    intentOnly.journal.create(unpublished);
    const adopted = await discoverBoxOwnership(intentOnly.identity, {
        platform: 'darwin', env: { TMPDIR: '/private/tmp' }, runner: runnerFixture(intentOnly.connection),
        hostClient: directClient(intentOnly.connection, [
            ownedRecord(intentOnly.identity, intentOnly.labels),
        ]),
        outerJournal: intentOnly.journal,
    });
    assert.match(`${adopted.state} ${adopted.message}`, /unpublished|journal|ambiguous/i);
});
