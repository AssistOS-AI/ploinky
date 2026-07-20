import { sendJson } from './authHandlers/index.js';
import { readJsonBody } from './handlers/common.js';
import { Caller } from './policy/Caller.js';
import { buildUserApiKeyResult } from './security/userIdentityKey.js';
import { SubjectIdentityKeyError } from '../utils/security/subjectIdentityKey.js';

// Router-owned endpoint: POST /api/router/identity/user-api-key
//
// Mints a router-signed user identity key (`user:<id>|<signature>`) for
// the authenticated caller. Ploinky owns the private signing key, so this lives
// in the router. The handler is a thin wrapper: it trusts
// `req.user` (populated upstream by ensureAuthenticated), parses the JSON body,
// derives admin status from the canonical Caller convention, delegates the
// privilege decision + signing to the pure buildUserApiKeyResult, and serializes
// the result. All key logic — including the no-horizontal-escalation rule — lives
// in the pure function so it stays unit-testable.

export const USER_IDENTITY_KEY_PATH = '/api/router/identity/user-api-key';

export async function handleUserIdentityKeyRoute(req, res, parsedUrl) {
    const pathname = parsedUrl?.pathname || '';
    if (pathname !== USER_IDENTITY_KEY_PATH) {
        return false;
    }

    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
        res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
        return true;
    }

    // Only an authenticated, non-guest user may mint a user key. A guest session
    // does not satisfy authenticated route access (DS005), and anonymous callers
    // never reach a populated req.user — both resolve to a non-'user' Caller kind,
    // so this single check is the authoritative 401 for them. (An agent principal
    // already carries its own signed key from agent env injection and has no
    // business minting a user key here.)
    const caller = Caller.fromRequest(req);
    if (caller.kind !== 'user') {
        sendJson(res, 401, { ok: false, error: 'not_authenticated' });
        return true;
    }

    let body = {};
    try {
        body = await readJsonBody(req);
    } catch (_) {
        sendJson(res, 400, { ok: false, error: 'invalid_json', message: 'Request body must be valid JSON.' });
        return true;
    }

    // Admin status comes from the same canonical Caller convention used by
    // MCP/policy routing (roles include admin, or the local admin id/username;
    // never a guest). A non-admin's body userId is ignored by buildUserApiKeyResult.
    const requestedUserId = body && typeof body === 'object' ? body.userId : undefined;

    try {
        const result = buildUserApiKeyResult({
            sessionUser: req.user,
            requestedUserId,
            isAdmin: caller.isAdmin === true,
        });
        sendJson(res, 200, {
            subjectId: result.subjectId,
            apiKey: result.apiKey,
            publicKey: result.publicKey,
        });
        return true;
    } catch (error) {
        // Match by the typed `code` (the primitive's documented contract) rather
        // than only `instanceof`: that stays correct even if the key primitive is
        // resolved through a second module copy, where the class identity differs.
        const isInvalidSubject = error?.code === 'INVALID_SUBJECT'
            || (error instanceof SubjectIdentityKeyError && error.code === 'INVALID_SUBJECT');
        if (isInvalidSubject) {
            sendJson(res, 400, {
                ok: false,
                error: 'invalid_user_id',
                message: 'userId must match [A-Za-z0-9._:-]+ with no slash, pipe, whitespace, or empty value.',
            });
            return true;
        }
        sendJson(res, 500, { ok: false, error: 'user_api_key_failed' });
        return true;
    }
}

export default handleUserIdentityKeyRoute;
