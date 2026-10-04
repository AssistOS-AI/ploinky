import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPinnedPublicSourceReader } from './import_source_reader_codex.mjs';

const source = Buffer.from('export const value = 1;\n');
const row = { url: 'file:///candidate/api.mjs', format: 'module', bytes: source.length, sha256: createHash('sha256').update(source).digest('hex') };
function fixture({ grow = false, fstatFails = false, closeFails = false, replaced = false } = {}) {
    let opened = 0, closed = 0, read = 0, offset = 0;
    const stat = { dev: 1, ino: 2, uid: 1000, mode: 0o100644, nlink: 1, size: source.length, mtimeMs: 1, ctimeMs: 1, isFile: () => true };
    const body = grow ? Buffer.concat([source, Buffer.from('X')]) : source;
    const io = { realpathSync: value => value, openSync() { opened++; return 42; },
        fstatSync() { if (fstatFails) throw new Error(); return stat; },
        lstatSync: () => ({ ...stat, ino: replaced ? 3 : 2 }),
        readSync(_fd, bytes, start, length) { read++; const count = Math.min(length, body.length - offset); body.copy(bytes, start, offset, offset + count); offset += count; return count; },
        closeSync() { closed++; if (closeFails) throw new Error(); }
    };
    return { io, counts: () => ({ opened, closed, read }) };
}
test('qualified pinned source is returned only after exact bounded reading and descriptor closure', () => {
    const fake = fixture(), reader = createPinnedPublicSourceReader({ modules: [row], roots: ['/candidate'], io: fake.io, check() {} });
    assert.deepEqual(reader.readSource(row), source); assert.deepEqual(fake.counts(), { opened: 1, closed: 1, read: 2 });
    assert.deepEqual(reader.retainedDescriptors(), []);
});
test('growth and path replacement refuse with one normal close and no subsequent open', () => {
    for (const options of [{ grow: true }, { replaced: true }]) {
        const fake = fixture(options), reader = createPinnedPublicSourceReader({ modules: [row], roots: ['/candidate'], io: fake.io, check() {} });
        assert.throws(() => reader.readSource(row), { code: 'import-reader-failed' });
        assert.throws(() => reader.readSource(row)); assert.equal(fake.counts().opened, 1); assert.equal(fake.counts().closed, 1);
    }
});
test('fstat failure retains before observation and ambiguous close is never retried', () => {
    const fake = fixture({ fstatFails: true, closeFails: true }), reader = createPinnedPublicSourceReader({ modules: [row], roots: ['/candidate'], io: fake.io, check() {} });
    assert.throws(() => reader.readSource(row), { code: 'import-reader-close-unknown' });
    assert.deepEqual(reader.retainedDescriptors(), [{ fd: 42, closed: false, closeUnknown: true }]);
    assert.throws(() => reader.readSource(row)); assert.equal(fake.counts().closed, 1);
});
test('expiry during final close refuses despite a correctly read source', () => {
    const fake = fixture(), close = fake.io.closeSync; let expired = false;
    fake.io.closeSync = fd => { close(fd); expired = true; };
    const reader = createPinnedPublicSourceReader({ modules: [row], roots: ['/candidate'], io: fake.io, check() { if (expired) throw new Error(); } });
    assert.throws(() => reader.readSource(row)); assert.equal(fake.counts().closed, 1); assert.equal(reader.snapshot().retained, 0);
});
test('unknown requests and protected or out-of-root paths refuse before filesystem access', () => {
    const fake = fixture(), reader = createPinnedPublicSourceReader({ modules: [row], roots: ['/candidate'], io: fake.io, check() {} });
    assert.throws(() => reader.readSource({ ...row, url: 'file:///candidate/unknown.mjs' })); assert.equal(fake.counts().opened, 0);
    for (const url of ['file:///candidate/.codex/auth.json', 'file:///foreign/api.mjs']) {
        assert.throws(() => createPinnedPublicSourceReader({ modules: [{ ...row, url }], roots: ['/candidate'], io: fake.io, check() {} }));
    }
});
