import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import {
    streamAdmittedUpload, UploadAdmissionError, __testables as admission,
} from '../../cli/server/handlers/uploadAdmission.js';
import { handleWorkspaceUpload, handleBlobs } from '../../cli/server/handlers/blobs.js';
import { handleWebchatUploadPost } from '../../cli/server/handlers/webchat/uploads.js';

const policy = { route: '/test', maxBytes: 8, maxFiles: 10, maxStorageBytes: 100, timeoutMs: 2000 };
function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e3-admission-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function upload(root, name, options = {}) {
    const req = options.req || new PassThrough();
    req.headers ||= { 'content-length': '1' };
    const done = deferred();
    const counts = { success: 0, failure: 0 };
    const accepted = streamAdmittedUpload(req, {
        storageRoot: root, targetPath: path.join(root, name), policy, ...options,
        onSuccess: value => { counts.success += 1; done.resolve({ ok: true, ...value }); },
        onFailure: error => { counts.failure += 1; done.resolve({ ok: false, error }); },
    });
    return { req, accepted, done: done.promise, counts };
}
function manualTimers() {
    let fire;
    return {
        api: { now: () => 0, setTimeout: fn => { fire = fn; return 1; }, clearTimeout() {} },
        fire: () => fire(),
    };
}
function assertEmptyState(root) {
    assert.equal(admission.activeByStorageRoot.has(root), false);
    assert.equal(admission.tailsByStorageRoot.has(root), false);
    assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.part')), []);
}

test('twenty open bodies reserve exactly ten slots and reject ten at reservation time', async t => {
    const root = fixture(t);
    const original = fs.promises.readdir;
    t.mock.method(fs.promises, 'readdir', async (...args) => {
        await delay(50);
        return original(...args);
    });
    const uploads = Array.from({ length: 20 }, (_, i) => upload(root, `file-${i}`, {
        policy: { ...policy, timeoutMs: 10000 },
    }));
    const results = await Promise.all(uploads.map(item => item.accepted));
    assert.equal(results.filter(result => result.accepted).length, 10);
    assert.equal(uploads.every(item => !item.req.writableEnded), true);
    for (let i = 10; i < 20; i += 1) {
        const result = await uploads[i].done;
        assert.equal(result.error.status, 507);
        assert.equal(result.error.code, 'upload_count_quota_exceeded');
        uploads[i].req.destroy();
    }
    for (let i = 0; i < 10; i += 1) uploads[i].req.end('x');
    assert.equal((await Promise.all(uploads.slice(0, 10).map(item => item.done))).every(r => r.ok), true);
    assert.equal(fs.readdirSync(root).length, 10);
    assertEmptyState(root);
});

test('same-target open bodies have one winner and every other reservation is busy', async t => {
    const root = fixture(t);
    const uploads = Array.from({ length: 8 }, () => upload(root, 'same'));
    const accepted = await Promise.all(uploads.map(item => item.accepted));
    assert.equal(accepted.filter(result => result.accepted).length, 1);
    for (const item of uploads.slice(1)) {
        assert.equal((await item.done).error.code, 'upload_target_busy');
        item.req.destroy();
    }
    uploads[0].req.end('x');
    assert.equal((await uploads[0].done).ok, true);
    assertEmptyState(root);
});

test('an empty active Set removed during a scan is re-read before adding the next reservation', async t => {
    const root = fixture(t);
    const first = upload(root, 'first');
    await first.accepted;
    const entered = deferred();
    const release = deferred();
    const original = fs.promises.readdir;
    let blocked = false;
    t.mock.method(fs.promises, 'readdir', async (...args) => {
        if (!blocked) {
            blocked = true;
            entered.resolve();
            await release.promise;
        }
        return original(...args);
    });
    const second = upload(root, 'second');
    await entered.promise;
    // Model an abort releasing the final member while the next inventory is suspended.
    const firstReservation = [...admission.activeByStorageRoot.get(root)][0];
    admission.activeByStorageRoot.delete(root);
    release.resolve();
    assert.equal((await second.accepted).accepted, true);
    assert.equal(admission.activeByStorageRoot.get(root).size, 1);
    assert.equal([...admission.activeByStorageRoot.get(root)][0].targetPath, path.join(root, 'second'));
    // Restore the first reservation for its normal cleanup.
    admission.activeByStorageRoot.get(root).add(firstReservation);
    first.req.emit('aborted');
    second.req.emit('aborted');
    await Promise.all([first.done, second.done]);
    assertEmptyState(root);
});

test('queued abort, queued timeout and destroyed entry leave no reservation or partial', async t => {
    for (const reason of ['abort', 'timeout', 'destroyed']) {
        const root = fixture(t);
        const gate = deferred();
        const holding = admission.withStorageRootLock(root, () => gate.promise);
        const timers = manualTimers();
        const req = new PassThrough();
        req.headers = { 'content-length': '1' };
        if (reason === 'destroyed') req.destroy();
        const item = upload(root, 'new', { req, timers: timers.api });
        if (reason === 'abort') req.emit('aborted');
        if (reason === 'timeout') timers.fire();
        gate.resolve();
        await holding;
        assert.equal((await item.accepted).accepted, false);
        assert.equal((await item.done).error.code, reason === 'timeout' ? 'upload_timeout' : 'upload_aborted');
        assertEmptyState(root);
        assert.deepEqual(fs.readdirSync(root), []);
        const next = upload(root, 'next');
        await next.accepted;
        next.req.end('x');
        assert.equal((await next.done).ok, true);
    }
});

test('abort checks cover reservation realpath, target lstat, inventory, open and chmod awaits', async t => {
    for (const operation of ['realpath', 'lstat', 'readdir', 'open', 'chmod']) {
        const root = fixture(t);
        fs.writeFileSync(path.join(root, 'old'), 'o');
        const req = new PassThrough();
        req.headers = { 'content-length': '1' };
        const original = fs.promises[operation === 'chmod' ? 'open' : operation];
        const name = operation === 'chmod' ? 'open' : operation;
        let injected = false;
        const mock = t.mock.method(fs.promises, name, async (...args) => {
            const result = await original(...args);
            if (operation === 'chmod') {
                const chmod = result.chmod.bind(result);
                result.chmod = async (...mode) => {
                    await chmod(...mode);
                    req.destroy();
                };
            } else if (!injected) {
                injected = true;
                req.destroy();
            }
            return result;
        });
        const item = upload(root, 'old', { req, replaceExisting: true });
        assert.equal((await item.accepted).accepted, false, operation);
        assert.equal((await item.done).error.code, 'upload_aborted', operation);
        assert.equal(fs.readFileSync(path.join(root, 'old'), 'utf8'), 'o');
        assertEmptyState(root);
        mock.mock.restore();
    }
});

test('timeouts in reservation and pre-commit final inventory never commit or call success', async t => {
    for (const phase of ['reservation', 'finalization']) {
        const root = fixture(t);
        fs.writeFileSync(path.join(root, 'old'), 'o');
        const timers = manualTimers();
        const original = fs.promises.readdir;
        let calls = 0;
        const mock = t.mock.method(fs.promises, 'readdir', async (...args) => {
            const result = await original(...args);
            calls += 1;
            if (calls === (phase === 'reservation' ? 1 : 2)) timers.fire();
            return result;
        });
        const item = upload(root, 'old', { replaceExisting: true, timers: timers.api });
        const accepted = await item.accepted;
        if (accepted.accepted) item.req.end('x');
        assert.equal((await item.done).error.code, 'upload_timeout');
        assert.deepEqual(item.counts, { success: 0, failure: 1 });
        assert.equal(fs.readFileSync(path.join(root, 'old'), 'utf8'), 'o');
        assertEmptyState(root);
        mock.mock.restore();
    }
});

test('timeout and reset during atomic commit cannot produce failure after successful replacement', async t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'old'), 'o');
    const timers = manualTimers();
    const original = fs.promises.rename;
    let item;
    t.mock.method(fs.promises, 'rename', async (...args) => {
        await original(...args);
        timers.fire();
        item.req.emit('aborted');
    });
    item = upload(root, 'old', { replaceExisting: true, timers: timers.api });
    await item.accepted;
    item.req.end('x');
    assert.equal((await item.done).ok, true);
    assert.deepEqual(item.counts, { success: 1, failure: 0 });
    assert.equal(fs.readFileSync(path.join(root, 'old'), 'utf8'), 'x');
    assertEmptyState(root);
});

test('throwing lock section has a nonrejecting tail, removes its key and allows a successor', async t => {
    const root = fixture(t);
    const unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    await assert.rejects(admission.withStorageRootLock(root, () => { throw new Error('section'); }), /section/);
    await delay(0);
    assert.deepEqual(unhandled, []);
    assertEmptyState(root);
    const item = upload(root, 'next');
    await item.accepted;
    item.req.end('x');
    assert.equal((await item.done).ok, true);
});

test('response callback exceptions never reject admission or produce a second callback', async t => {
    const root = fixture(t);
    let successes = 0;
    let failures = 0;
    const called = deferred();
    const req = new PassThrough();
    req.headers = { 'content-length': '1' };
    const result = await streamAdmittedUpload(req, {
        storageRoot: root, targetPath: path.join(root, 'callback'), policy,
        onSuccess: async () => {
            successes += 1;
            called.resolve();
            throw Object.assign(new Error('headers already sent'), { code: 'ERR_HTTP_HEADERS_SENT' });
        },
        onFailure: () => { failures += 1; },
    });
    assert.equal(result.accepted, true);
    req.end('x');
    await called.promise;
    await delay(0);
    assert.equal(successes, 1);
    assert.equal(failures, 0);
    assertEmptyState(root);
    const invalid = new PassThrough();
    invalid.headers = { 'content-length': '99' };
    const rejected = await streamAdmittedUpload(invalid, {
        storageRoot: root, targetPath: path.join(root, 'invalid'), policy,
        onFailure: async () => { throw new Error('failure response closed'); },
    });
    assert.equal(rejected.accepted, false);
    assertEmptyState(root);
});

test('entry timer covers async preparation and an abort during mkdir never opens a partial', async t => {
    for (const failure of ['timeout', 'abort']) {
        const root = fixture(t);
        const entered = deferred();
        const release = deferred();
        const timers = manualTimers();
        const req = new PassThrough();
        req.headers = { 'content-length': '1' };
        const item = upload(root, 'child/target', {
            req, timers: timers.api,
            prepare: async check => {
                entered.resolve();
                await release.promise;
                check();
                await fs.promises.mkdir(path.join(root, 'child'));
                check();
            },
        });
        if (failure === 'timeout') timers.fire();
        else {
            await entered.promise;
            req.destroy();
        }
        release.resolve();
        assert.equal((await item.accepted).accepted, false);
        assert.equal((await item.done).error.code, failure === 'timeout' ? 'upload_timeout' : 'upload_aborted');
        assert.deepEqual(fs.readdirSync(root), []);
        assertEmptyState(root);
    }
});

test('changed target and link EEXIST preserve an external writer and remove only owned partials', async t => {
    for (const phase of ['before-check', 'at-link']) {
        const root = fixture(t);
        const item = upload(root, 'target');
        await item.accepted;
        const original = fs.promises.link;
        let mock;
        if (phase === 'before-check') fs.writeFileSync(path.join(root, 'target'), 'external');
        else mock = t.mock.method(fs.promises, 'link', async (...args) => {
            fs.writeFileSync(args[1], 'external');
            return original(...args);
        });
        item.req.end('x');
        assert.equal((await item.done).error.code, 'upload_target_changed');
        assert.equal(fs.readFileSync(path.join(root, 'target'), 'utf8'), 'external');
        assert.deepEqual(fs.readdirSync(root), ['target']);
        assertEmptyState(root);
        mock?.mock.restore();
    }
});

test('replacement detects another writer changing the target during final inventory', async t => {
    const root = fixture(t);
    const target = path.join(root, 'target');
    fs.writeFileSync(target, 'o');
    const item = upload(root, 'target', { replaceExisting: true });
    await item.accepted;
    const original = fs.promises.readdir;
    let changed = false;
    t.mock.method(fs.promises, 'readdir', async (...args) => {
        const result = await original(...args);
        if (!changed) {
            changed = true;
            fs.writeFileSync(target, 'external');
        }
        return result;
    });
    item.req.end('x');
    assert.equal((await item.done).error.code, 'upload_target_changed');
    assert.equal(fs.readFileSync(target, 'utf8'), 'external');
    assertEmptyState(root);
});

test('inventory parity preserves ordered early quota errors, ignored files and LIFO directories', async t => {
    for (let seed = 1; seed <= 3; seed += 1) {
        const root = fixture(t);
        for (let i = 0; i < 24; i += 1) {
            const dir = path.join(root, `dir-${(i * seed) % 7}`);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `file-${i}`), 'x'.repeat((i * seed) % 9));
        }
        fs.symlinkSync('dir-0', path.join(root, 'link'));
        const options = { ignoredPaths: new Set([path.join(root, 'link')]),
            includeEntry: ({ relativePath }) => !relativePath.endsWith('1'),
            includeDirectory: ({ relativePath }) => relativePath !== 'dir-2' };
        assert.deepEqual(await admission.inspectStorageAsync(root, options), admission.inspectStorage(root, options));
    }
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'a'), 'xx');
    fs.writeFileSync(path.join(root, 'b'), 'xx');
    fs.writeFileSync(path.join(root, 'z'), 'x');
    const sync = fs.lstatSync;
    const asyncStat = fs.promises.lstat;
    t.mock.method(fs, 'lstatSync', (entry, ...args) => {
        if (entry === path.join(root, 'z')) throw Object.assign(new Error('late'), { code: 'EACCES' });
        return sync(entry, ...args);
    });
    t.mock.method(fs.promises, 'lstat', async (entry, ...args) => {
        if (entry === path.join(root, 'z')) throw Object.assign(new Error('late'), { code: 'EACCES' });
        return asyncStat(entry, ...args);
    });
    for (const quota of [{ maxFiles: 1, maxStorageBytes: 99 }, { maxFiles: 9, maxStorageBytes: 1 }]) {
        let expected;
        try { admission.inspectStorage(root, { policy: quota }); } catch (error) { expected = error.code; }
        await assert.rejects(admission.inspectStorageAsync(root, { policy: quota }),
            error => error.code === expected);
    }
    await assert.rejects(admission.inspectStorageAsync(root), { code: 'storage_inventory_unavailable' });
});

class Response extends Writable {
    constructor() { super(); this.chunks = []; this.headersSent = false; }
    _write(chunk, encoding, callback) { this.chunks.push(chunk); callback(); }
    writeHead(status) { this.statusCode = status; this.headersSent = true; }
}
function routeRequest() {
    const req = new PassThrough();
    req.method = 'POST';
    req.headers = { 'content-length': '1', 'x-file-name': 'target' };
    return req;
}
test('workspace and WebChat root spellings collide on one canonical busy target', async t => {
    const root = fixture(t);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(root, alias);
    const first = routeRequest();
    first.url = '/upload?path=target';
    const firstRes = new Response();
    const firstDone = new Promise(resolve => firstRes.once('finish', resolve));
    const admitted = handleWorkspaceUpload(first, firstRes, { workspaceRoot: alias });
    const second = routeRequest();
    const secondRes = new Response();
    const secondDone = new Promise(resolve => secondRes.once('finish', resolve));
    await handleWebchatUploadPost(second, secondRes, null, {
        workspaceRoot: root, cwd: root, uploadRoot: root,
    }, { policy });
    await secondDone;
    assert.equal(secondRes.statusCode, 409);
    assert.match(Buffer.concat(secondRes.chunks).toString(), /upload_target_busy/);
    await admitted;
    first.end('x');
    await firstDone;
    assert.equal(firstRes.statusCode, 200);
    second.destroy();
});

test('missing blob root preparation is covered by the entry timer before any mkdir', async t => {
    const root = fixture(t);
    const blobsDir = path.join(root, 'missing', 'blobs');
    const timers = manualTimers();
    const req = routeRequest();
    req.url = '/blobs';
    const res = new Response();
    const finished = new Promise(resolve => res.once('finish', resolve));
    let lstats = 0;
    let nativeRealpaths = 0;
    const lstat = fs.lstatSync;
    const native = fs.realpathSync.native;
    const statMock = t.mock.method(fs, 'lstatSync', (...args) => { lstats += 1; return lstat(...args); });
    const realMock = t.mock.method(fs.realpathSync, 'native', (...args) => {
        nativeRealpaths += 1;
        return native(...args);
    });
    const admissionPromise = handleBlobs(req, res, {
        timers: timers.api, policy,
        sharedRecordResolver: () => ({ ok: true, agent: {
            blobsDir, canonicalName: 'shared', isShared: true,
        } }),
    });
    timers.fire();
    await admissionPromise;
    await finished;
    statMock.mock.restore();
    realMock.mock.restore();
    assert.equal(lstats, 4, 'two missing components, existing ancestor, canonical ancestor identity');
    assert.equal(nativeRealpaths, 1);
    assert.equal(res.statusCode, 408);
    assert.equal(Buffer.concat(res.chunks).toString(), 'upload_timeout');
    assert.deepEqual(fs.readdirSync(root), []);
});

test('missing and then existing canonical roots share a single busy reservation key', async t => {
    const root = fixture(t);
    const real = path.join(root, 'real');
    fs.mkdirSync(real);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(real, alias);
    const firstRoot = path.join(alias, 'new');
    const canonicalRoot = path.join(real, 'new');
    const created = deferred();
    const release = deferred();
    const first = upload(firstRoot, 'target', {
        prepare: async check => {
            await fs.promises.mkdir(firstRoot);
            check();
            created.resolve();
            await release.promise;
            check();
        },
    });
    await created.promise;
    assert.equal(admission.activeByStorageRoot.has(canonicalRoot), false);
    const second = upload(canonicalRoot, 'target');
    let secondSettled = false;
    second.accepted.then(() => { secondSettled = true; });
    await delay(0);
    assert.equal(secondSettled, false, 'B cannot overtake A after mkdir but before reservation');
    release.resolve();
    assert.equal((await first.accepted).accepted, true);
    assert.equal((await second.accepted).accepted, false);
    assert.equal((await second.done).error.code, 'upload_target_busy');
    first.req.end('x');
    assert.equal((await first.done).ok, true);
    assertEmptyState(canonicalRoot);
});

test('five concurrent overwrite replays commit once and reject noncommitting turns without partials', async t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'target'), 'o');
    const items = Array.from({ length: 5 }, () => upload(root, 'target', { replaceExisting: true }));
    const accepted = await Promise.all(items.map(item => item.accepted));
    assert.equal(accepted.filter(item => item.accepted).length, 1);
    for (const item of items.slice(1)) {
        assert.ok(['upload_target_busy', 'upload_target_changed'].includes((await item.done).error.code));
        item.req.destroy();
    }
    items[0].req.end('x');
    assert.equal((await items[0].done).ok, true);
    assert.deepEqual(fs.readdirSync(root), ['target']);
});

test('two initially missing spellings retain FIFO quota admission with both bodies open', async t => {
    const root = fixture(t);
    const real = path.join(root, 'real');
    fs.mkdirSync(real);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(real, alias);
    const roots = [path.join(alias, 'new'), path.join(real, 'new')];
    const items = roots.map((storageRoot, index) => upload(storageRoot, `target-${index}`, {
        policy: { ...policy, maxFiles: 1 },
        prepare: async check => { await fs.promises.mkdir(storageRoot, { recursive: true }); check(); },
    }));
    assert.deepEqual((await Promise.all(items.map(item => item.accepted))).map(result => result.accepted),
        [true, false]);
    assert.equal(items.every(item => !item.req.writableEnded), true);
    assert.equal((await items[1].done).error.code, 'upload_count_quota_exceeded');
    items[0].req.end('x');
    assert.equal((await items[0].done).ok, true);
    assertEmptyState(roots[1]);
});

test('missing-root ancestor alias and inode replacements fail before prepare and after mkdir', async t => {
    for (const phase of ['queued', 'after-mkdir']) {
        for (const change of ['alias', 'inode']) {
            const root = fixture(t);
            const real = path.join(root, 'real');
            const other = path.join(root, 'other');
            const moved = path.join(root, 'moved');
            const alias = path.join(root, 'alias');
            fs.mkdirSync(real);
            fs.mkdirSync(other);
            fs.writeFileSync(path.join(real, 'marker'), 'external');
            fs.symlinkSync(real, alias);
            const storageRoot = path.join(alias, 'new');
            const canonical = path.join(real, 'new');
            const gate = deferred();
            const holding = phase === 'queued'
                ? admission.withStorageRootLock(canonical, () => gate.promise) : Promise.resolve();
            const replace = () => {
                if (change === 'alias') {
                    fs.unlinkSync(alias);
                    fs.symlinkSync(other, alias);
                    // Valid descendants ensure failure cannot be explained by ENOENT.
                    fs.mkdirSync(path.join(other, 'new'), { recursive: true });
                } else {
                    fs.renameSync(real, moved);
                    fs.mkdirSync(path.join(real, 'new'), { recursive: true });
                }
            };
            let preparations = 0;
            const item = upload(storageRoot, 'target', {
                prepare: async check => {
                    preparations += 1;
                    await fs.promises.mkdir(storageRoot, { recursive: true });
                    check();
                    if (phase === 'after-mkdir') replace();
                },
            });
            if (phase === 'queued') replace();
            gate.resolve();
            await holding;
            assert.equal((await item.accepted).accepted, false, `${phase} ${change}`);
            assert.equal((await item.done).error.code, 'storage_inventory_unavailable');
            assert.equal(preparations, phase === 'queued' ? 0 : 1);
            assert.equal(item.req.listenerCount('data'), 0);
            assert.deepEqual(item.counts, { success: 0, failure: 1 });
            assert.equal(admission.activeByStorageRoot.has(canonical), false);
            assert.equal(admission.tailsByStorageRoot.has(canonical), false);
            assert.equal(fs.readFileSync(path.join(change === 'inode' ? moved : real, 'marker'), 'utf8'),
                'external');
            const current = fs.realpathSync(storageRoot);
            assert.deepEqual(fs.readdirSync(current), []);
            const recovery = upload(storageRoot, 'recovery');
            await recovery.accepted;
            recovery.req.end('x');
            assert.equal((await recovery.done).ok, true);
            assertEmptyState(current);
        }
    }
});

test('root capture ascends only ENOENT, bounds sync work and preserves Unicode suffixes', async t => {
    const root = fixture(t);
    const identity = admission.captureStorageRootIdentity(path.join(root, 'uno', 'два', '三'));
    assert.equal(identity.canonicalRoot, path.join(root, 'uno', 'два', '三'));
    assert.equal(identity.ancestorRequested, root);
    assert.equal(Object.isFrozen(identity), true);
    fs.writeFileSync(path.join(root, 'file'), 'x');
    fs.symlinkSync('absent', path.join(root, 'dangling'));
    for (const target of [path.join(root, 'file'), path.join(root, 'file', 'child'),
        path.join(root, 'dangling', 'child')]) {
        assert.throws(() => admission.captureStorageRootIdentity(target),
            { code: 'storage_inventory_unavailable' });
    }
    const original = fs.lstatSync;
    const mock = t.mock.method(fs, 'lstatSync', (target, ...args) => {
        if (target === path.join(root, 'denied')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return original(target, ...args);
    });
    assert.throws(() => admission.captureStorageRootIdentity(path.join(root, 'denied')),
        { code: 'storage_inventory_unavailable' });
    mock.mock.restore();
});

test('each root-verification await checks cancellation on both success and I/O rejection', async t => {
    const root = fixture(t);
    for (const requireRoot of [false, true]) {
        const target = path.join(root, requireRoot ? 'existing' : 'missing');
        if (requireRoot) fs.mkdirSync(target);
        const identity = admission.captureStorageRootIdentity(target);
        const trace = [];
        const originals = { realpath: fs.promises.realpath, lstat: fs.promises.lstat };
        const mocks = Object.keys(originals).map(name => t.mock.method(fs.promises, name, async (...args) => {
            trace.push(name);
            return originals[name](...args);
        }));
        await admission.verifyStorageRootIdentity(identity, { requireRoot, check() {} });
        mocks.forEach(mock => mock.mock.restore());
        assert.ok(trace.length >= 3);
        for (let selected = 0; selected < trace.length; selected += 1) {
            for (const reject of [false, true]) {
                let index = 0;
                let aborted = false;
                const injections = Object.keys(originals).map(name =>
                    t.mock.method(fs.promises, name, async (...args) => {
                        const current = index++;
                        if (current !== selected) return originals[name](...args);
                        if (reject) {
                            aborted = true;
                            throw Object.assign(new Error('injected I/O rejection'), { code: 'EIO' });
                        }
                        try { return await originals[name](...args); } finally { aborted = true; }
                    }));
                await assert.rejects(admission.verifyStorageRootIdentity(identity, {
                    requireRoot,
                    check() { if (aborted) throw new UploadAdmissionError(400, 'upload_aborted'); },
                }), { code: 'upload_aborted' }, `${requireRoot}/await ${selected}/reject ${reject}`);
                injections.forEach(mock => mock.mock.restore());
            }
        }
    }
});

test('root verification rejects changes immediately before publishing a reservation', async t => {
    const root = fixture(t);
    const real = path.join(root, 'real');
    const moved = path.join(root, 'moved');
    fs.mkdirSync(real);
    const storageRoot = path.join(real, 'new');
    const original = fs.promises.readdir;
    let replaced = false;
    t.mock.method(fs.promises, 'readdir', async (...args) => {
        const result = await original(...args);
        if (!replaced) {
            replaced = true;
            fs.renameSync(real, moved);
            fs.mkdirSync(storageRoot, { recursive: true });
        }
        return result;
    });
    const item = upload(storageRoot, 'target', {
        prepare: async check => { await fs.promises.mkdir(storageRoot); check(); },
    });
    assert.equal((await item.accepted).accepted, false);
    assert.equal((await item.done).error.code, 'storage_inventory_unavailable');
    assertEmptyState(storageRoot);
    assert.deepEqual(fs.readdirSync(storageRoot), []);
});

test('prepare rejection after mkdir drains its ticket without deleting shared scaffolding', async t => {
    const root = fixture(t);
    const storageRoot = path.join(root, 'new');
    const item = upload(storageRoot, 'target', {
        prepare: async check => {
            await fs.promises.mkdir(storageRoot);
            check();
            throw new Error('prepare failed');
        },
    });
    assert.equal((await item.accepted).accepted, false);
    assert.equal((await item.done).error.code, 'upload_write_failed');
    assertEmptyState(storageRoot);
    const recovery = upload(storageRoot, 'recovery');
    await recovery.accepted;
    recovery.req.end('x');
    assert.equal((await recovery.done).ok, true);
});

test('1000-blob inventory workload has strict event-loop maximum below 5ms and bounded lstat batches', async t => {
    const root = fixture(t);
    for (let i = 0; i < 1000; i += 1) {
        fs.writeFileSync(path.join(root, `blob-${i}`), 'x');
        fs.writeFileSync(path.join(root, `blob-${i}.json`), '{}');
    }
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const syncCalls = {};
    const restore = [];
    const replace = (object, name, implementation) => {
        const original = object[name];
        object[name] = implementation;
        restore.push(() => { object[name] = original; });
    };
    let histogram;
    // Call-history mocks retain every stat result and stack inside the timing window.
    try {
        for (const name of ['realpathSync', 'lstatSync', 'readdirSync', 'openSync', 'closeSync',
            'renameSync', 'linkSync', 'unlinkSync']) {
            const originalSync = fs[name];
            const wrapped = (...args) => {
                syncCalls[name] = (syncCalls[name] || 0) + 1;
                return originalSync(...args);
            };
            const native = originalSync.native;
            if (native) wrapped.native = (...args) => {
                syncCalls[`${name}.native`] = (syncCalls[`${name}.native`] || 0) + 1;
                return native(...args);
            };
            replace(fs, name, wrapped);
        }
        const original = fs.promises.lstat;
        replace(fs.promises, 'lstat', async (...args) => {
            active += 1;
            calls += 1;
            maximum = Math.max(maximum, active);
            try { return await original(...args); } finally { active -= 1; }
        });
        histogram = monitorEventLoopDelay({ resolution: 1 });
        histogram.enable();
        await delay(3);
        histogram.reset();
        const latencies = [];
        for (let i = 0; i < 10; i += 1) {
            const started = performance.now();
            const item = upload(root, `new-${i}`, {
                policy: { ...policy, maxFiles: 1024, maxStorageBytes: 100000, timeoutMs: 120000 },
                includeEntry: ({ relativePath }) => !relativePath.endsWith('.json'),
            });
            assert.equal((await item.accepted).accepted, true);
            latencies.push(performance.now() - started);
            item.req.end('x');
            assert.equal((await item.done).ok, true);
        }
        histogram.disable();
        latencies.sort((a, b) => a - b);
        t.diagnostic(JSON.stringify({ reservationP50Ms: latencies[5], reservationP99Ms: latencies[9],
            eventLoopMaxMs: histogram.max / 1e6, eventLoopP99Ms: histogram.percentile(99) / 1e6,
            lstatCalls: calls, maximumLstatConcurrency: maximum, syncCalls }));
        assert.ok(maximum <= 16);
        assert.ok(calls >= 40000);
        assert.deepEqual(syncCalls, { lstatSync: 20, 'realpathSync.native': 10 });
        assert.ok(histogram.max / 1e6 < 5, `event-loop max ${histogram.max / 1e6}ms must be <5ms`);
    } finally {
        histogram?.disable();
        while (restore.length) restore.pop()();
    }
});
