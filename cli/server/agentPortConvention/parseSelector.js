export const AGENT_PORT_ROUTE = 'base-agent-additional-server';
const ROUTE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/;
const PCHAR_PERCENT_ENCODING = /%(?:24|26|2B|2C|3A|3B|3D|40)/g;

export class AgentPortSelectorError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'AgentPortSelectorError';
        this.code = code;
        this.status = status;
    }
}

function reject(code, message, status) {
    throw new AgentPortSelectorError(code, message, status);
}

function encodeCanonicalSuffixSegment(value) {
    return encodeURIComponent(value).replace(
        PCHAR_PERCENT_ENCODING,
        encoded => decodeURIComponent(encoded),
    );
}

function decodeCanonicalSegment(raw, label, canonicalize = encodeURIComponent) {
    if (!raw || raw.includes('\\') || /%2f|%5c/i.test(raw)) {
        reject('MALFORMED_SELECTOR', `${label} is not canonical`);
    }
    let decoded;
    try {
        decoded = decodeURIComponent(raw);
    } catch (_) {
        reject('MALFORMED_SELECTOR', `${label} has invalid percent encoding`);
    }
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
        reject('MALFORMED_SELECTOR', `${label} contains a protected separator`);
    }
    if (decoded === '.' || decoded === '..') {
        reject('MALFORMED_SELECTOR', `${label} contains a dot segment`);
    }
    if (canonicalize(decoded) !== raw) {
        reject('NON_CANONICAL_SELECTOR', `${label} does not round-trip canonically`);
    }
    return decoded;
}

function assertNoNestedProtectedEncoding(rawPath) {
    let decoded = rawPath;
    for (let pass = 0; pass < 3; pass += 1) {
        if (/%2f|%5c/i.test(decoded)) {
            reject('MALFORMED_SELECTOR', 'encoded path separators are not allowed');
        }
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) return;
            decoded = next;
        } catch (_) {
            reject('MALFORMED_SELECTOR', 'invalid percent encoding');
        }
    }
    if (/%(?:25)*(?:2f|5c)/i.test(rawPath)) {
        reject('MALFORMED_SELECTOR', 'nested encoded path separators are not allowed');
    }
}

function splitRawTarget(requestTarget) {
    const raw = String(requestTarget || '');
    if (!raw.startsWith('/') || raw.includes('#') || raw.includes('\0') || raw.includes('\\')) {
        reject('MALFORMED_SELECTOR', 'request target must be an origin-form path');
    }
    const queryIndex = raw.indexOf('?');
    return queryIndex < 0
        ? { rawPath: raw, query: '' }
        : { rawPath: raw.slice(0, queryIndex), query: raw.slice(queryIndex + 1) };
}

export function parseAgentPortSelector(requestTarget, { deniedPorts = [] } = {}) {
    const { rawPath, query } = splitRawTarget(requestTarget);
    const prefixPath = `/${AGENT_PORT_ROUTE}`;
    if (rawPath !== prefixPath && !rawPath.startsWith(`${prefixPath}/`)) return null;
    if (rawPath.includes('//')) reject('MALFORMED_SELECTOR', 'empty path segments are not allowed');
    assertNoNestedProtectedEncoding(rawPath);

    const rawSegments = rawPath.slice(1).split('/');
    if (rawSegments.length < 3 || rawSegments[0] !== AGENT_PORT_ROUTE) {
        reject('MALFORMED_SELECTOR', 'convention requires one agent and one port segment');
    }

    const rawAgent = rawSegments[1];
    const agent = decodeCanonicalSegment(rawAgent, 'agent segment');
    if (!ROUTE_KEY_PATTERN.test(agent)) {
        reject('MALFORMED_SELECTOR', 'agent route key is invalid');
    }

    const rawPort = rawSegments[2];
    if (!PORT_PATTERN.test(rawPort)) {
        reject('MALFORMED_SELECTOR', 'port must use canonical decimal grammar');
    }
    const port = Number(rawPort);
    if (port < 1 || port > 65535) {
        reject('MALFORMED_SELECTOR', 'port is outside the valid range');
    }
    const denied = new Set(Array.from(deniedPorts, Number));
    if (denied.has(port)) {
        reject('DENIED_PORT', 'the selected port is runtime-reserved', 403);
    }

    const suffixSegments = rawSegments.slice(3);
    const hasTrailingSlash = suffixSegments.at(-1) === '';
    if (hasTrailingSlash) suffixSegments.pop();
    for (const [index, segment] of suffixSegments.entries()) {
        decodeCanonicalSegment(segment, `suffix segment ${index + 1}`, encodeCanonicalSuffixSegment);
    }
    const suffix = suffixSegments.length
        ? `/${suffixSegments.join('/')}${hasTrailingSlash ? '/' : ''}`
        : '/';
    return Object.freeze({
        convention: AGENT_PORT_ROUTE,
        agent,
        rawAgent,
        port,
        canonicalPort: rawPort,
        suffix,
        query,
        policyPath: rawPath,
        requestTarget: query ? `${rawPath}?${query}` : rawPath,
    });
}

export default parseAgentPortSelector;
