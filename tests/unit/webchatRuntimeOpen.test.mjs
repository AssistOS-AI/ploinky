import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { computeRchTool } from '../../Agent/lib/requestHash.mjs';
import { handleRuntimeRoute } from '../../cli/server/handlers/webchat/runtimeRoutes.js';
import {
    WEBCHAT_RUNTIME_OPEN_EVENT,
    WEBCHAT_STOP_EVENT,
    serializeWebchatEnvelopeForAgent,
} from '../../cli/server/handlers/webchat/messageEnvelope.js';
import {
    assertWebchatDelegationsManifest,
    buildMcpDelegationsForUserCall,
    normalizeWebchatDelegations,
} from '../../cli/server/mcp-proxy/mcpDelegations.js';
import { verifyUserDelegationGrant } from '../../cli/server/mcp-proxy/userDelegationGrant.js';
import { createNetwork } from '../../cli/server/webchat/network.js';
import { previewAgentEnable } from '../../cli/utils/agents.js';
import { deriveSubkey } from '../../cli/utils/security/masterKey.js';
import { domainFixture } from './directDomainFixtures.mjs';

const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);
test.after(() => {
    if (previousMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousMasterKey;
});

// Fictional agents: `unrelated` is a WebChat agent that declares
// `webchat.delegations` for the provider `explorer`; `mailer` forwards
// envelopes without declaring delegations.
const COORDINATOR = 'agent:fixtures/unrelated';
const PROVIDER = 'agent:fixtures/explorer';
const DELEGATION = Object.freeze({
    key: 'providerAdmission',
    targetAgentId: 'agent:./explorer',
    tools: ['__coordinator_admission__'],
    scopes: ['execution:owner'],
    ttlSeconds: 30,
});
const USER_A = Object.freeze({ id: 'user-a', username: 'alice', email: 'a@example.test', roles: ['user'] });
const USER_B = Object.freeze({ id: 'user-b', username: 'bob', email: 'b@example.test', roles: ['user'] });
const GUEST = Object.freeze({ id: 'guest:visitor', username: 'visitor', roles: ['guest'] });

function webchatWorld(t, { delegations = [DELEGATION] } = {}) {
    return domainFixture(t, {
        mode: 'dual',
        manifests: {
            unrelated: {
                routerAccess: { httpRoutes: [{ path: '/public/*', access: 'authenticated' }] },
                webchat: { forwardEnvelope: true, delegations },
            },
            mailer: { webchat: { forwardEnvelope: true } },
        },
    });
}

const decodeJwt = (token) => JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
const webchatRch = (args) => computeRchTool({ method: 'POST', path: '/mcp', tool: '__webchat_message__', arguments: args });
const baseArgs = (tabId, pageInstanceId, text = '') => ({
    surface: 'webchat', tabId, pageInstanceId, text, attachments: [], references: [], presentation: { visible: false },
});

function verifyAdmissionGrant(claims) {
    const entry = claims.delegations?.providerAdmission;
    assert.ok(entry?.token, 'the envelope token carries the providerAdmission grant');
    return verifyUserDelegationGrant({
        signingSecret: deriveSubkey('router-user-delegation', 32),
        token: entry.token,
        expectedSourceAgentId: COORDINATOR,
        expectedTargetAgentId: PROVIDER,
        expectedTool: '__coordinator_admission__',
    });
}

function makeTty({ protocol = true } = {}) {
    const handlers = { output: [], close: [], startup: [] };
    let state = protocol ? 'starting' : 'ready';
    const tty = {
        input: [],
        alive: true,
        isAlive() { return this.alive; },
        onOutput(handler) { handlers.output.push(handler); },
        onClose(handler) { handlers.close.push(handler); },
        write(value) { this.input.push(String(value)); return true; },
        dispose() { this.alive = false; },
        ready() { state = 'ready'; for (const handler of handlers.startup) handler({ state }); },
        fail() { state = 'failed'; for (const handler of handlers.startup) handler({ state }); },
        close() { this.alive = false; for (const handler of handlers.close) handler(); },
    };
    if (protocol) {
        tty.onStartupState = (handler) => { handlers.startup.push(handler); handler({ state }); };
    }
    return tty;
}

const runtimeOpenLines = (tty) => tty.input
    .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter((payload) => payload?.event === WEBCHAT_RUNTIME_OPEN_EVENT);

function server(t, { agentName = 'unrelated', forwardEnvelope = true, protocol = true } = {}) {
    const ttys = [];
    const appState = { runtimes: new Map(), sessions: new Map([['sid-a', {}], ['sid-b', {}], ['sid-g', {}]]) };
    const effectiveConfig = {
        agentName,
        forwardEnvelope,
        ttyFactory: { create: () => { const tty = makeTty({ protocol }); ttys.push(tty); return tty; } },
    };
    const requests = [];
    const request = (pathname, { tabId = 'tab-a', page = 'page-a', sid = 'sid-a', user = USER_A, body, onWrite, onEnd } = {}) => {
        const req = new EventEmitter();
        req.headers = { cookie: `webchat_sid=${sid}`, host: 'localhost' };
        req.socket = {};
        req.method = pathname === '/stream' ? 'GET' : 'POST';
        req.user = user;
        req.authMode = 'sso';
        const chunks = [];
        const res = {
            statusCode: null,
            writeHead(status) { this.statusCode = status; },
            write(chunk) { chunks.push(String(chunk)); onWrite?.(String(chunk)); },
            end(chunk = '') { chunks.push(String(chunk)); this.ended = true; onEnd?.(); },
        };
        handleRuntimeRoute({
            pathname, req, res,
            parsedUrl: new URL(`http://localhost${pathname}?tabId=${tabId}&pageInstanceId=${page}`),
            appState, effectiveConfig, workspaceDirectory: '/workspace', agentQuery: '',
        });
        if (body !== undefined) { req.emit('data', Buffer.from(body)); req.emit('end'); }
        requests.push(req);
        return { req, res, chunks };
    };
    t.after(() => {
        for (const req of requests) req.emit('close');
        for (const tab of appState.runtimes.values()) clearTimeout(tab.cleanupTimer);
    });
    return { ttys, appState, request, effectiveConfig };
}

test('webchat.delegations minting: every forwarded envelope of a non-guest user carries the declared grant; none for a guest or an undeclared agent', (t) => {
    webchatWorld(t);
    const envelope = { text: 'hello', attachments: [], presentation: { visible: true } };
    const req = { headers: { host: 'localhost' }, socket: {}, user: USER_A, authMode: 'sso' };
    const payload = JSON.parse(serializeWebchatEnvelopeForAgent({
        req, effectiveConfig: { agentName: 'unrelated' }, tabId: 'tab-a', pageInstanceId: 'page-a', envelope,
    }));
    const claims = decodeJwt(payload.invocation.token);
    assert.equal(claims.tool, '__webchat_message__');
    const verified = verifyAdmissionGrant(claims);
    assert.equal(verified.user.id, USER_A.id);
    assert.deepEqual(verified.delegation.scope, ['execution:owner']);
    assert.equal(verified.claims.exp - verified.claims.iat, 30);
    assert.equal(Object.hasOwn(payload, 'event'), false, 'an ordinary envelope has no event');

    const guestPayload = JSON.parse(serializeWebchatEnvelopeForAgent({
        req: { ...req, user: GUEST }, effectiveConfig: { agentName: 'unrelated' }, tabId: 'tab-g', pageInstanceId: 'page-g', envelope,
    }));
    assert.ok(guestPayload.invocation?.token, 'positive control: the guest envelope is still signed');
    assert.equal(decodeJwt(guestPayload.invocation.token).delegations, undefined, 'no grant is minted for a guest');

    const undeclared = JSON.parse(serializeWebchatEnvelopeForAgent({
        req, effectiveConfig: { agentName: 'mailer' }, tabId: 'tab-a', pageInstanceId: 'page-a', envelope,
    }));
    assert.equal(decodeJwt(undeclared.invocation.token).delegations, undefined);

    // mcp-config tool delegations are not consulted for the WebChat pseudo-tool, and
    // webchat.delegations is not consulted for an ordinary MCP tool.
    assert.equal(buildMcpDelegationsForUserCall({ req, routeKey: 'unrelated', toolName: 'some_tool', routes: {} }), undefined);
    assert.deepEqual(Object.keys(buildMcpDelegationsForUserCall({ req, routeKey: 'unrelated', toolName: '__webchat_message__' })), ['providerAdmission']);
});

test('the runtime-open envelope is written exactly once per runtime creation, after ready, signed for the stream user with event in the signed arguments', (t) => {
    webchatWorld(t);
    const srv = server(t);
    const first = srv.request('/stream', { tabId: 'tab-a', page: 'page-a', sid: 'sid-a', user: USER_A });
    assert.equal(first.res.statusCode, 200);
    assert.equal(srv.ttys.length, 1);
    assert.equal(runtimeOpenLines(srv.ttys[0]).length, 0, 'nothing is written while the runtime is starting');
    // A second user attaches to the shared runtime before and after readiness.
    srv.request('/stream', { tabId: 'tab-b', page: 'page-b', sid: 'sid-b', user: USER_B });
    srv.ttys[0].ready();
    srv.ttys[0].ready();
    srv.request('/stream', { tabId: 'tab-c', page: 'page-c', sid: 'sid-b', user: USER_B });
    assert.equal(srv.ttys.length, 1, 'one runtime creation');
    const lines = runtimeOpenLines(srv.ttys[0]);
    assert.equal(lines.length, 1, 'exactly one runtime-open envelope');
    const [open] = lines;
    assert.equal(open.text, '');
    assert.deepEqual(open.presentation, { visible: false });
    assert.equal(open.sourceTabId, 'tab-a');
    assert.equal(open.sourcePageInstanceId, 'page-a');
    const claims = decodeJwt(open.invocation.token);
    assert.equal(claims.sub, `user:${USER_A.id}`, 'signed for the user of the stream request that created the runtime');
    assert.equal(claims.rch, webchatRch({ ...baseArgs('tab-a', 'page-a'), event: WEBCHAT_RUNTIME_OPEN_EVENT }));
    assert.notEqual(claims.rch, webchatRch(baseArgs('tab-a', 'page-a')), 'the event is part of the signed arguments');
    assert.equal(verifyAdmissionGrant(claims).user.id, USER_A.id);
});

test('runtime-open: none for a failed startup, an undeclared agent or a configuration that does not forward envelopes; a runtime without a startup protocol is ready at creation', (t) => {
    webchatWorld(t);
    const failed = server(t);
    failed.request('/stream');
    failed.ttys[0].fail();
    assert.equal(runtimeOpenLines(failed.ttys[0]).length, 0);

    const undeclared = server(t, { agentName: 'mailer' });
    undeclared.request('/stream');
    undeclared.ttys[0].ready();
    assert.equal(runtimeOpenLines(undeclared.ttys[0]).length, 0);

    const notForwarding = server(t, { forwardEnvelope: false });
    notForwarding.request('/stream');
    notForwarding.ttys[0].ready();
    assert.equal(runtimeOpenLines(notForwarding.ttys[0]).length, 0);

    const immediate = server(t, { protocol: false });
    immediate.request('/stream');
    assert.equal(runtimeOpenLines(immediate.ttys[0]).length, 1, 'positive control: written at creation');

    const guest = server(t);
    guest.request('/stream', { sid: 'sid-g', user: GUEST, tabId: 'tab-g', page: 'page-g' });
    guest.ttys[0].ready();
    const [guestOpen] = runtimeOpenLines(guest.ttys[0]);
    assert.ok(guestOpen, 'a guest runtime is announced too');
    assert.equal(decodeJwt(guestOpen.invocation.token).delegations, undefined, 'but carries no grant');
});

test('a browser envelope cannot produce the runtime-open event', (t) => {
    webchatWorld(t);
    const srv = server(t, { protocol: false });
    srv.request('/stream');
    const tty = srv.ttys[0];
    const before = tty.input.length;
    const input = srv.request('/input', {
        body: JSON.stringify({ __webchatMessage: 1, text: '/tasks', event: WEBCHAT_RUNTIME_OPEN_EVENT, presentation: { visible: false } }),
    });
    assert.equal(input.res.statusCode, 204);
    const written = tty.input.slice(before).map((line) => JSON.parse(line));
    assert.equal(written.length, 1);
    assert.equal(Object.hasOwn(written[0], 'event'), false);
    const claims = decodeJwt(written[0].invocation.token);
    assert.equal(claims.rch, webchatRch({ ...baseArgs('tab-a', 'page-a', '/tasks') }));
    assert.equal(verifyAdmissionGrant(claims).user.id, USER_A.id, 'the hidden /tasks command carries a fresh grant');
});

test('manifest validation of webchat.delegations: a valid declaration normalizes; an invalid one is a manifest error at admission and at generation compile', (t) => {
    const entries = normalizeWebchatDelegations({ webchat: { delegations: [DELEGATION] } }, { repoName: 'fixtures', agentName: 'unrelated' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].targetAgentId, PROVIDER, 'agent:./ expands with the declaring repository');
    assert.equal(entries[0].sourceAgentId, COORDINATOR);
    assert.deepEqual(normalizeWebchatDelegations({ webchat: { forwardEnvelope: true } }), [], 'absent is not an error');

    const invalid = [
        ['not an array', { key: 'x' }],
        ['empty array', []],
        ['empty tools', [{ ...DELEGATION, tools: [] }]],
        ['empty scopes', [{ ...DELEGATION, scopes: [] }]],
        ['ttl below the minimum', [{ ...DELEGATION, ttlSeconds: 5 }]],
        ['traversal target', [{ ...DELEGATION, targetAgentId: 'agent:../evil' }]],
    ];
    for (const [label, delegations] of invalid) {
        assert.throws(() => assertWebchatDelegationsManifest({
            manifest: { webchat: { delegations } }, repoName: 'fixtures', agentName: 'unrelated', label: 'manifest(fixtures/unrelated)',
        }), /manifest\(fixtures\/unrelated\): Invalid MCP tool delegations for '__webchat_message__'/, label);
    }

    // Generation compile refuses an enabled route whose manifest is invalid.
    const world = webchatWorld(t);
    const file = path.join(world.root, 'fixtures', 'unrelated', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.webchat.delegations = [{ ...DELEGATION, ttlSeconds: 5 }];
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => world.apply(), /manifest\(unrelated\): Invalid MCP tool delegations for '__webchat_message__'.*invalid ttlSeconds/);
});

// The generic client against the real runtime route: two tabs share one
// runtime; the agent process exits after readiness (for example its container
// restarted); both clients reconnect under the bounded backoff and the
// respawn yields exactly one runtime creation and one runtime-open envelope.
test('a respawn after a ready runtime closes yields exactly one runtime creation and one runtime-open; a failed close stays terminal', (t) => {
    webchatWorld(t);
    const srv = server(t);
    const users = { 'tab-a': ['sid-a', USER_A, 'page-a'], 'tab-b': ['sid-b', USER_B, 'page-b'] };
    const sources = [];
    class SseEventSource {
        constructor(url) {
            this.listeners = new Map();
            sources.push(this);
            const tabId = new URL(url, 'http://localhost/').searchParams.get('tabId');
            const [sid, user, page] = users[tabId];
            let buffer = '';
            srv.request('/stream', {
                tabId, page, sid, user,
                onWrite: (chunk) => {
                    buffer += chunk;
                    let index;
                    while ((index = buffer.indexOf('\n\n')) >= 0) {
                        const block = buffer.slice(0, index);
                        buffer = buffer.slice(index + 2);
                        const name = /^event: (.*)$/m.exec(block)?.[1];
                        const data = /^data: (.*)$/m.exec(block)?.[1];
                        if (name && data !== undefined && !this.closed) this.listeners.get(name)?.({ data });
                    }
                },
                onEnd: () => { if (!this.closed) this.onerror?.(); },
            });
        }
        addEventListener(name, fn) { this.listeners.set(name, fn); }
        close() { this.closed = true; }
    }
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(Math, 'random', () => 0);
    const originalSource = globalThis.EventSource;
    globalThis.EventSource = SseEventSource;
    const banners = { 'tab-a': [], 'tab-b': [] };
    const networks = ['tab-a', 'tab-b'].map((tabId) => createNetwork({
        TAB_ID: tabId, PAGE_INSTANCE_ID: users[tabId][2], agentName: 'unrelated',
        toEndpoint: (route) => route, dlog() {},
        showBanner: (text) => banners[tabId].push(text), hideBanner() {},
        statusEl: { textContent: '' }, statusDot: { classList: { add() {}, remove() {} } },
    }, { addServerMsg() {}, showTypingIndicator() {}, hideTypingIndicator() {} }));
    t.after(() => {
        for (const network of networks) network.stop();
        if (originalSource === undefined) delete globalThis.EventSource;
        else globalThis.EventSource = originalSource;
    });
    for (const network of networks) network.start();
    assert.equal(srv.ttys.length, 1);
    srv.ttys[0].ready();
    assert.equal(runtimeOpenLines(srv.ttys[0]).length, 1);

    // The agent process exits after readiness: the Router writes close{closed} and ends both streams.
    srv.ttys[0].close();
    assert.equal(srv.appState.runtimes.size, 0);
    assert.equal(sources.length, 2, 'no reconnect before the backoff delay');
    t.mock.timers.tick(1000);
    assert.equal(sources.length, 4, 'each client reconnects exactly once');
    assert.equal(srv.ttys.length, 2, 'the respawn created exactly one runtime');
    srv.ttys[1].ready();
    const reopened = runtimeOpenLines(srv.ttys[1]);
    assert.equal(reopened.length, 1, 'and exactly one runtime-open envelope');
    assert.equal(decodeJwt(reopened[0].invocation.token).sub, `user:${USER_A.id}`);
    t.mock.timers.tick(120000);
    assert.equal(sources.length, 4);
    assert.equal(srv.ttys.length, 2);

    // A runtime that fails its startup closes with state failed: terminal for both clients.
    srv.ttys[1].fail();
    srv.ttys[1].close();
    t.mock.timers.tick(120000);
    assert.equal(sources.length, 4, 'no reconnect after a failed close');
    assert.equal(srv.ttys.length, 2);
    for (const tabId of ['tab-a', 'tab-b']) assert.match(banners[tabId].at(-1), /Agent startup failed/);
});

// The enable-time call site in cli/utils/agents.js (planAgentEnable), reached
// through previewAgentEnable before any record or route is staged.
test('enable planning refuses an invalid webchat.delegations declaration and accepts a valid one', () => {
    const preview = (manifest) => {
        const registry = {};
        const routing = { routes: {} };
        const resolved = {
            agentPath: '/fixture/fixtures/unrelated', manifest, manifestBytes: Buffer.from('{}'),
            manifestPath: '/fixture/fixtures/unrelated/manifest.json', normalized: { mode: 'global' }, profile: '',
            repoName: 'fixtures', routerEndpoint: null, runtimeAdmission: {}, shortAgentName: 'unrelated',
            profileResolution: { resolvedProfileName: 'default', profileConfig: null, network: { mode: 'default' } },
        };
        const result = previewAgentEnable({ agentName: 'fixtures/unrelated', mode: 'global' }, {
            readRegistry: () => registry, readRouting: () => routing, resolveInput: () => resolved,
        });
        assert.deepEqual({ registry, routing }, { registry: {}, routing: { routes: {} } }, 'planning stages nothing');
        return result;
    };
    const container = 'node:20';
    assert.equal(preview({ container, webchat: { forwardEnvelope: true, delegations: [DELEGATION] } }).plan.record.agentName, 'unrelated');
    assert.equal(preview({ container, webchat: { forwardEnvelope: true } }).plan.record.agentName, 'unrelated');
    for (const delegations of [[], { key: 'x' }, [{ ...DELEGATION, ttlSeconds: 5 }], [{ ...DELEGATION, scopes: [] }]]) {
        assert.throws(() => preview({ container, webchat: { delegations } }),
            /manifest\(fixtures\/unrelated\): Invalid MCP tool delegations for '__webchat_message__'/, JSON.stringify(delegations));
    }
});

// The WebChat stop (Escape or the stop button) posts a single ESC to /control.
const controlLines = (tty, before) => tty.input.slice(before).map((line) => JSON.parse(line));

test('a stop on a delegating agent is a signed stop envelope with the same grant as a message envelope; undeclared agents keep the unsigned control', (t) => {
    webchatWorld(t);
    const srv = server(t, { protocol: false });
    srv.request('/stream', { tabId: 'tab-a', page: 'page-a', sid: 'sid-a', user: USER_A });
    const tty = srv.ttys[0];
    const before = tty.input.length;
    const stop = srv.request('/control', { tabId: 'tab-a', page: 'page-a', sid: 'sid-a', user: USER_A, body: '\x1b' });
    assert.equal(stop.res.statusCode, 204);
    const [envelope] = controlLines(tty, before);
    assert.equal(Object.hasOwn(envelope, '__webchatControl'), false, 'not the unsigned control line');
    assert.equal(envelope.__webchatMessage, 1);
    assert.equal(envelope.event, WEBCHAT_STOP_EVENT);
    assert.equal(envelope.text, '');
    assert.deepEqual(envelope.presentation, { visible: false });
    assert.equal(envelope.sourceTabId, 'tab-a');
    assert.equal(envelope.sourcePageInstanceId, 'page-a');

    const claims = decodeJwt(envelope.invocation.token);
    assert.equal(claims.tool, '__webchat_message__');
    assert.equal(claims.sub, `user:${USER_A.id}`);
    assert.equal(claims.rch, webchatRch({ ...baseArgs('tab-a', 'page-a'), event: WEBCHAT_STOP_EVENT }), 'the stop event is part of the signed arguments');
    assert.notEqual(claims.rch, webchatRch(baseArgs('tab-a', 'page-a')));
    const grant = verifyAdmissionGrant(claims);
    assert.equal(grant.user.id, USER_A.id);

    // Same delegation scope, TTL and key as a message envelope for the same user.
    const message = JSON.parse(serializeWebchatEnvelopeForAgent({
        req: { headers: { host: 'localhost' }, socket: {}, user: USER_A, authMode: 'sso' },
        effectiveConfig: { agentName: 'unrelated' }, tabId: 'tab-a', pageInstanceId: 'page-a',
        envelope: { text: 'hi', attachments: [], presentation: { visible: true } },
    }));
    const messageGrant = verifyAdmissionGrant(decodeJwt(message.invocation.token));
    assert.deepEqual(grant.delegation.scope, messageGrant.delegation.scope);
    assert.equal(grant.claims.exp - grant.claims.iat, messageGrant.claims.exp - messageGrant.claims.iat);
    assert.deepEqual(Object.keys(decodeJwt(envelope.invocation.token).delegations), ['providerAdmission']);

    // A guest's stop is signed too, without a grant, exactly like the guest's messages.
    const guest = server(t, { protocol: false });
    guest.request('/stream', { tabId: 'tab-g', page: 'page-g', sid: 'sid-g', user: GUEST });
    guest.request('/control', { tabId: 'tab-g', page: 'page-g', sid: 'sid-g', user: GUEST, body: '\x1b' });
    const guestStop = controlLines(guest.ttys[0], 0).find((line) => line.event === WEBCHAT_STOP_EVENT);
    assert.equal(decodeJwt(guestStop.invocation.token).delegations, undefined);

    // An agent that forwards envelopes without declaring delegations keeps the unsigned control.
    const undeclared = server(t, { agentName: 'mailer', protocol: false });
    undeclared.request('/stream');
    undeclared.request('/control', { body: '\x1b' });
    assert.deepEqual(controlLines(undeclared.ttys[0], 0).filter((line) => line.__webchatControl || line.event), [
        { __webchatControl: 1, type: 'stop', sourceTabId: 'tab-a', sourcePageInstanceId: 'page-a' },
    ]);

    // A delegating agent whose configuration does not forward envelopes: the raw control passes through.
    const raw = server(t, { forwardEnvelope: false, protocol: false });
    raw.request('/stream');
    raw.request('/control', { body: '\x1b' });
    assert.equal(raw.ttys[0].input.at(-1), '\x1b');

    // Other control bodies are untouched on a delegating agent.
    srv.request('/control', { body: 'x' });
    assert.equal(tty.input.at(-1), 'x');
});

test('an unauthenticated stop is refused as before and never yields a signed envelope', (t) => {
    webchatWorld(t);
    // A per-user runtime refuses a request without a verified user.
    const scoped = server(t, { protocol: false });
    scoped.effectiveConfig.runtimeScope = 'principal';
    scoped.request('/stream', { user: USER_A });
    const tty = scoped.ttys[0];
    const before = tty.input.length;
    const refused = scoped.request('/control', { user: null, body: '\x1b' });
    assert.equal(refused.res.statusCode, 403);
    assert.equal(tty.input.length, before, 'nothing is written');

    // Without a user no token can be minted: the stop stays the unsigned control line, as today.
    const open = server(t, { protocol: false });
    open.request('/stream', { user: USER_A });
    open.request('/control', { user: null, body: '\x1b' });
    const lines = controlLines(open.ttys[0], 0).filter((line) => line.__webchatControl || line.event === WEBCHAT_STOP_EVENT);
    assert.deepEqual(lines, [{ __webchatControl: 1, type: 'stop', sourceTabId: 'tab-a', sourcePageInstanceId: 'page-a' }]);
});
