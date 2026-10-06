import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'marketplace-scope-'));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const previousKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_WORKSPACE_ROOT = root;
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
fs.mkdirSync(path.join(root, '.ploinky/repos'), { recursive: true });
const { handleMarketplaceRoutes } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const { listAgentRepositoryNames, runWithRepositoryResolutionScope } = await import('../../cli/utils/agentRepositorySource.mjs');
const { setAgentRepositoryRegistered } = await import('../../cli/utils/agentRepositoryRegistration.mjs');
const { authService, SSO_AUTH_COOKIE_NAME } = await import('../../cli/server/authHandlers/shared.js');
const { mintBrowserCsrfToken } = await import('../../cli/server/browserMutationSecurity.js');
const admin = { sessionId: 'repository-admin-session', user: { id: 'admin', roles: ['admin'] } };
const configured = authService.isConfigured;
const validate = authService.validateSession;
authService.isConfigured = () => true;
authService.validateSession = async id => id === admin.sessionId ? admin : null;
const snapshot = { generation: 'scope-generation', agents: { shell: { type: 'agent', agentName: 'shell', repoName: 'repo', auth: { mode: 'sso' } } }, routing: { static: { agent: 'shell' }, routes: { shell: { agent: 'shell', repo: 'repo' } } }, manifests: {} };
const plan = () => ({ ok: true, kind: 'router-surface', surface: 'marketplace-ui', listener: 'public', hostSelection: { kind: 'agent-root', record: { routeKey: 'shell' } }, forwarding: { protocol: 'https', authority: 'explorer.example.test' }, snapshot, lease: { id: snapshot.generation, snapshot, commit: () => true } });
test.after(() => {
    authService.isConfigured = configured;
    authService.validateSession = validate;
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousKey;
    fs.rmSync(root, { recursive: true, force: true });
});
function checkout(name) {
    fs.mkdirSync(path.join(root, name, 'worker'), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'worker/manifest.json'), '{}');
}
async function request(resource, { body, ...options } = {}) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = body ? 'POST' : 'GET';
    req.headers = { host: 'explorer.example.test', origin: 'https://explorer.example.test', cookie: `${SSO_AUTH_COOKIE_NAME}=${admin.sessionId}` };
    req.session = admin;
    if (body) req.headers['x-ploinky-browser-csrf-token'] = mintBrowserCsrfToken({ req, routePlan: plan(), authContext: { boundHostRouteKey: 'shell' }, sessionId: admin.sessionId });
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); this.writableEnded = true; } };
    await handleMarketplaceRoutes(req, res, new URL(`https://explorer.example.test/api/marketplace/${resource}`), {
        routePlan: plan(), agentListOptions: { runtimeEntries: [], noWaitStates: new Map(), registry: {} }, ...options,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.marketplace;
}

test('marketplace agents GET scans the workspace once and the next request sees additions', async t => {
    checkout('catalog');
    const original = fs.readdirSync;
    let scans = 0;
    t.mock.method(fs, 'readdirSync', (target, ...args) => {
        if (target === root) scans += 1;
        return original(target, ...args);
    });
    const first = await request('agents');
    assert.ok(first.agents.some(agent => agent.ref === 'catalog/worker'));
    assert.equal(scans, 1);
    checkout('added');
    scans = 0;
    const next = await request('agents');
    assert.ok(next.agents.some(agent => agent.ref === 'added/worker'));
    assert.equal(scans, 1);
});

test('uninstall response uses a fresh scope after mutation even inside a caller scope', async () => {
    checkout('removed');
    await runWithRepositoryResolutionScope(async () => {
        assert.ok(listAgentRepositoryNames().includes('removed'));
        const payload = await request('repos', {
            body: { action: 'uninstall_repo', name: 'removed' },
            uninstallRepositoryAction: async () => {
                assert.ok(listAgentRepositoryNames().includes('removed'));
                setAgentRepositoryRegistered('removed', false);
                return { status: 'removed' };
            },
        });
        assert.ok(!payload.repositories.some(repo => repo.name === 'removed' && repo.installed));
    });
});
