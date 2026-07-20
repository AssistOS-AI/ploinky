import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
import { buildRouterRequest } from '../mcp-proxy/invocationMinter.js';
import { computeRch } from '../../../Agent/lib/requestHash.mjs';
import { getActiveGenerationRoutes } from '../generation/runtimeContext.js';
import { relayHttpCall } from '../proxy/relayHttpCall.js';

/**
 * ShareAuthorizer (abstract) + HttpShareAuthorizer (concrete) — deny-by-default
 * bridge for normal-user public sharing (DS014).
 *
 * The router cannot infer resource ownership from a path, so a normal user may
 * publish a route only if the OWNING agent affirmatively approves it via
 * `POST /<agent>/__agent/public-route-share/authorize` (a router-request
 * authenticated control-plane call). Absent, unreachable, or non-affirmative ⇒
 * deny. The full publish UX is deferred (plan Phase 8); this is only the bridge.
 *
 * Both classes live here (rather than a separate `ShareAuthorizer.js`) because a
 * case-insensitive filesystem cannot hold both that and the legacy
 * `shareAuthorizer.js` during the refactor.
 */

const SHARE_AUTHORIZE_PATH = '/__agent/public-route-share/authorize';
const SHARE_TOOL = '__public_route_share__';

export class ShareAuthorizer {
    // Returns Promise<{ allowed: boolean, reason: string }>. Deny by default.
    async authorize(_ctx) {
        return { allowed: false, reason: 'not_implemented' };
    }
}

function resolveOwningRoute(agentName) {
    const routes = getActiveGenerationRoutes();
    const route = routes[agentName];
    if (!route?.relay || !route?.primaryService) return null;
    const repo = String(route.repo || '').trim();
    const agent = String(route.agent || agentName || '').trim();
    if (!repo || !agent) return null;
    let principalId;
    try {
        principalId = deriveAgentPrincipalId(repo, agent);
    } catch {
        return null;
    }
    return { routeKey: agentName, principalId, agent };
}

export class HttpShareAuthorizer extends ShareAuthorizer {
    async authorize({ agentName, normalizedPath, access = '', verb = '', user }) {
        const owning = resolveOwningRoute(agentName);
        if (!owning) {
            return { allowed: false, reason: 'no_authorizer' };
        }
        try {
            const bodyObject = {
                path: normalizedPath,
                access: String(access || ''),
                verb: String(verb || ''),
                user: { id: String(user?.id || ''), username: String(user?.username || '') },
            };
            const built = buildRouterRequest({
                targetAgentId: owning.principalId,
                sub: user?.id ? `user:${user.id}` : '',
                actor: { kind: 'user', id: user?.id ? `user:${user.id}` : '', roles: Array.isArray(user?.roles) ? user.roles : [] },
                method: 'POST',
                path: SHARE_AUTHORIZE_PATH,
                tool: SHARE_TOOL,
                rch: computeRch(bodyObject),
            });
            const response = await relayHttpCall({
                routeKey: owning.routeKey,
                method: 'POST',
                target: SHARE_AUTHORIZE_PATH,
                timeoutMs: 2_000,
                headers: { authorization: `Bearer ${built.token}`, 'content-type': 'application/json' },
                body: Buffer.from(JSON.stringify(bodyObject), 'utf8'),
            });
            let payload = null;
            try { payload = JSON.parse(response.body.toString('utf8') || '{}'); } catch (_) {}
            if (response.statusCode === 200 && payload?.allowed === true) {
                return { allowed: true, reason: 'agent_approved' };
            }
            return { allowed: false, reason: 'agent_denied' };
        } catch {
            return { allowed: false, reason: 'authorizer_error' };
        }
    }
}

export default HttpShareAuthorizer;
