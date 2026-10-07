import assert from 'node:assert/strict';
import test from 'node:test';
import { executeRepositoryTransaction, serializeRepositoryError } from '../../cli/server/marketplaceRepositoryWorkerThread.mjs';

function transactionFixture({ fail = false, expiredAcquisition = false } = {}) {
    const calls = [];
    const lease = { token: 'fixture-exact-lease' };
    let grantRelease;
    let enteredBarrier;
    const barrier = new Promise((resolve) => { enteredBarrier = resolve; });
    const release = new Promise((resolve) => { grantRelease = resolve; });
    const data = { operationId: '01234567-89ab-cdef-0123-456789abcdef', deadline: Date.now() + 60_000,
        operation: { action: 'install_repo', url: '../fixture.git', name: 'fixture', branch: 'branch' } };
    const dependencies = {
        send: (message) => calls.push(message.type),
        withLease: async (options, fn) => {
            assert.equal(options.requireQuiescenceOnOwnerDeath, true);
            assert.equal(options.operation, `marketplace-repository:${data.operationId}`);
            assert.ok(options.waitTimeoutMs > 0);
            calls.push('acquired');
            if (expiredAcquisition) data.deadline = Date.now();
            const result = await fn(lease);
            calls.push('released');
            return result;
        },
        assertLease: (actual) => { assert.equal(actual, lease); calls.push('assert'); return actual; },
        authorize: async () => { calls.push('authorized'); },
        settle: async () => { enteredBarrier(); await release; },
        install: (...args) => {
            calls.push('install');
            assert.deepEqual(args, ['../fixture.git', 'fixture', 'branch', { stdio: 'pipe' }]);
            if (fail) throw new Error('ordinary failure');
            return { status: 'cloned' };
        },
    };
    return { data, dependencies, calls, barrier, grantRelease, lease };
}

for (const fail of [false, true]) test(`service ${fail ? 'failure' : 'success'} stays inside its lease until settlement grants release`, async () => {
    const fixture = transactionFixture({ fail });
    const pending = executeRepositoryTransaction(fixture.data, fixture.dependencies);
    await fixture.barrier;
    assert.deepEqual(fixture.calls, ['acquired', 'lease', 'authorized', 'assert', 'install', 'barrier']);
    fixture.grantRelease();
    const result = await pending;
    assert.equal(result.ok, !fail);
    assert.equal(fixture.calls.at(-1), 'released');
});

test('late acquisition releases the unused lease without authorization or service entry', async () => {
    const fixture = transactionFixture({ expiredAcquisition: true });
    const pending = executeRepositoryTransaction(fixture.data, fixture.dependencies);
    await fixture.barrier;
    assert.deepEqual(fixture.calls, ['acquired', 'lease', 'barrier']);
    fixture.grantRelease();
    const result = await pending;
    assert.equal(result.error.code, 'workspace_mutation_lock_timeout');
    assert.equal(fixture.calls.at(-1), 'released');
});

test('deadline equality never calls the lease helper that attempts acquisition before its timeout check', async () => {
    const fixture = transactionFixture();
    fixture.data.deadline = Date.now();
    const pending = executeRepositoryTransaction(fixture.data, fixture.dependencies);
    await fixture.barrier;
    assert.deepEqual(fixture.calls, ['barrier']);
    fixture.grantRelease();
    assert.equal((await pending).error.code, 'workspace_mutation_lock_timeout');
});

test('uninstall reuses the exact outer lease, and delayed authorization expiry prevents target resolution', async () => {
    const fixture = transactionFixture();
    fixture.data.operation = { action: 'uninstall_repo', target: 'fixture' };
    let selected = 0;
    fixture.dependencies.uninstall = async (target, options) => {
        assert.equal(target, 'fixture');
        return options.withLease({}, (lease) => { assert.equal(lease, fixture.lease); selected += 1; return { status: 'removed' }; });
    };
    let pending = executeRepositoryTransaction(fixture.data, fixture.dependencies);
    await fixture.barrier;
    assert.equal(selected, 1);
    fixture.grantRelease();
    assert.equal((await pending).ok, true);

    const delayed = transactionFixture();
    delayed.dependencies.authorize = async () => { delayed.data.deadline = Date.now(); };
    pending = executeRepositoryTransaction(delayed.data, delayed.dependencies);
    await delayed.barrier;
    assert.equal(delayed.calls.includes('install'), false);
    delayed.grantRelease();
    assert.equal((await pending).error.code, 'workspace_mutation_lock_timeout');
});

test('errors preserve short typed fields and redact credentials without transporting stack or raw diagnostics', () => {
    const result = serializeRepositoryError(Object.assign(new Error('https://user:secret@example.test/repo?token=private Authorization: Bearer hidden'), {
        code: 'workspace_mutation_lock_timeout', status: 400, stderr: 'private', environment: { SECRET: 'private' },
    }));
    assert.equal(result.code, 'workspace_mutation_lock_timeout');
    assert.equal(result.status, 400);
    assert.doesNotMatch(result.message, /user:secret|private|hidden/);
    assert.deepEqual(Object.keys(result).sort(), ['code', 'message', 'status']);
});

test('contained preparation is inside the outer lease and before authorization, with expired units disposed before release', async () => {
    for (const refusal of ['none', 'expiry', 'authorization']) {
        const fixture = transactionFixture();
        fixture.dependencies.prepareInstall = async () => {
            fixture.calls.push('prepared');
            if (refusal === 'expiry') fixture.data.deadline = Date.now();
        };
        fixture.dependencies.disposeInstall = async () => { fixture.calls.push('disposed'); };
        if (refusal === 'authorization') fixture.dependencies.authorize = async () => {
            fixture.calls.push('authorized'); throw Error('generation changed');
        };
        const pending = executeRepositoryTransaction(fixture.data, fixture.dependencies);
        await fixture.barrier;
        assert.deepEqual(fixture.calls.slice(0, 3), ['acquired', 'lease', 'prepared']);
        if (refusal !== 'none') {
            assert.equal(fixture.calls.includes('install'), false);
            assert.equal(fixture.calls.at(-2), 'disposed');
        } else assert.ok(fixture.calls.indexOf('prepared') < fixture.calls.indexOf('authorized'));
        assert.equal(fixture.calls.includes('released'), false);
        fixture.grantRelease(); await pending;
        assert.equal(fixture.calls.at(-1), 'released');
    }
});
