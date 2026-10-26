/**
 * Mandatory Router source-drift check. T1 to T3 are named in the acceptance
 * mandatory list (acceptance/mandatory-checks.mjs), so a missing, renamed or
 * failing test here rejects the offline acceptance evidence. T4 to T10 are
 * synthetic controls for the aggregator: a collector that reported nothing, or
 * stopped at the first mismatch, would fail this same file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { routerInventory, routerInventoryBaseline, routerSourceDrift } from './router-inventory.mjs';
import {
  assertRouterInventoryObligations,
  assertRouterReferenceMaps,
  collectRouterSourceDrift,
  resolveRouterSourceReference,
  routerReferenceMapErrors,
  routerSourceReferenceErrors,
} from './router-source-references.mjs';

const registry = JSON.parse(fs.readFileSync(new URL('./router-reference-obligations.json', import.meta.url)));
const realBytes = file => fs.readFileSync(new URL(`../../../${file}`, import.meta.url));
const fileOf = row => row.source.split(':')[0];
const lineOf = row => row.source.split(':')[1];
const isFamily = row => Object.hasOwn(registry.files, fileOf(row));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const buf = lines => Buffer.from(lines.join('\n'));
const ref = (line, statement, anchor = null) => ({ line, anchor, statement });
const sources = map => file => {
  if (!Object.hasOwn(map, file)) throw Object.assign(new Error(`no ${file}`), { code: 'ENOENT' });
  return map[file];
};

test('router source drift: every Router inventory row matches the reviewed registry at the checkout bytes, with all mismatches reported together', () => {
  const drift = routerSourceDrift();
  assert.deepEqual(drift, [], `ROUTER_SOURCE_DRIFT: ${drift.length} mismatches\n${drift.join('\n')}`);
});

test('router source drift: the resolved Router inventory retains every prior obligation', () => {
  assert.equal(assertRouterInventoryObligations(routerInventory), true);
});

test('router source drift: mutated checkout bytes in several files are all reported in one list', () => {
  // Real bytes with an in-memory mutation: every registered family gets an
  // appended newline (an unreviewed blob), and one unregistered anchored row
  // loses its anchor. It does not depend on whether the checkout has drifted.
  const anchoredId = 'agent-startup-probe.get';
  const anchoredFile = 'cli/server/agentStartupPage.js';
  const anchored = routerInventoryBaseline.find(row => row.id === anchoredId);
  assert.ok(anchored?.anchor && fileOf(anchored) === anchoredFile && !isFamily(anchored), 'the unregistered anchored row exists');
  const readSource = file => {
    const bytes = realBytes(file);
    if (Object.hasOwn(registry.files, file)) return Buffer.concat([bytes, Buffer.from('\n')]);
    if (file !== anchoredFile) return bytes;
    const text = bytes.toString('utf8');
    assert.ok(text.includes(anchored.anchor), 'the anchor is present before the mutation');
    const mutated = Buffer.from(text.replaceAll(anchored.anchor, 'wrong_dispatch'));
    assert.notDeepEqual(mutated, bytes, 'the mutation must change the bytes');
    return mutated;
  };
  const drift = collectRouterSourceDrift({ rows: routerInventoryBaseline, readSource });
  const familyRows = routerInventoryBaseline.filter(isFamily);
  assert.deepEqual([...new Set(familyRows.map(fileOf))].sort(), Object.keys(registry.files).sort(), 'every registered family has inventory rows');
  for (const row of familyRows) assert.ok(drift.includes(`UNREVIEWED_ROUTER_SOURCE: ${fileOf(row)} ${row.id} ${sha256(readSource(fileOf(row)))}`), row.id);
  assert.ok(drift.includes(`ROUTER_ANCHOR_NOT_ON_LINE: ${anchoredFile} ${anchoredId} line ${lineOf(anchored)}`));
  assert.ok(drift.length >= familyRows.length + 1, 'all mismatches come from one call');
});

// One registered family with a statement and an anchor mismatch, a file whose
// bytes were never reviewed, a file whose blob lacks one row, and a file
// emptied to nothing, next to rows that must stay quiet (including a unicode
// statement).
function mismatchWorld() {
  const A = buf(['// a', "app.get('/one', handlerOne);", "app.get('/two', handlerTwo);", "app.get('/three', handlerThree);", "app.get('/ünï', handlerUni);"]);
  const B0 = buf(['b1 line', 'b2 line']);
  const B1 = buf(['b1 line changed', 'b2 line']);
  const C0 = buf(['one', 'two']);
  const C1 = buf(['one', 'TWO']);
  const D = Buffer.alloc(0);
  const family = (baseline, blobs) => ({ baseline: sha256(baseline), candidate: sha256(baseline), blobs });
  const snapshot = {
    priorInventories: {},
    canonical: {
      a1: { source: 'src/a.js:2', anchor: 'handlerOne' }, a2: { source: 'src/a.js:3', anchor: null },
      a3: { source: 'src/a.js:4', anchor: 'handlerMissing' }, a4: { source: 'src/a.js:5', anchor: null },
      b1: { source: 'src/b.js:1', anchor: null }, b2: { source: 'src/b.js:2', anchor: null },
      c1: { source: 'src/c.js:1', anchor: null }, c2: { source: 'src/c.js:2', anchor: null },
      d1: { source: 'src/d.js:1', anchor: null },
    },
    files: {
      'src/a.js': family(A, { [sha256(A)]: {
        a1: ref(2, "app.get('/one', handlerOne);", 'handlerOne'),
        a2: ref(3, "app.get('/two', handlerTWO);"),
        a3: ref(4, "app.get('/three', handlerThree);", 'handlerMissing'),
        a4: ref(5, "app.get('/ünï', handlerUni);"),
      } }),
      'src/b.js': family(B0, { [sha256(B0)]: { b1: ref(1, 'b1 line'), b2: ref(2, 'b2 line') } }),
      'src/c.js': family(C0, { [sha256(C0)]: { c1: ref(1, 'one'), c2: ref(2, 'two') }, [sha256(C1)]: { c1: ref(1, 'one') } }),
      'src/d.js': family(D, { [sha256(D)]: { d1: ref(1, 'x') } }),
    },
  };
  const rows = Object.entries(snapshot.canonical).map(([id, { source, anchor }]) => ({ id, source, ...(anchor ? { anchor } : {}) }));
  const readSource = sources({ 'src/a.js': A, 'src/b.js': B1, 'src/c.js': C1, 'src/d.js': D });
  const expected = [
    `MISSING_ROUTER_BLOB_ROW: src/c.js c2 ${sha256(C1)}`,
    'ROUTER_ANCHOR_NOT_ON_LINE: src/a.js a3 line 4',
    'ROUTER_STATEMENT_MISMATCH: src/a.js a2 line 3',
    'ROUTER_STATEMENT_MISMATCH: src/d.js d1 line 1',
    `UNREVIEWED_ROUTER_SOURCE: src/b.js b1 ${sha256(B1)}`,
    `UNREVIEWED_ROUTER_SOURCE: src/b.js b2 ${sha256(B1)}`,
  ];
  return { snapshot, rows, readSource, expected };
}

test('router source drift aggregation: unknown blob, missing blob row, statement and family anchor mismatches are each reported', () => {
  const { snapshot, rows, readSource, expected } = mismatchWorld();
  assert.deepEqual(collectRouterSourceDrift({ rows, readSource, snapshot }), expected);
});

test("router source drift aggregation: an unregistered file's anchored row whose anchor left its line is reported", () => {
  const text = buf(["// u", "if (pathname === '/x') {", 'other']);
  const rows = [
    { id: 'u1', source: 'src/u.js:2', anchor: "pathname === '/x'" },
    { id: 'u2', source: 'src/u.js:3', anchor: "pathname === '/y'" },
    { id: 'u3', source: 'src/u.js:0' },
    { id: 'u4', source: 'src/u.js:4' },
    { id: 'u5', source: 'src/u.js:x' },
    { id: 'u6', source: 'src/u.js:1' },
  ];
  const snapshot = { priorInventories: {}, canonical: {}, files: {} };
  assert.deepEqual(collectRouterSourceDrift({ rows, readSource: sources({ 'src/u.js': text }), snapshot }), [
    'ROUTER_ANCHOR_NOT_ON_LINE: src/u.js u2 line 3',
    'ROUTER_SOURCE_LINE_OUT_OF_RANGE: src/u.js u3 line 0',
    'ROUTER_SOURCE_LINE_OUT_OF_RANGE: src/u.js u4 line 4',
    'ROUTER_SOURCE_LINE_OUT_OF_RANGE: src/u.js u5 line x',
  ]);
});

// Prior rows, in order: s1 has no canonical entry, s2 sits in a family whose
// stage pointer names an unregistered blob, s3 lost its union anchor, s4's
// stage reference changed the prior anchor, and s5 (no family) must stay quiet.
function stageMapWorld() {
  const prior = [
    { id: 's1', source: 'src/s.js:1', anchor: null },
    { id: 's2', source: 'src/p.js:1', anchor: null },
    { id: 's3', source: 'src/s.js:2', anchor: 'anc' },
    { id: 's4', source: 'src/s.js:3', anchor: 'keep' },
    { id: 's5', source: 'src/t.js:1', anchor: null },
  ];
  return {
    priorInventories: { baseline: { rows: prior }, candidate: { rows: [] } },
    canonical: {
      s2: { source: 'src/p.js:1', anchor: null }, s3: { source: 'src/s.js:2', anchor: null },
      s4: { source: 'src/s.js:3', anchor: 'keep' }, s5: { source: 'src/t.js:1', anchor: null },
    },
    files: {
      'src/s.js': { baseline: 'good', candidate: 'good', blobs: { good: { s3: ref(2, 'x', 'anc'), s4: ref(3, 'x', 'changed') } } },
      'src/p.js': { baseline: 'dead', candidate: 'dead', blobs: {} },
    },
  };
}

test('router source drift aggregation: stage-map failures are reported with their legacy codes', () => {
  const expected = [
    'MISSING_ROUTER_OBLIGATION: src/p.js s2 stage baseline',
    'MISSING_ROUTER_OBLIGATION: src/s.js s1 stage baseline',
    'MISSING_UNION_ROUTER_ANCHOR: src/s.js s3 stage baseline',
    'PRIOR_ROUTER_ANCHOR_CHANGED: src/s.js s4 stage baseline',
  ];
  const snapshot = stageMapWorld();
  assert.deepEqual(collectRouterSourceDrift({ rows: [], readSource: sources({}), snapshot }), expected);
  assert.deepEqual(routerReferenceMapErrors(snapshot).map(entry => entry.code), ['MISSING_ROUTER_OBLIGATION', 'MISSING_ROUTER_OBLIGATION', 'MISSING_UNION_ROUTER_ANCHOR', 'PRIOR_ROUTER_ANCHOR_CHANGED']);
  assert.deepEqual(routerReferenceMapErrors(registry), [], 'the reviewed registry has no stage-map failure');
  // A row in the family whose baseline pointer dangles is reported per row, not thrown.
  const rows = [{ id: 's2', source: 'src/p.js:1' }];
  assert.deepEqual(collectRouterSourceDrift({ rows, readSource: sources({ 'src/p.js': buf(['x']) }), snapshot }), [...expected, 'UNMAPPED_ROUTER_REFERENCE: src/p.js s2'].sort());
});

test('router source drift aggregation: an unreadable source file is reported instead of thrown', () => {
  const calls = [];
  const readSource = file => {
    calls.push(file);
    if (file === 'src/gone.js') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (file === 'src/odd.js') throw new TypeError('no code');
    return buf(['fine']);
  };
  const rows = [
    { id: 'g1', source: 'src/gone.js:1' }, { id: 'g2', source: 'src/gone.js:2' },
    { id: 'o1', source: 'src/odd.js:1' }, { id: 'f1', source: 'src/fine.js:1' },
  ];
  const snapshot = { priorInventories: {}, canonical: {}, files: {} };
  assert.deepEqual(collectRouterSourceDrift({ rows, readSource, snapshot }), [
    'ROUTER_SOURCE_UNREADABLE: src/gone.js * ENOENT',
    'ROUTER_SOURCE_UNREADABLE: src/odd.js * TypeError',
  ]);
  assert.deepEqual(calls.sort(), ['src/fine.js', 'src/gone.js', 'src/odd.js'], 'each file is read once');
});

test('router source drift aggregation: output is sorted, deduplicated and independent of row order', () => {
  const { snapshot, rows, readSource, expected } = mismatchWorld();
  const run = list => collectRouterSourceDrift({ rows: list, readSource, snapshot });
  const out = run(rows);
  assert.deepEqual(out, expected);
  assert.deepEqual(out, [...out].sort());
  assert.equal(new Set(out).size, out.length);
  assert.deepEqual(run([...rows].reverse()), out);
  assert.deepEqual(run([...rows.slice(3), ...rows.slice(0, 3)]), out);
  assert.deepEqual(run([...rows, ...rows]), out);
  assert.deepEqual(run([...rows, ...rows].reverse()), out);
  assert.deepEqual(routerSourceDrift(), routerSourceDrift(), 'repeated calls on the checkout agree');
});

test('router source drift aggregation: the throwing wrappers still raise the first legacy message', () => {
  const row = routerInventoryBaseline.find(isFamily);
  const file = fileOf(row);
  const bytes = Buffer.concat([realBytes(file), Buffer.from('\n')]);
  // Unmapped identity first, although the source, anchor and bytes are wrong too.
  const unmapped = { ...row, id: 'unknown.get', source: `${file}:0`, anchor: 'wrong_dispatch' };
  assert.throws(() => resolveRouterSourceReference(unmapped, bytes), { name: 'AssertionError', message: 'UNMAPPED_ROUTER_REFERENCE: unknown.get' });
  assert.deepEqual(routerSourceReferenceErrors(unmapped, bytes).map(entry => entry.code), ['UNMAPPED_ROUTER_REFERENCE']);
  // Stale, then anchor, then bytes: one message from the wrapper, all three from the collector.
  const faulty = { ...row, source: `${file}:0`, anchor: 'wrong_dispatch' };
  assert.throws(() => resolveRouterSourceReference(faulty, bytes), { name: 'AssertionError', message: `STALE_ROUTER_REFERENCE: ${row.id}` });
  assert.deepEqual(routerSourceReferenceErrors(faulty, bytes).map(entry => entry.code), ['STALE_ROUTER_REFERENCE', 'MISMATCHED_ROUTER_ANCHOR', 'UNREVIEWED_ROUTER_SOURCE']);
  assert.deepEqual(routerSourceReferenceErrors({ ...row, source: 'src/unregistered.js:1' }, bytes), []);
  const snapshot = stageMapWorld();
  assert.throws(() => assertRouterReferenceMaps(snapshot), { name: 'AssertionError', message: 'MISSING_ROUTER_OBLIGATION: s1' });
  assert.equal(assertRouterReferenceMaps(registry), true);
});

// Synthetic bytes for every file of the real inventory such that every row
// resolves against a registry clone that has one extra, reviewed blob per
// family. It does not depend on the checkout's own drift.
function consistentWorld() {
  const snapshot = structuredClone(registry);
  const fragments = new Map();
  const put = (file, line, text) => {
    if (!fragments.has(file)) fragments.set(file, new Map());
    const byLine = fragments.get(file);
    byLine.set(line, [...(byLine.get(line) ?? []), text]);
  };
  for (const row of routerInventoryBaseline) {
    const file = fileOf(row);
    if (Object.hasOwn(snapshot.files, file)) {
      const family = snapshot.files[file];
      const reference = family.blobs[family.baseline][row.id];
      put(file, reference.line, reference.statement);
    } else put(file, Number(lineOf(row)), row.anchor ?? '');
  }
  const bytes = {};
  for (const [file, byLine] of fragments) {
    const text = Array(Math.max(...byLine.keys())).fill('');
    for (const [line, parts] of byLine) {
      const unique = [...new Set(parts)];
      text[line - 1] = Object.hasOwn(snapshot.files, file) ? unique[0] : unique.filter(Boolean).join(' ');
      if (Object.hasOwn(snapshot.files, file)) assert.equal(unique.length, 1, `${file}:${line} has one reviewed statement`);
    }
    bytes[file] = buf(text);
    if (Object.hasOwn(snapshot.files, file)) {
      const family = snapshot.files[file];
      family.blobs[sha256(bytes[file])] = structuredClone(family.blobs[family.baseline]);
    }
  }
  return { snapshot, bytes };
}

test('router source drift aggregation: a registry obligation inconsistency on a resolved row is reported', () => {
  const { snapshot, bytes } = consistentWorld();
  const readSource = sources(bytes);
  const run = (registrySnapshot, source = readSource) => collectRouterSourceDrift({ rows: routerInventoryBaseline, readSource: source, snapshot: registrySnapshot });
  // Positive control: the consistent world has no mismatch and no inconsistency.
  assert.deepEqual(run(snapshot), []);
  // An anchored canonical row whose new reviewed blob entry has no anchor.
  const target = routerInventoryBaseline.find(row => isFamily(row) && registry.canonical[row.id].anchor !== null);
  assert.ok(target, 'an anchored registered row exists');
  const broken = structuredClone(snapshot);
  broken.files[fileOf(target)].blobs[sha256(bytes[fileOf(target)])][target.id].anchor = null;
  const result = run(broken);
  assert.equal(result.length, 1, result.join('\n'));
  assert.match(result[0], /^ROUTER_OBLIGATION: UNION_ROUTER_ANCHOR_MISMATCH: /);
  assert.ok(result[0].endsWith(`: ${target.id}`), result[0]);
  // While other drift exists, the obligation fold-in is skipped.
  const other = routerInventoryBaseline.find(row => isFamily(row) && fileOf(row) !== fileOf(target));
  const drifted = run(broken, file => file === fileOf(other) ? Buffer.concat([bytes[file], Buffer.from('\n')]) : bytes[file]);
  assert.ok(drifted.length > 0 && drifted.every(line => !line.startsWith('ROUTER_OBLIGATION')), drifted.join('\n'));
});
