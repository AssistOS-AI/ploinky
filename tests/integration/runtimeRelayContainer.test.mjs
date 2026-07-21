import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { compileProxyLimits } from '../../cli/server/proxy/limits.js';
import { createRelayHttpAgent, RelayDuplex } from '../../cli/server/proxy/executeHttpPlan.js';
import { RelayRequestMinter } from '../../cli/server/runtimeRelay/relayRequestMinter.js';
import { RuntimeRelayManager } from '../../cli/server/runtimeRelay/RuntimeRelayManager.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = crypto.randomBytes(32);
const TARGET_AGENT = 'agent:fixture/explicit-command';

function commandSucceeds(command, args) {
    return spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' }).status === 0;
}

function availableFixture() {
    if (!commandSucceeds('podman', ['info'])) return null;
    const candidates = [
        process.env.PLOINKY_RELAY_TEST_IMAGE,
        'localhost/assistos/ploinky-box-prepared:v5-redesign-20260717',
        'docker.io/assistos/ploinky-box:latest',
    ].filter(Boolean);
    return candidates.find(image => commandSucceeds('podman', ['image', 'exists', image])) || null;
}

function hostResponse(port, requestPath) {
    return new Promise(resolve => {
        const request = http.get({ hostname: '127.0.0.1', port, path: requestPath, timeout: 250 }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(''));
    });
}

test('exec/stdio relay reaches only the selected container loopback service without publishing TCP', { timeout: 30_000 }, async (t) => {
    const image = availableFixture();
    if (!image) return t.skip('Podman fixture image unavailable; set PLOINKY_RELAY_TEST_IMAGE');
    const name = `ploinky-relay-it-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const port = 42000 + crypto.randomInt(10000);
    const nonce = crypto.randomBytes(12).toString('hex');
    const app = [
        "const http=require('http')",
        "const port=Number(process.argv[1])",
        "const nonce=process.argv[2]",
        "http.createServer((req,res)=>{res.setHeader('content-type','text/plain');res.end(req.url==='/health'?nonce:'not-found')}).listen(port,'127.0.0.1')",
    ].join(';');
    const started = spawnSync('podman', [
        'run', '-d', '--rm', '--name', name,
        '--network', 'pasta',
        '-e', `PLOINKY_AGENT_ID=${TARGET_AGENT}`,
        '-e', `PLOINKY_AGENT_SECRET=${SECRET.toString('hex')}`,
        '-v', `${path.join(REPO_ROOT, 'Agent')}:/Agent:ro`,
        '-v', `${path.join(REPO_ROOT, 'node_modules')}:/Agent/node_modules:ro`,
        image, 'node', '-e', app, String(port), nonce,
    ], { encoding: 'utf8', stdio: 'pipe' });
    assert.equal(started.status, 0, started.stderr);
    const containerId = started.stdout.trim().toLowerCase();
    assert.match(containerId, /^[a-f0-9]{64}$/);
    t.after(() => spawnSync('podman', ['rm', '-f', containerId], { stdio: 'ignore' }));

    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const probe = spawnSync('podman', ['exec', containerId, 'node', '-e',
            "require('http').get(process.argv[1],r=>process.exit(r.statusCode===200?0:2)).on('error',()=>process.exit(3))",
            `http://127.0.0.1:${port}/health`], { stdio: 'ignore' });
        if (probe.status === 0) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'container-local explicit command did not become ready');
    assert.equal(execFileSync('podman', ['port', containerId], { encoding: 'utf8' }).trim(), '');
    assert.notEqual(await hostResponse(port, '/health'), nonce);

    const inspect = JSON.parse(execFileSync('podman', ['inspect', containerId], { encoding: 'utf8' }))[0];
    const networkMode = String(inspect.HostConfig?.NetworkMode || inspect.NetworkSettings?.NetworkMode || 'bridge');
    const limits = compileProxyLimits();
    const minter = new RelayRequestMinter({ resolveAgentSecret: () => SECRET });
    const relayErrors = [];
    const manager = new RuntimeRelayManager({
        minter,
        limits,
        spawnProcess: (...args) => {
            const child = spawn(...args);
            child.stderr.on('data', chunk => relayErrors.push(Buffer.from(chunk)));
            return child;
        },
    });
    const plan = Object.freeze({
        relay: Object.freeze({
            kind: 'container-exec-stdio', runtime: 'podman', containerId, containerName: name,
            targetAgentId: TARGET_AGENT, effectiveInstanceId: 'explicit-instance-1', networkMode,
        }),
        owner: Object.freeze({ effectiveInstanceId: 'explicit-instance-1' }),
        generationDigest: crypto.randomBytes(32).toString('base64url'),
        deniedPorts: Object.freeze([]),
        limits,
        method: 'GET', port, targetPath: '/health', query: '', transport: 'http',
    });
    const lease = { committed: false, commit() { if (this.committed) return false; this.committed = true; return true; } };
    let channel;
    try {
        channel = await manager.checkout({ plan, lease, authorized: true });
    } catch (error) {
        error.message += `: ${Buffer.concat(relayErrors).toString('utf8')}`;
        throw error;
    }
    let relayAgent;
    try {
        const stream = await channel.openRequest({ plan, bodyMode: 'none-v1', bodyHash: '', headers: { host: `127.0.0.1:${port}` } });
        relayAgent = createRelayHttpAgent(new RelayDuplex(stream));
        const body = await new Promise((resolve, reject) => {
            const request = http.get({ path: '/health', headers: { host: `127.0.0.1:${port}` }, agent: relayAgent }, response => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            });
            request.on('error', reject);
        });
        assert.equal(body, nonce);
    } finally {
        relayAgent?.destroy();
        channel.close();
    }
});
