import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    BOX_LABELS,
    BOX_READY_LINE,
    BOX_ROUTER_HEALTH_SOCKET,
    BOX_USERNS,
} from '../../ploinky-box/constants.mjs';
import { validateContainerConfiguration } from '../../ploinky-box/contract/container.mjs';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    containerCreateArgs,
    readContainerIdFromCidfile,
    waitForReadyLine,
} from '../../ploinky-box/lifecycle/container.mjs';
import { reconcileBoxContainer } from '../../ploinky-box/lifecycle/transactions.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-transaction-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const lockPath = path.join(root, 'lock');
    fs.mkdirSync(workspace);
    fs.mkdirSync(lockPath);
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const lock = {
        path: lockPath,
        assertHeld(instance) { assert.equal(instance, identity.instance); },
    };
    return { root, identity, lock };
}

function volumeHandles(identity) {
    return Object.fromEntries(Object.entries(identity.volumes).map(([key, name]) => [key, { name }]));
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
}) {
    return {
        id,
        labels: {
            'io.buildah.version': '1.43.1',
            [BOX_LABELS.pathHash]: identity.pathHash,
            [BOX_LABELS.role]: 'box',
            [BOX_LABELS.imageRef]: imageRef,
            [BOX_LABELS.routerHostPort]: String(hostPort),
            [BOX_LABELS.mediaHostPort]: String(mediaHostPort),
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
            ],
            environment: {
                ...IMAGE_CONTRACT.environment,
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
            mounts: [
                { type: 'volume', name: identity.volumes.containers, source: '', destination: '/home/podman/.local/share/containers', rw: true },
                { type: 'bind', name: '', source: repositoryRoot, destination: '/opt/ploinky', rw: false },
                { type: 'volume', name: identity.volumes.dependencies, source: '', destination: '/opt/ploinky/node_modules', rw: true },
                { type: 'bind', name: '', source: identity.workspaceRoot, destination: '/workspace', rw: true },
            ],
        },
    };
}

test('container validation ignores inherited image labels but rejects unknown ownership labels', (t) => {
    const state = fixture(t);
    const handle = containerHandle({
        identity: state.identity,
        repositoryRoot: state.root,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
        id: 'b'.repeat(64),
    });
    const desired = {
        identity: state.identity,
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
        repositoryRoot: state.root,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
        id: 'b'.repeat(64),
    });
    handle.runtime.devices = [];
    const desired = {
        identity: state.identity,
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
        repositoryRoot: state.root,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
        id: 'b'.repeat(64),
    });
    handle.runtime.devices = [];
    const desired = {
        identity: state.identity,
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
    corruptCidfile = false,
    failLocalStop = false,
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
                current = containerHandle({
                    identity: state.identity,
                    repositoryRoot: state.root,
                    imageId,
                    imageRef: imageRefLabel.slice(imageRefLabel.indexOf('=') + 1),
                    hostPort: Number(portLabel.slice(portLabel.indexOf('=') + 1)),
                    mediaHostPort: Number(mediaPortLabel.slice(mediaPortLabel.indexOf('=') + 1)),
                    id: cid,
                    running: false,
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
    const handles = volumeHandles(state.identity);
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
        ensureVolumes() {
            calls.push(['seam', 'ensure-volumes']);
            return {
                handles,
                created: initial ? [] : Object.entries(handles).map(([key, handle]) => ({ key, handle })),
            };
        },
        revalidateVolumes() { calls.push(['seam', 'revalidate-volumes']); },
        rollbackVolumes() { calls.push(['seam', 'rollback-volumes']); },
        removeContainer(engine, id, selectedRunner) {
            selectedRunner.run(engine.name, ['container', 'rm', '-f', '--volumes', id]);
        },
        stopPloinkyLocal(engine, id) {
            calls.push(['seam', 'stop-ploinky-local', engine.name, id]);
            if (failLocalStop) throw new Error('ploinky-local stop failed');
        },
        async waitReady(engine, id) {
            calls.push(['seam', 'wait-ready', id]);
            if (failCandidateReady && id === 'a'.repeat(64)) throw new Error('ready timeout');
        },
        discover() {
            calls.push(['seam', 'discover']);
            return current
                ? { state: 'owned', handles: { container: current, volumes: handles } }
                : { state: 'owned', handles: { container: null, volumes: handles } };
        },
        token(kind) { return kind === 'candidate' ? '1'.repeat(24) : '2'.repeat(24); },
    };
    return { runner, seams, calls, current: () => current };
}

test('container argv is exact, unprivileged, and ends with immutable image ID', (t) => {
    const state = fixture(t);
    const cidfile = path.join(state.lock.path, 'candidate.cid');
    const args = containerCreateArgs({
        identity: state.identity,
        imageId: 'a'.repeat(64),
        imageRef: 'docker.io/assistos/ploinky-box:runtime',
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
    assert.equal(args.filter((value) => value.endsWith(':U')).length, 2);
    assert.equal(args.includes(`${state.identity.workspaceRoot}:/workspace`), true);
    assert.equal(args.some((value) => value === `${state.identity.workspaceRoot}:/workspace:U`), false);
});

test('container validation rejects legacy workspace volumes and user-namespace drift', (t) => {
    const state = fixture(t);
    const desired = {
        identity: state.identity,
        repositoryRoot: state.root,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
    };
    const legacyMount = containerHandle({
        ...desired,
        id: 'b'.repeat(64),
    });
    legacyMount.runtime.mounts = legacyMount.runtime.mounts.map((mount) => (
        mount.destination === '/workspace'
            ? {
                type: 'volume',
                name: state.identity.legacyVolumes.workspace,
                source: '',
                destination: '/workspace',
                rw: true,
            }
            : mount
    ));
    assert.throws(
        () => validateContainerConfiguration(legacyMount, desired),
        (error) => /mount \/workspace is incompatible/.test(error.message)
            && /ploinky destroy/.test(error.message),
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
        repositoryRoot: state.root,
        imageId: 'd'.repeat(64),
        imageRef: 'docker.io/assistos/ploinky-box:runtime',
        hostPort: 8080,
        id: 'e'.repeat(64),
    });
    handle.runtime.init = false;

    assert.throws(() => validateContainerConfiguration(handle, {
        identity: state.identity,
        hostPort: 8080,
        imageId: 'd'.repeat(64),
        imageRef: 'docker.io/assistos/ploinky-box:runtime',
        repositoryRoot: state.root,
    }), /init state is incompatible/);
});

test('initial transaction preflights before pull, volumes, and container creation', async (t) => {
    const state = fixture(t);
    const h = harness(state);
    const result = await reconcileBoxContainer({
        identity: state.identity,
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
    assert.ok(flat.findIndex((value) => value.includes('stream podman pull')) < flat.findIndex((value) => value.includes('ensure-volumes')));
    assert.ok(flat.findIndex((value) => value.includes('ensure-volumes')) < flat.findIndex((value) => value.includes('container create')));
});

test('validated reuse rechecks pre-existing volume handles without registry or volume mutation', async (t) => {
    const state = fixture(t);
    const current = containerHandle({
        identity: state.identity,
        repositoryRoot: state.root,
        imageId: 'd'.repeat(64),
        imageRef: 'docker.io/assistos/ploinky-box:runtime',
        hostPort: 8080,
        id: 'e'.repeat(64),
    });
    const h = harness(state, { initial: current });
    const result = await reconcileBoxContainer({
        identity: state.identity,
        ownership: {
            state: 'owned',
            handles: { container: current, volumes: volumeHandles(state.identity) },
        },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
    }, h.seams);
    assert.equal(result.action, 'reused');
    assert.equal(h.calls.some((call) => call.includes('validate-existing-image')), true);
    assert.equal(h.calls.some((call) => call.includes('revalidate-volumes')), true);
    assert.equal(h.calls.some((call) => call.includes('pull')), false);
    assert.equal(h.calls.some((call) => call.includes('ensure-volumes')), false);
    assert.equal(h.calls.some((call) => call.includes('rollback-volumes')), false);
    assert.equal(h.calls.some((call) => call.join(' ').includes('volume rm')), false);
});

test('an incompatible owned image hard-cuts before any engine mutation', async (t) => {
    const state = fixture(t);
    const current = containerHandle({
        identity: state.identity,
        repositoryRoot: state.root,
        imageId: 'd'.repeat(64),
        imageRef: 'docker.io/assistos/ploinky-box:runtime',
        hostPort: 8080,
        id: 'e'.repeat(64),
        running: false,
    });
    const h = harness(state, { initial: current });
    h.seams.validateExistingImage = () => {
        const error = new Error('image configuration is incompatible; destroy and recreate the Box');
        error.code = 'PLOINKY_BOX_IMAGE_CONTRACT_HARD_CUT';
        throw error;
    };
    await assert.rejects(() => reconcileBoxContainer({
        identity: state.identity,
        ownership: {
            state: 'owned',
            handles: { container: current, volumes: volumeHandles(state.identity) },
        },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
    }, h.seams), (error) => (
        error.code === 'PLOINKY_BOX_IMAGE_CONTRACT_HARD_CUT'
            && /destroy and recreate/i.test(error.message)
    ));
    assert.deepEqual(h.calls, []);
});

test('preflight and pull failures produce zero resource mutation', async (t) => {
    for (const scenario of [{ failPreflight: true }, { failPull: true }]) {
        const state = fixture(t);
        const h = harness(state, scenario);
        await assert.rejects(() => reconcileBoxContainer({
            identity: state.identity,
            ownership: { state: 'absent', handles: null },
            engine: { name: 'podman', identity: 'engine' },
            runner: h.runner,
            lock: state.lock,
            repositoryRoot: state.root,
        }, h.seams));
        assert.equal(h.calls.some((call) => call.includes('ensure-volumes')), false);
        assert.equal(h.calls.some((call) => call.includes('create')), false);
        assert.equal(h.calls.some((call) => call.includes('rollback-volumes')), false);
    }
});

test('create races and ready timeouts remove candidates and transaction-created volumes', async (t) => {
    for (const scenario of [{ failCreate: true }, { failCandidateReady: true }]) {
        const state = fixture(t);
        const h = harness(state, scenario);
        await assert.rejects(() => reconcileBoxContainer({
            identity: state.identity,
            ownership: { state: 'absent', handles: null },
            engine: { name: 'podman', identity: 'engine' },
            runner: h.runner,
            lock: state.lock,
            repositoryRoot: state.root,
        }, h.seams), /transaction failed/);
        assert.equal(h.calls.some((call) => call.includes('rollback-volumes')), true);
        if (scenario.failCandidateReady) {
            assert.equal(h.calls.some((call) => call.join(' ').includes('container rm -f --volumes')), true);
        }
    }
});

test('replacement failure removes the candidate and restores the validated old image', async (t) => {
    const state = fixture(t);
    const oldImage = 'd'.repeat(64);
    const old = containerHandle({
        identity: state.identity,
        repositoryRoot: state.root,
        imageId: oldImage,
        imageRef: 'docker.io/assistos/ploinky-box:runtime',
        hostPort: 18080,
        mediaHostPort: 17880,
        id: 'e'.repeat(64),
    });
    const h = harness(state, { initial: old, failCandidateReady: true });
    await assert.rejects(() => reconcileBoxContainer({
        identity: state.identity,
        ownership: { state: 'owned', handles: { container: old, volumes: volumeHandles(state.identity) } },
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
    assert.equal(h.calls.some((call) => call.includes('rollback-volumes')), false);
    const removals = h.calls.filter((call) => call.join(' ').includes('container rm -f --volumes'));
    assert.equal(removals.length, 2);
});

test('successful replacement gracefully stops core before stopping and removing the old Box', async (t) => {
    const state = fixture(t);
    const old = containerHandle({
        identity: state.identity,
        repositoryRoot: state.root,
        imageId: 'd'.repeat(64),
        imageRef: 'docker.io/assistos/ploinky-box:runtime',
        hostPort: 18080,
        id: 'e'.repeat(64),
    });
    const h = harness(state, { initial: old });
    const result = await reconcileBoxContainer({
        identity: state.identity,
        ownership: { state: 'owned', handles: { container: old, volumes: volumeHandles(state.identity) } },
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
    const removal = events.findIndex((value) => value.includes('container rm -f --volumes'));
    const creation = events.findIndex((value) => value.includes('container create'));
    assert.ok(graceful >= 0 && graceful < outerStop);
    assert.ok(outerStop < removal && removal < creation);
});

test('ploinky-local replacement stop failure preserves the old same-image Box without candidate cleanup', async (t) => {
    const state = fixture(t);
    const oldImage = 'd'.repeat(64);
    const old = containerHandle({
        identity: state.identity,
        repositoryRoot: state.root,
        imageId: oldImage,
        imageRef: 'docker.io/assistos/ploinky-box:runtime',
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
        ownership: { state: 'owned', handles: { container: old, volumes: volumeHandles(state.identity) } },
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
    assert.equal(h.calls.some((call) => call.join(' ').includes('container rm -f --volumes')), false);
    assert.equal(h.calls.some((call) => call.join(' ').includes('container create')), false);
});

test('missing or corrupt cidfiles are fail-closed primitives', (t) => {
    const state = fixture(t);
    const missing = path.join(state.root, 'missing.cid');
    assert.throws(() => readContainerIdFromCidfile(missing), /missing/);
    const corrupt = path.join(state.root, 'corrupt.cid');
    fs.writeFileSync(corrupt, 'not-an-id\n');
    assert.throws(() => readContainerIdFromCidfile(corrupt), /corrupt/);
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
        () => waitForReadyLine({ name: 'podman' }, 'a'.repeat(64), runner),
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
        ownership: { state: 'absent', handles: null },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
    }, h.seams);
    assert.equal(result.action, 'created');
    assert.equal(result.ownership.handles.container.id, 'a'.repeat(64));
});
