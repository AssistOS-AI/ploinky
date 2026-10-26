import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyEdgeRoutingGeneration, initializeFreshEdgeRoutingSources } from '../../cli/sandbox/edgeGeneration.js';
import { NETWORK_LABELS } from '../../cli/sandbox/networkLifecycle.js';
import { RelayRequestMinter } from '../../cli/server/runtimeRelay/relayRequestMinter.js';
import { RuntimeRelayManager } from '../../cli/server/runtimeRelay/RuntimeRelayManager.js';
import { agentPortPlan, resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import { buildHttpRouteAuthInfoHeader } from '../../cli/server/routerHandlers.js';
import {
    WebttyHomeProfileProvider,
    findHomeProfileProvider,
    homeProfileDeclaration,
    validateHomeProfileHome,
    validateHomeProfileRequest,
    validateHomeProfileResponse,
} from '../../cli/server/webtty/homeProfileProvider.mjs';
import { deriveAgentRequestSecret } from '../../cli/utils/security/masterKey.js';
import { verifyHttpRouteAuthInfoFromHeaders } from '../../Agent/lib/invocationAuth.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';

const resolvePath = (port) => `/base-agent-additional-server/keeper/${port}/api/profiles/resolve`;
const RESOLVE = resolvePath(7001);
const UPSTREAM_PATH = '/api/profiles/resolve';
const AGENT_ID = 'agent:fixtures/keeper';
const ADMIN = Object.freeze({ id: 'local:admin', username: 'admin', email: '', roles: ['admin'] });
const MEMBER = Object.freeze({ id: 'local:member', username: 'member', email: '', roles: ['user'] });
// The admitted WebTTY request: an SSO administrator, matching the provider's
// own route auth mode in the fixture.
const ADMIN_REQ = Object.freeze({ user: ADMIN, authMode: 'sso' });

function agentEnv(agentId = AGENT_ID) {
    return { PLOINKY_AGENT_ID: agentId, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(agentId) };
}

function keeperManifest({ webtty, routerAccess, port = 7001, access = 'authenticated', requiredCapability } = {}) {
    return {
        webtty: webtty === undefined ? { homeProfiles: { version: 1, resolve: resolvePath(port) } } : webtty,
        routerAccess: routerAccess === undefined
            ? {
                httpRoutes: [{ path: `/base-agent-additional-server/keeper/${port}/api/*`, access }],
                ...(requiredCapability ? { requiredCapability } : {}),
            }
            : routerAccess,
    };
}

// A real edge generation with one profile-providing agent, a real WebTTY
// route plan, and the provider's and a sibling agent's data directories.
function workspaceFixture(t, manifest = keeperManifest(), { auth = { mode: 'sso' } } = {}) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky webtty profiles '));
    const workspace = path.join(parent, 'work space');
    fs.mkdirSync(workspace);
    const previous = Object.fromEntries(['PLOINKY_WORKSPACE_ROOT', 'PLOINKY_MASTER_KEY']
        .map((key) => [key, process.env[key]]));
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(parent, { recursive: true, force: true });
    });
    initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    const agentPath = path.join(workspace, '.ploinky/repos/fixtures/keeper');
    fs.mkdirSync(agentPath, { recursive: true });
    const writeManifest = (value) => fs.writeFileSync(path.join(agentPath, 'manifest.json'), JSON.stringify(value));
    const writeRouting = (withKeeper = true) => {
        fs.writeFileSync(path.join(workspace, '.ploinky/routing.json'), JSON.stringify({ routes: withKeeper ? {
            keeper: { repo: 'fixtures', agent: 'keeper', container: 'keeper-container', hostPath: agentPath },
        } : {} }));
        fs.writeFileSync(path.join(workspace, '.ploinky/agents.json'), JSON.stringify(withKeeper ? { 'keeper-container': {
            type: 'agent', repoName: 'fixtures', agentName: 'keeper', runtime: 'podman',
            containerId: 'a'.repeat(64), instanceId: 'keeper-instance', enableGeneration: 'keeper-enable',
            auth,
        } } : {}));
    };
    writeManifest(manifest);
    writeRouting();
    const activate = () => applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'webtty-home-profile-unit' });
    activate();
    const data = path.join(workspace, '.data', 'keeper');
    fs.mkdirSync(path.join(data, 'profiles', 'p-1', 'home'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.data', 'other', 'secret'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'outside'), { recursive: true });
    return {
        workspace,
        data,
        activate,
        writeManifest,
        writeRouting,
        webttyPlan() {
            const plan = resolveEdgeRoutePlan({
                req: { method: 'POST', url: '/webtty/target-discoveries', headers: { host: '127.0.0.1:8080' } },
            });
            assert.equal(plan.ok, true, plan.code);
            assert.equal(plan.kind, 'router-surface');
            return plan;
        },
    };
}

// The closest in-process seam to the private relay: each opened request is a
// real TCP connection to a local HTTP server standing in for the agent.
class TcpRelayStream extends EventEmitter {
    constructor(port) {
        super();
        this.channel = { child: { stdin: new EventEmitter() } };
        this.terminal = false;
        this.cancelled = 0;
        this.socket = net.connect(port, '127.0.0.1');
        this.socket.on('data', (chunk) => this.emit('data', chunk));
        this.socket.on('end', () => { this.terminal = true; this.emit('end'); });
        this.socket.on('error', (error) => this.emit('error', error));
    }

    write(chunk) { return this.socket.write(chunk); }
    end() {}
    cancel() {
        this.cancelled += 1;
        this.terminal = true;
        this.socket.destroy();
    }
    abandon() { this.cancel(); }
}

function tcpRelayManager(port) {
    const manager = {
        checkouts: 0,
        closed: 0,
        opened: [],
        streams: [],
        async checkout({ lease, authorized }) {
            if (authorized !== true || lease.commit() !== true) {
                throw Object.assign(new Error('stale generation'), { code: 'EDGE_GENERATION_CHANGED' });
            }
            manager.checkouts += 1;
            return {
                async openRequest(options) {
                    manager.opened.push(options);
                    const stream = new TcpRelayStream(port);
                    manager.streams.push(stream);
                    return stream;
                },
                close() { manager.closed += 1; },
            };
        },
    };
    return manager;
}

// A stand-in provider agent that trusts only the verified signature: the
// administrator decision comes from the signed actor roles.
async function providerServer(t, behave = () => null) {
    const replayCache = createMemoryReplayCache();
    const received = [];
    const sockets = new Set();
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const url = new URL(req.url, 'http://agent.local');
        received.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
        const custom = await behave({ req, res, body });
        if (custom) return;
        const verified = verifyHttpRouteAuthInfoFromHeaders(req.headers, {
            env: agentEnv(), replayCache, method: req.method, path: url.pathname, query: url.search, body,
        });
        const roles = verified.ok ? verified.payload?.actor?.roles || [] : [];
        if (!verified.ok || !roles.includes('admin')) {
            res.writeHead(verified.ok ? 403 : 401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ allowed: false }));
            return;
        }
        const { id } = JSON.parse(body.toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ allowed: true, profile: { id, label: 'Profile One', home: `profiles/${id}/home` } }));
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
    }));
    return { port: server.address().port, received, sockets, replayCache };
}

// Deadline timers the provider set and has not cleared yet.
const pendingTimers = new Set();

function provider(fx, relayManager, limits = {}) {
    return new WebttyHomeProfileProvider({
        workspaceRoot: fx.workspace,
        relayManager,
        providerDataDirectory: (name) => path.join(fx.workspace, '.data', name),
        limits: { deadlineMs: 1_500, ...limits },
        setTimer: (callback, milliseconds) => {
            const handle = setTimeout(() => { pendingTimers.delete(handle); callback(); }, milliseconds);
            pendingTimers.add(handle);
            return handle;
        },
        clearTimer: (handle) => {
            pendingTimers.delete(handle);
            clearTimeout(handle);
        },
    });
}

async function refused(promise, category) {
    await assert.rejects(promise, (error) => {
        assert.equal(error.code, 'WEBTTY_PROFILE_UNAVAILABLE');
        if (category) assert.equal(error.category, category);
        return true;
    });
}

test('declarations name only the declaring agent\'s own canonical agent-port path', () => {
    assert.deepEqual(homeProfileDeclaration(keeperManifest(), 'keeper'), { version: 1, resolve: RESOLVE });
    for (const webtty of [
        undefined,
        null,
        { homeProfiles: { version: 2, resolve: RESOLVE } },
        { homeProfiles: { version: 1, resolve: RESOLVE, extra: true } },
        { homeProfiles: { version: 1 } },
        { homeProfiles: { version: 1, resolve: '/keeper/api/profiles/resolve' } },
        { homeProfiles: { version: 1, resolve: '/base-agent-additional-server/other/7001/api/resolve' } },
        { homeProfiles: { version: 1, resolve: `${RESOLVE}?x=1` } },
        { homeProfiles: { version: 1, resolve: `${RESOLVE}/` } },
        { homeProfiles: { version: 1, resolve: '/base-agent-additional-server/keeper/7001/api/%2e%2e/x' } },
        { homeProfiles: { version: 1, resolve: '/base-agent-additional-server/keeper/7001/api/../x' } },
        { homeProfiles: { version: 1, resolve: '/base-agent-additional-server/keeper/7001' } },
        { homeProfiles: { version: 1, resolve: 'https://example.test/base-agent-additional-server/keeper/7001/x' } },
    ]) {
        const manifest = webtty === undefined ? {} : { webtty };
        assert.equal(homeProfileDeclaration(manifest, 'keeper'), null, JSON.stringify(webtty));
    }
});

test('a provider name must select exactly one enabled agent with a valid declaration', () => {
    const record = (repoName, containerId) => ({
        type: 'agent', repoName, agentName: 'keeper', containerId, instanceId: `${repoName}-i`, enableGeneration: `${repoName}-g`,
    });
    const snapshot = (routes, agents, manifests) => ({ routing: { routes }, agents, manifests });
    const one = snapshot(
        { keeper: { repo: 'fixtures', agent: 'keeper', container: 'c1' } },
        { c1: record('fixtures', 'a'.repeat(64)) },
        { keeper: keeperManifest() },
    );
    assert.equal(findHomeProfileProvider(one, 'keeper').routeKey, 'keeper');
    assert.equal(findHomeProfileProvider(one, 'other'), null);
    // A second enabled agent with the same name and its own valid declaration.
    const ambiguous = snapshot(
        {
            keeper: { repo: 'fixtures', agent: 'keeper', container: 'c1' },
            keeper2: { repo: 'second', agent: 'keeper', container: 'c2' },
        },
        { c1: record('fixtures', 'a'.repeat(64)), c2: record('second', 'b'.repeat(64)) },
        {
            keeper: keeperManifest(),
            keeper2: keeperManifest({ webtty: { homeProfiles: {
                version: 1, resolve: '/base-agent-additional-server/keeper2/7001/api/profiles/resolve',
            } } }),
        },
    );
    assert.equal(findHomeProfileProvider(ambiguous, 'keeper'), null);
    for (const route of [{ disabled: true }, { draining: true }]) {
        const inactive = snapshot(
            { keeper: { repo: 'fixtures', agent: 'keeper', container: 'c1', ...route } },
            { c1: record('fixtures', 'a'.repeat(64)) },
            { keeper: keeperManifest() },
        );
        assert.equal(findHomeProfileProvider(inactive, 'keeper'), null);
    }
});

test('request, home and response shapes are exact', () => {
    assert.deepEqual(validateHomeProfileRequest({ provider: 'keeper', id: 'p-1' }), { provider: 'keeper', id: 'p-1' });
    for (const value of [
        null, {}, { provider: 'keeper' }, { provider: 'keeper', id: 'p-1', home: '/x' },
        { provider: '../x', id: 'p-1' }, { provider: 'keeper', id: '-p' }, { provider: 'keeper', id: 'a'.repeat(129) },
        { provider: 'keeper', id: 'p/1' }, { provider: 'keeper', id: 7 },
    ]) assert.equal(validateHomeProfileRequest(value), null, JSON.stringify(value));
    assert.equal(validateHomeProfileHome('profiles/p-1/home'), 'profiles/p-1/home');
    for (const home of ['', '/abs/home', '../other', 'profiles/../../x', 'profiles/./home', 'profiles//home',
        'profiles/home/', 'profiles\\home', 'profiles%2F..%2Fx', 'profiles/%2e%2e', 'line\nbreak', 7]) {
        assert.equal(validateHomeProfileHome(home), null, JSON.stringify(home));
    }
    const ok = (value) => Buffer.from(JSON.stringify(value));
    const good = { allowed: true, profile: { id: 'p-1', label: 'Profile One', home: 'profiles/p-1/home' } };
    assert.deepEqual(validateHomeProfileResponse(200, ok(good), 'p-1'), good.profile);
    for (const [status, body] of [
        [201, ok(good)],
        [302, ok(good)],
        [200, ok({ allowed: false })],
        [200, ok({ ...good, extra: 1 })],
        [200, ok({ allowed: true, profile: { ...good.profile, extra: 1 } })],
        [200, ok({ allowed: true, profile: { ...good.profile, id: 'p-2' } })],
        [200, ok({ allowed: 'true', profile: good.profile })],
        [200, ok({ allowed: true, profile: { ...good.profile, label: '' } })],
        [200, ok({ allowed: true, profile: { ...good.profile, label: 'bad\u0007label' } })],
        [200, ok({ allowed: true, profile: { ...good.profile, label: 'x'.repeat(129) } })],
        [200, Buffer.from('not json')],
        [200, ok([good])],
    ]) assert.equal(validateHomeProfileResponse(status, body, 'p-1'), null, `${status} ${body}`);
});

test('real hop: a signed administrator resolves a confined home over the relay seam', async (t) => {
    const fx = workspaceFixture(t);
    const server = await providerServer(t);
    const relay = tcpRelayManager(server.port);
    const resolved = await provider(fx, relay).resolve({
        req: {
            ...ADMIN_REQ, sessionId: 'browser-session-token', headers: { cookie: 'ploinky_jwt=browser-cookie' },
        },
        routePlan: fx.webttyPlan(),
        profile: { provider: 'keeper', id: 'p-1' },
    });
    const home = fs.realpathSync(path.join(fx.data, 'profiles', 'p-1', 'home'));
    const stat = fs.statSync(home, { bigint: true });
    assert.deepEqual(resolved, {
        profile: { provider: 'keeper', id: 'p-1', label: 'Profile One' },
        home: {
            relativePath: path.relative(fs.realpathSync(fx.workspace), home).split(path.sep).join('/'),
            absolutePath: home,
            identity: { dev: String(stat.dev), ino: String(stat.ino) },
        },
    });
    assert.equal(resolved.home.relativePath, '.data/keeper/profiles/p-1/home');
    // Exactly one signed POST of the exact body to the real upstream path.
    assert.equal(server.received.length, 1);
    const [request] = server.received;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, UPSTREAM_PATH);
    assert.equal(request.body.toString('utf8'), '{"version":1,"id":"p-1"}');
    assert.equal(relay.opened[0].bodyMode, 'buffered');
    assert.equal(relay.opened[0].bodyHash, sha256RawBodyHash(request.body));
    assert.equal(relay.opened[0].plan.targetPath, UPSTREAM_PATH);
    assert.equal(relay.opened[0].plan.query, '');
    // No browser cookie, session token or plain identity header is forwarded.
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['x-ploinky-user-id'], undefined);
    assert.doesNotMatch(JSON.stringify(request.headers), /browser-session-token|browser-cookie/);
    const authInfo = JSON.parse(request.headers['x-ploinky-auth-info']);
    assert.equal(authInfo.invocationBody.path, UPSTREAM_PATH);
    assert.equal(authInfo.invocationBody.search, '');
    assert.equal(authInfo.invocationBody.method, 'POST');
    // Channel, request and agent are released after the exchange.
    assert.equal(relay.checkouts, 1);
    assert.equal(relay.closed, 1);
    assert.equal(relay.streams[0].socket.destroyed, true);

    // The captured signature is accepted only for its exact surface.
    const verify = (headers, overrides = {}) => verifyHttpRouteAuthInfoFromHeaders(headers, {
        env: agentEnv(), replayCache: createMemoryReplayCache(), method: 'POST',
        path: UPSTREAM_PATH, query: '', body: request.body, ...overrides,
    });
    assert.equal(verify(request.headers).ok, true);
    assert.match(verify(request.headers, { path: '/api/profiles/other' }).reason, /path mismatch/);
    assert.match(verify(request.headers, { body: Buffer.from('{"version":1,"id":"p-2"}') }).reason, /body hash mismatch/);
    assert.match(verify(request.headers, { query: '?id=p-1' }).reason, /query mismatch/);
    assert.match(verify(request.headers, { method: 'GET' }).reason, /method mismatch/);
    assert.equal(verify(request.headers, { env: agentEnv('agent:fixtures/other') }).ok, false);
    const replayCache = createMemoryReplayCache();
    assert.equal(verify(request.headers, { replayCache }).ok, true);
    assert.equal(verify(request.headers, { replayCache }).ok, false);
    // Unsigned and internal-token-only requests carry no verifiable identity.
    assert.equal(verify({ 'x-ploinky-auth-info': JSON.stringify({ user: ADMIN }) }).ok, false);
    assert.equal(verify({ authorization: `Bearer ${authInfo.invocationToken}` }).ok, false);
    assert.equal(verify({ 'x-ploinky-internal-token': 'internal' }).ok, false);
});

test('real hop: forged compatibility roles and unsigned requests are refused by the verifying agent', async (t) => {
    const fx = workspaceFixture(t);
    const server = await providerServer(t);
    const routePlan = fx.webttyPlan();
    const plan = agentPortPlan({
        req: { method: 'POST', url: RESOLVE, headers: {} },
        host: routePlan.host,
        listener: routePlan.listener,
        parsedUrl: new URL(RESOLVE, 'http://localhost'),
        hostSelection: routePlan.hostSelection,
        routes: routePlan.snapshot.routing.routes,
        snapshot: routePlan.snapshot,
        lease: routePlan.lease,
        requestTarget: RESOLVE,
    });
    assert.equal(plan.ok, true, plan.code);
    const body = Buffer.from('{"version":1,"id":"p-1"}');
    const send = (headers) => new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1', port: server.port, method: 'POST', path: UPSTREAM_PATH,
            headers: { 'content-type': 'application/json', 'content-length': body.length, ...headers },
        }, (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
        request.end(body);
    });
    const signedMember = JSON.parse(buildHttpRouteAuthInfoHeader(
        { method: 'POST', user: MEMBER }, plan.parsedUrl, plan.authDefinition,
        { bodyHash: sha256RawBodyHash(body), routePath: plan.unmatchedSuffix },
    )['x-ploinky-auth-info']);
    // The unsigned compatibility user claims administrator; the signed actor does not.
    signedMember.user.roles = ['admin'];
    assert.equal(await send({ 'x-ploinky-auth-info': JSON.stringify(signedMember) }), 403);
    assert.equal(await send({ 'x-ploinky-auth-info': JSON.stringify({ user: ADMIN }) }), 401);
    assert.equal(await send({ 'x-ploinky-internal-token': 'internal-only' }), 401);
    assert.equal(await send({}), 401);
});

test('real hop: a generation that is stale before or replaced during resolution is refused', async (t) => {
    const fx = workspaceFixture(t);
    let regenerate = null;
    const server = await providerServer(t, async () => { regenerate?.(); return null; });
    const relay = tcpRelayManager(server.port);
    const stalePlan = fx.webttyPlan();
    fx.activate();
    await refused(provider(fx, relay).resolve({
        req: ADMIN_REQ, routePlan: stalePlan, profile: { provider: 'keeper', id: 'p-1' },
    }), 'generation');
    assert.equal(server.received.length, 0);
    assert.equal(relay.checkouts, 0);

    // Regenerated (same sources) and removed (provider gone) while the
    // provider was answering.
    for (const change of [() => fx.activate(), () => { fx.writeRouting(false); fx.activate(); }]) {
        fx.writeRouting(true);
        fx.activate();
        regenerate = () => { regenerate = null; change(); };
        await refused(provider(fx, relay).resolve({
            req: ADMIN_REQ, routePlan: fx.webttyPlan(), profile: { provider: 'keeper', id: 'p-1' },
        }), 'generation');
    }
    assert.equal(relay.closed, relay.checkouts);
});

test('timeouts, oversize and malformed answers refuse and release the relay and timers', async (t) => {
    const fx = workspaceFixture(t);
    let mode = '';
    const server = await providerServer(t, ({ res }) => {
        if (mode === 'slow') return true;
        if (mode === 'oversize') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ allowed: true, pad: 'x'.repeat(20 * 1024) }));
            return true;
        }
        if (mode === 'oversize-chunked') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('{"allowed":true,"pad":"');
            res.write('x'.repeat(20 * 1024));
            return true;
        }
        if (mode === 'malformed') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"allowed": tru');
            return true;
        }
        if (mode === 'non-200') {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ allowed: true, profile: { id: 'p-1', label: 'x', home: 'profiles/p-1/home' } }));
            return true;
        }
        if (mode === 'redirect') {
            res.writeHead(307, { location: 'http://127.0.0.1:1/elsewhere' });
            res.end();
            return true;
        }
        if (mode === 'refused') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ allowed: false }));
            return true;
        }
        if (mode === 'mismatch') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ allowed: true, profile: { id: 'p-2', label: 'x', home: 'profiles/p-1/home' } }));
            return true;
        }
        return null;
    });
    for (const [selected, category] of [
        ['slow', 'timeout'], ['oversize', 'oversize'], ['oversize-chunked', 'oversize'], ['malformed', 'response'],
        ['non-200', 'response'], ['redirect', 'response'], ['refused', 'response'], ['mismatch', 'response'],
    ]) {
        mode = selected;
        const relay = tcpRelayManager(server.port);
        const started = Date.now();
        await refused(provider(fx, relay, { deadlineMs: 250 }).resolve({
            req: ADMIN_REQ, routePlan: fx.webttyPlan(), profile: { provider: 'keeper', id: 'p-1' },
        }), category);
        assert.ok(Date.now() - started < 1_000, selected);
        assert.equal(relay.checkouts, 1, selected);
        assert.equal(relay.closed, 1, selected);
        assert.equal(relay.streams.length, 1, selected);
        assert.equal(relay.streams[0].socket.destroyed, true, selected);
        // The provider's deadline timer is cleared on every refusal path.
        assert.equal(pendingTimers.size, 0, selected);
    }
    mode = '';
    const relay = tcpRelayManager(server.port);
    await provider(fx, relay).resolve({
        req: ADMIN_REQ, routePlan: fx.webttyPlan(), profile: { provider: 'keeper', id: 'p-1' },
    });
    assert.equal(relay.closed, 1);
    assert.equal(pendingTimers.size, 0);
});

test('route-policy deny, relay opt-out, public access and non-administrators never reach the relay', async (t) => {
    const cases = [
        ['opt-out', keeperManifest({ routerAccess: { agentPorts: false } })],
        // The route policy denies a write to a public route (PUBLIC_ROUTE_WRITE_DENIED).
        ['public write denied', keeperManifest({ routerAccess: { httpRoutes: [
            { path: '/base-agent-additional-server/keeper/7001/api/*', access: 'public' },
        ] } })],
    ];
    for (const [name, manifest] of cases) {
        const fx = workspaceFixture(t, manifest);
        const relay = tcpRelayManager(1);
        await refused(provider(fx, relay).resolve({
            req: ADMIN_REQ, routePlan: fx.webttyPlan(), profile: { provider: 'keeper', id: 'p-1' },
        }), 'route');
        assert.equal(relay.checkouts, 0, name);
    }
    const fx = workspaceFixture(t);
    const relay = tcpRelayManager(1);
    const denied = new WebttyHomeProfileProvider({
        workspaceRoot: fx.workspace,
        relayManager: relay,
        planAgentPort: () => ({ matched: true, ok: false, status: 403, code: 'HTTP_ROUTE_ACCESS_DENIED' }),
    });
    await refused(denied.resolve({
        req: ADMIN_REQ, routePlan: fx.webttyPlan(), profile: { provider: 'keeper', id: 'p-1' },
    }), 'route');
    for (const user of [null, MEMBER, { ...ADMIN, roles: ['admin', 'guest'] }]) {
        await refused(provider(fx, relay).resolve({
            req: { user }, routePlan: fx.webttyPlan(), profile: { provider: 'keeper', id: 'p-1' },
        }), 'administrator');
    }
    await refused(provider(fx, relay).resolve({
        req: ADMIN_REQ, routePlan: fx.webttyPlan(), profile: { provider: 'missing', id: 'p-1' },
    }), 'provider');
    assert.equal(relay.checkouts, 0);
});

test('a returned home must stay strictly inside the provider data directory', async (t) => {
    const fx = workspaceFixture(t);
    fs.symlinkSync(path.join(fx.workspace, 'outside'), path.join(fx.data, 'profiles', 'link-out'));
    fs.symlinkSync(path.join(fx.workspace, '.data', 'other', 'secret'), path.join(fx.data, 'profiles', 'link-sibling'));
    fs.symlinkSync(path.join(fx.data, 'profiles', 'p-1', 'home'), path.join(fx.data, 'profiles', 'link-in'));
    fs.writeFileSync(path.join(fx.data, 'profiles', 'file'), 'not a directory');
    let home = '';
    const server = await providerServer(t, ({ res, body }) => {
        const { id } = JSON.parse(body.toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ allowed: true, profile: { id, label: 'Profile One', home } }));
        return true;
    });
    const resolve = () => provider(fx, tcpRelayManager(server.port)).resolve({
        req: ADMIN_REQ, routePlan: fx.webttyPlan(), profile: { provider: 'keeper', id: 'p-1' },
    });
    for (const escaping of [
        '../other/secret', '/etc', `${fx.data}/profiles/p-1/home`, 'profiles%2Fp-1%2Fhome', 'profiles/../../other/secret',
        'profiles/link-out', 'profiles/link-sibling', 'profiles/file', 'profiles/missing', 'profiles\\p-1',
        'profiles//p-1/home',
    ]) {
        home = escaping;
        await refused(resolve(), 'home');
    }
    home = 'profiles/link-in';
    const resolved = await resolve();
    assert.equal(resolved.home.absolutePath, fs.realpathSync(path.join(fx.data, 'profiles', 'p-1', 'home')));
    assert.equal(resolved.home.relativePath, '.data/keeper/profiles/p-1/home');
});

test('a route that would not sign, or a signature without an invocation token, never reaches the relay', async (t) => {
    const fx = workspaceFixture(t);
    const relay = tcpRelayManager(1);
    const unsignedRoute = new WebttyHomeProfileProvider({
        workspaceRoot: fx.workspace,
        relayManager: relay,
        planAgentPort: (args) => {
            const plan = agentPortPlan(args);
            return { ...plan, authDefinition: { ...plan.authDefinition, issueInvocation: false } };
        },
    });
    await refused(unsignedRoute.resolve({
        req: ADMIN_REQ, routePlan: fx.webttyPlan(), profile: { provider: 'keeper', id: 'p-1' },
    }), 'route');
    for (const signRouteRequest of [
        () => ({}),
        () => ({ 'x-ploinky-auth-info': JSON.stringify({ user: ADMIN, sessionId: '' }) }),
        () => ({ 'x-ploinky-auth-info': 'not json' }),
        () => { throw new Error('signing failed'); },
    ]) {
        const unsigned = new WebttyHomeProfileProvider({
            workspaceRoot: fx.workspace,
            relayManager: relay,
            signRouteRequest,
        });
        await refused(unsigned.resolve({
            req: ADMIN_REQ, routePlan: fx.webttyPlan(), profile: { provider: 'keeper', id: 'p-1' },
        }), 'signature');
    }
    assert.equal(relay.checkouts, 0);
});

async function refusedBeforeRelay(fx, req, server) {
    const relay = tcpRelayManager(server.port);
    await refused(provider(fx, relay).resolve({
        req, routePlan: fx.webttyPlan(), profile: { provider: 'keeper', id: 'p-1' },
    }), 'route');
    assert.equal(relay.checkouts, 0);
    assert.equal(server.received.length, 0);
}

test('a provider route capability the administrator lacks is refused before signing', async (t) => {
    const server = await providerServer(t);
    const fx = workspaceFixture(t, keeperManifest({ requiredCapability: 'keeper.access' }));
    await refusedBeforeRelay(fx, ADMIN_REQ, server);
    await refusedBeforeRelay(fx, { user: { ...ADMIN, capabilities: ['other.access'] }, authMode: 'sso' }, server);
    // With the capability the same administrator resolves, exactly as a
    // browser request to that route would be admitted.
    const relay = tcpRelayManager(server.port);
    const resolved = await provider(fx, relay).resolve({
        req: { user: { ...ADMIN, capabilities: ['keeper.access'] }, authMode: 'sso' },
        routePlan: fx.webttyPlan(),
        profile: { provider: 'keeper', id: 'p-1' },
    });
    assert.equal(resolved.profile.id, 'p-1');
    assert.equal(relay.checkouts, 1);
});

test('a provider route whose owner has no user authentication is refused before signing', async (t) => {
    const server = await providerServer(t);
    const fx = workspaceFixture(t, keeperManifest(), { auth: { mode: 'none' } });
    await refusedBeforeRelay(fx, ADMIN_REQ, server);
});

test('a guest provider route is refused before signing an administrator identity', async (t) => {
    const server = await providerServer(t);
    const fx = workspaceFixture(t, keeperManifest({ access: 'guest' }));
    await refusedBeforeRelay(fx, ADMIN_REQ, server);
});

test('an administrator session of another auth mode than the provider route is refused before signing', async (t) => {
    const server = await providerServer(t);
    const fx = workspaceFixture(t);
    for (const req of [
        { user: ADMIN },
        { user: ADMIN, authMode: 'local' },
        { user: ADMIN, authMode: 'guest' },
        { user: ADMIN, authMode: 'local', authChannel: 'browser' },
    ]) await refusedBeforeRelay(fx, req, server);
});

// The real Router-side relay manager and the real in-container relay helper,
// spawned over stdio exactly as the readiness and relay tests do; only the
// container inspection and socket resolution are fixed.
function realRelayManager() {
    let nonce = 0;
    return new RuntimeRelayManager({
        minter: new RelayRequestMinter({
            resolveAgentSecret: () => assert.fail('the resolve relay must use its fresh channel key'),
            createNonce: () => `home-profile-${++nonce}`,
        }),
        inspectContainer: async () => ({
            Id: 'a'.repeat(64),
            Name: '/keeper-container',
            State: { Running: true },
            HostConfig: { NetworkMode: 'bridge' },
            Config: {
                Labels: {
                    [NETWORK_LABELS.managed]: '1',
                    [NETWORK_LABELS.resource]: 'agent',
                    [NETWORK_LABELS.instanceId]: 'keeper-instance',
                    [NETWORK_LABELS.enableGeneration]: 'keeper-enable',
                },
            },
        }),
        resolveSocket: () => ({ path: '/test/runtime-relay.sock' }),
        openTransport: async () => spawn(process.execPath, [
            fileURLToPath(new URL('../../Agent/server/RuntimeHttpRelay.mjs', import.meta.url)),
            'stdio',
        ], {
            env: { PATH: process.env.PATH || '', PLOINKY_AGENT_ID: AGENT_ID },
            stdio: ['pipe', 'pipe', 'pipe'],
        }),
        channelIdleTimeoutMs: 5_000,
    });
}

test('real relay: the signed resolve crosses the real relay manager and helper and releases every stream', async (t) => {
    let mode = '';
    const server = await providerServer(t, ({ res }) => {
        if (mode === 'slow') return true;
        if (mode === 'oversize') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ allowed: true, pad: 'x'.repeat(20 * 1024) }));
            return true;
        }
        return null;
    });
    const fx = workspaceFixture(t, keeperManifest({ port: server.port }));
    const manager = realRelayManager();
    t.after(() => manager.close());
    const resolve = (limits) => new WebttyHomeProfileProvider({
        workspaceRoot: fx.workspace,
        relayManager: manager,
        providerDataDirectory: (name) => path.join(fx.workspace, '.data', name),
        limits,
    }).resolve({ req: ADMIN_REQ, routePlan: fx.webttyPlan(), profile: { provider: 'keeper', id: 'p-1' } });

    const resolved = await resolve({ deadlineMs: 2_000 });
    assert.equal(resolved.home.relativePath, '.data/keeper/profiles/p-1/home');
    assert.equal(server.received.length, 1);
    assert.equal(server.received[0].url, UPSTREAM_PATH);
    assert.equal(server.received[0].body.toString('utf8'), '{"version":1,"id":"p-1"}');
    assert.equal(manager.totalActive, 0);
    assert.equal(manager.agentActive.size, 0);

    for (const [selected, category] of [['slow', 'timeout'], ['oversize', 'oversize']]) {
        mode = selected;
        await refused(resolve({ deadlineMs: 400 }), category);
        assert.equal(manager.totalActive, 0, selected);
        assert.equal(manager.agentActive.size, 0, selected);
    }
    assert.equal(server.received.length, 3);
});
