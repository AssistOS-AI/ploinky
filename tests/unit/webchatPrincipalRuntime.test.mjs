import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Real login shells run below for the local TTY factory (production `sh -lc`).
process.env.PLOINKY_ENGINE_GUARD_ALLOW_LOGIN_SHELLS = '1';
if (typeof global.processKill !== 'function') {
    global.processKill = () => {};
}

// The workspace fixture must exist before the router modules load, because
// they resolve the workspace and routing paths at import time.
const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-principal-')));
const ploinkyDir = path.join(tempDir, '.ploinky');
const dpuManifestDir = path.join(ploinkyDir, 'repos', 'AssistOSExplorer', 'dpuAgent');
const sharedManifestDir = path.join(ploinkyDir, 'repos', 'AssistOSExplorer', 'sharedAgent');
fs.mkdirSync(dpuManifestDir, { recursive: true });
fs.mkdirSync(sharedManifestDir, { recursive: true });
fs.writeFileSync(path.join(dpuManifestDir, 'manifest.json'), JSON.stringify({
    cli: 'node /code/src/index.mjs',
    webchat: { auth: 'static', forwardEnvelope: true, runtimeScope: 'principal' },
}, null, 2));
fs.writeFileSync(path.join(sharedManifestDir, 'manifest.json'), JSON.stringify({
    cli: 'node /code/src/index.mjs',
    webchat: { forwardEnvelope: true },
}, null, 2));
fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
    routes: {
        dpuAgent: {
            repo: 'AssistOSExplorer', agent: 'dpuAgent', container: 'dpu-agent-container',
            hostPath: dpuManifestDir, hostPort: 7402,
        },
        sharedAgent: {
            repo: 'AssistOSExplorer', agent: 'sharedAgent', container: 'shared-agent-container',
            hostPath: sharedManifestDir, hostPort: 7403,
        },
    },
}, null, 2));
fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
    'dpu-agent-container': {
        type: 'agent', repoName: 'AssistOSExplorer', agentName: 'dpuAgent',
        instanceId: 'dpu-agent-instance', enableGeneration: 'dpu-agent-enable-generation',
        auth: { mode: 'none' },
    },
    'shared-agent-container': {
        type: 'agent', repoName: 'AssistOSExplorer', agentName: 'sharedAgent',
        instanceId: 'shared-agent-instance', enableGeneration: 'shared-agent-enable-generation',
        auth: { mode: 'none' },
    },
}, null, 2));
fs.mkdirSync(path.join(ploinkyDir, 'data', 'edge-routing'), { recursive: true });
fs.mkdirSync(path.join(ploinkyDir, 'data', 'router-security'), { recursive: true });
fs.writeFileSync(path.join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), JSON.stringify({ hosts: {} }, null, 2));
fs.writeFileSync(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), JSON.stringify({
    schema: 'router-policy', httpRoutes: [], mcpTools: [],
}, null, 2));
const originalCwd = process.cwd();
const originalEnv = {
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
};
process.chdir(tempDir);
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);
process.env.PLOINKY_WORKSPACE_ROOT = tempDir;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';

const suffix = `?test=${Date.now()}`;
const { applyEdgeRoutingGeneration } = await import(`../../cli/sandbox/edgeGeneration.js${suffix}`);
applyEdgeRoutingGeneration({ workspaceRoot: tempDir, reason: 'webchat-principal-runtime-test-fixture' });
const runtimeState = await import('../../cli/server/handlers/webchat/runtimeState.js');
const { handleRuntimeRoute } = await import('../../cli/server/handlers/webchat/runtimeRoutes.js');
const launchOptions = await import('../../cli/server/handlers/webchat/launchOptions.js');
const messageEnvelope = await import('../../cli/server/handlers/webchat/messageEnvelope.js');
const commandResolver = await import('../../cli/server/webchat/commandResolver.js');
const ttyModule = await import('../../cli/server/webchat/tty.js');
const { computeRchTool } = await import('../../Agent/lib/requestHash.mjs');

test.after(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
});

const WORKSPACE = '/workspace';
const USER_A = { id: 'sso:alice', username: 'alice', email: 'alice@example.test', roles: ['user'] };
const USER_B = { id: 'sso:bob', username: 'bob', email: 'bob@example.test', roles: ['user'] };
const MARKER_X = 'MARKER-X-7c1f2d';

// A fake agent process per runtime. It records its input and lets the test
// emit output exactly as a real agent would on stdout.
function createFakeFactory() {
    const created = [];
    return {
        created,
        create(ssoUser) {
            const outputHandlers = new Set();
            const proc = {
                ssoUser,
                writes: [],
                disposed: false,
                pid: null,
                isAlive: () => !proc.disposed,
                write(data) { proc.writes.push(String(data)); return true; },
                onOutput(handler) { outputHandlers.add(handler); return () => outputHandlers.delete(handler); },
                onClose() { return () => {}; },
                emit(text) { for (const handler of outputHandlers) handler(text); },
                dispose() { proc.disposed = true; },
            };
            created.push(proc);
            return proc;
        },
    };
}

function makeConfig(factory, runtimeScope) {
    return {
        agentName: 'dpuAgent',
        forwardEnvelope: false,
        ttyFactory: factory,
        ...(runtimeScope ? { runtimeScope } : {}),
    };
}

function makeAppState() {
    return { runtimes: new Map(), sessions: new Map() };
}

function openStream({ appState, effectiveConfig, user, agentQuery = 'agent=dpuAgent', tabId, sid }) {
    if (!appState.sessions.has(sid)) appState.sessions.set(sid, { tabs: new Map() });
    const req = new EventEmitter();
    req.method = 'GET';
    req.headers = { cookie: `webchat_sid=${sid}` };
    if (user) {
        req.user = user;
        req.authMode = 'sso';
        req.sessionId = `sso-cookie-of-${user.username}`;
    }
    const res = {
        statusCode: null,
        body: '',
        writes: [],
        writeHead(status) { this.statusCode = status; },
        write(value) { this.writes.push(String(value)); return true; },
        end(value = '') { this.body += value; },
    };
    handleRuntimeRoute({
        pathname: '/stream', req, res,
        parsedUrl: new URL(`http://localhost/stream?tabId=${tabId}&pageInstanceId=page-${tabId}`),
        appState, workspaceDirectory: WORKSPACE, effectiveConfig, agentQuery,
    });
    return { req, res };
}

async function postInput({ appState, effectiveConfig, user, agentQuery = 'agent=dpuAgent', tabId, text }) {
    const req = new EventEmitter();
    req.method = 'POST';
    req.headers = { host: 'localhost' };
    if (user) {
        req.user = user;
        req.authMode = 'sso';
    }
    let resolveEnded;
    const ended = new Promise((resolve) => { resolveEnded = resolve; });
    const res = {
        statusCode: null,
        body: '',
        writeHead(status) { this.statusCode = status; },
        write() { return true; },
        end(value = '') { this.body += value; resolveEnded(); },
    };
    handleRuntimeRoute({
        pathname: '/input', req, res,
        parsedUrl: new URL(`http://localhost/input?tabId=${tabId}&pageInstanceId=page-${tabId}`),
        appState, workspaceDirectory: WORKSPACE, effectiveConfig, agentQuery,
    });
    if (res.statusCode === null) {
        req.emit('data', JSON.stringify({ __webchatMessage: 1, version: 1, text }));
        req.emit('end');
    }
    await ended;
    return res;
}

function cleanup(appState) {
    for (const [key, tab] of appState.runtimes.entries()) {
        runtimeState.disposeTab(tab, key, { runtimes: appState.runtimes });
    }
}

test('runtime scope shared: a second user joins the first user\'s runtime and receives its output (leak control)', async () => {
    const factory = createFakeFactory();
    const effectiveConfig = makeConfig(factory);
    const appState = makeAppState();
    const a = openStream({ appState, effectiveConfig, user: USER_A, tabId: 'tab-A', sid: 'sid-A' });
    const b = openStream({ appState, effectiveConfig, user: USER_B, tabId: 'tab-B', sid: 'sid-B' });
    assert.equal(a.res.statusCode, 200);
    assert.equal(b.res.statusCode, 200);
    assert.equal(factory.created.length, 1, 'shared scope keeps one runtime for every user');

    factory.created[0].emit(`${MARKER_X}\n`);
    assert.match(a.res.writes.join(''), new RegExp(MARKER_X));
    assert.match(b.res.writes.join(''), new RegExp(MARKER_X), 'shared scope is expected to leak; this is the control');

    const inputB = await postInput({ appState, effectiveConfig, user: USER_B, tabId: 'tab-B', text: 'from B' });
    assert.equal(inputB.statusCode, 204);
    assert.match(factory.created[0].writes.join(''), /from B/);
    cleanup(appState);
});

test('runtime scope principal: users get distinct runtimes, only A receives X, and B input never reaches A', async () => {
    const factory = createFakeFactory();
    const effectiveConfig = makeConfig(factory, 'principal');
    const appState = makeAppState();
    const a = openStream({ appState, effectiveConfig, user: USER_A, tabId: 'tab-A', sid: 'sid-A' });
    const b = openStream({ appState, effectiveConfig, user: USER_B, tabId: 'tab-B', sid: 'sid-B' });
    assert.equal(a.res.statusCode, 200);
    assert.equal(b.res.statusCode, 200);
    assert.equal(factory.created.length, 2, 'each principal gets its own runtime');
    const [procA, procB] = factory.created;
    assert.equal(procA.ssoUser.id, USER_A.id);
    assert.equal(procB.ssoUser.id, USER_B.id);

    procA.emit(`${MARKER_X}\n`);
    assert.match(a.res.writes.join(''), new RegExp(MARKER_X), 'positive control: A receives its own output');
    assert.doesNotMatch(b.res.writes.join(''), new RegExp(MARKER_X), 'B must never receive A\'s output');

    const inputB = await postInput({ appState, effectiveConfig, user: USER_B, tabId: 'tab-B', text: 'from B' });
    assert.equal(inputB.statusCode, 204);
    assert.doesNotMatch(procA.writes.join(''), /from B/, 'B\'s input never reaches A\'s process');
    assert.match(procB.writes.join(''), /from B/);
    assert.doesNotMatch(a.res.writes.join(''), /from B/, 'B\'s transcript echo never reaches A');

    const inputA = await postInput({ appState, effectiveConfig, user: USER_A, tabId: 'tab-A', text: 'from A' });
    assert.equal(inputA.statusCode, 204);
    assert.match(procA.writes.join(''), /from A/);
    assert.doesNotMatch(procB.writes.join(''), /from A/);
    cleanup(appState);
});

test('runtime scope principal: the agent process never receives the SSO session cookie', () => {
    for (const runtimeScope of ['principal', undefined]) {
        const factory = createFakeFactory();
        const appState = makeAppState();
        openStream({ appState, effectiveConfig: makeConfig(factory, runtimeScope), user: USER_A, tabId: 'tab-A', sid: 'sid-A' });
        assert.equal(factory.created.length, 1);
        assert.equal(Object.hasOwn(factory.created[0].ssoUser, 'sessionId'), false);
        assert.doesNotMatch(JSON.stringify(factory.created[0].ssoUser), /sso-cookie-of-alice/);
        cleanup(appState);
    }
});

test('runtime scope principal: every runtime route refuses a request without an authenticated user', async () => {
    const factory = createFakeFactory();
    const effectiveConfig = makeConfig(factory, 'principal');
    const appState = makeAppState();
    const stream = openStream({ appState, effectiveConfig, user: null, tabId: 'tab-G', sid: 'sid-G' });
    assert.equal(stream.res.statusCode, 403);
    assert.equal(factory.created.length, 0, 'no runtime is created for an anonymous request');
    assert.equal(appState.runtimes.size, 0);

    const emptyId = openStream({ appState, effectiveConfig, user: { id: '', username: 'x', roles: [] }, tabId: 'tab-E', sid: 'sid-E' });
    assert.equal(emptyId.res.statusCode, 403);
    assert.equal(factory.created.length, 0);

    const input = await postInput({ appState, effectiveConfig, user: null, tabId: 'tab-G', text: 'hello' });
    assert.equal(input.statusCode, 403);

    for (const pathname of ['/control', '/interaction']) {
        const req = new EventEmitter();
        req.method = 'POST';
        req.headers = { cookie: 'webchat_sid=sid-G' };
        const res = { statusCode: null, writeHead(status) { this.statusCode = status; }, end() {} };
        handleRuntimeRoute({
            pathname, req, res,
            parsedUrl: new URL(`http://localhost${pathname}?tabId=tab-G`),
            appState, workspaceDirectory: WORKSPACE, effectiveConfig, agentQuery: 'agent=dpuAgent',
        });
        assert.equal(res.statusCode, 403, `${pathname} refuses an anonymous principal-scoped request`);
    }
});

test('runtime scope principal: a fourth resource with every runtime connected returns 429', () => {
    const factory = createFakeFactory();
    const effectiveConfig = makeConfig(factory, 'principal');
    const appState = makeAppState();
    const resources = ['r1', 'r2', 'r3', 'r4'];
    const streams = resources.map((resource, index) => openStream({
        appState, effectiveConfig, user: USER_A,
        agentQuery: `agent=dpuAgent&dpu-resource-id=${resource}`,
        tabId: `tab-${index}`, sid: 'sid-A',
    }));
    assert.deepEqual(streams.map((entry) => entry.res.statusCode), [200, 200, 200, 429]);
    assert.equal(factory.created.length, 3);
    assert.equal(appState.runtimes.size, 3);

    // Another principal is not limited by A's runtimes.
    const other = openStream({
        appState, effectiveConfig, user: USER_B,
        agentQuery: 'agent=dpuAgent&dpu-resource-id=r1', tabId: 'tab-B', sid: 'sid-B',
    });
    assert.equal(other.res.statusCode, 200);
    cleanup(appState);
});

test('runtime scope principal: a fourth resource evicts the principal\'s oldest idle runtime', () => {
    const factory = createFakeFactory();
    const effectiveConfig = makeConfig(factory, 'principal');
    const appState = makeAppState();
    const open = (resource, index, user = USER_A) => openStream({
        appState, effectiveConfig, user,
        agentQuery: `agent=dpuAgent&dpu-resource-id=${resource}`,
        tabId: `tab-${resource}-${index}`, sid: user === USER_A ? 'sid-A' : 'sid-B',
    });
    const first = open('r1', 1);
    const second = open('r2', 2);
    const third = open('r3', 3);
    // B's idle runtime is older than every runtime of A and must not be evicted for A.
    const otherUser = open('r9', 9, USER_B);
    assert.deepEqual([first, second, third, otherUser].map((entry) => entry.res.statusCode), [200, 200, 200, 200]);
    const tabs = [...appState.runtimes.values()];
    tabs[0].createdAt = 1000;
    tabs[1].createdAt = 2000;
    tabs[2].createdAt = 3000;
    tabs[3].createdAt = 1;

    // Close the second and third streams; the second is the oldest idle runtime.
    second.req.emit('close');
    third.req.emit('close');
    otherUser.req.emit('close');
    const [procR1, procR2, procR3, procB] = factory.created;

    const fourth = open('r4', 4);
    assert.equal(fourth.res.statusCode, 200);
    assert.equal(procR2.disposed, true, 'the oldest idle runtime is evicted');
    assert.equal(procR1.disposed, false, 'a connected runtime is never evicted');
    assert.equal(procR3.disposed, false, 'only one idle runtime is evicted');
    assert.equal(procB.disposed, false, 'another principal\'s runtime is never evicted');
    assert.equal(factory.created.length, 5);
    assert.equal([...appState.runtimes.values()].filter((tab) => tab.tty && !tab.disposed).length, 4);
    cleanup(appState);
});

test('runtime scope shared: the runtime key keeps the previous format byte for byte', () => {
    const effectiveConfig = { agentName: 'sharedAgent' };
    const query = 'agent=sharedAgent&forward-envelope=1';
    const signature = crypto.createHash('sha256').update(query).digest('hex').slice(0, 16);
    assert.equal(runtimeState.buildRuntimeKey(WORKSPACE, effectiveConfig, query), `${WORKSPACE}\0sharedAgent\0${signature}`);
    assert.equal(runtimeState.buildRuntimeKey(WORKSPACE, effectiveConfig, query, ''), `${WORKSPACE}\0sharedAgent\0${signature}`);
    const principalKey = runtimeState.buildRuntimeKey(WORKSPACE, { agentName: 'dpuAgent', runtimeScope: 'principal' }, query, 'abc');
    assert.notEqual(principalKey, runtimeState.buildRuntimeKey(WORKSPACE, { agentName: 'dpuAgent', runtimeScope: 'principal' }, query, 'abd'));
});

test('runtime scope comes only from the agent manifest', async () => {
    assert.equal(commandResolver.extractManifestWebchatOptions({ webchat: { runtimeScope: 'principal' } }).runtimeScope, 'principal');
    assert.notEqual(commandResolver.extractManifestWebchatOptions({ webchat: { runtimeScope: 'per-user' } }).runtimeScope, 'principal');
    assert.notEqual(commandResolver.extractManifestWebchatOptions({ webchat: {} }).runtimeScope, 'principal');

    const principal = await commandResolver.resolveWebchatCommandsForAgentAsync('dpuAgent', { cliArgs: [] });
    assert.equal(principal.runtimeScope, 'principal');
    const shared = await commandResolver.resolveWebchatCommandsForAgentAsync('sharedAgent', {
        cliArgs: (await launchOptions.resolveWebchatLaunchOptionsAsync(
            new URL('http://localhost/webchat?agent=sharedAgent&webchat-runtime-scope=principal'),
        )).cliArgs,
    });
    assert.notEqual(shared.runtimeScope, 'principal', 'a query key cannot select principal scope');

    const { initializeTTYFactories, createServiceConfig } = await import('../../cli/server/utils/ttyFactories.js');
    const { getWebchatFactory } = await initializeTTYFactories();
    const service = createServiceConfig(getWebchatFactory);
    const effective = service.webchat.getFactoryForCommands(principal);
    assert.equal(effective.runtimeScope, 'principal', 'the effective WebChat config carries the manifest scope');
    assert.notEqual(service.webchat.getFactoryForCommands(shared).runtimeScope, 'principal');
});

test('reserved identity and scope query keys never become agent argv', async () => {
    const url = new URL('http://localhost/webchat?agent=dpuAgent&sso-user-id=admin&SSO-Email=x%40y&Sso-Session-Id=stolen'
        + '&%20sso-roles=admin&webchat-runtime-scope=principal&forward-envelope=1&dpu-resource-id=r1');
    const sync = launchOptions.resolveWebchatLaunchOptions(url).cliArgs;
    const asyncArgs = (await launchOptions.resolveWebchatLaunchOptionsAsync(url)).cliArgs;
    for (const cliArgs of [sync, asyncArgs]) {
        assert.equal(cliArgs.some((arg) => /^--\s*sso-/i.test(arg)), false, cliArgs.join(' '));
        assert.equal(cliArgs.some((arg) => /webchat-runtime-scope/i.test(arg)), false, cliArgs.join(' '));
        assert.ok(cliArgs.includes('--forward-envelope=1'), 'agent-owned launch flags still pass');
        assert.ok(cliArgs.includes('--dpu-resource-id=r1'));
    }
    const commands = await commandResolver.resolveWebchatCommandsForAgentAsync('dpuAgent', { cliArgs: asyncArgs });
    assert.doesNotMatch(commands.host, /sso-|admin|stolen|webchat-runtime-scope/i);
});

test('WebChat identity argv and env never carry the SSO session', async () => {
    const ssoUser = { ...USER_A, sessionId: 'sso-cookie-secret-value' };
    // A real local WebChat process: print its argv and the session env var.
    const script = 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),sid:process.env.SSO_SESSION_ID||null})+"\\n")';
    const factory = ttyModule.createLocalTTYFactory({ workdir: tempDir, command: `${JSON.stringify(process.execPath)} -e '${script}' --` });
    const session = factory.create(ssoUser);
    const chunks = [];
    await new Promise((resolve) => {
        session.onOutput((data) => chunks.push(data));
        session.onClose(resolve);
    });
    const line = chunks.join('').split('\n').find((entry) => entry.startsWith('{'));
    const observed = JSON.parse(line);
    assert.ok(observed.argv.includes(`--sso-user-id=${USER_A.id}`), `positive control: ${line}`);
    assert.equal(observed.argv.some((arg) => /sso-session/i.test(arg)), false, line);
    assert.doesNotMatch(line, /sso-cookie-secret-value/);
    assert.equal(observed.sid, null);

    // The container factory shares the same identity argument builder.
    assert.equal(typeof ttyModule.buildSsoCliArgs, 'function');
    const args = ttyModule.buildSsoCliArgs(ssoUser);
    assert.ok(args.includes(`--sso-user-id=${USER_A.id}`), 'positive control: the user id is still passed');
    assert.equal(args.some((arg) => /session/i.test(arg)), false);
    assert.doesNotMatch(args.join(' '), /sso-cookie-secret-value/);
});

function decodeJwtPayload(token) {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
}

test('signed WebChat arguments carry runtimeScope only for principal-scoped runtimes', () => {
    const req = { headers: { host: 'localhost' }, socket: {}, user: USER_A, authMode: 'sso' };
    const envelope = { text: 'list my resources', attachments: [], presentation: { visible: true } };
    const baseArgs = {
        surface: 'webchat', tabId: 'tab-A', pageInstanceId: 'page-A', text: 'list my resources',
        attachments: [], references: [], presentation: { visible: true },
    };
    const rch = (args) => computeRchTool({ method: 'POST', path: '/mcp', tool: '__webchat_message__', arguments: args });

    const principalPayload = JSON.parse(messageEnvelope.serializeWebchatEnvelopeForAgent({
        req, effectiveConfig: { agentName: 'dpuAgent', runtimeScope: 'principal' },
        tabId: 'tab-A', pageInstanceId: 'page-A', envelope,
    }));
    assert.ok(principalPayload.invocation?.token, 'the router mints a WebChat invocation token');
    assert.equal(Object.hasOwn(principalPayload, 'runtimeScope'), false, 'the scope is signed, not sent as a forgeable field');
    const principalClaims = decodeJwtPayload(principalPayload.invocation.token);
    assert.equal(principalClaims.tool, '__webchat_message__');
    assert.equal(principalClaims.sub, `user:${USER_A.id}`);
    assert.equal(principalClaims.rch, rch({ ...baseArgs, runtimeScope: 'principal' }));
    assert.notEqual(principalClaims.rch, rch(baseArgs));

    const sharedPayload = JSON.parse(messageEnvelope.serializeWebchatEnvelopeForAgent({
        req, effectiveConfig: { agentName: 'dpuAgent' },
        tabId: 'tab-A', pageInstanceId: 'page-A', envelope,
    }));
    assert.equal(decodeJwtPayload(sharedPayload.invocation.token).rch, rch(baseArgs), 'shared scope signs the unchanged arguments');
});
