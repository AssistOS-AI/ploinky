function headerFields(headers, name) {
    return Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
}

function combinedHeader(headers, name) {
    const fields = headerFields(headers, name);
    if (fields.length) return fields.flatMap(([, value]) => value).join(', ');
}

export function requestHasCredential(req) {
    return Object.keys(req.headers).some(key => {
        const name = key.toLowerCase();
        return name === 'cookie' || name === 'authorization';
    });
}

export function decideAgentAnswer({
    access, cacheClass, application, method, requestHasCredential, status,
    headers, routerQueuedSetCookie, isStream,
}) {
    if (access !== 'public') return { cdnCacheControl: 'no-store' };
    if (headers === null || typeof headers !== 'object'
        || (Object.getPrototypeOf(headers) !== Object.prototype && Object.getPrototypeOf(headers) !== null)) {
        return { cdnCacheControl: 'no-store' };
    }

    const cacheControl = combinedHeader(headers, 'cache-control');
    const bypass = { cacheControl, cdnCacheControl: 'no-store', removeValidators: false };
    if ((cacheClass !== 'page' && cacheClass !== 'immutable')
        || application?.enabled !== true || (cacheClass === 'page' && application.held !== false)
        || (method !== 'GET' && method !== 'HEAD') || status !== 200
        || requestHasCredential !== false || routerQueuedSetCookie !== false || isStream !== false
        || headerFields(headers, 'set-cookie').length) return bypass;

    const vary = combinedHeader(headers, 'vary') || '';
    if (vary.split(',').some(value => value.trim() && value.trim().toLowerCase() !== 'accept-encoding')) return bypass;
    const contentType = combinedHeader(headers, 'content-type') || '';
    if (/(?:^|,)\s*text\/event-stream\s*(?:[;,]|$)/i.test(contentType)) return bypass;
    // A quoted extension value may contain commas and directive names.
    const directives = (cacheControl || '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
    if (/(?:^|,)\s*(?:private|no-store)\s*(?:[=,]|$)/i.test(directives)) return bypass;

    if (cacheClass === 'immutable') {
        return {
            cacheControl: 'public, max-age=31536000, immutable',
            cdnCacheControl: 'max-age=31536000',
            removeValidators: true,
        };
    }
    if (![60, 120, 300].includes(application.pageSeconds)) return bypass;
    return {
        cacheControl: cacheControl ?? 'no-cache',
        cdnCacheControl: `max-age=${application.pageSeconds}, stale-if-error=900`,
        removeValidators: true,
    };
}
