import { hasInternalAgentSegment } from '../internalAgentPath.js';

const READONLY_METHODS = new Set(['GET', 'HEAD']);
const INTERNAL_EXACT = new Set(['/policy/command', '/metrics', '/health', '/health/internal']);

// Router-owned first segments. RoutingServer.isRouterOwnedPath builds on this
// exported set (Task 8) so the dispatch list and the policy write/match-time
// list cannot drift. A policy entry whose first segment is router-owned would
// be dead at enforcement time (the dispatch never evaluates policy for
// router-owned paths) but would still show up in http.route.check/list; an
// audit trap, so it is rejected at the path layer.
export const ROUTER_OWNED_FIRST_SEGMENTS = new Set([
    'agent-card',
    'mcp',
    'auth',
    'admin',
    'webtty',
    'webchat',
    'dashboard',
    'status',
    'upload',
    'blobs',
    'workspace-files',
    'api',
    'health',
    'metrics',
    'MCPBrowserClient.js',
]);

export class HttpRouteAccessPath {
    static isReadOnlyMethod(method) {
        return READONLY_METHODS.has(String(method || '').toUpperCase());
    }

    static isInternal(pathValue) {
        const raw = String(pathValue || '');
        if (raw === '/' || raw === '/*') return true;
        const core = raw.endsWith('/*') ? (raw.slice(0, -2) || '/') : raw;
        if (!core || core === '/') return true;
        if (INTERNAL_EXACT.has(core)) return true;
        if (core === '/auth' || core.startsWith('/auth/')) return true;
        if (core === '/admin' || core.startsWith('/admin/')) return true;
        // Literal AND percent-encoded `__agent` segments (multi-pass decode),
        // matching the current isUnsafeInternalPath behavior in
        // HttpRouteWhitelist.js:21-23. The agent HTTP server decodes the path
        // before routing, so an encoded segment is as dangerous as a literal one.
        if (hasInternalAgentSegment(core)) return true;
        const firstSegment = core.split('/').filter(Boolean)[0] || '';
        if (ROUTER_OWNED_FIRST_SEGMENTS.has(firstSegment)) return true;
        return false;
    }

    static normalize(rawPath, { allowWildcard = true } = {}) {
        if (typeof rawPath !== 'string' || !rawPath.trim()) {
            return { ok: false, error: 'path must be a non-empty string', code: 'INVALID_PATH' };
        }
        let value = rawPath.trim();
        const queryIndex = value.indexOf('?');
        if (queryIndex >= 0) value = value.slice(0, queryIndex);
        if (value.includes('#')) return { ok: false, error: 'fragment not allowed', code: 'INVALID_PATH' };
        if (value.includes('\0')) return { ok: false, error: 'NUL not allowed', code: 'INVALID_PATH' };
        if (value.includes('\\')) return { ok: false, error: 'backslash not allowed', code: 'INVALID_PATH' };
        if (/[a-z][a-z0-9+.-]*:\/\//i.test(value)) return { ok: false, error: 'scheme not allowed', code: 'INVALID_PATH' };
        if (!value.startsWith('/')) return { ok: false, error: 'path must start with /', code: 'INVALID_PATH' };
        if (/%2f|%5c/i.test(value)) return { ok: false, error: 'encoded slash/backslash not allowed', code: 'INVALID_PATH' };

        let isWildcard = false;
        let core = value;
        if (value.endsWith('/*')) {
            if (!allowWildcard) return { ok: false, error: 'wildcard not allowed here', code: 'INVALID_WILDCARD' };
            isWildcard = true;
            core = value.slice(0, -2) || '/';
        }
        if (core.includes('*')) return { ok: false, error: 'wildcard is only allowed as a trailing /*', code: 'INVALID_WILDCARD' };
        if (core.includes('//')) return { ok: false, error: 'double slash not allowed', code: 'INVALID_PATH' };
        const segments = core.split('/');
        if (segments.includes('..') || segments.includes('.')) {
            return { ok: false, error: 'relative path segments not allowed', code: 'INVALID_PATH' };
        }
        const path = isWildcard ? `${core}/*` : core;
        if (this.isInternal(path)) return { ok: false, error: 'internal route path is not policy-controlled', code: 'INTERNAL_ROUTE_NOT_ALLOWED' };
        return { ok: true, path, isWildcard, prefix: core };
    }

    static matches(requestPath, entryPath) {
        if (entryPath.endsWith('/*')) {
            const prefix = entryPath.slice(0, -2);
            return requestPath === prefix || requestPath.startsWith(`${prefix}/`);
        }
        return requestPath === entryPath;
    }

    static routeKeyForPath(pathValue) {
        return String(pathValue || '').split('/').filter(Boolean)[0] || '';
    }
}

export default HttpRouteAccessPath;
