// webAssist anonymous policy and session-history isolation against an offline model of
// the contract (list-sites denied; history readable by the owning principal, by whoever
// holds the session secret, and by an administrator). A product that deviates in any one
// way must fail exactly the check that measures it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeAgentMcp, sessionSecretDeclared, webAssistGuestCheckDefinitions, webAssistGuestProbes } from './agent-probes.mjs';
import { WEBASSIST_SESSION_SECRET_TOOLS } from './guest-agent-policy.mjs';

const text = value => ({ status: 200, headers: {}, json: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
const denied = message => decodeAgentMcp({ status: 200, headers: {}, json: { result: { isError: true, content: [{ type: 'text', text: message }] } } });
const schemaFor = mode => {
  const base = { type: 'object', properties: { siteId: { type: 'string' }, sessionId: { type: 'string' } }, required: ['siteId', 'sessionId'] };
  if (mode === 'declared') base.properties.sessionSecret = { type: 'string' };
  if (mode === 'required') { base.properties.sessionSecret = { type: 'string' }; base.required.push('sessionSecret'); }
  if (mode === 'number') base.properties.sessionSecret = { type: 'number' };
  return base;
};

/** Contract model of webAssist behind the guest route. `defect` selects one deviation. */
function productModel({ defect = '', listSites = 'denied', schema = 'declared', schemaTool = '' } = {}) {
  const records = new Map();
  const mcp = { async rpc(actor, agent, method, params) {
    assert.equal(agent, 'webAssist');
    if (method === 'tools/list') {
      const tools = ['list-sites', 'register-events', 'web_cli_chat', 'web_cli_history']
        .map(name => ({ name, inputSchema: WEBASSIST_SESSION_SECRET_TOOLS.includes(name) && name !== schemaTool ? schemaFor(schema) : schemaFor('declared') }));
      return decodeAgentMcp({ status: 200, headers: {}, json: { result: { tools } } });
    }
    assert.equal(params.name, 'list-sites');
    if (actor === 'anonymous') {
      if (listSites === 'denied') return denied('Access denied: Explorer access is required to list webAssist sites.');
      if (listSites === 'broken') return denied('ENOENT: no such file or directory, scandir sites');
    }
    return decodeAgentMcp({ status: 200, headers: {}, json: { result: { content: [{ type: 'text', text: JSON.stringify(actor === 'admin' && defect === 'dataRoot' ? { sites: [], count: 0, dataRoot: '/workspace/webassist-data/data' } : { sites: ['site-a'], count: 1 }) }] } } });
  } };
  const readHistory = (actor, { siteId, sessionId, sessionSecret }) => {
    const record = records.get(`${siteId}/${sessionId}`);
    const missing = { siteId, sessionId, exists: false, sessionKuId: `ku_sess_${sessionId}`, history: [] };
    if (!record) return missing;
    const owner = defect === 'ownerBlind' ? false : record.owner === actor;
    const secret = defect === 'ignoreSecret' ? false : defect === 'anySecret' ? Boolean(sessionSecret) : (sessionSecret !== undefined && sessionSecret === record.secret);
    if (!(owner || secret || defect === 'ignoreOwner')) {
      if (defect === 'foreignError') return { error: 'Internal storage error for this session' };
      if (defect === 'foreignEmptyExists') return { ...missing, exists: true };
      return missing;
    }
    return { siteId, sessionId, exists: true, sessionKuId: `ku_sess_${sessionId}`, history: [{ role: 'user', message: `${record.marker} user` }], ...(defect === 'echoSecret' ? { echoed: record.secret } : {}) };
  };
  const request = async (actor, { method, body }) => {
    if (body?.method === 'initialize') return { status: 200, headers: { 'mcp-session-id': `mcp-${actor}` }, json: { result: { protocolVersion: '2025-06-18' } }, text: '' };
    if (method === 'DELETE') return { status: 204, headers: {}, json: undefined, text: '' };
    assert.equal(body.params.name, 'web_cli_history');
    const result = readHistory(actor, body.params.arguments);
    if (result.error) return { status: 200, headers: {}, json: { result: { isError: true, content: [{ type: 'text', text: result.error }] } }, text: '' };
    return { status: 200, headers: {}, json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }, text: '' };
  };
  const factory = async actor => {
    const fixture = { siteId: 'a7-webassist-test', sessionId: `a7-sess-${actor.toLowerCase()}`, marker: `a7-marker-${actor}`, secret: `secret-${actor}-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789` };
    records.set(`${fixture.siteId}/${fixture.sessionId}`, { owner: actor, marker: fixture.marker, secret: fixture.secret });
    return fixture;
  };
  return { mcp, request, factory, records };
}

function world(options = {}, { clients, factory = true } = {}) {
  const model = productModel(options);
  const checks = [];
  const ctx = {
    secrets: new Set(), cleanups: [], checks, webAssistSessionFactory: factory ? model.factory : undefined,
    clients: clients || { anonymous: { cookies: [{ name: 'ploinky_guest', value: 'guest-A' }] }, anonymousB: { cookies: [{ name: 'ploinky_guest', value: 'guest-B' }] } },
    cleanup(fn) { this.cleanups.push(fn); },
    async check(id, fn) { try { await fn(); checks.push({ id, status: 'PASS' }); } catch (error) { checks.push({ id, status: 'FAIL', error: String(error?.message || error) }); } },
    request: model.request,
  };
  return { ctx, checks, model };
}
const IDS = Object.fromEntries(webAssistGuestCheckDefinitions().map(definition => [definition.id.split('.').slice(2).join('.'), definition.id]));
const run = async (options, setup) => {
  const w = world(options, setup);
  await webAssistGuestProbes(w.ctx, w.model.mcp);
  return w;
};
const statuses = w => Object.fromEntries(w.checks.map(check => [check.id, check.status]));
const failed = w => w.checks.filter(check => check.status !== 'PASS').map(check => check.id);

test('the contract model passes every webAssist guest check exactly once', async () => {
  const w = await run();
  assert.deepEqual(failed(w), []);
  assert.deepEqual(w.checks.map(check => check.id).sort(), webAssistGuestCheckDefinitions().map(definition => definition.id).sort());
});

test('webAssist guest checks are mandatory with the right positive controls', () => {
  const mandatory = JSON.parse(readFileSync(new URL('./acceptance/mandatory-checks.json', import.meta.url), 'utf8'));
  const control = id => mandatory.checks.find(entry => entry.id === id)?.positiveControlAnyOf;
  assert.deepEqual(control('agent.webAssist.anonymous.list-sites-denied'), ['agent.webAssist.admin.list-sites-positive']);
  assert.deepEqual(control('agent.webAssist.anonymous.session-history-own-positive'), ['agent.webAssist.anonymous.session-fixture']);
  for (const id of ['cross-read', 'wrong-secret', 'secret-positive']) assert.deepEqual(control(`agent.webAssist.anonymous.session-history-${id}`), ['agent.webAssist.anonymous.session-history-own-positive'], id);
  assert.equal(control('agent.webAssist.anonymous.session-fixture'), null);
  assert.equal(control('agent.webAssist.admin.session-secret-schema'), null);
  assert.equal(mandatory.checks.some(entry => entry.id === 'agent.webAssist.anonymous.session-history-isolation'), false, 'the single isolation check was split');
  for (const id of Object.values(IDS)) assert.equal(mandatory.checks.find(entry => entry.id === id)?.count, 1, id);
});

test('list-sites: a leak, a non-authorization failure, a disclosed data root or a missing positive never pass', async () => {
  assert.deepEqual(failed(await run({ listSites: 'leak' })), ['agent.webAssist.anonymous.list-sites-denied']);
  assert.deepEqual(failed(await run({ listSites: 'broken' })), ['agent.webAssist.anonymous.list-sites-denied']);
  assert.deepEqual(failed(await run({ defect: 'dataRoot' })), ['agent.webAssist.admin.list-sites-positive']);
});

test('sessionSecret must be a declared, optional string on both tools', async () => {
  assert.equal(sessionSecretDeclared(schemaFor('declared')), true);
  for (const mode of ['missing', 'required', 'number']) assert.equal(sessionSecretDeclared(schemaFor(mode)), false, mode);
  assert.equal(sessionSecretDeclared({ sessionSecret: { type: 'string', optional: true } }), true);
  assert.equal(sessionSecretDeclared({ sessionSecret: { type: 'string', optional: false } }), false);
  assert.equal(sessionSecretDeclared(undefined), false);
  for (const schema of ['missing', 'required', 'number']) assert.deepEqual(failed(await run({ schema })), ['agent.webAssist.admin.session-secret-schema'], schema);
  // One tool without the declaration is enough to fail.
  for (const schemaTool of WEBASSIST_SESSION_SECRET_TOOLS) assert.deepEqual(failed(await run({ schema: 'missing', schemaTool })), ['agent.webAssist.admin.session-secret-schema'], schemaTool);
});

test('a session secret that never reaches webAssist fails the correct-secret positive only', async () => {
  assert.deepEqual(failed(await run({ defect: 'ignoreSecret' })), [IDS['anonymous.session-history-secret-positive']]);
});

test('a product that accepts any or the wrong secret fails the wrong-secret negative', async () => {
  assert.deepEqual(failed(await run({ defect: 'anySecret' })), [IDS['anonymous.session-history-wrong-secret']]);
});

test('a product that ignores the owner fails the no-secret and wrong-secret negatives', async () => {
  assert.deepEqual(failed(await run({ defect: 'ignoreOwner' })).sort(), [IDS['anonymous.session-history-cross-read'], IDS['anonymous.session-history-wrong-secret']].sort());
});

test('a product that does not recognise the owner fails the own-read positive', async () => {
  const w = await run({ defect: 'ownerBlind' });
  assert.equal(statuses(w)[IDS['anonymous.session-history-own-positive']], 'FAIL');
});

test('the session secret is never echoed by a history read', async () => {
  const w = await run({ defect: 'echoSecret' });
  const result = statuses(w);
  assert.equal(result[IDS['anonymous.session-history-own-positive']], 'FAIL');
  assert.equal(result[IDS['anonymous.session-history-secret-positive']], 'FAIL');
});

test('a foreign read must be the missing-session shape, not an error or an existing empty session', async () => {
  for (const defect of ['foreignError', 'foreignEmptyExists']) assert.ok(failed(await run({ defect })).includes(IDS['anonymous.session-history-cross-read']), defect);
});

test('without a session fixture, or with a fixture that cannot be seeded, everything dependent fails and nothing is recorded as a gap', async () => {
  const dependents = ['anonymous.session-fixture', 'anonymous.session-history-own-positive', 'anonymous.session-history-cross-read', 'anonymous.session-history-wrong-secret', 'anonymous.session-history-secret-positive'].map(key => IDS[key]);
  const none = await run({}, { factory: false });
  assert.deepEqual(dependents.filter(id => statuses(none)[id] !== 'FAIL'), []);
  const w = world();
  w.ctx.webAssistSessionFactory = async () => { throw new Error('seeding impossible: the data root is unreadable across the mount'); };
  await webAssistGuestProbes(w.ctx, w.model.mcp);
  assert.deepEqual(dependents.filter(id => statuses(w)[id] !== 'FAIL'), []);
  assert.equal(w.checks.some(check => check.status === 'PASS' && dependents.includes(check.id)), false);
});

test('two jars that hold the same guest session, or none, are not two visitors', async () => {
  const same = await run({}, { clients: { anonymous: { cookies: [{ name: 'ploinky_guest', value: 'guest-A' }] }, anonymousB: { cookies: [{ name: 'ploinky_guest', value: 'guest-A' }] } } });
  assert.match(same.checks.find(check => check.id === IDS['anonymous.session-fixture']).error, /distinct guest sessions/);
  assert.equal(statuses(same)[IDS['anonymous.session-history-cross-read']], 'FAIL');
  const none = await run({}, { clients: { anonymous: { cookies: [] }, anonymousB: { cookies: [] } } });
  assert.equal(statuses(none)[IDS['anonymous.session-fixture']], 'FAIL');
});
