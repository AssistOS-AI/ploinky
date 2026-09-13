import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCatalog, agentInventory } from './agent-inventory.mjs';
import { assertAgentMcpDenied, decodeAgentMcp, agentReadTools, agentProbes, reconcileAgentRegistry, createAgentSessions,
    assertAgentHttpPositive, assertAgentReadPositive, discoverAgentMcp, agentDiscoveryMethods } from './agent-probes.mjs';

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

test('every read tool has a meaningful success schema and account/role identity is checked', () => {
    const principal = { id: 'fixture-admin', roles: ['admin'] };
    const settings = (names) => Object.fromEntries(names.map((key) => [key, '']));
    const payloads = {
        userpersisto_profile_get: { user: { id: principal.id, username: 'fixture' }, roles: ['admin'], capabilities: [], authMethods: [], emailVerified: true },
        userpersisto_user_list: { users: [{ id: principal.id }], totalCount: 4 },
        userpersisto_config_get: settings(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_PRICE_CREDITS', 'STRIPE_PRICE_SUBSCRIPTION', 'USERPERSISTO_CREDITS_PER_UNIT', 'USERPERSISTO_BILLING_SUCCESS_URL', 'USERPERSISTO_BILLING_CANCEL_URL']),
        userpersisto_auth_policy_get: { enabledAuthMethods: ['emailCode'], allowedRedirectOrigins: [], environmentOverrides: [], selfRegistrationEnabled: true, registrationRole: 'selfRegistered' },
        userpersisto_google_status: { enabled: false, configured: false, available: false, secretPresent: false, redirectUri: '', clientId: '', reason: 'disabled', missing: [] },
        userpersisto_oidc_status: { enabled: false, issuer: '', discoveryUrl: '' },
        email_config_get: settings(['MAILJET_API_KEY', 'MAILJET_API_SECRET', 'MAILJET_FROM_EMAIL', 'MAILJET_FROM_NAME', 'EMAIL_AUTH_CODE_TEMPLATE_ID']),
        email_provider_status: { configured: false, fromEmail: '' },
        workspace_monitor_settings_get: { ok: true, settings: { workspaceCpuPercent: 80, workspaceMemoryBytes: 100, routerCpuPercent: 80, routerMemoryBytes: 50, logRetentionDays: 7 } },
        workspace_monitor_snapshot_get: { ok: true, available: false, stale: true, ageMs: null, snapshot: null },
        dpu_whoami: { ok: true, authenticated: true, actor: { id: principal.id, principalId: `user:${principal.id}`, roles: ['admin'] }, userSpace: { privateId: 'private', mySpaceRootId: 'root' } },
        dpu_workspace_roots: { ok: true, roots: { confidential: { path: '/Confidential' }, mySpace: { id: 'root', path: '/Confidential/My Space' }, ...Object.fromEntries(['sharedFiles', 'secrets', 'researchData', 'jobs'].map((name) => [name, { scope: name, path: '/Confidential/example', type: 'virtual-list' }])) } },
        webmeet_room_list: { rooms: [], canManageRooms: true },
        git_auth_status: { ok: true, configured: false, connected: false, tokenStored: false, setup: { configured: false, scope: 'repo' }, connection: null, pending: null },
    };
    for (const probe of agentReadTools) {
        const success = (value) => decodeAgentMcp(response(200, { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }));
        assert.doesNotThrow(() => assertAgentReadPositive(probe, success(payloads[probe.tool]), principal));
        for (const payload of [{}, { ok: true }, { ...payloads[probe.tool], ok: false }, { ...payloads[probe.tool], error: 'unavailable' }]) {
            assert.throws(() => assertAgentReadPositive(probe, success(payload), principal));
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
    assert.equal(agentCatalog.length, 26);
    assert.equal(agentCatalog.filter((a) => a.enabled).length, 19);
    assert.equal(new Set(agentCatalog.map((a) => `${a.repo}/${a.agent}`)).size, 26);
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
    assert.equal(reconcileAgentRegistry({ routes }).keys.length, 19);
    assert.throws(() => reconcileAgentRegistry({ routes: {} }));
    assert.throws(() => reconcileAgentRegistry({ routes: { ...routes, alien: { agent: 'unrelated-workspace-agent' } } }));
    assert.deepEqual(reconcileAgentRegistry({ routes: { ...routes, alias: { agent: 'explorer' } } }).alternateKeys, [{ key: 'alias', agent: 'explorer' }]);
});
