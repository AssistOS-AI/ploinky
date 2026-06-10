import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { verifyRouterRequestToken } from '../../Agent/lib/requestSignedTokens.mjs';
import { deriveAgentRequestSecret, deriveSubkey } from '../../cli/services/masterKey.js';
import { computeRchHttp } from '../../Agent/lib/requestHash.mjs';
import { normalizeServiceSpec } from '../../cli/server/httpServiceRoutes.js';
import { verifyUserDelegationGrant } from '../../cli/server/mcp-proxy/userDelegationGrant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MASTER_KEY = '5'.repeat(64);

const VALID_DELEGATION_SPEC = {
    externalPrefix: '/services/onlyoffice/',
    internalPrefix: '/control/',
    auth: 'protected',
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

test('normalizeServiceSpec preserves protected service delegations with canonical target ids', () => {
    const definition = normalizeServiceSpec('onlyOffice', { agent: 'onlyOffice', repo: 'AssistOSExplorer' }, VALID_DELEGATION_SPEC);

    assert.equal(Array.isArray(definition?.delegations), true);
    assert.equal(definition.delegations.length, 1);
    assert.deepEqual(definition.delegations[0], {
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

test('normalizeServiceSpec rejects delegations on auth none services', () => {
    assert.throws(() => normalizeServiceSpec('explorer', { agent: 'explorer', repo: 'AchillesIDE' }, {
        slug: 'office',
        auth: 'none',
        delegations: [{
            targetAgentId: 'agent:AssistOSExplorer/dpuAgent',
            tools: ['dpu_workspace_roots'],
            scopes: ['dpu:confidential:read'],
        }],
    }), /Delegations are only supported/);
});

test('normalizeServiceSpec rejects delegation targets that are not canonical agent ids', () => {
    assert.throws(() => normalizeServiceSpec('onlyOffice', { agent: 'onlyOffice', repo: 'AssistOSExplorer' }, {
        slug: 'onlyoffice',
        auth: 'protected',
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
        auth: 'protected',
        delegations: [{
            targetAgentId: 'agent:AssistOSExplorer/dpuAgent',
            tools: [],
            scopes: ['dpu:confidential:read'],
        }],
    }), /empty delegation tools/);
});

test('protected http service auth info includes configured user delegation grant', async (t) => {
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
        url: '/services/onlyoffice/office/session',
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
    req.socket = { encrypted: false };
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
    return new Promise((resolve) => server.close(() => resolve()));
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
                auth: 'protected'
            }
        ]
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        explorer: {
            type: 'agent',
            agentName: 'explorer',
            repoName: 'AchillesIDE',
            auth: { mode: 'local', usersVar: 'PLOINKY_AUTH_EXPLORER_USERS' }
        },
        browserUseAgent: {
            type: 'agent',
            agentName: 'browserUseAgent',
            repoName: 'services',
            auth: { mode: 'none' }
        }
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        routes: {
            explorer: {
                agent: 'explorer',
                repo: 'AchillesIDE',
                hostPort: 55289,
                hostPath: explorerManifestDir
            },
            browserUseAgent: {
                agent: 'browserUseAgent',
                repo: 'services',
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
                auth: 'protected',
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
                }],
            },
        ],
        publicServices: [
            {
                slug: 'public-office',
                externalPrefix: '/public-services/onlyoffice/',
                internalPrefix: '/public/',
                auth: 'none',
            },
        ],
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        onlyOffice: {
            type: 'agent',
            agentName: 'onlyOffice',
            repoName: 'AssistOSExplorer',
            auth: { mode: 'none' }
        }
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        routes: {
            onlyOffice: {
                agent: 'onlyOffice',
                repo: 'AssistOSExplorer',
                hostPort: servicePort,
                hostPath: onlyOfficeManifestDir
            }
        }
    }, null, 2));
}

function writeBrokenPrincipalConfig(ploinkyDir, servicePort) {
    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({}, null, 2));
    writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        routes: {
            brokenService: {
                hostPort: servicePort,
                httpServices: [
                    {
                        slug: 'broken',
                        externalPrefix: '/services/broken/',
                        internalPrefix: '/broken/',
                        auth: 'protected',
                    },
                ],
            },
        },
    }, null, 2));
}

async function withRouterModules(t, servicePort, writeConfig = writeWorkspaceConfig) {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'ploinky-http-service-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    mkdirSync(ploinkyDir, { recursive: true });
    writeFileSync(path.join(ploinkyDir, '.secrets'), '# test secrets\n');
    writeConfig(ploinkyDir, servicePort);

    const previousCwd = process.cwd();
    const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
    process.chdir(workspace);
    process.env.PLOINKY_MASTER_KEY = MASTER_KEY;
    t.after(() => {
        process.chdir(previousCwd);
        if (previousMasterKey === undefined) {
            delete process.env.PLOINKY_MASTER_KEY;
        } else {
            process.env.PLOINKY_MASTER_KEY = previousMasterKey;
        }
        rmSync(workspace, { recursive: true, force: true });
    });

    const nonce = `${Date.now()}-${Math.random()}`;
    const authHandlers = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/authHandlers.js')).href}?test=${nonce}`);
    const localService = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/auth/localService.js')).href}?test=${nonce}`);
    const routerHandlers = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/routerHandlers.js')).href}?test=${nonce}`);
    return { authHandlers, localService, routerHandlers };
}

test('protected HTTP service falls back to static auth and injects router auth info', async (t) => {
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
    localService.createLocalAuthUser({
        policy,
        username: 'admin',
        password: 'correct horse battery staple',
        roles: ['admin']
    });
    const login = localService.authenticateLocalUser({
        username: 'admin',
        password: 'correct horse battery staple',
        policy
    });
    const req = makeRequest({
        url: '/services/browser-use/sessions/sess_1?view=1',
        cookie: `ploinky_jwt=${login.sessionId}`,
        headers: {
            'x-ploinky-auth-info': '{"user":{"id":"spoofed"}}'
        }
    });
    const res = new MockWritableResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    const authResult = await authHandlers.ensureAuthenticated(req, res, parsedUrl);
    assert.equal(authResult.ok, true, res.body);
    assert.equal(req.authMode, 'local');
    assert.equal(req.user?.id, 'local:admin');

    const handled = routerHandlers.handleHttpServiceRoute(req, res, parsedUrl);
    assert.equal(handled, true);
    await res.done;

    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'ok');
    assert.equal(captured?.url, '/browser-use/sessions/sess_1?view=1');

    const authInfo = JSON.parse(captured?.headers['x-ploinky-auth-info'] || '{}');
    assert.equal(authInfo.user?.id, 'local:admin');
    assert.equal(authInfo.user?.username, 'admin');
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
    assert.equal(verified.payload.sub, 'user:local:admin');

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

test('protected HTTP service invocation rch binds the forwarded request body', async (t) => {
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
        url: '/services/browser-use/sessions/sess_guest?view=1',
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
});

test('protected HTTP service fails closed when invocation principal cannot be resolved', async (t) => {
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

test('protected HTTP service auth info carries user identity', async () => {
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
        auth: 'protected',
        delegations: [{
            targetAgentId: 'agent:./dpuAgent',
            tools: ['dpu_confidential_get'],
            scopes: ['dpu:confidential:read'],
            ttlSeconds: 1800,
        }],
    };
    const def = normalizeServiceSpec('onlyOffice', { repo: 'CustomRepoName', agent: 'onlyOffice' }, spec, 'protected');
    assert.equal(def.delegations[0].targetAgentId, 'agent:CustomRepoName/dpuAgent');
});

test('service delegation target with explicit repo is left unchanged', () => {
    const spec = {
        slug: 'onlyoffice', externalPrefix: '/services/onlyoffice/', internalPrefix: '/control/', auth: 'protected',
        delegations: [{ targetAgentId: 'agent:AchillesIDE/dpuAgent', tools: ['dpu_confidential_get'], scopes: ['dpu:confidential:read'], ttlSeconds: 1800 }],
    };
    const def = normalizeServiceSpec('onlyOffice', { repo: 'CustomRepoName', agent: 'onlyOffice' }, spec, 'protected');
    assert.equal(def.delegations[0].targetAgentId, 'agent:AchillesIDE/dpuAgent');
});

test('relative delegation target without a source repo is rejected', () => {
    const spec = {
        slug: 'onlyoffice', externalPrefix: '/services/onlyoffice/', internalPrefix: '/control/', auth: 'protected',
        delegations: [{ targetAgentId: 'agent:./dpuAgent', tools: ['dpu_confidential_get'], scopes: ['dpu:confidential:read'], ttlSeconds: 1800 }],
    };
    assert.throws(() => normalizeServiceSpec('onlyOffice', {}, spec, 'protected'), /cannot expand relative target/);
});
