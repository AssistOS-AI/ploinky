import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const SOURCE = 'cli/server/edgeRoutePlan.js';
const SHA256 = '53307d82bd83896ae41aade6a92197bdaf202899e6792c451cb01718a1529a4d';
const LINE = 914;
const STATEMENT = "if (pathname === '/api/edge/runtime-sources' || pathname === '/api/edge/agent-images') {";

// A current addition, outside the immutable historical 128-row union.
export function buildAgentImagesRouterInventory(current, bytes) {
    assert.equal(createHash('sha256').update(bytes).digest('hex'), SHA256, 'UNREVIEWED_AGENT_IMAGES_SOURCE');
    assert.equal(bytes.toString().split('\n')[LINE - 1]?.trim(), STATEMENT, 'AGENT_IMAGES_STATEMENT_MISMATCH');
    const row = Object.freeze({
        id: 'private-agent-images.get', method: 'GET', path: '/api/edge/agent-images',
        source: `${SOURCE}:${LINE}`, sourceBlobSha256: SHA256, anchor: STATEMENT,
        expected: { anonymous: 'deny', selfRegistered: 'deny', user: 'deny', admin: 'deny' },
        notes: 'Private listener only; exact current execution-provider holder ACL, signed assertion and replay protection. '
            + 'Bare bodyless GET. Lease-snapshot metadata and bounded image inspect only; 503 on lease change or bounds.',
        coverage: 'inventoried; live evidence required',
        gap: 'Covered by isolated fake-CLI operation tests; no deployed private API probe.',
    });
    const rows = Object.freeze([...current, row]);
    assert.equal(new Set(rows.map((entry) => entry.id)).size, rows.length, 'DUPLICATE_ROUTER_OBLIGATION');
    return rows;
}
