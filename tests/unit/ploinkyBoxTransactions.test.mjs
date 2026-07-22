import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    BOX_LABELS,
    BOX_READY_LINE,
    BOX_RUNTIME_CONTRACT_LABEL,
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

function containerHandle({ identity, repositoryRoot, imageId, imageRef, hostPort, id, running = true }) {
    return {
        id,
        labels: {
            [BOX_RUNTIME_CONTRACT_LABEL]: '6',
            'io.buildah.version': '1.43.1',
            [BOX_LABELS.schema]: '1',
            [BOX_LABELS.pathHash]: identity.pathHash,
            [BOX_LABELS.role]: 'box',
            [BOX_LABELS.imageRef]: imageRef,
            [BOX_LABELS.routerHostPort]: String(hostPort),
        },
        runtime: {
            complete: true,
            imageId,
            configuredImage: imageId,
            user: 'podman',
            environment: {
                ...IMAGE_CONTRACT.environment,
                PLOINKY_PRIVATE_BIND: '0.0.0.0',
                PLOINKY_PUBLIC_BIND: '0.0.0.0',
                PLOINKY_PUBLIC_AUTHORITY: `127.0.0.1:${hostPort}`,
                HOSTNAME: id.slice(0, 12),
            },
            publications: [
                { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: '7882' },
                { containerPort: '8080', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: String(hostPort) },
            ],
            running,
            status: running ? 'running' : 'exited',
            privileged: false,
            securityOptions: ['unmask=ALL'],
            devices: [
                { hostPath: '/dev/fuse', containerPath: '/dev/fuse', permissions: 'rwm' },
                { hostPath: '/dev/net/tun', containerPath: '/dev/net/tun', permissions: 'rwm' },
            ],
            mounts: [
                { type: 'volume', name: identity.volumes.containers, source: '', destination: '/home/podman/.local/share/containers', rw: true },
                { type: 'bind', name: '', source: repositoryRoot, destination: '/opt/ploinky', rw: false },
                { type: 'volume', name: identity.volumes.dependencies, source: '', destination: '/opt/ploinky/node_modules', rw: true },
                { type: 'volume', name: identity.volumes.workspace, source: '', destination: '/workspace', rw: true },
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
    assert.throws(
        () => validateContainerConfiguration(handle, desired),
        /device set is incompatible/,
    );
    assert.throws(
        () => validateContainerConfiguration(handle, {
            ...desired,
            hostKind: 'podman-machine',
        }),
        /security options are incompatible/,
    );
    handle.runtime.securityOptions = ['label=disable', 'unmask=ALL'];
    assert.doesNotThrow(() => validateContainerConfiguration(handle, {
        ...desired,
        hostKind: 'podman-machine',
    }));
});

test('Podman Machine container argv disables only its outer SELinux label confinement', (t) => {
    const state = fixture(t);
    const args = containerCreateArgs({
        identity: state.identity,
        imageId: 'a'.repeat(64),
        imageRef: 'runtime',
        hostPort: 19090,
        repositoryRoot: state.root,
        cidfile: path.join(state.root, 'candidate.cid'),
        hostKind: 'podman-machine',
    });
    assert.deepEqual(args.flatMap((value, index) => (
        value === '--security-opt' ? [args[index + 1]] : []
    )), ['unmask=ALL', 'label=disable']);
    assert.equal(args.includes('--privileged'), false);
});

function harness(state, {
    initial = null,
    candidateImage = 'c'.repeat(64),
    failPreflight = false,
    failPull = false,
    failCreate = false,
    failCandidateReady = false,
    corruptCidfile = false,
    failCoreStop = false,
} = {}) {
    const calls = [];
    let current = initial;
    let createCount = 0;
    const runner = {
        run(command, args) {
            calls.push(['run', command, ...args]);
            if (args[0] === 'pull' && failPull) throw new Error('pull failed');
            if (args[0] === 'container' && args[1] === 'create') {
                if (failCreate) throw new Error('create race');
                createCount += 1;
                const cid = createCount === 1 ? 'a'.repeat(64) : 'b'.repeat(64);
                const cidfile = args[args.indexOf('--cidfile') + 1];
                fs.writeFileSync(cidfile, corruptCidfile && createCount === 1 ? 'corrupt\n' : `${cid}\n`, { mode: 0o600 });
                const imageId = args.at(-1);
                const imageRefLabel = args.find((value) => value.startsWith(`${BOX_LABELS.imageRef}=`));
                const portLabel = args.find((value) => value.startsWith(`${BOX_LABELS.routerHostPort}=`));
                current = containerHandle({
                    identity: state.identity,
                    repositoryRoot: state.root,
                    imageId,
                    imageRef: imageRefLabel.slice(imageRefLabel.indexOf('=') + 1),
                    hostPort: Number(portLabel.slice(portLabel.indexOf('=') + 1)),
                    id: cid,
                    running: false,
                });
            }
            if (args[0] === 'container' && args[1] === 'start') current.runtime.running = true;
            if (args[0] === 'container' && args[1] === 'stop') current.runtime.running = false;
            if (args[0] === 'container' && args[1] === 'rm') current = null;
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
        stopCore(engine, id) {
            calls.push(['seam', 'stop-core', engine.name, id]);
            if (failCoreStop) throw new Error('graceful core stop failed');
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

test('container argv is exact, least-privileged, and ends with immutable image ID', (t) => {
    const state = fixture(t);
    const cidfile = path.join(state.lock.path, 'candidate.cid');
    const args = containerCreateArgs({
        identity: state.identity,
        imageId: 'a'.repeat(64),
        imageRef: 'docker.io/assistos/ploinky-box:runtime',
        hostPort: 19090,
        repositoryRoot: state.root,
        cidfile,
    });
    assert.equal(args.at(-1), 'a'.repeat(64));
    assert.equal(args.includes('--privileged'), false);
    assert.equal(args.some((value) => value.includes('docker.sock') || value.includes('podman.sock')), false);
    assert.equal(args.filter((value) => value === '--publish').length, 2);
    assert.equal(args.includes('127.0.0.1:19090:8080/tcp'), true);
    assert.equal(args.includes('0.0.0.0:7882:7882/udp'), true);
    assert.equal(args.includes('unmask=ALL'), true);
    assert.equal(args.includes('/dev/fuse'), true);
    assert.equal(args.includes('/dev/net/tun'), true);
    assert.equal(args.filter((value) => value.endsWith(':U')).length, 3);
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
    }, h.seams);
    assert.equal(result.action, 'created');
    const flat = h.calls.map((call) => call.join(' '));
    assert.ok(flat.findIndex((value) => value.includes('preflight')) < flat.findIndex((value) => value.includes('run podman pull')));
    assert.ok(flat.findIndex((value) => value.includes('run podman pull')) < flat.findIndex((value) => value.includes('ensure-volumes')));
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

test('an older owned image contract hard-cuts before any engine mutation', async (t) => {
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
        const error = new Error('contract 5; destroy and recreate the Box');
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
    }, h.seams), /transaction failed/);
    assert.equal(h.current().runtime.imageId, oldImage);
    assert.equal(h.current().runtime.running, true);
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
    const graceful = events.findIndex((value) => value.includes('seam stop-core'));
    const outerStop = events.findIndex((value) => value.includes('container stop --time 30'));
    const removal = events.findIndex((value) => value.includes('container rm -f --volumes'));
    const creation = events.findIndex((value) => value.includes('container create'));
    assert.ok(graceful >= 0 && graceful < outerStop);
    assert.ok(outerStop < removal && removal < creation);
});

test('graceful replacement failure preserves the old same-image Box without candidate cleanup', async (t) => {
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
        failCoreStop: true,
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
            && /graceful core stop failed/.test(error.cause?.message || '')
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

test('readiness failure preserves bounded container self-check diagnostics', async () => {
    const runner = {
        query(_command, args) {
            if (args[1] === 'logs') {
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
