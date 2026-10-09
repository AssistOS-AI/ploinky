import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// These controls run real Node processes, but only on a harmless fabricated package tree: no Ploinky, Box, engine,
// network or credential is involved. They qualify the official synchronous hooks and the catalog builder locally.
const spawnSync = cp.spawnSync;
const here = path.dirname(fileURLToPath(import.meta.url));
const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'uc-binding-'));
after(() => fs.rmSync(parent, { recursive: true, force: true }));
const env = () => ({ PATH: process.env.PATH, HOME: parent, LC_ALL: 'C' });
const commit = 'a'.repeat(40);

function makeTree(name) {
    const root = path.join(parent, name); fs.mkdirSync(path.join(root, 'ploinky-box/bin'), { recursive: true }); fs.mkdirSync(path.join(root, 'node_modules/depx'), { recursive: true });
    const write = (relative, text) => fs.writeFileSync(path.join(root, relative), text);
    write('ploinky-box/bin/ploinky-box.mjs', [
        "import path from 'node:path';", "import { helper } from '../helper.mjs';", "import legacy from '../legacy.cjs';", "import data from '../data.json' with { type: 'json' };", "import depx from 'depx';",
        'export async function runOuterCli(argv) {', "    if (argv[0] === 'late') return (await import('../late.mjs')).late;", '    return { helper, legacy, data, depx, sep: path.sep };', '}', ''].join('\n'));
    write('ploinky-box/helper.mjs', "import fs from 'node:fs';\nif (process.env.UC_MARKER) fs.appendFileSync(process.env.UC_MARKER, 'helper-evaluated\\n');\nexport const helper = 'helper-v1';\n");
    write('ploinky-box/legacy.cjs', "module.exports = { legacy: 'legacy-v1' };\n");
    write('ploinky-box/data.json', '{"data":"json-v1"}\n');
    write('ploinky-box/supervisor.mjs', 'export function createBoxSupervisor() { return {}; }\n');
    write('ploinky-box/late.mjs', "import fs from 'node:fs';\nif (process.env.UC_MARKER) fs.appendFileSync(process.env.UC_MARKER, 'late-evaluated\\n');\nexport const late = 'late-v1';\n");
    write('node_modules/depx/package.json', '{"name":"depx","version":"1.0.0","main":"index.js"}\n'); write('node_modules/depx/index.js', "module.exports = 'depx-v1';\n");
    return root;
}
function build(root, name) {
    const out = path.join(parent, `${name}_codex.json`);
    const result = spawnSync(process.execPath, [path.join(here, 'catalog_builder.mjs'), '--candidate', root, '--commit', commit, '--out', out], { env: env(), encoding: 'utf8', timeout: 30000, cwd: parent });
    return { result, out };
}
const driver = path.join(parent, 'driver.mjs');
fs.writeFileSync(driver, `import fs from 'node:fs';
import { loadVerifiedOuterApi } from ${JSON.stringify(pathToFileURL(path.join(here, 'worker.mjs')).href)};
const catalog = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
try {
    const { runOuterCli, binding } = await loadVerifiedOuterApi({ catalog, roots: [process.argv[3]], check() {} });
    const result = await runOuterCli([process.argv[4] ?? 'normal']);
    console.log(JSON.stringify({ ok: true, result, snapshot: binding.hooks.snapshot() }));
} catch (error) { console.log(JSON.stringify({ ok: false, code: error.code ?? 'other' })); process.exitCode = 1; }
`);
function run(catalog, root, mode, marker) {
    const result = spawnSync(process.execPath, [driver, catalog, root, mode], { env: { ...env(), ...(marker ? { UC_MARKER: marker } : {}) }, encoding: 'utf8', timeout: 30000, cwd: parent });
    let value = null; try { value = JSON.parse(result.stdout.trim().split('\n').at(-1)); } catch { value = null; }
    return { result, value };
}

test('the recording run produces a finite catalog of exact edges and bytes for every module format', () => {
    const root = makeTree('catalog'), { result, out } = build(root, 'catalog');
    assert.equal(result.status, 0, result.stderr); const catalog = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(Object.keys(catalog).sort(), ['apiURL', 'builtins', 'candidateCommit', 'edges', 'entryParentURL', 'initialModules', 'modules', 'schemaVersion']);
    assert.equal(catalog.candidateCommit, commit); assert.equal(catalog.apiURL, pathToFileURL(path.join(root, 'ploinky-box/bin/ploinky-box.mjs')).href);
    assert.equal(catalog.entryParentURL, pathToFileURL(path.join(here, 'product_import.mjs')).href);
    const formats = Object.fromEntries(catalog.modules.map(row => [path.relative(root, fileURLToPath(row.url)), row.format]));
    assert.deepEqual(formats, { 'node_modules/depx/index.js': 'commonjs', 'ploinky-box/bin/ploinky-box.mjs': 'module', 'ploinky-box/data.json': 'json', 'ploinky-box/helper.mjs': 'module',
        'ploinky-box/legacy.cjs': 'commonjs', 'ploinky-box/supervisor.mjs': 'module' });
    assert.ok(catalog.builtins.includes('node:path') && catalog.builtins.includes('node:fs'));
    assert.equal(catalog.initialModules.some(url => url.endsWith('supervisor.mjs')), false, 'extra entries are not part of the initial closure');
    assert.equal(catalog.modules.some(row => row.url.endsWith('late.mjs')), false);
    assert.ok(catalog.edges.some(edge => edge.specifier === catalog.apiURL && edge.parentURL === catalog.entryParentURL));
    assert.ok(catalog.edges.some(edge => edge.specifier === 'depx' && edge.format === 'commonjs'));
    assert.ok(catalog.edges.some(edge => edge.specifier === '../data.json' && edge.attributes.type === 'json'));
    for (const row of catalog.modules) assert.equal(row.bytes, fs.statSync(fileURLToPath(row.url)).size);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    const again = build(root, 'catalog'); assert.notEqual(again.result.status, 0); assert.match(again.result.stderr, /catalog-failed/, 'an existing output is never overwritten');
});

test('the verified hooks load every format from private pinned bytes through the real official hooks', () => {
    const root = makeTree('positive'), { out } = build(root, 'positive'), marker = path.join(parent, 'positive-marker.txt');
    const { result, value } = run(out, root, 'normal', marker);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(value.result, { helper: 'helper-v1', legacy: { legacy: 'legacy-v1' }, data: { data: 'json-v1' }, depx: 'depx-v1', sep: '/' });
    assert.equal(value.snapshot.firstFailure, null); assert.equal(value.snapshot.loadedModules, 5); assert.equal(fs.readFileSync(marker, 'utf8'), 'helper-evaluated\n');
});

test('changed bytes, a symlink swap and a replaced dependency refuse before the substituted module can evaluate', () => {
    for (const [label, tamper, codes] of [
        ['same-length source edit', root => fs.writeFileSync(path.join(root, 'ploinky-box/helper.mjs'), fs.readFileSync(path.join(root, 'ploinky-box/helper.mjs'), 'utf8').replace('helper-v1', 'helper-XX')), ['import-reader-failed']],
        ['commonjs edit', root => fs.writeFileSync(path.join(root, 'ploinky-box/legacy.cjs'), "module.exports = { legacy: 'legacy-XX' };\n"), ['import-reader-failed']],
        ['package replaced', root => fs.writeFileSync(path.join(root, 'node_modules/depx/index.js'), "module.exports = 'depx-XX';\n"), ['import-reader-failed']],
        ['symlink swap', root => { const file = path.join(root, 'ploinky-box/helper.mjs'); fs.renameSync(file, `${file}.orig`); fs.symlinkSync(`${file}.orig`, file); }, ['import-reader-failed']],
        ['grown file', root => fs.appendFileSync(path.join(root, 'ploinky-box/data.json'), ' '.repeat(10)), ['import-reader-failed']]]) {
        const root = makeTree(`tamper-${label.replace(/\W/g, '')}`), { out } = build(root, `tamper-${label.replace(/\W/g, '')}`), marker = path.join(parent, `tamper-${label.replace(/\W/g, '')}-marker.txt`);
        tamper(root); const { result, value } = run(out, root, 'normal', marker);
        assert.notEqual(result.status, 0, label); assert.equal(value.ok, false, label); assert.ok(codes.includes(value.code) || value.code.startsWith('import-'), `${label}: ${value.code}`);
        assert.equal(fs.existsSync(marker), false, `${label}: the substituted module evaluated`);
    }
});

test('a late dynamic import outside the catalog is refused and never evaluated', () => {
    const root = makeTree('late'), { out } = build(root, 'late'), marker = path.join(parent, 'late-marker.txt');
    const { result, value } = run(out, root, 'late', marker);
    assert.notEqual(result.status, 0); assert.equal(value.ok, false); assert.equal(value.code, 'import-edge-unqualified');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'helper-evaluated\n', 'only the catalogued initial closure evaluated');
});

test('a catalog that omits an initial module or names the wrong source refuses', () => {
    const root = makeTree('closure'), { out } = build(root, 'closure'), catalog = JSON.parse(fs.readFileSync(out, 'utf8'));
    const removed = path.join(parent, 'closure-removed_codex.json'); fs.writeFileSync(removed, JSON.stringify({ ...catalog, edges: catalog.edges.filter(edge => edge.specifier !== 'depx') }));
    const first = run(removed, root, 'normal'); assert.notEqual(first.result.status, 0); assert.equal(first.value.code, 'import-edge-unqualified');
    const changed = path.join(parent, 'closure-hash_codex.json'); fs.writeFileSync(changed, JSON.stringify({ ...catalog, modules: catalog.modules.map(row => row.url.endsWith('helper.mjs') ? { ...row, sha256: '1'.repeat(64) } : row) }));
    const second = run(changed, root, 'normal'); assert.notEqual(second.result.status, 0); assert.ok(second.value.code.startsWith('import-'));
});
