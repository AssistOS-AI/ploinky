import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-public-'));
const previousCwd = process.cwd();
const previousKey = process.env.PLOINKY_MASTER_KEY;
process.chdir(workspace);
process.env.PLOINKY_MASTER_KEY = '4'.repeat(64);
fs.mkdirSync('.ploinky');
const { handleMarketplaceRoutes } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const { authenticateLocalUser, getSession } = await import('../../cli/server/auth/localService.js');
const { hashPassword } = await import('../../cli/utils/security/localAuthPasswords.js');
const { setUsersPayload } = await import('../../cli/utils/security/encryptedPasswordStore.js');
const { mintBrowserCsrfToken } = await import('../../cli/server/browserMutationSecurity.js');
const { mintAdminCsrfToken } = await import('../../cli/server/adminControlSecurity.js');
const policy = { mode: 'local', usersVar: 'MARKETPLACE_TEST_USERS' };
const otherPolicy = { mode: 'local', usersVar: 'OTHER_TEST_USERS' };
for (const p of [policy, otherPolicy]) setUsersPayload(p.usersVar, { version: 1, users: ['admin', 'user'].map(username => ({
    id: `local:${username}`, username, passwordHash: hashPassword('fixture-password'), roles: username === 'admin' ? ['local', 'admin'] : ['local'], rev: 1,
})) });
const session = (username = 'admin', p = policy) => authenticateLocalUser({ username, password: 'fixture-password', policy: p, routeKey: 'shell' });
const admin = session();
const user = session('user');
const foreign = session('admin', otherPolicy);
const snapshot = { generation: 'generation-a', agents: { shell: { type: 'agent', agentName: 'shell', repoName: 'repo', auth: policy } }, routing: { static: { agent: 'shell' }, routes: { shell: { agent: 'shell', repo: 'repo' } } }, manifests: {} };
const plan = () => ({ ok: true, kind: 'router-surface', surface: 'marketplace-ui', listener: 'public', hostSelection: { kind: 'agent-root', record: { routeKey: 'shell' } }, forwarding: { protocol: 'https', authority: 'explorer.example.test' }, snapshot, lease: { id: snapshot.generation, snapshot, commit: () => true } });
let enabled = 0;
async function request({ who = admin, routePlan = plan(), origin = 'https://explorer.example.test', csrf = 'valid', method = 'POST', body = { action: 'enable_agent', agentRef: 'repo/worker', mode: 'global' }, mutate } = {}) {
    const req = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.headers = { host: 'explorer.example.test', origin, cookie: `ploinky_jwt=${who.sessionId}` };
    req.session = getSession(who.sessionId);
    if (csrf === 'valid') req.headers['x-ploinky-browser-csrf-token'] = mintBrowserCsrfToken({ req, routePlan: plan(), authContext: { boundHostRouteKey: 'shell' }, sessionId: who.sessionId });
    if (csrf === 'local') {
        req.headers.host = 'localhost'; req.headers.origin = 'http://localhost';
        req.headers['x-ploinky-csrf-token'] = mintAdminCsrfToken({ req, sessionId: who.sessionId });
    }
    if (mutate) mutate(req);
    const res = { status: 200, setHeader() {}, writeHead(code) { this.status = code; }, end(body) { this.body = JSON.parse(body); } };
    await handleMarketplaceRoutes(req, res, new URL('https://explorer.example.test/api/marketplace'), { routePlan, enableAgentAction: async () => { enabled++; return { result: { status: 'enabled' } }; } });
    return res;
}
test.after(() => { process.chdir(previousCwd); if (previousKey === undefined) delete process.env.PLOINKY_MASTER_KEY; else process.env.PLOINKY_MASTER_KEY = previousKey; fs.rmSync(workspace, { recursive: true, force: true }); });

test('public Marketplace admits a selected-root admin using routed browser CSRF', async () => {
    const before = enabled;
    const res = await request();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(enabled, before + 1);
    assert.equal(res.body.action, 'enable_agent');
});
test('public Marketplace rejects non-admin and foreign user-store sessions', async () => {
    const before = enabled;
    assert.equal((await request({ who: user })).status, 403);
    assert.equal((await request({ who: foreign })).status, 401);
    assert.equal(enabled, before);
});
test('public Marketplace rejects missing proof, cross-origin, host and generation replay', async () => {
    const before = enabled;
    for (const options of [{ csrf: 'missing' }, { origin: 'https://evil.test' },
        { routePlan: { ...plan(), lease: { ...plan().lease, id: 'generation-b' } } },
        { routePlan: { ...plan(), forwarding: { protocol: 'https', authority: 'other.test' } } },
        { routePlan: { ...plan(), surface: 'user-admin' } },
        { routePlan: { ...plan(), hostSelection: { kind: 'dedicated-service', record: { routeKey: 'shell' } } } }]) {
        assert.ok([401, 403].includes((await request(options)).status), JSON.stringify(options));
    }
    assert.equal(enabled, before);
});
test('public Marketplace revalidates the lease before mutation', async () => {
    let calls = 0;
    const before = enabled;
    assert.equal((await request({ routePlan: { ...plan(), lease: { ...plan().lease, commit: () => ++calls < 2 } } })).status, 503);
    assert.equal(enabled, before);
});
test('local Marketplace still requires local control proof', async () => {
    assert.equal((await request({ routePlan: null, csrf: 'local' })).status, 200);
    assert.equal((await request({ routePlan: null })).status, 403);
});

test('Marketplace reads advertise management only for a usable administrator origin', async () => {
    assert.equal((await request({ method: 'GET' })).body.marketplace.permissions.canManage, true);
    assert.equal((await request({ method: 'GET', who: user })).body.marketplace.permissions.canManage, false);
    assert.equal((await request({ method: 'GET', routePlan: null })).body.marketplace.permissions.canManage, false);
    assert.equal((await request({ method: 'GET', who: foreign })).status, 401);
});

test('queued activations revalidate immediately before starting the worker', async () => {
    const { enableMarketplaceAgent } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    let started;
    const firstStarted = new Promise(resolve => { started = resolve; });
    const first = enableMarketplaceAgent({ agentRef: 'repo/first' }, {
        runEnableWorker: async () => { started(); await blocked; return {}; },
    });
    await firstStarted;
    let checks = 0;
    const second = enableMarketplaceAgent({ agentRef: 'repo/second' }, {
        beforeEnable: () => { checks++; throw new Error('stale generation'); },
        runEnableWorker: async () => assert.fail('stale queued mutation started'),
    });
    const rejected = assert.rejects(second, /stale generation/);
    assert.equal(checks, 0);
    release();
    await first;
    await rejected;
    assert.equal(checks, 1);
});


test('Marketplace skill recommendations prefer the workspace checkout over installed copies', async () => {
    fs.mkdirSync(path.join(workspace, '.ploinky/repos/DocumentationSkills/.git'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'DocumentationSkills/.git'), { recursive: true });
    const res = await request({ method: 'GET' });
    assert.equal(res.status, 200);
    const repo = res.body.marketplace.repositories.find(item => item.name === 'DocumentationSkills');
    assert.equal(repo.kind, 'skills');
    assert.deepEqual(repo.skillSource, { source: path.join(workspace, 'DocumentationSkills'), origin: 'workspace' });
});
