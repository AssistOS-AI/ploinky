/**
 * Mandatory anonymous and selfRegistered denials for the eleven admin-only WebMeet
 * tools (guest-agent-policy.mjs, WEBMEET_ADMIN_ONLY_TOOLS), each verified from the
 * administrator side and each paired with an administrator positive that performs
 * and observes the same state change.
 *
 * Every room, participant and resource used here is created by this run's
 * administrator; cleanup is armed before each creation and reconciles by exact run
 * name. Ordering is deliberate: for each tool the denied attempts run first (state S0
 * is observed unchanged), then the administrator performs the operation (state S1 is
 * observed). Participant checks run first and tightly, because a joined member
 * without heartbeats is swept after the 30 s presence TTL
 * (webmeetAgent/lib/store/roomRecords.mjs:21, lib/services/roomParticipants.mjs:346-372).
 *
 * The existing resource.webmeet.{selfRegistered,userA,userB}.{rename,delete} checks in
 * resource-probes.mjs cover the shared fixture room; this module adds the anonymous
 * variants there through the same loop and everything else here.
 */
import assert from 'node:assert/strict';
import { WEBMEET_ADMIN_ONLY_TOOLS } from './guest-agent-policy.mjs';

export const WEBMEET_DENIED_ACTORS = Object.freeze(['anonymous', 'selfRegistered']);
const AGENT = 'webmeetAgent';
const FIXTURE = 'resource.webmeet.admin-tools-fixture';
const LIFECYCLE_FIXTURE = 'resource.webmeet.admin-lifecycle-fixture';
const PARTICIPANT_FIXTURE = 'resource.webmeet.admin.participant-fixture';
const RESOURCE_FIXTURE = 'resource.webmeet.admin.resource-fixture';

/** op -> the administrator positive that proves the same operation works. */
export const WEBMEET_POSITIVE_FOR_OP = Object.freeze({
  create: FIXTURE,
  rename: 'resource.webmeet.admin.rename-positive',
  delete: 'resource.webmeet.admin.delete-positive',
  archive: 'resource.webmeet.admin.archive-positive',
  attach: 'resource.webmeet.admin.attach-positive',
  detach: 'resource.webmeet.admin.detach-positive',
  'resource-remove': 'resource.webmeet.admin.resource-remove-positive',
  'participant-role': 'resource.webmeet.admin.participant-role-positive',
  'participant-remove': 'resource.webmeet.admin.participant-remove-positive',
  'robo-team-get': 'resource.webmeet.admin.robo-team-get-positive',
  'robo-team-update': 'resource.webmeet.admin.robo-team-update-positive',
});

/** Ops whose selfRegistered/userA/userB and anonymous denials live in resource-probes.mjs. */
const SHARED_ROOM_OPS = new Set(['rename', 'delete']);

export const denialId = (actor, op) => `resource.webmeet.${actor}.${op}`;

/** Every mandatory check this module records, with its positive control. */
export function webmeetAdminToolCheckDefinitions() {
  const source = 'tests/security/authorization/webmeet-admin-tools.mjs runWebmeetAdminToolProbes';
  const def = (id, positiveControlAnyOf = null) => ({ id, kind: 'live', boundary: 'resources', source, positiveControlAnyOf });
  const out = [
    def(FIXTURE), def(LIFECYCLE_FIXTURE),
    def(PARTICIPANT_FIXTURE, [FIXTURE]), def(RESOURCE_FIXTURE, [FIXTURE]),
  ];
  const positives = [
    ['rename', [FIXTURE]], ['delete', [LIFECYCLE_FIXTURE]], ['archive', [LIFECYCLE_FIXTURE]], ['attach', [FIXTURE]], ['detach', [FIXTURE]],
    ['resource-remove', [RESOURCE_FIXTURE]], ['participant-role', [PARTICIPANT_FIXTURE]], ['participant-remove', [PARTICIPANT_FIXTURE]],
    ['robo-team-get', [FIXTURE]], ['robo-team-update', [FIXTURE]],
  ];
  for (const [op, control] of positives) out.push(def(WEBMEET_POSITIVE_FOR_OP[op], control));
  for (const { op } of WEBMEET_ADMIN_ONLY_TOOLS) {
    if (SHARED_ROOM_OPS.has(op)) continue;
    for (const actor of WEBMEET_DENIED_ACTORS) out.push(def(denialId(actor, op), [WEBMEET_POSITIVE_FOR_OP[op]]));
  }
  return out;
}

const roomId = room => room?.roomId || room?.id;
const roomName = room => room?.name || room?.title;

export async function runWebmeetAdminToolProbes(ctx, mcp, { assertAllowed, assertResourceDenied }) {
  const call = (actor, tool, args) => mcp(actor, AGENT, tool, args);
  const admin = async (tool, args, label) => assertAllowed(await call('admin', tool, args), label);
  const listRooms = async () => {
    const value = await admin('webmeet_room_list', {}, 'administrator lists rooms');
    assert.ok(Array.isArray(value.rooms), 'Room listing requires a rooms array');
    return value.rooms;
  };
  const getRoom = async (id, includeParticipants = true) => admin('webmeet_room_get', { roomId: id, includeParticipants }, `administrator reads room ${includeParticipants ? '' : 'state '}`.trim());
  const names = {
    tools: `${ctx.prefix}-admintools-room`,
    renamed: `${ctx.prefix}-admintools-renamed`,
    lifecycle: `${ctx.prefix}-lifecycle-room`,
    marker: `${ctx.prefix}-robo-marker`,
  };

  // Cleanup is armed before creation and reconciles by exact run-owned name, so a
  // create whose response is lost, or a denied create that unexpectedly persisted, is still removed.
  const armRoomCleanup = (nameList, baselineIds) => {
    let cleaned = false;
    ctx.cleanup(async () => {
      if (cleaned) return;
      await ctx.guard();
      const matches = (await listRooms()).filter(room => nameList.includes(roomName(room)) && !baselineIds.has(roomId(room)));
      assert.ok(matches.length <= 1, `Room cleanup ownership unresolved: ${matches.length} run-name matches`);
      for (const match of matches) {
        const id = roomId(match);
        const current = await getRoom(id, false);
        assert.equal(roomId(current.meeting), id, 'Room cleanup identity mismatch');
        assertAllowed(await call('admin', 'webmeet_room_delete', { roomId: id, confirmed: true }), 'run-owned room cleanup');
      }
      cleaned = true;
    });
  };
  const createOwnedRoom = async (name, nameList) => {
    const baseline = new Set((await listRooms()).map(roomId));
    armRoomCleanup(nameList, baseline);
    const created = await admin('webmeet_room_create', { name, roomType: 'team' }, `administrator creates ${name}`);
    const id = roomId(created);
    assert.ok(id && !baseline.has(id), 'Room creation returned a new identity');
    const listed = (await listRooms()).find(room => roomId(room) === id);
    assert.equal(roomName(listed), name, 'The administrator observes the created room');
    return id;
  };

  const all = webmeetAdminToolCheckDefinitions().map(definition => definition.id);
  const recorded = new Set();
  const check = async (id, fn) => {
    recorded.add(id);
    await ctx.check(id, fn);
  };
  const outcome = new Map();
  const positive = async (id, fn) => {
    let ok = false;
    await check(id, async () => { await fn(); ok = true; });
    outcome.set(id, ok);
    return ok;
  };
  /** A denied attempt: administrator-side state first, then the authorization decision. */
  const denied = async (actor, op, attempt, verifyUnchanged, marker = '') => {
    await check(denialId(actor, op), async () => {
      await ctx.guard();
      const result = await attempt(actor);
      await verifyUnchanged();
      assertResourceDenied(result, `${actor} attempts ${WEBMEET_ADMIN_ONLY_TOOLS.find(entry => entry.op === op).tool}`, marker);
    });
  };
  const deniedBoth = async (op, attempt, verifyUnchanged, marker = '') => {
    for (const actor of WEBMEET_DENIED_ACTORS) await denied(actor, op, attempt, verifyUnchanged, marker);
  };

  // ---- fixture room and create ---------------------------------------------------
  let room;
  await positive(FIXTURE, async () => {
    await ctx.guard();
    room = await createOwnedRoom(names.tools, [names.tools, names.renamed]);
  });
  if (!room) {
    for (const id of all) if (!recorded.has(id)) await check(id, async () => assert.fail('The administrator-created WebMeet fixture room is unavailable; no authorization conclusion is possible'));
    return;
  }
  for (const actor of WEBMEET_DENIED_ACTORS) {
    const name = `${ctx.prefix}-denied-create-${actor}`;
    const baseline = new Set((await listRooms()).map(roomId));
    armRoomCleanup([name], baseline);
    await check(denialId(actor, 'create'), async () => {
      await ctx.guard();
      const result = await call(actor, 'webmeet_room_create', { name, roomType: 'team' });
      const after = await listRooms();
      assert.equal(after.some(entry => roomName(entry) === name), false, 'A denied room creation persisted a room');
      assertResourceDenied(result, `${actor} creates a room`);
    });
  }

  // ---- participants (first and tight: members expire after the 30 s presence TTL) ----
  let participant;
  const members = async () => (await getRoom(room, false)).participants;
  const memberById = async id => (await members()).find(entry => entry?.id === id);
  await positive(PARTICIPANT_FIXTURE, async () => {
    await ctx.guard();
    const joined = await admin('webmeet_room_join', { roomId: room, displayName: `${ctx.prefix}-participant` }, 'administrator joins the fixture room');
    participant = joined.participantIdentity || joined.participant?.id;
    assert.ok(participant, 'Join returned no participant identity');
    assert.ok(await memberById(participant), 'The administrator observes the joined participant');
  });
  if (participant) {
    const forbiddenRole = `${ctx.prefix}-forbidden-role`;
    await deniedBoth('participant-role',
      actor => call(actor, 'webmeet_participant_update_role', { roomId: room, participantId: participant, role: forbiddenRole }),
      async () => {
        const member = await memberById(participant);
        assert.ok(member, 'A denied role update removed the participant');
        assert.notEqual(member.role, forbiddenRole, 'A denied role update changed the participant role');
      });
    await positive(WEBMEET_POSITIVE_FOR_OP['participant-role'], async () => {
      const role = `${ctx.prefix}-positive-role`;
      await admin('webmeet_participant_update_role', { roomId: room, participantId: participant, role }, 'administrator updates the participant role');
      assert.equal((await memberById(participant))?.role, role, 'The administrator observes the new role');
    });
    await deniedBoth('participant-remove',
      actor => call(actor, 'webmeet_participant_remove', { roomId: room, participantId: participant }),
      async () => assert.ok(await memberById(participant), 'A denied removal removed the participant'));
    await positive(WEBMEET_POSITIVE_FOR_OP['participant-remove'], async () => {
      const removed = await admin('webmeet_participant_remove', { roomId: room, participantId: participant }, 'administrator removes the participant');
      assert.equal(removed.ok, true);
      assert.equal(await memberById(participant), undefined, 'The administrator observes the participant gone');
    });
  } else {
    for (const id of all.filter(entry => /participant-(role|remove)/.test(entry))) await check(id, async () => assert.fail('Participant fixture unavailable'));
  }

  // ---- RoboTeam settings -------------------------------------------------------------
  // The tool's input schema requires every leaf of every settings section and forbids extra keys
  // (AssistOSExplorer webmeetAgent/mcp-config.json webmeet_robo_team_update), and Ploinky validates the
  // arguments before authorization or the handler run. A partial payload would therefore be rejected as
  // invalid arguments for every actor: a denied actor's refusal would be masked and the administrator
  // positive would fail. Both the denied attempts and the positive therefore send the administrator's full
  // current settings, read once before the first denied attempt, with only assistant.name changed.
  let roboSnapshot;
  let roboSnapshotFailure;
  try {
    await ctx.guard();
    const current = await admin('webmeet_robo_team_get', { roomId: room }, 'administrator snapshots RoboTeam settings');
    assert.ok(current.settings && typeof current.settings === 'object' && !Array.isArray(current.settings), 'The RoboTeam settings snapshot is an object');
    assert.equal(typeof current.settings.assistant?.name, 'string', 'The RoboTeam settings snapshot carries assistant.name');
    roboSnapshot = structuredClone(current.settings);
  } catch (error) { roboSnapshotFailure = error; }
  const roboSettingsNamed = name => {
    if (!roboSnapshot) assert.fail(`The RoboTeam settings snapshot is unavailable, so no valid update payload can be built: ${roboSnapshotFailure?.message || 'unknown failure'}`);
    const settings = structuredClone(roboSnapshot);
    settings.assistant.name = name;
    return settings;
  };
  const roboSettings = async () => (await admin('webmeet_robo_team_get', { roomId: room }, 'administrator reads RoboTeam settings')).settings;
  const roboName = async () => (await roboSettings())?.assistant?.name;
  await deniedBoth('robo-team-update',
    actor => call(actor, 'webmeet_robo_team_update', { roomId: room, settings: roboSettingsNamed(`${ctx.prefix}-forbidden-robo`) }),
    async () => {
      if (!roboSnapshot) assert.fail('The RoboTeam settings snapshot is unavailable, so unchanged settings cannot be shown');
      assert.deepEqual(await roboSettings(), roboSnapshot, 'A denied RoboTeam update changed the settings');
    });
  await positive(WEBMEET_POSITIVE_FOR_OP['robo-team-update'], async () => {
    const updated = await admin('webmeet_robo_team_update', { roomId: room, settings: roboSettingsNamed(names.marker) }, 'administrator updates RoboTeam settings');
    assert.equal(updated.settings?.assistant?.name, names.marker);
    assert.equal(await roboName(), names.marker, 'The administrator observes the new settings');
  });
  await deniedBoth('robo-team-get',
    actor => call(actor, 'webmeet_robo_team_get', { roomId: room }),
    async () => {},
    names.marker);
  await positive(WEBMEET_POSITIVE_FOR_OP['robo-team-get'], async () => {
    const read = await admin('webmeet_robo_team_get', { roomId: room }, 'administrator reads RoboTeam settings');
    assert.equal(read.roomId, room);
    assert.equal(read.settings?.assistant?.name, names.marker);
  });

  // ---- RoboTeam agent attach and detach ----------------------------------------------
  const roboAgent = async () => {
    const value = await admin('webmeet_agent_list', { roomId: room }, 'administrator lists room agents');
    const agent = (value.agents || []).find(entry => entry?.agentType === 'robo_team');
    assert.ok(agent, 'The room has its RoboTeam agent');
    return agent;
  };
  // The agent id is read, not assumed; the denied attempts below still require it to be active and attached.
  const agentId = await roboAgent().then(agent => agent.id, () => 'agent_robo_team');
  await deniedBoth('detach',
    actor => call(actor, 'webmeet_agent_detach', { roomId: room, agentId: agentId }),
    async () => { const agent = await roboAgent(); assert.equal(agent.status, 'active', 'A denied detach changed the agent'); assert.ok(!agent.deletedAt); });
  await positive(WEBMEET_POSITIVE_FOR_OP.detach, async () => {
    await admin('webmeet_agent_detach', { roomId: room, agentId: agentId }, 'administrator detaches the agent');
    const agent = await roboAgent();
    assert.equal(agent.status, 'detached', 'The administrator observes the detached agent');
    assert.ok(agent.deletedAt);
  });
  await deniedBoth('attach',
    actor => call(actor, 'webmeet_agent_attach', { roomId: room, agentType: 'robo_team', mode: 'blackboard_demo' }),
    async () => { const agent = await roboAgent(); assert.equal(agent.status, 'detached', 'A denied attach changed the agent'); assert.ok(agent.deletedAt); });
  await positive(WEBMEET_POSITIVE_FOR_OP.attach, async () => {
    await admin('webmeet_agent_attach', { roomId: room, agentType: 'robo_team', mode: 'blackboard_demo' }, 'administrator attaches the agent');
    const agent = await roboAgent();
    assert.equal(agent.status, 'active', 'The administrator observes the attached agent');
    assert.ok(!agent.deletedAt);
  });

  // ---- room resources ------------------------------------------------------------------
  let resourceId;
  const resources = async () => (await admin('webmeet_resource_list', { roomId: room }, 'administrator lists room resources')).resources;
  await positive(RESOURCE_FIXTURE, async () => {
    const authorized = await admin('webmeet_resource_authorize_upload', { roomId: room, filename: 'authz-fixture.txt', mimeType: 'text/plain', size: 1 }, 'administrator authorizes a resource record');
    resourceId = authorized.resourceId;
    assert.ok(resourceId && authorized.storagePath);
    await admin('webmeet_resource_commit_upload', { roomId: room, resourceId, filename: 'authz-fixture.txt', mimeType: 'text/plain', size: 1, storagePath: authorized.storagePath }, 'administrator commits the resource record');
    assert.ok((await resources()).some(entry => entry.resourceId === resourceId), 'The administrator observes the resource');
  });
  if (resourceId) {
    await deniedBoth('resource-remove',
      actor => call(actor, 'webmeet_resource_remove', { roomId: room, resourceId }),
      async () => assert.ok((await resources()).some(entry => entry.resourceId === resourceId && !entry.deletedAt), 'A denied removal removed the resource'));
    await positive(WEBMEET_POSITIVE_FOR_OP['resource-remove'], async () => {
      const removed = await admin('webmeet_resource_remove', { roomId: room, resourceId }, 'administrator removes the resource');
      assert.equal(removed.ok, true);
      assert.equal((await resources()).some(entry => entry.resourceId === resourceId), false, 'The administrator observes the resource gone');
    });
  } else {
    for (const id of all.filter(entry => /resource-remove/.test(entry))) await check(id, async () => assert.fail('Resource fixture unavailable'));
  }

  // ---- rename (positive on the tools room; denials live with the shared fixture) -------------
  await positive(WEBMEET_POSITIVE_FOR_OP.rename, async () => {
    await admin('webmeet_room_rename', { roomId: room, name: names.renamed }, 'administrator renames the room');
    assert.equal(roomName((await getRoom(room, false)).meeting), names.renamed, 'The administrator observes the new name');
  });

  // ---- archive and delete on a separate lifecycle room ----------------------------------------
  let lifecycle;
  await positive(LIFECYCLE_FIXTURE, async () => {
    await ctx.guard();
    lifecycle = await createOwnedRoom(names.lifecycle, [names.lifecycle]);
  });
  if (lifecycle) {
    const state = async () => (await getRoom(lifecycle, false)).meeting;
    await deniedBoth('archive',
      actor => call(actor, 'webmeet_room_archive', { roomId: lifecycle }),
      async () => { const meeting = await state(); assert.notEqual(meeting.status, 'archived', 'A denied archive archived the room'); assert.ok(!meeting.archivedAt); });
    await positive(WEBMEET_POSITIVE_FOR_OP.archive, async () => {
      await admin('webmeet_room_archive', { roomId: lifecycle }, 'administrator archives the room');
      const meeting = await state();
      assert.equal(meeting.status, 'archived', 'The administrator observes the archived room');
      assert.ok(meeting.archivedAt);
    });
    await positive(WEBMEET_POSITIVE_FOR_OP.delete, async () => {
      const deleted = await admin('webmeet_room_delete', { roomId: lifecycle, confirmed: true }, 'administrator deletes the room');
      assert.equal(deleted.deleted, true);
      const gone = await call('admin', 'webmeet_room_get', { roomId: lifecycle });
      assert.equal(gone.failed, true, 'The deleted room is no longer readable');
      assert.match(gone.error, /not found/i);
      assert.equal((await listRooms()).some(entry => roomId(entry) === lifecycle), false);
    });
  } else {
    for (const id of all.filter(entry => /archive|\.delete-positive/.test(entry))) await check(id, async () => assert.fail('Lifecycle fixture unavailable'));
  }
  // Anything this module owns but did not reach is a failure, never a silent absence.
  for (const id of all) if (!recorded.has(id)) await check(id, async () => assert.fail('Check was not reached'));
}
