function authorityError(message, status = 400, code = 'INVALID_AUTHORITY') {
    return Object.assign(new Error(`routingAuthority: ${message}`), { status, code });
}

export function normalizeAuthority(value, label = 'request') {
    const raw = String(value || '').trim();
    if (!raw || raw.endsWith(':') || /[\s\\/@?#,]/.test(raw)) {
        throw authorityError(`invalid ${label} authority`);
    }
    let parsed;
    try {
        parsed = new URL(`http://${raw}/`);
    } catch (_) {
        throw authorityError(`invalid ${label} authority`);
    }
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.hostname) {
        throw authorityError(`invalid ${label} authority`);
    }
    return parsed.host.toLowerCase();
}

function hostHeaderValues(req) {
    const rawHeaders = Array.isArray(req?.rawHeaders) ? req.rawHeaders : [];
    const values = [];
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
        if (String(rawHeaders[index]).toLowerCase() === 'host') values.push(String(rawHeaders[index + 1]));
    }
    if (values.length) return values;
    const header = req?.headers?.host;
    if (Array.isArray(header)) return header.map(String);
    return header === undefined ? [] : [String(header)];
}

function normalizeRequestTarget(rawTarget, authority, scheme) {
    const target = String(rawTarget || '');
    const absolute = target.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)(\/[^#]*)?$/);
    if (absolute) {
        const targetScheme = absolute[1].toLowerCase();
        if (targetScheme !== scheme) throw authorityError('absolute-form scheme conflicts with listener');
        if (normalizeAuthority(absolute[2], 'absolute-form') !== authority) {
            throw authorityError('absolute-form authority conflicts with Host');
        }
        return absolute[3] || '/';
    }
    if (!target.startsWith('/') || target.startsWith('//') || target.includes('#')) {
        throw authorityError('unsupported request-target form');
    }
    return target;
}

export function classifyRequestAuthority(req, {
    expectedAuthority,
    scheme = 'http',
} = {}) {
    const values = hostHeaderValues(req);
    if (values.length !== 1) throw authorityError('exactly one Host header is required');
    const authority = normalizeAuthority(values[0]);
    if (expectedAuthority !== undefined && authority !== normalizeAuthority(expectedAuthority, 'configured')) {
        throw authorityError('authority is not active on this listener', 404, 'UNKNOWN_AUTHORITY');
    }
    return {
        authority,
        requestTarget: normalizeRequestTarget(req?.url, authority, String(scheme || 'http').toLowerCase()),
    };
}

export default normalizeAuthority;
