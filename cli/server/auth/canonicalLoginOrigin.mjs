const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function validateCanonicalLoginOrigin({ canonicalLoginOrigin, baseUrl, redirectUri }) {
    try {
        if (typeof canonicalLoginOrigin !== 'string' || typeof baseUrl !== 'string') throw new Error();
        const target = new URL(canonicalLoginOrigin);
        const source = new URL(baseUrl);
        const callback = new URL(redirectUri);
        // Exact origins reject URL parser normalization, credentials, control
        // characters, paths, and provider-supplied query parameters.
        if (target.origin !== canonicalLoginOrigin || source.origin !== baseUrl
            || !LOOPBACK_HOSTS.has(source.hostname) || !LOOPBACK_HOSTS.has(target.hostname)
            || !['http:', 'https:'].includes(source.protocol)
            || source.protocol !== target.protocol || source.port !== target.port
            || source.origin === target.origin || callback.origin !== source.origin) {
            throw new Error();
        }
        return target.origin;
    } catch {
        throw new Error('Invalid canonical login origin');
    }
}
