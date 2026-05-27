import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
    createAgentHttpClient,
    getAgentCardsUrl,
    getAgentCardUrl,
    getAgentChatCompletionsUrl,
    getRouterUrl
} from '../../Agent/client/AgentHttpClient.mjs';

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

function readJsonBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        });
    });
}

test('AgentHttpClient resolves router and agent endpoint URLs', () => {
    assert.equal(
        getRouterUrl({ PLOINKY_ROUTER_URL: 'http://router.test:9999/' }),
        'http://router.test:9999'
    );
    assert.equal(
        getRouterUrl({ PLOINKY_ROUTER_HOST: 'host.containers.internal', PLOINKY_ROUTER_PORT: '8097' }),
        'http://host.containers.internal:8097'
    );
    assert.equal(
        getAgentChatCompletionsUrl('openaiAgent', { routerUrl: 'http://127.0.0.1:8080/' }),
        'http://127.0.0.1:8080/v1/chat/completions/openaiAgent'
    );
    assert.equal(
        getAgentCardUrl('openaiAgent', { routerUrl: 'http://127.0.0.1:8080/' }),
        'http://127.0.0.1:8080/agent-card/openaiAgent'
    );
    assert.equal(
        getAgentCardsUrl({ routerUrl: 'http://127.0.0.1:8080/' }),
        'http://127.0.0.1:8080/agent-card'
    );
});

test('AgentHttpClient calls router agent-card and chat completions endpoints', async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
        seen.push({
            method: req.method,
            url: req.url,
            auth: req.headers['x-test-auth'] || ''
        });
        if (req.method === 'GET' && req.url === '/agent-card') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                agents: [{ name: 'openaiAgent', payload: { anyShape: { ok: true } } }],
                errors: []
            }));
            return;
        }
        if (req.method === 'GET' && req.url === '/agent-card/openaiAgent') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ agent: 'openaiAgent', capabilities: { tags: ['fast'] } }));
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/chat/completions/openaiAgent') {
            const body = await readJsonBody(req);
            assert.equal(body.stream, false);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{ message: { role: 'assistant', content: 'echo:ping' } }]
            }));
            return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    await listen(server);
    try {
        const { port } = server.address();
        const client = createAgentHttpClient({
            routerUrl: `http://127.0.0.1:${port}`,
            requestHeaders: { 'x-test-auth': 'router-issued' }
        });
        const aggregate = await client.agentCard();
        assert.equal(aggregate.agents[0].name, 'openaiAgent');
        assert.deepEqual(aggregate.agents[0].payload.anyShape, { ok: true });

        const capabilities = await client.agentCard('openaiAgent');
        assert.deepEqual(capabilities.capabilities.tags, ['fast']);

        const completion = await client.chatCompletions('openaiAgent', {
            model: 'demo',
            stream: false,
            messages: [{ role: 'user', content: 'ping' }]
        });
        assert.equal(completion.choices[0].message.content, 'echo:ping');
    } finally {
        await close(server);
    }

    assert.deepEqual(seen.map(entry => entry.url), [
        '/agent-card',
        '/agent-card/openaiAgent',
        '/v1/chat/completions/openaiAgent'
    ]);
    assert.ok(seen.every(entry => entry.auth === 'router-issued'));
});

test('AgentHttpClient streams chat completions SSE events through router endpoint', async () => {
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions/openaiAgent') {
            res.writeHead(404);
            res.end();
            return;
        }
        const body = await readJsonBody(req);
        assert.equal(body.stream, true);
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache'
        });
        res.write(`data: ${JSON.stringify({
            object: 'chat.completion.chunk',
            choices: [{ delta: { content: 'echo:ping' } }]
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    });

    await listen(server);
    const events = [];
    try {
        const { port } = server.address();
        const client = createAgentHttpClient({ routerUrl: `http://127.0.0.1:${port}` });
        for await (const event of client.chatCompletionsStream('openaiAgent', {
            model: 'demo',
            messages: [{ role: 'user', content: 'ping' }]
        })) {
            events.push(event);
        }
    } finally {
        await close(server);
    }

    assert.equal(events.length, 2);
    assert.equal(events[0].done, false);
    assert.equal(events[0].json.object, 'chat.completion.chunk');
    assert.equal(events[0].json.choices[0].delta.content, 'echo:ping');
    assert.equal(events[1].done, true);
});
