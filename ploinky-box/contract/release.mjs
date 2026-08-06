import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { PloinkyBoxError } from '../errors.mjs';

export const RELEASE_DESCRIPTOR_SCHEMA = 'ploinky-release-v1';
export const RELEASE_DESCRIPTOR_ENV = 'PLOINKY_RELEASE_DESCRIPTOR';
export const REQUIRED_RELEASE_AGENTLIB_SHA = 'dd94929443033c0a43bf7569068ec1d2926dba35';
export const CODING_NODE_IMAGE_REFERENCE = 'docker.io/assistos/ploinky-node:24-bookworm-tools';

const RELEASE_INPUT_FIELDS = Object.freeze([
    'schema',
    'boxImageId',
    'boxImageDigest',
    'nodeImageId',
    'nodeImageDigest',
    'artifactSourceSha',
    'controllerSourceSha',
    'agentlibSha',
    'routerHostPort',
    'mediaHostPort',
]);
const RELEASE_FIELDS = Object.freeze([...RELEASE_INPUT_FIELDS, 'releaseGeneration']);
const RAW_IMAGE_ID = /^[a-f0-9]{64}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const PHASE_10C_ROLLBACK = Object.freeze({
    boxImageId: '55c3ea330884b09ce80bb0d3a3ba9762fee3ad353c89f062c7321a4d9c2258f8',
    boxImageDigest: 'sha256:aabe3e79dca2d7e89bbe5fa08a704401db7c242b6e68d54ee14ee4b35d3b9b19',
    nodeImageId: '083efb041797f93b230efa260ac490bf4b3266852a34bf92fce36f7824219d38',
    nodeImageDigest: 'sha256:3f72d71eeb783367047701f15e3e4dcbd233caa567b77e21428c89424d66d692',
    artifactSourceSha: '4e963bc7633dff333594d0d88b5ee5ed53dfa71e',
});
const CONTROLLER_RUNTIME_PATHS = Object.freeze([
    '.gitmodules',
    'Agent',
    'bin',
    'cli',
    'container',
    'globalDeps/package.json',
    'node_modules/achillesAgentLib',
    'package.json',
    'ploinky-box',
]);

function releaseError(message, code = 'PLOINKY_RELEASE_DESCRIPTOR_INVALID') {
    return new PloinkyBoxError(message, { code });
}

function exactKeys(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const observed = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return observed.length === wanted.length
        && observed.every((field, index) => field === wanted[index]);
}

function canonicalInput(input) {
    return Object.fromEntries(RELEASE_INPUT_FIELDS.map((field) => [field, input[field]]));
}

function derivedGeneration(input) {
    return crypto.createHash('sha256').update(JSON.stringify(canonicalInput(input))).digest('hex');
}

function validPort(value) {
    return Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}

function isExactPhase10cRollback(descriptor) {
    return Object.entries(PHASE_10C_ROLLBACK)
        .every(([field, value]) => descriptor?.[field] === value);
}

export function createReleaseDescriptor(input, {
    expectedControllerSourceSha,
} = {}) {
    if (!exactKeys(input, RELEASE_INPUT_FIELDS)) {
        throw releaseError(`Release descriptor must contain exactly ${RELEASE_INPUT_FIELDS.join(', ')}`);
    }
    if (input.schema !== RELEASE_DESCRIPTOR_SCHEMA) {
        throw releaseError(`Release descriptor schema must be ${RELEASE_DESCRIPTOR_SCHEMA}`);
    }
    for (const field of ['boxImageId', 'nodeImageId']) {
        if (!RAW_IMAGE_ID.test(input[field])) {
            throw releaseError(`${field} must be an exact raw 64-character lowercase image ID`);
        }
    }
    for (const field of ['boxImageDigest', 'nodeImageDigest']) {
        if (!SHA256_DIGEST.test(input[field])) {
            throw releaseError(`${field} must be an exact sha256 digest`);
        }
    }
    for (const field of ['artifactSourceSha', 'controllerSourceSha', 'agentlibSha']) {
        if (!COMMIT_SHA.test(input[field])) {
            throw releaseError(`${field} must be an exact 40-character lowercase commit`);
        }
    }
    if (input.agentlibSha !== REQUIRED_RELEASE_AGENTLIB_SHA) {
        throw releaseError(`agentlibSha must be ${REQUIRED_RELEASE_AGENTLIB_SHA}`);
    }
    if (expectedControllerSourceSha !== undefined
        && input.controllerSourceSha !== expectedControllerSourceSha) {
        throw releaseError('controllerSourceSha is stale for the live outer controller');
    }
    if (!validPort(input.routerHostPort) || !validPort(input.mediaHostPort)) {
        throw releaseError('routerHostPort and mediaHostPort must be integers in the range 1..65535');
    }
    if (input.routerHostPort === input.mediaHostPort) {
        throw releaseError('Router and media host ports must be distinct');
    }
    if (input.mediaHostPort === 7882) {
        throw releaseError('mediaHostPort 7882 is reserved and cannot admit an isolated release');
    }
    const canonical = canonicalInput(input);
    return Object.freeze({
        ...canonical,
        releaseGeneration: derivedGeneration(canonical),
    });
}

export function serializeReleaseDescriptor(descriptor) {
    if (!exactKeys(descriptor, RELEASE_FIELDS)) {
        throw releaseError('Release descriptor is not canonical');
    }
    const canonical = createReleaseDescriptor(canonicalInput(descriptor), {
        expectedControllerSourceSha: descriptor.controllerSourceSha,
    });
    if (descriptor.releaseGeneration !== canonical.releaseGeneration) {
        throw releaseError('releaseGeneration is stale for the release descriptor');
    }
    return JSON.stringify(canonical);
}

export function parseReleaseDescriptor(serialized, options = {}) {
    let parsed;
    try {
        parsed = JSON.parse(String(serialized));
    } catch (cause) {
        throw releaseError(`Release descriptor JSON is malformed: ${cause.message}`);
    }
    if (!exactKeys(parsed, RELEASE_FIELDS)) {
        throw releaseError('Serialized release descriptor has partial or extra fields');
    }
    const canonical = createReleaseDescriptor(canonicalInput(parsed), options);
    if (parsed.releaseGeneration !== canonical.releaseGeneration) {
        throw releaseError('releaseGeneration is stale for the release descriptor');
    }
    return canonical;
}

export function assertDistinctReleaseDescriptors(previous, current) {
    const left = parseReleaseDescriptor(serializeReleaseDescriptor(previous), {
        expectedControllerSourceSha: previous.controllerSourceSha,
    });
    const right = parseReleaseDescriptor(serializeReleaseDescriptor(current), {
        expectedControllerSourceSha: current.controllerSourceSha,
    });
    if (left.releaseGeneration === right.releaseGeneration) {
        throw releaseError('Release descriptors must be distinct');
    }
    if (left.routerHostPort === right.routerHostPort) {
        throw releaseError('Distinct releases require unique Router host ports');
    }
    if (left.mediaHostPort === right.mediaHostPort) {
        throw releaseError('Distinct releases require unique media host ports');
    }
    return Object.freeze({ previous: left, current: right });
}

export function validateReleaseImageInspection(kind, inspection, descriptor) {
    if (!['box', 'node'].includes(kind)) {
        throw releaseError(`Unknown release image kind ${kind}`);
    }
    const prefix = kind === 'box' ? 'box' : 'node';
    const expectedId = descriptor[`${prefix}ImageId`];
    const expectedDigest = descriptor[`${prefix}ImageDigest`];
    const observedId = String(inspection?.Id ?? inspection?.ID ?? '').replace(/^sha256:/, '');
    const observedDigest = String(inspection?.Digest ?? '').trim();
    const repoDigests = Array.isArray(inspection?.RepoDigests)
        ? inspection.RepoDigests.map(String)
        : [];
    const digestMatches = observedDigest === expectedDigest
        || repoDigests.some((value) => value.endsWith(`@${expectedDigest}`));
    const labels = inspection?.Config?.Labels ?? inspection?.Labels ?? {};
    const sourceSha = String(
        labels?.['io.assistos.ploinky.source-sha']
        ?? '',
    );
    // Phase 10C predates the AgentLib OCI label and is the explicitly accepted
    // previous rollback pair. Its descriptor remains bound through the exact
    // artifact digest plus the artifact commit's gitlink/package/lock proof.
    // Every rebuilt image carries this label; if present it is authoritative.
    const agentlibSha = String(labels?.['io.assistos.ploinky.agentlib-sha'] ?? '');
    const acceptedPreLabelRollback = !agentlibSha && isExactPhase10cRollback(descriptor);
    if (observedId !== expectedId
        || !digestMatches
        || sourceSha !== descriptor.artifactSourceSha
        || (agentlibSha !== descriptor.agentlibSha && !acceptedPreLabelRollback)) {
        throw releaseError(
            `${kind} image inspection is stale for release ${descriptor.releaseGeneration}`,
            'PLOINKY_RELEASE_IMAGE_STALE',
        );
    }
    return Object.freeze({
        kind,
        imageId: expectedId,
        imageDigest: expectedDigest,
        artifactSourceSha: descriptor.artifactSourceSha,
        agentlibSha: agentlibSha || descriptor.agentlibSha,
        releaseGeneration: descriptor.releaseGeneration,
    });
}

export function inspectAndValidateReleaseImage(engine, kind, descriptor, runner) {
    const prefix = kind === 'box' ? 'box' : kind === 'node' ? 'node' : '';
    if (!prefix) throw releaseError(`Unknown release image kind ${kind}`);
    void engine; void descriptor; void runner;
    throw releaseError(
        `Ordinary host ${kind} image inspection is retired; use the structured exact-image client`,
        'PLOINKY_RELEASE_IMAGE_INSPECT_UNSUPPORTED',
    );
}

export function resolveReleaseManifestImage(manifest, descriptor, {
    inspectNodeImage,
} = {}) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw releaseError('Manifest must be an object');
    }
    if (manifest.container !== CODING_NODE_IMAGE_REFERENCE) {
        throw releaseError(`Coding manifest container must remain ${CODING_NODE_IMAGE_REFERENCE}`);
    }
    const hasSelector = Object.hasOwn(manifest, 'lite-sandbox');
    if (hasSelector && typeof manifest['lite-sandbox'] !== 'boolean') {
        throw releaseError('lite-sandbox must be boolean when present');
    }
    if (manifest['lite-sandbox'] === true) {
        return CODING_NODE_IMAGE_REFERENCE;
    }
    if (typeof inspectNodeImage !== 'function') {
        throw releaseError(
            'Exact local Node image inspection is required; pull, build, retag, and fallback are forbidden',
            'PLOINKY_RELEASE_IMAGE_STALE',
        );
    }
    inspectNodeImage(descriptor);
    return descriptor.nodeImageId;
}

export function releaseRuntimeIdentity(runtimeIdentity, descriptor) {
    if (!runtimeIdentity || typeof runtimeIdentity !== 'object' || Array.isArray(runtimeIdentity)) {
        throw releaseError('Runtime identity must be an object');
    }
    if (runtimeIdentity.releaseGeneration !== undefined
        && runtimeIdentity.releaseGeneration !== descriptor.releaseGeneration) {
        throw releaseError(
            'Runtime identity belongs to a stale release generation',
            'PLOINKY_RELEASE_GENERATION_STALE',
        );
    }
    return Object.freeze({
        ...runtimeIdentity,
        releaseGeneration: descriptor.releaseGeneration,
    });
}

export function assertReleaseRuntimeIdentity(runtimeIdentity, descriptor) {
    if (!runtimeIdentity || runtimeIdentity.releaseGeneration !== descriptor.releaseGeneration) {
        throw releaseError(
            'Runtime identity belongs to a stale release generation',
            'PLOINKY_RELEASE_GENERATION_STALE',
        );
    }
    return runtimeIdentity;
}

export function validateReleaseControllerAdmission(descriptor, {
    repositoryRoot,
    fsApi = fs,
    exec = execFileSync,
} = {}) {
    const root = path.resolve(repositoryRoot || path.resolve(import.meta.dirname, '../..'));
    let head;
    let gitlink;
    let trackedPackage;
    let trackedLock;
    let artifactGitlink;
    let artifactPackage;
    let artifactLock;
    let untrackedRuntimeSource;
    try {
        const gitOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
        head = String(exec('git', ['-C', root, 'rev-parse', 'HEAD'], gitOptions)).trim();
        gitlink = String(exec('git', [
            '-C', root, 'ls-tree', 'HEAD', 'node_modules/achillesAgentLib',
        ], gitOptions)).trim().split(/\s+/);
        trackedPackage = String(exec('git', [
            '-C', root, 'show', 'HEAD:globalDeps/package.json',
        ], gitOptions));
        trackedLock = String(exec('git', [
            '-C', root, 'show', 'HEAD:ploinky-box/dependencies.lock.json',
        ], gitOptions));
        artifactGitlink = String(exec('git', [
            '-C', root, 'ls-tree', descriptor.artifactSourceSha, 'node_modules/achillesAgentLib',
        ], gitOptions)).trim().split(/\s+/);
        artifactPackage = String(exec('git', [
            '-C', root, 'show', `${descriptor.artifactSourceSha}:globalDeps/package.json`,
        ], gitOptions));
        artifactLock = String(exec('git', [
            '-C', root, 'show', `${descriptor.artifactSourceSha}:ploinky-box/dependencies.lock.json`,
        ], gitOptions));
        exec('git', [
            '-C', root, 'diff', '--quiet', descriptor.controllerSourceSha, '--',
            ...CONTROLLER_RUNTIME_PATHS,
        ], gitOptions);
        untrackedRuntimeSource = String(exec('git', [
            '-C', root, 'ls-files', '--others', '--exclude-standard', '--',
            ...CONTROLLER_RUNTIME_PATHS,
        ], gitOptions)).trim();
    } catch (cause) {
        throw releaseError(`Unable to validate live release controller state: ${cause.message}`);
    }
    if (head !== descriptor.controllerSourceSha) {
        throw releaseError('controllerSourceSha is stale for the live outer controller');
    }
    if (untrackedRuntimeSource) {
        throw releaseError(
            `Live release controller has untracked runtime source: ${untrackedRuntimeSource.split('\n')[0]}`,
        );
    }
    if (gitlink[0] !== '160000' || gitlink[1] !== 'commit' || gitlink[2] !== descriptor.agentlibSha) {
        throw releaseError('Tracked AgentLib gitlink is stale for the release descriptor');
    }
    let packageJson;
    let lock;
    let artifactPackageJson;
    let artifactLockJson;
    try {
        const livePackage = fsApi.readFileSync(path.join(root, 'globalDeps/package.json'), 'utf8');
        const liveLock = fsApi.readFileSync(path.join(root, 'ploinky-box/dependencies.lock.json'), 'utf8');
        if (livePackage !== trackedPackage || liveLock !== trackedLock) {
            throw new Error('AgentLib package or Box lock differs from the controller HEAD');
        }
        packageJson = JSON.parse(livePackage);
        lock = JSON.parse(liveLock);
        artifactPackageJson = JSON.parse(artifactPackage);
        artifactLockJson = JSON.parse(artifactLock);
    } catch (cause) {
        throw releaseError(`Unable to read tracked AgentLib pins: ${cause.message}`);
    }
    const expectedSpec = `git+https://github.com/AssistOS-AI/achillesAgentLib.git#${descriptor.agentlibSha}`;
    const locked = lock?.repositories?.achillesAgentLib;
    const artifactLocked = artifactLockJson?.repositories?.achillesAgentLib;
    if (packageJson?.dependencies?.achillesAgentLib !== expectedSpec
        || locked?.url !== 'https://github.com/AssistOS-AI/AchillesAgentLib.git'
        || locked?.commit !== descriptor.agentlibSha
        || artifactGitlink[0] !== '160000'
        || artifactGitlink[1] !== 'commit'
        || artifactGitlink[2] !== descriptor.agentlibSha
        || artifactPackageJson?.dependencies?.achillesAgentLib !== expectedSpec
        || artifactLocked?.url !== 'https://github.com/AssistOS-AI/AchillesAgentLib.git'
        || artifactLocked?.commit !== descriptor.agentlibSha) {
        throw releaseError(
            'AgentLib controller or artifact source boundaries are stale for the release descriptor',
        );
    }
    return descriptor;
}
