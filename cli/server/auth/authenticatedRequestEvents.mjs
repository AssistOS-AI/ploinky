const listeners = new Set();

export function onAuthenticatedRequestDecision(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
}

// Called only after a fresh, full browser-session validation. No request,
// session credential or provider token crosses this observation boundary.
export function publishAuthenticatedRequestDecision(req) {
    const authMode = req?.authMode;
    const userId = req?.user?.id;
    const sourceRoles = req?.user?.roles;
    if (!['local', 'sso'].includes(authMode) || typeof userId !== 'string' || !userId
        || !Array.isArray(sourceRoles)
        || sourceRoles.some(role => typeof role !== 'string')) return false;
    if (req?.session?.expiresAt && Date.now() > Number(req.session.expiresAt)) return false;
    if (authMode === 'local') {
        // The local adapter defaults missing signed roles to ['user']; that
        // projection is not a complete decision about administrator authority.
        const signedRoles = req?.session?._jwtPayload?.usr?.roles;
        if (!Array.isArray(signedRoles) || signedRoles.length !== sourceRoles.length
            || signedRoles.some((role, index) => role !== sourceRoles[index])) return false;
    }
    const roles = Object.freeze(sourceRoles.map(role => role.trim().toLowerCase()));
    if (roles.includes('guest')) return false;
    const decidedAt = authMode === 'local' ? req?.session?.createdAt : Date.now();
    if (!Number.isSafeInteger(decidedAt) || decidedAt <= 0) return false;
    const decision = Object.freeze({ authMode, userId, roles, decidedAt });
    for (const listener of [...listeners]) {
        try { Promise.resolve(listener(decision)).catch(() => {}); } catch (_) { }
    }
    return true;
}
