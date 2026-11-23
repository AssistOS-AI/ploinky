// Run inside a fresh, dedicated Box with its local nested Podman and agent
// image already available. All repositories created below belong to the fixture.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isInsideBox } from '../../../ploinky-box/lib/boxMarker.mjs';

const [flag, argument, ...extra] = process.argv.slice(2);
assert(flag === '--workspace' && argument && !extra.length, 'usage: node start-abort.mjs --workspace <fresh Box workspace>');
assert(process.platform === 'linux' && isInsideBox(), 'requires a local Linux Ploinky Box with nested rootless Podman');
const root = fs.realpathSync(argument);
assert.equal(root, process.env.PLOINKY_WORKSPACE_ROOT, 'scratch must be the workspace owned by this Box');
assert(!root.split(path.sep).includes('.ploinky') && root !== '/', 'invalid fixture workspace');
assert(!process.env.CONTAINER_HOST && !process.env.CONTAINER_CONNECTION && !process.env.DOCKER_HOST, 'remote engines are excluded');
const source = fileURLToPath(new URL('../../../', import.meta.url));
const cli = path.join(source, 'cli/index.js');
const project = 's2fixture';
const agent = 's2agent';
const ref = project + '/' + agent;
const state = path.join(root, '.ploinky');
const repos = path.join(state, 'repos');
const repo = path.join(repos, project);
const receiptFile = path.join(state, 'data/canary', agent + '.json');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const env = { ...process.env, PLOINKY_ROOT: source, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

function command(bin, args, cwd = root) {
    // Engine inspections include secret environment values. Do not attach
    // stdout, stderr or child-process error objects to assertion failures.
    try {
        return execFileSync(bin, args, { cwd, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
        throw new Error(bin + ' ' + args[0] + ' failed (' + (error.status ?? error.code) + ')');
    }
}
const podman = (...args) => command('podman', ['--remote=false', ...args]);
const runCli = (...args) => command(process.execPath, [cli, ...args]);
const git = (dir, ...args) => command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], dir);
const inspect = id => {
    assert.match(id, /^[0-9a-f]{64}$/);
    const [row] = JSON.parse(podman('container', 'inspect', id));
    assert.equal(row.Id || row.ID, id);
    return row;
};
const ids = () => podman('ps', '-a', '--no-trunc', '--format', '{{.ID}}').split(/\s+/).filter(Boolean);
assert.equal(podman('info', '--format', '{{.Host.Security.Rootless}}'), 'true');
assert.equal(ids().length, 0, 'nested runtime must be dedicated and empty');
assert(!fs.existsSync(repos) || fs.readdirSync(repos).length === 0, 'refusing an existing repository store');
assert(!fs.existsSync(path.join(state, 'agents.json')) || !Object.values(json(path.join(state, 'agents.json'))).some(r => r?.type === 'agent'),
    'refusing an existing agent registry');
assert(!fs.existsSync(path.join(state, 'routing.json')) || !Object.keys(json(path.join(state, 'routing.json')).routes || {}).length,
    'refusing an existing routing table');
assert(!fs.existsSync(path.join(root, '.data/agents', agent)), 'refusing an existing agent home');
const scratch = fs.mkdtempSync(path.join(root, '.canary-s2-'));
const { bootstrapAgentLibRuntime } = await import('../../../agentlib/bootstrap.mjs');
await bootstrapAgentLibRuntime({ cwd: root });
const { loadActiveEdgeRoutingGeneration, initializeFreshEdgeRoutingSources } = await import('../../../cli/sandbox/edgeGeneration.js');
const { computeRchTool } = await import('../../../Agent/lib/requestHash.mjs');
const { buildRouterRequest } = await import('../../../cli/server/mcp-proxy/invocationMinter.js');
const snapshot = () => loadActiveEdgeRoutingGeneration({ workspaceRoot: root }).generation;

function init(dir) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
}
function commit(dir, message) {
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', message);
    return git(dir, 'rev-parse', 'HEAD');
}
initializeFreshEdgeRoutingSources({ workspaceRoot: root });
for (const name of ['AchillesIDE', 'copilot-agents', 'AchillesCLI']) {
    const dir = path.join(repos, name);
    init(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), 'Local fixture\n');
    commit(dir, 'local fixture');
}
init(repo);
const agentDir = path.join(repo, agent);
const code = path.join(agentDir, 'code');
fs.mkdirSync(code, { recursive: true });
fs.mkdirSync(path.join(agentDir, 'skills'));
fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({
    agent: 'node --require /code/headers.cjs /Agent/server/AgentServer.mjs',
    readiness: { protocol: 'mcp', port: 7000 },
    network: { mode: 'bridge', attachments: [{ name: 'fixture', primary: true }] },
    profiles: { default: { openPorts: ['127.0.0.1:19700:7000'] } },
    canary: { probe: { port: 7000, path: '/fixture-health', status: 204 } },
}));
function writeCopy(copy) {
    fs.writeFileSync(path.join(agentDir, 'skills', 'copy'), copy);
    fs.writeFileSync(path.join(code, 'headers.cjs'), `
const http = require('node:http');
const createServer = http.createServer;
http.createServer = function(listener) {
    return createServer.call(this, (req, res) => {
        res.setHeader('x-fixture-copy', ${JSON.stringify(copy)});
        res.setHeader('x-fixture-launch', process.env.PLOINKY_LAUNCH_ID || '');
        if (req.url === '/fixture-health') { res.writeHead(204); res.end(); }
        else listener(req, res);
    });
};
`);
    const config = JSON.stringify({ maxParallelTasks: 1, tools: [
        { name: copy + '_hold', async: true, command: 'sleep', args: ['1800'] },
    ] });
    fs.writeFileSync(path.join(agentDir, 'mcp-config.json'), config);
    fs.writeFileSync(path.join(code, 'mcp-config.json'), config);
}
writeCopy('old');
const oldCommit = commit(repo, 'old fixture copy');
git(repo, 'switch', '-qc', 'candidate');
writeCopy('new');
const candidate = commit(repo, 'new fixture copy');
git(repo, 'switch', '-q', 'main');
env.PLOINKY_CANARY_ADMISSION = JSON.stringify({
    agentRef: ref, commit: candidate, inventoryRow: { routeKey: agent, eligible: true, requiredMemoryBytes: 1 },
    cacheConfirmation: 'no-shared-html-cache',
});

async function until(fn, message, timeout = 120_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const result = fn();
        if (result) return result;
        await delay(20);
    }
    throw new Error(message);
}

// Only the CLI child loads this interposer. Suspend after the production
// rename so the parent can inspect the persisted state before killing it.
const preload = path.join(scratch, 'interrupt.cjs');
fs.writeFileSync(preload, `
const fs = require('node:fs');
const path = require('node:path');
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
    const result = rename.call(this, from, to);
    const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
    let stop = false;
    if (process.env.FIXTURE_STEP === 'created' && to === ${JSON.stringify(receiptFile)}) {
        stop = read(to).step === 'created';
    }
    if (process.env.FIXTURE_STEP === 'withdrawn' && to === ${JSON.stringify(path.join(state, 'data/edge-routing/active.json'))}) {
        const selector = read(to);
        if (selector.state === 'active') {
            const hex = selector.generation.replace(/^sha256:/, '');
            const doc = read(path.join(path.dirname(to), 'generations', hex + '.json'));
            const routing = JSON.parse(Buffer.from(doc.sources.routing, 'base64'));
            stop = routing.routes[${JSON.stringify(agent)}]?.canary?.mode === 'withdrawn';
        }
    }
    if (stop) {
        fs.writeFileSync(process.env.FIXTURE_MARK, String(process.pid), {flag: 'wx'});
        process.kill(process.pid, 'SIGSTOP');
    }
    return result;
};
`);
async function interrupt(args, step, observe) {
    const marker = path.join(scratch, step);
    const child = spawn(process.execPath, ['--require', preload, cli, ...args], {
        cwd: root, env: { ...env, FIXTURE_MARK: marker, FIXTURE_STEP: step }, stdio: 'ignore',
    });
    const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    try {
        await until(() => {
            assert.equal(child.exitCode, null, step + ' exited before interruption');
            return fs.existsSync(marker);
        }, step + ' interruption point was never reached');
        assert.equal(Number(fs.readFileSync(marker, 'utf8')), child.pid);
        observe();
    } finally {
        child.kill('SIGKILL');
        const result = await exited;
        assert.equal(result.signal, 'SIGKILL', 'CLI must be killed at ' + step);
    }
}

async function connection(record, copy) {
    const endpoint = 'http://127.0.0.1:' + record.hostPort + '/mcp';
    let sid;
    async function rpc(body, token) {
        const result = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
                ...(sid ? { 'mcp-session-id': sid } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
            body: JSON.stringify({ jsonrpc: '2.0', ...body }),
        });
        assert.equal(result.headers.get('x-fixture-copy'), copy);
        assert.equal(result.headers.get('x-fixture-launch'), record.launchId);
        assert(result.ok, body.method + ' failed HTTP ' + result.status);
        sid ??= result.headers.get('mcp-session-id');
        if (body.id === undefined) { await result.arrayBuffer(); return; }
        const reply = await result.json();
        assert(reply.result && !reply.error, body.method + ' returned an MCP error');
        return reply.result;
    }
    await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 's2fixture', version: '1' } } });
    assert(sid);
    await rpc({ method: 'notifications/initialized' });
    const { tools } = await rpc({ id: 2, method: 'tools/list' });
    const tool = copy + '_hold';
    assert(tools.some(t => t.name === tool));
    assert(!tools.some(t => t.name === (copy === 'old' ? 'new_hold' : 'old_hold')));
    return async () => {
        const method = 'POST', requestPath = '/mcp';
        const { token } = buildRouterRequest({ targetAgentId: 'agent:' + ref, targetRecord: record,
            sub: 'user:fixture', actor: { kind: 'user', id: 'user:fixture', roles: ['user'] },
            method, path: requestPath, tool, rch: computeRchTool({ method, path: requestPath, tool, arguments: {} }) });
        const result = await rpc({ id: 3, method: 'tools/call', params: { name: tool, arguments: {} } }, token);
        assert(!result.isError);
        assert(result.metadata?.taskId, 'fixture task must be enqueued');
        return result.metadata.taskId;
    };
}
function aliases(row) {
    const networks = Object.values(row.NetworkSettings.Networks);
    assert.equal(networks.length, 1);
    return networks[0].Aliases;
}
function mount(row, destination) {
    const matches = row.Mounts.filter(m => m.Destination === destination);
    assert.equal(matches.length, 1, destination);
    return matches[0];
}
function absent(receipt, home) {
    assert(!ids().includes(receipt.canaryContainerId), 'canary still present in podman ps -a');
    const live = snapshot();
    assert(!live.agents[receipt.canaryContainerName] && !live.routing.routes[agent].canary);
    assert(!json(path.join(state, 'agents.json'))[receipt.canaryContainerName]);
    assert(!json(path.join(state, 'routing.json')).routes[agent].canary);
    assert(!fs.existsSync(path.join(root, receipt.codePath)));
    assert(!fs.existsSync(path.join(home, '.tasksQueue.canary.' + receipt.rolloutId)));
    assert(json(receiptFile).terminal?.outcome);
}

const start = ['canary', 'start', ref, '--commit', candidate];
let started = false;
try {
    started = true;
    runCli('start', ref, '8080');
    const primaryKey = snapshot().routing.routes[agent].container;
    // A primary's port is kept on its route (routingFile.js); only canary records carry hostPort.
    const old = { ...snapshot().agents[primaryKey], hostPort: snapshot().routing.routes[agent].hostPort };
    const primary = inspect(old.containerId);
    assert.match(old.launchId, /\S/);
    const home = mount(primary, '/root').Source;
    assert.equal(fs.realpathSync(home), path.join(root, '.data/agents', agent));
    const configHash = hash(path.join(home, 'mcp-config.json'));
    const queue = path.join(home, '.tasksQueue');
    const enqueueOld = await connection(old, 'old');
    await enqueueOld();
    const pending = await enqueueOld();
    const stillPending = () => fs.existsSync(queue) && json(queue).some(t => t.id === pending && t.status === 'pending');
    await until(stillPending, 'old task did not stay pending');
    const queueHash = hash(queue);

    let orphan;
    await interrupt(start, 'created', () => {
        orphan = json(receiptFile);
        assert.equal(orphan.oldCommit, oldCommit);
        assert.equal(orphan.oldContainerId, old.containerId);
        assert.equal(orphan.oldLaunchId, old.launchId);
        assert.equal(inspect(orphan.canaryContainerId).Name.replace(/^\//, ''), orphan.canaryContainerName);
        assert(!snapshot().routing.routes[agent].canary);
    });
    runCli('canary', 'status', '--json');
    absent(orphan, home);

    runCli(...start);
    const receipt = json(receiptFile);
    const live = snapshot();
    const field = live.routing.routes[agent].canary;
    assert.equal(field.rolloutId, receipt.rolloutId);
    assert.equal(field.commit, candidate);
    const record = live.agents[field.container];
    assert.equal(record.canaryOf, agent);
    assert.equal(record.containerId, receipt.canaryContainerId);
    assert.notEqual(record.containerId, old.containerId);
    assert.notEqual(record.launchId, old.launchId);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), oldCommit);
    const row = inspect(record.containerId);
    assert.equal(row.Image, primary.Image);
    assert.equal(mount(row, '/root').Source, home);
    assert.equal(mount(row, '/shared').Source, mount(primary, '/shared').Source);
    assert(row.Config.Env.includes('PLOINKY_CANARY=1'));
    assert(row.Config.Env.includes('PLOINKY_CANARY_ROLLOUT=' + receipt.rolloutId));
    assert(row.Config.Env.includes('PLOINKY_LAUNCH_ID=' + record.launchId));
    assert.equal(receipt.codePath, path.join('.ploinky/canary', agent, candidate));
    assert.equal(field.codePath, path.join(receipt.codePath, 'code'));
    for (const [dest, tree] of [['/code', 'code'], ['/code/skills', 'skills']]) {
        const bound = mount(row, dest);
        assert.equal(bound.RW, false);
        assert.equal(fs.realpathSync(bound.Source), path.join(root, receipt.codePath, tree));
    }
    assert(!row.Mounts.some(m => (m.Destination === '/code' || m.Destination.startsWith('/code/'))
        && (m.Source === repo || m.Source.startsWith(repo + path.sep))));
    const create = row.Config.CreateCommand;
    assert(Array.isArray(create), 'nested Podman must preserve the creation arguments');
    const publications = create.flatMap((arg, index) =>
        ['-p', '--publish'].includes(arg) ? [create[index + 1]] : arg.startsWith('--publish=') ? [arg.slice(10)] : []);
    assert.deepEqual(publications, ['127.0.0.1::7000']);
    const ports = Object.entries(row.NetworkSettings.Ports).filter(([, bindings]) => bindings?.length);
    assert.equal(ports.length, 1);
    assert.equal(ports[0][0], '7000/tcp');
    assert.equal(ports[0][1].length, 1);
    assert.equal(ports[0][1][0].HostIp, '127.0.0.1');
    assert.equal(Number(ports[0][1][0].HostPort), Number(record.hostPort));
    assert.notEqual(Number(record.hostPort), 19700);
    assert.equal(Number(primary.NetworkSettings.Ports['7000/tcp'][0].HostPort), 19700);
    const checkAliases = () => {
        const oldRuntime = inspect(old.containerId);
        const newRuntime = inspect(record.containerId);
        const [network] = Object.keys(oldRuntime.NetworkSettings.Networks);
        const [bridge] = JSON.parse(podman('network', 'inspect', network));
        const members = bridge.containers ?? bridge.Containers;
        assert(members && Object.hasOwn(members, old.containerId) && Object.hasOwn(members, record.containerId),
            'the actual managed bridge must contain both exact runtimes');
        const oldAliases = aliases(oldRuntime), newAliases = aliases(newRuntime);
        assert(record.networkAlias && record.networkAlias.length <= 63);
        assert(oldAliases.includes(agent) && !oldAliases.includes(record.networkAlias));
        assert(newAliases.includes(record.networkAlias) && !newAliases.includes(agent));
    };
    checkAliases();
    await connection(old, 'old');
    const enqueueNew = await connection(record, 'new');
    const newId = await enqueueNew();
    assert(newId.startsWith('canary.' + receipt.rolloutId + '.'));
    const newQueue = path.join(home, '.tasksQueue.canary.' + receipt.rolloutId);
    await until(() => fs.existsSync(newQueue) && json(newQueue).some(t => t.id === newId), 'new queue was never persisted');
    assert.equal(hash(path.join(home, 'mcp-config.json')), configHash);
    assert.equal(hash(queue), queueHash);
    assert(stillPending());
    runCli('start', ref);
    const adopted = snapshot();
    assert.equal(adopted.agents[primaryKey].containerId, old.containerId);
    assert.equal(adopted.agents[field.container].containerId, record.containerId);
    assert.equal(adopted.agents[primaryKey].launchId, old.launchId);
    assert.equal(adopted.agents[field.container].launchId, record.launchId);
    checkAliases();
    await interrupt(['canary', 'abort', ref], 'withdrawn', () => {
        const gen = snapshot();
        assert.equal(gen.routing.routes[agent].canary.mode, 'withdrawn');
        assert.equal(gen.agents[field.container].containerId, record.containerId);
        assert(ids().includes(record.containerId));
    });
    runCli('canary', 'abort', ref);
    absent(receipt, home);
    assert(stillPending() && hash(queue) === queueHash);
    assert(inspect(old.containerId).State.Running);
} finally {
    if (started) runCli('stop');
}
console.log('S2 nested Podman start, orphan recovery, withdrawal and resumed abort passed');
