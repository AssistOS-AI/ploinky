/** Docker and Podman report the same immutable SHA-256 ID with different prefixes. */
export function normalizeImageId(value) {
    const imageId = String(value ?? '');
    return imageId && !imageId.startsWith('sha256:') ? `sha256:${imageId}` : imageId;
}

export function isImmutableLocalImageId(value) {
    return typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(value);
}
