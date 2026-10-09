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
const { signAgentHttpAssertion } = await import('../../Agent/lib/agentAssertion.mjs');
const { deriveAgentRequestSecret } = await import('../../cli/utils/security/masterKey.js');
const { remoteUrlOrEmpty } = await import('../../cli/server/authHandlers/marketplaceProjection.js');

const principals = {
    // Named "admin" but holding no administrator role: the username is not the policy.
    namedAdmin: { sessionId: 's-named-admin', user: { id: 'admin', username: 'admin', roles: ['user'] } },
    ordinary: { sessionId: 's-ordinary', user: { id: 'u1', username: 'ordinary', roles: ['user'] } },
    selfRegistered: { sessionId: 's-self', user: { id: 'u2', username: 'newcomer', roles: ['selfRegistered'] } },
    noRoles: { sessionId: 's-noroles', user: { id: 'u3', username: 'plain' } },
    guest: { sessionId: 's-guest', user: { id: 'g0', username: 'visitor', roles: ['guest'] } },
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

// Shared URL vectors: [input, expected non-admin display value]. Sentinels mark
// credential material that must never survive in any form.
const URL_PROJECTION_VECTORS = [
    ['https://github.com/o/r.git', 'https://github.com/o/r.git'],
    ['http://host.example/r.git', 'http://host.example/r.git'],
    ['git://host.example/r.git', 'git://host.example/r.git'],
    ['https://git.example:8443/group/sub/r.git', 'https://git.example:8443/group/sub/r.git'],
    ['HTTPS://GitHub.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://github.com', 'https://github.com/'],
    // Userinfo is removed whatever it holds, including a token used as the username.
    ['https://user:SENTINELPW@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://SENTINELTOKEN@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://x-access-token:SENTINELTOKEN@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://SENTINEL%40TOKEN:SENTINEL%3APW@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://:SENTINELPW@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['ssh://git@host.example/o/r.git', 'ssh://host.example/o/r.git'],
    ['ssh://SENTINELTOKEN@host.example:2222/o/r.git', 'ssh://host.example:2222/o/r.git'],
    // Query and fragment data are dropped rather than guessed at.
    ['https://github.com/o/r.git?access_token=SENTINELQUERY', 'https://github.com/o/r.git'],
    ['https://github.com/o/r.git#SENTINELFRAGMENT', 'https://github.com/o/r.git'],
    ['https://SENTINELTOKEN@github.com/o/r.git?private_token=SENTINELQUERY#SENTINELFRAGMENT', 'https://github.com/o/r.git'],
    // scp-style: the user part is removed whatever it holds.
    ['git@github.com:o/r.git', 'github.com:o/r.git'],
    ['SENTINELTOKEN@github.com:o/r.git', 'github.com:o/r.git'],
    ['SENTINELUSER:SENTINELPW@github.com:o/r.git', ''],
    // Ambiguous forms fail closed.
    ['https://host.example/user:SENTINELPW@evil.example/r.git', ''],
    ['https://host.example/SENTINEL%40TOKEN/r.git', ''],
    ['https://host.example/%2e%2e/SENTINELPATH', 'https://host.example/SENTINELPATH'],
    ['https://user:SENTINELPW@host.example\\@evil.example/r', ''],
    ['https://host.example/r .git', ''],
    ['https://host.example/r\n.git', ''],
    ['https://[::1]/r.git', ''],
    ['git+ssh://git@host.example/r.git', ''],
    ['ftp://host.example/r.git', ''],
    ['https://', ''],
    ['git@host:/', ''],
    ['git@C:/Users/x/repo', ''],
    ['git@host.example://r.git', ''],
    ['user@localhost:repo', ''],
    // Local locations never reappear through a URL.
    ['/Users/x/work/repo', ''],
    ['file:///Users/x/repo', ''],
    ['file://host.example/r.git', ''],
    ['./repo', ''],
    ['../repo', ''],
    ['~/repo', ''],
    ['C:\\repo', ''],
    ['repo', ''],
    ['', ''],
    [undefined, ''],
    [null, ''],
    [5, ''],
    [{ toString: () => 'https://github.com/o/r.git' }, ''],
];

test('URL projection emits only credential-free remote origins', () => {
    for (const [input, expected] of URL_PROJECTION_VECTORS) {
        const actual = remoteUrlOrEmpty(input);
        assert.equal(actual, expected, `projection of ${JSON.stringify(String(input))}`);
        assert.equal(/SENTINEL(?!PATH)|%40|@[^:/]*:/.test(actual), false, `credential material survived for ${String(input)}`);
        assert.equal(actual.includes('?') || actual.includes('#'), false, `query or fragment survived for ${String(input)}`);
    }
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

const callerPrincipal = 'agent:repo/caller';
const agentEnv = { PLOINKY_AGENT_ID: callerPrincipal, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(callerPrincipal) };
const { MARKETPLACE_AGENT_TARGET } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const cookieOf = who => ({ cookie: `${SSO_AUTH_COOKIE_NAME}=${who.sessionId}` });
async function rawGet(resource, headers, { search = '', agentListOptions = { liveContainers: [] }, collectContainers } = {}) {
    const req = Readable.from([]);
    req.method = 'GET';
    req.headers = { host: 'explorer.example.test', ...headers };
    const res = { status: 200, setHeader() {}, writeHead(code) { this.status = code; }, end(body) { this.body = JSON.parse(body); } };
    await handleMarketplaceRoutes(req, res, new URL(`https://explorer.example.test/api/marketplace/${resource}${search}`),
        { routePlan: plan(), agentListOptions, ...(collectContainers ? { collectContainers } : {}) });
    return res;
}
const sign = (resource, { tool = 'marketplace.read', targetAgent = MARKETPLACE_AGENT_TARGET, path: signedPath = `/api/marketplace/${resource}`, query = '' } = {}) =>
    signAgentHttpAssertion({ method: 'GET', path: signedPath, query, targetAgent, tool, env: agentEnv });
const bearer = token => ({ authorization: `Bearer ${token}` });
const machineNeedle = { repos: skillsRoot, agents: agentsRoot, 'list-repos': localOnlyRoot };
const RESOURCES = Object.keys(machineNeedle);

test('a verified agent assertion keeps local paths on every read, with or without a session cookie', async () => {
    for (const resource of RESOURCES) {
        for (const cookie of [{}, cookieOf(principals.ordinary), cookieOf(principals.guest)]) {
            const res = await rawGet(resource, { ...bearer(sign(resource)), ...cookie });
            assert.equal(res.status, 200, `${resource}: ${JSON.stringify(res.body)}`);
            assert.equal(JSON.stringify(res.body).includes(machineNeedle[resource]), true, `${resource} lost machine data`);
        }
    }
});

test('an unverified Bearer is rejected before any session fallback and never receives paths', async () => {
    const tamper = token => token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    const bad = {
        'forged signature': resource => tamper(sign(resource)),
        'wrong target': resource => sign(resource, { targetAgent: 'other-agent' }),
        'wrong path': resource => sign(resource, { path: '/api/marketplace/unrelated' }),
        'wrong tool': resource => sign(resource, { tool: 'repositories.install' }),
        'wrong query': resource => sign(resource, { query: 'x=1' }),
        'garbage': () => 'bogus',
    };
    for (const [label, make] of Object.entries(bad)) {
        for (const resource of RESOURCES) {
            for (const who of [principals.realAdmin, principals.ordinary, principals.guest]) {
                const res = await rawGet(resource, { ...bearer(make(resource)), ...cookieOf(who) });
                assert.equal(res.status, 401, `${label} ${resource} ${who.user.id}`);
                assert.equal(res.body.ok, false);
                assertNoLocalPaths(res.body, `${label} ${resource}`);
            }
        }
    }
    // Wrong request: a token signed without a query is refused for a request that carries one.
    const res = await rawGet('repos', { ...bearer(sign('repos')), ...cookieOf(principals.realAdmin) }, { search: '?x=1' });
    assert.equal(res.status, 401);
});

test('a replayed assertion is rejected on the second use', async () => {
    for (const resource of RESOURCES) {
        const headers = { ...bearer(sign(resource)), ...cookieOf(principals.ordinary) };
        assert.equal((await rawGet(resource, headers)).status, 200, resource);
        const replay = await rawGet(resource, headers);
        assert.equal(replay.status, 401, resource);
        assertNoLocalPaths(replay.body, `replayed ${resource}`);
    }
});

test('an explicitly delegated Marketplace read is rejected even with a valid assertion', async () => {
    for (const resource of RESOURCES) {
        for (const cookie of [{}, cookieOf(principals.realAdmin), cookieOf(principals.ordinary)]) {
            for (const delegation of ['any-token', 'Bearer eyJhbGciOiJub25lIn0.eyJyb2xlcyI6WyJhZG1pbiJdfQ.']) {
                const res = await rawGet(resource, { ...bearer(sign(resource)), ...cookie, 'x-ploinky-user-delegation': delegation });
                assert.equal(res.status, 403, `${resource} ${delegation.slice(0, 8)}`);
                assert.equal(res.body.error, 'user_delegation_unsupported');
                assertNoLocalPaths(res.body, `delegated ${resource}`);
            }
        }
    }
});

test('concurrent machine, admin and non-admin reads through the awaited inventory each get their own projection', async () => {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    let calls = 0;
    // Staggered, reordered inventory completion makes interleaving the norm.
    const collectContainers = async () => { await delay([15, 1, 8, 3, 12][calls++ % 5]); return []; };
    const callers = {
        machine: () => bearer(sign('agents')),
        admin: () => cookieOf(principals.realAdmin),
        namedAdmin: () => cookieOf(principals.namedAdmin),
        guestAdmin: () => cookieOf(principals.guestAdmin),
        ordinary: () => cookieOf(principals.ordinary),
    };
    const jobs = [];
    for (let round = 0; round < 6; round++) {
        for (const [label, headers] of Object.entries(callers)) {
            for (const resource of RESOURCES) {
                const resourceHeaders = label === 'machine' ? bearer(sign(resource)) : headers();
                jobs.push(rawGet(resource, resourceHeaders, { agentListOptions: {}, collectContainers }).then(res => ({ label, resource, res })));
            }
        }
    }
    for (const { label, resource, res } of await Promise.all(jobs)) {
        assert.equal(res.status, 200, `${label} ${resource}: ${JSON.stringify(res.body)}`);
        if (label === 'machine' || label === 'admin') assert.equal(JSON.stringify(res.body).includes(machineNeedle[resource]), true, `${label} ${resource} lost data`);
        else assertNoLocalPaths(res.body, `${label} ${resource}`);
    }
    assert.ok(calls >= 6, 'the awaited inventory path was exercised');
});

test('credential-bearing repository URLs are redacted for non-administrators and kept for admins and machines', async t => {
    const sourcesFile = path.join(workspace, '.ploinky', 'repo_sources.json');
    const sources = {
        CredUserinfoSkills: { url: 'https://x-access-token:SENTINELTOKEN@github.com/acme/cred-userinfo.git', branch: 'main', kind: 'skills' },
        CredUsernameSkills: { url: 'https://SENTINELTOKEN@git.example/acme/cred-username.git', kind: 'skills' },
        CredEncodedSkills: { url: 'https://SENTINEL%40TOKEN:SENTINEL%3APW@git.example/acme/cred-encoded.git', kind: 'skills' },
        CredQuerySkills: { url: 'https://git.example/acme/cred-query.git?access_token=SENTINELQUERY#SENTINELFRAGMENT', kind: 'skills' },
        CredScpSkills: { url: 'SENTINELTOKEN@github.com:acme/cred-scp.git', kind: 'skills' },
        CredFileSkills: { url: `file://${workspace}/SENTINELFILE`, kind: 'skills' },
        CredPathSkills: { url: `${workspace}/SENTINELLOCAL`, kind: 'skills' },
    };
    const bytes = JSON.stringify(sources, null, 2);
    fs.writeFileSync(sourcesFile, bytes);
    t.after(() => fs.rmSync(sourcesFile, { force: true }));
    const expected = {
        CredUserinfoSkills: 'https://github.com/acme/cred-userinfo.git',
        CredUsernameSkills: 'https://git.example/acme/cred-username.git',
        CredEncodedSkills: 'https://git.example/acme/cred-encoded.git',
        CredQuerySkills: 'https://git.example/acme/cred-query.git',
        CredScpSkills: 'github.com:acme/cred-scp.git',
        CredFileSkills: '',
        CredPathSkills: '',
    };
    const assertRedacted = (body, label) => {
        const text = JSON.stringify(body);
        assert.equal(/SENTINEL/.test(text), false, `${label}: credential or local sentinel leaked`);
        assertNoLocalPaths(body, label);
    };
    for (const [label, who] of Object.entries(principals)) {
        if (label === 'realAdmin') continue;
        const repos = await get('repos', who);
        assertRedacted(repos, `${label} repos`);
        const listed = await get('list-repos', who);
        assertRedacted(listed, `${label} list-repos`);
        for (const [name, url] of Object.entries(expected)) {
            // Stable identity and branch survive; only the display URL changes.
            assert.equal(repo(repos, name).url, url, `${label} ${name} repos url`);
            assert.equal(repo(repos, name).repositorySource.url, url, `${label} ${name} repositorySource url`);
            assert.equal(listed.repositories.find(item => item.name === name).url, url, `${label} ${name} list-repos url`);
        }
        assert.equal(repo(repos, 'CredUserinfoSkills').branch, 'main');
    }
    // Administrators and verified machine readers keep the configured values.
    const adminRepos = await get('repos', principals.realAdmin);
    const adminListed = await get('list-repos', principals.realAdmin);
    const machineRepos = await rawGet('repos', bearer(sign('repos')));
    const machineListed = await rawGet('list-repos', bearer(sign('list-repos')));
    for (const [name, value] of Object.entries(sources)) {
        assert.equal(repo(adminRepos, name).url, value.url, `admin ${name}`);
        assert.equal(adminListed.repositories.find(item => item.name === name).url, value.url, `admin list ${name}`);
        assert.equal(machineRepos.body.marketplace.repositories.find(item => item.name === name).url, value.url, `machine ${name}`);
        assert.equal(machineListed.body.repositories.find(item => item.name === name).url, value.url, `machine list ${name}`);
    }
    // Presentation never rewrites the stored configuration.
    assert.equal(fs.readFileSync(sourcesFile, 'utf8'), bytes);
});
