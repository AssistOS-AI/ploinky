import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'marketplace-projection-'));
const previousCwd = process.cwd();
const previousKey = process.env.PLOINKY_MASTER_KEY;
process.chdir(workspace);
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
fs.mkdirSync('.ploinky');
const { handleMarketplaceRoutes, __testables } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const { authService, SSO_AUTH_COOKIE_NAME } = await import('../../cli/server/authHandlers/shared.js');
const { remoteUrlOrEmpty } = await import('../../cli/server/authHandlers/marketplaceProjection.js');

const principals = {
    // Named "admin" but holding no administrator role: the username is not the policy.
    namedAdmin: { sessionId: 's-named-admin', user: { id: 'admin', username: 'admin', roles: ['user'] } },
    ordinary: { sessionId: 's-ordinary', user: { id: 'u1', username: 'ordinary', roles: ['user'] } },
    selfRegistered: { sessionId: 's-self', user: { id: 'u2', username: 'newcomer', roles: ['selfRegistered'] } },
    noRoles: { sessionId: 's-noroles', user: { id: 'u3', username: 'plain' } },
    guestAdmin: { sessionId: 's-guest-admin', user: { id: 'g1', username: 'ops', roles: ['admin', 'guest'] } },
    // Genuine administrator whose username is not "admin".
    realAdmin: { sessionId: 's-real-admin', user: { id: 'ops-1', username: 'operations', roles: ['admin'] } },
};
const originalConfigured = authService.isConfigured;
const originalValidate = authService.validateSession;
authService.isConfigured = () => true;
authService.validateSession = async id => Object.values(principals).find(item => item.sessionId === id) || null;

const snapshot = { generation: 'generation-p', agents: { shell: { type: 'agent', agentName: 'shell', repoName: 'repo', auth: { mode: 'sso' } } }, routing: { static: { agent: 'shell' }, routes: { shell: { agent: 'shell', repo: 'repo' } } }, manifests: {} };
const plan = () => ({ ok: true, kind: 'router-surface', surface: 'marketplace-ui', listener: 'public', hostSelection: { kind: 'agent-root', record: { routeKey: 'shell' } }, forwarding: { protocol: 'https', authority: 'explorer.example.test' }, snapshot, lease: { id: snapshot.generation, snapshot, commit: () => true } });

async function get(resource, who) {
    const req = Readable.from([]);
    req.method = 'GET';
    req.headers = { host: 'explorer.example.test', cookie: `${SSO_AUTH_COOKIE_NAME}=${who.sessionId}` };
    const res = { status: 200, setHeader() {}, writeHead(code) { this.status = code; }, end(body) { this.body = JSON.parse(body); } };
    await handleMarketplaceRoutes(req, res, new URL(`https://explorer.example.test/api/marketplace/${resource}`), { routePlan: plan(), agentListOptions: { liveContainers: [] } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
}

const skillsRoot = path.join(workspace, 'DocumentationSkills');
const localOnlyRoot = path.join(workspace, 'LocalOnlySkills');
const agentsRoot = path.join(workspace, 'LocalAgentsCheckout');
fs.mkdirSync(path.join(skillsRoot, '.git'), { recursive: true });
fs.mkdirSync(path.join(localOnlyRoot, '.git'), { recursive: true });
fs.mkdirSync(path.join(localOnlyRoot, 'skills/local-example'), { recursive: true });
fs.writeFileSync(path.join(localOnlyRoot, 'skills/local-example/SKILL.md'), '---\nname: local-example\ndescription: Local example\n---\n');
fs.mkdirSync(path.join(agentsRoot, 'worker'), { recursive: true });
fs.writeFileSync(path.join(agentsRoot, 'worker', 'manifest.json'), JSON.stringify({ container: 'node:22' }));
const physicalWorkspace = fs.realpathSync(workspace);

test.after(() => { authService.isConfigured = originalConfigured; authService.validateSession = originalValidate; process.chdir(previousCwd); if (previousKey === undefined) delete process.env.PLOINKY_MASTER_KEY; else process.env.PLOINKY_MASTER_KEY = previousKey; fs.rmSync(workspace, { recursive: true, force: true }); });

const walk = (value, visit, key = '') => {
    visit(value, key);
    if (Array.isArray(value)) value.forEach(item => walk(item, visit, key));
    else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) walk(item, visit, name);
};
function assertNoLocalPaths(body, label) {
    const text = JSON.stringify(body);
    for (const needle of [workspace, physicalWorkspace, 'manifest.json']) assert.equal(text.includes(needle), false, `${label}: leaked ${needle}`);
    walk(body, (value, key) => {
        assert.notEqual(key, 'source', `${label}: source key present`);
        assert.notEqual(key, 'manifestPath', `${label}: manifestPath key present`);
        if (typeof value === 'string') assert.equal(path.isAbsolute(value), false, `${label}: absolute path value ${value}`);
    });
}
const repo = (body, name) => body.marketplace.repositories.find(item => item.name === name);

test('non-admin principals receive no local path from any marketplace endpoint', async () => {
    for (const [label, who] of Object.entries(principals)) {
        if (label === 'realAdmin') continue;
        for (const resource of ['repos', 'agents', 'list-repos']) {
            const body = await get(resource, who);
            assertNoLocalPaths(body, `${label} ${resource}`);
            if (resource === 'agents') assert.ok(body.marketplace.agents.some(agent => agent.ref === 'LocalAgentsCheckout/worker'), `${label}: agent still listed`);
        }
        // Safe display fields survive the projection.
        const repos = await get('repos', who);
        assert.equal(repo(repos, 'DocumentationSkills').skillSource.origin, 'workspace');
        assert.equal(repo(repos, 'LocalAgentsCheckout').workspacePath, './LocalAgentsCheckout');
        assert.ok(repo(repos, 'DocumentationSkills').url.startsWith('https://'));
        assert.equal(repo(repos, 'LocalOnlySkills').url, '');
        assert.equal(repo(repos, 'LocalOnlySkills').repositorySource.url, '');
    }
});

test('a genuine administrator with another username keeps the source and manifest paths', async () => {
    const repos = await get('repos', principals.realAdmin);
    assert.deepEqual(repo(repos, 'DocumentationSkills').skillSource, { source: skillsRoot, origin: 'workspace' });
    assert.equal(repo(repos, 'LocalOnlySkills').url, localOnlyRoot);
    assert.deepEqual(repo(repos, 'LocalOnlySkills').skillSource, { source: localOnlyRoot, origin: 'workspace' });
    assert.equal(repo(repos, 'LocalOnlySkills').repositorySource.source, localOnlyRoot);
    const agents = await get('agents', principals.realAdmin);
    const worker = agents.marketplace.agents.find(agent => agent.ref === 'LocalAgentsCheckout/worker');
    assert.equal(worker.manifestPath, path.join(agentsRoot, 'worker', 'manifest.json'));
    const listed = await get('list-repos', principals.realAdmin);
    assert.equal(listed.repositories.find(item => item.name === 'LocalOnlySkills').source, localOnlyRoot);
});

test('admin and non-admin requests in sequence never share a projection', async () => {
    const order = ['realAdmin', 'namedAdmin', 'realAdmin', 'guestAdmin', 'selfRegistered', 'realAdmin', 'ordinary'];
    for (const label of order) {
        for (const resource of ['repos', 'agents', 'list-repos']) {
            const body = await get(resource, principals[label]);
            if (label === 'realAdmin') {
                assert.equal(JSON.stringify(body).includes(resource === 'agents' ? agentsRoot : skillsRoot), true, `${label} ${resource} lost admin data`);
            } else assertNoLocalPaths(body, `${label} ${resource} after admin`);
        }
    }
});

test('the combined state builder is path-free unless the caller is a genuine administrator', () => {
    const { buildMarketplaceState } = __testables;
    assertNoLocalPaths(buildMarketplaceState(null, { liveContainers: [] }), 'no user');
    assertNoLocalPaths(buildMarketplaceState(principals.namedAdmin.user, { liveContainers: [] }), 'named admin');
    assertNoLocalPaths(buildMarketplaceState(principals.guestAdmin.user, { liveContainers: [] }), 'guest admin');
    assert.equal(JSON.stringify(buildMarketplaceState(principals.realAdmin.user, { liveContainers: [] })).includes(skillsRoot), true);
});

test('only remote Git origins survive URL projection', () => {
    for (const url of ['https://github.com/o/r.git', 'http://host/r.git', 'ssh://git@host/o/r.git', 'git://host/r.git', 'git@github.com:o/r.git']) assert.equal(remoteUrlOrEmpty(url), url);
    for (const url of ['/Users/x/work/repo', 'file:///Users/x/repo', './repo', '../repo', '~/repo', 'C:\\repo', '', undefined, null, 5]) assert.equal(remoteUrlOrEmpty(url), '', String(url));
});

test('free-text startup failure detail is withheld from non-administrators', () => {
    const { buildMarketplaceState } = __testables;
    const leaky = `phase: start \u2014 ENOENT: no such file or directory, open '${agentsRoot}/worker/secret.json'`;
    const options = {
        liveContainers: [],
        registry: { workerKey: { type: 'agent', repoName: 'LocalAgentsCheckout', agentName: 'worker', runtime: 'bwrap' } },
        noWaitStates: new Map([['workerKey', { status: 'failed', detail: leaky }]]),
    };
    const detailOf = state => state.agents.find(agent => agent.ref === 'LocalAgentsCheckout/worker');
    assert.equal(detailOf(buildMarketplaceState(principals.realAdmin.user, options)).statusDetail, leaky);
    for (const label of ['namedAdmin', 'guestAdmin', 'ordinary']) {
        const agent = detailOf(buildMarketplaceState(principals[label].user, options));
        assert.equal(agent.status, 'failed');
        assert.equal('statusDetail' in agent, false, label);
        assertNoLocalPaths(agent, label);
    }
});
