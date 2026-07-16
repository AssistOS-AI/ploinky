import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createAgentClient } from '../../Agent/client/AgentMcpClient.mjs';

test('AgentMcpClient signs Marketplace reads and leaves enable mode caller-controlled', async () => {
    const original = {
        id: process.env.PLOINKY_AGENT_ID,
        secret: process.env.PLOINKY_AGENT_SECRET,
        router: process.env.PLOINKY_ROUTER_URL,
    };
    process.env.PLOINKY_AGENT_ID = 'agent:repo/caller';
    process.env.PLOINKY_AGENT_SECRET = 'caller-secret';

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
        process.env.PLOINKY_ROUTER_URL = `http://127.0.0.1:${port}`;
        const client = await createAgentClient('worker');
        const status = await client.ensureAgentRunning('repo/worker');
        assert.equal(status.running, true);
        await client.ensureAgentRunning('repo/worker');
        running = false;
        await client.ensureAgentRunning('repo/worker', { mode: 'global' });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        if (original.id === undefined) delete process.env.PLOINKY_AGENT_ID;
        else process.env.PLOINKY_AGENT_ID = original.id;
        if (original.secret === undefined) delete process.env.PLOINKY_AGENT_SECRET;
        else process.env.PLOINKY_AGENT_SECRET = original.secret;
        if (original.router === undefined) delete process.env.PLOINKY_ROUTER_URL;
        else process.env.PLOINKY_ROUTER_URL = original.router;
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
