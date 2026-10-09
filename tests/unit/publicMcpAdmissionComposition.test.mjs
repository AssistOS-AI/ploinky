import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A public MCP session target comes only from the route whose own record and
// policy the Router resolved. A caller-chosen WebChat selector, a service
// route, or `?agent=` can never name one.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'pmac-')));
const ploinkyDir = path.join(workspace, '.ploinky');
mkdirSync(ploinkyDir, { recursive: true });
const agent = (name, mode = 'none') => ({ type: 'agent', agentName: name, repoName: 'fixtures', auth: { mode } });
const agents = { owner: agent('owner'), other: agent('other'), secure: agent('secure', 'sso') };
const routing = {
    routes: {
        owner: { agent: 'owner', repo: 'fixtures', hostPort: 41001 },
        other: { agent: 'other', repo: 'fixtures', hostPort: 41002 },
        secure: { agent: 'secure', repo: 'fixtures', hostPort: 41003 },
    },
    static: { agent: 'owner', hostPath: workspace },
};
writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify(agents));
writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify(routing));

const previous = {
    cwd: process.cwd(),
    root: process.env.PLOINKY_WORKSPACE_ROOT,
    key: process.env.PLOINKY_MASTER_KEY,
};
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
const href = (file) => pathToFileURL(path.join(REPO_ROOT, file)).href;
const nonce = `?test=${Date.now()}-${Math.random()}`;
const authHandlers = await import(href('cli/server/authHandlers/index.js') + nonce);
const { resolveAuthContextForRoutePlan } = await import(href('cli/server/authHandlers/authContext.js') + nonce);
const { createMcpSessionOwner } = await import(href('cli/server/mcp-proxy/sessionOwnership.mjs'));
const { handleAgentMcpRequest } = await import(href('cli/server/mcp-proxy/index.js'));

test.after(() => {
    process.chdir(previous.cwd);
    if (previous.root === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previous.root;
    if (previous.key === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previous.key;
    rmSync(workspace, { recursive: true, force: true });
});

const manifests = {
    owner: { webchat: { auth: 'static' } },
    other: { webchat: { auth: 'static' } },
    secure: { webchat: { auth: 'static' } },
};
const snapshot = { generation: 'pmac-generation', routing, agents, manifests };
const basePlan = {
    ok: false,
    kind: null,
    hostSelection: { kind: 'control', host: 'localhost' },
    snapshot,
    lease: { id: snapshot.generation, snapshot, commit: () => true },
};
const agentRootPlan = (routeKey, url) => ({
    ...basePlan,
    ok: true,
    kind: 'agent-root',
    routeKey,
    route: routing.routes[routeKey],
    canonicalPath: new URL(url, 'http://localhost').pathname,
    upstreamPath: '/mcp',
});

function mockResponse() {
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    return {
        done,
        statusCode: 0,
        headers: {},
        body: '',
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        getHeader(name) { return this.headers[String(name).toLowerCase()]; },
        writeHead(status, headers = {}) {
            this.statusCode = status;
            for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
        },
        end(body = '') { this.body = String(body); finish(); },
    };
}

function mcpRequest(url, { session, rpc = 'initialize', method = 'POST' } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: rpc }))]);
    return Object.assign(req, {
        method,
        url,
        headers: { host: 'localhost', ...(session ? { 'mcp-session-id': session } : {}) },
        rawHeaders: [],
    });
}

async function admit(url, plan) {
    const req = mcpRequest(url);
    const parsedUrl = new URL(url, 'http://localhost');
    const context = resolveAuthContextForRoutePlan(parsedUrl, plan);
    const result = await authHandlers.ensureAuthenticated(req, mockResponse(), parsedUrl, { routePlan: plan });
    return { req, context, result };
}

const publicOwner = (surface, target) => ({ kind: 'public-none', surface, target });

test('aggregate /mcp admits only the static owner whatever ?agent= selects', async () => {
    for (const url of ['/mcp', '/mcp?agent=other', '/mcp?agent=secure']) {
        const { req, context, result } = await admit(url, basePlan);
        assert.equal(result.ok, true, url);
        assert.equal(context.routeKey, 'owner', url);
        assert.equal(context.serviceRouteKey, undefined, url);
        assert.deepEqual(createMcpSessionOwner(req, 'aggregate'), publicOwner('aggregate', 'owner'), url);
    }
});

test('agent /<route>/mcp admits exactly the genuinely public route, never ?agent=', async () => {
    for (const url of ['/owner/mcp', '/owner/mcp?agent=other', '/owner/mcp?agent=secure']) {
        const { req, context, result } = await admit(url, agentRootPlan('owner', url));
        assert.equal(result.ok, true, url);
        assert.equal(context.routeKey, 'owner', url);
        assert.deepEqual(createMcpSessionOwner(req, 'agent', 'owner'), publicOwner('agent', 'owner'), url);
        assert.equal(createMcpSessionOwner(req, 'agent', 'other'), null, url);
        assert.equal(createMcpSessionOwner(req, 'agent', 'secure'), null, url);
    }
});

test('a public route that is not the resolved owner is not admitted by path or selector', async () => {
    for (const url of ['/other/mcp', '/other/mcp?agent=other', '/other/mcp?agent=owner']) {
        const { req, context, result } = await admit(url, agentRootPlan('other', url));
        assert.equal(result.ok, true, url);
        assert.equal(context.routeKey, 'owner', url);
        assert.equal(createMcpSessionOwner(req, 'agent', 'other'), null, url);
    }
});

test('a WebChat selector under a none owner records no public target for the selected agent', async () => {
    for (const selected of ['secure', 'other']) {
        const url = `/webchat/stream?agent=${selected}`;
        const { req, context, result } = await admit(url, basePlan);
        assert.equal(result.ok, true, url);
        assert.equal(context.routeKey, 'owner', url);
        assert.equal(context.serviceRouteKey, selected, url);
        assert.ok(context.webchatBinding, url);
        for (const target of [selected, 'owner']) {
            assert.equal(createMcpSessionOwner(req, 'agent', target), null, `${url} agent ${target}`);
        }
        assert.equal(createMcpSessionOwner(req, 'aggregate'), null, `${url} aggregate`);
    }
});

test('only requests the Router dispatches to an MCP handler can admit a public target', async () => {
    const targets = ['owner', 'other', 'secure', 'bogus'];
    const none = async (url, plan) => {
        const { req } = await admit(url, plan);
        for (const target of targets) {
            assert.equal(createMcpSessionOwner(req, 'agent', target), null, `${url} agent ${target}`);
        }
        assert.equal(createMcpSessionOwner(req, 'aggregate'), null, `${url} aggregate`);
    };
    for (const url of [
        '/auth/x?agent=other', '/auth/x?agent=bogus', '/auth/login?agent=owner',
        '/webchat/unknown?agent=other', '/webchat/assets/app.js?agent=other',
        '/webchat/uploads?agent=secure', '/webchat/stream', '/webchat/stream?agent=bogus',
        '/status', '/blobs/x?agent=other', '/upload',
        '/%6dcp', '/%6dcp?agent=other', '/mcpx', '/api/mcp',
    ]) {
        await none(url, basePlan);
    }
    // A request with no route plan has no canonical classification.
    const parsedUrl = new URL('/mcp', 'http://localhost');
    const req = mcpRequest('/mcp');
    assert.equal((await authHandlers.ensureAuthenticated(req, mockResponse(), parsedUrl)).ok, true);
    assert.equal(createMcpSessionOwner(req, 'aggregate'), null);
});

// The admission predicate is also pinned on its own: these requests are
// classified as MCP dispatch by a plan while their auth context is the
// WebChat or authentication context the Router builds for the URL.
test('the admission predicate refuses selector-derived and unresolved contexts', async () => {
    const mcpPlan = agentRootPlan('owner', '/owner/mcp');
    const urls = [
        '/webchat/uploads?agent=secure', // serviceRouteKey without a binding
        '/webchat/stream', // a binding without a serviceRouteKey
        '/auth/x?agent=bogus', // no resolved record
        '/webchat/stream?agent=bogus', // no resolved record
    ];
    for (const url of urls) {
        const { req, context } = await admit(url, mcpPlan);
        if (url === '/webchat/uploads?agent=secure') {
            assert.equal(context.serviceRouteKey, 'secure');
            assert.equal(context.webchatBinding, undefined);
        } else if (url === '/webchat/stream') {
            assert.equal(context.serviceRouteKey, undefined);
            assert.ok(context.webchatBinding);
        } else {
            assert.equal(context.record, null, url);
        }
        for (const target of ['owner', 'other', 'secure', 'bogus']) {
            assert.equal(createMcpSessionOwner(req, 'agent', target), null, `${url} agent ${target}`);
        }
    }
});

test('a browser MCP session opens on the public route and stays bound to it', async () => {
    const url = '/owner/mcp';
    const plan = agentRootPlan('owner', url);
    const dispatch = async (target, options) => {
        const req = mcpRequest(`/${target}/mcp`, options);
        const res = mockResponse();
        await handleAgentMcpRequest(req, res, { hostPort: 1 }, target, {
            waitForAgentReady: async () => true,
            routePlan: { ...plan, routeKey: target, route: routing.routes[target] },
        });
        await res.done;
        return { res, json: res.body ? JSON.parse(res.body) : null };
    };
    const opened = await dispatch('owner');
    const session = opened.res.headers['mcp-session-id'];
    assert.equal(opened.res.statusCode, 200);
    assert.ok(session, 'initialize on the public route returns a session handle');
    const again = await dispatch('owner', { session, rpc: 'unknown' });
    assert.equal(again.json.error.code, -32601);
    const foreign = await dispatch('other', { session, rpc: 'unknown' });
    assert.equal(foreign.json.error.code, -32000);
    const noHandle = await dispatch('other');
    assert.equal(noHandle.res.headers['mcp-session-id'], undefined);
    assert.equal(noHandle.json.error.code, -32000);
});
