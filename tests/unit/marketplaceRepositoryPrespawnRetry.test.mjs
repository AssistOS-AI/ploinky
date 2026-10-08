import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { procFixture } from './marketplaceRepositoryProcFixtures.mjs';

// Reproduces the router latch on an incomplete pre-spawn census with the real
// process observer over an in-memory /proc, through the real Marketplace route.
const previousCwd = process.cwd();
const previousEnv = Object.fromEntries(['PLOINKY_WORKSPACE_ROOT', 'PLOINKY_MASTER_KEY'].map((key) => [key, process.env[key]]));
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repository-prespawn-retry-')));
const invocation = path.join(workspace, 'invocation');
fs.mkdirSync(invocation);
fs.mkdirSync(path.join(workspace, '.ploinky/repos'), { recursive: true });
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = '6'.repeat(64);
process.chdir(invocation);
const { handleMarketplaceRoutes } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const { mintSessionJwt, getSession } = await import('../../cli/server/auth/localService.js');
const { mintAdminCsrfToken } = await import('../../cli/server/adminControlSecurity.js');
const { createMarketplaceRepositoryRunner } = await import('../../cli/server/marketplaceRepositoryWorker.mjs');
const { createRepositoryProcessObserver } = await import('../../cli/server/marketplaceRepositoryProcessGroup.mjs');
const adminId = mintSessionJwt({ id: 'local:admin', roles: ['admin'] }, 1, { channel: 'cli' });

// Literal codes keep this file importable against a revision without them.
const RETRY = 'PLOINKY_MARKETPLACE_REPOSITORY_RETRY';
const RECOVERY = 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED';
const CLOSED = 'PLOINKY_MARKETPLACE_REPOSITORY_REQUEST_CLOSED';
const SUPERVISOR_PATH = fileURLToPath(new URL('../../cli/server/marketplaceRepositorySupervisor.mjs', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uninstall = { action: 'uninstall_repo', target: 'fixture' };

test.after(() => {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

function response() {
    return Object.assign(new EventEmitter(), {
        writes: 0, setHeader() {}, writeHead(status) { this.status = status; this.writes += 1; },
        end(value) { this.body = JSON.parse(value); this.writableEnded = true; this.emit('close'); },
    });
}
async function request(runner, body = uninstall) {
    const res = response();
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    req.headers = { host: 'localhost', origin: 'http://localhost', cookie: `ploinky_jwt=${adminId}` };
    req.session = getSession(adminId);
    req.headers['x-ploinky-csrf-token'] = mintAdminCsrfToken({ req, sessionId: adminId });
    await handleMarketplaceRoutes(req, res, new URL('http://localhost/api/marketplace/repos'), {
        repositoryWorkerEligibility: () => true, repositoryWorker: (options) => runner.run(options) });
    return res;
}

// A scripted supervisor: it is visible in /proc with the exact coordinator
// identity, follows the uninstall protocol, and leaves /proc when it exits.
function scriptedRunner(t, fixture, { observer = createRepositoryProcessObserver({ fsApi: fixture.fsApi }), scripts = [] } = {}) {
    const children = [];
    const logs = [];
    fixture.add(process.pid);
    const runner = createMarketplaceRepositoryRunner({
        observer, executablePath: '/node', resolveExecutable: async (value) => value,
        diagnosticSink: (type, entry) => { logs.push({ type, entry }); },
        spawnProcess(executable, args, options) {
            const script = scripts[children.length] || 'success';
            const child = new EventEmitter();
            const pid = process.pid + 1 + children.length;
            const operationId = options.env.PLOINKY_MARKETPLACE_REPOSITORY_OPERATION;
            const emit = (type, extra = {}) => child.emit('message', { type, operationId, ...extra });
            const exit = (code) => {
                if (child.exited) return;
                child.exited = true;
                fixture.processes.delete(pid);
                child.connected = false;
                child.emit('close', code, null);
            };
            const react = (message) => {
                if (message.type === 'ownership') emit('authorize');
                else if (message.type === 'authorization') {
                    emit('barrier'); emit('release-granted');
                    emit('terminal', message.ok ? { ok: true, result: { status: 'removed' } }
                        : { ok: false, error: { code: message.error.code, message: message.error.message } });
                    exit(0);
                }
            };
            Object.assign(child, { pid, args, options, connected: true, messages: [], exited: false,
                stdout: { resume() {} }, stderr: { resume() {} },
                send(message, callback) { this.messages.push(message); callback?.(null); setImmediate(() => react(message)); } });
            fixture.add(pid, { parent: process.pid, argv: [executable, ...args] });
            children.push(child);
            setImmediate(() => (script === 'pre-hello-exit' ? exit(1) : emit('hello', { pid })));
            return child;
        },
    });
    t.after(() => runner.shutdown());
    return { runner, children, logs, retries: () => logs.filter((entry) => entry.type === 'marketplace_repository_retryable') };
}
const overlap = (observation) => observation.diagnostic?.unknowns?.some((row) => row.category === 'overlap');
async function waitForLeakedScan(observer) {
    // The bounded census returned at its deadline; its task still owns the
    // scan flag until the delayed read returns and its finally runs.
    const until = Date.now() + 5_000;
    for (;;) {
        const observation = await observer.scan();
        if (!overlap(observation)) return observation;
        assert.ok(Date.now() < until, 'the leaked scan task did not finish');
        await sleep(25);
    }
}
const run = (runner, options = {}) => {
    const promise = runner.run({ operation: uninstall, rawBodyBytes: 20, cwd: invocation, workspaceRoot: workspace, ...options });
    promise.catch(() => {});
    return promise;
};

test('T8: a deadline-incomplete baseline returns 503 RETRY without latching; a real pre-hello exit still latches', { timeout: 30_000 }, async (t) => {
    const fixture = procFixture();
    const observer = createRepositoryProcessObserver({ fsApi: fixture.fsApi });
    const h = scriptedRunner(t, fixture, { observer, scripts: ['success', 'pre-hello-exit'] });
    fixture.setBeforeOpen(() => sleep(1_100));

    const first = await request(h.runner);
    assert.equal(first.body?.error, RETRY, `request 1 must be RETRY, got ${JSON.stringify(first.body)}`);
    assert.equal(first.status, 503);
    assert.equal(h.children.length, 0);
    assert.deepEqual(h.runner.snapshot(), { active: false, pending: 0, chargedBytes: 0, accepting: true,
        recoveryDebt: false, rescanRequired: true });
    assert.equal(h.runner.diagnostics().firstCause, null);
    assert.deepEqual(h.retries()[0]?.entry.cause.unknowns?.map((row) => row.category), ['deadline']);

    fixture.setBeforeOpen(async () => {});
    assert.equal((await waitForLeakedScan(observer)).complete, true);

    const second = await request(h.runner);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.result.status, 'removed');
    assert.equal(h.children.length, 1);
    assert.equal(h.runner.snapshot().rescanRequired, false);

    const third = await request(h.runner);
    assert.equal(third.status, 503);
    assert.equal(third.body.error, RECOVERY);
    assert.equal(h.children.length, 2);
    assert.equal(h.runner.diagnostics().firstCause.reason, 'pre-hello-exit');
    assert.equal(h.runner.snapshot().accepting, false);
    assert.equal(h.runner.snapshot().recoveryDebt, true);

    const fourth = await request(h.runner);
    assert.equal(fourth.status, 503);
    assert.equal(fourth.body.error, RECOVERY);
    assert.equal(h.children.length, 2, 'a latched runner spawns nothing');
    assert.equal(fixture.handles(), 0);
});

for (const [advanceMs, completes] of [[999, true], [1_001, false]]) {
    test(`probe boundary: a ${advanceMs} ms first /proc read ${completes ? 'completes and spawns' : 'returns RETRY without a spawn'}`, async (t) => {
        // Virtual observer time makes the 1 s census deadline exact.
        let virtual = 0;
        const fixture = procFixture();
        let delayed = false;
        fixture.setBeforeOpen(async () => { if (!delayed) { delayed = true; virtual += advanceMs; } });
        const observer = createRepositoryProcessObserver({ fsApi: fixture.fsApi, now: () => virtual });
        const h = scriptedRunner(t, fixture, { observer });
        const pending = run(h.runner);
        if (completes) {
            assert.equal((await pending).status, 'removed');
            assert.equal(h.children.length, 1);
        } else {
            await assert.rejects(pending, { code: RETRY });
            assert.equal(h.children.length, 0);
            assert.deepEqual(h.retries()[0].entry.cause.unknowns.map((row) => row.category), ['deadline']);
        }
        assert.equal(h.runner.snapshot().accepting, true);
        assert.equal(h.runner.snapshot().recoveryDebt, false);
        assert.equal(h.runner.diagnostics().firstCause, null);
    });
}

test('probe concurrency: a leaked stale scan task makes the next baseline fail fast with overlap, then a fresh baseline succeeds', { timeout: 30_000 }, async (t) => {
    const fixture = procFixture();
    const observer = createRepositoryProcessObserver({ fsApi: fixture.fsApi });
    const h = scriptedRunner(t, fixture, { observer });
    fixture.setBeforeOpen(() => sleep(1_100));
    await assert.rejects(run(h.runner), { code: RETRY });
    const started = Date.now();
    await assert.rejects(run(h.runner), { code: RETRY });
    assert.ok(Date.now() - started < 250, 'overlap is refused without waiting for the leaked task');
    assert.ok(h.runner.diagnostics().recent.some((entry) => entry.phase === 'baseline'
        && entry.unknowns?.some((row) => row.category === 'overlap')));
    assert.equal(h.children.length, 0);
    fixture.setBeforeOpen(async () => {});
    await waitForLeakedScan(observer);
    assert.equal((await run(h.runner)).status, 'removed');
    assert.equal(h.children.length, 1);
    assert.equal(h.runner.snapshot().accepting, true);
    assert.equal(h.runner.snapshot().recoveryDebt, false);
});

test('probe idempotency: 17 admitted tickets on a persistently incomplete census all RETRY with no spawn until a complete baseline', async (t) => {
    const fixture = procFixture();
    fixture.add(11, { unreadable: 'status' });
    const h = scriptedRunner(t, fixture);
    const tickets = Array.from({ length: 17 }, () => run(h.runner));
    assert.equal(h.runner.snapshot().pending, 16);
    const settled = await Promise.allSettled(tickets);
    assert.deepEqual([...new Set(settled.map((entry) => entry.reason?.code))], [RETRY]);
    assert.equal(h.children.length, 0);
    assert.equal(h.retries().length, 1, 'the retryable event is throttled');
    assert.deepEqual(h.retries()[0].entry.cause.unknowns, [{ category: 'permission', field: 'status', errno: 'EACCES', count: 1 }]);
    assert.equal(h.runner.diagnostics().firstCause, null);
    fixture.processes.get(11).unreadable = null;
    assert.equal((await run(h.runner)).status, 'removed');
    assert.equal(h.children.length, 1);
});

for (const complete of [true, false]) {
    test(`probe error injection: shutdown during an in-flight ${complete ? 'complete' : 'incomplete'} baseline never spawns`, async (t) => {
        const fixture = procFixture();
        if (!complete) fixture.add(11, { unreadable: 'status' });
        let open;
        const gate = new Promise((resolve) => { open = resolve; });
        let reads = 0;
        fixture.setBeforeOpen(() => { reads += 1; return gate; });
        const h = scriptedRunner(t, fixture);
        const pending = run(h.runner);
        while (!reads) await sleep(1);
        assert.deepEqual(await h.runner.shutdown(), { ok: true });
        await assert.rejects(pending, { code: CLOSED });
        open();
        while (fixture.handles()) await sleep(1);
        await sleep(10);
        assert.equal(h.children.length, 0);
        assert.equal(h.runner.snapshot().accepting, false);
        assert.equal(h.runner.snapshot().rescanRequired, false);
        await assert.rejects(run(h.runner), { code: RECOVERY });
    });
}

for (const complete of [true, false]) {
    test(`probe orphan: a response closed during ${complete ? 'a complete' : 'an incomplete'} baseline ends as ${complete ? 'closed' : 'RETRY'} without a latch`, async (t) => {
        const fixture = procFixture();
        if (!complete) fixture.add(11, { unreadable: 'status' });
        let open;
        const gate = new Promise((resolve) => { open = resolve; });
        let reads = 0;
        fixture.setBeforeOpen(() => { reads += 1; return gate; });
        const h = scriptedRunner(t, fixture);
        const res = Object.assign(new EventEmitter(), { closed: false, destroyed: false, writableEnded: false });
        const pending = run(h.runner, { response: res });
        while (!reads) await sleep(1);
        res.destroyed = true; res.emit('close');
        open();
        // An incomplete census throws before the closed check; a complete one
        // reaches the closed check before any spawn.
        await assert.rejects(pending, { code: complete ? CLOSED : RETRY });
        assert.equal(h.children.length, 0);
        assert.deepEqual(h.runner.snapshot(), { active: false, pending: 0, chargedBytes: 0, accepting: true,
            recoveryDebt: false, rescanRequired: !complete });
        assert.equal(h.runner.diagnostics().firstCause, null);
        fixture.setBeforeOpen(async () => {});
        fixture.processes.get(11)?.unreadable && (fixture.processes.get(11).unreadable = null);
        assert.equal((await run(h.runner)).status, 'removed');
    });
}
