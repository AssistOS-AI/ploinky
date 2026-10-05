import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestFixture, installPureGuards } from './test_support_codex.mjs';
import { validateManifest, parseManifestBytes, parseAcceptanceArguments, LIMITS } from './manifest_codex.mjs';
installPureGuards();
test('complete qualified data is admitted purely without claiming physical qualification', () => {
    const { value, nowMs } = manifestFixture(); assert.equal(validateManifest(value, { nowMs }), value);
    assert.deepEqual(parseManifestBytes(Buffer.from(JSON.stringify(value)), { nowMs }), value);
});
test('fixed argc/mode and absolute normalized _codex JSON path reject individual flags before reads', () => {
    assert.equal(parseAcceptanceArguments(['--acceptance', '/owned/manifest_codex.json']).manifestPath, '/owned/manifest_codex.json');
    for (const args of [[], ['--skip', '/owned/manifest_codex.json'], ['--acceptance', 'manifest_codex.json'], ['--acceptance', '/owned/manifest.json'],
        ['--acceptance', '/owned/../manifest_codex.json'], ['--acceptance', '/owned/manifest_codex.json', '--skip-U5']]) assert.throws(() => parseAcceptanceArguments(args));
});
test('unknown/missing fields, placeholder identities, uniform fake pins and omitted mandatory stages refuse', () => {
    for (const mutate of [v => { v.extra = true; }, v => { delete v.graph; }, v => { v.host.hostname = 'pending'; }, v => { v.box.imageId = '0'.repeat(64); },
        v => { v.phases.splice(5, 1); }, v => { v.limits.commandMs++; }, v => { v.grant.testingResumeAuthorized = false; }, v => { v.epochs.release.freshRequired = false; }]) {
        const { value } = manifestFixture(); mutate(value); assert.throws(() => validateManifest(value));
    }
});
test('unpushed/source-map/default fallback laundering, writable source and third publication refuse', () => {
    for (const mutate of [v => { v.candidate.pushedCommit = '0'.repeat(40); }, v => { v.candidate.repositories[0].commit = v.candidate.repositories[1].commit; },
        v => { v.candidate.repositories[1].branch = 'other'; v.candidate.repositories[1].upstream = 'origin/other'; },
        v => { v.sourceMounts[0].readOnly = false; }, v => { v.publications.push({}); }, v => { v.engine.rootless = false; }, v => { v.agentLib.commit = v.candidate.commit; }]) {
        const { value } = manifestFixture(); mutate(value); assert.throws(() => validateManifest(value));
    }
});
test('qualified endpoint, exact engine/boot, declared no-wait and private evidence boundaries cannot be replaced', () => {
    for (const mutate of [v => { v.fixtureEndpoint.bindIP = '0.0.0.0'; }, v => { v.fixtureEndpoint.engineIdentity = v.box.id; }, v => { v.fixtureEndpoint.pullPolicy = 'always'; },
        v => { v.graph[0].noWait = true; }, v => { v.grant.boot = '11111111-2222-3333-4444-555555555555'; },
        v => { v.evidence.root = '/home/skutner/.codex'; }, v => { v.graph[0].name = 'AssistOSExplorer/gptresearcher'; }]) {
        const { value } = manifestFixture(); mutate(value); assert.throws(() => validateManifest(value));
    }
});
test('JSON duplicate and escaped duplicate keys, invalid UTF8 and byte overflow refuse', () => {
    const { value } = manifestFixture(), json = JSON.stringify(value);
    for (const text of [json.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'), json.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1')]) {
        assert.throws(() => parseManifestBytes(Buffer.from(text)), error => error.code === 'manifest-duplicate-key');
    }
    assert.throws(() => parseManifestBytes(Buffer.from([0xff])), error => error.code === 'manifest-json');
    assert.throws(() => parseManifestBytes(Buffer.alloc(LIMITS.manifestBytes + 1)), error => error.code === 'manifest-byte-limit');
});
