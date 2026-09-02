import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previousCwd = process.cwd();
const previousKey = process.env.PLOINKY_MASTER_KEY;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-local-capability-'));
process.chdir(workspace);
process.env.PLOINKY_MASTER_KEY = '6'.repeat(64);
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
const { createLocalAuthUser, authenticateLocalUser } = await import('../../cli/server/auth/localService.js');
const { ensureHttpRouteAccess } = await import('../../cli/server/authHandlers/authContext.js');
test.after(() => {
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousKey;
    fs.rmSync(workspace, { recursive: true, force: true });
});

function response() {
    return {
        headers: {}, statusCode: 200,
        setHeader(name, value) { this.headers[name] = value; },
        getHeader(name) { return this.headers[name]; },
        writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
        end(body) { this.body = body; },
    };
}

test('an existing local account still reaches its upgraded protected browser route using the retained password store', async () => {
    const policy = { mode: 'local', usersVar: 'FIXTURE_LOCAL_USERS' };
    const account = createLocalAuthUser({ policy, username: 'retained', password: 'fixture password', roles: ['user'] });
    const loggedIn = authenticateLocalUser({ policy, username: 'retained', password: 'fixture password' });
    const passwordBytes = fs.readFileSync(path.join(workspace, '.ploinky', 'passwords.enc'));
    const snapshot = {
        agents: { app: { type: 'agent', agentName: 'app', repoName: 'fixture', auth: policy } },
        routing: { static: { agent: 'app' }, routes: { app: { container: 'app', repo: 'fixture', agent: 'app' } } },
        manifests: { app: { ploinky: 'sso enable', routerAccess: {
            requiredCapability: 'app.access', localAuthRoles: ['admin', 'user'],
        } } },
    };
    const url = new URL('http://localhost/base-agent-additional-server/app/7000/private');
    const req = { method: 'GET', url: url.pathname, headers: { host: 'localhost', cookie: `ploinky_jwt=${loggedIn.sessionId}` }, socket: {} };
    assert.equal((await ensureHttpRouteAccess(req, response(), url, { access: 'authenticated', routeKey: 'app' }, { snapshot })).ok, true);
    assert.equal(req.authMode, 'local');
    assert.equal(req.user.id, account.id);
    assert.equal(req.user.capabilities, undefined, 'the compatibility grant remains route-specific');
    assert.deepEqual(fs.readFileSync(path.join(workspace, '.ploinky', 'passwords.enc')), passwordBytes,
        'startup compatibility does not rewrite account ownership or credentials');

    const forged = { ...req, headers: { host: 'localhost', cookie: 'ploinky_jwt=unverified', accept: 'application/json' }, authMode: 'local' };
    const denied = response();
    assert.equal((await ensureHttpRouteAccess(forged, denied, url, { access: 'authenticated', routeKey: 'app' }, { snapshot })).ok, false);
    assert.equal(denied.statusCode, 401);
});
