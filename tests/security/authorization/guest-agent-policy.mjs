/**
 * Reviewed policy for the enabled agents whose own manifest selects guest
 * authentication (expected-runtimes.json `guestAgents`, derived from the pinned
 * manifests). The Router answers an anonymous visitor on their MCP routes with a
 * minted guest session (cli/server/authHandlers/authContext.js:1028-1078), so the
 * route itself does not separate guests from workspace users. What does:
 *
 *  - the exact tool lists below (anonymous and selfRegistered discovery must equal
 *    them, not merely equal the live administrator list);
 *  - the agents' own handlers. WebMeet refuses a guest identity for every tool outside
 *    its allowlist (webmeetAgent/tools/webmeet_tool.mjs:88-96, :255-262) and refuses
 *    a non-admin for the eleven room-management operations pinned here; those eleven
 *    are exercised, with admin-side state verification, by webmeet-admin-tools.mjs.
 *
 * Basis lines are Explorer bdf0f96f unless stated otherwise.
 */

/**
 * The Router's per-route guest session cookie names for the reviewed guest agents.
 * Pinned literally so the harness does not derive them from the product code; the
 * unit test tests/unit/guestCookieNames.test.mjs checks them against the Router
 * helper (cli/server/auth/guestCookieNames.js).
 */
export const GUEST_COOKIE_NAMES = Object.freeze({
  webAssist: 'ploinky_guest_ncGyyzpdIxmPjORN_wQfqv',
  webmeetAgent: 'ploinky_guest_iw2P_FBNZBzQ_b5bTDMOLe',
});

/** The guest cookie name of one reviewed guest route; any other route key is an error. */
export function guestCookieNameFor(routeKey) {
  const name = Object.hasOwn(GUEST_COOKIE_NAMES, String(routeKey || '')) ? GUEST_COOKIE_NAMES[routeKey] : '';
  if (!name) throw new Error(`No reviewed guest cookie name for route '${routeKey}'`);
  return name;
}

export const WEBMEET_GUEST_ALLOWLIST = Object.freeze([
  'webmeet_room_public_get',
  'webmeet_room_join_guest',
  'webmeet_room_guest_get',
  'webmeet_chat_send_guest',
  'webmeet_room_leave',
  'webmeet_presence_heartbeat',
  'webmeet_participant_avatar_update',
]);

/**
 * Every call site of assertAdminAuthInfo (webmeetAgent/lib/store/accessPolicy.mjs:82-86),
 * the function that contains it and the MCP tool that dispatches to it
 * (webmeetAgent/tools/webmeet_tool.mjs). Eleven sites, eleven tools.
 */
export const WEBMEET_ADMIN_ONLY_TOOLS = Object.freeze([
  { op: 'create', tool: 'webmeet_room_create', gate: 'lib/webmeetStore.mjs:475 createMeeting' },
  { op: 'rename', tool: 'webmeet_room_rename', gate: 'lib/webmeetStore.mjs:451 updateMeetingTitle' },
  { op: 'delete', tool: 'webmeet_room_delete', gate: 'lib/services/roomDeletion.mjs:12 deleteRoom' },
  { op: 'archive', tool: 'webmeet_room_archive', gate: 'lib/services/roomArchive.mjs:64 archiveRoom' },
  { op: 'attach', tool: 'webmeet_agent_attach', gate: 'lib/webmeetStore.mjs:602 attachMeetingAgent' },
  { op: 'detach', tool: 'webmeet_agent_detach', gate: 'lib/webmeetStore.mjs:674 detachMeetingAgent' },
  { op: 'resource-remove', tool: 'webmeet_resource_remove', gate: 'lib/webmeetStore.mjs:761 removeRoomResource' },
  { op: 'participant-role', tool: 'webmeet_participant_update_role', gate: 'lib/services/roomParticipants.mjs:981 updateRoomParticipantRole' },
  { op: 'participant-remove', tool: 'webmeet_participant_remove', gate: 'lib/services/roomParticipants.mjs:1007 removeRoomParticipant' },
  { op: 'robo-team-get', tool: 'webmeet_robo_team_get', gate: 'lib/roboTeam/service.mjs:333 getRoboTeamSettings' },
  { op: 'robo-team-update', tool: 'webmeet_robo_team_update', gate: 'lib/roboTeam/service.mjs:347 updateRoboTeamSettings' },
]);

const WEBMEET_TOOLS = Object.freeze([
  'webmeet_agent_attach', 'webmeet_agent_detach', 'webmeet_agent_list', 'webmeet_attachment_publish', 'webmeet_blackboard_get',
  'webmeet_blackboard_workspace_get', 'webmeet_chat_list', 'webmeet_chat_send', 'webmeet_chat_send_guest', 'webmeet_event_command',
  'webmeet_media_commit', 'webmeet_participant_avatar_update', 'webmeet_participant_list', 'webmeet_participant_remove',
  'webmeet_participant_update_role', 'webmeet_presence_heartbeat', 'webmeet_resource_authorize_download', 'webmeet_resource_authorize_upload',
  'webmeet_resource_commit_upload', 'webmeet_resource_list', 'webmeet_resource_remove', 'webmeet_robo_team_get', 'webmeet_robo_team_update',
  'webmeet_room_archive', 'webmeet_room_create', 'webmeet_room_delete', 'webmeet_room_events_list', 'webmeet_room_get', 'webmeet_room_guest_get',
  'webmeet_room_join', 'webmeet_room_join_guest', 'webmeet_room_leave', 'webmeet_room_list', 'webmeet_room_public_get', 'webmeet_room_rename',
  'webmeet_scripta_sync_apply', 'webmeet_scripta_sync_close', 'webmeet_scripta_sync_open', 'webmeet_scripta_sync_pull', 'webmeet_scripta_workspace_list',
]);

/**
 * webAssist anonymous policy, decided from source. The guest widget
 * (webAssist/IDE-plugins/web-assist-chat/web-assist-chat.js:246-248) uses
 * web_cli_chat, web_cli_history and register-events; list-sites is used only by the
 * settings component (webassist-settings.js:306) and returns every site id and the
 * absolute data root (src/mcp/list-sites.mjs, listSites), which a website visitor has
 * no use for. So:
 *
 *   list-sites       deny      exercised live (agent-probes.mjs, webAssistAnonymousProbes)
 *   web_cli_chat     allow     not invoked: it performs inference, which this suite never runs
 *   register-events  allow     not invoked: it appends to a site event log that has no removal path
 *   web_cli_history  allow     own session, or the client-held sessionSecret, or an administrator;
 *                              isolation is exercised with sessions seeded by webassist-fixture.mjs
 *                              because only web_cli_chat (inference) can create one
 */
/**
 * Tools whose input schema must declare an optional string `sessionSecret`
 * (webAssist/mcp-config.json). The exact name matters twice: an undeclared argument is
 * dropped by the AgentServer schema and the Router canonicalization before the tool
 * runs, and AgentServer redacts argument keys matching /secret/i from its debug output.
 */
export const WEBASSIST_SESSION_SECRET_TOOLS = Object.freeze(['web_cli_chat', 'web_cli_history']);

export const GUEST_AGENT_POLICY = Object.freeze({
  webAssist: Object.freeze({
    repo: 'AchillesIDE',
    tools: Object.freeze(['list-sites', 'register-events', 'web_cli_chat', 'web_cli_history']),
    resources: Object.freeze([]),
    anonymous: Object.freeze({
      'list-sites': 'deny',
      'register-events': 'allow-not-invoked',
      web_cli_chat: 'allow-not-invoked',
      web_cli_history: 'allow-own-session-or-secret',
    }),
  }),
  webmeetAgent: Object.freeze({
    repo: 'AchillesIDE',
    tools: WEBMEET_TOOLS,
    resources: Object.freeze([]),
    guestAllowlist: WEBMEET_GUEST_ALLOWLIST,
    adminOnly: Object.freeze(WEBMEET_ADMIN_ONLY_TOOLS.map(entry => entry.tool).sort()),
  }),
});

export function pinnedGuestList(agent, field) {
  const policy = GUEST_AGENT_POLICY[agent];
  if (!policy) throw new Error(`Guest agent ${agent} has no reviewed policy`);
  const list = field === 'tools' ? policy.tools : field === 'resources' ? policy.resources : null;
  if (!list) throw new Error(`No reviewed ${field} list for guest agent ${agent}`);
  return [...list].sort();
}
