import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { agentCatalog, agentInventory } from './agent-inventory.mjs';
import { assertDenied, WORKSPACE } from './core.mjs';

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
    { agent: 'webmeetAgent', tool: 'webmeet_room_list', policy: 'workspace' },
    { agent: 'gitAgent', tool: 'git_auth_status', policy: 'workspace' },
];
export const agentDiscoveryMethods = [
    { method: 'tools/list', field: 'tools' },
    { method: 'resources/list', field: 'resources' },
    { method: 'resources/templates/list', field: 'resourceTemplates' },
    { method: 'prompts/list', field: 'prompts' },
];
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
            requireFields(value, ['enabled', 'configured', 'available', 'secretPresent'], 'boolean');
            requireFields(value, ['redirectUri', 'clientId', 'reason'], 'string');
            assert.ok(Array.isArray(value.missing));
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
        if (!agent.enabled) { ctx.recordGap(`agent.${agent.agent}.disabled`, 'Manifest and tools inventoried; runtime disabled/on-demand. No functional positive control and agent was not enabled.'); continue; }
        for (const definition of agentDiscoveryMethods) {
            const id = `agent.${agent.agent}.discovery.${definition.method.replaceAll('/', '.')}`;
            let baseline;
            try {
                baseline = await mcp.rpc('admin', agent.agent, definition.method);
                if (baseline.response.json?.error?.code === -32601) {
                    ctx.recordGap(id, 'Runtime explicitly does not support this MCP discovery method. No authorization or empty-list claim is made.');
                    continue;
                }
                assert.ok(baseline.success);
                requireNamedList(baseline.value, definition.field);
            } catch {
                ctx.recordGap(id, 'Administrator discovery control unavailable or returned an unexpected response shape; inspect the private response artifact. No denial is counted.');
                continue;
            }
            const names = baseline.value[definition.field].map((item) => item.name).sort();
            const sourceNames = definition.field === 'tools' ? agent.tools : [];
            ctx.report.discovery.push({ agent: agent.agent, actor: 'admin', method: definition.method, stage: baseline.stage,
                [definition.field]: names, sourceOnly: sourceNames.filter((n) => !names.includes(n)), runtimeOnly: names.filter((n) => !sourceNames.includes(n)) });
            if (baseline.value.nextCursor) ctx.recordGap(`${id}.pagination`, 'Discovery returned a continuation cursor; only the bounded first page is inventoried.');
            await ctx.check(`${id}.positive`, async () => requireNamedList(baseline.value, definition.field));
            for (const actor of actors.filter((a) => a !== 'admin')) {
                await ctx.check(`${id}.${actor}`, async () => {
                    const result = await mcp.rpc(actor, agent.agent, definition.method);
                    const visible = Array.isArray(result.value?.[definition.field]) ? result.value[definition.field].map((item) => item.name).sort() : [];
                    ctx.report.discovery.push({ agent: agent.agent, actor, method: definition.method, stage: result.stage,
                        [definition.field]: visible, status: result.response.status });
                    if (actor === 'anonymous' || (actor === 'selfRegistered' && agent.agent === 'explorer')) assertAgentMcpDenied(result);
                    else if (!result.success) {
                        if (result.response.json?.error?.code === -32601) {
                            ctx.recordGap(`${id}.${actor}.unsupported`, 'This principal received unsupported-method response despite a working administrator control. This is not an authorization denial.');
                            throw new Error('Unknown discovery authorization outcome: unsupported method for this principal');
                        }
                        assertAgentMcpDenied(result); // Explicit policy may hide discovery from authenticated roles.
                    } else {
                        requireNamedList(result.value, definition.field);
                        if (result.value.nextCursor) ctx.recordGap(`${id}.${actor}.pagination`, 'Only the bounded first discovery page was read.');
                        // Listing metadata does not establish execution or resource-read permission.
                        if (actor === 'selfRegistered' && agent.agent !== 'userPersistoAgent' && visible.length) ctx.recordGap(`${id}.selfRegistered.scope`, 'Workspace discovery metadata is visible to selfRegistered; tool calls and resource reads require separate authorization controls.');
                    }
                });
            }
        }
        // Use a real initialized administrator session; no missing-session/404 evidence accepted.
        let session, stream;
        try {
            session = await mcp.initialize('admin', agent.agent);
            if (session.failure) throw new Error('No administrator MCP session');
            stream = await ctx.request('admin', { path: `/${agent.agent}/mcp`, headers: { ...session.headers, accept: 'text/event-stream' }, stream: true });
        } catch {
            ctx.recordGap(`agent.${agent.agent}.sse`, 'Administrator SSE preparation unavailable; no negative-only claim.');
            continue;
        }
        if (stream.status === 200 && String(stream.headers['content-type']).includes('text/event-stream')) {
            await ctx.check(`agent.${agent.agent}.sse.positive`, async () => assert.equal(stream.status, 200));
            for (const actor of ['anonymous', 'selfRegistered', 'userB']) await ctx.check(`agent.${agent.agent}.sse.cross-session.${actor}`, async () => {
                const response = await ctx.request(actor, { path: `/${agent.agent}/mcp`, headers: { 'mcp-session-id': session.headers['mcp-session-id'], 'mcp-protocol-version': session.headers['mcp-protocol-version'], accept: 'text/event-stream' }, stream: true });
                assertDenied(response);
            });
        } else ctx.recordGap(`agent.${agent.agent}.sse`, `Valid administrator session did not produce an SSE stream (HTTP ${stream.status}); no negative-only claim.`);
    }
}

async function readTools(ctx, mcp) {
    ctx.report.agentReadResults ||= [];
    for (const probe of agentReadTools) {
        let positive;
        try {
            positive = await mcp.rpc('admin', probe.agent, 'tools/call', { name: probe.tool, arguments: probe.args || {} });
            assertAgentReadPositive(probe, positive, ctx.principals.admin);
        } catch {
            ctx.recordGap(`agent.tool.${probe.tool}`, 'Administrator read control unavailable or returned an unexpected response shape; inspect the private response artifact. No denial is counted.');
            continue;
        }
        await ctx.check(`agent.tool.${probe.tool}.admin`, async () => assertAgentReadPositive(probe, positive, ctx.principals.admin));
        if (probe.tool === 'workspace_monitor_snapshot_get' && !positive.value.available) ctx.recordGap('agent.tool.workspace_monitor_snapshot_get.data', 'Snapshot status works but no actual snapshot data is available; data-disclosure coverage remains incomplete.');
        for (const actor of ['anonymous', 'selfRegistered', 'userA', 'userB']) await ctx.check(`agent.tool.${probe.tool}.${actor}`, async () => {
            const result = await mcp.rpc(actor, probe.agent, 'tools/call', { name: probe.tool, arguments: probe.args || {} });
            ctx.report.agentReadResults.push({ agent: probe.agent, tool: probe.tool, actor, stage: result.stage, status: result.response.status });
            const denied = actor === 'anonymous' || probe.policy === 'admin' || (actor === 'selfRegistered' && probe.policy === 'workspace');
            if (denied) assertAgentMcpDenied(result);
            else assertAgentReadPositive(probe, result, ctx.principals[actor]);
        });
    }
}

async function usernamePrivilegeProbe(ctx, mcp) {
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
    if (typeof original !== 'string') { ctx.recordGap('agent.username-admin', 'Could not capture existing disposable username; profile was not changed.'); return; }
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
                : `Username update did not yield a working control (HTTP ${update.status}); reservation and privilege escalation remain unverified.`);
            return;
        }
        requireObject(update.json);
        assert.equal(update.json.ok, true);
        assert.equal(update.json.profile?.user?.username, 'admin', 'Username mutation requires a persisted profile control');
        const current = await ctx.request('userA', { path: '/auth/token?agent=workspaceMonitorAgent' });
        await ctx.check('agent.username-admin.persisted-role', async () => {
            assert.deepEqual(current.json?.user?.roles, ['user'], 'Disposable actor must remain real ordinary user');
            assert.equal(current.json?.user?.username, 'admin', 'Changed username must be in verified Router principal');
        });
        await ctx.check('agent.username-admin.monitor-denial', async () => assertAgentMcpDenied(await mcp.rpc('userA', 'workspaceMonitorAgent', 'tools/call', { name: 'workspace_monitor_settings_get', arguments: {} })));
        await ctx.check('agent.username-admin.webmeet-role', async () => {
            const result = await mcp.rpc('userA', 'webmeetAgent', 'tools/call', { name: 'webmeet_room_list', arguments: {} });
            assertAgentReadPositive({ tool: 'webmeet_room_list' }, result, ctx.principals.userA);
            assert.equal(result.value?.canManageRooms, false, 'Ordinary user acquired administrator room-management projection through username');
        });
    } finally { await restore(); }
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
        catch { ctx.recordGap(probe.id, 'Administrator HTTP control unavailable or returned an unexpected response shape; negative responses are not counted.'); continue; }
        await ctx.check(`${probe.id}.admin`, async () => assertAgentHttpPositive(probe, positive, ctx.principals.admin));
        for (const actor of ['anonymous', 'selfRegistered', 'userA', 'userB']) await ctx.check(`${probe.id}.${actor}`, async () => {
            const response = await ctx.request(actor, probe);
            if (probe.policy === 'admin' || actor === 'anonymous' || actor === 'selfRegistered') assertDenied(response);
            else assertAgentHttpPositive(probe, response, ctx.principals[actor]);
        });
    }
    await discoverAgentMcp(ctx, mcp);
    await readTools(ctx, mcp);
    await usernamePrivilegeProbe(ctx, mcp);
    for (const gap of [
        ['agent.websocket', 'LiveKit public WebSocket requires scoped room token; robot/browser requires unavailable optional backend. No missing-token or failed-upgrade response proves resource authorization.'],
        ['agent.image-routes', 'OnlyOffice DocumentServer, LiveKit, Umami and disabled GPTResearcher expose image-owned dynamic route families. Wildcards remain explicit unresolved endpoint-inventory gaps.'],
        ['agent.inference', 'No inference, external provider/Git/OAuth, download acquisition, or costly compute invocation permitted by local-only target.'],
        ['agent.aliases', 'Canonical MCP and selected additional-server paths exercised. Live route keys reconciled separately; encoded/duplicate-slash/trailing-slash variants and complete additional-server path cross-products remain unexercised.'],
    ]) ctx.recordGap(...gap);
}
