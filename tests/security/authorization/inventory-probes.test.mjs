import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCatalog, agentInventory } from './agent-inventory.mjs';
import { readFileSync } from 'node:fs';
import { expectedTool } from './inventory-generate.mjs';
import { assertDenied } from './core.mjs';
const expectedRuntimes = JSON.parse(readFileSync(new URL('./acceptance/expected-runtimes.json', import.meta.url), 'utf8'));
import { assertAgentMcpDenied, decodeAgentMcp, agentReadTools, agentProbes, reconcileAgentRegistry, createAgentSessions,
    assertAgentHttpPositive, assertAgentHttpDenied, assertAgentReadPositive, discoverAgentMcp, agentDiscoveryMethods, readTools, createRoomListingFixture, usernamePrivilegeProbe } from './agent-probes.mjs';

const response = (status, json) => ({ status, json, headers: {}, text: JSON.stringify(json) });
test('MCP decoder rejects redirects, missing endpoints, malformed success and structured tool failures', () => {
    for (const value of [response(302, undefined), response(404, { error: 'not found' }), response(200, {}), response(200, { result: { isError: true, content: [{ type: 'text', text: 'Access denied' }] } }), response(200, { result: { content: [{ type: 'text', text: '{"ok":false,"error":"forbidden"}' }] } })]) assert.ok(!decodeAgentMcp(value).success);
    assert.ok(decodeAgentMcp(response(200, { result: { tools: [] } })).success);
    const withStderr = decodeAgentMcp(response(200, { result: { content: [
        { type: 'text', text: '{"ok":false,"error":{"message":"administrator required"}}' },
        { type: 'text', text: 'stderr:\nnon-fatal warning' },
    ] } }));
    assert.equal(withStderr.success, false);
    assert.doesNotThrow(() => assertAgentMcpDenied(withStderr));
    assert.equal(decodeAgentMcp(response(200, { result: { structuredContent: { ok: false, error: 'forbidden' } } })).success, false);
    const contradictory = decodeAgentMcp(response(200, { result: {
        structuredContent: { ok: false, error: 'forbidden' },
        content: [{ type: 'text', text: '{"ok":true,"allowed":true}' }],
    } }));
    assert.equal(contradictory.success, false);
    assert.doesNotThrow(() => assertAgentMcpDenied(contradictory));
    assert.equal(decodeAgentMcp(response(200, { result: null })).success, false);
});

test('anonymous MCP probes contact the actual agent without auth-token preparation or borrowed sessions', async () => {
    const calls = [];
    const ctx = { secrets: new Set(), cleanup() {}, recordGap() {}, async request(actor, request) {
        calls.push({ actor, ...request });
        assert.equal(actor, 'anonymous');
        assert.equal(request.path, '/explorer/mcp');
        assert.equal(request.body.method, 'initialize');
        assert.equal(request.headers['mcp-session-id'], undefined);
        assert.equal(request.headers['x-ploinky-browser-csrf-token'], undefined);
        return response(403, { error: 'authentication required' });
    } };
    const result = await createAgentSessions(ctx).rpc('anonymous', 'explorer', 'tools/call', { name: 'read_tool', arguments: {} });
    assertAgentMcpDenied(result);
    assert.equal(result.stage, 'initialize');
    assert.equal(calls.length, 1);
});

test('an unexpectedly initialized anonymous session proceeds only with its own returned session identity', async () => {
    let initialized = false;
    const ctx = { secrets: new Set(), cleanup() {}, recordGap() {}, async request(actor, request) {
        assert.equal(actor, 'anonymous');
        assert.equal(request.path, '/gitAgent/mcp');
        if (!initialized) {
            initialized = true;
            return { ...response(200, { result: { protocolVersion: '2025-06-18' } }), headers: { 'mcp-session-id': 'anonymous-owned-session' } };
        }
        assert.equal(request.headers['mcp-session-id'], 'anonymous-owned-session');
        assert.equal(request.body.method, 'tools/list');
        return response(200, { result: { tools: [] } });
    } };
    const result = await createAgentSessions(ctx).rpc('anonymous', 'gitAgent', 'tools/list');
    assert.equal(result.stage, 'tools/list');
    assert.equal(result.success, true);
    assert.throws(() => assertAgentMcpDenied(result));
});

test('authenticated proof preparation failure cannot masquerade as an agent endpoint denial', async () => {
    const calls = [];
    const ctx = { secrets: new Set(), cleanup() {}, recordGap() {}, async request(actor, request) {
        calls.push(request.path);
        return response(403, { error: 'forbidden' });
    } };
    await assert.rejects(createAgentSessions(ctx).rpc('userA', 'gitAgent', 'tools/list'), /Cannot prepare actual agent request/);
    assert.deepEqual(calls, ['/auth/token?agent=gitAgent']);
});

test('all owned agent sessions get cleanup even when one fails and generic 404 cannot claim session closure', async () => {
    let cleanup;
    const closed = [];
    const ctx = { secrets: new Set(), cleanup(fn) { cleanup = fn; }, async request(actor, request) {
        if (request.method === 'DELETE') { closed.push(actor); return actor === 'userA' ? response(404, { error: 'not found' }) : response(204, undefined); }
        if (request.path.startsWith('/auth/token')) return response(200, { browserMutation: { routeKey: 'gitAgent', csrfToken: `proof-${actor}` } });
        return { ...response(200, { result: { protocolVersion: '2025-06-18' } }), headers: { 'mcp-session-id': `session-${actor}` } };
    } };
    const mcp = createAgentSessions(ctx);
    await mcp.initialize('userA', 'gitAgent');
    await mcp.initialize('userB', 'gitAgent');
    assert.ok(ctx.secrets.has('proof-userA') && ctx.secrets.has('session-userB'));
    await assert.rejects(cleanup(), AggregateError);
    assert.deepEqual(closed, ['userA', 'userB']);
});

test('HTTP positive controls require handler payloads and reject JSON error pages or wrong role projection', () => {
    const principal = { id: 'fixture-admin', roles: ['admin'] };
    const payloads = {
        'agent.soul.management.me': { authenticated: true, user: { id: principal.id, username: 'fixture', keyOwner: 'fixture', roles: ['admin'] } },
        'agent.soul.management.models': { data: [{ id: 'model-id' }] },
        'agent.soul.management.providers': { data: [] },
        'agent.robot.list': { ok: true, canAdmin: true, robots: [] },
    };
    for (const probe of agentProbes) {
        assert.doesNotThrow(() => assertAgentHttpPositive(probe, response(200, payloads[probe.id]), principal));
        for (const payload of [{}, { ok: true }, { ...payloads[probe.id], ok: false }, { ...payloads[probe.id], error: 'unavailable' }]) {
            assert.throws(() => assertAgentHttpPositive(probe, response(200, payload), principal));
        }
    }
    assert.throws(() => assertAgentHttpPositive(agentProbes[3], response(200, payloads['agent.robot.list']), { id: 'ordinary', roles: ['user'] }));
});

test('the RoboTeam listing capability refusal is accepted exactly, and nothing else widens the shared denial rule', () => {
    const robot = agentProbes.find(probe => probe.id === 'agent.robot.list');
    const refusal = { ok: false, error: 'Explorer access is required to list robots' };
    assert.doesNotThrow(() => assertAgentHttpDenied(robot, response(403, refusal)), 'the product\'s explicit refusal');
    assert.doesNotThrow(() => assertAgentHttpDenied(robot, response(401, { ok: false, error: 'authenticated Ploinky user is required' })), 'the shared rule still serves other denials');
    // Only that probe, only that status, only that exact error, only as a failure.
    assert.throws(() => assertAgentHttpDenied(agentProbes.find(probe => probe.id === 'agent.soul.management.me'), response(403, refusal)), 'another probe');
    for (const bad of [
        response(401, refusal), response(500, refusal), response(200, refusal), response(403, { ...refusal, ok: true }),
        response(403, { ok: false, error: 'Explorer access is required' }), response(403, { ok: false, error: 'explorer access is required to list robots' }),
        response(403, { ok: false, error: 'Explorer access is required to list robots.' }), response(403, { ok: false, message: refusal.error }),
        response(403, { ok: false, error: 'access is required' }), response(403, { ok: false, error: 'storage_full' }), response(403, { ok: false, error: 'access log unavailable' }),
    ]) assert.throws(() => assertAgentHttpDenied(robot, bad), JSON.stringify(bad.json));
    // The shared rule itself is unchanged: a bare capability-like sentence is not an authorization denial.
    assert.throws(() => assertDenied(response(403, refusal)));
});

test('every read tool has a meaningful success schema and account/role identity is checked', () => {
    const principal = { id: 'fixture-admin', roles: ['admin'] };
    const settings = (names) => Object.fromEntries(names.map((key) => [key, '']));
    const payloads = {
        userpersisto_profile_get: { user: { id: principal.id, username: 'fixture' }, roles: ['admin'], capabilities: [], authMethods: [], emailVerified: true },
        userpersisto_user_list: { users: [{ id: principal.id }], totalCount: 4 },
        userpersisto_config_get: settings(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_PRICE_CREDITS', 'STRIPE_PRICE_SUBSCRIPTION', 'USERPERSISTO_CREDITS_PER_UNIT', 'USERPERSISTO_BILLING_SUCCESS_URL', 'USERPERSISTO_BILLING_CANCEL_URL']),
        userpersisto_auth_policy_get: { enabledAuthMethods: ['emailCode'], allowedRedirectOrigins: [], environmentOverrides: [], selfRegistrationEnabled: true, registrationRole: 'selfRegistered' },
        userpersisto_google_status: { enabled: false, configured: true, available: false, mode: 'gis', missing: [], redirectUri: 'http://127.0.0.1:8080/base-agent-additional-server/userPersistoAgent/7000/service/auth/google/callback', clientId: 'client', secretRequired: false, configurationSource: 'local-default', policySource: 'stored-or-default', reason: 'disabled' },
        userpersisto_oidc_status: { enabled: false, issuer: '', discoveryUrl: '' },
        email_config_get: settings(['MAILJET_API_KEY', 'MAILJET_API_SECRET', 'MAILJET_FROM_EMAIL', 'MAILJET_FROM_NAME', 'EMAIL_AUTH_CODE_TEMPLATE_ID']),
        email_provider_status: { configured: false, fromEmail: '' },
        workspace_monitor_settings_get: { ok: true, settings: { workspaceCpuPercent: 80, workspaceMemoryBytes: 100, routerCpuPercent: 80, routerMemoryBytes: 50, logRetentionDays: 7 } },
        workspace_monitor_snapshot_get: { ok: true, available: false, stale: true, ageMs: null, snapshot: null },
        dpu_whoami: { ok: true, authenticated: true, actor: { id: principal.id, principalId: `user:${principal.id}`, roles: ['admin'] }, userSpace: { privateId: 'private', mySpaceRootId: 'root' } },
        dpu_workspace_roots: { ok: true, roots: { confidential: { path: '/Confidential' }, mySpace: { id: 'root', path: '/Confidential/My Space' }, ...Object.fromEntries(['sharedFiles', 'secrets', 'researchData', 'jobs'].map((name) => [name, { scope: name, path: '/Confidential/example', type: 'virtual-list' }])) } },
        webmeet_room_list: { rooms: [], canManageRooms: true },
        webmeet_room_events_list: { events: [fixtureEvent()] },
        git_auth_status: { ok: true, configured: false, connected: false, tokenStored: false, setup: { configured: false, scope: 'repo' }, connection: null, pending: null },
    };
    for (const probe of agentReadTools) {
        const success = (value) => decodeAgentMcp(response(200, { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }));
        const checkedProbe = probe.tool === 'webmeet_room_events_list' ? { ...probe, requiredRoomId: FIXTURE_ROOM } : probe;
        assert.doesNotThrow(() => assertAgentReadPositive(checkedProbe, success(payloads[probe.tool]), principal));
        for (const payload of [{}, { ok: true }, { ...payloads[probe.tool], ok: false }, { ...payloads[probe.tool], error: 'unavailable' }]) {
            assert.throws(() => assertAgentReadPositive(checkedProbe, success(payload), principal));
        }
    }
    assert.throws(() => assertAgentReadPositive({ tool: 'userpersisto_profile_get' }, { success: true, value: payloads.userpersisto_profile_get }, { id: 'different', roles: ['user'] }));
    assert.throws(() => assertAgentReadPositive({ tool: 'webmeet_room_list' }, { success: true, value: payloads.webmeet_room_list }, { id: 'ordinary', roles: ['user'] }));
});

test('resources, templates and prompts are discovered separately and unsupported methods stay explicit gaps', async () => {
    const calls = [], gaps = [], failures = [];
    const ctx = { report: {}, recordGap: (id, reason) => gaps.push({ id, reason }), async check(id, fn) { try { await fn(); } catch (error) { failures.push({ id, error }); } } };
    const mcp = {
        async rpc(actor, agent, method) {
            calls.push({ actor, agent, method });
            if (method !== 'tools/list') return decodeAgentMcp(response(200, { error: { code: -32601, message: 'Method not found' } }));
            return decodeAgentMcp(actor === 'anonymous' ? response(401, { error: 'authentication required' }) : response(200, { result: { tools: [] } }));
        },
        async initialize() { return { failure: response(404, { error: 'no backend' }) }; },
    };
    await discoverAgentMcp(ctx, mcp, [{ agent: 'fixture', enabled: true, tools: [] }]);
    assert.deepEqual(calls.filter((c) => c.actor === 'admin').map((c) => c.method), agentDiscoveryMethods.map((d) => d.method));
    for (const method of ['resources.list', 'resources.templates.list', 'prompts.list']) assert.ok(gaps.some((g) => g.id.endsWith(method) && /does not support/.test(g.reason)));
    assert.equal(failures.length, 0);
    const privateMarker = 'never-repeat-private-payload';
    await discoverAgentMcp(ctx, { async rpc() { throw new Error(privateMarker); }, async initialize() { throw new Error(privateMarker); } }, [{ agent: 'broken', enabled: true, tools: [] }]);
    assert.ok(gaps.every((g) => !g.reason.includes(privateMarker)));
});
test('MCP denial requires real authorization instead of validation, transport or endpoint absence', () => {
    assert.doesNotThrow(() => assertAgentMcpDenied(decodeAgentMcp(response(403, { error: 'forbidden' }))));
    assert.doesNotThrow(() => assertAgentMcpDenied(decodeAgentMcp(response(200, { result: { isError: true, content: [{ type: 'text', text: 'Access denied: administrator is required.' }] } }))));
    for (const value of [response(200, { result: { ok: true } }), response(404, { error: 'forbidden' }), response(302, { error: 'forbidden' }), response(403, { ok: true }), response(500, { error: 'forbidden' }), response(200, { result: { isError: true, content: [{ type: 'text', text: 'Missing argument or task not found' }] } })]) assert.throws(() => assertAgentMcpDenied(decodeAgentMcp(value)));
});
test('inventory preserves every recorded runtime and disabled agents without claiming coverage', () => {
    // Exact reviewed identity sets derived from the pinned manifest graph
    // (acceptance/expected-runtime-graph.mjs), not minimum counts.
    const key = (a) => `${a.repo}/${a.agent}`;
    const catalogKeys = agentCatalog.map(key);
    assert.equal(new Set(catalogKeys).size, catalogKeys.length, 'Catalog identities must be unique');
    assert.deepEqual(agentCatalog.filter((a) => a.enabled).map(key).sort(), expectedRuntimes.enabled.map(key).sort());
    assert.deepEqual(agentCatalog.filter((a) => !a.enabled).map(key).sort(), expectedRuntimes.disabled.map(key).sort());
    assert.equal(agentCatalog.length, expectedRuntimes.counts.total);
    for (const a of agentCatalog.filter((entry) => !entry.enabled)) assert.ok(!expectedRuntimes.enabled.some((e) => key(e) === key(a)), 'Disabled inventory entry cannot be an expected runtime');
    // The retired agent stays excluded; the distinct local-llms/local-llm is inventoried.
    assert.ok(agentCatalog.some((a) => a.repo === 'local-llms' && a.agent === 'local-llm' && a.enabled));
    assert.equal(agentCatalog.some((a) => a.agent === 'default-local-llm'), false);
    assert.equal(agentInventory.some((r) => r.agent === 'default-local-llm'), false);
    for (const a of agentCatalog) {
        const rows = agentInventory.filter((r) => r.repo === a.repo && r.agent === a.agent);
        assert.ok(rows.length);
        for (const name of a.tools) assert.ok(rows.some((r) => r.tool === name));
        if (!a.enabled) assert.ok(rows.every((r) => r.gap?.match(/disabled|on-demand/i)));
    }
    assert.ok(agentInventory.every((r) => r.coverage === 'inventoried-not-exercised'));
});
test('safe read probes reference declared tools and do not mutate or infer visibility as execution', () => {
    for (const p of agentReadTools) {
        assert.ok(agentCatalog.find((a) => a.agent === p.agent)?.tools.includes(p.tool));
        assert.ok(!/(_set|_update|_create|_delete|_send|_grant|_revoke)$/.test(p.tool));
    }
});

test('registry reconciliation rejects absent or incorrect runtime principals instead of silently omitting aliases', () => {
    const routes = Object.fromEntries(agentCatalog.filter((a) => a.enabled).map((a) => [a.agent, { agent: a.agent }]));
    assert.equal(reconcileAgentRegistry({ routes }).keys.length, expectedRuntimes.counts.enabled);
    assert.throws(() => reconcileAgentRegistry({ routes: {} }));
    assert.throws(() => reconcileAgentRegistry({ routes: { ...routes, alien: { agent: 'unrelated-workspace-agent' } } }));
    assert.deepEqual(reconcileAgentRegistry({ routes: { ...routes, alias: { agent: 'explorer' } } }).alternateKeys, [{ key: 'alias', agent: 'explorer' }]);
});

const FIXTURE_ROOM = 'room_11111111-1111-4111-8111-111111111111';
function fixtureEvent(roomId = FIXTURE_ROOM) {
    return `rooms:meeting.created:${Buffer.from(JSON.stringify({ id: 'event_fixture', createdAt: '2026-10-09T00:00:00.000Z', workspaceId: 'rooms', meetingId: roomId, roomId, meeting: { id: roomId, name: 'authz-test-listing-room' } })).toString('base64url')}`;
}
const mcpSuccess = (value) => decodeAgentMcp(response(200, { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }));

function fixtureCtx() {
    const gaps = [], failures = [], passed = [], cleanups = [];
    const principals = { admin: { id: 'a', roles: ['admin'] }, selfRegistered: { id: 's', roles: ['selfRegistered'] }, userA: { id: 'ua', roles: ['user'] }, userB: { id: 'ub', roles: ['user'] } };
    return { gaps, failures, passed, cleanups, ctx: { report: {}, principals, prefix: 'authz-test', async guard() {},
        recordGap: (id, reason) => gaps.push({ id, reason }), cleanup: (fn) => cleanups.push(fn),
        async check(id, fn) { try { await fn(); passed.push(id); } catch (error) { failures.push(id); } } } };
}

async function runRoomListReadTools({ fixture = { roomId: FIXTURE_ROOM }, admin, selfRegistered, ordinary }) {
    const state = fixtureCtx();
    const mcp = { async rpc(actor, agent, method, params) {
        if (params.name === 'webmeet_room_events_list') return actor === 'anonymous' || actor === 'selfRegistered'
            ? { ...decodeAgentMcp(response(403, { error: 'forbidden' })), stage: method }
            : { ...mcpSuccess({ events: [fixtureEvent()] }), stage: method };
        if (params.name !== 'webmeet_room_list') throw new Error('control unavailable in this fixture');
        if (actor === 'anonymous') return { ...decodeAgentMcp(response(401, { error: 'authentication required' })), stage: method };
        if (actor === 'admin') return { ...admin, stage: method };
        if (actor === 'selfRegistered') return { ...selfRegistered, stage: method };
        return { ...ordinary, stage: method };
    } };
    await readTools(state.ctx, mcp, fixture);
    return state;
}

test('room list requires the task-owned room for entitled users and an exactly empty list for selfRegistered', async () => {
    const id = 'agent.tool.webmeet_room_list.selfRegistered';
    const listed = mcpSuccess({ rooms: [{ id: FIXTURE_ROOM }], canManageRooms: false });
    const admin = mcpSuccess({ rooms: [{ id: 'room_archived' }, { id: FIXTURE_ROOM }], canManageRooms: true });
    const good = await runRoomListReadTools({ admin, ordinary: listed, selfRegistered: mcpSuccess({ rooms: [], canManageRooms: false }) });
    assert.deepEqual(good.failures, []);
    assert.deepEqual(good.gaps.filter((gap) => gap.id.startsWith('agent.tool.webmeet_room_list')), []);
    for (const actor of ['admin', 'anonymous', 'selfRegistered', 'userA', 'userB']) assert.ok(good.passed.includes(`agent.tool.webmeet_room_list.${actor}`), actor);
    for (const selfRegistered of [
        listed, // base behaviour: any authenticated non-guest saw open rooms
        mcpSuccess({ rooms: [], canManageRooms: true }),
        decodeAgentMcp(response(403, { error: 'forbidden' })),
        mcpSuccess({ rooms: [], canManageRooms: false, error: 'unavailable' }),
    ]) {
        assert.deepEqual((await runRoomListReadTools({ admin, ordinary: listed, selfRegistered })).failures, [id]);
    }
    // An entitled listing that is empty or omits the fixture is not a positive control.
    for (const ordinary of [mcpSuccess({ rooms: [], canManageRooms: false }), mcpSuccess({ rooms: [{ id: 'room_other' }], canManageRooms: false })]) {
        const result = await runRoomListReadTools({ admin, ordinary, selfRegistered: mcpSuccess({ rooms: [], canManageRooms: false }) });
        assert.deepEqual(result.failures.sort(), ['agent.tool.webmeet_room_list.userA', 'agent.tool.webmeet_room_list.userB']);
    }
    const adminWithoutFixture = await runRoomListReadTools({ admin: mcpSuccess({ rooms: [{ id: 'room_archived' }], canManageRooms: true }), ordinary: listed, selfRegistered: mcpSuccess({ rooms: [], canManageRooms: false }) });
    assert.equal(adminWithoutFixture.passed.includes(id), false, 'no filtered claim without the fixture in the administrator control');
    assert.ok(adminWithoutFixture.failures.includes('agent.tool.webmeet_room_list.admin'), 'an admin listing without the owned room fails');
    assert.equal(adminWithoutFixture.gaps.some((gap) => gap.id.startsWith('agent.tool.webmeet_room_list')), false);
});

test('a missing room fixture fails the listing probe instead of recording a gap', async () => {
    const result = await runRoomListReadTools({ fixture: null, admin: mcpSuccess({ rooms: [{ id: 'room_archived' }], canManageRooms: true }),
        ordinary: mcpSuccess({ rooms: [], canManageRooms: false }), selfRegistered: mcpSuccess({ rooms: [], canManageRooms: false }) });
    assert.ok(result.failures.includes('agent.tool.webmeet_room_list.fixture-required'));
    assert.equal(result.passed.some((id) => id.startsWith('agent.tool.webmeet_room_list.')), false);
    assert.equal(result.gaps.some((gap) => gap.id.startsWith('agent.tool.webmeet_room_list')), false);
});

test('the room fixture is created by the administrator and cleaned up only by exact run-owned identity', async () => {
    const calls = [];
    let current;
    const mcp = { async rpc(actor, agent, method, params) {
        calls.push({ actor, agent, name: params.name, arguments: params.arguments });
        if (params.name === 'webmeet_room_list') return mcpSuccess({ rooms: current ? [current.meeting] : [], canManageRooms: true });
        if (params.name === 'webmeet_room_create') {
            assert.equal(state.cleanups.length, 1, 'cleanup must already be armed');
            current = { meeting: { id: FIXTURE_ROOM, name: params.arguments.name } };
            return mcpSuccess({ roomId: FIXTURE_ROOM, name: params.arguments.name });
        }
        if (params.name === 'webmeet_room_get') return current ? mcpSuccess(current)
            : { ...decodeAgentMcp(response(200, { result: { isError: true, content: [{ type: 'text', text: 'Meeting not found.' }] } })), stage: 'tools/call' };
        if (params.name === 'webmeet_room_delete') {
            current = undefined;
            return mcpSuccess({ ok: true, deleted: true, roomId: FIXTURE_ROOM });
        }
        throw new Error('unexpected');
    } };
    const state = fixtureCtx();
    assert.deepEqual(await createRoomListingFixture(state.ctx, mcp), { roomId: FIXTURE_ROOM, name: 'authz-test-listing-room' });
    assert.deepEqual(calls.find(call => call.name === 'webmeet_room_create'), { actor: 'admin', agent: 'webmeetAgent', name: 'webmeet_room_create', arguments: { name: 'authz-test-listing-room', roomType: 'team' } });
    assert.equal(state.cleanups.length, 1);
    current = { meeting: { id: FIXTURE_ROOM, name: 'someone-else' } };
    await assert.rejects(state.cleanups[0](), /ownership unresolved/);
    assert.equal(calls.some((call) => call.name === 'webmeet_room_delete'), false, 'never deletes a room it cannot prove it owns');
    current = { meeting: { id: FIXTURE_ROOM, name: 'authz-test-listing-room' } };
    await state.cleanups[0]();
    assert.deepEqual(calls.find(call => call.name === 'webmeet_room_delete'), { actor: 'admin', agent: 'webmeetAgent', name: 'webmeet_room_delete', arguments: { roomId: FIXTURE_ROOM, confirmed: true } });
    assert.deepEqual(calls.at(-1), { actor: 'admin', agent: 'webmeetAgent', name: 'webmeet_room_get', arguments: { roomId: FIXTURE_ROOM } });
    assert.equal(current, undefined, 'the fake models actual removal before proving absence');

    const failing = fixtureCtx();
    const denied = { async rpc() { return decodeAgentMcp(response(403, { error: 'forbidden' })); } };
    assert.equal(await createRoomListingFixture(failing.ctx, denied), undefined);
    assert.deepEqual(failing.failures, ['agent.tool.webmeet_room_list.fixture']);
    assert.equal(failing.cleanups.length, 0);
    assert.deepEqual(failing.gaps, []);
});

test('the workspace room feed keeps selfRegistered denied and is a declared non-mutating read', () => {
    const probe = agentReadTools.find((entry) => entry.tool === 'webmeet_room_events_list');
    assert.deepEqual(probe, { agent: 'webmeetAgent', tool: 'webmeet_room_events_list', args: { roomId: 'rooms' }, policy: 'workspace' });
    assert.equal(expectedTool('webmeetAgent', 'webmeet_room_events_list').selfRegistered, 'deny');
    assert.equal(expectedTool('webmeetAgent', 'webmeet_room_list').selfRegistered, 'allow-filtered-empty');
    assert.equal(expectedTool('webmeetAgent', 'webmeet_room_create').selfRegistered, 'deny');
});

test('username privilege probe retains its owned room positive and restores the disposable profile', async () => {
    for (const roomFixture of [{ roomId: FIXTURE_ROOM }, null]) {
        const state = fixtureCtx();
        let username = 'fixture';
        state.ctx.request = async (actor, request) => {
            if (request.path.startsWith('/auth/token')) return response(200, { user: { roles: ['user'], username } });
            if (request.body) username = request.body.username;
            return response(200, { ok: true, profile: { user: { id: 'ua', username }, roles: ['user'], capabilities: ['explorer.access'], authMethods: [], emailVerified: true } });
        };
        const mcp = { async rpc(actor, agent, method, params) {
            if (params.name === 'workspace_monitor_settings_get') return decodeAgentMcp(response(403, { error: 'admin required' }));
            if (params.name === 'webmeet_room_list') return mcpSuccess({ rooms: [{ id: FIXTURE_ROOM }], canManageRooms: false });
            throw new Error('unexpected call');
        } };
        await usernamePrivilegeProbe(state.ctx, mcp, roomFixture);
        assert.equal(username, 'fixture', 'disposable username restored');
        assert.deepEqual(state.gaps, []);
        assert.deepEqual(state.failures, roomFixture ? [] : ['agent.username-admin.webmeet-role']);
        assert.equal(state.passed.includes('agent.username-admin.webmeet-role'), Boolean(roomFixture));
    }
});

test('workspace feed positives reject empty, malformed, unrelated and mismatched fixture events', () => {
    const probe = { tool: 'webmeet_room_events_list', requiredRoomId: FIXTURE_ROOM, requiredRoomName: 'authz-test-listing-room' };
    assert.doesNotThrow(() => assertAgentReadPositive(probe, mcpSuccess({ events: [fixtureEvent()] })));
    const encode = payload => `rooms:meeting.created:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const owned = JSON.parse(Buffer.from(fixtureEvent().split(':')[2], 'base64url').toString('utf8'));
    for (const events of [[], ['encoded-room-event'], ['rooms:meeting.created:e30'], [fixtureEvent('room_other')],
        [encode({ ...owned, meeting: { id: FIXTURE_ROOM, name: 'foreign-run' } })],
        [encode({ ...owned, meetingId: 'room_other' })], [encode({ ...owned, roomId: 'room_other' })],
        [encode({ ...owned, workspaceId: 'foreign' })], [encode({ ...owned, id: '' })],
        [encode({ ...owned, createdAt: 'invalid' })], [fixtureEvent().replace('meeting.created', 'meeting.archived')]]) {
        assert.throws(() => assertAgentReadPositive(probe, mcpSuccess({ events })));
    }
    assert.throws(() => assertAgentReadPositive(probe, mcpSuccess({ events: [fixtureEvent()], error: 'unavailable' })));
    assert.throws(() => assertAgentReadPositive({ tool: probe.tool }, mcpSuccess({ events: [fixtureEvent()] })));
});

test('workspace feed checks all five actors and fails an unavailable or empty admin control without a gap', async () => {
    const run = async (values, fixture = { roomId: FIXTURE_ROOM, name: 'authz-test-listing-room' }) => {
        const state = fixtureCtx();
        await readTools(state.ctx, { async rpc(actor, agent, method, params) {
            if (params.name !== 'webmeet_room_events_list') throw new Error('unrelated control unavailable');
            const value = values[actor];
            if (value instanceof Error) throw value;
            return { ...value, stage: method };
        } }, fixture);
        return { ...state, feedFailures: state.failures.filter(id => id.startsWith('agent.tool.webmeet_room_events_list.')) };
    };
    const positive = mcpSuccess({ events: [fixtureEvent()] });
    const denied = decodeAgentMcp(response(403, { error: 'forbidden' }));
    const values = { admin: positive, userA: positive, userB: positive, anonymous: denied, selfRegistered: denied };
    const good = await run(values);
    assert.deepEqual(good.feedFailures, []);
    for (const actor of Object.keys(values)) assert.ok(good.passed.includes(`agent.tool.webmeet_room_events_list.${actor}`), actor);
    for (const actor of ['admin', 'userA', 'userB']) {
        const empty = await run({ ...values, [actor]: mcpSuccess({ events: [] }) });
        assert.deepEqual(empty.feedFailures, [`agent.tool.webmeet_room_events_list.${actor}`]);
        assert.equal(empty.gaps.some(gap => gap.id.startsWith('agent.tool.webmeet_room_events_list')), false);
    }
    const failed = await run({ ...values, admin: new Error('transport failure') });
    assert.deepEqual(failed.feedFailures, ['agent.tool.webmeet_room_events_list.admin']);
    const missing = await run(values, null);
    assert.deepEqual(missing.feedFailures, ['agent.tool.webmeet_room_events_list.fixture-required']);
    for (const result of [failed, missing]) {
        assert.equal(result.passed.some(id => id.startsWith('agent.tool.webmeet_room_events_list.')), false);
        assert.equal(result.gaps.some(gap => gap.id.startsWith('agent.tool.webmeet_room_events_list')), false);
    }
});
