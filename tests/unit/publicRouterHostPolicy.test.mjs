import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

process.env.PLOINKY_MASTER_KEY ||= 'c'.repeat(64);

const {
    PUBLIC_ROUTER_HOSTS_ENV,
    isTrustedPublicRouterHost,
    normalizePublicRouterHost,
    parsePublicRouterHosts,
    readPublicRouterHosts,
    serializePublicRouterHosts,
} = await import('../../cli/utils/publicRouterHosts.mjs');
const { applyEdgeRoutingGeneration } = await import('../../cli/sandbox/edgeGeneration.js');
const { resolveEdgeRoutePlan } = await import('../../cli/server/edgeRoutePlan.js');
const {
    canonicalControlOrigin,
    mintAdminCsrfToken,
    verifyAdminMutationRequest,
} = await import('../../cli/server/adminControlSecurity.js');
const {
    BROWSER_CSRF_HEADER,
    mintBrowserCsrfToken,
    verifyBrowserMutationRequest,
} = await import('../../cli/server/browserMutationSecurity.js');
const { sanitizeResponseHeaders } = await import('../../cli/server/proxy/sanitizeResponseHeaders.js');
const { executeWebSocketPlan } = await import('../../cli/server/proxy/executeWebSocketPlan.js');
const {
    RESERVED_AGENT_ENV_NAMES,
    stripReservedAgentEnv,
} = await import('../../cli/utils/security/agentIdentityEnv.js');

const LAN_ORIGIN = 'http://192.168.1.63:18080';

function setEnv(t, name, value) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
    });
}

function trustHosts(t, hosts) {
    setEnv(
        t,
        PUBLIC_ROUTER_HOSTS_ENV,
        hosts === undefined || typeof hosts === 'string' ? hosts : serializePublicRouterHosts(hosts),
    );
}

function routedWorkspace(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-public-router-hosts-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const alphaDir = path.join(ploinkyDir, 'repos', 'fixtures', 'alpha');
    fs.mkdirSync(edgeDir, { recursive: true });
    fs.mkdirSync(policyDir, { recursive: true });
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.writeFileSync(path.join(alphaDir, 'manifest.json'), JSON.stringify({
        ploinky: 'sso enable',
        routerAccess: {
            httpRoutes: [{ path: '/base-agent-additional-server/alpha/7000/*', access: 'authenticated' }],
        },
    }));
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        static: { agent: 'alpha', port: 7777 },
        routes: {
            alpha: {
                repo: 'fixtures',
                agent: 'alpha',
                container: 'alpha-container',
                hostPath: alphaDir,
                hostPort: 43101,
            },
        },
    }));
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        'alpha-container': {
            type: 'agent',
            repoName: 'fixtures',
            agentName: 'alpha',
            instanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
            runtime: 'podman',
            containerId: 'a'.repeat(64),
            auth: { mode: 'sso' },
        },
    }));
    fs.writeFileSync(path.join(edgeDir, 'desired.json'), JSON.stringify({ hosts: {} }));
    fs.writeFileSync(path.join(policyDir, 'policy-state.json'), JSON.stringify({
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    }));
    setEnv(t, 'PLOINKY_WORKSPACE_ROOT', workspace);
    setEnv(t, 'PLOINKY_ROUTER_HOST_PORT', '18080');
    setEnv(t, 'PLOINKY_MEDIA_HOST_PORT', '17891');
    applyEdgeRoutingGeneration({
        workspaceRoot: workspace,
        reason: 'public-router-host-policy',
        publicationState: 'ready',
    });
    return workspace;
}

function plan({ host, url = '/alpha/index.html', listener = 'public', headers = {}, transport = 'http' }) {
    return resolveEdgeRoutePlan({
        req: {
            method: 'GET',
            url,
            headers: { host, ...headers },
            ...(listener === 'private' ? { ploinkyListenerClass: 'private' } : {}),
        },
        listener,
        transport,
    });
}

test('outer Router host names admit only usable IPv4 literals and DNS names', () => {
    assert.equal(normalizePublicRouterHost('192.168.1.50'), '192.168.1.50');
    assert.equal(normalizePublicRouterHost('100.76.22.69'), '100.76.22.69');
    assert.equal(normalizePublicRouterHost('Spark-1234.Local'), 'spark-1234.local');
    for (const value of [
        '', ' 192.168.1.50', '192.168.1.50:8083', '192.168.001.50', '192.168.1', '0x7f.1', '1.2.3.4.5',
        '127.0.0.1', '0.0.0.0', '169.254.1.2', '::1', '[::1]', 'fe80::1', 'user@host', 'host/path',
        '*.example.test', '*', 'bad_name', 'trailing.', 'localhost', 'router.localhost',
        'host.containers.internal', 'host.docker.internal', 'a'.repeat(64), 42, null,
    ]) {
        assert.equal(normalizePublicRouterHost(value), null, JSON.stringify(value));
    }
});

test('the trusted host environment value must be one canonical bounded JSON array', () => {
    const text = serializePublicRouterHosts(['spark.local', '192.168.1.50', '10.0.0.5', 'SPARK.local', 'apparatus']);
    assert.equal(text, '["10.0.0.5","192.168.1.50","apparatus","spark.local"]');
    assert.deepEqual(parsePublicRouterHosts(text), ['10.0.0.5', '192.168.1.50', 'apparatus', 'spark.local']);
    assert.equal(serializePublicRouterHosts([]), '[]');
    for (const invalid of [
        '["192.168.1.50", "10.0.0.5"]',
        '["192.168.1.50","10.0.0.5"]',
        '["apparatus","apparatus"]',
        '["Apparatus"]',
        '{"hosts":[]}',
        '"192.168.1.50"',
        'not json',
        '[1]',
        '["0.0.0.0"]',
        '["localhost"]',
        '["192.168.1.50:8083"]',
        JSON.stringify(Array.from({ length: 65 }, (_, index) => `h${String(index).padStart(2, '0')}.example.test`)),
    ]) {
        assert.throws(
            () => parsePublicRouterHosts(invalid),
            { code: 'PLOINKY_PUBLIC_ROUTER_HOSTS_INVALID' },
            invalid,
        );
    }
});

test('runtime lookup trusts exact entries only and fails closed on malformed state', () => {
    const env = { [PUBLIC_ROUTER_HOSTS_ENV]: '["192.168.1.50","spark.local"]' };
    assert.equal(isTrustedPublicRouterHost('192.168.1.50', env), true);
    assert.equal(isTrustedPublicRouterHost('spark.local', env), true);
    for (const host of ['192.168.1.5', '192.168.1.500', 'spark.local.attacker.test', 'attacker.test', '', 'SPARK.LOCAL']) {
        assert.equal(isTrustedPublicRouterHost(host, env), false, host);
    }
    assert.equal(isTrustedPublicRouterHost('192.168.1.50', {}), false);
    const malformed = { [PUBLIC_ROUTER_HOSTS_ENV]: '["attacker.test", "192.168.1.50"]' };
    assert.equal(isTrustedPublicRouterHost('attacker.test', malformed), false);
    assert.equal(isTrustedPublicRouterHost('192.168.1.50', malformed), false);
    assert.match(readPublicRouterHosts(malformed).error, /sorted, unique/);
    assert.equal(isTrustedPublicRouterHost('*', { [PUBLIC_ROUTER_HOSTS_ENV]: '["*"]' }), false);
});

test('an exact trusted LAN Host reaches the public control surface with its own authority', (t) => {
    routedWorkspace(t);
    trustHosts(t, undefined);
    const before = plan({ host: '192.168.1.63:18080' });
    assert.equal(before.status, 421);
    assert.equal(before.code, 'UNKNOWN_HOST');

    process.env[PUBLIC_ROUTER_HOSTS_ENV] = serializePublicRouterHosts(['192.168.1.63', 'apparatus.local']);
    const lan = plan({ host: '192.168.1.63:18080' });
    assert.equal(lan.ok, true);
    assert.equal(lan.kind, 'agent-root');
    assert.equal(lan.decision.access, 'authenticated');
    assert.deepEqual(lan.hostSelection, { kind: 'control', host: '192.168.1.63', source: 'public-router-alias' });
    assert.deepEqual(lan.forwarding, { authority: '192.168.1.63:18080', protocol: 'http' });

    const named = plan({ host: 'apparatus.local:18080' });
    assert.equal(named.ok, true);
    assert.deepEqual(named.forwarding, { authority: 'apparatus.local:18080', protocol: 'http' });

    const loopback = plan({ host: '127.0.0.1:18080' });
    assert.deepEqual(loopback.hostSelection, { kind: 'control', host: '127.0.0.1' });

    // The Router serves its own pages for a control-host miss, as on loopback.
    const controlMiss = plan({ host: '192.168.1.63:18080', url: '/' });
    assert.equal(controlMiss.code, 'ROUTE_NOT_FOUND');
    assert.equal(controlMiss.hostSelection.kind, 'control');
});

test('unknown, malformed-policy, private, managed, and forged-header Hosts stay rejected', (t) => {
    routedWorkspace(t);
    trustHosts(t, ['192.168.1.63']);
    for (const host of ['192.168.1.64:18080', 'attacker.test', '192.168.1.63.attacker.test', 'apparatus', '0.0.0.0:18080']) {
        const denied = plan({ host });
        assert.equal(denied.ok, false, host);
        assert.equal(denied.code, 'UNKNOWN_HOST', host);
    }
    const privateListener = plan({
        host: '192.168.1.63:8081',
        url: '/api/edge/turn-credentials',
        listener: 'private',
    });
    assert.equal(privateListener.code, 'UNKNOWN_HOST');
    const managedListener = plan({ host: '192.168.1.63:8080', listener: 'managed' });
    assert.equal(managedListener.code, 'UNKNOWN_HOST');

    const forgedTarget = plan({
        host: 'attacker.test',
        headers: { 'x-forwarded-host': '192.168.1.63:18080', forwarded: 'host=192.168.1.63:18080' },
    });
    assert.equal(forgedTarget.code, 'UNKNOWN_HOST');
    const forgedAuthority = plan({
        host: '192.168.1.63:18080',
        headers: { 'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'https' },
    });
    assert.deepEqual(forgedAuthority.forwarding, { authority: '192.168.1.63:18080', protocol: 'http' });

    process.env[PUBLIC_ROUTER_HOSTS_ENV] = '["192.168.1.63", "attacker.test"]';
    assert.equal(plan({ host: '192.168.1.63:18080' }).code, 'UNKNOWN_HOST');
    assert.equal(plan({ host: 'attacker.test' }).code, 'UNKNOWN_HOST');
});

test('agent-port plans and WebSocket upgrades admit only the exact trusted LAN origin', async (t) => {
    routedWorkspace(t);
    trustHosts(t, ['192.168.1.63']);
    const url = '/base-agent-additional-server/alpha/7000/socket';
    const httpPlan = plan({ host: '192.168.1.63:18080', url });
    assert.equal(httpPlan.ok, true);
    assert.equal(httpPlan.kind, 'agent-port');
    assert.equal(httpPlan.origin, LAN_ORIGIN);
    assert.equal(httpPlan.authority, '192.168.1.63:18080');
    assert.deepEqual(httpPlan.originPolicy.allowedOrigins, [LAN_ORIGIN]);

    const websocketPlan = plan({ host: '192.168.1.63:18080', url, transport: 'websocket' });
    class Socket extends Writable {
        constructor() { super(); this.body = ''; }
        _write(chunk, _encoding, callback) { this.body += String(chunk); callback(); }
    }
    async function upgrade(origin) {
        const socket = new Socket();
        let checkouts = 0;
        const handled = await executeWebSocketPlan({
            req: {
                method: 'GET',
                headers: {
                    host: '192.168.1.63:18080',
                    origin,
                    connection: 'Upgrade',
                    upgrade: 'websocket',
                    'sec-websocket-version': '13',
                    'sec-websocket-key': Buffer.alloc(16, 9).toString('base64'),
                },
            },
            socket,
            plan: websocketPlan,
            lease: { release() {} },
            relayManager: {
                async checkout() {
                    checkouts += 1;
                    return {
                        openRequest: async () => {
                            throw Object.assign(new Error('fixture stops after origin admission'), {
                                code: 'EDGE_GENERATION_CHANGED',
                            });
                        },
                        close() {},
                    };
                },
            },
            authorized: true,
        });
        return { handled, checkouts, body: socket.body };
    }
    for (const origin of ['http://attacker.test', 'http://127.0.0.1:18080', 'https://192.168.1.63:18080', 'http://192.168.1.63:18081']) {
        const rejected = await upgrade(origin);
        assert.equal(rejected.handled, false, origin);
        assert.equal(rejected.checkouts, 0, origin);
        assert.match(rejected.body, /^HTTP\/1\.1 403 /, origin);
    }
    const admitted = await upgrade(LAN_ORIGIN);
    assert.equal(admitted.checkouts, 1);
    assert.match(admitted.body, /^HTTP\/1\.1 503 /);
});

test('admin and browser mutation proofs bind to the exact trusted LAN origin', (t) => {
    trustHosts(t, ['192.168.1.51', '192.168.1.63']);
    const request = (host, headers = {}) => ({
        url: '/dashboard/',
        method: 'POST',
        headers: { host, ...headers },
        socket: { encrypted: false },
        user: { id: 'local:admin', username: 'admin', roles: ['user', 'admin'] },
        sessionId: 'session-lan',
    });
    const lan = request('192.168.1.63:8083', { origin: 'http://192.168.1.63:8083' });
    assert.equal(canonicalControlOrigin(lan), 'http://192.168.1.63:8083');
    lan.headers['x-ploinky-csrf-token'] = mintAdminCsrfToken({ sessionId: lan.sessionId, req: lan });
    assert.deepEqual(verifyAdminMutationRequest(lan), { ok: true, origin: 'http://192.168.1.63:8083' });
    for (const origin of ['http://127.0.0.1:8083', 'http://attacker.test', 'http://192.168.1.63:8084', 'https://192.168.1.63:8083']) {
        assert.equal(verifyAdminMutationRequest({ ...lan, headers: { ...lan.headers, origin } }).code, 'CONTROL_ORIGIN_REQUIRED', origin);
    }
    const loopback = request('127.0.0.1:8083', { origin: 'http://127.0.0.1:8083' });
    const loopbackToken = mintAdminCsrfToken({ sessionId: loopback.sessionId, req: loopback });
    assert.equal(verifyAdminMutationRequest({
        ...lan,
        headers: { ...lan.headers, 'x-ploinky-csrf-token': loopbackToken },
    }).code, 'CSRF_INVALID');
    assert.equal(verifyAdminMutationRequest({
        ...lan,
        headers: { ...lan.headers, 'x-forwarded-host': 'attacker.test' },
    }).code, 'CONTROL_ORIGIN_REQUIRED');
    // URL parsing maps 192.168.1.063 to 192.168.1.51; only canonical spelling counts.
    assert.equal(canonicalControlOrigin(request('192.168.1.063:8083')), null);
    assert.equal(canonicalControlOrigin(request('192.168.1.51:8083')), 'http://192.168.1.51:8083');
    for (const host of ['apparatus:8083', '192.168.1.64:8083', '192.168.1.63@attacker.test']) {
        assert.equal(canonicalControlOrigin(request(host)), null, host);
    }
    process.env[PUBLIC_ROUTER_HOSTS_ENV] = 'not json';
    assert.equal(canonicalControlOrigin(request('192.168.1.63:8083')), null);
    process.env[PUBLIC_ROUTER_HOSTS_ENV] = serializePublicRouterHosts(['192.168.1.63']);

    const routePlan = {
        forwarding: { protocol: 'http', authority: '192.168.1.63:8083' },
        hostSelection: { kind: 'control', host: '192.168.1.63', source: 'public-router-alias' },
        snapshot: { generation: 'edge-generation-lan' },
        lease: { id: 'edge-generation-lan' },
    };
    const browser = { headers: { host: '192.168.1.63:8083', origin: 'http://192.168.1.63:8083' }, socket: { encrypted: false } };
    browser.headers[BROWSER_CSRF_HEADER] = mintBrowserCsrfToken({ req: browser, routePlan, sessionId: 'session-lan' });
    assert.equal(verifyBrowserMutationRequest(browser, { routePlan, sessionId: 'session-lan' }).ok, true);
    browser.headers.origin = 'http://127.0.0.1:8083';
    assert.equal(
        verifyBrowserMutationRequest(browser, { routePlan, sessionId: 'session-lan' }).code,
        'BROWSER_ORIGIN_REQUIRED',
    );
});

test('redirects survive only when they return to the exact admitted origin', () => {
    const lanPlan = { origin: LAN_ORIGIN, responsePolicy: { allowRedirects: true } };
    const kept = `${LAN_ORIGIN}/base-agent-additional-server/alpha/7000/login?next=%2F`;
    assert.equal(sanitizeResponseHeaders({ location: kept }, lanPlan).location, kept);
    assert.equal(sanitizeResponseHeaders({ location: '/relative/login' }, lanPlan).location, '/relative/login');
    for (const location of [
        'http://192.168.1.64:18080/other-host',
        'http://192.168.1.63:9999/other-port',
        'https://192.168.1.63:18080/other-scheme',
        'http://user:secret@192.168.1.63:18080/credentials',
        // The trusted origin as userinfo cannot smuggle another private host.
        'http://192.168.1.63:18080@10.0.0.5/confusable',
        'http://127.0.0.1:7000/private',
        'http://apparatus:18080/single-label',
        'http://apparatus.local:18080/mdns',
        'http://[fd00::1]:18080/private-ipv6',
    ]) {
        assert.equal(sanitizeResponseHeaders({ location }, lanPlan).location, undefined, location);
    }
    assert.equal(sanitizeResponseHeaders({ location: kept }, { origin: LAN_ORIGIN, responsePolicy: {} }).location, undefined);
    const namedPlan = { origin: 'http://apparatus.local:18080', responsePolicy: { allowRedirects: true } };
    assert.equal(
        sanitizeResponseHeaders({ location: 'http://apparatus.local:18080/login' }, namedPlan).location,
        'http://apparatus.local:18080/login',
    );
});

test('agent configuration cannot inject trusted outer Router hosts', () => {
    assert.equal(RESERVED_AGENT_ENV_NAMES.includes(PUBLIC_ROUTER_HOSTS_ENV), true);
    const agentEnvironment = { SAFE: 'kept', [PUBLIC_ROUTER_HOSTS_ENV]: '["attacker.test"]' };
    stripReservedAgentEnv(agentEnvironment);
    assert.deepEqual(agentEnvironment, { SAFE: 'kept' });
    // Workspace .env and secret files are agent-writable; only the Box
    // environment may supply the Router's trusted list.
    const workspaceUtil = fs.readFileSync(new URL('../../cli/commands/workspaceUtil.js', import.meta.url), 'utf8');
    assert.match(workspaceUtil, /\[PUBLIC_ROUTER_HOSTS_ENV\]: _envFileHosts, \.\.\.fileEnvironment \} = envFile;/);
    assert.match(workspaceUtil, /\[PUBLIC_ROUTER_HOSTS_ENV\]: _secretHosts, \.\.\.secretEnvironment \} = secrets;/);
    assert.match(workspaceUtil, /\{ \.\.\.fileEnvironment, \.\.\.secretEnvironment, \.\.\.process\.env \}/);
});
