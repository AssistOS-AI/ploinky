import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { manifestFixture, installPureGuards, H } from './test_support.mjs';
import { createMemoryFs } from './fake_fs_support.mjs';
import { createFakeHost } from './fake_host_support.mjs';
import { applicationMarker } from './application_marker.mjs';
import { createMarkerFiles } from './marker_files.mjs';
import { createCleanupPort } from './cleanup_port.mjs';
import { createNegativePort, validateObservations } from './negative_port.mjs';
import { fixtureNames } from './git_fixture.mjs';
installPureGuards();

const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('marker storage observer reports bounded identity and removal requires the exact created file', async () => {
    const { value: manifest } = manifestFixture(), marker = applicationMarker(manifest), fs = createMemoryFs({ [marker.workspacePath]: marker.bytes }), files = createMarkerFiles({ manifest, io: { ...fs, openSync: name => fs.openSync(name) } });
    assert.deepEqual(await files.readMarker({ ...marker, workspacePath: marker.workspacePath + '.absent' }), { exists: false });
    const row = await files.readMarker(marker); assert.equal(row.exists, true); assert.equal(row.sha256, marker.sha256); assert.equal(row.boxId, manifest.box.id); assert.equal(row.links, 1); assert.equal(row.bytes, marker.bytes.length);
    assert.throws(() => files.remove(marker), error => error.code === 'marker-not-owned');
    files.retainMarker({ ...marker, bytes: marker.bytes.length, identity: row.identity });
    fs.replaceInode(marker.workspacePath); assert.throws(() => files.remove(marker), error => error.code === 'marker-ownership-changed');
    const same = createMemoryFs({ [marker.workspacePath]: marker.bytes }), ok = createMarkerFiles({ manifest, io: same }); const identity = (await ok.readMarker(marker)).identity;
    ok.retainMarker({ ...marker, bytes: marker.bytes.length, identity }); same.overrideLinks.set(marker.workspacePath, 2); assert.throws(() => ok.remove(marker), error => error.code === 'marker-ownership-changed'); same.overrideLinks.delete(marker.workspacePath);
    same.setFile(marker.workspacePath, Buffer.concat([marker.bytes, Buffer.from('x')])); assert.throws(() => ok.remove(marker), error => error.code === 'marker-ownership-changed');
    same.setFile(marker.workspacePath, marker.bytes); assert.equal(ok.remove(marker), 'removed'); assert.equal(same.files.has(marker.workspacePath), false); assert.equal(ok.remove(marker), 'absent');
    same.setFile(marker.workspacePath, Buffer.alloc(5000)); await assert.rejects(ok.readMarker(marker), error => error.code === 'marker-shape');
});

function cleanupHarness({ source = 'url', registered = true, remains = false, leaves = null } = {}) {
    const { value: manifest } = manifestFixture(), names = fixtureNames(manifest.runId), marker = applicationMarker(manifest), calls = [];
    const sourcesFile = `${manifest.workspace.path}/.ploinky/repo_sources.json`, repoDir = `${manifest.workspace.path}/.ploinky/repos/${names.repoName}`;
    const fs = createMemoryFs({ [sourcesFile]: source === 'none' ? '{}' : JSON.stringify({ [names.repoName]: source === 'url' ? 'http://x/agent' : { url: source === 'object' ? 'http://x/agent' : 'http://other/agent' }, unrelated: 'http://keep' }), [`${repoDir}/manifest.json`]: '{}', [marker.workspacePath]: marker.bytes });
    const cache = { cli: async (operation, args) => { calls.push(['cli', args]); if (!remains) { if (leaves !== 'source') fs.setFile(sourcesFile, JSON.stringify({ unrelated: 'http://keep' })); if (leaves !== 'directory') fs.unlinkSync(`${repoDir}/manifest.json`); } return { code: 0 }; } };
    const fixture = { agentUrl: 'http://x/agent', cleanup: async ({ writersQuiescent }) => { calls.push(['fixture', writersQuiescent]); return { server: 'removed', files: 'removed' }; } };
    const markerFiles = { remove: value => { calls.push(['marker', value.name]); return 'removed'; } };
    const port = createCleanupPort({ manifest, cache, fixture, markerFiles, marker, io: { ...fs } });
    return { port, names, calls, fs, state: { registered }, sourcesFile };
}

test('cleanup removes only the exact owned repository key, server, files and marker in order and only while quiescent', async () => {
    const h = cleanupHarness(); const result = await h.port.run({ writersQuiescent: true, names: h.names, state: h.state });
    assert.deepEqual(result, { repository: 'uninstalled', server: 'removed', files: 'removed', marker: 'removed' }); assert.deepEqual(h.calls.map(call => call[0]), ['cli', 'fixture', 'marker']);
    assert.deepEqual(h.calls[0][1], ['uninstall', 'repo', h.names.repoName]); assert.equal(h.state.registered, false);
    assert.deepEqual(JSON.parse(h.fs.files.get(h.sourcesFile)), { unrelated: 'http://keep' }, 'unrelated source keys are untouched');
    const object = cleanupHarness({ source: 'object' }); assert.equal((await object.port.run({ writersQuiescent: true, names: object.names, state: object.state })).repository, 'uninstalled');
    const none = cleanupHarness({ source: 'none' }); assert.equal((await none.port.run({ writersQuiescent: true, names: none.names, state: none.state })).repository, 'absent'); assert.equal(none.calls.some(call => call[0] === 'cli'), false);
    const unregistered = cleanupHarness({ registered: false }); assert.equal((await unregistered.port.run({ writersQuiescent: true, names: unregistered.names, state: unregistered.state })).repository, 'absent');
});

test('cleanup refuses an unquiescent run, a same-name replacement key and an uninstall that left residue', async () => {
    const dirty = cleanupHarness(); await rejects(dirty.port.run({ writersQuiescent: false, names: dirty.names, state: dirty.state }), 'cleanup-not-quiescent'); assert.deepEqual(dirty.calls, []);
    const foreign = cleanupHarness({ source: 'foreign' }); await rejects(foreign.port.run({ writersQuiescent: true, names: foreign.names, state: foreign.state }), 'cleanup-repository-not-owned'); assert.deepEqual(foreign.calls, []);
    for (const leaves of ['source', 'directory']) { const partial = cleanupHarness({ leaves }); await rejects(partial.port.run({ writersQuiescent: true, names: partial.names, state: partial.state }), 'cleanup-repository-remains'); assert.equal(partial.calls.some(call => call[0] === 'fixture'), false); }
    const residue = cleanupHarness({ remains: true }); await rejects(residue.port.run({ writersQuiescent: true, names: residue.names, state: residue.state }), 'cleanup-repository-remains'); assert.equal(residue.calls.some(call => call[0] === 'fixture' || call[0] === 'marker'), false);
});

function negativeHarness(mutate = () => {}) {
    const { value: manifest } = manifestFixture(), evidence = manifest.evidence.root; const fs = createMemoryFs({}), generation = 'gen-1';
    const good = { runId: manifest.runId, workspace: manifest.workspace.path, result: 'passed', coverage: 'continuation-only', cleanup: { result: 'passed' },
        passes: { 'optional-errors': { exitCode: 1, generation: { before: generation, after: 'gen-2', graphReady: true } }, 'unknown-required-scope': { exitCode: 1, generation: { before: 'gen-2', after: 'gen-2', pendingActivation: true }, pendingActivation: { reason: 'PRIVATE' } } } };
    mutate(good, fs, manifest);
    const obsPath = path.join(evidence, 'continuation', 'observations_codex.json'); fs.setFile(obsPath, JSON.stringify(good));
    const host = createFakeHost([{ match: () => true, reply: () => ({ code: 0 }) }]);
    const port = createNegativePort({ manifest, manifestPath: path.join(evidence, 'manifest_codex.json'), deps: host.deps, env: { PATH: '/usr/bin' }, io: { ...fs, openSync: name => fs.openSync(name) } });
    return { port, host, manifest, fs, good, generation };
}

test('U6 launches the tightened runner once with exact arguments and projects only validated public evidence', async () => {
    const h = negativeHarness(); const evidence = await h.port.run({ generation: h.generation, check() {} });
    assert.deepEqual(evidence, { phase: 'U6', optional: { exit: 1, activation: 'restarted', graphReady: true, generationChanged: true }, required: { exit: 1, activation: 'deferred', generationPreserved: true, pendingActivation: true }, cleanup: 'passed', coverage: 'continuation-only' });
    const [launch] = h.host.log; assert.equal(launch.bin, h.manifest.host.node.path); assert.deepEqual(launch.args, [path.join(h.manifest.candidate.root, 'tests/e2e/updateContinueOnError/run.mjs'), '--workspace', h.manifest.workspace.path,
        '--manifest', path.join(h.manifest.evidence.root, 'manifest_codex.json'), '--artifacts', path.join(h.manifest.evidence.root, 'continuation'), '--ploinky', h.manifest.candidate.cliPath, '--generation', h.generation]);
    assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE/); await rejects(h.port.run({ generation: h.generation, check() {} }), 'negative-already-run');
    for (const bad of [undefined, '', 'has space', 'a\nb']) { const fresh = negativeHarness(); await rejects(fresh.port.run({ generation: bad, check() {} }), 'negative-already-run'); assert.equal(fresh.host.log.length, 0, 'no runner launches without an admitted generation'); }
});

test('U6 rejects a continuation record that is not a passed, restarted, then deferred, truthful pair', async () => {
    const mutants = [['failed result', g => { g.result = 'failed'; }, 'continuation-observations'], ['other run', g => { g.runId = 'other'; }, 'continuation-observations'], ['uncleaned', g => { g.cleanup.result = 'failed'; }, 'continuation-observations'],
        ['coverage claim', g => { g.coverage = 'whole'; }, 'continuation-observations'], ['optional exit 0', g => { g.passes['optional-errors'].exitCode = 0; }, 'continuation-exit'],
        ['required exit 0', g => { g.passes['unknown-required-scope'].exitCode = 0; }, 'continuation-exit'], ['pass missing', g => { delete g.passes['unknown-required-scope']; }, 'continuation-exit'],
        ['uncertain', g => { g.passes['optional-errors'].uncertain = true; }, 'continuation-exit'], ['no restart', g => { g.passes['optional-errors'].generation.after = 'gen-1'; }, 'continuation-optional-activation'],
        ['graph not ready', g => { g.passes['optional-errors'].generation.graphReady = false; }, 'continuation-optional-activation'], ['wrong baseline', g => { g.passes['optional-errors'].generation.before = 'gen-0'; }, 'continuation-optional-activation'],
        ['generation moved on deferral', g => { g.passes['unknown-required-scope'].generation.after = 'gen-3'; }, 'continuation-required-deferral'], ['no pending', g => { g.passes['unknown-required-scope'].generation.pendingActivation = false; }, 'continuation-required-deferral']];
    for (const [label, mutate, code] of mutants) { const h = negativeHarness(mutate); await assert.rejects(h.port.run({ generation: h.generation, check() {} }), error => error.code === code, label); }
    const none = negativeHarness(); none.fs.unlinkSync(path.join(none.manifest.evidence.root, 'continuation', 'observations_codex.json')); await rejects(none.port.run({ generation: none.generation, check() {} }), 'continuation-observations');
    assert.throws(() => validateObservations(null, negativeHarness().manifest), error => error.code === 'continuation-observations');
});

test('U6 restoration proof refuses a remaining scenario folder, source folder or fixture checkout and requires a prior run', async () => {
    const h = negativeHarness(); await rejects(h.port.restore({ writersQuiescent: true }), 'negative-restore-refused');
    await h.port.run({ generation: h.generation, check() {} }); await rejects(h.port.restore({ writersQuiescent: false }), 'negative-restore-refused');
    const ws = h.manifest.workspace.path, runId = h.manifest.runId;
    await rejects(h.port.restore({ writersQuiescent: true }), 'negative-restore-unknown');            // no repositories directory is itself unprovable
    h.fs.setFile(`${ws}/.ploinky/repos/keep/manifest.json`, '{}'); assert.equal(await h.port.restore({ writersQuiescent: true }), true);
    for (const leftover of [`${h.manifest.negativeScopes.optional}/90-good/ploinky-skills-manifest.json`, `${ws}/.update-e2e-${runId}/advance/tracked.txt`, `${ws}/.ploinky/repos/AAUpdateE2E4-collision-${runId}/incoming.txt`]) {
        h.fs.setFile(leftover, 'x'); await rejects(h.port.restore({ writersQuiescent: true }), 'negative-fixture-remains'); h.fs.unlinkSync(leftover);
    }
    assert.equal(await h.port.restore({ writersQuiescent: true }), true);
});
