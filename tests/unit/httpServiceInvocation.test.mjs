import test from 'node:test';
import assert from 'node:assert/strict';
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

function makeRequest({ method = 'GET', url, cookie = '', headers = {} }) {
    const req = Readable.from([]);
    req.method = method;
    req.url = url;
    req.headers = {
        accept: 'application/json',
        host: 'localhost',
        ...headers,
        ...(cookie ? { cookie } : {})
    };
    req.socket = { encrypted: false };
    return req;
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

async function withRouterModules(t, servicePort) {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'ploinky-http-service-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    mkdirSync(ploinkyDir, { recursive: true });
    writeFileSync(path.join(ploinkyDir, '.secrets'), '# test secrets\n');
    writeWorkspaceConfig(ploinkyDir, servicePort);

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
            'x-ploinky-auth-info': '{"user":{"id":"spoofed"}}',
            'x-ploinky-caller-jwt': 'spoofed-token'
        }
    });
    const res = new MockWritableResponse();
    const parsedUrl = new URL(req.url, 'http://localhost');

    const authResult = await authHandlers.ensureAuthenticated(req, res, parsedUrl);
    assert.equal(authResult.ok, true);
    assert.equal(req.authMode, 'local');
    assert.equal(req.user?.id, 'local:admin');

    const handled = routerHandlers.handleHttpServiceRoute(req, res, parsedUrl);
    assert.equal(handled, true);
    await res.done;

    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'ok');
    assert.equal(captured?.url, '/browser-use/sessions/sess_1?view=1');
    assert.equal(captured?.headers['x-ploinky-caller-jwt'], undefined);

    const authInfo = JSON.parse(captured?.headers['x-ploinky-auth-info'] || '{}');
    assert.equal(authInfo.user?.id, 'local:admin');
    assert.equal(authInfo.user?.username, 'admin');
    assert.deepEqual(authInfo.user?.roles, ['local', 'admin']);
    assert.ok(authInfo.sessionId);
    assert.ok(authInfo.invocationToken);
});

test('protected HTTP service auth info carries router invocation token', async () => {
    const { buildPlainAuthInfoHeader } = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/routerHandlers.js')).href}?plain=${Date.now()}`);
    const headers = buildPlainAuthInfoHeader({
        user: {
            id: 'local:admin',
            username: 'admin',
            email: 'admin@example.com',
            roles: ['admin']
        },
        sessionId: 'session-1'
    }, {
        token: 'router-issued-invocation'
    });

    const authInfo = JSON.parse(headers['x-ploinky-auth-info']);

    assert.deepEqual(authInfo.user, {
        id: 'local:admin',
        username: 'admin',
        email: 'admin@example.com',
        roles: ['admin']
    });
    assert.equal(authInfo.sessionId, 'session-1');
    assert.equal(authInfo.invocationToken, 'router-issued-invocation');
});
