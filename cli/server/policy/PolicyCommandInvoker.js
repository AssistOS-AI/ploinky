import { parseCookies, readJsonBody } from '../handlers/common.js';
import { Caller } from './Caller.js';

// Inlined (matching authHandlers.sendJson) so the policy layer does not pull in
// the heavy authHandlers module just for a 3-line response helper.
function sendJson(res, statusCode, body) {
    const payload = JSON.stringify(body || {});
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(payload);
}

/**
 * PolicyCommandInvoker — the Command-pattern invoker and HTTP adapter for
 * `POST /policy/command` (DS014). Authenticated via the router SSO session
 * cookie; agents (which cannot present a session cookie) are rejected. It builds
 * the CommandContext, looks the command up in the registry, runs authorize then
 * execute, maps the CommandResult to the HTTP response, and writes one audit line.
 *
 * Dependencies (session resolver + admin predicate) are injected so the invoker
 * is testable without real session minting.
 */

export class PolicyCommandInvoker {
    constructor({ registry, auditLog, getSession, cookieName = 'ploinky_sso', isAdminUser }) {
        this._registry = registry;
        this._audit = auditLog;
        this._getSession = getSession;
        this._cookieName = cookieName;
        this._isAdminUser = isAdminUser;
    }

    async handle(req, res) {
        if (String(req.method || '').toUpperCase() !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST is required.' } });
            return true;
        }
        const cookies = parseCookies(req);
        const cookie = cookies.get(this._cookieName) || '';
        const session = cookie ? this._getSession(cookie) : null;
        if (!session || !session.user) {
            sendJson(res, 401, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication is required.' } });
            return true;
        }
        let body = {};
        try {
            body = await readJsonBody(req);
        } catch {
            sendJson(res, 400, { ok: false, error: { code: 'UNKNOWN_COMMAND', message: 'Invalid JSON body.' } });
            return true;
        }
        const user = session.user;
        const actorId = user?.id ? `user:${user.id}` : 'user:unknown';
        const command = this._registry.get(body?.command);
        if (!command) {
            this._audit.record({ user: actorId, command: String(body?.command || ''), ok: false, code: 'UNKNOWN_COMMAND' });
            sendJson(res, 400, { ok: false, error: { code: 'UNKNOWN_COMMAND', message: `Unknown command '${body?.command}'.` } });
            return true;
        }
        const ctx = { command: command.name, body: body || {}, user, isAdmin: this._isAdminUser(user), caller: Caller.fromRequest(req) };
        let result = await command.authorize(ctx);
        if (result.ok) {
            result = await command.execute(ctx);
        }
        if (result.audit) {
            this._audit.record({ user: actorId, command: command.name, ...result.audit, ok: result.ok, code: result.error?.code });
        }
        if (result.ok) {
            sendJson(res, result.status || 200, { ok: true, ...(result.data || {}) });
        } else {
            sendJson(res, result.status || 400, { ok: false, error: result.error });
        }
        return true;
    }
}

export default PolicyCommandInvoker;
