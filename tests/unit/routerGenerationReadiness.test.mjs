import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    ROUTER_GENERATION_SOURCE_FORMAT,
    ensureRouterGenerationReady,
    readRouterGenerationHealth,
} from '../../cli/utils/runtime/routerGenerationReadiness.mjs';
import {
    applyEdgeRoutingGeneration,
    loadActiveEdgeRoutingGeneration,
} from '../../cli/sandbox/edgeGeneration.js';
import {
    createRouterOriginsWorkspace,
    installLegacyGeneration,
} from '../helpers/routerOriginsWorkspace.mjs';

const READY = Object.freeze({
    status: 'healthy',
    pid: 1234,
    generationSourceFormat: ROUTER_GENERATION_SOURCE_FORMAT,
});
const LEGACY = Object.freeze({ status: 'healthy', pid: 1233 });
const NOT_READY = { code: 'PLOINKY_ROUTER_GENERATION_NOT_READY' };

async function healthServer(t, handler) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'router-health-'));
    const socketPath = path.join(directory, 'health.sock');
    const server = http.createServer(handler);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return socketPath;
}

function migrationState(fixture) {
    return {
        selector: fs.readFileSync(path.join(fixture.edgeDir, 'active.json'), 'utf8'),
        generationFiles: fs.readdirSync(path.join(fixture.edgeDir, 'generations')).sort(),
        routing: fs.readFileSync(path.join(fixture.ploinkyDir, 'routing.json'), 'utf8'),
        agents: fs.readFileSync(path.join(fixture.ploinkyDir, 'agents.json'), 'utf8'),
    };
}

test('generation health reads the daemon identity and loaded format over the Unix health socket', async (t) => {
    const requests = [];
    const socketPath = await healthServer(t, (req, res) => {
        requests.push({ method: req.method, url: req.url });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...READY, uptime: 10 }));
    });
    assert.deepEqual(await readRouterGenerationHealth({ socketPath }), { ...READY, uptime: 10 });
    assert.deepEqual(requests, [{ method: 'GET', url: '/health' }]);
});

test('health probe retains a valid legacy identity without inventing format support', async (t) => {
    const socketPath = await healthServer(t, (_req, res) => res.end(JSON.stringify(LEGACY)));
    assert.deepEqual(await readRouterGenerationHealth({ socketPath }), LEGACY);
});

test('health probe rejects malformed, unsuccessful, or identity-free responses', async (t) => {
    let response;
    const socketPath = await healthServer(t, (_req, res) => {
        res.writeHead(response.status);
        res.end(response.body);
    });
    for (const [label, status, value] of [
        ['invalid JSON', 200, '{'],
        ['redirect', 302, JSON.stringify(READY)],
        ['server failure', 503, JSON.stringify(READY)],
        ['array', 200, '[]'],
        ['null', 200, 'null'],
        ['unhealthy', 200, JSON.stringify({ ...READY, status: 'starting' })],
        ['missing identity', 200, JSON.stringify({ status: 'healthy' })],
        ['string identity', 200, JSON.stringify({ ...READY, pid: '1234' })],
        ['zero identity', 200, JSON.stringify({ ...READY, pid: 0 })],
        ['fractional identity', 200, JSON.stringify({ ...READY, pid: 1.5 })],
    ]) {
        response = { status, body: value };
        await assert.rejects(readRouterGenerationHealth({ socketPath }), NOT_READY, label);
    }
});

test('health probe bounds oversized and stalled responses and rejects an unreachable socket', async (t) => {
    const oversized = await healthServer(t, (_req, res) => res.end('x'.repeat(65 * 1024)));
    await assert.rejects(readRouterGenerationHealth({ socketPath: oversized }), /too large/);

    const stalled = await healthServer(t, () => {});
    const startedAt = Date.now();
    await assert.rejects(readRouterGenerationHealth({ socketPath: stalled, timeoutMs: 30 }), /timed out/);
    assert.ok(Date.now() - startedAt < 1_000, 'a stalled daemon must not hold startup indefinitely');

    await assert.rejects(readRouterGenerationHealth({ socketPath: `${stalled}.missing`, timeoutMs: 30 }), NOT_READY);
});

test('health probe rejects a response whose declared body is interrupted', async (t) => {
    const socketPath = await healthServer(t, (_req, res) => {
        res.writeHead(200, { 'Content-Length': '1000' });
        res.write('{"status":');
        setImmediate(() => res.destroy());
    });
    await assert.rejects(readRouterGenerationHealth({ socketPath }), NOT_READY);
});

test('a compatible running Router is reused without stopping or spawning', async () => {
    const events = [];
    const result = await ensureRouterGenerationReady({
        waitForListener: async (child) => { assert.equal(child, null); events.push('listener'); },
        readHealth: async () => { events.push('health'); return READY; },
        stopRouter: () => assert.fail('must not stop a compatible Router'),
        spawnRouter: () => assert.fail('must not spawn a second Router'),
        onReload: () => assert.fail('must not announce a reload'),
        timeoutMs: 30,
    });
    assert.deepEqual(result, { reused: true, child: null });
    assert.deepEqual(events, ['listener', 'health']);
});

test('legacy Router replacement is confirmed before an actual generation migration may run', async (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    installLegacyGeneration(fixture.edgeDir, fixture.applied.selector.generation);
    assert.equal(loadActiveEdgeRoutingGeneration({ workspaceRoot: fixture.workspace }).generation.routerOrigins, null);
    const before = migrationState(fixture);
    const events = [];
    const child = { pid: 1234, exitCode: null };
    let running = true;
    let spawned = false;
    const replacementRead = Promise.withResolvers();
    const releaseHealth = Promise.withResolvers();
    const migration = (async () => {
        const result = await ensureRouterGenerationReady({
            waitForListener: async (observedChild) => {
                events.push(observedChild ? 'replacement-listener' : 'listener');
                if (!running) throw new Error('listener is down');
            },
            readHealth: async () => {
                assert.deepEqual(migrationState(fixture), before, 'a health observation must precede generation mutation');
                if (!spawned) { events.push('legacy-health'); return LEGACY; }
                events.push('replacement-health');
                replacementRead.resolve();
                return releaseHealth.promise;
            },
            onReload: () => events.push('reload'),
            stopRouter: async () => { events.push('stop'); running = false; },
            spawnRouter: async () => { events.push('spawn'); spawned = true; running = true; return child; },
            timeoutMs: 200,
        });
        events.push('generation-write');
        const applied = applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'verified-router-migration' });
        return { result, applied };
    })();
    await Promise.race([replacementRead.promise, migration]);
    assert.deepEqual(migrationState(fixture), before, 'even a listening replacement is insufficient without format confirmation');
    releaseHealth.resolve(READY);
    const { result, applied } = await migration;
    assert.deepEqual(result, { reused: false, child });
    assert.deepEqual(applied.generation.routerOrigins, ['http://pgx:3000']);
    assert.deepEqual(events, [
        'listener', 'legacy-health', 'reload', 'stop', 'listener', 'spawn',
        'replacement-listener', 'replacement-health', 'generation-write',
    ]);
});

test('missing health support triggers reload rather than compatible reuse', async () => {
    let running = true;
    let spawned = false;
    const child = { pid: 1234, exitCode: null };
    const result = await ensureRouterGenerationReady({
        waitForListener: async () => { if (!running) throw new Error('stopped'); },
        readHealth: async () => {
            if (!spawned) throw new Error('legacy health socket missing');
            return READY;
        },
        stopRouter: async () => { running = false; },
        spawnRouter: async () => { spawned = true; running = true; return child; },
        timeoutMs: 30,
    });
    assert.deepEqual(result, { reused: false, child });
});

test('cold startup cleans a surviving Watchdog before spawning and verifies its Router reader', async () => {
    const events = [];
    const child = { pid: 1234, exitCode: null };
    const result = await ensureRouterGenerationReady({
        waitForListener: async (observedChild) => {
            if (!observedChild) { events.push('listener-absent'); throw new Error('no Router listener'); }
            assert.equal(observedChild, child);
            events.push('replacement-listener');
        },
        stopRouter: async () => { events.push('watchdog-cleanup'); },
        spawnRouter: async () => { events.push('spawn'); return child; },
        readHealth: async () => { events.push('verified-health'); return READY; },
        timeoutMs: 30,
    });
    assert.deepEqual(result, { reused: false, child });
    assert.deepEqual(events, ['listener-absent', 'watchdog-cleanup', 'spawn', 'replacement-listener', 'verified-health']);
});

test('failed or unverified Router replacement never reaches the generation-write continuation', async (t) => {
    const fixture = createRouterOriginsWorkspace(t, { hosts: ['pgx'] });
    installLegacyGeneration(fixture.edgeDir, fixture.applied.selector.generation);
    const before = migrationState(fixture);
    const cases = [
        ['no stop operation', {
            waitForListener: async () => {},
            readHealth: async () => LEGACY,
            spawnRouter: () => assert.fail('cannot spawn while the old daemon runs'),
        }],
        ['stop throws', {
            waitForListener: async () => {},
            readHealth: async () => LEGACY,
            stopRouter: async () => { throw new Error('stop failed'); },
            spawnRouter: () => assert.fail('cannot spawn after failed stop'),
        }],
        ['old daemon keeps listening', {
            waitForListener: async () => {},
            readHealth: async () => LEGACY,
            stopRouter: async () => {},
            spawnRouter: () => assert.fail('cannot spawn before old listener is down'),
        }],
        ['replacement is incompatible', {
            waitForListener: async (child) => { if (!child) throw new Error('absent'); },
            readHealth: async () => LEGACY,
            spawnRouter: async () => ({ pid: 1234, exitCode: null }),
        }],
        ['replacement exits', {
            waitForListener: async (child) => { if (!child) throw new Error('absent'); },
            readHealth: () => assert.fail('an exited child is not a live Router'),
            spawnRouter: async () => ({ pid: 1234, exitCode: 1 }),
        }],
    ];
    for (const [label, options] of cases) {
        let wrote = false;
        await assert.rejects(async () => {
            await ensureRouterGenerationReady({ ...options, timeoutMs: 20 });
            wrote = true;
            applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'must-not-migrate' });
        }, undefined, label);
        assert.equal(wrote, false, label);
        assert.deepEqual(migrationState(fixture), before, label);
    }
});

test('detailed health advertises the format loaded by the Router, independent of mutable checkout reads', () => {
    const source = fs.readFileSync(new URL('../../cli/server/RoutingServer.js', import.meta.url), 'utf8');
    assert.match(source, /import \{ ROUTER_GENERATION_SOURCE_FORMAT \} from '\.\.\/utils\/runtime\/routerGenerationReadiness\.mjs'/);
    const detailedHealth = source.slice(source.indexOf('function detailedHealthData()'), source.indexOf('\nfunction ', source.indexOf('function detailedHealthData()') + 1));
    assert.match(detailedHealth, /generationSourceFormat: ROUTER_GENERATION_SOURCE_FORMAT/);
    assert.doesNotMatch(detailedHealth, /readFileSync|readFile\(/);
});
