export class SessionTokenService {
    constructor({
        mintUserSession,
        mintGuestSession,
        verifySessionJwt,
        revokeSession,
        isSessionRevoked,
    } = {}) {
        this.mintUserSession = mintUserSession;
        this.mintGuestSession = mintGuestSession;
        this._verifySessionJwt = verifySessionJwt;
        this.revokeSession = revokeSession;
        this._isSessionRevoked = isSessionRevoked;
    }

    _verified(token) {
        try {
            return this._verifySessionJwt(token);
        } catch {
            return null;
        }
    }

    _isRevoked(payload) {
        return this._isSessionRevoked
            ? this._isSessionRevoked({ sid: payload?.sid, jti: payload?.jti })
            : false;
    }

    _sessionFromPayload(token, payload, { kind = 'user' } = {}) {
        return {
            kind,
            id: token,
            user: payload.usr ? {
                id: payload.usr.id || payload.sub,
                username: payload.usr.username,
                name: payload.usr.name || payload.usr.username,
                email: payload.usr.email || null,
                roles: Array.isArray(payload.usr.roles) ? payload.usr.roles : ['user'],
            } : null,
            createdAt: payload.iat * 1000,
            expiresAt: payload.exp * 1000,
            _jwtPayload: payload,
        };
    }

    async getUserSession(token, options = {}) {
        const payload = this._verified(token);
        if (!payload || payload.typ !== 'user-session' || !payload.usr || this._isRevoked(payload)) {
            return null;
        }
        if (payload.chn !== 'cli' || payload.usr.id !== 'local:admin' || payload.sub !== 'local:admin') return null;
        return this._sessionFromPayload(token, payload, { kind: 'operator' });
    }

    async getGuestSession(token, options = {}) {
        const payload = this._verified(token);
        if (!payload || payload.typ !== 'guest-session' || !payload.usr || this._isRevoked(payload)) {
            return null;
        }
        const expectedRouteKey = String(options?.routeKey || options?.policy?.routeKey || '').trim();
        const payloadRouteKey = String(payload.groute || payload.guestRouteKey || '').trim();
        if (expectedRouteKey && payloadRouteKey !== expectedRouteKey) {
            return null;
        }
        const expectedGuestScope = String(options?.guestScope || options?.policy?.guestScope || '').trim();
        const payloadGuestScope = String(payload.gscope || payload.guestScope || '').trim();
        if (options?.allowAnyGuestScope === true) {
            return payloadGuestScope
                ? this._sessionFromPayload(token, payload, { kind: 'guest' })
                : null;
        }
        if (expectedGuestScope) {
            if (payloadGuestScope !== expectedGuestScope) return null;
        } else if (payloadGuestScope) {
            return null;
        }
        return this._sessionFromPayload(token, payload, { kind: 'guest' });
    }
}
