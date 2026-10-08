import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

// 27 agents in 9 Git checkouts, 16 of them running. Every child process one GET /api/marketplace/agents spawns is recorded by
// wrapping child_process before the route modules load, and a stub `podman` answers ps/inspect.
const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'marketplace-counts-'));
const root = path.join(base, 'workspace');
const stubs = path.join(base, 'stubs');
fs.mkdirSync(path.join(root, '.ploinky/repos'), { recursive: true });
fs.mkdirSync(stubs);
const previous = { root: process.env.PLOINKY_WORKSPACE_ROOT, key: process.env.PLOINKY_MASTER_KEY, path: process.env.PATH, cwd: process.cwd() };
process.env.PLOINKY_WORKSPACE_ROOT = root;
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);

const REPOS = 9;
const PER_REPO = 3;
const RUNNING = 16;
const spawned = [];
const originals = {};
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
    originals[name] = childProcess[name];
    childProcess[name] = function wrapped(command, args, ...rest) {
        spawned.push([name, command, ...(Array.isArray(args) ? args : [])].join(' '));
        return originals[name].call(this, command, args, ...rest);
    };
    // execFile/exec carry a custom promisify that resolves { stdout, stderr }; keep it on the wrapper.
    const custom = originals[name][promisify.custom];
    if (custom) {
        childProcess[name][promisify.custom] = function wrappedAsync(command, args, ...rest) {
            spawned.push([name, command, ...(Array.isArray(args) ? args : [])].join(' '));
            return custom.call(this, command, args, ...rest);
        };
    }
}
syncBuiltinESMExports();

const names = [];
for (let r = 0; r < REPOS; r += 1) {
    const repo = `repo${r}`;
    const directory = path.join(root, repo);
    fs.mkdirSync(directory, { recursive: true });
    originals.execFileSync('git', ['init', '-q', directory]);
    originals.execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', `https://example.test/team/${repo}.git`]);
    for (let a = 0; a < PER_REPO; a += 1) {
        fs.mkdirSync(path.join(directory, `agent${a}`), { recursive: true });
        fs.writeFileSync(path.join(directory, `agent${a}`, 'manifest.json'), JSON.stringify({ about: `${repo} ${a}` }));
        names.push({ repo, agent: `agent${a}` });
    }
}
const inspectJson = names.slice(0, RUNNING).map(({ repo, agent }) => ({
    Id: 'a'.repeat(64), Name: `/ploinky_${repo}_${agent}_x`,
    Config: { Image: 'img', WorkingDir: '/code', Env: [`AGENT_NAME=${agent}`, `PLOINKY_AGENT_ID=agent:${repo}/${agent}`] },
    State: { Status: 'running', Running: true, Pid: 100 }, Mounts: [], NetworkSettings: { Ports: {} },
}));
fs.writeFileSync(path.join(stubs, 'inspect.json'), JSON.stringify(inspectJson));
fs.writeFileSync(path.join(stubs, 'ps.txt'), inspectJson.map(c => c.Name.slice(1)).join('\n') + '\n');
fs.writeFileSync(path.join(stubs, 'podman'), `#!/bin/sh
case "$1" in
  ps) cat '${stubs}/ps.txt' ;;
  inspect) cat '${stubs}/inspect.json' ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${stubs}${path.delimiter}${previous.path}`;

const { handleMarketplaceRoutes } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const { authService, SSO_AUTH_COOKIE_NAME } = await import('../../cli/server/authHandlers/shared.js');
const admin = { sessionId: 'counts-session', user: { id: 'admin', roles: ['admin'] } };
const configured = authService.isConfigured;
const validate = authService.validateSession;
authService.isConfigured = () => true;
authService.validateSession = async id => (id === admin.sessionId ? admin : null);
const snapshot = { generation: 'counts', agents: { shell: { type: 'agent', agentName: 'shell', repoName: 'repo', auth: { mode: 'sso' } } }, routing: { static: { agent: 'shell' }, routes: { shell: { agent: 'shell', repo: 'repo' } } }, manifests: {} };
const plan = () => ({ ok: true, kind: 'router-surface', surface: 'marketplace-ui', listener: 'public', hostSelection: { kind: 'agent-root', record: { routeKey: 'shell' } }, forwarding: { protocol: 'https', authority: 'explorer.example.test' }, snapshot, lease: { id: snapshot.generation, snapshot, commit: () => true } });

test.after(() => {
    for (const [name, fn] of Object.entries(originals)) childProcess[name] = fn;
    syncBuiltinESMExports();
    authService.isConfigured = configured;
    authService.validateSession = validate;
    process.env.PATH = previous.path;
    if (previous.root === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previous.root;
    if (previous.key === undefined) delete process.env.PLOINKY_MASTER_KEY; else process.env.PLOINKY_MASTER_KEY = previous.key;
    fs.rmSync(base, { recursive: true, force: true });
});

async function agentsRequest() {
    const res = Object.assign(new EventEmitter(), {
        setHeader() {}, writeHead(status) { this.status = status; },
        end(value) { this.body = JSON.parse(value); this.emit('close'); },
    });
    const req = Readable.from([]);
    req.method = 'GET';
    req.headers = { host: 'explorer.example.test', origin: 'https://explorer.example.test', cookie: `${SSO_AUTH_COOKIE_NAME}=${admin.sessionId}` };
    req.session = admin;
    spawned.length = 0;
    await handleMarketplaceRoutes(req, res, new URL('https://explorer.example.test/api/marketplace/agents'), { routePlan: plan() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { body: res.body, spawned: [...spawned] };
}

test('one agents GET: engine and Git child processes are not duplicated within the request', async () => {
    const { body, spawned: calls } = await agentsRequest();
    const agents = body.marketplace.agents;
    assert.equal(agents.length, REPOS * PER_REPO);
    assert.equal(agents.filter(agent => agent.running).length, 0, 'stub containers have no published route, so none counts as running');
    const engine = calls.filter(call => /\bpodman\b/.test(call.split(' ')[1]));
    assert.equal(engine.filter(call => / ps /.test(call)).length, 1, 'one ps');
    assert.equal(engine.filter(call => / inspect /.test(call)).length, 1, 'one inspect for all containers');
    const git = calls.filter(call => call.split(' ')[1] === 'git');
    const dirs = git.map(call => call.split(' ')[3]);
    assert.equal(new Set(dirs).size, dirs.length, 'no checkout read twice');
});

test('repeated agents GETs spawn the same fixed set each time and return identical bodies (no cross-request reuse)', async () => {
    const first = await agentsRequest();
    const second = await agentsRequest();
    assert.deepEqual(second.body, first.body);
    assert.equal(first.spawned.length, REPOS + 2);
    assert.equal(second.spawned.length, REPOS + 2, 'each request reads Git origins and the engine itself');
    const times = [];
    for (let i = 0; i < 15; i += 1) {
        const started = process.hrtime.bigint();
        await agentsRequest();
        times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    if (process.env.MARKETPLACE_COUNTS_BENCH) console.log(`agents GET p50 ${times[7].toFixed(1)} ms (stub podman, ${REPOS} Git checkouts)`);
});
