#!/usr/bin/env node
// Engine-free tests for the runtime supervisor. They use the injected fake
// engine or --dry-run, so no Podman/Docker mutation is needed.
// Runs standalone (`node container/runtime-supervisor-tests.mjs`) and via the
// unit suite (imported by tests/unit/runtimeSupervisor.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCommandRegistry } from '../cli/services/commandRegistry.js';
import {
    REQUIRED_RUNTIME_IMAGE,
    buildRuntimeRunArgs,
    createDefaultRuntimeConfig,
    mergeAndValidatePublishes,
    mergeDesiredRuntimeConfig,
    normalizeContainerInspect,
    normalizeImageInspect,
    planReconciliation,
    validateImageContract,
} from './runtime-contract.mjs';
import { createEngineClient } from './runtime-engine.mjs';
import {
    createFakeEngine,
    createSupervisorHarness,
} from '../tests/helpers/runtimeSupervisorHarness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const MJS = path.join(HERE, 'runtime-supervisor.mjs');
const PLOINKY = path.join(HERE, '..', 'bin', 'ploinky');
const PCLI = path.join(HERE, '..', 'bin', 'p-cli');
const PSH = path.join(HERE, '..', 'bin', 'psh');
const INSTALL_DEPS = path.join(HERE, '..', 'bin', 'ploinky-install-deps');
const REQUIRED_IMAGE = REQUIRED_RUNTIME_IMAGE;

const dockerInspect = [{
    Id: 'container-id',
    Name: '/ploinky-box-demo',
    Image: 'sha256:runtime-v1',
    Config: {
        Image: 'docker.io/assistos/ploinky-box:podman-node24-runtime-v1',
        User: 'podman',
        Env: [
            'PLOINKY_WORKSPACE_ROOT=/workspace',
            'PLOINKY_RUNTIME_NAME=ploinky-box-demo',
        ],
    },
    State: { Status: 'running' },
    HostConfig: {
        Privileged: true,
        Binds: [
            '/src/ploinky:/opt/ploinky:ro',
            '/host/data:/workspace/mounted',
        ],
        PortBindings: {
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }],
            '7880/udp': [{ HostIp: '127.0.0.1', HostPort: '17880' }],
        },
        Devices: [
            { PathOnHost: '/dev/fuse', PathInContainer: '/dev/fuse', CgroupPermissions: 'rwm' },
            { PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' },
        ],
        SecurityOpt: ['seccomp=unconfined'],
    },
    Mounts: [
        { Type: 'volume', Name: 'ploinky-box-demo-workspace', Destination: '/workspace' },
        { Type: 'volume', Name: 'ploinky-box-demo-containers', Destination: '/home/podman/.local/share/containers' },
        { Type: 'volume', Name: 'ploinky-box-demo-ploinky-deps', Destination: '/opt/ploinky/node_modules' },
        { Type: 'bind', Source: '/src/ploinky', Destination: '/opt/ploinky', Mode: 'ro', RW: false },
        { Type: 'bind', Source: '/host/data', Destination: '/workspace/mounted', Mode: 'rw', RW: true },
    ],
}];

const podmanInspect = [{
    Id: 'container-id',
    Name: 'ploinky-box-demo',
    Image: 'sha256:runtime-v1',
    ImageName: 'docker.io/assistos/ploinky-box:podman-node24-runtime-v1',
    Config: {
        Image: 'docker.io/assistos/ploinky-box:podman-node24-runtime-v1',
        User: 'podman',
        Env: [
            'PLOINKY_WORKSPACE_ROOT=/workspace',
            'PLOINKY_RUNTIME_NAME=ploinky-box-demo',
        ],
    },
    State: { Status: 'running', Running: true },
    HostConfig: {
        Privileged: true,
        Binds: [
            '/src/ploinky:/opt/ploinky:ro',
            '/host/data:/workspace/mounted:rw,rprivate,rbind',
        ],
        PortBindings: {
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }],
            '7880/udp': [{ HostIp: '127.0.0.1', HostPort: '17880' }],
        },
        Devices: [
            { PathOnHost: '/dev/fuse', PathInContainer: '/dev/fuse', CgroupPermissions: 'rwm' },
            { PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' },
        ],
        SecurityOpt: ['seccomp=unconfined'],
    },
    Mounts: [
        { Type: 'volume', Name: 'ploinky-box-demo-workspace', Source: '/var/home/user/.local/share/containers/storage/volumes/ploinky-box-demo-workspace/_data', Destination: '/workspace', Driver: 'local', Mode: '', RW: true, Propagation: '' },
        { Type: 'volume', Name: 'ploinky-box-demo-containers', Source: '/var/home/user/.local/share/containers/storage/volumes/ploinky-box-demo-containers/_data', Destination: '/home/podman/.local/share/containers', Driver: 'local', Mode: '', RW: true, Propagation: '' },
        { Type: 'volume', Name: 'ploinky-box-demo-ploinky-deps', Source: '/var/home/user/.local/share/containers/storage/volumes/ploinky-box-demo-ploinky-deps/_data', Destination: '/opt/ploinky/node_modules', Driver: 'local', Mode: 'U', RW: true, Propagation: '' },
        { Type: 'bind', Source: '/src/ploinky', Destination: '/opt/ploinky', Driver: '', Mode: 'ro', RW: false, Propagation: 'rprivate' },
        { Type: 'bind', Source: '/host/data', Destination: '/workspace/mounted', Driver: '', Mode: 'rw,rprivate,rbind', RW: true, Propagation: 'rprivate' },
    ],
}];

function contractV1Image(id = 'sha256:runtime-v1') {
    return {
        Id: id,
        Config: {
            Labels: { 'io.assistos.ploinky.runtime-contract': '1' },
        },
    };
}

function legacyImage(id = 'sha256:legacy') {
    return { Id: id, Config: { Labels: {} } };
}

function contractV1Images() {
    const image = contractV1Image();
    return {
        [REQUIRED_IMAGE]: image,
        [image.Id]: image,
    };
}

function compatibleRunningContainer(overrides = {}) {
    return {
        inspect: structuredClone(dockerInspect[0]),
        logs: '[ploinky-box] self-check OK\n',
        coreStatus: 0,
        coreStdout: 'core: running\n',
        ...overrides,
    };
}

function compatibleStoppedContainer(overrides = {}) {
    const value = compatibleRunningContainer(overrides);
    value.inspect.State.Status = 'exited';
    return value;
}

function legacyRunningContainerWithCustomConfig() {
    const value = compatibleRunningContainer();
    value.inspect.Image = 'sha256:legacy';
    value.inspect.Config.Image = 'docker.io/assistos/ploinky-box:podman-node24';
    value.inspect.Config.Env.push('CUSTOM_RUNTIME_SETTING=kept');
    value.inspect.HostConfig.PortBindings['8080/tcp'][0] = {
        HostIp: '0.0.0.0',
        HostPort: '18080',
    };
    return value;
}

function statusScenarios() {
    return [
        { name: 'missing', input: { container: null }, code: 1, core: false },
        { name: 'stopped', input: { container: compatibleStoppedContainer(), images: contractV1Images() }, code: 1, core: false },
        { name: 'compatible', input: { container: compatibleRunningContainer(), images: contractV1Images() }, code: 0, core: true },
        {
            name: 'outdated',
            input: {
                container: legacyRunningContainerWithCustomConfig(),
                images: { 'sha256:legacy': legacyImage() },
            },
            code: 1,
            core: true,
        },
        {
            name: 'image metadata missing',
            input: {
                container: compatibleRunningContainer(),
                images: {},
            },
            code: 1,
            core: true,
        },
        {
            name: 'unhealthy',
            input: {
                container: compatibleRunningContainer({ logs: 'self-check failed\n' }),
                images: contractV1Images(),
            },
            code: 1,
            core: true,
        },
        {
            name: 'core failure',
            input: {
                container: compatibleRunningContainer({ coreStatus: 6 }),
                images: contractV1Images(),
            },
            code: 6,
            core: true,
        },
    ];
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('docker and podman inspect normalize to the same runtime config', () => {
    const dockerConfig = normalizeContainerInspect('docker', dockerInspect);
    const podmanConfig = normalizeContainerInspect('podman', podmanInspect);
    assert.deepEqual(
        { ...podmanConfig, binds: dockerConfig.binds },
        dockerConfig,
    );
    assert.ok(podmanConfig.binds.includes(
        '/host/data:/workspace/mounted:rw,rprivate,rbind',
    ));
    assert.deepEqual(dockerConfig.routerPublish, {
        hostIp: '127.0.0.1',
        hostPort: '18080',
        containerPort: '8080',
        protocol: 'tcp',
    });
    assert.deepEqual(dockerConfig.extraPublishes, [{
        hostIp: '127.0.0.1',
        hostPort: '17880',
        containerPort: '7880',
        protocol: 'udp',
    }]);
    assert.equal(dockerConfig.sourceDir, '/src/ploinky');
    assert.equal(dockerConfig.mountDir, '/host/data');
});

test('image inspect normalizes and validates the runtime contract', () => {
    const image = normalizeImageInspect(contractV1Image());
    assert.equal(image.id, 'sha256:runtime-v1');
    assert.equal(image.contract, '1');
    assert.doesNotThrow(() => validateImageContract(image, REQUIRED_IMAGE));
    assert.throws(
        () => validateImageContract(
            normalizeImageInspect(legacyImage()),
            'registry.example/legacy:latest',
        ),
        /requires io\.assistos\.ploinky\.runtime-contract=1; observed <missing>/,
    );
});

test('reconciliation plan creates, starts, reuses, and replaces', () => {
    const desired = {
        ...normalizeContainerInspect('docker', dockerInspect),
        contract: '1',
    };
    assert.deepEqual(
        planReconciliation({ existing: null, desired, contractMatches: true }),
        { action: 'create', reasons: ['missing'] },
    );
    assert.deepEqual(
        planReconciliation({
            existing: { ...desired, state: 'exited', running: false },
            desired,
            contractMatches: true,
        }),
        { action: 'start', reasons: [] },
    );
    assert.deepEqual(
        planReconciliation({
            existing: { ...desired, state: 'running', running: true },
            desired,
            contractMatches: true,
        }),
        { action: 'reuse', reasons: [] },
    );
    assert.equal(
        planReconciliation({
            existing: { ...desired, image: 'legacy' },
            desired,
            contractMatches: false,
        }).action,
        'replace',
    );
});

test('desired config preserves omissions and replaces explicit publishes', () => {
    const desired = {
        ...normalizeContainerInspect('docker', dockerInspect),
        contract: '1',
    };
    const existing = {
        ...desired,
        image: 'registry.example/custom-runtime:v1',
        contract: '1',
        mountDir: '/kept/mount',
        routerPublish: {
            hostIp: '0.0.0.0',
            hostPort: '19000',
            containerPort: '8080',
            protocol: 'tcp',
        },
        extraPublishes: [{
            hostIp: '127.0.0.1',
            hostPort: '7000',
            containerPort: '7000',
            protocol: 'tcp',
        }],
    };
    const omitted = mergeDesiredRuntimeConfig(
        { explicit: new Set(), publish: [] },
        existing,
        [],
    );
    assert.equal(omitted.image, 'registry.example/custom-runtime:v1');
    assert.equal(omitted.mountDir, '/kept/mount');
    assert.equal(omitted.routerPublish.hostPort, '19000');
    assert.deepEqual(omitted.extraPublishes, existing.extraPublishes);

    const changed = mergeDesiredRuntimeConfig(
        {
            explicit: new Set(['--publish']),
            publish: ['127.0.0.1:9000:9000/tcp'],
        },
        existing,
        ['127.0.0.1:7880:7880/udp', '127.0.0.1:7880:7880/udp'],
    );
    assert.deepEqual(changed.extraPublishes, [
        {
            hostIp: '127.0.0.1',
            hostPort: '9000',
            containerPort: '9000',
            protocol: 'tcp',
        },
        {
            hostIp: '127.0.0.1',
            hostPort: '7880',
            containerPort: '7880',
            protocol: 'udp',
        },
    ]);
});

test('desired config changes only explicitly selected creation fields', () => {
    const existing = {
        ...normalizeContainerInspect('docker', dockerInspect),
        contract: '1',
    };
    const assertOnly = (changed, fields) => {
        const actualRest = structuredClone(changed);
        const expectedRest = structuredClone(existing);
        for (const field of fields) {
            delete actualRest[field];
            delete expectedRest[field];
        }
        assert.deepEqual(actualRest, expectedRest);
    };

    const port = mergeDesiredRuntimeConfig(
        parseHostInvocation(['--port', '19191', 'list', 'agents']),
        existing,
    );
    assert.equal(port.routerPublish.hostPort, '19191');
    assertOnly(port, ['routerPublish']);

    const image = mergeDesiredRuntimeConfig(
        parseHostInvocation([
            '--image', 'registry.example/runtime:v1', 'list', 'agents',
        ]),
        existing,
    );
    assert.equal(image.image, 'registry.example/runtime:v1');
    assertOnly(image, ['image']);

    const mount = mergeDesiredRuntimeConfig(
        parseHostInvocation(['--mount', '/new/mount', 'list', 'agents']),
        existing,
    );
    assert.equal(mount.mountDir, '/new/mount');
    assert.ok(mount.binds.includes('/new/mount:/workspace/mounted'));
    assertOnly(mount, ['mountDir', 'binds']);

    const lan = mergeDesiredRuntimeConfig(
        parseHostInvocation(['--listen-lan', 'list', 'agents']),
        existing,
    );
    assert.equal(lan.routerPublish.hostIp, '0.0.0.0');
    assertOnly(lan, ['routerPublish']);

    for (const flag of ['--publish', '--expose']) {
        const publish = mergeDesiredRuntimeConfig(
            parseHostInvocation([
                flag, '127.0.0.1:9000:9000/tcp', 'list', 'agents',
            ]),
            existing,
        );
        assert.deepEqual(publish.extraPublishes, [{
            hostIp: '127.0.0.1',
            hostPort: '9000',
            containerPort: '9000',
            protocol: 'tcp',
        }]);
        assertOnly(publish, ['extraPublishes']);
    }
});

test('desired config initializes an explicitly selected missing router publish', () => {
    const withoutRouterInspect = structuredClone(dockerInspect);
    delete withoutRouterInspect[0].HostConfig.PortBindings['8080/tcp'];
    const existing = normalizeContainerInspect(
        'docker',
        withoutRouterInspect,
    );
    assert.equal(existing.routerPublish, null);

    const omitted = mergeDesiredRuntimeConfig(
        { explicit: new Set(), publish: [] },
        existing,
    );
    assert.equal(omitted.routerPublish, null);

    const port = mergeDesiredRuntimeConfig(
        parseHostInvocation(['--port', '19000', 'list', 'agents']),
        existing,
    );
    assert.deepEqual(port.routerPublish, {
        hostIp: '127.0.0.1',
        hostPort: '19000',
        containerPort: '8080',
        protocol: 'tcp',
    });

    const lan = mergeDesiredRuntimeConfig(
        parseHostInvocation(['--listen-lan', 'list', 'agents']),
        existing,
    );
    assert.deepEqual(lan.routerPublish, {
        hostIp: '0.0.0.0',
        hostPort: '8080',
        containerPort: '8080',
        protocol: 'tcp',
    });
});

test('desired config omitted image migrates only the known legacy official reference', () => {
    const custom = {
        ...normalizeContainerInspect('docker', dockerInspect),
        image: 'registry.example/custom-runtime:current',
        contract: '',
    };
    assert.equal(
        mergeDesiredRuntimeConfig(
            { explicit: new Set(), publish: [] },
            custom,
        ).image,
        'registry.example/custom-runtime:current',
    );
    const legacy = {
        ...custom,
        image: 'docker.io/assistos/ploinky-box:podman-node24',
    };
    assert.equal(
        mergeDesiredRuntimeConfig(
            { explicit: new Set(), publish: [] },
            legacy,
        ).image,
        REQUIRED_RUNTIME_IMAGE,
    );
});

test('podman and docker build equivalent creation commands (engine parity)', () => {
    const dockerConfig = normalizeContainerInspect('docker', dockerInspect);
    const podmanConfig = normalizeContainerInspect('podman', podmanInspect);
    const dockerArgs = buildRuntimeRunArgs(dockerConfig, {
        engine: 'docker',
        selinux: false,
    });
    const podmanArgs = buildRuntimeRunArgs(podmanConfig, {
        engine: 'podman',
        selinux: false,
    });
    const canonical = args => args.map(value =>
        value.replace(':/opt/ploinky/node_modules:U', ':/opt/ploinky/node_modules')
            .replace(':/workspace/mounted:rw,rprivate,rbind', ':/workspace/mounted')
    );
    assert.deepEqual(canonical(podmanArgs), canonical(dockerArgs));
    assert.ok(podmanArgs.includes(
        'ploinky-box-demo-ploinky-deps:/opt/ploinky/node_modules:U',
    ));
    assert.ok(dockerArgs.includes(
        'ploinky-box-demo-ploinky-deps:/opt/ploinky/node_modules',
    ));
    for (const args of [podmanArgs, dockerArgs]) {
        assert.ok(args.includes('--privileged'));
        assert.ok(args.includes('/dev/fuse:/dev/fuse:rwm'));
        assert.ok(args.includes('/dev/net/tun:/dev/net/tun:rwm'));
        assert.ok(args.includes('seccomp=unconfined'));
        assert.equal(args.at(-1), REQUIRED_IMAGE);
    }
});

test('fake podman and docker construct equivalent runtime creates (engine parity)', async () => {
    const runArgs = {};
    for (const engine of ['podman', 'docker']) {
        const harness = createSupervisorHarness({
            engine,
            container: null,
            images: contractV1Images(),
        });
        assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
        runArgs[engine] = harness.calls.find(call => call.args[0] === 'run').args;
    }
    const canonical = args => args.map(value =>
        value.replace(':/opt/ploinky/node_modules:U', ':/opt/ploinky/node_modules')
    );
    assert.deepEqual(canonical(runArgs.podman), canonical(runArgs.docker));
    assert.ok(runArgs.podman.includes(
        'ploinky-box-demo-ploinky-deps:/opt/ploinky/node_modules:U',
    ));
    assert.ok(runArgs.docker.includes(
        'ploinky-box-demo-ploinky-deps:/opt/ploinky/node_modules',
    ));
});

test('inspect model performs a local existing-image contract lookup', async () => {
    const harness = createSupervisorHarness({
        engine: 'podman',
        container: compatibleRunningContainer(),
        images: contractV1Images(),
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    assert.ok(harness.calls.some(call =>
        call.kind === 'query'
        && call.args[0] === 'image'
        && call.args[1] === 'inspect'
        && call.args[2] === 'sha256:runtime-v1'
    ));
    assert.ok(!harness.calls.some(call =>
        call.kind === 'run' && call.args[0] === 'pull'
    ));
});

test('review regression: engine failures preserve status, signal, and spawn details through the boundary', async () => {
    const directCases = [
        {
            result: { status: 7, signal: null },
            exitCode: 7,
            message: /exited 7/,
        },
        {
            result: { status: null, signal: 'SIGTERM' },
            exitCode: 143,
            message: /SIGTERM/,
        },
        {
            result: {
                status: null,
                signal: null,
                error: new Error('spawn podman ENOENT'),
            },
            exitCode: 1,
            message: /spawn podman ENOENT/,
        },
    ];
    for (const expected of directCases) {
        const client = createEngineClient({
            name: 'podman',
            spawnSyncImpl: () => expected.result,
        });
        assert.throws(
            () => client.run(['exec', 'demo']),
            error => error.exitCode === expected.exitCode
                && expected.message.test(error.message),
        );
    }

    const boundarySpawn = finalResult => (_name, args, options) => {
        if (options.encoding === 'utf8') {
            if (args[0] === 'machine') {
                return { status: 0, stdout: 'running\n', stderr: '' };
            }
            if (args[0] === 'container' && args.includes('--format')) {
                return { status: 0, stdout: 'running\n', stderr: '' };
            }
            if (args[0] === 'container') {
                return {
                    status: 0,
                    stdout: JSON.stringify(dockerInspect),
                    stderr: '',
                };
            }
            if (args[0] === 'image') {
                return {
                    status: 0,
                    stdout: JSON.stringify([contractV1Image()]),
                    stderr: '',
                };
            }
            if (args[0] === 'exec') {
                return { status: 0, stdout: '', stderr: '' };
            }
            return { status: 1, stdout: '', stderr: 'unsupported query' };
        }
        return finalResult;
    };
    for (const expected of directCases) {
        const stderr = captureWritable();
        const raw = createRuntimeSupervisor({
            ...minimalSupervisorDependencies(),
            detectEngine: () => 'podman',
            spawnSyncImpl: boundarySpawn(expected.result),
            waitHealthy: async () => {},
        });
        assert.equal(
            await runSupervisorWithBoundary(
                raw,
                ['list', 'agents'],
                stderr.stream,
            ),
            expected.exitCode,
        );
    }
});

test('review regression: empty or unidentified container inspect fails before mutation', async () => {
    for (const raw of [[], null, {}, [null], [{}], { State: {} }]) {
        assert.throws(
            () => normalizeContainerInspect('podman', raw),
            /invalid container inspect: missing identifying record/,
        );
    }
    assert.doesNotThrow(() => normalizeContainerInspect('docker', dockerInspect));
    assert.doesNotThrow(() => normalizeContainerInspect('podman', podmanInspect));

    const harness = createSupervisorHarness({
        engine: 'podman',
        container: {
            inspect: {
                State: { Status: 'running' },
                Config: {},
                HostConfig: {},
                Mounts: [],
            },
        },
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 1);
    assert.match(
        harness.stderr,
        /invalid container inspect: missing identifying record/,
    );
    assert.deepEqual(
        harness.calls.filter(call => call.kind === 'run'),
        [],
    );
});

test('review regression: structurally malformed container inspect fails before mutation', async () => {
    const malformed = [
        { Id: 'x' },
        { Id: 'x', State: { Status: 'exited' } },
        {
            Id: 42,
            Config: {},
            State: { Status: 'exited' },
            HostConfig: {},
            Mounts: [],
        },
        {
            Id: 'x',
            Config: [],
            State: { Status: 'exited' },
            HostConfig: {},
            Mounts: [],
        },
        {
            Id: 'x',
            Config: {},
            State: { Running: true },
            HostConfig: {},
            Mounts: [],
        },
        {
            Id: 'x',
            Config: {},
            State: { Status: 1 },
            HostConfig: {},
            Mounts: [],
        },
        {
            Id: 'x',
            Config: {},
            State: { Status: 'exited' },
            HostConfig: [],
            Mounts: [],
        },
        {
            Id: 'x',
            Config: {},
            State: { Status: 'exited' },
            HostConfig: {},
            Mounts: {},
        },
    ];

    for (const inspect of malformed) {
        assert.throws(
            () => normalizeContainerInspect('podman', inspect),
            /invalid container inspect/,
        );
        const harness = createSupervisorHarness({
            engine: 'podman',
            container: { inspect },
        });
        assert.equal(await harness.supervisor.run(['list', 'agents']), 1);
        assert.match(harness.stderr, /invalid container inspect/);
        assert.deepEqual(
            harness.calls.filter(call => call.kind === 'run'),
            [],
        );
    }
});

test('review regression: merged publishes reject only conflicting host sockets', () => {
    const claim = (
        hostIp,
        hostPort,
        containerPort,
        protocol = 'tcp',
    ) => ({ hostIp, hostPort, containerPort, protocol });

    assert.throws(
        () => mergeAndValidatePublishes([
            claim('0.0.0.0', '8080-8082', '9000-9002'),
            claim('127.0.0.1', '8081', '9100'),
        ]),
        /overlapping runtime publish host socket 8081\/tcp: wildcard bind .* conflicts with specific bind /,
    );
    assert.throws(
        () => mergeAndValidatePublishes(
            [claim('', '8080', '9000')],
            [claim('127.0.0.1', '8080', '9100')],
        ),
        /overlapping runtime publish host socket 8080\/tcp: wildcard bind .* conflicts with specific bind /,
    );

    assert.equal(
        mergeAndValidatePublishes(
            [claim('0.0.0.0', '8080', '9000', 'tcp')],
            [claim('127.0.0.1', '8080', '9100', 'udp')],
        ).length,
        2,
    );
    assert.equal(
        mergeAndValidatePublishes([
            claim('127.0.0.1', '8080', '9000'),
            claim('127.0.0.2', '8080', '9100'),
        ]).length,
        2,
    );
    assert.deepEqual(
        mergeAndValidatePublishes(
            [claim('0.0.0.0', '8080', '9000')],
            [claim('127.0.0.1', '8080', '9000')],
        ),
        [claim('0.0.0.0', '8080', '9000')],
    );
});

test('review regression: ephemeral host port zero publishes do not collide', () => {
    const publishes = [
        {
            hostIp: '127.0.0.1',
            hostPort: '0',
            containerPort: '9000',
            protocol: 'tcp',
        },
        {
            hostIp: '',
            hostPort: '0',
            containerPort: '9100',
            protocol: 'tcp',
        },
    ];

    assert.deepEqual(
        mergeAndValidatePublishes(publishes),
        publishes,
    );
});

test('review regression: router publish rejects a merged fixed-socket conflict before mutation', async () => {
    const invocation = {
        name: 'demo',
        image: REQUIRED_IMAGE,
        port: '8080',
        listenLan: false,
        publish: ['127.0.0.1:8080:9000/tcp'],
        explicit: new Set(['--publish']),
        sourceDirResolved: '/src/ploinky',
        mountDirResolved: '',
    };
    assert.throws(
        () => mergeDesiredRuntimeConfig(invocation, null),
        /overlapping runtime publish host socket 8080\/tcp/,
    );

    const duplicate = mergeDesiredRuntimeConfig({
        ...invocation,
        publish: ['127.0.0.1:8080:8080/tcp'],
    }, null);
    assert.deepEqual(duplicate.extraPublishes, []);

    const harness = createSupervisorHarness({
        engine: 'podman',
        container: null,
        images: contractV1Images(),
    });
    assert.equal(await harness.supervisor.run([
        '--publish', '127.0.0.1:8080:9000/tcp',
        'list', 'agents',
    ]), 1);
    assert.match(
        harness.stderr,
        /overlapping runtime publish host socket 8080\/tcp/,
    );
    assert.deepEqual(
        harness.calls.filter(call => call.kind === 'run'),
        [],
    );
});

test('review regression: fake engine models replacement rollback and health phases', async () => {
    const replacementArgs = [
        'run', '-d', '--name', 'ploinky-box-demo', REQUIRED_IMAGE,
    ];
    const afterHealthFailure = createFakeEngine({
        engine: 'podman',
        container: compatibleRunningContainer(),
        images: contractV1Images(),
        failures: { 'run rollback': 9 },
    });
    afterHealthFailure.engineClient.query([
        'container', 'inspect', 'ploinky-box-demo',
    ]);
    afterHealthFailure.engineClient.run(['rm', 'ploinky-box-demo']);
    afterHealthFailure.engineClient.run(replacementArgs);
    afterHealthFailure.engineClient.run(['rm', 'ploinky-box-demo']);
    assert.throws(
        () => afterHealthFailure.engineClient.run(replacementArgs),
        /run rollback exited 9/,
    );

    const afterCreationFailure = createFakeEngine({
        engine: 'podman',
        container: compatibleRunningContainer(),
        images: contractV1Images(),
        failures: { 'run replacement': 8, 'run rollback': 9 },
    });
    afterCreationFailure.engineClient.query([
        'container', 'inspect', 'ploinky-box-demo',
    ]);
    afterCreationFailure.engineClient.run(['rm', 'ploinky-box-demo']);
    assert.throws(
        () => afterCreationFailure.engineClient.run(replacementArgs),
        /run replacement exited 8/,
    );
    assert.throws(
        () => afterCreationFailure.engineClient.run(replacementArgs),
        /run rollback exited 9/,
    );

    const harness = createSupervisorHarness({
        engine: 'podman',
        container: null,
        images: contractV1Images(),
    });
    assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
    assert.ok(harness.calls.some(call =>
        call.kind === 'health' && call.phase === 'create'
    ));
});

function makeFakeNodeCapture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-node-'));
    const capture = path.join(dir, 'capture.json');
    const node = path.join(dir, 'node');
    const realNode = process.execPath;
    fs.writeFileSync(node, `#!/usr/bin/env bash
printf '{"argv":[' > ${JSON.stringify(capture)}
first=1
for arg in "$@"; do
  if [ "$first" -eq 0 ]; then printf ',' >> ${JSON.stringify(capture)}; fi
  first=0
  ${JSON.stringify(realNode)} -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$arg" >> ${JSON.stringify(capture)}
done
printf '],"PLOINKY_PUBLIC_ENTRYPOINT":' >> ${JSON.stringify(capture)}
${JSON.stringify(realNode)} -e 'process.stdout.write(JSON.stringify(process.env.PLOINKY_PUBLIC_ENTRYPOINT || ""))' >> ${JSON.stringify(capture)}
printf '}' >> ${JSON.stringify(capture)}
exit 0
`);
    fs.chmodSync(node, 0o755);
    return { dir, capture };
}

function addReadlinkWithoutDashF(dir) {
    const readlink = path.join(dir, 'readlink');
    fs.writeFileSync(readlink, `#!/usr/bin/env bash
if [ "\${1-}" = "-f" ]; then
  exit 1
fi
/usr/bin/readlink "$@"
`);
    fs.chmodSync(readlink, 0o755);
}

function readCapture(capture) {
    return JSON.parse(fs.readFileSync(capture, 'utf8'));
}

function captureWritable() {
    let captured = '';
    return {
        stream: {
            write(chunk) {
                captured += String(chunk);
                return true;
            },
        },
        text() {
            return captured;
        },
    };
}

function minimalSupervisorDependencies() {
    return {
        stdout: { write() { return true; }, isTTY: false },
        stdin: { isTTY: false },
        cwd: '/workspace/test-runtime',
        env: {},
        sleep: async () => {},
        askLine: async () => null,
    };
}

function publicRun(engine, ...args) {
    const r = spawnSync(MJS, args, {
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_BOX_ENGINE: engine },
    });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

function publicRunWithEnv(extraEnv, engine, ...args) {
    const r = spawnSync(MJS, args, {
        encoding: 'utf8',
        env: {
            ...process.env,
            ...extraEnv,
            PLOINKY_BOX_ENGINE: engine,
        },
    });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

function publicRunIn(cwd, engine, ...args) {
    const r = spawnSync(MJS, args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_BOX_ENGINE: engine },
    });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

function publicRunInWithEnv(cwd, extraEnv, engine, ...args) {
    const r = spawnSync(MJS, args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            ...extraEnv,
            PLOINKY_BOX_ENGINE: engine,
        },
    });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

function makeMissingStatusEngine() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-status-engine-'));
    const calls = path.join(dir, 'calls.log');
    const engine = path.join(dir, 'podman');
    fs.writeFileSync(engine, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
exit 1
`);
    fs.chmodSync(engine, 0o755);
    return { dir, calls };
}

// Fixed-basename child inside a random temp parent: deterministic inference,
// no collision with real containers. Callers clean up the returned parent.
function makeCwd(basename) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-cwd-'));
    const dir = path.join(parent, basename);
    fs.mkdirSync(dir);
    return { parent, dir };
}

function checkIncludes(out, needle, description) {
    assert.ok(out.includes(needle), `${description}\n  wanted: ${needle}\n  in: ${out}`);
}

function checkAbsent(out, needle, description) {
    assert.ok(!out.includes(needle), `${description} (found forbidden '${needle}')\n  in: ${out}`);
}

function countOccurrences(out, needle) {
    return out.split(needle).length - 1;
}

function dryRunPublishTokens(out, engine = 'podman') {
    const prefix = `DRY-RUN: ${engine} run `;
    const line = out.split('\n').find(candidate => candidate.startsWith(prefix));
    assert.ok(line, `missing ${engine} dry-run create command in: ${out}`);
    const args = line.slice(`DRY-RUN: ${engine} `.length).trim().split(/\s+/);
    return args.flatMap((token, index) =>
        token === '-p' ? [args[index + 1]] : []
    );
}

function makeFakePloinkyGraphSource({
    webPublishingOpenPorts = ['127.0.0.1:8081:8081'],
    webPublishingProfiles = null,
} = {}) {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-graph-source-'));
    const sourceDir = path.join(workspaceRoot, 'ploinky');
    fs.mkdirSync(path.join(sourceDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'cli'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'container'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'globalDeps'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'bin', 'ploinky'), '#!/usr/bin/env bash\n');
    fs.writeFileSync(path.join(sourceDir, 'cli', 'index.js'), '');
    fs.writeFileSync(path.join(sourceDir, 'globalDeps', 'package.json'), '{"name":"globalDeps"}\n');

    function writeManifest(repoDir, agentName, manifest) {
        const agentDir = path.join(workspaceRoot, repoDir, agentName);
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }

    writeManifest('AssistOSExplorer', 'explorer', {
        enable: [
            'basic/webtty global',
            'webmeetInfra/liveKitServerAgent no-wait',
            'onlyOffice global no-wait',
        ],
        profiles: {
            default: {
                enable: [
                    {
                        agent: 'basic/web-publishing global',
                    },
                ],
            },
        },
    });
    writeManifest('basic', 'web-publishing', {
        profiles: webPublishingProfiles || {
            default: {
                openPorts: webPublishingOpenPorts,
            },
        },
    });
    writeManifest('basic', 'webtty', {
        profiles: {
            default: {
                env: {
                    PORT: { default: '7681' },
                },
            },
        },
    });
    writeManifest('AssistOSExplorer', 'onlyOffice', {
        profiles: {
            default: {
                env: [
                    { name: 'ONLYOFFICE_JWT_SECRET', required: true },
                ],
            },
        },
    });
    writeManifest('webmeetInfra', 'liveKitServerAgent', {
        profiles: {
            default: {
                openPorts: [
                    '127.0.0.1:7881:7881',
                    '127.0.0.1:3478:3478/tcp',
                    '127.0.0.1:3478:3478/udp',
                    '127.0.0.1:7882-7892:7882-7892/udp',
                    '127.0.0.1:20000-20010:20000-20010/udp',
                ],
            },
        },
    });

    return {
        sourceDir,
        cleanup() {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        },
    };
}

// Fake checkout + fake npm: asserts the exact install flags and that the
// script verifies both dependency dirs afterwards.
function makeFakeCheckout({ npmCreatesDeps, npmBody = '' }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-fake-root-'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.copyFileSync(INSTALL_DEPS, path.join(root, 'bin', 'ploinky-install-deps'));
    fs.chmodSync(path.join(root, 'bin', 'ploinky-install-deps'), 0o755);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fake"}\n');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-fake-npm-'));
    const argsFile = path.join(binDir, 'npm-args.txt');
    fs.writeFileSync(path.join(binDir, 'npm'), `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(argsFile)}
${npmBody || (npmCreatesDeps ? `mkdir -p "$PWD/node_modules/achillesAgentLib" "$PWD/node_modules/mcp-sdk"` : 'true')}
`);
    fs.chmodSync(path.join(binDir, 'npm'), 0o755);
    return { root, binDir, argsFile };
}

function makeFakePodmanForMissingDeps() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-fake-podman-'));
    const calls = path.join(dir, 'calls.log');
    const state = path.join(dir, 'state');
    const podman = path.join(dir, 'podman');
    fs.writeFileSync(podman, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
state_file=${JSON.stringify(state)}
case "$1 $2" in
  "machine inspect")
    echo running
    exit 0
    ;;
  "container inspect")
    if [ -f "$state_file" ]; then
      if [ "$3" = "--format" ]; then echo running; fi
      exit 0
    fi
    exit 1
    ;;
  "image inspect")
    echo '[{"Id":"sha256:runtime-v1","Config":{"Labels":{"io.assistos.ploinky.runtime-contract":"1"}}}]'
    exit 0
    ;;
  "info --format")
    echo false
    exit 0
    ;;
  "run -d")
    echo running > "$state_file"
    echo fake-container-id
    exit 0
    ;;
  "logs ploinky-box-qa")
    echo "self-check OK"
    exit 0
    ;;
  "exec ploinky-box-qa")
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);
    fs.chmodSync(podman, 0o755);
    return { dir, calls };
}

test('ploinky-install-deps bash syntax check (bash -n)', () => {
    const r = spawnSync('bash', ['-n', INSTALL_DEPS], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
});

test('public bin/ploinky delegates to the runtime supervisor on the host', () => {
    const fake = makeFakeNodeCapture();
    try {
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX_ENGINE: 'podman',
        };
        const r = spawnSync(PLOINKY, ['status', '--dry-run'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.equal(captured.argv[0], MJS);
        assert.deepEqual(captured.argv.slice(1), ['status', '--dry-run']);
        assert.equal(captured.PLOINKY_PUBLIC_ENTRYPOINT, '');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('bin/ploinky resolves its repo root when invoked through a symlink', () => {
    const fake = makeFakeNodeCapture();
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-link-'));
    const link = path.join(linkDir, 'ploinky');
    try {
        fs.symlinkSync(PLOINKY, link);
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX_ENGINE: 'podman',
        };
        const r = spawnSync(link, ['status', '--dry-run'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.equal(captured.argv[0], MJS);
        assert.deepEqual(captured.argv.slice(1), ['status', '--dry-run']);
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
        fs.rmSync(linkDir, { recursive: true, force: true });
    }
});

test('p-cli still delegates through bin/ploinky', () => {
    const fake = makeFakeNodeCapture();
    try {
        addReadlinkWithoutDashF(fake.dir);
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX_ENGINE: 'podman',
        };
        const r = spawnSync(PCLI, ['status', '--dry-run'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.equal(captured.argv[0], MJS);
        assert.deepEqual(captured.argv.slice(1), ['status', '--dry-run']);
        assert.equal(captured.PLOINKY_PUBLIC_ENTRYPOINT, '');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('p-cli resolves its repo root when invoked through a symlink', () => {
    const fake = makeFakeNodeCapture();
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p-cli-link-'));
    const link = path.join(linkDir, 'p-cli');
    try {
        addReadlinkWithoutDashF(fake.dir);
        fs.symlinkSync(PCLI, link);
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX_ENGINE: 'podman',
        };
        const r = spawnSync(link, ['status'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.equal(captured.argv[0], MJS);
        assert.deepEqual(captured.argv.slice(1), ['status']);
        assert.equal(captured.PLOINKY_PUBLIC_ENTRYPOINT, '');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
        fs.rmSync(linkDir, { recursive: true, force: true });
    }
});

test('psh delegates to ploinky sh through a symlink', () => {
    const fake = makeFakeNodeCapture();
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psh-link-'));
    const link = path.join(linkDir, 'psh');
    try {
        addReadlinkWithoutDashF(fake.dir);
        fs.symlinkSync(PSH, link);
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX_ENGINE: 'podman',
        };
        const r = spawnSync(link, ['--dry-run'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.equal(captured.argv[0], MJS);
        assert.deepEqual(captured.argv.slice(1), ['sh', '--dry-run']);
        assert.equal(captured.PLOINKY_PUBLIC_ENTRYPOINT, '');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
        fs.rmSync(linkDir, { recursive: true, force: true });
    }
});

test('ploinky-install-deps installs with read-only-safe npm flags and verifies deps', () => {
    const { root, binDir, argsFile } = makeFakeCheckout({ npmCreatesDeps: true });
    try {
        const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` };
        const r = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const npmArgs = fs.readFileSync(argsFile, 'utf8');
        assert.ok(npmArgs.includes('install --no-package-lock --no-audit --no-fund'), npmArgs);
        assert.ok(fs.statSync(path.join(root, 'node_modules', 'achillesAgentLib')).isDirectory());
        assert.ok(fs.statSync(path.join(root, 'node_modules', 'mcp-sdk')).isDirectory());
        // second run: already installed, npm must not run again
        const r2 = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r2.status, 0, `${r2.stdout}${r2.stderr}`);
        assert.ok(r2.stdout.includes('already present'), r2.stdout);
        assert.equal(fs.readFileSync(argsFile, 'utf8'), npmArgs, 'npm not re-invoked when deps exist');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('ploinky-install-deps fails loudly when npm leaves deps missing', () => {
    const { root, binDir } = makeFakeCheckout({ npmCreatesDeps: false });
    try {
        const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` };
        const r = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
        assert.ok(`${r.stdout}${r.stderr}`.includes('still missing after npm install'), `${r.stdout}${r.stderr}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('ploinky-install-deps preserves an existing AchillesAgentLib checkout while installing missing mcp-sdk', () => {
    const { root, binDir, argsFile } = makeFakeCheckout({
        npmCreatesDeps: false,
        npmBody: 'mkdir -p "$PWD/node_modules/mcp-sdk"',
    });
    try {
        const localChange = path.join(root, 'node_modules', 'achillesAgentLib', 'local-change.txt');
        fs.mkdirSync(path.dirname(localChange), { recursive: true });
        fs.writeFileSync(localChange, 'do not delete\n');
        const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` };
        const r = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        assert.equal(fs.readFileSync(localChange, 'utf8'), 'do not delete\n');
        const npmArgs = fs.readFileSync(argsFile, 'utf8');
        assert.ok(npmArgs.includes('install --ignore-scripts --no-package-lock --no-audit --no-fund'), npmArgs);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('ploinky-install-deps resets a partial achillesAgentLib before installing when reset is explicitly allowed', () => {
    const { root, binDir } = makeFakeCheckout({ npmCreatesDeps: true });
    try {
        // partial state: achillesAgentLib exists (would break postinstall's git clone), mcp-sdk missing
        fs.mkdirSync(path.join(root, 'node_modules', 'achillesAgentLib', '.git'), { recursive: true });
        const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}`, PLOINKY_INSTALL_DEPS_ALLOW_RESET: '1' };
        const r = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        assert.ok(!fs.existsSync(path.join(root, 'node_modules', 'achillesAgentLib', '.git')), 'partial dir was reset');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

// --- Added with the Node implementation: syntax + import-level unit tests ---
import {
    parseHostInvocation,
    instanceName,
    volumeNames,
    publicUsageText,
    routeHostInvocation,
    createRuntimeSupervisor,
    runSupervisorWithBoundary,
    sanitizeBoxSuffix,
    resolveInstanceIdentity,
    resolveHostPloinkySource,
    shouldInstallDeps,
    inferPublicStartBranchArgs,
} from './runtime-supervisor.mjs';

function buildArgsForInvocation(cfg, options = {}) {
    cfg.name ||= 'demo';
    cfg.sourceDirResolved ||= REPO_ROOT;
    const config = createDefaultRuntimeConfig(cfg);
    return buildRuntimeRunArgs(config, {
        engine: cfg.engine || 'podman',
        ...options,
    });
}

test('host routing has no box lifecycle namespace', () => {
    assert.deepEqual(routeHostInvocation(parseHostInvocation([])), { kind: 'repl' });
    assert.deepEqual(routeHostInvocation(parseHostInvocation(['cli'])), {
        kind: 'ordinary',
        forwardedArgs: ['cli'],
        interactive: true,
    });
    assert.deepEqual(routeHostInvocation(parseHostInvocation(['status'])), { kind: 'status' });
    assert.deepEqual(routeHostInvocation(parseHostInvocation(['stop'])), { kind: 'stop' });
    assert.deepEqual(routeHostInvocation(parseHostInvocation(['destroy'])), { kind: 'destroy' });
    assert.deepEqual(routeHostInvocation(parseHostInvocation(['start', 'explorer'])), {
        kind: 'start',
        forwardedArgs: ['start', 'explorer'],
    });
    assert.deepEqual(routeHostInvocation(parseHostInvocation(['box', 'status'])), {
        kind: 'ordinary',
        forwardedArgs: ['box', 'status'],
        interactive: false,
    });
});

for (const engine of ['podman', 'docker']) {
    test(engine + ' status is read-only in every state', async () => {
        for (const scenario of statusScenarios()) {
            const harness = createSupervisorHarness({
                engine,
                ...scenario.input,
            });
            const code = await harness.supervisor.run(['status']);
            assert.equal(code, scenario.code, scenario.name);
            const forbidden = new Set([
                'pull',
                'run',
                'start',
                'stop',
                'rm',
                'volume',
            ]);
            assert.equal(
                harness.calls.some(call => forbidden.has(call.args[0])),
                false,
                scenario.name,
            );
            const coreExecs = harness.calls.filter(call =>
                call.args[0] === 'exec'
                && call.args.slice(-2).join(' ') === 'ploinky status'
            );
            assert.equal(coreExecs.length, scenario.core ? 1 : 0, scenario.name);
        }
    });
}

test('dry-run status still inspects and reports an existing runtime read-only', async () => {
    const harness = createSupervisorHarness({
        container: compatibleRunningContainer(),
        images: contractV1Images(),
    });
    assert.equal(await harness.supervisor.run(['--dry-run', 'status']), 0);
    assert.match(harness.stdout, /runtime: ploinky-box-demo \(running\)/);
    assert.equal(harness.calls.some(call =>
        call.kind === 'query'
        && call.args.join(' ') === 'container inspect ploinky-box-demo'
    ), true);
    const forbidden = new Set(['pull', 'run', 'start', 'stop', 'rm', 'volume']);
    assert.equal(
        harness.calls.some(call => forbidden.has(call.args[0])),
        false,
    );
});

test('dry-run status creates a live read-only engine client for core status', async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();
    const fake = createFakeEngine({
        container: compatibleRunningContainer(),
        images: contractV1Images(),
        stdout: stdout.stream,
        stderr: stderr.stream,
    });
    let clientDryRun;
    const raw = createRuntimeSupervisor({
        ...minimalSupervisorDependencies(),
        stdout: stdout.stream,
        stderr: stderr.stream,
        cwd: '/workspace/demo',
        detectEngine: () => 'podman',
        createEngineClient(options) {
            clientDryRun = options.dryRun;
            return fake.engineClient;
        },
    });

    assert.equal(
        await runSupervisorWithBoundary(
            raw,
            ['--dry-run', 'status'],
            stderr.stream,
        ),
        0,
    );
    assert.equal(clientDryRun, false);
    assert.equal(fake.calls.filter(call =>
        call.args[0] === 'exec'
        && call.args.slice(-2).join(' ') === 'ploinky status'
    ).length, 1);
});

test('dry-run status preserves injected detector mutations and caller dry-run state', async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();
    const fake = createFakeEngine({
        container: compatibleRunningContainer(),
        images: contractV1Images(),
        stdout: stdout.stream,
        stderr: stderr.stream,
    });
    let detectedInvocation;
    let detectedDryRun;
    let clientName;
    let clientDryRun;
    const raw = createRuntimeSupervisor({
        ...minimalSupervisorDependencies(),
        stdout: stdout.stream,
        stderr: stderr.stream,
        cwd: '/workspace/demo',
        detectEngine(invocation) {
            detectedInvocation = invocation;
            detectedDryRun = invocation.dryRun;
            invocation.engine = 'podman';
            return true;
        },
        createEngineClient(options) {
            clientName = options.name;
            clientDryRun = options.dryRun;
            return fake.engineClient;
        },
    });

    assert.equal(
        await runSupervisorWithBoundary(
            raw,
            ['--dry-run', 'status'],
            stderr.stream,
        ),
        0,
    );
    assert.equal(detectedDryRun, false);
    assert.equal(clientName, 'podman');
    assert.equal(clientDryRun, false);
    assert.equal(detectedInvocation.dryRun, true);
});

test('route-effective dry-run restoration survives detector failure', async () => {
    const stderr = captureWritable();
    let detectedInvocation;
    const raw = createRuntimeSupervisor({
        ...minimalSupervisorDependencies(),
        stderr: stderr.stream,
        detectEngine(invocation) {
            detectedInvocation = invocation;
            invocation.engine = 'podman';
            throw new Error('detector failed');
        },
    });

    assert.equal(
        await runSupervisorWithBoundary(
            raw,
            ['--dry-run', 'status'],
            stderr.stream,
        ),
        1,
    );
    assert.match(stderr.text(), /detector failed/);
    assert.equal(detectedInvocation.engine, 'podman');
    assert.equal(detectedInvocation.dryRun, true);
});

test('dry-run status validates a missing explicit engine before inspection', async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();
    const missingEngine = `/definitely/missing/ploinky-engine-${process.pid}`;
    let clientCreations = 0;
    const raw = createRuntimeSupervisor({
        ...minimalSupervisorDependencies(),
        stdout: stdout.stream,
        stderr: stderr.stream,
        cwd: '/workspace/demo',
        env: { PATH: '' },
        createEngineClient() {
            clientCreations += 1;
            return {
                name: missingEngine,
                query() {
                    return {
                        ok: false,
                        status: 1,
                        stdout: '',
                        stderr: 'must not inspect',
                    };
                },
                streamContains() {
                    throw new Error('must not read logs');
                },
                run() {
                    throw new Error('must not run core status');
                },
            };
        },
    });

    assert.equal(
        await runSupervisorWithBoundary(
            raw,
            ['--dry-run', 'status', '--engine', missingEngine],
            stderr.stream,
        ),
        1,
    );
    assert.match(stderr.text(), /requested engine .* not found in PATH/);
    assert.doesNotMatch(stdout.text(), /runtime: .* \(missing\)/);
    assert.equal(clientCreations, 0);
});

test('running status treats malformed image metadata as missing and still invokes core', async () => {
    const stdout = captureWritable();
    const stderr = captureWritable();
    const fake = createFakeEngine({
        container: compatibleRunningContainer(),
        images: contractV1Images(),
        stdout: stdout.stream,
        stderr: stderr.stream,
    });
    const originalQuery = fake.engineClient.query.bind(fake.engineClient);
    fake.engineClient.query = (args) => {
        if (args[0] !== 'image') return originalQuery(args);
        fake.calls.push({ kind: 'query', args: [...args], options: {} });
        return {
            ok: true,
            status: 0,
            stdout: '{',
            stderr: '',
        };
    };
    const raw = createRuntimeSupervisor({
        ...minimalSupervisorDependencies(),
        stdout: stdout.stream,
        stderr: stderr.stream,
        cwd: '/workspace/demo',
        detectEngine: () => 'podman',
        engineClient: fake.engineClient,
    });

    assert.equal(
        await runSupervisorWithBoundary(raw, ['status'], stderr.stream),
        1,
    );
    assert.match(
        stdout.text(),
        /contract: outdated \(expected 1, observed <missing>\)/,
    );
    assert.match(stdout.text(), /health: healthy/);
    assert.match(stdout.text(), /core: running/);
    assert.equal(fake.calls.filter(call =>
        call.kind === 'streamContains' && call.args[0] === 'logs'
    ).length, 1);
    assert.equal(fake.calls.filter(call =>
        call.args[0] === 'exec'
        && call.args.slice(-2).join(' ') === 'ploinky status'
    ).length, 1);
    const forbidden = new Set(['pull', 'run', 'start', 'stop', 'rm', 'volume']);
    assert.equal(
        fake.calls.some(call => forbidden.has(call.args[0])),
        false,
    );
});

test('compatible status prints runtime contract publishes health and core output', async () => {
    const harness = createSupervisorHarness({
        container: compatibleRunningContainer(),
        images: contractV1Images(),
    });
    assert.equal(await harness.supervisor.run(['status']), 0);
    for (const line of [
        'runtime: ploinky-box-demo (running)',
        'image: docker.io/assistos/ploinky-box:podman-node24-runtime-v1',
        'publish: 127.0.0.1:18080 -> 8080/tcp',
        'publish: 127.0.0.1:17880 -> 7880/udp',
        'contract: compatible (expected 1, observed 1)',
        'health: healthy',
        'core: running',
    ]) {
        assert.match(harness.stdout, new RegExp(escapeRegExp(line)));
    }
});

test('stopped status still reports image contract without invoking core', async () => {
    const harness = createSupervisorHarness({
        container: compatibleStoppedContainer(),
        images: contractV1Images(),
    });
    assert.equal(await harness.supervisor.run(['status']), 1);
    assert.match(harness.stdout, /runtime: ploinky-box-demo \(exited\)/);
    assert.match(
        harness.stdout,
        /contract: compatible \(expected 1, observed 1\)/,
    );
    assert.equal(harness.calls.some(call => call.args[0] === 'exec'), false);
});

for (const engine of ['podman', 'docker']) {
    test(engine + ' matching running runtime is reused without pull or recreation', async () => {
        const harness = createSupervisorHarness({
            engine,
            container: compatibleRunningContainer(),
            images: contractV1Images(),
        });
        const code = await harness.supervisor.run(['list', 'agents']);
        assert.equal(code, 0);
        assert.equal(harness.calls.some(call => call.args[0] === 'pull'), false);
        assert.equal(harness.calls.some(call => call.args[0] === 'run'), false);
        assert.equal(harness.calls.some(call => call.args[0] === 'start'), false);
        assert.ok(harness.calls.some(call =>
            call.kind === 'run'
            && call.args[0] === 'exec'
            && call.args.includes('PLOINKY_RUNTIME_NAME=ploinky-box-demo')
            && call.args.slice(-2).join(' ') === 'list agents'
        ));
    });

    test(engine + ' bare host repl forwards to p-cli and returns its status', async () => {
        const stdout = captureWritable();
        const stderr = captureWritable();
        const fake = createFakeEngine({
            engine,
            container: compatibleRunningContainer(),
            images: contractV1Images(),
            stdout: stdout.stream,
            stderr: stderr.stream,
        });
        const originalRun = fake.engineClient.run.bind(fake.engineClient);
        fake.engineClient.run = (args, options = {}) => {
            if (args[0] === 'exec' && args.at(-1) === 'p-cli') {
                fake.calls.push({
                    kind: 'run',
                    args: [...args],
                    options: { ...options },
                });
                return 19;
            }
            return originalRun(args, options);
        };
        const raw = createRuntimeSupervisor({
            ...minimalSupervisorDependencies(),
            stdout: Object.assign(stdout.stream, { isTTY: true }),
            stderr: stderr.stream,
            stdin: { isTTY: true },
            cwd: '/workspace/demo',
            detectEngine: () => engine,
            engineClient: fake.engineClient,
        });

        assert.equal(
            await runSupervisorWithBoundary(raw, [], stderr.stream),
            19,
        );
        const exec = fake.calls.find(call =>
            call.kind === 'run'
            && call.args[0] === 'exec'
            && call.args.at(-1) === 'p-cli'
        );
        assert.ok(exec);
        assert.ok(exec.args.includes('-it'));
        assert.ok(exec.args.includes('PLOINKY_RUNTIME_NAME=ploinky-box-demo'));
        assert.equal(exec.options.allowFail, true);
    });

    test(engine + ' forwarded core nonzero status is returned unchanged', async () => {
        const stdout = captureWritable();
        const stderr = captureWritable();
        const fake = createFakeEngine({
            engine,
            container: compatibleRunningContainer(),
            images: contractV1Images(),
            stdout: stdout.stream,
            stderr: stderr.stream,
        });
        const originalRun = fake.engineClient.run.bind(fake.engineClient);
        fake.engineClient.run = (args, options = {}) => {
            if (
                args[0] === 'exec'
                && args.slice(-3).join(' ') === 'ploinky list agents'
            ) {
                fake.calls.push({
                    kind: 'run',
                    args: [...args],
                    options: { ...options },
                });
                return 17;
            }
            return originalRun(args, options);
        };
        const raw = createRuntimeSupervisor({
            ...minimalSupervisorDependencies(),
            stdout: stdout.stream,
            stderr: stderr.stream,
            cwd: '/workspace/demo',
            detectEngine: () => engine,
            engineClient: fake.engineClient,
        });

        assert.equal(
            await runSupervisorWithBoundary(
                raw,
                ['list', 'agents'],
                stderr.stream,
            ),
            17,
        );
        const exec = fake.calls.find(call =>
            call.kind === 'run'
            && call.args[0] === 'exec'
            && call.args.slice(-3).join(' ') === 'ploinky list agents'
        );
        assert.ok(exec);
        assert.equal(exec.options.allowFail, true);
    });

    test(engine + ' stopped compatible runtime starts without pulling', async () => {
        const harness = createSupervisorHarness({
            engine,
            container: compatibleStoppedContainer(),
            images: contractV1Images(),
        });
        assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
        assert.ok(harness.calls.some(call => call.args[0] === 'start'));
        assert.equal(harness.calls.some(call => call.args[0] === 'pull'), false);
    });

    test(engine + ' missing runtime obtains and validates v1 before create', async () => {
        const harness = createSupervisorHarness({
            engine,
            container: null,
            images: {},
        });
        assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
        assert.deepEqual(
            harness.calls
                .filter(call => ['pull', 'image', 'run'].includes(call.args[0]))
                .map(call => call.args[0]),
            ['image', 'pull', 'image', 'run'],
        );
        const run = harness.calls.find(call => call.args[0] === 'run').args;
        assert.ok(run.includes(REQUIRED_IMAGE));
        assert.ok(run.includes('PLOINKY_RUNTIME_NAME=ploinky-box-demo'));
    });

    test(engine + ' legacy runtime is replaced through the ordinary command path', async () => {
        const harness = createSupervisorHarness({
            engine,
            container: legacyRunningContainerWithCustomConfig(),
            images: {
                'sha256:legacy': legacyImage(),
                [REQUIRED_IMAGE]: contractV1Image(),
            },
        });
        assert.equal(await harness.supervisor.run(['list', 'agents']), 0);
        assert.deepEqual(
            harness.calls
                .filter(call => [
                    'pull',
                    'image',
                    'exec',
                    'stop',
                    'rm',
                    'run',
                ].includes(call.args[0]))
                .map(call => call.args[0])
                .slice(0, 7),
            ['image', 'pull', 'image', 'exec', 'stop', 'rm', 'run'],
        );
    });

    test(engine + ' host bare cli rejects non-tty before runtime mutation', async () => {
        const harness = createSupervisorHarness({
            engine,
            stdin: { isTTY: false },
            stdoutIsTTY: false,
            container: null,
        });
        assert.equal(await harness.supervisor.run(['cli']), 1);
        assert.match(harness.stderr, /requires an interactive terminal/);
        assert.equal(
            harness.calls.some(call =>
                ['pull', 'run', 'start'].includes(call.args[0])
            ),
            false,
        );
    });

    test(engine + ' host agent cli preserves non-tty mode', async () => {
        const harness = createSupervisorHarness({
            engine,
            stdin: { isTTY: false },
            stdoutIsTTY: false,
            container: compatibleRunningContainer(),
            images: contractV1Images(),
        });
        assert.equal(await harness.supervisor.run(['cli', 'explorer']), 0);
        const exec = harness.calls.find(call =>
            call.kind === 'run'
            && call.args[0] === 'exec'
            && call.args.includes('ploinky')
        ).args;
        assert.equal(exec.includes('-it'), false);
        assert.ok(exec.includes('-i'));
        assert.ok(exec.includes('PLOINKY_NO_TTY=1'));
        assert.ok(exec.includes('PLOINKY_RUNTIME_NAME=ploinky-box-demo'));
    });

    test(engine + ' unobtainable replacement image leaves the legacy runtime untouched', async () => {
        const harness = createSupervisorHarness({
            engine,
            container: legacyRunningContainerWithCustomConfig(),
            images: { 'sha256:legacy': legacyImage() },
            failures: { pull: 23 },
        });
        assert.equal(await harness.supervisor.run(['list', 'agents']), 1);
        assert.equal(
            harness.calls.some(call =>
                ['exec', 'stop', 'rm', 'run'].includes(call.args[0])
            ),
            false,
        );
        assert.equal(harness.state.container.inspect.State.Status, 'running');
        assert.match(harness.stderr, /pull.*exited 23/);
    });

    test(engine + ' failed create self-check removes only the failed container', async () => {
        const harness = createSupervisorHarness({
            engine,
            container: null,
            images: {},
            failures: { 'health create': 7 },
        });
        assert.equal(await harness.supervisor.run(['list', 'agents']), 1);
        assert.ok(harness.calls.some(call => call.args[0] === 'rm'));
        assert.equal(harness.calls.some(call => call.args[0] === 'volume'), false);
        assert.equal(harness.calls.some(call =>
            call.kind === 'run'
            && call.args[0] === 'exec'
            && call.args.slice(-2).join(' ') === 'list agents'
        ), false);
        assert.equal(harness.state.container, null);
    });

    test(engine + ' explicit compatible custom image is accepted', async () => {
        const custom = 'registry.example/runtime:custom';
        const harness = createSupervisorHarness({
            engine,
            container: null,
            images: { [custom]: contractV1Image('sha256:custom') },
        });
        assert.equal(
            await harness.supervisor.run([
                '--image',
                custom,
                'list',
                'agents',
            ]),
            0,
        );
        const run = harness.calls.find(call => call.args[0] === 'run').args;
        assert.equal(run.at(-1), custom);
    });

    for (const [name, image, observed] of [
        ['missing label', legacyImage('sha256:no-label'), '<missing>'],
        [
            'wrong label',
            {
                Id: 'sha256:wrong-label',
                Config: {
                    Labels: {
                        'io.assistos.ploinky.runtime-contract': '2',
                    },
                },
            },
            '2',
        ],
    ]) {
        test(engine + ' explicit custom image rejects ' + name + ' before runtime mutation', async () => {
            const custom = 'registry.example/runtime:' + name.replace(' ', '-');
            const harness = createSupervisorHarness({
                engine,
                container: null,
                images: { [custom]: image },
            });
            assert.equal(
                await harness.supervisor.run([
                    '--image',
                    custom,
                    'list',
                    'agents',
                ]),
                1,
            );
            assert.match(harness.stderr, new RegExp(escapeRegExp(custom)));
            assert.match(
                harness.stderr,
                /io\.assistos\.ploinky\.runtime-contract=1/,
            );
            assert.match(
                harness.stderr,
                new RegExp('observed ' + escapeRegExp(observed)),
            );
            assert.equal(
                harness.calls.some(call =>
                    ['run', 'start', 'stop', 'rm'].includes(call.args[0])
                ),
                false,
            );
        });
    }

    test(engine + ' invalid explicit custom image leaves an existing v1 runtime untouched', async () => {
        const custom = 'registry.example/runtime:invalid';
        const harness = createSupervisorHarness({
            engine,
            container: compatibleRunningContainer(),
            images: contractV1Images(),
            pullImages: {
                [custom]: legacyImage('sha256:invalid-custom'),
            },
        });
        assert.equal(
            await harness.supervisor.run([
                '--image',
                custom,
                'list',
                'agents',
            ]),
            1,
        );
        assert.match(harness.stderr, /observed <missing>/);
        assert.equal(
            harness.calls.some(call =>
                ['exec', 'stop', 'rm', 'run'].includes(call.args[0])
            ),
            false,
        );
        assert.equal(harness.state.container.inspect.State.Status, 'running');
    });

    test(engine + ' omitted incompatible custom image contract is validated without silently replacing its reference', async () => {
        const custom = 'registry.example/runtime:current';
        const container = compatibleRunningContainer();
        container.inspect.Config.Image = custom;
        container.inspect.Image = 'sha256:custom-old';
        const harness = createSupervisorHarness({
            engine,
            container,
            images: {
                'sha256:custom-old': legacyImage('sha256:custom-old'),
            },
            pullImages: {
                [custom]: legacyImage('sha256:custom-new'),
            },
        });
        assert.equal(await harness.supervisor.run(['list', 'agents']), 1);
        const pull = harness.calls.find(call => call.args[0] === 'pull').args;
        assert.equal(pull[1], custom);
        assert.equal(pull.includes(REQUIRED_IMAGE), false);
        assert.equal(
            harness.calls.some(call =>
                ['exec', 'stop', 'rm', 'run'].includes(call.args[0])
            ),
            false,
        );
    });
}

test('source-owned runtime marker is absent', () => {
    assert.equal(fs.existsSync(path.join(HERE, 'ploinky-box-marker')), false);
});

test('public help contains no compatibility surface', () => {
    const help = publicUsageText();
    assert.doesNotMatch(help, /ploinky box/);
    assert.doesNotMatch(help, /ploinky-box\s/);
    assert.doesNotMatch(help, /\bup\b|\bupdate\b|\bcp\b/);
});

for (const argv of [['help'], ['--help'], ['-h']]) {
    test('host help alias ' + argv[0] + ' returns before engine detection', async () => {
        let detections = 0;
        const stderr = captureWritable();
        const raw = createRuntimeSupervisor({
            ...minimalSupervisorDependencies(),
            detectEngine: () => {
                detections += 1;
                throw new Error('must not be called');
            },
        });
        assert.equal(
            await runSupervisorWithBoundary(raw, argv, stderr.stream),
            0,
        );
        assert.equal(detections, 0);
    });
}

test('ordinary command reports missing host engine before mutation', async () => {
    const calls = [];
    const stderr = captureWritable();
    const raw = createRuntimeSupervisor({
        ...minimalSupervisorDependencies(),
        detectEngine: () => null,
        spawnSyncImpl: (...args) => calls.push(args),
    });
    assert.equal(
        await runSupervisorWithBoundary(raw, ['list', 'agents'], stderr.stream),
        1,
    );
    assert.match(stderr.text(), /requires Podman or Docker on the host/);
    assert.deepEqual(calls, []);
});

test('host launcher delegates directly to the public-only supervisor', () => {
    const launcher = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'ploinky'), 'utf8');
    assert.match(
        launcher,
        /exec node "\$ROOT_DIR\/container\/runtime-supervisor\.mjs" "\$@"/,
    );
    assert.doesNotMatch(launcher, /PLOINKY_PUBLIC_ENTRYPOINT/);
    assert.doesNotMatch(launcher, /container\/ploinky-box\.mjs/);
});

test('runtime-supervisor.mjs syntax check (node --check)', () => {
    const r = spawnSync(process.execPath, ['--check', MJS], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
});

test('runtime-supervisor.mjs main guard works through a symlink', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-supervisor-test-'));
    const link = path.join(tmp, 'supervisor-link.mjs');
    try {
        fs.symlinkSync(MJS, link);
        const r = spawnSync(process.execPath, [link, '-h'], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.stdout.includes('Usage: ploinky [flags] [command] [args]'), r.stdout);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('parseHostInvocation: global flags and first non-flag command', () => {
    const cfg = parseHostInvocation(['--name', 'qa', '--dry-run', 'list', 'agents'], {});
    assert.equal(cfg.command, 'list');
    assert.deepEqual(cfg.args, ['agents']);
    assert.equal(cfg.name, 'qa');
    assert.equal(cfg.dryRun, true);
    assert.deepEqual([...cfg.explicit], ['--name', '--dry-run']);
});

test('parseHostInvocation: PLOINKY_BOX_ENGINE env seeds the engine, --engine overrides', () => {
    assert.equal(parseHostInvocation([], { PLOINKY_BOX_ENGINE: 'docker' }).engine, 'docker');
    assert.equal(parseHostInvocation(['--engine', 'podman'], { PLOINKY_BOX_ENGINE: 'docker' }).engine, 'podman');
});

test('public start infers non-default source branch unless branch flags are explicit', () => {
    assert.deepEqual(
        inferPublicStartBranchArgs(['explorer'], { PLOINKY_BOX_BRANCH: 'feature-x' }, REPO_ROOT),
        ['--branch', 'feature-x'],
    );
    assert.deepEqual(
        inferPublicStartBranchArgs(['explorer'], { PLOINKY_BOX_BRANCH: 'main' }, REPO_ROOT),
        [],
    );
    assert.deepEqual(
        inferPublicStartBranchArgs(['explorer', '--branch', 'manual'], { PLOINKY_BOX_BRANCH: 'feature-x' }, REPO_ROOT),
        [],
    );
    assert.deepEqual(
        inferPublicStartBranchArgs(['explorer'], { PLOINKY_BOX_BRANCH: 'feature-x', PLOINKY_BOX_AUTO_BRANCH: '0' }, REPO_ROOT),
        [],
    );
});

test('resolveHostPloinkySource: PLOINKY_BOX_SOURCE override wins, defaults to the checkout', () => {
    assert.equal(resolveHostPloinkySource({}), REPO_ROOT);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-src-'));
    try {
        for (const marker of ['bin', 'cli', 'globalDeps']) fs.mkdirSync(path.join(tmp, marker));
        fs.writeFileSync(path.join(tmp, 'bin', 'ploinky'), '#!/usr/bin/env bash\n');
        fs.writeFileSync(path.join(tmp, 'cli', 'index.js'), '// stub\n');
        fs.writeFileSync(path.join(tmp, 'globalDeps', 'package.json'), '{}\n');
        assert.equal(resolveHostPloinkySource({ PLOINKY_BOX_SOURCE: tmp }), path.resolve(tmp));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('automatic runtime preparation reports an invalid PLOINKY_BOX_SOURCE', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-notsrc-'));
    try {
        const r = spawnSync(MJS, ['--name', 'qa', '--dry-run', 'list', 'agents'], {
            encoding: 'utf8',
            env: { ...process.env, PLOINKY_BOX_ENGINE: 'podman', PLOINKY_BOX_SOURCE: tmp },
        });
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        assert.equal(r.status, 1, out);
        checkIncludes(out, 'ploinky source not found', 'invalid source dies');
        checkIncludes(out, 'PLOINKY_BOX_SOURCE', 'error names the escape hatch');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('parseHostInvocation: repeatable --publish and --expose accumulate in order', () => {
    const cfg = parseHostInvocation([
        '--publish', '127.0.0.1:1:1',
        '--expose', '127.0.0.1:2:2',
        '--publish', '127.0.0.1:3:3',
        'list', 'agents',
    ], {});
    assert.deepEqual(cfg.publish, ['127.0.0.1:1:1', '127.0.0.1:2:2', '127.0.0.1:3:3']);
    assert.deepEqual([...cfg.explicit], ['--publish', '--expose']);
    assert.equal(Object.hasOwn(cfg, 'webmeetPorts'), false);
});

test('automatic runtime creation rejects publishes outside the TCP and UDP range', () => {
    const { out, status } = publicRun(
        'podman',
        '--name', 'qa',
        '--dry-run',
        '--publish', '0.0.0.0:70000:70000',
        'list', 'agents',
    );
    assert.equal(status, 1, out);
    checkIncludes(out, "invalid --publish '0.0.0.0:70000:70000'", 'invalid publish is rejected');
});

test('instance and volume naming', () => {
    const named = parseHostInvocation(['--name', 'qa'], {});
    assert.equal(instanceName(named), 'ploinky-box-qa');
    assert.deepEqual(volumeNames(named), {
        workspace: 'ploinky-box-qa-workspace',
        containers: 'ploinky-box-qa-containers',
        deps: 'ploinky-box-qa-ploinky-deps',
    });
});

test('volume naming includes the deps volume', () => {
    const named = parseHostInvocation(['--name', 'qa'], {});
    assert.deepEqual(volumeNames(named), {
        workspace: 'ploinky-box-qa-workspace',
        containers: 'ploinky-box-qa-containers',
        deps: 'ploinky-box-qa-ploinky-deps',
    });
});

test('buildRuntimeRunArgs: selinux label only when the engine reports it; image is last', () => {
    const cfg = parseHostInvocation([], {});
    const plain = buildArgsForInvocation(cfg, { selinux: false });
    const labeled = buildArgsForInvocation(cfg, { selinux: true });
    assert.ok(!plain.join(' ').includes('label=disable'));
    assert.ok(labeled.join(' ').includes('--security-opt label=disable'));
    assert.equal(plain[plain.length - 1], REQUIRED_IMAGE);
    assert.ok(plain.includes('--privileged'));
});

test('buildRuntimeRunArgs: explicit publish spelling stays exact while config is normalized', () => {
    const cases = [
        {
            raw: '8081',
            normalized: {
                hostIp: '', hostPort: '', containerPort: '8081', protocol: 'tcp',
            },
        },
        {
            raw: '18081:8081',
            normalized: {
                hostIp: '', hostPort: '18081', containerPort: '8081', protocol: 'tcp',
            },
        },
        {
            raw: '18081:8081/tcp',
            normalized: {
                hostIp: '', hostPort: '18081', containerPort: '8081', protocol: 'tcp',
            },
        },
        {
            raw: '127.0.0.1:18081:8081',
            normalized: {
                hostIp: '127.0.0.1', hostPort: '18081', containerPort: '8081', protocol: 'tcp',
            },
        },
        {
            raw: '127.0.0.1:18081:08081',
            normalized: {
                hostIp: '127.0.0.1', hostPort: '18081', containerPort: '8081', protocol: 'tcp',
            },
        },
        {
            raw: '127.0.0.1::8081',
            normalized: {
                hostIp: '127.0.0.1', hostPort: '', containerPort: '8081', protocol: 'tcp',
            },
        },
    ];

    for (const expected of cases) {
        const invocation = parseHostInvocation([
            '--publish', expected.raw,
        ], {});
        invocation.name ||= 'demo';
        invocation.sourceDirResolved ||= REPO_ROOT;
        const config = createDefaultRuntimeConfig(invocation);
        assert.deepEqual(config.extraPublishes, [expected.normalized]);

        const args = buildRuntimeRunArgs(config, {
            engine: 'podman',
            selinux: false,
        });
        const publishTokens = args.flatMap((token, index) =>
            token === '-p' ? [args[index + 1]] : []
        );
        assert.deepEqual(publishTokens, [
            '127.0.0.1:8080:8080',
            expected.raw,
        ]);
    }

    const canonicalInvocation = parseHostInvocation([], {});
    canonicalInvocation.name ||= 'demo';
    canonicalInvocation.sourceDirResolved ||= REPO_ROOT;
    const canonicalConfig = createDefaultRuntimeConfig(canonicalInvocation);
    canonicalConfig.extraPublishes = mergeAndValidatePublishes([{
        hostIp: '127.0.0.1',
        hostPort: '',
        containerPort: '8081',
        protocol: 'tcp',
    }]);
    const canonicalArgs = buildRuntimeRunArgs(canonicalConfig, {
        engine: 'podman',
        selinux: false,
    });
    const canonicalPublishes = canonicalArgs.flatMap((token, index) =>
        token === '-p' ? [canonicalArgs[index + 1]] : []
    );
    assert.deepEqual(canonicalPublishes, [
        '127.0.0.1:8080:8080',
        '127.0.0.1::8081',
    ]);
});

test('buildRuntimeRunArgs: null router keeps exact raw extra publish spelling', () => {
    const invocation = parseHostInvocation([
        '--publish', '18081:8081/tcp',
    ], {});
    invocation.name ||= 'demo';
    invocation.sourceDirResolved ||= REPO_ROOT;
    const config = createDefaultRuntimeConfig(invocation);
    config.routerPublish = null;

    const args = buildRuntimeRunArgs(config, {
        engine: 'podman',
        selinux: false,
    });
    const publishTokens = args.flatMap((token, index) =>
        token === '-p' ? [args[index + 1]] : []
    );
    assert.deepEqual(publishTokens, ['18081:8081/tcp']);
});

test('buildRuntimeRunArgs: read-only source mount plus writable deps volume', () => {
    const podmanCfg = parseHostInvocation(['--engine', 'podman'], {});
    const podmanArgs = buildArgsForInvocation(podmanCfg, { selinux: false }).join(' ');
    assert.ok(podmanArgs.includes(`-v ${REPO_ROOT}:/opt/ploinky:ro`), podmanArgs);
    assert.ok(!podmanArgs.includes('ploinky-box-marker'), podmanArgs);
    assert.ok(!podmanArgs.includes(':/etc/ploinky-box'), podmanArgs);
    assert.ok(podmanArgs.includes('-ploinky-deps:/opt/ploinky/node_modules:U'), podmanArgs);
    assert.ok(!podmanArgs.includes('/workspace:ro'), 'workspace stays writable');
    assert.ok(!podmanArgs.includes('PLOINKY_BOX='), 'no PLOINKY_BOX env injection');

    const dockerCfg = parseHostInvocation(['--engine', 'docker'], {});
    const dockerArgs = buildArgsForInvocation(dockerCfg, { selinux: false }).join(' ');
    assert.ok(dockerArgs.includes('-ploinky-deps:/opt/ploinky/node_modules '), dockerArgs);
    assert.ok(!dockerArgs.includes(':U'), 'docker gets no :U volume option');
});

test('automatic runtime preparation fixes Docker deps ownership; Podman relies on :U', () => {
    const docker = publicRun('docker', '--dry-run', '--name', 'qa', 'list', 'agents');
    checkIncludes(docker.out, 'exec --user root ploinky-box-qa chown podman:podman /opt/ploinky/node_modules',
        'Docker preparation chowns the fresh deps volume');
    const podman = publicRun('podman', '--dry-run', '--name', 'qa', 'list', 'agents');
    checkAbsent(podman.out, 'chown podman:podman /opt/ploinky/node_modules', 'Podman preparation needs no chown (:U)');
});

test('shouldInstallDeps: explicit env opt-in, TTY confirm, default no', () => {
    assert.equal(shouldInstallDeps({ PLOINKY_BOX_INSTALL_DEPS: '1' }, false, null), true);
    assert.equal(shouldInstallDeps({}, true, 'y'), true);
    assert.equal(shouldInstallDeps({}, true, 'Y'), true);
    assert.equal(shouldInstallDeps({}, true, 'n'), false);
    assert.equal(shouldInstallDeps({}, true, ''), false);
    assert.equal(shouldInstallDeps({}, true, null), false);
    assert.equal(shouldInstallDeps({}, false, 'y'), false); // non-TTY never installs from a piped reply
});

test('dependency flow source contract: fatal public decline, docker chown is mandatory', () => {
    const source = fs.readFileSync(MJS, 'utf8');
    checkIncludes(source, 'export async function reconcileRuntime(',
        'the automatic runtime capability owns dependency preparation');
    checkIncludes(source, "throw new SupervisorError('Ploinky dependencies are required before running this command')",
        'declined public commands throw through the shared boundary');
    checkIncludes(source, 'const runtime = await reconcileRuntime(invocation, {',
        'ordinary public commands require dependencies before forwarding');
    checkAbsent(source, 'process.exit(', 'helper-level process exits are removed');
    checkAbsent(source, "chown', 'podman:podman', '/opt/ploinky/node_modules'], { allowFail: true",
        'docker deps chown failures are not ignored');
});

test('automatic runtime preparation exits nonzero when dependency install is declined noninteractively', () => {
    const fake = makeFakePodmanForMissingDeps();
    try {
        const r = spawnSync(MJS, ['--name', 'qa', '--port', '18349', 'list', 'agents'], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fake.dir}:${process.env.PATH || ''}`,
                PLOINKY_BOX_ENGINE: 'podman',
                PLOINKY_BOX_INSTALL_DEPS: '',
            },
            input: '',
        });
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        assert.equal(r.status, 1, out);
        checkIncludes(out, 'WARNING: Ploinky cannot run until dependencies are installed.', 'declined deps warning is emitted');
        const calls = fs.readFileSync(fake.calls, 'utf8');
        checkAbsent(calls, '/opt/ploinky/bin/ploinky-install-deps', 'decline must not run the installer');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('buildRuntimeRunArgs: mount is appended only when set, before the image', () => {
    const cfg = parseHostInvocation(['--mount', '/tmp'], {});
    cfg.mountDirResolved = '/tmp';
    const args = buildArgsForInvocation(cfg, { selinux: false });
    const mountIndex = args.indexOf('/tmp:/workspace/mounted');
    assert.equal(args[mountIndex - 1], '-v');
    assert.ok(mountIndex < args.indexOf('-e'));
    assert.ok(mountIndex < args.length - 1);
});

test('bin/ploinky bash syntax and single-entry contract', () => {
    const r = spawnSync('bash', ['-n', PLOINKY], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const entry = fs.readFileSync(PLOINKY, 'utf8');
    assert.ok(entry.includes('/etc/ploinky-box'), 'entry routes on the image marker file');
    assert.ok(entry.includes('PLOINKY_WORKSPACE_ROOT'), 'entry supports older images that lack the marker file');
    assert.ok(entry.includes('/opt/ploinky'), 'entry limits marker fallback to the mounted box source path');
    assert.ok(entry.includes('Ploinky dependencies are not installed. Install them now? [y/N]'), 'entry carries the confirm prompt');
    assert.ok(entry.includes('Ploinky cannot run until dependencies are installed.'), 'entry carries the decline warning');
    assert.ok(entry.includes('ploinky-install-deps'), 'entry points at the installer');
    assert.ok(entry.includes('cli/index.js'), 'in-box branch execs the CLI');
    assert.ok(!entry.includes('PLOINKY_DIRECT'), 'PLOINKY_DIRECT is gone');
    assert.ok(!entry.includes('PLOINKY_BOX'), 'PLOINKY_BOX routing is gone');
    assert.ok(!entry.includes('ploinky-direct'), 'ploinky-direct is gone');
});

test('bin/ploinky-install-deps recognizes the same in-box context', () => {
    const installer = fs.readFileSync(path.join(HERE, '..', 'bin', 'ploinky-install-deps'), 'utf8');
    assert.ok(installer.includes('/etc/ploinky-box'), 'installer honors the image marker file');
    assert.ok(installer.includes('PLOINKY_WORKSPACE_ROOT'), 'installer supports older images that lack the marker file');
    assert.ok(installer.includes('/opt/ploinky'), 'installer limits marker fallback to the mounted box source path');
    assert.ok(installer.includes('PLOINKY_INSTALL_DEPS_ALLOW_RESET'), 'installer keeps the explicit reset override');
});

test('bin/ploinky-direct is deleted', () => {
    assert.ok(!fs.existsSync(path.join(HERE, '..', 'bin', 'ploinky-direct')), 'ploinky-direct must not exist');
});

test('public status inspects the inferred runtime without creating it', () => {
    const { parent, dir } = makeCwd('testExplorerFresh');
    const fake = makeMissingStatusEngine();
    try {
        const { out, status } = publicRunInWithEnv(
            dir,
            { PATH: `${fake.dir}:${process.env.PATH || ''}` },
            'podman',
            '--dry-run',
            'status',
        );
        assert.equal(status, 1, out);
        checkIncludes(out, 'runtime: ploinky-box-testExplorerFresh (missing)', 'status resolves the inferred runtime');
        checkAbsent(out, 'DRY-RUN: podman run -d', 'status does not create the runtime');
        checkAbsent(out, ' podman start ', 'status does not start the runtime');
        assert.equal(
            fs.readFileSync(fake.calls, 'utf8').trim(),
            'container inspect ploinky-box-testExplorerFresh',
        );
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('public destroy targets the outer volume destroy command', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'destroy');
    assert.equal(status, 0, out);
    checkIncludes(out, 'volume rm ploinky-box-qa-workspace ploinky-box-qa-containers ploinky-box-qa-ploinky-deps', 'public destroy removes outer volumes');
    checkIncludes(out, "'ploinky-box-qa' and its volumes removed.", 'public destroy uses outer destroy behavior');
    checkAbsent(out, 'DRY-RUN: podman run -d', 'public destroy does not create/start the box first');
    checkAbsent(out, 'exec -w /workspace ploinky-box-qa ploinky destroy', 'public destroy does not run in-box destroy');
});

test('public destroy honors --name after the command for the outer box', () => {
    const { out, status } = publicRun('podman', '--dry-run', 'destroy', '--name', 'qa');
    assert.equal(status, 0, out);
    checkIncludes(out, 'volume rm ploinky-box-qa-workspace ploinky-box-qa-containers ploinky-box-qa-ploinky-deps', 'post-command --name selects outer volumes');
    checkIncludes(out, "'ploinky-box-qa' and its volumes removed.", 'post-command --name uses outer destroy behavior');
    checkAbsent(out, 'ploinky destroy --name qa', 'post-command --name is not forwarded in-box');
    checkAbsent(out, 'exec -w /workspace ploinky-box-qa ploinky destroy', 'post-command --name does not run in-box destroy');
});

test('public no-arg command opens the in-runtime Ploinky REPL', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run');
    assert.equal(status, 0, out);
    checkIncludes(out, 'DRY-RUN: podman run -d', 'no-arg public command ensures the runtime');
    checkIncludes(
        out,
        'exec -i -e PLOINKY_RUNTIME_NAME=ploinky-box-qa -w /workspace ploinky-box-qa p-cli',
        'no-arg public command opens the Ploinky REPL through p-cli',
    );
});

test('public start preserves branch flags while forcing in-box router to 8080', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', 'explorer',
            '--branch', 'feature-x',
            '9191',
            '--repo-branch', 'AssistOSExplorer=peristo-user',
            '--branch-fallback', 'fail',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '127.0.0.1:9191:8080', 'public start positional port is host port');
        checkIncludes(
            out,
            'exec -e PLOINKY_RUNTIME_NAME=ploinky-box-qa -w /workspace ploinky-box-qa ploinky start explorer 8080 --profile default --branch feature-x --repo-branch AssistOSExplorer=peristo-user --branch-fallback fail',
            'public start forwards branch flags after in-box port',
        );
        checkAbsent(out, 'ploinky start explorer 9191', 'public start never uses host port inside');
    } finally {
        source.cleanup();
    }
});

test('public start forwards inferred source branch when no branch flag is supplied', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            {
                PLOINKY_BOX_BRANCH: 'feature-default',
                PLOINKY_BOX_SOURCE: source.sourceDir,
            },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(
            out,
            'exec -e PLOINKY_RUNTIME_NAME=ploinky-box-qa -w /workspace ploinky-box-qa ploinky start explorer 8080 --profile default --branch feature-default',
            'public start appends the inferred branch after the fixed in-box port',
        );
    } finally {
        source.cleanup();
    }
});

test('public start explorer publishes graph-derived openPorts only', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '-p 127.0.0.1:8081:8081', 'Explorer start publishes Web Publishing nginx');
        checkIncludes(out, '-p 127.0.0.1:7881:7881', 'Explorer start publishes LiveKit direct TCP media-plane port');
        checkIncludes(out, '-p 127.0.0.1:3478:3478', 'Explorer start publishes TURN TCP');
        checkIncludes(out, '-p 127.0.0.1:3478:3478/udp', 'Explorer start publishes TURN UDP');
        checkIncludes(out, '-p 127.0.0.1:7882-7892:7882-7892/udp', 'Explorer start publishes LiveKit UDP media range');
        checkIncludes(out, '-p 127.0.0.1:20000-20010:20000-20010/udp', 'Explorer start publishes TURN relay range');
        checkAbsent(out, '-p 127.0.0.1:8082:8082', 'Explorer start does not publish OnlyOffice directly');
        checkAbsent(out, '-p 127.0.0.1:7681:7681', 'Explorer start does not publish webtty directly');
        checkAbsent(out, '-p 127.0.0.1:17000:17000', 'Explorer start does not publish LiveKit health directly');
        checkAbsent(out, '-p 127.0.0.1:7880:7880', 'Explorer start does not publish LiveKit signaling directly');
        checkAbsent(out, '-p 127.0.0.1:6379:6379', 'Explorer start does not publish Redis by default');
    } finally {
        source.cleanup();
    }
});

test('public start only adds Explorer default publishes for the explorer agent', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'start', 'demo');
    assert.equal(status, 0, out);
    checkIncludes(out, 'exec -e PLOINKY_RUNTIME_NAME=ploinky-box-qa -w /workspace ploinky-box-qa ploinky start demo 8080', 'non-Explorer start still runs inside');
    checkAbsent(out, '-p 127.0.0.1:7880:7880', 'non-Explorer start does not get Explorer LiveKit publish');
    checkAbsent(out, '-p 127.0.0.1:8081:8081', 'non-Explorer start does not get Explorer Web Publishing publish');
});

test('public start explorer preserves explicit publishes and skips conflicting defaults', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', '0.0.0.0:3478:3478/udp',
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '-p 0.0.0.0:3478:3478/udp', 'explicit TURN UDP publish is preserved');
        checkAbsent(out, '-p 127.0.0.1:3478:3478/udp', 'derived TURN UDP publish is skipped for the same target');
        checkIncludes(out, '-p 127.0.0.1:3478:3478', 'same port with a different protocol is still added');
    } finally {
        source.cleanup();
    }
});

test('public start explorer does not duplicate an exact explicit default publish', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', '127.0.0.1:3478:3478/udp',
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        assert.equal(countOccurrences(out, '-p 127.0.0.1:3478:3478/udp'), 1, out);
    } finally {
        source.cleanup();
    }
});

test('public start preserves every supported explicit publish form and suppresses the canonical TCP target', () => {
    const cases = [
        '8081',
        '18081:8081',
        '18081:8081/tcp',
        '127.0.0.1:18081:8081',
    ];
    for (const explicit of cases) {
        const source = makeFakePloinkyGraphSource();
        try {
            const { out, status } = publicRunWithEnv(
                { PLOINKY_BOX_SOURCE: source.sourceDir },
                'podman',
                '--name', 'qa',
                '--dry-run',
                '--publish', explicit,
                'start', 'explorer',
            );
            assert.equal(status, 0, out);
            const publishes = dryRunPublishTokens(out);
            assert.ok(
                publishes.includes(explicit),
                `explicit publish '${explicit}' is passed through byte-for-byte\n  in: ${out}`,
            );
            assert.ok(
                !publishes.includes('127.0.0.1:8081:8081'),
                `explicit publish '${explicit}' suppresses generated 8081/tcp\n  in: ${out}`,
            );
        } finally {
            source.cleanup();
        }
    }
});

test('public start preserves an engine protocol outside the manifest TCP/UDP policy', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const explicit = '127.0.0.1:18081:8081/sctp';
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', explicit,
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, `-p ${explicit}`, 'explicit SCTP publish is left for the engine to interpret');
        checkIncludes(out, '-p 127.0.0.1:8081:8081', 'SCTP does not suppress generated TCP at the same target');
    } finally {
        source.cleanup();
    }
});

test('public start canonicalizes leading zeroes only for suppression and never rewrites the raw explicit value', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const explicit = '127.0.0.1:18081:08081';
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', explicit,
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        const publishes = dryRunPublishTokens(out);
        assert.ok(
            publishes.includes(explicit),
            `the engine receives the exact leading-zero publish\n  in: ${out}`,
        );
        assert.ok(
            !publishes.includes('127.0.0.1:8081:8081'),
            `leading zeroes cannot bypass generated-target suppression\n  in: ${out}`,
        );
    } finally {
        source.cleanup();
    }
});

test('public start suppresses an overlapping generated single port when the explicit target is a range', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const explicit = '18080-18090:8080-8090';
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', explicit,
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, `-p ${explicit}`, 'the explicit range is preserved');
        checkAbsent(out, '-p 127.0.0.1:8081:8081', 'the overlapping generated single port is suppressed');
    } finally {
        source.cleanup();
    }
});

test('public start suppresses the whole generated range when an explicit single target overlaps it', () => {
    const source = makeFakePloinkyGraphSource({
        webPublishingOpenPorts: ['127.0.0.1:9000-9010:9000-9010'],
    });
    try {
        const explicit = '19001:9001';
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', explicit,
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, `-p ${explicit}`, 'the explicit single-port publish is preserved');
        checkAbsent(out, '127.0.0.1:9000-9010:9000-9010', 'the overlapping generated range is not emitted');
        checkAbsent(out, '127.0.0.1:9000:9000', 'the generated range is not split below the overlap');
        checkAbsent(out, '127.0.0.1:9002-9010:9002-9010', 'the generated range is not split above the overlap');
    } finally {
        source.cleanup();
    }
});

test('public start keeps generated UDP when an explicit TCP target uses the same port', () => {
    const source = makeFakePloinkyGraphSource({
        webPublishingOpenPorts: ['127.0.0.1:8081:8081/udp'],
    });
    try {
        const explicit = '18081:8081/tcp';
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', explicit,
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '-p 18081:8081', 'the explicit TCP publish is preserved');
        checkIncludes(out, '-p 127.0.0.1:8081:8081/udp', 'same-number UDP remains independent');
    } finally {
        source.cleanup();
    }
});

test('public qualified Explorer start plans and forwards one explicit development profile', () => {
    const source = makeFakePloinkyGraphSource({
        webPublishingProfiles: {
            default: {
                openPorts: ['127.0.0.1:8081:8081'],
            },
            dev: {
                openPorts: ['127.0.0.1:9081:8081'],
            },
        },
    });
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', 'AchillesIDE/explorer', '8080', '--profile', 'DEV',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '-p 127.0.0.1:9081:9081', 'the dev openPorts mapping is selected');
        checkAbsent(out, '-p 127.0.0.1:8081:8081', 'the default-only mapping is replaced');
        checkIncludes(
            out,
            'exec -e PLOINKY_RUNTIME_NAME=ploinky-box-qa -w /workspace ploinky-box-qa ploinky start AchillesIDE/explorer 8080 --profile dev',
            'the normalized planner profile reaches the in-box start command',
        );
    } finally {
        source.cleanup();
    }
});

test('public bare Explorer start ignores host profile state and plans and forwards default', () => {
    const source = makeFakePloinkyGraphSource({
        webPublishingProfiles: {
            default: {
                openPorts: ['127.0.0.1:8081:8081'],
            },
            dev: {
                openPorts: ['127.0.0.1:9081:8081'],
            },
        },
    });
    try {
        const { out, status } = publicRunWithEnv(
            {
                PLOINKY_BOX_SOURCE: source.sourceDir,
                PLOINKY_PROFILE: 'dev',
            },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '-p 127.0.0.1:8081:8081', 'omission selects the default publish graph');
        checkAbsent(out, '-p 127.0.0.1:9081:9081', 'host profile state does not select dev');
        checkIncludes(
            out,
            'exec -e PLOINKY_RUNTIME_NAME=ploinky-box-qa -w /workspace ploinky-box-qa ploinky start explorer 8080 --profile default',
            'omission explicitly forwards default in-box',
        );
    } finally {
        source.cleanup();
    }
});

test('public start accepts --profile=value before the agent and does not treat it as positional', () => {
    const source = makeFakePloinkyGraphSource({
        webPublishingProfiles: {
            default: { openPorts: ['127.0.0.1:8081:8081'] },
            dev: { openPorts: ['127.0.0.1:9081:8081'] },
        },
    });
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', '--profile=dev', 'AssistOSExplorer/explorer', '9191',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '127.0.0.1:9191:8080', 'the positional host port remains aligned');
        checkIncludes(
            out,
            'ploinky start AssistOSExplorer/explorer 8080 --profile dev',
            'the profile option is consumed and forwarded canonically',
        );
        checkAbsent(out, 'ploinky start dev 8080', 'the profile value never becomes the agent positional');
    } finally {
        source.cleanup();
    }
});

test('ploinky-box source does not hardcode Explorer publish topology', () => {
    const source = fs.readFileSync(MJS, 'utf8');
    const oldPublishConstant = ['EXPLORER', 'START', 'PUBLISH', 'SPECS'].join('_');
    const oldExplorerEnv = ['PLOINKY', 'BOX', 'EXPLORER', 'PORTS'].join('_');
    const oldPortMetadata = ['box', 'Publish'].join('');
    assert.equal(source.includes(oldPublishConstant), false);
    assert.equal(source.includes(oldExplorerEnv), false);
    assert.equal(source.includes('127.0.0.1:8082:8082'), false);
    assert.equal(source.includes(oldPortMetadata), false);
});

test('public start accepts --port before the agent without forwarding it in-box', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', '--port', '9191', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '127.0.0.1:9191:8080', 'post-command --port before agent is the host port');
        checkIncludes(out, 'exec -e PLOINKY_RUNTIME_NAME=ploinky-box-qa -w /workspace ploinky-box-qa ploinky start explorer 8080', 'agent remains explorer');
        checkAbsent(out, 'ploinky start 9191 8080 --port explorer', 'post-command --port does not reorder into in-box args');
    } finally {
        source.cleanup();
    }
});

test('public start accepts --port after the agent without forwarding it in-box', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', 'explorer', '--port', '9192',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '127.0.0.1:9192:8080', 'post-command --port after agent is the host port');
        checkIncludes(out, 'exec -e PLOINKY_RUNTIME_NAME=ploinky-box-qa -w /workspace ploinky-box-qa ploinky start explorer 8080', 'agent remains explorer');
        checkAbsent(out, 'ploinky start explorer 8080 --port 9192', 'post-command --port is not forwarded in-box');
    } finally {
        source.cleanup();
    }
});

test('public start without an agent forwards in-box start instead of wrapper failing', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'start');
    assert.equal(status, 0, out);
    checkIncludes(out, 'exec -e PLOINKY_RUNTIME_NAME=ploinky-box-qa -w /workspace ploinky-box-qa ploinky start', 'start with no args is forwarded');
    checkAbsent(out, 'usage:', 'public start without args is not rejected by the wrapper');
});

test('public command hoists --expose after the command without forwarding it in-box', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'list', 'agents', '--expose', '127.0.0.1:9090:9090');
    assert.equal(status, 0, out);
    checkIncludes(out, '-p 127.0.0.1:9090:9090', 'public post-command --expose publishes a runtime port');
    checkIncludes(out, 'exec -e PLOINKY_RUNTIME_NAME=ploinky-box-qa -w /workspace ploinky-box-qa ploinky list agents', 'ordinary command still reaches core');
    checkAbsent(out, 'ploinky list agents --expose 127.0.0.1:9090:9090', 'post-command --expose is not forwarded in-box');
});

test('public ploinky forwards registered non-lifecycle CLI commands into the runtime', () => {
    const registry = getCommandRegistry();
    assert.equal(registry.box, undefined, 'box is not a registered core command');

    for (const command of Object.keys(registry)) {
        if (['help', 'status', 'stop', 'destroy', 'cli'].includes(command)) {
            continue;
        }
        const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', command);
        assert.equal(status, 0, `${command}\n${out}`);
        checkIncludes(out, 'DRY-RUN: podman run -d', `${command}: public command ensures the box`);

        const ttyFlag = command === 'shell' ? '-i ' : '';
        checkIncludes(
            out,
            `exec ${ttyFlag}-e PLOINKY_RUNTIME_NAME=ploinky-box-qa -w /workspace ploinky-box-qa ploinky ${command}`,
            `${command}: public command forwards to in-box ploinky`,
        );
    }
});

test('public parser preserves normal command flags after the command', () => {
    const cfg = parseHostInvocation(['client', 'tool', 'process', '--dry-run'], {});
    assert.equal(cfg.command, 'client');
    assert.deepEqual(cfg.args, ['tool', 'process', '--dry-run']);
    assert.equal(cfg.dryRun, false);
});

test('public parser hoists runtime selector flags after the command', () => {
    const cfg = parseHostInvocation(['destroy', '--name', 'qa', '--expose', '127.0.0.1:9090:9090'], {});
    assert.equal(cfg.command, 'destroy');
    assert.equal(cfg.name, 'qa');
    assert.deepEqual(cfg.publish, ['127.0.0.1:9090:9090']);
    assert.deepEqual(cfg.args, []);
    assert.deepEqual([...cfg.explicit], ['--name', '--expose']);
});

test('public parameterless cli rejects noninteractive dry-run before mutation', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'cli');
    assert.equal(status, 1, out);
    checkIncludes(out, 'requires an interactive terminal', 'public cli explains the TTY requirement');
    checkAbsent(out, 'DRY-RUN: podman run -d', 'public cli rejects before reconciliation');
});

test('public sh forwards with interactive exec', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'sh');
    assert.equal(status, 0, out);
    checkIncludes(
        out,
        'exec -i -e PLOINKY_RUNTIME_NAME=ploinky-box-qa -w /workspace ploinky-box-qa ploinky sh',
        'public sh preserves non-TTY input without requesting a terminal',
    );
});

test('smoke script documents optional public ploinky path', () => {
    const smokeText = fs.readFileSync(path.join(HERE, 'smoke-box.mjs'), 'utf8');
    assert.ok(smokeText.includes('SMOKE_PUBLIC_PLOINKY'), smokeText);
    assert.ok(smokeText.includes('bin/ploinky'), smokeText);
});

test('docs describe boxed-by-default ploinky and the host-mounted core', () => {
    const rootReadme = fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8');
    const boxReadme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
    assert.ok(rootReadme.includes('mounted read-only'), rootReadme);
    assert.ok(rootReadme.includes('core edits on the host'), rootReadme);
    assert.ok(rootReadme.includes('node cli/index.js'), rootReadme);
    assert.ok(!rootReadme.includes('PLOINKY_DIRECT'), 'the direct-mode escape is gone');
    assert.ok(boxReadme.includes('Graph-driven Explorer publishes'), boxReadme);
    assert.ok(boxReadme.includes('openPorts'), boxReadme);
    assert.ok(boxReadme.includes('/opt/ploinky'), boxReadme);
    assert.ok(boxReadme.includes('read-only'), boxReadme);
    assert.ok(boxReadme.includes('ploinky-deps'), boxReadme);
    assert.ok(boxReadme.includes('PLOINKY_BOX_SOURCE'), boxReadme);
    assert.ok(boxReadme.includes('PLOINKY_BOX_INSTALL_DEPS'), boxReadme);
    assert.ok(boxReadme.includes('Install them now?'), boxReadme);
    assert.ok(boxReadme.includes('/etc/ploinky-box'), boxReadme);
    assert.ok(!boxReadme.includes('PLOINKY_DIRECT'), 'the direct-mode escape is gone');
});

test('package metadata advertises the Node 20 runtime floor', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
    assert.equal(packageJson.engines.node, '>=20.0.0');
});

test('package metadata exposes ploinky as the public binary', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
    assert.equal(packageJson.bin.ploinky, './bin/ploinky');
});

test('sanitizeBoxSuffix: engine-safe suffixes', () => {
    assert.equal(sanitizeBoxSuffix('testExplorerFresh'), 'testExplorerFresh');
    assert.equal(sanitizeBoxSuffix('my repo!'), 'my_repo_');
    assert.equal(sanitizeBoxSuffix('a.b-c_d'), 'a.b-c_d');
    assert.equal(sanitizeBoxSuffix('x'.repeat(80)), 'x'.repeat(63));
    assert.equal(sanitizeBoxSuffix(''), '');
});

test('resolveInstanceIdentity: cwd inference and --name override', () => {
    const inferred = resolveInstanceIdentity(parseHostInvocation([], {}), '/home/u/testExplorer2');
    assert.equal(inferred.name, 'testExplorer2');
    assert.equal(inferred.nameSource, 'cwd');
    assert.equal(instanceName(inferred), 'ploinky-box-testExplorer2');

    const flagged = resolveInstanceIdentity(parseHostInvocation(['--name', 'qa'], {}), '/home/u/testExplorer2');
    assert.equal(flagged.name, 'qa');
    assert.equal(flagged.nameSource, 'flag');
});

test('parseHostInvocation: explicit-port tracking for start', () => {
    assert.equal(parseHostInvocation(['--port', '9090', 'start'], {}).explicit.has('--port'), true);
    assert.equal(parseHostInvocation(['start'], {}).explicit.has('--port'), false);
});

test('automatic runtime creation sanitizes the inferred cwd basename', () => {
    const { parent, dir } = makeCwd('my repo!');
    try {
        const { out } = publicRunIn(dir, 'podman', '--dry-run', 'list', 'agents');
        checkIncludes(out, '--name ploinky-box-my_repo_', 'unsafe chars become underscores');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('--name overrides the cwd basename', () => {
    const { parent, dir } = makeCwd('testExplorerFresh');
    try {
        const { out } = publicRunIn(dir, 'podman', '--name', 'qa', '--dry-run', 'list', 'agents');
        checkIncludes(out, '--name ploinky-box-qa', 'explicit --name wins');
        checkAbsent(out, 'testExplorerFresh', 'cwd basename ignored when --name is given');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('un-inferable cwd dies with guidance', () => {
    const { parent, dir } = makeCwd('___');
    try {
        const { out, status } = publicRunIn(dir, 'podman', '--dry-run', 'list', 'agents');
        assert.equal(status, 1, out);
        checkIncludes(out, 'cannot infer an instance name', 'un-inferable cwd is an error');
        checkIncludes(out, 'pass --name X', 'error points at the escape hatch');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('status targets the inferred instance', () => {
    const { parent, dir } = makeCwd('testExplorerFresh');
    const fake = makeMissingStatusEngine();
    try {
        const { out, status } = publicRunInWithEnv(
            dir,
            { PATH: `${fake.dir}:${process.env.PATH || ''}` },
            'podman',
            '--dry-run',
            'status',
        );
        assert.equal(status, 1, out);
        checkIncludes(out, 'runtime: ploinky-box-testExplorerFresh (missing)', 'status resolves the inferred name');
        assert.equal(
            fs.readFileSync(fake.calls, 'utf8').trim(),
            'container inspect ploinky-box-testExplorerFresh',
        );
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('destroy targets the inferred instance and says so', () => {
    const { parent, dir } = makeCwd('testExplorerFresh');
    try {
        const { out } = publicRunIn(dir, 'podman', '--dry-run', 'destroy');
        checkIncludes(out, "targeting 'ploinky-box-testExplorerFresh' (name inferred from the current directory)", 'destroy announces the inferred target');
        checkIncludes(out, 'volume rm ploinky-box-testExplorerFresh-workspace ploinky-box-testExplorerFresh-containers ploinky-box-testExplorerFresh-ploinky-deps', 'destroy removes all three volumes');
        checkIncludes(out, "'ploinky-box-testExplorerFresh' and its volumes removed.", 'destroy resolves the inferred name');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});
