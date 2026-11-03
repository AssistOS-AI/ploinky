import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageSourceIdentity } from '../../agentlib/contract.mjs';
import { normalizeBoxAgentLib } from '../../ploinky-box/contract/agentlib.mjs';
import {
    BOX_IMAGE_REFERENCE,
    BOX_LABELS,
    BOX_READY_LINE,
    BOX_ROUTER_HEALTH_SOCKET,
    BOX_TMPFS,
    BOX_USERNS,
} from '../../ploinky-box/constants.mjs';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { nestedPodmanSeccompProfileContract, nestedPodmanSeccompProfilePath } from '../../ploinky-box/seccomp.mjs';
import {
    agentLibFixture,
    agentLibFixtureEnv,
    boxImageIdFixtureEnv,
    agentLibFixtureLabels,
    agentLibFixtureMounts,
} from './agentlibFixture.mjs';
import { hostStateFixtureMounts, quiescentEngine } from './hostStateFixture.mjs';

// A fake Box engine for reconcileBoxContainer tests: fixture workspace, Box container handles, a recording
// runner and the transaction seams. Shared by the Box image refresh tests.
export const DATA_FINGERPRINTS = Object.freeze({
    dependencies: 'd'.repeat(64),
    images: 'f'.repeat(64),
});
const TMPFS_CREATE_ARGUMENT = `${BOX_TMPFS.destination}:${BOX_TMPFS.options.join(',')}`;
const TMPFS_INSPECTED_OPTIONS = Object.freeze([
    ...BOX_TMPFS.options.filter((option) => option !== 'notmpcopyup'),
    'rprivate',
].sort());

export function fixture(t) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-transaction-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    // The checkout (`root`) and the workspace are siblings: a workspace inside
    // the invoking checkout is refused (D6).
    const root = path.join(base, 'checkout');
    const workspace = path.join(base, 'workspace');
    const lockPath = path.join(root, 'lock');
    fs.mkdirSync(root);
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(workspace, '.ploinky'));
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
    // Every Box now carries the direct-mounted achillesAgentLib source as part
    // of its immutable contract, so the fixture selects one for the workspace.
    const agentLib = agentLibFixture(identity.workspaceRoot);
    return { root, base, identity, lock, agentLib };
}

export function containerHandle({
    identity,
    repositoryRoot,
    imageId,
    imageRef,
    hostPort,
    mediaHostPort = 7882,
    // The in-Box media listener: N:N for a current Box, 7882 for a legacy one.
    mediaContainerPort = mediaHostPort,
    // 'auto' derives the variable a current Box carries; the fake engine passes
    // what the create arguments actually requested (a string, or null).
    boxMediaPortEnv = 'auto',
    id,
    running = true,
    dataFingerprints = DATA_FINGERPRINTS,
    agentLib,
    // PLOINKY_REPOS_SOURCE as the Box environment records it (null: unset).
    reposSourceEnv = null,
}) {
    const mediaEnv = boxMediaPortEnv === 'auto'
        ? (Number(mediaContainerPort) === 7882 ? null : String(mediaContainerPort))
        : boxMediaPortEnv;
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
            [BOX_LABELS.seccompFingerprint]: nestedPodmanSeccompProfileContract(repositoryRoot).fingerprint,
            [BOX_LABELS.dependenciesFingerprint]: dataFingerprints.dependencies,
            [BOX_LABELS.imagesFingerprint]: dataFingerprints.images,
        },
        runtime: {
            complete: true,
            imageId,
            configuredImage: imageId,
            user: 'podman',
            workingDir: identity.workspaceRoot,
            createCommand: [
                'podman', 'container', 'create',
                '--init',
                '--userns', BOX_USERNS,
                '--device', '/dev/fuse', '--device', '/dev/net/tun',
                '--tmpfs', TMPFS_CREATE_ARGUMENT,
            ],
            environment: {
                ...IMAGE_CONTRACT.environment,
                PLOINKY_WORKSPACE_ROOT: identity.workspaceRoot,
                ...agentLibFixtureEnv(agentLib),
                ...boxImageIdFixtureEnv(imageId),
                PLOINKY_PRIVATE_BIND: '0.0.0.0',
                PLOINKY_PUBLIC_BIND: '0.0.0.0',
                PLOINKY_PUBLIC_AUTHORITY: `127.0.0.1:${hostPort}`,
                PLOINKY_ROUTER_HEALTH_SOCKET: BOX_ROUTER_HEALTH_SOCKET,
                ...(mediaEnv === null ? {} : { PLOINKY_BOX_MEDIA_PORT: mediaEnv }),
                ...(reposSourceEnv === null ? {} : { PLOINKY_REPOS_SOURCE: reposSourceEnv }),
                HOSTNAME: id.slice(0, 12),
            },
            publications: [
                { containerPort: String(mediaContainerPort), protocol: 'udp', hostIp: '0.0.0.0',
                    hostPort: String(mediaHostPort) },
                { containerPort: '8080', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: String(hostPort) },
            ],
            running,
            status: running ? 'running' : 'exited',
            init: true,
            usernsMode: 'private',
            privileged: false,
            securityOptions: [
                'label=disable',
                'unmask=ALL',
                `seccomp=${nestedPodmanSeccompProfilePath(repositoryRoot)}`,
            ],
            devices: [
                { hostPath: '/dev/fuse', containerPath: '/dev/fuse', permissions: 'rwm' },
                { hostPath: '/dev/net/tun', containerPath: '/dev/net/tun', permissions: 'rwm' },
            ],
            tmpfs: [{ destination: BOX_TMPFS.destination, options: [...TMPFS_INSPECTED_OPTIONS] }],
            mounts: [
                { type: 'bind', name: '', source: identity.dataPaths.images,
                    destination: '/home/podman/.local/share/ploinky-images', rw: true },
                { type: 'bind', name: '', source: repositoryRoot, destination: '/opt/ploinky', rw: false },
                { type: 'bind', name: '', source: identity.dataPaths.dependencies,
                    destination: '/opt/ploinky/node_modules', rw: true },
                { type: 'bind', name: '', source: identity.workspaceRoot, destination: identity.workspaceRoot,
                    rw: true },
                ...hostStateFixtureMounts(identity.workspaceRoot, repositoryRoot),
                ...agentLibFixtureMounts(agentLib, identity.workspaceRoot),
            ],
        },
    };
}

export function harness(state, {
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
                fs.writeFileSync(cidfile, corruptCidfile && createCount === 1 ? 'corrupt\n' : `${cid}\n`,
                    { mode: 0o600 });
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
                    mediaContainerPort: Number(args[args.indexOf('--publish', args.indexOf('--publish') + 1) + 1]
                        .split(':')[2].split('/')[0]),
                    boxMediaPortEnv: (args.find((value) => value.startsWith('PLOINKY_BOX_MEDIA_PORT='))
                        ?? '').slice('PLOINKY_BOX_MEDIA_PORT='.length) || null,
                    reposSourceEnv: (args.find((value) => value.startsWith('PLOINKY_REPOS_SOURCE='))
                        ?? '').slice('PLOINKY_REPOS_SOURCE='.length) || null,
                    id: cid,
                    running: false,
                    dataFingerprints: {
                        dependencies: dependenciesLabel.slice(dependenciesLabel.indexOf('=') + 1),
                        images: imagesLabel.slice(imagesLabel.indexOf('=') + 1),
                    },
                });
                if (args.includes('--network')) {
                    current.runtime.createCommand.push('--network', args[args.indexOf('--network') + 1]);
                    current.runtime.networkMode = 'pasta';
                }
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
        stopPloinkyLocal(engine, id, _runner, options) {
            calls.push(['seam', 'stop-ploinky-local', engine.name, id, options?.workspaceRoot]);
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
            return current ? { state: 'owned', handles: { container: current } } : { state: 'absent', handles: null };
        },
        token(kind) { return kind === 'candidate' ? '1'.repeat(24) : '2'.repeat(24); },
        quiescence({ excludeContainerIds = [] } = {}) {
            calls.push(['seam', excludeContainerIds.length ? 'pre-stop-scan' : 'quiescence']);
            return quiescentEngine();
        },
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


export function imageAgentLibFixture(supplyingImageId = `sha256:${'f'.repeat(64)}`) {
    return normalizeBoxAgentLib({
        sourceDir: '/opt/ploinky-agentlib', sourceRelativePath: 'image', mode: 'image', supplyingImageId,
        sourceId: imageSourceIdentity(supplyingImageId),
    });
}

export function reconciliationArguments(state, h, initial, replacement = false) {
    return {
        identity: state.identity, agentLib: state.agentLib,
        ownership: initial ? { state: 'owned', handles: { container: initial } } : { state: 'absent', handles: null },
        engine: { name: 'podman', identity: 'engine' }, runner: h.runner, lock: state.lock,
        repositoryRoot: state.root, ...(replacement ? { explicitPort: 19090 } : {}),
        stderr: { write() {} },
    };
}

export function lifecycleContainer(state, running = true) {
    return containerHandle({
        identity: state.identity, agentLib: state.agentLib, repositoryRoot: state.root,
        imageId: 'd'.repeat(64), imageRef: BOX_IMAGE_REFERENCE, hostPort: 8080,
        id: 'e'.repeat(64), running,
    });
}

