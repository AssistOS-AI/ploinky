import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { applyEdgeRoutingGeneration, initializeFreshEdgeRoutingSources } from '../../cli/sandbox/edgeGeneration.js';
import { httpAccessForEdgeRoutePlan, resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import { executeHttpPlan } from '../../cli/server/proxy/executeHttpPlan.js';
import { PLOINKY_RATE_SOURCE_HEADER, buildHttpRouteRateSourceHeader } from '../../cli/server/routerHandlers.js';

// Every plan here comes from resolveEdgeRoutePlan, never from a hand-built object, so a plan shape the rate-source
// builder does not read shows up as a failing case. The Router's own call sites (RoutingServer.js) are not exercised:
// the proxy cases pass the builder's result the way those call sites do.
const PREFIX = '/base-agent-additional-server/alpha/7001';
const LOCAL_HOST = '127.0.0.1:18080';
const PUBLISHED_HOST = 'published.synthetic.test';
const CLIENT_SUPPLIED = 'f'.repeat(64);
const SOURCE = /^[0-9a-f]{64}$/;

function routedWorkspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-rate-source-')));
    const environment = {
        PLOINKY_WORKSPACE_ROOT: root,
        PLOINKY_MASTER_KEY: '5'.repeat(64),
        PLOINKY_ROUTER_HOST_PORT: '18080',
        PLOINKY_MEDIA_HOST_PORT: '17891',
    };
    const saved = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
    Object.assign(process.env, environment);
    t.after(() => {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const options = { workspaceRoot: root };
    const { paths } = initializeFreshEdgeRoutingSources(options);
    const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
    const hostPath = path.join(root, 'fixtures', 'alpha');
    fs.mkdirSync(hostPath, { recursive: true });
    write(path.join(hostPath, 'manifest.json'), {
        routerAccess: { httpRoutes: [
            { path: `${PREFIX}/intake/*`, access: 'guest' },
            { path: `${PREFIX}/open/*`, access: 'public' },
            { path: `${PREFIX}/account/*`, access: 'authenticated' },
        ] },
    });
    write(paths.routingFile, { routes: {
        alpha: { repo: 'fixtures', agent: 'alpha', container: 'alpha-container', hostPath, hostPort: 43101 },
    } });
    write(paths.agentsFile, { 'alpha-container': {
        type: 'agent', repoName: 'fixtures', agentName: 'alpha', instanceId: 'alpha-instance',
        enableGeneration: 'alpha-enable', runtime: 'podman', containerId: 'a'.repeat(64), auth: { mode: 'sso' },
    } });
    write(paths.desiredFile, {
        hosts: { [PUBLISHED_HOST]: { agent: 'fixtures/alpha', dnsManagement: 'external' } },
        cloudflare: {
            accountId: 'fixture-account', zoneId: 'fixture-zone', tunnelName: 'fixture-tunnel',
            apiTokenSecret: 'publication/fixture-api', deleteTunnelOnTeardown: true,
        },
    });
    applyEdgeRoutingGeneration({ ...options, publicationState: 'ready' });
}

function request({ method = 'POST', suffix = '/intake/submit', host = LOCAL_HOST, peer = '198.51.100.7', headers = {}, user } = {}) {
    return Object.assign(Readable.from([]), {
        method,
        url: `${PREFIX}${suffix}`,
        headers: { host, ...headers },
        socket: { remoteAddress: peer },
        ...(user ? { user } : {}),
    });
}

function published(address, peer = '10.0.0.1') {
    return request({ host: PUBLISHED_HOST, peer, headers: address === undefined ? {} : { 'cf-connecting-ip': address } });
}

function planFor(req, transport = 'http') {
    const plan = resolveEdgeRoutePlan({ req, listener: 'public', transport });
    assert.equal(plan.ok, true, plan.code);
    assert.equal(plan.kind, 'agent-port');
    return plan;
}

function sourceOf(req, transport = 'http') {
    return buildHttpRouteRateSourceHeader(req, planFor(req, transport))[PLOINKY_RATE_SOURCE_HEADER];
}

class Response extends Writable {
    constructor() { super(); this.statusCode = 0; this.headersSent = false; }
    writeHead(status) { this.statusCode = status; this.headersSent = true; }
    _write(_chunk, _encoding, done) { done(); }
}

// Runs the request through the proxy with the builder's result passed the way the Router passes it. `handed` is the
// header set given to the relay, which is what the agent receives; the relay stops there, so no upstream connection is
// opened and `status` is then the proxy's answer to that stop. `checkouts` counts how often the relay was asked for.
async function proxied(req) {
    const plan = planFor(req);
    const res = new Response();
    let handed = null;
    let checkouts = 0;
    await executeHttpPlan({
        req, res, plan, lease: plan.lease, authorized: true, prebufferedBody: Buffer.alloc(0),
        trustedHeadersFactory: () => ({ applicationHeaders: buildHttpRouteRateSourceHeader(req, plan) }),
        relayManager: { checkout: async () => {
            checkouts += 1;
            return {
                openRequest: async ({ headers }) => { handed = headers; throw new Error('headers captured; no upstream'); },
                close() {},
            };
        } },
    });
    return { handed, checkouts, status: res.statusCode };
}

test('a guest route on an agent port reaches the agent with a Router-built rate source', async t => {
    routedWorkspace(t);
    const req = request({ headers: { [PLOINKY_RATE_SOURCE_HEADER]: CLIENT_SUPPLIED } });
    assert.equal(httpAccessForEdgeRoutePlan(planFor(req)).access, 'guest');

    const { handed, checkouts } = await proxied(req);
    assert.equal(checkouts, 1);
    assert.match(handed[PLOINKY_RATE_SOURCE_HEADER], SOURCE);
    assert.notEqual(handed[PLOINKY_RATE_SOURCE_HEADER], CLIENT_SUPPLIED);
    assert.equal(handed[PLOINKY_RATE_SOURCE_HEADER], sourceOf(req));
    assert.equal(handed['x-forwarded-prefix'], PREFIX);
});

test('public and authenticated routes carry no rate source, and a client-supplied one never passes', async t => {
    routedWorkspace(t);
    const supplied = { [PLOINKY_RATE_SOURCE_HEADER]: CLIENT_SUPPLIED };
    const cases = [
        ['public', request({ method: 'GET', suffix: '/open/status', headers: supplied })],
        ['authenticated', request({
            suffix: '/account/profile', headers: supplied,
            user: { id: 'member-1', username: '', email: 'member@example.test', roles: ['user'] },
        })],
    ];
    for (const [access, req] of cases) {
        const plan = planFor(req);
        assert.equal(httpAccessForEdgeRoutePlan(plan).access, access);
        assert.deepEqual(buildHttpRouteRateSourceHeader(req, plan), {}, access);
        const { handed, checkouts } = await proxied(req);
        assert.equal(checkouts, 1, access);
        assert.equal(handed[PLOINKY_RATE_SOURCE_HEADER], undefined, access);
    }
});

test('the rate source is stable for one transport source and differs between sources', t => {
    routedWorkspace(t);
    const first = sourceOf(request({ peer: '198.51.100.7' }));
    assert.match(first, SOURCE);
    assert.equal(sourceOf(request({ peer: '198.51.100.7', suffix: '/intake/other' })), first);
    assert.equal(sourceOf(request({ peer: '::ffff:198.51.100.7' })), first);
    assert.notEqual(sourceOf(request({ peer: '198.51.100.8' })), first);
});

test('a WebSocket plan for a guest route gets the same rate source as its HTTP plan', t => {
    routedWorkspace(t);
    const upgrade = () => request({ method: 'GET', suffix: '/intake/live' });
    assert.equal(httpAccessForEdgeRoutePlan(planFor(upgrade(), 'websocket')).access, 'guest');
    const overWebSocket = sourceOf(upgrade(), 'websocket');
    assert.match(overWebSocket, SOURCE);
    assert.equal(overWebSocket, sourceOf(upgrade()));
});

test('a published host takes the source from the connector header, not from the TCP peer', t => {
    routedWorkspace(t);
    const plan = planFor(published('203.0.113.7'));
    assert.equal(plan.hostSelection.source, 'public-host');
    assert.equal(httpAccessForEdgeRoutePlan(plan).access, 'guest');

    const first = sourceOf(published('203.0.113.7'));
    assert.match(first, SOURCE);
    // The connector's peer address is the same for every visitor and takes no part.
    assert.equal(sourceOf(published('203.0.113.7', '10.0.0.2')), first);
    assert.notEqual(sourceOf(published('203.0.113.8')), first);
    // The same address seen as a local TCP peer is a different partition.
    assert.notEqual(sourceOf(request({ peer: '203.0.113.7' })), first);
});

test('a guest request on a published host without a usable connector source is answered 400 and never reaches the relay', async t => {
    routedWorkspace(t);
    for (const address of [undefined, '', 'not-an-address', '203.0.113.7, 203.0.113.8']) {
        const label = JSON.stringify(address ?? null);
        const { handed, checkouts, status } = await proxied(published(address));
        assert.equal(status, 400, label);
        assert.equal(checkouts, 0, label);
        assert.equal(handed, null, label);
    }
    // The same request with a usable source is proxied.
    const accepted = await proxied(published('203.0.113.7'));
    assert.equal(accepted.checkouts, 1);
    assert.match(accepted.handed[PLOINKY_RATE_SOURCE_HEADER], SOURCE);
});

test('a local guest request whose TCP peer address is missing or malformed is answered 400 and never reaches the relay', async t => {
    routedWorkspace(t);
    for (const peer of [null, '', 'not-an-address']) {
        const label = JSON.stringify(peer);
        // A connector header on a local host is ignored, so it cannot stand in for the missing peer address.
        const { handed, checkouts, status } = await proxied(request({ peer, headers: { 'cf-connecting-ip': '203.0.113.7' } }));
        assert.equal(status, 400, label);
        assert.equal(checkouts, 0, label);
        assert.equal(handed, null, label);
    }
});
