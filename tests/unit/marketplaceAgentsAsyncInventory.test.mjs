import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';

const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'marketplace-inventory-'));
const previousCwd = process.cwd();
const previousKey = process.env.PLOINKY_MASTER_KEY;
const previousPath = process.env.PATH;
process.chdir(workspace);
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
fs.mkdirSync('.ploinky');
const { handleMarketplaceRoutes, __testables } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const { collectLiveAgentContainersAsync, collectLiveAgentContainersStrictAsync } = await import('../../cli/sandbox/docker/containerRegistry.js');
const { authService, SSO_AUTH_COOKIE_NAME } = await import('../../cli/server/authHandlers/shared.js');
const { mintBrowserCsrfToken } = await import('../../cli/server/browserMutationSecurity.js');

const policy = { mode: 'sso' };
const admin = { sessionId: 'admin-provider-session', user: { id: 'admin', roles: ['admin'] } };
const originalConfigured = authService.isConfigured;
const originalValidate = authService.validateSession;
authService.isConfigured = () => true;
authService.validateSession = async id => (id === admin.sessionId ? admin : null);
const snapshot = { generation: 'generation-a', agents: { shell: { type: 'agent', agentName: 'shell', repoName: 'repo', auth: policy } }, routing: { static: { agent: 'shell' }, routes: { shell: { agent: 'shell', repo: 'repo' } } }, manifests: {} };
const plan = () => ({ ok: true, kind: 'router-surface', surface: 'marketplace-ui', listener: 'public', hostSelection: { kind: 'agent-root', record: { routeKey: 'shell' } }, forwarding: { protocol: 'https', authority: 'explorer.example.test' }, snapshot, lease: { id: snapshot.generation, snapshot, commit: () => true } });

// One installed agent, so a listing carries a row whose runtime state comes from the container inventory.
const manifestPath = path.join(workspace, 'fixture-agents', 'worker', 'manifest.json');
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, JSON.stringify({ about: 'fixture worker' }));
const summaries = [{ repo: 'repo', installed: true, agents: [{ repo: 'repo', name: 'worker', about: 'fixture worker', manifestPath }] }];
const runningWorker = { containerName: 'ploinky_repo_worker_abc123', runtime: 'podman', state: { status: 'running', running: true, pid: 4242 } };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function mockResponse() {
    const res = new EventEmitter();
    res.status = 0;
    res.body = undefined;
    res.writableEnded = false;
    res.closed = false;
    res.setHeader = () => {};
    res.writeHead = (code) => { res.status = code; };
    res.ended = new Promise((resolve) => {
        res.end = (body) => {
            res.body = body === undefined ? undefined : JSON.parse(body);
            res.writableEnded = true;
            resolve(res);
            queueMicrotask(() => res.emit('close'));
        };
    });
    return res;
}

// Starts a marketplace request. `res.ended` settles when a response body was written; `done` settles when the handler returns.
function startRequest({ method = 'GET', resource = 'agents', body, res = mockResponse(), ...routeOptions } = {}) {
    const req = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.headers = { host: 'explorer.example.test', origin: 'https://explorer.example.test', cookie: `${SSO_AUTH_COOKIE_NAME}=${admin.sessionId}` };
    req.session = admin;
    if (method !== 'GET') {
        req.headers['x-ploinky-browser-csrf-token'] = mintBrowserCsrfToken({ req, routePlan: plan(), authContext: { boundHostRouteKey: 'shell' }, sessionId: admin.sessionId });
    }
    const url = new URL(`https://explorer.example.test/api/marketplace/${resource}`);
    const done = handleMarketplaceRoutes(req, res, url, { routePlan: plan(), enableAgentAction: async () => ({ result: { status: 'enabled' } }), ...routeOptions });
    return { res, done };
}
const get = (options) => startRequest({ method: 'GET', ...options });

// A collector that tracks how many inventories are in flight. `release(n)` finishes the n-th started collection (1-based), after which it
// answers with `containers`.
function trackedCollector(containers = []) {
    const state = { started: 0, inFlight: 0, maxInFlight: 0, gates: [] };
    state.collect = async () => {
        const index = ++state.started;
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        const gate = deferred();
        state.gates[index] = gate;
        try {
            await gate.promise;
            return containers;
        } finally {
            state.inFlight -= 1;
        }
    };
    state.release = (index) => state.gates[index]?.resolve();
    state.releaseAll = () => state.gates.forEach(gate => gate?.resolve());
    return state;
}

async function until(predicate, label, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
        await sleep(5);
    }
}

// A `podman` on PATH. `script` is the shell body; the stub dir is returned and PATH is restored by `restore()`.
function installStubPodman(script) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'inventory-stub-'));
    fs.writeFileSync(path.join(dir, 'podman'), `#!/bin/sh\nDIR='${dir}'\n${script}\n`, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${previousPath}`;
    return { dir, restore: () => { process.env.PATH = previousPath; } };
}
function killRecordedPids(dir) {
    const file = path.join(dir, 'pids');
    if (!fs.existsSync(file)) return [];
    const pids = fs.readFileSync(file, 'utf8').split('\n').map(Number).filter(Boolean);
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already gone */ } }
    return pids;
}
const processAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

function startHeartbeat() {
    let last = performance.now();
    let max = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        max = Math.max(max, now - last);
        last = now;
    }, 1);
    return { stop() { clearInterval(timer); return Math.max(max, performance.now() - last); } };
}

test.after(() => {
    process.env.PATH = previousPath;
    authService.isConfigured = originalConfigured;
    authService.validateSession = originalValidate;
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.PLOINKY_MASTER_KEY; else process.env.PLOINKY_MASTER_KEY = previousKey;
    fs.rmSync(workspace, { recursive: true, force: true });
});

test('GET agents with an injected collector equals the listing built from the same container list', async () => {
    const collector = trackedCollector([runningWorker]);
    const request = get({ collectContainers: collector.collect, agentListOptions: { summaries } });
    await until(() => collector.started === 1, 'the inventory to start');
    collector.release(1);
    await request.res.ended;
    await request.done;
    assert.equal(request.res.status, 200);
    const reference = get({ agentListOptions: { summaries, liveContainers: [runningWorker] } });
    await reference.res.ended;
    assert.deepEqual(request.res.body, reference.res.body);
    const [row] = request.res.body.marketplace.agents;
    assert.equal(row.ref, 'repo/worker');
    assert.equal(row.containerName, runningWorker.containerName, 'the collected container was matched to the agent');
    const control = get({ agentListOptions: { summaries, liveContainers: [] } });
    await control.res.ended;
    assert.equal(control.res.body.marketplace.agents[0].containerName, '', 'a different container list gives a different listing');
});

test('GET agents never collects when the caller supplies runtimeEntries or liveContainers', async () => {
    let calls = 0;
    const collectContainers = async () => { calls += 1; return []; };
    for (const agentListOptions of [{ liveContainers: [] }, { runtimeEntries: [] }]) {
        const request = get({ collectContainers, agentListOptions: { summaries, ...agentListOptions } });
        await request.res.ended;
        assert.equal(request.res.status, 200);
    }
    assert.equal(calls, 0);
});

test('a failing collector reads as no live container, as the synchronous path did', async () => {
    const request = get({ collectContainers: async () => { throw new Error('engine unavailable'); }, agentListOptions: { summaries } });
    await request.res.ended;
    assert.equal(request.res.status, 200);
    assert.equal(request.res.body.marketplace.agents[0].containerName, '');
});

test('GET repos is still served', async () => {
    const request = get({ resource: 'repos' });
    await request.res.ended;
    assert.equal(request.res.status, 200);
    assert.ok(Array.isArray(request.res.body.marketplace.repositories));
});

test('POST enable and disable return a marketplace whose agents array has the GET shape', async () => {
    const getRequest = get({ agentListOptions: { summaries, liveContainers: [runningWorker] } });
    await getRequest.res.ended;
    for (const action of ['enable_agent', 'disable_agent']) {
        const request = startRequest({
            method: 'POST',
            body: { action, agentRef: 'repo/worker', mode: 'global' },
            agentListOptions: { summaries, liveContainers: [runningWorker] },
            enableAgentAction: async () => ({ result: { status: 'enabled' } }),
        });
        await request.res.ended;
        if (action === 'disable_agent') assert.equal(request.res.status, 409, 'disable of a never-enabled agent is blocked before a payload exists');
        else {
            assert.equal(request.res.status, 200, JSON.stringify(request.res.body));
            assert.ok(Array.isArray(request.res.body.marketplace.agents), 'marketplace.agents must be an array');
            assert.deepEqual(request.res.body.marketplace, getRequest.res.body.marketplace);
        }
    }
});

test('POST enable builds its response through the inventory collector too', async () => {
    const collector = trackedCollector([runningWorker]);
    const request = startRequest({
        method: 'POST',
        body: { action: 'enable_agent', agentRef: 'repo/worker', mode: 'global' },
        collectContainers: collector.collect,
        agentListOptions: { summaries },
    });
    await until(() => collector.started === 1, 'the post-mutation inventory to start');
    collector.release(1);
    await request.res.ended;
    assert.equal(request.res.status, 200);
    assert.equal(request.res.body.marketplace.agents[0].containerName, runningWorker.containerName);
});

test('5 concurrent GETs run at most 2 inventories at once and each collects for itself', async () => {
    const collector = trackedCollector([runningWorker]);
    const requests = Array.from({ length: 5 }, () => get({ collectContainers: collector.collect, agentListOptions: { summaries } }));
    await until(() => collector.started >= 2, 'two inventories to start');
    await sleep(50);
    assert.equal(collector.started, 2, 'only two inventories start while both slots are busy');
    collector.release(1);
    await until(() => collector.started === 3, 'a queued request to start its own inventory');
    for (let index = 2; index <= 5; index += 1) {
        await until(() => collector.started >= index, `inventory ${index}`);
        collector.release(index);
    }
    await Promise.all(requests.map(request => request.res.ended));
    assert.equal(collector.maxInFlight, 2);
    assert.equal(collector.started, 5, 'one inventory per request: nothing is shared');
    for (const request of requests) {
        assert.equal(request.res.status, 200);
        assert.equal(request.res.body.marketplace.agents[0].containerName, runningWorker.containerName);
    }
});

test('a queued inventory starts in the async context of its own request', async () => {
    const als = new AsyncLocalStorage();
    const seen = [];
    const gates = [];
    const requests = ['request-a', 'request-b', 'request-c'].map(id => als.run(id, () => get({
        agentListOptions: { summaries },
        collectContainers: async () => {
            const gate = deferred();
            seen.push({ expected: id, actual: als.getStore() });
            gates.push(gate);
            await gate.promise;
            return [];
        },
    })));
    await until(() => seen.length === 2, 'two inventories to start');
    gates[0].resolve();
    await until(() => seen.length === 3, 'the queued inventory to start');
    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(requests.map(request => request.res.ended));
    assert.deepEqual(seen.map(entry => entry.actual), seen.map(entry => entry.expected));
    assert.deepEqual(seen.map(entry => entry.expected).sort(), ['request-a', 'request-b', 'request-c']);
});

test('a request that closes while queued never starts an inventory, and the others finish', async () => {
    const collector = trackedCollector([]);
    try {
        const first = get({ collectContainers: collector.collect, agentListOptions: { summaries } });
        const second = get({ collectContainers: collector.collect, agentListOptions: { summaries } });
        await until(() => collector.started === 2, 'both slots to be busy');
        const aborted = get({ collectContainers: collector.collect, agentListOptions: { summaries } });
        const survivor = get({ collectContainers: collector.collect, agentListOptions: { summaries } });
        await sleep(30);
        aborted.res.emit('close');
        collector.release(1);
        collector.release(2);
        await until(() => collector.started >= 3, 'the surviving queued request to start');
        await sleep(50);
        assert.equal(collector.started, 3, 'the closed request started no inventory');
        collector.release(3);
        await Promise.all([first.res.ended, second.res.ended, survivor.res.ended]);
        await aborted.done;
        assert.equal(aborted.res.writableEnded, false, 'nothing is written to a closed response');
        assert.equal(aborted.res.status, 0);
        assert.equal(survivor.res.status, 200);
    } finally {
        collector.releaseAll();
    }
});

test('a response already closed before it reaches the limiter never starts an inventory, even with a free slot', async () => {
    const collector = trackedCollector([]);
    const res = mockResponse();
    res.closed = true;
    res.destroyed = true;
    const request = get({ res, collectContainers: collector.collect, agentListOptions: { summaries } });
    await sleep(100);
    try {
        assert.equal(collector.started, 0);
        assert.equal(res.writableEnded, false);
    } finally {
        collector.releaseAll();
    }
    await request.done;
});

test('a close event after the response ended does not cancel queued work', async () => {
    const collector = trackedCollector([]);
    const first = get({ collectContainers: collector.collect, agentListOptions: { summaries } });
    const second = get({ collectContainers: collector.collect, agentListOptions: { summaries } });
    await until(() => collector.started === 2, 'both slots to be busy');
    const queued = get({ collectContainers: collector.collect, agentListOptions: { summaries } });
    await sleep(30);
    queued.res.writableEnded = true;
    queued.res.emit('close');
    queued.res.writableEnded = false;
    collector.release(1);
    await until(() => collector.started === 3, 'the queued inventory to start');
    collector.releaseAll();
    await Promise.all([first.res.ended, second.res.ended, queued.res.ended]);
    assert.equal(queued.res.status, 200);
});

test('the limiter releases its slot when a job throws or rejects', async () => {
    const limiter = __testables.createInventoryLimiter(1);
    await assert.rejects(limiter(() => { throw new Error('sync failure'); }), /sync failure/);
    await assert.rejects(limiter(async () => { throw new Error('async failure'); }), /async failure/);
    assert.equal(await limiter(async () => 'next'), 'next');
});

test('the limiter runs queued jobs in order and reports a cancelled job as skipped', async () => {
    const limiter = __testables.createInventoryLimiter(1);
    const order = [];
    const gate = deferred();
    const first = limiter(async () => { order.push('first'); await gate.promise; return 1; });
    const cancelled = limiter(async () => { order.push('cancelled'); return 2; }, { isCancelled: () => true });
    const third = limiter(async () => { order.push('third'); return 3; });
    gate.resolve();
    assert.deepEqual(await Promise.all([first, cancelled, third]), [1, __testables.MARKETPLACE_INVENTORY_SKIPPED, 3]);
    assert.deepEqual(order, ['first', 'third']);
});

test('the event loop keeps running during a slow inventory (injected collector)', async () => {
    // Warm the listing path so the measurement sees only the inventory wait.
    await get({ agentListOptions: { summaries, liveContainers: [] } }).res.ended;
    const heartbeat = startHeartbeat();
    const request = get({ collectContainers: async () => { await sleep(300); return []; }, agentListOptions: { summaries } });
    await request.res.ended;
    const maxGap = heartbeat.stop();
    assert.equal(request.res.status, 200);
    assert.ok(maxGap < 20, `event loop gap ${maxGap.toFixed(1)} ms`);
});

test('the event loop keeps running while a real podman child takes 0.3 s (stub podman on PATH)', async () => {
    const stub = installStubPodman('exec sleep 0.3');
    try {
        await get({ agentListOptions: { summaries, liveContainers: [] } }).res.ended;
        const heartbeat = startHeartbeat();
        const startedAt = performance.now();
        const request = get({ agentListOptions: { summaries } });
        await request.res.ended;
        const elapsed = performance.now() - startedAt;
        const maxGap = heartbeat.stop();
        assert.equal(request.res.status, 200);
        assert.ok(elapsed >= 250, `the stub child must really have run (elapsed ${elapsed.toFixed(0)} ms)`);
        assert.ok(maxGap < 20, `event loop gap ${maxGap.toFixed(1)} ms`);
    } finally {
        stub.restore();
        killRecordedPids(stub.dir);
    }
});

test('a hung podman is killed at the timeout, the request completes with no containers, and the slot is freed', async () => {
    // The first two podman invocations hang; any later one answers at once with no containers.
    const stub = installStubPodman('if mkdir "$DIR/s1" 2>/dev/null || mkdir "$DIR/s2" 2>/dev/null; then echo $$ >> "$DIR/pids"; exec sleep 60; fi\nexit 0');
    try {
        const startedAt = performance.now();
        const requests = [get({ agentListOptions: { summaries } }), get({ agentListOptions: { summaries } }), get({ agentListOptions: { summaries } })];
        const finished = await Promise.race([
            Promise.all(requests.map(request => request.res.ended)).then(() => 'done'),
            sleep(8000).then(() => 'late'),
        ]);
        const elapsed = performance.now() - startedAt;
        assert.equal(finished, 'done', 'all three requests must complete within the 5 s timeout plus a margin (a hung child must not hold the slot)');
        assert.ok(elapsed >= 4500, `the hung children end by timeout, not earlier (elapsed ${elapsed.toFixed(0)} ms)`);
        for (const request of requests) {
            assert.equal(request.res.status, 200);
            assert.equal(request.res.body.marketplace.agents[0].containerName, '');
        }
        const pids = fs.readFileSync(path.join(stub.dir, 'pids'), 'utf8').split('\n').map(Number).filter(Boolean);
        assert.equal(pids.length, 2);
        assert.deepEqual(pids.filter(processAlive), [], 'the timed-out children were killed');
    } finally {
        stub.restore();
        killRecordedPids(stub.dir);
    }
});

test('the collectors map a hung engine to an empty list (default) or ENGINE_READ_FAILED (strict) within the timeout', async () => {
    const stub = installStubPodman('if mkdir "$DIR/s1" 2>/dev/null || mkdir "$DIR/s2" 2>/dev/null; then echo $$ >> "$DIR/pids"; exec sleep 60; fi\nexit 0');
    try {
        const startedAt = performance.now();
        const outcome = await Promise.race([
            Promise.allSettled([collectLiveAgentContainersAsync(), collectLiveAgentContainersStrictAsync()]),
            sleep(8000).then(() => 'late'),
        ]);
        assert.notEqual(outcome, 'late', 'a hung engine must not hold the collectors past the timeout plus a margin');
        assert.ok(performance.now() - startedAt >= 4500);
        const results = new Map([[0, outcome[0]], [1, outcome[1]]]);
        // Which collector got which hung child is a race; each one saw a hung child or the fast path, never a hang.
        for (const settled of results.values()) {
            if (settled.status === 'fulfilled') assert.deepEqual(settled.value, []);
            else assert.equal(settled.reason.code, 'ENGINE_READ_FAILED');
        }
        assert.equal(results.get(0).status, 'fulfilled');
        assert.deepEqual(results.get(0).value, []);
    } finally {
        stub.restore();
        killRecordedPids(stub.dir);
    }
});
