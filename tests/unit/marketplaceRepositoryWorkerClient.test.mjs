import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsPromises from 'node:fs/promises';
import test from 'node:test';
import { createMarketplaceRepositoryRunner, repositoryWorkerEligible, REPOSITORY_QUEUE_LIMITS,
    runMarketplaceRepositoryWorker, shutdownMarketplaceRepositoryWorkers } from '../../cli/server/marketplaceRepositoryWorker.mjs';

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

test('incomplete baseline retains the first cause and re-emits it on a later rejection after initial log loss', async (t) => {
    const logs = [];
    const h = harness(t, { diagnosticSink: (_type, entry) => logs.push(entry) });
    h.observer.scan = async () => ({ complete: false, records: [], members: [], writers: [],
        diagnostic: { unknowns: [{ category: 'permission', field: 'namespace', errno: 'EACCES', count: 1 }] } });
    await assert.rejects(h.run({ diagnosticContext: { caller: 'agent-assertion', routeLease: true } }), { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
    assert.equal(h.children.length, 0);
    const first = h.runner.diagnostics().firstCause;
    assert.equal(first.phase, 'baseline');
    assert.equal(first.unknowns[0].field, 'namespace');
    assert.equal(first.caller, 'agent-assertion');
    logs.length = 0;
    await assert.rejects(h.run(), { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
    assert.equal(logs.length, 0);
    await h.advance(5000);
    await assert.rejects(h.run(), { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
    assert.deepEqual(logs[0].firstCause, first);
    assert.equal(h.runner.snapshot().chargedBytes, 0);
});

test('diagnostic faults and floods carry no authority; strict control errors still cancel under a stalled sink', async (t) => {
    const h = harness(t, { diagnosticSink: () => new Promise(() => {}) });
    const pending = h.run(); await flush();
    const [child] = h.children;
    for (let i = 0; i < 1000; i += 1) {
        h.message(child, 'diagnostic', { payload: { phase: 'ipc', reason: 'received', secret: 'SECRET_CANARY' } });
        h.message(child, 'diagnostic', { payload: { phase: 'observation', reason: 'incomplete' } });
    }
    await flush();
    assert.equal(child.messages.length, 0, 'diagnostics cannot grant ownership or admission');
    assert.equal(h.runner.snapshot().accepting, true);
    assert.equal(h.runner.diagnostics().recent.length, 32);
    assert.ok(h.runner.diagnostics().loss >= 1000);
    assert.doesNotMatch(JSON.stringify(h.runner.diagnostics()), /SECRET_CANARY/);
    h.message(child, 'terminal', { ok: true, result: {} });
    await h.advance(8000);
    await assert.rejects(pending, { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
    assert.equal(h.runner.diagnostics().firstCause.reason, 'protocol');
    assert.equal(h.runner.snapshot().chargedBytes, 0);
    const terminalState = h.runner.diagnostics();
    h.message(child, 'diagnostic', { payload: { phase: 'ipc', reason: 'received' } });
    assert.deepEqual(h.runner.diagnostics(), terminalState, 'finished tickets remain terminal');
});

for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    test(`diagnostic prototype key ${key} only records loss and preserves the live transaction`, async (t) => {
        const h = harness(t);
        const pending = h.run(); await flush();
        const [child] = h.children;
        const before = h.runner.snapshot();
        h.message(child, 'diagnostic', { payload: Object.fromEntries([[key, 'SECRET_CANARY']]) });
        h.message(child, 'diagnostic', { payload: { unknowns: [Object.fromEntries([[key, 'SECRET_CANARY']])] } });
        await flush();
        assert.deepEqual(h.runner.snapshot(), before);
        assert.equal(h.runner.diagnostics().loss, 2);
        assert.equal(h.runner.diagnostics().firstCause, null);
        assert.deepEqual(h.signals, []);
        assert.equal(child.messages.length, 0);
        assert.doesNotMatch(JSON.stringify(h.runner.diagnostics()), /SECRET_CANARY/);
        await h.hello(child); await h.authorize(child); h.terminal(child);
        assert.equal((await pending).status, 'cloned');
        assert.equal(h.runner.snapshot().accepting, true);
        assert.equal(h.runner.snapshot().chargedBytes, 0);
    });
}

test('wrong diagnostic operation identity cancels, and a pre-hello exit is distinct from an ownership mismatch', async (t) => {
    for (const mode of ['wrong-id', 'pre-hello', 'ownership']) {
        const h = harness(t, { diagnosticSink: () => { throw new Error('SECRET_CANARY'); } });
        const pending = h.run(); await flush();
        const [child] = h.children;
        if (mode === 'wrong-id') h.message(child, 'diagnostic', { operationId: 'wrong', payload: {} });
        else if (mode === 'pre-hello') child.emit('close', 0, null);
        else {
            const read = h.observer.read;
            h.observer.read = async (...args) => ({ ...await read(...args), exe: '/SECRET_CANARY' });
            await h.hello(child);
        }
        await h.advance(8000);
        await assert.rejects(pending, { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
        const cause = h.runner.diagnostics().firstCause;
        assert.equal(cause.reason, mode === 'wrong-id' ? 'protocol' : mode === 'pre-hello' ? 'pre-hello-exit' : 'mismatch');
        assert.doesNotMatch(JSON.stringify(h.runner.diagnostics()), /SECRET_CANARY/);
    }
});

test('supervisor cause survives secondary failures and a response close after cancellation settlement', async (t) => {
    const response = new EventEmitter();
    const h = harness(t);
    const pending = h.run({ response }); await flush();
    const [child] = h.children;
    await h.hello(child);
    h.message(child, 'diagnostic', { payload: { phase: 'release', reason: 'release-failed' } });
    h.message(child, 'recovery');
    h.message(child, 'invalid-control');
    child.emit('close', 1, 'SIGTERM');
    await h.advance(8000);
    await assert.rejects(pending, { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
    const first = h.runner.diagnostics().firstCause;
    assert.equal(first.source, 'supervisor');
    assert.equal(first.reason, 'release-failed');
    response.emit('close');
    assert.deepEqual(h.runner.diagnostics().firstCause, first);
    const closure = h.runner.diagnostics().recent.at(-1);
    assert.equal(closure.phase, 'closure');
    assert.equal(closure.state, 'cancelling');
    assert.equal(closure.closedAt, h.time.now());
});

test('normal admission expiry is observable without creating a first recovery cause', async (t) => {
    const h = harness(t);
    const active = h.run(); await flush();
    await h.hello(h.children[0]); await h.authorize(h.children[0]);
    const queued = h.run();
    await h.advance(REPOSITORY_QUEUE_LIMITS.admissionMs);
    await assert.rejects(queued, { code: 'workspace_mutation_lock_timeout' });
    assert.equal(h.runner.diagnostics().firstCause, null);
    assert.ok(h.runner.diagnostics().recent.some(entry => entry.reason === 'expired'));
    h.terminal(h.children[0]); await active;
});

test('shutdown cause and post-hello crash retain distinct reasons under unchanged cancellation deadlines', async (t) => {
    for (const mode of ['shutdown', 'crash']) {
        const h = harness(t);
        const pending = h.run(); await flush();
        await h.hello(h.children[0]); await h.authorize(h.children[0]);
        const closing = mode === 'shutdown' ? h.runner.shutdown() : null;
        if (mode === 'crash') h.children[0].emit('close', 1, null);
        await h.advance(8000);
        await assert.rejects(pending, { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED' });
        if (closing) assert.equal((await closing).ok, false);
        assert.equal(h.runner.diagnostics().firstCause.reason, mode === 'shutdown' ? 'shutdown' : 'abnormal-exit');
        assert.equal(h.runner.snapshot().chargedBytes, 0);
    }
});

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

test('exported shutdown before singleton creation permanently rejects admission without process observation', async (t) => {
    let observations = 0;
    t.mock.method(fsPromises, 'opendir', async () => { observations += 1; throw new Error('unexpected census'); });
    assert.deepEqual(await shutdownMarketplaceRepositoryWorkers(), { ok: true });
    const options = { operation, rawBodyBytes: 20, cwd: process.cwd(), workspaceRoot: process.cwd() };
    await expectSettledRejection(runMarketplaceRepositoryWorker(options), 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    await shutdownMarketplaceRepositoryWorkers();
    await expectSettledRejection(runMarketplaceRepositoryWorker(options), 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    assert.equal(observations, 0, 'shutdown cannot lazily create a fresh accepting observer/runner');
});

function sentinelRecord() {
    return { pid: 50_001, birth: '500010', namespace: 'pid:[1]', uids: '1000:1000:1000:1000',
        parent: 1, group: 50_001, session: 50_001, state: 'S' };
}

for (const kind of ['pre-ownership', 'identity-only', 'well-formed-foreign']) {
    test(`${kind} cohort claim cannot make an unrelated sentinel remembered or signalable`, async (t) => {
        const h = harness(t);
        const pending = h.run(); await flush();
        const child = h.children[0];
        if (kind !== 'pre-ownership') await h.hello(child);
        const sentinel = sentinelRecord();
        const claim = kind === 'identity-only'
            ? { pid: sentinel.pid, birth: sentinel.birth, namespace: sentinel.namespace, uids: sentinel.uids }
            : sentinel;
        const scans = [];
        const scan = h.observer.scan;
        h.observer.scan = async (options) => {
            scans.push({ remembered: [...(options?.remembered || [])], cancelling: child.messages.some((entry) => entry.type === 'cancel') });
            const observation = await scan(options);
            return { ...observation, records: [...observation.records, sentinel] };
        };
        h.message(child, 'cohort', { members: [claim] });
        await h.advance(8_000);
        await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
        assert.ok(scans.length > 0);
        assert.equal(scans.some((entry) => entry.remembered.some((record) => record.pid === sentinel.pid)), false,
            'an unproven IPC claim must never seed observer history');
        assert.equal(h.signals.some((entry) => entry.pid === sentinel.pid), false, 'the unrelated sentinel is never signaled');
        assert.equal(scans.filter((entry) => !entry.cancelling).length, kind === 'well-formed-foreign' ? 1 : 0,
            'early or incomplete records fail before ownership observation; a complete claim still needs corroboration');
    });
}

test('cohort fields must be complete and bounded before any claim can request ownership corroboration', async (t) => {
    for (const patch of [
        { parent: -1 }, { group: 0 }, { session: Number.MAX_SAFE_INTEGER }, { state: 'RUNNING' },
        { birth: '9'.repeat(21) }, { namespace: `pid:[${'9'.repeat(21)}]` },
        { uids: '4294967296:1000:1000:1000' }, { argv: ['unexpected-extra-field'] },
    ]) {
        const h = harness(t);
        const pending = h.run(); await flush(); await h.hello(h.children[0]);
        let preCancellationScans = 0;
        const scan = h.observer.scan;
        h.observer.scan = async (options) => {
            if (!h.children[0].messages.some((entry) => entry.type === 'cancel')) preCancellationScans += 1;
            return scan(options);
        };
        h.message(h.children[0], 'cohort', { members: [{ ...sentinelRecord(), ...patch }] });
        await h.advance(8_000);
        await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
        assert.equal(preCancellationScans, 0, JSON.stringify(patch));
        assert.equal(h.signals.some((entry) => entry.pid === 50_001), false);
    }
});

test('locally corroborated late cancellation members remain remembered after their visible ownership evidence disappears', async (t) => {
    const h = harness(t);
    const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
    const owned = sentinelRecord();
    let visible = false;
    const histories = [];
    const scan = h.observer.scan;
    h.observer.scan = async (options) => {
        histories.push([...(options?.remembered || [])]);
        const observation = await scan(options);
        return { ...observation, members: visible ? [owned] : [], writers: visible ? [owned] : [] };
    };
    const shutdown = h.runner.shutdown(); await flush();
    visible = true;
    h.message(h.children[0], 'cohort', { members: [owned] }); await flush();
    visible = false;
    await h.advance(8_000);
    await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    assert.equal((await shutdown).ok, false);
    assert.ok(histories.some((records) => records.some((entry) => entry.pid === owned.pid && entry.birth === owned.birth)),
        'Router-proven ownership remains part of its cancellation history');
    assert.ok(h.signals.some((entry) => entry.pid === owned.pid && entry.name === 'SIGKILL' && entry.group === false),
        'a legitimate late owned member is not lost when cancellation starts');
});

for (const corroborated of [false, true]) {
    test(`terminal and clean closure await ${corroborated ? 'valid' : 'failed'} delayed cohort corroboration before delivery or queue progress`, async (t) => {
        const h = harness(t);
        const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
        const queued = h.run();
        let outcome = 'pending';
        pending.then(() => { outcome = 'success'; }, () => { outcome = 'failure'; });
        const claim = sentinelRecord();
        let resolveObservation;
        const observation = new Promise((resolve) => { resolveObservation = resolve; });
        const scan = h.observer.scan;
        let deferred = false;
        h.observer.scan = async (options) => {
            if (!deferred) { deferred = true; return observation; }
            return scan(options);
        };
        h.message(h.children[0], 'cohort', { members: [claim] }); await flush();
        assert.equal(deferred, true, 'cohort validation reached its deferred observation');
        h.terminal(h.children[0]); await flush();
        assert.equal(outcome, 'pending', 'terminal and close cannot bypass pending ownership validation');
        assert.equal(h.runner.snapshot().active, true);
        assert.equal(h.runner.snapshot().pending, 1);
        assert.equal(h.children.length, 1, 'no later supervisor launches while validation is pending');
        resolveObservation({ complete: true, records: [claim], members: corroborated ? [claim] : [], writers: [] });
        await flush();
        if (corroborated) {
            assert.equal((await pending).status, 'cloned');
            assert.equal(outcome, 'success');
            assert.equal(h.children.length, 2, 'a validated result releases the queue slot');
            assert.equal(h.runner.snapshot().recoveryDebt, false);
            await h.hello(h.children[1]); await h.authorize(h.children[1]); h.terminal(h.children[1]);
            await queued;
        } else {
            await h.advance(8_000);
            await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
            await expectSettledRejection(queued, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
            assert.equal(outcome, 'failure');
            assert.equal(h.children.length, 1, 'failed corroboration never drains into a later launch');
            assert.equal(h.signals.some((entry) => entry.pid === claim.pid), false, 'unproven identity never gains signal authority');
            assert.equal(h.runner.snapshot().recoveryDebt, true);
        }
    });
}

test('a stalled cohort validation has a bounded deadline and cannot delay cancellation or turn closure into success', async (t) => {
    const h = harness(t);
    const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
    const scan = h.observer.scan;
    let deferred = false;
    h.observer.scan = async (options) => {
        if (!deferred) { deferred = true; return new Promise(() => {}); }
        return scan(options);
    };
    h.message(h.children[0], 'cohort', { members: [sentinelRecord()] });
    h.terminal(h.children[0]);
    await h.advance(1_000);
    assert.equal(h.runner.snapshot().accepting, false, 'the bounded validation deadline closes admission');
    const shutdown = h.runner.shutdown();
    await h.advance(8_000);
    await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    assert.equal((await shutdown).ok, false);
    assert.equal(h.runner.snapshot().active, false, 'cancellation does not await a stalled validation promise');
});

// Like the production observer, refuse a second census while outstanding I/O
// owns all eight reader slots. A timeout does not make those slots disappear.
function exclusiveObservations(h, { delayMs = 300, snapshot = () => ({ members: [], writers: [] }) } = {}) {
    const scan = h.observer.scan;
    const signal = h.observer.signal;
    const flights = [];
    const signalRecords = [];
    let busy = false;
    let overlappingScans = 0;
    let busySignalAttempts = 0;
    h.observer.scan = (options) => {
        if (busy) {
            overlappingScans += 1;
            return Promise.resolve({ complete: false, records: [], members: [], writers: [] });
        }
        busy = true;
        const captured = snapshot(options);
        let resolve;
        let reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        const flight = {
            at: h.time.monotonic(), history: [...(options?.remembered || [])], finished: false,
            async resolve(value = captured) {
                if (this.finished) return;
                this.finished = true;
                const base = await scan(options);
                busy = false;
                resolve({ ...base, ...value });
            },
            reject(error = new Error('late observation rejection')) {
                if (this.finished) return;
                this.finished = true; busy = false; reject(error);
            },
        };
        flights.push(flight);
        const wait = typeof delayMs === 'function' ? delayMs(flights.length) : delayMs;
        if (wait !== null) h.time.setTimeout(() => { void flight.resolve(); }, wait);
        return promise;
    };
    h.observer.signal = async (record, name, options) => {
        if (busy) { busySignalAttempts += 1; return false; }
        signalRecords.push({ ...record });
        return signal(record, name, options);
    };
    return { flights, signalRecords, overlappingScans: () => overlappingScans,
        busySignalAttempts: () => busySignalAttempts, busy: () => busy };
}

function anotherRecord(pid) {
    return { ...sentinelRecord(), pid, birth: String(pid * 10), group: pid, session: pid };
}

test('cumulative valid frames every 100ms share one production-exclusive 300ms census', async (t) => {
    const h = harness(t);
    const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
    const owned = sentinelRecord();
    const observations = exclusiveObservations(h, { snapshot: () => ({ members: [owned], writers: [] }) });
    h.message(h.children[0], 'cohort', { members: [owned] });
    await h.advance(100); h.message(h.children[0], 'cohort', { members: [owned] });
    await h.advance(100); h.message(h.children[0], 'cohort', { members: [owned] });
    h.terminal(h.children[0]);
    await h.advance(100);
    assert.equal(observations.overlappingScans(), 0, 'cumulative frames share the production-exclusive census');
    assert.equal(observations.flights.length, 1, 'duplicates create no jobs');
    assert.equal(h.runner.snapshot().recoveryDebt, false);
    assert.equal((await pending).status, 'cloned');
});

test('absence of a later claim waits for a subsequent serialized pass within its first-arrival deadline', async (t) => {
    const h = harness(t);
    const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
    const a = sentinelRecord(); const b = anotherRecord(50_002);
    let visible = [a];
    const observations = exclusiveObservations(h, { snapshot: () => ({ members: [...visible], writers: [] }) });
    h.message(h.children[0], 'cohort', { members: [a] });
    await h.advance(100); visible = [a, b]; h.message(h.children[0], 'cohort', { members: [a, b] });
    h.terminal(h.children[0]);
    await h.advance(200);
    assert.equal(h.runner.snapshot().accepting, true, 'earlier-pass absence does not reject a later arrival');
    assert.equal(observations.flights.length, 2);
    assert.deepEqual(observations.flights.map((entry) => entry.at), [0, 300]);
    await h.advance(300);
    assert.equal(observations.overlappingScans(), 0);
    assert.equal((await pending).status, 'cloned');
});

test('a foreign first claim cannot disappear when a later cumulative frame omits it', async (t) => {
    const h = harness(t);
    const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
    const queued = h.run();
    const owned = sentinelRecord(); const foreign = anotherRecord(50_003);
    const observations = exclusiveObservations(h, { snapshot: () => ({ members: [owned], writers: [] }) });
    h.message(h.children[0], 'cohort', { members: [owned, foreign] });
    await h.advance(100); h.message(h.children[0], 'cohort', { members: [owned] });
    h.terminal(h.children[0]);
    await h.advance(200);
    assert.equal(h.runner.snapshot().accepting, false, 'an omitted earlier ownership obligation still fails');
    await h.advance(8_000);
    await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    await expectSettledRejection(queued, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    assert.equal(h.children.length, 1);
    assert.equal(h.signals.some((entry) => entry.pid === foreign.pid), false);
    assert.equal(observations.overlappingScans(), 0);
});

test('duplicates do not renew a claim deadline while it waits behind an earlier observation', async (t) => {
    const h = harness(t);
    const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
    const a = sentinelRecord(); const b = anotherRecord(50_002);
    let visible = [a];
    const observations = exclusiveObservations(h, { delayMs: (index) => index === 1 ? 900 : 300,
        snapshot: () => ({ members: [...visible], writers: [] }) });
    h.message(h.children[0], 'cohort', { members: [a] });
    for (let tick = 1; tick <= 10; tick += 1) {
        await h.advance(100); visible = [a, b]; h.message(h.children[0], 'cohort', { members: [b] });
    }
    h.terminal(h.children[0]);
    await h.advance(100);
    assert.equal(h.runner.snapshot().accepting, false, 'B expires at first arrival 100ms plus 1s, despite duplicates');
    assert.deepEqual(observations.flights.map((entry) => entry.at), [0, 900]);
    await h.advance(8_000);
    await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    assert.equal(observations.overlappingScans(), 0);
});

test('the incremental proven-plus-pending identity union is bounded without evicting earlier claims', async (t) => {
    const h = harness(t);
    const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
    const owned = sentinelRecord();
    const scan = h.observer.scan;
    h.observer.scan = async (options) => ({ ...await scan(options), members: [owned], writers: [] });
    h.message(h.children[0], 'cohort', { members: [owned] }); await flush();
    const observations = exclusiveObservations(h, { delayMs: null });
    const claims = Array.from({ length: 8_192 }, (_, index) => anotherRecord(60_000 + index));
    h.message(h.children[0], 'cohort', { members: claims.slice(0, 4_096) });
    h.message(h.children[0], 'cohort', { members: claims.slice(4_096, 8_191) });
    assert.equal(h.runner.snapshot().accepting, true, 'one proven plus 8191 pending identities fits');
    assert.equal(observations.flights.length, 1);
    h.message(h.children[0], 'cohort', { members: claims.slice(8_191) });
    assert.equal(h.runner.snapshot().accepting, false, 'the 8193rd distinct identity refuses without eviction');
    await observations.flights[0].resolve(); await h.advance(8_000);
    await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    assert.equal(h.signals.some((entry) => entry.pid >= 60_000), false, 'unproved overflow claims never become history');
});

test('cancellation joins a 300ms census, observes late members serially and reserves KILL plus two fresh post-close passes', async (t) => {
    let proofs = 0;
    const h = harness(t, { proveQuiescence: async (view, options) => {
        proofs += 1;
        const first = await view.scan(options);
        await new Promise((resolve) => h.time.setTimeout(resolve, 25));
        const second = await view.scan(options);
        return { ok: first.complete && second.complete && !first.writers.length && !second.writers.length };
    } });
    const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
    const a = sentinelRecord(); const b = anotherRecord(50_002);
    let visible = [a];
    const observations = exclusiveObservations(h, { snapshot: () => ({ members: [...visible], writers: [] }) });
    h.message(h.children[0], 'cohort', { members: [a] });
    await h.advance(100);
    const shutdown = h.runner.shutdown();
    visible = [a, b]; h.message(h.children[0], 'cohort', { members: [b] });
    assert.equal(observations.flights.length, 1, 'shutdown and late frames join existing census');
    await h.advance(500);
    visible = [];
    h.message(h.children[0], 'cohort', { members: [{ ...b, parent: 123, group: 123, session: 123 }] });
    await h.advance(1_500);
    assert.ok(h.signals.some((entry) => entry.group && entry.name === 'SIGKILL' && entry.at === 2_100));
    assert.equal(observations.busySignalAttempts(), 0, 'healthy scans never overlap signal reads');
    assert.equal(observations.signalRecords.find((entry) => entry.pid === b.pid)?.group, b.group,
        'peer topology cannot overwrite Router-proven history');
    await h.advance(1_000);
    await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    assert.equal((await shutdown).ok, false);
    assert.equal(proofs, 1);
    assert.equal(observations.overlappingScans(), 0);
    assert.ok(observations.flights.slice(-2).every((entry) => entry.at > 2_100), 'quiescence uses two fresh post-close censuses');
});

for (const ending of ['resolve', 'reject']) {
    test(`a still-busy expired flight cannot regain authority on late ${ending} after bounded cancellation`, async (t) => {
        let proofCalls = 0;
        const h = harness(t, { proveQuiescence: async () => { proofCalls += 1; return { ok: true }; } });
        const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
        const observations = exclusiveObservations(h, { delayMs: null });
        h.message(h.children[0], 'cohort', { members: [sentinelRecord()] });
        await h.advance(1_000);
        assert.equal(h.runner.snapshot().accepting, false);
        await h.advance(8_000);
        await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
        assert.equal(h.runner.snapshot().active, false, 'underlying busy I/O cannot extend the cleanup deadline');
        assert.equal(observations.flights.length, 1, 'uncertainty does not start replacement/busy-loop scans');
        assert.equal(observations.overlappingScans(), 0);
        const signals = h.signals.length;
        let identityReads = 0;
        const late = new Proxy(sentinelRecord(), { get(target, key) { identityReads += 1; return target[key]; } });
        if (ending === 'resolve') await observations.flights[0].resolve({ members: [late], writers: [] });
        else observations.flights[0].reject();
        await flush(); await h.advance(1_000);
        assert.equal(identityReads, 0, 'a late result is not read into authority/history');
        assert.equal(h.signals.length, signals);
        assert.equal(proofCalls, 0);
        assert.equal(h.children.length, 1);
        assert.equal(h.runner.snapshot().recoveryDebt, true);
    });
}

for (const corroborated of [false, true]) {
    test(`ordinary error delivery also waits for ${corroborated ? 'valid' : 'failed'} cohort corroboration`, async (t) => {
        const h = harness(t);
        const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
        let outcome = 'pending';
        pending.then(() => { outcome = 'success'; }, (error) => { outcome = error.code; });
        const owned = sentinelRecord();
        const observations = exclusiveObservations(h, { snapshot: () => ({ members: corroborated ? [owned] : [], writers: [] }) });
        h.message(h.children[0], 'cohort', { members: [owned] });
        h.terminal(h.children[0], { ok: false, error: { code: 'ORDINARY_FIXTURE_ERROR', message: 'ordinary failure' } });
        await flush();
        assert.equal(outcome, 'pending', 'ordinary errors also wait for ownership validation');
        await h.advance(300);
        if (!corroborated) await h.advance(8_000);
        await expectSettledRejection(pending, corroborated ? 'ORDINARY_FIXTURE_ERROR' : 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
        assert.equal(observations.overlappingScans(), 0);
    });
}

test('a timely pass may positively prove a later-arriving claim without an unnecessary second census', async (t) => {
    const h = harness(t);
    const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
    const a = sentinelRecord(); const b = anotherRecord(50_002);
    const observations = exclusiveObservations(h, { snapshot: () => ({ members: [a, b], writers: [] }) });
    h.message(h.children[0], 'cohort', { members: [a] });
    await h.advance(100); h.message(h.children[0], 'cohort', { members: [b] });
    h.terminal(h.children[0]); await h.advance(200);
    assert.equal(observations.flights.length, 1);
    assert.equal((await pending).status, 'cloned');
});

test('an incomplete observation can preserve positive cleanup identities but never complete an operation', async (t) => {
    const h = harness(t);
    const pending = h.run(); await flush(); await h.hello(h.children[0]); await h.authorize(h.children[0]);
    const owned = sentinelRecord();
    const observations = exclusiveObservations(h, { snapshot: () => ({ complete: false, members: [owned], writers: [] }) });
    h.message(h.children[0], 'cohort', { members: [owned] }); h.terminal(h.children[0]);
    await h.advance(300);
    assert.equal(h.runner.snapshot().accepting, false, 'partial positive evidence cannot make an incomplete pass successful');
    h.message(h.children[0], 'cohort', { members: [owned] });
    await h.advance(8_000);
    await expectSettledRejection(pending, 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED');
    assert.ok(h.signals.some((entry) => entry.pid === owned.pid && entry.name === 'SIGKILL'));
    assert.equal(h.runner.snapshot().recoveryDebt, true, 'later frames cannot erase the failed observation');
    assert.equal(observations.flights.length, 1, 'unknown results do not create busy-loop scans');
});
