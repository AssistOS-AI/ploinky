// AC9: the agent-side runtime-sources reader validates the envelope strictly,
// retries exactly once on an explicit generation race, never caches, and maps
// transport failures to UNAVAILABLE and contract failures to INVALID.
import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    RUNTIME_SOURCES_INVALID,
    RUNTIME_SOURCES_UNAVAILABLE,
    fetchRuntimeSources,
} from '../../Agent/lib/runtimeSources.mjs';
import { verifyJws } from '../../Agent/lib/jwtVerify.mjs';
import { derivePrivateAgentRequestSecret } from '../../cli/utils/security/masterKey.js';
import { installGeneratedRouterRuntime } from '../helpers/generatedRouterRuntime.mjs';
import { setEnvironment } from '../helpers/routerOriginsWorkspace.mjs';

const GENERATION = `sha256:${'a'.repeat(64)}`;
const ACTIVATION = '0d7f6b1e-7c1a-4c55-9f0a-2b8c3d4e5f60';
const CALLER = Object.freeze({
    agentId: 'agent:suite/coordinator',
    instanceId: '11111111-2222-4333-8444-555555555555',
    enableGeneration: '66666666-7777-4888-8999-aaaaaaaaaaaa',
});

function agentEnvironment(t, internalRouterUrl) {
    setEnvironment(t, { PLOINKY_MASTER_KEY: '5'.repeat(64) });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-sources-client-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const runtime = installGeneratedRouterRuntime({
        origin: 'http://127.0.0.1:19090',
        tempDir,
        agentPrincipal: CALLER.agentId,
        instanceId: CALLER.instanceId,
        generationId: CALLER.enableGeneration,
        internalRouterUrl,
        assignProcessEnv: false,
    });
    return {
        ...runtime.env,
        PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(CALLER.agentId, CALLER.instanceId, CALLER.enableGeneration),
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

function json(res, status, body) {
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
    res.end(payload);
}

function envelope(overrides = {}) {
    return {
        schemaVersion: 1,
        authorizationGeneration: GENERATION,
        activationId: ACTIVATION,
        sources: [
            { kind: 'agent-repository', relativePath: 'suite' },
            { kind: 'agent-runtime-library', relativePath: 'achillesAgentLib' },
            { kind: 'linked-repository', relativePath: 'group/Docs' },
        ],
        outsideWorkspace: 1,
        ...overrides,
    };
}

async function rejectsWith(promise, code, extra = {}) {
    await assert.rejects(promise, (error) => {
        assert.equal(error.name, 'RuntimeSourcesError');
        assert.equal(error.code, code, error.message);
        for (const [key, value] of Object.entries(extra)) assert.equal(error[key], value, key);
        return true;
    });
}

test('a valid envelope is returned frozen, read freshly for every call over a signed bodyless GET', async (t) => {
    const listener = await fakeListener(t, (req, res) => json(res, 200, envelope()));
    const env = agentEnvironment(t, listener.url);
    const first = await fetchRuntimeSources({ env });
    assert.deepEqual(first, envelope());
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.sources[0]), true);
    await fetchRuntimeSources({ env });
    assert.equal(listener.requests.length, 2, 'no cache');
    for (const request of listener.requests) {
        assert.equal(request.method, 'GET');
        assert.equal(request.url, '/api/edge/runtime-sources');
        assert.equal(request.body.length, 0);
        const { payload } = verifyJws(request.headers['ploinky-agent-assertion'], {
            secret: Buffer.from(env.PLOINKY_AGENT_PRIVATE_SECRET, 'hex'),
            expectedAudience: 'ploinky-private-router',
            maxTtlSeconds: 30,
        });
        assert.equal(payload.path, '/api/edge/runtime-sources');
        assert.equal(payload.iss, CALLER.agentId);
    }
});

test('an empty source list is a valid answer (nothing is active)', async (t) => {
    const listener = await fakeListener(t, (req, res) => json(res, 200, envelope({ sources: [], outsideWorkspace: 0 })));
    const result = await fetchRuntimeSources({ env: agentEnvironment(t, listener.url) });
    assert.deepEqual(result.sources, []);
});

test('an extra key, unknown kind, bad path, duplicate or out-of-bounds answer is RUNTIME_SOURCES_INVALID', async (t) => {
    const cases = [
        envelope({ extra: true }),
        envelope({ schemaVersion: 2 }),
        envelope({ outsideWorkspace: -1 }),
        envelope({ outsideWorkspace: 1.5 }),
        envelope({ authorizationGeneration: 'sha256:short' }),
        envelope({ sources: [{ kind: 'agent-repository', relativePath: 'suite', extra: 1 }] }),
        envelope({ sources: [{ kind: 'workspace', relativePath: 'suite' }] }),
        envelope({ sources: [{ kind: 'agent-repository', relativePath: '' }] }),
        envelope({ sources: [{ kind: 'agent-repository', relativePath: '..' }] }),
        envelope({ sources: [{ kind: 'agent-repository', relativePath: 'a/../b' }] }),
        envelope({ sources: [{ kind: 'agent-repository', relativePath: 'a/./b' }] }),
        envelope({ sources: [{ kind: 'agent-repository', relativePath: 'a//b' }] }),
        envelope({ sources: [{ kind: 'agent-repository', relativePath: '/abs' }] }),
        envelope({ sources: [{ kind: 'agent-repository', relativePath: 'nul\0byte' }] }),
        envelope({ sources: [{ kind: 'agent-repository', relativePath: 'x'.repeat(4097) }] }),
        envelope({ sources: [{ kind: 'agent-repository', relativePath: 'a' }, { kind: 'agent-library', relativePath: 'a' }] }),
        envelope({ sources: Array.from({ length: 513 }, (_, index) => ({ kind: 'agent-repository', relativePath: `r${index}` })) }),
        '{"schemaVersion":1',
    ];
    let index = 0;
    const listener = await fakeListener(t, (req, res) => json(res, 200, cases[index++]));
    const env = agentEnvironment(t, listener.url);
    for (let current = 0; current < cases.length; current += 1) {
        await rejectsWith(fetchRuntimeSources({ env }), RUNTIME_SOURCES_INVALID);
    }
    assert.equal(listener.requests.length, cases.length);
    // A 4096-byte path is still accepted.
    const atBound = await fakeListener(t, (req, res) => json(res, 200, envelope({ sources: [{ kind: 'agent-repository', relativePath: 'x'.repeat(4096) }] })));
    assert.equal((await fetchRuntimeSources({ env: agentEnvironment(t, atBound.url) })).sources[0].relativePath.length, 4096);
});

test('exactly one retry follows a 503 edge_generation_changed; a second race is UNAVAILABLE', async (t) => {
    const once = await fakeListener(t, (req, res, count) => (count === 1
        ? json(res, 503, { ok: false, error: 'edge_generation_changed' })
        : json(res, 200, envelope())));
    assert.deepEqual(await fetchRuntimeSources({ env: agentEnvironment(t, once.url) }), envelope());
    assert.equal(once.requests.length, 2);
    assert.notEqual(once.requests[0].headers['ploinky-agent-assertion'], once.requests[1].headers['ploinky-agent-assertion'],
        'the retry signs a fresh assertion');

    const twice = await fakeListener(t, (req, res) => json(res, 503, { ok: false, error: 'edge_generation_changed' }));
    await rejectsWith(fetchRuntimeSources({ env: agentEnvironment(t, twice.url) }), RUNTIME_SOURCES_UNAVAILABLE,
        { status: 503, routerCode: 'edge_generation_changed' });
    assert.equal(twice.requests.length, 2, 'at most one retry');

    const unavailable = await fakeListener(t, (req, res) => json(res, 503, { ok: false, error: 'RUNTIME_SOURCES_UNAVAILABLE' }));
    await rejectsWith(fetchRuntimeSources({ env: agentEnvironment(t, unavailable.url) }), RUNTIME_SOURCES_UNAVAILABLE);
    assert.equal(unavailable.requests.length, 1, 'no retry for another 503');
});

test('timeout and Router 500 are UNAVAILABLE; 403, 404, lease and descriptor failures are INVALID', async (t) => {
    const hang = await fakeListener(t, () => {});
    await rejectsWith(fetchRuntimeSources({ env: agentEnvironment(t, hang.url), timeoutMs: 100 }), RUNTIME_SOURCES_UNAVAILABLE);

    const failed = await fakeListener(t, (req, res) => json(res, 500, { ok: false, error: 'boom' }));
    await rejectsWith(fetchRuntimeSources({ env: agentEnvironment(t, failed.url) }), RUNTIME_SOURCES_UNAVAILABLE, { status: 500 });

    for (const [status, error] of [[403, 'PRIVATE_CALLER_DENIED'], [404, 'not_found'], [503, 'RUNTIME_SOURCES_LEASE_INVALID']]) {
        const listener = await fakeListener(t, (req, res) => json(res, status, { ok: false, error }));
        await rejectsWith(fetchRuntimeSources({ env: agentEnvironment(t, listener.url) }), RUNTIME_SOURCES_INVALID, { status, routerCode: error });
    }

    const notJson = await fakeListener(t, (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('{}'); });
    await rejectsWith(fetchRuntimeSources({ env: agentEnvironment(t, notJson.url) }), RUNTIME_SOURCES_INVALID);

    const unused = await fakeListener(t, (req, res) => json(res, 200, envelope()));
    const env = agentEnvironment(t, unused.url);
    for (const broken of [
        Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'PLOINKY_ROUTER_DESCRIPTOR_FILE')),
        { ...env, PLOINKY_AGENT_ENABLE_GENERATION: 'other-generation' },
        { PLOINKY_AGENT_PRIVATE_SECRET: env.PLOINKY_AGENT_PRIVATE_SECRET },
    ]) {
        await rejectsWith(fetchRuntimeSources({ env: broken }), RUNTIME_SOURCES_INVALID);
    }
    const withoutSecret = { ...env };
    delete withoutSecret.PLOINKY_AGENT_PRIVATE_SECRET;
    await rejectsWith(fetchRuntimeSources({ env: withoutSecret }), RUNTIME_SOURCES_INVALID);
    assert.equal(unused.requests.length, 0, 'descriptor and identity failures send no request');
});
