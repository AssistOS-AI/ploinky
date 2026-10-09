import test from 'node:test';
import assert from 'node:assert/strict';
import { installPureGuards, H } from './test_support.mjs';
import { createMemoryFs } from './fake_fs_support.mjs';
import { runStoreProbe, storeProbeMain, validateStoreProbeInput, STORE_PROBE_LIMITS, STORE_PROBE_SCHEMA } from './store_probe.mjs';
installPureGuards();

const ws = '/home/skutner/work/testExplorerFresh', store = `${ws}/.ploinky/deps/store`;
const object = H('obj').slice(0, 8) + '-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002', sha = H('commit-a').slice(0, 40), treeHash = H('tree');
const target = (extra = {}) => ({ label: 'primary', repoName: 'UcProbe', agentName: 'probe', alias: null, packageName: 'uc-moving-probe', markerFile: 'index.js', ...extra });
const input = (extra = {}) => ({ targets: [target()], objects: [], ...extra });
function build(mutate = () => {}) {
    const state = { containerId: H('c0'), tree: treeHash, objectId: object, receipts: 1 };
    mutate(state);
    const files = {
        [`${store}/objects/${state.objectId}/manifest.json`]: JSON.stringify({ tree: { hash: treeHash }, provenance: [{ name: 'uc-moving-probe', commit: sha, verification: 'remote-verified' }], resolution: { installer: { kind: 'container-npm' } } }),
        [`${store}/objects/${state.objectId}/payload/node_modules/.package-lock.json`]: JSON.stringify({ packages: { 'node_modules/uc-moving-probe': { resolved: `git+http://x/pkg.git#${state.lockCommit ?? sha}` } } }),
        [`${store}/objects/${state.objectId}/payload/node_modules/uc-moving-probe/package.json`]: JSON.stringify({ name: 'uc-moving-probe', version: '1.0.0' }),
        [`${store}/objects/${state.objectId}/payload/node_modules/uc-moving-probe/index.js`]: 'module.exports = { marker: "A" };\n',
        [`${store}/objects/${other}/manifest.json`]: JSON.stringify({ tree: { hash: H('other-tree') } }),
    };
    for (let index = 0; index < state.receipts; index++) files[`${store}/receipts/readers/r${index}.json`] = JSON.stringify({ objectId: state.objectId, generationId: H('generation'), consumer: { kind: 'container', key: 'container:ploinky_probe:inst-1:en-1' }, schema: 1 });
    files[`${store}/receipts/readers/unrelated.json`] = JSON.stringify({ objectId: other, consumer: { kind: 'container', key: 'container:ploinky_other:i:e' } });
    const io = createMemoryFs(files);
    const record = { type: 'agent', repoName: 'UcProbe', agentName: 'probe', runtime: 'podman', containerId: state.containerId, instanceId: 'inst-1', enableGeneration: 'en-1',
        dependencies: { schema: 1, mode: 'store', objectId: state.objectId, generationId: H('generation'), payloadPath: state.payloadPath ?? `${store}/objects/${state.objectId}/payload` }, ...state.record };
    const registry = { ploinky_probe: record }, calls = [];
    const apis = { readAgentRegistrySnapshot: options => { calls.push(['registry', options]); return state.registryAfter && calls.length > 1 ? state.registryAfter : registry; },
        hashInstalledTree: (root, options) => { calls.push(['tree', root, options]); if (state.treeThrows) throw new Error('PRIVATE'); return { hash: state.tree }; } };
    const inspect = ids => new Map(ids.map(id => [id, { id, name: state.name ?? 'ploinky_probe', running: state.running ?? true, startedAt: state.startedAt ?? '2026-10-04T12:00:00.5Z', imageId: H('img'), instanceId: state.rowInstance ?? 'inst-1', enableGeneration: 'en-1',
        mounts: state.mounts ?? [{ source: `${store}/objects/${state.objectId}/payload/node_modules`, destination: '/code/node_modules', readOnly: true }] }]));
    return { state, io, apis, inspect, registry, calls, run: (probeInput = input()) => runStoreProbe(probeInput, { workspaceRoot: ws, apis, io, inspect }) };
}
const fails = (promise, code) => assert.rejects(promise, error => error.code === code);

test('store probe projects exact object, provenance, lock, marker, receipt and mount facts without any mutator', async () => {
    const h = build(); const result = await h.run(input({ objects: [object, other] }));
    assert.deepEqual(Object.keys(result).sort(), ['objects', 'schema', 'targets', 'version']); assert.equal(result.schema, STORE_PROBE_SCHEMA);
    const [row] = result.targets;
    assert.deepEqual({ ...row, markerSha256: undefined }, { label: 'primary', containerName: 'ploinky_probe', runtimeId: H('c0'), startedAt: '2026-10-04T12:00:00.5Z', instanceId: 'inst-1', enableGeneration: 'en-1', running: true, labelsEqual: true, objectId: object, selectorId: H('generation'),
        version: '1.0.0', sourceCommit: sha, provenanceCommit: sha, lockCommit: sha, markerSha256: undefined, payloadSha256: treeHash, treeMatchesManifest: true, installerKind: 'container-npm', verification: 'remote-verified',
        readerReceipt: { runtimeId: H('c0'), instanceId: 'inst-1', enableGeneration: 'en-1', objectId: object }, receiptCount: 1, mountSource: `${store}/objects/${object}/payload/node_modules`, mountReadOnly: true });
    assert.equal(row.markerSha256.length, 64); assert.deepEqual(result.objects, [{ objectId: object, present: true, treeMatches: true, payloadSha256: treeHash }, { objectId: other, present: true, treeMatches: false, payloadSha256: H('other-tree') }]);
    assert.deepEqual(Object.keys(h.apis).sort(), ['hashInstalledTree', 'readAgentRegistrySnapshot']); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|http:|git\+/);
});

test('object presence is reported without error, and a missing target, record, tree or provenance refuses with a fixed code', async () => {
    const h = build(); const gone = '00000000-0000-4000-8000-0000000000ff';
    assert.deepEqual((await h.run({ targets: [], objects: [gone] })).objects, [{ objectId: gone, present: false, treeMatches: false, payloadSha256: null }]);
    await fails(build(s => { s.tree = H('changed'); }).run(), 'store-probe-object');
    await fails(build(s => { s.treeThrows = true; }).run(), 'store-probe-tree');
    await fails(build(s => { s.record = { dependencies: { mode: 'none' } }; }).run(), 'store-probe-record');
    await fails(build(s => { s.payloadPath = '/elsewhere'; }).run(), 'store-probe-record');
    await fails(build(s => { s.record = { containerId: 'short' }; }).run(), 'store-probe-missing');
    await fails(build(s => { s.record = { runtime: 'docker' }; }).run(), 'store-probe-record');
    await fails(build().run(input({ targets: [target({ agentName: 'absent' })] })), 'store-probe-missing');
    await fails(build().run(input({ targets: [target({ alias: 'a' })] })), 'store-probe-missing');
    await fails(build().run(input({ targets: [target({ packageName: 'other-package' })] })), 'store-probe-provenance');
    await fails(build().run(input({ targets: [target({ markerFile: 'absent.js' })] })), 'store-probe-marker');
    await fails(build(s => { s.lockCommit = 'not-a-commit'; }).run(), 'store-probe-lock');
});

test('receipt, mount and label evidence is exact: a duplicate or absent receipt and a writable or foreign mount are visible', async () => {
    assert.equal((await build(s => { s.receipts = 0; }).run()).targets[0].readerReceipt, null);
    const twice = (await build(s => { s.receipts = 2; }).run()).targets[0]; assert.equal(twice.readerReceipt, null); assert.equal(twice.receiptCount, 2);
    assert.equal((await build(s => { s.mounts = [{ source: `${store}/objects/${object}/payload/node_modules`, destination: '/code/node_modules', readOnly: false }]; }).run()).targets[0].mountReadOnly, false);
    assert.equal((await build(s => { s.mounts = [{ source: '/somewhere/else', destination: '/code/node_modules', readOnly: true }]; }).run()).targets[0].mountSource, null);
    const stopped = (await build(s => { s.running = false; }).run()).targets[0]; assert.equal(stopped.running, false);
    assert.equal((await build(s => { s.rowInstance = 'other'; }).run()).targets[0].labelsEqual, false);
    assert.equal((await build(s => { s.name = 'ploinky_other'; }).run()).targets[0].labelsEqual, false);
    await fails(build(s => { s.registryAfter = { ploinky_probe: { type: 'agent', repoName: 'UcProbe', agentName: 'probe', runtime: 'podman', containerId: H('c9'), instanceId: 'inst-1', enableGeneration: 'en-1', dependencies: { mode: 'store', objectId: s.objectId, generationId: H('generation') } } }; }).run(), 'store-probe-registry-changed');
});

test('probe input validation and public main refuse unknown, oversized or secret-bearing input', async () => {
    for (const bad of [null, {}, { targets: [], objects: [] }, { targets: [target({ extra: 1 })], objects: [] }, { targets: [target({ repoName: '../x' })], objects: [] }, { targets: [target({ markerFile: 'a/b' })], objects: [] },
        { targets: [], objects: ['not-an-id'] }, { targets: [target(), target()], objects: [] }, { targets: Array.from({ length: STORE_PROBE_LIMITS.targets + 1 }, (_, i) => target({ label: `t${i}` })), objects: [] }]) {
        assert.throws(() => validateStoreProbeInput(bad), error => error.code === 'store-probe-input');
    }
    const out = []; assert.equal(await storeProbeMain({ input: { bad: true }, workspaceRoot: ws, write: value => out.push(value), load: async () => ({}) }), 1); assert.equal(out[0].failure, 'store-probe-input');
    out.length = 0; assert.equal(await storeProbeMain({ input: input(), workspaceRoot: ws, write: value => out.push(value), load: async () => { throw new Error('PRIVATE-DETAIL'); } }), 1);
    assert.deepEqual(out, [{ schema: STORE_PROBE_SCHEMA, version: 1, failure: 'store-probe-failed' }]);
});

test('identity mode reports only runtime and object identity for graph runtimes, including those without a store object', async () => {
    const identity = { label: 'graph', repoName: 'UcProbe', agentName: 'probe', alias: null, packageName: null, markerFile: null };
    const h = build(); const [row] = (await h.run({ targets: [identity], objects: [] })).targets;
    assert.deepEqual(row, { label: 'graph', containerName: 'ploinky_probe', runtimeId: H('c0'), instanceId: 'inst-1', enableGeneration: 'en-1', running: true, labelsEqual: true,
        objectId: object, selectorId: H('generation'), payloadSha256: treeHash, storeMode: 'store' });
    const none = build(s => { s.record = { dependencies: { schema: 1, mode: 'none', reason: 'no-dependencies' } }; });
    assert.deepEqual((await none.run({ targets: [identity], objects: [] })).targets[0], { label: 'graph', containerName: 'ploinky_probe', runtimeId: H('c0'), instanceId: 'inst-1', enableGeneration: 'en-1', running: true, labelsEqual: true,
        objectId: null, selectorId: null, payloadSha256: null, storeMode: 'none' });
    await fails(build().run({ targets: [{ ...identity, markerFile: 'index.js' }], objects: [] }), 'store-probe-input');
    await fails(build(s => { s.tree = H('changed'); }).run({ targets: [identity], objects: [] }), 'store-probe-object');
    await fails(build().run({ targets: [{ ...target(), packageName: 'uc-moving-probe' }], objects: [] }).then(() => build(s => { s.record = { dependencies: { mode: 'none' } }; }).run()), 'store-probe-record');
});
