import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { agentCatalog, agentInventory } from './agent-inventory.mjs';
import { assertDenied, Client, WORKSPACE } from './core.mjs';
import { GUEST_AGENT_POLICY, WEBASSIST_SESSION_SECRET_TOOLS, pinnedGuestList } from './guest-agent-policy.mjs';

const actors = ['anonymous', 'selfRegistered', 'userA', 'userB', 'admin'];
const profilePath = '/base-agent-additional-server/userPersistoAgent/7000/service/dashboard/api/profile';
export const agentProbes = [
    { id: 'agent.soul.management.me', method: 'GET', path: '/base-agent-additional-server/soul-gateway/7000/management/me', policy: 'admin' },
    { id: 'agent.soul.management.models', method: 'GET', path: '/base-agent-additional-server/soul-gateway/7000/management/models', policy: 'admin' },
    { id: 'agent.soul.management.providers', method: 'GET', path: '/base-agent-additional-server/soul-gateway/7000/management/providers', policy: 'admin' },
    { id: 'agent.robot.list', method: 'GET', path: '/base-agent-additional-server/roboTeamAgent/3001/api/robots', policy: 'workspace' },
];
export const agentReadTools = [
    { agent: 'userPersistoAgent', tool: 'userpersisto_profile_get', policy: 'own-account' },
    { agent: 'userPersistoAgent', tool: 'userpersisto_user_list', args: { pageSize: 1 }, policy: 'admin' },
    { agent: 'userPersistoAgent', tool: 'userpersisto_config_get', policy: 'admin' },
    { agent: 'userPersistoAgent', tool: 'userpersisto_auth_policy_get', policy: 'admin' },
    { agent: 'userPersistoAgent', tool: 'userpersisto_google_status', policy: 'admin' },
    { agent: 'userPersistoAgent', tool: 'userpersisto_oidc_status', policy: 'admin' },
    { agent: 'emailAgent', tool: 'email_config_get', policy: 'admin' },
    { agent: 'emailAgent', tool: 'email_provider_status', policy: 'admin' },
    { agent: 'workspaceMonitorAgent', tool: 'workspace_monitor_settings_get', policy: 'admin' },
    { agent: 'workspaceMonitorAgent', tool: 'workspace_monitor_snapshot_get', policy: 'admin' },
    { agent: 'dpuAgent', tool: 'dpu_whoami', policy: 'workspace' },
    { agent: 'dpuAgent', tool: 'dpu_workspace_roots', policy: 'workspace' },
    // Lesser authenticated users receive an exactly empty room list, not an error.
    { agent: 'webmeetAgent', tool: 'webmeet_room_list', policy: 'workspace', lesserUserFilteredField: 'rooms' },
    { agent: 'webmeetAgent', tool: 'webmeet_room_events_list', args: { roomId: 'rooms' }, policy: 'workspace' },
    { agent: 'gitAgent', tool: 'git_auth_status', policy: 'workspace' },
];
export const agentDiscoveryMethods = [
    { method: 'tools/list', field: 'tools' },
    { method: 'resources/list', field: 'resources' },
    { method: 'resources/templates/list', field: 'resourceTemplates' },
    { method: 'prompts/list', field: 'prompts' },
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const explicitFailure = (value) => isObject(value) && (value.ok === false || value.success === false || value.isError === true || Boolean(value.error));
function requireObject(value) {
    assert.ok(isObject(value), 'Expected a structured operation result');
    assert.ok(!explicitFailure(value), 'Operation returned a failure payload');
}
function requireFields(value, fields, type) {
    requireObject(value);
    for (const field of fields) assert.equal(typeof value[field], type, `Expected ${type} field ${field}`);
}
function requireNamedList(value, field) {
    requireObject(value);
    assert.ok(Array.isArray(value[field]), 'Expected a discovery array');
    for (const item of value[field]) {
        requireObject(item);
        assert.ok(typeof item.name === 'string' && item.name.length, 'Discovery entry requires a name');
        if (field === 'resources') assert.ok(typeof item.uri === 'string' && item.uri.length, 'Resource requires a URI');
        if (field === 'resourceTemplates') assert.ok(typeof item.uriTemplate === 'string' && item.uriTemplate.length, 'Resource template requires a URI template');
    }
}

// Shapes come from the pinned handlers listed in agent-inventory. A status code
// or an empty object cannot establish a functioning authorized control.
export function assertAgentHttpPositive(probe, response, principal) {
    assert.equal(response.status, 200, 'Authorized HTTP control requires success');
    const value = response.json;
    requireObject(value);
    switch (probe.id) {
        case 'agent.soul.management.me':
            assert.equal(value.authenticated, true);
            requireFields(value.user, ['id', 'username', 'keyOwner'], 'string');
            assert.ok(value.user.id.length && value.user.keyOwner.length);
            assert.ok(Array.isArray(value.user.roles) && value.user.roles.includes('admin'));
            if (principal) assert.equal(value.user.id, principal.id, 'Management result belongs to the current principal');
            break;
        case 'agent.soul.management.models':
        case 'agent.soul.management.providers':
            assert.ok(Array.isArray(value.data), 'Management list requires data array');
            for (const item of value.data) { requireObject(item); assert.ok(typeof item.id === 'string' && item.id.length); }
            break;
        case 'agent.robot.list':
            assert.equal(value.ok, true);
            assert.ok(Array.isArray(value.robots));
            assert.equal(typeof value.canAdmin, 'boolean');
            for (const robot of value.robots) { requireObject(robot); assert.ok(typeof robot.id === 'string' && robot.id.length); }
            if (principal) assert.equal(value.canAdmin, principal.roles.includes('admin'), 'Robot administration projection must match persisted role');
            break;
        default: assert.fail('No source-derived HTTP response validator exists');
    }
}

export function assertAgentReadPositive(probe, result, principal) {
    assert.equal(result.success, true, 'Authorized MCP control requires a real successful result');
    const value = result.value;
    requireObject(value);
    switch (probe.tool) {
        case 'userpersisto_profile_get':
            requireFields(value.user, ['id', 'username'], 'string');
            assert.ok(value.user.id.length && Array.isArray(value.roles) && Array.isArray(value.capabilities) && Array.isArray(value.authMethods));
            assert.equal(typeof value.emailVerified, 'boolean');
            if (principal) assert.equal(value.user.id, principal.id, 'Own-account result belongs to current principal');
            break;
        case 'userpersisto_user_list':
            assert.ok(Array.isArray(value.users) && value.users.length === 1, 'Page size one must include an existing user');
            assert.ok(Number.isInteger(value.totalCount) && value.totalCount >= 1);
            assert.ok(typeof value.users[0]?.id === 'string' && value.users[0].id.length);
            break;
        case 'userpersisto_config_get':
            requireFields(value, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_PRICE_CREDITS', 'STRIPE_PRICE_SUBSCRIPTION', 'USERPERSISTO_CREDITS_PER_UNIT', 'USERPERSISTO_BILLING_SUCCESS_URL', 'USERPERSISTO_BILLING_CANCEL_URL'], 'string');
            break;
        case 'userpersisto_auth_policy_get':
            assert.ok(Array.isArray(value.enabledAuthMethods) && value.enabledAuthMethods.length > 0);
            assert.ok(Array.isArray(value.allowedRedirectOrigins) && Array.isArray(value.environmentOverrides));
            assert.equal(typeof value.selfRegistrationEnabled, 'boolean');
            assert.equal(value.registrationRole, 'selfRegistered');
            break;
        case 'userpersisto_google_status':
            // userPersistoAgent/lib/auth/google.mjs getGoogleStatus: readiness and the
            // exact callback, never a secret. `secretRequired` is a constant false (the
            // GIS flow has no client secret) and `secretPresent` must not exist.
            requireFields(value, ['enabled', 'configured', 'available', 'secretRequired'], 'boolean');
            requireFields(value, ['mode', 'redirectUri', 'clientId', 'configurationSource', 'policySource', 'reason'], 'string');
            assert.equal(value.secretRequired, false, 'The Google GIS status never requires a client secret');
            assert.equal(Object.hasOwn(value, 'secretPresent'), false, 'Google status must not report secret presence');
            assert.ok(Array.isArray(value.missing) && value.missing.every(name => typeof name === 'string'));
            break;
        case 'userpersisto_oidc_status':
            requireFields(value, ['enabled'], 'boolean');
            requireFields(value, ['issuer', 'discoveryUrl'], 'string');
            break;
        case 'email_config_get':
            requireFields(value, ['MAILJET_API_KEY', 'MAILJET_API_SECRET', 'MAILJET_FROM_EMAIL', 'MAILJET_FROM_NAME', 'EMAIL_AUTH_CODE_TEMPLATE_ID'], 'string');
            break;
        case 'email_provider_status':
            requireFields(value, ['configured'], 'boolean');
            requireFields(value, ['fromEmail'], 'string');
            break;
        case 'workspace_monitor_settings_get':
            assert.equal(value.ok, true);
            requireObject(value.settings);
            for (const field of ['workspaceCpuPercent', 'workspaceMemoryBytes', 'routerCpuPercent', 'routerMemoryBytes', 'logRetentionDays']) assert.ok(Number.isFinite(value.settings[field]), 'Monitor settings must contain finite numeric limits');
            break;
        case 'workspace_monitor_snapshot_get':
            assert.equal(value.ok, true);
            requireFields(value, ['available', 'stale'], 'boolean');
            if (value.available) {
                requireObject(value.snapshot);
                assert.ok(Array.isArray(value.snapshot.runtimes) && Number.isFinite(Date.parse(value.snapshot.sampledAt)));
                assert.ok(Number.isFinite(value.ageMs));
            } else { assert.equal(value.snapshot, null); assert.equal(value.ageMs, null); }
            break;
        case 'dpu_whoami':
            assert.equal(value.ok, true);
            assert.equal(value.authenticated, true);
            requireFields(value.actor, ['id', 'principalId'], 'string');
            assert.ok(value.actor.id.length && Array.isArray(value.actor.roles));
            requireFields(value.userSpace, ['privateId', 'mySpaceRootId'], 'string');
            if (principal) assert.equal(value.actor.id, principal.id, 'DPU actor must match current principal');
            break;
        case 'dpu_workspace_roots':
            assert.equal(value.ok, true);
            requireFields(value.roots?.mySpace, ['id', 'path'], 'string');
            assert.ok(value.roots.mySpace.id.length);
            assert.equal(value.roots?.confidential?.path, '/Confidential');
            for (const field of ['sharedFiles', 'secrets', 'researchData', 'jobs']) requireFields(value.roots[field], ['scope', 'path', 'type'], 'string');
            break;
        case 'webmeet_room_list':
            assert.ok(Array.isArray(value.rooms));
            assert.equal(typeof value.canManageRooms, 'boolean');
            if (principal) assert.equal(value.canManageRooms, principal.roles.includes('admin'), 'Room management must follow persisted role');
            // With a task-owned open room, an entitled listing that omits it
            // (including an empty list) is not a working positive control.
            if (probe.requiredRoomId) assert.ok(value.rooms.some((room) => room?.id === probe.requiredRoomId || room?.roomId === probe.requiredRoomId), 'Entitled room listing must include the task-owned open team room');
            break;
        case 'webmeet_room_events_list':
            assert.ok(Array.isArray(value.events), 'Workspace room feed requires an events array');
            assert.ok(probe.requiredRoomId, 'Workspace room feed requires a task-owned room');
            assert.ok(value.events.map(decodeWorkspaceRoomEvent).some(({ type, payload }) =>
                type === 'meeting.created' && payload.meetingId === probe.requiredRoomId &&
                payload.roomId === probe.requiredRoomId && payload.workspaceId === 'rooms' &&
                payload.meeting?.id === probe.requiredRoomId &&
                (!probe.requiredRoomName || payload.meeting.name === probe.requiredRoomName)),
            'Workspace room feed must include the decoded creation event for the task-owned visible room');
            break;
        case 'git_auth_status':
            assert.equal(value.ok, true);
            requireFields(value, ['configured', 'connected', 'tokenStored'], 'boolean');
            requireFields(value.setup, ['configured'], 'boolean');
            requireFields(value.setup, ['scope'], 'string');
            assert.ok(value.connection === null || isObject(value.connection));
            assert.ok(value.pending === null || isObject(value.pending));
            break;
        default: assert.fail('No source-derived read-tool response validator exists');
    }
}

function decodeWorkspaceRoomEvent(encoded) {
    assert.equal(typeof encoded, 'string', 'Feed entries must be encoded events');
    const match = /^rooms:([^:]+):([A-Za-z0-9_-]+)$/.exec(encoded);
    assert.ok(match, 'Feed entry must use the workspace event wire format');
    const payload = JSON.parse(Buffer.from(match[2], 'base64url').toString('utf8'));
    requireObject(payload);
    assert.ok(typeof payload.id === 'string' && payload.id.length, 'Feed event needs an event ID');
    assert.ok(typeof payload.createdAt === 'string' && Number.isFinite(Date.parse(payload.createdAt)), 'Feed event needs a timestamp');
    return { type: match[1], payload };
}

// A filtered empty listing proves nothing against an empty store. Require an
// owned open room and fail fixture errors instead of recording coverage gaps.
export async function createRoomListingFixture(ctx, mcp) {
    let fixture;
    await ctx.check('agent.tool.webmeet_room_list.fixture', async () => {
        const name = `${ctx.prefix}-listing-room`;
        const rpc = async (tool, args = {}) => {
            await ctx.guard();
            return mcp.rpc('admin', 'webmeetAgent', 'tools/call', { name: tool, arguments: args });
        };
        const identity = view => {
            const id = view?.id || view?.roomId;
            assert.ok(typeof id === 'string' && /^room_[0-9a-f-]{36}$/i.test(id), 'Room response returned no authoritative room ID');
            return id;
        };
        const roomName = view => view?.name || view?.title;
        const list = async () => {
            const result = await rpc('webmeet_room_list');
            assertAgentReadPositive({ tool: 'webmeet_room_list' }, result);
            assert.equal(result.value.canManageRooms, true, 'Room cleanup requires an authoritative administrator listing');
            for (const room of result.value.rooms) identity(room);
            return result.value.rooms;
        };
        const baseline = await list();
        assert.equal(baseline.some(room => roomName(room) === name), false, 'Fixture run name already belongs to a preexisting room');
        const baselineIds = new Set(baseline.map(identity));
        assert.equal(baselineIds.size, baseline.length, 'Baseline room listing contains duplicate identities');
        let roomId, cleaned = false;
        // The create RPC can persist before its response or private artifact
        // fails. Arm reconciliation before dispatch, while ownership is known.
        ctx.cleanup(async () => {
            if (cleaned) return;
            const matches = (await list()).filter(room => roomName(room) === name);
            assert.equal(matches.length, 1, 'Room cleanup ownership unresolved: expected one exact run-name match');
            const reconciledId = identity(matches[0]);
            assert.equal(baselineIds.has(reconciledId), false, 'Room cleanup cannot delete a preexisting identity');
            if (roomId) assert.equal(reconciledId, roomId, 'Listing room cleanup identity mismatch');
            else roomId = reconciledId;
            const current = await rpc('webmeet_room_get', { roomId });
            assert.equal(current.success, true, 'Listing room cleanup could not read the owned room');
            const view = current.value?.meeting || current.value?.room || current.value;
            assert.equal(identity(view), roomId, 'Listing room cleanup identity mismatch');
            assert.equal(roomName(view), name, 'Listing room cleanup name mismatch');
            const deleted = await rpc('webmeet_room_delete', { roomId, confirmed: true });
            assert.equal(deleted.success, true, 'Listing room cleanup delete failed');
            assert.equal(deleted.value?.ok, true, 'Listing room cleanup delete must report ok');
            assert.equal(deleted.value?.deleted, true, 'Listing room cleanup delete must report removal');
            assert.equal(deleted.value?.roomId, roomId, 'Listing room cleanup delete identity mismatch');
            const absent = await rpc('webmeet_room_get', { roomId });
            assert.equal(absent.stage, 'tools/call', 'Listing room cleanup absence must come from the get tool');
            assert.equal(absent.response?.status, 200, 'Listing room cleanup absence cannot be an HTTP failure');
            assert.equal(absent.success, false, 'Listing room cleanup absence failed: owned room remains readable');
            // AgentServer wraps a failed tool subprocess in SDK InternalError;
            // registerTool preserves its exact prefixed message as isError text.
            assert.ok(['Meeting not found.', 'MCP error -32603: Meeting not found.'].includes(absent.error?.trim()),
                'Listing room cleanup absence requires the exact missing-meeting contract');
            cleaned = true;
        });
        const created = await rpc('webmeet_room_create', { name, roomType: 'team' });
        assert.equal(created.success, true, 'Administrator could not create the task-owned listing room');
        roomId = identity(created.value);
        assert.equal(baselineIds.has(roomId), false, 'Room creation returned a preexisting identity');
        fixture = { roomId, name };
    });
    return fixture;
}

export function assertAgentFilteredEmpty(probe, result, principal) {
    assertAgentReadPositive({ ...probe, requiredRoomId: undefined }, result, principal);
    assert.deepEqual(result.value[probe.lesserUserFilteredField], [], 'Lesser user must receive an exactly empty filtered listing');
    if (probe.tool === 'webmeet_room_list') assert.equal(result.value.canManageRooms, false, 'Lesser user must not receive room management');
}

export function decodeAgentMcp(response) {
    const rpc = response.json;
    const result = rpc?.result;
    const textBlocks = result?.content?.filter((b) => b.type === 'text') || [];
    let value = result?.structuredContent ?? result;
    const representations = [result, result?.structuredContent];
    // AgentServer adds stderr as a second text block. It must not hide a real
    // structured failure in stdout or turn a denial into an apparent success.
    for (const [index, block] of textBlocks.entries()) { try { const parsed = JSON.parse(block.text); representations.push(parsed); if (index === 0) value = parsed; } catch {} }
    for (const block of result?.content || []) if (block.type === 'json') { representations.push(block.json); value = block.json; }
    const failed = representations.some(explicitFailure);
    return { response, value, success: Boolean(response.status === 200 && rpc && !rpc.error && isObject(result) && !failed),
        error: [rpc?.error?.message, ...representations.filter(isObject).flatMap((v) => [v.message, typeof v.error === 'object' ? JSON.stringify(v.error) : v.error]), result?.isError ? textBlocks.map((b) => b.text).join(' ') : ''].filter(Boolean).join(' ') };
}
export function assertAgentMcpDenied(result) {
    if ([401, 403].includes(result.response.status)) return assertDenied(result.response);
    assert.equal(result.response.status, 200, 'Non-authorization status cannot establish denied MCP access');
    assert.equal(result.success, false, 'Forbidden tool succeeded');
    assert.match(result.error, /access.denied|forbidden|unauthori[sz]ed|authentication.{0,30}required|admin.{0,35}required|only.{0,20}admin|requires.{0,20}administrator|permission.denied|capability|agent.invocation.required|not.allowed/i, 'MCP failure must identify authorization, not validation or missing resource');
}

/**
 * Anonymous discovery on an agent whose own manifest selects guest
 * authentication (cli/utils/manifestAuth.js:21; expected-runtimes.json
 * `guestAgents`, derived from the pinned manifests). The Router answers an
 * anonymous visitor on such a route with a minted guest session
 * (cli/server/authHandlers/authContext.js:1028-1078), so a successful list is the
 * declared contract, not a denial bypass. Two things carry the contract: the agent
 * must be in the manifest-derived guest set (the caller only reaches this
 * assertion for such an agent) and the list must be a valid named list that
 * equals the administrator-visible list exactly. The guest-session cookie is
 * supporting evidence only: it comes from the shared anonymous jar, so an earlier
 * guest route could have supplied it. Tool calls stay denied by their own checks.
 */
export function assertGuestDiscovery(result, { field, adminNames, guestCookie, pinned }) {
    assert.equal(result.response.status, 200, 'Guest discovery must be answered with HTTP 200');
    assert.ok(result.success, 'A guest-authentication agent must answer an anonymous visitor\'s discovery');
    requireNamedList(result.value, field);
    // The reviewed list, not only the live administrator list: a changed tool surface needs a new review.
    assert.deepEqual(pinned, [...pinned].sort(), 'The reviewed list must be sorted');
    assert.deepEqual(adminNames, pinned, 'The administrator-visible names differ from the reviewed guest-agent list');
    assert.deepEqual(result.value[field].map((item) => item.name).sort(), pinned, 'Guest discovery must expose exactly the reviewed names');
    assert.equal(guestCookie, true, 'Anonymous access must come from a minted guest session, not from an unauthenticated route');
}
export function hasGuestCookie(client, init) {
    const jar = (client?.cookies || []).some((cookie) => cookie.name === 'ploinky_guest' && cookie.value);
    const header = [].concat(init?.headers?.['set-cookie'] || []).some((line) => /^ploinky_guest=[^;]+/.test(line));
    return jar || header;
}

/**
 * userPersistoAgent's MCP route inherits the workspace agent's required
 * capability: a default (non-owned) route needs both owners' capabilities
 * (cli/server/authHandlers/authContext.js, resolveAuthenticatedRouteAuthContext),
 * and the Explorer manifest requires `explorer.access`
 * (explorer/manifest.json routerAccess.requiredCapability). A selfRegistered
 * account has no such capability, so the MCP initialize is refused with that exact
 * 403 before any tool runs, while the account's own profile stays reachable on the
 * owned authenticated dashboard route. The own-profile read is the positive
 * control for the account-scoped operation; the exact refusal is the denial.
 */
export async function assertOwnAccountRouteGate(ctx, probe, result, actor) {
    const own = await ctx.request(actor, { path: profilePath });
    assert.equal(own.status, 200, 'The account\'s own profile must be readable on the owned dashboard route');
    requireObject(own.json);
    assert.equal(own.json.ok, true);
    assertAgentReadPositive(probe, { success: true, value: own.json.profile }, ctx.principals[actor]);
    assert.equal(result.stage, 'initialize', 'The route refuses the session before any tool call');
    assert.equal(result.response.status, 403);
    assert.equal(result.response.json?.ok, false);
    assert.equal(result.response.json?.error, 'required_capability_missing');
    assert.equal(result.response.json?.requiredCapability, 'explorer.access');
}

export function createAgentSessions(ctx) {
    const sessions = new Map();
    let id = 0;
    async function initialize(actor, agent) {
        const key = `${actor}:${agent}`;
        if (sessions.has(key)) return sessions.get(key);
        const headers = { accept: 'application/json, text/event-stream' };
        if (actor !== 'anonymous') {
            const proof = await ctx.request(actor, { path: `/auth/token?agent=${encodeURIComponent(agent)}` });
            // A failed preparation request is never returned as evidence about
            // an agent route which has not yet been contacted.
            assert.equal(proof.status, 200, 'Cannot prepare actual agent request: browser proof unavailable');
            const csrf = proof.json?.browserMutation?.csrfToken;
            assert.ok(typeof csrf === 'string' && csrf, 'Missing MCP route-specific browser proof');
            assert.equal(proof.json?.browserMutation?.routeKey, agent, 'Browser proof is bound to wrong route');
            ctx.secrets.add(csrf);
            headers['x-ploinky-browser-csrf-token'] = csrf;
        }
        const init = await ctx.request(actor, { method: 'POST', path: `/${agent}/mcp`, headers,
            body: { jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'authorization-regression', version: '1' } } } });
        const sessionId = init.headers['mcp-session-id'];
        if (!decodeAgentMcp(init).success || typeof init.json?.result?.protocolVersion !== 'string' || !init.json.result.protocolVersion || typeof sessionId !== 'string' || !sessionId) return { failure: init };
        ctx.secrets.add(sessionId);
        const session = { headers: { ...headers, 'mcp-session-id': sessionId, 'mcp-protocol-version': init.json.result.protocolVersion }, init };
        sessions.set(key, session);
        return session;
    }
    async function rpc(actor, agent, method, params = {}) {
        const session = await initialize(actor, agent);
        if (session.failure) return { ...decodeAgentMcp(session.failure), stage: 'initialize' };
        return { ...decodeAgentMcp(await ctx.request(actor, { method: 'POST', path: `/${agent}/mcp`, headers: session.headers,
            body: { jsonrpc: '2.0', id: ++id, method, params } })), stage: method };
    }
    ctx.cleanup(async () => {
        const failures = [];
        for (const [key, session] of sessions) {
            try {
                const split = key.indexOf(':');
                const actor = key.slice(0, split), agent = key.slice(split + 1);
                const response = await ctx.request(actor, { method: 'DELETE', path: `/${agent}/mcp`, headers: session.headers });
                const alreadyClosed = response.status === 404 && response.json?.error?.code === -32001 && response.json.error.message === 'Session not found';
                assert.ok(([200, 202, 204].includes(response.status) && !explicitFailure(response.json)) || alreadyClosed, 'Agent MCP session cleanup did not return a successful close or exact already-closed result');
                sessions.delete(key);
            } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, `${failures.length} agent MCP session cleanup(s) failed`);
    });
    return { initialize, rpc };
}

export async function discoverAgentMcp(ctx, mcp, catalog = agentCatalog) {
    ctx.report.discovery ||= [];
    for (const agent of catalog) {
        if (!agent.enabled) { ctx.recordGap(`agent.${agent.agent}.disabled`, 'Manifest and tools inventoried; runtime disabled/on-demand. No functional positive control and agent was not enabled.', { kind: 'agent-disabled', repo: agent.repo, agent: agent.agent }); continue; }
        // Reviewed capability classification (policy.json `capabilities`): skip only
        // the exact non-applicable surfaces; the report lists them separately and
        // retained real-service controls run in capability-probes.mjs.
        const classified = (ctx.capabilities || []).find((c) => c.repo === agent.repo && c.agent === agent.agent);
        const notApplicable = new Set(classified?.nonApplicable || []);
        const guestAgent = (ctx.guestAgents || []).some((g) => g.repo === agent.repo && g.agent === agent.agent);
        for (const definition of agentDiscoveryMethods) {
            if (notApplicable.has(`mcp-discovery:${definition.method}`)) continue;
            const id = `agent.${agent.agent}.discovery.${definition.method.replaceAll('/', '.')}`;
            let baseline;
            try {
                baseline = await mcp.rpc('admin', agent.agent, definition.method);
                if (baseline.response.json?.error?.code === -32601) {
                    // Typed evidence: an initialization -32601 (stage 'initialize') can never
                    // satisfy a reviewed discovery-method exclusion.
                    ctx.recordGap(id, 'Runtime explicitly does not support this MCP discovery method. No authorization or empty-list claim is made.', {
                        kind: 'rpc-method-unsupported', actor: 'admin', endpoint: `/${agent.agent}/mcp`, requestedMethod: definition.method,
                        stage: baseline.stage, initialized: baseline.stage !== 'initialize', httpStatus: baseline.response.status, rpcCode: -32601,
                    });
                    continue;
                }
                assert.ok(baseline.success);
                requireNamedList(baseline.value, definition.field);
            } catch {
                ctx.recordGap(id, 'Administrator discovery control unavailable or returned an unexpected response shape; inspect the private response artifact. No denial is counted.', {
                    kind: 'positive-unavailable', actor: 'admin', endpoint: `/${agent.agent}/mcp`, requestedMethod: definition.method,
                    stage: baseline?.stage, httpStatus: baseline?.response?.status, rpcCode: baseline?.response?.json?.error?.code,
                    errorCode: typeof baseline?.response?.json?.error === 'string' ? baseline.response.json.error : undefined,
                });
                continue;
            }
            const names = baseline.value[definition.field].map((item) => item.name).sort();
            const sourceNames = definition.field === 'tools' ? agent.tools : [];
            ctx.report.discovery.push({ agent: agent.agent, actor: 'admin', method: definition.method, stage: baseline.stage,
                [definition.field]: names, sourceOnly: sourceNames.filter((n) => !names.includes(n)), runtimeOnly: names.filter((n) => !sourceNames.includes(n)) });
            if (baseline.value.nextCursor) ctx.recordGap(`${id}.pagination`, 'Discovery returned a continuation cursor; only the bounded first page is inventoried.', { kind: 'pagination', actor: 'admin', requestedMethod: definition.method });
            await ctx.check(`${id}.positive`, async () => requireNamedList(baseline.value, definition.field));
            for (const actor of actors.filter((a) => a !== 'admin')) {
                await ctx.check(`${id}.${actor}`, async () => {
                    const result = await mcp.rpc(actor, agent.agent, definition.method);
                    const visible = Array.isArray(result.value?.[definition.field]) ? result.value[definition.field].map((item) => item.name).sort() : [];
                    ctx.report.discovery.push({ agent: agent.agent, actor, method: definition.method, stage: result.stage,
                        [definition.field]: visible, status: result.response.status });
                    if (actor === 'anonymous' && guestAgent) {
                        // The cached session of this very result; a failed initialize is not retried.
                        const session = result.stage === 'initialize' ? null : await mcp.initialize('anonymous', agent.agent);
                        assertGuestDiscovery(result, { field: definition.field, adminNames: names, guestCookie: hasGuestCookie(ctx.clients?.anonymous, session?.init), pinned: pinnedGuestList(agent.agent, definition.field) });
                    } else if (actor === 'anonymous' || (actor === 'selfRegistered' && agent.agent === 'explorer')) assertAgentMcpDenied(result);
                    else if (!result.success) {
                        if (result.response.json?.error?.code === -32601) {
                            ctx.recordGap(`${id}.${actor}.unsupported`, 'This principal received unsupported-method response despite a working administrator control. This is not an authorization denial.', { kind: 'actor-unsupported', actor, requestedMethod: definition.method, stage: result.stage, httpStatus: result.response.status, rpcCode: -32601 });
                            throw new Error('Unknown discovery authorization outcome: unsupported method for this principal');
                        }
                        assertAgentMcpDenied(result); // Explicit policy may hide discovery from authenticated roles.
                    } else {
                        requireNamedList(result.value, definition.field);
                        if (result.value.nextCursor) ctx.recordGap(`${id}.${actor}.pagination`, 'Only the bounded first discovery page was read.', { kind: 'pagination', actor, requestedMethod: definition.method });
                        // Listing metadata does not establish execution or resource-read permission.
                        if (actor === 'selfRegistered' && agent.agent !== 'userPersistoAgent' && visible.length) ctx.recordGap(`${id}.selfRegistered.scope`, 'Workspace discovery metadata is visible to selfRegistered; tool calls and resource reads require separate authorization controls.', { kind: 'selfregistered-visible-tools', actor, endpoint: `/${agent.agent}/mcp`, requestedMethod: definition.method, stage: result.stage, httpStatus: result.response.status, visibleTools: visible });
                    }
                });
            }
        }
        // The public agent MCP route serves POST/DELETE only: GET returns 405
        // event_stream_not_supported with Allow: POST, DELETE
        // (cli/server/mcp-proxy/index.js:827-830). Record that exact transport
        // contract as typed evidence from a real initialized administrator
        // session; any other outcome (200, 404, 503, transport error) is typed
        // differently and never matches the reviewed entry.
        if (notApplicable.has('mcp-get-transport')) continue;
        const transportId = `agent.${agent.agent}.mcp-get-transport`;
        let session, stream;
        try {
            session = await mcp.initialize('admin', agent.agent);
            if (session.failure) throw new Error('No administrator MCP session');
            stream = await ctx.request('admin', { path: `/${agent.agent}/mcp`, headers: { ...session.headers, accept: 'text/event-stream' }, stream: true });
        } catch {
            ctx.recordGap(transportId, 'Administrator MCP session unavailable; the GET transport contract was not observed.', { kind: 'positive-unavailable', actor: 'admin', endpoint: `/${agent.agent}/mcp` });
            continue;
        }
        const allow = String(stream.headers?.allow || '').replace(/\s+/g, '');
        const unsupported = stream.status === 405 && stream.json?.error === 'event_stream_not_supported';
        ctx.recordGap(transportId, unsupported
            ? 'The public agent MCP route does not offer a GET event stream (405 event_stream_not_supported); POST/session ownership is asserted separately.'
            : `Unexpected GET /mcp outcome (HTTP ${stream.status}); not the reviewed unsupported-transport contract.`,
        { kind: unsupported ? 'unsupported-transport' : 'positive-unavailable', actor: 'admin', endpoint: `/${agent.agent}/mcp`, httpStatus: stream.status, errorCode: typeof stream.json?.error === 'string' ? stream.json.error : undefined, allow });
    }
}

export async function readTools(ctx, mcp, roomFixture) {
    ctx.report.agentReadResults ||= [];
    for (const listedProbe of agentReadTools) {
        const filteredListing = Boolean(listedProbe.lesserUserFilteredField);
        const fixtureRequired = filteredListing || listedProbe.tool === 'webmeet_room_events_list';
        if (fixtureRequired && !roomFixture) {
            await ctx.check(`agent.tool.${listedProbe.tool}.fixture-required`, async () => assert.fail('Task-owned room fixture unavailable; no listing or feed claim can be made'));
            continue;
        }
        const probe = fixtureRequired ? { ...listedProbe, requiredRoomId: roomFixture.roomId, requiredRoomName: roomFixture.name } : listedProbe;
        let positive;
        try {
            positive = await mcp.rpc('admin', probe.agent, 'tools/call', { name: probe.tool, arguments: probe.args || {} });
            assertAgentReadPositive(probe, positive, ctx.principals.admin);
        } catch (error) {
            if (fixtureRequired) {
                await ctx.check(`agent.tool.${probe.tool}.admin`, async () => { throw error; });
                continue;
            }
            ctx.recordGap(`agent.tool.${probe.tool}`, 'Administrator read control unavailable or returned an unexpected response shape; inspect the private response artifact. No denial is counted.', { kind: 'positive-unavailable', actor: 'admin', requestedMethod: 'tools/call', stage: positive?.stage, httpStatus: positive?.response?.status });
            continue;
        }
        await ctx.check(`agent.tool.${probe.tool}.admin`, async () => assertAgentReadPositive(probe, positive, ctx.principals.admin));
        if (probe.tool === 'workspace_monitor_snapshot_get' && !positive.value.available) ctx.recordGap('agent.tool.workspace_monitor_snapshot_get.data', 'Snapshot status works but no actual snapshot data is available; data-disclosure coverage remains incomplete.', { kind: 'data-unavailable', actor: 'admin' });
        for (const actor of ['anonymous', 'selfRegistered', 'userA', 'userB']) await ctx.check(`agent.tool.${probe.tool}.${actor}`, async () => {
            const result = await mcp.rpc(actor, probe.agent, 'tools/call', { name: probe.tool, arguments: probe.args || {} });
            ctx.report.agentReadResults.push({ agent: probe.agent, tool: probe.tool, actor, stage: result.stage, status: result.response.status });
            const filtered = actor === 'selfRegistered' && filteredListing;
            const ownAccountGate = actor === 'selfRegistered' && probe.policy === 'own-account';
            const denied = !filtered && (actor === 'anonymous' || probe.policy === 'admin' || (actor === 'selfRegistered' && probe.policy === 'workspace'));
            if (ownAccountGate) await assertOwnAccountRouteGate(ctx, probe, result, actor);
            else if (denied) assertAgentMcpDenied(result);
            else if (filtered) assertAgentFilteredEmpty(probe, result, ctx.principals[actor]);
            else assertAgentReadPositive(probe, result, ctx.principals[actor]);
        });
    }
}

export async function usernamePrivilegeProbe(ctx, mcp, roomFixture, { revalidationMs = 45000, pollMs = 2000 } = {}) {
    let original;
    let changed = false;
    await ctx.check('agent.username-admin.profile-positive', async () => {
        const profile = await ctx.request('userA', { path: profilePath });
        assert.equal(profile.status, 200);
        requireObject(profile.json);
        assert.equal(profile.json.ok, true);
        assertAgentReadPositive({ tool: 'userpersisto_profile_get' }, { success: true, value: profile.json.profile }, ctx.principals.userA);
        original = profile.json.profile.user.username;
        assert.equal(typeof original, 'string', 'Profile must contain persisted username before mutation');
    });
    if (typeof original !== 'string') { ctx.recordGap('agent.username-admin', 'Could not capture existing disposable username; profile was not changed.', { kind: 'positive-unavailable', actor: 'userA' }); return; }
    const restore = async () => {
        if (!changed) return;
        await ctx.guard();
        await ctx.request('userA', { path: '/auth/token?agent=userPersistoAgent' });
        const response = await ctx.request('userA', { path: profilePath, method: 'POST', body: { username: original } });
        assert.equal(response.status, 200, 'Disposable username restoration failed');
        requireObject(response.json);
        assert.equal(response.json.ok, true, 'Disposable username restoration requires a successful profile response');
        assert.equal(response.json.profile?.user?.username, original, 'Restored username must be persisted in the returned profile');
        assert.equal(response.json.profile?.user?.id, ctx.principals.userA.id);
        changed = false;
    };
    ctx.cleanup(restore);
    try {
        await ctx.guard();
        await ctx.request('userA', { path: '/auth/token?agent=userPersistoAgent' });
        // A transport failure can occur after persistence. Keep restoration
        // armed before sending the mutation, not only after receiving success.
        changed = true;
        const update = await ctx.request('userA', { path: profilePath, method: 'POST', body: { username: 'admin' } });
        if (update.status !== 200) {
            const reserved = update.json?.error === 'username_taken' || update.json?.code === 'username_taken';
            ctx.recordGap(`agent.username-admin.${reserved ? 'reserved' : 'unavailable'}`, reserved
                ? 'The disposable profile received the explicit username_taken rejection. The username shortcut was not exercised; this is not a confirmed exploit.'
                : `Username update did not yield a working control (HTTP ${update.status}); reservation and privilege escalation remain unverified.`,
                { kind: reserved ? 'username-reserved' : 'positive-unavailable', actor: 'userA', httpStatus: update.status });
            return;
        }
        requireObject(update.json);
        assert.equal(update.json.ok, true);
        assert.equal(update.json.profile?.user?.username, 'admin', 'Username mutation requires a persisted profile control');
        // The Router principal is a session snapshot that is refreshed from the
        // provider at most every ssoValidationIntervalMs (30 s by default,
        // cli/server/auth/genericAuthBridge.js, createGenericAuthBridge and
        // validateSession), and the provider's refresh returns the stored username
        // (userPersistoAgent/runtime/index.mjs, sso_refresh_session and
        // normalizeUser). The denial probes below prove nothing unless the Router
        // principal really carries the changed username, so wait, boundedly, for it.
        let persistedRole = false;
        await ctx.check('agent.username-admin.persisted-role', async () => {
            const deadline = Date.now() + revalidationMs;
            let current;
            for (;;) {
                current = await ctx.request('userA', { path: '/auth/token?agent=workspaceMonitorAgent' });
                if (current.status === 200 && current.json?.user?.username === 'admin') break;
                if (Date.now() >= deadline) break;
                await pause(pollMs);
            }
            assert.deepEqual(current.json?.user?.roles, ['user'], 'Disposable actor must remain real ordinary user');
            assert.equal(current.json?.user?.username, 'admin', 'Changed username must be in verified Router principal');
            persistedRole = true;
        });
        await ctx.check('agent.username-admin.monitor-denial', async () => {
            assert.ok(persistedRole, 'The username shortcut was not exercised: the Router principal never carried the changed username');
            assertAgentMcpDenied(await mcp.rpc('userA', 'workspaceMonitorAgent', 'tools/call', { name: 'workspace_monitor_settings_get', arguments: {} }));
        });
        await ctx.check('agent.username-admin.webmeet-role', async () => {
            assert.ok(persistedRole, 'The username shortcut was not exercised: the Router principal never carried the changed username');
            assert.ok(roomFixture?.roomId, 'Username room-role control requires the task-owned fixture');
            const result = await mcp.rpc('userA', 'webmeetAgent', 'tools/call', { name: 'webmeet_room_list', arguments: {} });
            assertAgentReadPositive({ tool: 'webmeet_room_list', requiredRoomId: roomFixture?.roomId }, result, ctx.principals.userA);
            assert.equal(result.value?.canManageRooms, false, 'Ordinary user acquired administrator room-management projection through username');
        });
    } finally { await restore(); }
}

const WEBASSIST_SOURCE = 'tests/security/authorization/agent-probes.mjs webAssistGuestProbes';
const WEBASSIST_IDS = Object.freeze({
    adminList: 'agent.webAssist.admin.list-sites-positive',
    anonymousList: 'agent.webAssist.anonymous.list-sites-denied',
    schema: 'agent.webAssist.admin.session-secret-schema',
    fixture: 'agent.webAssist.anonymous.session-fixture',
    own: 'agent.webAssist.anonymous.session-history-own-positive',
    cross: 'agent.webAssist.anonymous.session-history-cross-read',
    wrongSecret: 'agent.webAssist.anonymous.session-history-wrong-secret',
    correctSecret: 'agent.webAssist.anonymous.session-history-secret-positive',
});
export function webAssistGuestCheckDefinitions() {
    const def = (id, positiveControlAnyOf = null) => ({ id, kind: 'live', boundary: 'agents', source: WEBASSIST_SOURCE, positiveControlAnyOf });
    return [
        def(WEBASSIST_IDS.adminList),
        def(WEBASSIST_IDS.anonymousList, [WEBASSIST_IDS.adminList]),
        def(WEBASSIST_IDS.schema),
        def(WEBASSIST_IDS.fixture),
        def(WEBASSIST_IDS.own, [WEBASSIST_IDS.fixture]),
        def(WEBASSIST_IDS.cross, [WEBASSIST_IDS.own]),
        def(WEBASSIST_IDS.wrongSecret, [WEBASSIST_IDS.own]),
        def(WEBASSIST_IDS.correctSecret, [WEBASSIST_IDS.own]),
    ];
}

/**
 * The tool input schemas that carry the session secret, in exactly the encoding the
 * live tools/list shows: JSON Schema with properties.sessionSecret { type: 'string' },
 * the secret absent from `required`, `required` equal to the listed names, and
 * additionalProperties false. If sessionSecret were undeclared, the AgentServer schema
 * and the Router argument canonicalization would drop it (the secret would never arrive).
 */
export const SESSION_SECRET_REQUIRED = Object.freeze({ web_cli_chat: ['siteId', 'message'], web_cli_history: ['siteId', 'sessionId'] });
export function sessionSecretDeclared(inputSchema, requiredNames) {
    if (!inputSchema || typeof inputSchema !== 'object' || inputSchema.additionalProperties !== false) return false;
    const property = inputSchema.properties?.sessionSecret;
    if (!property || property.type !== 'string') return false;
    const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    if (required.includes('sessionSecret')) return false;
    return JSON.stringify([...required].sort()) === JSON.stringify([...requiredNames].sort());
}

/** A history read is a normal (non-error) MCP result whose first text block is the JSON result. */
export function historyResultOf(result) {
    assert.equal(result.response.status, 200, 'history read answers HTTP 200');
    assert.equal(result.response.json?.error, undefined, 'history read is not a JSON-RPC error');
    const rpcResult = result.response.json?.result;
    assert.ok(rpcResult && rpcResult.isError !== true, 'history read is not an MCP error result (errors are for a missing grant, invalid input or storage failure)');
    const block = (rpcResult.content || []).find((entry) => entry?.type === 'text');
    assert.ok(block, 'history read carries a text block');
    let value;
    try { value = JSON.parse(block.text); } catch { assert.fail('history read text is not JSON'); }
    requireObject(value);
    assert.deepEqual(Object.keys(value).sort(), ['exists', 'history', 'sessionId', 'sessionKuId', 'siteId'], 'history result has exactly the contract keys');
    assert.equal(typeof value.exists, 'boolean');
    assert.ok(Array.isArray(value.history));
    return value;
}

/**
 * webAssist anonymous policy (guest-agent-policy.mjs). list-sites is denied to an
 * anonymous visitor; the administrator read is its positive control. A chat session is
 * bound to the guest principal that created it, or to the client-held sessionSecret:
 * history is readable by the owner, by anyone presenting the secret, and by an
 * administrator, and by nobody else. web_cli_history keys history by siteId and sessionId
 * (get-session-history.mjs); a session can only be created by web_cli_chat (inference),
 * so the suite seeds one per jar through the injected `createSession` fixture
 * (webassist-fixture.mjs). Without the fixture every dependent check FAILs; nothing is
 * ever recorded as a gap or a pass.
 *
 * Contract used for the history reads (webAssist DS004/AM3): arguments
 * { siteId, sessionId, sessionSecret? }; a caller that is neither owner, secret holder
 * nor admin gets { siteId, sessionId, exists: false, sessionKuId, history: [] }.
 */
export async function webAssistGuestProbes(ctx, mcp, { createSession = ctx.webAssistSessionFactory } = {}) {
    await ctx.check(WEBASSIST_IDS.adminList, async () => {
        const result = await mcp.rpc('admin', 'webAssist', 'tools/call', { name: 'list-sites', arguments: {} });
        assert.ok(result.success, 'The administrator list-sites read must succeed');
        requireObject(result.value);
        assert.ok(Array.isArray(result.value.sites) && Number.isInteger(result.value.count), 'list-sites returns { sites, count }');
        assert.equal(Object.hasOwn(result.value, 'dataRoot'), false, 'list-sites must not disclose the absolute data root');
    });
    await ctx.check(WEBASSIST_IDS.anonymousList, async () => {
        const result = await mcp.rpc('anonymous', 'webAssist', 'tools/call', { name: 'list-sites', arguments: {} });
        assert.ok(!result.success || !Array.isArray(result.value?.sites), 'An anonymous visitor listed every site id');
        assertAgentMcpDenied(result);
    });
    await ctx.check(WEBASSIST_IDS.schema, async () => {
        const listed = await mcp.rpc('admin', 'webAssist', 'tools/list');
        assert.ok(listed.success, 'The administrator tools/list must succeed');
        for (const name of WEBASSIST_SESSION_SECRET_TOOLS) {
            const tool = (listed.value?.tools || []).find((entry) => entry.name === name);
            assert.ok(tool, `${name} is listed`);
            assert.ok(sessionSecretDeclared(tool.inputSchema, SESSION_SECRET_REQUIRED[name]), `${name} must declare an optional string sessionSecret in the live encoding (an undeclared argument is dropped before the tool runs)`);
        }
    });

    let sessions;
    let readers;
    await ctx.check(WEBASSIST_IDS.fixture, async () => {
        assert.equal(typeof createSession, 'function', 'No webAssist session fixture is configured: a session can only be created by web_cli_chat (inference) or seeded by webassist-fixture.mjs');
        if (!ctx.clients.anonymousB) ctx.clients.anonymousB = new Client([], { onSecret: (value) => ctx.secrets.add(value) });
        const guest = async (actor) => {
            const headers = { accept: 'application/json, text/event-stream' };
            const init = await ctx.request(actor, { method: 'POST', path: '/webAssist/mcp', headers, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'authorization-regression', version: '1' } } } });
            const sessionId = init.headers['mcp-session-id'];
            assert.equal(init.status, 200);
            assert.ok(typeof sessionId === 'string' && sessionId, 'Each anonymous jar needs its own MCP session');
            ctx.secrets.add(sessionId);
            const sessionHeaders = { ...headers, 'mcp-session-id': sessionId, 'mcp-protocol-version': init.json?.result?.protocolVersion || '2025-06-18' };
            ctx.cleanup(async () => { await ctx.request(actor, { method: 'DELETE', path: '/webAssist/mcp', headers: sessionHeaders }); });
            return (args) => ctx.request(actor, { method: 'POST', path: '/webAssist/mcp', headers: sessionHeaders, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'web_cli_history', arguments: args } } }).then(decodeAgentMcp);
        };
        readers = { anonymous: await guest('anonymous'), anonymousB: await guest('anonymousB') };
        const jarSession = (actor) => ctx.clients[actor].cookies.find((c) => c.name === 'ploinky_guest')?.value;
        assert.ok(jarSession('anonymous') && jarSession('anonymousB'), 'Each jar holds a guest session cookie');
        assert.notEqual(jarSession('anonymous'), jarSession('anonymousB'), 'The two anonymous jars must hold distinct guest sessions');
        const a = await createSession('anonymous');
        const b = await createSession('anonymousB');
        assert.notEqual(a.sessionId, b.sessionId);
        assert.notEqual(a.secret, b.secret);
        for (const fixture of [a, b]) for (const field of ['siteId', 'sessionId', 'marker', 'secret']) assert.ok(typeof fixture[field] === 'string' && fixture[field], `The session fixture provides ${field}`);
        sessions = { anonymous: a, anonymousB: b };
    });
    const needFixture = () => assert.ok(sessions && readers, 'The seeded session fixture is unavailable; no history conclusion is possible');
    const history = (reader, fixture, extra = {}) => readers[reader]({ siteId: fixture.siteId, sessionId: fixture.sessionId, ...extra });
    const wholeResponse = (result) => JSON.stringify([result.value, result.response.json, result.response.text]);
    const assertMissing = (result, victim) => {
        assert.ok(!wholeResponse(result).includes(victim.marker), 'One anonymous visitor read another visitor\'s chat history');
        const value = historyResultOf(result);
        assert.equal(value.exists, false, 'Another visitor\'s session must read as missing');
        assert.deepEqual(value.history, [], 'Another visitor\'s history must be empty');
        assert.equal(value.sessionId, victim.sessionId);
    };
    await ctx.check(WEBASSIST_IDS.own, async () => {
        needFixture();
        for (const [reader, fixture] of [['anonymous', sessions.anonymous], ['anonymousB', sessions.anonymousB]]) {
            const result = await history(reader, fixture);
            const value = historyResultOf(result);
            assert.equal(value.exists, true, 'Each visitor reads its own seeded session');
            assert.ok(JSON.stringify(value.history).includes(fixture.marker), 'Each visitor\'s own history carries its marker');
            assert.equal(wholeResponse(result).includes(fixture.secret), false, 'The session secret is never returned by a history read');
        }
    });
    await ctx.check(WEBASSIST_IDS.cross, async () => {
        needFixture();
        assertMissing(await history('anonymousB', sessions.anonymous), sessions.anonymous);
        assertMissing(await history('anonymous', sessions.anonymousB), sessions.anonymousB);
    });
    await ctx.check(WEBASSIST_IDS.wrongSecret, async () => {
        needFixture();
        const wrong = `${sessions.anonymous.secret.slice(0, -1)}${sessions.anonymous.secret.endsWith('A') ? 'B' : 'A'}`;
        assert.notEqual(wrong, sessions.anonymous.secret);
        assertMissing(await history('anonymousB', sessions.anonymous, { sessionSecret: wrong }), sessions.anonymous);
        // The other visitor's secret does not open this session either.
        assertMissing(await history('anonymousB', sessions.anonymous, { sessionSecret: sessions.anonymousB.secret }), sessions.anonymous);
    });
    await ctx.check(WEBASSIST_IDS.correctSecret, async () => {
        needFixture();
        // The secret travels Router -> AgentServer schema -> webAssist: only then can a different principal read.
        const result = await history('anonymousB', sessions.anonymous, { sessionSecret: sessions.anonymous.secret });
        const value = historyResultOf(result);
        assert.equal(value.exists, true, 'A different principal presenting the correct secret reads the session');
        assert.ok(JSON.stringify(value.history).includes(sessions.anonymous.marker), 'The correct secret returns the marker turn');
        assert.equal(wholeResponse(result).includes(sessions.anonymous.secret), false, 'The secret is not echoed');
    });
}

export function reconcileAgentRegistry(registry) {
    assert.ok(registry?.routes && typeof registry.routes === 'object', 'Live route registry is missing');
    const known = new Map(agentCatalog.filter((a) => a.enabled).map((a) => [a.agent, a]));
    const records = Object.entries(registry.routes).map(([key, value]) => ({ key, agent: value.agent }));
    for (const record of records) assert.ok(known.has(record.agent), 'Live route references an agent absent from enabled inventory');
    for (const agent of known.keys()) assert.ok(records.some((r) => r.agent === agent), 'Enabled agent missing from live route registry');
    return { keys: records.map((r) => r.key).sort(), alternateKeys: records.filter((r) => r.key !== r.agent), unexercisedNormalizationFamilies: ['trailing slash', 'duplicate slash', 'percent encoding', 'dot segment', 'additional-server selector'] };
}

export async function runAgentProbes(ctx) {
    const mcp = createAgentSessions(ctx);
    await ctx.check('agent.registry.reconciliation', async () => {
        const registry = JSON.parse(await fs.readFile(path.join(WORKSPACE, '.ploinky', 'routing.json'), 'utf8'));
        ctx.report.agentRegistry = reconcileAgentRegistry(registry);
    });
    ctx.report.agentInventory = { totalRows: agentInventory.length, agents: agentCatalog.length, enabled: agentCatalog.filter((a) => a.enabled).length, declaredTools: agentInventory.filter((r) => r.tool).length, completeEndpointCoverage: false };
    for (const probe of agentProbes) {
        let positive;
        try { positive = await ctx.request('admin', probe); assertAgentHttpPositive(probe, positive, ctx.principals.admin); }
        catch { ctx.recordGap(probe.id, 'Administrator HTTP control unavailable or returned an unexpected response shape; negative responses are not counted.', { kind: 'positive-unavailable', actor: 'admin', httpStatus: positive?.status }); continue; }
        await ctx.check(`${probe.id}.admin`, async () => assertAgentHttpPositive(probe, positive, ctx.principals.admin));
        for (const actor of ['anonymous', 'selfRegistered', 'userA', 'userB']) await ctx.check(`${probe.id}.${actor}`, async () => {
            const response = await ctx.request(actor, probe);
            if (probe.policy === 'admin' || actor === 'anonymous' || actor === 'selfRegistered') assertDenied(response);
            else assertAgentHttpPositive(probe, response, ctx.principals[actor]);
        });
    }
    await discoverAgentMcp(ctx, mcp);
    if ((ctx.guestAgents || []).some((g) => g.agent === 'webAssist')) await webAssistGuestProbes(ctx, mcp);
    const roomFixture = await createRoomListingFixture(ctx, mcp);
    await readTools(ctx, mcp, roomFixture);
    await usernamePrivilegeProbe(ctx, mcp, roomFixture);
    for (const gap of [
        ['agent.websocket', 'LiveKit public WebSocket requires scoped room token; robot/browser requires unavailable optional backend. No missing-token or failed-upgrade response proves resource authorization.'],
        ['agent.image-routes', 'OnlyOffice DocumentServer, LiveKit, Umami and disabled GPTResearcher expose image-owned dynamic route families. Wildcards remain explicit unresolved endpoint-inventory gaps.'],
        ['agent.inference', 'No inference, external provider/Git/OAuth, download acquisition, or costly compute invocation permitted by local-only target.'],
        ['agent.aliases', 'Canonical MCP and selected additional-server paths exercised. Live route keys reconciled separately; encoded/duplicate-slash/trailing-slash variants and complete additional-server path cross-products remain unexercised.'],
    ]) ctx.recordGap(...gap, { kind: 'declared-limitation' });
}
