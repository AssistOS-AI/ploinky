import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { streamAdmittedUpload, __testables as admission } from '../../cli/server/handlers/uploadAdmission.js';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function rejectedAwait(t, operation, cancellation, { cleanupFails = false } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e3-rejection-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'old');
    const prepared = path.join(root, 'prepared');
    fs.writeFileSync(target, 'o');
    // The qualified runner is Linux; an unavailable fd inventory is a failed prerequisite.
    const fdCount = () => fs.readdirSync('/proc/self/fd').length;
    const initialFds = fdCount();
    const entered = deferred();
    const release = deferred();
    const completed = deferred();
    const counts = { success: 0, failure: 0 };
    const handles = [];
    const mocks = [];
    const req = new PassThrough();
    req.headers = { 'content-length': '1' };
    let now = 0;
    let timeout;
    const policy = { route: '/test', maxBytes: 8, maxFiles: 10, maxStorageBytes: 100, timeoutMs: 2000 };
    const rejectIo = async () => {
        entered.resolve();
        await release.promise;
        throw Object.assign(new Error('injected rejected filesystem await'), {
            code: ['open', 'prepare', 'rename'].includes(operation) ? 'ENOSPC' : 'EIO',
        });
    };
    const open = fs.promises.open;
    mocks.push(t.mock.method(fs.promises, 'open', async (...args) => {
        if (operation === 'open' && String(args[0]).includes('.ploinky-upload-')) return rejectIo();
        const handle = await open(...args);
        handles.push(handle);
        if (operation === 'chmod') handle.chmod = rejectIo;
        return handle;
    }));
    if (operation === 'target') {
        const lstat = fs.promises.lstat;
        mocks.push(t.mock.method(fs.promises, 'lstat', async (...args) =>
            args[0] === target ? rejectIo() : lstat(...args)));
    }
    if (operation === 'prepare') {
        const mkdir = fs.promises.mkdir;
        mocks.push(t.mock.method(fs.promises, 'mkdir', async (...args) =>
            args[0] === prepared ? rejectIo() : mkdir(...args)));
    }
    if (operation === 'rename') mocks.push(t.mock.method(fs.promises, 'rename', rejectIo));
    if (cleanupFails) {
        const unlink = fs.promises.unlink;
        mocks.push(t.mock.method(fs.promises, 'unlink', async (...args) => {
            if (String(args[0]).endsWith('.part')) {
                throw Object.assign(new Error('injected cleanup failure'), { code: 'EACCES' });
            }
            return unlink(...args);
        }));
    }
    try {
        const accepted = streamAdmittedUpload(req, {
            storageRoot: root, targetPath: target, policy, replaceExisting: true,
            timers: {
                now: () => now,
                setTimeout(callback) { timeout = callback; return 1; },
                clearTimeout() {},
            },
            ...(operation === 'prepare' ? { prepare: async check => {
                await fs.promises.mkdir(prepared);
                check();
            } } : {}),
            onSuccess: value => { counts.success += 1; completed.resolve({ ok: true, ...value }); },
            onFailure: error => { counts.failure += 1; completed.resolve({ ok: false, error }); },
        });
        if (operation === 'rename') {
            assert.equal((await accepted).accepted, true);
            req.end('x');
        }
        await entered.promise;
        if (cancellation === 'timeout') timeout();
        if (cancellation === 'abort') req.emit('aborted');
        if (cancellation === 'deadline') now = policy.timeoutMs;
        release.resolve();
        if (operation !== 'rename') assert.equal((await accepted).accepted, false);
        const result = await completed.promise;
        const cancellationWins = cancellation !== 'none' && operation !== 'rename';
        const expectedCode = cleanupFails ? 'upload_cleanup_failed'
            : cancellationWins ? (cancellation === 'abort' ? 'upload_aborted' : 'upload_timeout')
                : operation === 'target' ? 'storage_inventory_unavailable'
                    : operation === 'chmod' ? 'upload_write_failed' : 'upload_storage_full';
        const expectedStatus = cleanupFails ? 500
            : cancellationWins ? (cancellation === 'abort' ? 400 : 408)
                : operation === 'chmod' ? 500 : 507;
        assert.equal(result.ok, false);
        assert.equal(result.error.code, expectedCode);
        assert.equal(result.error.status, expectedStatus);
        assert.deepEqual(counts, { success: 0, failure: 1 });
        assert.ok(handles.every(handle => handle.fd === -1), 'all opened handles close before failure');
        assert.equal(fdCount(), initialFds);
        assert.equal(admission.activeByStorageRoot.has(root), false);
        assert.equal(admission.tailsByStorageRoot.has(root), false);
        assert.equal(req.listenerCount('data'), 0);
        assert.equal(fs.readFileSync(target, 'utf8'), 'o');
        if (!cleanupFails) assert.deepEqual(fs.readdirSync(root), ['old']);
        else assert.equal(fs.readdirSync(root).filter(name => name.endsWith('.part')).length, 1);
    } finally {
        release.resolve();
        mocks.reverse().forEach(mock => mock.mock.restore());
        req.destroy();
    }
    // A genuine unlink failure intentionally leaves its test-owned partial for fixture cleanup.
    const next = new PassThrough();
    next.headers = { 'content-length': '1' };
    const nextDone = deferred();
    assert.equal((await streamAdmittedUpload(next, {
        storageRoot: root, targetPath: path.join(root, 'successor'), policy,
        onSuccess: () => nextDone.resolve(true),
        onFailure: () => nextDone.resolve(false),
    })).accepted, true);
    next.end('x');
    assert.equal(await nextDone.promise, true);
    assert.equal(fs.readFileSync(path.join(root, 'successor'), 'utf8'), 'x');
    assert.equal(fdCount(), initialFds);
    assert.equal(admission.activeByStorageRoot.has(root), false);
    assert.equal(admission.tailsByStorageRoot.has(root), false);
    assert.deepEqual(counts, { success: 0, failure: 1 });
}

for (const operation of ['open', 'chmod', 'prepare', 'target']) {
    for (const cancellation of ['timeout', 'abort', 'deadline', 'none']) {
        test(`rejected ${operation} await preserves ${cancellation} precedence and releases ownership`,
            async t => rejectedAwait(t, operation, cancellation));
    }
}

for (const cancellation of ['timeout', 'abort', 'deadline']) {
    test(`rejected commit ignores ${cancellation} after the commit point`,
        async t => rejectedAwait(t, 'rename', cancellation));
}

test('genuine cleanup failure remains visible despite a latched abort',
    async t => rejectedAwait(t, 'chmod', 'abort', { cleanupFails: true }));
