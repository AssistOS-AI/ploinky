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

function makeRequest({ method = 'GET', url, body }) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    const req = Readable.from(chunks);
    req.method = method;
    req.url = url;
    req.headers = {
        accept: 'application/json',
        host: 'localhost',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    req.socket = { encrypted: false };
    return req;
}

async function invoke(handler, options) {
    const req = makeRequest(options);
    const res = new MockResponse();
    const parsedUrl = new URL(options.url, 'http://localhost');
    const handled = await handler(req, res, parsedUrl);
    return {
        handled,
        statusCode: res.statusCode,
        headers: res.headers,
        body: res.body ? JSON.parse(res.body) : null,
    };
}

test('user CRUD routes are gone while agent settings branding route remains', async (t) => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'ploinky-user-admin-removed-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    mkdirSync(ploinkyDir, { recursive: true });

    const previousCwd = process.cwd();
    const previousWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.chdir(workspace);
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    t.after(() => {
        process.chdir(previousCwd);
        if (previousWorkspaceRoot === undefined) {
            delete process.env.PLOINKY_WORKSPACE_ROOT;
        } else {
            process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspaceRoot;
        }
        rmSync(workspace, { recursive: true, force: true });
    });

    writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        explorer: {
            type: 'agent',
            agentName: 'explorer',
            repoName: 'AssistOSExplorer',
            auth: { mode: 'sso' },
        },
    }, null, 2));

    const nonce = Date.now();
    const authHandlers = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/authHandlers/index.js')).href}?test=${nonce}`);

    for (const request of [
        { url: '/api/agents/explorer/users' },
        { method: 'POST', url: '/api/agents/explorer/users', body: { username: 'editor', password: 'secret' } },
        { method: 'PATCH', url: '/api/agents/explorer/users/user-1', body: { roles: ['admin'] } },
        { method: 'DELETE', url: '/api/agents/explorer/users/user-1' },
    ]) {
        const result = await invoke(authHandlers.handleUserAdminRoutes, request);
        assert.equal(result.handled, true);
        assert.equal(result.statusCode, 410);
        assert.equal(result.body.error, 'local_auth_removed');
    }

    let result = await invoke(authHandlers.handleUserAdminRoutes, {
        url: '/api/agents/explorer/settings',
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.settings.loginBrandingName, 'Login');

    result = await invoke(authHandlers.handleUserAdminRoutes, {
        method: 'PATCH',
        url: '/api/agents/explorer/settings',
        body: {
            loginBrandingName: 'Acme Workspace',
        },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.settings.loginBrandingName, 'Acme Workspace');
});
