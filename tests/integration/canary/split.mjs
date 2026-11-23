import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import '../../helpers/agentlibTestContract.mjs';

const routeKey = 'service';
const principal = 'agent:fixture/service';
const source = 'agent:fixture/caller';
const rolloutId = 'rollout-1';
const tool = 'inspect';
const args = { common: 'shared', optional: 'new' };

async function listen(t, server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    return server.address().port;
}

function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

function json(res, status, data, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(data));
}

function guarded(handler) {
    return (req, res) => handler(req, res).catch(error => json(res, error.status || 500, { error: error.message }));
}

function websocketAccept(key) {
    return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function upgrade(port, cookie, keepOpen = false) {
    return new Promise((resolve, reject) => {
        const key = randomBytes(16).toString('base64');
        const req = http.get({ hostname: '127.0.0.1', port, path: '/service/public/socket', headers: {
            cookie, connection: 'upgrade', upgrade: 'websocket', 'sec-websocket-version': 13,
            'sec-websocket-key': key,
        } });
        req.on('error', reject);
        req.on('response', res => { res.resume(); resolve({ status: res.statusCode }); });
        req.on('upgrade', (res, socket) => {
            if (!keepOpen || res.headers['sec-websocket-accept'] !== websocketAccept(key)) socket.destroy();
            if (res.headers['sec-websocket-accept'] !== websocketAccept(key)) return reject(new Error('invalid upgrade response'));
            resolve({ status: res.statusCode, copy: res.headers['x-fixture-copy'], ...(keepOpen && { socket }) });
        });
    });
}

test('two isolated copies serve their own page, assets, streams, upgrades, tasks and tool schema', { timeout: 30_000 }, async t => {
    const cwd = process.cwd();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-split-'));
    const previous = { PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT, PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY };
    process.chdir(root);
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    process.env.PLOINKY_MASTER_KEY = randomBytes(32).toString('hex');
    t.after(() => {
        process.chdir(cwd);
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
    });

    const { deriveAgentRequestSecret, deriveSubkey } = await import('../../../cli/utils/security/masterKey.js');
    const { verifyRouterRequestFromHeaders, verifyOpenAiServiceAuthInfoFromHeaders,
        verifyOpenAiModelsAuthInfoFromHeaders } = await import('../../../Agent/lib/invocationAuth.mjs');
    const { computeRchTool } = await import('../../../Agent/lib/requestHash.mjs');
    const { createMemoryReplayCache } = await import('../../../Agent/lib/jwtVerify.mjs');
    const { signAgentAssertion, signAgentHttpAssertion } = await import('../../../Agent/lib/agentAssertion.mjs');
    const { mintUserDelegationGrant } = await import('../../../cli/server/mcp-proxy/userDelegationGrant.js');
    const identities = {};
    const dials = [];
    for (const [index, copy] of ['old', 'canary'].entries()) {
        const launchId = randomUUID();
        const replayCache = createMemoryReplayCache();
        const env = { PLOINKY_AGENT_ID: principal, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(principal), PLOINKY_LAUNCH_ID: launchId };
        const backend = http.createServer(guarded(async (req, res) => {
            const url = new URL(req.url, 'http://localhost');
            const verify = (name, params) => {
                const surface = { method: req.method, path: url.pathname, tool: name };
                const proof = verifyRouterRequestFromHeaders(req.headers, { ...surface, env, replayCache,
                    rch: computeRchTool({ ...surface, arguments: params }) });
                assert.equal(proof.ok, true, proof.reason);
            };
            if (url.pathname === '/task') {
                const taskId = url.searchParams.get('taskId');
                verify('__task_status__', { taskId });
                dials.push({ copy, taskId });
                return json(res, 200, { task: { id: taskId, copy } });
            }
            if (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/models') {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const verifier = req.method === 'GET' ? verifyOpenAiModelsAuthInfoFromHeaders : verifyOpenAiServiceAuthInfoFromHeaders;
                const proof = verifier(req.headers, { env, replayCache, body: Buffer.concat(chunks) });
                assert.equal(proof.ok, true, proof.reason);
                assert.equal(Object.hasOwn(req.headers, 'authorization'), false);
                assert.equal(Object.hasOwn(req.headers, 'cookie'), false);
                assert.equal(req.headers['x-ploinky-agentic-depth'], '1');
                return res.end(copy);
            }
            if (url.pathname === '/mcp') {
                if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const rpc = JSON.parse(Buffer.concat(chunks));
                const reply = (result, headers) => json(res, 200, { jsonrpc: '2.0', id: rpc.id, result }, headers);
                if (rpc.method === 'initialize') {
                    return reply({ protocolVersion: rpc.params.protocolVersion, capabilities: {}, serverInfo: { name: copy, version: '1' } },
                        { 'mcp-session-id': copy + '-session' });
                }
                if (rpc.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
                assert.equal(req.headers['mcp-session-id'], copy + '-session');
                if (rpc.method === 'tools/list') {
                    const properties = { common: { type: 'string' } };
                    if (copy === 'canary') properties.optional = { type: 'string' };
                    return reply({ tools: [{ name: tool, inputSchema: { type: 'object', properties, additionalProperties: false } }] });
                }
                assert.equal(rpc.method, 'tools/call');
                verify(tool, rpc.params.arguments);
                dials.push({ copy, tool });
                return reply({ content: [{ type: 'text', text: JSON.stringify({ copy, args: rpc.params.arguments }) }] });
            }
            if (url.pathname.endsWith('/stream')) {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write('data: ' + copy + '\n\n');
                if (!url.searchParams.has('hold')) res.end();
                return;
            }
            if (url.pathname === '/agent-card') return json(res, 200, { copy });
            res.end(copy);
        }));
        backend.on('upgrade', (req, socket) => {
            socket.on('end', () => socket.destroy());
            socket.write(['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket',
                'Sec-WebSocket-Accept: ' + websocketAccept(req.headers['sec-websocket-key']),
                'X-Fixture-Copy: ' + copy, '', ''].join('\r\n'));
        });
        identities[copy] = { type: 'agent', repoName: 'fixture', agentName: routeKey, runtime: 'podman',
            containerId: String(index + 1).repeat(64), instanceId: copy + '-instance', enableGeneration: copy + '-enable',
            launchId, hostPort: await listen(t, backend), auth: { mode: 'sso' } };
    }

    const canary = { container: 'primary__canary', rolloutId, share: 0, testAccounts: ['tester'], mode: 'split', salt: 'salt',
        commit: 'a'.repeat(40), codeDigest: 'sha256:' + 'a'.repeat(64), codePath: '.ploinky/canary/service/export',
        splitStartedAt: new Date().toISOString(), thresholds: { errorRate: 0.05, windowSeconds: 600 },
        probe: { port: 8787, path: '/health', status: 200 } };
    const hostPath = path.join(root, 'fixture', routeKey);
    const route = { repo: 'fixture', agent: routeKey, container: 'primary', hostPath, hostPort: identities.old.hostPort, canary };
    const manifest = { readiness: { protocol: 'tcp' }, routerAccess: { agentPorts: true, httpRoutes: [
        { path: '/public/*', access: 'public' }, { path: '/guest/*', access: 'guest' },
        { path: '/private/*', access: 'authenticated' },
        { path: '/base-agent-additional-server/service/8787/*', access: 'authenticated' },
    ] } };
    for (const [copy, dir] of [['old', hostPath], ['canary', path.join(root, canary.codePath)]]) {
        write(path.join(dir, 'manifest.json'), manifest);
        write(path.join(dir, 'public/index.html'), '<script src="/service/public/asset.js"></script>' + copy);
        write(path.join(dir, 'public/asset.js'), 'asset-' + copy);
    }
    const state = path.join(root, '.ploinky');
    write(path.join(state, 'routing.json'), { routes: { service: route } });
    write(path.join(state, 'agents.json'), { primary: identities.old, primary__canary: { ...identities.canary, canaryOf: routeKey } });
    const publicHost = 'service.synthetic.test';
    write(path.join(state, 'data/edge-routing/desired.json'), {
        hosts: { [publicHost]: { agent: 'fixture/service' } },
        cloudflare: { tunnelTokenSecret: 'cloudflare/fixture-tunnel' },
    });
    write(path.join(state, 'data/router-security/policy-state.json'), { schema: 'router-policy', httpRoutes: [],
        mcpTools: [{ agent: routeKey, tool, access: 'authenticated', enabled: true }] });
    const { applyEdgeRoutingGeneration, loadActiveEdgeRoutingGeneration } = await import('../../../cli/sandbox/edgeGeneration.js');
    const apply = () => applyEdgeRoutingGeneration({ workspaceRoot: root, reason: 'canary-split-test', publicationState: 'ready' });
    apply();
    const { resolveEdgeRoutePlan, httpAccessForEdgeRoutePlan } = await import('../../../cli/server/edgeRoutePlan.js');
    const { readPublicCanaryUserId } = await import('../../../cli/server/routerHandlers.js');
    const { ensureHttpRouteAccess, buildIdentityHeaders } = await import('../../../cli/server/authHandlers/authContext.js');
    const { authService } = await import('../../../cli/server/authHandlers/shared.js');
    const { createSessionStore } = await import('../../../cli/server/auth/sessionStore.js');
    const store = createSessionStore();
    const cookies = Object.fromEntries(['tester', 'reader'].map(id => [
        id, 'ploinky_sso=' + store.createSession({ user: { id, roles: ['user'] } }).id,
    ]));
    t.mock.method(authService, 'isConfigured', () => true);
    t.mock.method(authService, 'getSession', store.getSession);
    t.mock.method(authService, 'validateSession', async id => store.getSession(id));
    t.mock.method(authService, 'admissionFence', id => () => Boolean(store.getSession(id)));
    const { canarySignals: signals, observeCanarySnapshot } = await import('../../../cli/server/canary/routerSignals.js');
    signals.setProbe(null);
    observeCanarySnapshot(loadActiveEdgeRoutingGeneration({ workspaceRoot: root }).generation);
    assert.equal(signals.routingState(routeKey, rolloutId).state, 'paused');
    assert.equal(signals.resume(routeKey, rolloutId), true);
    const { dispatchAgentRootHttp, dispatchCanaryAgentOpenAi, executeHttpPlan } = await import('../../../cli/server/proxy/executeHttpPlan.js');
    const { buildHttpRouteAuthInfoHeader, handleRouterMcp } = await import('../../../cli/server/routerHandlers.js');
    const { requestAgentCard, selectAgentCardCandidates } = await import('../../../cli/server/agentCardFanout.js');
    const { handleAgentRootUpgrade } = await import('../../../cli/server/wsAgentRootProxy.js');
    const { handleAgentMcpRequest, readAuthenticatedAgentTask } = await import('../../../cli/server/mcp-proxy/index.js');
    const { createUpstreamSessionPool } = await import('../../../cli/server/mcp-proxy/upstreamSessionPool.js');
    const pool = createUpstreamSessionPool();
    t.after(() => pool.closeAll());
    let race;
    function beforeDispatch(site) {
        if (race?.site !== site || race.changes === race.limit) return;
        race.changes++;
        if (race.changes === 1) {
            for (let i = 0; i < 3; i++) signals.recordProbe(routeKey, rolloutId, { ok: false });
            assert.equal(signals.routingState(routeKey, rolloutId).state, 'tripped');
        } else {
            assert.equal(signals.resume(routeKey, rolloutId), true);
        }
    }
    function guardedPlan(plan, site) {
        const lease = { ...plan.lease, commit() { beforeDispatch(site); return plan.lease.commit(); } };
        return { ...plan, lease };
    }
    const request = pool.request.bind(pool);
    pool.request = options => request(options.method !== 'tools/call' ? options : {
        ...options, beforeDial() { beforeDispatch('pooled'); return options.beforeDial(); },
    });
    const relayProofs = [];
    const relayManager = { checkout: async ({ lease }) => ({
        openRequest: async ({ plan, headers }) => {
            const record = identities[plan.copy];
            assert.equal(plan.relay.containerId, record.containerId);
            assert.equal(plan.owner.effectiveInstanceId, record.instanceId);
            assert.equal(plan.owner.enableGeneration, record.enableGeneration);
            const { verifyHttpRouteAuthInfoFromHeaders } = await import('../../../Agent/lib/invocationAuth.mjs');
            const proof = verifyHttpRouteAuthInfoFromHeaders(headers, {
                method: 'GET', path: plan.targetPath,
                env: { PLOINKY_AGENT_ID: principal, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(principal), PLOINKY_LAUNCH_ID: record.launchId },
                replayCache: createMemoryReplayCache(),
            });
            assert.equal(proof.ok, true, proof.reason);
            relayProofs.push(plan.copy);
            beforeDispatch('relay');
            assert.equal(lease.commit(), true);
            const stream = net.createConnection({ host: '127.0.0.1', port: record.hostPort });
            stream.abandon = () => stream.destroy();
            return stream;
        },
        close() {},
    }) };
    const router = http.createServer(guarded(async (req, res) => {
        const plan = resolveEdgeRoutePlan({ req });
        if (req.url === '/mcp') {
            assert.equal(plan.hostSelection.kind, 'control');
            const cookie = req.headers.cookie?.slice('ploinky_sso='.length);
            const session = store.getSession(cookie);
            assert.ok(session);
            Object.assign(req, { user: session.user, authMode: 'sso', sessionId: cookie });
            return handleRouterMcp(req, res, plan);
        }
        assert.equal(plan.ok, true, plan.code);
        const upstream = plan.parsedUrl.pathname.slice('/service'.length);
        if (upstream === '/v1/chat/completions' || upstream === '/v1/models') {
            return dispatchCanaryAgentOpenAi({ req, res, plan: guardedPlan(plan, 'agent-openai') });
        }
        if (!req.headers.authorization) {
            const access = await ensureHttpRouteAccess(req, res, plan.parsedUrl, httpAccessForEdgeRoutePlan(plan), { routePlan: plan });
            if (!access.ok) return;
            if (plan.route.canary && httpAccessForEdgeRoutePlan(plan).access === 'public') req.canaryPublicUserId = readPublicCanaryUserId(req);
        }
        if (plan.kind === 'agent-port') return executeHttpPlan({ req, res, plan, lease: plan.lease, authorized: true, relayManager,
            trustedHeadersFactory: ({ bodyHash, plan: selected }) => ({
                authInfo: buildHttpRouteAuthInfoHeader(req, plan.parsedUrl, plan.authDefinition, {
                    bodyHash, routePath: plan.unmatchedSuffix, targetRecord: selected.targetRecord, snapshot: plan.snapshot,
                })['x-ploinky-auth-info'],
            }),
        });
        if (upstream === '/mcp') return handleAgentMcpRequest(req, res, plan.route, routeKey, {
            routePlan: plan, beforeDial: () => plan.lease.commit(), pool, signals,
        });
        if (upstream === '/task') {
            const task = await readAuthenticatedAgentTask({ req, route: plan.route, routePlan: plan, agentName: routeKey,
                beforeDial: () => { beforeDispatch('task'); return plan.lease.commit(); },
                taskId: plan.parsedUrl.searchParams.get('taskId') });
            return json(res, 200, task);
        }
        await dispatchAgentRootHttp({ req, res, plan: guardedPlan(plan, upstream.endsWith('.js') ? 'static' : 'passthrough'),
            headersForSelection: () => buildIdentityHeaders(req) });
    }));
    router.on('upgrade', (req, socket, head) => {
        const plan = resolveEdgeRoutePlan({ req, transport: 'websocket' });
        void handleAgentRootUpgrade({ req, socket, head, routePlan: guardedPlan(plan, 'websocket') }).catch(() => socket.destroy());
    });
    const port = await listen(t, router);
    const origin = 'http://127.0.0.1:' + port;
    const fetchPath = (resource, cookie, options = {}) => fetch(origin + resource, {
        ...options, redirect: 'manual', headers: { cookie: cookie || '', ...options.headers },
    });
    async function bodyAt(resource, cookie) {
        const res = await fetchPath(resource, cookie);
        const body = await res.text();
        assert.equal(res.status, 200, resource + ' ' + body);
        return body;
    }
    async function checkAgentOnlyOpenAi(expected, method) {
        const chat = method === 'POST';
        const path = chat ? '/v1/chat/completions' : '/v1/models';
        const body = chat ? Buffer.from('{ "messages" : [] }') : Buffer.alloc(0);
        const token = signAgentHttpAssertion({ method, path, body, targetAgent: routeKey,
            tool: chat ? '__openai_chat_completions__' : '__openai_models__',
            env: { PLOINKY_AGENT_ID: source, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(source) } });
        const request = () => fetchPath('/service' + path, cookies.tester, { method, ...(chat ? { body } : {}),
            headers: { authorization: 'Bearer ' + token } });
        const response = await request();
        const text = await response.text();
        assert.equal(response.status, 200, text);
        assert.equal(text, expected);
        const replay = await request();
        assert.equal(replay.status, 401);
        await replay.arrayBuffer();
    }
    // The first check changes the exposure after source verification. Its
    // retry must sign again without admitting a replay of the source assertion.
    race = { site: 'agent-openai', limit: 1, changes: 0 };
    await checkAgentOnlyOpenAi('old', 'POST');
    assert.equal(race.changes, 1);
    race = null;
    assert.equal(signals.resume(routeKey, rolloutId), true);
    for (const [id, copy] of [['tester', 'canary'], ['reader', 'old']]) {
        const cookie = cookies[id];
        assert.equal(await bodyAt('/service/private/page', cookie), copy);
        assert.equal(await bodyAt('/service/guest/page', cookie), copy);
        const page = await bodyAt('/service/public/index.html', cookie);
        assert.ok(page.endsWith(copy), page);
        assert.equal(await bodyAt(page.match(/src="([^"]+)"/)[1], cookie), 'asset-' + copy);
        assert.equal(await bodyAt('/service/public/stream', cookie), 'data: ' + copy + '\n\n');
        assert.deepEqual(await upgrade(port, cookie), { status: 101, copy });
        for (const [taskId, owner] of [['prior-task', 'old'], ['canary.rollout-1.0123456789abcdef', 'canary']]) {
            assert.deepEqual(JSON.parse(await bodyAt('/service/task?taskId=' + taskId, cookie)), { id: taskId, copy: owner });
        }
    }
    const publicPage = await fetchPath('/service/public/index.html');
    assert.equal(publicPage.status, 200);
    assert.equal(publicPage.headers.has('set-cookie'), false);
    assert.equal(publicPage.headers.has('location'), false);
    assert.ok((await publicPage.text()).endsWith('old'));
    assert.equal(await bodyAt('/service/guest/page'), 'old');
    const retired = await fetchPath('/service/task?taskId=canary.previous.0123456789abcdef', cookies.tester);
    assert.equal(retired.status, 404);

    async function rpc(cookie, method, headers = {}) {
        const res = await fetchPath('/service/mcp', cookie, { method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params: method === 'tools/call' ? { name: tool, arguments: args } : {} }),
        });
        const payload = await res.json();
        assert.equal(res.status, 200, JSON.stringify(payload));
        assert.equal(payload.error, undefined, JSON.stringify(payload.error));
        return method === 'initialize' ? res.headers.get('mcp-session-id') : JSON.parse(payload.result.content[0].text);
    }
    const sessions = {};
    for (const id of Object.keys(cookies)) sessions[id] = await rpc(cookies[id], 'initialize');
    for (let round = 0; round < 2; round++) {
        await Promise.all((round ? ['reader', 'tester'] : ['tester', 'reader']).map(async id => {
            const response = await rpc(cookies[id], 'tools/call', { 'mcp-session-id': sessions[id] });
            assert.deepEqual(response, id === 'tester' ? { copy: 'canary', args } : { copy: 'old', args: { common: 'shared' } });
        }));
    }
    assert.equal(pool.snapshot().entries.length, 2);
    for (const [id, copy] of [['tester', 'canary'], ['reader', 'old']]) {
        const assertion = signAgentAssertion({ targetAgent: routeKey, tool, argumentsObj: args,
            env: { PLOINKY_AGENT_ID: source, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(source) } });
        const { token } = mintUserDelegationGrant({ sourceAgentId: source, targetAgentId: principal, tools: [tool],
            scopes: ['inspect'], route: { routeKey: 'caller', pathPrefix: '/caller', requestPath: '/caller' },
            user: { id, roles: ['user'] }, signingSecret: deriveSubkey('router-user-delegation', 32) });
        const result = await rpc('', 'tools/call', { authorization: 'Bearer ' + assertion, 'x-ploinky-user-delegation': token });
        assert.equal(result.copy, copy);
    }
    assert.equal(dials.filter(dial => dial.tool === tool).length, 6);

    const streams = [];
    const sockets = [];
    try {
        for (const [id, copy] of [['tester', 'canary'], ['reader', 'old']]) {
            const res = await new Promise((resolve, reject) =>
                http.get(origin + '/service/public/stream?hold', { headers: { cookie: cookies[id] } }, resolve).on('error', reject));
            streams.push(res);
            assert.equal(String((await once(res, 'data'))[0]), 'data: ' + copy + '\n\n');
            const upgraded = await upgrade(port, cookies[id], true);
            assert.equal(upgraded.copy, copy);
            sockets.push(upgraded.socket);
        }
        const timeout = { signal: AbortSignal.timeout(3000) };
        // Node reports an aborted HTTP stream as an error before its close.
        streams[0].on('error', () => {});
        const closed = [
            once(streams[0], 'aborted', timeout), once(sockets[0], 'close', timeout),
        ];
        for (let i = 0; i < 3; i++) signals.recordProbe(routeKey, rolloutId, { ok: false });
        await Promise.all(closed);
        assert.equal(streams[1].destroyed, false);
        assert.equal(sockets[1].destroyed, false);
        assert.equal(signals.resume(routeKey, rolloutId), true);
    } finally {
        for (const stream of streams) stream.destroy();
        for (const socket of sockets) socket.destroy();
    }

    const cases = [
        ['relay', '/base-agent-additional-server/service/8787/page', 'old'],
        ['static', '/service/public/asset.js', 'asset-old'],
        ['passthrough', '/service/public/page', 'old'],
        ['websocket', null, 'old'],
        ['task', '/service/task?taskId=canary.rollout-1.0123456789abcdef', 'canary'],
        ['pooled', '/service/mcp', 'old'],
    ];
    for (const [site, resource, expected] of cases) {
        for (const limit of [1, 2]) {
            if (signals.routingState(routeKey, rolloutId).state === 'tripped') signals.resume(routeKey, rolloutId);
            race = { site, limit, changes: 0 };
            const before = dials.length;
            const start = relayProofs.length;
            let status, body;
            if (site === 'websocket') {
                const result = await upgrade(port, cookies.tester);
                status = result.status === 101 ? 200 : result.status;
                body = result.copy;
            } else {
                const options = site !== 'pooled' ? {} : { method: 'POST', headers: {
                    'mcp-session-id': sessions.tester, 'content-type': 'application/json',
                }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: args } }) };
                const result = await fetchPath(resource, cookies.tester, options);
                status = result.status;
                body = await result.text();
                if (status === 200 && site === 'task') body = JSON.parse(body).copy;
                if (status === 200 && site === 'pooled') body = JSON.parse(JSON.parse(body).result.content[0].text).copy;
            }
            assert.equal(race.changes, limit, site + ' changes, response ' + body);
            assert.equal(status, limit === 1 ? 200 : 503, site + ' response ' + body);
            if (limit === 1) assert.equal(body, expected, site);
            if (site === 'relay') assert.deepEqual(relayProofs.slice(start), ['canary', 'old']);
            if (['task', 'pooled'].includes(site)) assert.equal(dials.length - before, limit === 1 ? 1 : 0, site);
        }
    }
    race = null;
    route.draining = true;
    route.canary.mode = 'all';
    delete route.hostPort;
    write(path.join(state, 'routing.json'), { routes: { service: route } });
    apply();
    await checkAgentOnlyOpenAi('canary', 'POST');
    await checkAgentOnlyOpenAi('canary', 'GET');
    assert.equal(await bodyAt('/service/public/page', cookies.reader), 'canary');
    assert.equal(await bodyAt('/base-agent-additional-server/service/8787/page', cookies.reader), 'canary');
    const publicPlan = resolveEdgeRoutePlan({ req: { method: 'GET', headers: { host: publicHost }, url: '/public/page' } });
    assert.equal(publicPlan.ok, true, publicPlan.code);
    assert.equal(publicPlan.kind, 'agent-root');
    assert.equal(publicPlan.target.hostPort, identities.canary.hostPort);
    const aggregated = await fetchPath('/mcp', cookies.reader, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'tool', agent: routeKey, tool, arguments: args }) });
    const result = await aggregated.json();
    assert.equal(aggregated.status, 200, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.result.content[0].text), { copy: 'canary', args });
    const [card] = selectAgentCardCandidates(publicPlan, {});
    assert.equal(card.selection.copy, 'canary');
    const reply = await requestAgentCard(card.selection.route, card.agentName, {}, {
        selection: card.selection, beforeDial: () => publicPlan.lease.commit(),
    });
    assert.deepEqual(reply.agent.payload, { copy: 'canary' });
});
