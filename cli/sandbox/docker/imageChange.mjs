import { spawnSync } from 'node:child_process';
import { hashMismatchDetail } from '../runtimeReplacementLog.js';
import { containerToolchainIdentity, normalizeImageId } from '../../utils/dependencies/store/installContract.mjs';

// The immutable ID an existing container runs, or null when it cannot be read.
// Podman prints bare hex and Docker prefixes sha256:; normalizeImageId accepts both.
export function readRuntimeContainerImageId(runtime, containerName, spawn = spawnSync) {
    try {
        const result = spawn(runtime, ['container', 'inspect', '--format', '{{.Image}}', containerName], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
        });
        if (result.error || result.status !== 0) return null;
        return normalizeImageId(String(result.stdout || '').trim().split('\n')[0]);
    } catch (_) {
        return null;
    }
}

// The normalized ID an image reference resolves to locally, or null.
export function readLocalImageId(runtime, image) {
    try {
        return containerToolchainIdentity({ runtime, image }).identity.imageId;
    } catch (_) {
        return null;
    }
}

/**
 * Whether an existing managed container runs a different image than its
 * reference resolves to locally now (a re-pulled tag). Null when equal or
 * when either side is unknown: uncertainty never forces a replacement.
 */
export function containerImageChange({ runtime, containerName, imageRef }, {
    readContainerImageId = readRuntimeContainerImageId,
    readImageId = readLocalImageId,
} = {}) {
    const ref = String(imageRef || '').trim();
    if (!ref || !containerName || (runtime !== 'podman' && runtime !== 'docker')) return null;
    const observed = readContainerImageId(runtime, containerName);
    const desired = observed ? readImageId(runtime, ref) : null;
    if (!observed || !desired || observed === desired) return null;
    return Object.freeze({ observed, desired });
}

/** The reference an agent runs: its catalog image, else the resolved manifest image ('' when unresolvable). */
export function desiredImageRef(catalogIdentity, resolveManifestImageRef) {
    const catalogRef = String(catalogIdentity?.imageRef || '').trim();
    if (catalogRef) return catalogRef;
    try {
        return String(resolveManifestImageRef() || '').trim();
    } catch (_) {
        return '';
    }
}

/** The replacement-log detail of an image change: first 12 hex digits of the old and new ID. */
export function imageChangeDetail({ observed, desired }) {
    return hashMismatchDetail('image', observed.replace(/^sha256:/, ''), desired.replace(/^sha256:/, ''));
}
