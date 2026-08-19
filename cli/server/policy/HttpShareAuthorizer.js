import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
import { PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import { buildRouterRequest } from '../mcp-proxy/invocationMinter.js';
import { computeRch } from '../../../Agent/lib/requestHash.mjs';

/**
 * ShareAuthorizer (abstract) + HttpShareAuthorizer (concrete) — deny-by-default
 * bridge for normal-user public sharing (DS016).
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

function readRoutingRoutes() {
    try {
        const file = path.join(PLOINKY_WORKSPACE_ROOT, '.ploinky', 'routing.json');
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed.routes === 'object' ? parsed.routes : {};
    } catch {
        return {};
    }
}

function resolveOwningRoute(agentName) {
    const routes = readRoutingRoutes();
    const route = routes[agentName];
    if (!route || !route.hostPort) return null;
    const repo = String(route.repo || '').trim();
    const agent = String(route.agent || agentName || '').trim();
    if (!repo || !agent) return null;
    let principalId;
    try {
        principalId = deriveAgentPrincipalId(repo, agent);
    } catch {
        return null;
    }
    return { hostPort: route.hostPort, principalId, agent };
}

function postJson(hostPort, requestPath, headers, bodyObject, timeoutMs = 2000) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; resolve(value); } };
        const payload = Buffer.from(JSON.stringify(bodyObject), 'utf8');
        const req = http.request({
            host: '127.0.0.1',
            port: hostPort,
            path: requestPath,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { json = null; }
                done({ status: res.statusCode, json });
            });
        });
        req.on('error', () => done({ status: 0, json: null }));
        req.setTimeout(timeoutMs, () => { req.destroy(); done({ status: 0, json: null }); });
        req.end(payload);
    });
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
            const response = await postJson(owning.hostPort, SHARE_AUTHORIZE_PATH, { authorization: `Bearer ${built.token}` }, bodyObject);
            if (response.status === 200 && response.json && response.json.allowed === true) {
                return { allowed: true, reason: 'agent_approved' };
            }
            return { allowed: false, reason: 'agent_denied' };
        } catch {
            return { allowed: false, reason: 'authorizer_error' };
        }
    }
}

export default HttpShareAuthorizer;
