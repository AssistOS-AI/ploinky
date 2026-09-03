import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { resolveManifestReadinessWaitOptions } from '../../cli/utils/runtime/startupReadiness.js';
import { waitForEnabledAgentReadiness } from '../../cli/utils/agents.js';
import { waitForNoWaitReadiness } from '../../cli/commands/noWaitWorker.js';
import { waitForAgentReady } from '../../cli/server/utils/agentReadiness.js';
import { buildBlockingReadinessEntryFromNode, waitForManifestReadiness } from '../../cli/commands/workspaceUtil.js';

const coldManifest = {
    agent: 'node server.mjs',
    readiness: { protocol: 'mcp' },
    health: { readiness: { script: 'healthcheck.sh', interval: 1, timeout: 5, failureThreshold: 180 } },
};

function environment(t, values) {
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = String(value);
    }
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
}

test('cold MCP startup outlives 120s only within its declared budget and still requires a handshake', async t => {
    environment(t, {
        PLOINKY_ENABLE_AGENT_READY_TIMEOUT_MS: undefined,
        PLOINKY_ENABLE_AGENT_READY_INTERVAL_MS: 1,
        PLOINKY_ENABLE_AGENT_READY_PROBE_TIMEOUT_MS: undefined,
    });
    let now = 1_000_000;
    let attempts = 0;
    let methods = [];
    t.mock.method(Date, 'now', () => now);
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const request = JSON.parse(Buffer.concat(chunks));
        methods.push(request.method);
        assert.equal(req.url, '/mcp');
        if (request.method === 'initialize') {
            attempts += 1;
            // The socket is open throughout installation, but MCP is available
            // only at 180 seconds. Move the clock, not the real network probe.
            now += 60_000;
            if (attempts < 3) {
                res.writeHead(503).end('installing');
                return;
            }
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
            jsonrpc: '2.0', id: request.id,
            result: request.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-06-18' },
        }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const port = server.address().port;
    const reset = () => { now = 1_000_000; attempts = 0; methods = []; };
    const started = { containerName: 'cold-agent', hostPort: port, runtime: 'podman' };

    assert.equal(await waitForAgentReady({ hostPort: port }, {
        protocol: 'mcp', timeoutMs: 120000, intervalMs: 1,
    }), false, 'the previous fixed deadline fails while installation is still running');
    assert.equal(attempts, 2);

    reset();
    await waitForEnabledAgentReadiness('cold-agent', coldManifest, started, { containerWaitRunning: () => true });
    assert.equal(now, 1_180_000);
    assert.deepEqual(methods, ['initialize', 'initialize', 'initialize', 'notifications/initialized', 'tools/list']);

    reset();
    process.env.PLOINKY_ENABLE_AGENT_READY_TIMEOUT_MS = '90000';
    await assert.rejects(waitForEnabledAgentReadiness('cold-agent', coldManifest, started, {
        containerWaitRunning: () => true,
    }), /readiness protocol 'mcp' did not succeed/);
    assert.equal(attempts, 2, 'an explicit operator deadline remains shorter than the manifest budget');

    reset();
    delete process.env.PLOINKY_ENABLE_AGENT_READY_TIMEOUT_MS;
    await assert.rejects(waitForEnabledAgentReadiness('cold-agent', { readiness: { protocol: 'mcp' } }, started, {
        containerWaitRunning: () => true,
    }), /readiness protocol 'mcp' did not succeed/);
    assert.equal(attempts, 2, 'an undeclared budget retains the original deadline');

    reset();
    await assert.rejects(waitForEnabledAgentReadiness('cold-agent', coldManifest, started, {
        containerWaitRunning: () => attempts === 0,
    }), /exited before readiness protocol 'mcp' succeeded/);
    assert.equal(attempts, 1, 'a longer budget cannot hide a runtime exit');
});

test('shared readiness options preserve defaults, manifest attempts and explicit operator overrides', () => {
    assert.deepEqual(resolveManifestReadinessWaitOptions({}), { timeoutMs: 120000, intervalMs: 250, probeTimeoutMs: 1000 });
    assert.deepEqual(resolveManifestReadinessWaitOptions({}, 15000), { timeoutMs: 15000, intervalMs: 250, probeTimeoutMs: 1000 });
    assert.deepEqual(resolveManifestReadinessWaitOptions(coldManifest), { timeoutMs: 1080000, intervalMs: 1000, probeTimeoutMs: 5000 });
    assert.deepEqual(resolveManifestReadinessWaitOptions(coldManifest, 120000, {
        timeoutMs: '70000', intervalMs: '50', probeTimeoutMs: '500',
    }), { timeoutMs: 70000, intervalMs: 50, probeTimeoutMs: 500 });
    assert.equal(resolveManifestReadinessWaitOptions({ health: { readiness: { failureThreshold: 1 } } }).timeoutMs, 120000);
});

test('readiness deadlines reject malformed, nonfinite and overflowing declarations and overrides', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, 'junk', '120junk', true, {}, Number.MAX_SAFE_INTEGER]) {
        for (const field of ['interval', 'timeout', 'failureThreshold']) {
            const manifest = structuredClone(coldManifest);
            manifest.health.readiness[field] = value;
            assert.throws(() => resolveManifestReadinessWaitOptions(manifest), /finite positive integer/);
        }
        for (const field of ['timeoutMs', 'intervalMs', 'probeTimeoutMs']) {
            assert.throws(() => resolveManifestReadinessWaitOptions(coldManifest, 120000, { [field]: value }), /finite positive integer/);
        }
    }
    assert.throws(() => resolveManifestReadinessWaitOptions({ health: { readiness: [] } }), /must be an object/);
    assert.throws(() => resolveManifestReadinessWaitOptions({ health: { readiness: '180' } }), /must be an object/);
});

test('blocking, restart and reinstall readiness use the same declared budget and preserve their default floors', async t => {
    for (const kind of ['STATIC', 'DEPENDENCY']) {
        environment(t, Object.fromEntries(['TIMEOUT', 'INTERVAL', 'PROBE_TIMEOUT'].map(field => [`PLOINKY_${kind}_AGENT_READY_${field}_MS`, undefined])));
    }
    for (const isStatic of [false, true]) {
        const entry = buildBlockingReadinessEntryFromNode({ id: 'cold-agent', shortAgentName: 'cold-agent', manifest: coldManifest, isStatic }, { hostPort: 31000 });
        assert.equal(entry.timeoutMs, 1080000);
        assert.equal(entry.protocol, 'mcp');
    }
    for (const kind of ['reinstall', 'dependency', 'static']) {
        for (const manifest of [coldManifest, { readiness: { protocol: 'mcp' } }]) {
            let observed;
            await waitForManifestReadiness({ key: 'cold-agent', label: 'cold-agent', kind, manifest, route: { hostPort: 31000 } }, {
                waitForAgentReadyImpl(_route, options) { observed = options; return true; },
            });
            assert.equal(observed.timeoutMs, manifest.health ? 1080000 : kind === 'reinstall' ? 15000 : 120000);
            assert.equal(observed.protocol, 'mcp');
        }
    }
    process.env.PLOINKY_DEPENDENCY_AGENT_READY_TIMEOUT_MS = '10000';
    await waitForManifestReadiness({ label: 'cold-agent', kind: 'reinstall', manifest: coldManifest, route: { hostPort: 31000 } }, {
        waitForAgentReadyImpl(_route, options) { assert.equal(options.timeoutMs, 10000); return true; },
    });
});

test('detached readiness uses declared MCP budget and keeps its explicit operator settings', async t => {
    environment(t, {
        PLOINKY_NO_WAIT_READY_TIMEOUT_MS: undefined,
        PLOINKY_NO_WAIT_READY_INTERVAL_MS: undefined,
        PLOINKY_NO_WAIT_READY_PROBE_TIMEOUT_MS: undefined,
    });
    let observed;
    const run = manifest => waitForNoWaitReadiness({ manifest, shortAgent: 'cold-agent', containerName: 'cold-agent', hostPort: 31000 }, {
        waitUntilReady(_route, options) { observed = options; return true; },
    });
    await run(coldManifest);
    assert.deepEqual(observed, { timeoutMs: 1080000, intervalMs: 1000, probeTimeoutMs: 5000, protocol: 'mcp' });
    await run({ readiness: { protocol: 'mcp' } });
    assert.deepEqual(observed, { timeoutMs: 120000, intervalMs: 250, probeTimeoutMs: 1000, protocol: 'mcp' });
    process.env.PLOINKY_NO_WAIT_READY_TIMEOUT_MS = '20000';
    process.env.PLOINKY_NO_WAIT_READY_INTERVAL_MS = '75';
    process.env.PLOINKY_NO_WAIT_READY_PROBE_TIMEOUT_MS = '800';
    await run(coldManifest);
    assert.deepEqual(observed, { timeoutMs: 20000, intervalMs: 75, probeTimeoutMs: 800, protocol: 'mcp' });
});
