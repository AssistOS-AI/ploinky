import { createHash } from 'node:crypto';
import { resolveSessionBindingId } from '../sessionBinding.js';

// Only the authentication admission path may mark an explicitly public target.
// A missing identity or an unknown route never implies anonymous authority.
const publicAdmissions = new WeakMap();

export function admitPublicMcpTarget(req, target) {
    if (typeof target === 'string' && target) publicAdmissions.set(req, target);
}

export function readMcpSessionHeader(req) {
    const value = req.headers?.['mcp-session-id'];
    const raw = req.rawHeaders || [];
    let count = 0;
    for (let i = 0; i < raw.length; i += 2) {
        if (String(raw[i]).toLowerCase() === 'mcp-session-id') count += 1;
    }
    const supplied = value !== undefined || count > 0;
    const valid = !supplied || (count <= 1 && typeof value === 'string'
        && value.length > 0 && !/[\s,]/.test(value));
    return { supplied, valid, id: supplied && valid ? value : null };
}

export function createMcpSessionOwner(req, surface, target = '') {
    if (req.agent || req.delegatedAgentVerified) return null;
    const mode = req.authMode;
    const userId = req.user?.id;
    const binding = resolveSessionBindingId(req, req.sessionId);
    if (['sso', 'local', 'guest'].includes(mode)
        && typeof userId === 'string' && userId.trim() && binding) {
        return Object.freeze({
            kind: mode === 'guest' ? 'guest' : 'authenticated',
            mode, userId, channel: req.authChannel || 'browser', surface, target,
            binding: createHash('sha256').update('mcp-browser-session\0').update(mode)
                .update('\0').update(binding).digest('base64url'),
        });
    }
    if (req.user || req.session || req.sessionId || mode) return null;
    const publicTarget = publicAdmissions.get(req);
    if (!publicTarget || (surface === 'agent' && publicTarget !== target)) return null;
    return Object.freeze({ kind: 'public-none', surface, target: publicTarget });
}

export function matchesMcpSessionOwner(entry, owner) {
    if (!entry?.owner || !owner) return false;
    const keys = ['kind', 'surface', 'target', 'mode', 'userId', 'channel', 'binding'];
    return keys.every(key => entry.owner[key] === owner[key]);
}

export function inspectMcpSession(store, req, owner) {
    const header = readMcpSessionHeader(req);
    const entry = header.id ? store.get(header.id) : null;
    const owned = matchesMcpSessionOwner(entry, owner);
    return { ...header, entry: owned ? entry : null,
        refused: !header.valid || Boolean(entry && !owned) };
}
