import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    AGENT_IMAGES_INVALID,
    AGENT_IMAGES_UNAVAILABLE,
    fetchAgentImages,
} from '../../Agent/lib/agentImages.mjs';
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-images-client-'));
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

const DIGEST = `sha256:${'a'.repeat(64)}`;
function entry(overrides = {}) {
    return { ref: 'suite/tool', about: 'A tool', enableMode: 'global', runtime: 'podman',
        image: { reference: 'registry.example/suite/tool', digest: DIGEST, imageId: DIGEST }, reason: null, ...overrides };
}
function envelope(agents = [entry()]) { return { schemaVersion: 1, agents }; }

test('fresh bodyless signed private hop returns a deeply frozen validated image list', async (t) => {
    const listener = await fakeListener(t, (req, res) => json(res, 200, envelope()));
    const env = agentEnvironment(t, listener.url);
    const result = await fetchAgentImages({ env });
    assert.deepEqual(result, envelope());
    for (const value of [result, result.agents, result.agents[0], result.agents[0].image]) {
        assert.equal(Object.isFrozen(value), true);
    }
    await fetchAgentImages({ env });
    assert.equal(listener.requests.length, 2);
    for (const request of listener.requests) {
        assert.equal(request.method, 'GET');
        assert.equal(request.url, '/api/edge/agent-images');
        assert.equal(request.body.length, 0);
        const { payload } = verifyJws(request.headers['ploinky-agent-assertion'], {
            secret: Buffer.from(env.PLOINKY_AGENT_PRIVATE_SECRET, 'hex'),
            expectedAudience: 'ploinky-private-router', maxTtlSeconds: 30,
        });
        assert.equal(payload.path, '/api/edge/agent-images');
        assert.equal(payload.iss, CALLER.agentId);
    }
});

test('rejects malformed schema, duplicate refs, inconsistent reasons, identities and bounds', async (t) => {
    const cases = [
        { ...envelope(), extra: 1 }, { ...envelope(), schemaVersion: 2 },
        envelope([entry({ extra: 1 })]), envelope([entry(), entry()]),
        envelope([entry({ ref: '../tool' })]), envelope([entry({ about: 'x'.repeat(4097) })]),
        envelope([entry({ enableMode: 'unknown' })]), envelope([entry({ runtime: 'unknown' })]),
        envelope([entry({ image: null, reason: null })]), envelope([entry({ reason: 'digest_unknown' })]),
        envelope([entry({ runtime: 'bwrap' })]), envelope([entry({ image: { ...entry().image, digest: 'sha256:short' } })]),
        envelope([entry({ image: { ...entry().image, imageId: 'tag' } })]),
        envelope([entry({ image: { ...entry().image, reference: '--option' } })]),
        envelope([entry({ image: { ...entry().image, reference: 'unqualified/image' } })]),
        envelope([entry({ image: { ...entry().image, reference: 'registry.example/suite/tool:tag' } })]),
        envelope([entry({ image: { ...entry().image, reference: `repo@${DIGEST}` } })]),
        envelope(Array.from({ length: 257 }, (_, n) => entry({ ref: `suite/tool${n}` }))),
        '{"schemaVersion":1', 'x'.repeat(256 * 1024 + 1),
    ];
    let index = 0;
    const listener = await fakeListener(t, (req, res) => json(res, 200, cases[index++]));
    const env = agentEnvironment(t, listener.url);
    for (const value of cases) {
        await assert.rejects(fetchAgentImages({ env }), { code: AGENT_IMAGES_INVALID }, JSON.stringify(value).slice(0, 100));
    }
    const valid = envelope([
        entry({ image: null, reason: 'digest_unknown' }),
        entry({ ref: 'suite/native', runtime: 'seatbelt', image: null, reason: 'not_container' }),
        entry({ ref: 'suite/notpulled', image: { ...entry().image, imageId: null } }),
    ]);
    const accepted = await fakeListener(t, (req, res) => json(res, 200, valid));
    assert.deepEqual(await fetchAgentImages({ env: agentEnvironment(t, accepted.url) }), valid);
    const empty = await fakeListener(t, (req, res) => json(res, 200, envelope([])));
    assert.deepEqual((await fetchAgentImages({ env: agentEnvironment(t, empty.url) })).agents, []);
});

test('one generation-race retry signs freshly; other transport and contract failures are classified', async (t) => {
    const once = await fakeListener(t, (req, res, count) => count === 1
        ? json(res, 503, { error: 'edge_generation_changed' }) : json(res, 200, envelope()));
    assert.deepEqual(await fetchAgentImages({ env: agentEnvironment(t, once.url) }), envelope());
    assert.equal(once.requests.length, 2);
    assert.notEqual(once.requests[0].headers['ploinky-agent-assertion'], once.requests[1].headers['ploinky-agent-assertion']);
    for (const [status, error, code, requests] of [
        [503, 'edge_generation_changed', AGENT_IMAGES_UNAVAILABLE, 2],
        [503, 'AGENT_IMAGES_UNAVAILABLE', AGENT_IMAGES_UNAVAILABLE, 1],
        [500, 'failed', AGENT_IMAGES_UNAVAILABLE, 1],
        [403, 'PRIVATE_CALLER_DENIED', AGENT_IMAGES_INVALID, 1],
        [404, 'not_found', AGENT_IMAGES_INVALID, 1],
        [503, 'AGENT_IMAGES_LEASE_INVALID', AGENT_IMAGES_INVALID, 1],
        [302, 'redirect', AGENT_IMAGES_INVALID, 1],
    ]) {
        const listener = await fakeListener(t, (req, res) => json(res, status, { error }));
        await assert.rejects(fetchAgentImages({ env: agentEnvironment(t, listener.url) }), { code, status, routerCode: error });
        assert.equal(listener.requests.length, requests);
    }
    const plain = await fakeListener(t, (req, res) => { res.writeHead(200); res.end('{}'); });
    await assert.rejects(fetchAgentImages({ env: agentEnvironment(t, plain.url) }), { code: AGENT_IMAGES_INVALID });
    const unused = await fakeListener(t, (req, res) => json(res, 200, envelope()));
    const env = agentEnvironment(t, unused.url);
    delete env.PLOINKY_AGENT_PRIVATE_SECRET;
    await assert.rejects(fetchAgentImages({ env }), { code: AGENT_IMAGES_INVALID });
    assert.equal(unused.requests.length, 0);
});

test('timeout and caller abort stop the request with AGENT_IMAGES_UNAVAILABLE', async (t) => {
    const listener = await fakeListener(t, () => {});
    const env = agentEnvironment(t, listener.url);
    await assert.rejects(fetchAgentImages({ env, timeoutMs: 40 }), { code: AGENT_IMAGES_UNAVAILABLE });
    const controller = new AbortController();
    const pending = fetchAgentImages({ env, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { code: AGENT_IMAGES_UNAVAILABLE });
});

