import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// WebChat page and runtime requests launch exactly the target admitted by the
// Router's authorization snapshot. These cases drive the real auth entrypoint
// and then the real WebChat handler, as the Router does.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-binding-')));
fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
fs.mkdirSync(path.join(root, 'project'));
const previous = {
    cwd: process.cwd(),
    root: process.env.PLOINKY_WORKSPACE_ROOT,
    key: process.env.PLOINKY_MASTER_KEY,
};
process.chdir(root);
process.env.PLOINKY_WORKSPACE_ROOT = root;
process.env.PLOINKY_MASTER_KEY = '9'.repeat(64);
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';

const { applyEdgeRoutingGeneration, loadActiveEdgeRoutingGeneration } = await import('../../cli/sandbox/edgeGeneration.js');
const { ensureAuthenticated } = await import('../../cli/server/authHandlers/authContext.js');
const { authService } = await import('../../cli/server/authHandlers/shared.js');
const { verifyBrowserMutationRequest } = await import('../../cli/server/browserMutationSecurity.js');
const { handleWebChat } = await import('../../cli/server/handlers/webchat/index.js');
const { handleRuntimeRoute } = await import('../../cli/server/handlers/webchat/runtimeRoutes.js');
const runtimeState = await import('../../cli/server/handlers/webchat/runtimeState.js');
const { DIRECT_CLI_PATH } = await import('../../cli/utils/directCli.js');

test.after(() => {
    process.chdir(previous.cwd);
    for (const [name, value] of [['PLOINKY_WORKSPACE_ROOT', previous.root], ['PLOINKY_MASTER_KEY', previous.key]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
});

const HOST = 'root.example.test';
const GUEST_HOST = 'guest.example.test';
const INHERIT_HOST = 'inherit.example.test';
const AGENTS = {
    explorer: { mode: 'sso', manifest: { routerAccess: { requiredCapability: 'explorer.access' } } },
    hostRoot: { mode: 'sso', manifest: { enable: ['dependency', 'guestDependency', 'selfDependency'], routerAccess: { requiredCapability: 'root.access' } } },
    inheritRoot: { mode: 'none', manifest: { enable: ['selfDependency'], routerAccess: { requiredCapability: 'root.access' } } },
    dependency: { mode: 'sso', manifest: { webchat: { auth: 'static' } } },
    selfDependency: { mode: 'sso', manifest: { webchat: { auth: 'self' }, routerAccess: { requiredCapability: 'dep.access' } } },
    outsider: { mode: 'sso', manifest: { webchat: { auth: 'self' } } },
    outsiderStatic: { mode: 'sso', manifest: { webchat: { auth: 'static' } } },
    guestOwner: { mode: 'guest', manifest: { webchat: { auth: 'self' } }, alias: 'guest-owner-alias' },
    guestOther: { mode: 'guest', manifest: {}, alias: 'guest-other-alias' },
    guestStatic: { mode: 'guest', manifest: { webchat: { auth: 'static' } } },
    guestDependency: { mode: 'guest', manifest: { webchat: { auth: 'self' } } },
    guestRoot: { mode: 'guest', manifest: { webchat: { auth: 'self' } } },
};

const SSO_USERS = {
    'sso-all': ['explorer.access', 'root.access', 'dep.access'],
    'sso-dep-only': ['dep.access'],
    'sso-dep-explorer': ['dep.access', 'explorer.access'],
    'sso-explorer': ['explorer.access'],
};

// Builds the workspace sources, applies a real edge generation from them and
// returns the generation as the Router loads it, so every host-scope case runs
// on a reconstructable snapshot (WebChat targets are derived from it).
function writeWorkspace({ staticAgent = 'explorer', mutateDisk = null, webchatHosts = [HOST, GUEST_HOST, INHERIT_HOST] } = {}) {
    const routes = {};
    const agents = {};
    Object.entries(AGENTS).forEach(([name, spec], index) => {
        const hostPath = path.join(root, 'agent-src', name);
        fs.mkdirSync(hostPath, { recursive: true });
        const manifest = { cli: `${name}-cli`, ...spec.manifest };
        fs.writeFileSync(path.join(hostPath, 'manifest.json'), JSON.stringify(manifest));
        routes[name] = {
            container: `ctr_${name}`,
            hostPath,
            repo: 'fixtures',
            agent: name,
            hostPort: 41000 + index,
            ...(spec.alias ? { alias: spec.alias } : {}),
        };
        agents[`ctr_${name}`] = {
            type: 'agent',
            agentName: name,
            repoName: 'fixtures',
            instanceId: `${name}-instance`,
            enableGeneration: `${name}-enable-generation`,
            ...(spec.alias ? { alias: spec.alias } : {}),
            auth: { mode: spec.mode },
        };
    });
    const routing = { routes, static: { agent: staticAgent, hostPath: routes[staticAgent].hostPath } };
    const hostRoots = { [HOST]: 'hostRoot', [GUEST_HOST]: 'guestRoot', [INHERIT_HOST]: 'inheritRoot' };
    const desired = {
        hosts: Object.fromEntries(Object.entries(hostRoots).map(([host, routeKey]) => [host, {
            agent: `fixtures/${routeKey}`,
            routerSurfaces: webchatHosts.includes(host) ? ['webchat'] : [],
        }])),
        cloudflare: { tunnelTokenSecret: 'publication/test-connector' },
    };
    const edgeDir = path.join(root, '.ploinky', 'data', 'edge-routing');
    const policyDir = path.join(root, '.ploinky', 'data', 'router-security');
    fs.rmSync(edgeDir, { recursive: true, force: true });
    fs.mkdirSync(edgeDir, { recursive: true });
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(path.join(edgeDir, 'desired.json'), JSON.stringify(desired, null, 2));
    fs.writeFileSync(path.join(policyDir, 'policy-state.json'), JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }, null, 2));
    fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), JSON.stringify(routing, null, 2));
    fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify(agents, null, 2));
    applyEdgeRoutingGeneration({ workspaceRoot: root, reason: 'webchat-binding-fixture', publicationState: 'ready' });
    const snapshot = loadActiveEdgeRoutingGeneration({ workspaceRoot: root }).generation;
    if (mutateDisk) {
        const disk = structuredClone(routing);
        mutateDisk(disk);
        fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), JSON.stringify(disk, null, 2));
    }
    return snapshot;
}

function lease(snapshot, commit = () => true) {
    return { id: snapshot.generation, snapshot, commit };
}

function controlPlan(snapshot) {
    return {
        ok: false,
        code: 'ROUTE_NOT_FOUND',
        hostSelection: { kind: 'control', host: '127.0.0.1' },
        lease: lease(snapshot),
        snapshot,
    };
}

function hostPlan(snapshot, host = HOST, rootRouteKey = 'hostRoot') {
    return {
        ok: true,
        kind: 'router-surface',
        surface: 'webchat',
        listener: 'public',
        host,
        hostSelection: { kind: 'agent-root', host, record: { routeKey: rootRouteKey } },
        forwarding: { protocol: 'http', authority: host },
        lease: lease(snapshot),
        snapshot,
    };
}

function mockSso(t) {
    const sessions = Object.fromEntries(Object.entries(SSO_USERS).map(([token, capabilities]) => [token, {
        user: { id: `user:${token}`, username: token, roles: ['user'], capabilities },
        expiresAt: Date.now() + 60_000,
    }]));
    t.mock.method(authService, 'isConfigured', () => true);
    t.mock.method(authService, 'validateSession', async (token) => sessions[token] || null);
    t.mock.method(authService, 'getSession', (token) => sessions[token] || null);
    t.mock.method(authService, 'refreshSession', async () => {});
}

function makeReq(url, { method = 'GET', cookie = '', host = '127.0.0.1', accept = 'application/json', body } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    req.url = url;
    req.method = method;
    req.headers = { host, accept, ...(cookie ? { cookie } : {}) };
    req.socket = {};
    return req;
}

function makeRes() {
    const headers = new Map();
    return {
        statusCode: 0,
        body: '',
        headers,
        ended: false,
        setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
        getHeader(name) { return headers.get(String(name).toLowerCase()); },
        writeHead(status, values = {}) {
            this.statusCode = status;
            for (const [name, value] of Object.entries(values || {})) this.setHeader(name, value);
        },
        write(chunk) { this.body += String(chunk || ''); return true; },
        end(chunk = '') { this.body += String(chunk || ''); this.ended = true; },
    };
}

function guestCookieFrom(res) {
    const values = [res.getHeader('set-cookie')].flat().filter(Boolean).map(String);
    const match = values.map((value) => /^ploinky_guest=([^;]+)/.exec(value)).find(Boolean);
    return match ? `ploinky_guest=${match[1]}` : '';
}

function fakeTty(label) {
    let output = null;
    return {
        label,
        writes: [],
        isAlive: () => true,
        write(data) { this.writes.push(String(data)); return true; },
        onOutput(callback) { output = callback; },
        emit(text) { output?.(text); },
        onClose() {},
        onStartupState() {},
        dispose() {},
    };
}

function spyAppConfig(staticLabel) {
    const created = [];
    const resolved = [];
    const factory = (label, commands) => ({
        create(user) {
            const tty = fakeTty(label);
            created.push({ label, commands, user, tty });
            return tty;
        },
    });
    const appConfig = {
        agentName: staticLabel,
        runtime: 'local',
        ttyFactory: factory(staticLabel, null),
        getFactoryForCommands(commands) {
            resolved.push(commands);
            return {
                agentName: commands.agentName,
                displayName: commands.agentName,
                runtime: 'local',
                ttyFactory: factory(commands.agentName, commands),
            };
        },
    };
    return { appConfig, created, resolved };
}

async function settle(res) {
    for (let attempt = 0; attempt < 50 && !res.statusCode; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

async function authenticate(url, { plan, cookie = '', method = 'GET', host, accept, body } = {}) {
    const req = makeReq(url, {
        method,
        cookie,
        host: host || plan?.host || '127.0.0.1',
        accept,
        body,
    });
    const res = makeRes();
    const result = await ensureAuthenticated(req, res, new URL(url, `http://${req.headers.host}`), { routePlan: plan });
    return { req, res, result };
}

async function chain(url, { plan, cookie = '', method = 'GET', body, appConfig, appState, accept } = {}) {
    const auth = await authenticate(url, { plan, cookie, method, body, accept });
    if (!auth.result.ok) return { ...auth, handled: null };
    const handled = makeRes();
    await handleWebChat(auth.req, handled, appConfig, appState);
    await settle(handled);
    return { ...auth, handled };
}

function newState() {
    return { sessions: new Map(), runtimes: new Map() };
}

test('H1 host-bound WebChat binds no selector to the host root, not the static agent', async (t) => {
    mockSso(t);
    const snapshot = writeWorkspace();
    const { appConfig, created } = spyAppConfig('explorer');
    const appState = newState();
    for (const [url, target] of [
        ['/webchat/', 'hostRoot'],
        ['/webchat/?agent=hostRoot', 'hostRoot'],
        ['/webchat/?agent=dependency', 'dependency'],
    ]) {
        const { req, result } = await authenticate(url, { plan: hostPlan(snapshot), cookie: 'ploinky_sso=sso-all' });
        assert.equal(result.ok, true, url);
        assert.equal(req.edgeAuthContext.boundHostRouteKey, 'hostRoot', url);
        assert.equal(req.edgeAuthContext.webchatBinding?.target, target, url);
        assert.equal(req.edgeAuthContext.webchatBinding?.ownerRouteKey, 'hostRoot', url);
        assert.equal(req.edgeAuthContext.webchatBinding?.scope, 'host', url);
    }
    const page = await chain('/webchat/', { plan: hostPlan(snapshot), cookie: 'ploinky_sso=sso-all', appConfig, appState });
    assert.equal(page.handled.statusCode, 200);
    assert.match(page.handled.body, /data-agent="hostRoot"/);
    const stream = await chain('/webchat/stream?tabId=t1&pageInstanceId=p1', {
        plan: hostPlan(snapshot), cookie: 'ploinky_sso=sso-all', appConfig, appState,
    });
    assert.equal(stream.handled.statusCode, 200);
    assert.deepEqual(created.map((entry) => entry.label), ['hostRoot']);
    assert.equal(created[0].commands.host, `'${DIRECT_CLI_PATH}' cli hostRoot`);
    const dependency = await chain('/webchat/stream?agent=dependency&tabId=t2&pageInstanceId=p2', {
        plan: hostPlan(snapshot), cookie: 'ploinky_sso=sso-all', appConfig, appState,
    });
    assert.equal(dependency.handled.statusCode, 200);
    assert.deepEqual(created.map((entry) => entry.label), ['hostRoot', 'dependency']);
});

test('H2 a selector outside the host closure is unavailable before authentication', async (t) => {
    mockSso(t);
    const snapshot = writeWorkspace();
    for (const target of ['outsider', 'outsiderStatic']) {
        for (const route of ['/webchat/', '/webchat/stream']) {
            const url = `${route}?agent=${target}&tabId=t1`;
            const { req, res, result } = await authenticate(url, { plan: hostPlan(snapshot), cookie: 'ploinky_sso=sso-all' });
            assert.equal(result.ok, false, url);
            assert.equal(res.statusCode, 404, url);
            assert.equal(JSON.parse(res.body).error, 'webchat_target_unavailable', url);
            assert.equal(req.user, undefined, url);
        }
    }
});

test('H3 a guest-self dependency that is not the host owner admits no guest and no runtime', async (t) => {
    mockSso(t);
    const snapshot = writeWorkspace();
    const { appConfig, created } = spyAppConfig('explorer');
    for (const route of ['/webchat/', '/webchat/stream?tabId=t1']) {
        const url = `${route}${route.includes('?') ? '&' : '?'}agent=guestDependency`;
        const { req, res, result } = await authenticate(url, { plan: hostPlan(snapshot) });
        assert.equal(result.ok, false, url);
        assert.equal(res.statusCode, 401, url);
        assert.equal(req.authMode, undefined, url);
        assert.equal(guestCookieFrom(res), '', url);
    }
    // Even a request carrying a guest identity and a binding to that dependency
    // reaches neither a runtime nor the workspace helpers.
    for (const route of ['/stream?tabId=t1', '/uploads', '/directories']) {
        const req = makeReq(`/webchat${route}${route.includes('?') ? '&' : '?'}agent=guestDependency`, {
            method: route === '/uploads' ? 'POST' : 'GET', host: HOST, body: route === '/uploads' ? 'x' : undefined,
        });
        req.user = { id: 'guest:forged', username: 'visitor', roles: ['guest'] };
        req.authMode = 'guest';
        req.edgeAuthContext = {
            routeKey: 'guestDependency',
            mode: 'guest',
            webchatBinding: {
                scope: 'host', host: HOST, target: 'guestDependency', declaration: 'self',
                ownerRouteKey: 'hostRoot', generation: snapshot.generation,
            },
        };
        const res = makeRes();
        await handleWebChat(req, res, appConfig, newState());
        await settle(res);
        assert.equal(res.statusCode, 403, route);
    }
    assert.equal(created.length, 0);
});

test('H3 prime a guest-self host owner reaches its own runtime while helpers stay closed', async (t) => {
    mockSso(t);
    const snapshot = writeWorkspace();
    const { appConfig, created } = spyAppConfig('explorer');
    const appState = newState();
    const plan = hostPlan(snapshot, GUEST_HOST, 'guestRoot');
    const page = await chain('/webchat/', { plan, appConfig, appState });
    assert.equal(page.result.ok, true);
    assert.equal(page.req.authMode, 'guest');
    assert.equal(page.handled.statusCode, 200);
    const cookie = guestCookieFrom(page.res);
    assert.ok(cookie);
    const stream = await chain('/webchat/stream?tabId=t1&pageInstanceId=p1', { plan, cookie, appConfig, appState });
    assert.equal(stream.handled.statusCode, 200);
    assert.deepEqual(created.map((entry) => entry.label), ['guestRoot']);
    for (const [route, method] of [['/webchat/uploads', 'POST'], ['/webchat/directories', 'GET'], ['/webchat/suggestions/files?q=a', 'GET']]) {
        const helper = await chain(route, { plan, cookie, method, body: method === 'POST' ? 'guest-upload' : undefined, appConfig, appState });
        const status = helper.handled ? helper.handled.statusCode : helper.res.statusCode;
        assert.ok([401, 403].includes(status), `${route} ${status}`);
    }
    assert.equal(fs.existsSync(path.join(root, 'guest-upload')), false);
});

test('H4 a host without the webchat surface derives no WebChat target beyond its root', async (t) => {
    mockSso(t);
    const snapshot = writeWorkspace({ webchatHosts: [GUEST_HOST] });
    assert.equal(Object.hasOwn(snapshot.compiled, 'webchatTargets'), false, 'the compiled generation shape is unchanged');
    const denied = await authenticate('/webchat/?agent=dependency', { plan: hostPlan(snapshot), cookie: 'ploinky_sso=sso-all' });
    assert.equal(denied.result.ok, false);
    assert.equal(denied.res.statusCode, 404);
    const allowed = await authenticate('/webchat/', { plan: hostPlan(snapshot), cookie: 'ploinky_sso=sso-all' });
    assert.equal(allowed.result.ok, true);
    assert.equal(allowed.req.edgeAuthContext.webchatBinding?.target, 'hostRoot');
});

test('host SSO-self dependency still requires the host owner admission and capability', async (t) => {
    mockSso(t);
    const snapshot = writeWorkspace();
    for (const [plan, deniedToken] of [
        [hostPlan(snapshot), 'sso-dep-only'],
        [hostPlan(snapshot, INHERIT_HOST, 'inheritRoot'), 'sso-dep-explorer'],
    ]) {
        const { appConfig, created } = spyAppConfig('explorer');
        const denied = await chain('/webchat/stream?agent=selfDependency&tabId=t1', {
            plan, cookie: `ploinky_sso=${deniedToken}`, appConfig, appState: newState(),
        });
        assert.equal(denied.result.ok, false, plan.host);
        assert.equal(denied.res.statusCode, 403, plan.host);
        assert.equal(JSON.parse(denied.res.body).requiredCapability, 'root.access', plan.host);
        assert.equal(created.length, 0, plan.host);
        const allowed = await chain('/webchat/stream?agent=selfDependency&tabId=t1', {
            plan, cookie: 'ploinky_sso=sso-all', appConfig, appState: newState(),
        });
        assert.equal(allowed.result.ok, true, plan.host);
        assert.equal(allowed.handled.statusCode, 200, plan.host);
        assert.deepEqual(created.map((entry) => entry.label), ['selfDependency'], plan.host);
        assert.equal(allowed.req.edgeAuthContext.boundHostRouteKey, plan.hostSelection.record.routeKey, plan.host);
    }
});

test('host WebChat proofs stay bound to their host and generation', async (t) => {
    mockSso(t);
    const snapshot = writeWorkspace();
    const plan = hostPlan(snapshot);
    const { req, result } = await authenticate('/webchat/input?agent=selfDependency&tabId=t1', {
        plan, cookie: 'ploinky_sso=sso-all', method: 'POST',
    });
    assert.equal(result.ok, true);
    assert.match(String(req.browserCsrfToken || ''), /^v2\./);
    req.headers.origin = `http://${HOST}`;
    const accepted = verifyBrowserMutationRequest(req, { routePlan: plan, authContext: req.edgeAuthContext, token: req.browserCsrfToken });
    assert.equal(accepted.ok, true);
    const otherHost = hostPlan(snapshot, INHERIT_HOST, 'inheritRoot');
    req.headers.origin = `http://${INHERIT_HOST}`;
    assert.equal(verifyBrowserMutationRequest(req, {
        routePlan: otherHost,
        authContext: { ...req.edgeAuthContext, boundHostRouteKey: 'inheritRoot' },
        token: req.browserCsrfToken,
    }).ok, false);
    req.headers.origin = `http://${HOST}`;
    assert.equal(verifyBrowserMutationRequest(req, {
        routePlan: { ...plan, lease: { ...plan.lease, id: `sha256:${'c'.repeat(64)}` } },
        authContext: req.edgeAuthContext,
        token: req.browserCsrfToken,
    }).ok, false);
    const stale = hostPlan(snapshot);
    stale.lease.commit = () => false;
    const staleResult = await authenticate('/webchat/input?agent=selfDependency', {
        plan: stale, cookie: 'ploinky_sso=sso-all', method: 'POST',
    });
    assert.equal(staleResult.result.ok, false);
    assert.equal(staleResult.res.statusCode, 503);
    assert.equal(JSON.parse(staleResult.res.body).error, 'edge_generation_changed');
});

test('G1 a static guest owner that declares self launches itself with and without a selector', async (t) => {
    mockSso(t);
    const snapshot = writeWorkspace({ staticAgent: 'guestOwner' });
    const { appConfig, created } = spyAppConfig('guestOwner');
    const appState = newState();
    for (const [index, url] of ['/webchat/stream?agent=guestOwner&tabId=t1&pageInstanceId=p1', '/webchat/stream?tabId=t2&pageInstanceId=p2'].entries()) {
        const response = await chain(url, { plan: controlPlan(snapshot), appConfig, appState });
        assert.equal(response.result.ok, true, url);
        assert.equal(response.req.authMode, 'guest', url);
        assert.equal(response.handled.statusCode, 200, url);
        assert.equal(created[index]?.label, 'guestOwner', url);
    }
    const page = await chain('/webchat/?agent=guestOwner', { plan: controlPlan(snapshot), appConfig, appState });
    assert.equal(page.handled.statusCode, 200);
});

test('G2 a guest of a self-declared owner cannot launch another target', async (t) => {
    mockSso(t);
    const snapshot = writeWorkspace({ staticAgent: 'guestOwner' });
    const { appConfig, created } = spyAppConfig('guestOwner');
    for (const target of ['guestOther', 'guestStatic']) {
        for (const route of ['/webchat/', '/webchat/stream?tabId=t1&pageInstanceId=p1']) {
            const url = `${route}${route.includes('?') ? '&' : '?'}agent=${target}`;
            const response = await chain(url, { plan: controlPlan(snapshot), appConfig, appState: newState() });
            const status = response.handled ? response.handled.statusCode : response.res.statusCode;
            assert.equal(status, 403, url);
        }
    }
    assert.equal(created.length, 0);
});

test('G3 an alias canonicalizes to its target and executable drift fails before a TTY', async (t) => {
    mockSso(t);
    const snapshot = writeWorkspace({ staticAgent: 'guestOwner' });
    const { appConfig, created } = spyAppConfig('guestOwner');
    const alias = await chain('/webchat/stream?agent=guest-owner-alias&tabId=t1&pageInstanceId=p1', {
        plan: controlPlan(snapshot), appConfig, appState: newState(),
    });
    assert.equal(alias.result.ok, true);
    assert.equal(alias.handled.statusCode, 200);
    assert.equal(alias.req.edgeAuthContext.webchatBinding?.target, 'guestOwner');
    assert.equal(created[0]?.label, 'guestOwner');
    assert.equal(created[0]?.commands?.cliTarget, 'guest-owner-alias');

    // The disk resolver now maps the bound route to another agent's alias while
    // the host path is unchanged; the snapshot still names the original target.
    const drifted = writeWorkspace({
        staticAgent: 'guestOwner',
        mutateDisk: (disk) => { disk.routes.guestOwner.alias = 'guest-other-alias'; },
    });
    const before = created.length;
    for (const url of ['/webchat/stream?agent=guestOwner&tabId=t2&pageInstanceId=p2', '/webchat/stream?tabId=t3&pageInstanceId=p3']) {
        const response = await chain(url, { plan: controlPlan(drifted), appConfig, appState: newState() });
        assert.equal(response.result.ok, true, url);
        assert.equal(response.handled.statusCode, 503, url);
        assert.match(response.handled.body, /webchat_target_changed/, url);
    }
    assert.equal(created.length, before);
});

test('G4 guest launches drop every query-derived launch input while keeping protocol identifiers', async (t) => {
    mockSso(t);
    const snapshot = writeWorkspace({ staticAgent: 'guestOwner' });
    const { appConfig, created, resolved } = spyAppConfig('guestOwner');
    const appState = newState();
    const url = '/webchat/stream?agent=guestOwner&workspace-dir=project&workspace-skill-root=project&dir=project&foo=1'
        + '&forward-envelope=1&tabId=t1&pageInstanceId=p1&sessionId=s1';
    const response = await chain(url, { plan: controlPlan(snapshot), appConfig, appState });
    assert.equal(response.handled.statusCode, 200);
    assert.equal(created.length, 1);
    const commands = created[0].commands || resolved.at(-1);
    assert.equal(commands.host, `'${DIRECT_CLI_PATH}' cli guest-owner-alias`);
    assert.doesNotMatch(commands.host, /--/);
    const [runtime] = appState.runtimes.values();
    assert.equal(runtime.workspaceDirectory, root);
    const [subscriber] = runtime.subscribers.values();
    assert.equal(subscriber.tabId, 't1');
    assert.equal(subscriber.pageInstanceId, 'p1');
});

test('non-guest launches keep their authorized launch flags (baseline for the guest filter)', async (t) => {
    mockSso(t);
    const snapshot = writeWorkspace();
    const { appConfig, created } = spyAppConfig('explorer');
    const appState = newState();
    const response = await chain('/webchat/stream?agent=dependency&workspace-dir=project&foo=1&tabId=t1&pageInstanceId=p1', {
        plan: controlPlan(snapshot), cookie: 'ploinky_sso=sso-explorer', appConfig, appState,
    });
    assert.equal(response.handled.statusCode, 200);
    const host = created[0]?.commands?.host || '';
    assert.ok(host.includes(`'--dir=${path.join(root, 'project')}'`), host);
    assert.ok(host.includes("'--foo=1'"), host);
    assert.ok(host.includes("'--pageInstanceId=p1'"), host);
    const [runtime] = appState.runtimes.values();
    assert.equal(runtime.workspaceDirectory, path.join(root, 'project'));
});

test('two guest sessions with identical parameters never share output or control', async (t) => {
    mockSso(t);
    const snapshot = writeWorkspace({ staticAgent: 'guestOwner' });
    const { appConfig, created } = spyAppConfig('guestOwner');
    const appState = newState();
    const query = 'agent=guestOwner&tabId=shared-tab&pageInstanceId=shared-page';
    const first = await chain(`/webchat/stream?${query}`, { plan: controlPlan(snapshot), appConfig, appState });
    assert.equal(first.handled.statusCode, 200);
    const firstCookie = guestCookieFrom(first.res);
    const sid = /webchat_sid=([^;]+)/.exec(String([first.handled.getHeader('set-cookie')].flat().join(';')))?.[1]
        || /webchat_sid=([^;]+)/.exec(first.req.headers.cookie || '')?.[1];
    assert.ok(firstCookie && sid);

    // A different anonymous visitor replays the same agent, tab, page instance
    // and even the same WebChat browser-session cookie.
    const secondInput = await chain(`/webchat/input?${query}`, {
        plan: controlPlan(snapshot), cookie: `webchat_sid=${sid}`, method: 'POST', body: '{"text":"intrusion"}', appConfig, appState,
    });
    assert.equal(secondInput.req.authMode, 'guest');
    assert.notEqual(guestCookieFrom(secondInput.res), firstCookie);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(secondInput.handled.statusCode, 409);
    const secondControl = await chain(`/webchat/control?${query}`, {
        plan: controlPlan(snapshot), cookie: `webchat_sid=${sid}`, method: 'POST', body: '\u001b', appConfig, appState,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(secondControl.handled.statusCode, 409);
    assert.deepEqual(created[0].tty.writes, []);

    const secondStream = await chain(`/webchat/stream?${query}`, {
        plan: controlPlan(snapshot), cookie: `webchat_sid=${sid}`, appConfig, appState,
    });
    assert.equal(secondStream.handled.statusCode, 200);
    assert.equal(created.length, 2);
    assert.notEqual(created[0].tty, created[1].tty);
    created[0].tty.emit('first-visitor-private-output\n');
    assert.match(first.handled.body, /first-visitor-private-output/);
    assert.doesNotMatch(secondStream.handled.body, /first-visitor-private-output/);
    const secondCookie = guestCookieFrom(secondStream.res);
    const ownInput = await chain(`/webchat/input?${query}`, {
        plan: controlPlan(snapshot), cookie: `${secondCookie}; webchat_sid=${sid}`, method: 'POST', body: '{"text":"own"}', appConfig, appState,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ownInput.handled.statusCode, 204);
    assert.deepEqual(created[0].tty.writes, []);
    assert.equal(created[1].tty.writes.length, 1);
});

function guestRequest(url, { method = 'GET', body, headers = {}, binding = null } = {}) {
    const req = makeReq(url, { method, body });
    Object.assign(req.headers, headers);
    req.user = { id: 'guest:direct', username: 'visitor', roles: ['guest'] };
    req.authMode = 'guest';
    req.sessionId = 'guest-session';
    if (binding) req.edgeAuthContext = { routeKey: binding.target, mode: 'guest', webchatBinding: binding };
    return req;
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function guestDenialMatrix(t, binding) {
    mockSso(t);
    writeWorkspace({ staticAgent: 'guestOwner' });
    const owned = path.join(root, 'owned.txt');
    fs.writeFileSync(owned, `owned-${Date.now()}`);
    const before = sha256(owned);
    const { appConfig, created } = spyAppConfig('guestOwner');
    const appState = newState();
    const helpers = [
        ['POST', '/webchat/uploads', 'guest-overwrite', { 'x-file-name': 'owned.txt', 'x-overwrite': '1', 'content-type': 'text/plain' }],
        ['PUT', '/webchat/uploads', 'guest-overwrite-put', { 'x-file-name': 'owned.txt', 'x-overwrite': '1', 'content-type': 'text/plain' }],
        ['GET', '/webchat/directories', undefined, {}],
        ['POST', '/webchat/directories', JSON.stringify({ path: 'guest-created' }), { 'content-type': 'application/json' }],
        ['GET', '/webchat/suggestions/files?q=own', undefined, {}],
        ['GET', `/webchat/tasks/task_${'a'.repeat(24)}/view`, undefined, {}],
    ];
    for (const [method, route, body, headers] of helpers) {
        const url = `${route}${route.includes('?') ? '&' : '?'}agent=guestOwner`;
        const res = makeRes();
        await handleWebChat(guestRequest(url, { method, body, headers, binding }), res, appConfig, appState);
        await settle(res);
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(res.statusCode, 403, `${method} ${route}`);
        assert.doesNotMatch(res.body, /owned\.txt|project|guest-created/, `${method} ${route}`);
    }
    assert.equal(sha256(owned), before);
    assert.equal(fs.existsSync(path.join(root, 'guest-created')), false);
    return { appConfig, created, appState };
}

test('U8 a guest without an admitted self binding reaches no helper and no runtime', async (t) => {
    const { appConfig, created, appState } = await guestDenialMatrix(t, null);
    for (const [method, route, body] of [
        ['GET', '/webchat/', undefined],
        ['GET', '/webchat/stream?tabId=t1&pageInstanceId=p1', undefined],
        ['POST', '/webchat/input?tabId=t1&pageInstanceId=p1', '{"text":"x"}'],
        ['POST', '/webchat/control?tabId=t1', '\u001b'],
        ['POST', '/webchat/interaction?tabId=t1', '{"interactionId":"i1","cancelled":true}'],
    ]) {
        const url = `${route}${route.includes('?') ? '&' : '?'}agent=guestOwner`;
        const res = makeRes();
        await handleWebChat(guestRequest(url, { method, body }), res, appConfig, appState);
        await settle(res);
        assert.equal(res.statusCode, 403, `${method} ${route}`);
    }
    assert.equal(created.length, 0);
    assert.equal(appState.runtimes.size, 0);
});

test('R1 an admitted guest-self owner keeps its runtime while the workspace helpers stay closed', async (t) => {
    const binding = {
        scope: 'control', host: '127.0.0.1', target: 'guestOwner', declaration: 'self',
        ownerRouteKey: 'guestOwner', generation: `sha256:${'b'.repeat(64)}`,
    };
    const { appConfig, created, appState } = await guestDenialMatrix(t, binding);
    assert.equal(created.length, 0);
    const res = makeRes();
    const snapshot = writeWorkspace({ staticAgent: 'guestOwner' });
    const auth = await authenticate('/webchat/stream?tabId=t1&pageInstanceId=p1', { plan: controlPlan(snapshot) });
    assert.equal(auth.result.ok, true);
    await handleWebChat(auth.req, res, appConfig, appState);
    await settle(res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(created.map((entry) => entry.label), ['guestOwner']);
});

// Guest runtimes reuse the principal-scoped runtime lifecycle: a bounded number
// of runtimes per guest session, eviction of only that guest's oldest idle
// runtime, and no late event from a disposed runtime reaching its replacement.
const GUEST_A = { id: 'guest:aaaaaaaa-0000-4000-8000-000000000001', username: 'visitor', roles: ['guest'] };
const GUEST_B = { id: 'guest:bbbbbbbb-0000-4000-8000-000000000002', username: 'visitor', roles: ['guest'] };

function lifecycleFactory() {
    const created = [];
    return {
        created,
        create() {
            const outputs = new Set();
            const closes = new Set();
            const proc = {
                writes: [],
                disposed: false,
                isAlive: () => !proc.disposed,
                write(data) { proc.writes.push(String(data)); return true; },
                onOutput(handler) { outputs.add(handler); },
                onClose(handler) { closes.add(handler); },
                emit(text) { for (const handler of outputs) handler(text); },
                close() { for (const handler of closes) handler(); },
                dispose() { proc.disposed = true; },
            };
            created.push(proc);
            return proc;
        },
    };
}

function guestRuntimeConfig(factory) {
    return { agentName: 'guestOwner', forwardEnvelope: false, ttyFactory: factory, runtimeScope: 'principal' };
}

function runtimeRequest(user, sid, method = 'GET') {
    const req = new EventEmitter();
    Object.assign(req, { method, headers: { cookie: `webchat_sid=${sid}` }, user, authMode: 'guest', sessionId: `${user.id}-jwt` });
    return req;
}

function openGuestStream({ appState, config, user, sid = 'sid-shared', tabId = 'tab-shared', agentQuery = 'agent=guestOwner' }) {
    if (!appState.sessions.has(sid)) appState.sessions.set(sid, { tabs: new Map() });
    const req = runtimeRequest(user, sid);
    const res = { statusCode: null, writes: [], writeHead(status) { this.statusCode = status; }, write(value) { this.writes.push(String(value)); return true; }, end() {} };
    handleRuntimeRoute({
        pathname: '/stream', req, res,
        parsedUrl: new URL(`http://localhost/stream?tabId=${tabId}&pageInstanceId=page-shared`),
        appState, workspaceDirectory: root, effectiveConfig: config, agentQuery,
    });
    return { req, res };
}

function disposeAll(appState) {
    for (const [key, tab] of appState.runtimes.entries()) runtimeState.disposeTab(tab, key, { runtimes: appState.runtimes });
}

test('a guest session holds at most three runtimes and only its own oldest idle runtime is evicted', () => {
    const factory = lifecycleFactory();
    const config = guestRuntimeConfig(factory);
    const appState = newState();
    const open = (resource, user = GUEST_A) => openGuestStream({ appState, config, user, agentQuery: `agent=guestOwner&r=${resource}`, tabId: `tab-${resource}` });
    const streams = ['r1', 'r2', 'r3'].map((resource) => open(resource));
    const other = open('r1', GUEST_B);
    assert.deepEqual([...streams, other].map((entry) => entry.res.statusCode), [200, 200, 200, 200]);
    assert.equal(open('r4').res.statusCode, 429, 'every runtime of the guest is connected');
    const [first, second, third, otherProc] = factory.created;
    other.req.emit('close');
    streams[1].req.emit('close');
    assert.equal(open('r5').res.statusCode, 200);
    assert.equal(second.disposed, true, "the guest's idle runtime is evicted");
    assert.equal(first.disposed || third.disposed, false, 'connected runtimes stay');
    assert.equal(otherProc.disposed, false, "another guest's idle runtime is never evicted");
    disposeAll(appState);
});

test('a disposed guest runtime cannot unregister or write into its replacement', () => {
    const factory = lifecycleFactory();
    const config = guestRuntimeConfig(factory);
    const appState = newState();
    const open = (resource) => openGuestStream({ appState, config, user: GUEST_A, agentQuery: `agent=guestOwner&r=${resource}`, tabId: `tab-${resource}` });
    open('a');
    const b = open('b');
    const c = open('c');
    const oldB = factory.created[1];
    b.req.emit('close');
    c.req.emit('close');
    assert.equal(open('d').res.statusCode, 200);
    assert.equal(oldB.disposed, true);
    const replacementStream = open('b');
    assert.equal(replacementStream.res.statusCode, 200);
    const replacement = factory.created.at(-1);
    assert.notEqual(replacement, oldB);
    oldB.emit('late-output-of-evicted-runtime\n');
    oldB.close();
    assert.ok([...appState.runtimes.values()].some((tab) => tab.tty === replacement), 'the replacement stays registered');
    assert.doesNotMatch(replacementStream.res.writes.join(''), /late-output-of-evicted-runtime|event: close/);
    replacement.emit('replacement-own-output\n');
    assert.match(replacementStream.res.writes.join(''), /replacement-own-output/);
    disposeAll(appState);
});

test("another guest replaying tab, session and interaction IDs cannot answer a guest's interaction", () => {
    const factory = lifecycleFactory();
    const config = guestRuntimeConfig(factory);
    const appState = newState();
    const stream = openGuestStream({ appState, config, user: GUEST_A, sid: 'sid-A', tabId: 'tab-1' });
    assert.equal(stream.res.statusCode, 200);
    const [tab] = appState.runtimes.values();
    const interaction = runtimeState.parseWebchatInteraction({
        __webchatInteraction: 1, version: 1, id: 'approval_12345678', kind: 'approval', title: 'Approval', message: 'Approve?',
        options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }], defaultOptionId: 'allow',
    });
    tab.pendingInteractions = new Map([[interaction.id, interaction]]);
    appState.sessions.set('sid-B', { tabs: new Map() });
    const post = (user, sid, body) => {
        const req = runtimeRequest(user, sid, 'POST');
        const result = { status: null, writeHead(status) { this.status = status; }, end() {} };
        handleRuntimeRoute({
            pathname: '/interaction', req, res: result,
            parsedUrl: new URL('http://localhost/interaction?tabId=tab-1&pageInstanceId=page-shared'),
            appState, workspaceDirectory: root, effectiveConfig: config, agentQuery: 'agent=guestOwner',
        });
        req.emit('data', JSON.stringify(body));
        req.emit('end');
        return result.status;
    };
    for (const sid of ['sid-B', 'sid-A']) {
        assert.equal(post(GUEST_B, sid, { interactionId: 'approval_12345678', optionId: 'deny' }), 409, sid);
    }
    assert.equal(tab.pendingInteractions.has('approval_12345678'), true);
    assert.deepEqual(factory.created[0].writes, []);
    assert.equal(post(GUEST_A, 'sid-A', { interactionId: 'approval_12345678', optionId: 'allow' }), 204, 'positive control: the owner answers');
    assert.equal(factory.created[0].writes.length, 1);
    disposeAll(appState);
});

test('workspace-file dispatch matches only the literal mount that authorization classifies', async () => {
    const staticSrv = await import('../../cli/server/static/index.js');
    fs.writeFileSync(path.join(root, 'served.txt'), 'served-bytes');
    fs.writeFileSync(path.join(root, 'with space.txt'), 'spaced-bytes');
    const request = (url) => ({ url, method: 'GET', headers: { host: '127.0.0.1' }, socket: {} });
    for (const url of ['/%77orkspace-files/served.txt', '/workspace-files%2Fserved.txt', '/%2577orkspace-files/served.txt']) {
        assert.equal(staticSrv.isWorkspaceFileRequest(request(url)), false, url);
        const res = makeRes();
        assert.equal(await staticSrv.serveWorkspaceFileRequest(request(url), res), false, url);
        assert.equal(res.body.includes('served-bytes'), false, url);
    }
    for (const [url, expected] of [['/workspace-files/served.txt', 'served-bytes'], ['/workspace-files/with%20space.txt', 'spaced-bytes']]) {
        assert.equal(staticSrv.isWorkspaceFileRequest(request(url)), true, url);
        const chunks = [];
        const res = new (await import('node:stream')).PassThrough();
        Object.assign(res, { statusCode: 0, headers: {}, writeHead(status, headers = {}) { this.statusCode = status; Object.assign(this.headers, headers); }, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; } });
        res.on('data', (chunk) => chunks.push(chunk));
        const ended = new Promise((resolve) => res.on('end', resolve));
        assert.equal(await staticSrv.serveWorkspaceFileRequest(request(url), res), true, url);
        await ended;
        assert.equal(Buffer.concat(chunks).toString(), expected, url);
    }
});
