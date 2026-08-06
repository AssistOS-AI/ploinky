import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { routeOuterCommand } from '../../ploinky-box/command/route.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import {
    buildOuterContainerDefinition,
    directContainerCreateSpec,
} from '../../ploinky-box/lifecycle/container.mjs';
import { createBoxSupervisor, formatBoxStatus } from '../../ploinky-box/supervisor.mjs';
import {
    CODING_NODE_IMAGE_REFERENCE,
    RELEASE_DESCRIPTOR_ENV,
    RELEASE_DESCRIPTOR_SCHEMA,
    REQUIRED_RELEASE_AGENTLIB_SHA,
    assertDistinctReleaseDescriptors,
    assertReleaseRuntimeIdentity,
    createReleaseDescriptor,
    parseReleaseDescriptor,
    releaseRuntimeIdentity,
    resolveReleaseManifestImage,
    serializeReleaseDescriptor,
    validateReleaseControllerAdmission,
    validateReleaseImageInspection,
} from '../../ploinky-box/contract/release.mjs';
import { resolveManifestImage } from '../../cli/utils/security/secretVars.js';
import {
    inspectExactReleaseNodeImage,
    readInnerReleaseDescriptor,
    resolveInnerReleaseManifestImage,
} from '../../cli/utils/runtime/releaseRuntime.js';
import { detectContainerRuntimeKey } from '../../cli/utils/dependencies/dependencyRuntimeKey.js';
import { NETWORK_LABELS } from '../../cli/sandbox/networkLifecycle.js';
import {
    normalizeRelayDescriptor,
    verifyInspectedContainer,
} from '../../cli/server/runtimeRelay/confinement.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const workspaceRoot = path.resolve(repoRoot, '..');
const PHASE_10C_BOX_ID = '55c3ea330884b09ce80bb0d3a3ba9762fee3ad353c89f062c7321a4d9c2258f8';
const PHASE_10C_BOX_DIGEST = 'sha256:aabe3e79dca2d7e89bbe5fa08a704401db7c242b6e68d54ee14ee4b35d3b9b19';
const PHASE_10C_NODE_ID = '083efb041797f93b230efa260ac490bf4b3266852a34bf92fce36f7824219d38';
const PHASE_10C_NODE_DIGEST = 'sha256:3f72d71eeb783367047701f15e3e4dcbd233caa567b77e21428c89424d66d692';
const PHASE_10C_SOURCE = '4e963bc7633dff333594d0d88b5ee5ed53dfa71e';
const CONTROLLER_SOURCE = 'c'.repeat(40);

function descriptorInput(overrides = {}) {
    return {
        schema: RELEASE_DESCRIPTOR_SCHEMA,
        boxImageId: PHASE_10C_BOX_ID,
        boxImageDigest: PHASE_10C_BOX_DIGEST,
        nodeImageId: PHASE_10C_NODE_ID,
        nodeImageDigest: PHASE_10C_NODE_DIGEST,
        artifactSourceSha: PHASE_10C_SOURCE,
        controllerSourceSha: CONTROLLER_SOURCE,
        agentlibSha: REQUIRED_RELEASE_AGENTLIB_SHA,
        routerHostPort: 18081,
        mediaHostPort: 17883,
        ...overrides,
    };
}

function release(overrides = {}) {
    return createReleaseDescriptor(descriptorInput(overrides), {
        expectedControllerSourceSha: overrides.controllerSourceSha || CONTROLLER_SOURCE,
    });
}

function exactNodeInspection(descriptor) {
    return {
        Id: descriptor.nodeImageId,
        Digest: descriptor.nodeImageDigest,
        RepoDigests: [`docker.io/assistos/ploinky-node@${descriptor.nodeImageDigest}`],
        Config: {
            Labels: {
                'io.assistos.ploinky.source-sha': descriptor.artifactSourceSha,
                'io.assistos.ploinky.agentlib-sha': descriptor.agentlibSha,
            },
        },
    };
}

test('one canonical descriptor derives and revalidates an immutable release generation', () => {
    const descriptor = release();
    assert.match(descriptor.releaseGeneration, /^[a-f0-9]{64}$/);
    assert.equal(descriptor.agentlibSha, 'dd94929443033c0a43bf7569068ec1d2926dba35');
    assert.equal(Object.isFrozen(descriptor), true);

    const serialized = serializeReleaseDescriptor(descriptor);
    assert.equal(serialized, JSON.stringify(descriptor));
    assert.deepEqual(parseReleaseDescriptor(serialized, {
        expectedControllerSourceSha: CONTROLLER_SOURCE,
    }), descriptor);
});

test('the release AgentLib identity is identical at gitlink, package, and Box lock boundaries', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'globalDeps/package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(
        path.join(repoRoot, 'ploinky-box/dependencies.lock.json'),
        'utf8',
    ));
    const gitlink = execFileSync('git', [
        '-C', repoRoot,
        'ls-tree', 'HEAD', 'node_modules/achillesAgentLib',
    ], { encoding: 'utf8' }).trim().split(/\s+/);

    assert.deepEqual(gitlink.slice(0, 3), [
        '160000',
        'commit',
        REQUIRED_RELEASE_AGENTLIB_SHA,
    ]);
    assert.equal(
        packageJson.dependencies.achillesAgentLib,
        `git+https://github.com/AssistOS-AI/achillesAgentLib.git#${REQUIRED_RELEASE_AGENTLIB_SHA}`,
    );
    assert.deepEqual(lock.repositories.achillesAgentLib, {
        url: 'https://github.com/AssistOS-AI/AchillesAgentLib.git',
        commit: REQUIRED_RELEASE_AGENTLIB_SHA,
    });
});

test('descriptor admission rejects partial, extra, mutable, malformed, mixed, and stale inputs', () => {
    const canonical = release();
    const invalid = [];

    for (const field of Object.keys(descriptorInput())) {
        const candidate = descriptorInput();
        delete candidate[field];
        invalid.push(candidate);
    }
    invalid.push({ ...descriptorInput(), legacyImage: 'docker.io/assistos/ploinky-node:latest' });
    invalid.push(descriptorInput({ boxImageId: `sha256:${PHASE_10C_BOX_ID}` }));
    invalid.push(descriptorInput({ nodeImageId: 'docker.io/assistos/ploinky-node:24-bookworm-tools' }));
    invalid.push(descriptorInput({ nodeImageId: 'A'.repeat(64) }));
    invalid.push(descriptorInput({ boxImageDigest: PHASE_10C_BOX_ID }));
    invalid.push(descriptorInput({ nodeImageDigest: 'sha256:latest' }));
    invalid.push(descriptorInput({ artifactSourceSha: 'main' }));
    invalid.push(descriptorInput({ agentlibSha: '975e7a318e1c8c8d1792ec96fe7b820fc465d1f5' }));
    invalid.push(descriptorInput({ routerHostPort: 17883, mediaHostPort: 17883 }));
    invalid.push(descriptorInput({ mediaHostPort: 7882 }));

    for (const candidate of invalid) {
        assert.throws(
            () => createReleaseDescriptor(candidate, {
                expectedControllerSourceSha: CONTROLLER_SOURCE,
            }),
            { code: 'PLOINKY_RELEASE_DESCRIPTOR_INVALID' },
        );
    }

    assert.throws(
        () => parseReleaseDescriptor(JSON.stringify({
            ...canonical,
            releaseGeneration: 'f'.repeat(64),
        }), { expectedControllerSourceSha: CONTROLLER_SOURCE }),
        /releaseGeneration.*stale|stale.*releaseGeneration/i,
    );
    assert.throws(
        () => parseReleaseDescriptor(serializeReleaseDescriptor(canonical), {
            expectedControllerSourceSha: 'd'.repeat(40),
        }),
        /controllerSourceSha.*stale|stale.*controllerSourceSha/i,
    );
});

test('inner admission rejects independent generation and AgentLib side channels', () => {
    const descriptor = release();
    const serialized = serializeReleaseDescriptor(descriptor);
    assert.deepEqual(readInnerReleaseDescriptor({
        env: { [RELEASE_DESCRIPTOR_ENV]: serialized },
    }), descriptor);
    for (const conflict of [
        { PLOINKY_RELEASE_GENERATION: descriptor.releaseGeneration },
        { PLOINKY_RELEASE_GENERATION: '9'.repeat(64) },
        { PLOINKY_AGENTLIB_REF: descriptor.agentlibSha },
        { PLOINKY_AGENTLIB_REF: '9'.repeat(40) },
    ]) {
        assert.throws(
            () => readInnerReleaseDescriptor({
                env: { [RELEASE_DESCRIPTOR_ENV]: serialized, ...conflict },
            }),
            /descriptor.*sole|side channel|independent/i,
        );
    }
});

test('controller admission proves both controller and artifact AgentLib boundaries', () => {
    const controllerSourceSha = execFileSync('git', [
        '-C', repoRoot, 'rev-parse', 'HEAD',
    ], { encoding: 'utf8' }).trim();
    const previous = release({ controllerSourceSha });
    const cleanRuntimeExec = (command, args, options) => {
        if (args.includes('diff') && args.includes('--quiet')) return '';
        if (args.includes('ls-files') && args.includes('--others')) return '';
        return execFileSync(command, args, options);
    };
    assert.doesNotThrow(() => validateReleaseControllerAdmission(previous, {
        repositoryRoot: repoRoot,
        exec: cleanRuntimeExec,
    }));
    assert.throws(() => validateReleaseControllerAdmission(previous, {
        repositoryRoot: repoRoot,
        exec(command, args, options) {
            if (args.includes('diff') && args.includes('--quiet')) {
                const error = new Error('runtime diff');
                error.status = 1;
                throw error;
            }
            return cleanRuntimeExec(command, args, options);
        },
    }), /controller.*runtime|runtime.*controller|live release controller/i);
    assert.throws(() => validateReleaseControllerAdmission(previous, {
        repositoryRoot: repoRoot,
        exec(command, args, options) {
            if (args.includes('ls-files') && args.includes('--others')) {
                return 'ploinky-box/contract/untracked-runtime.mjs\n';
            }
            return cleanRuntimeExec(command, args, options);
        },
    }), /untracked.*runtime|runtime.*untracked|live release controller/i);

    const nonexistentArtifact = release({
        artifactSourceSha: '0'.repeat(40),
        controllerSourceSha,
    });
    assert.throws(
        () => validateReleaseControllerAdmission(nonexistentArtifact, {
            repositoryRoot: repoRoot,
            exec: cleanRuntimeExec,
        }),
        /artifact.*source|AgentLib.*artifact|unable to validate/i,
    );
});

test('Phase 10C rollback and a rebuilt current pair are distinct descriptors under new controller code', () => {
    const previous = release();
    const current = release({
        boxImageId: '1'.repeat(64),
        boxImageDigest: `sha256:${'2'.repeat(64)}`,
        nodeImageId: '3'.repeat(64),
        nodeImageDigest: `sha256:${'4'.repeat(64)}`,
        artifactSourceSha: CONTROLLER_SOURCE,
        routerHostPort: 18082,
        mediaHostPort: 17884,
    });

    assert.equal(previous.boxImageId, PHASE_10C_BOX_ID);
    assert.equal(previous.nodeImageId, PHASE_10C_NODE_ID);
    assert.equal(previous.artifactSourceSha, PHASE_10C_SOURCE);
    assert.equal(previous.controllerSourceSha, CONTROLLER_SOURCE);
    assert.doesNotThrow(() => assertDistinctReleaseDescriptors(previous, current));
    assert.notEqual(previous.releaseGeneration, current.releaseGeneration);

    assert.throws(
        () => assertDistinctReleaseDescriptors(previous, release({
            boxImageId: '5'.repeat(64),
            boxImageDigest: `sha256:${'6'.repeat(64)}`,
            nodeImageId: '7'.repeat(64),
            nodeImageDigest: `sha256:${'8'.repeat(64)}`,
            artifactSourceSha: CONTROLLER_SOURCE,
            routerHostPort: 18082,
            mediaHostPort: previous.mediaHostPort,
        })),
        /media.*unique|distinct.*media/i,
    );
});

test('OpenCode, Codex, and PI false or missing selectors use the exact Node ID without the LLM gate', () => {
    const descriptor = release();
    for (const agent of ['opencodeAgent', 'codexAgent', 'piAgent']) {
        const manifest = JSON.parse(fs.readFileSync(
            path.join(workspaceRoot, 'AchillesCLI', agent, 'manifest.json'),
            'utf8',
        ));
        for (const mode of ['false', 'missing']) {
            const candidate = { ...manifest };
            if (mode === 'false') candidate['lite-sandbox'] = false;
            else delete candidate['lite-sandbox'];
            let inspections = 0;
            const selected = resolveReleaseManifestImage(candidate, descriptor, {
                inspectNodeImage(exactDescriptor) {
                    inspections += 1;
                    assert.equal(exactDescriptor, descriptor);
                },
            });
            assert.equal(selected, descriptor.nodeImageId, `${agent}:${mode}`);
            assert.equal(inspections, 1, `${agent}:${mode}`);
            assert.equal(Object.hasOwn(manifest, 'llmRuntime'), false, agent);
        }
    }
});

test('false and missing coding modes inspect the exact Node image once across admission and dependency probing', () => {
    const descriptor = release();
    for (const agent of ['opencodeAgent', 'codexAgent', 'piAgent']) {
        const manifest = JSON.parse(fs.readFileSync(
            path.join(workspaceRoot, 'AchillesCLI', agent, 'manifest.json'),
            'utf8',
        ));
        for (const mode of ['false', 'missing']) {
            const candidate = { ...manifest };
            if (mode === 'false') candidate['lite-sandbox'] = false;
            else delete candidate['lite-sandbox'];
            const calls = [];
            let receipt = null;
            const image = resolveInnerReleaseManifestImage(candidate, {
                descriptor,
                runtime: 'podman',
                spawnSyncImpl(runtime, args) {
                    calls.push(`${runtime} ${args.join(' ')}`);
                    return {
                        status: 0,
                        stdout: JSON.stringify([exactNodeInspection(descriptor)]),
                        stderr: '',
                    };
                },
                captureInspection(value) {
                    receipt = value;
                },
            });
            const runtimeKey = detectContainerRuntimeKey({
                manifest: candidate,
                image,
                runtime: 'podman',
                releaseDescriptor: descriptor,
                releaseImageInspection: receipt,
                ensureImage({ image: ensuredImage }) {
                    calls.push(`ensure ${ensuredImage}`);
                },
                execProbe({ image: probedImage }) {
                    calls.push(`probe ${probedImage}`);
                    return '{"platform":"linux","arch":"x64","nodeMajor":24,"libc":"glibc"}';
                },
            });
            assert.equal(runtimeKey, 'container-linux-x64-glibc-node24');
            assert.deepEqual(calls, [
                `podman image inspect ${descriptor.nodeImageId}`,
                `probe ${descriptor.nodeImageId}`,
            ], `${agent}:${mode}`);
        }
    }
});

test('dependency probing cannot forge, omit, or redirect exact release image admission', () => {
    const descriptor = release();
    const manifest = JSON.parse(fs.readFileSync(
        path.join(workspaceRoot, 'AchillesCLI', 'codexAgent', 'manifest.json'),
        'utf8',
    ));
    manifest['lite-sandbox'] = false;
    let receipt = null;
    const image = resolveInnerReleaseManifestImage(manifest, {
        descriptor,
        runtime: 'podman',
        spawnSyncImpl() {
            return {
                status: 0,
                stdout: JSON.stringify([exactNodeInspection(descriptor)]),
                stderr: '',
            };
        },
        captureInspection(value) {
            receipt = value;
        },
    });
    const base = {
        manifest,
        image,
        runtime: 'podman',
        ensureImage() {
            assert.fail('an exact admitted release image must not be ensured again');
        },
        execProbe() {
            return '{"platform":"linux","arch":"x64","nodeMajor":24,"libc":"glibc"}';
        },
    };
    for (const releaseInputs of [
        { releaseDescriptor: descriptor },
        { releaseImageInspection: receipt },
        { releaseDescriptor: descriptor, releaseImageInspection: { ...receipt } },
        {
            releaseDescriptor: descriptor,
            releaseImageInspection: receipt,
            image: '9'.repeat(64),
        },
    ]) {
        assert.throws(
            () => detectContainerRuntimeKey({ ...base, ...releaseInputs }),
            { code: 'PLOINKY_RELEASE_IMAGE_STALE' },
        );
    }
});

test('lite-sandbox true keeps the Node image completely dormant and never dual-launches', () => {
    const descriptor = release();
    for (const agent of ['opencodeAgent', 'codexAgent', 'piAgent']) {
        const manifest = JSON.parse(fs.readFileSync(
            path.join(workspaceRoot, 'AchillesCLI', agent, 'manifest.json'),
            'utf8',
        ));
        let inspections = 0;
        const selected = resolveReleaseManifestImage(manifest, descriptor, {
            inspectNodeImage() { inspections += 1; },
        });
        assert.equal(selected, CODING_NODE_IMAGE_REFERENCE);
        assert.equal(inspections, 0, agent);
    }
});

test('exact local Box and Node inspections bind IDs, digests, and artifact source without fallback', () => {
    const descriptor = release();
    function inspection(kind) {
        const prefix = kind === 'box' ? 'box' : 'node';
        return {
            Id: descriptor[`${prefix}ImageId`],
            Digest: descriptor[`${prefix}ImageDigest`],
            RepoDigests: [`docker.io/assistos/ploinky-${prefix}@${descriptor[`${prefix}ImageDigest`]}`],
            Config: {
                Labels: {
                    'io.assistos.ploinky.source-sha': descriptor.artifactSourceSha,
                    'io.assistos.ploinky.agentlib-sha': descriptor.agentlibSha,
                },
            },
        };
    }

    assert.doesNotThrow(() => validateReleaseImageInspection('box', inspection('box'), descriptor));
    assert.doesNotThrow(() => validateReleaseImageInspection('node', inspection('node'), descriptor));
    const phase10cRollbackInspection = inspection('node');
    delete phase10cRollbackInspection.Config.Labels['io.assistos.ploinky.agentlib-sha'];
    assert.doesNotThrow(() => validateReleaseImageInspection(
        'node',
        phase10cRollbackInspection,
        descriptor,
    ));
    const rebuilt = release({
        boxImageId: '1'.repeat(64),
        boxImageDigest: `sha256:${'2'.repeat(64)}`,
        nodeImageId: '3'.repeat(64),
        nodeImageDigest: `sha256:${'4'.repeat(64)}`,
        artifactSourceSha: CONTROLLER_SOURCE,
    });
    assert.throws(() => validateReleaseImageInspection('node', {
        Id: rebuilt.nodeImageId,
        Digest: rebuilt.nodeImageDigest,
        Config: {
            Labels: {
                'io.assistos.ploinky.source-sha': rebuilt.artifactSourceSha,
            },
        },
    }, rebuilt), { code: 'PLOINKY_RELEASE_IMAGE_STALE' });
    for (const mutate of [
        (value) => { value.Id = '9'.repeat(64); },
        (value) => { value.Digest = `sha256:${'9'.repeat(64)}`; value.RepoDigests = []; },
        (value) => { value.Config.Labels['io.assistos.ploinky.source-sha'] = '9'.repeat(40); },
        (value) => { value.Config.Labels['io.assistos.ploinky.agentlib-sha'] = '9'.repeat(40); },
    ]) {
        const value = inspection('node');
        mutate(value);
        assert.throws(
            () => validateReleaseImageInspection('node', value, descriptor),
            { code: 'PLOINKY_RELEASE_IMAGE_STALE' },
        );
    }

    assert.throws(() => inspectExactReleaseNodeImage(descriptor, {
        runtime: 'podman',
        spawnSyncImpl() {
            return {
                status: 0,
                stdout: JSON.stringify([inspection('node'), inspection('node')]),
                stderr: '',
            };
        },
    }), /one.*record|exactly one/i);
});

test('release generation is immutable ownership for status, reconcile, lease, cancellation, and cleanup records', () => {
    const previous = release();
    const current = release({
        boxImageId: '1'.repeat(64),
        boxImageDigest: `sha256:${'2'.repeat(64)}`,
        nodeImageId: '3'.repeat(64),
        nodeImageDigest: `sha256:${'4'.repeat(64)}`,
        artifactSourceSha: CONTROLLER_SOURCE,
        routerHostPort: 18082,
        mediaHostPort: 17884,
    });
    const owned = releaseRuntimeIdentity({
        instanceId: '11111111-2222-4333-8444-555555555555',
        enableGeneration: '66666666-7777-4888-8999-aaaaaaaaaaaa',
    }, previous);
    assert.equal(owned.releaseGeneration, previous.releaseGeneration);
    assert.doesNotThrow(() => assertReleaseRuntimeIdentity(owned, previous));
    assert.throws(
        () => assertReleaseRuntimeIdentity(owned, current),
        { code: 'PLOINKY_RELEASE_GENERATION_STALE' },
    );
    for (const purpose of ['status', 'reconcile', 'lease', 'cancellation', 'cleanup']) {
        assert.equal(
            assertReleaseRuntimeIdentity({ ...owned, purpose }, previous).releaseGeneration,
            previous.releaseGeneration,
            purpose,
        );
    }
});

test('runtime relay confinement preserves and verifies exact release ownership', () => {
    const releaseGeneration = '1'.repeat(64);
    const relay = normalizeRelayDescriptor({
        kind: 'container-exec-stdio',
        runtime: 'podman',
        containerId: 'a'.repeat(64),
        containerName: 'coding-runtime',
        targetAgentId: 'agent:fixtures/coding',
        effectiveInstanceId: 'instance-current',
        enableGeneration: 'enable-current',
        releaseGeneration,
        networkMode: 'bridge',
    });
    assert.equal(relay.releaseGeneration, releaseGeneration);
    const inspection = {
        Id: relay.containerId,
        Name: relay.containerName,
        State: { Running: true },
        HostConfig: { NetworkMode: 'bridge' },
        Config: {
            Labels: {
                [NETWORK_LABELS.managed]: '1',
                [NETWORK_LABELS.resource]: 'agent',
                [NETWORK_LABELS.instanceId]: relay.effectiveInstanceId,
                [NETWORK_LABELS.enableGeneration]: relay.enableGeneration,
                [NETWORK_LABELS.releaseGeneration]: '2'.repeat(64),
            },
        },
    };
    assert.throws(() => verifyInspectedContainer(relay, inspection), /release|runtime identity/i);
    inspection.Config.Labels[NETWORK_LABELS.releaseGeneration] = releaseGeneration;
    assert.deepEqual(verifyInspectedContainer(relay, inspection), relay);
    assert.throws(() => normalizeRelayDescriptor({ ...relay, releaseGeneration: 'main' }), /release/i);
});

test('public Box admission accepts one release descriptor and retires loose legacy overrides', () => {
    const descriptor = release();
    const serialized = serializeReleaseDescriptor(descriptor);
    const parsed = parseOuterArguments([
        '--local-release-descriptor', serialized,
        'start', 'Agent',
    ], { expectedControllerSourceSha: CONTROLLER_SOURCE });
    assert.deepEqual(parsed.localReleaseDescriptor, descriptor);
    assert.equal(parsed.start.hostPort, descriptor.routerHostPort);
    assert.deepEqual(routeOuterCommand(parsed), {
        kind: 'start',
        hostPort: descriptor.routerHostPort,
        localReleaseDescriptor: descriptor,
        coreArgv: ['start', 'Agent', '8080'],
    });

    for (const argv of [
        ['--local-box-image-id', descriptor.boxImageId, '--local-media-port', String(descriptor.mediaHostPort), 'start', 'Agent'],
        ['--local-node-image-id', descriptor.nodeImageId, 'start', 'Agent'],
    ]) {
        assert.throws(
            () => parseOuterArguments(argv, { expectedControllerSourceSha: CONTROLLER_SOURCE }),
            { code: 'PLOINKY_BOX_ARGUMENT_INVALID' },
        );
    }
});

test('Box creation owns the canonical descriptor in its exact environment and labels', () => {
    const descriptor = release();
    const serialized = serializeReleaseDescriptor(descriptor);
    const definition = buildOuterContainerDefinition({
        identity: {
            pathHash: 'a'.repeat(12),
            instance: 'ploinky-box-test',
            volumes: {
                workspace: 'ploinky-test-workspace',
                containers: 'ploinky-test-containers',
                dependencies: 'ploinky-test-dependencies',
            },
        },
        imageId: descriptor.boxImageId,
        imageRef: descriptor.boxImageId,
        hostPort: descriptor.routerHostPort,
        mediaHostPort: descriptor.mediaHostPort,
        repositoryRoot: repoRoot,
        hostKind: 'podman-machine',
        releaseDescriptor: descriptor,
    });
    const spec = directContainerCreateSpec(definition);
    assert.equal(spec.env[RELEASE_DESCRIPTOR_ENV], serialized);
    assert.equal(Object.hasOwn(spec.env, 'PLOINKY_RELEASE_GENERATION'), false);
    assert.equal(Object.hasOwn(spec.env, 'PLOINKY_AGENTLIB_REF'), false);
    assert.equal(
        spec.labels[BOX_LABELS.releaseGeneration],
        descriptor.releaseGeneration,
    );
    assert.equal(spec.labels[BOX_LABELS.releaseDescriptor], serialized);
    assert.equal(spec.image, descriptor.boxImageId);
    assert.equal(spec.raw_image_name, descriptor.boxImageId);
    assert.equal(spec.remove, false);
    assert.deepEqual(spec.dependencyContainers, []);
});

test('read-only status rejects a descriptor owned by stale controller source', async () => {
    const descriptor = release();
    const serialized = serializeReleaseDescriptor(descriptor);
    let admissionCalls = 0;
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => ({ instance: 'ploinky-box-test' }),
        discover: () => ({
            state: 'owned',
            engine: { name: 'podman' },
            handles: {
                container: {
                    id: 'a'.repeat(64),
                    labels: {
                        [BOX_LABELS.imageRef]: descriptor.boxImageId,
                        [BOX_LABELS.releaseDescriptor]: serialized,
                        [BOX_LABELS.releaseGeneration]: descriptor.releaseGeneration,
                    },
                    runtime: { running: false, imageId: descriptor.boxImageId },
                },
                volumes: {},
            },
        }),
        validateReleaseAdmission() {
            admissionCalls += 1;
            throw new Error('controllerSourceSha is stale for the live outer controller');
        },
    });
    const status = await supervisor.inspectBoxStatus();
    assert.equal(admissionCalls, 1);
    assert.equal(status.state, 'incompatible');
    assert.match(status.detail, /controllerSourceSha.*stale/);
});

test('the real manifest resolver consumes the Box-owned release and preserves true-mode dormancy', () => {
    const descriptor = release();
    const prior = process.env[RELEASE_DESCRIPTOR_ENV];
    process.env[RELEASE_DESCRIPTOR_ENV] = serializeReleaseDescriptor(descriptor);
    try {
        const manifest = JSON.parse(fs.readFileSync(
            path.join(workspaceRoot, 'AchillesCLI', 'codexAgent', 'manifest.json'),
            'utf8',
        ));
        assert.equal(resolveManifestImage({ ...manifest, 'lite-sandbox': false }), descriptor.nodeImageId);
        const missing = { ...manifest };
        delete missing['lite-sandbox'];
        assert.equal(resolveManifestImage(missing), descriptor.nodeImageId);
        assert.equal(resolveManifestImage(manifest), CODING_NODE_IMAGE_REFERENCE);
        assert.equal(resolveManifestImage({
            ...manifest,
            container: 'docker.io/library/node:24-bookworm-slim',
            'lite-sandbox': false,
        }), 'docker.io/library/node:24-bookworm-slim');
    } finally {
        if (prior === undefined) delete process.env[RELEASE_DESCRIPTOR_ENV];
        else process.env[RELEASE_DESCRIPTOR_ENV] = prior;
    }
});

test('status names the exact release generation instead of an ambiguous current image', () => {
    const descriptor = release();
    const rendered = formatBoxStatus({
        state: 'running-initialized',
        identity: { instance: 'ploinky-box-test' },
        releaseDescriptor: descriptor,
        inbox: {
            initialized: true,
            routingConfigured: true,
            trackedAgents: 0,
            runningAgents: 0,
            runtimes: [],
            warnings: [],
            cloudflarePublication: {
                mode: 'disabled',
                management: '',
                state: 'disabled',
                connectorState: 'disabled',
                hostnames: [],
            },
        },
    });
    assert.match(rendered, new RegExp(`Release generation: ${descriptor.releaseGeneration}`));
    assert.match(rendered, new RegExp(`Node image: ${descriptor.nodeImageId}`));
});
