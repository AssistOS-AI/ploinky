import { spawnSync } from 'child_process';

// Image identity of a container runtime: the immutable local ID an image
// reference currently names, and the ID a container was created from. A
// container whose image ID differs from its reference's current local ID runs
// a superseded image (for example after `ploinky update` pulled a newer image
// under the same tag) and is not reused.

const IMAGE_ID_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/;

/** The bare 64-hex image ID, or '' when the value is not an image ID. */
export function normalizeImageId(value) {
    const match = IMAGE_ID_PATTERN.exec(String(value ?? '').trim());
    return match ? match[1] : '';
}

function inspectId(runtime, args) {
    const result = spawnSync(runtime, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30_000,
    });
    if (result.status !== 0 || result.error) return '';
    return normalizeImageId(String(result.stdout || '').split('\n')[0]);
}

/** The local image ID `image` names now, or '' when it has no local copy. */
export function inspectLocalImageId(image, runtime) {
    const reference = String(image || '').trim();
    if (!reference || !runtime) return '';
    return inspectId(runtime, ['image', 'inspect', '--format', '{{.Id}}', reference]);
}

/** The image ID the exact container was created from, or ''. */
export function inspectContainerImageId(containerName, runtime) {
    const name = String(containerName || '').trim();
    if (!name || !runtime) return '';
    return inspectId(runtime, ['container', 'inspect', '--format', '{{.Image}}', name]);
}

/**
 * Reuse decision on image identity: '' when the container runs the image its
 * reference names now, or when either identity is unknown (a reference
 * without a local copy is pulled by the launch path, as before); otherwise a
 * secret-free reason that requires replacement.
 */
export function runtimeImageReuseProblem({ containerImageId, referenceImageId }) {
    const current = normalizeImageId(containerImageId);
    const desired = normalizeImageId(referenceImageId);
    if (!current || !desired || current === desired) return '';
    return `image changed (${current.slice(0, 12)} -> ${desired.slice(0, 12)})`;
}
