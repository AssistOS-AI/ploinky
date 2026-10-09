// Corrections to expectations that the last full live run showed to disagree with
// the current product contract. Each section pins the exact contract AND proves the
// loosened-looking variants still fail: a bare 200, a generic 503, a missing
// positive control, an unexplained fan-out entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSessionExpired } from './account-probes.mjs';
import { GUEST_COOKIE_NAMES, pinnedGuestList } from './guest-agent-policy.mjs';
import { assertAgentReadPositive, assertGuestDiscovery, assertOwnAccountRouteGate, createAgentSessions, discoverAgentMcp, hasGuestCookie, usernamePrivilegeProbe } from './agent-probes.mjs';
import { classifyAgentCardFanout, runRouterProbes, routerProbes } from './router-probes.mjs';
import { runTerminalProbes } from './stream-probes.mjs';
import { deriveExpectedRuntimes } from './acceptance/expected-runtime-graph.mjs';
import { loadAcceptanceInputs } from './acceptance/verify-acceptance.mjs';

const response = (status, json, headers = {}) => ({ status, json, headers, text: JSON.stringify(json) });
const gapsOf = ctx => ctx.gaps;
function recordingCtx(handler, extra = {}) {
    const ctx = {
        prefix: 'authz-test', gaps: [], cleanups: [], secrets: new Set(), report: { checks: [], requests: [] }, principals: { userA: { id: 'USER.3', roles: ['user'] }, selfRegistered: { id: 'USER.2', roles: ['selfRegistered'] }, admin: { id: 'USER.1', roles: ['admin'] } },
        async guard() { return {}; }, cleanup(fn) { this.cleanups.push(fn); },
        recordGap(id, reason, evidence) { this.gaps.push({ id, reason, evidence }); },
        async request(actor, options) { this.report.requests.push({ actor, ...options }); return handler(actor, options); },
        async check(id, fn) { try { await fn(); this.report.checks.push({ id, status: 'PASS' }); } catch (error) { this.report.checks.push({ id, status: error?.code === 'ERR_ASSERTION' ? 'FAIL' : 'ERROR', error: String(error?.message || error) }); } },
        ...extra,
    };
    return ctx;
}
const statusOf = (ctx, id) => ctx.report.checks.find(c => c.id === id)?.status;

// ---- logout replay -------------------------------------------------------------
test('logout replay: only the exact session_expired refusal that clears the cookie passes', () => {
    const clearing = ['ploinky_sso=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'];
    assert.doesNotThrow(() => assertSessionExpired(response(401, { ok: false, error: 'session_expired' }, { 'set-cookie': clearing })));
    for (const bad of [
        response(200, { ok: true, user: { id: 'USER.3' } }, { 'set-cookie': clearing }),
        response(401, { ok: false, error: 'not_authenticated' }, { 'set-cookie': clearing }),
        response(403, { ok: false, error: 'session_expired' }, { 'set-cookie': clearing }),
        response(401, { ok: false, error: 'session_expired', detail: 'x' }, { 'set-cookie': clearing }),
        response(401, { ok: false, error: 'session_expired' }, {}),
        response(401, { ok: false, error: 'session_expired' }, { 'set-cookie': ['ploinky_sso=abc; Path=/; HttpOnly; Max-Age=0'] }),
        response(401, { ok: false, error: 'session_expired' }, { 'set-cookie': ['ploinky_sso=; Path=/; HttpOnly; Max-Age=14400'] }),
    ]) assert.throws(() => assertSessionExpired(bad));
});

// ---- google status shape ---------------------------------------------------------
test('userpersisto_google_status: the real readiness shape passes and any secret-presence field or old shape fails', () => {
    const real = { enabled: true, configured: true, available: true, mode: 'gis', missing: [], redirectUri: 'http://127.0.0.1:8080/base-agent-additional-server/userPersistoAgent/7000/service/auth/google/callback', clientId: 'client', secretRequired: false, configurationSource: 'local-default', policySource: 'stored-or-default', reason: 'ready' };
    const check = value => assertAgentReadPositive({ tool: 'userpersisto_google_status' }, { success: true, value });
    assert.doesNotThrow(() => check(real));
    assert.throws(() => check({ ...real, secretPresent: false }), /secret presence/);
    assert.throws(() => check({ ...real, secretRequired: true }), /never requires/);
    const { secretRequired, ...withoutRequired } = real;
    assert.throws(() => check(withoutRequired));
    assert.throws(() => check({ ...real, missing: 'USERPERSISTO_SETTINGS_KEY' }));
    assert.throws(() => check({ ...real, ok: false }));
    assert.throws(() => check({ enabled: false, configured: false, available: false, secretPresent: false, redirectUri: '', clientId: '', reason: 'disabled', missing: [] }));
});

// ---- own-account MCP gate for selfRegistered ----------------------------------------
test('profile_get for selfRegistered: the owned dashboard route is the positive and the MCP refusal must be the exact capability error', async () => {
    const probe = { tool: 'userpersisto_profile_get', policy: 'own-account' };
    const profile = { user: { id: 'USER.2', username: '' }, roles: ['selfRegistered'], capabilities: [], authMethods: [], emailVerified: false };
    const dashboard = () => response(200, { ok: true, profile });
    const refused = { stage: 'initialize', response: response(403, { ok: false, error: 'required_capability_missing', requiredCapability: 'explorer.access' }) };
    const run = async (handler, result) => assertOwnAccountRouteGate(recordingCtx(handler), probe, result, 'selfRegistered');
    await run(dashboard, refused);
    // No positive control (the own profile is not readable) -> no denial is credited.
    await assert.rejects(run(() => response(403, { ok: false, error: 'forbidden' }), refused));
    await assert.rejects(run(() => response(200, { ok: true, profile: { ...profile, user: { id: 'USER.9', username: '' } } }), refused), /belongs to current principal/);
    // The MCP side must be the exact capability refusal at initialize.
    for (const bad of [
        { ...refused, stage: 'tools/call' },
        { stage: 'initialize', response: response(403, { ok: false, error: 'forbidden' }) },
        { stage: 'initialize', response: response(401, { ok: false, error: 'required_capability_missing', requiredCapability: 'explorer.access' }) },
        { stage: 'initialize', response: response(403, { ok: false, error: 'required_capability_missing', requiredCapability: 'other.capability' }) },
        { stage: 'tools/call', response: response(200, { result: { content: [] } }) },
    ]) await assert.rejects(run(dashboard, bad));
});

// ---- agent-card fan-out -------------------------------------------------------------
const absent = name => ({ name, statusCode: 404, error: '{"error":"agent-card not configured"}' });
const liveCard = () => ({
    agents: [{ name: 'umamiAgent', statusCode: 200, payload: { agent: 'umamiAgent', about: '', 'agent-card': { name: 'Umami Agent' } } }],
    errors: ['roboTeamAgent', 'dpuAgent', 'emailAgent', 'explorer', 'gitAgent', 'multimedia', 'soplangAgent', 'tasksAgent', 'userPersistoAgent', 'webAssist', 'webmeetAgent', 'workspaceMonitorAgent', 'local-llm'].map(absent)
        .concat([{ name: 'soul-gateway', statusCode: 404, error: '{"error":{"message":"Not found","type":"not_found"}}' }]),
});
test('agent-card fan-out: the live shape is a declared absence; every other error remains unexplained', () => {
    assert.deepEqual(classifyAgentCardFanout(liveCard()).unexplained, []);
    assert.equal(classifyAgentCardFanout(liveCard()).absent.length, 14);
    const variants = {
        timeout: c => { c.errors[0] = { name: 'roboTeamAgent', error: 'agent-card request timed out' }; },
        status500: c => { c.errors[0] = { ...absent('roboTeamAgent'), statusCode: 500 }; },
        otherBody: c => { c.errors[0] = { ...absent('roboTeamAgent'), error: '{"error":"internal"}' }; },
        soulBodyOnAgentServer: c => { c.errors[0] = { ...absent('roboTeamAgent'), error: '{"error":{"message":"Not found","type":"not_found"}}' }; },
        agentServerBodyOnSoul: c => { c.errors[13] = { ...absent('soul-gateway') }; },
        extraField: c => { c.errors[0] = { ...absent('roboTeamAgent'), detail: 'x' }; },
        unknownAgent: c => { c.errors.push(absent('not-an-enabled-agent')); },
        declaredCardMissing: c => { c.errors.push(absent('umamiAgent')); },
        duplicate: c => { c.errors.push(absent('dpuAgent')); },
        cardFromUndeclaring: c => { c.agents.push({ name: 'dpuAgent', statusCode: 200, payload: {} }); },
        cardNon200: c => { c.agents[0] = { ...c.agents[0], statusCode: 201 }; },
    };
    for (const [name, mutate] of Object.entries(variants)) {
        const card = liveCard();
        mutate(card);
        assert.notDeepEqual(classifyAgentCardFanout(card).unexplained, [], name);
    }
});

test('agent-card fan-out: the allow probe records an observation for declared absences and the forbidden gap otherwise', async () => {
    const probe = routerProbes.find(p => p.id === 'agent-card.allow');
    const run = async body => {
        const ctx = recordingCtx(() => response(200, body, { 'content-type': 'application/json' }), {
            principals: { anonymous: { id: 'anon' } },
        });
        await runRouterProbes(ctx, { probes: [{ ...probe, roles: ['anonymous'] }] });
        return ctx;
    };
    const good = await run(liveCard());
    assert.equal(statusOf(good, 'router:agent-card.allow:anonymous'), 'PASS');
    assert.deepEqual(gapsOf(good), []);
    assert.deepEqual(good.report.routerObservations.map(o => [o.id, o.agents.length]), [['agent-card-declared-absence', 14]]);
    const broken = liveCard();
    broken.errors[0] = { name: 'roboTeamAgent', error: 'agent-card request timed out' };
    const bad = await run(broken);
    assert.equal(gapsOf(bad).length, 1);
    assert.equal(gapsOf(bad)[0].id, 'router:agent-card.allow:anonymous:fanout');
    assert.match(gapsOf(bad)[0].reason, /roboTeamAgent/);
    const clean = await run({ agents: [], errors: [] });
    assert.deepEqual(gapsOf(clean), []);
    assert.equal(clean.report.routerObservations, undefined);
});

// ---- guest-authentication discovery ---------------------------------------------------
const named = (field, names) => ({ [field]: names.map(name => field === 'resources' ? { name, uri: `file:///${name}` } : { name }) });
test('guest discovery: a minted guest session and the exact reviewed list pass; a bare 200 or an unreviewed list does not', () => {
    const reviewed = pinnedGuestList('webAssist', 'tools');
    const ok = { response: response(200, {}), success: true, value: named('tools', reviewed) };
    const args = { field: 'tools', adminNames: reviewed, guestCookie: true, pinned: reviewed };
    assert.doesNotThrow(() => assertGuestDiscovery(ok, args));
    assert.throws(() => assertGuestDiscovery(ok, { ...args, guestCookie: false }), /minted guest session/);
    assert.throws(() => assertGuestDiscovery({ ...ok, value: named('tools', [...reviewed, 'extra_admin_tool']) }, args), /exactly the reviewed names/);
    assert.throws(() => assertGuestDiscovery({ ...ok, value: named('tools', reviewed.slice(1)) }, args), /exactly/);
    // Anonymous equals the live administrator list but both differ from the reviewed list: still a failure.
    const drifted = [...reviewed, 'a_new_tool'].sort();
    assert.throws(() => assertGuestDiscovery({ ...ok, value: named('tools', drifted) }, { ...args, adminNames: drifted }), /differ from the reviewed/);
    assert.throws(() => assertGuestDiscovery({ ...ok, success: false }, args));
    assert.throws(() => assertGuestDiscovery({ ...ok, response: response(401, {}) }, args));
    const webAssistCookie = GUEST_COOKIE_NAMES.webAssist;
    const webmeetCookie = GUEST_COOKIE_NAMES.webmeetAgent;
    assert.equal(hasGuestCookie({ cookies: [{ name: webAssistCookie, value: 'x' }] }, undefined, 'webAssist'), true);
    assert.equal(hasGuestCookie({ cookies: [{ name: webAssistCookie, value: '' }] }, undefined, 'webAssist'), false);
    assert.equal(hasGuestCookie({ cookies: [] }, { headers: { 'set-cookie': [`${webAssistCookie}=abc; Path=/`] } }, 'webAssist'), true);
    assert.equal(hasGuestCookie({ cookies: [] }, { headers: { 'set-cookie': [`${webAssistCookie}=; Path=/; Max-Age=0`] } }, 'webAssist'), false);
    assert.equal(hasGuestCookie({ cookies: [{ name: 'ploinky_sso', value: 'x' }] }, { headers: {} }, 'webAssist'), false);
    // Another guest route's cookie, or the retired shared name, is not this route's guest session.
    assert.equal(hasGuestCookie({ cookies: [{ name: webmeetCookie, value: 'x' }] }, undefined, 'webAssist'), false);
    assert.equal(hasGuestCookie({ cookies: [] }, { headers: { 'set-cookie': [`${webmeetCookie}=abc; Path=/`] } }, 'webAssist'), false);
    assert.equal(hasGuestCookie({ cookies: [{ name: webmeetCookie, value: 'x' }] }, undefined, 'webmeetAgent'), true);
    assert.equal(hasGuestCookie({ cookies: [{ name: 'ploinky_guest', value: 'x' }] }, undefined, 'webAssist'), false); // legacy-guest-cookie-case
    // A route without a reviewed guest cookie name is an error, never "any guest cookie".
    assert.throws(() => hasGuestCookie({ cookies: [{ name: webAssistCookie, value: 'x' }] }, undefined), /No reviewed guest cookie name/);
    assert.throws(() => hasGuestCookie({ cookies: [{ name: webAssistCookie, value: 'x' }] }, undefined, 'unreviewedGuestAgent'), /No reviewed guest cookie name/);
    assert.throws(() => pinnedGuestList('unreviewedGuestAgent', 'tools'), /no reviewed policy/);
});

function discoveryWorld({ guest = true, anonymousTools, anonymousStatus = 200, cookie = true } = {}) {
    const admin = pinnedGuestList('webAssist', 'tools');
    const checks = [];
    const ctx = {
        report: {}, secrets: new Set(), guestAgents: guest ? [{ repo: 'AchillesIDE', agent: 'webAssist' }] : [], clients: { anonymous: { cookies: cookie ? [{ name: GUEST_COOKIE_NAMES.webAssist, value: 'g' }] : [] } },
        recordGap: () => {},
        async check(id, fn) { try { await fn(); checks.push({ id, status: 'PASS' }); } catch (error) { checks.push({ id, status: 'FAIL', error: String(error?.message || error) }); } },
    };
    const mcp = {
        async rpc(actor, agent, method) {
            if (method === 'resources/list') return { stage: method, response: response(200, {}), success: true, value: { resources: [] } };
            if (method !== 'tools/list') return { stage: method, response: response(200, { error: { code: -32601 } }), success: false, value: undefined };
            if (actor === 'anonymous' && anonymousStatus !== 200) return { stage: 'initialize', response: response(anonymousStatus, { error: 'authentication required' }), success: false, error: 'authentication required' };
            const names = actor === 'anonymous' && anonymousTools ? anonymousTools : admin;
            return { stage: method, response: response(200, {}), success: true, value: named('tools', names) };
        },
        async initialize() { return { init: { headers: {} } }; },
    };
    return { ctx, mcp, checks, catalog: [{ repo: 'AchillesIDE', agent: 'webAssist', enabled: true, tools: admin }] };
}
test('guest discovery flow: only a declared guest agent may answer anonymous discovery, and only as a guest', async () => {
    const outcome = async options => {
        const world = discoveryWorld(options);
        await discoverAgentMcp(world.ctx, world.mcp, world.catalog);
        return world.checks.find(c => c.id === 'agent.webAssist.discovery.tools.list.anonymous');
    };
    assert.equal((await outcome({})).status, 'PASS');
    // Same successful list on an agent that is NOT declared guest is a denial bypass.
    assert.equal((await outcome({ guest: false })).status, 'FAIL');
    // A declared guest agent still fails without a guest session (mode-none route) and on extra names.
    assert.equal((await outcome({ cookie: false })).status, 'FAIL');
    assert.equal((await outcome({ anonymousTools: [...pinnedGuestList('webAssist', 'tools'), 'extra_admin_tool'] })).status, 'FAIL');
    assert.equal((await outcome({ anonymousStatus: 401 })).status, 'FAIL');
});

// ---- username shortcut: the principal must carry the changed username ---------------------
function usernameWorld({ usernameAfter = 2, neverAdmin = false } = {}) {
    let tokenCalls = 0;
    const state = { username: '' };
    const profile = () => ({ user: { id: 'USER.3', username: state.username }, roles: ['user'], capabilities: ['explorer.access'], authMethods: [], emailVerified: false });
    const handler = (actor, options) => {
        const p = options.path;
        if (p === '/auth/token?agent=workspaceMonitorAgent') {
            tokenCalls++;
            const username = !neverAdmin && tokenCalls > usernameAfter ? 'admin' : '';
            return response(200, { ok: true, user: { id: 'USER.3', roles: ['user'], username } });
        }
        if (p.startsWith('/auth/token')) return response(200, { ok: true });
        if (options.method === 'POST') { state.username = options.body.username; return response(200, { ok: true, profile: profile() }); }
        return response(200, { ok: true, profile: profile() });
    };
    const ctx = recordingCtx(handler);
    const calls = [];
    const mcp = { async rpc(actor, agent, method, params) { calls.push(params?.name); return params?.name === 'workspace_monitor_settings_get'
        ? { stage: method, response: response(200, {}), success: false, error: 'Access denied: administrator is required.' }
        : { stage: method, response: response(200, {}), success: true, value: { rooms: [{ id: 'room_1' }], canManageRooms: false } }; } };
    return { ctx, mcp, calls, state, tokenCalls: () => tokenCalls };
}
test('username shortcut: the monitor and room probes run only after the Router principal carries the changed username', async () => {
    const world = usernameWorld({ usernameAfter: 3 });
    await usernamePrivilegeProbe(world.ctx, world.mcp, { roomId: 'room_1' }, { revalidationMs: 2000, pollMs: 2 });
    assert.equal(statusOf(world.ctx, 'agent.username-admin.profile-positive'), 'PASS');
    assert.equal(statusOf(world.ctx, 'agent.username-admin.persisted-role'), 'PASS');
    assert.equal(statusOf(world.ctx, 'agent.username-admin.monitor-denial'), 'PASS');
    assert.equal(statusOf(world.ctx, 'agent.username-admin.webmeet-role'), 'PASS');
    assert.ok(world.tokenCalls() >= 4, 'the probe waited for the refreshed principal');
    for (const fn of world.ctx.cleanups) await fn();
    assert.equal(world.state.username, '', 'the disposable username is restored');
});
test('username shortcut: a principal that never carries the username fails all three and exercises nothing', async () => {
    const world = usernameWorld({ neverAdmin: true });
    await usernamePrivilegeProbe(world.ctx, world.mcp, { roomId: 'room_1' }, { revalidationMs: 30, pollMs: 5 });
    assert.equal(statusOf(world.ctx, 'agent.username-admin.persisted-role'), 'FAIL');
    assert.equal(statusOf(world.ctx, 'agent.username-admin.monitor-denial'), 'FAIL');
    assert.equal(statusOf(world.ctx, 'agent.username-admin.webmeet-role'), 'FAIL');
    assert.deepEqual(world.calls, [], 'no MCP call was made without a proven principal');
    for (const fn of world.ctx.cleanups) await fn();
});

// ---- terminal discovery cleanup ------------------------------------------------------------
async function terminalWorld({ deleteWorks = true, consumeRemovesBatch = true } = {}) {
    const host = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'authz-terminal-'));
    const fixture = { directory: 'authz-term-test-terminal', host };
    const discoveries = new Map();
    const sessions = new Set();
    let counter = 0;
    const id = (prefix) => `${prefix}${String(++counter).padStart(32 - prefix.length, 'x')}`;
    const handler = async (actor, { method = 'GET', path: p, body, stream }) => {
        const denied = actor !== 'admin' ? response(actor === 'anonymous' ? 401 : 403, { ok: false, error: 'authentication required' }) : null;
        if (p === '/webtty/target-discoveries' && method === 'POST') {
            if (denied) return denied;
            const discoveryId = id('d');
            const launch = id('L');
            discoveries.set(discoveryId, launch);
            return response(201, { ok: true, discovery: { id: discoveryId, targets: [{ kind: 'box', access: 'rw', launch, label: 'Ploinky Box' }] } });
        }
        if (p.startsWith('/webtty/target-discoveries/') && method === 'DELETE') {
            if (denied) return denied;
            const discoveryId = p.split('/').pop();
            if (!discoveries.has(discoveryId) || !deleteWorks) return response(404, { ok: false, error: 'not_found' });
            discoveries.delete(discoveryId);
            return response(200, { ok: true });
        }
        if (p === '/webtty/sessions' && method === 'POST') {
            if (denied) return denied;
            const found = [...discoveries].find(([, launch]) => launch === body.launch);
            if (!found) return response(404, { ok: false, error: 'not_found' });
            if (consumeRemovesBatch) discoveries.delete(found[0]);
            const sessionId = id('s');
            sessions.add(sessionId);
            return response(201, { ok: true, session: { id: sessionId, target: { kind: 'box' } } });
        }
        const session = p.match(/^\/webtty\/sessions\/([^/]+)(\/(stream|input|resize))?$/);
        if (session) {
            if (denied) return denied;
            if (session[3] === 'stream') return { status: 200, headers: { 'content-type': 'text/event-stream' }, text: '', json: undefined };
            if (session[3] === 'input') { await fsPromises.writeFile(path.join(host, 'marker.txt'), `${body.data.match(/'(authz-[a-z0-9-]+)'/)[1]}\n`); return response(200, { ok: true }); }
            if (session[3] === 'resize') return response(200, { ok: true });
            if (method === 'DELETE') { sessions.delete(session[1]); return response(200, { ok: true }); }
        }
        return response(404, { ok: false, error: 'not_found' });
    };
    const ctx = recordingCtx(handler, { prefix: 'authz-term-test' });
    return { ctx, fixture, cleanup: () => fsPromises.rm(host, { recursive: true, force: true }) };
}
test('terminal discovery cleanup: 404 is only the consumed-batch contract, backed by a positive delete', async t => {
    const world = await terminalWorld();
    t.after(world.cleanup);
    await runTerminalProbes(world.ctx, world.fixture);
    const failed = world.ctx.report.checks.filter(c => c.status !== 'PASS');
    assert.deepEqual(failed, []);
    assert.equal(statusOf(world.ctx, 'router:terminal-discovery-delete-positive:admin'), 'PASS');
    assert.equal(statusOf(world.ctx, 'router:terminal-discovery-cleanup:admin'), 'PASS');
    assert.deepEqual(world.ctx.gaps, []);
    for (const fn of world.ctx.cleanups) await fn();
});
test('terminal discovery cleanup: a broken DELETE cannot hide behind the 404', async t => {
    const world = await terminalWorld({ deleteWorks: false });
    t.after(world.cleanup);
    await runTerminalProbes(world.ctx, world.fixture);
    assert.equal(statusOf(world.ctx, 'router:terminal-discovery-delete-positive:admin'), 'FAIL');
});
test('terminal discovery cleanup: if consumption left the batch, the cleanup must find it removable (200), not 404', async t => {
    const world = await terminalWorld({ consumeRemovesBatch: false });
    t.after(world.cleanup);
    await runTerminalProbes(world.ctx, world.fixture);
    // The model now disagrees with the reviewed consumed-batch contract, so the 200 is a FAIL.
    assert.equal(statusOf(world.ctx, 'router:terminal-discovery-cleanup:admin'), 'FAIL');
    assert.equal(statusOf(world.ctx, 'router:terminal-discovery-delete-positive:admin'), 'PASS');
});

// ---- guest agents come from the pinned manifests -------------------------------------------
test('guestAgents are derived from enabled guest-authentication manifests only and match the committed set', () => {
    const manifests = {
        'R/root': { ploinky: 'sso enable', enable: ['child', 'S/guesty'] },
        'R/child': {}, 'S/guesty': { guest: true }, 'S/idle-guest': { guest: true }, 'S/plain': {},
    };
    const source = { listAgents: repo => Object.keys(manifests).filter(k => k.startsWith(`${repo}/`)).map(k => k.split('/')[1]), readManifest: (repo, agent) => manifests[`${repo}/${agent}`] || null };
    const derived = deriveExpectedRuntimes({ policy: { rootAgent: 'R/root', profile: 'default', inventoryRepositories: [{ name: 'R' }, { name: 'S' }] }, source });
    assert.deepEqual(derived.guestAgents, [{ repo: 'S', agent: 'guesty' }], 'a disabled guest agent is not a guest runtime');
    // Guest authentication cannot be combined with SSO authentication on the same manifest.
    manifests['S/guesty'] = { guest: true, ploinky: 'sso enable' };
    assert.throws(() => deriveExpectedRuntimes({ policy: { rootAgent: 'R/root', profile: 'default', inventoryRepositories: [{ name: 'R' }, { name: 'S' }] }, source }), /cannot be combined with guest/);
    const { expectedRuntimes } = loadAcceptanceInputs();
    assert.deepEqual(expectedRuntimes.guestAgents, [{ repo: 'AchillesIDE', agent: 'webAssist' }, { repo: 'AchillesIDE', agent: 'webmeetAgent' }]);
    assert.ok(expectedRuntimes.guestAgents.every(g => expectedRuntimes.enabled.some(e => e.repo === g.repo && e.agent === g.agent)));
});
