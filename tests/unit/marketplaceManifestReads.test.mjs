import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'marketplace-manifest-reads-'));
const root = path.join(base, 'workspace');
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const previousKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_WORKSPACE_ROOT = root;
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
fs.mkdirSync(path.join(root, '.ploinky/repos'), { recursive: true });
const { handleMarketplaceRoutes } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const { authService, SSO_AUTH_COOKIE_NAME } = await import('../../cli/server/authHandlers/shared.js');

const admin = { sessionId: 'manifest-reads-session', user: { id: 'admin', roles: ['admin'] } };
const configured = authService.isConfigured;
const validate = authService.validateSession;
authService.isConfigured = () => true;
authService.validateSession = async id => id === admin.sessionId ? admin : null;
const snapshot = { generation: 'g', agents: { shell: { type: 'agent', agentName: 'shell', repoName: 'repo', auth: { mode: 'sso' } } }, routing: { static: { agent: 'shell' }, routes: { shell: { agent: 'shell', repo: 'repo' } } }, manifests: {} };
const plan = () => ({ ok: true, kind: 'router-surface', surface: 'marketplace-ui', listener: 'public', hostSelection: { kind: 'agent-root', record: { routeKey: 'shell' } }, forwarding: { protocol: 'https', authority: 'explorer.example.test' }, snapshot, lease: { id: snapshot.generation, snapshot, commit: () => true } });

test.after(() => {
    authService.isConfigured = configured;
    authService.validateSession = validate;
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousKey;
    fs.rmSync(base, { recursive: true, force: true });
});

function agent(repo, name, content) {
    fs.mkdirSync(path.join(root, repo, name), { recursive: true });
    fs.writeFileSync(path.join(root, repo, name, 'manifest.json'), content);
}

async function listAgents() {
    const req = Readable.from([]);
    req.method = 'GET';
    req.headers = { host: 'explorer.example.test', origin: 'https://explorer.example.test', cookie: `${SSO_AUTH_COOKIE_NAME}=${admin.sessionId}` };
    req.session = admin;
    const res = Object.assign(new EventEmitter(), {
        setHeader() {}, writeHead(status) { this.status = status; },
        end(value) { this.body = JSON.parse(value); this.writableEnded = true; this.emit('close'); },
    });
    await handleMarketplaceRoutes(req, res, new URL('https://explorer.example.test/api/marketplace/agents'), {
        routePlan: plan(), agentListOptions: { runtimeEntries: [], noWaitStates: new Map(), registry: {} },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return (res.body.marketplace || res.body).agents;
}

test('a marketplace agents request parses each agent manifest once', async t => {
    agent('catalog', 'alpha', JSON.stringify({ about: 'Alpha', enableModes: ['devel', 'isolated'] }));
    agent('catalog', 'beta', JSON.stringify({ about: 'Beta' }));
    agent('catalog', 'broken', '{not json');
    agent('extra', 'gamma', JSON.stringify({ about: 'Gamma', enableModes: ['bogus'] }));

    const original = fs.readFileSync;
    const reads = new Map();
    t.mock.method(fs, 'readFileSync', (target, ...args) => {
        const key = typeof target === 'string' ? target : '';
        if (key.endsWith(`${path.sep}manifest.json`) && key.startsWith(root)) reads.set(key, (reads.get(key) || 0) + 1);
        return original(target, ...args);
    });

    const agents = await listAgents();
    const byRef = new Map(agents.map(entry => [entry.ref, entry]));
    for (const ref of ['catalog/alpha', 'catalog/beta', 'catalog/broken', 'extra/gamma']) assert.ok(byRef.has(ref), ref);

    assert.equal(reads.size, 4);
    assert.deepEqual([...reads.values()], [1, 1, 1, 1], JSON.stringify([...reads]));

    // Behaviour is unchanged: declared modes, defaults for no/unreadable/invalid declarations.
    assert.deepEqual(byRef.get('catalog/alpha').enableModes, ['devel', 'isolated']);
    assert.equal(byRef.get('catalog/alpha').enableMode, 'devel');
    assert.equal(byRef.get('catalog/alpha').about, 'Alpha');
    for (const ref of ['catalog/beta', 'catalog/broken', 'extra/gamma']) {
        assert.ok(byRef.get(ref).enableModes.length > 1, ref);
    }
    assert.equal(byRef.get('catalog/broken').about, '');

    // No cross-request cache: the next request reads each manifest again.
    reads.clear();
    await listAgents();
    assert.deepEqual([...reads.values()], [1, 1, 1, 1]);
});
