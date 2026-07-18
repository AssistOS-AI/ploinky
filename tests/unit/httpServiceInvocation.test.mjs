import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MASTER_KEY = '5'.repeat(64);
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_MASTER_KEY = process.env.PLOINKY_MASTER_KEY;
const ORIGINAL_WORKSPACE_ROOT = process.env.PLOINKY_WORKSPACE_ROOT;
const SUITE_WORKSPACE = mkdtempSync(path.join(os.tmpdir(), 'ploinky-http-service-suite-'));
const SUITE_PLOINKY_DIR = path.join(SUITE_WORKSPACE, '.ploinky');

mkdirSync(SUITE_PLOINKY_DIR, { recursive: true });
process.chdir(SUITE_WORKSPACE);
process.env.PLOINKY_MASTER_KEY = MASTER_KEY;
process.env.PLOINKY_WORKSPACE_ROOT = SUITE_WORKSPACE;

// Load every Ploinky module only after selecting the suite-owned workspace.
// Several dependencies capture config paths at module initialization; static
// imports here would otherwise point tests at the developer's real .ploinky.
const [
    { createMemoryReplayCache },
    { verifyRouterRequestToken },
    { deriveAgentRequestSecret, deriveSubkey },
    { computeRchHttp },
    { collectHttpServiceRoutes, normalizeServiceSpec },
    { buildHttpServiceRateSourceHeader, PLOINKY_RATE_SOURCE_HEADER, stripRouterIdentityHeaders },
    { verifyUserDelegationGrant },
] = await Promise.all([
    import('../../Agent/lib/jwtVerify.mjs'),
    import('../../Agent/lib/requestSignedTokens.mjs'),
    import('../../cli/services/masterKey.js'),
    import('../../Agent/lib/requestHash.mjs'),
    import('../../cli/server/httpServiceRoutes.js'),
    import('../../cli/server/routerHandlers.js'),
    import('../../cli/server/mcp-proxy/userDelegationGrant.js'),
]);

test.after(() => {
    process.chdir(ORIGINAL_CWD);
    if (ORIGINAL_MASTER_KEY === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = ORIGINAL_MASTER_KEY;
    if (ORIGINAL_WORKSPACE_ROOT === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = ORIGINAL_WORKSPACE_ROOT;
    rmSync(SUITE_WORKSPACE, { recursive: true, force: true });
});

test('router strips every forwarding and Ploinky identity header before public upstream dial', () => {
    const sanitized = stripRouterIdentityHeaders({
        authorization: 'Bearer attacker',
        cookie: 'ploinky_jwt=attacker',
        forwarded: 'for=attacker',
        'x-forwarded-client-cert': 'spoofed',
        'x-forwarded-arbitrary': 'spoofed',
        'x-ploinky-auth-info': 'spoofed',
        'x-ploinky-future-identity': 'spoofed',
        'cf-connecting-ip': '198.51.100.11',
        'true-client-ip': '198.51.100.12',
        'x-real-ip': '198.51.100.13',
        accept: 'application/json',
    }, { preserveAuthorization: false, preserveCookie: false });
    assert.deepEqual(sanitized, { accept: 'application/json' });
});

test('guest rate-source partitions are opaque, transport-derived, route-scoped, and spoof-proof', () => {
    const routePlan = {
        decision: { access: 'guest' },
        definition: {
            routeKey: 'services/umamiAgent',
            externalPrefix: '/public-services/umami-telemetry/',
        },
        hostSelection: { source: 'local-alias' },
    };
    const first = buildHttpServiceRateSourceHeader({
        headers: { [PLOINKY_RATE_SOURCE_HEADER]: 'f'.repeat(64) },
        sessionId: 'session-a',
        socket: { remoteAddress: '::ffff:192.0.2.44' },
    }, routePlan)[PLOINKY_RATE_SOURCE_HEADER];
    const sameSourceNewSession = buildHttpServiceRateSourceHeader({
        headers: {},
        sessionId: 'session-b',
        socket: { remoteAddress: '192.0.2.44' },
    }, routePlan)[PLOINKY_RATE_SOURCE_HEADER];
    const otherSource = buildHttpServiceRateSourceHeader({
        headers: {},
        socket: { remoteAddress: '192.0.2.45' },
    }, routePlan)[PLOINKY_RATE_SOURCE_HEADER];
    const otherRoute = buildHttpServiceRateSourceHeader({
        headers: {},
        socket: { remoteAddress: '192.0.2.44' },
    }, {
        ...routePlan,
        definition: { ...routePlan.definition, routeKey: 'other/telemetry' },
    })[PLOINKY_RATE_SOURCE_HEADER];

    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, sameSourceNewSession);
    assert.notEqual(first, otherSource);
    assert.notEqual(first, otherRoute);
    assert.notEqual(first, 'f'.repeat(64));
    assert.equal(first.includes('192.0.2.44'), false);
    assert.equal(first.includes('session-'), false);
});

test('public-host guest rate partition requires one canonical Cloudflare source address', () => {
    const routePlan = {
        decision: { access: 'guest' },
        definition: {
            routeKey: 'services/umamiAgent',
            externalPrefix: '/public-services/umami-telemetry/',
        },
        hostSelection: { source: 'public-host' },
    };
    const expanded = buildHttpServiceRateSourceHeader({
        headers: { 'cf-connecting-ip': '2001:0db8:0:0:0:0:0:1' },
        socket: { remoteAddress: '127.0.0.1' },
    }, routePlan)[PLOINKY_RATE_SOURCE_HEADER];
    const compressed = buildHttpServiceRateSourceHeader({
        headers: { 'cf-connecting-ip': '2001:db8::1' },
        socket: { remoteAddress: '198.51.100.9' },
    }, routePlan)[PLOINKY_RATE_SOURCE_HEADER];
    assert.equal(expanded, compressed);
    assert.throws(
        () => buildHttpServiceRateSourceHeader({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, routePlan),
        /no valid canonical transport source/,
    );
    assert.throws(
        () => buildHttpServiceRateSourceHeader({
            headers: { 'cf-connecting-ip': '192.0.2.1, 192.0.2.2' },
            socket: { remoteAddress: '127.0.0.1' },
        }, routePlan),
        /no valid canonical transport source/,
    );
    assert.deepEqual(buildHttpServiceRateSourceHeader({}, {
        ...routePlan,
        decision: { access: 'authenticated' },
    }), {});
});

const VALID_DELEGATION_SPEC = {
    externalPrefix: '/services/onlyoffice/',
    internalPrefix: '/control/',
    access: 'authenticated',
    slug: 'onlyoffice',
    delegations: [{
        targetAgentId: 'agent:AssistOSExplorer/dpuAgent',
        tools: [
            'dpu_workspace_roots',
            'dpu_confidential_list',
            'dpu_confidential_get',
            'dpu_confidential_update',
        ],
        scopes: [
            'dpu:confidential:read',
            'dpu:confidential:write',
        ],
    }],
};

test('normalizeServiceSpec preserves authenticated service delegations with canonical target ids', () => {
    const definition = normalizeServiceSpec('onlyOffice', { agent: 'onlyOffice', repo: 'AssistOSExplorer' }, VALID_DELEGATION_SPEC);

    assert.equal(Array.isArray(definition?.delegations), true);
    assert.equal(definition.delegations.length, 1);
    assert.deepEqual(definition.delegations[0], {
        key: '',
        targetAgentId: 'agent:AssistOSExplorer/dpuAgent',
        tools: [
            'dpu_workspace_roots',
            'dpu_confidential_list',
            'dpu_confidential_get',
            'dpu_confidential_update',
        ],
        scope: [
            'dpu:confidential:read',
            'dpu:confidential:write',
        ],
        ttlSeconds: 1800,
    });
});

test('normalizeServiceSpec requires explicit service access', () => {
    assert.throws(
        () => normalizeServiceSpec('explorer', { agent: 'explorer', repo: 'AchillesIDE' }, {
            slug: 'avatar-settings',
            externalPrefix: '/services/explorer/avatar-settings/',
            internalPrefix: '/avatar-settings/',
        }),
        /requires access: public \| guest \| authenticated/,
    );
});

test('normalizeServiceSpec preserves delegation request path conditions', () => {
    const definition = normalizeServiceSpec('onlyOffice', { agent: 'onlyOffice', repo: 'AssistOSExplorer' }, {
        ...VALID_DELEGATION_SPEC,
        delegations: [{
            ...VALID_DELEGATION_SPEC.delegations[0],
            when: {
                queryParam: 'path',
                pathRoots: ['/Confidential'],
            },
        }],
    });

    assert.deepEqual(definition.delegations[0].when, {
        queryParam: 'path',
        pathRoots: ['/Confidential'],
    });
});

test('normalizeServiceSpec rejects delegations on public services', () => {
    assert.throws(() => normalizeServiceSpec('explorer', { agent: 'explorer', repo: 'AchillesIDE' }, {
        slug: 'office',
        access: 'public',
        delegations: [{
            targetAgentId: 'agent:AssistOSExplorer/dpuAgent',
            tools: ['dpu_workspace_roots'],
            scopes: ['dpu:confidential:read'],
        }],
    }), /Delegations are only supported/);
});

test('normalizeServiceSpec rejects removed auth fields', () => {
    for (const removed of [
        { auth: ['pro', 'tected'].join('') },
        { mode: 'guest' },
        { [['force', 'Guest'].join('')]: true },
    ]) {
        assert.throws(() => normalizeServiceSpec('explorer', { agent: 'explorer', repo: 'AchillesIDE' }, {
            slug: 'old-service',
            internalPrefix: '/old/',
            ...removed,
        }), /field '.+' was removed/);
    }
});

test('collectHttpServiceRoutes skips one invalid service spec without dropping valid siblings', () => {
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
        const definitions = collectHttpServiceRoutes({
            routes: {
                explorer: {
                    agent: 'explorer',
                    repo: 'AchillesIDE',
                    hostPort: 7011,
                    httpServices: [
                        {
                            slug: 'old-service',
                            internalPrefix: '/old/',
                            auth: ['pro', 'tected'].join(''),
                        },
                        {
                            slug: 'public-service',
                            internalPrefix: '/public/',
                            access: 'public',
                        },
                    ],
                },
            },
        });
        assert.deepEqual(definitions.map((definition) => ({
            externalPrefix: definition.externalPrefix,
            internalPrefix: definition.internalPrefix,
            access: definition.access,
        })), [{
            externalPrefix: '/public-services/public-service/',
            internalPrefix: '/public/',
            access: 'public',
        }]);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /service not mounted \(fail closed\)/);
    } finally {
        console.error = originalError;
    }
});

test('service slugs are route-scoped and may repeat across distinct route prefixes', () => {
    const definitions = collectHttpServiceRoutes({
        routes: {
            alpha: {
                hostPort: 7101,
                httpServices: [{
                    slug: 'dashboard',
                    externalPrefix: '/services/alpha-dashboard/',
                    internalPrefix: '/',
                    access: 'authenticated',
                }],
            },
            beta: {
                hostPort: 7102,
                httpServices: [{
                    slug: 'dashboard',
                    externalPrefix: '/services/beta-dashboard/',
                    internalPrefix: '/',
                    access: 'authenticated',
                }],
            },
        },
    });

    assert.deepEqual(definitions.map(({ routeKey, slug }) => ({ routeKey, slug })), [
        { routeKey: 'alpha', slug: 'dashboard' },
        { routeKey: 'beta', slug: 'dashboard' },
    ]);
});

test('default HTTP service collection consumes active compiled services without re-reading manifests', async (t) => {
    const servicePort = 43123;
    await withRouterModules(t, servicePort);

    writeFileSync(
        path.join(SUITE_PLOINKY_DIR, 'repos', 'services', 'browserUseAgent', 'manifest.json'),
        '{ invalid JSON',
    );

    const definitions = collectHttpServiceRoutes();
    assert.deepEqual(definitions.map((definition) => definition.slug), [
        'browser-use',
        'browser-use-guest',
    ]);
    assert.deepEqual(definitions[0].target, {
        hostname: '127.0.0.1',
        hostPort: servicePort,
        containerPort: null,
    });
    assert.equal(definitions[0].externalPrefix, '/services/browser-use/');

    const explicitDefinitions = collectHttpServiceRoutes({
        routes: {
            explicit: {
                hostPort: 43124,
                httpServices: [{
                    slug: 'explicit-service',
                    externalPrefix: '/services/explicit-service/',
                    internalPrefix: '/',
                    access: 'authenticated',
                }],
            },
        },
    });
    assert.equal(explicitDefinitions[0].externalPrefix, '/services/explicit-service/');
});

test('normalizeServiceSpec rejects delegation targets that are not canonical agent ids', () => {
    assert.throws(() => normalizeServiceSpec('onlyOffice', { agent: 'onlyOffice', repo: 'AssistOSExplorer' }, {
        slug: 'onlyoffice',
        access: 'authenticated',
        delegations: [{
            targetAgentId: 'invalid-target',
            tools: ['dpu_workspace_roots'],
            scopes: ['dpu:confidential:read'],
        }],
    }), /invalid targetAgentId/);
});

test('normalizeServiceSpec rejects empty delegation tool lists', () => {
    assert.throws(() => normalizeServiceSpec('onlyOffice', { agent: 'onlyOffice', repo: 'AssistOSExplorer' }, {
        slug: 'onlyoffice',
        access: 'authenticated',
        delegations: [{
            targetAgentId: 'agent:AssistOSExplorer/dpuAgent',
            tools: [],
            scopes: ['dpu:confidential:read'],
        }],
    }), /empty delegation tools/);
});

test('authenticated http service auth info includes configured user delegation grant', async (t) => {
    let captured = null;
    const upstream = http.createServer((req, res) => {
        captured = {
            url: req.url,
            headers: req.headers,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    });
    const servicePort = await listen(upstream);
    t.after(async () => {
        await close(upstream);
    });

    const { routerHandlers } = await withRouterModules(t, servicePort, writeOnlyOfficeDelegationConfig);
    const req = makeRequest({
        url: '/services/onlyoffice/office/session?path=%2FConfidential%2FReport.docx',
    });
    req.user = {
        id: 'local:alice',
        username: 'alice',
        roles: ['user'],
    };
    req.sessionId = 'session-alice';
    const res = new MockWritableResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    assert.equal(routerHandlers.handleHttpServiceRoute(req, res, parsedUrl), true);
    await res.done;

    const authInfo = JSON.parse(captured?.headers['x-ploinky-auth-info'] || '{}');
    assert.equal(authInfo.user.id, 'local:alice');
    assert.equal(authInfo.delegations?.dpuConfidential?.targetAgentId, 'agent:AssistOSExplorer/dpuAgent');
    const verified = verifyUserDelegationGrant({
        signingSecret: deriveSubkey('router-user-delegation', 32),
        token: authInfo.delegations.dpuConfidential.token,
        expectedSourceAgentId: 'agent:AssistOSExplorer/onlyOffice',
        expectedTargetAgentId: 'agent:AssistOSExplorer/dpuAgent',
        expectedTool: 'dpu_confidential_get',
        replayCache: createMemoryReplayCache(),
    });
    assert.equal(verified.user.id, 'local:alice');
});

test('authenticated http service grant is omitted when the configured request path root does not match', async (t) => {
    let captured = null;
    const upstream = http.createServer((req, res) => {
        captured = {
            url: req.url,
            headers: req.headers,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    });
    const servicePort = await listen(upstream);
    t.after(async () => {
        await close(upstream);
    });

    const { routerHandlers } = await withRouterModules(t, servicePort, writeOnlyOfficeDelegationConfig);
    for (const requestPath of ['/workspace/Report.docx', '/Confidentialfoo/Report.docx']) {
        captured = null;
        const req = makeRequest({
            url: `/services/onlyoffice/office/session?path=${encodeURIComponent(requestPath)}`,
        });
        req.user = {
            id: 'local:alice',
            username: 'alice',
            roles: ['user'],
        };
        req.sessionId = 'session-alice';
        const res = new MockWritableResponse();
        const parsedUrl = new URL(req.url, 'http://localhost');

        assert.equal(routerHandlers.handleHttpServiceRoute(req, res, parsedUrl), true);
        await res.done;

        const authInfo = JSON.parse(captured?.headers['x-ploinky-auth-info'] || '{}');
        assert.equal(authInfo.delegations, undefined, `${requestPath} must not receive a DPU grant`);
    }
});

test('http service grant is omitted for anonymous and guest actors', async (t) => {
    let captured = null;
    const upstream = http.createServer((req, res) => {
        captured = {
            url: req.url,
            headers: req.headers,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    });
    const servicePort = await listen(upstream);
    t.after(async () => {
        await close(upstream);
    });

    const { routerHandlers } = await withRouterModules(t, servicePort, writeOnlyOfficeDelegationConfig);
    const guestReq = makeRequest({
        url: '/services/onlyoffice/office/session?path=%2FConfidential%2FGuest.docx',
    });
    guestReq.user = {
        id: 'guest:anon',
        username: 'anon',
        roles: ['guest'],
    };
    guestReq.sessionId = 'guest-session';
    guestReq.authMode = 'guest';
    const guestRes = new MockWritableResponse();
    const guestParsed = new URL(guestReq.url, 'http://localhost');

    assert.equal(routerHandlers.handleHttpServiceRoute(guestReq, guestRes, guestParsed), true);
    await guestRes.done;

    let authInfo = JSON.parse(captured?.headers['x-ploinky-auth-info'] || '{}');
    assert.equal(authInfo.delegations, undefined);

    captured = null;
    const publicReq = makeRequest({
        url: '/public-services/onlyoffice/editor-status',
    });
    const publicRes = new MockWritableResponse();
    const publicParsed = new URL(publicReq.url, 'http://localhost');
    assert.equal(routerHandlers.handleHttpServiceRoute(publicReq, publicRes, publicParsed), true);
    await publicRes.done;

    assert.equal(captured?.headers['x-ploinky-auth-info'], undefined);
});

test('router strips caller-supplied x-ploinky-user-delegation before proxying', async (t) => {
    let captured = null;
    const upstream = http.createServer((req, res) => {
        captured = {
            url: req.url,
            headers: req.headers,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    });
    const servicePort = await listen(upstream);
    t.after(async () => {
        await close(upstream);
    });

    const { routerHandlers } = await withRouterModules(t, servicePort, writeOnlyOfficeDelegationConfig);
    const req = makeRequest({
        url: '/services/onlyoffice/office/session',
        headers: {
            'x-ploinky-user-delegation': 'spoofed-token',
        },
    });
    req.user = {
        id: 'local:alice',
        username: 'alice',
        roles: ['user'],
    };
    req.sessionId = 'session-alice';
    const res = new MockWritableResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    assert.equal(routerHandlers.handleHttpServiceRoute(req, res, parsedUrl), true);
    await res.done;

    assert.equal(captured?.headers['x-ploinky-user-delegation'], undefined);
});

test('http service grant expiry is capped by the service delegation ttl', async (t) => {
    let captured = null;
    const upstream = http.createServer((req, res) => {
        captured = {
            url: req.url,
            headers: req.headers,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    });
    const servicePort = await listen(upstream);
    t.after(async () => {
        await close(upstream);
    });

    const { routerHandlers } = await withRouterModules(t, servicePort, writeOnlyOfficeDelegationConfig);
    const req = makeRequest({
        url: '/services/onlyoffice/office/session?path=%2FConfidential%2FReport.docx',
    });
    req.user = {
        id: 'local:alice',
        username: 'alice',
        roles: ['user'],
    };
    req.sessionId = 'session-alice';
    const res = new MockWritableResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    assert.equal(routerHandlers.handleHttpServiceRoute(req, res, parsedUrl), true);
    await res.done;

    const authInfo = JSON.parse(captured?.headers['x-ploinky-auth-info'] || '{}');
    const claims = JSON.parse(Buffer.from(authInfo.delegations.dpuConfidential.token.split('.')[1], 'base64url').toString('utf8'));
    assert.ok((Number(claims.exp) - Number(claims.iat)) <= 45);
});

class MockWritableResponse extends Writable {
    constructor() {
        super();
        this.statusCode = 200;
        this.headers = new Map();
        this.body = '';
        this.done = new Promise((resolve) => this.on('finish', resolve));
    }

    setHeader(name, value) {
        this.headers.set(String(name).toLowerCase(), value);
    }

    getHeader(name) {
        return this.headers.get(String(name).toLowerCase());
    }

    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        for (const [name, value] of Object.entries(headers || {})) {
            this.setHeader(name, value);
        }
    }

    _write(chunk, _encoding, callback) {
        this.body += chunk ? Buffer.from(chunk).toString('utf8') : '';
        callback();
    }
}

function makeRequest({ method = 'GET', url, cookie = '', headers = {}, body = null }) {
    const bodyBuffer = body === null || body === undefined ? null : Buffer.from(body);
    const req = Readable.from(bodyBuffer ? [bodyBuffer] : []);
    req.method = method;
    req.url = url;
    req.headers = {
        accept: 'application/json',
        host: 'localhost',
        ...headers,
        ...(bodyBuffer ? { 'content-length': String(bodyBuffer.length) } : {}),
        ...(cookie ? { cookie } : {})
    };
    req.socket = { encrypted: false, remoteAddress: '127.0.0.1' };
    return req;
}

function sha256BodyHash(body) {
    return crypto.createHash('sha256').update(Buffer.from(body)).digest('base64url');
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    try {
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
    } catch (_) {
        // best effort teardown for test sockets
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            try {
                server.closeAllConnections?.();
            } catch (_) {
                // best effort teardown for test sockets
            }
            resolve();
        }, 1000);
        timer.unref?.();
        server.close(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

function requestBody({ port, path: requestPath, method = 'GET', body = '', headers = {} }) {
    const bytes = Buffer.from(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: requestPath,
            method,
            headers: {
                ...headers,
                ...(bytes.length ? { 'content-length': String(bytes.length) } : {}),
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                });
            });
        });
        req.setTimeout(2000, () => req.destroy(new Error('request timed out')));
        req.on('error', reject);
        req.end(bytes);
    });
}

function writeWorkspaceConfig(ploinkyDir, servicePort) {
    const explorerManifestDir = path.join(ploinkyDir, 'repos', 'AchillesIDE', 'explorer');
    const serviceManifestDir = path.join(ploinkyDir, 'repos', 'services', 'browserUseAgent');
    mkdirSync(explorerManifestDir, { recursive: true });
    mkdirSync(serviceManifestDir, { recursive: true });
    writeFileSync(path.join(explorerManifestDir, 'manifest.json'), JSON.stringify({ about: 'Explorer' }, null, 2));
    writeFileSync(path.join(serviceManifestDir, 'manifest.json'), JSON.stringify({
        httpServices: [
            {
                slug: 'browser-use',
                externalPrefix: '/services/browser-use/',
                internalPrefix: '/browser-use/',
                access: 'authenticated'
            },
            {
                slug: 'browser-use-guest',
                externalPrefix: '/public-services/browser-use-guest/',
                internalPrefix: '/browser-use/',
                access: 'guest'
            }
        ]
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        explorer: {
            type: 'agent',
            agentName: 'explorer',
            repoName: 'AchillesIDE',
            instanceId: 'explorer-instance',
            enableGeneration: 'explorer-enable-generation',
            auth: { mode: 'local', usersVar: 'PLOINKY_AUTH_EXPLORER_USERS' }
        },
        browserUseAgent: {
            type: 'agent',
            agentName: 'browserUseAgent',
            repoName: 'services',
            instanceId: 'browser-use-instance',
            enableGeneration: 'browser-use-enable-generation',
            auth: { mode: 'none' }
        }
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        routes: {
            explorer: {
                agent: 'explorer',
                repo: 'AchillesIDE',
                container: 'explorer',
                hostPort: 55289,
                hostPath: explorerManifestDir
            },
            browserUseAgent: {
                agent: 'browserUseAgent',
                repo: 'services',
                container: 'browserUseAgent',
                hostPort: servicePort,
                hostPath: serviceManifestDir
            }
        },
        static: {
            agent: 'explorer',
            hostPath: explorerManifestDir
        }
    }, null, 2));
}

function writeOnlyOfficeDelegationConfig(ploinkyDir, servicePort) {
    const onlyOfficeManifestDir = path.join(ploinkyDir, 'repos', 'AssistOSExplorer', 'onlyOffice');
    mkdirSync(onlyOfficeManifestDir, { recursive: true });
    writeFileSync(path.join(onlyOfficeManifestDir, 'manifest.json'), JSON.stringify({
        httpServices: [
            {
                slug: 'onlyoffice',
                externalPrefix: '/services/onlyoffice/',
                internalPrefix: '/control/',
                access: 'authenticated',
                delegations: [{
                    targetAgentId: 'agent:AssistOSExplorer/dpuAgent',
                    tools: [
                        'dpu_workspace_roots',
                        'dpu_confidential_list',
                        'dpu_confidential_get',
                        'dpu_confidential_update',
                    ],
                    scopes: [
                        'dpu:confidential:read',
                        'dpu:confidential:write',
                    ],
                    ttlSeconds: 45,
                    when: {
                        queryParam: 'path',
                        pathRoots: ['/Confidential'],
                    },
                }],
            },
            {
                slug: 'public-office',
                externalPrefix: '/public-services/onlyoffice/',
                internalPrefix: '/public/',
                access: 'public',
            },
        ],
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        onlyOffice: {
            type: 'agent',
            agentName: 'onlyOffice',
            repoName: 'AssistOSExplorer',
            instanceId: 'onlyoffice-instance',
            enableGeneration: 'onlyoffice-enable-generation',
            auth: { mode: 'none' }
        }
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        routes: {
            onlyOffice: {
                agent: 'onlyOffice',
                repo: 'AssistOSExplorer',
                container: 'onlyOffice',
                hostPort: servicePort,
                hostPath: onlyOfficeManifestDir
            }
        }
    }, null, 2));
}

function writeBrokenPrincipalConfig(ploinkyDir, servicePort) {
    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        brokenService: {
            type: 'agent',
            agentName: 'brokenService',
            repoName: 'fixtures',
            instanceId: 'broken-service-instance',
            enableGeneration: 'broken-service-enable-generation',
            auth: { mode: 'none' },
        },
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        routes: {
            brokenService: {
                hostPort: servicePort,
                httpServices: [
                    {
                        slug: 'broken',
                        externalPrefix: '/services/broken/',
                        internalPrefix: '/broken/',
                        access: 'authenticated',
                    },
                ],
            },
        },
    }, null, 2));
}

function writeEdgeSourceDocuments(ploinkyDir) {
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    mkdirSync(edgeDir, { recursive: true });
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(path.join(edgeDir, 'desired.json'), JSON.stringify({
        schemaVersion: 1,
        hosts: {},
        security: {
            hostNetworkAllowedInstances: [],
            internalServiceConsumers: {},
        },
    }, null, 2));
    writeFileSync(path.join(policyDir, 'policy-state.json'), JSON.stringify({
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    }, null, 2));
}

async function withRouterModules(t, servicePort, writeConfig = writeWorkspaceConfig) {
    const workspace = SUITE_WORKSPACE;
    const ploinkyDir = SUITE_PLOINKY_DIR;
    rmSync(ploinkyDir, { recursive: true, force: true });
    mkdirSync(ploinkyDir, { recursive: true });
    writeFileSync(path.join(ploinkyDir, '.secrets'), '# test secrets\n');
    writeConfig(ploinkyDir, servicePort);
    writeEdgeSourceDocuments(ploinkyDir);

    const edgeGeneration = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/services/edgeGeneration.js')).href}?test=${Date.now()}-${Math.random()}`);
    edgeGeneration.applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'http-service-test-fixture' });

    const nonce = `${Date.now()}-${Math.random()}`;
    const authHandlers = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/authHandlers/index.js')).href}?test=${nonce}`);
    // authHandlers imports the canonical localService module. Use that same
    // module instance so its in-memory user/session view cannot diverge from a
    // query-suffixed test copy.
    const localService = await import(pathToFileURL(path.join(REPO_ROOT, 'cli/server/auth/localService.js')).href);
    const routerHandlers = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/routerHandlers.js')).href}?test=${nonce}`);
    return { authHandlers, localService, routerHandlers };
}

test('authenticated HTTP service falls back to static auth and injects router auth info', async (t) => {
    let captured = null;
    const upstream = http.createServer((req, res) => {
        captured = {
            url: req.url,
            headers: req.headers
        };
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
    });
    const servicePort = await listen(upstream);
    t.after(async () => {
        await close(upstream);
    });

    const { authHandlers, localService, routerHandlers } = await withRouterModules(t, servicePort);
    const unauthReq = makeRequest({
        url: '/services/browser-use/sessions/sess_fake'
    });
    const unauthRes = new MockWritableResponse();
    const unauthParsedUrl = new URL(unauthReq.url, 'http://localhost');
    const unauthResult = await authHandlers.ensureAuthenticated(unauthReq, unauthRes, unauthParsedUrl);
    await unauthRes.done;

    assert.equal(unauthResult.ok, false);
    assert.equal(unauthRes.statusCode, 401);
    assert.equal(JSON.parse(unauthRes.body).error, 'not_authenticated');
    assert.equal(captured, null);

    const policy = { mode: 'local', usersVar: 'PLOINKY_AUTH_EXPLORER_USERS' };
    const username = `admin-${crypto.randomBytes(4).toString('hex')}`;
    const userId = `local:${username}`;
    localService.createLocalAuthUser({
        policy,
        username,
        password: 'correct horse battery staple',
        roles: ['admin']
    });
    const login = localService.authenticateLocalUser({
        username,
        password: 'correct horse battery staple',
        policy
    });
    const req = makeRequest({
        url: '/services/browser-use/sessions/sess_1?view=1',
        cookie: `ploinky_jwt=${login.sessionId}`,
        headers: {
            'x-ploinky-auth-info': '{"user":{"id":"spoofed"}}',
            forwarded: 'host=attacker.invalid;proto=https',
            'x-forwarded-host': 'attacker.invalid',
            'x-forwarded-proto': 'https',
            'x-forwarded-for': '198.51.100.10',
        }
    });
    const res = new MockWritableResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    const authResult = await authHandlers.ensureAuthenticated(req, res, parsedUrl);
    assert.equal(authResult.ok, true, res.body);
    assert.equal(req.authMode, 'local');
    assert.equal(req.user?.id, userId);

    const handled = routerHandlers.handleHttpServiceRoute(req, res, parsedUrl);
    assert.equal(handled, true);
    await res.done;

    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'ok');
    assert.equal(captured?.url, '/browser-use/sessions/sess_1?view=1');
    assert.equal(captured?.headers.host, 'localhost:8080');
    assert.equal(captured?.headers['x-forwarded-host'], 'localhost:8080');
    assert.equal(captured?.headers['x-forwarded-proto'], 'http');
    assert.equal(captured?.headers.forwarded, undefined);
    assert.equal(captured?.headers['x-forwarded-for'], undefined);

    const authInfo = JSON.parse(captured?.headers['x-ploinky-auth-info'] || '{}');
    assert.equal(authInfo.user?.id, userId);
    assert.equal(authInfo.user?.username, username);
    assert.deepEqual(authInfo.user?.roles, ['user', 'admin']);
    assert.ok(authInfo.sessionId);
    assert.equal(typeof authInfo.invocationToken, 'string');
    assert.deepEqual(authInfo.invocationBody, {
        method: 'GET',
        externalPath: '/services/browser-use/sessions/sess_1',
        path: '/browser-use/sessions/sess_1',
        search: '?view=1',
        routeKey: 'browserUseAgent',
        bodyHash: sha256BodyHash(''),
    });

    const verified = verifyRouterRequestToken(authInfo.invocationToken, {
        secret: deriveAgentRequestSecret('agent:services/browserUseAgent', { encoding: 'buffer' }),
        expectedAudience: 'agent:services/browserUseAgent',
        tool: '__http_service__',
        method: authInfo.invocationBody.method,
        path: authInfo.invocationBody.path,
        rch: computeRchHttp({
            method: authInfo.invocationBody.method,
            path: authInfo.invocationBody.path,
            query: authInfo.invocationBody.search,
            bodyHash: authInfo.invocationBody.bodyHash,
        }),
        replayCache: createMemoryReplayCache(),
    });
    assert.equal(verified.payload.typ, 'router-request');
    assert.equal(verified.payload.actor?.kind, 'user');
    assert.equal(verified.payload.sub, `user:${userId}`);

    captured = null;
    const rootReq = makeRequest({
        url: '/services/browser-use',
        cookie: `ploinky_jwt=${login.sessionId}`,
    });
    const rootRes = new MockWritableResponse();
    const rootParsedUrl = new URL(rootReq.url, 'http://localhost');

    const rootAuthResult = await authHandlers.ensureAuthenticated(rootReq, rootRes, rootParsedUrl);
    assert.equal(rootAuthResult.ok, true, rootRes.body);

    const rootHandled = routerHandlers.handleHttpServiceRoute(rootReq, rootRes, rootParsedUrl);
    assert.equal(rootHandled, true);
    await rootRes.done;

    assert.equal(rootRes.statusCode, 200);
    assert.equal(rootRes.body, 'ok');
    assert.equal(captured?.url, '/browser-use/');
});

test('authenticated HTTP service invocation rch binds the forwarded request body', async (t) => {
    let captured = null;
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            captured = {
                url: req.url,
                headers: req.headers,
                body: Buffer.concat(chunks),
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    const servicePort = await listen(upstream);
    t.after(async () => {
        await close(upstream);
    });

    const { routerHandlers } = await withRouterModules(t, servicePort);
    const requestBody = JSON.stringify({ action: 'create', name: 'body-bound' });
    const req = makeRequest({
        method: 'POST',
        url: '/services/browser-use/sessions/sess_1?view=1',
        headers: {
            'content-type': 'application/json',
        },
        body: requestBody,
    });
    req.user = {
        id: 'local:admin',
        username: 'admin',
        roles: ['user', 'admin'],
    };
    req.sessionId = 'session-1';
    const res = new MockWritableResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    const handled = routerHandlers.handleHttpServiceRoute(req, res, parsedUrl);
    assert.equal(handled, true);
    await res.done;

    assert.equal(res.statusCode, 200);
    assert.equal(captured?.url, '/browser-use/sessions/sess_1?view=1');
    assert.equal(captured?.body.toString('utf8'), requestBody);

    const authInfo = JSON.parse(captured?.headers['x-ploinky-auth-info'] || '{}');
    assert.equal(typeof authInfo.invocationToken, 'string');
    assert.deepEqual(authInfo.invocationBody, {
        method: 'POST',
        externalPath: '/services/browser-use/sessions/sess_1',
        path: '/browser-use/sessions/sess_1',
        search: '?view=1',
        routeKey: 'browserUseAgent',
        bodyHash: sha256BodyHash(requestBody),
    });

    const verified = verifyRouterRequestToken(authInfo.invocationToken, {
        secret: deriveAgentRequestSecret('agent:services/browserUseAgent', { encoding: 'buffer' }),
        expectedAudience: 'agent:services/browserUseAgent',
        tool: '__http_service__',
        method: authInfo.invocationBody.method,
        path: authInfo.invocationBody.path,
        rch: computeRchHttp({
            method: authInfo.invocationBody.method,
            path: authInfo.invocationBody.path,
            query: authInfo.invocationBody.search,
            bodyHash: authInfo.invocationBody.bodyHash,
        }),
        replayCache: createMemoryReplayCache(),
    });
    assert.equal(verified.payload.typ, 'router-request');

    assert.throws(() => verifyRouterRequestToken(authInfo.invocationToken, {
        secret: deriveAgentRequestSecret('agent:services/browserUseAgent', { encoding: 'buffer' }),
        expectedAudience: 'agent:services/browserUseAgent',
        tool: '__http_service__',
        method: authInfo.invocationBody.method,
        path: authInfo.invocationBody.path,
        rch: computeRchHttp({
            method: authInfo.invocationBody.method,
            path: authInfo.invocationBody.path,
            query: authInfo.invocationBody.search,
            bodyHash: sha256BodyHash(JSON.stringify({ action: 'tampered' })),
        }),
        replayCache: createMemoryReplayCache(),
    }), /request hash mismatch/);
});

test('HTTP service invocation signs the internal path observed by the service', async (t) => {
    let captured = null;
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            captured = {
                url: req.url,
                headers: req.headers,
                body: Buffer.concat(chunks),
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    const servicePort = await listen(upstream);
    t.after(async () => {
        await close(upstream);
    });

    const { routerHandlers } = await withRouterModules(t, servicePort);
    const requestBody = JSON.stringify({ action: 'create' });
    const req = makeRequest({
        method: 'POST',
        url: '/services/browser-use/sessions/sess_2?view=1',
        body: requestBody,
    });
    req.user = {
        id: 'local:admin',
        username: 'admin',
        roles: ['user', 'admin'],
    };
    req.sessionId = 'session-1';
    const res = new MockWritableResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    assert.equal(routerHandlers.handleHttpServiceRoute(req, res, parsedUrl), true);
    await res.done;

    assert.equal(captured?.url, '/browser-use/sessions/sess_2?view=1');
    const authInfo = JSON.parse(captured?.headers['x-ploinky-auth-info'] || '{}');
    assert.equal(authInfo.invocationBody.externalPath, '/services/browser-use/sessions/sess_2');
    assert.equal(authInfo.invocationBody.path, '/browser-use/sessions/sess_2');

    assert.doesNotThrow(() => verifyRouterRequestToken(authInfo.invocationToken, {
        secret: deriveAgentRequestSecret('agent:services/browserUseAgent', { encoding: 'buffer' }),
        expectedAudience: 'agent:services/browserUseAgent',
        tool: '__http_service__',
        method: 'POST',
        path: '/browser-use/sessions/sess_2',
        rch: computeRchHttp({
            method: 'POST',
            path: '/browser-use/sessions/sess_2',
            query: '?view=1',
            bodyHash: sha256BodyHash(requestBody),
        }),
        replayCache: createMemoryReplayCache(),
    }));

    assert.throws(() => verifyRouterRequestToken(authInfo.invocationToken, {
        secret: deriveAgentRequestSecret('agent:services/browserUseAgent', { encoding: 'buffer' }),
        expectedAudience: 'agent:services/browserUseAgent',
        tool: '__http_service__',
        method: 'POST',
        path: '/services/browser-use/sessions/sess_2',
        rch: computeRchHttp({
            method: 'POST',
            path: '/services/browser-use/sessions/sess_2',
            query: '?view=1',
            bodyHash: sha256BodyHash(requestBody),
        }),
        replayCache: createMemoryReplayCache(),
    }), /path mismatch|request hash mismatch/);
});

test('HTTP service invocation rejects oversized buffered bodies before proxying', async (t) => {
    let reached = false;
    const upstream = http.createServer((_req, res) => {
        reached = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    });
    const servicePort = await listen(upstream);
    t.after(async () => {
        await close(upstream);
    });

    const previousLimit = process.env.PLOINKY_HTTP_SERVICE_INVOCATION_MAX_BODY_BYTES;
    process.env.PLOINKY_HTTP_SERVICE_INVOCATION_MAX_BODY_BYTES = '8';
    t.after(() => {
        if (previousLimit === undefined) {
            delete process.env.PLOINKY_HTTP_SERVICE_INVOCATION_MAX_BODY_BYTES;
        } else {
            process.env.PLOINKY_HTTP_SERVICE_INVOCATION_MAX_BODY_BYTES = previousLimit;
        }
    });

    const { routerHandlers } = await withRouterModules(t, servicePort);
    const req = makeRequest({
        method: 'POST',
        url: '/services/browser-use/sessions/sess_1',
        body: '0123456789',
    });
    req.user = {
        id: 'local:admin',
        username: 'admin',
        roles: ['user', 'admin'],
    };
    req.sessionId = 'session-1';
    const res = new MockWritableResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    assert.equal(routerHandlers.handleHttpServiceRoute(req, res, parsedUrl), true);
    await res.done;

    assert.equal(reached, false);
    assert.equal(res.statusCode, 413);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'http_service_body_too_large');
    assert.equal(body.limitBytes, 8);
});

test('HTTP service oversized body returns 413 on a real socket', async (t) => {
    let reached = false;
    const upstream = http.createServer((_req, res) => {
        reached = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    });
    const servicePort = await listen(upstream);
    t.after(async () => {
        await close(upstream);
    });

    const previousLimit = process.env.PLOINKY_HTTP_SERVICE_INVOCATION_MAX_BODY_BYTES;
    process.env.PLOINKY_HTTP_SERVICE_INVOCATION_MAX_BODY_BYTES = '8';
    t.after(() => {
        if (previousLimit === undefined) {
            delete process.env.PLOINKY_HTTP_SERVICE_INVOCATION_MAX_BODY_BYTES;
        } else {
            process.env.PLOINKY_HTTP_SERVICE_INVOCATION_MAX_BODY_BYTES = previousLimit;
        }
    });

    const { routerHandlers } = await withRouterModules(t, servicePort);
    const router = http.createServer((req, res) => {
        req.user = {
            id: 'local:admin',
            username: 'admin',
            roles: ['user', 'admin'],
        };
        req.sessionId = 'session-1';
        const parsedUrl = new URL(req.url, 'http://localhost');
        if (!routerHandlers.handleHttpServiceRoute(req, res, parsedUrl)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'not_found' }));
        }
    });
    const routerPort = await listen(router);
    t.after(async () => {
        await close(router);
    });

    const response = await requestBody({
        port: routerPort,
        method: 'POST',
        path: '/services/browser-use/sessions/sess_1',
        body: '0123456789',
        headers: { accept: 'application/json' },
    });

    assert.equal(reached, false);
    assert.equal(response.statusCode, 413);
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'http_service_body_too_large');
    assert.equal(body.limitBytes, 8);
});

test('guest HTTP service invocation records guest actor kind', async (t) => {
    let captured = null;
    const upstream = http.createServer((req, res) => {
        captured = {
            url: req.url,
            headers: req.headers,
        };
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
    });
    const servicePort = await listen(upstream);
    t.after(async () => {
        await close(upstream);
    });

    const { routerHandlers } = await withRouterModules(t, servicePort);
    const req = makeRequest({
        url: '/public-services/browser-use-guest/sessions/sess_guest?view=1',
        headers: { [PLOINKY_RATE_SOURCE_HEADER]: 'f'.repeat(64) },
    });
    req.user = {
        id: 'guest:abc',
        username: 'visitor',
        roles: ['guest'],
    };
    req.sessionId = 'guest-session-1';
    req.authMode = 'guest';
    const res = new MockWritableResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    assert.equal(routerHandlers.handleHttpServiceRoute(req, res, parsedUrl), true);
    await res.done;

    const authInfo = JSON.parse(captured?.headers['x-ploinky-auth-info'] || '{}');
    const verified = verifyRouterRequestToken(authInfo.invocationToken, {
        secret: deriveAgentRequestSecret('agent:services/browserUseAgent', { encoding: 'buffer' }),
        expectedAudience: 'agent:services/browserUseAgent',
        tool: '__http_service__',
        method: 'GET',
        path: '/browser-use/sessions/sess_guest',
        rch: computeRchHttp({
            method: 'GET',
            path: '/browser-use/sessions/sess_guest',
            query: '?view=1',
            bodyHash: sha256BodyHash(''),
        }),
        replayCache: createMemoryReplayCache(),
    });

    assert.equal(verified.payload.actor.kind, 'guest');
    assert.deepEqual(verified.payload.actor.roles, ['guest']);
    assert.match(captured?.headers[PLOINKY_RATE_SOURCE_HEADER] || '', /^[a-f0-9]{64}$/);
    assert.notEqual(captured?.headers[PLOINKY_RATE_SOURCE_HEADER], 'f'.repeat(64));
});

test('authenticated HTTP service fails closed when invocation principal cannot be resolved', async (t) => {
    let reached = false;
    const upstream = http.createServer((_req, res) => {
        reached = true;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('unexpected');
    });
    const servicePort = await listen(upstream);
    t.after(async () => {
        await close(upstream);
    });

    const { routerHandlers } = await withRouterModules(t, servicePort, writeBrokenPrincipalConfig);
    const req = makeRequest({
        url: '/services/broken/session',
    });
    req.user = {
        id: 'local:admin',
        username: 'admin',
        roles: ['local', 'admin'],
    };
    req.sessionId = 'session-1';
    const res = new MockWritableResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    const handled = routerHandlers.handleHttpServiceRoute(req, res, parsedUrl);
    assert.equal(handled, true);
    await res.done;

    assert.equal(reached, false);
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'http_service_invocation_unavailable');
    assert.match(body.message, /could not resolve provider 'brokenService'/);
});

test('authenticated HTTP service auth info carries user identity', async () => {
    const { buildPlainAuthInfoHeader } = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/routerHandlers.js')).href}?plain=${Date.now()}`);
    const headers = buildPlainAuthInfoHeader({
        user: {
            id: 'local:admin',
            username: 'admin',
            email: 'admin@example.com',
            roles: ['admin']
        },
        sessionId: 'session-1'
    });

    const authInfo = JSON.parse(headers['x-ploinky-auth-info']);

    assert.deepEqual(authInfo.user, {
        id: 'local:admin',
        username: 'admin',
        email: 'admin@example.com',
        roles: ['admin']
    });
    assert.equal(authInfo.sessionId, 'session-1');
});

test('service delegation target "." expands to the source route repo', () => {
    const spec = {
        slug: 'onlyoffice',
        externalPrefix: '/services/onlyoffice/',
        internalPrefix: '/control/',
        access: 'authenticated',
        delegations: [{
            targetAgentId: 'agent:./dpuAgent',
            tools: ['dpu_confidential_get'],
            scopes: ['dpu:confidential:read'],
            ttlSeconds: 1800,
        }],
    };
    const def = normalizeServiceSpec('onlyOffice', { repo: 'CustomRepoName', agent: 'onlyOffice' }, spec);
    assert.equal(def.delegations[0].targetAgentId, 'agent:CustomRepoName/dpuAgent');
});

test('service delegation target with explicit repo is left unchanged', () => {
    const spec = {
        slug: 'onlyoffice', externalPrefix: '/services/onlyoffice/', internalPrefix: '/control/', access: 'authenticated',
        delegations: [{ targetAgentId: 'agent:AchillesIDE/dpuAgent', tools: ['dpu_confidential_get'], scopes: ['dpu:confidential:read'], ttlSeconds: 1800 }],
    };
    const def = normalizeServiceSpec('onlyOffice', { repo: 'CustomRepoName', agent: 'onlyOffice' }, spec);
    assert.equal(def.delegations[0].targetAgentId, 'agent:AchillesIDE/dpuAgent');
});

test('relative delegation target without a source repo is rejected', () => {
    const spec = {
        slug: 'onlyoffice', externalPrefix: '/services/onlyoffice/', internalPrefix: '/control/', access: 'authenticated',
        delegations: [{ targetAgentId: 'agent:./dpuAgent', tools: ['dpu_confidential_get'], scopes: ['dpu:confidential:read'], ttlSeconds: 1800 }],
    };
    assert.throws(() => normalizeServiceSpec('onlyOffice', {}, spec), /cannot expand relative target/);
});

test('delegation targets with dot-only path segments are rejected', () => {
    for (const target of ['agent:../dpuAgent', 'agent:./../dpuAgent', 'agent:CustomRepoName/..', 'agent:CustomRepoName/.']) {
        const spec = {
            slug: 'onlyoffice', externalPrefix: '/services/onlyoffice/', internalPrefix: '/control/', access: 'authenticated',
            delegations: [{ targetAgentId: target, tools: ['dpu_confidential_get'], scopes: ['dpu:confidential:read'], ttlSeconds: 1800 }],
        };
        assert.throws(() => normalizeServiceSpec('onlyOffice', { repo: 'CustomRepoName', agent: 'onlyOffice' }, spec), /invalid targetAgentId/);
    }
});

test('explicit delegation key is preserved through normalization', () => {
    const spec = {
        slug: 'onlyoffice', externalPrefix: '/services/onlyoffice/', internalPrefix: '/control/', access: 'authenticated',
        delegations: [{ key: 'dpuConfidential', targetAgentId: 'agent:AchillesIDE/dpuAgent', tools: ['dpu_confidential_get'], scopes: ['dpu:confidential:read'], ttlSeconds: 1800 }],
    };
    const def = normalizeServiceSpec('onlyOffice', { repo: 'AchillesIDE', agent: 'onlyOffice' }, spec);
    assert.equal(def.delegations[0].key, 'dpuConfidential');
});
