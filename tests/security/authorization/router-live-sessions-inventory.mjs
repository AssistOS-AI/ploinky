import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertRouterInventoryObligations } from './router-source-references.mjs';

const HANDLER = 'cli/server/handlers/webtty.js';
const HANDLER_SHA256 = 'a857a64e177ea41d199c719e92caecbc2ad9cd47cf91b3db11430c7cfee1ee31';
const amendments = Object.freeze({
    'webtty-stream.get': 'Any administrator on the same host-route can watch; each viewer has its own session/generation lease and replay cursor.',
    'webtty-input.post': 'Body {data}; administrator, Origin/CSRF, current request generation and owner principal. Other administrators cannot type.',
    'webtty-resize.post': 'Body {cols,rows}; administrator, Origin/CSRF, current request generation and owner principal. Watchers cannot resize.',
    'webtty-delete.delete': 'Owner or any administrator on the same host-route can stop; current generation and Origin/CSRF required. Tombstone replay is idempotent.',
});
const additions = Object.freeze([
    { id: 'webtty-live-sessions.get', method: 'GET', path: '/webtty/live-sessions', line: 199,
        statement: "if (pathname === '/webtty/live-sessions' && method === 'GET') {",
        notes: 'Administrator-only safe display rows for live and recently exited shells on this host-route.' },
    { id: 'webtty-attach-token.post', method: 'POST', path: '/webtty/live-sessions/:sessionId/attach-tokens', line: 224,
        statement: 'sendJson(res, 201, { ok: true, ...await manager.createAttachToken({ req, routePlan, id: attachTokenPath[1] }) });',
        notes: 'Exact empty JSON body, administrator and Origin/CSRF before body read; single-use 60-second token bound to login, route and shell.' },
    { id: 'webtty-attachment.post', method: 'POST', path: '/webtty/attachments', line: 226,
        statement: 'const session = await manager.attach({ req, routePlan, ...body });',
        notes: 'Body {attach,cols,rows}; administrator and Origin/CSRF before body read. Owner may resize; other administrators attach read-only. No query tokens.' },
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
