import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createValidatedJsonFileReader } from '../../cli/utils/validatedJsonFile.js';

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validated-json-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'agents.json');
    const calls = { stat: 0, read: 0, close: 0 };
    const fsApi = {
        ...fs,
        statSync(...args) { calls.stat += 1; return fs.statSync(...args); },
        readFileSync(...args) { calls.read += 1; return fs.readFileSync(...args); },
        closeSync(...args) { calls.close += 1; return fs.closeSync(...args); },
    };
    return { file, calls, fsApi, reader: createValidatedJsonFileReader({ fsApi }) };
}

function stamp(overrides = {}) {
    return { dev: 1n, ino: 1n, size: 13n, mtimeNs: 1n, ctimeNs: 1n, isFile: () => true, ...overrides };
}

function injected() {
    const state = { pathStat: stamp(), handleStat: stamp(), text: '{"value":"a"}', reads: 0, closes: 0 };
    const fsApi = {
        statSync() { return state.pathStat; },
        openSync() { return 17; },
        fstatSync() { return state.handleStat; },
        readFileSync(fd, encoding) {
            assert.equal(fd, 17);
            assert.equal(encoding, 'utf8');
            state.reads += 1;
            return state.text;
        },
        closeSync(fd) { assert.equal(fd, 17); state.closes += 1; },
    };
    return { state, fsApi };
}

test('1000 unchanged reads validate every hit, read once and deeply freeze snapshots', (t) => {
    const { file, reader, calls } = fixture(t);
    fs.writeFileSync(file, '{"nested":{"items":[{"value":1}]}}');
    const first = reader.read(file);
    for (let index = 1; index < 1000; index += 1) {
        const result = reader.read(file);
        assert.equal(result.hit, true);
        assert.equal(result.value, first.value);
    }
    assert.deepEqual(calls, { stat: 1000, read: 1, close: 1 });
    assert.deepEqual(reader.stats(), { hits: 999, misses: 1, size: 1 });
    assert.throws(() => first.value.nested.items.push(2), TypeError);
    assert.throws(() => { first.value.nested.items[0].value = 2; }, TypeError);
});

test('same-size rename and different-size in-place writes are visible on the next read', (t) => {
    const { file, reader } = fixture(t);
    fs.writeFileSync(file, '{"value":"a"}');
    assert.equal(reader.read(file).value.value, 'a');
    fs.writeFileSync(`${file}.next`, '{"value":"b"}');
    fs.renameSync(`${file}.next`, file);
    assert.equal(reader.read(file).value.value, 'b');
    fs.writeFileSync(file, '{"value":"longer"}');
    assert.equal(reader.read(file).value.value, 'longer');
});

test('metadata-only change and explicit invalidation each force a reread', (t) => {
    const { file, reader, calls } = fixture(t);
    fs.writeFileSync(file, '{}');
    reader.read(file);
    fs.utimesSync(file, 1, 1);
    assert.equal(reader.read(file).hit, false);
    reader.invalidate(file);
    assert.equal(reader.read(file).hit, false);
    assert.equal(calls.read, 3);
});

for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
    test(`a change only in ${field} invalidates the snapshot`, () => {
        const { fsApi, state } = injected();
        const reader = createValidatedJsonFileReader({ fsApi });
        reader.read('/fixture');
        state.pathStat = state.handleStat = stamp({ [field]: 99n });
        state.text = '{"value":"b"}';
        assert.equal(reader.read('/fixture').value.value, 'b');
        assert.equal(state.reads, 2);
    });
}

test('the opened-handle stamp prevents pinning old bytes under a newer path stamp', () => {
    const { fsApi, state } = injected();
    state.pathStat = stamp({ ino: 2n });
    const reader = createValidatedJsonFileReader({ fsApi });
    const first = reader.read('/fixture');
    assert.equal(first.value.value, 'a');
    assert.equal(first.stamp, '1:1:13:1:1');
    state.handleStat = state.pathStat;
    state.text = '{"value":"b"}';
    assert.equal(reader.read('/fixture').value.value, 'b');
    assert.equal(state.reads, 2);
});

test('S1 to S1-prime to S2 rereads the old ctime bump and then the replacement inode', () => {
    const { fsApi, state } = injected();
    const reader = createValidatedJsonFileReader({ fsApi });
    assert.equal(reader.read('/fixture').value.value, 'a');
    state.pathStat = state.handleStat = stamp({ ctimeNs: 2n });
    assert.equal(reader.read('/fixture').hit, false);
    assert.equal(state.reads, 2);
    state.pathStat = state.handleStat = stamp({ ino: 2n, ctimeNs: 3n });
    state.text = '{"value":"b"}';
    assert.equal(reader.read('/fixture').value.value, 'b');
    assert.equal(state.reads, 3);
});

test('parse errors discard an old entry and do not cache failures', () => {
    const { fsApi, state } = injected();
    const reader = createValidatedJsonFileReader({ fsApi });
    reader.read('/fixture');
    state.pathStat = state.handleStat = stamp({ ino: 2n });
    state.text = '{';
    for (let index = 0; index < 2; index += 1) assert.throws(() => reader.read('/fixture'), SyntaxError);
    assert.equal(reader.stats().size, 0);
    state.text = '{"value":"b"}';
    assert.equal(reader.read('/fixture').value.value, 'b');
    assert.equal(state.closes, 4);
});

for (const operation of ['fstatSync', 'readFileSync']) {
    test(`${operation} failures close every opened descriptor and are never cached`, () => {
        const { fsApi, state } = injected();
        const original = fsApi[operation];
        const reader = createValidatedJsonFileReader({ fsApi });
        reader.read('/fixture');
        state.pathStat = stamp({ ctimeNs: 2n });
        fsApi[operation] = () => { throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' }); };
        for (let index = 0; index < 50; index += 1) {
            assert.throws(() => reader.read('/fixture'), { code: 'EIO' });
        }
        assert.equal(state.closes, 51);
        assert.equal(reader.stats().size, 0);
        fsApi[operation] = original;
        assert.equal(reader.read('/fixture').hit, false);
    });
}

test('only a regular opened handle is cached, even when the path stat is regular', () => {
    const { fsApi, state } = injected();
    state.handleStat = stamp({ isFile: () => false });
    const reader = createValidatedJsonFileReader({ fsApi });
    reader.read('/fixture');
    reader.read('/fixture');
    assert.equal(state.reads, 2);
    assert.equal(reader.stats().size, 0);
    state.handleStat = stamp();
    reader.read('/fixture');
    state.pathStat = stamp({ isFile: () => false });
    assert.equal(reader.read('/fixture').hit, false);
});

test('missing paths and open-time ENOENT discard entries, then creation is read afresh', () => {
    const { fsApi, state } = injected();
    const reader = createValidatedJsonFileReader({ fsApi });
    reader.read('/fixture');
    state.pathStat = undefined;
    assert.deepEqual(reader.read('/fixture'), { exists: false });
    assert.equal(reader.stats().size, 0);
    state.pathStat = stamp();
    assert.equal(reader.read('/fixture').hit, false);
    state.pathStat = stamp({ ino: 2n });
    const open = fsApi.openSync;
    fsApi.openSync = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
    assert.deepEqual(reader.read('/fixture'), { exists: false });
    assert.equal(reader.stats().size, 0);
    fsApi.openSync = open;
    assert.equal(reader.read('/fixture').hit, false);
});

test('empty, null and four-megabyte JSON retain load semantics; directories never leak handles', (t) => {
    const { file, reader, calls } = fixture(t);
    assert.deepEqual(reader.read(file), { exists: false });
    for (const text of ['', 'null', '{}']) {
        fs.writeFileSync(file, text);
        reader.invalidate(file);
        assert.deepEqual(reader.read(file).value, {});
    }
    const value = { data: 'x'.repeat(4 * 1024 * 1024) };
    fs.writeFileSync(file, JSON.stringify(value));
    assert.deepEqual(reader.read(file).value, value);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    const before = calls.close;
    for (let index = 0; index < 10; index += 1) assert.throws(() => reader.read(file), { code: 'EISDIR' });
    assert.equal(calls.close - before, 10);
    assert.equal(reader.stats().size, 0);
});

test('LRU capacity is bounded and hits retain the most recently used entry', () => {
    const { fsApi } = injected();
    const reader = createValidatedJsonFileReader({ fsApi, maxEntries: 2 });
    reader.read('/a');
    reader.read('/b');
    assert.equal(reader.read('/a').hit, true);
    reader.read('/c');
    assert.equal(reader.stats().size, 2);
    assert.equal(reader.read('/a').hit, true);
    assert.equal(reader.read('/b').hit, false);
    const uncached = createValidatedJsonFileReader({ fsApi, maxEntries: 0 });
    uncached.read('/a');
    assert.equal(uncached.read('/a').hit, false);
    assert.equal(uncached.stats().size, 0);
});
