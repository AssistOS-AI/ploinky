import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

test('AgentMcpClient signs Marketplace reads and leaves enable mode caller-controlled', async () => {
    const originalCwd = process.cwd();
    const originalEnvironment = { ...process.env };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-marketplace-'));
    process.chdir(tempDir);
    process.env.PLOINKY_MASTER_KEY = 'd'.repeat(64);
    process.env.PLOINKY_AGENT_ID = 'agent:repo/caller';
    process.env.PLOINKY_AGENT_SECRET = 'caller-secret';

    const { installGeneratedRouterRuntime } = await import('../helpers/generatedRouterRuntime.mjs');
    const { createAgentClient } = await import('../../Agent/client/AgentMcpClient.mjs');
    const requests = [];
    let running = false;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
            requests.push({
                method: req.method,
                authorization: req.headers.authorization || '',
                body,
            });
            if (body?.action === 'enable_agent') running = true;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                ok: true,
                marketplace: {
                    agents: [{ ref: 'repo/worker', name: 'worker', running, status: running ? 'running' : 'inactive' }],
                },
            }));
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        installGeneratedRouterRuntime({
            origin: `http://127.0.0.1:${port}`,
            tempDir,
            agentPrincipal: 'agent:repo/caller',
        });
        const client = await createAgentClient('worker');
        const status = await client.ensureAgentRunning('repo/worker');
        assert.equal(status.running, true);
        await client.ensureAgentRunning('repo/worker');
        running = false;
        await client.ensureAgentRunning('repo/worker', { mode: 'global' });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
        for (const name of Object.keys(process.env)) {
            if (!Object.prototype.hasOwnProperty.call(originalEnvironment, name)) delete process.env[name];
        }
        Object.assign(process.env, originalEnvironment);
    }

    assert.deepEqual(requests.map(({ method }) => method), ['GET', 'POST', 'GET', 'GET', 'POST']);
    assert.ok(requests.every(({ authorization }) => authorization.startsWith('Bearer ')));
    assert.deepEqual(requests[1].body, {
        action: 'enable_agent',
        agentRef: 'repo/worker',
    });
    assert.deepEqual(requests[4].body, {
        action: 'enable_agent',
        agentRef: 'repo/worker',
        mode: 'global',
    });
});
