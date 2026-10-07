import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createMarketplaceRepositoryRunner, repositoryWorkerEligible, REPOSITORY_QUEUE_LIMITS } from '../../cli/server/marketplaceRepositoryWorker.mjs';

const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
const operation = { action: 'install_repo', url: '../source.git', name: 'fixture', branch: 'fixture-branch' };
const operationBytes = Buffer.byteLength(JSON.stringify(operation));
async function expectSettledRejection(promise, code) {
    let rejected;
    promise.catch((error) => { rejected = error; });
    await flush();
    assert.equal(rejected?.code, code, 'the refused ticket must already be rejected, not left pending');
}

function harness(t, overrides = {}) {
    let elapsed = 0;
    const timers = new Map();
    let timerId = 0;
    const time = {
        now: () => 1_000_000 + elapsed, monotonic: () => elapsed,
        setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, at: elapsed + ms }); return id; },
        clearTimeout: (id) => timers.delete(id),
    };
    async function advance(ms) {
        const until = elapsed + ms;
        await flush();
        for (;;) {
            const next = [...timers].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            elapsed = next[1].at;
            timers.delete(next[0]);
            next[1].callback();
            await flush();
        }
        elapsed = until;
        await flush();
    }
    const children = [];
    const signals = [];
    let scans = 0;
    const router = { pid: process.pid, birth: '100', namespace: 'pid:[1]', uids: '1000:1000:1000:1000',
        state: 'S', parent: 1, group: process.pid, session: process.pid };
    const observer = {
        async scan() { scans += 1; return { complete: true, records: [router], members: [], writers: [] }; },
        async read(pid) {
            const child = children.find((entry) => entry.pid === pid && !entry.closed);
            if (!child) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            return { ...router, pid, birth: String(pid), group: pid, session: pid, parent: process.pid,
                exe: process.execPath, argv: [process.execPath, child.args[0]] };
        },
        async signal(record, name, options) {
            if (options?.isAllowed && !options.isAllowed()) return false;
            signals.push({ pid: record.pid, name, group: options?.group === true, at: elapsed });
            const child = children.find((entry) => entry.pid === record.pid);
            if (options?.group && child) { child.closed = true; child.emit('close', null, name); }
            return true;
        },
    };
    const runner = createMarketplaceRepositoryRunner({
        observer, time, resolveExecutable: async (value) => value,
        proveQuiescence: async () => ({ ok: true }),
        spawnProcess(executable, args, options) {
            const child = new EventEmitter();
            Object.assign(child, { executable, args, options, pid: 40_000 + children.length,
                connected: true, messages: [], stdout: { resume() {} }, stderr: { resume() {} },
                send(message, callback) { this.messages.push(message); callback?.(null); } });
            children.push(child);
            return child;
        },
        ...overrides,
    });
    const run = (options = {}) => {
        const promise = runner.run({ operation, rawBodyBytes: 20, cwd: '/invocation', workspaceRoot: '/workspace', ...options });
        promise.catch(() => {});
        return promise;
    };
    const message = (child, type, extra = {}) => child.emit('message', {
        type, operationId: child.options.env.PLOINKY_MARKETPLACE_REPOSITORY_OPERATION, ...extra,
    });
    async function hello(child) { message(child, 'hello', { pid: child.pid }); await flush(); }
    async function authorize(child) { message(child, 'authorize'); await flush(); }
    function terminal(child, envelope = { ok: true, result: { status: 'cloned' } }, { close = true } = {}) {
        message(child, 'barrier'); message(child, 'release-granted'); message(child, 'terminal', envelope);
        if (close) { child.closed = true; child.emit('close', 0, null); }
    }
    t.after(async () => { const closing = runner.shutdown(); await advance(8_000); await closing; });
    return { runner, run, children, signals, advance, hello, authorize, terminal, message, scans: () => scans, time, observer };
}

test('eligibility uses the canonical marker only on Linux and preserves marker errors', () => {
    let calls = 0;
    const insideBox = () => { calls += 1; return false; };
    assert.equal(repositoryWorkerEligible({ platform: 'darwin', insideBox }), false);
    assert.equal(calls, 0);
    assert.equal(repositoryWorkerEligible({ platform: 'linux', insideBox }), false);
    assert.equal(calls, 1);
    assert.equal(repositoryWorkerEligible({ platform: 'linux', insideBox: () => true }), true);
    assert.throws(() => repositoryWorkerEligible({ platform: 'linux', insideBox: () => {
        throw Object.assign(new Error('invalid marker'), { code: 'PLOINKY_BOX_MARKER_INVALID' });
    } }), { code: 'PLOINKY_BOX_MARKER_INVALID' });
});

test('seventeen simultaneous tickets serialize, reject the eighteenth and reuse count and byte reservations exactly once', async (t) => {
    const h = harness(t);
    const promises = Array.from({ length: 17 }, () => h.run());
    await flush();
    assert.equal(h.children.length, 1);
    assert.equal(h.runner.snapshot().pending, 16);
    assert.equal(h.runner.snapshot().chargedBytes, 17 * (20 + operationBytes));
    await expectSettledRejection(h.run(), 'marketplace_repository_busy');
    assert.equal(h.children.length, 1, 'rejected ticket never launches');
    for (let i = 0; i < promises.length; i += 1) {
        await h.hello(h.children[i]); await h.authorize(h.children[i]); h.terminal(h.children[i]);
        assert.equal((await promises[i]).status, 'cloned');
        await flush();
        assert.equal(h.children.length, Math.min(i + 2, promises.length));
    }
    assert.equal(h.runner.snapshot().chargedBytes, 0);
    assert.equal(h.runner.snapshot().pending, 0);
    const next = h.run(); await flush();
    await h.hello(h.children[17]); await h.authorize(h.children[17]); h.terminal(h.children[17]);
    await next;
    assert.equal(h.runner.snapshot().chargedBytes, 0);
});

test('the aggregate byte boundary admits exactly eight MiB and refuses one more byte without launch', async (t) => {
    const h = harness(t);
    const full = h.run({ rawBodyBytes: REPOSITORY_QUEUE_LIMITS.bytes - operationBytes });
    await flush();
    assert.equal(h.runner.snapshot().chargedBytes, REPOSITORY_QUEUE_LIMITS.bytes);
    await expectSettledRejection(h.run({ operation: {}, rawBodyBytes: 0 }), 'marketplace_repository_busy');
    await h.hello(h.children[0]); await h.authorize(h.children[0]); h.terminal(h.children[0]);
    await full;
    await expectSettledRejection(h.run({ rawBodyBytes: REPOSITORY_QUEUE_LIMITS.bytes - operationBytes + 1 }), 'marketplace_repository_busy');
    assert.equal(h.children.length, 1);
    assert.equal(h.runner.snapshot().chargedBytes, 0);
});

test('supervisor receives pinned workspace and original cwd; input travels only after verified ownership over IPC', async (t) => {
    const h = harness(t);
    const pending = h.run(); await flush();
    const [child] = h.children;
    assert.equal(child.options.cwd, '/invocation');
    assert.equal(child.options.env.PLOINKY_WORKSPACE_ROOT, '/workspace');
    assert.equal(child.options.shell, false);
    assert.equal(child.options.detached, true);
    assert.equal(child.args.length, 1);
    assert.equal(JSON.stringify(child.args).includes(operation.url), false);
    assert.deepEqual(child.messages, [], 'no ownership grant before hello/identity validation');
    await h.hello(child);
    const ownership = child.messages.find((entry) => entry.type === 'ownership');
    assert.deepEqual(ownership.operation, operation);
    assert.equal(ownership.coordinator.pid, child.pid);
    await h.authorize(child);
    h.terminal(child, undefined, { close: false });
    let settled = false; pending.then(() => { settled = true; }, () => {}); await flush();
    assert.equal(settled, false, 'terminal message alone cannot complete delivery');
    child.closed = true; child.emit('close', 0, null); await pending;
});

test('closed pending requests are removed once and admitted disconnects drain without cancelling', async (t) => {
    const h = harness(t);
    const response = new EventEmitter();
    const active = h.run({ response });
    const queuedResponse = new EventEmitter();
    const queued = h.run({ response: queuedResponse });
    queuedResponse.emit('close'); queuedResponse.emit('close');
    await assert.rejects(queued, { code: 'PLOINKY_MARKETPLACE_REPOSITORY_REQUEST_CLOSED' });
    assert.equal(h.runner.snapshot().pending, 0);
    assert.equal(h.runner.snapshot().chargedBytes, 20 + operationBytes);
    await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
    response.emit('close');
    assert.equal(h.children[0].messages.some((entry) => entry.type === 'cancel'), false);
    h.terminal(h.children[0]); await active;
    assert.equal(h.children.length, 1);
    assert.equal(h.runner.snapshot().chargedBytes, 0);
});

test('the original hardware-aware authorization is checked after acquisition and never after result publication', async (t) => {
    const h = harness(t);
    let revision = 1;
    const generation = 'same-generation';
    let calls = 0;
    const pending = h.run({ authorize: () => { calls += 1; assert.equal(generation, 'same-generation'); return revision === 1; } });
    await flush(); await h.hello(h.children[0]);
    assert.equal(calls, 0, 'no admission before worker acquisition');
    revision = 2;
    await h.authorize(h.children[0]);
    const reply = h.children[0].messages.find((entry) => entry.type === 'authorization');
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'EDGE_GENERATION_CHANGED');
    h.terminal(h.children[0], { ok: false, error: reply.error });
    await assert.rejects(pending, { code: 'EDGE_GENERATION_CHANGED' });
    assert.equal(calls, 1);
});

test('pending expiry proceeds during an admitted operation and equality at authorization refuses entry', async (t) => {
    const h = harness(t);
    const active = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
    const queued = h.run();
    await h.advance(600_000);
    await expectSettledRejection(queued, 'workspace_mutation_lock_timeout');
    assert.equal(h.children.length, 1, 'admitted work has no ordinary deadline');
    h.terminal(h.children[0]); await active;
    const late = h.run(); await flush(); await h.hello(h.children[1]);
    await h.advance(600_000); await h.authorize(h.children[1]);
    const reply = h.children[1].messages.find((entry) => entry.type === 'authorization');
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'workspace_mutation_lock_timeout');
    h.terminal(h.children[1], { ok: false, error: reply.error });
    await assert.rejects(late, { code: 'workspace_mutation_lock_timeout' });
    assert.equal(h.runner.snapshot().chargedBytes, 0);
});

test('shutdown owns final group KILL, waits for closure/proof and remembers recovery after active work closes', async (t) => {
    const h = harness(t);
    const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
    const shutdown = h.runner.shutdown();
    assert.equal(h.children[0].messages.at(-1).type, 'cancel');
    await h.advance(2_000);
    assert.deepEqual(h.signals, [{ pid: h.children[0].pid, name: 'SIGKILL', group: true, at: 2_000 }]);
    await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    assert.equal((await shutdown).ok, false);
    assert.equal(h.runner.snapshot().active, false);
    assert.equal(h.runner.snapshot().recoveryDebt, true);
    assert.equal((await h.runner.shutdown()).ok, false);
    await assert.rejects(h.run(), { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
});

test('an early terminal cannot succeed and closes queue admission', async (t) => {
    const h = harness(t);
    const pending = h.run(); await flush(); await h.hello(h.children[0]);
    h.message(h.children[0], 'terminal', { ok: true, result: { status: 'forged' } });
    await h.advance(8_000);
    await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    assert.equal(h.runner.snapshot().accepting, false);
});

test('a closed response starts no census or process, and closure before admission denies authorization', async (t) => {
    const h = harness(t);
    await assert.rejects(h.run({ response: { destroyed: true } }), { code: 'PLOINKY_MARKETPLACE_REPOSITORY_REQUEST_CLOSED' });
    assert.equal(h.scans(), 0);
    assert.equal(h.children.length, 0);
    const response = new EventEmitter();
    let authorizations = 0;
    const pending = h.run({ response, authorize: () => { authorizations += 1; return true; } });
    await flush(); await h.hello(h.children[0]);
    response.emit('close');
    await h.authorize(h.children[0]);
    const reply = h.children[0].messages.find((entry) => entry.type === 'authorization');
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'PLOINKY_MARKETPLACE_REPOSITORY_REQUEST_CLOSED');
    assert.equal(authorizations, 0);
    h.terminal(h.children[0], { ok: false, error: reply.error });
    await assert.rejects(pending, { code: 'PLOINKY_MARKETPLACE_REPOSITORY_REQUEST_CLOSED' });
    assert.equal(h.runner.snapshot().chargedBytes, 0);
});

test('ownership acknowledgement after expiry carries no operation and cannot grant admission', async (t) => {
    const h = harness(t);
    const pending = h.run(); await flush();
    await h.advance(600_000); await h.hello(h.children[0]);
    const ownership = h.children[0].messages.find((entry) => entry.type === 'ownership');
    assert.equal(ownership.operation, null);
    assert.equal(ownership.unusedError.code, 'workspace_mutation_lock_timeout');
    h.terminal(h.children[0], { ok: false, error: ownership.unusedError });
    await assert.rejects(pending, { code: 'workspace_mutation_lock_timeout' });
    assert.equal(h.runner.snapshot().recoveryDebt, false);
    assert.equal(h.runner.snapshot().chargedBytes, 0);
});

test('delayed authorization acknowledgement cannot renew the original admission deadline', async (t) => {
    const h = harness(t);
    let authorize;
    const permission = new Promise((resolve) => { authorize = resolve; });
    const pending = h.run({ authorize: () => permission }); await flush(); await h.hello(h.children[0]);
    h.message(h.children[0], 'authorize'); await flush();
    await h.advance(600_000);
    authorize(true); await flush();
    const reply = h.children[0].messages.find((entry) => entry.type === 'authorization');
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'workspace_mutation_lock_timeout');
    h.terminal(h.children[0], { ok: false, error: reply.error });
    await assert.rejects(pending, { code: 'workspace_mutation_lock_timeout' });
});

test('expiry during prelaunch identity preparation never spawns a child or charges a released ticket twice', async (t) => {
    let finishPreparation;
    const preparation = new Promise((resolve) => { finishPreparation = resolve; });
    const h = harness(t, { resolveExecutable: async (value) => { await preparation; return value; } });
    const pending = h.run(); await flush();
    await h.advance(600_000);
    finishPreparation(); await flush();
    await assert.rejects(pending, { code: 'workspace_mutation_lock_timeout' });
    assert.equal(h.children.length, 0);
    assert.equal(h.runner.snapshot().chargedBytes, 0);
    await h.advance(8_000);
    assert.equal(h.runner.snapshot().chargedBytes, 0);
});

for (const kind of ['wrong-operation', 'malformed-cohort', 'success-without-admission']) {
    test(`${kind} enters recovery without allowing a later mutation`, async (t) => {
        const h = harness(t);
        const pending = h.run(); await flush(); await h.hello(h.children[0]);
        if (kind === 'wrong-operation') h.message(h.children[0], 'authorize', { operationId: 'foreign-operation' });
        else if (kind === 'malformed-cohort') h.message(h.children[0], 'cohort', { members: [{}] });
        else h.terminal(h.children[0]);
        await h.advance(8_000);
        await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
        assert.equal(h.runner.snapshot().recoveryDebt, true);
        await assert.rejects(h.run(), { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
    });
}
