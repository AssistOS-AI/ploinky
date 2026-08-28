import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    BOX_IMAGE_REFERENCE,
    BOX_LABELS,
    BOX_READY_LINE,
    BOX_ROUTER_HEALTH_SOCKET,
    BOX_TMPFS,
    BOX_USERNS,
} from '../../ploinky-box/constants.mjs';
import {
    normalizeContainerRuntime,
    validateContainerConfiguration,
} from '../../ploinky-box/contract/container.mjs';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    ensureWorkspaceDataPaths,
    inspectWorkspaceDataPaths,
} from '../../ploinky-box/workspace-data.mjs';
import {
    captureContainerLogBaseline,
    containerCreateArgs,
    readContainerIdFromCidfile,
    startContainerAndWaitReady,
    waitForReadyLine,
} from '../../ploinky-box/lifecycle/container.mjs';
import { reconcileBoxContainer } from '../../ploinky-box/lifecycle/transactions.mjs';
import {
    agentLibFixture,
    agentLibFixtureEnv,
    agentLibFixtureLabels,
    agentLibFixtureMounts,
} from '../helpers/agentlibFixture.mjs';

const DATA_FINGERPRINTS = Object.freeze({
    dependencies: 'd'.repeat(64),
    images: 'f'.repeat(64),
});
const TMPFS_CREATE_ARGUMENT = `${BOX_TMPFS.destination}:${BOX_TMPFS.options.join(',')}`;
const TMPFS_INSPECTED_OPTIONS = Object.freeze([
    ...BOX_TMPFS.options.filter((option) => option !== 'notmpcopyup'),
    'rprivate',
].sort());
const EMPTY_LOG_BASELINE = Object.freeze({ stdout: '', stderr: '' });

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-transaction-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const lockPath = path.join(root, 'lock');
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(workspace, '.ploinky'));
    fs.mkdirSync(lockPath);
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const lock = {
        path: lockPath,
        assertHeld(instance) { assert.equal(instance, identity.instance); },
    };
    // Every Box now carries the direct-mounted achillesAgentLib source as part
    // of its immutable contract, so the fixture selects one for the workspace.
    const agentLib = agentLibFixture(identity.workspaceRoot);
    return { root, identity, lock, agentLib };
}

function dataDirectoriesExist(identity) {
    return Object.values(identity.dataPaths).every((target) => fs.existsSync(target));
}

function containerHandle({
    identity,
    repositoryRoot,
    imageId,
    imageRef,
    hostPort,
    mediaHostPort = 7882,
    id,
    running = true,
    dataFingerprints = DATA_FINGERPRINTS,
    agentLib,
}) {
    return {
        id,
        labels: {
            ...agentLibFixtureLabels(agentLib),
            'io.buildah.version': '1.43.1',
            [BOX_LABELS.pathHash]: identity.pathHash,
            [BOX_LABELS.role]: 'box',
            [BOX_LABELS.imageRef]: imageRef,
            [BOX_LABELS.routerHostPort]: String(hostPort),
            [BOX_LABELS.mediaHostPort]: String(mediaHostPort),
            [BOX_LABELS.dependenciesFingerprint]: dataFingerprints.dependencies,
            [BOX_LABELS.imagesFingerprint]: dataFingerprints.images,
        },
        runtime: {
            complete: true,
            imageId,
            configuredImage: imageId,
            user: 'podman',
            createCommand: [
                'podman', 'container', 'create',
                '--init',
                '--userns', BOX_USERNS,
                '--device', '/dev/fuse', '--device', '/dev/net/tun',
                '--tmpfs', TMPFS_CREATE_ARGUMENT,
            ],
            environment: {
                ...IMAGE_CONTRACT.environment,
                ...agentLibFixtureEnv(agentLib),
                PLOINKY_PRIVATE_BIND: '0.0.0.0',
                PLOINKY_PUBLIC_BIND: '0.0.0.0',
                PLOINKY_PUBLIC_AUTHORITY: `127.0.0.1:${hostPort}`,
                PLOINKY_ROUTER_HEALTH_SOCKET: BOX_ROUTER_HEALTH_SOCKET,
                HOSTNAME: id.slice(0, 12),
            },
            publications: [
                { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: String(mediaHostPort) },
                { containerPort: '8080', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: String(hostPort) },
            ],
            running,
            status: running ? 'running' : 'exited',
            init: true,
            usernsMode: 'private',
            privileged: false,
            securityOptions: ['label=disable', 'unmask=ALL'],
            devices: [
                { hostPath: '/dev/fuse', containerPath: '/dev/fuse', permissions: 'rwm' },
                { hostPath: '/dev/net/tun', containerPath: '/dev/net/tun', permissions: 'rwm' },
            ],
            tmpfs: [{ destination: BOX_TMPFS.destination, options: [...TMPFS_INSPECTED_OPTIONS] }],
            mounts: [
                { type: 'bind', name: '', source: identity.dataPaths.images, destination: '/home/podman/.local/share/ploinky-images', rw: true },
                { type: 'bind', name: '', source: repositoryRoot, destination: '/opt/ploinky', rw: false },
                { type: 'bind', name: '', source: identity.dataPaths.dependencies, destination: '/opt/ploinky/node_modules', rw: true },
                { type: 'bind', name: '', source: identity.workspaceRoot, destination: '/workspace', rw: true },
                ...agentLibFixtureMounts(agentLib),
            ],
        },
    };
}

test('container validation ignores inherited image labels but rejects unknown ownership labels', (t) => {
    const state = fixture(t);
    const handle = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
        id: 'b'.repeat(64),
    });
    const desired = {
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
    };
    assert.doesNotThrow(() => validateContainerConfiguration(handle, desired));
    handle.labels['io.assistos.ploinky-box.unexpected'] = '1';
    assert.throws(
        () => validateContainerConfiguration(handle, desired),
        /label set is incompatible/,
    );
});

test('Podman Machine validation tolerates its omitted device inspection only', (t) => {
    const state = fixture(t);
    const handle = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
        id: 'b'.repeat(64),
    });
    handle.runtime.devices = [];
    const desired = {
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
    };
    handle.runtime.createCommand = [
        'podman', 'container', 'create',
        '--userns', BOX_USERNS,
    ];
    assert.throws(
        () => validateContainerConfiguration(handle, desired),
        /device set is incompatible/,
    );
    handle.runtime.createCommand = [
        'podman', 'container', 'create',
        '--userns', BOX_USERNS,
        '--device', '/dev/fuse', '--device', '/dev/net/tun',
        '--tmpfs', TMPFS_CREATE_ARGUMENT,
    ];
    assert.doesNotThrow(() => validateContainerConfiguration(handle, {
        ...desired,
        hostKind: 'podman-machine',
    }));
});

test('native device mismatch reports normalized observed and expected devices', (t) => {
    const state = fixture(t);
    const handle = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
        id: 'b'.repeat(64),
    });
    handle.runtime.devices = [];
    handle.runtime.createCommand = [
        'podman', 'container', 'create',
        '--userns', BOX_USERNS,
    ];

    assert.throws(
        () => validateContainerConfiguration(handle, {
            identity: state.identity,
            agentLib: state.agentLib,
            repositoryRoot: state.root,
            imageId: 'a'.repeat(64),
            imageRef: 'runtime',
            hostPort: 19090,
        }),
        /observed=\[\] recorded=\[\] expected=\[\"\/dev\/fuse\",\"\/dev\/net\/tun\"\] hostKind=native-linux/,
    );
});

test('omitted device inspection requires the exact recorded device arguments', (t) => {
    const state = fixture(t);
    const handle = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
        id: 'b'.repeat(64),
    });
    handle.runtime.devices = [];
    const desired = {
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
    };

    assert.doesNotThrow(() => validateContainerConfiguration(handle, desired));
    handle.runtime.createCommand.push('--device', '/dev/kvm');
    assert.throws(
        () => validateContainerConfiguration(handle, desired),
        /device set is incompatible/,
    );
});

test('Box container argv disables outer SELinux label confinement on every supported host', (t) => {
    const state = fixture(t);
    for (const hostKind of ['native-linux', 'podman-machine']) {
        const args = containerCreateArgs({
            identity: state.identity,
            dataFingerprints: DATA_FINGERPRINTS,
            agentLib: state.agentLib,
            imageId: 'a'.repeat(64),
            imageRef: 'runtime',
            hostPort: 19090,
            repositoryRoot: state.root,
            cidfile: path.join(state.root, 'candidate.cid'),
            hostKind,
        });
        assert.deepEqual(args.flatMap((value, index) => (
            value === '--security-opt' ? [args[index + 1]] : []
        )), ['unmask=ALL', 'label=disable']);
        assert.equal(args.includes('--privileged'), false);
    }
});

function harness(state, {
    initial = null,
    candidateImage = 'c'.repeat(64),
    failPreflight = false,
    failPull = false,
    failCreate = false,
    failCandidateReady = false,
    failBaselineCapture = false,
    corruptCidfile = false,
    failLocalStop = false,
    realDataPaths = false,
} = {}) {
    const calls = [];
    let current = initial;
    let createCount = 0;
    const runner = {
        run(command, args) {
            calls.push(['run', command, ...args]);
            if (args[0] === 'container' && args[1] === 'create') {
                if (failCreate) throw new Error('create race');
                createCount += 1;
                const cid = createCount === 1 ? 'a'.repeat(64) : 'b'.repeat(64);
                const cidfile = args[args.indexOf('--cidfile') + 1];
                fs.writeFileSync(cidfile, corruptCidfile && createCount === 1 ? 'corrupt\n' : `${cid}\n`, { mode: 0o600 });
                const imageId = args.at(-1);
                const imageRefLabel = args.find((value) => value.startsWith(`${BOX_LABELS.imageRef}=`));
                const portLabel = args.find((value) => value.startsWith(`${BOX_LABELS.routerHostPort}=`));
                const mediaPortLabel = args.find((value) => value.startsWith(`${BOX_LABELS.mediaHostPort}=`));
                const dependenciesLabel = args.find((value) => (
                    value.startsWith(`${BOX_LABELS.dependenciesFingerprint}=`)
                ));
                const imagesLabel = args.find((value) => (
                    value.startsWith(`${BOX_LABELS.imagesFingerprint}=`)
                ));
                current = containerHandle({
                    identity: state.identity,
                    agentLib: state.agentLib,
                    repositoryRoot: state.root,
                    imageId,
                    imageRef: imageRefLabel.slice(imageRefLabel.indexOf('=') + 1),
                    hostPort: Number(portLabel.slice(portLabel.indexOf('=') + 1)),
                    mediaHostPort: Number(mediaPortLabel.slice(mediaPortLabel.indexOf('=') + 1)),
                    id: cid,
                    running: false,
                    dataFingerprints: {
                        dependencies: dependenciesLabel.slice(dependenciesLabel.indexOf('=') + 1),
                        images: imagesLabel.slice(imagesLabel.indexOf('=') + 1),
                    },
                });
            }
            if (args[0] === 'container' && args[1] === 'start') current.runtime.running = true;
            if (args[0] === 'container' && args[1] === 'stop') current.runtime.running = false;
            if (args[0] === 'container' && args[1] === 'rm') current = null;
        },
        async stream(command, args) {
            calls.push(['stream', command, ...args]);
            if (args[0] === 'pull' && failPull) {
                return { ok: false, status: 125, stdout: '', stderr: 'pull failed' };
            }
            return { ok: true, status: 0, stdout: 'pull complete\n', stderr: '' };
        },
        query(command, args) {
            calls.push(['query', command, ...args]);
            return { ok: true, stdout: `${BOX_READY_LINE}\n`, stderr: '' };
        },
    };
    const seams = {
        async preflight() {
            calls.push(['seam', 'preflight']);
            if (failPreflight) throw new Error('port conflict');
        },
        validateImage() {
            calls.push(['seam', 'validate-image']);
            return { immutableId: candidateImage };
        },
        validateExistingImage(engine, imageId, imageRef) {
            calls.push(['seam', 'validate-existing-image', engine, imageId, imageRef]);
            return { immutableId: imageId };
        },
        removeContainer(engine, id, selectedRunner) {
            selectedRunner.run(engine.name, ['container', 'rm', '-f', id]);
        },
        stopPloinkyLocal(engine, id) {
            calls.push(['seam', 'stop-ploinky-local', engine.name, id]);
            if (failLocalStop) throw new Error('ploinky-local stop failed');
        },
        async startAndWaitReady(engine, id, selectedRunner) {
            calls.push(['seam', 'capture-logs', id]);
            if (failBaselineCapture) throw new Error('log baseline unavailable');
            selectedRunner.run(engine.name, ['container', 'start', id]);
            calls.push(['seam', 'wait-ready', id]);
            if (failCandidateReady && id === 'a'.repeat(64)) throw new Error('ready timeout');
        },
        discover() {
            calls.push(['seam', 'discover']);
            return { state: 'owned', handles: { container: current } };
        },
        token(kind) { return kind === 'candidate' ? '1'.repeat(24) : '2'.repeat(24); },
    };
    if (!realDataPaths) {
        seams.ensureDataPaths = () => {
            calls.push(['seam', 'ensure-data-paths']);
            return {
                paths: state.identity.dataPaths,
                fingerprints: DATA_FINGERPRINTS,
                created: [],
            };
        };
        seams.inspectDataPaths = () => ({
            paths: state.identity.dataPaths,
            fingerprints: DATA_FINGERPRINTS,
        });
        seams.revalidateDataPaths = () => {
            calls.push(['seam', 'revalidate-data-paths']);
            return { paths: state.identity.dataPaths, fingerprints: DATA_FINGERPRINTS };
        };
    }
    return { runner, seams, calls, current: () => current };
}

function assertNoEngineVolumeCommand(calls) {
    assert.equal(calls.some((call) => call.includes('volume')), false);
}

test('container argv is exact, unprivileged, and ends with immutable image ID', (t) => {
    const state = fixture(t);
    const cidfile = path.join(state.lock.path, 'candidate.cid');
    const args = containerCreateArgs({
        identity: state.identity,
        dataFingerprints: DATA_FINGERPRINTS,
        agentLib: state.agentLib,
        imageId: 'a'.repeat(64),
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 19090,
        mediaHostPort: 17891,
        repositoryRoot: state.root,
        cidfile,
    });
    assert.equal(args.at(-1), 'a'.repeat(64));
    assert.equal(args.filter((value) => value === '--init').length, 1);
    assert.equal(args.includes('--privileged'), false);
    assert.equal(args.some((value) => value.includes('docker.sock') || value.includes('podman.sock')), false);
    assert.equal(args.filter((value) => value === '--publish').length, 2);
    assert.equal(args.includes('127.0.0.1:19090:8080/tcp'), true);
    assert.equal(args.includes('0.0.0.0:17891:7882/udp'), true);
    assert.equal(args.includes(`${BOX_LABELS.mediaHostPort}=17891`), true);
    assert.equal(args.includes('unmask=ALL'), true);
    assert.equal(args.includes('label=disable'), true);
    assert.equal(args.includes(`PLOINKY_ROUTER_HEALTH_SOCKET=${BOX_ROUTER_HEALTH_SOCKET}`), true);
    assert.equal(args.includes('/dev/fuse'), true);
    assert.equal(args.includes('/dev/net/tun'), true);
    assert.deepEqual(args.slice(args.indexOf('--userns'), args.indexOf('--userns') + 2), [
        '--userns', BOX_USERNS,
    ]);
    assert.equal(args.filter((value) => value.endsWith(':U')).length, 0);
    assert.equal(args.includes(`${state.identity.workspaceRoot}:/workspace`), true);
    assert.equal(args.some((value) => value === `${state.identity.workspaceRoot}:/workspace:U`), false);

    // Exactly six durable binds and one transient tmpfs, with no named volume.
    // The two achillesAgentLib binds come last and are both read-only: the
    // stable runtime path, then the shadow over the writable /workspace alias
    // that would otherwise leave the same inode writable.
    const mountArgs = args.flatMap((value, index) => (
        value === '--volume' ? [args[index + 1]] : []
    ));
    assert.deepEqual(mountArgs, [
        `${state.root}:/opt/ploinky:ro`,
        `${state.identity.workspaceRoot}:/workspace`,
        `${state.identity.dataPaths.dependencies}:/opt/ploinky/node_modules`,
        `${state.identity.dataPaths.images}:/home/podman/.local/share/ploinky-images`,
        `${state.agentLib.sourceDir}:/opt/ploinky-agentlib:ro`,
        `${state.agentLib.sourceDir}:/workspace/achillesAgentLib:ro`,
    ]);
    assert.ok(
        mountArgs.indexOf(`${state.identity.workspaceRoot}:/workspace`)
        < mountArgs.indexOf(`${state.agentLib.sourceDir}:/workspace/achillesAgentLib:ro`),
        'the alias shadow must be applied after the writable workspace bind',
    );
    assert.equal(args.includes(`PLOINKY_AGENTLIB_DIR=/opt/ploinky-agentlib`), true);
    assert.equal(args.includes(`PLOINKY_AGENTLIB_MODE=local`), true);
    assert.equal(args.includes(`PLOINKY_AGENTLIB_FINGERPRINT=${state.agentLib.fingerprint}`), true);
    for (const mount of mountArgs) {
        assert.equal(path.isAbsolute(mount.split(':')[0]), true);
        assert.equal(mount.includes(state.identity.instance), false);
    }
    const tmpfsArgs = args.flatMap((value, index) => (
        value === '--tmpfs' ? [args[index + 1]] : []
    ));
    assert.deepEqual(tmpfsArgs, [TMPFS_CREATE_ARGUMENT]);
    const [destination, ...optionParts] = tmpfsArgs[0].split(':');
    assert.equal(destination, BOX_TMPFS.destination);
    assert.deepEqual(optionParts.join(':').split(',').sort(), [...BOX_TMPFS.options].sort());
});

test('Podman tmpfs inspection is normalized independently from its create record', () => {
    const runtime = normalizeContainerRuntime({
        Config: {
            Env: [],
            CreateCommand: [
                'podman', 'container', 'create', '--tmpfs', TMPFS_CREATE_ARGUMENT, 'image-id',
            ],
        },
        HostConfig: {
            Tmpfs: {
                '/tmp': 'rw,exec,nosuid,nodev,mode=1777,rprivate',
            },
        },
        State: { Status: 'created', Running: false },
        Mounts: [],
    });
    assert.deepEqual(runtime.tmpfs, [{
        destination: BOX_TMPFS.destination,
        options: [...TMPFS_INSPECTED_OPTIONS],
    }]);
});

test('container validation accepts only the exact transient tmpfs contract', (t) => {
    const state = fixture(t);
    const desired = {
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
    };
    const exact = () => containerHandle({ ...desired, id: 'b'.repeat(64) });
    assert.doesNotThrow(() => validateContainerConfiguration(exact(), desired));

    const cases = [
        ['no tmpfs', (handle) => { handle.runtime.tmpfs = []; }],
        ['noexec semantics', (handle) => {
            handle.runtime.tmpfs[0].options = handle.runtime.tmpfs[0].options
                .filter((option) => option !== 'exec').concat('noexec').sort();
        }],
        ['missing mode', (handle) => {
            handle.runtime.tmpfs[0].options = handle.runtime.tmpfs[0].options
                .filter((option) => option !== 'mode=1777');
        }],
        ['missing notmpcopyup', (handle) => {
            handle.runtime.createCommand[handle.runtime.createCommand.indexOf(TMPFS_CREATE_ARGUMENT)] =
                '/tmp:rw,exec,nosuid,nodev,mode=1777';
        }],
        ['extra option', (handle) => {
            handle.runtime.tmpfs[0].options.push('size=64m');
            handle.runtime.tmpfs[0].options.sort();
        }],
        ['runroot child', (handle) => {
            handle.runtime.tmpfs[0].destination = '/tmp/storage-run-1000';
            handle.runtime.createCommand[handle.runtime.createCommand.indexOf(TMPFS_CREATE_ARGUMENT)] =
                TMPFS_CREATE_ARGUMENT.replace('/tmp:', '/tmp/storage-run-1000:');
        }],
        ['second tmpfs', (handle) => {
            handle.runtime.tmpfs.push({
                destination: '/var/tmp',
                options: [...TMPFS_INSPECTED_OPTIONS],
            });
        }],
        ['duplicate option', (handle) => {
            handle.runtime.tmpfs[0].options.push('rw');
        }],
        ['create-command disagreement', (handle) => {
            handle.runtime.createCommand[handle.runtime.createCommand.indexOf(TMPFS_CREATE_ARGUMENT)] =
                `${TMPFS_CREATE_ARGUMENT},size=64m`;
        }],
    ];
    for (const [name, mutate] of cases) {
        const handle = exact();
        mutate(handle);
        assert.throws(
            () => validateContainerConfiguration(handle, desired),
            /tmpfs set is incompatible/,
            name,
        );
    }

    const representedInMounts = exact();
    representedInMounts.runtime.mounts.push({
        type: 'tmpfs', name: '', source: '', destination: '/tmp', rw: true,
    });
    assert.doesNotThrow(() => validateContainerConfiguration(representedInMounts, desired));
});

test('container validation rejects retired named-volume mounts and user-namespace drift', (t) => {
    const state = fixture(t);
    const desired = {
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
    };
    // A Box created by the retired design is never adopted; the operator is
    // told to destroy it, and the guidance must not name a removed flag.
    for (const destination of [
        '/workspace',
        '/opt/ploinky/node_modules',
        '/home/podman/.local/share/ploinky-images',
    ]) {
        const retiredMount = containerHandle({ ...desired, id: 'b'.repeat(64) });
        retiredMount.runtime.mounts = retiredMount.runtime.mounts.map((mount) => (
            mount.destination === destination
                ? {
                    type: 'volume',
                    name: `${state.identity.instance}-workspace`,
                    source: '',
                    destination,
                    rw: true,
                }
                : mount
        ));
        assert.throws(
            () => validateContainerConfiguration(retiredMount, desired),
            (error) => new RegExp(`mount ${destination} is incompatible`).test(error.message)
                && /ploinky destroy/.test(error.message)
                && !/--delete-volumes/.test(error.message),
        );
    }

    const wrongSource = containerHandle({ ...desired, id: 'b'.repeat(64) });
    wrongSource.runtime.mounts = wrongSource.runtime.mounts.map((mount) => (
        mount.destination === '/opt/ploinky/node_modules'
            ? { ...mount, source: '/somewhere/else' }
            : mount
    ));
    assert.throws(
        () => validateContainerConfiguration(wrongSource, desired),
        /mount \/opt\/ploinky\/node_modules is incompatible/,
    );

    const changedUserns = containerHandle({
        ...desired,
        id: 'c'.repeat(64),
    });
    changedUserns.runtime.createCommand = changedUserns.runtime.createCommand.filter((value) => (
        value !== '--userns' && value !== BOX_USERNS
    ));
    assert.throws(
        () => validateContainerConfiguration(changedUserns, desired),
        (error) => /user namespace is incompatible/.test(error.message)
            && /ploinky destroy/.test(error.message),
    );
});

test('container validation rejects a Box that cannot reap orphaned children', (t) => {
    const state = fixture(t);
    const handle = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'd'.repeat(64),
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 8080,
        id: 'e'.repeat(64),
    });
    handle.runtime.init = false;

    assert.throws(() => validateContainerConfiguration(handle, {
        identity: state.identity,
        hostPort: 8080,
        imageId: 'd'.repeat(64),
        imageRef: BOX_IMAGE_REFERENCE,
        repositoryRoot: state.root,
    }), /init state is incompatible/);
});

test('initial transaction preflights before pull, workspace data, and container creation', async (t) => {
    const state = fixture(t);
    const h = harness(state);
    const result = await reconcileBoxContainer({
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: { state: 'absent', handles: null },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
        explicitPort: 19090,
        explicitMediaPort: 17891,
    }, h.seams);
    assert.equal(result.action, 'created');
    assert.equal(result.mediaHostPort, 17891);
    assert.equal(h.calls.some((call) => call.includes('0.0.0.0:17891:7882/udp')), true);
    const flat = h.calls.map((call) => call.join(' '));
    assert.ok(flat.findIndex((value) => value.includes('preflight')) < flat.findIndex((value) => value.includes('stream podman pull')));
    assert.ok(flat.findIndex((value) => value.includes('stream podman pull')) < flat.findIndex((value) => value.includes('ensure-data-paths')));
    assert.ok(flat.findIndex((value) => value.includes('ensure-data-paths')) < flat.findIndex((value) => value.includes('revalidate-data-paths')));
    assert.ok(flat.findIndex((value) => value.includes('revalidate-data-paths')) < flat.findIndex((value) => value.includes('container create')));
    assert.ok(flat.findIndex((value) => value.includes('container create')) < flat.findIndex((value) => value.includes('capture-logs')));
    assert.ok(flat.findIndex((value) => value.includes('capture-logs')) < flat.findIndex((value) => value.includes('container start')));
    assert.ok(flat.findIndex((value) => value.includes('container start')) < flat.findIndex((value) => value.includes('wait-ready')));
    assert.ok(flat.findIndex((value) => value.includes('wait-ready')) < flat.findIndex((value) => value.includes('discover')));
    assertNoEngineVolumeCommand(h.calls);
});

test('a real create materializes the workspace data directories before the container', async (t) => {
    const state = fixture(t);
    const h = harness(state, { realDataPaths: true });

    const result = await reconcileBoxContainer({
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: { state: 'absent', handles: null },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
    }, h.seams);

    assert.equal(result.action, 'created');
    assert.equal(dataDirectoriesExist(state.identity), true);
    assertNoEngineVolumeCommand(h.calls);
});

test('validated reuse retains the exact workspace data bind sources without engine volume commands', async (t) => {
    const state = fixture(t);
    const data = ensureWorkspaceDataPaths({ identity: state.identity, lock: state.lock });
    const current = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'd'.repeat(64),
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 8080,
        id: 'e'.repeat(64),
        dataFingerprints: data.fingerprints,
    });
    const h = harness(state, { initial: current, realDataPaths: true });
    const result = await reconcileBoxContainer({
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: { state: 'owned', handles: { container: current } },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
    }, h.seams);
    assert.equal(result.action, 'reused');
    assert.equal(h.calls.some((call) => call.includes('validate-existing-image')), true);
    assert.equal(h.calls.some((call) => call.includes('pull')), false);
    assert.equal(h.calls.some((call) => call.includes('capture-logs')), false);
    assert.equal(h.calls.some((call) => call.join(' ').includes('container start')), false);
    assert.equal(dataDirectoriesExist(state.identity), true);
    assertNoEngineVolumeCommand(h.calls);
});

test('stopped reuse captures logs before start and validates the same running ID', async (t) => {
    const state = fixture(t);
    const current = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'd'.repeat(64),
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 8080,
        id: 'e'.repeat(64),
        running: false,
    });
    const h = harness(state, { initial: current });
    const result = await reconcileBoxContainer({
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: { state: 'owned', handles: { container: current } },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
    }, h.seams);
    assert.equal(result.action, 'reused');
    assert.equal(result.ownership.handles.container.id, current.id);
    assert.equal(result.ownership.handles.container.runtime.running, true);
    const events = h.calls.map((call) => call.join(' '));
    const revalidate = events.findIndex((value) => value.includes('revalidate-data-paths'));
    const capture = events.findIndex((value) => value.includes('capture-logs'));
    const start = events.findIndex((value) => value.includes('container start'));
    const wait = events.findIndex((value) => value.includes('wait-ready'));
    const discover = events.findIndex((value) => value.includes('discover'));
    assert.ok(revalidate >= 0 && revalidate < capture);
    assert.ok(capture < start && start < wait && wait < discover);
    assert.equal(events.some((value) => value.includes('pull')), false);
    assert.equal(events.some((value) => value.includes('container create')), false);
    assert.equal(events.some((value) => value.includes('container rm')), false);
});

test('stopped reuse baseline failure mutates no container or image state', async (t) => {
    const state = fixture(t);
    const current = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'd'.repeat(64),
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 8080,
        id: 'e'.repeat(64),
        running: false,
    });
    const h = harness(state, { initial: current, failBaselineCapture: true });
    await assert.rejects(() => reconcileBoxContainer({
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: { state: 'owned', handles: { container: current } },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
    }, h.seams), /log baseline unavailable/);
    assert.equal(current.runtime.running, false);
    assert.equal(h.calls.some((call) => call.join(' ').includes('container start')), false);
    assert.equal(h.calls.some((call) => call.includes('pull')), false);
    assert.equal(h.calls.some((call) => call.join(' ').includes('container rm')), false);
    assert.equal(h.calls.some((call) => call.join(' ').includes('container create')), false);
});

test('final stopped rediscovery rejects reconciliation after readiness', async (t) => {
    const state = fixture(t);
    const current = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'd'.repeat(64),
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 8080,
        id: 'e'.repeat(64),
        running: false,
    });
    const h = harness(state, { initial: current });
    const discover = h.seams.discover;
    h.seams.discover = () => {
        const result = discover();
        result.handles.container.runtime.running = false;
        result.handles.container.runtime.status = 'exited';
        return result;
    };
    await assert.rejects(() => reconcileBoxContainer({
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: { state: 'owned', handles: { container: current } },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
    }, h.seams), /not running after readiness/);
});

test('a replaced live bind source forces outer-container replacement', async (t) => {
    const state = fixture(t);
    const original = ensureWorkspaceDataPaths({ identity: state.identity, lock: state.lock });
    const current = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'd'.repeat(64),
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 8080,
        id: 'e'.repeat(64),
        dataFingerprints: original.fingerprints,
    });
    const displaced = path.join(state.root, 'displaced-dependencies');
    fs.renameSync(state.identity.dataPaths.dependencies, displaced);
    fs.mkdirSync(state.identity.dataPaths.dependencies);
    const replacementState = inspectWorkspaceDataPaths({ identity: state.identity });
    assert.notEqual(
        replacementState.fingerprints.dependencies,
        original.fingerprints.dependencies,
    );

    const h = harness(state, { initial: current, realDataPaths: true });
    const result = await reconcileBoxContainer({
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: { state: 'owned', handles: { container: current } },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
    }, h.seams);

    assert.equal(result.action, 'replaced');
    assert.notEqual(result.ownership.handles.container.id, current.id);
    assert.equal(
        h.current().labels[BOX_LABELS.dependenciesFingerprint],
        replacementState.fingerprints.dependencies,
    );
    assert.equal(h.calls.some((call) => call.join(' ').includes('container rm -f')), true);
    assert.equal(h.calls.some((call) => call.join(' ').includes('container create')), true);
});

test('an incompatible owned WebTTY native runtime hard-cuts before any engine mutation', async (t) => {
    const state = fixture(t);
    const current = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'd'.repeat(64),
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 8080,
        id: 'e'.repeat(64),
        running: false,
    });
    const h = harness(state, { initial: current });
    h.seams.validateExistingImage = () => {
        const error = new Error(
            `WebTTY native contract mismatch for ${'d'.repeat(64)}; build or pull a compatible runtime image and recreate the Box`,
        );
        error.code = 'PLOINKY_BOX_WEBTTY_NATIVE_CONTRACT_INVALID';
        throw error;
    };
    await assert.rejects(() => reconcileBoxContainer({
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: {
            state: 'owned',
            handles: { container: current },
        },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
    }, h.seams), (error) => (
        error.code === 'PLOINKY_BOX_WEBTTY_NATIVE_CONTRACT_INVALID'
            && /compatible runtime image and recreate the Box/i.test(error.message)
    ));
    assert.deepEqual(h.calls, []);
});

test('preflight and pull failures create no workspace data and no container', async (t) => {
    for (const scenario of [{ failPreflight: true }, { failPull: true }]) {
        const state = fixture(t);
        const h = harness(state, { ...scenario, realDataPaths: true });
        await assert.rejects(() => reconcileBoxContainer({
            identity: state.identity,
            agentLib: state.agentLib,
            ownership: { state: 'absent', handles: null },
            engine: { name: 'podman', identity: 'engine' },
            runner: h.runner,
            lock: state.lock,
            repositoryRoot: state.root,
        }, h.seams));
        assert.equal(fs.existsSync(state.identity.boxDataRoot), false);
        assert.equal(h.calls.some((call) => call.includes('create')), false);
        assertNoEngineVolumeCommand(h.calls);
    }
});

test('create races and ready timeouts remove the candidate but retain workspace data', async (t) => {
    for (const scenario of [{ failCreate: true }, { failCandidateReady: true }]) {
        const state = fixture(t);
        const h = harness(state, { ...scenario, realDataPaths: true });
        await assert.rejects(() => reconcileBoxContainer({
            identity: state.identity,
            agentLib: state.agentLib,
            ownership: { state: 'absent', handles: null },
            engine: { name: 'podman', identity: 'engine' },
            runner: h.runner,
            lock: state.lock,
            repositoryRoot: state.root,
        }, h.seams), /transaction failed/);
        // Durable workspace state is never rolled back by a failed attempt.
        assert.equal(dataDirectoriesExist(state.identity), true);
        assertNoEngineVolumeCommand(h.calls);
        if (scenario.failCandidateReady) {
            assert.equal(h.calls.some((call) => call.join(' ').includes('container rm -f')), true);
        }
    }
});

test('replacement failure removes the candidate and restores the validated old image', async (t) => {
    const state = fixture(t);
    const oldImage = 'd'.repeat(64);
    const old = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: oldImage,
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 18080,
        mediaHostPort: 17880,
        id: 'e'.repeat(64),
    });
    const h = harness(state, { initial: old, failCandidateReady: true });
    await assert.rejects(() => reconcileBoxContainer({
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: { state: 'owned', handles: { container: old } },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
        explicitPort: 19090,
        explicitMediaPort: 17891,
    }, h.seams), /transaction failed/);
    assert.equal(h.current().runtime.imageId, oldImage);
    assert.equal(h.current().runtime.running, true);
    assert.equal(h.current().labels[BOX_LABELS.mediaHostPort], '17880');
    assert.equal(h.current().runtime.publications.some((entry) => (
        entry.protocol === 'udp' && entry.hostPort === '17880'
    )), true);
    assertNoEngineVolumeCommand(h.calls);
    const removals = h.calls.filter((call) => call.join(' ').includes('container rm -f'));
    assert.equal(removals.length, 2);
});

test('successful replacement gracefully stops core before stopping and removing the old Box', async (t) => {
    const state = fixture(t);
    const old = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: 'd'.repeat(64),
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 18080,
        id: 'e'.repeat(64),
    });
    const h = harness(state, { initial: old });
    const result = await reconcileBoxContainer({
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: { state: 'owned', handles: { container: old } },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
        explicitPort: 19090,
    }, h.seams);
    assert.equal(result.action, 'replaced');
    const events = h.calls.map((call) => call.join(' '));
    const graceful = events.findIndex((value) => value.includes('seam stop-ploinky-local'));
    const outerStop = events.findIndex((value) => value.includes('container stop --time 30'));
    const removal = events.findIndex((value) => value.includes('container rm -f'));
    const creation = events.findIndex((value) => value.includes('container create'));
    assert.ok(graceful >= 0 && graceful < outerStop);
    assert.ok(outerStop < removal && removal < creation);
    assertNoEngineVolumeCommand(h.calls);
});

test('ploinky-local replacement stop failure preserves the old same-image Box without candidate cleanup', async (t) => {
    const state = fixture(t);
    const oldImage = 'd'.repeat(64);
    const old = containerHandle({
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: oldImage,
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 18080,
        id: 'e'.repeat(64),
    });
    const h = harness(state, {
        initial: old,
        candidateImage: oldImage,
        failLocalStop: true,
    });
    await assert.rejects(() => reconcileBoxContainer({
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: { state: 'owned', handles: { container: old } },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
        explicitPort: 19090,
    }, h.seams), (error) => (
        /Box container transaction failed/.test(error.message)
            && /ploinky-local stop failed/.test(error.cause?.message || '')
    ));
    assert.equal(h.current(), old);
    assert.equal(old.runtime.running, true);
    assert.equal(h.calls.some((call) => call.join(' ').includes('container stop --time 30')), false);
    assert.equal(h.calls.some((call) => call.join(' ').includes('container rm -f')), false);
    assert.equal(h.calls.some((call) => call.join(' ').includes('container create')), false);
    assertNoEngineVolumeCommand(h.calls);
});

test('missing or corrupt cidfiles are fail-closed primitives', (t) => {
    const state = fixture(t);
    const missing = path.join(state.root, 'missing.cid');
    assert.throws(() => readContainerIdFromCidfile(missing), /missing/);
    const corrupt = path.join(state.root, 'corrupt.cid');
    fs.writeFileSync(corrupt, 'not-an-id\n');
    assert.throws(() => readContainerIdFromCidfile(corrupt), /corrupt/);
});

test('container start captures an immutable cumulative-log baseline before mutation', async () => {
    const calls = [];
    let started = false;
    const runner = {
        query(_command, args) {
            calls.push(['query', ...args]);
            if (args[1] === 'logs') {
                return started
                    ? { ok: true, stdout: `historical\n${BOX_READY_LINE}\n`, stderr: 'old stderr\n' }
                    : { ok: true, stdout: 'historical\n', stderr: 'old stderr\n' };
            }
            return { ok: true, stdout: 'running\n', stderr: '' };
        },
        run(_command, args) {
            calls.push(['run', ...args]);
            started = true;
        },
    };
    const baseline = captureContainerLogBaseline(
        { name: 'podman' },
        'a'.repeat(64),
        runner,
    );
    assert.deepEqual(baseline, { stdout: 'historical\n', stderr: 'old stderr\n' });
    assert.equal(Object.isFrozen(baseline), true);

    calls.length = 0;
    started = false;
    await startContainerAndWaitReady({ name: 'podman' }, 'a'.repeat(64), runner, {
        stdout: { write() {} },
        stderr: { write() {} },
        intervalMs: 0,
        delay: async () => {},
    });
    assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
        ['query', 'container', 'logs'],
        ['run', 'container', 'start'],
        ['query', 'container', 'logs'],
        ['query', 'container', 'inspect'],
    ]);

    let startCalled = false;
    const failedRunner = {
        query() { return { ok: false, stdout: '', stderr: 'log driver unavailable' }; },
        run() { startCalled = true; },
    };
    await assert.rejects(
        () => startContainerAndWaitReady(
            { name: 'podman' }, 'b'.repeat(64), failedRunner,
        ),
        /capture Box container logs before start/,
    );
    assert.equal(startCalled, false);
    assert.throws(
        () => captureContainerLogBaseline({ name: 'podman' }, 'not-an-id', runner),
        /immutable container ID/,
    );
});

test('historical readiness cannot hide a current-boot runroot failure', async () => {
    const baseline = Object.freeze({
        stdout: `[ploinky-box] first boot\n${BOX_READY_LINE}\n`,
        stderr: '',
    });
    const runner = {
        query(_command, args) {
            if (args[1] === 'logs') {
                return {
                    ok: true,
                    stdout: baseline.stdout,
                    stderr: '[ploinky-box] SELF-CHECK FAILED: EACCES, Permission denied: /tmp/storage-run-1000\n',
                };
            }
            return { ok: true, stdout: 'exited\n', stderr: '' };
        },
    };
    await assert.rejects(
        () => waitForReadyLine({ name: 'podman' }, 'a'.repeat(64), runner, {
            logBaseline: baseline,
            stdout: { write() {} },
            stderr: { write() {} },
        }),
        (error) => /EACCES.*storage-run-1000/.test(error.message)
            && !error.message.includes('first boot'),
    );
});

test('only fresh ready output is streamed and accepted while the Box is running', async () => {
    const baseline = Object.freeze({
        stdout: `old output\n${BOX_READY_LINE}\n`,
        stderr: 'old diagnostic\n',
    });
    const stdout = { value: '', write(chunk) { this.value += String(chunk); } };
    const stderr = { value: '', write(chunk) { this.value += String(chunk); } };
    let logReads = 0;
    const runner = {
        query(_command, args) {
            if (args[1] === 'logs') {
                logReads += 1;
                return logReads === 1
                    ? { ok: true, ...baseline }
                    : {
                        ok: true,
                        stdout: `${baseline.stdout}current boot\n${BOX_READY_LINE}\n`,
                        stderr: `${baseline.stderr}current diagnostic\n`,
                    };
            }
            return { ok: true, stdout: 'running\n', stderr: '' };
        },
    };
    await waitForReadyLine({ name: 'podman' }, 'a'.repeat(64), runner, {
        logBaseline: baseline,
        stdout,
        stderr,
        intervalMs: 0,
        delay: async () => {},
    });
    assert.equal(stdout.value, `current boot\n${BOX_READY_LINE}\n`);
    assert.equal(stderr.value, 'current diagnostic\n');
    assert.equal(logReads, 2);
});

test('a fresh ready marker never overrides a terminal state from the same poll', async () => {
    const runner = {
        query(_command, args) {
            if (args[1] === 'logs') {
                return { ok: true, stdout: `${BOX_READY_LINE}\n`, stderr: 'boot exited\n' };
            }
            return { ok: true, stdout: 'exited\n', stderr: '' };
        },
    };
    await assert.rejects(
        () => waitForReadyLine({ name: 'podman' }, 'a'.repeat(64), runner, {
            logBaseline: EMPTY_LOG_BASELINE,
            stdout: { write() {} },
            stderr: { write() {} },
        }),
        /entered exited.*boot exited/,
    );
});

test('readiness fails closed when either cumulative log stream drifts', async () => {
    for (const stream of ['stdout', 'stderr']) {
        const baseline = { stdout: 'stdout-before\n', stderr: 'stderr-before\n' };
        const current = { ...baseline, [stream]: `${stream}-different\n` };
        const runner = {
            query(_command, args) {
                if (args[1] === 'logs') return { ok: true, ...current };
                return { ok: true, stdout: 'running\n', stderr: '' };
            },
        };
        await assert.rejects(
            () => waitForReadyLine({ name: 'podman' }, 'a'.repeat(64), runner, {
                logBaseline: baseline,
                stdout: { write() {} },
                stderr: { write() {} },
            }),
            new RegExp(`${stream} log history drifted`),
        );
    }
});

test('readiness cannot succeed without a running-state proof', async () => {
    const runner = {
        query(_command, args) {
            if (args[1] === 'logs') {
                return { ok: true, stdout: `${BOX_READY_LINE}\n`, stderr: '' };
            }
            return { ok: false, stdout: '', stderr: 'inspect unavailable' };
        },
    };
    await assert.rejects(
        () => waitForReadyLine({ name: 'podman' }, 'a'.repeat(64), runner, {
            logBaseline: EMPTY_LOG_BASELINE,
            stdout: { write() {} },
            stderr: { write() {} },
            timeoutMs: 0,
            intervalMs: 0,
            delay: async () => {},
        }),
        /Timed out waiting for exact ready line/,
    );
});

test('readiness failure rereads bounded container self-check diagnostics after exit', async () => {
    let logReads = 0;
    const runner = {
        query(_command, args) {
            if (args[1] === 'logs') {
                logReads += 1;
                if (logReads === 1) {
                    return { ok: true, stdout: '', stderr: '' };
                }
                return {
                    ok: true,
                    stdout: '',
                    stderr: '[ploinky-box] SELF-CHECK FAILED: inner runtime is unavailable\n',
                };
            }
            return { ok: true, stdout: 'exited\n', stderr: '' };
        },
    };
    await assert.rejects(
        () => waitForReadyLine({ name: 'podman' }, 'a'.repeat(64), runner, {
            logBaseline: EMPTY_LOG_BASELINE,
        }),
        /container logs: \[ploinky-box\] SELF-CHECK FAILED: inner runtime is unavailable/,
    );
    assert.equal(logReads, 2);
});

test('readiness explains legacy TUN self-check failures as an access problem', async () => {
    const runner = {
        query(_command, args) {
            if (args[1] === 'logs') {
                return {
                    ok: true,
                    stdout: '',
                    stderr: '[ploinky-box] SELF-CHECK FAILED: /dev/net/tun not present\n',
                };
            }
            return { ok: true, stdout: 'exited\n', stderr: '' };
        },
    };
    await assert.rejects(
        () => waitForReadyLine({ name: 'podman' }, 'a'.repeat(64), runner, {
            logBaseline: EMPTY_LOG_BASELINE,
            stdout: { write() {} },
            stderr: { write() {} },
        }),
        /must exist on the host and be accessible inside the Box for nested networking.*label=disable/,
    );
});

test('readiness streams each Box log line once before readiness', async () => {
    const stdout = { value: '', write(chunk) { this.value += String(chunk); } };
    const stderr = { value: '', write(chunk) { this.value += String(chunk); } };
    let logReads = 0;
    const runner = {
        query(_command, args) {
            if (args[1] === 'logs') {
                logReads += 1;
                return logReads === 1
                    ? { ok: true, stdout: '[ploinky-box] Starting runtime self-checks\n', stderr: '' }
                    : {
                        ok: true,
                        stdout: `[ploinky-box] Starting runtime self-checks\n${BOX_READY_LINE}\n`,
                        stderr: '[ploinky-box] diagnostic\n',
                    };
            }
            return { ok: true, stdout: 'running\n', stderr: '' };
        },
    };
    await waitForReadyLine({ name: 'podman' }, 'a'.repeat(64), runner, {
        logBaseline: EMPTY_LOG_BASELINE,
        stdout,
        stderr,
        intervalMs: 0,
        delay: async () => {},
    });
    assert.equal(stdout.value, `[ploinky-box] Starting runtime self-checks\n${BOX_READY_LINE}\n`);
    assert.equal(stderr.value, '[ploinky-box] diagnostic\n');
});

test('a corrupt cidfile can recover only through rediscovered immutable image identity', async (t) => {
    const state = fixture(t);
    const h = harness(state, { corruptCidfile: true });
    const result = await reconcileBoxContainer({
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: { state: 'absent', handles: null },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
    }, h.seams);
    assert.equal(result.action, 'created');
    assert.equal(result.ownership.handles.container.id, 'a'.repeat(64));
});
