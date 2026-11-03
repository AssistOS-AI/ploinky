// Anonymous registry manifest digest lookup (HEAD, never a pull). Ploinky
// reads no registry credentials; a Bearer token obtained anonymously lives in
// a local variable for one call and is never logged, stored or returned.

const MANIFEST_ACCEPT = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TLS_CODE_PATTERN = new RegExp('^(?:CERT_|ERR_TLS_|ERR_SSL_)|^(?:UNABLE_TO_VERIFY_LEAF_SIGNATURE|'
    + 'SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|EPROTO)$');

export function isTlsClassError(error) {
    const code = String(error?.cause?.code ?? error?.code ?? '');
    return TLS_CODE_PATTERN.test(code);
}

function errorLabel(error) {
    return String(error?.cause?.code ?? error?.code ?? error?.name ?? 'fetch error');
}

// Node honours NODE_USE_ENV_PROXY from 22.21.0 and from 24.
export function nodeHonoursEnvProxy(version = process.versions.node) {
    const [major = 0, minor = 0] = String(version).split('.').map(Number);
    return major >= 24 || (major === 22 && minor >= 21);
}

/** Whether global fetch would bypass a configured proxy, so the engine must be asked instead. */
export function nativeFetchIgnoresProxy(
    env = process.env,
    execArgv = process.execArgv,
    nodeVersion = process.versions.node,
) {
    const proxied = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
        .some((name) => String(env?.[name] || '').trim() !== '');
    if (!proxied) return false;
    if (env?.NODE_USE_ENV_PROXY === '1' && nodeHonoursEnvProxy(nodeVersion)) return false;
    if ((execArgv || []).includes('--use-env-proxy')) return false;
    if (String(env?.NODE_OPTIONS || '').split(/\s+/).includes('--use-env-proxy')) return false;
    return true;
}

function parseBearerChallenge(header) {
    const text = String(header || '').trim();
    const match = /^bearer\s+(.*)$/i.exec(text);
    if (!match) return null;
    const params = {};
    const pattern = /([a-zA-Z_]+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g;
    let item;
    while ((item = pattern.exec(match[1])) !== null) {
        params[item[1].toLowerCase()] = item[2] !== undefined ? item[2] : item[3];
    }
    return params.realm ? params : null;
}

const undetermined = (reason) => ({ status: 'undetermined', reason });
const unavailable = (reason) => ({ status: 'unavailable', reason });

/**
 * @returns {Promise<{status:'ok',digest:string}|{status:'unavailable'|'undetermined',reason:string}>}
 * Never throws.
 */
export async function fetchRemoteManifestDigest(parsed, {
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
    unreachableHosts = new Set(),
} = {}) {
    const host = parsed.apiHost;
    if (unreachableHosts.has(host)) return unavailable(`${host} already unreachable in this run`);
    const url = `https://${host}/v2/${parsed.repository}/manifests/${parsed.tag}`;
    const head = (token) => fetchImpl(url, {
        method: 'HEAD',
        headers: { Accept: MANIFEST_ACCEPT, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
    });
    const classifyResponse = (response) => {
        if (response.status === 200) {
            const digest = String(response.headers?.get?.('docker-content-digest') || '').trim().toLowerCase();
            return DIGEST_PATTERN.test(digest)
                ? { status: 'ok', digest }
                : undetermined('registry answered without a usable Docker-Content-Digest');
        }
        if (response.status === 429 || response.status >= 500) {
            unreachableHosts.add(host);
            return unavailable(`registry answered HTTP ${response.status}`);
        }
        return undetermined(`registry answered HTTP ${response.status}`);
    };
    try {
        let response = await head(null);
        if (response.status !== 401) return classifyResponse(response);
        const challenge = parseBearerChallenge(response.headers?.get?.('www-authenticate'));
        if (!challenge) return undetermined('registry requires an unsupported authentication scheme');
        let tokenUrl;
        try { tokenUrl = new URL(challenge.realm); } catch (_) { return undetermined('token realm is not a URL'); }
        if (tokenUrl.protocol !== 'https:') return undetermined('token realm is not an https URL');
        if (challenge.service) tokenUrl.searchParams.set('service', challenge.service);
        tokenUrl.searchParams.set('scope', challenge.scope || `repository:${parsed.repository}:pull`);
        const tokenResponse = await fetchImpl(tokenUrl.href, { signal: AbortSignal.timeout(timeoutMs) });
        if (tokenResponse.status === 429 || tokenResponse.status >= 500) {
            unreachableHosts.add(host);
            return unavailable(`token service answered HTTP ${tokenResponse.status}`);
        }
        if (tokenResponse.status !== 200) return undetermined(`token service answered HTTP ${tokenResponse.status}`);
        let body = null;
        try { body = await tokenResponse.json(); } catch (_) { body = null; }
        const token = String(body?.token || body?.access_token || '');
        if (!token) return undetermined('token service returned no token');
        response = await head(token);
        return classifyResponse(response);
    } catch (error) {
        if (isTlsClassError(error)) return undetermined(`TLS error (${errorLabel(error)})`);
        unreachableHosts.add(host);
        return unavailable(errorLabel(error));
    }
}
