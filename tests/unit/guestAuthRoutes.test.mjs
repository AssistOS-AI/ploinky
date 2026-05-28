import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MASTER_KEY = '4'.repeat(64);

class MockResponse {
    constructor() {
        this.statusCode = 200;
        this.headers = new Map();
        this.body = '';
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

    end(chunk = '') {
        this.body += chunk ? String(chunk) : '';
    }
}

function makeRequest({ method = 'GET', url, body, cookie = '', accept = 'application/json' }) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    const req = Readable.from(chunks);
    req.method = method;
    req.url = url;
    req.headers = {
        accept,
        host: 'localhost',
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    req.socket = { encrypted: false };
    return req;
}

function writeWorkspaceConfig(ploinkyDir) {
    writeFileSync(path.join(ploinkyDir, '.secrets'), '# test secrets\n');
    const webAdminManifestDir = path.join(ploinkyDir, 'repos', 'webassist', 'webAdmin');
    const serviceManifestDir = path.join(ploinkyDir, 'repos', 'services', 'guestAgent');
    mkdirSync(webAdminManifestDir, { recursive: true });
    mkdirSync(serviceManifestDir, { recursive: true });
    writeFileSync(path.join(webAdminManifestDir, 'manifest.json'), JSON.stringify({
        webchat: { auth: 'static' },
    }, null, 2));
    writeFileSync(path.join(serviceManifestDir, 'manifest.json'), JSON.stringify({
        httpServices: [
            {
                externalPrefix: '/public-services/meeting-room/',
                internalPrefix: '/api/',
                auth: 'guest',
                guestScope: 'meeting-room-public-service',
                forceGuest: true,
            },
            {
                externalPrefix: '/public-services/visitor-support/',
                internalPrefix: '/api/',
                auth: 'guest',
                guestScope: 'visitor-support-public-service',
            },
        ],
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        explorer: {
            type: 'agent',
            agentName: 'explorer',
            repoName: 'AchillesIDE',
            auth: { mode: 'local', usersVar: 'PLOINKY_AUTH_EXPLORER_USERS' },
        },
        webAssist: {
            type: 'agent',
            agentName: 'webAssist',
            repoName: 'webassist',
            auth: { mode: 'guest' },
        },
        webAdmin: {
            type: 'agent',
            agentName: 'webAdmin',
            repoName: 'webassist',
            auth: { mode: 'none' },
        },
        guestAgent: {
            type: 'agent',
            agentName: 'guestAgent',
            repoName: 'services',
            auth: { mode: 'none' },
        },
    }, null, 2));
    writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        routes: {
            explorer: { agent: 'explorer', repo: 'AchillesIDE', hostPort: 55289 },
            webAssist: { agent: 'webAssist', repo: 'webassist', hostPort: 53659 },
            webAdmin: { agent: 'webAdmin', repo: 'webassist', hostPort: 41155 },
            guestAgent: {
                agent: 'guestAgent',
                repo: 'services',
                hostPort: 43111,
                hostPath: serviceManifestDir,
            },
        },
        static: {
            agent: 'explorer',
            hostPath: '/tmp/explorer',
        },
    }, null, 2));
}

async function withAuthModules(t) {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'ploinky-guest-auth-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    mkdirSync(ploinkyDir, { recursive: true });
    writeWorkspaceConfig(ploinkyDir);

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
    return { authHandlers, localService };
}

test('guest routes use the guest agent policy instead of the static Explorer policy', async (t) => {
    const { authHandlers } = await withAuthModules(t);
    const mcpReq = makeRequest({
        method: 'POST',
        url: '/webAssist/mcp',
    });
    const mcpRes = new MockResponse();
    const mcpParsedUrl = new URL(mcpReq.url, 'http://localhost');

    const mcpResult = await authHandlers.ensureAuthenticated(mcpReq, mcpRes, mcpParsedUrl);

    assert.equal(mcpResult.ok, true);
    assert.equal(mcpReq.authMode, 'guest');
    assert.equal(mcpReq.user?.username, 'visitor');
    assert.deepEqual(mcpReq.user?.roles, ['guest']);
    assert.match(String(mcpRes.getHeader('set-cookie') || ''), /^ploinky_guest=/);
    assert.doesNotMatch(String(mcpRes.getHeader('set-cookie') || ''), /^ploinky_jwt=/);

    const guestJwt = String(mcpReq.sessionId || '');
    const tokenReq = makeRequest({
        method: 'GET',
        url: '/auth/token?agent=webAssist',
        cookie: `ploinky_guest=${guestJwt}`,
    });
    const tokenRes = new MockResponse();
    const tokenParsedUrl = new URL(tokenReq.url, 'http://localhost');

    const handled = await authHandlers.handleAuthRoutes(tokenReq, tokenRes, tokenParsedUrl);
    const body = JSON.parse(tokenRes.body || '{}');

    assert.equal(handled, true);
    assert.equal(tokenRes.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.token.accessToken, null);
    assert.equal(body.user.username, 'visitor');
    assert.deepEqual(body.user.roles, ['guest']);
    assert.match(String(tokenRes.getHeader('set-cookie') || ''), /^ploinky_guest=/);
    assert.match(String(tokenRes.getHeader('set-cookie') || ''), /Max-Age=3600/);

    const noAuthMcpReq = makeRequest({
        method: 'POST',
        url: '/webAdmin/mcp',
    });
    const noAuthMcpRes = new MockResponse();
    const noAuthMcpParsedUrl = new URL(noAuthMcpReq.url, 'http://localhost');

    const noAuthMcpResult = await authHandlers.ensureAuthenticated(noAuthMcpReq, noAuthMcpRes, noAuthMcpParsedUrl);
    const noAuthMcpBody = JSON.parse(noAuthMcpRes.body || '{}');

    assert.equal(noAuthMcpResult.ok, false);
    assert.equal(noAuthMcpRes.statusCode, 401);
    assert.equal(noAuthMcpBody.error, 'not_authenticated');
    assert.match(noAuthMcpBody.login, /agent=explorer/);

    const webAdminChatReq = makeRequest({
        url: '/webchat?agent=webAdmin',
        accept: 'text/html',
    });
    const webAdminChatRes = new MockResponse();
    const webAdminChatParsedUrl = new URL(webAdminChatReq.url, 'http://localhost');

    const webAdminChatResult = await authHandlers.ensureAuthenticated(webAdminChatReq, webAdminChatRes, webAdminChatParsedUrl);

    assert.equal(webAdminChatResult.ok, false);
    assert.equal(webAdminChatRes.statusCode, 302);

    const location = new URL(String(webAdminChatRes.getHeader('location') || ''), 'http://localhost');
    assert.equal(location.pathname, '/auth/login');
    assert.equal(location.searchParams.get('agent'), 'explorer');
    assert.equal(location.searchParams.get('returnTo'), '/webchat?agent=webAdmin');
    assert.doesNotMatch(String(webAdminChatRes.getHeader('set-cookie') || ''), /^ploinky_guest=/);

    const webAssistChatReq = makeRequest({
        url: '/webchat?agent=webAssist',
        accept: 'text/html',
    });
    const webAssistChatRes = new MockResponse();
    const webAssistChatParsedUrl = new URL(webAssistChatReq.url, 'http://localhost');

    const webAssistChatResult = await authHandlers.ensureAuthenticated(webAssistChatReq, webAssistChatRes, webAssistChatParsedUrl);

    assert.equal(webAssistChatResult.ok, true);
    assert.equal(webAssistChatReq.authMode, 'guest');
    assert.equal(webAssistChatReq.user?.username, 'visitor');
    assert.match(String(webAssistChatRes.getHeader('set-cookie') || ''), /^ploinky_guest=/);
});

test('guest public services use scoped forced guest sessions', async (t) => {
    const { authHandlers, localService } = await withAuthModules(t);
    const localJwt = localService.mintSessionJwt({
        id: 'local:admin',
        username: 'admin',
        name: 'Admin',
        roles: ['local', 'admin']
    }, 1);

    const guestServiceReq = makeRequest({
        url: '/public-services/meeting-room/guest?room=room-1&token=invite',
        cookie: `ploinky_jwt=${localJwt}`
    });
    const guestServiceRes = new MockResponse();
    const guestServiceParsedUrl = new URL(guestServiceReq.url, 'http://localhost');

    const guestServiceResult = await authHandlers.ensureAuthenticated(guestServiceReq, guestServiceRes, guestServiceParsedUrl);

    assert.equal(guestServiceResult.ok, true);
    assert.equal(guestServiceReq.authMode, 'guest');
    assert.equal(guestServiceReq.user?.username, 'visitor');
    assert.deepEqual(guestServiceReq.user?.roles, ['guest']);
    assert.match(String(guestServiceRes.getHeader('set-cookie') || ''), /^ploinky_guest=/);

    const guestServiceJwt = String(guestServiceReq.sessionId || '');
    assert.equal(localService.getSession(guestServiceJwt, { policy: { mode: 'guest' } }), null);
    assert.equal(
        localService.getSession(guestServiceJwt, { policy: { mode: 'guest', guestScope: 'meeting-room-public-service' } })?.user?.username,
        'visitor'
    );
});

test('guest public services follow normal guest policy unless forceGuest is set', async (t) => {
    const { authHandlers, localService } = await withAuthModules(t);
    const localJwt = localService.mintSessionJwt({
        id: 'local:admin',
        username: 'admin',
        name: 'Admin',
        roles: ['local', 'admin']
    }, 1);

    const localReq = makeRequest({
        url: '/public-services/visitor-support/chat',
        cookie: `ploinky_jwt=${localJwt}`
    });
    const localRes = new MockResponse();
    const localParsedUrl = new URL(localReq.url, 'http://localhost');

    const localResult = await authHandlers.ensureAuthenticated(localReq, localRes, localParsedUrl);

    assert.equal(localResult.ok, true);
    assert.equal(localReq.authMode, 'local');
    assert.equal(localReq.user?.username, 'admin');
    assert.doesNotMatch(String(localRes.getHeader('set-cookie') || ''), /^ploinky_guest=/);

    const guestReq = makeRequest({
        url: '/public-services/visitor-support/chat',
    });
    const guestRes = new MockResponse();
    const guestParsedUrl = new URL(guestReq.url, 'http://localhost');

    const guestResult = await authHandlers.ensureAuthenticated(guestReq, guestRes, guestParsedUrl);

    assert.equal(guestResult.ok, true);
    assert.equal(guestReq.authMode, 'guest');
    assert.equal(guestReq.user?.username, 'visitor');
    assert.match(String(guestRes.getHeader('set-cookie') || ''), /^ploinky_guest=/);

    const guestJwt = String(guestReq.sessionId || '');
    assert.equal(localService.getSession(guestJwt, { policy: { mode: 'guest' } }), null);
    assert.equal(
        localService.getSession(guestJwt, { policy: { mode: 'guest', guestScope: 'visitor-support-public-service' } })?.user?.username,
        'visitor'
    );
});
