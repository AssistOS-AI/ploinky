import { WhitelistPath } from './WhitelistPath.js';

/**
 * HttpRouteWhitelist — the read-only public whitelist decision (DS014): may a
 * guest reach this HTTP route without authentication? Decisions are path-based;
 * the query string never participates. Internal routes are never reachable, even
 * if a corrupted state file or a broad wildcard entry would otherwise cover them.
 * Fails closed on a corrupt policy file. Reads entries from an injected repository.
 */
export class HttpRouteWhitelist {
    constructor({ repository }) {
        this._repo = repository;
    }

    isReachableByGuest(requestPath, method) {
        if (!WhitelistPath.isReadonlyMethod(method)) return false;
        const norm = WhitelistPath.normalize(requestPath, { allowWildcard: false });
        if (!norm.ok) return false;
        // The concrete request path must not itself be an internal route.
        if (WhitelistPath.isInternal(norm.path)) return false;
        const { entries, corrupt } = this._repo.listHttpRoutes();
        if (corrupt) return false;
        for (const entry of entries) {
            if (!entry || entry.enabled === false || typeof entry.path !== 'string') continue;
            if (WhitelistPath.isInternal(entry.path)) continue;
            if (this._matches(norm.path, entry.path)) return true;
        }
        return false;
    }

    _matches(requestPath, entryPath) {
        if (entryPath.endsWith('/*')) {
            const prefix = entryPath.slice(0, -2);
            if (!prefix) return false;
            return requestPath === prefix || requestPath.startsWith(`${prefix}/`);
        }
        return requestPath === entryPath;
    }
}

export default HttpRouteWhitelist;
