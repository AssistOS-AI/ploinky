import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMemoryFs } from './fake_fs_support_codex.mjs';
import { runPinProbe, pinProbeMain, PIN_PROBE_SCHEMA, PIN_PROBE_LIMITS } from './pin_probe_codex.mjs';
import { ownedRegistration } from './owned_ids_codex.mjs';
import { pinIdFor } from '../../../cli/utils/dependencies/store/gitPins.mjs';

const spawnSync = cp.spawnSync;
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../../..');
const ws = '/home/skutner/work/testExplorerFresh';
const fails = (promise, code) => assert.rejects(promise, error => error.code === code);

function fakeApis({ records = [], registry = {}, onRefresh = () => {}, refreshThrows = false, registryThrows = false } = {}) {
    const calls = [];
    return { calls, refreshUpdateGitPins: async (args, deps) => { calls.push({ args, deps }); onRefresh(args, deps); if (refreshThrows) throw new Error('PRIVATE'); return { records }; },
        readAgentRegistrySnapshot: () => { if (registryThrows) throw new Error('PRIVATE'); return registry; } };
}

test('the probe asks the product for every enabled registration offline, through a read-only pin view, and returns only public ids', async () => {
    const io = createMemoryFs({ [`${ws}/.ploinky/deps/store/state/pins.json`]: JSON.stringify({ pins: { stale: { binding: { scope: 'global' } } } }), [`${ws}/.ploinky/repo_sources.json`]: JSON.stringify({ SourceOnly: 'http://x' }),
        [`${ws}/.ploinky/repos/OnDisk/manifest.json`]: '{}' });
    const registry = { ploinky_A_a: { type: 'agent', repoName: 'RepoA', agentName: 'a' }, ploinky_B_b: { type: 'agent', repoName: 'RepoB', agentName: 'b' }, _config: { type: 'config' }, plain: { type: 'other' } };
    const apis = fakeApis({ registry, records: [{ phase: 'git-pin', id: 'f'.repeat(64) }, { phase: 'git-pin', id: 'ploinky_B_b' }, { phase: 'registered-repository', id: 'IgnoredBecauseNotGitPin' }, { phase: 'git-pin', id: 'f'.repeat(64) }] });
    const document = await runPinProbe({}, { workspaceRoot: ws, apis, io });
    assert.deepEqual(document, { schema: PIN_PROBE_SCHEMA, version: 1, gitPinRecordIds: ['f'.repeat(64), 'ploinky_B_b'].sort(), registrations: ['ploinky_A_a', 'ploinky_B_b'], repositories: ['OnDisk', 'RepoA', 'RepoB', 'SourceOnly'] });
    const [{ args, deps }] = apis.calls; assert.deepEqual(args, { repositoryNames: null, sourceOutcomes: null });
    assert.deepEqual(deps.store.readPins(), { pins: { stale: { binding: { scope: 'global' } } } }); assert.equal(deps.store.updatePins('lease', () => ({})), undefined, 'the pin store is read-only');
    const discovered = deps.discover([{ pinId: 'p'.repeat(64) }], { unsupported: [{ pinId: 'u'.repeat(64) }] }); assert.equal(discovered.queriesRun, 0); assert.deepEqual(discovered.results.map(row => row.status), ['unsupported', 'fixed']);
    assert.equal(deps.withLease({}, lease => lease), null, 'no lease is taken');
    assert.doesNotMatch(JSON.stringify(document), /PRIVATE|http:/);
});

test('failures and oversized or malformed inputs refuse with fixed codes', async () => {
    const io = createMemoryFs({ [`${ws}/.ploinky/x`]: '' });
    await fails(runPinProbe({}, { workspaceRoot: ws, apis: fakeApis({ refreshThrows: true }), io }), 'pin-probe-refresh');
    await fails(runPinProbe({}, { workspaceRoot: ws, apis: { refreshUpdateGitPins: async () => ({}), readAgentRegistrySnapshot: () => ({}) }, io }), 'pin-probe-refresh');
    await fails(runPinProbe({}, { workspaceRoot: ws, apis: fakeApis({ registryThrows: true }), io }), 'pin-probe-registry');
    await fails(runPinProbe({ extra: 1 }, { workspaceRoot: ws, apis: fakeApis(), io }), 'pin-probe-input'); await fails(runPinProbe({}, { workspaceRoot: 'relative', apis: fakeApis(), io }), 'pin-probe-input');
    await fails(runPinProbe({}, { workspaceRoot: ws, apis: fakeApis(), io: createMemoryFs({ [`${ws}/.ploinky/deps/store/state/pins.json`]: 'not json' }) }), 'pin-probe-pins');
    await fails(runPinProbe({}, { workspaceRoot: ws, apis: fakeApis(), io: createMemoryFs({ [`${ws}/.ploinky/repo_sources.json`]: '{bad' }) }), 'pin-probe-sources');
    await fails(runPinProbe({}, { workspaceRoot: ws, apis: fakeApis(), io: createMemoryFs({ [`${ws}/.ploinky/deps/store/state/pins.json`]: Buffer.alloc(PIN_PROBE_LIMITS.pinsBytes + 1, 32) }) }), 'pin-probe-pins');
    await fails(runPinProbe({}, { workspaceRoot: ws, apis: fakeApis({ records: [{ phase: 'git-pin', id: 'bad id' }] }), io }), 'pin-probe-bound');
    const out = []; assert.equal(await pinProbeMain({ input: {}, workspaceRoot: ws, write: value => out.push(value), load: async () => { throw new Error('PRIVATE-IMPORT'); } }), 1);
    assert.deepEqual(out, [{ schema: PIN_PROBE_SCHEMA, version: 1, failure: 'pin-probe-failed' }]);
});

const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'uc-pins-'));
after(() => fs.rmSync(parent, { recursive: true, force: true }));
test('against the product\'s own pin refresh, the probe returns the owned pin and a non-owned graph agent\'s pin exactly as the product derives them', () => {
    const workspace = path.join(parent, 'testExplorerFresh'); fs.mkdirSync(path.join(workspace, '.ploinky', 'repos'), { recursive: true });
    const script = path.join(parent, 'real.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs'; import path from 'node:path';
const ws = process.env.PLOINKY_WORKSPACE_ROOT, root = ${JSON.stringify(root)};
const { getAgentContainerName } = await import(root + '/cli/sandbox/docker/common.js');
const { runPinProbe, loadPinApis } = await import(root + '/tests/e2e/liveUpdateCache/pin_probe_codex.mjs');
const make = (repo, agent, deps) => { const dir = path.join(ws, '.ploinky/repos', repo, agent); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ container: 'x', agent: 'node /code/a.mjs', readiness: { protocol: 'tcp' } })); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: agent, version: '1.0.0', dependencies: deps })); };
make('UcProbeabcdef12', 'probe', { 'uc-probe-abcdef12': 'git+http://10.0.2.2:18080/r/pkg.git#refs/heads/main' });
make('AssistOSExplorer', 'soplangAgent', { soplang: 'git+https://github.com/AssistOS-AI/soplang.git' });
fs.writeFileSync(path.join(ws, '.ploinky/agents.json'), JSON.stringify({ [getAgentContainerName('probe', 'UcProbeabcdef12')]: { type: 'agent', repoName: 'UcProbeabcdef12', agentName: 'probe', profile: 'default', runtime: 'podman' },
    [getAgentContainerName('soplangAgent', 'AssistOSExplorer')]: { type: 'agent', repoName: 'AssistOSExplorer', agentName: 'soplangAgent', profile: 'default', runtime: 'podman' } }));
const real = await loadPinApis(root);
// Only the Box-supplied SDK bundle and global package, which exist only inside a Box, are stubbed; everything else is the product's.
const apis = { readAgentRegistrySnapshot: real.readAgentRegistrySnapshot, refreshUpdateGitPins: (args, deps) => real.refreshUpdateGitPins(args, { ...deps, readSdkBundle: () => null, readGlobalPackage: () => ({}) }) };
console.log(JSON.stringify({ document: await runPinProbe({}, { workspaceRoot: ws, apis }), containers: Object.keys(JSON.parse(fs.readFileSync(path.join(ws, '.ploinky/agents.json'), 'utf8'))) }));
`);
    const result = spawnSync(process.execPath, [script], { cwd: workspace, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: parent, LC_ALL: 'C', PLOINKY_WORKSPACE_ROOT: workspace, PLOINKY_AGENTLIB_DIR: process.env.PLOINKY_AGENTLIB_DIR ?? '' } });
    assert.equal(result.status, 0, result.stderr); const { document, containers } = JSON.parse(result.stdout.trim().split('\n').at(-1));
    const manifest = { runId: 'update-cache-20261004T120000Z-abcdef12_codex', workspace: { path: workspace } }, owned = ownedRegistration(manifest);
    const soplangContainer = containers.find(name => name.includes('soplangAgent')), soplangPin = pinIdFor({ scope: 'registration', registration: soplangContainer, packageSource: '.ploinky/repos/AssistOSExplorer/soplangAgent/package.json' }, 'dependencies', 'soplang');
    assert.ok(containers.includes(owned.containerName), 'the derived registration name is the product\'s'); assert.deepEqual(document.gitPinRecordIds, [owned.pinId, soplangPin].sort(), 'the owned pin and the non-owned graph pin');
    assert.deepEqual(document.registrations, containers.slice().sort()); assert.deepEqual(document.repositories, ['AssistOSExplorer', 'UcProbeabcdef12']);
    assert.equal(fs.existsSync(path.join(workspace, '.ploinky', 'deps')), false, 'the probe wrote no dependency-store state');
});
