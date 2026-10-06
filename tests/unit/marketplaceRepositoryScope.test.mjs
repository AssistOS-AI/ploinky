import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { installGitFixture, until } from '../helpers/repositoryGitFixture.mjs';

const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'marketplace-scope-'));
const physical = path.join(base, 'physical');
const root = path.join(base, 'workspace');
fs.mkdirSync(physical);
fs.symlinkSync(physical, root);
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
const { resolveSkillRepositorySource } = await import('../../cli/utils/skillRepositorySource.js');
const { resolveAgentRepositoryName } = await import('../../cli/utils/agentRepositorySource.mjs');
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
    fs.rmSync(base, { recursive: true, force: true });
});
function checkout(name) {
    fs.mkdirSync(path.join(root, name, 'worker'), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'worker/manifest.json'), '{}');
}
function response() {
    return Object.assign(new EventEmitter(), {
        setHeader() {}, writeHead(status) { this.status = status; },
        end(value) { this.body = JSON.parse(value); this.writableEnded = true; this.emit('close'); },
    });
}
async function request(resource, { body, res = response(), expectClosed = false, ...options } = {}) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = body ? 'POST' : 'GET';
    req.headers = { host: 'explorer.example.test', origin: 'https://explorer.example.test', cookie: `${SSO_AUTH_COOKIE_NAME}=${admin.sessionId}` };
    req.session = admin;
    if (body) req.headers['x-ploinky-browser-csrf-token'] = mintBrowserCsrfToken({ req, routePlan: plan(), authContext: { boundHostRouteKey: 'shell' }, sessionId: admin.sessionId });
    await handleMarketplaceRoutes(req, res, new URL(`https://explorer.example.test/api/marketplace/${resource}`), {
        routePlan: plan(), agentListOptions: { runtimeEntries: [], noWaitStates: new Map(), registry: {} }, ...options,
    });
    if (expectClosed) {
        assert.equal(res.status, undefined);
        assert.equal(res.body, undefined);
        return;
    }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.marketplace || res.body;
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

function gitCheckout(name, url, { skill = false, workspace = root } = {}) {
    const directory = path.join(workspace, name);
    fs.mkdirSync(directory, { recursive: true });
    execFileSync('git', ['init', '-q', directory]);
    execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', url]);
    if (skill) {
        fs.mkdirSync(path.join(directory, 'skills/sample'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'skills/sample/SKILL.md'), '---\nname: sample\ndescription: Fixture skill\n---\nFixture\n');
    } else {
        fs.mkdirSync(path.join(directory, 'worker'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'worker/manifest.json'), '{}');
    }
    return directory;
}
function source(name, url, kind = 'agents') {
    const file = path.join(root, '.ploinky/repo_sources.json');
    const sources = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    fs.writeFileSync(file, JSON.stringify({ ...sources, [name]: { url, kind } }));
}

test('real agents GET prepares before collector with heartbeat, one scan and no synchronous Git', async t => {
    const url = 'https://example.test/team/agent.git';
    const directory = gitCheckout('agent-development', url);
    source('registered-agent', url);
    const git = installGitFixture(t, { delayMs: 200 });
    const readdir = fs.readdirSync;
    let scans = 0;
    t.mock.method(fs, 'readdirSync', (target, ...args) => {
        if (target === root) scans += 1;
        return readdir(target, ...args);
    });
    let beats = 0;
    const timer = setInterval(() => { beats += 1; }, 5);
    t.after(() => clearInterval(timer));
    const payload = await request('agents', {
        agentListOptions: { registry: {}, noWaitStates: new Map() },
        collectContainers: async () => {
            assert.equal(resolveAgentRepositoryName(path.join(directory, 'worker')), 'registered-agent');
            assert.equal(git.live.size, 0, 'preparation precedes the E6a collector');
            return [];
        },
    });
    clearInterval(timer);
    assert.ok(payload.agents.some(agent => agent.ref === 'registered-agent/worker'));
    assert.ok(beats >= 5, 'event loop progresses while Git is sleeping');
    assert.equal(scans, 1);
    assert.equal(git.synchronous(), 0);
    assert.equal(git.started.filter(entry => entry.directory === directory).length, 1);
});

for (const resource of ['repos', 'list-repos']) test(`real ${resource} prepares lexical and canonical skill origins in one pool`, async t => {
    const url = 'https://example.test/team/skills.git';
    const directory = path.join(root, 'skill-development');
    if (!fs.existsSync(directory)) gitCheckout('skill-development', url, { skill: true });
    source('registered-skills', url, 'skills');
    const expected = resolveSkillRepositorySource('registered-skills', url);
    assert.equal(expected.source, path.join(physical, 'skill-development'));
    const git = installGitFixture(t, { delayMs: 150 });
    const readdir = fs.readdirSync;
    const discoveries = new Map();
    t.mock.method(fs, 'readdirSync', (target, ...args) => {
        if ([root, physical].includes(target) && new Error().stack.includes('repositoryEntries')) discoveries.set(target, (discoveries.get(target) || 0) + 1);
        return readdir(target, ...args);
    });
    const payload = await request(resource);
    const row = payload.repositories.find(repo => repo.name === 'registered-skills');
    assert.ok(row);
    assert.equal(resource === 'repos' ? row.repositorySource.source : row.source, expected.source);
    assert.equal(git.synchronous(), 0, 'canonical consumer must find prepared origin values');
    assert.deepEqual([...discoveries.entries()].sort(), [[root, 1], [physical, 1]].sort());
    assert.equal(git.started.filter(entry => entry.directory === directory).length, 1);
    assert.equal(git.started.filter(entry => entry.directory === path.join(physical, 'skill-development')).length, 1);
    const queries = git.started.map(entry => entry.directory);
    assert.equal(new Set(queries).size, queries.length);
    assert.equal(git.peak(), 2, 'one pool covers both root spellings');
    assert.equal(git.live.size, 0);
});

test('catalog confinement still rejects an external symlinked skill checkout', async t => {
    const url = 'https://example.test/team/external.git';
    const external = gitCheckout('external-target', url, { workspace: base, skill: true });
    fs.symlinkSync(external, path.join(root, 'external'));
    source('external', url, 'skills');
    const git = installGitFixture(t);
    const payload = await request('list-repos');
    const row = payload.repositories.find(repo => repo.name === 'external');
    assert.equal(row.origin, 'remote');
    assert.equal(row.source, url);
    assert.equal(git.synchronous(), 0);
});

test('already-closed response starts no discovery, Git child or collector', async t => {
    const git = installGitFixture(t);
    const original = fs.readdirSync;
    let scans = 0;
    t.mock.method(fs, 'readdirSync', (target, ...args) => { if (target === root) scans += 1; return original(target, ...args); });
    const res = response();
    res.destroyed = true;
    await request('agents', { res, expectClosed: true, agentListOptions: {}, collectContainers: () => assert.fail('closed request inventory') });
    assert.equal(scans, 0);
    assert.equal(git.started.length, 0);
});

test('response close cancels active Git, prevents queued paths and suppresses payload', async t => {
    const git = installGitFixture(t, { hang: true });
    const res = response();
    const run = request('repos', { res, expectClosed: true });
    await until(() => git.events().length === 2, 'two catalog children');
    const victimChildren = git.started.map(entry => entry.child);
    git.configure({ delayMs: 100 });
    const survivor = request('agents');
    res.emit('close');
    await run;
    for (const child of victimChildren) assert.equal(child.signalCode, 'SIGKILL');
    assert.ok((await survivor).agents.some(agent => agent.ref === 'registered-agent/worker'));
    // Survivor prepares only the lexical root; no cancelled catalog's canonical jobs start.
    assert.ok(git.started.every(entry => entry.directory.startsWith(root + path.sep)));
    assert.equal(git.live.size, 0);
});

test('response closed in E6a inventory queue skips collection and keeps survivors alive', async t => {
    const git = installGitFixture(t);
    const gates = [];
    let collections = 0;
    const collectContainers = async () => {
        collections += 1;
        await new Promise(resolve => gates.push(resolve));
        return [];
    };
    t.after(() => gates.forEach(resolve => resolve()));
    const options = { agentListOptions: { registry: {}, noWaitStates: new Map() }, collectContainers };
    const first = request('agents', options);
    const second = request('agents', options);
    await until(() => collections === 2, 'both inventory slots');
    const res = response();
    const before = git.started.length;
    const third = request('agents', { ...options, res, expectClosed: true });
    await until(() => git.started.length > before && git.live.size === 0, 'third request prepared');
    res.emit('close');
    gates.forEach(resolve => resolve());
    await Promise.all([first, second, third]);
    assert.equal(collections, 2);
    assert.equal(git.live.size, 0);
    assert.equal(git.synchronous(), 0);
});

test('close during an active inventory keeps prepared origins until that inventory settles', async t => {
    const git = installGitFixture(t);
    const res = response();
    let release;
    let entered = false;
    const run = request('agents', {
        res, expectClosed: true, agentListOptions: { registry: {}, noWaitStates: new Map() },
        collectContainers: async () => {
            entered = true;
            await new Promise(resolve => { release = resolve; });
            assert.equal(resolveAgentRepositoryName(path.join(root, 'agent-development/worker')), 'registered-agent');
            return [];
        },
    });
    await until(() => entered, 'active inventory');
    res.emit('close');
    release();
    await run;
    assert.equal(git.synchronous(), 0);
    assert.equal(git.live.size, 0);
});

test('new requests observe origin, source and global configuration changes immediately', async t => {
    const directory = path.join(root, 'agent-development');
    const oldHome = process.env.HOME;
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const oldGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.HOME = path.join(base, 'fresh-home');
    process.env.XDG_CONFIG_HOME = path.join(base, 'fresh-xdg');
    delete process.env.GIT_CONFIG_GLOBAL;
    fs.mkdirSync(process.env.HOME, { recursive: true });
    t.after(() => {
        for (const [key, value] of [['HOME', oldHome], ['XDG_CONFIG_HOME', oldXdg], ['GIT_CONFIG_GLOBAL', oldGlobal]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
    const git = installGitFixture(t);
    assert.ok((await request('agents')).agents.some(agent => agent.ref === 'registered-agent/worker'));
    const url = 'https://example.test/team/changed.git';
    fs.writeFileSync(path.join(directory, '.git/config'), `[remote "origin"]\nurl = ${url}\n`);
    source('changed-agent', url);
    assert.ok((await request('agents')).agents.some(agent => agent.ref === 'changed-agent/worker'));
    fs.writeFileSync(path.join(process.env.HOME, '.gitconfig'), '[broken\n');
    const rejected = await request('agents');
    assert.ok(rejected.agents.some(agent => agent.ref === 'agent-development/worker'));
    assert.ok(!rejected.agents.some(agent => agent.ref === 'changed-agent/worker'));
    fs.writeFileSync(path.join(process.env.HOME, '.gitconfig'), '');
    assert.ok((await request('agents')).agents.some(agent => agent.ref === 'changed-agent/worker'));
    assert.equal(git.synchronous(), 0);
});

test('retargeted workspace symlink selects the new canonical source on the next catalog request', async t => {
    const next = path.join(base, 'next-physical');
    fs.mkdirSync(path.join(next, '.ploinky/repos'), { recursive: true });
    const url = 'https://example.test/team/next-skills.git';
    gitCheckout('next-development', url, { workspace: next, skill: true });
    fs.writeFileSync(path.join(next, '.ploinky/repo_sources.json'), JSON.stringify({ 'next-skills': { url, kind: 'skills' } }));
    const git = installGitFixture(t);
    const before = await request('list-repos');
    assert.ok(before.repositories.some(repo => repo.name === 'registered-skills' && repo.source === path.join(physical, 'skill-development')));
    fs.unlinkSync(root);
    fs.symlinkSync(next, root);
    const after = await request('list-repos');
    const row = after.repositories.find(repo => repo.name === 'next-skills');
    assert.equal(row.source, path.join(next, 'next-development'));
    assert.ok(!after.repositories.some(repo => repo.source === path.join(physical, 'skill-development')));
    assert.equal(git.synchronous(), 0);
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
