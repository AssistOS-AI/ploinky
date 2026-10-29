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

import { domainFixture } from './directDomainFixtures.mjs';

// The real RoutingServer process: the reserved task-reference surface is
// dispatched to its handler behind the session gate, and never to an agent.
// (Harness copied from edgeAdditionalServerRoot.test.mjs; authenticated and
// private-listener behavior is covered at handler level in
// taskReferenceRoutes.test.mjs.)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function startRouter(t) {
    const world = domainFixture(t);
    const port = await freePort();
    process.env.PLOINKY_ROUTER_HOST_PORT = String(port);
    world.apply();
    // Without credentials the in-Router publication runtime would reconcile and
    // inactivate the ready public hosts. This test needs Router dispatch only,
    // so the cloudflared integration RoutingServer imports is replaced by an
    // inert stand-in through a loader hook confined to this child.
    const stub = path.join(world.root, 'cloudflared-integration-stub.mjs');
    fs.writeFileSync(stub, [
        'export function createCloudflaredRouterIntegration() {',
        "    return { getStatus: () => ({ state: 'test-disabled' }), stop: async () => {},",
        '        markPrivateListenerReady() {}, markPublicListenerReady() {} };',
        '}',
    ].join('\n'));
    const hooks = path.join(world.root, 'cloudflared-integration-hooks.mjs');
    fs.writeFileSync(hooks, [
        `const stub = ${JSON.stringify(pathToFileURL(stub).href)};`,
        `const target = ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'ploinky-box/cloudflared/index.mjs')).href)};`,
        'export async function resolve(specifier, context, next) {',
        '    const resolved = await next(specifier, context);',
        '    return resolved.url === target ? { url: stub, shortCircuit: true } : resolved;',
        '}',
    ].join('\n'));
    // The private listener binds a fixed 8081 exclusively; an ephemeral port
    // keeps concurrent real-Router tests from contending for it.
    const register = path.join(world.root, 'cloudflared-integration-register.mjs');
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
    // HOME stays outside the workspace: Router subprocesses may create files
    // under it while the fixture removes the workspace.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'root-application-home-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
    const child = spawn(process.execPath, [
        '--import', register,
        '--import', path.join(REPO_ROOT, 'tests/helpers/routerTemplatePreload.mjs'),
        path.join(REPO_ROOT, 'cli/server/RoutingServer.js'),
    ], {
        cwd: world.root,
        env: {
            ...env,
            HOME: home,
            PLOINKY_WORKSPACE_ROOT: world.root,
            PLOINKY_ROUTER_HOST_PORT: String(port),
            PLOINKY_MEDIA_HOST_PORT: '17891',
            PLOINKY_MASTER_KEY: '7'.repeat(64),
            PLOINKY_ROUTER_HEALTH_SOCKET: path.join(world.root, 'h.sock'),
            PLOINKY_TEST_PUBLIC_PORT: String(port),
            PLOINKY_TEST_REPO_ROOT: REPO_ROOT,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    // The child must be gone before the fixture removes its workspace, so the
    // test stops it in `finally`; this hook is only a backstop.
    const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            // The whole process group, so no Router subprocess outlives it.
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
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { port, stop };
}

function request(port, { host, method = 'GET', target, headers = {} }) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: { host, ...headers } }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.setTimeout(5000, () => req.destroy(new Error(`no answer for ${method} ${target}`)));
        req.on('error', reject);
        req.end();
    });
}


test('the real Router puts task-reference operations behind the session gate and keeps aliases reserved', async (t) => {
    const { port, stop } = await startRouter(t);
    try {
        const id = 'T'.repeat(22);
        for (const [method, target] of [['GET', `/task-refs/explorer/${id}`], ['POST', '/task-refs/explorer/lookup'],
            ['GET', '/task-refs/descriptor?agent=unrelated&tool=start_job']]) {
            const response = await request(port, { host: '127.0.0.1:' + port, method, target });
            // The Router's own session gate refuses an anonymous caller before
            // the handler runs (session cases: taskReferenceRealRouter.test.mjs).
            assert.ok([401, 302, 503].includes(response.status), `${method} ${target}: ${response.status} ${response.body}`);
            assert.doesNotMatch(response.body, /task_reference_unavailable|task_reference_authentication_required/);
            assert.doesNotMatch(response.body, /task_reference_unavailable/);
        }
        for (const target of [`/task-refs/explorer/%54${'T'.repeat(21)}`, '/task-refs/explorer/x/y/z', '//task-refs/x']) {
            const response = await request(port, { host: '127.0.0.1:' + port, target });
            assert.equal(response.status, 503, `${target}: ${response.body}`);
            assert.match(response.body, /task_reference_unavailable/);
        }
    } finally {
        await stop();
    }
});
