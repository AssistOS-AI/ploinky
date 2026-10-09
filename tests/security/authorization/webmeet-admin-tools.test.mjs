// The eleven admin-only WebMeet tools and the webAssist anonymous policy, against a
// faithful offline model of the pinned handlers. A leaking product must fail the exact
// denial, a broken positive must fail its dependents, and nothing the run created may remain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed, assertResourceDenied } from './resource-probes.mjs';
import { WEBMEET_ADMIN_ONLY_TOOLS, WEBMEET_GUEST_ALLOWLIST, GUEST_AGENT_POLICY, pinnedGuestList } from './guest-agent-policy.mjs';
import { runWebmeetAdminToolProbes, webmeetAdminToolCheckDefinitions, WEBMEET_POSITIVE_FOR_OP, WEBMEET_DENIED_ACTORS, denialId } from './webmeet-admin-tools.mjs';
import { decodeAgentMcp, webAssistGuestCheckDefinitions, webAssistGuestProbes } from './agent-probes.mjs';

const ADMIN_TOOLS = new Set(WEBMEET_ADMIN_ONLY_TOOLS.map(entry => entry.tool));
const ok = value => ({ failed: false, value, error: '', response: { status: 200, json: {}, text: '' } });
const fail = error => ({ failed: true, value: { ok: false, error }, error, response: { status: 200, json: {}, text: '' } });

/** Model of webmeetAgent@bdf0f96f: guest allowlist at dispatch, assertAdminAuthInfo in the eleven handlers. */
function webmeetWorld({ leak = new Set(), failTool = new Set(), persistThenFailCreate = '' } = {}) {
  const rooms = new Map();
  let counter = 0;
  const id = prefix => `${prefix}_${String(++counter).padStart(8, '0')}`;
  const seen = [];
  const view = room => ({ id: room.id, roomId: room.id, name: room.name, title: room.name, status: room.status, archivedAt: room.archivedAt });
  const requireRoom = roomId => { const room = rooms.get(roomId); if (!room) throw new Error('Meeting not found.'); return room; };
  const handlers = {
    webmeet_room_list: () => ({ rooms: [...rooms.values()].map(view), canManageRooms: true }),
    webmeet_room_create: args => {
      const room = { id: id('room'), name: args.name, status: 'open', archivedAt: null, members: [], settings: { assistant: { name: 'Robo Team' } }, resources: [],
        agent: { id: 'agent_robo_team', agentType: 'robo_team', status: 'active', deletedAt: null } };
      rooms.set(room.id, room);
      if (persistThenFailCreate && args.name === persistThenFailCreate) throw new Error('response lost');
      return view(room);
    },
    webmeet_room_get: args => { const room = requireRoom(args.roomId); return { meeting: view(room), participants: room.members.map(member => ({ ...member })), agents: [] }; },
    webmeet_room_rename: args => { const room = requireRoom(args.roomId); room.name = args.name; return view(room); },
    webmeet_room_delete: args => { requireRoom(args.roomId); rooms.delete(args.roomId); return { ok: true, deleted: true, roomId: args.roomId }; },
    webmeet_room_archive: args => { const room = requireRoom(args.roomId); room.status = 'archived'; room.archivedAt = 'now'; return { ok: true, meeting: view(room) }; },
    webmeet_room_join: args => { const room = requireRoom(args.roomId); const participant = { id: id('participant'), displayName: args.displayName }; room.members.push(participant); return { participant, participantIdentity: participant.id }; },
    webmeet_participant_update_role: args => { const member = requireRoom(args.roomId).members.find(entry => entry.id === args.participantId); if (!member) throw new Error('Participant is not joined.'); member.role = args.role; return { ok: true, participant: member }; },
    webmeet_participant_remove: args => { const room = requireRoom(args.roomId); const before = room.members.length; room.members = room.members.filter(entry => entry.id !== args.participantId); return { ok: room.members.length < before, participantId: args.participantId }; },
    webmeet_robo_team_get: args => ({ roomId: args.roomId, settings: requireRoom(args.roomId).settings }),
    webmeet_robo_team_update: args => { const room = requireRoom(args.roomId); room.settings = { assistant: { name: args.settings.assistant.name } }; return { roomId: args.roomId, settings: room.settings }; },
    webmeet_agent_list: args => ({ agents: [{ ...requireRoom(args.roomId).agent }] }),
    webmeet_agent_attach: args => { const room = requireRoom(args.roomId); Object.assign(room.agent, { status: 'active', deletedAt: null }); return room.agent; },
    webmeet_agent_detach: args => { const room = requireRoom(args.roomId); Object.assign(room.agent, { status: 'detached', deletedAt: 'now' }); return room.agent; },
    webmeet_resource_authorize_upload: args => ({ ok: true, roomId: args.roomId, resourceId: id('resource'), storagePath: `/store/${args.roomId}/x` }),
    webmeet_resource_commit_upload: args => { requireRoom(args.roomId).resources.push({ resourceId: args.resourceId, deletedAt: null }); return { ok: true }; },
    webmeet_resource_list: args => ({ resources: requireRoom(args.roomId).resources.filter(entry => !entry.deletedAt).map(entry => ({ ...entry })) }),
    webmeet_resource_remove: args => { const resource = requireRoom(args.roomId).resources.find(entry => entry.resourceId === args.resourceId && !entry.deletedAt); if (!resource) throw new Error('Resource not found.'); resource.deletedAt = 'now'; return { ok: true, resourceId: args.resourceId }; },
  };
  const mcp = async (principal, agent, tool, args = {}) => {
    seen.push({ principal, tool });
    assert.equal(agent, 'webmeetAgent');
    const leaked = leak.has(`${principal}:${tool}`);
    if (principal === 'anonymous' && !leaked && !WEBMEET_GUEST_ALLOWLIST.includes(tool)) return fail(`Access denied: guest invocation cannot call "${tool}".`);
    if (principal !== 'admin' && !leaked && ADMIN_TOOLS.has(tool)) return fail('Access denied: only admin can manage rooms.');
    if (failTool.has(`${principal}:${tool}`)) return fail('backend unavailable');
    try { return ok(handlers[tool](args)); } catch (error) { return fail(error.message); }
  };
  return { mcp, rooms, seen };
}
function checkCtx() {
  return { prefix: 'authz-test', cleanups: [], report: { checks: [] }, async guard() {}, cleanup(fn) { this.cleanups.push(fn); },
    async check(id, fn) { try { await fn(); this.report.checks.push({ id, status: 'PASS' }); } catch (error) { this.report.checks.push({ id, status: error?.code === 'ERR_ASSERTION' ? 'FAIL' : 'ERROR', error: String(error?.message || error) }); } } };
}
const run = async options => {
  const world = webmeetWorld(options);
  const ctx = checkCtx();
  await runWebmeetAdminToolProbes(ctx, world.mcp, { assertAllowed, assertResourceDenied });
  return { world, ctx };
};
const status = (ctx, id) => ctx.report.checks.filter(check => check.id === id).map(check => check.status);

test('the pinned guest policy is consistent with the reviewed expected-gap lists and the eleven admin gates', () => {
  assert.equal(WEBMEET_ADMIN_ONLY_TOOLS.length, 11);
  assert.equal(new Set(WEBMEET_ADMIN_ONLY_TOOLS.map(entry => entry.tool)).size, 11);
  assert.equal(new Set(WEBMEET_ADMIN_ONLY_TOOLS.map(entry => entry.op)).size, 11);
  const tools = new Set(GUEST_AGENT_POLICY.webmeetAgent.tools);
  assert.equal(tools.size, 40);
  for (const entry of WEBMEET_ADMIN_ONLY_TOOLS) assert.ok(tools.has(entry.tool), entry.tool);
  for (const tool of WEBMEET_GUEST_ALLOWLIST) { assert.ok(tools.has(tool), tool); assert.ok(!ADMIN_TOOLS.has(tool), `${tool} cannot be both guest-allowed and admin-only`); }
  assert.equal(WEBMEET_GUEST_ALLOWLIST.length, 7);
  const gaps = JSON.parse(readFileSync(new URL('./acceptance/expected-gaps.json', import.meta.url), 'utf8')).gaps;
  for (const agent of ['webAssist', 'webmeetAgent']) {
    const gap = gaps.find(entry => entry.id === `agent.${agent}.discovery.tools.list.selfRegistered.scope`);
    assert.deepEqual(gap.evidence.visibleTools, pinnedGuestList(agent, 'tools'), `${agent}: the selfRegistered gap pins the same reviewed list`);
    assert.deepEqual(pinnedGuestList(agent, 'resources'), []);
  }
  // webAssist: every pinned tool has an explicit anonymous decision and nothing else is decided.
  assert.deepEqual(Object.keys(GUEST_AGENT_POLICY.webAssist.anonymous).sort(), pinnedGuestList('webAssist', 'tools'));
  assert.equal(GUEST_AGENT_POLICY.webAssist.anonymous['list-sites'], 'deny');
});

test('every admin-only tool has anonymous and selfRegistered denials with its own administrator positive', () => {
  const definitions = webmeetAdminToolCheckDefinitions();
  const ids = new Set(definitions.map(definition => definition.id));
  assert.equal(ids.size, definitions.length);
  for (const { op } of WEBMEET_ADMIN_ONLY_TOOLS) {
    assert.ok(ids.has(WEBMEET_POSITIVE_FOR_OP[op]) || op === 'create', `positive for ${op}`);
    if (['rename', 'delete'].includes(op)) continue; // the shared fixture room's denials are recorded by resource-probes.mjs
    for (const actor of WEBMEET_DENIED_ACTORS) {
      const definition = definitions.find(entry => entry.id === denialId(actor, op));
      assert.ok(definition, `${actor} ${op}`);
      assert.deepEqual(definition.positiveControlAnyOf, [WEBMEET_POSITIVE_FOR_OP[op]]);
    }
  }
});

test('a faithful product passes every WebMeet admin-tool check exactly once and leaves nothing behind', async () => {
  const { world, ctx } = await run();
  assert.deepEqual(ctx.report.checks.filter(check => check.status !== 'PASS'), []);
  assert.deepEqual(ctx.report.checks.map(check => check.id).sort(), webmeetAdminToolCheckDefinitions().map(definition => definition.id).sort());
  for (const cleanup of ctx.cleanups.reverse()) await cleanup();
  assert.deepEqual([...world.rooms.values()], [], 'every run-owned room is gone, including the lifecycle room already deleted by the positive');
  // Each denial was really attempted by the denied actor with the tool under test.
  for (const { tool, op } of WEBMEET_ADMIN_ONLY_TOOLS) {
    if (['rename', 'delete'].includes(op)) continue;
    for (const actor of WEBMEET_DENIED_ACTORS) assert.ok(world.seen.some(call => call.principal === actor && call.tool === tool), `${actor} ${tool}`);
  }
});

test('a product that lets anonymous or selfRegistered through fails exactly that denial', async () => {
  for (const { tool, op } of WEBMEET_ADMIN_ONLY_TOOLS) {
    if (['rename', 'delete'].includes(op)) continue;
    for (const actor of WEBMEET_DENIED_ACTORS) {
      const { world, ctx } = await run({ leak: new Set([`${actor}:${tool}`]) });
      const failed = ctx.report.checks.filter(check => check.status !== 'PASS').map(check => check.id);
      // A real leak changes state, so the other actor's denial for the same tool can also see it; nothing else may fail.
      assert.ok(failed.includes(denialId(actor, op)), `${actor} ${tool}`);
      const related = new Set([...WEBMEET_DENIED_ACTORS.map(other => denialId(other, op)), WEBMEET_POSITIVE_FOR_OP[op]]);
      assert.ok(failed.every(id => related.has(id)), `${actor} ${tool}: unexpected failures ${failed.join(', ')}`);
      for (const cleanup of ctx.cleanups.reverse()) await cleanup();
      assert.deepEqual([...world.rooms.values()].filter(room => /^authz-test-/.test(room.name)), [], 'cleanup removed any room the leak created');
    }
  }
});

test('a broken administrator positive fails the positive and never lets its denials pass silently', async () => {
  for (const [tool, positive] of [['webmeet_agent_detach', WEBMEET_POSITIVE_FOR_OP.detach], ['webmeet_robo_team_update', WEBMEET_POSITIVE_FOR_OP['robo-team-update']], ['webmeet_room_archive', WEBMEET_POSITIVE_FOR_OP.archive]]) {
    const { ctx } = await run({ failTool: new Set([`admin:${tool}`]) });
    assert.notEqual(status(ctx, positive)[0], 'PASS', positive);
  }
  // Unavailable fixtures fail every dependent check instead of recording a gap.
  const noJoin = await run({ failTool: new Set(['admin:webmeet_room_join']) });
  for (const id of ['resource.webmeet.admin.participant-fixture', 'resource.webmeet.admin.participant-role-positive', 'resource.webmeet.admin.participant-remove-positive', 'resource.webmeet.anonymous.participant-role', 'resource.webmeet.selfRegistered.participant-remove']) assert.equal(status(noJoin.ctx, id)[0], 'FAIL', id);
  const noRoom = await run({ failTool: new Set(['admin:webmeet_room_create']) });
  assert.deepEqual(noRoom.ctx.report.checks.map(check => check.id).sort(), webmeetAdminToolCheckDefinitions().map(definition => definition.id).sort());
  assert.ok(noRoom.ctx.report.checks.every(check => check.status !== 'PASS'));
});

test('cleanup is armed before creation: a create whose response is lost still removes the room', async () => {
  const { world, ctx } = await run({ persistThenFailCreate: 'authz-test-admintools-room' });
  assert.equal(status(ctx, 'resource.webmeet.admin-tools-fixture')[0], 'FAIL');
  assert.equal([...world.rooms.values()].filter(room => room.name === 'authz-test-admintools-room').length, 1, 'the room persisted despite the lost response');
  for (const cleanup of ctx.cleanups.reverse()) await cleanup();
  assert.equal([...world.rooms.values()].length, 0);
});

// ---- webAssist anonymous policy ------------------------------------------------------------
function assistMcp({ anonymousListsSites = false } = {}) {
  return { async rpc(actor, agent, method, params) {
    assert.equal(agent, 'webAssist');
    if (params.name === 'list-sites') {
      if (actor === 'anonymous' && !anonymousListsSites) return decodeAgentMcp({ status: 200, json: { result: { isError: true, content: [{ type: 'text', text: 'Access denied: guest invocation cannot call list-sites.' }] } }, headers: {} });
      return decodeAgentMcp({ status: 200, json: { result: { content: [{ type: 'text', text: JSON.stringify({ sites: ['site-a'], count: 1, dataRoot: '/workspace/webassist-data' }) }] } }, headers: {} });
    }
    throw new Error(`unexpected ${params.name}`);
  } };
}
function assistCtx({ histories, factory } = {}) {
  const checks = [];
  const sessions = { anonymous: 'mcp-A', anonymousB: 'mcp-B' };
  const ctx = {
    secrets: new Set(), cleanups: [], checks, webAssistSessionFactory: factory,
    clients: { anonymous: { cookies: [{ name: 'ploinky_guest', value: 'guest-A' }] }, anonymousB: { cookies: [{ name: 'ploinky_guest', value: 'guest-B' }] } },
    cleanup(fn) { this.cleanups.push(fn); },
    async check(id, fn) { try { await fn(); checks.push({ id, status: 'PASS' }); } catch (error) { checks.push({ id, status: 'FAIL', error: String(error?.message || error) }); } },
    async request(actor, { method, body }) {
      if (body?.method === 'initialize') return { status: 200, headers: { 'mcp-session-id': sessions[actor] }, json: { result: { protocolVersion: '2025-06-18' } }, text: '' };
      if (method === 'DELETE') return { status: 204, headers: {}, json: undefined, text: '' };
      const { siteId, sessionId } = body.params.arguments;
      const history = histories(actor, siteId, sessionId);
      return { status: 200, headers: {}, json: { result: { content: [{ type: 'text', text: JSON.stringify(history) }] } }, text: '' };
    },
  };
  return { ctx, checks };
}
const own = { anonymous: { siteId: 'site-a', sessionId: 'sess-A', marker: 'MARKER-A' }, anonymousB: { siteId: 'site-a', sessionId: 'sess-B', marker: 'MARKER-B' } };
const factory = async actor => own[actor];
const historyOf = (readerMayCross) => (actor, siteId, sessionId) => {
  const owner = Object.keys(own).find(key => own[key].sessionId === sessionId);
  if (owner && (owner === actor || readerMayCross)) return { siteId, sessionId, exists: true, history: [{ role: 'user', message: own[owner].marker }] };
  return { siteId, sessionId, exists: false, history: [] };
};

test('webAssist anonymous list-sites is denied with an administrator positive, and the live leak fails', async () => {
  const good = assistCtx({ histories: historyOf(false), factory });
  await webAssistGuestProbes(good.ctx, assistMcp(), { createSession: factory });
  assert.deepEqual(good.checks.map(check => [check.id, check.status]), [['agent.webAssist.admin.list-sites-positive', 'PASS'], ['agent.webAssist.anonymous.list-sites-denied', 'PASS'], ['agent.webAssist.anonymous.session-history-isolation', 'PASS']]);
  assert.deepEqual(good.checks.map(check => check.id), webAssistGuestCheckDefinitions().map(definition => definition.id));
  const leaking = assistCtx({ histories: historyOf(false), factory });
  await webAssistGuestProbes(leaking.ctx, assistMcp({ anonymousListsSites: true }), { createSession: factory });
  assert.equal(leaking.checks.find(check => check.id === 'agent.webAssist.anonymous.list-sites-denied').status, 'FAIL');
});

test('webAssist cross-session history: isolation passes, a cross read fails, and no fixture is a failure, not a pass', async () => {
  const isolated = assistCtx({ histories: historyOf(false), factory });
  await webAssistGuestProbes(isolated.ctx, assistMcp(), { createSession: factory });
  assert.equal(isolated.checks.at(-1).status, 'PASS');
  const leaking = assistCtx({ histories: historyOf(true), factory });
  await webAssistGuestProbes(leaking.ctx, assistMcp(), { createSession: factory });
  assert.equal(leaking.checks.at(-1).status, 'FAIL');
  assert.match(leaking.checks.at(-1).error, /read another visitor/);
  // A visitor whose own history is empty is not a positive control.
  const emptyOwn = assistCtx({ histories: (actor, siteId, sessionId) => ({ siteId, sessionId, exists: false, history: [] }), factory });
  await webAssistGuestProbes(emptyOwn.ctx, assistMcp(), { createSession: factory });
  assert.equal(emptyOwn.checks.at(-1).status, 'FAIL');
  // The live run has no inference-free session fixture: the check fails instead of passing vacuously.
  const noFixture = assistCtx({ histories: historyOf(false) });
  await webAssistGuestProbes(noFixture.ctx, assistMcp());
  assert.equal(noFixture.checks.at(-1).status, 'FAIL');
  assert.match(noFixture.checks.at(-1).error, /session fixture/);
});
