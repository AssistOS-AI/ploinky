import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { requestAgentCard } from '../../cli/server/agentCardFanout.js';
import { createRootAgentDialContext } from '../../cli/server/rootAgentDial.js';

test('public aggregate agent-card fanout strips credentials, identity, forwarding, and hop-by-hop headers on the wire', async (t) => {
    let observed = null;
    const upstream = http.createServer((req, res) => {
        observed = { method: req.method, url: req.url, headers: { ...req.headers } };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'observed-agent' }));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => upstream.close(resolve)));
    const port = upstream.address().port;

    const result = await requestAgentCard({ hostPort: port }, 'alpha', {
        host: 'attacker.example',
        cookie: 'session=secret',
        authorization: 'Bearer secret',
        forwarded: 'for=attacker;host=attacker.example;proto=http',
        'x-forwarded-for': '198.51.100.7',
        'x-forwarded-host': 'attacker.example',
        'x-forwarded-proto': 'http',
        'x-real-ip': '198.51.100.7',
        'x-ploinky-auth-info': 'spoofed',
        'x-ploinky-custom': 'spoofed',
        'ploinky-agent-assertion': 'spoofed',
        'x-api-key': 'secret-api-key',
        'x-auth-token': 'secret-auth-token',
        connection: 'keep-alive, x-remove-me',
        'proxy-connection': 'keep-alive',
        'keep-alive': 'timeout=5',
        'x-remove-me': 'connection-token',
        upgrade: 'websocket',
        te: 'trailers',
        'x-safe-correlation': 'correlation-1',
        'accept-language': 'en-US',
        'user-agent': 'ploinky-agent-card-test',
    }, {
        dialContext: createRootAgentDialContext({
            routePlan: { lease: { snapshot: { agents: {} }, commit: () => true } },
            route: { hostPort: port },
            targetPort: port,
        }),
    });

    assert.equal(result.ok, true);
    assert.equal(observed.method, 'GET');
    assert.equal(observed.url, '/agent-card');
    assert.equal(observed.headers.accept, 'application/json');
    assert.equal(observed.headers['accept-language'], 'en-US');
    assert.equal(observed.headers['user-agent'], 'ploinky-agent-card-test');
    assert.equal(observed.headers.host, `127.0.0.1:${port}`);
    for (const forbidden of [
        'cookie', 'authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
        'x-forwarded-proto', 'x-real-ip', 'x-ploinky-auth-info', 'x-ploinky-custom',
        'ploinky-agent-assertion', 'x-api-key', 'x-auth-token', 'proxy-connection',
        'keep-alive', 'x-remove-me', 'upgrade', 'te', 'x-safe-correlation',
    ]) {
        assert.equal(observed.headers[forbidden], undefined, forbidden);
    }
});

test('agent-card fanout revalidates the captured generation immediately before each dial', async (t) => {
    let connections = 0;
    const upstream = http.createServer((_req, res) => {
        connections += 1;
        res.end('{}');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => upstream.close(resolve)));

    const result = await requestAgentCard(
        { hostPort: upstream.address().port },
        'alpha',
        {},
        {
            dialContext: createRootAgentDialContext({
                routePlan: { lease: { snapshot: { agents: {} }, commit: () => false } },
                route: { hostPort: upstream.address().port },
                targetPort: upstream.address().port,
            }),
        },
    );

    assert.equal(result.ok, false);
    assert.equal(result.generationChanged, true);
    assert.equal(result.error.error, 'edge_generation_changed');
    assert.equal(connections, 0);
});

test('agent-card fanout rejects fabricated contexts without falling back to the global agent', async (t) => {
    let connections = 0;
    const upstream = http.createServer((_req, res) => {
        connections += 1;
        res.end(JSON.stringify({ name: 'must-not-be-reached' }));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => upstream.close(resolve)));

    const result = await requestAgentCard(
        { hostPort: upstream.address().port },
        'alpha',
        {},
        { dialContext: { targetPort: upstream.address().port, commit: () => true } },
    );

    assert.deepEqual(result, {
        ok: false,
        generationChanged: true,
        error: { name: 'alpha', error: 'edge_generation_changed' },
    });
    assert.equal(connections, 0);
});
