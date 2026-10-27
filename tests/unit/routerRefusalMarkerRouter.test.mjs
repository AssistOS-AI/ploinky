// The real Router (cli/server/RoutingServer.js in a child process) marks the
// route-stage refusal of an inactive edge selector: no generation is applied,
// so route resolution refuses every request before anything is dispatched.
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

import { initializeFreshEdgeRoutingSources } from '../../cli/sandbox/edgeGeneration.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function startInactiveRouter(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-home-'));
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    });
    initializeFreshEdgeRoutingSources({ workspaceRoot: root });
    const port = await freePort();
    // The cloudflared integration RoutingServer imports is replaced by an
    // inert stand-in through a loader hook confined to this child.
    const stub = path.join(root, 'cloudflared-stub.mjs');
    fs.writeFileSync(stub, [
        'export function createCloudflaredRouterIntegration() {',
        "    return { getStatus: () => ({ state: 'test-disabled' }), stop: async () => {},",
        '        markPrivateListenerReady() {}, markPublicListenerReady() {} };',
        '}',
    ].join('\n'));
    const hooks = path.join(root, 'cloudflared-hooks.mjs');
    fs.writeFileSync(hooks, [
        `const stub = ${JSON.stringify(pathToFileURL(stub).href)};`,
        `const target = ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'ploinky-box/cloudflared/index.mjs')).href)};`,
        'export async function resolve(specifier, context, next) {',
        '    const resolved = await next(specifier, context);',
        '    return resolved.url === target ? { url: stub, shortCircuit: true } : resolved;',
        '}',
    ].join('\n'));
    const register = path.join(root, 'cloudflared-register.mjs');
    fs.writeFileSync(register, [
        "import net from 'node:net';",
        "import { register } from 'node:module';",
        `register(${JSON.stringify(pathToFileURL(hooks).href)});`,
        'const listen = net.Server.prototype.listen;',
        'net.Server.prototype.listen = function (...args) {',
        "    if (args[0] && typeof args[0] === 'object' && args[0].port === 8081) args[0] = { ...args[0], port: 0 };",
        '    return listen.apply(this, args);',
        '};',
    ].join('\n'));
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        if ((name.startsWith('PLOINKY_') && name !== 'PLOINKY_AGENTLIB_DIR') || name === 'PORT') delete env[name];
    }
    const child = spawn(process.execPath, [
        '--import', register,
        '--import', path.join(REPO_ROOT, 'tests/helpers/routerTemplatePreload.mjs'),
        path.join(REPO_ROOT, 'cli/server/RoutingServer.js'),
    ], {
        cwd: root,
        env: {
            ...env,
            HOME: home,
            PLOINKY_WORKSPACE_ROOT: root,
            PLOINKY_ROUTER_HOST_PORT: String(port),
            PLOINKY_MEDIA_HOST_PORT: '17893',
            PLOINKY_MASTER_KEY: '7'.repeat(64),
            PLOINKY_ROUTER_HEALTH_SOCKET: path.join(root, 'h.sock'),
            PLOINKY_TEST_PUBLIC_PORT: String(port),
            PLOINKY_TEST_REPO_ROOT: REPO_ROOT,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); }
            await exited;
        }
    };
    t.after(stop);
    const deadline = Date.now() + 15000;
    while (!/Ploinky server running/.test(output)) {
        if (child.exitCode !== null) throw new Error(`router exited:\n${output}`);
        if (Date.now() > deadline) {
            await stop();
            throw new Error(`router did not start:\n${output}`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { port };
}

function get(port, target) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: target, headers: { host: '127.0.0.1' } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.setTimeout(5000, () => req.destroy(new Error(`no answer for ${target}`)));
        req.on('error', reject);
        req.end();
    });
}

test('an inactive edge selector is refused by the real Router with stage=route and cause=edge-generation-inactive', { timeout: 60_000 }, async (t) => {
    const { port } = await startInactiveRouter(t);
    const answer = await get(port, '/anything');
    assert.equal(answer.status, 503, answer.body);
    assert.deepEqual(JSON.parse(answer.body), { error: 'EDGE_GENERATION_INACTIVE' });
    assert.equal(answer.headers['x-ploinky-refusal'], 'v=1; stage=route; cause=edge-generation-inactive');
    assert.ok(Number(answer.headers['retry-after']) > 0, 'the Retry-After of the denial is kept');
});
