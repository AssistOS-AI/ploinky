import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createVerifiedImportHooks } from './import_binding_codex.mjs';
import { AcceptanceError } from './manifest_codex.mjs';

const API = 'file:///candidate/api.mjs', DEP = 'file:///candidate/dependency.mjs', WORKER = 'file:///candidate/worker.mjs';
const content = new Map([[API, Buffer.from("import './dependency.mjs'; export const api = 1;\n")], [DEP, Buffer.from('export const dependency = 2;\n')]]);
function catalog() {
    return { schemaVersion: 1, candidateCommit: 'a'.repeat(40), apiURL: API, entryParentURL: WORKER, builtins: ['node:path'],
        modules: [...content].map(([url, bytes]) => ({ url, format: 'module', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })),
        edges: [{ specifier: API, parentURL: WORKER, url: API, format: 'module', conditions: ['node', 'import'], attributes: {} },
            { specifier: './dependency.mjs', parentURL: API, url: DEP, format: 'module', conditions: ['node', 'import'], attributes: {} },
            { specifier: 'node:path', parentURL: API, url: 'node:path', format: 'builtin', conditions: ['node', 'import'], attributes: {} }], initialModules: [API, DEP] };
}
const context = { parentURL: WORKER, conditions: ['node', 'import'], importAttributes: {} };
const forbidden = () => { throw new Error('normal file loader must not run'); };
test('normal qualified resolution and private exact source preserve the initial closure', () => {
    const hooks = createVerifiedImportHooks(catalog(), { readSource: row => content.get(row.url), check() {} });
    assert.deepEqual(hooks.resolve(API, context, () => ({ url: API, format: 'module' })), { url: API, format: 'module' });
    for (const url of [API, DEP]) assert.equal(hooks.load(url, { format: 'module' }, forbidden).source, content.get(url).toString());
    assert.equal(hooks.assertInitialClosure(), true); assert.equal(hooks.snapshot().actualRegistration, 'UNPROVEN');
});
test('changed loaded source refuses before returning evaluation bytes and latches all later calls', () => {
    const hooks = createVerifiedImportHooks(catalog(), { readSource: row => Buffer.alloc(row.bytes, 65), check() {} });
    assert.throws(() => hooks.load(API, { format: 'module' }, forbidden), { code: 'import-source-changed' });
    let resolved = 0; assert.throws(() => hooks.resolve(API, context, () => { resolved++; return { url: API, format: 'module' }; }));
    assert.equal(resolved, 0); assert.equal(hooks.snapshot().loadedModules, 0);
});
test('source is immutable after return and caller catalog changes cannot rebind an edge', () => {
    const input = catalog(), bytes = Buffer.from(content.get(API));
    const hooks = createVerifiedImportHooks(input, { readSource: () => bytes, check() {} }); input.edges[0].url = DEP; input.initialModules.splice(0);
    const result = hooks.load(API, { format: 'module' }, forbidden); bytes.fill(65);
    assert.equal(result.source, content.get(API).toString());
    assert.equal(hooks.resolve(API, context, () => ({ url: API, format: 'module' })).url, API);
    assert.throws(() => hooks.assertInitialClosure(), { code: 'import-initial-closure-unproven' });
});
test('unknown or redirected edges refuse, and unknown loads never read a file', () => {
    for (const next of [() => ({ url: DEP, format: 'module' }), () => ({ url: API, format: 'commonjs' })]) {
        const hooks = createVerifiedImportHooks(catalog(), { readSource: row => content.get(row.url), check() {} });
        assert.throws(() => hooks.resolve(API, context, next), { code: 'import-resolution-changed' });
    }
    let reads = 0; const hooks = createVerifiedImportHooks(catalog(), { readSource() { reads++; }, check() {} });
    assert.throws(() => hooks.load('file:///private/unqualified.mjs', { format: 'module' }, forbidden), { code: 'import-load-attributes' }); assert.equal(reads, 0);
});
test('unsupported format, oversized acquisition and late deadline checks refuse', () => {
    const variants = [
        { readSource: row => Buffer.alloc(row.bytes + 1), check() {}, code: 'import-source-shape' },
        { readSource: row => content.get(row.url), count: 0, check() { if (++this.count > 1) throw new AcceptanceError('control-deadline'); }, code: 'import-binding-unknown' }
    ];
    for (const value of variants) {
        const hooks = createVerifiedImportHooks(catalog(), { readSource: value.readSource, check: value.check.bind(value) });
        assert.throws(() => hooks.load(API, { format: 'module' }, forbidden), { code: value.code });
    }
    const bad = catalog(); bad.modules[0].format = 'addon';
    assert.throws(() => createVerifiedImportHooks(bad, { readSource() {}, check() {} }), { code: 'import-module' });
});
test('qualified builtin delegation does not manufacture product closure proof', () => {
    const hooks = createVerifiedImportHooks(catalog(), { readSource: row => content.get(row.url), check() {} });
    assert.deepEqual(hooks.load('node:path', { format: 'builtin' }, () => ({ format: 'builtin', source: null })), { format: 'builtin', source: null });
    assert.throws(() => hooks.assertInitialClosure(), { code: 'import-initial-closure-unproven' });
});
test('reader and clock errors never export caller-authored private error codes', () => {
    const privateCode = 'private-canary-that-is-not-a-public-failure';
    const hooks = createVerifiedImportHooks(catalog(), { readSource() { throw new AcceptanceError(privateCode); }, check() {} });
    assert.throws(() => hooks.load(API, { format: 'module' }, forbidden), { code: 'import-binding-unknown' });
    assert.equal(JSON.stringify(hooks.snapshot()).includes(privateCode), false);
});
test('exhausted source quota refuses before one additional reader call', () => {
    const bytes = Buffer.alloc(1048576, 32), input = catalog();
    input.modules[0].bytes = bytes.length; input.modules[0].sha256 = createHash('sha256').update(bytes).digest('hex');
    let calls = 0; const hooks = createVerifiedImportHooks(input, { readSource() { calls++; return bytes; }, check() {} });
    for (let index = 0; index < 32; index++) hooks.load(API, { format: 'module' }, forbidden);
    assert.throws(() => hooks.load(API, { format: 'module' }, forbidden), { code: 'import-acquisition-cap' }); assert.equal(calls, 32);
});
test('changed returned cache attributes and unqualified load pairs refuse', () => {
    const hooks = createVerifiedImportHooks(catalog(), { readSource: row => content.get(row.url), check() {} });
    assert.throws(() => hooks.resolve(API, context, () => ({ url: API, format: 'module', importAttributes: { type: 'json' } })), { code: 'import-resolution-changed' });
    const next = createVerifiedImportHooks(catalog(), { readSource: row => content.get(row.url), check() {} });
    assert.throws(() => next.load(API, { format: 'module', importAttributes: { type: 'json' } }, forbidden), { code: 'import-load-attributes' });
});
test('hidden/accessor/symbol attributes and sparse conditions refuse without delegation', () => {
    for (const attrs of [Object.defineProperty({}, 'type', { value: 'json' }), Object.defineProperty({}, 'type', { get() { throw new Error('getter must not run'); } }), { [Symbol('extra')]: 'value' }]) {
        const hooks = createVerifiedImportHooks(catalog(), { readSource: row => content.get(row.url), check() {} }); let called = false;
        assert.throws(() => hooks.resolve(API, { ...context, importAttributes: attrs }, () => { called = true; })); assert.equal(called, false);
    }
    const input = catalog(); input.edges[0].conditions = Array(1);
    assert.throws(() => createVerifiedImportHooks(input, { readSource() {}, check() {} }), { code: 'import-conditions' });
});
test('observed native null-prototype attributes and omitted builtin resolver format are supported', () => {
    const hooks = createVerifiedImportHooks(catalog(), { readSource: row => content.get(row.url), check() {} });
    const attrs = Object.create(null);
    const result = hooks.resolve('node:path', { ...context, parentURL: API, importAttributes: attrs }, () => ({ url: 'node:path', importAttributes: attrs }));
    assert.equal(result.url, 'node:path'); assert.equal(Object.getPrototypeOf(result.importAttributes), null);
    assert.deepEqual(hooks.load('node:path', { format: 'builtin', importAttributes: attrs }, () => ({ format: 'builtin', source: null })), { format: 'builtin', source: null });
});
test('all catalogue arrays reject accessors before reading values, and builtin format pairs stay qualified', () => {
    for (const name of ['builtins', 'initialModules', 'modules', 'edges']) {
        const input = catalog(); let read = false;
        Object.defineProperty(input[name], '0', { get() { read = true; throw new Error('array getter must not run'); } });
        assert.throws(() => createVerifiedImportHooks(input, { readSource() {}, check() {} })); assert.equal(read, false);
    }
    const hooks = createVerifiedImportHooks(catalog(), { readSource: row => content.get(row.url), check() {} }); let loaded = false;
    assert.throws(() => hooks.load('node:path', { format: 'module' }, () => { loaded = true; }), { code: 'import-load-unqualified' }); assert.equal(loaded, false);
});
test('copying admitted own __proto__ attributes preserves the cache key', () => {
    const input = catalog(), attrs = {};
    Object.defineProperty(attrs, '__proto__', { value: 'json', enumerable: true }); input.edges[0].attributes = attrs;
    const hooks = createVerifiedImportHooks(input, { readSource: row => content.get(row.url), check() {} });
    const result = hooks.resolve(API, { ...context, importAttributes: attrs }, () => ({ url: API, format: 'module', importAttributes: attrs }));
    assert.equal(Object.hasOwn(result.importAttributes, '__proto__'), true); assert.equal(result.importAttributes.__proto__, 'json');
    assert.equal(Object.getPrototypeOf(result.importAttributes), Object.prototype);
    assert.equal(hooks.load(API, { format: 'module', importAttributes: result.importAttributes }, forbidden).source, content.get(API).toString());
});
