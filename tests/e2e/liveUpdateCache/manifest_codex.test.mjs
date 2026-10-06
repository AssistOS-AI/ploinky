import test from 'node:test';
import assert from 'node:assert/strict';
import { generationManifest, manifestFixture, installPureGuards } from './test_support_codex.mjs';
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
test('the Box carries its exact container name and image reference: missing, ID-shaped, malformed or extra values refuse', () => {
    const { value: good } = manifestFixture(); assert.match(good.box.name, /^ploinky-box-[a-z0-9][a-z0-9-]{0,200}$/); validateManifest(structuredClone(good));
    const edge = structuredClone(good); edge.box.name = `ploinky-box-${'a'.repeat(201)}`; validateManifest(edge);
    for (const mutate of [v => { delete v.box.name; }, v => { v.box.name = v.box.id; }, v => { v.box.name = `/${good.box.name}`; }, v => { v.box.name = 'ploinky-box-'; }, v => { v.box.name = 'ploinky-box--x'; },
        v => { v.box.name = good.box.name.toUpperCase(); }, v => { v.box.name = `${good.box.name}\n`; }, v => { v.box.name = `ploinky-box-${'a'.repeat(202)}`; }, v => { v.box.name = 'testExplorerFresh'; }, v => { v.box.name = null; },
        v => { delete v.box.imageRef; }, v => { v.box.imageRef = ''; }, v => { v.box.imageRef = 'x y'; }, v => { v.box.imageRef = 5; }, v => { v.box.extra = 'x'; }]) {
        const { value } = manifestFixture(); mutate(value); assert.throws(() => validateManifest(value), error => error.code === 'manifest-schema' || error.code === 'live-inputs');
    }
});
test('the two-generation release schema: evidence files, generations, activation parameters and the optional-runtime declaration are exact', () => {
    const { value: good } = manifestFixture(); assert.equal(good.activation, null); validateManifest(structuredClone(good));
    const declared = structuredClone(good); declared.activation = structuredClone(generationManifest(good, 'R2').activation); validateManifest(declared);
    const refuse = (mutate, label) => { const { value } = manifestFixture(); mutate(value); assert.throws(() => validateManifest(value), error => /^[a-z][a-z0-9-]+$/.test(error.code), label); };
    for (const [label, mutate] of [['no release2 evidence file', v => { delete v.evidence.release2; }], ['no release1Record evidence file', v => { delete v.evidence.release1Record; }], ['release2 equals release', v => { v.evidence.release2 = v.evidence.release; }],
        ['release1Record equals functional', v => { v.evidence.release1Record = v.evidence.functional; }], ['release1Record outside the root', v => { v.evidence.release1Record = '/home/skutner/work/other/release1_codex.json'; }],
        ['no generations', v => { delete v.epochs.release.generations; }], ['a third generation', v => { v.epochs.release.generations.push({ id: 'R3', gates: [] }); }], ['Copilot moved to R2', v => { v.epochs.release.generations[0].gates = []; v.epochs.release.generations[1].gates.unshift('Copilot'); }],
        ['R1 activated', v => { v.epochs.release.generations[0].activation = true; }], ['another activation command', v => { v.epochs.release.activation.command = ['npm', 'test']; }], ['a wider activation guard', v => { v.epochs.release.activation.guardMs = 600000; }],
        ['a longer install deadline', v => { v.epochs.release.activation.install.deadlineMs = 240000; }], ['no activation key', v => { delete v.activation; }], ['activation is an object', v => { v.activation = {}; }], ['two declared runtimes', v => { v.activation = structuredClone(generationManifest(v, 'R2').activation).slice(0, 2); }],
        ['four declared runtimes', v => { v.activation = [...structuredClone(generationManifest(v, 'R2').activation), { ...structuredClone(generationManifest(v, 'R2').activation[0]), name: 'AssistOSExplorer/extra' }]; }],
        ['an undeclared agent', v => { v.activation = structuredClone(generationManifest(v, 'R2').activation); v.activation[2].name = 'AssistOSExplorer/other'; }], ['a declared runtime already in the default graph', v => { v.activation = structuredClone(generationManifest(v, 'R2').activation); v.activation[0].name = v.graph[0].name; }],
        ['a duplicate declared runtime', v => { v.activation = structuredClone(generationManifest(v, 'R2').activation); v.activation[1].name = v.activation[0].name; }], ['an unknown repository', v => { v.activation = structuredClone(generationManifest(v, 'R2').activation); v.activation[0].repository = 'Elsewhere'; }],
        ['an extra key on a declaration', v => { v.activation = structuredClone(generationManifest(v, 'R2').activation); v.activation[0].extra = 1; }], ['a no-wait mismatch', v => { v.activation = structuredClone(generationManifest(v, 'R2').activation); v.activation[0].noWait = true; }]]) refuse(mutate, label);
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
