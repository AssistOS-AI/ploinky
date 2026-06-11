import { PolicyCommand } from './PolicyCommand.js';
import { HttpRouteAccessPath } from '../HttpRouteAccessPath.js';
import { normalizeHttpRouteAccess } from '../HttpRouteAccessDecision.js';

function owningAgentForPath(normalizedPath) {
    return normalizedPath.split('/').filter(Boolean)[0] || '';
}

class HttpRouteMutationCommand extends PolicyCommand {
    constructor({ repository, authorizer }) {
        super();
        this._repo = repository;
        this._authorizer = authorizer;
    }

    // Non-admin mutations go through the share authorizer with the concrete
    // grant: the verb and the access class involved. Under restrictive merge,
    // removal can loosen effective access back to a broader wildcard, so the
    // owning agent must see what is being changed or removed.
    async _authorizeMutation(ctx, verb, access) {
        const norm = HttpRouteAccessPath.normalize(ctx.body?.path);
        if (!norm.ok) return this._fail(400, norm.code || 'INVALID_PATH', 'Invalid path.', { path: ctx.body?.path });
        if (!ctx.isAdmin) {
            const authz = await this._authorizer.authorize({
                agentName: owningAgentForPath(norm.path),
                normalizedPath: norm.path,
                access: String(access || ''),
                verb: String(verb || '').toLowerCase(),
                user: ctx.user,
            });
            if (!authz || authz.allowed !== true) {
                return this._fail(403, 'FORBIDDEN', `${verb} this route is not permitted.`, { path: norm.path, access: String(access || '') });
            }
        }
        return { ok: true };
    }
}

export class HttpRouteSetCommand extends HttpRouteMutationCommand {
    get name() { return 'http.route.set'; }

    async authorize(ctx) {
        const access = normalizeHttpRouteAccess(ctx.body?.access);
        if (!access) return this._fail(400, 'INVALID_ACCESS', 'access must be public, guest, or authenticated.', { path: ctx.body?.path });
        return this._authorizeMutation(ctx, 'Changing', access);
    }

    async execute(ctx) {
        const norm = HttpRouteAccessPath.normalize(ctx.body?.path);
        const access = normalizeHttpRouteAccess(ctx.body?.access);
        if (!access) return this._fail(400, 'INVALID_ACCESS', 'access must be public, guest, or authenticated.', { path: norm.path });
        const actorId = this._actorId(ctx);
        const now = new Date().toISOString();
        try {
            this._repo.mutate((state) => {
                const existing = state.httpRoutes.find((entry) => entry.path === norm.path);
                if (existing) {
                    existing.access = access;
                    existing.enabled = ctx.body?.enabled !== false;
                    existing.updatedAt = now;
                    existing.updatedBy = actorId;
                    return state;
                }
                state.httpRoutes.push({
                    path: norm.path,
                    access,
                    enabled: ctx.body?.enabled !== false,
                    createdAt: now,
                    createdBy: actorId,
                    updatedAt: now,
                    updatedBy: actorId,
                });
                return state;
            });
            return this._ok(200, { path: norm.path, access }, { path: norm.path, access });
        } catch {
            return this._fail(500, 'POLICY_PERSISTENCE_ERROR', 'Failed to persist policy.', { path: norm.path });
        }
    }
}

export class HttpRouteRemoveCommand extends HttpRouteMutationCommand {
    get name() { return 'http.route.remove'; }

    async authorize(ctx) {
        const norm = HttpRouteAccessPath.normalize(ctx.body?.path);
        if (!norm.ok) return this._fail(400, norm.code || 'INVALID_PATH', 'Invalid path.', { path: ctx.body?.path });
        const existing = this._repo.getHttpRouteEntry(norm.path);
        if (existing?.corrupt) return this._fail(500, 'POLICY_PERSISTENCE_ERROR', 'Policy is unavailable.', { path: norm.path });
        return this._authorizeMutation(ctx, 'Removing', existing?.access || '');
    }

    async execute(ctx) {
        const norm = HttpRouteAccessPath.normalize(ctx.body?.path);
        try {
            let found = false;
            this._repo.mutate((state) => {
                const before = state.httpRoutes.length;
                state.httpRoutes = state.httpRoutes.filter((entry) => entry.path !== norm.path);
                found = state.httpRoutes.length < before;
                return state;
            });
            if (!found) return this._fail(404, 'POLICY_ENTRY_NOT_FOUND', 'Route policy entry was not found.', { path: norm.path });
            return this._ok(200, { path: norm.path }, { path: norm.path });
        } catch {
            return this._fail(500, 'POLICY_PERSISTENCE_ERROR', 'Failed to persist policy.', { path: norm.path });
        }
    }
}

export class HttpRouteCheckCommand extends PolicyCommand {
    constructor({ routeAccessPolicy }) {
        super();
        this._routeAccessPolicy = routeAccessPolicy;
    }

    get name() { return 'http.route.check'; }

    async execute(ctx) {
        const norm = HttpRouteAccessPath.normalize(ctx.body?.path, { allowWildcard: false });
        if (!norm.ok) return this._fail(400, norm.code || 'INVALID_PATH', 'Invalid path.', { path: ctx.body?.path });
        const method = String(ctx.body?.method || 'GET').toUpperCase();
        const decision = this._routeAccessPolicy.evaluate({ pathname: norm.path, method });
        return this._ok(200, { path: norm.path, method, decision });
    }
}

export class HttpRouteListCommand extends PolicyCommand {
    constructor({ repository }) {
        super();
        this._repo = repository;
    }

    get name() { return 'http.route.list'; }

    async execute() {
        const { entries, corrupt } = this._repo.listHttpRoutes();
        if (corrupt) return this._fail(500, 'POLICY_PERSISTENCE_ERROR', 'Policy is unavailable.', {});
        return this._ok(200, { httpRoutes: entries });
    }
}
