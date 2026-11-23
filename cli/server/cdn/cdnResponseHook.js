const CDN_HEADER = 'Cloudflare-CDN-Cache-Control';
const cdnDecisions = new WeakMap();
const keepPublicStatic = Symbol('Router public static response');

export function markCdnDecision(res, value) {
    cdnDecisions.set(res, value);
}

export function markCdnKeep(res) {
    cdnDecisions.set(res, keepPublicStatic);
}

function hasExplicitCookie(headers) {
    if (Array.isArray(headers)) {
        return headers.some((name, index) => index % 2 === 0 && name.toLowerCase() === 'set-cookie');
    }
    return Object.keys(headers ?? {}).some(name => name.toLowerCase() === 'set-cookie');
}

// Explicit writeHead fields take precedence over setHeader. Replace every
// spelling of the field there, preserving unrelated duplicates (e.g. cookies).
function withCdnHeader(headers, value) {
    if (Array.isArray(headers)) {
        const result = [];
        for (let i = 0; i < headers.length; i += 2) {
            if (headers[i].toLowerCase() !== CDN_HEADER.toLowerCase()) {
                result.push(headers[i], headers[i + 1]);
            }
        }
        result.push(CDN_HEADER, value);
        return result;
    }
    const result = { ...headers };
    for (const name of Object.keys(result)) {
        if (name.toLowerCase() === CDN_HEADER.toLowerCase()) delete result[name];
    }
    result[CDN_HEADER] = value;
    return result;
}

export function installCdnResponseHook(_req, res) {
    const writeHead = res.writeHead;
    res.writeHead = function (status, reason, headers) {
        const decision = cdnDecisions.get(this);
        // A failed writeHead can be followed by a Router-generated error.
        // A retry must make its own decision for that answer.
        if (decision != null) cdnDecisions.delete(this);
        const fields = typeof reason === 'string' ? headers : headers ?? reason;
        let value = 'no-store';
        if (decision != null && this.getHeader('set-cookie') === undefined && !hasExplicitCookie(fields)) {
            if (decision === keepPublicStatic) {
                if (status >= 200 && status < 300) return writeHead.apply(this, arguments);
            } else if (status === 200) {
                value = decision;
            }
        }
        if (typeof reason === 'string') {
            return writeHead.call(this, status, reason, withCdnHeader(headers, value));
        }
        return writeHead.call(this, status, withCdnHeader(headers ?? reason, value));
    };
}
