import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS, BOX_ROLES } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { discoverBoxOwnership } from '../../ploinky-box/engine/discovery.mjs';

function identityFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-discovery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return buildWorkspaceIdentity(root, { markerFound: true });
}

function labels(identity, role) {
    const result = {
        [BOX_LABELS.pathHash]: identity.pathHash,
        [BOX_LABELS.role]: role,
    };
    if (role === BOX_ROLES.container) {
        result[BOX_LABELS.imageRef] = 'runtime';
        result[BOX_LABELS.routerHostPort] = '18080';
        result[BOX_LABELS.mediaHostPort] = '17891';
        result[BOX_LABELS.dependenciesFingerprint] = 'd'.repeat(64);
        result[BOX_LABELS.imagesFingerprint] = 'f'.repeat(64);
    }
    return result;
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

function ownedContainer(identity) {
    return {
        Id: 'container-id-123',
        Name: identity.instance,
        Labels: labels(identity, BOX_ROLES.container),
    };
}

// Records left behind by the retired named-volume design. They are returned by
// this fake only if discovery asks for them, which it must never do.
function retiredVolumeRecords(identity) {
    return ['images', 'ploinky-deps', 'containers', 'workspace'].map((role) => ({
        Name: `${identity.instance}-${role}`,
        Driver: 'local',
        Scope: 'local',
        Options: {},
        CreatedAt: '2026-07-21T00:00:00Z',
        Mountpoint: `/private/retired/${role}`,
        Labels: {
            [BOX_LABELS.pathHash]: identity.pathHash,
            [BOX_LABELS.role]: role,
        },
    }));
}

function fakeRunner(identity, {
    podman = podmanInfo(),
    docker = 'absent',
    dockerInfo = null,
    container = null,
    inventoryRecords = null,
    connections = [],
    failures = new Map(),
} = {}) {
    const calls = [];
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
                return { ok: true, stdout: JSON.stringify(dockerInfo || {
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
                    record = kind === 'container' && container?.Name === name ? container : null;
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

function assertNoVolumeCommand(runner) {
    assert.equal(runner.calls.some((call) => call[1] === 'volume'), false);
}

test('discovery accepts native Linux and the default macOS Podman Machine', (t) => {
    const identity = identityFixture(t);
    const linuxRunner = fakeRunner(identity);
    const linux = discoverBoxOwnership(identity, {
        platform: 'linux', env: {}, runner: linuxRunner,
    });
    assert.equal(linux.state, 'absent');
    assert.equal(linux.engine.hostKind, 'native-linux');
    assertNoVolumeCommand(linuxRunner);

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
    assertNoVolumeCommand(machineRunner);
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

test('ownership handles carry only the outer container and no volume state', (t) => {
    const identity = identityFixture(t);
    const absentRunner = fakeRunner(identity);
    const absent = discoverBoxOwnership(identity, {
        platform: 'linux', env: {}, runner: absentRunner,
    });
    assert.equal(absent.state, 'absent');
    assert.equal(absent.handles, null);

    const runner = fakeRunner(identity, { container: ownedContainer(identity) });
    const owned = discoverBoxOwnership(identity, { platform: 'linux', env: {}, runner });
    assert.equal(owned.state, 'owned');
    assert.equal(owned.handles.container.id, 'container-id-123');
    assert.deepEqual(Object.keys(owned.handles), ['container']);
    assert.equal(owned.handles.volumes, undefined);
    assert.equal(owned.handles.legacyVolumes, undefined);
    assert.equal(JSON.stringify(owned).includes('mountpointHash'), false);
    assertNoVolumeCommand(runner);
});

test('discovery never issues a volume command in any reachable-engine path', (t) => {
    const identity = identityFixture(t);
    for (const container of [null, ownedContainer(identity)]) {
        const runner = fakeRunner(identity, {
            container,
            inventoryRecords: {
                podman: {
                    container: container ? [container] : [],
                    volume: retiredVolumeRecords(identity),
                },
            },
        });
        discoverBoxOwnership(identity, { platform: 'linux', env: {}, runner });
        assertNoVolumeCommand(runner);
        assert.equal(runner.calls.some((call) => call.includes('volume')), false);
    }
});

test('retired labelled named volumes neither establish ownership nor block a Box', (t) => {
    const identity = identityFixture(t);
    const retired = retiredVolumeRecords(identity);

    // Only the retired volumes still exist: the workspace is simply absent.
    const absentRunner = fakeRunner(identity, {
        inventoryRecords: { podman: { container: [], volume: retired } },
    });
    const absent = discoverBoxOwnership(identity, {
        platform: 'linux', env: {}, runner: absentRunner,
    });
    assert.equal(absent.state, 'absent');
    assert.equal(absent.handles, null);

    // The same retired volumes alongside a current Box change nothing.
    const container = ownedContainer(identity);
    const ownedRunner = fakeRunner(identity, {
        container,
        inventoryRecords: { podman: { container: [container], volume: retired } },
    });
    const owned = discoverBoxOwnership(identity, {
        platform: 'linux', env: {}, runner: ownedRunner,
    });
    assert.equal(owned.state, 'owned');
    assert.equal(JSON.stringify(owned).includes('-ploinky-deps'), false);
});

test('unlabeled exact names and label drift fail closed', (t) => {
    const identity = identityFixture(t);
    const variants = [];
    const unlabeled = ownedContainer(identity);
    unlabeled.Labels = {};
    variants.push(unlabeled);
    const extraLabel = ownedContainer(identity);
    extraLabel.Labels['io.assistos.ploinky-box.unexpected'] = 'present';
    variants.push(extraLabel);
    const wrongPath = ownedContainer(identity);
    wrongPath.Labels[BOX_LABELS.pathHash] = '000000000000';
    variants.push(wrongPath);
    const wrongRole = ownedContainer(identity);
    wrongRole.Labels[BOX_LABELS.role] = 'images';
    variants.push(wrongRole);
    const missingPort = ownedContainer(identity);
    delete missingPort.Labels[BOX_LABELS.mediaHostPort];
    variants.push(missingPort);
    const partialFingerprint = ownedContainer(identity);
    delete partialFingerprint.Labels[BOX_LABELS.imagesFingerprint];
    variants.push(partialFingerprint);

    for (const container of variants) {
        const result = discoverBoxOwnership(identity, {
            platform: 'linux', env: {}, runner: fakeRunner(identity, { container }),
        });
        assert.equal(result.state, 'foreign');
    }
});

test('a container without an immutable ID is foreign rather than owned', (t) => {
    const identity = identityFixture(t);
    const container = ownedContainer(identity);
    delete container.Id;

    const result = discoverBoxOwnership(identity, {
        platform: 'linux', env: {}, runner: fakeRunner(identity, { container }),
    });

    assert.equal(result.state, 'foreign');
    assert.match(result.message, /no immutable ID/);
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

test('a Docker Podman-compatibility frontend is deduplicated across Box creation discovery', (t) => {
    const identity = identityFixture(t);
    const sharedInfo = podmanInfo();
    const emptyDockerView = { container: {}, volume: {} };
    const beforeCreate = discoverBoxOwnership(identity, {
        platform: 'linux',
        env: {},
        runner: fakeRunner(identity, {
            podman: sharedInfo,
            docker: emptyDockerView,
            dockerInfo: sharedInfo,
        }),
    });
    assert.equal(beforeCreate.state, 'absent');

    const container = ownedContainer(identity);
    const dockerView = {
        container: { [identity.instance]: container },
        volume: {},
    };
    const afterCreate = discoverBoxOwnership(identity, {
        platform: 'linux',
        env: {},
        runner: fakeRunner(identity, {
            podman: sharedInfo,
            docker: dockerView,
            dockerInfo: sharedInfo,
            container,
        }),
    });
    assert.equal(afterCreate.state, 'owned');
    assert.equal(afterCreate.handles.container.id, container.Id);
    assert.equal(afterCreate.inventories.docker.handles.container.id, container.Id);
});

test('a same-backend claim cannot hide a divergent Docker container', (t) => {
    const identity = identityFixture(t);
    const sharedInfo = podmanInfo();
    const container = ownedContainer(identity);
    const divergent = { ...ownedContainer(identity), Id: 'different-container-id' };
    const result = discoverBoxOwnership(identity, {
        platform: 'linux',
        env: {},
        runner: fakeRunner(identity, {
            podman: sharedInfo,
            docker: {
                container: { [identity.instance]: divergent },
                volume: {},
            },
            dockerInfo: sharedInfo,
            container,
        }),
    });

    assert.equal(result.state, 'foreign');
    assert.match(result.message, /inconsistent Box inventory/);
});

test('incomplete Podman-shaped Docker metadata cannot bypass a real conflict', (t) => {
    const identity = identityFixture(t);
    const container = ownedContainer(identity);
    const incompleteDockerInfo = podmanInfo();
    incompleteDockerInfo.version = {};
    const result = discoverBoxOwnership(identity, {
        platform: 'linux',
        env: {},
        runner: fakeRunner(identity, {
            docker: {
                container: {
                    [identity.instance]: { ...ownedContainer(identity), Id: 'separate-docker-id' },
                },
                volume: {},
            },
            dockerInfo: incompleteDockerInfo,
            container,
        }),
    });

    assert.equal(result.state, 'foreign');
    assert.match(result.message, /Docker has an exact-name or labeled resource conflicting/);
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

test('an unreadable container inventory is unknown rather than absent', (t) => {
    const identity = identityFixture(t);
    const failures = new Map([[
        ['podman', 'container', 'ls', '-a', '--filter', `label=${BOX_LABELS.pathHash}=${identity.pathHash}`, '--format', '{{json .}}'].join('\0'),
        { ok: false, stdout: '', stderr: 'engine busy', error: null },
    ]]);
    const result = discoverBoxOwnership(identity, {
        platform: 'linux', env: {}, runner: fakeRunner(identity, { failures }),
    });
    assert.equal(result.state, 'unknown');
    assert.match(result.message, /could not inventory Box container ownership/);
});
