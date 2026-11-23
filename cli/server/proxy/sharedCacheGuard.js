const cdnHeaders = new Set(['cloudflare-cdn-cache-control', 'cdn-cache-control', 'surrogate-control']);
const sharedDirectives = new Set(['public', 'private', 's-maxage', 'proxy-revalidate']);
const endToEndCacheHeaders = new Set(['cache-control', 'cloudflare-cdn-cache-control', 'etag', 'last-modified', 'vary']);

function privateCacheControl(value) {
    // A field-qualified private only protects the named fields. Emit one
    // unqualified private and retain the other browser directives verbatim.
    const retained = ['private'];
    let start = 0;
    let quoted = false;
    for (let index = 0; index <= value.length; index++) {
        const char = value[index];
        if (char === undefined || (char === ',' && !quoted)) {
            const directive = value.slice(start, index).trim();
            const name = directive.split('=', 1)[0].trim().toLowerCase();
            if (directive && !sharedDirectives.has(name)) retained.push(directive);
            start = index + 1;
        } else if (char === '"') {
            quoted = !quoted;
        } else if (quoted && char === '\\' && index + 1 < value.length) {
            index++;
        }
    }
    return retained.join(', ');
}

export function guardSharedCache(headers, access) {
    const result = { ...headers };
    const cacheControl = [];
    for (const [key, value] of Object.entries(result)) {
        const name = key.toLowerCase();
        if (cdnHeaders.has(name)) {
            delete result[key];
        } else if (access !== 'public' && name === 'cache-control') {
            cacheControl.push(value);
            delete result[key];
        } else if (name === 'connection') {
            // An intermediary must not consume the Router's cache policy as
            // a hop-by-hop field nominated by the upstream.
            const options = String(value).split(',').map(token => token.trim());
            const kept = options.filter(token => !endToEndCacheHeaders.has(token.toLowerCase()));
            if (!kept.length) delete result[key];
            else if (kept.length !== options.length) result[key] = kept.join(', ');
        }
    }
    if (access !== 'public') {
        result['cache-control'] = privateCacheControl(cacheControl.join(', '));
        result['cloudflare-cdn-cache-control'] = 'no-store';
    }
    return result;
}
