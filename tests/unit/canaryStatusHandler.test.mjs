import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';

// Run the Router's complete private request processor without opening a listener.
// As in mcpBrowserClientStreamCleanup.test.mjs, read the function from the Router.
const source = fs.readFileSync(new URL('../../cli/server/RoutingServer.js', import.meta.url), 'utf8');
function functionSource(start, next) {
    const from = source.indexOf(start);
    const end = source.indexOf(next, from);
    assert.ok(from >= 0 && end > from);
    return source.slice(from, end);
}

test('canary status authorization at Router dispatch', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-status-'));
    const previousCwd = process.cwd();
    process.chdir(root);
    const alias = 'canary-console.example.test';
    const env = {
        PLOINKY_WORKSPACE_ROOT: root, PLOINKY_ROUTER_HOST_PORT: '18080', PLOINKY_MEDIA_HOST_PORT: '17891',
        PLOINKY_PUBLIC_ROUTER_HOSTS: JSON.stringify([alias]), PLOINKY_MASTER_KEY: randomBytes(32).toString('hex'),
    };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(() => {
        process.chdir(previousCwd);
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const edge = await import('../../cli/sandbox/edgeGeneration.js');
    const { paths } = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: root });
    const hostPath = path.join(root, 'fixture');
    fs.mkdirSync(hostPath);
    fs.writeFileSync(path.join(hostPath, 'manifest.json'), JSON.stringify({ ploinky: 'sso enable' }));
    const route = { repo: 'fixtures', agent: 'owner', container: 'owner', hostPort: 18081, hostPath };
    const routing = { static: { agent: 'owner' }, routes: { owner: route } };
    fs.writeFileSync(paths.routingFile, JSON.stringify(routing));
    fs.writeFileSync(paths.agentsFile, JSON.stringify({ owner: {
        type: 'agent', repoName: 'fixtures', agentName: 'owner', instanceId: 'fixture',
        enableGeneration: 'fixture', auth: { mode: 'sso' },
    } }));
    const apply = () => edge.applyEdgeRoutingGeneration({ workspaceRoot: root });
    apply();
    const { normalizeExactHost, resolveEdgeRoutePlan, commitRouteGeneration } = await import('../../cli/server/edgeRoutePlan.js');
    const { recordRouterAuthorityObservation } = await import('../../cli/server/routerAuthorityAttestationRegistry.js');
    const { ensureAuthenticated } = await import('../../cli/server/authHandlers/authContext.js');
    const { authService, LOCAL_AUTH_COOKIE_NAME, SSO_AUTH_COOKIE_NAME } = await import('../../cli/server/authHandlers/shared.js');
    const { requireAdminControlRequest } = await import('../../cli/server/adminControlSecurity.js');
    const { mintSessionJwt } = await import('../../cli/server/auth/localService.js');
    const { canaryStatus } = await import('../../cli/server/canary/routerSignals.js');
    const { onAuthenticatedRequestDecision } = await import('../../cli/server/auth/authenticatedRequestEvents.mjs');
    const cliToken = mintSessionJwt({ id: 'local:admin', roles: ['admin'] }, 1, { channel: 'cli' });
    t.mock.method(authService, 'isConfigured', () => true);
    t.mock.method(authService, 'validateSession', async id => id === 'fixture-browser'
        ? { user: { id: 'sso:fixture', roles: ['admin'] } } : null);
    const json = functionSource('function sendJsonResponse(', '\nfunction decodePathSegment(');
    const handler = functionSource('async function processRequest(', '\nfunction handleAsyncRequest(');
    const dispatch = vm.runInNewContext(`${json}\n${handler}\nprocessRequest`, {
        Buffer, URL, normalizeExactHost, resolveEdgeRoutePlan, commitRouteGeneration,
        interfaceClassifier: { classify: () => 'public' }, routerAuthorityAttestationRegistry: null,
        recordRouterAuthorityObservation, ensureAuthenticated, requireAdminControlRequest, canaryStatus,
    });
    const url = '/api/router/canary/status';
    const cli = `${LOCAL_AUTH_COOKIE_NAME}=${cliToken}`;
    async function request({ host = 'localhost', cookie = cli, method = 'GET' } = {}) {
        const req = { url, method, socket: { localAddress: '127.0.0.1' }, headers: { host, cookie, accept: 'application/json' } };
        const res = new http.ServerResponse(req);
        let body;
        res.end = chunk => { body = JSON.parse(String(chunk)); };
        await dispatch(req, res);
        assert.equal(res.getHeader('cache-control'), 'no-store');
        return { status: res.statusCode, body, allow: res.getHeader('allow'), req };
    }
    await t.test('local CLI administrator can read the counters', async () => {
        const { status, body, req } = await request();
        assert.equal(status, 200);
        assert.equal(req.authChannel, 'cli');
        assert.deepEqual(body, { rollouts: [], baselines: [] });
    });
    await t.test('authenticated browser administrator is refused', async () => {
        const { status, body, req } = await request({ cookie: `${SSO_AUTH_COOKIE_NAME}=fixture-browser` });
        assert.deepEqual(req.user.roles, ['admin']);
        assert.equal(req.authMode, 'sso');
        assert.equal(status, 403);
        assert.equal(body.error, 'local_cli_session_required');
    });
    await t.test('anonymous request requires authentication', async () => {
        const { status, body } = await request({ cookie: '' });
        assert.equal(status, 401);
        assert.equal(body.error, 'not_authenticated');
    });
    await t.test('authenticated POST is refused', async () => {
        const { status, body, allow } = await request({ method: 'POST' });
        assert.equal(status, 405);
        assert.equal(body.error, 'method_not_allowed');
        assert.equal(allow, 'GET');
    });
    await t.test('configured public control alias is refused', async () => {
        const { status, body } = await request({ host: alias });
        assert.equal(status, 403);
        assert.equal(body.error, 'loopback_control_host_required');
    });
    await t.test('generation replaced after authentication refuses the read', async t => {
        let changed = false;
        t.after(onAuthenticatedRequestDecision(() => {
            route.hostPort++;
            fs.writeFileSync(paths.routingFile, JSON.stringify(routing));
            apply();
            changed = true;
        }));
        const { status, body } = await request();
        assert.ok(changed);
        assert.equal(status, 503);
        assert.equal(body.error, 'edge_generation_changed');
    });
});
