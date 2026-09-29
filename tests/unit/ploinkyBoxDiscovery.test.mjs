import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    BOX_AGENTLIB_LABELS,
    BOX_LABELS,
    BOX_ROLES,
} from '../../ploinky-box/constants.mjs';
import { discoverBoxOwnership } from '../../ploinky-box/engine/discovery.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';

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
        result[BOX_LABELS.seccompFingerprint] = 'e'.repeat(64);
        result[BOX_LABELS.dependenciesFingerprint] = 'd'.repeat(64);
        result[BOX_LABELS.imagesFingerprint] = 'f'.repeat(64);
        result[BOX_AGENTLIB_LABELS.mode] = 'local';
        result[BOX_AGENTLIB_LABELS.sourceIdHash] = 'a'.repeat(64);
        result[BOX_AGENTLIB_LABELS.fingerprint] = 'b'.repeat(64);
        result[BOX_AGENTLIB_LABELS.sourceRelativePath] = 'achillesAgentLib';
        result[BOX_AGENTLIB_LABELS.commit] = 'c'.repeat(40);
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

function fakeRunner(identity, {
    podman = podmanInfo(),
    container = null,
    connections = [],
    failures = new Map(),
    inspectStdout,
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
            if (command !== 'podman') {
                throw new Error(`Discovery called non-authoritative engine: ${key}`);
            }
            if (args.join('\0') === ['info', '--format', 'json'].join('\0')) {
                return { ok: true, stdout: JSON.stringify(podman), stderr: '' };
            }
            if (args.join('\0') === [
                'system', 'connection', 'list', '--format', 'json',
            ].join('\0')) {
                return { ok: true, stdout: JSON.stringify(connections), stderr: '' };
            }
            if (args[0] === 'container' && args[1] === 'inspect') {
                if (inspectStdout !== undefined) {
                    return { ok: true, stdout: inspectStdout, stderr: '' };
                }
                const record = container?.Name === args[2] ? container : null;
                return record ? {
                    ok: true,
                    stdout: JSON.stringify([record]),
                    stderr: '',
                } : {
                    ok: false,
                    stdout: '',
                    stderr: 'no such container',
                    error: null,
                };
            }
            throw new Error(`Unexpected command: ${key}`);
        },
    };
}

// Fake Podman Machine marker files: a string is the file content, an Error is
// thrown as-is, and any other path is absent (ENOENT). Records every read.
function markerFiles(entries = {}) {
    const reads = [];
    const read = (file) => {
        reads.push(file);
        const value = entries[file];
        if (value instanceof Error) throw value;
        if (value === undefined) {
            throw Object.assign(new Error(`ENOENT: no such file, open '${file}'`), { code: 'ENOENT' });
        }
        return value;
    };
    read.reads = reads;
    return read;
}

// Unit discovery never reads the real /etc: without an explicit reader these
// tests see a host that has no Podman Machine marker.
function discover(identity, options) {
    return discoverBoxOwnership(identity, { readMachineMarkerFile: markerFiles(), ...options });
}

function assertOnlyPodmanExactInspect(runner, identity) {
    assert.deepEqual(runner.calls, [
        ['podman', 'info', '--format', 'json'],
        ['podman', 'container', 'inspect', identity.instance],
    ]);
}

test('discovery accepts native Linux and the default macOS Podman Machine', (t) => {
    const identity = identityFixture(t);
    const linuxRunner = fakeRunner(identity);
    const linux = discover(identity, {
        platform: 'linux',
        env: {},
        runner: linuxRunner,
    });
    assert.equal(linux.state, 'absent');
    assert.equal(linux.engine.hostKind, 'native-linux');
    assertOnlyPodmanExactInspect(linuxRunner, identity);

    const machineRunner = fakeRunner(identity, {
        podman: podmanInfo({ serviceIsRemote: true }),
        connections: [{ Default: true, IsMachine: true }],
    });
    const machine = discover(identity, {
        platform: 'darwin',
        env: {},
        runner: machineRunner,
    });
    assert.equal(machine.state, 'absent');
    assert.equal(machine.engine.hostKind, 'podman-machine');
    assert.deepEqual(machineRunner.calls, [
        ['podman', 'info', '--format', 'json'],
        ['podman', 'system', 'connection', 'list', '--format', 'json'],
        ['podman', 'container', 'inspect', identity.instance],
    ]);
});

test('discovery retains the selected rootless helper without guessing from platform or installed binaries', (t) => {
    const identity = identityFixture(t);
    for (const helper of ['pasta', 'slirp4netns']) {
        const info = podmanInfo();
        info.host.rootlessNetworkCmd = helper;
        const runner = fakeRunner(identity, { podman: info });
        const result = discover(identity, { platform: 'linux', env: {}, runner });
        assert.equal(result.engine.rootlessNetworkCmd, helper);
        assertOnlyPodmanExactInspect(runner, identity);
    }
});

test('discovery rejects unsupported, rootful, and remote engines before inspection', (t) => {
    const identity = identityFixture(t);
    const unsupportedRunner = fakeRunner(identity);
    assert.equal(discover(identity, {
        platform: 'win32',
        env: {},
        runner: unsupportedRunner,
    }).state, 'unsupported');
    assert.equal(unsupportedRunner.calls.length, 0);

    const configuredRemoteRunner = fakeRunner(identity);
    assert.equal(discover(identity, {
        platform: 'linux',
        env: { CONTAINER_HOST: 'ssh://elsewhere' },
        runner: configuredRemoteRunner,
    }).state, 'unsupported');
    assert.equal(configuredRemoteRunner.calls.length, 0);

    const rootfulRunner = fakeRunner(identity, {
        podman: podmanInfo({ rootless: false }),
    });
    assert.equal(discover(identity, {
        platform: 'linux',
        env: {},
        runner: rootfulRunner,
    }).state, 'unsupported');
    assert.deepEqual(rootfulRunner.calls, [['podman', 'info', '--format', 'json']]);

    const linuxRemoteRunner = fakeRunner(identity, {
        podman: podmanInfo({ serviceIsRemote: true }),
    });
    assert.equal(discover(identity, {
        platform: 'linux',
        env: {},
        runner: linuxRemoteRunner,
    }).state, 'unsupported');
    assert.deepEqual(linuxRemoteRunner.calls, [['podman', 'info', '--format', 'json']]);

    const arbitraryMacRemote = fakeRunner(identity, {
        podman: podmanInfo({ serviceIsRemote: true }),
        connections: [{ Default: true, IsMachine: false }],
    });
    const arbitraryResult = discover(identity, {
        platform: 'darwin',
        env: {},
        runner: arbitraryMacRemote,
    });
    assert.equal(arbitraryResult.state, 'unsupported');
    assert.match(arbitraryResult.message, /not an arbitrary remote/i);
    assert.equal(
        arbitraryMacRemote.calls.some((call) => call[1] === 'container'),
        false,
    );
});

test('discovery refuses a gvproxy-based Podman Machine guest before querying Podman', (t) => {
    const identity = identityFixture(t);
    for (const [file, content] of [
        ['/etc/podman-machine', 'applehv\n'],
        ['/etc/podman-machine', 'qemu'],
        ['/etc/podman-machine', 'hyperv'],
        ['/etc/podman-machine', 'libkrun'],
        ['/etc/podman-machine', ''],
        ['/etc/podman-machine', ' \n'],
        ['/etc/podman-machine', 'unknown-provider'],
        // Podman compares the type exactly, so only lowercase `wsl` is exempt.
        ['/etc/podman-machine', 'WSL'],
        // Go's TrimSpace keeps a byte-order mark, so Podman treats these as
        // gvproxy-based; JavaScript's trim() would strip it and admit them.
        ['/etc/podman-machine', '﻿wsl'],
        ['/etc/podman-machine', 'wsl﻿\n'],
        // Only ASCII whitespace is trimmed. Podman also trims these, but
        // refusing them can only fail closed.
        ['/etc/podman-machine', '\u0085wsl'],
        ['/etc/podman-machine', ' wsl'],
        ['/etc/containers/podman-machine', 'applehv'],
    ]) {
        const runner = fakeRunner(identity);
        const result = discoverBoxOwnership(identity, {
            platform: 'linux',
            env: {},
            runner,
            readMachineMarkerFile: markerFiles({ [file]: content }),
        });
        const label = `${file}=${JSON.stringify(content)}`;
        assert.equal(result.state, 'unsupported', label);
        assert.match(result.message, /gvproxy-based Podman Machine guest/, label);
        assert.ok(result.message.includes(file), label);
        assert.equal(result.engine, undefined, label);
        assert.deepEqual(runner.calls, [], label);
    }

    // The current marker decides; the pre-Podman-6 path is only a fallback.
    const primary = markerFiles({
        '/etc/podman-machine': 'applehv',
        '/etc/containers/podman-machine': 'wsl',
    });
    assert.equal(discoverBoxOwnership(identity, {
        platform: 'linux', env: {}, runner: fakeRunner(identity), readMachineMarkerFile: primary,
    }).state, 'unsupported');
    assert.deepEqual(primary.reads, ['/etc/podman-machine']);
});

test('discovery keeps native Linux without a gvproxy marker and ignores markers on macOS', (t) => {
    const identity = identityFixture(t);
    for (const entries of [
        {},
        { '/etc/podman-machine': 'wsl\n' },
        { '/etc/podman-machine': ' wsl \n' },
        // Every ASCII whitespace character Go's TrimSpace removes.
        { '/etc/podman-machine': '\t\v\f\r wsl\r\n' },
        { '/etc/containers/podman-machine': 'wsl' },
    ]) {
        const runner = fakeRunner(identity);
        const reader = markerFiles(entries);
        const result = discoverBoxOwnership(identity, {
            platform: 'linux', env: {}, runner, readMachineMarkerFile: reader,
        });
        assert.equal(result.state, 'absent', JSON.stringify(entries));
        assert.equal(result.engine.hostKind, 'native-linux');
        assertOnlyPodmanExactInspect(runner, identity);
        assert.deepEqual(reader.reads, entries['/etc/podman-machine']
            ? ['/etc/podman-machine']
            : ['/etc/podman-machine', '/etc/containers/podman-machine']);
    }

    const machineRunner = fakeRunner(identity, {
        podman: podmanInfo({ serviceIsRemote: true }),
        connections: [{ Default: true, IsMachine: true }],
    });
    const macReader = markerFiles({ '/etc/podman-machine': 'applehv' });
    const machine = discoverBoxOwnership(identity, {
        platform: 'darwin', env: {}, runner: machineRunner, readMachineMarkerFile: macReader,
    });
    assert.equal(machine.state, 'absent');
    assert.equal(machine.engine.hostKind, 'podman-machine');
    assert.deepEqual(macReader.reads, []);
});

test('an unreadable Podman Machine marker fails closed with its path and reason', (t) => {
    const identity = identityFixture(t);
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const directory = Object.assign(new Error('EISDIR: illegal operation on a directory'), { code: 'EISDIR' });
    for (const [entries, file, code, reads] of [
        [{ '/etc/podman-machine': denied }, '/etc/podman-machine', 'EACCES', ['/etc/podman-machine']],
        [
            { '/etc/containers/podman-machine': directory },
            '/etc/containers/podman-machine',
            'EISDIR',
            ['/etc/podman-machine', '/etc/containers/podman-machine'],
        ],
    ]) {
        const runner = fakeRunner(identity);
        const reader = markerFiles(entries);
        const result = discoverBoxOwnership(identity, {
            platform: 'linux', env: {}, runner, readMachineMarkerFile: reader,
        });
        assert.equal(result.state, 'unsupported', code);
        assert.ok(result.message.includes(file), code);
        assert.ok(result.message.includes(code), code);
        assert.match(result.message, /cannot read the Podman Machine marker/, code);
        assert.deepEqual(reader.reads, reads, code);
        assert.deepEqual(runner.calls, [], code);
    }
});

test('unavailable and malformed Podman information fails closed', (t) => {
    const identity = identityFixture(t);
    const infoKey = ['podman', 'info', '--format', 'json'].join('\0');

    const absentRunner = fakeRunner(identity, {
        failures: new Map([[
            infoKey,
            { ok: false, stdout: '', stderr: '', error: { code: 'ENOENT' } },
        ]]),
    });
    const absent = discover(identity, {
        platform: 'linux',
        env: {},
        runner: absentRunner,
    });
    assert.equal(absent.state, 'unsupported');
    assert.match(absent.message, /Podman was not found/);

    const unreachableRunner = fakeRunner(identity, {
        failures: new Map([[
            infoKey,
            { ok: false, stdout: '', stderr: 'engine busy', error: null },
        ]]),
    });
    const unreachable = discover(identity, {
        platform: 'linux',
        env: {},
        runner: unreachableRunner,
    });
    assert.equal(unreachable.state, 'unknown');
    assert.match(unreachable.message, /engine is unreachable/);

    const malformedRunner = fakeRunner(identity, {
        failures: new Map([[
            infoKey,
            { ok: true, stdout: '{', stderr: '', error: null },
        ]]),
    });
    const malformed = discover(identity, {
        platform: 'linux',
        env: {},
        runner: malformedRunner,
    });
    assert.equal(malformed.state, 'unknown');
    assert.match(malformed.message, /malformed engine information/);
});

test('ownership handles carry only the exact outer container', (t) => {
    const identity = identityFixture(t);
    const absentRunner = fakeRunner(identity);
    const absent = discover(identity, {
        platform: 'linux',
        env: {},
        runner: absentRunner,
    });
    assert.equal(absent.state, 'absent');
    assert.equal(absent.handles, null);
    assertOnlyPodmanExactInspect(absentRunner, identity);

    const runner = fakeRunner(identity, { container: ownedContainer(identity) });
    const owned = discover(identity, {
        platform: 'linux',
        env: {},
        runner,
    });
    assert.equal(owned.state, 'owned');
    assert.equal(owned.handles.container.id, 'container-id-123');
    assert.deepEqual(Object.keys(owned.handles), ['container']);
    assert.equal(owned.handles.volumes, undefined);
    assert.equal(owned.handles.legacyVolumes, undefined);
    assertOnlyPodmanExactInspect(runner, identity);
});

test('Podman exact-name inspection is the only Box inventory source', (t) => {
    const identity = identityFixture(t);
    const differentlyNamed = ownedContainer(identity);
    differentlyNamed.Name = 'another-container-with-copied-labels';
    const runner = fakeRunner(identity, { container: differentlyNamed });

    const result = discover(identity, {
        platform: 'linux',
        env: {},
        runner,
    });

    assert.equal(result.state, 'absent');
    assertOnlyPodmanExactInspect(runner, identity);
    assert.equal(runner.calls.some((call) => call.includes('docker')), false);
    assert.equal(runner.calls.some((call) => call.includes('ls')), false);
    assert.equal(runner.calls.some((call) => call.includes('volume')), false);
});

test('a Box replacement between commands is rediscovered without a frontend conflict', (t) => {
    const identity = identityFixture(t);
    const calls = [];
    let inspectionCount = 0;
    const runner = {
        query(command, args) {
            calls.push([command, ...args]);
            assert.equal(command, 'podman');
            if (args[0] === 'info') {
                return { ok: true, stdout: JSON.stringify(podmanInfo()), stderr: '' };
            }
            if (args[0] === 'container' && args[1] === 'inspect') {
                const record = ownedContainer(identity);
                record.Id = inspectionCount === 0 ? 'old-container-id' : 'new-container-id';
                inspectionCount += 1;
                return { ok: true, stdout: JSON.stringify([record]), stderr: '' };
            }
            throw new Error(`Unexpected command: ${[command, ...args].join(' ')}`);
        },
    };

    const first = discover(identity, {
        platform: 'linux',
        env: {},
        runner,
    });
    const second = discover(identity, {
        platform: 'linux',
        env: {},
        runner,
    });

    assert.equal(first.state, 'owned');
    assert.equal(first.handles.container.id, 'old-container-id');
    assert.equal(second.state, 'owned');
    assert.equal(second.handles.container.id, 'new-container-id');
    assert.equal(calls.every((call) => call[0] === 'podman'), true);
    assert.equal(calls.some((call) => call.includes('ls')), false);
});

test('discovery checks workspace provenance but leaves configuration to reconciliation', (t) => {
    const identity = identityFixture(t);

    const unlabeled = ownedContainer(identity);
    unlabeled.Labels = {};
    const wrongPath = ownedContainer(identity);
    wrongPath.Labels[BOX_LABELS.pathHash] = '000000000000';
    const wrongRole = ownedContainer(identity);
    wrongRole.Labels[BOX_LABELS.role] = 'images';

    for (const container of [unlabeled, wrongPath, wrongRole]) {
        const result = discover(identity, {
            platform: 'linux',
            env: {},
            runner: fakeRunner(identity, { container }),
        });
        assert.equal(result.state, 'foreign');
    }

    const minimal = ownedContainer(identity);
    minimal.Labels = {
        [BOX_LABELS.pathHash]: identity.pathHash,
        [BOX_LABELS.role]: BOX_ROLES.container,
    };
    const extraLabel = ownedContainer(identity);
    extraLabel.Labels['io.assistos.ploinky-box.unexpected'] = 'present';
    const incompleteConfiguration = ownedContainer(identity);
    delete incompleteConfiguration.Labels[BOX_LABELS.imageRef];
    delete incompleteConfiguration.Labels[BOX_LABELS.mediaHostPort];
    delete incompleteConfiguration.Labels[BOX_LABELS.imagesFingerprint];
    delete incompleteConfiguration.Labels[BOX_AGENTLIB_LABELS.fingerprint];
    incompleteConfiguration.Labels[BOX_AGENTLIB_LABELS.mode] = 'legacy';
    // An image-supplied library carries only the mode, source identity and relative
    // path: it has no content fingerprint or commit label, and the supplying image is
    // the container's own immutable image, so discovery reads none of them for ownership.
    const imageSupplied = ownedContainer(identity);
    delete imageSupplied.Labels[BOX_AGENTLIB_LABELS.fingerprint];
    delete imageSupplied.Labels[BOX_AGENTLIB_LABELS.commit];
    imageSupplied.Labels[BOX_AGENTLIB_LABELS.mode] = 'image';
    imageSupplied.Labels[BOX_AGENTLIB_LABELS.sourceRelativePath] = 'image';

    for (const container of [minimal, extraLabel, incompleteConfiguration, imageSupplied]) {
        const result = discover(identity, {
            platform: 'linux',
            env: {},
            runner: fakeRunner(identity, { container }),
        });
        assert.equal(result.state, 'owned');
    }
});

test('a container without an immutable ID is foreign rather than owned', (t) => {
    const identity = identityFixture(t);
    const container = ownedContainer(identity);
    delete container.Id;

    const result = discover(identity, {
        platform: 'linux',
        env: {},
        runner: fakeRunner(identity, { container }),
    });

    assert.equal(result.state, 'foreign');
    assert.match(result.message, /no immutable ID/);
});

test('an unreadable or malformed exact inspection is unknown rather than absent', (t) => {
    const identity = identityFixture(t);
    const inspectKey = [
        'podman', 'container', 'inspect', identity.instance,
    ].join('\0');
    const unreadableRunner = fakeRunner(identity, {
        failures: new Map([[
            inspectKey,
            { ok: false, stdout: '', stderr: 'engine busy', error: null },
        ]]),
    });
    const unreadable = discover(identity, {
        platform: 'linux',
        env: {},
        runner: unreadableRunner,
    });
    assert.equal(unreadable.state, 'unknown');
    assert.match(unreadable.message, /could not determine whether container/);

    for (const inspectStdout of ['[]', '[{}, {}]', 'not-json']) {
        const malformed = discover(identity, {
            platform: 'linux',
            env: {},
            runner: fakeRunner(identity, { inspectStdout }),
        });
        assert.equal(malformed.state, 'unknown');
        assert.match(malformed.message, /malformed container inspection/);
    }
});
