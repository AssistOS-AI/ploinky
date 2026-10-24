import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WEBTTY_PROTOCOL_LIMITS } from '../../../core-services/webtty/worker-protocol.mjs';
import { isAdminUser } from '../auth/localService.js';
import { verifyBrowserMutationRequest } from '../browserMutationSecurity.js';
import { commitRouteGeneration } from '../edgeRoutePlan.js';
import { validateHomeProfileRequest } from '../webtty/homeProfileProvider.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBTTY_ROOT = path.resolve(__dirname, '../webtty');
const ASSETS = Object.freeze({
    'webtty.css': { path: path.join(WEBTTY_ROOT, 'webtty.css'), type: 'text/css; charset=utf-8' },
    'webtty-bootstrap.js': { path: path.join(WEBTTY_ROOT, 'webtty-bootstrap.js'), type: 'application/javascript; charset=utf-8' },
    'webtty.js': { path: path.join(WEBTTY_ROOT, 'webtty.js'), type: 'application/javascript; charset=utf-8' },
    'xterm.css': { path: path.join(WEBTTY_ROOT, 'vendor/xterm.css'), type: 'text/css; charset=utf-8' },
    'xterm.js': { path: path.join(WEBTTY_ROOT, 'vendor/xterm.js'), type: 'application/javascript; charset=utf-8' },
    'addon-fit.js': { path: path.join(WEBTTY_ROOT, 'vendor/addon-fit.js'), type: 'application/javascript; charset=utf-8' },
});

const SECURITY_HEADERS = Object.freeze({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    // xterm creates runtime style sheets and inline layout attributes. Keep the
    // exception scoped to CSS; executable content remains same-origin only.
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});

function sendJson(res, status, value, extraHeaders = {}) {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        ...extraHeaders,
    });
    res.end(body);
}

function sendError(res, status, error, extraHeaders = {}) {
    sendJson(res, status, { ok: false, error }, extraHeaders);
}

async function readJsonBody(req, maxBytes) {
    const contentType = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw Object.assign(new Error('content type'), { code: 'UNSUPPORTED_MEDIA_TYPE' });
    const declared = Number(req.headers?.['content-length'] || 0);
    if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
            req.destroy?.();
            throw Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' });
        }
        chunks.push(chunk);
    }
    try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
        return value;
    } catch (_) {
        throw Object.assign(new Error('invalid JSON'), { code: 'INVALID_JSON' });
    }
}

function requireAdministrator(req, res) {
    if (isAdminUser(req?.user)) return true;
    sendError(res, req?.user ? 403 : 401, req?.user ? 'administrator_required' : 'authentication_required');
    return false;
}

function requireAvailable(manager, res) {
    let availability;
    try {
        availability = manager?.availability?.() || { ok: false };
    } catch (error) {
        mapOperationError(res, error);
        return false;
    }
    if (availability.ok) return true;
    sendError(res, 503, 'webtty_unavailable', { 'Retry-After': '5' });
    return false;
}

function verifyMutationBeforeBody(req, res, routePlan) {
    let proof;
    try {
        proof = verifyBrowserMutationRequest(req, {
            routePlan,
            authContext: req.edgeAuthContext,
            sessionId: req.sessionId,
        });
    } catch (error) {
        mapOperationError(res, error);
        return false;
    }
    if (!proof.ok) {
        sendError(res, 403, String(proof.code || 'browser_mutation_denied').toLowerCase());
        return false;
    }
    return true;
}

function commitMutation(routePlan, res) {
    try {
        if (commitRouteGeneration(routePlan)) return true;
    } catch (error) {
        mapOperationError(res, error);
        return false;
    }
    sendError(res, 503, 'edge_generation_changed');
    return false;
}

function exactBodyKeys(body, expected) {
    const keys = Object.keys(body).sort();
    const target = [...expected].sort();
    return keys.length === target.length && keys.every((key, index) => key === target[index]);
}

function validateDimensions(cols, rows) {
    return Number.isSafeInteger(cols)
        && cols >= WEBTTY_PROTOCOL_LIMITS.minColumns
        && cols <= WEBTTY_PROTOCOL_LIMITS.maxColumns
        && Number.isSafeInteger(rows)
        && rows >= WEBTTY_PROTOCOL_LIMITS.minRows
        && rows <= WEBTTY_PROTOCOL_LIMITS.maxRows;
}

function sessionPath(pathname) {
    const match = pathname.match(/^\/webtty\/sessions\/([A-Za-z0-9_-]{16,128})(?:\/(stream|input|resize|close-policy|close-intents))?$/);
    return match ? { id: match[1], operation: match[2] || '' } : null;
}

const VIEW_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const CLOSE_POLICIES = new Set(['keep', 'stop']);

// A stream names exactly one server-issued view: `?view=<id>` and nothing else.
function streamViewId(parsedUrl) {
    const params = parsedUrl.searchParams;
    const keys = [...params.keys()];
    const value = params.get('view');
    return keys.length === 1 && keys[0] === 'view' && VIEW_ID_PATTERN.test(value || '') ? value : '';
}

function discoveryPath(pathname) {
    const match = pathname.match(/^\/webtty\/target-discoveries\/([A-Za-z0-9_-]{16,128})$/);
    return match ? { id: match[1] } : null;
}

const RETRYABLE_CLIENT_OPERATION_ERRORS = new Set([
    'WEBTTY_LAUNCH_QUOTA',
    'WEBTTY_GLOBAL_QUOTA',
    'WEBTTY_USER_QUOTA',
    'WEBTTY_SESSION_QUOTA',
    'WEBTTY_CREATION_RATE',
    'WEBTTY_VIEWER_QUOTA',
    'WEBTTY_VIEW_LIMIT',
    'WEBTTY_INPUT_RATE',
    'WEBTTY_IPC_BACKPRESSURE',
    'WEBTTY_AGENT_IPC_BACKPRESSURE',
]);

const STALE_TARGET_ERRORS = new Set([
    'WEBTTY_TARGET_STALE',
    'WEBTTY_TARGET_DIRECTORY_STALE',
    'WEBTTY_TARGET_GENERATION_STALE',
    'WEBTTY_TARGET_IDENTITY_STALE',
]);

function mapOperationError(res, error) {
    const code = String(error?.code || '');
    if (code === 'WEBTTY_AUTH_INVALID' || code === 'WEBTTY_AUTH_SESSION_REQUIRED') {
        sendError(res, 401, 'authentication_required');
    } else if (code === 'WEBTTY_ADMIN_REQUIRED') {
        sendError(res, 403, 'administrator_required');
    } else if (code === 'WEBTTY_OWNER_REQUIRED') {
        sendError(res, 403, 'owner_required');
    } else if (RETRYABLE_CLIENT_OPERATION_ERRORS.has(code)) {
        sendError(res, 429, code.toLowerCase(), { 'Retry-After': '5' });
    } else if (code === 'WEBTTY_LAUNCH_NOT_FOUND') {
        sendError(res, 404, 'terminal_launch_unavailable');
    } else if (code === 'WEBTTY_SESSION_NOT_FOUND' || code === 'WEBTTY_ATTACH_NOT_FOUND') {
        sendError(res, 404, 'not_found');
    } else if (STALE_TARGET_ERRORS.has(code)) {
        sendError(res, 409, 'terminal_target_stale');
    } else if (code === 'WEBTTY_PROFILE_UNAVAILABLE') {
        sendError(res, 409, 'terminal_profile_unavailable');
    } else if (code === 'WEBTTY_VIEW_STALE') {
        sendError(res, 409, 'terminal_view_stale');
    } else if (code === 'WEBTTY_UNAVAILABLE' || code === 'WEBTTY_TARGET_PROVIDER_UNAVAILABLE') {
        sendError(res, 503, 'webtty_unavailable', { 'Retry-After': '5' });
    } else if (code === 'WEBTTY_GENERATION_CHANGED' || code === 'EDGE_GENERATION_INACTIVE') {
        sendError(res, 503, 'edge_generation_changed');
    } else {
        sendError(res, 503, 'terminal_runtime_failure');
    }
}

export async function handleWebtty(req, res, parsedUrl, {
    manager,
    routePlan,
} = {}) {
    const pathname = parsedUrl.pathname || '/';
    if (!(pathname === '/webtty' || pathname.startsWith('/webtty/'))) return false;
    if (!requireAdministrator(req, res)) return true;
    const method = String(req.method || 'GET').toUpperCase();

    // The list stays readable while WebTTY is disabled so that close outcomes
    // remain visible; it then returns only retained outcomes with
    // `available: false`. Lease validation still applies. No other route opens.
    if (pathname === '/webtty/live-sessions' && method === 'GET') {
        try {
            const { sessions, available } = await manager.listLiveSessions({ req, routePlan });
            sendJson(res, 200, { ok: true, version: 1, sessions, ...(available === false ? { available: false } : {}) });
        } catch (error) { mapOperationError(res, error); }
        return true;
    }

    if (!requireAvailable(manager, res)) return true;

    const attachTokenPath = pathname.match(/^\/webtty\/live-sessions\/([A-Za-z0-9_-]{32})\/attach-tokens$/);
    if ((attachTokenPath || pathname === '/webtty/attachments') && method === 'POST') {
        if (!verifyMutationBeforeBody(req, res, routePlan)) return true;
        let body;
        try { body = await readJsonBody(req, 1024); }
        catch (error) {
            sendError(res, error.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : error.code === 'BODY_TOO_LARGE' ? 413 : 400, error.code.toLowerCase());
            return true;
        }
        // A token body is exactly {} or {supersedes: <view id>}: an explicit
        // recovery names the view it replaces; the format is the only check here.
        const recoveryClaim = attachTokenPath && exactBodyKeys(body, ['supersedes'])
            && typeof body.supersedes === 'string' && VIEW_ID_PATTERN.test(body.supersedes);
        if (parsedUrl.search || (attachTokenPath ? !exactBodyKeys(body, []) && !recoveryClaim
            : !exactBodyKeys(body, ['attach', 'cols', 'rows'])
                || typeof body.attach !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.attach)
                || !validateDimensions(body.cols, body.rows))) {
            sendError(res, 400, 'invalid_attachment_request');
            return true;
        }
        if (!commitMutation(routePlan, res)) return true;
        try {
            if (attachTokenPath) {
                sendJson(res, 201, { ok: true, ...await manager.createAttachToken({
                    req, routePlan, id: attachTokenPath[1], ...(recoveryClaim ? { supersedes: body.supersedes } : {}),
                }) });
            } else {
                const { view, ...session } = await manager.attach({ req, routePlan, ...body });
                sendJson(res, 200, { ok: true, session, view });
            }
        } catch (error) { mapOperationError(res, error); }
        return true;
    }

    if ((pathname === '/webtty' || pathname === '/webtty/') && method === 'GET') {
        const body = await fs.promises.readFile(path.join(WEBTTY_ROOT, 'webtty.html'));
        if (req.destroyed || res.destroyed) return true;
        res.writeHead(200, {
            ...SECURITY_HEADERS,
            'X-Frame-Options': 'SAMEORIGIN',
            'Content-Security-Policy': SECURITY_HEADERS['Content-Security-Policy']
                .replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': body.length,
        });
        res.end(body);
        return true;
    }

    if (pathname.startsWith('/webtty/assets/') && method === 'GET') {
        const name = pathname.slice('/webtty/assets/'.length);
        if (!Object.hasOwn(ASSETS, name)) { sendError(res, 404, 'not_found'); return true; }
        const asset = ASSETS[name];
        try {
            const body = await fs.promises.readFile(asset.path);
            if (req.destroyed || res.destroyed) return true;
            res.writeHead(200, {
                ...SECURITY_HEADERS,
                'Content-Type': asset.type,
                'Content-Length': body.length,
            });
            res.end(body);
        } catch (_) {
            sendError(res, 503, 'webtty_asset_unavailable');
        }
        return true;
    }

    if (pathname === '/webtty/target-discoveries' && method === 'POST') {
        if (!verifyMutationBeforeBody(req, res, routePlan)) return true;
        let body;
        try { body = await readJsonBody(req, 8 * 1024); }
        catch (error) {
            sendError(res, error.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : error.code === 'BODY_TOO_LARGE' ? 413 : 400, error.code.toLowerCase());
            return true;
        }
        // Exactly `{dir}` (standalone) or `{dir, profile: {provider, id}}`.
        // The browser names a profile; it never supplies a HOME path.
        const withProfile = exactBodyKeys(body, ['dir', 'profile']);
        if ((!withProfile && !exactBodyKeys(body, ['dir'])) || typeof body.dir !== 'string'
            || (withProfile && !validateHomeProfileRequest(body.profile))) {
            sendError(res, 400, 'invalid_discovery_request');
            return true;
        }
        try {
            const discovery = await manager.discoverTargets({
                req,
                routePlan,
                directory: body.dir,
                ...(withProfile ? { profile: validateHomeProfileRequest(body.profile) } : {}),
            });
            sendJson(res, 201, { ok: true, discovery });
        } catch (error) {
            mapOperationError(res, error);
        }
        return true;
    }

    const selectedDiscovery = discoveryPath(pathname);
    if (selectedDiscovery && method === 'DELETE') {
        if (!verifyMutationBeforeBody(req, res, routePlan)) return true;
        if (!commitMutation(routePlan, res)) return true;
        try {
            const cancelled = await manager.cancelTargetDiscovery({
                req,
                routePlan,
                id: selectedDiscovery.id,
            });
            if (!cancelled) sendError(res, 404, 'not_found');
            else sendJson(res, 200, { ok: true });
        } catch (error) {
            mapOperationError(res, error);
        }
        return true;
    }

    if (pathname === '/webtty/sessions' && method === 'POST') {
        if (!verifyMutationBeforeBody(req, res, routePlan)) return true;
        let body;
        try { body = await readJsonBody(req, 8 * 1024); }
        catch (error) {
            sendError(res, error.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : error.code === 'BODY_TOO_LARGE' ? 413 : 400, error.code.toLowerCase());
            return true;
        }
        if (!exactBodyKeys(body, ['launch', 'cols', 'rows', 'closePolicy'])
            || typeof body.launch !== 'string'
            || !/^[A-Za-z0-9_-]{32}$/.test(body.launch)
            || !validateDimensions(body.cols, body.rows)
            || !CLOSE_POLICIES.has(body.closePolicy)) {
            sendError(res, 400, 'invalid_session_request');
            return true;
        }
        try {
            const { view, ...session } = await manager.create({
                req,
                routePlan,
                launch: body.launch,
                cols: body.cols,
                rows: body.rows,
                closePolicy: body.closePolicy,
            });
            sendJson(res, 201, { ok: true, session, view });
        } catch (error) {
            mapOperationError(res, error);
        }
        return true;
    }

    const selected = sessionPath(pathname);
    if (!selected) {
        sendError(res, 404, 'not_found');
        return true;
    }

    if (selected.operation === 'stream' && method === 'GET') {
        const viewId = streamViewId(parsedUrl);
        if (!viewId) { sendError(res, 400, 'invalid_stream_request'); return true; }
        let session;
        let retired = null;
        try {
            session = await manager.authorize(req, routePlan, selected.id, 'watch');
            if (session) {
                manager.streamView(session, req, viewId);
                manager.assertViewerQuota(session);
            } else {
                // A view that missed its retired shell's exit may still learn it.
                retired = await manager.retiredStreamOutcome(req, routePlan, selected.id, viewId);
            }
        }
        catch (error) { mapOperationError(res, error); return true; }
        const streamHeaders = {
            ...SECURITY_HEADERS,
            'Content-Type': 'text/event-stream; charset=utf-8',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        };
        if (!session) {
            // Final guard: nothing is awaited between it and the response.
            let exitEvent = null;
            try { exitEvent = retired ? manager.commitRetiredStreamOutcome(routePlan, retired) : null; }
            catch (error) { mapOperationError(res, error); return true; }
            if (!exitEvent) { sendError(res, 404, 'not_found'); return true; }
            res.writeHead(200, streamHeaders);
            try { res.write(exitEvent); } catch (_) { }
            try { res.end(); } catch (_) { }
            return true;
        }
        res.writeHead(200, streamHeaders);
        let attached = false;
        try {
            attached = manager.attachStream(session, req, res, req.headers?.['last-event-id'], routePlan, viewId);
        } catch (_) { }
        if (!attached && !res.writableEnded && !res.destroyed) {
            try { res.end(); } catch (_) { }
        }
        return true;
    }

    if (selected.operation === 'input' && method === 'POST') {
        if (!verifyMutationBeforeBody(req, res, routePlan)) return true;
        let body;
        try { body = await readJsonBody(req, WEBTTY_PROTOCOL_LIMITS.maxInputBytes + 256); }
        catch (error) {
            sendError(res, error.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : error.code === 'BODY_TOO_LARGE' ? 413 : 400, error.code.toLowerCase());
            return true;
        }
        if (!exactBodyKeys(body, ['data']) || typeof body.data !== 'string'
            || Buffer.byteLength(body.data) < 1
            || Buffer.byteLength(body.data) > WEBTTY_PROTOCOL_LIMITS.maxInputBytes) {
            sendError(res, 400, 'invalid_input');
            return true;
        }
        let session;
        try { session = await manager.authorize(req, routePlan, selected.id, 'input'); }
        catch (error) { mapOperationError(res, error); return true; }
        if (!session) { sendError(res, 404, 'not_found'); return true; }
        if (!commitMutation(routePlan, res)) return true;
        try { await manager.input(session, body.data); sendJson(res, 200, { ok: true }); }
        catch (error) { mapOperationError(res, error); }
        return true;
    }

    if (selected.operation === 'resize' && method === 'POST') {
        if (!verifyMutationBeforeBody(req, res, routePlan)) return true;
        let body;
        try { body = await readJsonBody(req, 1024); }
        catch (error) {
            sendError(res, error.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : error.code === 'BODY_TOO_LARGE' ? 413 : 400, error.code.toLowerCase());
            return true;
        }
        if (!exactBodyKeys(body, ['cols', 'rows']) || !validateDimensions(body.cols, body.rows)) {
            sendError(res, 400, 'invalid_dimensions');
            return true;
        }
        let session;
        try { session = await manager.authorize(req, routePlan, selected.id, 'resize'); }
        catch (error) { mapOperationError(res, error); return true; }
        if (!session) { sendError(res, 404, 'not_found'); return true; }
        if (!commitMutation(routePlan, res)) return true;
        try { await manager.resize(session, body.cols, body.rows); sendJson(res, 200, { ok: true }); }
        catch (error) { mapOperationError(res, error); }
        return true;
    }

    if ((selected.operation === 'close-policy' || selected.operation === 'close-intents') && method === 'POST') {
        if (!verifyMutationBeforeBody(req, res, routePlan)) return true;
        let body;
        try { body = await readJsonBody(req, 1024); }
        catch (error) {
            sendError(res, error.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : error.code === 'BODY_TOO_LARGE' ? 413 : 400, error.code.toLowerCase());
            return true;
        }
        const intent = selected.operation === 'close-intents';
        if (parsedUrl.search || !CLOSE_POLICIES.has(body.policy) || (intent
            ? !exactBodyKeys(body, ['view', 'policy']) || typeof body.view !== 'string' || !VIEW_ID_PATTERN.test(body.view)
            : !exactBodyKeys(body, ['policy']))) {
            sendError(res, 400, intent ? 'invalid_close_intent' : 'invalid_close_policy');
            return true;
        }
        if (!commitMutation(routePlan, res)) return true;
        try {
            if (intent) {
                const result = await manager.closeIntent({
                    req, routePlan, id: selected.id, view: body.view, policy: body.policy,
                });
                if (result.pending) sendJson(res, 202, { ok: true, pending: true, until: result.until });
                else sendJson(res, 200, { ok: true, pending: false, ...(result.reason ? { reason: result.reason } : {}) });
            } else {
                const result = await manager.setClosePolicy({ req, routePlan, id: selected.id, policy: body.policy });
                sendJson(res, 200, { ok: true, closePolicy: result.closePolicy, pendingStopUntil: result.pendingStopUntil });
            }
        } catch (error) { mapOperationError(res, error); }
        return true;
    }

    if (!selected.operation && method === 'DELETE') {
        if (!verifyMutationBeforeBody(req, res, routePlan)) return true;
        if (!commitMutation(routePlan, res)) return true;
        let closed;
        try { closed = await manager.closeAuthorized(req, routePlan, selected.id); }
        catch (error) { mapOperationError(res, error); return true; }
        if (!closed) { sendError(res, 404, 'not_found'); return true; }
        sendJson(res, 200, { ok: true });
        return true;
    }

    sendError(res, 405, 'method_not_allowed');
    return true;
}

export default handleWebtty;
