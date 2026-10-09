import test from 'node:test';
import assert from 'node:assert/strict';
import { installPureGuards } from './test_support.mjs';
import { createCatalogRecorder, parseBuilderArguments, buildCatalogMain, DEFAULT_EXTRA_ENTRIES } from './catalog_builder.mjs';
import { IMPORT_LIMITS } from './import_binding.mjs';
installPureGuards();

const PARENT = 'file:///checkout/tests/product_import.mjs', API = 'file:///candidate/ploinky-box/bin/ploinky-box.mjs', DEP = 'file:///candidate/ploinky-box/dep.mjs';
const bytesFor = new Map([[API, Buffer.from('import "./dep.mjs";\n')], [DEP, Buffer.from('export const x = 1;\n')]]);
const io = (overrides = {}) => ({ lstatSync: file => { const url = `file://${file}`; return { isFile: () => !overrides.notFile, isSymbolicLink: () => Boolean(overrides.symlink), size: overrides.size ?? bytesFor.get(url).length }; },
    readFileSync: file => overrides.read ? overrides.read() : bytesFor.get(`file://${file}`) });
const conditions = ['node', 'import'];
const resolveAs = (recorder, specifier, parentURL, url, format = 'module', extra = {}) => recorder.resolve(specifier, { parentURL, conditions, importAttributes: {} }, () => ({ url, format, ...extra }));
const loadAs = (recorder, url, format = 'module') => recorder.load(url, { format }, () => ({ format, source: null }));

test('recorder keeps exact edges, builtins from resolution and bytes of every loaded file', () => {
    const recorder = createCatalogRecorder({ entryParentURL: PARENT, io: io() });
    resolveAs(recorder, API, PARENT, API); loadAs(recorder, API); resolveAs(recorder, './dep.mjs', API, DEP, null); loadAs(recorder, DEP); resolveAs(recorder, 'fs', API, 'node:fs', undefined);
    recorder.markInitial();
    const catalog = recorder.finish({ candidateCommit: 'a'.repeat(40), apiURL: API });
    assert.deepEqual(catalog.builtins, ['node:fs']); assert.deepEqual(catalog.initialModules, [API, DEP]);
    assert.deepEqual(catalog.modules.map(row => [row.url, row.format, row.bytes]), [[API, 'module', 20], [DEP, 'module', 20]]);
    assert.deepEqual(catalog.edges.find(edge => edge.specifier === './dep.mjs'), { specifier: './dep.mjs', parentURL: API, conditions: ['import', 'node'], attributes: {}, url: DEP, format: 'module' });
    assert.equal(catalog.edges.find(edge => edge.url === 'node:fs').format, 'builtin');
});

test('recorder refuses symlinks, non-files, oversized or changed sources, foreign protocols and incomplete catalogs', () => {
    const attempt = options => { const recorder = createCatalogRecorder({ entryParentURL: PARENT, io: io(options) }); resolveAs(recorder, API, PARENT, API); return () => loadAs(recorder, API); };
    assert.throws(attempt({ symlink: true }), error => error.code === 'catalog-source-shape'); assert.throws(attempt({ notFile: true }), error => error.code === 'catalog-source-shape');
    assert.throws(attempt({ size: IMPORT_LIMITS.sourceBytes + 1 }), error => error.code === 'catalog-source-shape');
    assert.throws(attempt({ read: () => Buffer.from('changed length') }), error => error.code === 'catalog-source-changed');
    const recorder = createCatalogRecorder({ entryParentURL: PARENT, io: io() });
    assert.throws(() => resolveAs(recorder, 'data:text/javascript,1', PARENT, 'data:text/javascript,1'), error => error.code === 'catalog-url');
    assert.throws(() => loadAs(recorder, API), error => error.code === 'catalog-after-failure');
    const other = createCatalogRecorder({ entryParentURL: PARENT, io: io() });
    assert.throws(() => other.load('http://example.invalid/x.mjs', { format: 'module' }, () => ({ format: 'module' })), error => error.code === 'catalog-url');
    const fresh = createCatalogRecorder({ entryParentURL: PARENT, io: io() }); resolveAs(fresh, API, PARENT, API); loadAs(fresh, API);
    assert.throws(() => fresh.finish({ candidateCommit: 'a'.repeat(40), apiURL: API }), error => error.code === 'catalog-incomplete', 'markInitial is mandatory');
    fresh.markInitial(); assert.throws(() => fresh.finish({ candidateCommit: 'short', apiURL: API }), error => error.code === 'catalog-incomplete');
    assert.throws(() => fresh.finish({ candidateCommit: 'a'.repeat(40), apiURL: DEP }), error => error.code === 'catalog-incomplete');
    const unloaded = createCatalogRecorder({ entryParentURL: PARENT, io: io() }); resolveAs(unloaded, API, PARENT, API); loadAs(unloaded, API); resolveAs(unloaded, './dep.mjs', API, DEP); unloaded.markInitial();
    assert.throws(() => unloaded.finish({ candidateCommit: 'a'.repeat(40), apiURL: API }), error => error.code === 'catalog-edge-unloaded');
});

test('conflicting resolutions of one edge key are refused rather than silently merged', () => {
    const recorder = createCatalogRecorder({ entryParentURL: PARENT, io: io() }); resolveAs(recorder, API, PARENT, API); loadAs(recorder, API); resolveAs(recorder, './x.mjs', API, DEP); loadAs(recorder, DEP);
    resolveAs(recorder, './x.mjs', API, API); recorder.markInitial();
    assert.throws(() => recorder.finish({ candidateCommit: 'a'.repeat(40), apiURL: API }), error => error.code === 'catalog-edge-ambiguous');
});

test('builder arguments are exact and the output is created exclusively after recording', async () => {
    const good = ['--candidate', '/home/skutner/work/pinned-ploinky', '--commit', 'a'.repeat(40), '--out', '/home/skutner/work/evidence/sources_codex.json'];
    assert.deepEqual(parseBuilderArguments(good), { candidate: '/home/skutner/work/pinned-ploinky', commit: 'a'.repeat(40), out: '/home/skutner/work/evidence/sources_codex.json', extra: [] });
    assert.deepEqual(parseBuilderArguments([...good, '--extra', 'ploinky-box/diagnose.mjs']).extra, ['ploinky-box/diagnose.mjs']);
    for (const bad of [[], good.slice(0, 4), [...good, '--extra'], [...good, '--extra', '../escape.mjs'], [...good, '--extra', '/abs.mjs'], [...good, '--candidate', '/x'], ['--candidate', 'relative', ...good.slice(2)],
        ['--candidate', '/a/../b', ...good.slice(2)], ['--candidate', good[1], '--commit', 'zz', ...good.slice(4)], [...good.slice(0, 5), '/tmp/out.json'], [...good.slice(0, 5), '/tmp/out_codex.json', '--bogus', 'x']]) {
        assert.throws(() => parseBuilderArguments(bad), error => error.code === 'catalog-arguments');
    }
    const writes = [], opened = []; let hooks = null;
    const fake = { ...io(), openSync: (file, flags) => { opened.push([file, flags]); return 9; }, writeSync: (_fd, text) => { writes.push(text); }, closeSync: () => {} };
    const importer = async url => { if (url === API) { resolveAs(hooks, API, PARENT, API); loadAs(hooks, API); resolveAs(hooks, './dep.mjs', API, DEP); loadAs(hooks, DEP); } else { resolveAs(hooks, url, PARENT, url); loadAs(hooks, url); } return { runOuterCli() {} }; };
    bytesFor.set('file:///candidate/ploinky-box/supervisor.mjs', Buffer.from('export const s = 1;\n'));
    const summary = await buildCatalogMain(['--candidate', '/candidate', '--commit', 'a'.repeat(40), '--out', '/evidence/sources_codex.json'],
        { io: fake, registerHooks: value => { hooks = value; }, importer: url => importer(url), entryParentURL: PARENT });
    assert.deepEqual(summary, { modules: 3, edges: 3, builtins: 0 }); assert.equal(opened.length, 1); assert.equal(opened[0][0], '/evidence/sources_codex.json');
    const catalog = JSON.parse(writes[0]); assert.deepEqual(catalog.initialModules, [API, DEP]); assert.equal(DEFAULT_EXTRA_ENTRIES.length, 1);
    await assert.rejects(buildCatalogMain(['--candidate', '/candidate', '--commit', 'a'.repeat(40), '--out', '/evidence/sources_codex.json'], { io: fake, registerHooks: null, importer, entryParentURL: PARENT }), error => error.code === 'catalog-hooks-unavailable');
    await assert.rejects(buildCatalogMain(['--candidate', '/candidate', '--commit', 'a'.repeat(40), '--out', '/evidence/sources_codex.json'], { io: fake, registerHooks: value => { hooks = value; }, importer: async () => ({}), entryParentURL: PARENT }), error => error.code === 'catalog-api-missing');
});
