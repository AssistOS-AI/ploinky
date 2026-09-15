/** Safe Router probes. The runner supplies credentials and never follows redirects. */
import assert from 'node:assert/strict';
const roles = ['anonymous', 'selfRegistered', 'user', 'admin'];
const nonAdmins = roles.filter(role => role !== 'admin');
const probes = [];
function pair(id, method, path, options = {}) {
  const { allowed = ['admin'], ...rest } = options;
  probes.push({ id: `${id}.allow`, inventoryId: `${id}.${method.toLowerCase()}`, method, path,
    roles: allowed, expect: 'allow', status: 200, ...rest });
  const denied = roles.filter(role => !allowed.includes(role));
  if (denied.length) probes.push({ id: `${id}.deny`, inventoryId: `${id}.${method.toLowerCase()}`, method, path,
    roles: denied, expect: 'deny', statuses: [401, 403],
    positiveControl: `${id}.allow`, ...rest });
}

pair('health', 'GET', '/health', { jsonEquals: { status: 'healthy' } });
pair('users-list', 'GET', '/api/agents/explorer/users?pageSize=1', { jsonEquals: { ok: true }, jsonArrayKeys: ['users', 'availableRoles'] });
pair('status', 'GET', '/status/data', { inventoryId: 'status.*', jsonKeys: ['workspace', 'servers', 'static', 'runtimes'] });
pair('webtty-ui', 'GET', '/webtty/', { contentType: 'text/html', textIncludes: ['<html'], availabilityFailure: 'Do not accept 503 as denial; terminal manager/backend may be unavailable.' });
pair('marketplace-read', 'GET', '/api/marketplace', {
  allowed: ['selfRegistered', 'user', 'admin'], jsonEquals: { ok: true }, jsonKeys: ['marketplace'],
  assertions: ['marketplace.user.id equals verified current principal', 'marketplace.permissions.canManage is true only for admin', 'unprivileged skillSource.source contains no absolute local path'],
});
pair('auth-token', 'GET', '/auth/token?agent=explorer', {
  allowed: ['selfRegistered', 'user', 'admin'], jsonEquals: { ok: true }, jsonKeys: ['user', 'browserMutation'],
  privateResponse: true, assertions: ['user.id and roles equal independently verified principal'],
});
for (const [command, key] of [['http.route.list', 'httpRoutes'], ['mcp.policy.list', 'mcpTools']]) {
  pair(`policy-${command}`, 'POST', '/policy/command', {
    body: { command }, jsonEquals: { ok: true }, jsonArrayKeys: [key],
    safety: 'Read-only command; policy invoker intentionally does not require CSRF for reads.',
  });
}
pair('policy-http.route.check', 'POST', '/policy/command', {
  body: { command: 'http.route.check', path: '/explorer/index.html', method: 'GET' },
  jsonEquals: { ok: true, path: '/explorer/index.html', method: 'GET' }, jsonKeys: ['decision'],
});
probes.push({ id: 'agent-card.allow', inventoryId: 'agent-card.get', method: 'GET', path: '/agent-card', roles,
  expect: 'allow', status: 200, jsonArrayKeys: ['agents', 'errors'],
  assertions: ['errors must be inspected and surfaced; incomplete fanout does not imply endpoint coverage'],
});
probes.push({ id: 'mcp-browser-client.allow', inventoryId: 'mcp-browser-client.get', method: 'GET', path: '/MCPBrowserClient.js', roles,
  expect: 'allow', status: 200, textIncludes: ['MCPBrowserClient'],
});
probes.push({ id: 'auth-logged-out.allow', inventoryId: 'auth-logged-out.get', method: 'GET', path: '/auth/logged-out', roles,
  expect: 'allow', status: 200, contentType: 'text/html', textIncludes: ['<html'],
});
probes.push({ id: 'openai-agent-discovery.browser-deny', inventoryId: 'openai-agent-discovery.get', method: 'GET', path: '/api/router/openai-agent-discovery', roles,
  expect: 'deny', statuses: [401], denyJsonEquals: { complete: false, error: 'agent_assertion_required' },
  positiveControl: null, coverage: 'browser-negative-only', gap: 'Positive signed-agent control is isolated-test-only; no deployed agent credentials borrowed.',
});

const forgedHeaders = {
  'x-ploinky-user-id': 'authorization-suite-forged-admin',
  'x-ploinky-user': 'authorization-suite-forged-admin',
  'x-ploinky-user-roles': 'admin',
  'x-ploinky-user-email': 'authorization-suite-forged-admin@example.invalid',
  'x-ploinky-auth-info': JSON.stringify({ user: { id: 'authorization-suite-forged-admin', roles: ['admin'], capabilities: ['admin.users.manage', 'explorer.access'] } }),
  'x-ploinky-user-delegation': 'authorization-suite-invalid-delegation',
  'x-ploinky-agent-assertion': 'authorization-suite-invalid-assertion',
  'x-user-id': 'authorization-suite-forged-admin',
  'x-user-role': 'admin',
};
for (const [id, path, positiveControl] of [
  ['users-list', '/api/agents/explorer/users?pageSize=1', 'users-list.allow'],
  ['health', '/health', 'health.allow'],
  ['status', '/status/data', 'status.allow'],
]) probes.push({ id: `${id}.forged-identity-deny`, inventoryId: `${id}.${id === 'status' ? '*' : 'get'}`, method: 'GET', path,
  roles: nonAdmins, expect: 'deny', statuses: [401, 403], headers: forgedHeaders, positiveControl,
});
probes.push({ id: 'policy-http.route.list.forged-identity-deny', inventoryId: 'policy-http.route.list.post', method: 'POST', path: '/policy/command',
  body: { command: 'http.route.list' }, roles: nonAdmins, expect: 'deny', statuses: [401, 403], headers: forgedHeaders,
  positiveControl: 'policy-http.route.list.allow',
});
probes.push({ id: 'openai-agent-discovery.forged-assertion-deny', inventoryId: 'openai-agent-discovery.get', method: 'GET', path: '/api/router/openai-agent-discovery',
  roles, expect: 'deny', statuses: [401], headers: { authorization: 'Bearer authorization-suite-invalid-assertion', ...forgedHeaders },
  denyJsonEquals: { complete: false, error: 'agent_assertion_required' }, positiveControl: null,
  coverage: 'browser-negative-only', gap: 'No valid agent assertion minted against live deployment.',
});

// These raw paths MUST use node:http request({path}), never URL normalization or
// automatic redirect handling. A route rejection is a separate boundary check,
// not proof that an existing protected resource denied this principal.
for (const [name, path] of [
  ['duplicate-slash', '/api//agents/explorer/users?pageSize=1'],
  ['dot-segment', '/api/agents/explorer/./users?pageSize=1'],
  ['parent-segment', '/api/agents/explorer/probe/../users?pageSize=1'],
  ['encoded-owner', '/api/agents/%65xplorer/users?pageSize=1'],
  ['encoded-resource', '/api/agents/explorer/%75sers?pageSize=1'],
  ['encoded-parent', '/api/agents/explorer/probe/%2e%2e/users?pageSize=1'],
  ['encoded-slash', '/api/agents/explorer%2fusers?pageSize=1'],
  ['double-encoded-slash', '/api/agents/explorer%252fusers?pageSize=1'],
]) probes.push({ id: `users-list.path-${name}`, inventoryId: 'users-list.get', method: 'GET', path,
  rawPath: true, roles: nonAdmins, expect: 'deny', statuses: [401, 403],
  boundaryRejectionStatuses: [400, 404, 405, 421], positiveControl: 'users-list.allow',
  coverage: 'normalization-boundary',
  assertions: ['Any 200 users payload for non-admin is failure; 404 is boundary rejection only and never promoted to an authorization pass.'],
});
for (const [name, headers] of [
  ['role-override', { 'x-http-method-override': 'GET', 'x-method-override': 'GET' }],
  ['forwarded-identity', { forwarded: 'for=127.0.0.1;host=127.0.0.1;proto=http', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': '127.0.0.1:8080', 'x-forwarded-user': 'admin' }],
]) probes.push({ id: `users-list.${name}-deny`, inventoryId: 'users-list.get', method: 'GET', path: '/api/agents/explorer/users?pageSize=1',
  roles: nonAdmins, headers, expect: 'deny', statuses: [401, 403], positiveControl: 'users-list.allow',
});

export const routerProbes = Object.freeze(probes.map(probe => Object.freeze(probe)));

/** Pure shape assertion; runner owns status/denial/role checks and sanitization. */
export function validateRouterAllowedResponse(probe, response) {
  const errors = [];
  const status = response.status ?? response.statusCode;
  if (status !== (probe.status ?? 200)) errors.push(`expected status ${probe.status ?? 200}, received ${status}`);
  if (status >= 300 && status < 400) errors.push('redirect is never an allowed response');
  const json = response.json;
  const headers = response.headers ?? {};
  const contentType = headers['content-type'] ?? headers.get?.('content-type') ?? '';
  if (probe.contentType && !String(contentType).includes(probe.contentType)) errors.push('content type did not match');
  for (const key of probe.jsonKeys ?? []) if (!json || !Object.hasOwn(json, key)) errors.push(`missing JSON key ${key}`);
  for (const key of probe.jsonArrayKeys ?? []) if (!Array.isArray(json?.[key])) errors.push(`expected JSON array ${key}`);
  for (const [key, value] of Object.entries(probe.jsonEquals ?? {})) if (JSON.stringify(json?.[key]) !== JSON.stringify(value)) errors.push(`JSON field ${key} did not match`);
  for (const value of probe.textIncludes ?? []) if (!String(response.text ?? response.body ?? '').includes(value)) errors.push('expected response marker absent');
  if (json && (json.error || json.ok === false)) errors.push('error body cannot satisfy an allowed probe');
  return { ok: errors.length === 0, errors };
}

/** Never include path values, identity values, or credential-bearing data in findings. */
export function inspectMarketplaceAuthorization(json, principal) {
  const issues = [];
  const marketplace = json?.marketplace;
  if (!marketplace || json?.ok !== true) return ['marketplace response missing'];
  if (!principal?.id || marketplace.user?.id !== principal.id) issues.push('marketplace returned an incorrect principal');
  const admin = principal?.roles?.includes('admin') === true;
  if (marketplace.permissions?.canManage !== admin) issues.push('management permission does not match verified role');
  if (!Array.isArray(marketplace.repositories) || !Array.isArray(marketplace.agents)) issues.push('marketplace inventory arrays missing');
  if (!admin) {
    for (const repository of marketplace.repositories ?? []) {
      const source = repository?.skillSource?.source;
      if (typeof source === 'string' && (/^\//.test(source) || /^[A-Za-z]:[\\/]/.test(source))) {
        issues.push('unprivileged skillSource.source discloses an absolute local filesystem path');
      }
    }
  }
  return [...new Set(issues)];
}

export function validateRouterPrincipal(json, principal) {
  return Boolean(principal?.id && json?.user?.id === principal.id
    && JSON.stringify([...(json.user.roles ?? [])].sort()) === JSON.stringify([...(principal.roles ?? [])].sort()));
}

/**
 * Runner contract:
 * - ctx.request(actor,{method,path,body,headers}) -> {status,headers,json,text}.
 * - ctx.check(id,asyncFn) records assertion failures and continues.
 * - ctx.recordGap(id,reason), ctx.principals, ctx.report are mutable run context.
 * - HTTP request targets must stay raw and redirects must never be followed.
 * - 'user' expands to BOTH verified same-role actors userA and userB.
 * This module does not construct/print credentials, or write any response body.
 */
export async function runRouterProbes(ctx, { probes: selectedProbes = routerProbes } = {}) {
  const success = new Map();
  const actorsFor = role => role === 'user' ? ['userA', 'userB'] : [role];
  const concrete = selectedProbes.flatMap(probe => probe.roles.flatMap(role => actorsFor(role).map(actor => ({ probe, actor }))));
  const allow = concrete.filter(({ probe }) => probe.expect === 'allow');
  const deny = concrete.filter(({ probe }) => probe.expect === 'deny');
  ctx.report.routerCoverage ||= [];

  const record = (probe, actor, status) => ctx.report.routerCoverage.push({
    inventoryId: probe.inventoryId, probeId: probe.id, actor, status,
    ...(probe.positiveControl ? { positiveControl: probe.positiveControl } : {}),
  });
  const request = (probe, actor) => ctx.request(actor, {
    method: probe.method, path: probe.path, body: probe.body, headers: probe.headers,
  });

  for (const { probe, actor } of allow) {
    let response;
    let passed = false;
    await ctx.check(`router:${probe.id}:${actor}`, async () => {
      response = await request(probe, actor);
      const validation = validateRouterAllowedResponse(probe, response);
      assert.ok(validation.ok, validation.errors.join('; '));
      if (probe.id.startsWith('auth-token.')) assert.ok(validateRouterPrincipal(response.json, ctx.principals[actor]), 'Router token identity/role must match independently verified principal');
      if (probe.id === 'marketplace-read.allow') {
        assert.ok(response.json?.marketplace?.user?.id === ctx.principals[actor]?.id, 'Marketplace must bind the current principal');
        assert.equal(response.json?.marketplace?.permissions?.canManage, actor === 'admin', 'Marketplace administration flag must match verified principal');
      }
      const actors = success.get(probe.id) ?? new Set();
      actors.add(actor);
      success.set(probe.id, actors);
      passed = true;
    });
    record(probe, actor, passed ? 'AUTHORIZED_CONTROL_PASSED' : 'AUTHORIZED_CONTROL_FAILED');
    if (passed && probe.id === 'marketplace-read.allow') {
      await ctx.check(`router:marketplace-sensitive-path-metadata:${actor}`, async () => {
        assert.deepEqual(inspectMarketplaceAuthorization(response.json, ctx.principals[actor]), [], 'Marketplace returned unauthorized metadata (see sanitized issue names)');
      });
      const issues = inspectMarketplaceAuthorization(response.json, ctx.principals[actor]);
      if (issues.length) {
        ctx.report.routerFindings ||= [];
        ctx.report.routerFindings.push({
          id: 'marketplace-local-source-path-disclosure', actor, issues,
          source: ['cli/server/authHandlers/marketplaceRoutes.js:342', 'cli/utils/skillRepositorySource.js:16'],
          reproduction: 'GET /api/marketplace with a verified selfRegistered or user session; inspect repositories[].skillSource.source.',
          expected: 'Unprivileged catalog consumers receive a remote source or opaque repository identity.',
          actual: 'An absolute local filesystem path is returned to an unprivileged session.',
        });
      }
      if (actor !== 'admin' && (response.json?.marketplace?.agents ?? []).some(agent => agent.manifestPath || agent.pid || agent.containerName)) {
        ctx.report.routerObservations ||= [];
        ctx.report.routerObservations.push({ actor, id: 'marketplace-runtime-metadata', source: 'cli/server/authHandlers/marketplaceRoutes.js:393', note: 'Unprivileged catalog also includes manifestPath/containerName/pid; no values copied to report. Review product necessity separately.' });
      }
    }
    if (passed && probe.id === 'agent-card.allow' && response.json.errors.length) {
      ctx.recordGap(`router:${probe.id}:${actor}:fanout`, 'Aggregate card returned per-agent errors; this response is not full agent-card coverage.');
    }
  }

  for (const { probe, actor } of deny) {
    if (probe.positiveControl && !success.get(probe.positiveControl)?.size) {
      ctx.recordGap(`router:${probe.id}:${actor}`, `Authorized control ${probe.positiveControl} failed; denied request cannot prove endpoint authorization.`);
      record(probe, actor, 'CONTROL_UNAVAILABLE');
      continue;
    }
    let response;
    let received = false;
    // The request is counted separately from the assertion so a canonical-path
    // rejection can be recorded as boundary evidence without an auth PASS.
    try {
      response = await request(probe, actor);
      received = true;
    } catch (error) {
      await ctx.check(`router:${probe.id}:${actor}`, async () => { throw error; });
      record(probe, actor, 'TRANSPORT_ERROR');
    }
    if (!received) continue;
    if (probe.boundaryRejectionStatuses?.includes(response.status)) {
      ctx.recordGap(`router:${probe.id}:${actor}`, `Raw path rejected with HTTP ${response.status}; this is normalization boundary evidence, not authorization proof against the resource.`);
      record(probe, actor, 'BOUNDARY_REJECTED_ONLY');
      continue;
    }
    let passed = false;
    await ctx.check(`router:${probe.id}:${actor}`, async () => {
      assert.ok(probe.statuses.includes(response.status), `Expected explicit authorization rejection (401/403), received HTTP ${response.status}; redirects, missing routes and transport errors are not denial evidence`);
      assert.ok(response.json && typeof response.json === 'object', 'Authorization rejection must have a structured error body');
      assert.ok(response.json.error, 'Authorization rejection must contain an error');
      assert.equal(Array.isArray(response.json.users), false, 'Denied response must not return a user list');
      assert.equal(Array.isArray(response.json.runtimes), false, 'Denied response must not return runtime data');
      for (const [key, value] of Object.entries(probe.denyJsonEquals ?? {})) assert.equal(response.json[key], value, `Denied response field ${key} differs from authorization contract`);
      passed = true;
    });
    record(probe, actor, passed ? (probe.positiveControl ? 'AUTHORIZATION_DENIAL_PASSED' : 'NEGATIVE_ONLY_PASSED') : 'AUTHORIZATION_DENIAL_FAILED');
    if (!probe.positiveControl && probe.gap) ctx.recordGap(`router:${probe.id}:${actor}:positive-control`, probe.gap);
  }
}
