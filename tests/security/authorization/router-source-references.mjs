import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

// This reviewed fixture retains both prior inventories' obligations. Source
// variants name exact statements; no first-match route discovery is performed.
const obligations = JSON.parse(fs.readFileSync(new URL('./router-reference-obligations.json', import.meta.url)));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
function contractDigest(row) {
    const { source, anchor, sourceBlobSha256, ...contract } = row;
    return createHash('sha256').update(JSON.stringify(stable(contract))).digest('hex');
}
const previous = Object.values(obligations.priorInventories);

export function assertRouterReferenceMaps(snapshot = obligations) {
    for (const [stage, inventory] of Object.entries(snapshot.priorInventories)) {
        for (const prior of inventory.rows) {
            const canonical = snapshot.canonical[prior.id];
            assert.ok(canonical, `MISSING_ROUTER_OBLIGATION: ${prior.id}`);
            if (prior.anchor) assert.ok(canonical.anchor, `MISSING_UNION_ROUTER_ANCHOR: ${prior.id}`);
            const [file] = prior.source.split(':');
            const family = snapshot.files[file];
            if (!family) continue;
            const reference = family.blobs[family[stage]]?.[prior.id];
            assert.ok(reference, `MISSING_ROUTER_OBLIGATION: ${prior.id}`);
            // Each product retains its own original anchor literally, even
            // when the other product requires a synchronous counterpart.
            if (prior.anchor) assert.equal(reference.anchor, prior.anchor, `PRIOR_ROUTER_ANCHOR_CHANGED: ${prior.id}`);
        }
    }
    return true;
}
assertRouterReferenceMaps();

export function normalizeRouterInventory(rows) {
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'DUPLICATE_ROUTER_OBLIGATION');
    for (const inventory of previous) {
        assert.equal(rows.length, inventory.rows.length, 'MISSING_ROUTER_OBLIGATION');
        for (const prior of inventory.rows) {
            const row = rows.find(value => value.id === prior.id);
            assert.ok(row, `MISSING_ROUTER_OBLIGATION: ${prior.id}`);
            assert.equal(contractDigest(row), prior.contractSha256, `ROUTER_CONTRACT_DRIFT: ${prior.id}`);
        }
    }
    return rows.map(row => {
        const prior = obligations.priorInventories.baseline.rows.find(value => value.id === row.id);
        assert.equal(row.source, prior.source, `STALE_ROUTER_REFERENCE: ${row.id}`);
        assert.equal(row.anchor ?? null, prior.anchor, `MISMATCHED_ROUTER_ANCHOR: ${row.id}`);
        const canonical = obligations.canonical[row.id];
        const reference = { ...row, source: canonical.source };
        if (canonical.anchor !== null) reference.anchor = canonical.anchor;
        return reference;
    });
}

export function hasRouterSourceReference(row) {
    return Object.hasOwn(obligations.files, row.source.split(':')[0]);
}

export function resolveRouterSourceReference(row, bytes) {
    const [file] = row.source.split(':');
    const family = obligations.files[file];
    if (!family) return row;
    const canonical = obligations.canonical[row.id];
    assert.ok(canonical && Object.hasOwn(family.blobs[family.baseline], row.id), `UNMAPPED_ROUTER_REFERENCE: ${row.id}`);
    assert.equal(row.source, canonical.source, `STALE_ROUTER_REFERENCE: ${row.id}`);
    assert.equal(row.anchor ?? null, canonical.anchor, `MISMATCHED_ROUTER_ANCHOR: ${row.id}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const reference = family.blobs[sha256]?.[row.id];
    assert.ok(reference, `UNREVIEWED_ROUTER_SOURCE: ${file} ${sha256}`);
    const line = bytes.toString('utf8').split('\n')[reference.line - 1];
    assert.equal(line?.trim(), reference.statement, `ROUTER_STATEMENT_MISMATCH: ${row.id}`);
    const resolved = { ...row, source: `${file}:${reference.line}`, sourceBlobSha256: sha256 };
    if (reference.anchor !== null) resolved.anchor = reference.anchor;
    return resolved;
}

export function assertRouterInventoryObligations(rows) {
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'DUPLICATE_ROUTER_OBLIGATION');
    for (const inventory of previous) {
        assert.equal(rows.length, inventory.rows.length, 'MISSING_ROUTER_OBLIGATION');
        for (const prior of inventory.rows) {
            const row = rows.find(value => value.id === prior.id);
            assert.ok(row, `MISSING_ROUTER_OBLIGATION: ${prior.id}`);
            assert.equal(contractDigest(row), prior.contractSha256, `ROUTER_CONTRACT_DRIFT: ${prior.id}`);
            if (obligations.canonical[prior.id].anchor) assert.ok(row.anchor, `MISSING_UNION_ROUTER_ANCHOR: ${prior.id}`);
            const [file] = prior.source.split(':');
            const family = obligations.files[file];
            if (family) {
                const reference = family.blobs[row.sourceBlobSha256]?.[row.id];
                assert.ok(reference, `UNREVIEWED_ROUTER_SOURCE: ${row.id}`);
                assert.equal(row.source, `${file}:${reference.line}`, `STALE_ROUTER_REFERENCE: ${row.id}`);
                assert.equal(row.anchor ?? null, reference.anchor, `UNION_ROUTER_ANCHOR_MISMATCH: ${row.id}`);
                if (prior.anchor) assert.ok(reference.anchor, `MISSING_UNION_ROUTER_ANCHOR: ${row.id}`);
            } else {
                assert.equal(row.source, prior.source, `STALE_ROUTER_REFERENCE: ${row.id}`);
                assert.equal(row.anchor ?? null, prior.anchor, `UNION_ROUTER_ANCHOR_MISMATCH: ${row.id}`);
            }
        }
    }
    return true;
}
