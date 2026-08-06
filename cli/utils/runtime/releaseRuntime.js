import { spawnSync } from 'node:child_process';

import {
    CODING_NODE_IMAGE_REFERENCE,
    assertReleaseRuntimeIdentity,
    parseReleaseDescriptor,
    releaseRuntimeIdentity,
    resolveReleaseManifestImage,
    validateReleaseImageInspection,
} from '../../../ploinky-box/contract/release.mjs';

export const RELEASE_DESCRIPTOR_ENV = 'PLOINKY_RELEASE_DESCRIPTOR';
const AUTHORIZED_NODE_IMAGE_INSPECTIONS = new WeakSet();

export function readInnerReleaseDescriptor({ env = process.env } = {}) {
    const serialized = String(env?.[RELEASE_DESCRIPTOR_ENV] || '').trim();
    if (!serialized) return null;
    for (const name of ['PLOINKY_RELEASE_GENERATION', 'PLOINKY_AGENTLIB_REF']) {
        if (String(env?.[name] || '').trim()) {
            const error = new Error(
                `${RELEASE_DESCRIPTOR_ENV} is the sole release authority; independent ${name} is forbidden`,
            );
            error.code = 'PLOINKY_RELEASE_GENERATION_STALE';
            throw error;
        }
    }
    return parseReleaseDescriptor(serialized);
}

export function isReleaseCodingManifest(manifest) {
    return Boolean(
        manifest
        && typeof manifest === 'object'
        && !Array.isArray(manifest)
        && manifest.container === CODING_NODE_IMAGE_REFERENCE
        && manifest.containerSecurity
        && typeof manifest.containerSecurity === 'object'
        && !Array.isArray(manifest.containerSecurity)
        && manifest.containerSecurity.nestedBwrap === true
    );
}

function releaseImageError(message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = 'PLOINKY_RELEASE_IMAGE_STALE';
    return error;
}

export function inspectExactReleaseNodeImage(descriptor, {
    runtime,
    spawnSyncImpl = spawnSync,
} = {}) {
    if (!runtime || typeof runtime !== 'string') {
        throw releaseImageError('Exact local Node image inspection requires a container runtime');
    }
    const result = spawnSyncImpl(runtime, ['image', 'inspect', descriptor.nodeImageId], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result?.error || result?.status !== 0) {
        const detail = String(result?.error?.message || result?.stderr || '').trim();
        throw releaseImageError(
            `Exact local Node image ${descriptor.nodeImageId} is unavailable; pull, build, tag, and fallback are forbidden${detail ? `: ${detail}` : ''}`,
            result?.error,
        );
    }
    let parsed;
    try {
        parsed = JSON.parse(String(result.stdout || ''));
    } catch (cause) {
        throw releaseImageError('Exact local Node image inspection returned malformed JSON', cause);
    }
    const records = Array.isArray(parsed) ? parsed : [parsed];
    if (records.length !== 1) {
        throw releaseImageError('Exact local Node image inspection must contain exactly one record');
    }
    const [inspection] = records;
    const receipt = validateReleaseImageInspection('node', inspection, descriptor);
    AUTHORIZED_NODE_IMAGE_INSPECTIONS.add(receipt);
    return receipt;
}

export function assertExactReleaseNodeImageInspectionReceipt(receipt, descriptor, image) {
    if (!receipt || !AUTHORIZED_NODE_IMAGE_INSPECTIONS.has(receipt)
        || receipt.kind !== 'node'
        || receipt.imageId !== image
        || receipt.imageId !== descriptor?.nodeImageId
        || receipt.imageDigest !== descriptor?.nodeImageDigest
        || receipt.artifactSourceSha !== descriptor?.artifactSourceSha
        || receipt.agentlibSha !== descriptor?.agentlibSha
        || receipt.releaseGeneration !== descriptor?.releaseGeneration) {
        throw releaseImageError('Exact release Node image requires its sealed admission inspection');
    }
    return receipt;
}

export function resolveInnerReleaseManifestImage(manifest, {
    descriptor = readInnerReleaseDescriptor(),
    runtime,
    spawnSyncImpl = spawnSync,
    captureInspection,
} = {}) {
    if (!descriptor || !isReleaseCodingManifest(manifest)) return null;
    return resolveReleaseManifestImage(manifest, descriptor, {
        inspectNodeImage(exactDescriptor) {
            const receipt = inspectExactReleaseNodeImage(exactDescriptor, { runtime, spawnSyncImpl });
            if (captureInspection !== undefined) {
                if (typeof captureInspection !== 'function') {
                    throw releaseImageError('Release image inspection capture must be a function');
                }
                captureInspection(receipt);
            }
        },
    });
}

export function bindInnerReleaseRuntimeIdentity(runtimeIdentity, descriptor) {
    return descriptor ? releaseRuntimeIdentity(runtimeIdentity, descriptor) : Object.freeze(runtimeIdentity);
}

export function assertInnerReleaseRuntimeIdentity(runtimeIdentity, descriptor) {
    return descriptor ? assertReleaseRuntimeIdentity(runtimeIdentity, descriptor) : runtimeIdentity;
}
