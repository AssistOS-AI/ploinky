import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { register } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import test from 'node:test';

const host = 'cache.example.test';
const rootHost = 'root.cache.example.test';
const agent = 'fixtures/site';
const portMount = '/base-agent-additional-server/site/8787';
const cdn = 'cloudflare-cdn-cache-control';
const browser = 'cache-control';
const pagePolicy = seconds => `max-age=${seconds}, stale-if-error=900`;
const page = { path: '/page', access: 'public', cache: 'page' };
const routes = [page, { path: '/asset', access: 'public', cache: 'immutable' },
    { path: '/plain', access: 'public' }, { path: '/account', access: 'authenticated' }];

function openStream(server) {
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const socket = Duplex.from({ readable: incoming, writable: outgoing });
    Object.assign(socket, { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' });
    server.emit('connection', socket);
    return Duplex.from({ readable: outgoing, writable: incoming });
}

function inMemoryRequest(server, options, callback) {
    return http.request({
        ...options,
        agent: undefined,
        headers: { ...options.headers, connection: 'close' },
        createConnection: () => openStream(server),
    }, callback);
}

function request(server, url, { headers = {}, method = 'GET', body } = {}) {
    return new Promise((resolve, reject) => {
        const req = inMemoryRequest(server, { path: url, method, headers: { host, ...headers } }, async res => {
            try {
                const chunks = [];
                for await (const chunk of res) chunks.push(chunk);
                resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
            } catch (error) {
                reject(error);
            }
        });
        req.once('error', reject);
        req.end(body);
    });
}

function isolateWorkspace(t) {
    const repo = path.resolve(import.meta.dirname, '../..');
    const tmp = path.resolve(os.tmpdir());
    const root = fs.mkdtempSync(path.join(tmp.startsWith(repo + path.sep) ? tmp : repo, '.cache-dispatch-'));
    const environment = {
        PLOINKY_WORKSPACE_ROOT: root,
        PLOINKY_ROUTER_HEALTH_SOCKET: path.join(root, 'health.sock'),
        PLOINKY_MASTER_KEY: randomBytes(32).toString('hex'),
        PLOINKY_SSO_SESSION_PERSISTENCE: 'off',
        PLOINKY_ROUTER_HOST_PORT: '18080',
        PLOINKY_MEDIA_HOST_PORT: '17891',
    };
    const saved = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    Object.assign(process.env, environment);
    t.after(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}

async function generationFixture(root) {
    const edge = await import('../../cli/sandbox/edgeGeneration.js');
    const { paths } = edge.initializeFreshEdgeRoutingSources({ workspaceRoot: root });
    const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
    const site = path.join(root, 'fixtures/site');
    const owner = path.join(root, 'fixtures/owner');
    fs.mkdirSync(site, { recursive: true });
    fs.mkdirSync(owner, { recursive: true });
    write(path.join(owner, 'manifest.json'), {});
    write(paths.routingFile, { routes: {
        site: { repo: 'fixtures', agent: 'site', container: 'site-fixture', hostPath: site, hostPort: 43102 },
        owner: { repo: 'fixtures', agent: 'owner', container: 'owner-fixture', hostPath: owner, hostPort: 43101 },
    } });
    write(paths.agentsFile, { 'site-fixture': {
        type: 'agent', repoName: 'fixtures', agentName: 'site', instanceId: 'site-instance',
        enableGeneration: 'site-enable', runtime: 'podman', containerId: 'a'.repeat(64), auth: { mode: 'sso' },
    }, 'owner-fixture': {
        type: 'agent', repoName: 'fixtures', agentName: 'owner', instanceId: 'owner-instance',
        enableGeneration: 'owner-enable', runtime: 'podman', containerId: 'b'.repeat(64),
    } });
    write(paths.desiredFile, {
        hosts: {
            [host]: { agent, routerSurfaces: [] },
            [rootHost]: { agent: 'fixtures/owner', routerSurfaces: [], rootApplication: { agent, port: 8787 } },
        },
        cloudflare: { tunnelTokenSecret: 'publication/fixture-connector' },
    });
    return function apply(httpRoutes) {
        write(path.join(site, 'manifest.json'), {
            ploinky: 'sso enable', sso: { providerAgent: 'identity' }, routerAccess: { agentPorts: true, httpRoutes },
        });
        edge.applyEdgeRoutingGeneration({ workspaceRoot: root, publicationState: 'ready' });
        return edge.captureEdgeRoutingLease();
    };
}

// Capture the actual public, private and upgrade callbacks. Stop bootstrap after
// the handlers are attached, before any listener, worker or monitor starts.
async function captureRouter(t) {
    const bootstrap = {
        './utils/ttyFactories.js': 'export const initializeTTYFactories = () => ({}), createServiceConfig = () => ({});',
        '../../ploinky-box/lib/boxMarker.mjs': 'export const isInsideBox = () => false;',
        './utils/processLifecycle.js': 'export function setupProcessLifecycle() { throw new Error("fixture-handlers-ready"); }',
    };
    const entry = new URL('../../cli/server/RoutingServer.js?cdn-cache-dispatch', import.meta.url).href;
    const loader = `
        let fixture;
        export function initialize(data) { fixture = data; }
        export function resolve(specifier, context, nextResolve) {
            if (context.parentURL === fixture.entry && Object.hasOwn(fixture.bootstrap, specifier)) {
                const source = fixture.bootstrap[specifier];
                return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
            }
            return nextResolve(specifier, context);
        }
    `;
    register('data:text/javascript,' + encodeURIComponent(loader), { data: { entry, bootstrap } });
    const { WebttySessionManager } = await import('../../cli/server/webtty/sessionManager.mjs');
    t.mock.method(WebttySessionManager.prototype, 'initialize', async () => ({ ok: true }));
    const create = t.mock.method(http, 'createServer');
    try {
        await assert.rejects(import(entry), { message: 'fixture-handlers-ready' });
        assert.equal(create.mock.callCount(), 3);
        const [publicServer, privateServer, healthServer] = create.mock.calls.map(call => call.result);
        const { createPrivateListenerSet } = await import('../../cli/server/privateListenerSet.js');
        const transport = new EventEmitter();
        transport.listen = (options, ready) => {
            assert.equal(options.host, '127.0.0.1');
            ready();
        };
        const privateListeners = createPrivateListenerSet({
            httpServer: privateServer, createServer: () => transport, schedule: () => null,
            interfaceClassifier: { refresh() {}, snapshot: () => ({ gateways: [] }),
                classify: address => address === '127.0.0.1' ? 'loopback' : 'unmanaged' },
        });
        await privateListeners.start();
        t.after(() => privateListeners.close());
        return { publicServer, privateTransport: transport, healthServer };
    } finally {
        create.mock.restore();
    }
}

async function attachUpstreams(t) {
    let upstreamHeaders = {};
    let beforeResponse;
    const body = 'application response';
    const upstream = http.createServer((_req, res) => {
        beforeResponse?.();
        res.writeHead(200, {
            etag: '"origin"', 'last-modified': 'Mon, 23 Nov 2026 12:00:00 GMT', ...upstreamHeaders,
        });
        res.end(body);
    });
    const { RuntimeRelayManager } = await import('../../cli/server/runtimeRelay/RuntimeRelayManager.js');
    const checkout = t.mock.method(RuntimeRelayManager.prototype, 'checkout', ({ lease }) => {
        assert.ok(lease.commit());
        return { openRequest() {
            const stream = openStream(upstream);
            stream.abandon = () => stream.destroy();
            return stream;
        }, close() {} };
    });
    const dial = t.mock.method(net, 'createConnection', options => {
        assert.equal(Number(options.port), 43102);
        return openStream(upstream);
    });
    return { body, checkout, dial, respond(headers, onRequest) {
        upstreamHeaders = headers;
        beforeResponse = onRequest;
    } };
}

test('CDN cache policy through the Router HTTP listeners', async t => {
    const root = isolateWorkspace(t);
    const apply = await generationFixture(root);
    const manifest = [...routes, ...routes.map(row => ({ ...row, path: portMount + row.path })),
        { path: portMount + '/web-libs/*', access: 'public' }];
    let lease = apply(manifest);
    const { publicServer, privateTransport, healthServer } = await captureRouter(t);
    const upstream = await attachUpstreams(t);
    const { authService } = await import('../../cli/server/authHandlers/shared.js');
    t.mock.method(authService, 'isConfigured', () => true);
    t.mock.method(authService, 'validateSession', async id => id === 'fixture-session'
        ? { user: { id: 'fixture-user', roles: ['user'] } } : null);
    t.mock.method(authService, 'refreshSession', async () => {});
    const { setCacheApplication, setCacheHold } = await import('../../cli/server/cdn/cacheSettingsStore.js');
    const settings = (enabled, pageSeconds) => setCacheApplication(agent, { enabled, pageSeconds });
    const hold = { by: 'operator', since: '2026-11-23T12:00:00Z' };

    for (const [name, mount, transport] of [
        ['agent-port', portMount, upstream.checkout],
        ['transparent', '/site', upstream.dial],
    ]) {
        await t.test(name, async t => {
            async function answer(suffix, headers) {
                const count = transport.mock.callCount();
                const result = await request(publicServer, mount + suffix, { headers });
                assert.equal(result.status, 200, result.body);
                assert.equal(result.body, upstream.body);
                assert.equal(transport.mock.callCount(), count + 1);
                return result.headers;
            }
            await settings(true, 60);
            await setCacheHold(agent, null);
            upstream.respond({});
            await t.test('enabled page revalidates in the browser and removes origin validators', async () => {
                const headers = await answer('/page');
                assert.equal(headers[cdn], pagePolicy(60));
                assert.equal(headers[browser], 'no-cache');
                assert.equal(headers.etag, undefined);
                assert.equal(headers['last-modified'], undefined);
            });
            await t.test('the next request sees an edited TTL and then the off switch', async () => {
                await settings(true, 120);
                upstream.respond({ [browser]: 'max-age=10' });
                let headers = await answer('/page');
                assert.equal(headers[cdn], pagePolicy(120));
                assert.equal(headers[browser], 'max-age=10');
                await settings(false, 120);
                headers = await answer('/page');
                assert.equal(headers[cdn], 'no-store');
                assert.equal(headers.etag, '"origin"');
                await settings(true, 120);
            });
            await t.test('credentialed requests, unmarked routes, cookies and event streams refuse CDN caching', async () => {
                upstream.respond({});
                for (const headers of [{ cookie: 'app=fixture' }, { authorization: 'Bearer fixture' }]) {
                    assert.equal((await answer('/page', headers))[cdn], 'no-store');
                }
                assert.equal((await answer('/plain'))[cdn], 'no-store');
                upstream.respond({ 'set-cookie': 'app=fixture' });
                const cookie = await answer('/page');
                assert.equal(cookie[cdn], 'no-store');
                assert.deepEqual(cookie['set-cookie'], ['app=fixture']);
                upstream.respond({});
                publicServer.prependOnceListener('request', (_req, res) => res.setHeader('Set-Cookie', 'queued=fixture'));
                const queued = await answer('/page');
                assert.equal(queued[cdn], 'no-store');
                assert.deepEqual(queued['set-cookie'], ['queued=fixture']);
                upstream.respond({ 'content-type': 'text/event-stream' });
                const stream = await answer('/page');
                assert.equal(stream['content-type'], 'text/event-stream');
                assert.equal(stream[cdn], 'no-store');
            });
            await t.test('authenticated application answers are private', async () => {
                upstream.respond({ [browser]: 'public, max-age=90' });
                const headers = await answer('/account', { cookie: 'ploinky_sso=fixture-session' });
                assert.equal(headers[browser], 'private, max-age=90');
                assert.equal(headers[cdn], 'no-store');
            });
            await t.test('holding the application bypasses pages while retaining immutable release files', async () => {
                upstream.respond({});
                await setCacheHold(agent, hold);
                assert.equal((await answer('/page'))[cdn], 'no-store');
                const headers = await answer('/asset');
                assert.equal(headers[cdn], 'max-age=31536000');
                assert.equal(headers[browser], 'public, max-age=31536000, immutable');
                assert.equal(headers.etag, undefined);
                assert.equal(headers['last-modified'], undefined);
            });
            await t.test('a lease withdrawn while the upstream prepares its answer refuses caching', async () => {
                await setCacheHold(agent, null);
                upstream.respond({}, () => apply([...manifest, { path: '/new', access: 'public' }]));
                const headers = await answer('/page');
                assert.equal(lease.isCurrent(), false);
                assert.equal(headers[cdn], 'no-store');
                upstream.respond({});
                lease = apply(manifest);
            });
        });
    }

    // Administrator route choices through both relays, on the exact keys a generation's entries normalize to.
    await t.test('administrator route choices change what each relay marks for the CDN', async t => {
        const { setCacheRoute } = await import('../../cli/server/cdn/cacheSettingsStore.js');
        const marks = [{ path: '/never/*', access: 'public', cache: 'never' },
            { path: '/never/inner', access: 'public', cache: 'page' },
            { path: '/shared/*', access: 'public' }, { path: '/shared/own', access: 'public' },
            { path: '/static/*', access: 'public' }, { path: '/static/guest/*', access: 'guest' },
            { path: '/static/secret/*', access: 'authenticated' }];
        lease = apply([...manifest, ...marks, ...marks.map(row => ({ ...row, path: portMount + row.path }))]);
        await settings(true, 60);
        await setCacheHold(agent, null);
        const choice = (setting, mark) => ({ setting, at: '2026-11-27T10:00:00.000Z', by: 'admin', entry: { access: 'public', manifest: mark } });
        for (const [name, mount, transport] of [['agent-port', portMount, upstream.checkout], ['transparent', '/site', upstream.dial]]) {
            await t.test(name, async () => {
                const choose = (route, record) => setCacheRoute(agent, mount + route, record);
                const answer = async suffix => {
                    const count = transport.mock.callCount();
                    const result = await request(publicServer, mount + suffix);
                    assert.equal(result.status, 200, result.body);
                    assert.equal(transport.mock.callCount(), count + 1);
                    return result.headers;
                };
                upstream.respond({});
                // The manifest alone: the page is cached, the shared files and the never routes are not.
                assert.equal((await answer('/page'))[cdn], pagePolicy(60));
                assert.equal((await answer('/shared/a.css'))[cdn], 'no-store');
                assert.equal((await answer('/never/x'))[cdn], 'no-store');
                // B: off beats the manifest page mark and leaves the origin's own headers.
                await choose('/page', choice('off', 'page'));
                let headers = await answer('/page');
                assert.deepEqual([headers[cdn], headers.etag], ['no-store', '"origin"']);
                await choose('/page', null);
                assert.equal((await answer('/page'))[cdn], pagePolicy(60));
                // C: an administrator page mark on an unmarked wildcard applies, with the page rules and a browser revalidation.
                await choose('/shared/*', choice('page', null));
                headers = await answer('/shared/a.css');
                assert.deepEqual([headers[cdn], headers[browser], headers.etag], [pagePolicy(60), 'no-cache', undefined]);
                // An exact unmarked entry still shadows the wildcard.
                assert.equal((await answer('/shared/own'))[cdn], 'no-store');
                // A page choice on a public wildcard does not reach a nested guest or authenticated entry.
                await choose('/static/*', choice('page', null));
                assert.equal((await answer('/static/a.css'))[cdn], pagePolicy(60));
                for (const nested of ['/static/guest/x', '/static/secret/x']) {
                    const result = await request(publicServer, mount + nested);
                    assert.equal(result.headers[cdn], 'no-store', nested);
                }
                await choose('/static/*', null);
                // The choice never overrides a credential, a cookie or a hold.
                upstream.respond({ 'set-cookie': 'app=fixture' });
                assert.equal((await answer('/shared/a.css'))[cdn], 'no-store');
                upstream.respond({});
                await setCacheHold(agent, { by: 'operator', since: '2026-11-27T10:00:00Z' });
                assert.equal((await answer('/shared/a.css'))[cdn], 'no-store');
                await setCacheHold(agent, null);
                assert.equal((await answer('/shared/a.css'))[cdn], pagePolicy(60));
                // Negative control: structurally valid hand-written page choices on never entries stay no-store
                // in the same state in which the sibling shared route is cached.
                await choose('/never/*', choice('page', null));
                await choose('/never/inner', choice('page', 'page'));
                await choose('/never/x', choice('page', null));
                assert.equal((await answer('/shared/a.css'))[cdn], pagePolicy(60));
                for (const suffix of ['/never/x', '/never/inner', '/never/deeper/y']) {
                    assert.equal((await answer(suffix))[cdn], 'no-store', suffix);
                }
                // A stale choice never applies: the recorded mark no longer matches the entry.
                await choose('/shared/*', choice('page', 'immutable'));
                assert.equal((await answer('/shared/a.css'))[cdn], 'no-store');
                // A choice that is not valid for the switch state or the file fails closed.
                await choose('/shared/*', choice('page', null));
                await settings(false, 60);
                assert.equal((await answer('/shared/a.css'))[cdn], 'no-store');
                await settings(true, 60);
                const file = path.join(root, '.ploinky/data/cache-settings.json');
                const saved = fs.readFileSync(file, 'utf8');
                fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), routes: { [agent]: { '/x': { setting: 'page' } } } }));
                const warn = t.mock.method(console, 'warn', () => {});
                assert.equal((await answer('/page'))[cdn], 'no-store');
                assert.equal((await answer('/shared/a.css'))[cdn], 'no-store');
                warn.mock.restore();
                fs.writeFileSync(file, saved);
                assert.equal((await answer('/page'))[cdn], pagePolicy(60));
                for (const route of ['/shared/*', '/never/*', '/never/inner', '/never/x']) await choose(route, null);
            });
        }
        lease = apply(manifest);
    });

    // A root-application host serves the bare suffix; its administrator choices sit on the convention path.
    await t.test('administrator route choices on a root-application host', async () => {
        const { setCacheRoute } = await import('../../cli/server/cdn/cacheSettingsStore.js');
        lease = apply([...manifest, { path: portMount + '/never/*', access: 'public', cache: 'never' },
            { path: portMount + '/shared/*', access: 'public' }]);
        await settings(true, 60);
        await setCacheHold(agent, null);
        const choose = (route, setting, mark) => setCacheRoute(agent, portMount + route, setting
            && { setting, at: '2026-11-27T10:00:00.000Z', by: 'admin', entry: { access: 'public', manifest: mark } });
        const answer = async suffix => {
            const count = upstream.checkout.mock.callCount();
            const result = await request(publicServer, suffix, { headers: { host: rootHost } });
            assert.equal(result.status, 200, result.body);
            assert.equal(upstream.checkout.mock.callCount(), count + 1);
            return result.headers[cdn];
        };
        upstream.respond({});
        assert.equal(await answer('/page'), pagePolicy(60));
        await choose('/page', 'off', 'page');
        assert.equal(await answer('/page'), 'no-store');
        await choose('/page', null);
        assert.equal(await answer('/shared/a.css'), 'no-store');
        await choose('/shared/*', 'page', null);
        assert.equal(await answer('/shared/a.css'), pagePolicy(60));
        await choose('/shared/*', null);
        assert.equal(await answer('/shared/a.css'), 'no-store');
        lease = apply(manifest);
    });

    await t.test('Router denials and successful public static assets', async () => {
        const denied = await request(publicServer, '/site/__agent/private');
        assert.equal(denied.status, 404);
        assert.equal(denied.headers[cdn], 'no-store');
        const asset = await request(publicServer, '/web-libs/qrLib/qr.min.js', { headers: { host: 'localhost' } });
        assert.equal(asset.status, 200);
        assert.ok(asset.body.length > 0);
        assert.equal(asset.headers[browser], 'public, max-age=300');
        assert.equal(asset.headers[cdn], undefined);
        const mcp = await request(publicServer, '/MCPBrowserClient.js', { headers: { host: 'localhost' }, method: 'HEAD' });
        assert.equal(mcp.status, 200);
        assert.equal(mcp.headers[cdn], undefined);
        assert.equal(mcp.headers[browser], 'public, max-age=300');
        const directory = await request(publicServer, '/web-libs/qrLib', { headers: { host: 'localhost' } });
        assert.equal(directory.status, 404);
        assert.equal(directory.headers[cdn], 'no-store');
    });

    await t.test('the Router reserves /web-libs on root hosts and gives an agent-mounted answer no exemption', async () => {
        const denied = await request(publicServer, '/web-libs/x.js', { headers: { host: rootHost } });
        assert.equal(denied.status, 404);
        assert.equal(JSON.parse(denied.body).error, 'ROUTE_SURFACE_DENIED');
        assert.equal(denied.headers[cdn], 'no-store');
        const mounted = await request(publicServer, portMount + '/web-libs/x.js');
        assert.equal(mounted.status, 200, mounted.body);
        assert.equal(mounted.body, upstream.body);
        assert.equal(mounted.headers[cdn], 'no-store');
    });

    await t.test('the Router installs the response hook on its health listener', async () => {
        const answer = await request(healthServer, '/missing');
        assert.equal(answer.status, 404);
        assert.equal(answer.headers[cdn], 'no-store');
    });

    await t.test('malformed upgrade target gets a raw 400 with CDN no-store', () => {
        let output = '';
        const socket = new PassThrough();
        socket.on('data', data => { output += data; });
        publicServer.emit('upgrade', { url: 'invalid', headers: { host } }, socket, Buffer.alloc(0));
        assert.match(output, /^HTTP\/1\.1 400 /);
        assert.match(output, /\r\nCloudflare-CDN-Cache-Control: no-store\r\n/i);
    });

    await t.test('only the exact private POST reaches the signed cache operator handler', async () => {
        const { signCacheOperatorRequest, CACHE_OPERATOR_HEADER } = await import('../../cli/commands/cacheOperatorAssertion.js');
        const body = Buffer.from(JSON.stringify({ op: 'clear', host }));
        const url = '/api/edge/cache';
        const headers = { host: 'localhost', [CACHE_OPERATOR_HEADER]: signCacheOperatorRequest(body, lease) };
        for (const [method, target] of [['GET', url], ['POST', url + '?'], ['POST', '/api/edge/x/../cache']]) {
            const refused = await request(privateTransport, target, { headers, method });
            assert.equal(refused.status, 404);
            assert.equal(JSON.parse(refused.body).error, 'PRIVATE_ROUTE_SURFACE_DENIED');
        }
        const result = await request(privateTransport, url, { method: 'POST', headers, body });
        assert.equal(result.status, 200, result.body);
        assert.deepEqual(JSON.parse(result.body), { purge: { host, outcome: 'unconfigured' } });
        assert.equal(result.headers[cdn], 'no-store');
    });

    await t.test('the hold probes a marked page and refuses an unmarked 200 or Router error', async () => {
        const { changeCacheHold, probeCacheOrigin } = await import('../../cli/server/cdn/cacheHold.js');
        const dataDir = path.join(root, '.ploinky/data');
        fs.writeFileSync(path.join(dataDir, 'cache-purge.json'), JSON.stringify({
            version: 1, hosts: { [host]: { zoneId: 'a'.repeat(32), secretHandle: 'publication/fixture-purge' } },
        }));
        for (const { manifest, target, status, success, probes } of [
            { manifest: [page], target: '/site/page', status: 200, success: true, probes: 1 },
            { manifest: [{ ...page, path: '/plain/*' }, { path: '/plain/', access: 'public' }],
                target: '/site/plain/', status: 200, success: false, probes: 0 },
            { manifest: [page], target: '/site/page', status: 502, success: false, probes: 1 },
        ]) {
            const current = apply(manifest);
            const observed = [];
            if (status === 502) {
                upstream.dial.mock.mockImplementation((_options, callback) => {
                    queueMicrotask(() => callback(new Error('fixture upstream unavailable')));
                });
            }
            const probe = options => probeCacheOrigin(options, (req, callback) => {
                assert.equal(req.path, target);
                assert.equal(req.headers.host, host);
                return inMemoryRequest(publicServer, req, res => {
                    observed.push([res.statusCode, res.headers[cdn]]);
                    callback(res);
                });
            });
            const result = await changeCacheHold({
                op: 'hold', agent, by: 'operator', generation: current.snapshot,
                assertCurrent: () => assert.ok(current.isCurrent()),
            }, { dataDir, purge: async () => ({ host, outcome: 'accepted' }), probe });
            const direct = await request(publicServer, target);
            assert.equal(direct.status, status);
            assert.equal(direct.headers[cdn], 'no-store');
            assert.equal(result.success, success, target);
            assert.deepEqual(observed, probes ? [[status, 'no-store']] : []);
        }
    });
});
