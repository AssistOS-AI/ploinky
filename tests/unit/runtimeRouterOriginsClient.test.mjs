import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    RUNTIME_ROUTER_ORIGINS_INVALID,
    RUNTIME_ROUTER_ORIGINS_UNAVAILABLE,
    fetchRuntimeRouterOrigins,
} from '../../Agent/lib/runtimeRouterOrigins.mjs';
import { inactivateEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';
import { derivePrivateAgentRequestSecret } from '../../cli/utils/security/masterKey.js';
import { installGeneratedRouterRuntime } from '../helpers/generatedRouterRuntime.mjs';
import {
    CONSUMER,
    createRouterOriginsWorkspace,
    startPrivateOriginsListener,
} from '../helpers/routerOriginsWorkspace.mjs';

const ORIGINS = ['http://100.73.151.25:3000', 'http://pgx:3000'];
const GENERATION = `sha256:${'a'.repeat(64)}`;
const ACTIVATION = '0d7f6b1e-7c1a-4c55-9f0a-2b8c3d4e5f60';

function agentEnvironment(t, internalRouterUrl) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-origins-client-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const runtime = installGeneratedRouterRuntime({
        origin: 'http://127.0.0.1:19090',
        tempDir,
        agentPrincipal: CONSUMER.agentId,
        instanceId: CONSUMER.instanceId,
        generationId: CONSUMER.enableGeneration,
        internalRouterUrl,
        assignProcessEnv: false,
    });
    return {
        ...runtime.env,
        PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(
            CONSUMER.agentId,
            CONSUMER.instanceId,
            CONSUMER.enableGeneration,
        ),
    };
}

async function fakeListener(t, respond) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
            respond(req, res, requests.length);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
    });
    return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

function json(res, status, body, headers = {}) {
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers });
    res.end(payload);
}

function envelope(overrides = {}) {
    return { schemaVersion: 1, authorizationGeneration: GENERATION, activationId: ACTIVATION, routerOrigins: ORIGINS, ...overrides };
}

async function rejectsWith(promise, code, extra = {}) {
    await assert.rejects(promise, (error) => {
        assert.equal(error.name, 'RuntimeRouterOriginsError');
        assert.equal(error.code, code, error.message);
        for (const [key, value] of Object.entries(extra)) assert.equal(error[key], value, key);
        return true;
    });
}

test('the helper reads fresh active origins through the signed descriptor and real private pipeline', async (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['100.73.151.25', 'pgx'] });
    const listener = await startPrivateOriginsListener(t);
    const env = agentEnvironment(t, listener.url);

    const first = await fetchRuntimeRouterOrigins({ env });
    assert.deepEqual(first, {
        schemaVersion: 1,
        authorizationGeneration: fixture.applied.selector.generation,
        activationId: fixture.applied.selector.activationId,
        routerOrigins: ORIGINS,
    });
    assert.equal(Object.isFrozen(first), true);
    await fetchRuntimeRouterOrigins({ env });
    assert.deepEqual(listener.requests, [
        { method: 'GET', url: '/api/edge/runtime-origins' },
        { method: 'GET', url: '/api/edge/runtime-origins' },
    ], 'every decision performs a fresh read');

    // A later failure is never answered from an earlier success.
    inactivateEdgeRoutingGeneration('operator-stop', { workspaceRoot: fixture.workspace });
    await rejectsWith(fetchRuntimeRouterOrigins({ env }), RUNTIME_ROUTER_ORIGINS_UNAVAILABLE,
        { status: 503, routerCode: 'EDGE_GENERATION_INACTIVE' });
});

test('identity and descriptor failures are invalid, and descriptor failures send no request', async (t) => {
    createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    const listener = await startPrivateOriginsListener(t);
    const env = agentEnvironment(t, listener.url);

    await rejectsWith(fetchRuntimeRouterOrigins({ env: { ...env, PLOINKY_AGENT_PRIVATE_SECRET: 'b'.repeat(64) } }),
        RUNTIME_ROUTER_ORIGINS_INVALID, { status: 401 });
    assert.equal(listener.requests.length, 1);

    for (const broken of [
        { ...env, PLOINKY_INTERNAL_ROUTER_URL: 'http://127.0.0.1:1' },
        { ...env, PLOINKY_ENV_SOURCE_PLOINKY_ROUTER_DESCRIPTOR_FILE: 'configured' },
        { ...env, PLOINKY_AGENT_ENABLE_GENERATION: 'other-generation' },
        Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'PLOINKY_ROUTER_DESCRIPTOR_FILE')),
        { PLOINKY_AGENT_PRIVATE_SECRET: env.PLOINKY_AGENT_PRIVATE_SECRET },
    ]) {
        await rejectsWith(fetchRuntimeRouterOrigins({ env: broken }), RUNTIME_ROUTER_ORIGINS_INVALID);
    }
    await rejectsWith(fetchRuntimeRouterOrigins({ env: { ...env, PLOINKY_AGENT_PRIVATE_SECRET: '' } }), RUNTIME_ROUTER_ORIGINS_INVALID);
    assert.equal(listener.requests.length, 1, 'broken descriptor or identity state never reaches the Router');
});

test('redirects, unsupported statuses, and advertised-but-missing endpoints are contract failures', async (t) => {
    createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    let targetHits = 0;
    const target = await fakeListener(t, (_req, res) => { targetHits += 1; json(res, 200, envelope()); });
    for (const [status, body, headers] of [
        [302, { ok: false }, { Location: `${target.url}/api/edge/runtime-origins` }],
        [307, '', { Location: `${target.url}/api/edge/runtime-origins` }],
        [404, { error: 'PRIVATE_ROUTE_SURFACE_DENIED' }, {}],
        [403, { ok: false, error: 'PRIVATE_CALLER_DENIED' }, {}],
        [400, { error: 'RUNTIME_ORIGINS_REQUEST_INVALID' }, {}],
        [503, { ok: false, error: 'RUNTIME_ORIGINS_INVALID' }, {}],
    ]) {
        const listener = await fakeListener(t, (_req, res) => json(res, status, body, headers));
        await rejectsWith(fetchRuntimeRouterOrigins({ env: agentEnvironment(t, listener.url) }), RUNTIME_ROUTER_ORIGINS_INVALID, { status });
        assert.equal(listener.requests.length, 1, String(status));
    }
    assert.equal(targetHits, 0, 'redirects are never followed');
});

test('transitional and transport failures are temporary, with one retry only for an explicit race', async (t) => {
    createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    for (const [status, code] of [[503, 'EDGE_GENERATION_INACTIVE'], [503, 'EDGE_GENERATION_RUNTIME_MISMATCH'], [500, 'internal_error']]) {
        const listener = await fakeListener(t, (_req, res) => json(res, status, { ok: false, error: code }));
        await rejectsWith(fetchRuntimeRouterOrigins({ env: agentEnvironment(t, listener.url) }), RUNTIME_ROUTER_ORIGINS_UNAVAILABLE, { status });
        assert.equal(listener.requests.length, 1, code);
    }

    const raced = await fakeListener(t, (_req, res, count) => (count === 1
        ? json(res, 503, { ok: false, error: 'edge_generation_changed' })
        : json(res, 200, envelope())));
    const env = agentEnvironment(t, raced.url);
    assert.deepEqual((await fetchRuntimeRouterOrigins({ env })).routerOrigins, ORIGINS);
    assert.equal(raced.requests.length, 2);
    assert.notEqual(raced.requests[0].headers['ploinky-agent-assertion'], raced.requests[1].headers['ploinky-agent-assertion'],
        'the retry is freshly signed rather than replayed');

    const racing = await fakeListener(t, (_req, res) => json(res, 503, { ok: false, error: 'edge_generation_changed' }));
    await rejectsWith(fetchRuntimeRouterOrigins({ env: agentEnvironment(t, racing.url) }), RUNTIME_ROUTER_ORIGINS_UNAVAILABLE);
    assert.equal(racing.requests.length, 2, 'retries are bounded');

    const closed = await fakeListener(t, () => {});
    const closedUrl = closed.url;
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const unusedUrl = `http://127.0.0.1:${probe.address().port}`;
    await new Promise((resolve) => probe.close(resolve));
    await rejectsWith(fetchRuntimeRouterOrigins({ env: agentEnvironment(t, unusedUrl) }), RUNTIME_ROUTER_ORIGINS_UNAVAILABLE);

    const started = Date.now();
    await rejectsWith(fetchRuntimeRouterOrigins({ env: agentEnvironment(t, closedUrl), timeoutMs: 150 }), RUNTIME_ROUTER_ORIGINS_UNAVAILABLE);
    assert.ok(Date.now() - started < 3_000, 'the request deadline is bounded');
});

test('response bodies are bounded and envelopes are validated exactly', async (t) => {
    createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    const oversized = JSON.stringify({ ...envelope(), padding: 'x'.repeat(40 * 1024) });
    const invalidBodies = [
        ['declared oversize', (res) => json(res, 200, oversized)],
        ['chunked oversize', (res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write(oversized.slice(0, 20_000));
            res.end(oversized.slice(20_000));
        }],
        ['not JSON', (res) => json(res, 200, '{')],
        ['text content type', (res) => json(res, 200, envelope(), { 'Content-Type': 'text/plain' })],
        ['extra field', (res) => json(res, 200, { ...envelope(), topology: {} })],
        ['missing field', (res) => json(res, 200, { schemaVersion: 1, authorizationGeneration: GENERATION, routerOrigins: ORIGINS })],
        ['unknown schema', (res) => json(res, 200, envelope({ schemaVersion: 2 }))],
        ['string schema', (res) => json(res, 200, envelope({ schemaVersion: '1' }))],
        ['invalid generation', (res) => json(res, 200, envelope({ authorizationGeneration: 'sha256:abc' }))],
        ['invalid activation', (res) => json(res, 200, envelope({ activationId: 'activation' }))],
        ['unsorted origins', (res) => json(res, 200, envelope({ routerOrigins: [...ORIGINS].reverse() }))],
        ['path origin', (res) => json(res, 200, envelope({ routerOrigins: ['http://pgx:3000/login'] }))],
        ['wildcard origin', (res) => json(res, 200, envelope({ routerOrigins: ['http://0.0.0.0:3000'] }))],
        ['array body', (res) => json(res, 200, [envelope()])],
    ];
    for (const [name, respond] of invalidBodies) {
        const listener = await fakeListener(t, (_req, res) => respond(res));
        await rejectsWith(fetchRuntimeRouterOrigins({ env: agentEnvironment(t, listener.url) }), RUNTIME_ROUTER_ORIGINS_INVALID)
            .catch((error) => { error.message = `${name}: ${error.message}`; throw error; });
    }

    const exact = await fakeListener(t, (_req, res) => json(res, 200, envelope({ routerOrigins: [] })));
    const result = await fetchRuntimeRouterOrigins({ env: agentEnvironment(t, exact.url) });
    assert.deepEqual(result.routerOrigins, []);
    const [request] = exact.requests;
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/api/edge/runtime-origins');
    assert.equal(request.body.length, 0);
    assert.match(request.headers['ploinky-agent-assertion'], /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
});
