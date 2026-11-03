import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
import {
    BOX_SOURCE_MISMATCH,
    normalizeContainerRuntime,
    validateContainerConfiguration,
} from '../../ploinky-box/contract/container.mjs';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    nestedPodmanSeccompProfileContract,
    nestedPodmanSeccompProfilePath,
} from '../../ploinky-box/seccomp.mjs';
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
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { assertExistingImageDependencies, DEPENDENCY_MARKER_NAME } from '../../ploinky-box/entrypoint/install-dependencies.mjs';
import { hardwareStorePaths, initializeStore, readStoreSnapshot, setAgentLimits, assertGateOffStoreEmpty } from '../../cli/sandbox/hardwareLimits/store.mjs';
import {
    agentLibFixture,
    agentLibFixtureEnv,
    boxImageIdFixtureEnv,
    agentLibFixtureLabels,
    agentLibFixtureMounts,
} from '../helpers/agentlibFixture.mjs';
import { hostStateFixtureMounts, PERMISSIVE_HOST_STATE_GUARD, quiescentEngine } from '../helpers/hostStateFixture.mjs';

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

function storedLogs(text) {
    return text.replace(/^(.+)$/gm, '2026-09-15T09:00:00.000000000Z $1');
}

function fixture(t) {
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
                { containerPort: String(mediaContainerPort), protocol: 'udp', hostIp: '0.0.0.0', hostPort: String(mediaHostPort) },
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
                { type: 'bind', name: '', source: identity.dataPaths.images, destination: '/home/podman/.local/share/ploinky-images', rw: true },
                { type: 'bind', name: '', source: repositoryRoot, destination: '/opt/ploinky', rw: false },
                { type: 'bind', name: '', source: identity.dataPaths.dependencies, destination: '/opt/ploinky/node_modules', rw: true },
                { type: 'bind', name: '', source: identity.workspaceRoot, destination: identity.workspaceRoot, rw: true },
                ...hostStateFixtureMounts(identity.workspaceRoot, repositoryRoot),
                ...agentLibFixtureMounts(agentLib, identity.workspaceRoot),
            ],
        },
    };
}

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


function imageAgentLibFixture(supplyingImageId = `sha256:${'f'.repeat(64)}`) {
    return normalizeBoxAgentLib({
        sourceDir: '/opt/ploinky-agentlib', sourceRelativePath: 'image', mode: 'image', supplyingImageId,
        sourceId: imageSourceIdentity(supplyingImageId),
    });
}

function reconciliationArguments(state, h, initial, replacement = false) {
    return {
        identity: state.identity, agentLib: state.agentLib,
        ownership: initial ? { state: 'owned', handles: { container: initial } } : { state: 'absent', handles: null },
        engine: { name: 'podman', identity: 'engine' }, runner: h.runner, lock: state.lock,
        repositoryRoot: state.root, ...(replacement ? { explicitPort: 19090 } : {}),
        stderr: { write() {} },
    };
}

function lifecycleContainer(state, running = true) {
    return containerHandle({
        identity: state.identity, agentLib: state.agentLib, repositoryRoot: state.root,
        imageId: 'd'.repeat(64), imageRef: BOX_IMAGE_REFERENCE, hostPort: 8080,
        id: 'e'.repeat(64), running,
    });
}


import { imageRefreshPolicyFromSecrets, imageRefreshPolicyOf } from '../../cli/sandbox/docker/imageRefreshPolicy.mjs';
import { readImageRefreshPolicyFile } from '../../ploinky-box/inbox/readImageRefreshPolicy.mjs';
import { boxImageUpdateRecord, refreshBoxImageForUpdate } from '../../ploinky-box/update/boxImageRefresh.mjs';
import { createUpdateBoxScenario } from '../helpers/updateBoxScenario.mjs';
import { verifiedRecord } from '../helpers/fakeUpdateCore.mjs';

const IMAGE_REF = 'docker.io/x/box:latest';
const OLD_ID = `sha256:${'d'.repeat(64)}`;
const NEW_ID = `sha256:${'c'.repeat(64)}`;
const REMOTE = `sha256:${'b'.repeat(64)}`;
const LOCAL_DIGEST = `sha256:${'a'.repeat(64)}`;
const ENGINE = { name: 'podman', identity: 'engine' };

// ---- 1. Pure pieces and the step ----

test('policy rule: off disables, on and empty are the default, anything else is ignored and reported', () => {
    assert.deepEqual(imageRefreshPolicyOf(''), { policy: 'refresh', ignoredValue: '' });
    assert.deepEqual(imageRefreshPolicyOf('on'), { policy: 'refresh', ignoredValue: '' });
    assert.deepEqual(imageRefreshPolicyOf('off'), { policy: 'off', ignoredValue: '' });
    assert.deepEqual(imageRefreshPolicyOf(' off '), { policy: 'off', ignoredValue: '' });
    assert.deepEqual(imageRefreshPolicyOf('bogus'), { policy: 'refresh', ignoredValue: 'bogus' });
});

test('policy from secrets follows aliases; a cycle resolves to refresh', () => {
    assert.equal(imageRefreshPolicyFromSecrets({ PLOINKY_IMAGE_REFRESH: '$X', X: 'off' }).policy, 'off');
    assert.equal(imageRefreshPolicyFromSecrets({ PLOINKY_IMAGE_REFRESH: '$A', A: '$B', B: '$A' }).policy, 'refresh');
    assert.equal(imageRefreshPolicyFromSecrets({}).policy, 'refresh');
});

test('readImageRefreshPolicyFile: missing and empty files refresh and are never written; failures are unknown', () => {
    const writes = [];
    const fsApi = (read) => ({ readFileSync: read, writeFileSync: (...args) => writes.push(args) });
    const enoent = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    assert.deepEqual(readImageRefreshPolicyFile('/s', { fsApi: fsApi(enoent), decrypt: () => ({}) }),
        { policy: 'refresh' });
    assert.deepEqual(readImageRefreshPolicyFile('/s', { fsApi: fsApi(() => '  \n'),
        decrypt: () => assert.fail('empty') }),
        { policy: 'refresh' });
    assert.deepEqual(readImageRefreshPolicyFile('/s', { fsApi: fsApi(() => 'cipher'),
        decrypt: () => ({ PLOINKY_IMAGE_REFRESH: 'off' }) }),
        { policy: 'off' });
    assert.deepEqual(readImageRefreshPolicyFile('/s', { fsApi: fsApi(() => 'cipher'),
        decrypt: () => { throw new Error('bad key'); } }),
        { policy: 'unknown' });
    const eacces = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    assert.deepEqual(readImageRefreshPolicyFile('/s', { fsApi: fsApi(eacces), decrypt: () => ({}) }),
        { policy: 'unknown' });
    assert.deepEqual(writes, [], 'the program never writes');
});

function stepContainer(overrides = {}) {
    return {
        id: 'e'.repeat(64),
        labels: { [BOX_LABELS.imageRef]: IMAGE_REF },
        runtime: { running: true, imageId: OLD_ID },
        ...overrides,
    };
}

function stepHarness({ policy = '{"policy":"refresh"}', repoDigests = [`docker.io/x/box@${LOCAL_DIGEST}`],
    remote = { status: 'ok', digest: REMOTE },
    afterId = NEW_ID, pullThrows = null, validateThrows = null, probeThrows = null, policyOk = true } = {}) {
    const calls = { query: [], pulls: [], fetches: 0, validate: [], probe: [], logs: [] };
    const runner = {
        query(command, args, options) {
            calls.query.push({ command, args, options });
            if (args[0] === 'container') return policyOk ? { ok: true, stdout: `${policy}\n` } : { ok: false,
                stdout: '' };
            if (args.includes('{{json .RepoDigests}}')) return { ok: true, stdout: JSON.stringify(repoDigests) };
            return { ok: true, stdout: `${afterId}\n` };
        },
    };
    const deps = {
        runner,
        fetchDigest: async () => { calls.fetches += 1; return remote; },
        pullImage: async (engine, ref) => { calls.pulls.push([engine, ref]); if (pullThrows) throw pullThrows; },
        validateExisting: (...args) => { calls.validate.push(args); if (validateThrows) throw validateThrows; },
        probeAgentLib: (...args) => { calls.probe.push(args); if (probeThrows) throw probeThrows; },
    };
    const stderr = { write: (line) => calls.logs.push(line) };
    const run = (overrides = {}, env = {}) => refreshBoxImageForUpdate({
        engine: ENGINE, container: stepContainer(), imageRef: IMAGE_REF, workspaceRoot: '/work/space',
        activity: { undetermined: false }, env, stdout: { write() {} }, stderr, ...overrides,
    }, deps);
    return { run, calls };
}

test('step: no container, pinned, unqualified, localhost and a different label skip with no runner call', async () => {
    for (const [overrides] of [
        [{ container: null }],
        [{ imageRef: `docker.io/x/box@sha256:${'e'.repeat(64)}` }],
        [{ imageRef: 'ploinky-box:latest' }],
        [{ imageRef: 'localhost:5000/x' }],
        [{ imageRef: 'localhost/x:1' }],
        [{ container: stepContainer({ labels: { [BOX_LABELS.imageRef]: 'docker.io/x/box:other' } }) }],
    ]) {
        const { run, calls } = stepHarness();
        const result = await run(overrides);
        assert.equal(result.outcome, 'skip', JSON.stringify(overrides));
        assert.equal(calls.query.length + calls.fetches + calls.pulls.length, 0);
    }
});

test('step: a stopped Box or undetermined graph activity defers without any I/O', async () => {
    for (const overrides of [
        { container: stepContainer({ runtime: { running: false, imageId: OLD_ID } }) },
        { activity: { undetermined: true } },
    ]) {
        const { run, calls } = stepHarness();
        assert.equal((await run(overrides)).outcome, 'deferred');
        assert.equal(calls.query.length + calls.fetches, 0);
    }
});

test('step: policy off logs one line and records nothing; an unreadable policy is policy-unavailable', async () => {
    const off = stepHarness({ policy: '{"policy":"off"}' });
    const result = await off.run();
    assert.equal(result.outcome, 'off');
    assert.equal(boxImageUpdateRecord(result, null), null);
    assert.equal(off.calls.logs.filter((line) => /turned off for this workspace/.test(line)).length, 1);
    assert.equal(off.calls.fetches + off.calls.pulls.length, 0);
    const exec = off.calls.query[0];
    assert.deepEqual(exec.args.slice(0, 5), ['container', 'exec', '--user', 'podman', '--workdir']);
    assert.equal(exec.args.at(-1), '/opt/ploinky/ploinky-box/inbox/readImageRefreshPolicy.mjs');
    assert.equal(exec.options.timeoutMs, 15_000);
    for (const bad of [{ policy: 'unknown' }, { policy: '{"policy":"refresh","x":1}' }, { policy: 'garbage' },
        { policyOk: false }, { policy: '{"policy":"maybe"}' }]) {
        const { run, calls } = stepHarness(bad);
        const outcome = await run();
        assert.equal(outcome.outcome, 'policy-unavailable', JSON.stringify(bad));
        assert.equal(boxImageUpdateRecord(outcome, null).code, 'box-image-policy-unavailable');
        assert.equal(calls.fetches + calls.pulls.length, 0);
    }
});

test('step: a digest already local is current and the RepoDigests are read by image ID, not by tag', async () => {
    const { run, calls } = stepHarness({ remote: { status: 'ok', digest: LOCAL_DIGEST } });
    assert.equal((await run()).outcome, 'current');
    const inspect = calls.query.find((entry) => entry.args.includes('{{json .RepoDigests}}'));
    assert.equal(inspect.args.at(-1), OLD_ID);
    assert.equal(calls.pulls.length, 0);
});

test('step: an unreachable registry keeps the Box; an undetermined answer or a proxy defers to the tag path',
    async () => {
    for (const reason of ['ENOTFOUND', 'registry answered HTTP 429']) {
        const { run, calls } = stepHarness({ remote: { status: 'unavailable', reason } });
        const result = await run();
        assert.equal(result.outcome, 'unreachable');
        assert.equal(boxImageUpdateRecord(result, null).code, 'registry-unreachable');
        assert.equal(calls.pulls.length, 0);
    }
    for (const reason of ['registry answered HTTP 403', 'TLS error (CERT_HAS_EXPIRED)']) {
        const { run, calls } = stepHarness({ remote: { status: 'undetermined', reason } });
        const result = await run();
        assert.deepEqual([result.outcome, result.refreshImageTag, result.replaceImage], ['tag-refresh', true, false]);
        assert.equal(calls.pulls.length, 0, 'the transaction pulls, not the step');
    }
    const proxied = stepHarness();
    const viaProxy = await proxied.run({}, { HTTPS_PROXY: 'http://proxy:3128' });
    assert.equal(viaProxy.outcome, 'tag-refresh');
    assert.equal(proxied.calls.fetches, 0);
});

test('step: a different digest is pulled once by digest with the engine object; success asks for a replacement',
    async () => {
    const { run, calls } = stepHarness();
    const result = await run();
    assert.equal(calls.pulls.length, 1);
    assert.equal(calls.pulls[0][0], ENGINE, 'the engine object, not its name');
    assert.equal(calls.pulls[0][1], `docker.io/x/box@${REMOTE}`);
    assert.deepEqual([result.outcome, result.replaceImage, result.refreshImageTag, result.digestRef],
        ['replace', true, false, `docker.io/x/box@${REMOTE}`]);
    assert.deepEqual([calls.validate[0][1], calls.probe[0][1]], [NEW_ID, NEW_ID], 'validated by the pulled image ID');
    assert.equal(calls.logs.join('').includes('token'), false);
});

test('step: an equal image ID after the pull is current; a failed pull or validation moves nothing', async () => {
    assert.equal((await stepHarness({ afterId: OLD_ID }).run()).outcome, 'current');
    const failedPull = await stepHarness({ pullThrows: new Error('pull failed') }).run();
    assert.deepEqual([failedPull.outcome, failedPull.replaceImage], ['pull-failed', false]);
    for (const option of [{ validateThrows: new Error('contract') }, { probeThrows: new Error('no agentlib') }]) {
        const result = await stepHarness(option).run();
        assert.deepEqual([result.outcome, result.replaceImage], ['invalid', false]);
    }
});

test('step: it never rejects, whatever throws', async () => {
    const throwing = {
        runner: { query() { throw new Error('engine gone'); } },
        fetchDigest: async () => { throw new Error('fetch'); },
    };
    const result = await refreshBoxImageForUpdate({
        engine: ENGINE, container: stepContainer(), imageRef: IMAGE_REF, workspaceRoot: '/work/space',
        activity: {}, env: {}, stdout: { write() {} }, stderr: { write() {} },
    }, throwing);
    assert.equal(result.outcome, 'error');
    assert.equal(boxImageUpdateRecord(result, null).code, 'box-image-check-error');
    const noQuery = stepHarness({ policy: '{"policy":"refresh"}' });
    const broken = await refreshBoxImageForUpdate({
        engine: ENGINE, container: stepContainer(), imageRef: IMAGE_REF, workspaceRoot: '/work/space',
        activity: {}, env: {}, stdout: { write() {} }, stderr: { write() {} },
    }, { runner: { query: (_c, args) => (args[0] === 'container' ? { ok: true,
        stdout: '{"policy":"refresh"}' } : { ok: false }) } });
    assert.equal(broken.outcome, 'error');
    assert.ok(noQuery);
});

test('records: every row of the outcome table', () => {
    const base = { canonical: IMAGE_REF, beforeId: OLD_ID };
    const record = (boxImage, prepared = null) => boxImageUpdateRecord({ ...base, ...boxImage }, prepared);
    const row = (value) => [value.outcome, value.code, value.required, value.phase, value.id];
    assert.deepEqual(row(record({ outcome: 'replace', afterId: NEW_ID }, { action: 'replaced', imageId: NEW_ID })),
        ['changed', 'box-image-refreshed', false, 'image', `box:${IMAGE_REF}`]);
    assert.deepEqual(record({ outcome: 'replace', afterId: NEW_ID }, { action: 'replaced', imageId: NEW_ID }).after,
        { imageId: NEW_ID });
    assert.equal(record({ outcome: 'tag-refresh' }, { action: 'replaced', imageId: NEW_ID,
        imageRefresh: { outcome: 'replace', afterId: NEW_ID } }).code,
        'box-image-refreshed');
    assert.equal(record({ outcome: 'tag-refresh' }, { action: 'reused', imageRefresh: { outcome: 'current' } }).code,
        'box-image-current');
    assert.equal(record({ outcome: 'tag-refresh' }, { action: 'reused',
        imageRefresh: { outcome: 'pending-agentlib' } }).code,
        'box-image-refresh-pending');
    assert.equal(record({ outcome: 'tag-refresh' }, { action: 'reused', imageRefresh: { outcome: 'pull-failed',
        reason: 'x' } }).code,
        'box-image-pull-failed');
    assert.equal(record({ outcome: 'tag-refresh' }, { action: 'reused', imageRefresh: { outcome: 'invalid' } }).code,
        'box-image-invalid');
    for (const [outcome, expected, code] of [
        ['current', 'unchanged', 'box-image-current'],
        ['unreachable', 'skipped', 'registry-unreachable'],
        ['pull-failed', 'skipped', 'box-image-pull-failed'],
        ['invalid', 'skipped', 'box-image-invalid'],
        ['deferred', 'skipped', 'box-image-check-deferred'],
        ['policy-unavailable', 'skipped', 'box-image-policy-unavailable'],
        ['error', 'skipped', 'box-image-check-error'],
    ]) {
        const made = record({ outcome });
        assert.deepEqual([made.outcome, made.code, made.required], [expected, code, false], outcome);
    }
    assert.equal(record({ outcome: 'skip' }), null);
    assert.equal(record({ outcome: 'off' }), null);
});

// ---- 2. Transaction ----

const pulls = (h) => h.calls.filter((call) => call[0] === 'stream' && call[2] === 'pull');

function reusableBox(state, running = true) {
    return lifecycleContainer(state, running);
}

test('transaction: replaceImage replaces a reusable Box with one tag pull', async (t) => {
    const state = fixture(t);
    const initial = reusableBox(state);
    const h = harness(state, { initial });
    const result = await reconcileBoxContainer({ ...reconciliationArguments(state, h, initial), replaceImage: true },
        h.seams);
    assert.equal(result.action, 'replaced');
    assert.equal(pulls(h).length, 1);
    assert.deepEqual(pulls(h)[0].slice(2), ['pull', BOX_IMAGE_REFERENCE]);
});

test('transaction: refreshImageTag with the same image ID reuses the Box after one pull', async (t) => {
    const state = fixture(t);
    const initial = reusableBox(state);
    const h = harness(state, { initial, candidateImage: 'd'.repeat(64) });
    const result = await reconcileBoxContainer({ ...reconciliationArguments(state, h, initial),
        refreshImageTag: true }, h.seams);
    assert.equal(result.action, 'reused');
    assert.equal(result.imageRefresh.outcome, 'current');
    assert.equal(pulls(h).length, 1);
});

test('transaction: refreshImageTag with a new ID in local mode replaces without a second pull', async (t) => {
    const state = fixture(t);
    const initial = reusableBox(state);
    const h = harness(state, { initial, candidateImage: 'c'.repeat(64) });
    const result = await reconcileBoxContainer({ ...reconciliationArguments(state, h, initial),
        refreshImageTag: true }, h.seams);
    assert.equal(result.action, 'replaced');
    assert.equal(pulls(h).length, 1, 'the refresh pull is the only one');
    assert.equal(result.imageId, 'c'.repeat(64));
    assert.deepEqual([result.imageRefresh.outcome, result.imageRefresh.afterId], ['replace',
        `sha256:${'c'.repeat(64)}`]);
    assert.equal(Object.hasOwn(result.imageRefresh, 'image'), false);
});

test('transaction: image mode with a selection that differs from the new ID keeps the Box as pending-agentlib',
    async (t) => {
    const state = fixture(t);
    fs.rmSync(state.agentLib.sourceDir, { recursive: true });
    state.agentLib = imageAgentLibFixture();
    const initial = containerHandle({
        identity: state.identity, agentLib: state.agentLib, repositoryRoot: state.root,
        imageId: state.agentLib.supplyingImageId, imageRef: BOX_IMAGE_REFERENCE, hostPort: 8080, id: 'e'.repeat(64),
    });
    const h = harness(state, { initial, candidateImage: `sha256:${'1'.repeat(64)}` });
    h.seams.probeAgentLib = () => ({ supplyingImageId: state.agentLib.supplyingImageId });
    const result = await reconcileBoxContainer({ ...reconciliationArguments(state, h, initial),
        refreshImageTag: true }, h.seams);
    assert.equal(result.action, 'reused');
    assert.equal(result.imageRefresh.outcome, 'pending-agentlib');
});

test('transaction: a failing pull or validation leaves the Box in place with the reason', async (t) => {
    const state = fixture(t);
    const initial = reusableBox(state);
    const failedPull = harness(state, { initial, failPull: true });
    const pullResult = await reconcileBoxContainer({ ...reconciliationArguments(state, failedPull, initial),
        refreshImageTag: true }, failedPull.seams);
    assert.equal(pullResult.action, 'reused');
    assert.equal(pullResult.imageRefresh.outcome, 'pull-failed');
    const invalid = harness(state, { initial });
    invalid.seams.validateImage = () => { throw new Error('contract violated'); };
    const invalidResult = await reconcileBoxContainer({ ...reconciliationArguments(state, invalid, initial),
        refreshImageTag: true }, invalid.seams);
    assert.equal(invalidResult.action, 'reused');
    assert.deepEqual([invalidResult.imageRefresh.outcome, invalidResult.imageRefresh.reason], ['invalid',
        'contract violated']);
});

test('transaction: refresh options are refused before any engine call when they cannot be honoured', async (t) => {
    const state = fixture(t);
    const initial = reusableBox(state);
    for (const [options, pattern] of [
        [{ replaceImage: true, refreshImageTag: true }, /cannot be combined/],
        [{ replaceImage: true, imagePolicy: 'preserve' }, /preserve/],
        [{ refreshImageTag: true, imagePolicy: 'preserve' }, /preserve/],
        [{ replaceImage: true, allowReplacement: false }, /may replace the Box/],
        [{ refreshImageTag: true, allowReplacement: false }, /may replace the Box/],
        [{ replaceImage: true, requireExistingContainerId: 'e'.repeat(64) }, /required existing Box/],
        [{ refreshImageTag: true, requireExistingContainerId: 'e'.repeat(64) }, /required existing Box/],
    ]) {
        const h = harness(state, { initial });
        await assert.rejects(reconcileBoxContainer({ ...reconciliationArguments(state, h, initial), ...options },
            h.seams), pattern);
        assert.deepEqual(h.calls, [], `no discover, pull or stop call: ${JSON.stringify(options)}`);
    }
});

// ---- 3. Supervisor ----

function scenarioWithBox(t, { boxImage, container = null, env = {} } = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-image-supervisor-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reconcileOptions = [];
    const loadedRefs = [];
    const refreshCalls = [];
    let scenario;
    const ownership = () => ({
        state: 'owned',
        engine: ENGINE,
        handles: { container: { id: 'a'.repeat(64), runtime: { running: true }, ...(container || {}) } },
    });
    scenario = createUpdateBoxScenario({
        root,
        core: { records: () => [verifiedRecord()] },
        overrides: {
            env,
            discover: ownership,
            loadAgentLibImage: async (options) => { loadedRefs.push(options.imageRef); return {}; },
            ...(boxImage === undefined ? {} : {
                refreshBoxImage: async (input, deps) => { refreshCalls.push([input, deps]); return boxImage; },
            }),
            updateWorkspacePloinky: async () => ({
                found: true, updated: false, skipped: true, scopeExcluded: true, reason: 'fixture',
                    repoPath: '/ws/ploinky',
            }),
            reconcile: async (options) => { reconcileOptions.push(options); return scenario.prepared; },
            updateAgentLib: async ({ loadImageBundle }) => {
                await loadImageBundle();
                return { selection: scenario.selection, changed: false, previous: scenario.selection };
            },
            selectAgentLib: async ({ loadImageBundle }) => {
                await loadImageBundle();
                return { selection: scenario.selection };
            },
        },
    });
    return { scenario, reconcileOptions, loadedRefs, refreshCalls };
}

test('supervisor: replaceImage and the digest ref reach the reconcile; the record sits between its neighbours', async (t) => {
    const boxImage = { outcome: 'replace', replaceImage: true, refreshImageTag: false,
        digestRef: `docker.io/x/box@${REMOTE}`,
        beforeId: OLD_ID, afterId: NEW_ID, canonical: IMAGE_REF, reason: '' };
    const { scenario, reconcileOptions, refreshCalls, loadedRefs } = scenarioWithBox(t, { boxImage });
    scenario.prepared.action = 'replaced';
    scenario.prepared.imageId = NEW_ID;
    const result = await scenario.supervisor.runUpdateTransaction(['update']);
    assert.equal(refreshCalls.length, 1);
    assert.equal(refreshCalls[0][1].runner !== undefined, true);
    assert.equal(reconcileOptions[0].replaceImage, true);
    assert.equal(reconcileOptions[0].refreshImageTag, false);
    assert.deepEqual(loadedRefs, [`docker.io/x/box@${REMOTE}`], 'the AgentLib is selected from the digest ref');
    const ids = result.records.map((record) => `${record.phase}:${record.code}`);
    const boxIndex = ids.indexOf('image:box-image-refreshed');
    assert.ok(boxIndex > 0, ids.join(','));
    assert.equal(result.records[boxIndex - 1].phase, 'workspace-ploinky', 'after the workspace-Ploinky record');
    assert.equal(result.records[boxIndex + 1].phase, 'agentlib', 'followed by the AgentLib record');
});

test('supervisor: refreshImageTag reaches the reconcile', async (t) => {
    const boxImage = { outcome: 'tag-refresh', replaceImage: false, refreshImageTag: true, digestRef: '',
        beforeId: OLD_ID,
        afterId: '', canonical: IMAGE_REF, reason: 'proxy' };
    const { scenario, reconcileOptions } = scenarioWithBox(t, { boxImage });
    scenario.prepared.imageRefresh = { outcome: 'current', beforeId: OLD_ID, afterId: OLD_ID, reason: '' };
    const result = await scenario.supervisor.runUpdateTransaction(['update']);
    assert.deepEqual([reconcileOptions[0].replaceImage, reconcileOptions[0].refreshImageTag], [false, true]);
    assert.ok(result.records.some((record) => record.code === 'box-image-current'));
});

test('supervisor: a targeted update never calls the Box image step', async (t) => {
    const { scenario, refreshCalls } = scenarioWithBox(t, { boxImage: { outcome: 'skip' } });
    await scenario.supervisor.runUpdateTransaction(['update', 'repos']);
    assert.equal(refreshCalls.length, 0);
});

test('supervisor: without the option there is no step, no record and no refresh option', async (t) => {
    const { scenario, reconcileOptions } = scenarioWithBox(t);
    const result = await scenario.supervisor.runUpdateTransaction(['update']);
    assert.equal(reconcileOptions[0].replaceImage, false);
    assert.equal(reconcileOptions[0].refreshImageTag, false);
    assert.equal(result.records.some((record) => record.phase === 'image'), false);
});

test('production wiring: the Box CLI constructs the supervisor with refreshBoxImageForUpdate', () => {
    const source = fs.readFileSync(new URL('../../ploinky-box/bin/ploinky-box.mjs', import.meta.url), 'utf8');
    assert.match(source, /createBoxSupervisor\(\{[^}]*refreshBoxImage: refreshBoxImageForUpdate/s);
});

// ---- 4. Cross-workspace: a tag moved by another workspace never makes a non-replacing command replace or refuse ----

const RUNNING_BOX = {
    labels: { [BOX_LABELS.imageRef]: IMAGE_REF },
    runtime: { running: true, imageId: OLD_ID },
};

test('cross-workspace: a generic command and a targeted update select the AgentLib from the image the Box runs',
    async (t) => {
    const generic = scenarioWithBox(t, { container: RUNNING_BOX, env: { PLOINKY_BOX_IMAGE: IMAGE_REF } });
    await generic.scenario.supervisor.prepareBoxForCommand({ imageRef: IMAGE_REF });
    assert.deepEqual(generic.loadedRefs, [OLD_ID], 'loads O, not the moved tag');
    assert.equal(generic.reconcileOptions[0].imageRef, IMAGE_REF);

    const targeted = scenarioWithBox(t, { container: RUNNING_BOX, env: { PLOINKY_BOX_IMAGE: IMAGE_REF } });
    await targeted.scenario.supervisor.runUpdateTransaction(['update', 'repos']);
    assert.deepEqual(targeted.loadedRefs, [OLD_ID]);
});

test('cross-workspace: a changed reference still selects from the new reference, and a full update reads the tag',
    async (t) => {
    const changed = scenarioWithBox(t, { container: RUNNING_BOX,
        env: { PLOINKY_BOX_IMAGE: 'docker.io/x/other:latest' } });
    await changed.scenario.supervisor.prepareBoxForCommand({ imageRef: 'docker.io/x/other:latest' });
    assert.deepEqual(changed.loadedRefs, ['docker.io/x/other:latest']);
    const full = scenarioWithBox(t, { container: RUNNING_BOX, env: { PLOINKY_BOX_IMAGE: IMAGE_REF } });
    await full.scenario.supervisor.runUpdateTransaction(['update']);
    assert.deepEqual(full.loadedRefs, [IMAGE_REF], 'a full update keeps reading the tag');
});

test('cross-workspace: a guarded start of an existing Box selects from its image (source check)', () => {
    const source = fs.readFileSync(new URL('../../ploinky-box/supervisor.mjs', import.meta.url), 'utf8');
    assert.match(source, /imageBundleLoader\(ownership, startImageSource\(ownership, existing, options\)\)/);
    assert.match(source, /return existing \? existingBoxImageSource\(ownership, ref\) : ref;/);
});
