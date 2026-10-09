// The eleven admin-only WebMeet tools and the webAssist anonymous policy, against a
// faithful offline model of the pinned handlers. A leaking product must fail the exact
// denial, a broken positive must fail its dependents, and nothing the run created may remain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAllowed, assertResourceDenied } from './resource-probes.mjs';
import { WEBMEET_ADMIN_ONLY_TOOLS, WEBMEET_GUEST_ALLOWLIST, GUEST_AGENT_POLICY, pinnedGuestList } from './guest-agent-policy.mjs';
import { runWebmeetAdminToolProbes, webmeetAdminToolCheckDefinitions, WEBMEET_POSITIVE_FOR_OP, WEBMEET_DENIED_ACTORS, denialId } from './webmeet-admin-tools.mjs';

const claimed = (tool, args) => ({
  ok: true, deleted: true, roomId: args.roomId, participantId: args.participantId, resourceId: args.resourceId, status: 'ok',
  participant: { id: args.participantId, role: args.role }, settings: args.settings, name: args.name, meeting: { id: args.roomId, name: args.name }, id: args.roomId,
});
const ADMIN_TOOLS = new Set(WEBMEET_ADMIN_ONLY_TOOLS.map(entry => entry.tool));
const ok = value => ({ failed: false, value, error: '', response: { status: 200, json: {}, text: '' } });
const fail = error => ({ failed: true, value: { ok: false, error }, error, response: { status: 200, json: {}, text: '' } });

/** Model of webmeetAgent@bdf0f96f: guest allowlist at dispatch, assertAdminAuthInfo in the eleven handlers. */
function webmeetWorld({ leak = new Set(), failTool = new Set(), persistThenFailCreate = '', silent = new Set(), disclose = new Set(), noop = new Set() } = {}) {
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
    const denial = principal === 'anonymous' ? `Access denied: guest invocation cannot call "${tool}".` : 'Access denied: only admin can manage rooms.';
    // Hostile models of a broken product: the state changes (or data is returned) and the call still answers "access denied".
    if (silent.has(`${principal}:${tool}`)) { try { handlers[tool](args); } catch { /* the attempt may fail after persisting */ } return fail(denial); }
    if (disclose.has(`${principal}:${tool}`)) { try { return { ...fail(denial), value: { ok: false, error: denial, ...handlers[tool](args) } }; } catch { return fail(denial); } }
    // An administrator operation that claims success without changing anything.
    if (noop.has(`${principal}:${tool}`)) return ok(claimed(tool, args));
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

// ---- N1: mutants that survived the first offline suite ------------------------------------------
// Mutating tools only: the shared-room rename/delete denials live in resource-probes.mjs and the RoboTeam read has no state to change.
const MUTATING_OPS = WEBMEET_ADMIN_ONLY_TOOLS.filter(entry => !['rename', 'delete', 'robo-team-get'].includes(entry.op));

test('a denied call that changes state yet answers "access denied" fails that denial (admin-side re-check)', async () => {
  for (const { tool, op } of MUTATING_OPS) {
    for (const actor of WEBMEET_DENIED_ACTORS) {
      const { world, ctx } = await run({ silent: new Set([`${actor}:${tool}`]) });
      const failed = ctx.report.checks.filter(check => check.status !== 'PASS').map(check => check.id);
      assert.ok(failed.includes(denialId(actor, op)), `${actor} ${tool}: the silent state change was not detected (failed: ${failed.join(', ') || 'none'})`);
      const related = new Set([...WEBMEET_DENIED_ACTORS.map(other => denialId(other, op)), WEBMEET_POSITIVE_FOR_OP[op]]);
      assert.ok(failed.every(id => related.has(id)), `${actor} ${tool}: unrelated failures ${failed.join(', ')}`);
      for (const cleanup of ctx.cleanups.reverse()) await cleanup();
      assert.deepEqual([...world.rooms.values()], [], 'cleanup removed whatever the silent change created');
    }
  }
});

test('a denied room creation that persisted a room is detected and the room is cleaned up', async () => {
  for (const actor of WEBMEET_DENIED_ACTORS) {
    const { world, ctx } = await run({ silent: new Set([`${actor}:webmeet_room_create`]) });
    assert.deepEqual(ctx.report.checks.filter(check => check.status !== 'PASS').map(check => check.id), [denialId(actor, 'create')]);
    assert.equal([...world.rooms.values()].filter(room => room.name === `authz-test-denied-create-${actor}`).length, 1, 'the room really persisted');
    for (const cleanup of ctx.cleanups.reverse()) await cleanup();
    assert.deepEqual([...world.rooms.values()], []);
  }
});

test('a denied RoboTeam read that discloses the settings inside its failure payload fails the marker check', async () => {
  for (const actor of WEBMEET_DENIED_ACTORS) {
    const { ctx } = await run({ disclose: new Set([`${actor}:webmeet_robo_team_get`]) });
    assert.deepEqual(ctx.report.checks.filter(check => check.status !== 'PASS').map(check => check.id), [denialId(actor, 'robo-team-get')]);
    assert.match(ctx.report.checks.find(check => check.id === denialId(actor, 'robo-team-get')).error, /leaked/);
  }
});

test('an administrator operation that answers ok without changing state fails its positive and nothing else passes silently', async () => {
  const positives = [
    ['webmeet_room_rename', 'rename'], ['webmeet_room_archive', 'archive'], ['webmeet_room_delete', 'delete'], ['webmeet_agent_attach', 'attach'], ['webmeet_agent_detach', 'detach'],
    ['webmeet_resource_remove', 'resource-remove'], ['webmeet_participant_update_role', 'participant-role'], ['webmeet_participant_remove', 'participant-remove'], ['webmeet_robo_team_update', 'robo-team-update'],
  ];
  for (const [tool, op] of positives) {
    const { ctx } = await run({ noop: new Set([`admin:${tool}`]) });
    assert.equal(ctx.report.checks.find(check => check.id === WEBMEET_POSITIVE_FOR_OP[op]).status, 'FAIL', `${tool}: a no-op administrator call must not satisfy its positive`);
  }
});
