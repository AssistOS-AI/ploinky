import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS, BOX_ROLES, BOX_SCHEMA_VERSION } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    discoverBoxOwnership,
    volumeHandleMatches,
} from '../../ploinky-box/engine/discovery.mjs';

function identityFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-discovery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return buildWorkspaceIdentity(root, { markerFound: true });
}

function labels(identity, role) {
    return {
        [BOX_LABELS.schema]: BOX_SCHEMA_VERSION,
        [BOX_LABELS.pathHash]: identity.pathHash,
        [BOX_LABELS.role]: role,
    };
}

function podmanInfo({ rootless = true, osName = 'linux', serviceIsRemote = false } = {}) {
    return {
        host: {
            id: 'podman-host',
            os: osName,
            security: { rootless },
            serviceIsRemote,
        },
        store: { graphRoot: '/graph', runRoot: '/run' },
        version: { APIVersion: '5' },
    };
}

function ownedRecords(identity, mountSuffix = 'one') {
    const container = {
        Id: 'container-id-123',
        Name: identity.instance,
        Labels: labels(identity, BOX_ROLES.container),
    };
    const volumes = Object.fromEntries(Object.entries(identity.volumes).map(([key, name]) => {
        const role = key === 'dependencies' ? BOX_ROLES.dependencies : BOX_ROLES[key];
        return [key, {
            Name: name,
            Driver: 'local',
            Scope: 'local',
            Options: {},
            CreatedAt: '2026-07-21T00:00:00Z',
            Mountpoint: `/private/${mountSuffix}/${key}`,
            Labels: labels(identity, role),
        }];
    }));
    return { container, volumes };
}

function fakeRunner(identity, {
    podman = podmanInfo(),
    docker = 'absent',
    records = null,
    inventoryRecords = null,
    connections = [],
    failures = new Map(),
} = {}) {
    const calls = [];
    const selected = records || { container: null, volumes: {} };
    return {
        calls,
        query(command, args) {
            calls.push([command, ...args]);
            const key = [command, ...args].join('\0');
            if (failures.has(key)) {
                return failures.get(key);
            }
            if (args[0] === 'info') {
                if (command === 'podman') {
                    return { ok: true, stdout: JSON.stringify(podman), stderr: '' };
                }
                if (docker === 'absent') {
                    return { ok: false, stdout: '', stderr: '', error: { code: 'ENOENT' } };
                }
                return { ok: true, stdout: JSON.stringify({
                    ID: 'docker-host', DockerRootDir: '/docker', ServerVersion: '1', OSType: 'linux',
                }), stderr: '' };
            }
            if (args[0] === 'system' && args[1] === 'connection') {
                return { ok: true, stdout: JSON.stringify(connections), stderr: '' };
            }
            if (args[1] === 'ls') {
                const kind = args[0];
                const provided = inventoryRecords?.[command]?.[kind] || [];
                return { ok: true, stdout: provided.map((item) => JSON.stringify(item)).join('\n'), stderr: '' };
            }
            if (args[1] === 'inspect') {
                const [kind, , name] = args;
                let record = null;
                if (command === 'podman') {
                    record = kind === 'container'
                        ? selected.container
                        : Object.values(selected.volumes).find((item) => item.Name === name);
                } else if (docker && docker !== 'absent') {
                    record = docker[kind]?.[name] || null;
                }
                return record
                    ? { ok: true, stdout: JSON.stringify([record]), stderr: '' }
                    : { ok: false, stdout: '', stderr: `no such ${kind}`, error: null };
            }
            throw new Error(`Unexpected command: ${key}`);
        },
    };
}

test('discovery accepts native Linux and the default macOS Podman Machine', (t) => {
    const identity = identityFixture(t);
    const linux = discoverBoxOwnership(identity, {
        platform: 'linux', env: {}, runner: fakeRunner(identity),
    });
    assert.equal(linux.state, 'absent');
    assert.equal(linux.engine.hostKind, 'native-linux');

    const machineRunner = fakeRunner(identity, {
        podman: podmanInfo({ serviceIsRemote: true }),
        connections: [{ Default: true, IsMachine: true }],
    });
    const machine = discoverBoxOwnership(identity, {
        platform: 'darwin', env: {}, runner: machineRunner,
    });
    assert.equal(machine.state, 'absent');
    assert.equal(machine.engine.hostKind, 'podman-machine');
    assert.equal(machineRunner.calls.some((call) => (
        call[1] === 'system' && call[2] === 'connection'
    )), true);
});

test('discovery rejects unsupported, rootful, and arbitrary remote engines before inventory', (t) => {
    const identity = identityFixture(t);
    const unsupportedRunner = fakeRunner(identity);
    assert.equal(discoverBoxOwnership(identity, {
        platform: 'win32', runner: unsupportedRunner,
    }).state, 'unsupported');
    assert.equal(unsupportedRunner.calls.length, 0);

    const rootfulRunner = fakeRunner(identity, { podman: podmanInfo({ rootless: false }) });
    assert.equal(discoverBoxOwnership(identity, { platform: 'linux', runner: rootfulRunner }).state, 'unsupported');
    assert.equal(rootfulRunner.calls.some((call) => call[1] === 'container'), false);

    const remoteRunner = fakeRunner(identity);
    assert.equal(discoverBoxOwnership(identity, {
        platform: 'linux', env: { CONTAINER_HOST: 'ssh://elsewhere' }, runner: remoteRunner,
    }).state, 'unsupported');

    const linuxRemoteRunner = fakeRunner(identity, {
        podman: podmanInfo({ serviceIsRemote: true }),
    });
    assert.equal(discoverBoxOwnership(identity, {
        platform: 'linux', env: {}, runner: linuxRemoteRunner,
    }).state, 'unsupported');

    const arbitraryMacRemote = fakeRunner(identity, {
        podman: podmanInfo({ serviceIsRemote: true }),
        connections: [{ Default: true, IsMachine: false }],
    });
    const arbitraryResult = discoverBoxOwnership(identity, {
        platform: 'darwin', env: {}, runner: arbitraryMacRemote,
    });
    assert.equal(arbitraryResult.state, 'unsupported');
    assert.match(arbitraryResult.message, /not an arbitrary remote/i);
});

test('discovery returns absent and owned handles with immutable IDs and private fingerprints', (t) => {
    const identity = identityFixture(t);
    const absent = discoverBoxOwnership(identity, {
        platform: 'linux', env: {}, runner: fakeRunner(identity),
    });
    assert.equal(absent.state, 'absent');

    const records = ownedRecords(identity);
    const owned = discoverBoxOwnership(identity, {
        platform: 'linux', env: {}, runner: fakeRunner(identity, { records }),
    });
    assert.equal(owned.state, 'owned');
    assert.equal(owned.handles.container.id, 'container-id-123');
    assert.equal(owned.handles.volumes.workspace.fingerprint.mountpointHash.length, 64);
    assert.equal(JSON.stringify(owned).includes('/private/'), false);

    const recreated = discoverBoxOwnership(identity, {
        platform: 'linux', env: {}, runner: fakeRunner(identity, {
            records: ownedRecords(identity, 'two'),
        }),
    });
    assert.equal(
        volumeHandleMatches(
            owned.handles.volumes.workspace,
            recreated.handles.volumes.workspace,
        ),
        false,
    );
});

test('unlabeled exact names, wrong labels, and incomplete fingerprints fail closed', (t) => {
    const identity = identityFixture(t);
    const variants = [];
    const unlabeled = ownedRecords(identity);
    unlabeled.container.Labels = {};
    variants.push(unlabeled);
    const wrongSchema = ownedRecords(identity);
    wrongSchema.container.Labels[BOX_LABELS.schema] = '999';
    variants.push(wrongSchema);
    const wrongPath = ownedRecords(identity);
    wrongPath.volumes.workspace.Labels[BOX_LABELS.pathHash] = '000000000000';
    variants.push(wrongPath);
    const wrongRole = ownedRecords(identity);
    wrongRole.volumes.containers.Labels[BOX_LABELS.role] = 'workspace';
    variants.push(wrongRole);
    const incomplete = ownedRecords(identity);
    delete incomplete.volumes.dependencies.Mountpoint;
    variants.push(incomplete);

    for (const records of variants) {
        const result = discoverBoxOwnership(identity, {
            platform: 'linux', env: {}, runner: fakeRunner(identity, { records }),
        });
        assert.equal(result.state, 'foreign');
        assert.equal(JSON.stringify(result).includes('/private/'), false);
    }
});

test('Docker exact-name conflicts and engine ambiguity fail closed', (t) => {
    const identity = identityFixture(t);
    const dockerConflict = {
        container: { [identity.instance]: { Id: 'foreign', Name: identity.instance, Labels: {} } },
        volume: {},
    };
    const conflict = discoverBoxOwnership(identity, {
        platform: 'linux', env: {}, runner: fakeRunner(identity, { docker: dockerConflict }),
    });
    assert.equal(conflict.state, 'foreign');

    const runner = fakeRunner(identity);
    const dockerInfoKey = ['docker', 'info', '--format', 'json'].join('\0');
    runner.query = ((original) => (command, args) => {
        if ([command, ...args].join('\0') === dockerInfoKey) {
            return { ok: false, stdout: '', stderr: 'daemon unavailable', error: null };
        }
        return original(command, args);
    })(runner.query.bind(runner));
    const unknown = discoverBoxOwnership(identity, { platform: 'linux', env: {}, runner });
    assert.equal(unknown.state, 'unknown');
});

test('unexpected labeled inventory records are foreign even when exact names are absent', (t) => {
    const identity = identityFixture(t);
    const runner = fakeRunner(identity, {
        inventoryRecords: {
            podman: {
                container: [{ Name: 'attacker', Labels: labels(identity, BOX_ROLES.container) }],
            },
        },
    });
    const result = discoverBoxOwnership(identity, { platform: 'linux', env: {}, runner });
    assert.equal(result.state, 'foreign');
    assert.equal(runner.calls.some((call) => ['exec', 'start', 'stop', 'rm'].includes(call[1])), false);
});
