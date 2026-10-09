import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routerInventory, routerInventoryBaseline } from './router-inventory.mjs';
import { resolveRouterSourceReference, assertRouterInventoryObligations, assertRouterReferenceMaps } from './router-source-references.mjs';
import { inspectMarketplaceAuthorization, routerProbes, runRouterProbes, validateRouterAllowedResponse, validateRouterPrincipal } from './router-probes.mjs';
import { assertNoWorkspaceDisclosure, markerCommand, runWebchatUploadDenialProof, runWorkspaceWriteMatrix, terminalFixtureNames, workspaceWriteCheckDefinitions, workspaceWriteMatrix, workspaceWriteRequest } from './stream-probes.mjs';

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
  // The controls run for every row of every registered file family, so a family
  // added to the reviewed registry cannot be left without them.
  const registry = JSON.parse(fs.readFileSync(new URL('./router-reference-obligations.json', import.meta.url)));
  const covered = new Set();
  for (const row of routerInventoryBaseline) {
    const [file, line] = row.source.split(':');
    if (!Object.hasOwn(registry.files, file)) continue;
    covered.add(file);
    const bytes = fs.readFileSync(new URL(`../../../${file}`, import.meta.url));
    const resolved = resolveRouterSourceReference(row, bytes);
    assert.ok(resolved.sourceBlobSha256, row.id);
    assert.throws(() => resolveRouterSourceReference({ ...row, source: `${file}:${Number(line) - 1}` }, bytes), /STALE_ROUTER_REFERENCE/, row.id);
    assert.throws(() => resolveRouterSourceReference({ ...row, anchor: 'wrong_dispatch' }, bytes), /MISMATCHED_ROUTER_ANCHOR/, row.id);
    assert.throws(() => resolveRouterSourceReference({ ...row, id: 'unknown.get' }, bytes), /UNMAPPED_ROUTER_REFERENCE/, row.id);
    // Even an insertion preserving the reviewed dispatch statement requires a
    // new blob review. Do not search for the first convenient matching anchor.
    assert.throws(() => resolveRouterSourceReference(row, Buffer.concat([bytes, Buffer.from('\n')])), /UNREVIEWED_ROUTER_SOURCE/, row.id);
    // Break the reviewed anchor; a row without an anchor breaks its reviewed
    // statement instead, and a blank reviewed line is replaced as a whole. The
    // mutation must change the bytes, or the control is vacuous.
    const reference = registry.files[file].blobs[resolved.sourceBlobSha256][row.id];
    const needle = resolved.anchor ?? reference.statement;
    const sourceLines = bytes.toString().split('\n');
    const reviewedLine = sourceLines[reference.line - 1];
    assert.ok(!needle || reviewedLine.includes(needle), `${row.id} reviewed text is on its reviewed line`);
    sourceLines[reference.line - 1] = needle ? reviewedLine.replace(needle, 'wrong_dispatch') : 'wrong_dispatch';
    const broken = Buffer.from(sourceLines.join('\n'));
    assert.notDeepEqual(broken, bytes, row.id);
    assert.throws(() => resolveRouterSourceReference(row, broken), /UNREVIEWED_ROUTER_SOURCE/, row.id);
  }
  assert.deepEqual([...covered].sort(), Object.keys(registry.files).sort(), 'every registered file family is exercised');
  // Ratchet: reviewed entries whose statement is blank cannot prove that the
  // dispatch line is the reviewed one. Two such entries predate the 2026-10-08
  // additions (see router-reference-review-2026-10-08.md); no new one may appear.
  const blankStatements = Object.entries(registry.files).flatMap(([file, family]) => Object.entries(family.blobs)
    .flatMap(([hash, rows]) => Object.entries(rows).filter(([, reference]) => !reference.statement.trim())
      .map(([id]) => `${file} ${hash.slice(0, 8)} ${id}`)));
  assert.deepEqual(blankStatements, [
    'cli/server/RoutingServer.js 27fb848d internal-agent-control.*',
    'cli/server/handlers/webtty.js 0c0d70d8 webtty-input.post',
  ]);
});

test('Router inventory retains the complete union of both prior inventories and refuses lost candidate anchors', () => {
  const snapshot = JSON.parse(fs.readFileSync(new URL('./router-reference-obligations.json', import.meta.url)));
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

test('Workspace write matrix has the exact reviewed identities and counts', () => {
  const { positives, denials } = workspaceWriteMatrix();
  const ids = [...positives, ...denials].map(row => row.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(positives.length, 7);
  assert.equal(denials.length, 61);
  assert.equal(denials.filter(row => row.operation === 'sink-upload').length, 25);
  assert.equal(denials.filter(row => row.operation !== 'sink-upload' && ['anonymous', 'selfRegistered'].includes(row.actor)).length, 24);
  assert.equal(denials.filter(row => row.operation !== 'sink-upload' && row.actor === 'userA').length, 12);
  for (const selector of ['default', 'authorization-suite-nonexistent', 'userPersistoAgent', 'webAssist', 'webmeetAgent']) {
    for (const pair of ['anonymous:absent', 'selfRegistered:absent', 'selfRegistered:valid', 'userA:absent', 'userA:invalid']) {
      assert.ok(ids.includes(`router:workspace-upload-deny:${pair}:${selector}`), `${pair}:${selector}`);
    }
  }
  // GET/HEAD reads are never denied merely for a missing or invalid proof.
  assert.equal(denials.some(row => ['directory-list', 'suggestions'].includes(row.operation) && row.actor === 'userA'), false);
  for (const operation of ['upload', 'directory-create']) for (const proof of ['absent', 'invalid']) for (const selector of ['default', 'webAssist', 'webmeetAgent']) {
    assert.ok(ids.includes(`router:webchat-${operation}-deny:userA:${proof}:${selector}`));
  }
});

test('Workspace write requests carry the declared proof, selector and a distinct payload', () => {
  const fixture = { directory: 'authz-12345678-abcd-terminal', host: '/tmp/unused' };
  const { denials } = workspaceWriteMatrix();
  const absent = workspaceWriteRequest(denials.find(row => row.id === 'router:workspace-upload-deny:userA:absent:webAssist'), fixture, 'p-1');
  assert.equal(absent.proof, false);
  assert.equal(absent.headers.origin, undefined);
  assert.match(absent.path, /^\/upload\?path=authz-12345678-abcd-terminal%2Ffixture\.txt&agent=webAssist$/);
  assert.equal(absent.body, 'p-1');
  const invalid = workspaceWriteRequest(denials.find(row => row.id === 'router:webchat-upload-deny:userA:invalid:default'), fixture, 'p-2');
  assert.equal(invalid.proof, false);
  assert.equal(invalid.headers.origin, 'http://127.0.0.1:8080');
  assert.match(invalid.headers['x-ploinky-browser-csrf-token'], /^v2\.authorization-suite-invalid-/);
  assert.equal(invalid.headers['x-overwrite'], '1');
  assert.equal(invalid.path, '/webchat/uploads');
  const valid = workspaceWriteRequest(denials.find(row => row.id === 'router:workspace-upload-deny:selfRegistered:valid:default'), fixture, 'p-3');
  assert.equal(valid.proof, true);
  const read = workspaceWriteRequest(denials.find(row => row.id === 'router:webchat-suggestions-deny:anonymous:webmeetAgent'), fixture, '');
  assert.equal(read.method, 'GET');
  assert.equal(read.body, undefined);
  assert.match(read.path, /&agent=webmeetAgent$/);
});

async function writeMatrixFixture(t) {
  const host = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'authz-write-matrix-'));
  t.after(() => fsPromises.rm(host, { recursive: true, force: true }));
  const fixture = { directory: path.basename(host), host };
  const filename = path.join(host, 'fixture.txt');
  await fsPromises.writeFile(filename, 'baseline');
  return { fixture, filename };
}

function matrixContext(handler) {
  const ctx = { prefix: 'authz-matrix', report: { checks: [] }, gaps: [], bodies: [],
    async request(actor, options) { if (options.body !== undefined) ctx.bodies.push(JSON.stringify(options.body)); return handler(actor, options); },
    async check(id, fn) { try { await fn(); ctx.report.checks.push({ id, status: 'PASS' }); } catch (error) { ctx.report.checks.push({ id, status: 'FAIL', error: error.message }); } },
    recordGap(id, reason) { ctx.gaps.push({ id, reason }); },
  };
  return ctx;
}

function fakeRouter(fixture, filename, { leakingId = '' } = {}) {
  return async (actor, options) => {
    const isWrite = options.method === 'PUT' || (options.method === 'POST' && options.path.startsWith('/webchat/uploads'));
    const allowed = actor === 'admin' || (actor === 'userA' && (options.method === 'GET' || options.proof === true));
    if (options.path.startsWith('/workspace-files/')) {
      const text = await fsPromises.readFile(filename, 'utf8');
      return { status: 200, text, headers: {} };
    }
    if (!allowed && !(leakingId && options.path.includes(leakingId))) {
      // The Router's generic 401 (authContext.js respondUnauthenticated): the login URL echoes the caller's own request path.
      const body = { ok: false, error: 'not_authenticated', login: `/auth/login?${new URLSearchParams({ returnTo: options.path, agent: 'explorer' })}` };
      return { status: 401, text: JSON.stringify(body), json: body, headers: {} };
    }
    if (isWrite) {
      await fsPromises.writeFile(filename, options.body);
      return { status: options.method === 'PUT' ? 200 : 201, text: '{"ok":true}', json: { ok: true }, headers: {} };
    }
    if (options.method === 'POST') {
      await fsPromises.mkdir(path.join(fixture.host, path.basename(options.body.path)));
      return { status: 201, text: '{"ok":true}', json: { ok: true }, headers: {} };
    }
    return { status: 200, text: '{"ok":true,"entries":[{"name":"fixture.txt"}]}', json: { ok: true }, headers: {} };
  };
}

test('Write matrix passes only with changed bytes and unchanged hashes under distinct payloads', async t => {
  const { fixture, filename } = await writeMatrixFixture(t);
  const ctx = matrixContext(fakeRouter(fixture, filename));
  await runWorkspaceWriteMatrix(ctx, fixture, filename);
  const failed = ctx.report.checks.filter(check => check.status !== 'PASS');
  assert.deepEqual(failed, []);
  assert.equal(ctx.report.checks.length, 68);
  assert.deepEqual(ctx.report.checks.map(check => check.id).sort(), workspaceWriteCheckDefinitions().map(definition => definition.id).sort(), 'the run records exactly the mandatory identities, once each');
  assert.equal(ctx.gaps.length, 0);
  assert.equal(new Set(ctx.bodies).size, ctx.bodies.length, 'every write and denial sends a distinct payload');
});

// The Router's generic 401 echoes the caller's own request path in `login`; that echo is not a listing.
const ownPath = '/upload?path=authz-x-terminal%2Ffixture.txt&agent=webAssist';
const routerLogin = (returnTo, extra = {}) => {
  const body = { ok: false, error: 'not_authenticated', login: `/auth/login?${new URLSearchParams({ returnTo, agent: 'explorer' })}`, ...extra };
  return { status: 401, text: JSON.stringify(body), json: body, headers: {} };
};

test('disclosure predicate: the Router login echo of the caller\'s own path passes, a listing or fixture content fails', () => {
  const opts = { requestPath: ownPath, fixtureText: 'authz-x-sink-positive-3' };
  assert.doesNotThrow(() => assertNoWorkspaceDisclosure(routerLogin(ownPath), opts), 'the exact Router 401 body');
  assert.doesNotThrow(() => assertNoWorkspaceDisclosure({ status: 403, text: '{"ok":false,"error":"admin_required"}' }, opts));
  assert.doesNotThrow(() => assertNoWorkspaceDisclosure({ status: 403, json: { ok: false, error: 'forbidden' } }, opts), 'json-only response');
  for (const [label, response] of [
    ['entries array', routerLogin(ownPath, { entries: [{ name: 'fixture.txt', type: 'file' }] })],
    ['listing key with names', routerLogin(ownPath, { files: ['a', 'b'] })],
    ['nested listing key', routerLogin(ownPath, { data: { items: [] } })],
    ['entry objects under an arbitrary key', routerLogin(ownPath, { data: [{ name: 'x' }] })],
    ['fixture name in a message', routerLogin(ownPath, { message: 'found fixture.txt' })],
    ['fixture bytes', routerLogin(ownPath, { detail: 'authz-x-sink-positive-3' })],
    ['returnTo naming another path', routerLogin('/webchat/directories?path=authz-x-terminal%2Ffixture.txt')],
    ['returnTo naming no path of this request', routerLogin('/upload')],
    ['login that is not the login page', { status: 401, text: '{"ok":false,"login":"https://evil.invalid/auth/login"}' }],
    ['fixture name leaking through another login parameter', { status: 401, text: JSON.stringify({ ok: false, login: `/auth/login?${new URLSearchParams({ returnTo: ownPath, hint: 'fixture.txt' })}` }) }],
    ['fixture name as an object key', routerLogin(ownPath, { tree: { 'fixture.txt': { bytes: 23 } } })],
    ['fixture path as a top-level key', { status: 401, text: JSON.stringify({ 'authz-x-terminal/fixture.txt': 'file' }) }],
    ['fixture bytes as an object key', routerLogin(ownPath, { seen: { 'authz-x-sink-positive-3': true } })],
    ['text listing without a JSON body', { status: 403, text: 'fixture.txt' }],
    ['listing only in text while json is stripped', { status: 403, json: { ok: false }, text: '{"ok":false,"entries":[{"name":"fixture.txt"}]}' }],
  ]) assert.throws(() => assertNoWorkspaceDisclosure(response, opts), /disclosed a workspace listing/, label);
});

test('A failed positive control turns its dependents into gaps and a changed fixture fails the denial', async t => {
  const { fixture, filename } = await writeMatrixFixture(t);
  const broken = matrixContext(async () => ({ status: 503, text: '{}', json: { ok: false, error: 'unavailable' }, headers: {} }));
  await runWorkspaceWriteMatrix(broken, fixture, filename);
  assert.equal(broken.report.checks.some(check => check.status === 'PASS' && /-deny:/.test(check.id)), false);
  assert.equal(broken.gaps.length, 61);
  assert.deepEqual(broken.gaps.map(gap => gap.id).sort(), workspaceWriteMatrix().denials.map(row => row.id).sort(), 'every unavailable denial is reported under its own mandatory identity');
  assert.ok(broken.gaps.every(gap => gap.reason.startsWith('positive-unavailable')));

  const second = await writeMatrixFixture(t);
  const leaking = matrixContext(fakeRouter(second.fixture, second.filename, { leakingId: 'agent=webAssist' }));
  await runWorkspaceWriteMatrix(leaking, second.fixture, second.filename);
  const leaked = leaking.report.checks.filter(check => check.status === 'FAIL').map(check => check.id);
  assert.ok(leaked.includes('router:workspace-upload-deny:anonymous:absent:webAssist'));
  assert.ok(leaked.includes('router:webchat-upload-deny:anonymous:webAssist'));
  assert.ok(leaked.includes('router:webchat-directory-create-deny:selfRegistered:webAssist'));
  assert.equal(leaked.some(id => !id.endsWith('webAssist')), false);
});

test('Focused pre-fix proof runs one WebChat upload denial and reports a changed owned file as FAIL', async t => {
  for (const vulnerable of [true, false]) {
    const { fixture, filename } = await writeMatrixFixture(t);
    await fsPromises.rm(filename);
    const ctx = matrixContext(async (actor, options) => {
      assert.equal(actor, 'anonymous');
      assert.equal(options.method, 'POST');
      assert.equal(options.path, '/webchat/uploads?agent=webAssist');
      assert.equal(options.headers['x-overwrite'], '1');
      if (vulnerable) {
        await fsPromises.writeFile(filename, options.body);
        return { status: 201, text: '{"ok":true}', json: { ok: true }, headers: {} };
      }
      return { status: 401, text: '{"ok":false,"error":"not_authenticated"}', json: { ok: false, error: 'not_authenticated' }, headers: {} };
    });
    ctx.guard = async () => ({});
    await runWebchatUploadDenialProof(ctx, { register: async () => fixture });
    assert.equal(ctx.report.checks.length, 1);
    assert.equal(ctx.report.checks[0].id, 'router:webchat-upload-deny:anonymous:webAssist');
    assert.equal(ctx.report.checks[0].status, vulnerable ? 'FAIL' : 'PASS');
    assert.equal(ctx.report.focusedProof.fixtureChanged, vulnerable);
    assert.equal(ctx.report.focusedProof.fixtureHoldsDenialPayload, vulnerable);
  }
});
