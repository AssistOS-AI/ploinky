import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { manifestFixture, expectationFixture, installPureGuards } from './test_support_codex.mjs';
import { createMemoryFs } from './fake_fs_support_codex.mjs';
import { parseInputs, loadInputs, inputsPath } from './inputs_codex.mjs';
installPureGuards();

const image = `docker.io/library/node@sha256:${'a'.repeat(64)}`;
function good() {
    const { value: manifest } = manifestFixture(), { expected } = expectationFixture(manifest);
    const value = { schemaVersion: 1, runId: manifest.runId, probeAgentImage: image, releaseManifest: '/home/skutner/work/release/manifest_codex.json', expectedUpdates: { 'normal-update': expected, 'settling-update': expected } };
    return { manifest, value, bytes: () => Buffer.from(JSON.stringify(value)) };
}

test('inputs bind one run, a digest-pinned probe image, an outside release manifest and exact expectations', () => {
    const h = good(); const inputs = parseInputs(h.bytes(), h.manifest);
    assert.equal(inputs.probeAgentImage, image); assert.deepEqual(Object.keys(inputs.expectedUpdates), ['normal-update', 'settling-update']);
    const mutate = fn => { const copy = good(); fn(copy.value, copy.manifest); return () => parseInputs(copy.bytes(), copy.manifest); };
    for (const [label, change] of [['other run', v => { v.runId = 'other'; }], ['floating image tag', v => { v.probeAgentImage = 'docker.io/library/node:latest'; }], ['uppercase digest', v => { v.probeAgentImage = `x@sha256:${'A'.repeat(64)}`; }],
        ['relative release manifest', v => { v.releaseManifest = 'release.json'; }], ['release manifest inside the workspace', (v, m) => { v.releaseManifest = `${m.workspace.path}/release.json`; }],
        ['release manifest inside the candidate', (v, m) => { v.releaseManifest = `${m.candidate.root}/release.json`; }], ['extra field', v => { v.extra = 1; }], ['missing operation', v => { delete v.expectedUpdates['settling-update']; }],
        ['extra operation', v => { v.expectedUpdates['optional-negative'] = v.expectedUpdates['normal-update']; }], ['malformed record id', v => { v.expectedUpdates['normal-update'] = { errors: [], blockedBy: [], recordIds: ['bad id with spaces'] }; }], ['control character in a record id', v => { v.expectedUpdates['normal-update'] = { errors: [], blockedBy: [], recordIds: ['PRIVATE\nid'] }; }],
        ['schema version', v => { v.schemaVersion = 2; }]]) assert.throws(mutate(change), error => /acceptance-inputs|update-expectation|manifest-schema/.test(error.code), label);
});

test('the operator file is shape-checked only; the observed vocabulary decides at update time', () => {
    const h = good(); h.value.expectedUpdates['normal-update'] = { errors: [], blockedBy: [], recordIds: ['workspace-graph', 'SomeDeployedRepo', 'a'.repeat(64)] };
    assert.doesNotThrow(() => parseInputs(h.bytes(), h.manifest), 'ids not known before the live observation are not refused at load');
});

test('a missing, oversized, group-writable or foreign file refuses before any mutation', () => {
    const h = good(); const file = inputsPath(h.manifest); assert.equal(file, path.join(h.manifest.evidence.root, 'inputs_codex.json'));
    assert.throws(() => loadInputs(h.manifest, createMemoryFs({})), error => error.code === 'acceptance-inputs-missing');
    const present = createMemoryFs({ [file]: h.bytes() }); assert.equal(loadInputs(h.manifest, present).probeAgentImage, image);
    const loose = { ...present, fstatSync: fd => ({ ...present.fstatSync(fd), mode: 0o100666 }) }; assert.throws(() => loadInputs(h.manifest, loose), error => error.code === 'acceptance-inputs-missing');
    assert.throws(() => loadInputs(h.manifest, createMemoryFs({ [file]: Buffer.alloc(300000, 32) })), error => error.code === 'acceptance-inputs-missing');
    assert.throws(() => loadInputs(h.manifest, createMemoryFs({ [file]: Buffer.from('not json') })), error => error.code === 'manifest-json');
});
