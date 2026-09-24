import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import {
    BOX_IMAGE_REFERENCE,
    BOX_LABELS,
    BOX_READY_LINE,
    BOX_ROUTER_HEALTH_SOCKET,
    BOX_TMPFS,
    BOX_USERNS,
} from '../../ploinky-box/constants.mjs';
import { validateContainerConfiguration } from '../../ploinky-box/contract/container.mjs';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import { writeGraphSkillScope } from '../../ploinky-box/graphSkillScope.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { containerCreateArgs } from '../../ploinky-box/lifecycle/container.mjs';
import { reconcileBoxContainer } from '../../ploinky-box/lifecycle/transactions.mjs';
import { preflightPublications, recheckReleasedPublications } from '../../ploinky-box/ports.mjs';
import {
    nestedPodmanSeccompProfileContract,
    nestedPodmanSeccompProfilePath,
} from '../../ploinky-box/seccomp.mjs';
import { buildHostSkillScope } from '../../ploinky-box/skillScope.mjs';
import {
    checkBoxHealth,
    createBoxSupervisor,
    formatBindResult,
    formatBoxStatus,
    runBoundedCoreStart,
} from '../../ploinky-box/supervisor.mjs';
import {
    agentLibFixture,
    agentLibFixtureEnv,
    agentLibFixtureLabels,
    agentLibFixtureMounts,
} from '../helpers/agentlibFixture.mjs';

const DATA_FINGERPRINTS = Object.freeze({ dependencies: 'd'.repeat(64), images: 'f'.repeat(64) });
const TMPFS_CREATE_ARGUMENT = `${BOX_TMPFS.destination}:${BOX_TMPFS.options.join(',')}`;
const TMPFS_INSPECTED_OPTIONS = Object.freeze([
    ...BOX_TMPFS.options.filter((option) => option !== 'notmpcopyup'),
    'rprivate',
].sort());
const OLD_ID = 'e'.repeat(64);
const OLD_IMAGE = 'd'.repeat(64);
const LAN_HOSTS = Object.freeze(['192.168.1.63', 'apparatus', 'apparatus.local']);
const LOOPBACK = Object.freeze({ address: '127.0.0.1', hostPort: 8083, hosts: null });
const INTERFACES = Object.freeze({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wlp0s20f3: [{ address: '192.168.1.63', family: 'IPv4', internal: false }],
    podman0: [{ address: '10.88.0.1', family: 'IPv4', internal: false }],
});

function wildcard(hostPort = 8083, hosts = LAN_HOSTS) {
    return { address: '0.0.0.0', hostPort, hosts: [...hosts] };
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-bind-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const lockPath = path.join(root, 'lock');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    fs.mkdirSync(lockPath);
    const seccompProfile = nestedPodmanSeccompProfilePath(root);
    fs.mkdirSync(path.dirname(seccompProfile), { recursive: true });
    fs.copyFileSync(
        new URL('../../ploinky-box/seccomp/podman-nested-pid-fallback.json', import.meta.url),
        seccompProfile,
    );
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const lock = {
        path: lockPath,
        assertHeld(instance) { assert.equal(instance, identity.instance); },
    };
    return { root, identity, lock, agentLib: agentLibFixture(identity.workspaceRoot) };
}

function containerHandle(state, {
    id = OLD_ID,
    imageId = OLD_IMAGE,
    imageRef = BOX_IMAGE_REFERENCE,
    hostPort = 8083,
    mediaHostPort = 7882,
    routerBinding = null,
    running = true,
} = {}) {
    const address = routerBinding?.address ?? '127.0.0.1';
    const hosts = routerBinding?.hosts ?? null;
    return {
        id,
        labels: {
            ...agentLibFixtureLabels(state.agentLib),
            [BOX_LABELS.pathHash]: state.identity.pathHash,
            [BOX_LABELS.role]: 'box',
            [BOX_LABELS.imageRef]: imageRef,
            [BOX_LABELS.routerHostPort]: String(hostPort),
            [BOX_LABELS.mediaHostPort]: String(mediaHostPort),
            ...(address === '127.0.0.1' ? {} : { [BOX_LABELS.routerBindAddress]: address }),
            [BOX_LABELS.seccompFingerprint]: nestedPodmanSeccompProfileContract(state.root).fingerprint,
            [BOX_LABELS.dependenciesFingerprint]: DATA_FINGERPRINTS.dependencies,
            [BOX_LABELS.imagesFingerprint]: DATA_FINGERPRINTS.images,
        },
        runtime: {
            complete: true,
            imageId,
            configuredImage: imageId,
            user: 'podman',
            workingDir: state.identity.workspaceRoot,
            createCommand: [
                'podman', 'container', 'create', '--init', '--userns', BOX_USERNS,
                '--device', '/dev/fuse', '--device', '/dev/net/tun', '--tmpfs', TMPFS_CREATE_ARGUMENT,
            ],
            environment: {
                ...IMAGE_CONTRACT.environment,
                PLOINKY_WORKSPACE_ROOT: state.identity.workspaceRoot,
                ...agentLibFixtureEnv(state.agentLib),
                PLOINKY_PRIVATE_BIND: '0.0.0.0',
                PLOINKY_PUBLIC_BIND: '0.0.0.0',
                PLOINKY_PUBLIC_AUTHORITY: `${['127.0.0.1', '0.0.0.0'].includes(address) ? '127.0.0.1' : address}:${hostPort}`,
                PLOINKY_ROUTER_HEALTH_SOCKET: BOX_ROUTER_HEALTH_SOCKET,
                ...(hosts ? { PLOINKY_PUBLIC_ROUTER_HOSTS: JSON.stringify(hosts) } : {}),
                HOSTNAME: id.slice(0, 12),
            },
            publications: [
                { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: String(mediaHostPort) },
                { containerPort: '8080', protocol: 'tcp', hostIp: address, hostPort: String(hostPort) },
            ],
            running,
            status: running ? 'running' : 'exited',
            init: true,
            usernsMode: 'private',
            privileged: false,
            securityOptions: [
                'label=disable',
                'unmask=ALL',
                `seccomp=${nestedPodmanSeccompProfilePath(state.root)}`,
            ],
            devices: [
                { hostPath: '/dev/fuse', containerPath: '/dev/fuse', permissions: 'rwm' },
                { hostPath: '/dev/net/tun', containerPath: '/dev/net/tun', permissions: 'rwm' },
            ],
            tmpfs: [{ destination: BOX_TMPFS.destination, options: [...TMPFS_INSPECTED_OPTIONS] }],
            mounts: [
                { type: 'bind', name: '', source: state.identity.dataPaths.images, destination: '/home/podman/.local/share/ploinky-images', rw: true },
                { type: 'bind', name: '', source: state.root, destination: '/opt/ploinky', rw: false },
                { type: 'bind', name: '', source: state.identity.dataPaths.dependencies, destination: '/opt/ploinky/node_modules', rw: true },
                { type: 'bind', name: '', source: state.identity.workspaceRoot, destination: state.identity.workspaceRoot, rw: true },
                ...agentLibFixtureMounts(state.agentLib, state.identity.workspaceRoot),
            ],
        },
    };
}

function optionValues(args, name) {
    return args.flatMap((value, index) => (value === name ? [args[index + 1]] : []));
}

function suffixAfter(values, prefix) {
    const value = values.find((item) => item.startsWith(prefix));
    return value === undefined ? undefined : value.slice(prefix.length);
}

// The fake engine records a created Box exactly as its create arguments
// describe it, so validation proves what the lifecycle actually requested.
function harness(state, {
    initial = null,
    candidateImage = 'c'.repeat(64),
    failCandidateReady = false,
    failLocalStop = false,
    failRemove = false,
} = {}) {
    const calls = [];
    let current = initial;
    let createCount = 0;
    const runner = {
        run(command, args) {
            calls.push(['run', command, ...args]);
            if (args[0] === 'container' && args[1] === 'create') {
                createCount += 1;
                const id = createCount === 1 ? 'a'.repeat(64) : 'b'.repeat(64);
                fs.writeFileSync(args[args.indexOf('--cidfile') + 1], `${id}\n`, { mode: 0o600 });
                const labels = optionValues(args, '--label');
                const environment = optionValues(args, '--env');
                const [address, hostPort] = optionValues(args, '--publish')[0].split(':');
                const created = containerHandle(state, {
                    id,
                    imageId: args.at(-1),
                    imageRef: suffixAfter(labels, `${BOX_LABELS.imageRef}=`),
                    hostPort: Number(hostPort),
                    mediaHostPort: Number(suffixAfter(labels, `${BOX_LABELS.mediaHostPort}=`)),
                    running: false,
                });
                created.runtime.publications[1].hostIp = address;
                const bindLabel = suffixAfter(labels, `${BOX_LABELS.routerBindAddress}=`);
                if (bindLabel !== undefined) created.labels[BOX_LABELS.routerBindAddress] = bindLabel;
                created.runtime.environment.PLOINKY_PUBLIC_AUTHORITY = suffixAfter(environment, 'PLOINKY_PUBLIC_AUTHORITY=');
                const hosts = suffixAfter(environment, 'PLOINKY_PUBLIC_ROUTER_HOSTS=');
                if (hosts !== undefined) created.runtime.environment.PLOINKY_PUBLIC_ROUTER_HOSTS = hosts;
                current = created;
            }
            if (args[0] === 'container' && args[1] === 'start') current.runtime.running = true;
            if (args[0] === 'container' && args[1] === 'stop') current.runtime.running = false;
            if (args[0] === 'container' && args[1] === 'rm') current = null;
        },
        async stream(command, args) {
            calls.push(['stream', command, ...args]);
            return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        query(command, args) {
            calls.push(['query', command, ...args]);
            return { ok: true, stdout: `${BOX_READY_LINE}\n`, stderr: '' };
        },
    };
    const seams = {
        async preflight(options) {
            calls.push(['seam', 'preflight', options.address, String(options.hostPort)]);
            return {
                hostPort: options.hostPort,
                mediaHostPort: options.mediaHostPort,
                address: options.address,
                recheckAfterRelease: { tcp: false, udp: false },
            };
        },
        async recheckReleased(preflight) {
            calls.push(['seam', 'recheck', preflight.address]);
        },
        validateImage() {
            calls.push(['seam', 'validate-image']);
            return { immutableId: candidateImage };
        },
        validateExistingImage(_engine, imageId) {
            calls.push(['seam', 'validate-existing-image', imageId]);
            return { immutableId: imageId };
        },
        removeContainer(engine, id, selectedRunner) {
            if (failRemove) {
                calls.push(['seam', 'remove-failed', id]);
                throw new Error('remove failed');
            }
            selectedRunner.run(engine.name, ['container', 'rm', '-f', id]);
        },
        stopPloinkyLocal(_engine, id) {
            calls.push(['seam', 'stop-ploinky-local', id]);
            if (failLocalStop) throw new Error('ploinky-local stop failed');
        },
        async startAndWaitReady(engine, id, selectedRunner) {
            selectedRunner.run(engine.name, ['container', 'start', id]);
            calls.push(['seam', 'wait-ready', id]);
            if (failCandidateReady && id === 'a'.repeat(64)) throw new Error('ready timeout');
        },
        discover() {
            calls.push(['seam', 'discover']);
            return current ? { state: 'owned', handles: { container: current } } : { state: 'absent', handles: null };
        },
        ensureDataPaths: () => ({ paths: state.identity.dataPaths, fingerprints: DATA_FINGERPRINTS, created: [] }),
        inspectDataPaths: () => ({ paths: state.identity.dataPaths, fingerprints: DATA_FINGERPRINTS }),
        revalidateDataPaths: () => ({ paths: state.identity.dataPaths, fingerprints: DATA_FINGERPRINTS }),
        retireStartLock() {},
        retireEdgePreparation() {},
        token: (kind) => (kind === 'candidate' ? '1'.repeat(24) : '2'.repeat(24)),
    };
    return { runner, seams, calls, current: () => current };
}

function reconcileArguments(state, h, initial, extra = {}) {
    return {
        identity: state.identity,
        agentLib: state.agentLib,
        ownership: initial ? { state: 'owned', handles: { container: initial } } : { state: 'absent', handles: null },
        engine: { name: 'podman', identity: 'engine' },
        runner: h.runner,
        lock: state.lock,
        repositoryRoot: state.root,
        stdout: { write() {} },
        stderr: { write() {} },
        ...extra,
    };
}

function flat(calls) {
    return calls.map((call) => call.join(' '));
}

test('create arguments publish exactly one Router TCP binding and keep media UDP unchanged', (t) => {
    const state = fixture(t);
    const base = {
        identity: state.identity,
        dataFingerprints: DATA_FINGERPRINTS,
        agentLib: state.agentLib,
        imageId: 'a'.repeat(64),
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 8083,
        mediaHostPort: 17891,
        repositoryRoot: state.root,
        cidfile: path.join(state.root, 'candidate.cid'),
    };
    const legacy = containerCreateArgs(base);
    assert.deepEqual(containerCreateArgs({ ...base, routerBinding: LOOPBACK }), legacy);
    assert.deepEqual(optionValues(legacy, '--publish'), ['127.0.0.1:8083:8080/tcp', '0.0.0.0:17891:7882/udp']);
    assert.equal(optionValues(legacy, '--env').includes('PLOINKY_PUBLIC_AUTHORITY=127.0.0.1:8083'), true);
    assert.equal(legacy.some((value) => (
        value.startsWith(`${BOX_LABELS.routerBindAddress}=`) || value.startsWith('PLOINKY_PUBLIC_ROUTER_HOSTS=')
    )), false);

    const wide = containerCreateArgs({ ...base, routerBinding: wildcard() });
    assert.deepEqual(optionValues(wide, '--publish'), ['0.0.0.0:8083:8080/tcp', '0.0.0.0:17891:7882/udp']);
    assert.equal(optionValues(wide, '--label').includes(`${BOX_LABELS.routerBindAddress}=0.0.0.0`), true);
    assert.equal(optionValues(wide, '--env').includes(
        'PLOINKY_PUBLIC_ROUTER_HOSTS=["192.168.1.63","apparatus","apparatus.local"]',
    ), true);
    assert.equal(optionValues(wide, '--env').includes('PLOINKY_PUBLIC_AUTHORITY=127.0.0.1:8083'), true);

    const specific = containerCreateArgs({ ...base, routerBinding: { address: '192.168.1.63', hosts: ['192.168.1.63'] } });
    assert.deepEqual(optionValues(specific, '--publish'), ['192.168.1.63:8083:8080/tcp', '0.0.0.0:17891:7882/udp']);
    assert.equal(optionValues(specific, '--env').includes('PLOINKY_PUBLIC_AUTHORITY=192.168.1.63:8083'), true);

    for (const args of [legacy, wide, specific]) {
        assert.equal(args.includes('--privileged'), false);
        assert.equal(args.some((value) => /^--(?:network|net)(?:=|$)/.test(value)), false);
        assert.equal(optionValues(args, '--publish').some((value) => /:(?:8081|7000)\//.test(value)), false);
        assert.deepEqual(optionValues(args, '--userns'), [BOX_USERNS]);
    }
    assert.throws(() => containerCreateArgs({ ...base, routerBinding: { address: '0.0.0.0' } }), /trusted outer host list/);
    assert.throws(() => containerCreateArgs({ ...base, routerBinding: { address: '127.0.0.1', hosts: ['192.168.1.63'] } }), /loopback/);
});

test('legacy loopback Boxes validate without bind metadata and never satisfy a wider binding', (t) => {
    const state = fixture(t);
    const desired = {
        identity: state.identity,
        agentLib: state.agentLib,
        repositoryRoot: state.root,
        imageId: OLD_IMAGE,
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 8083,
        dataFingerprints: DATA_FINGERPRINTS,
    };
    const legacy = containerHandle(state);
    assert.doesNotThrow(() => validateContainerConfiguration(legacy, desired));
    assert.doesNotThrow(() => validateContainerConfiguration(legacy, { ...desired, routerBinding: LOOPBACK }));
    assert.throws(
        () => validateContainerConfiguration(legacy, { ...desired, routerBinding: wildcard() }),
        /does not match the selected binding/,
    );
    const bound = containerHandle(state, { routerBinding: wildcard() });
    assert.doesNotThrow(() => validateContainerConfiguration(bound, { ...desired, routerBinding: wildcard() }));
    assert.throws(
        () => validateContainerConfiguration(bound, { ...desired, routerBinding: wildcard(8083, ['192.168.1.63']) }),
        /does not match the selected binding/,
    );
    const extraEnvironment = containerHandle(state, { routerBinding: wildcard() });
    extraEnvironment.runtime.environment.PLOINKY_UNEXPECTED = '1';
    assert.throws(() => validateContainerConfiguration(extraEnvironment, desired), /environment allowlist/);
});

test('an address-only change replaces the Box with the same image, port, and media publication', async (t) => {
    const state = fixture(t);
    const initial = containerHandle(state, { mediaHostPort: 17891 });
    const h = harness(state, { initial });
    const result = await reconcileBoxContainer(reconcileArguments(state, h, initial, {
        routerBinding: wildcard(),
        imagePolicy: 'preserve',
    }), h.seams);

    assert.equal(result.action, 'replaced');
    assert.deepEqual(result.routerBinding, wildcard());
    assert.deepEqual(result.previousRouterBinding, LOOPBACK);
    const replacement = h.current();
    assert.equal(replacement.runtime.imageId, OLD_IMAGE);
    assert.deepEqual(replacement.runtime.publications, [
        { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: '17891' },
        { containerPort: '8080', protocol: 'tcp', hostIp: '0.0.0.0', hostPort: '8083' },
    ]);
    const events = flat(h.calls);
    assert.equal(events.some((value) => value.includes(' pull ') || value.endsWith(' validate-image')), false);
    const order = [
        'seam preflight 0.0.0.0 8083',
        `seam stop-ploinky-local ${OLD_ID}`,
        `run podman container stop --time 30 ${OLD_ID}`,
        `run podman container rm -f ${OLD_ID}`,
        'seam recheck 0.0.0.0',
    ].map((prefix) => events.findIndex((value) => value.startsWith(prefix)));
    order.push(events.findIndex((value) => value.startsWith('run podman container create')));
    assert.equal(order.every((index) => index >= 0), true, JSON.stringify(order));
    assert.deepEqual([...order].sort((left, right) => left - right), order);
});

test('an equivalent binding is idempotent reuse without engine mutation', async (t) => {
    const state = fixture(t);
    const initial = containerHandle(state, { routerBinding: wildcard() });
    const h = harness(state, { initial });
    const result = await reconcileBoxContainer(reconcileArguments(state, h, initial, {
        routerBinding: wildcard(),
        imagePolicy: 'preserve',
    }), h.seams);
    assert.equal(result.action, 'reused');
    assert.deepEqual(result.routerBinding, wildcard());
    assert.equal(h.current(), initial);
    assert.equal(h.calls.some((call) => ['create', 'rm', 'stop', 'start', 'pull'].some((word) => call.includes(word))), false);
});

test('finalization rejects an exact Box that stopped after reconciliation', async (t) => {
    for (const replace of [false, true]) {
        const state = fixture(t);
        const initial = containerHandle(state, { routerBinding: replace ? null : wildcard() });
        const h = harness(state, { initial });
        const result = await reconcileBoxContainer(reconcileArguments(state, h, initial, {
            routerBinding: wildcard(), imagePolicy: 'preserve',
        }), h.seams);
        h.current().runtime.running = false;
        assert.throws(() => result.finalize(), /changed|running/);
    }
});

test('a trusted-host change alone replaces the Box', async (t) => {
    const state = fixture(t);
    const initial = containerHandle(state, { routerBinding: wildcard(8083, ['192.168.1.63']) });
    const h = harness(state, { initial });
    const result = await reconcileBoxContainer(reconcileArguments(state, h, initial, {
        routerBinding: wildcard(),
        imagePolicy: 'preserve',
    }), h.seams);
    assert.equal(result.action, 'replaced');
    assert.equal(
        h.current().runtime.environment.PLOINKY_PUBLIC_ROUTER_HOSTS,
        '["192.168.1.63","apparatus","apparatus.local"]',
    );
});

test('a listener on another interface or after release restores the loopback publication', async (t) => {
    const state = fixture(t);
    const initial = containerHandle(state);
    const h = harness(state, { initial });
    // Use the real overlap rules: the wildcard probe is excused by the old
    // loopback listener, every other interface is free, and the recheck after
    // release proves the port is still owned by someone else.
    h.seams.preflight = (options) => preflightPublications({
        ...options,
        checkTcp: async (_port, { host }) => host !== '0.0.0.0',
        checkUdp: async () => false,
        localAddresses: () => ['127.0.0.1', '192.168.1.63'],
    });
    h.seams.recheckReleased = (preflight) => recheckReleasedPublications(preflight, {
        checkTcp: async () => false,
        checkUdp: async () => true,
        timeoutMs: 0,
        delay: async () => {},
    });
    await assert.rejects(
        () => reconcileBoxContainer(reconcileArguments(state, h, initial, {
            routerBinding: wildcard(),
            imagePolicy: 'preserve',
        }), h.seams),
        (error) => {
            assert.match(error.message, /0\.0\.0\.0:8083 is still in use after the previous Box released it/);
            assert.equal(error.boxRollback.action, 'restored');
            assert.equal(error.boxRollback.oldStopAttempted, true);
            assert.deepEqual(error.boxRollback.routerBinding, LOOPBACK);
            return true;
        },
    );
    const restored = h.current();
    assert.equal(restored.runtime.running, true);
    assert.deepEqual(restored.runtime.publications[1], {
        containerPort: '8080', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: '8083',
    });
    assert.equal(restored.labels[BOX_LABELS.routerBindAddress], undefined);
    assert.equal(restored.runtime.environment.PLOINKY_PUBLIC_ROUTER_HOSTS, undefined);
    const creates = h.calls.filter((call) => call[2] === 'container' && call[3] === 'create');
    assert.equal(creates.length, 1);
    assert.equal(creates[0].includes('127.0.0.1:8083:8080/tcp'), true);

    const conflicted = fixture(t);
    const conflictedInitial = containerHandle(conflicted);
    const early = harness(conflicted, { initial: conflictedInitial });
    early.seams.preflight = (options) => preflightPublications({
        ...options,
        checkTcp: async (_port, { host }) => !['0.0.0.0', '192.168.1.63'].includes(host),
        checkUdp: async () => false,
        localAddresses: () => ['127.0.0.1', '192.168.1.63'],
    });
    await assert.rejects(
        () => reconcileBoxContainer(reconcileArguments(conflicted, early, conflictedInitial, {
            routerBinding: wildcard(),
            imagePolicy: 'preserve',
        }), early.seams),
        /192\.168\.1\.63:8083 is already in use by another listener/,
    );
    assert.equal(early.current(), conflictedInitial);
    assert.equal(early.calls.some((call) => ['stop', 'rm', 'create'].some((word) => call.includes(word))), false);
});

test('failures before old-container removal leave its publication and report the stop attempt', async (t) => {
    for (const scenario of ['preflight', 'local-stop', 'remove']) {
        const state = fixture(t);
        const initial = containerHandle(state);
        const h = harness(state, {
            initial,
            failLocalStop: scenario === 'local-stop',
            failRemove: scenario === 'remove',
        });
        if (scenario === 'preflight') {
            h.seams.preflight = async () => { throw new Error('Physical-host TCP 0.0.0.0:8083 is already in use'); };
        }
        await assert.rejects(
            () => reconcileBoxContainer(reconcileArguments(state, h, initial, {
                routerBinding: wildcard(),
                imagePolicy: 'preserve',
            }), h.seams),
            (error) => {
                if (scenario === 'preflight') {
                    assert.equal(error.boxRollback, undefined);
                } else {
                    assert.equal(error.boxRollback.action, 'preserved', scenario);
                    assert.equal(error.boxRollback.containerId, OLD_ID);
                    assert.equal(error.boxRollback.oldStopAttempted, true);
                    assert.equal(error.boxRollback.previouslyRunning, true);
                }
                return true;
            },
        );
        assert.equal(h.current(), initial, scenario);
        assert.equal(h.calls.some((call) => call.includes('create')), false, scenario);
        // A failed removal happens after the graceful stop; the supervisor
        // restarts that exact Box through the reuse lifecycle.
        assert.equal(initial.runtime.running, scenario !== 'remove', scenario);
    }
});

test('failures after old-container removal restore the previous binding, including explicit rollback', async (t) => {
    const state = fixture(t);
    const initial = containerHandle(state);
    const h = harness(state, { initial, failCandidateReady: true });
    await assert.rejects(
        () => reconcileBoxContainer(reconcileArguments(state, h, initial, {
            routerBinding: wildcard(),
            imagePolicy: 'preserve',
        }), h.seams),
        (error) => error.boxRollback.action === 'restored' && error.boxRollback.containerId === 'b'.repeat(64),
    );
    assert.equal(h.current().runtime.publications[1].hostIp, '127.0.0.1');
    assert.equal(h.current().runtime.imageId, OLD_IMAGE);

    const committed = fixture(t);
    const committedInitial = containerHandle(committed);
    const later = harness(committed, { initial: committedInitial });
    const result = await reconcileBoxContainer(reconcileArguments(committed, later, committedInitial, {
        routerBinding: wildcard(),
        imagePolicy: 'preserve',
    }), later.seams);
    assert.equal(later.current().runtime.publications[1].hostIp, '0.0.0.0');
    const rolledBack = await result.rollback();
    assert.equal(rolledBack.action, 'restored');
    assert.deepEqual(rolledBack.routerBinding, LOOPBACK);
    assert.equal(later.current().runtime.publications[1].hostIp, '127.0.0.1');
    assert.equal(later.current().labels[BOX_LABELS.routerBindAddress], undefined);
    assert.equal(later.current().runtime.environment.PLOINKY_PUBLIC_ROUTER_HOSTS, undefined);
});

test('the preserve image policy never pulls and needs a local image when no Box exists', async (t) => {
    const state = fixture(t);
    const h = harness(state);
    const created = await reconcileBoxContainer(reconcileArguments(state, h, null, {
        routerBinding: wildcard(),
        imagePolicy: 'preserve',
    }), h.seams);
    assert.equal(created.action, 'created');
    assert.equal(h.calls.some((call) => call.includes('pull')), false);
    assert.equal(h.calls.some((call) => call.includes('validate-image')), true);

    const missing = fixture(t);
    const absent = harness(missing);
    absent.seams.validateImage = () => { throw new Error('image inspection unavailable (command-failed)'); };
    await assert.rejects(
        () => reconcileBoxContainer(reconcileArguments(missing, absent, null, {
            routerBinding: wildcard(),
            imagePolicy: 'preserve',
        }), absent.seams),
        /never pulls images/,
    );
    assert.equal(absent.calls.some((call) => call.includes('create') || call.includes('pull')), false);
    await assert.rejects(
        () => reconcileBoxContainer(reconcileArguments(missing, absent, null, { imagePolicy: 'latest' }), absent.seams),
        /Unsupported Box image policy/,
    );
});

function fakeLockManager(root, events) {
    return {
        async acquire(instance) {
            const lockPath = fs.mkdtempSync(path.join(root, 'supervisor-lock-'));
            events.push('lock');
            let released = false;
            return {
                path: lockPath,
                assertHeld(expected) {
                    assert.equal(released, false);
                    assert.equal(expected, instance);
                },
                release() {
                    released = true;
                    events.push('release');
                },
            };
        },
    };
}

function memoryStore(events, initial = null) {
    let value = initial;
    return {
        get value() { return value; },
        read() {
            events.push('store-read');
            return value;
        },
        write(identity, binding, lock) {
            lock.assertHeld(identity.instance);
            events.push(`store-write:${binding.address}:${binding.hostPort}`);
            value = Object.freeze({ address: binding.address, hostPort: binding.hostPort, containerPort: 8080 });
            return value;
        },
        restore(identity, previous, lock) {
            lock.assertHeld(identity.instance);
            events.push(`store-restore:${previous ? `${previous.address}:${previous.hostPort}` : 'none'}`);
            value = previous;
        },
    };
}

function boxWorkspace(t, { running = true, routerBinding = null, hostPort = 8083, graph = true, scope = true } = {}) {
    const state = fixture(t);
    if (graph) {
        fs.writeFileSync(path.join(state.identity.anchorPath, 'routing.json'), JSON.stringify({
            static: { agent: 'explorer' },
            port: 8080,
            routes: {},
        }));
    }
    const scopeEnv = buildHostSkillScope(state.identity.workspaceRoot, state.identity.workspaceRoot);
    if (scope) {
        writeGraphSkillScope(state.identity, scopeEnv, {
            assertHeld(instance) { assert.equal(instance, state.identity.instance); },
        });
    }
    const container = containerHandle(state, { hostPort, routerBinding, running });
    const ownership = { state: 'owned', engine: { name: 'podman', identity: 'engine' }, handles: { container } };
    return { ...state, scopeEnv, container, ownership };
}

function bindSupervisor(box, events, overrides = {}) {
    return createBoxSupervisor({
        checkHostPrerequisites: () => {},
        env: {},
        platform: 'linux',
        resolveIdentity: () => box.identity,
        launchCwd: box.identity.workspaceRoot,
        lockManager: fakeLockManager(box.root, events),
        discover: () => box.ownership,
        repositoryRoot: box.root,
        runner: {
            run(_command, args) { events.push(`run:${args.join(' ')}`); },
            async stream(_command, args) {
                events.push(`stream:${args.at(-1)}`);
                return { ok: true, status: 0, stdout: '', stderr: '' };
            },
            query(_command, args) {
                events.push(`query:${args.at(-1)}`);
                return {
                    ok: true,
                    status: 0,
                    stdout: JSON.stringify({
                        state: 'running',
                        initialized: true,
                        routingConfigured: true,
                        trackedAgents: 1,
                        runningAgents: 1,
                        warnings: [],
                    }),
                };
            },
        },
        routerBindingStore: memoryStore(events),
        readNetworkInterfaces: () => INTERFACES,
        readHostname: () => 'apparatus',
        resolveHostReachableIpv4: async () => '192.168.1.63',
        selectAgentLib: async () => assert.fail('bind keeps the mounted AgentLib generation'),
        commitAgentLibSelection: () => assert.fail('bind must not advance AgentLib state'),
        stdout: { write() {} },
        stderr: { write() {} },
        ...overrides,
    });
}

function inOrder(events, markers) {
    const indexes = markers.map((marker) => events.findIndex((event) => event.startsWith(marker)));
    assert.equal(indexes.every((index) => index >= 0), true, `${JSON.stringify(markers)} in ${JSON.stringify(events)}`);
    assert.deepEqual([...indexes].sort((left, right) => left - right), indexes, JSON.stringify(events));
}

test('bind refuses a missing graph, missing launch scope, or foreign address before mutation', async (t) => {
    for (const missing of ['graph', 'scope', 'address']) {
        const box = boxWorkspace(t, { graph: missing !== 'graph', scope: missing !== 'scope' });
        const events = [];
        const supervisor = bindSupervisor(box, events, {
            reconcile: async () => assert.fail('bind must fail before reconciliation'),
            startCore: async () => assert.fail('bind must fail before the graph starts'),
        });
        await assert.rejects(
            () => supervisor.runBindTransaction({
                address: missing === 'address' ? '192.168.1.50' : '0.0.0.0',
                hostPort: 8083,
            }),
            {
                graph: { code: 'PLOINKY_BOX_BIND_GRAPH_REQUIRED' },
                scope: /no saved launch scope/,
                address: { code: 'PLOINKY_BOX_BIND_ADDRESS_UNASSIGNED' },
            }[missing],
        );
        assert.equal(events.some((event) => /^(?:run|stream|store-write)/.test(event)), false, missing);
        assert.deepEqual(events.filter((event) => ['lock', 'release'].includes(event)), ['lock', 'release'], missing);
    }
});

test('bind replaces the publication, restarts the captured graph, proves health, then saves the binding', async (t) => {
    const box = boxWorkspace(t);
    const events = [];
    const candidate = containerHandle(box, { id: 'c'.repeat(64), routerBinding: wildcard() });
    const store = memoryStore(events);
    const supervisor = bindSupervisor(box, events, {
        routerBindingStore: store,
        async reconcile(options) {
            options.lock.assertHeld(box.identity.instance);
            assert.deepEqual(options.routerBinding, wildcard());
            assert.equal(options.imagePolicy, 'preserve');
            assert.equal(options.imageRef, BOX_IMAGE_REFERENCE);
            assert.equal(options.agentLib.fingerprint, box.agentLib.fingerprint);
            assert.equal(options.explicitPort, undefined);
            events.push('reconcile');
            return {
                action: 'replaced',
                ownership: { ...box.ownership, handles: { container: candidate } },
                hostPort: 8083,
                mediaHostPort: 7882,
                routerBinding: wildcard(),
                previousAgentLib: box.agentLib,
                finalize() { events.push('finalize'); },
                async rollback() { assert.fail('a successful bind never rolls back'); },
            };
        },
        async startCore(_engine, containerId, argv, hostPort, mediaHostPort, _runner, options) {
            assert.equal(containerId, candidate.id);
            assert.deepEqual(argv, ['start', 'explorer', '8080']);
            assert.equal(hostPort, 8083);
            assert.equal(mediaHostPort, 7882);
            assert.deepEqual(options.skillScopeEnv, box.scopeEnv);
            assert.deepEqual(options.routerBinding, wildcard());
            assert.equal(options.hostReachableIpv4, '192.168.1.63');
            events.push('start-core');
        },
        async healthCheck(hostPort, { routerBinding }) {
            assert.equal(hostPort, 8083);
            assert.deepEqual(routerBinding, wildcard());
            events.push('health');
        },
    });

    const result = await supervisor.runBindTransaction({ address: '0.0.0.0', hostPort: 8083, containerPort: 8080 });

    assert.equal(result.action, 'replaced');
    assert.deepEqual(result.previousRouterBinding, LOOPBACK);
    assert.deepEqual(store.value, { address: '0.0.0.0', hostPort: 8083, containerPort: 8080 });
    assert.equal(events.filter((event) => event === 'lock').length, 1);
    assert.equal(events.some((event) => event.includes(' pull ')), false);
    inOrder(events, [
        'lock',
        'query:/opt/ploinky/ploinky-box/inbox/readStatus.mjs',
        'reconcile',
        'stream:/opt/ploinky/bin/ploinky-install-deps',
        'start-core',
        'health',
        'store-write:0.0.0.0:8083',
        'finalize',
        'release',
    ]);
    const output = formatBindResult(result);
    assert.match(output, /Router binding: 0\.0\.0\.0:8083 -> public Router 8080\/tcp/);
    assert.match(output, /Open http:\/\/192\.168\.1\.63:8083\//);
    assert.match(output, /Media publication: 0\.0\.0\.0:7882 -> 7882\/udp \(unchanged\)/);
    assert.match(output, /plain HTTP/);
    assert.doesNotMatch(output, /http:\/\/0\.0\.0\.0/);
});

test('bare bind publishes all IPv4 interfaces at the current host port', async (t) => {
    const box = boxWorkspace(t, { hostPort: 19090 });
    let requested = null;
    const supervisor = bindSupervisor(box, [], {
        reconcile: async (options) => {
            requested = options.routerBinding;
            throw new Error('planning captured');
        },
    });
    await assert.rejects(() => supervisor.runBindTransaction(null), /planning captured/);
    assert.deepEqual(requested, wildcard(19090));
});

test('repeating an effective binding verifies health without restarting anything', async (t) => {
    const box = boxWorkspace(t, { routerBinding: wildcard() });
    const events = [];
    const supervisor = bindSupervisor(box, events, {
        routerBindingStore: memoryStore(events, Object.freeze({ address: '0.0.0.0', hostPort: 8083, containerPort: 8080 })),
        reconcile: async (options) => ({
            action: 'reused',
            ownership: box.ownership,
            hostPort: 8083,
            mediaHostPort: 7882,
            routerBinding: options.routerBinding,
            finalize() { events.push('finalize'); },
            async rollback() { return { action: 'reused-preserved' }; },
        }),
        startCore: async () => assert.fail('an effective binding does not restart the graph'),
        healthCheck: async (_port, { routerBinding }) => { events.push(`health:${routerBinding.address}`); },
    });
    const result = await supervisor.runBindTransaction({ address: '0.0.0.0', hostPort: 8083 });
    assert.equal(result.action, 'unchanged');
    assert.equal(result.graphStarted, false);
    assert.equal(events.includes('health:0.0.0.0'), true);
    assert.equal(events.some((event) => event.startsWith('run:') || event.startsWith('stream:')), false);
    assert.match(formatBindResult(result), /already effective; nothing was restarted/);
});

test('binding an outer-only running Box starts its configured but stopped graph', async (t) => {
    const box = boxWorkspace(t, { routerBinding: wildcard() });
    const events = [];
    let graphRunning = false;
    const supervisor = bindSupervisor(box, events, {
        runner: {
            async stream() { return { ok: true, status: 0 }; },
            query() {
                return { ok: true, stdout: JSON.stringify({
                    initialized: true, routingConfigured: true, trackedAgents: 1, runningAgents: 0,
                }) };
            },
        },
        reconcile: async () => ({
            action: 'reused', ownership: box.ownership,
            hostPort: 8083, mediaHostPort: 7882, routerBinding: wildcard(),
            finalize() {}, async rollback() { return { action: 'reused-preserved' }; },
        }),
        startCore: async () => { graphRunning = true; },
        healthCheck: async () => { assert.equal(graphRunning, true, 'the configured graph must be started'); },
    });
    const result = await supervisor.runBindTransaction({ address: '0.0.0.0', hostPort: 8083 });
    assert.equal(result.action, 'graph-started');
});

test('failed readiness while reusing a stopped Box restores its stopped state', async (t) => {
    const box = boxWorkspace(t, { running: false, routerBinding: wildcard() });
    const events = [];
    const h = harness(box, { initial: box.container });
    h.seams.startAndWaitReady = async (engine, id, runner) => {
        runner.run(engine.name, ['container', 'start', id]);
        throw new Error('reused Box ready timeout');
    };
    const store = memoryStore(events);
    const supervisor = bindSupervisor(box, events, {
        runner: h.runner,
        routerBindingStore: store,
        discover: () => ({ ...h.seams.discover(), engine: box.ownership.engine }),
        reconcile: (options) => reconcileBoxContainer(options, h.seams),
        startCore: async () => assert.fail('the outer Box never became ready'),
        healthCheck: async () => assert.fail('the outer Box never became ready'),
    });
    await assert.rejects(
        () => supervisor.runBindTransaction({ address: '0.0.0.0', hostPort: 8083 }),
        /reused Box ready timeout/,
    );
    assert.equal(h.current().id, OLD_ID);
    assert.equal(h.current().runtime.running, false);
    assert.equal(store.value, null);
});

test('a candidate that stops before finalization restores the prior graph and saved binding', async (t) => {
    const box = boxWorkspace(t);
    const events = [];
    const h = harness(box, { initial: box.container });
    const run = h.runner.run;
    h.runner.run = (command, args) => {
        if (args.at(-1) === 'stop' && h.current()?.runtime.running === false) {
            throw new Error('cannot exec into stopped candidate');
        }
        return run(command, args);
    };
    h.runner.query = () => ({ ok: true, stdout: JSON.stringify({
        initialized: true, routingConfigured: true, trackedAgents: 1, runningAgents: 1,
    }) });
    const previous = { address: '127.0.0.1', hostPort: 8083, containerPort: 8080 };
    const store = memoryStore(events, previous);
    const supervisor = bindSupervisor(box, events, {
        runner: h.runner,
        routerBindingStore: store,
        discover: () => ({ ...h.seams.discover(), engine: box.ownership.engine }),
        reconcile: (options) => reconcileBoxContainer(options, h.seams),
        startCore: async () => {},
        healthCheck: async (_port, { routerBinding }) => {
            if (routerBinding.address === '0.0.0.0') h.current().runtime.running = false;
            else events.push('prior-health');
        },
        runCoreCommand: async (_engine, id, argv) => {
            assert.equal(id, h.current().id);
            assert.deepEqual(argv, ['start', 'explorer', '8080']);
            events.push('prior-graph');
        },
    });
    await assert.rejects(
        () => supervisor.runBindTransaction({ address: '0.0.0.0', hostPort: 8083 }),
        /not running/,
    );
    assert.equal(h.current().runtime.running, true);
    assert.equal(h.current().runtime.publications[1].hostIp, '127.0.0.1');
    assert.deepEqual(store.value, previous);
    inOrder(events, ['prior-graph', 'prior-health', 'store-restore']);
});

test('a failed health proof restores the previous publication, graph, and saved binding', async (t) => {
    for (const failure of ['health', 'save']) {
        const box = boxWorkspace(t);
        const events = [];
        const previous = Object.freeze({ address: '127.0.0.1', hostPort: 8083, containerPort: 8080 });
        const store = memoryStore(events, previous);
        if (failure === 'save') {
            const write = store.write;
            store.write = (...args) => {
                write(...args);
                throw new Error('saved binding could not be committed');
            };
        }
        const candidate = containerHandle(box, { id: 'c'.repeat(64), routerBinding: wildcard() });
        const supervisor = bindSupervisor(box, events, {
            routerBindingStore: store,
            reconcile: async () => ({
                action: 'replaced',
                ownership: { ...box.ownership, handles: { container: candidate } },
                hostPort: 8083,
                mediaHostPort: 7882,
                routerBinding: wildcard(),
                previousAgentLib: box.agentLib,
                finalize() { assert.fail('a failed bind is never finalized'); },
                async rollback() {
                    events.push('outer-rollback');
                    return {
                        action: 'restored',
                        ownership: box.ownership,
                        containerId: OLD_ID,
                        hostPort: 8083,
                        mediaHostPort: 7882,
                        routerBinding: LOOPBACK,
                        agentLib: box.agentLib,
                    };
                },
            }),
            startCore: async () => { events.push('start-core'); },
            healthCheck: async (_port, { routerBinding }) => {
                events.push(`health:${routerBinding.address}`);
                if (failure === 'health' && routerBinding.address === '0.0.0.0') {
                    throw new Error('Public Box health check was unhealthy (HTTP 421) through 192.168.1.63:8083');
                }
            },
            runCoreCommand: async (_engine, containerId, argv, _hostPort, _mediaHostPort, _runner, options) => {
                assert.deepEqual(options.skillScopeEnv, box.scopeEnv);
                assert.equal(options.agentLib, box.agentLib);
                events.push(`restore-core:${containerId}:${argv.join(' ')}`);
            },
        });
        await assert.rejects(
            () => supervisor.runBindTransaction({ address: '0.0.0.0', hostPort: 8083 }),
            failure === 'health' ? /HTTP 421/ : /could not be committed/,
        );
        assert.deepEqual(store.value, previous, failure);
        inOrder(events, [
            'start-core',
            'health:0.0.0.0',
            `run:container exec --user podman --workdir ${box.identity.workspaceRoot} ${candidate.id} /opt/ploinky/bin/ploinky-local stop`,
            'outer-rollback',
            `restore-core:${OLD_ID}:start explorer 8080`,
            'health:127.0.0.1',
        ]);
        assert.equal(events.some((event) => event.startsWith('store-restore')), failure === 'save', failure);
    }
});

test('a failed removal after the graceful stop restarts that Box through reuse and restores its graph', async (t) => {
    const box = boxWorkspace(t);
    const events = [];
    const stopped = { ...box.container, runtime: { ...box.container.runtime, running: false } };
    let observed = box.ownership;
    let reconciles = 0;
    const supervisor = bindSupervisor(box, events, {
        discover: () => observed,
        async reconcile(options) {
            reconciles += 1;
            if (reconciles === 1) {
                observed = { ...box.ownership, handles: { container: stopped } };
                throw Object.assign(new Error('Box container transaction failed: remove failed'), {
                    boxRollback: {
                        action: 'preserved',
                        containerId: OLD_ID,
                        oldStopAttempted: true,
                        previouslyRunning: true,
                        hostPort: 8083,
                        mediaHostPort: 7882,
                        routerBinding: LOOPBACK,
                        agentLib: box.agentLib,
                    },
                });
            }
            assert.equal(options.ownership.handles.container, stopped);
            assert.deepEqual(options.routerBinding, LOOPBACK);
            assert.equal(options.imagePolicy, 'preserve');
            events.push('restart-previous-box');
            observed = box.ownership;
            return {
                action: 'reused',
                ownership: box.ownership,
                hostPort: 8083,
                mediaHostPort: 7882,
                routerBinding: LOOPBACK,
                finalize() { events.push('restart-finalized'); },
            };
        },
        startCore: async () => assert.fail('the candidate graph never started'),
        runCoreCommand: async (_engine, containerId, argv) => { events.push(`restore-core:${containerId}:${argv.join(' ')}`); },
        healthCheck: async (_port, { routerBinding }) => { events.push(`health:${routerBinding.address}`); },
    });
    await assert.rejects(() => supervisor.runBindTransaction({ address: '0.0.0.0', hostPort: 8083 }), /remove failed/);
    assert.equal(reconciles, 2);
    inOrder(events, [
        'restart-previous-box',
        'restart-finalized',
        `restore-core:${OLD_ID}:start explorer 8080`,
        'health:127.0.0.1',
        'release',
    ]);
});

test('a failed bind on a stopped Box returns the restored Box to its stopped state', async (t) => {
    const box = boxWorkspace(t, { running: false });
    const events = [];
    const restoredId = 'b'.repeat(64);
    const supervisor = bindSupervisor(box, events, {
        reconcile: async () => {
            throw Object.assign(new Error('Box container transaction failed: ready timeout'), {
                boxRollback: {
                    action: 'restored',
                    containerId: restoredId,
                    oldStopAttempted: false,
                    previouslyRunning: false,
                    hostPort: 8083,
                    mediaHostPort: 7882,
                    routerBinding: LOOPBACK,
                    agentLib: box.agentLib,
                },
            });
        },
        runCoreCommand: async () => assert.fail('a stopped graph is not restarted'),
        healthCheck: async () => assert.fail('a stopped graph is not probed'),
    });
    await assert.rejects(() => supervisor.runBindTransaction({ address: '0.0.0.0', hostPort: 8083 }), /ready timeout/);
    assert.equal(events.some((event) => event.startsWith('query:')), false);
    const stops = events.filter((event) => /ploinky-local stop$|container stop --time 30/.test(event));
    assert.deepEqual(stops, [
        `run:container exec --user podman --workdir ${box.identity.workspaceRoot} ${restoredId} /opt/ploinky/bin/ploinky-local stop`,
        `run:container stop --time 30 ${restoredId}`,
    ]);
});

test('start, restart, and update restore the graph when outer reconciliation fails', async (t) => {
    for (const command of ['start', 'restart', 'update']) {
        const box = boxWorkspace(t, { routerBinding: wildcard() });
        const events = [];
        const restoredId = 'b'.repeat(64);
        const supervisor = bindSupervisor(box, events, {
            routerBindingStore: memoryStore(events, { address: '0.0.0.0', hostPort: 8083, containerPort: 8080 }),
            selectAgentLib: async () => ({ selection: box.agentLib }),
            updateAgentLib: async () => ({ selection: box.agentLib, changed: false }),
            updateWorkspacePloinky: async () => null,
            reconcile: async () => {
                throw Object.assign(new Error('replacement readiness failed'), {
                    boxRollback: {
                        action: 'restored', containerId: restoredId, previouslyRunning: true,
                        hostPort: 8083, mediaHostPort: 7882,
                        routerBinding: wildcard(), agentLib: box.agentLib,
                    },
                });
            },
            startCore: async () => assert.fail('the candidate graph never started'),
            runCoreCommand: async (_engine, id, argv, _port, _media, _runner, options) => {
                assert.equal(id, restoredId);
                assert.deepEqual(argv, ['start', 'explorer', '8080']);
                assert.deepEqual(options.skillScopeEnv, box.scopeEnv);
                assert.equal(options.agentLib, box.agentLib);
                events.push('restore-graph');
            },
            healthCheck: async (_port, { routerBinding }) => {
                assert.deepEqual(routerBinding, wildcard());
                events.push('restore-health');
            },
        });
        const run = {
            start: () => supervisor.runStartTransaction(['start', 'explorer', '8080']),
            restart: () => supervisor.runRestartTransaction(['restart']),
            update: () => supervisor.runUpdateTransaction(['update']),
        }[command];
        await assert.rejects(run, /replacement readiness failed/);
        inOrder(events, ['restore-graph', 'restore-health', 'release']);
        assert.equal(events.some((event) => event.startsWith('store-write')), false);
    }
});

test('start reuses the saved binding and a later explicit port keeps its address', async (t) => {
    const box = boxWorkspace(t, { routerBinding: wildcard() });
    const events = [];
    const store = memoryStore(events, Object.freeze({ address: '0.0.0.0', hostPort: 8083, containerPort: 8080 }));
    const output = { value: '', write(chunk) { this.value += String(chunk); } };
    const supervisor = bindSupervisor(box, events, {
        routerBindingStore: store,
        stdout: output,
        selectAgentLib: async () => ({ selection: box.agentLib, mode: 'local' }),
        revalidateAgentLibSource: () => {},
        commitAgentLibSelection: () => { events.push('commit-agentlib'); },
        readEdgeDesired: () => null,
        async reconcile(options) {
            assert.equal(options.explicitPort, 9090);
            assert.deepEqual(options.routerBinding, wildcard(9090));
            events.push('reconcile');
            return {
                action: 'replaced',
                ownership: box.ownership,
                hostPort: 9090,
                mediaHostPort: 7882,
                routerBinding: wildcard(9090),
                previousAgentLib: box.agentLib,
                finalize() { events.push('finalize'); },
                async rollback() {},
            };
        },
        startCore: async (_engine, _containerId, _argv, hostPort, _mediaHostPort, _runner, options) => {
            assert.equal(hostPort, 9090);
            assert.deepEqual(options.routerBinding, wildcard(9090));
        },
        healthCheck: async (hostPort, { routerBinding }) => {
            assert.equal(hostPort, 9090);
            assert.equal(routerBinding.address, '0.0.0.0');
            events.push('health');
        },
    });
    await supervisor.runStartTransaction(['start', 'explorer', '8080'], { explicitPort: 9090 });
    assert.deepEqual(store.value, { address: '0.0.0.0', hostPort: 9090, containerPort: 8080 });
    inOrder(events, ['reconcile', 'health', 'store-write:0.0.0.0:9090', 'finalize', 'release']);
    assert.match(output.value, /\[ploinky\] Router binding: 0\.0\.0\.0:9090 -> public Router 8080\/tcp/);
    assert.match(output.value, /\[ploinky\] Open http:\/\/192\.168\.1\.63:9090\//);

    const restartEvents = [];
    const restart = bindSupervisor(box, restartEvents, {
        routerBindingStore: memoryStore(restartEvents, store.value),
        selectAgentLib: async () => ({ selection: box.agentLib, mode: 'local' }),
        async reconcile(options) {
            assert.deepEqual(options.routerBinding, wildcard(9090));
            throw new Error('restart captured the saved binding');
        },
    });
    await assert.rejects(() => restart.runRestartTransaction(['restart']), /restart captured the saved binding/);

    const unsafe = bindSupervisor(box, [], {
        routerBindingStore: {
            read() {
                throw Object.assign(new Error('Saved Router binding must be private to the current user (mode 0600)'), {
                    code: 'PLOINKY_BOX_ROUTER_BINDING_STATE_INVALID',
                });
            },
        },
        selectAgentLib: async () => assert.fail('an unsafe saved binding fails before source selection'),
        reconcile: async () => assert.fail('an unsafe saved binding fails before reconciliation'),
    });
    await assert.rejects(() => unsafe.runStartTransaction(['start'], {}), { code: 'PLOINKY_BOX_ROUTER_BINDING_STATE_INVALID' });
});

function fakeHttpGet(seen, respond = () => ({ statusCode: 200, body: '{"status":"healthy"}' })) {
    return (options, callback) => {
        seen.push(`${options.hostname}|${options.headers.Host}`);
        const { statusCode, body } = respond(options);
        const response = new EventEmitter();
        response.statusCode = statusCode;
        response.headers = {};
        response.setEncoding = () => {};
        setImmediate(() => {
            callback(response);
            response.emit('data', body);
            response.emit('end');
        });
        const request = new EventEmitter();
        request.setTimeout = () => {};
        request.destroy = () => {};
        return request;
    };
}

test('health connects through the bound address and presents its exact authority', async () => {
    const seen = [];
    await checkBoxHealth(8083, {
        routerBinding: { address: '192.168.1.63', hostPort: 8083, hosts: ['192.168.1.63'] },
        httpGet: fakeHttpGet(seen),
    });
    assert.deepEqual(seen, ['192.168.1.63|192.168.1.63:8083']);
    seen.length = 0;
    await checkBoxHealth(8083, { routerBinding: wildcard(), httpGet: fakeHttpGet(seen) });
    assert.deepEqual(seen, ['127.0.0.1|127.0.0.1:8083', '192.168.1.63|192.168.1.63:8083']);
    seen.length = 0;
    await checkBoxHealth(8083, { httpGet: fakeHttpGet(seen) });
    assert.deepEqual(seen, ['127.0.0.1|127.0.0.1:8083']);
    await assert.rejects(
        () => checkBoxHealth(8083, {
            routerBinding: wildcard(),
            httpGet: fakeHttpGet([], (options) => (options.hostname === '127.0.0.1'
                ? { statusCode: 200, body: '{"status":"healthy"}' }
                : { statusCode: 421, body: '{"error":"UNKNOWN_HOST"}' })),
        }),
        /unhealthy \(HTTP 421\) through 192\.168\.1\.63:8083/,
    );
});

test('bounded start expects the public authority of a specific binding', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-bind-start-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agentLib = agentLibFixture(root);
    const reporting = (line) => ({
        async stream() { return { ok: true, status: 0, stdout: `${line}\n`, stderr: '' }; },
    });
    const options = (routerBinding) => ({
        workspaceRoot: root, stdout: { write() {} }, stderr: { write() {} }, agentLib, routerBinding,
    });
    const specific = { address: '192.168.1.63', hostPort: 8083, hosts: ['192.168.1.63'] };
    await runBoundedCoreStart(
        { name: 'podman' }, 'a'.repeat(64), ['start', 'explorer', '8080'], 8083, 7882,
        reporting('[start] Router: http://192.168.1.63:8083'), options(specific),
    );
    await assert.rejects(() => runBoundedCoreStart(
        { name: 'podman' }, 'a'.repeat(64), ['start', 'explorer', '8080'], 8083, 7882,
        reporting('[start] Router: http://127.0.0.1:8083'), options(specific),
    ), /public Router URL http:\/\/192\.168\.1\.63:8083/);
    await runBoundedCoreStart(
        { name: 'podman' }, 'a'.repeat(64), ['start', 'explorer', '8080'], 8083, 7882,
        reporting('[start] Router: http://127.0.0.1:8083'), options(wildcard()),
    );
});

test('status and dry-run report the binding without locks, writes, or wildcard browser URLs', (t) => {
    const status = formatBoxStatus({ state: 'stopped', identity: { instance: 'ploinky-box-workspace-123456789abc' }, routerBinding: wildcard() });
    assert.match(status, /Router binding: 0\.0\.0\.0:8083 -> public Router 8080\/tcp/);
    assert.match(status, /Open http:\/\/192\.168\.1\.63:8083\//);
    assert.doesNotMatch(status, /http:\/\/0\.0\.0\.0/);

    const box = boxWorkspace(t);
    const events = [];
    const supervisor = bindSupervisor(box, events, {
        reconcile: async () => assert.fail('dry-run never reconciles'),
    });
    const plan = supervisor.planBindDryRun({ address: '0.0.0.0', hostPort: 8083, containerPort: 8080 });
    assert.deepEqual(events, ['store-read']);
    assert.equal(plan.mutationPerformed, false);
    assert.equal(plan.graph, 'explorer');
    assert.equal(plan.currentMapping, '127.0.0.1:8083:8080');
    assert.equal(plan.requestedMapping, '0.0.0.0:8083:8080');
    assert.equal(plan.boxAction, 'replace');
    assert.deepEqual(plan.publications, ['0.0.0.0:8083:8080/tcp', '0.0.0.0:7882:7882/udp']);
    assert.deepEqual(plan.trustedHosts, [...LAN_HOSTS]);
    assert.deepEqual(plan.browserUrls, ['http://192.168.1.63:8083/', 'http://127.0.0.1:8083/']);
    assert.match(plan.image, new RegExp(`preserve ${OLD_IMAGE}`));
    assert.throws(
        () => supervisor.planBindDryRun({ address: '192.168.1.50', hostPort: 8083 }),
        { code: 'PLOINKY_BOX_BIND_ADDRESS_UNASSIGNED' },
    );
    assert.equal(events.some((event) => ['lock', 'release'].includes(event) || /^(?:run|stream|query)/.test(event)), false);
});

function bufferStream() {
    let value = '';
    return { isTTY: false, write(chunk) { value += String(chunk); }, value: () => value };
}

test('the public CLI dispatches bind and its dry run only to the host supervisor', async () => {
    const events = [];
    const supervisor = {
        async runBindTransaction(mapping) {
            events.push(['bind', mapping]);
            return { action: 'replaced', routerBinding: wildcard(), hostPort: 8083, mediaHostPort: 7882 };
        },
        planBindDryRun(mapping) {
            events.push(['bind-dry-run', mapping]);
            return { command: 'bind', mutationPerformed: false };
        },
        async prepareBoxForCommand() { assert.fail('bind is never forwarded to the in-Box core'); },
        inspectBoxStatus() {
            return {
                state: 'running-initialized',
                identity: { instance: 'ploinky-box-workspace-123456789abc', workspaceRoot: '/home/user/workspace' },
                routerBinding: wildcard(),
                ownership: {
                    state: 'owned',
                    engine: { name: 'podman' },
                    handles: {
                        container: {
                            id: 'a'.repeat(64),
                            labels: { [BOX_LABELS.routerHostPort]: '8083', [BOX_LABELS.mediaHostPort]: '7882' },
                        },
                    },
                },
            };
        },
    };
    const run = (argv, output = bufferStream()) => runOuterCli(argv, {
        env: {},
        input: { isTTY: false },
        output,
        errorOutput: bufferStream(),
        supervisor,
        execute: () => { events.push(['execute']); return 0; },
    });

    const bindOutput = bufferStream();
    assert.equal(await run(['bind', '0:8083:8080'], bindOutput), 0);
    assert.deepEqual(events, [['bind', { address: '0.0.0.0', hostPort: 8083, containerPort: 8080 }]]);
    assert.match(bindOutput.value(), /Open http:\/\/192\.168\.1\.63:8083\//);

    events.length = 0;
    const planOutput = bufferStream();
    assert.equal(await run(['--dry-run', 'bind'], planOutput), 0);
    assert.deepEqual(events, [['bind-dry-run', null]]);
    assert.equal(JSON.parse(planOutput.value()).mutationPerformed, false);

    events.length = 0;
    await assert.rejects(() => run(['bind', '0:8083:8081']), /private Router listener/);
    assert.deepEqual(events, []);

    const statusOutput = bufferStream();
    assert.equal(await run(['status'], statusOutput), 0);
    assert.match(statusOutput.value(), /^Router binding: 0\.0\.0\.0:8083 -> public Router 8080\/tcp\n/);
    assert.deepEqual(events, [['execute']]);

    const help = bufferStream();
    assert.equal(await run(['help'], help), 0);
    assert.match(help.value(), /ploinky bind \[ADDRESS:PORT:8080\]/);
    assert.match(help.value(), /127\.0\.0\.1 \(restore local-only access\)/);
    assert.match(help.value(), /8081 and agent ports cannot be published/);
    assert.match(help.value(), /plain HTTP/);
});
