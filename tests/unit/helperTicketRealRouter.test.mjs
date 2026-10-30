// The real Router (cli/server/RoutingServer.js in a child process) serves the private helper-ticket operation: reachable
// with the verified private agent identity of the single execution-provider agent, refused for every other caller, and
// never minting because this Router is not inside a Box (no live scope: `target_scope_mismatch`). Like the other
// real-Router tests it needs the Router's own dependencies (`mcp-sdk`) to be installed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { signPrivateRouterAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { initializeSourceProtection } from '../../cli/utils/runtime/sourceProtectionGate.mjs';
import { derivePrivateAgentRequestSecret } from '../../cli/utils/security/masterKey.js';
import { domainFixture } from './directDomainFixtures.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MASTER = '7'.repeat(64);
const ROUTE = '/api/edge/target-helper-ticket';

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function startRouter(t) {
    const saved = process.env.PLOINKY_MASTER_KEY;
    process.env.PLOINKY_MASTER_KEY = MASTER;
    t.after(() => {
        if (saved === undefined) delete process.env.PLOINKY_MASTER_KEY;
        else process.env.PLOINKY_MASTER_KEY = saved;
    });
    const world = domainFixture(t);
    const manifestFile = path.join(world.root, 'fixtures', 'explorer', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.executionProvider = { version: 1, port: 7300, taskReferences: { path: '/explorer/task-refs' } };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    world.apply();
    const created = await initializeSourceProtection({
        workspaceRoot: world.root,
        assertWorkspaceLease: () => {},
        enumerateExpectedHolders: async () => ({ status: 'known', principals: ['agent:fixtures/explorer'] }),
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'htk-home-'));
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'htk-router-'));
    t.after(() => {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
    });
    const ports = { pub: await freePort(), priv: await freePort() };
    // The cloudflared integration is replaced by an inert stand-in, and the fixed listeners move to test ports.
    const stub = path.join(scratch, 'cloudflared-stub.mjs');
    fs.writeFileSync(stub, [
        'export function createCloudflaredRouterIntegration() {',
        "    return { getStatus: () => ({ state: 'test-disabled' }), stop: async () => {},",
        '        markPrivateListenerReady() {}, markPublicListenerReady() {} };',
        '}',
    ].join('\n'));
    const hooks = path.join(scratch, 'cloudflared-hooks.mjs');
    fs.writeFileSync(hooks, [
        `const stub = ${JSON.stringify(pathToFileURL(stub).href)};`,
        `const target = ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'ploinky-box/cloudflared/index.mjs')).href)};`,
        'export async function resolve(specifier, context, next) {',
        '    const resolved = await next(specifier, context);',
        '    return resolved.url === target ? { url: stub, shortCircuit: true } : resolved;',
        '}',
    ].join('\n'));
    const register = path.join(scratch, 'register.mjs');
    fs.writeFileSync(register, [
        "import net from 'node:net';",
        "import { register } from 'node:module';",
        `register(${JSON.stringify(pathToFileURL(hooks).href)});`,
        'const listen = net.Server.prototype.listen;',
        'net.Server.prototype.listen = function (...args) {',
        '    if (typeof args[0] === \'number\') {',
        '        const callback = args.find((value) => typeof value === \'function\');',
        `        const port = args[0] === 8080 ? ${ports.pub} : 0;`,
        "        if (callback) this.once('listening', callback);",
        "        return listen.call(this, port, '127.0.0.1');",
        '    }',
        `    if (args[0] && typeof args[0] === 'object' && args[0].port === 8081) args[0] = { ...args[0], port: ${ports.priv} };`,
        '    return listen.apply(this, args);',
        '};',
    ].join('\n'));
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        if ((name.startsWith('PLOINKY_') && name !== 'PLOINKY_AGENTLIB_DIR') || name === 'PORT') delete env[name];
    }
    const child = spawn(process.execPath, ['--import', register, path.join(REPO_ROOT, 'cli/server/RoutingServer.js')], {
        cwd: world.root,
        env: {
            ...env,
            HOME: home,
            PLOINKY_WORKSPACE_ROOT: world.root,
            // The ports the fixture's generation was compiled for (domainFixture); the listeners move by the preload.
            PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
            PLOINKY_MEDIA_HOST_PORT: process.env.PLOINKY_MEDIA_HOST_PORT,
            PLOINKY_MASTER_KEY: MASTER,
            PLOINKY_ROUTER_HEALTH_SOCKET: path.join(scratch, 'h.sock'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); }
            await exited;
        }
    };
    t.after(stop);
    const deadline = Date.now() + 20000;
    while (!/Ploinky server running/.test(output)) {
        if (child.exitCode !== null) throw new Error(`router exited:\n${output}`);
        if (Date.now() > deadline) {
            await stop();
            throw new Error(`router did not start:\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ports, root: world.root, storeId: created.value.sourceStoreIdentity, output: () => output };
}

function send(port, { method = 'POST', target = ROUTE, body = '', headers = {}, host = '127.0.0.1:8081' } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: { host, ...headers } }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.setTimeout(8000, () => req.destroy(new Error(`no answer for ${method} ${target}`)));
        req.on('error', reject);
        req.end(body);
    });
}

function ticketRequest(label = 'one') {
    const id = (value) => Buffer.alloc(16, value).toString('base64url');
    return JSON.stringify({
        binding: { version: 1, scope: {
            workspaceId: 'ws', boxIdentity: 'box', boxGeneration: 'gen', workerPrincipal: 'agent:fixtures/explorer',
            workerRuntimeInstanceId: 'explorer-instance', workerEnableGeneration: 'explorer-enable', workerGeneration: id(1),
            agentPrincipal: 'agent:fixtures/provider', containerId: 'a'.repeat(64), runtimeInstanceId: 'provider-instance',
            enableGeneration: 'provider-enable', helperIncarnation: id(2),
        }, limitsDigest: '9'.repeat(64) },
        leaseId: id(3), reservationId: id(4), operationId: id(5), requestDigest: '7'.repeat(64),
        helperNonce: Buffer.from(label.padEnd(32, '-')).toString('base64url'), channelEpoch: '1', previousChannelEpoch: null,
        permissions: ['commit', 'prepare'], ttlSeconds: 30,
    });
}

function signed(name, body, { instance = `${name}-instance`, enable = `${name}-enable`, signedPath = ROUTE, method = 'POST' } = {}) {
    const agentId = `agent:fixtures/${name}`;
    return {
        'ploinky-agent-assertion': signPrivateRouterAssertion({
            method,
            path: signedPath,
            body: Buffer.from(body),
            env: {
                PLOINKY_AGENT_ID: agentId,
                PLOINKY_AGENT_INSTANCE_ID: instance,
                PLOINKY_AGENT_ENABLE_GENERATION: enable,
                PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(agentId, instance, enable),
            },
        }),
    };
}

test('the real Router serves the private helper-ticket operation to the single execution provider only, and mints nothing outside a Box', { timeout: 90_000 }, async (t) => {
    const { ports, output } = await startRouter(t);
    const call = (name, options = {}) => {
        const body = options.body ?? ticketRequest(options.label);
        return send(ports.priv, { body, headers: { ...signed(name, body, options), 'content-type': 'application/json' } });
    };

    // The provider reaches the handler. This Router is not inside a Box: there is no live scope, so nothing is minted.
    const reached = await call('explorer');
    assert.equal(reached.status, 200, reached.body);
    assert.equal(reached.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(reached.body), { ok: false, error: { code: 'target_scope_mismatch' } });
    // Transport errors: unparsable JSON is 400, a body over 64 KiB is 413.
    const malformed = await call('explorer', { body: '{"binding":' });
    assert.equal(malformed.status, 400, malformed.body);
    assert.deepEqual(JSON.parse(malformed.body), { error: 'invalid_request' });
    const oversized = await call('explorer', { body: JSON.stringify({ pad: 'x'.repeat(65536) }) });
    assert.equal(oversized.status, 413, oversized.body);

    // Every other caller is refused before the handler runs.
    const plain = await call('unrelated');
    assert.equal(plain.status, 403, plain.body);
    assert.equal(JSON.parse(plain.body).error, 'PRIVATE_CALLER_DENIED');
    assert.equal((await call('explorer', { instance: 'explorer-instance-0' })).status, 401);
    assert.equal((await send(ports.priv, { body: ticketRequest() })).status, 401);
    assert.equal((await call('explorer', { signedPath: '/api/edge/source-protection' })).status, 401);
    // Only the exact POST is the operation.
    const get = await send(ports.priv, { method: 'GET', headers: signed('explorer', '', { method: 'GET' }) });
    assert.equal(get.status, 400, get.body);
    assert.equal((await send(ports.priv, { target: `${ROUTE}?x=1`, body: ticketRequest(), headers: signed('explorer', ticketRequest()) })).status, 400);
    assert.equal((await send(ports.priv, { target: `${ROUTE}/`, body: ticketRequest(), headers: signed('explorer', ticketRequest(), { signedPath: `${ROUTE}/` }) })).status, 404);
    // The public listener does not serve it.
    const body = ticketRequest();
    const pub = await send(ports.pub, { body, host: '127.0.0.1', headers: signed('explorer', body) });
    assert.notEqual(pub.status, 200, pub.body);
    assert.equal(pub.body.includes('target_scope_mismatch'), false);
    // The Router output names the refusals by code only and carries no request material.
    assert.equal(output().includes(Buffer.from('one'.padEnd(32, '-')).toString('base64url')), false);
});
