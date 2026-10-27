import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createAgentClient } from '../../Agent/client/MCPBrowserClient.js';

async function withTaskServer(taskPayload, run) {
    let statusPolls = 0;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'GET' && url.searchParams.has('taskId')) {
            statusPolls += 1;
            if (taskPayload === null) {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'task not found' }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ task: { id: 't1', toolName: 'tool', ...taskPayload } }));
            return;
        }
        if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
        if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            const json = (result, headers = {}) => {
                res.writeHead(200, { 'content-type': 'application/json', ...headers });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
            };
            if (body.method === 'initialize') {
                json({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 't', version: '1' } },
                    { 'mcp-session-id': 's1', 'mcp-protocol-version': '2025-06-18' });
            } else if (body.method === 'tools/call') {
                json({ content: [], metadata: { taskId: 't1', status: 'queued' } });
            } else { res.writeHead(204); res.end(); }
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const client = createAgentClient(`http://127.0.0.1:${server.address().port}/mcp`);
    try {
        await client.connect();
        return await run(client, () => statusPolls);
    } finally {
        await client.close().catch(() => {});
        await new Promise((r) => server.close(r));
    }
}

for (const status of ['cancelled', 'not_found', 'failed']) {
    test(`callTool rejects on ${status} and stops polling`, async () => {
        await withTaskServer({ status }, async (client, polls) => {
            await assert.rejects(client.callTool('tool', {}), (error) => {
                assert.equal(error.task.status, status);
                assert.equal(error.taskStatus, status);
                assert.equal(error.status, undefined, 'error.status stays reserved for HTTP codes');
                return true;
            });
            const settled = polls();
            await new Promise((r) => setTimeout(r, 700));
            assert.equal(polls(), settled, 'no polls after terminal state');
            assert.equal(settled, 1);
        });
    });
}

test('callTool resolves on completed', async () => {
    await withTaskServer({ status: 'completed', result: { content: [{ type: 'text', text: 'ok' }], metadata: {} } }, async (client) => {
        const out = await client.callTool('tool', {});
        assert.equal(out.content[0].text, 'ok');
        assert.equal(out.metadata.status, 'completed');
    });
});

test('callTool rejects on HTTP 404 task-not-found as not_found and stops polling', async () => {
    await withTaskServer(null, async (client, polls) => {
        await assert.rejects(client.callTool('tool', {}), (error) => {
            assert.equal(error.taskStatus, 'not_found');
            assert.equal(error.task.status, 'not_found');
            return true;
        });
        await new Promise((r) => setTimeout(r, 700));
        assert.equal(polls(), 1, 'single poll, none after terminal state');
    });
});
