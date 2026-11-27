import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertRouterInventoryObligations } from './router-source-references.mjs';

const HANDLER = 'cli/server/handlers/webtty.js';
const HANDLER_SHA256 = '1e56909d44d083f4e5919375ad449e5c4b059e0f3139e637573b8f622a7cb2b8';
const amendments = Object.freeze({
    'webtty-create.post': 'Body exactly {launch,cols,rows,closePolicy} with closePolicy keep or stop; single-use 32-character launch proof; exact session/generation binding + CSRF. Returns the shell and a server-issued owner view {id}.',
    'webtty-stream.get': 'Any administrator on the same host-route can watch; the stream must name exactly one ?view= issued to the same principal and not ended by a close intent or superseded by a recovery claim. Each viewer has its own session/generation lease and replay cursor. After the shell is retired, a view that was neither ended nor superseded at retirement may receive exactly one finite 200 SSE exit event with the stored close reason, only for the principal recorded for that view, with fresh authentication of this request, the current route generation and host-route, and the final synchronous guard immediately before the response; it creates no viewer, worker, subscription or replay. Unknown, expired, evicted, ended or superseded views and other principals are still refused with the existing mappings.',
    'webtty-input.post': 'Body {data}. Requires administrator, Origin/CSRF, current generation and control of the terminal. The owner controls a personal terminal. The signed local CLI operator opens shared terminals, which every administrator on the same host-route can control.',
    'webtty-resize.post': 'Administrator, Origin/CSRF, current generation and control of the terminal required. Body requires cols and rows and accepts optional claim (exactly true) and view (a view id). While the size holder of a shared CLI terminal has a view attached, another controller must claim the size for their resize to apply.',
    'webtty-delete.delete': 'Owner or any administrator on the same host-route can stop; current generation and Origin/CSRF required. Tombstone replay is idempotent.',
});
const additions = Object.freeze([
    { id: 'webtty-live-sessions.get', method: 'GET', path: '/webtty/live-sessions', line: 220,
        statement: "if (pathname === '/webtty/live-sessions' && method === 'GET') {",
        notes: 'Administrator-only safe display rows for live and recently exited shells on this host-route. Answered after the administrator gate but before the availability gate, with lease validation; while WebTTY is disabled it returns only retained close outcomes with top-level available:false.' },
    { id: 'webtty-attach-token.post', method: 'POST', path: '/webtty/live-sessions/:sessionId/attach-tokens', line: 291,
        statement: 'sendJson(res, 201, { ok: true, ...await manager.createAttachToken({',
        notes: 'Body exactly {} or {supersedes: <32-character view id>} (format-checked only, else 400); administrator and Origin/CSRF before body read; single-use 60-second token bound to login, route and shell, carrying the claim. The claim is a hint, never a credential: at attach it applies only for a controller, to their own retained, not yet superseded controller view of the same shell; otherwise it is ignored.' },
    { id: 'webtty-attachment.post', method: 'POST', path: '/webtty/attachments', line: 295,
        statement: 'const { view, ...session } = await manager.attach({ req, routePlan, ...body });',
        notes: 'Body {attach,cols,rows}; administrator and Origin/CSRF before body read. Personal terminals give the owner control and other administrators read-only views. Administrators on the same host-route can control a shared CLI terminal. No query tokens. Returns a new server-issued view {id}. A plain view never cancels a pending tab-close stop; only a valid recovery claim of the view that armed it does.' },
    { id: 'webtty-close-policy.post', method: 'POST', path: '/webtty/sessions/:sessionId/close-policy', line: 560,
        statement: 'const result = await manager.setClosePolicy({ req, routePlan, id: selected.id, policy: body.policy });',
        notes: 'Body exactly {policy} (keep or stop); administrator and Origin/CSRF before body read, current generation, control of the terminal required. Keep cancels a pending stop; stop arms one only when the most recent non-superseded owner intent carried stop and no owner view is open or within its reconnect window.' },
    { id: 'webtty-close-intents.post', method: 'POST', path: '/webtty/sessions/:sessionId/close-intents', line: 554,
        statement: 'const result = await manager.closeIntent({',
        notes: 'Body exactly {view,policy}; administrator and Origin/CSRF before body read, current generation, control of the terminal required (watchers 403). The view must be a retained controller view of this terminal that has neither ended nor been superseded, else 409 with no effect; a view claimed while open by a living recovery view is superseded instead. Arms a 30-second stop only when both policies are stop; a newer view alone never supersedes.' },
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
