/**
 * WhitelistPath — pure path rules for the HTTP whitelist (DS014). No I/O, no
 * state: normalization/validation, the internal-route predicate, and the
 * readonly-method predicate. Used by both the matcher and the add/remove commands
 * so write-time and match-time apply identical rules.
 */

const READONLY_METHODS = new Set(['GET', 'HEAD']);
const INTERNAL_EXACT = new Set(['/whitelist/command', '/metrics', '/health/internal']);

export class WhitelistPath {
    static isReadonlyMethod(method) {
        return READONLY_METHODS.has(String(method || '').toUpperCase());
    }

    // A router-owned route that must never be public, checked on the path's
    // "core" (trailing `/*` stripped): `/whitelist/command`, `/auth/*`,
    // `/admin/*`, any `__agent` segment, `/metrics`, `/health/internal`, root.
    static isInternal(path) {
        const raw = String(path || '');
        if (raw === '/*' || raw === '/') return true;
        const core = raw.endsWith('/*') ? (raw.slice(0, -2) || '/') : raw;
        if (core === '/' || core === '') return true;
        if (INTERNAL_EXACT.has(core)) return true;
        if (core === '/auth' || core.startsWith('/auth/')) return true;
        if (core === '/admin' || core.startsWith('/admin/')) return true;
        if (core.split('/').filter(Boolean).includes('__agent')) return true;
        return false;
    }

    /**
     * Normalize + validate a whitelist path. Query is stripped (never decides).
     * With `allowWildcard`, a single trailing `/*` is permitted; any other `*`
     * is rejected. Returns `{ ok, path, isWildcard, prefix }` or `{ error, code }`.
     */
    static normalize(rawPath, { allowWildcard = true } = {}) {
        if (typeof rawPath !== 'string' || !rawPath) {
            return { error: 'path must be a non-empty string', code: 'INVALID_PATH' };
        }
        let value = rawPath;
        const queryIndex = value.indexOf('?');
        if (queryIndex >= 0) {
            value = value.slice(0, queryIndex);
        }
        if (value.includes('#')) return { error: 'fragment not allowed', code: 'INVALID_PATH' };
        if (value.includes('\0')) return { error: 'NUL not allowed', code: 'INVALID_PATH' };
        if (value.includes('\\')) return { error: 'backslash not allowed', code: 'INVALID_PATH' };
        if (/[a-z][a-z0-9+.-]*:\/\//i.test(value)) return { error: 'scheme not allowed', code: 'INVALID_PATH' };
        if (!value.startsWith('/')) return { error: 'path must start with /', code: 'INVALID_PATH' };
        if (/%2f|%5c/i.test(value)) return { error: 'encoded slash/backslash not allowed', code: 'INVALID_PATH' };

        let isWildcard = false;
        let core = value;
        if (value.endsWith('/*')) {
            if (!allowWildcard) return { error: 'wildcard not allowed here', code: 'INVALID_WILDCARD' };
            isWildcard = true;
            core = value.slice(0, -2) || '/';
        }
        if (core.includes('*')) {
            return { error: 'wildcard is only allowed as a trailing /*', code: 'INVALID_WILDCARD' };
        }
        if (core.includes('//')) return { error: 'double slash not allowed', code: 'INVALID_PATH' };
        const segments = core.split('/');
        if (segments.includes('..') || segments.includes('.')) {
            return { error: 'relative path segments not allowed', code: 'INVALID_PATH' };
        }
        if (core === '/') {
            return { error: 'root path cannot be whitelisted', code: 'INVALID_PATH' };
        }
        const path = isWildcard ? `${core}/*` : core;
        return { ok: true, path, isWildcard, prefix: core };
    }
}

export default WhitelistPath;
