// Container image reference parsing for the registry refresh check.
// Pure functions: no I/O, no engine access.

const DIGEST_PATTERN = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[0-9a-fA-F]{32,}$/;
const DOCKER_HUB = 'docker.io';
const DOCKER_HUB_API_HOST = 'registry-1.docker.io';

/**
 * Parse an image reference. Returns null for an empty ref, a ref containing
 * whitespace, or an uppercase repository path (not a valid reference).
 */
export function parseImageReference(ref) {
    const text = String(ref ?? '');
    if (!text || /\s/.test(text)) return null;
    const at = text.indexOf('@');
    const name = at === -1 ? text : text.slice(0, at);
    const digest = at === -1 ? '' : text.slice(at + 1);
    if (!name || (at !== -1 && !digest)) return null;
    const pinned = DIGEST_PATTERN.test(digest);

    const segments = name.split('/');
    const first = segments[0];
    const hasHost = segments.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
    let registry = DOCKER_HUB;
    let rest = name;
    if (hasHost) {
        registry = first.toLowerCase();
        rest = segments.slice(1).join('/');
    }
    if (registry === 'index.docker.io') registry = DOCKER_HUB;

    let repository = rest;
    let tag = 'latest';
    const lastSlash = rest.lastIndexOf('/');
    const colon = rest.lastIndexOf(':');
    if (colon > lastSlash) {
        repository = rest.slice(0, colon);
        tag = rest.slice(colon + 1);
    }
    if (!repository || !tag || repository !== repository.toLowerCase()) return null;
    if (registry === DOCKER_HUB && !repository.includes('/')) repository = `library/${repository}`;

    const apiHost = registry === DOCKER_HUB ? DOCKER_HUB_API_HOST : registry;
    const canonical = `${registry}/${repository}${digest ? '' : `:${tag}`}${digest ? `@${digest}` : ''}`;
    return Object.freeze({
        registry,
        apiHost,
        repository,
        tag,
        digest,
        pinned,
        explicitRegistry: hasHost,
        canonical,
    });
}

/**
 * The manifest digests an image's RepoDigests list holds for the repository of
 * `parsed`. Docker lists `assistos/x@sha256:...`, Podman lists the qualified
 * form; both normalize through parseImageReference.
 */
export function repoDigestSet(repoDigests, parsed) {
    const result = new Set();
    if (!Array.isArray(repoDigests) || !parsed) return result;
    for (const entry of repoDigests) {
        const candidate = parseImageReference(entry);
        if (!candidate?.digest) continue;
        if (candidate.registry === parsed.registry && candidate.repository === parsed.repository) {
            result.add(candidate.digest);
        }
    }
    return result;
}
