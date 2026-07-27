export function resolveSessionBindingId(req, fallbackSessionId = '') {
    const signedSessionId = String(req?.session?._jwtPayload?.sid || '').trim();
    if (signedSessionId) return signedSessionId;
    return String(fallbackSessionId || '').trim();
}

export default { resolveSessionBindingId };
