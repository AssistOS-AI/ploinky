import { WhitelistCommand } from './WhitelistCommand.js';
import { WhitelistPath } from '../WhitelistPath.js';

/**
 * The four `http.whitelist.*` commands (DS014). They share the HTTP-whitelist
 * responsibility, so they live together. Each constructor takes only the
 * receivers it needs (`repository`, `whitelist`, `authorizer`) via DI.
 */

function owningAgentForPath(normalizedPath) {
    return normalizedPath.split('/').filter(Boolean)[0] || '';
}

class HttpWhitelistMutationCommand extends WhitelistCommand {
    constructor({ repository, authorizer }) {
        super();
        this._repo = repository;
        this._authorizer = authorizer;
    }

    // Validate the path and check admin-or-share-authorization. Concrete add/remove
    // reuse this; `verb` only tunes the denial message.
    async _authorizeMutation(ctx, verb) {
        const norm = WhitelistPath.normalize(ctx.body?.path);
        if (!norm.ok) {
            return this._fail(400, norm.code || 'INVALID_PATH', 'Invalid path.', { path: ctx.body?.path });
        }
        if (WhitelistPath.isInternal(norm.path)) {
            return this._fail(400, 'INTERNAL_ROUTE_NOT_ALLOWED', 'Internal routes cannot be whitelisted.', { path: norm.path });
        }
        if (!ctx.isAdmin) {
            const authz = await this._authorizer.authorize({ agentName: owningAgentForPath(norm.path), normalizedPath: norm.path, user: ctx.user });
            if (!authz || authz.allowed !== true) {
                return this._fail(403, 'FORBIDDEN', `${verb} this route is not permitted.`, { path: norm.path });
            }
        }
        return { ok: true };
    }
}

export class HttpWhitelistAddCommand extends HttpWhitelistMutationCommand {
    get name() { return 'http.whitelist.add'; }

    async authorize(ctx) {
        return this._authorizeMutation(ctx, 'Publishing');
    }

    async execute(ctx) {
        const norm = WhitelistPath.normalize(ctx.body?.path);
        const actorId = this._actorId(ctx);
        try {
            let existed = false;
            this._repo.mutate((state) => {
                if (state.httpRoutes.some((entry) => entry.path === norm.path)) { existed = true; return state; }
                const now = new Date().toISOString();
                state.httpRoutes.push({ path: norm.path, access: 'public', enabled: true, createdAt: now, createdBy: actorId, updatedAt: now, updatedBy: actorId });
                return state;
            });
            if (existed) return this._fail(409, 'POLICY_ENTRY_EXISTS', 'Route is already whitelisted.', { path: norm.path });
            return this._ok(200, { path: norm.path }, { path: norm.path });
        } catch {
            return this._fail(500, 'POLICY_PERSISTENCE_ERROR', 'Failed to persist policy.', { path: norm.path });
        }
    }
}

export class HttpWhitelistRemoveCommand extends HttpWhitelistMutationCommand {
    get name() { return 'http.whitelist.remove'; }

    async authorize(ctx) {
        return this._authorizeMutation(ctx, 'Removing');
    }

    async execute(ctx) {
        const norm = WhitelistPath.normalize(ctx.body?.path);
        try {
            let found = false;
            this._repo.mutate((state) => {
                const before = state.httpRoutes.length;
                state.httpRoutes = state.httpRoutes.filter((entry) => entry.path !== norm.path);
                found = state.httpRoutes.length < before;
                return state;
            });
            if (!found) return this._fail(404, 'POLICY_ENTRY_NOT_FOUND', 'Route is not whitelisted.', { path: norm.path });
            return this._ok(200, { path: norm.path }, { path: norm.path });
        } catch {
            return this._fail(500, 'POLICY_PERSISTENCE_ERROR', 'Failed to persist policy.', { path: norm.path });
        }
    }
}

export class HttpWhitelistCheckCommand extends WhitelistCommand {
    constructor({ whitelist }) { super(); this._whitelist = whitelist; }
    get name() { return 'http.whitelist.check'; }

    async execute(ctx) {
        const norm = WhitelistPath.normalize(ctx.body?.path, { allowWildcard: false });
        if (!norm.ok) return this._fail(400, norm.code || 'INVALID_PATH', 'Invalid path.', { path: ctx.body?.path });
        return this._ok(200, { path: norm.path, public: this._whitelist.isReachableByGuest(norm.path, 'GET') });
    }
}

export class HttpWhitelistListCommand extends WhitelistCommand {
    constructor({ repository }) { super(); this._repo = repository; }
    get name() { return 'http.whitelist.list'; }

    async execute(_ctx) {
        const { entries, corrupt } = this._repo.listHttpRoutes();
        if (corrupt) return this._fail(500, 'POLICY_PERSISTENCE_ERROR', 'Policy is unavailable.', {});
        return this._ok(200, { httpRoutes: entries });
    }
}
