import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { routerInventory } from './router-inventory.mjs';
import { inspectMarketplaceAuthorization, routerProbes, runRouterProbes, validateRouterAllowedResponse, validateRouterPrincipal } from './router-probes.mjs';
import { markerCommand, terminalFixtureNames } from './stream-probes.mjs';

test('Router inventory identities are unique and every source reference is a real executable line', () => {
  assert.equal(new Set(routerInventory.map(row => row.id)).size, routerInventory.length);
  for (const row of routerInventory) {
    const [file, line] = row.source.split(':');
    const source = fs.readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), 'utf8');
    assert.ok(Number(line) > 0 && Number(line) <= source.split('\n').length, row.source);
    assert.deepEqual(Object.keys(row.expected).sort(), ['admin', 'anonymous', 'selfRegistered', 'user']);
  }
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
  for (const source of ['/workspace/.ploinky/repos/Skills', 'C:\\workspace\\Skills']) {
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
  assert.equal(markerCommand(prefix, `${prefix}-positive`), `printf '%s\\n' '${prefix}-positive' > '/workspace/${prefix}-terminal/marker.txt'\n`);
  for (const value of ['../escape', 'authz-1234;id', 'authz-1234$(id)', 'authz-1234/../escape', "authz-1234'quoted", 'authz-1234\nline']) {
    assert.throws(() => terminalFixtureNames(value), /shell-safe/);
    assert.throws(() => markerCommand(prefix, value), /generated literal/);
  }
});
