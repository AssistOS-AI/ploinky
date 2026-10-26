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

// Every check below is a collector that returns structured entries and never
// throws for registry or byte content. `DriftEntry` is { code, file, id,
// detail?, message }; `message` is the legacy single-error text that the
// throwing wrappers raise, so their codes and messages are unchanged.
const entryLine = ({ code, file, id, detail }) => `${code}: ${file} ${id}${detail ? ` ${detail}` : ''}`;

export function routerReferenceMapErrors(snapshot = obligations) {
    const errors = [];
    for (const [stage, inventory] of Object.entries(snapshot.priorInventories)) {
        for (const prior of inventory.rows) {
            const [file] = prior.source.split(':');
            const add = code => errors.push({ code, file, id: prior.id, detail: `stage ${stage}`, message: `${code}: ${prior.id}` });
            const canonical = snapshot.canonical[prior.id];
            if (!canonical) { add('MISSING_ROUTER_OBLIGATION'); continue; }
            if (prior.anchor && !canonical.anchor) add('MISSING_UNION_ROUTER_ANCHOR');
            const family = snapshot.files[file];
            if (!family) continue;
            const reference = family.blobs[family[stage]]?.[prior.id];
            if (!reference) { add('MISSING_ROUTER_OBLIGATION'); continue; }
            // Each product retains its own original anchor literally, even
            // when the other product requires a synchronous counterpart.
            if (prior.anchor && reference.anchor !== prior.anchor) add('PRIOR_ROUTER_ANCHOR_CHANGED');
        }
    }
    return errors;
}

export function assertRouterReferenceMaps(snapshot = obligations) {
    const errors = routerReferenceMapErrors(snapshot);
    if (errors.length) assert.fail(errors[0].message);
    return true;
}

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

const registeredFamily = (snapshot, file) => Object.hasOwn(snapshot.files, file) ? snapshot.files[file] : undefined;

// The checks run in the order the throwing resolver always raised them. A row
// whose identity or blob cannot be found stops there, because the later checks
// need that reference; the other faults are independent and all reported.
// A row of an unregistered file has no reference to compare and yields [].
export function routerSourceReferenceErrors(row, bytes, snapshot = obligations) {
    const [file] = row.source.split(':');
    const family = registeredFamily(snapshot, file);
    if (!family) return [];
    const errors = [];
    const add = (code, message, detail) => errors.push({ code, file, id: row.id, ...(detail === undefined ? {} : { detail }), message });
    const canonical = snapshot.canonical[row.id];
    // A dangling baseline pointer is a registry fault to report, not to throw on.
    if (!canonical || !Object.hasOwn(family.blobs[family.baseline] ?? {}, row.id)) {
        add('UNMAPPED_ROUTER_REFERENCE', `UNMAPPED_ROUTER_REFERENCE: ${row.id}`);
        return errors;
    }
    if (row.source !== canonical.source) add('STALE_ROUTER_REFERENCE', `STALE_ROUTER_REFERENCE: ${row.id}`);
    if ((row.anchor ?? null) !== canonical.anchor) add('MISMATCHED_ROUTER_ANCHOR', `MISMATCHED_ROUTER_ANCHOR: ${row.id}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const blob = Object.hasOwn(family.blobs, sha256) ? family.blobs[sha256] : undefined;
    const legacy = `UNREVIEWED_ROUTER_SOURCE: ${file} ${sha256}`;
    if (!blob) { add('UNREVIEWED_ROUTER_SOURCE', legacy, sha256); return errors; }
    const reference = blob[row.id];
    if (!reference) { add('MISSING_ROUTER_BLOB_ROW', legacy, sha256); return errors; }
    const line = bytes.toString('utf8').split('\n')[reference.line - 1];
    if (line?.trim() !== reference.statement) add('ROUTER_STATEMENT_MISMATCH', `ROUTER_STATEMENT_MISMATCH: ${row.id}`, `line ${reference.line}`);
    if (reference.anchor !== null && !line?.includes(reference.anchor)) add('ROUTER_ANCHOR_NOT_ON_LINE', `ROUTER_ANCHOR_NOT_ON_LINE: ${row.id}`, `line ${reference.line}`);
    return errors;
}

export function resolveRouterSourceReference(row, bytes, snapshot = obligations) {
    const [file] = row.source.split(':');
    const family = registeredFamily(snapshot, file);
    if (!family) return row;
    const errors = routerSourceReferenceErrors(row, bytes, snapshot);
    if (errors.length) assert.fail(errors[0].message);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const reference = family.blobs[sha256][row.id];
    const resolved = { ...row, source: `${file}:${reference.line}`, sourceBlobSha256: sha256 };
    if (reference.anchor !== null) resolved.anchor = reference.anchor;
    return resolved;
}

export function assertRouterInventoryObligations(rows, snapshot = obligations) {
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'DUPLICATE_ROUTER_OBLIGATION');
    for (const inventory of Object.values(snapshot.priorInventories)) {
        assert.equal(rows.length, inventory.rows.length, 'MISSING_ROUTER_OBLIGATION');
        for (const prior of inventory.rows) {
            const row = rows.find(value => value.id === prior.id);
            assert.ok(row, `MISSING_ROUTER_OBLIGATION: ${prior.id}`);
            assert.equal(contractDigest(row), prior.contractSha256, `ROUTER_CONTRACT_DRIFT: ${prior.id}`);
            if (snapshot.canonical[prior.id].anchor) assert.ok(row.anchor, `MISSING_UNION_ROUTER_ANCHOR: ${prior.id}`);
            const [file] = prior.source.split(':');
            const family = snapshot.files[file];
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

// One aggregated, sorted, unique report of every mismatch between the reviewed
// registry and the source bytes `readSource(file)` returns. It never throws for
// registry or byte content, so a single drifted file cannot hide the others;
// only a structurally malformed registry (for example `files[f].blobs`
// missing) may throw. `rows` are the baseline inventory rows. `readSource` is
// called once per distinct file; a failing read is reported as
// ROUTER_SOURCE_UNREADABLE for that file.
//
// A row of a registered file is checked against its reviewed reference. A row
// of an unregistered file must still name a line that exists, and an anchor it
// carries must still be on that line.
//
// When nothing else drifted, the resolved rows are also checked against the
// retained prior obligations, which the module-load assertion used to do. The
// result is one `ROUTER_OBLIGATION: <message>` entry on failure. While any
// drift exists this fold-in is skipped: unresolved rows already fail on their
// own, and the obligation check needs every row resolved.
export function collectRouterSourceDrift({ rows, readSource, snapshot = obligations }) {
    const lines = new Set();
    for (const entry of routerReferenceMapErrors(snapshot)) lines.add(entryLine(entry));
    const sources = new Map();
    const load = file => {
        if (!sources.has(file)) {
            try {
                const value = readSource(file);
                sources.set(file, { bytes: Buffer.isBuffer(value) ? value : Buffer.from(value) });
            } catch (error) {
                sources.set(file, { error });
                lines.add(entryLine({ code: 'ROUTER_SOURCE_UNREADABLE', file, id: '*', detail: String(error?.code ?? error?.name ?? 'ERROR') }));
            }
        }
        return sources.get(file);
    };
    for (const row of rows) {
        const [file, line] = row.source.split(':');
        const source = load(file);
        if (source.error) continue;
        if (registeredFamily(snapshot, file)) {
            for (const entry of routerSourceReferenceErrors(row, source.bytes, snapshot)) lines.add(entryLine(entry));
            continue;
        }
        const text = source.bytes.toString('utf8').split('\n');
        if (!/^\d+$/.test(String(line)) || Number(line) < 1 || Number(line) > text.length) {
            lines.add(entryLine({ code: 'ROUTER_SOURCE_LINE_OUT_OF_RANGE', file, id: row.id, detail: `line ${line}` }));
            continue;
        }
        if (row.anchor && !text[Number(line) - 1].includes(row.anchor)) lines.add(entryLine({ code: 'ROUTER_ANCHOR_NOT_ON_LINE', file, id: row.id, detail: `line ${line}` }));
    }
    const drift = [...lines].sort();
    if (!drift.length) {
        try {
            assertRouterInventoryObligations(rows.map(row => {
                const [file] = row.source.split(':');
                return registeredFamily(snapshot, file) ? resolveRouterSourceReference(row, sources.get(file).bytes, snapshot) : row;
            }), snapshot);
        // Only the first line: newer Node versions append an actual/expected diff
        // to a custom assertion message, and each drift entry is one line.
        } catch (error) { drift.push(`ROUTER_OBLIGATION: ${String(error?.message ?? error).split('\n')[0]}`); }
    }
    return drift;
}
