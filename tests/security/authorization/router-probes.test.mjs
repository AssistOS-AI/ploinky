import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { routerInventory, routerInventoryBaseline } from './router-inventory.mjs';
import { resolveRouterSourceReference, assertRouterInventoryObligations, assertRouterReferenceMaps } from './router-source-references.mjs';
import { inspectMarketplaceAuthorization, routerProbes, runRouterProbes, validateRouterAllowedResponse, validateRouterPrincipal } from './router-probes.mjs';
import { markerCommand, terminalFixtureNames } from './stream-probes.mjs';

test('Router inventory identities are unique and every source reference is a real executable line', () => {
  assert.equal(new Set(routerInventory.map(row => row.id)).size, routerInventory.length);
  for (const row of routerInventory) {
    const [file, line] = row.source.split(':');
    const source = fs.readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), 'utf8');
    assert.ok(/^\d+$/.test(String(line)) && Number(line) > 0 && Number(line) <= source.split('\n').length, row.source);
    // A row that names its handler statement must still point at it after
    // unrelated insertions shift the file.
    if (row.anchor) assert.ok(source.split('\n')[Number(line) - 1].includes(row.anchor), `${row.source} no longer contains ${row.anchor}`);
    assert.deepEqual(Object.keys(row.expected).sort(), ['admin', 'anonymous', 'selfRegistered', 'user']);
  }
});

test('Router source references reject stale metadata, wrong anchors, unknown blobs and unmapped identities', () => {
  for (const row of routerInventory) {
    const baseline = routerInventoryBaseline.find(candidate => candidate.id === row.id);
    const { source, anchor, sourceBlobSha256, ...contract } = row;
    const { source: originalSource, anchor: originalAnchor, ...originalContract } = baseline;
    assert.deepEqual(contract, originalContract, `${row.id} authority and coverage contract`);
  }
  for (const id of ['hardware-limits-read.get', 'marketplace-install_repo.post']) {
    const row = routerInventoryBaseline.find(candidate => candidate.id === id);
    const [file, line] = row.source.split(':');
    const bytes = fs.readFileSync(new URL(`../../../${file}`, import.meta.url));
    const resolved = resolveRouterSourceReference(row, bytes);
    assert.ok(resolved.sourceBlobSha256);
    assert.throws(() => resolveRouterSourceReference({ ...row, source: `${file}:${Number(line) - 1}` }, bytes), /STALE_ROUTER_REFERENCE/);
    assert.throws(() => resolveRouterSourceReference({ ...row, anchor: 'wrong_dispatch' }, bytes), /MISMATCHED_ROUTER_ANCHOR/);
    assert.throws(() => resolveRouterSourceReference({ ...row, id: 'unknown.get' }, bytes), /UNMAPPED_ROUTER_REFERENCE/);
    // Even an insertion preserving the reviewed dispatch statement requires a
    // new blob review. Do not search for the first convenient matching anchor.
    assert.throws(() => resolveRouterSourceReference(row, Buffer.concat([bytes, Buffer.from('\n')])), /UNREVIEWED_ROUTER_SOURCE/);
    const broken = Buffer.from(bytes.toString().replace(resolved.anchor, 'wrong_dispatch'));
    assert.throws(() => resolveRouterSourceReference(row, broken), /UNREVIEWED_ROUTER_SOURCE/);
  }
});

test('Router inventory retains the complete union of both prior inventories and refuses lost candidate anchors', () => {
  const snapshot = JSON.parse(fs.readFileSync(new URL('./router-reference-obligations_codex.json', import.meta.url)));
  assert.equal(snapshot.priorInventories.baseline.rows.length, 128);
  assert.equal(snapshot.priorInventories.candidate.rows.length, 128);
  assert.equal(snapshot.priorInventories.candidate.rows.filter(row => row.anchor).length, 43);
  assert.equal(routerInventory.filter(row => row.anchor).length, 43);
  assert.equal(assertRouterReferenceMaps(snapshot), true);
  assert.equal(assertRouterInventoryObligations(routerInventory), true);
  const id = 'webchat-directories-create.post';
  assert.throws(() => assertRouterInventoryObligations(routerInventory.filter(row => row.id !== id)), /MISSING_ROUTER_OBLIGATION/);
  assert.throws(() => assertRouterInventoryObligations(routerInventory.map(row => row.id === id ? { ...row, anchor: undefined } : row)), /MISSING_UNION_ROUTER_ANCHOR/);
  const lost = structuredClone(snapshot);
  lost.canonical[id].anchor = null;
  assert.throws(() => assertRouterReferenceMaps(lost), /MISSING_UNION_ROUTER_ANCHOR/);
  const weakened = structuredClone(snapshot);
  const file = 'cli/server/static/index.js';
  weakened.files[file].blobs[weakened.files[file].candidate]['web-libs.get'].anchor = 'function serveWebLibRequest';
  assert.throws(() => assertRouterReferenceMaps(weakened), /PRIOR_ROUTER_ANCHOR_CHANGED/);
});

test('A redirect, missing endpoint, or 200 error cannot satisfy authorized positive control', () => {
  const probe = routerProbes.find(row => row.id === 'users-list.allow');
  const good = { status: 200, json: { ok: true, users: [], availableRoles: [] } };
  assert.equal(validateRouterAllowedResponse(probe, good).ok, true);
  for (const response of [
    { status: 302, headers: { location: '/auth/login' }, text: 'login' },
    { status: 404, json: { error: 'not_found' } },
    { status: 200, json: { ok: false, users: [], availableRoles: [], error: 'denied' } },
    { status: 200, text: '<html>login</html>' },
    { status: 200, json: { ok: true, users: {} } },
  ]) assert.equal(validateRouterAllowedResponse(probe, response).ok, false);
});

test('Incorrect principal, guest substitution and stale promoted role fail identity check', () => {
  const principal = { id: 'fixture-self', roles: ['selfRegistered'] };
  assert.equal(validateRouterPrincipal({ user: principal }, principal), true);
  for (const user of [
    { id: 'fixture-other', roles: ['selfRegistered'] },
    { id: 'fixture-self', roles: ['guest'] },
    { id: 'fixture-self', roles: ['user'] },
    { id: 'fixture-self', roles: ['admin'] },
  ]) assert.equal(validateRouterPrincipal({ user }, principal), false);
});

test('Unprivileged source path disclosure is regression failure, never normalized as catalog access', () => {
  const principal = { id: 'fixture-self', roles: ['selfRegistered'] };
  const response = source => ({ ok: true, marketplace: {
    user: principal, permissions: { canManage: false }, agents: [],
    repositories: [{ skillSource: { source, origin: 'installed' } }],
  } });
  for (const source of ['/Users/danielsava/work/testExplorerFresh/.ploinky/repos/Skills', 'C:\\workspace\\Skills']) {
    const issues = inspectMarketplaceAuthorization(response(source), principal);
    assert.ok(issues.some(issue => issue.includes('absolute local filesystem path')));
    assert.ok(!JSON.stringify(issues).includes(source), 'Finding must not echo path values');
  }
  assert.deepEqual(inspectMarketplaceAuthorization(response('https://example.invalid/Skills.git'), principal), []);
  assert.ok(inspectMarketplaceAuthorization({ ...response('opaque'), marketplace: { ...response('opaque').marketplace, permissions: { canManage: true } } }, principal).length);
});

test('Every dependent denial references a concrete authorized probe; read-only commands only', () => {
  for (const probe of routerProbes) {
    if (probe.positiveControl) assert.ok(routerProbes.some(candidate => candidate.id === probe.positiveControl && candidate.expect === 'allow'), probe.id);
    if (probe.method === 'POST') assert.ok(['http.route.list', 'http.route.check', 'mcp.policy.list'].includes(probe.body?.command));
    if (probe.boundaryRejectionStatuses) assert.ok(!probe.statuses.includes(404), 'Missing resource cannot count as denial');
  }
});

function fakeContext(response) {
  const ctx = { report: {}, principals: {}, requests: [], failures: [], gaps: [],
    async request(actor, options) { ctx.requests.push({ actor, ...options }); return response; },
    async check(id, fn) { try { await fn(); } catch (error) { ctx.failures.push({ id, error }); } },
    recordGap(id, reason) { ctx.gaps.push({ id, reason }); },
  };
  return ctx;
}

test('Failed positive control never becomes a passed authorization denial; both ordinary users are expanded', async () => {
  const selected = routerProbes.filter(probe => ['health.allow', 'health.deny'].includes(probe.id));
  const ctx = fakeContext({ status: 404, json: { error: 'missing' } });
  await runRouterProbes(ctx, { probes: selected });
  assert.equal(ctx.requests.length, 1, 'Dependent denied probes must not run without a positive control');
  assert.equal(ctx.failures.length, 1, 'Positive-control failure must remain visible');
  assert.equal(ctx.gaps.length, 4, 'anonymous, selfRegistered and both ordinary users must receive explicit gaps');
  assert.deepEqual(ctx.report.routerCoverage.filter(row => row.status === 'CONTROL_UNAVAILABLE').map(row => row.actor).sort(), ['anonymous', 'selfRegistered', 'userA', 'userB']);
});

test('Path rejection remains boundary-only evidence, never an authorization pass', async () => {
  const ctx = fakeContext({ status: 404, json: { error: 'not_found' } });
  await runRouterProbes(ctx, { probes: [{
    id: 'boundary', method: 'GET', path: '/invalid-normalized-path', roles: ['user'],
    expect: 'deny', statuses: [401, 403], boundaryRejectionStatuses: [400, 404],
  }] });
  assert.equal(ctx.failures.length, 0);
  assert.equal(ctx.gaps.length, 2);
  assert.ok(ctx.report.routerCoverage.every(row => row.status === 'BOUNDARY_REJECTED_ONLY'));
});

test('Terminal fixture and marker command reject shell/path injection before any mutation', () => {
  const prefix = 'authz-12345678-abcd';
  const fixture = terminalFixtureNames(prefix);
  assert.equal(fixture.host, `/Users/danielsava/work/testExplorerFresh/${prefix}-terminal`);
  assert.equal(fixture.container, fixture.host);
  assert.equal(markerCommand(prefix, `${prefix}-positive`), `printf '%s\\n' '${prefix}-positive' > '/Users/danielsava/work/testExplorerFresh/${prefix}-terminal/marker.txt'\n`);
  for (const value of ['../escape', 'authz-1234;id', 'authz-1234$(id)', 'authz-1234/../escape', "authz-1234'quoted", 'authz-1234\nline']) {
    assert.throws(() => terminalFixtureNames(value), /shell-safe/);
    assert.throws(() => markerCommand(prefix, value), /generated literal/);
  }
});
