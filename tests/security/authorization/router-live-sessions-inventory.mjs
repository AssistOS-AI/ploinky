import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertRouterInventoryObligations } from './router-source-references.mjs';

const HANDLER = 'cli/server/handlers/webtty.js';
const HANDLER_SHA256 = '78569d92913f5520d6dbc6539d7c1ef6a72e4af3c85c8989c4e29f957fd2722a';
const amendments = Object.freeze({
    'webtty-create.post': 'Body exactly {launch,cols,rows,closePolicy} with closePolicy keep or stop; single-use 32-character launch proof; exact session/generation binding + CSRF. Returns the shell and a server-issued owner view {id}.',
    'webtty-stream.get': 'Any administrator on the same host-route can watch; the stream must name exactly one ?view= issued to the same principal and not ended by a close intent or superseded by a recovery claim. Each viewer has its own session/generation lease and replay cursor. After the shell is retired, a view that was neither ended nor superseded at retirement may receive exactly one finite 200 SSE exit event with the stored close reason, only for the principal recorded for that view, with fresh authentication of this request, the current route generation and host-route, and the final synchronous guard immediately before the response; it creates no viewer, worker, subscription or replay. Unknown, expired, evicted, ended or superseded views and other principals are still refused with the existing mappings.',
    'webtty-input.post': 'Body {data}; administrator, Origin/CSRF, current request generation and owner principal. Other administrators cannot type.',
    'webtty-resize.post': 'Body {cols,rows}; administrator, Origin/CSRF, current request generation and owner principal. Watchers cannot resize.',
    'webtty-delete.delete': 'Owner or any administrator on the same host-route can stop; current generation and Origin/CSRF required. Tombstone replay is idempotent.',
});
const additions = Object.freeze([
    { id: 'webtty-live-sessions.get', method: 'GET', path: '/webtty/live-sessions', line: 219,
        statement: "if (pathname === '/webtty/live-sessions' && method === 'GET') {",
        notes: 'Administrator-only safe display rows for live and recently exited shells on this host-route. Answered after the administrator gate but before the availability gate, with lease validation; while WebTTY is disabled it returns only retained close outcomes with top-level available:false.' },
    { id: 'webtty-attach-token.post', method: 'POST', path: '/webtty/live-sessions/:sessionId/attach-tokens', line: 252,
        statement: 'sendJson(res, 201, { ok: true, ...await manager.createAttachToken({',
        notes: 'Body exactly {} or {supersedes: <32-character view id>} (format-checked only, else 400); administrator and Origin/CSRF before body read; single-use 60-second token bound to login, route and shell, carrying the claim. The claim is a hint, never a credential: at attach it applies only for the owner, to a retained, not yet superseded owner view of the same shell; otherwise it is ignored.' },
    { id: 'webtty-attachment.post', method: 'POST', path: '/webtty/attachments', line: 256,
        statement: 'const { view, ...session } = await manager.attach({ req, routePlan, ...body });',
        notes: 'Body {attach,cols,rows}; administrator and Origin/CSRF before body read. Owner may resize; other administrators attach read-only. No query tokens. Returns a new server-issued view {id}. A plain view never cancels a pending tab-close stop; only a valid recovery claim of the view that armed it does.' },
    { id: 'webtty-close-policy.post', method: 'POST', path: '/webtty/sessions/:sessionId/close-policy', line: 499,
        statement: 'const result = await manager.setClosePolicy({ req, routePlan, id: selected.id, policy: body.policy });',
        notes: 'Body exactly {policy} (keep or stop); administrator and Origin/CSRF before body read, current generation, owner principal only. Keep cancels a pending stop; stop arms one only when the most recent non-superseded owner intent carried stop and no owner view is open or within its reconnect window.' },
    { id: 'webtty-close-intents.post', method: 'POST', path: '/webtty/sessions/:sessionId/close-intents', line: 493,
        statement: 'const result = await manager.closeIntent({',
        notes: 'Body exactly {view,policy}; administrator and Origin/CSRF before body read, current generation, owner principal only (watchers 403). The view must be the owner\'s and not already ended or superseded, else 409 with no effect; a view claimed while open by a living recovery view is superseded instead. Arms a 30-second stop only when both policies are stop; a newer view alone never supersedes.' },
]);

export function buildLiveSessionsRouterInventory(historical, bytes) {
    // Historical union, cardinality, contracts and source proofs remain mandatory.
    assertRouterInventoryObligations(historical);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), HANDLER_SHA256, 'UNREVIEWED_LIVE_SESSIONS_SOURCE');
    const lines = bytes.toString().split('\n');
    const current = historical.map(row => Object.freeze(amendments[row.id] ? { ...row, notes: amendments[row.id] } : row));
    for (const { line, statement, ...contract } of additions) {
        assert.equal(lines[line - 1]?.trim(), statement, `LIVE_SESSIONS_STATEMENT_MISMATCH: ${contract.id}`);
        current.push(Object.freeze({ ...contract, source: `${HANDLER}:${line}`, sourceBlobSha256: HANDLER_SHA256,
            anchor: statement,
            expected: { anonymous: 'deny', selfRegistered: 'deny', user: 'deny', admin: 'allow' },
            coverage: 'inventoried; live evidence required',
            gap: 'Live proof requires a dedicated terminal fixture; source/unit evidence does not establish deployment acceptance.',
        }));
    }
    assert.equal(new Set(current.map(row => row.id)).size, current.length, 'DUPLICATE_ROUTER_OBLIGATION');
    return Object.freeze(current);
}

export function assertLiveSessionsRouterInventory(rows, historical, bytes) {
    assert.deepEqual(rows, buildLiveSessionsRouterInventory(historical, bytes), 'LIVE_SESSIONS_CONTRACT_DRIFT');
    return true;
}
