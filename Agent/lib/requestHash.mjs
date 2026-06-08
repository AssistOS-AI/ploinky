import crypto from 'node:crypto';

/**
 * requestHash.mjs — shared request-content-hash (`rch`) implementation.
 *
 * The router signs `rch` into every internal JWT and the agent recomputes it
 * from the request it actually received; any divergence is rejected. Router and
 * agent therefore MUST hash with the exact same code, so this module is the one
 * implementation both sides import.
 *
 * It lives under `Agent/lib/` (not in achillesAgentLib) on purpose: the whole
 * `Agent/` tree is mounted into every agent container, whereas the container's
 * `achillesAgentLib` is an independently npm-installed upstream copy. Keeping
 * this self-contained (only `node:crypto`) guarantees router and agent run the
 * identical implementation.
 *
 * `canonicalJson` here is intentionally STRICTER than the lenient one in
 * `jwtSign.mjs`: that one coerces `undefined` to `null`, which would let two
 * different request shapes collapse to the same hash. A request hash must be
 * unambiguous, so `undefined`, functions, symbols, bigints, and non-finite
 * numbers throw rather than being silently dropped or coerced.
 */

export function canonicalJson(value) {
    const valueType = typeof value;
    if (value === undefined || valueType === 'function' || valueType === 'symbol') {
        throw new Error('canonicalJson: undefined, function, and symbol values are not allowed');
    }
    if (value === null) {
        return 'null';
    }
    if (valueType === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('canonicalJson: non-finite numbers are not allowed');
        }
        return JSON.stringify(value);
    }
    if (valueType === 'boolean' || valueType === 'string') {
        return JSON.stringify(value);
    }
    if (valueType === 'bigint') {
        throw new Error('canonicalJson: bigint values are not allowed');
    }
    if (Array.isArray(value)) {
        // Array order is significant and preserved; holes/`undefined` entries throw.
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
    }
    if (valueType === 'object') {
        // Object key order is NOT significant: keys are sorted lexicographically
        // so `{a,b}` and `{b,a}` hash identically.
        const keys = Object.keys(value).sort();
        const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
        return `{${parts.join(',')}}`;
    }
    throw new Error(`canonicalJson: unsupported value type ${valueType}`);
}

export function sha256b64url(input) {
    return crypto.createHash('sha256').update(String(input), 'utf8').digest('base64url');
}

export function sha256RawBodyHash(body = Buffer.alloc(0)) {
    const bytes = Buffer.isBuffer(body)
        ? body
        : Buffer.from(body === undefined || body === null ? '' : body);
    return crypto.createHash('sha256').update(bytes).digest('base64url');
}

// Generic entry point: hash the canonical JSON of an already-assembled input.
export function computeRch(input) {
    return sha256b64url(canonicalJson(input));
}

// HTTP surface. `bodyHash` is base64url(sha256(rawBodyBytes)) computed by the
// caller; the query string participates in the signed surface but is otherwise
// opaque (it never decides HTTP whitelist access — that is a separate concern).
export function computeRchHttp({ method, path, query, bodyHash }) {
    return computeRch({
        method: String(method ?? ''),
        path: String(path ?? ''),
        query: query === undefined || query === null ? '' : String(query),
        bodyHash: String(bodyHash ?? ''),
    });
}

// MCP tool-call surface. `args` MUST already be canonicalized against the
// tool's advertised inputSchema (unknown keys stripped) by the proxy, so the
// signed surface equals exactly what the agent will execute.
export function computeRchTool({ method, path, tool, arguments: args }) {
    return computeRch({
        method: String(method ?? ''),
        path: String(path ?? ''),
        tool: String(tool ?? ''),
        arguments: args === undefined || args === null ? {} : args,
    });
}

export default {
    canonicalJson,
    sha256b64url,
    sha256RawBodyHash,
    computeRch,
    computeRchHttp,
    computeRchTool,
};
