import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestFixture, installPureGuards, OPTIONAL_GRAPH, H } from './test_support.mjs';
import { createFakeHost } from './fake_host_support.mjs';
import { createMemoryFs } from './fake_fs_support.mjs';
import { createReleaseManifestWriter, WRITER_BUDGET_MS } from './release_manifest_writer.mjs';
import { parseManifestBytes, validateManifest } from './manifest.mjs';
import { engineIdentityOf, gpuWiringIdentityOf, BOX_LABEL_KEYS, BOX_IDENTITY_FORMAT, IMAGE_INSPECT_FORMAT, boxIdentityArgs, parseBoxIdentity, imageInspectArgs, parseImageInspect } from './engine.mjs';
import { runOwnedCommand } from './host_command.mjs';
installPureGuards();

const codeIs = code => error => error.code === code;
const uid = 1000, info = { rootless: true, version: '5.2.0', graphRoot: '/home/skutner/.local/share/containers/storage', runRoot: '/run/user/1000/containers' };
const lines = rows => rows.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
const BOX_ID = H('release-box'), BOX_NAME = 'ploinky-box-testexplorerfresh-7f7f7f7f7f7f', GRANT = H('grant-fingerprint'), IMAGE_REF = 'docker.io/assistos/ploinky-box:candidate-20261004';
const GRANT_WINDOW = base => ({ target: base.grant.target, operation: base.grant.operation, boot: base.grant.boot, issuedAtMs: base.grant.issuedAtMs, startsAtMs: base.grant.startsAtMs, endsAtMs: base.grant.endsAtMs + 3600000, operationStartedMonoMs: 1000,
    reviewSha256: base.grant.reviewSha256, nativeCheckpointSha256: base.grant.nativeCheckpointSha256, jointCheckpointSha256: base.grant.jointCheckpointSha256, custodyClosed: true, testingResumeAuthorized: true });

function build({ labelled = true, role = 'R1', overrides = {}, clockStep = 0, existing = false } = {}) {
    const { value: base } = manifestFixture(); base.engine.identity = engineIdentityOf({ info, path: base.engine.path, uid }); base.fixtureEndpoint.engineIdentity = base.engine.identity; base.engine.gpuWiringIdentity = gpuWiringIdentityOf({}); validateManifest(base);
    const state = { info: { ...info }, id: BOX_ID, name: `/${BOX_NAME}`, nameLookupId: BOX_ID, nameLookupName: `/${BOX_NAME}`, image: `sha256:${base.box.imageId}`, running: true, startedAt: '2026-10-04T12:29:50.123456789Z',
        labels: { [BOX_LABEL_KEYS.imageRef]: IMAGE_REF, [BOX_LABEL_KEYS.agentLibFingerprint]: base.agentLib.fingerprint, ...(labelled ? { [BOX_LABEL_KEYS.gpuGrant]: GRANT } : {}) },
        ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }], '7882/udp': [{ HostIp: '', HostPort: '7882' }] }, imageId: base.box.imageId, created: '2026-10-04T11:00:00.987654321Z', ...overrides };
    const routes = [
        { match: (bin, args) => args[0] === 'info', reply: () => ({ stdout: lines([['rootless', state.info.rootless], ['version', state.info.version], ['graphRoot', state.info.graphRoot], ['runRoot', state.info.runRoot]]) }) },
        { match: (bin, args) => args[0] === 'container' && args[1] === 'inspect' && args.at(-1) === BOX_ID, reply: () => ({ stdout: lines([['id', state.id], ['name', state.name], ['image', state.image], ['running', state.running], ['status', 'running'], ['startedAt', state.startedAt], ['privileged', false], ['init', true],
            ['capAdd', null], ['securityOpt', null], ['devices', [{ PathOnHost: '/dev/fuse' }, { PathOnHost: '/dev/net/tun' }]], ['networkMode', 'pasta'], ['ports', state.ports], ['mounts', []], ['labels', state.labels], ['workdir', base.workspace.path], ['user', 'podman']]) }) },
        { match: (bin, args) => args[0] === 'container' && args[1] === 'inspect' && args.at(-1) === BOX_NAME, reply: () => ({ stdout: lines([['id', state.nameLookupId], ['name', state.nameLookupName]]) }) },
        { match: (bin, args) => args[0] === 'image' && args[1] === 'inspect', reply: () => ({ stdout: lines([['id', state.imageId], ['created', state.created]]) }) },
    ];
    const host = createFakeHost(routes), kinds = [], observerCalls = [], clock = { t: 0, mono() { const value = this.t; this.t += clockStep; return value; } };
    const run = async (spec, deps) => { kinds.push([spec.operation, spec.kind]); return runOwnedCommand(spec, deps); };
    const observerFor = manifest => ({ observe: async () => { observerCalls.push(['observe', manifest.box.activeGeneration]); return { activeGeneration: 'g-7' }; }, admit: async () => { observerCalls.push(['admit', manifest]); if (state.admitFails) throw new Error('x'); return { admitted: true }; } });
    const io = createMemoryFs(existing ? { [role === 'R1' ? base.evidence.release : base.evidence.release2]: '{}' } : {}); const stat = { isDirectory: () => true, isSymbolicLink: () => false, dev: 7, ino: 4321, uid };
    io.lstatSync = (name => { const original = io.lstatSync; return file => (file === base.workspace.path ? stat : original(file)); })(); io.realpathSync = file => file;
    const root = '/home/skutner/work/evidence/update-cache-20261004T123000Z-feedc0de_codex', runId = 'update-cache-20261004T123000Z-feedc0de_codex';
    const writer = createReleaseManifestWriter({ base, deps: host.deps, env: { PATH: '/usr/bin' }, io, clock, observerFor, run });
    const input = { role, runId, boxId: BOX_ID, evidenceRoot: root, grant: GRANT_WINDOW(base), activation: role === 'R2' ? structuredClone(OPTIONAL_GRAPH) : null };
    return { base, state, host, kinds, observerCalls, io, writer, input, root, runId, clock, written: () => { const file = role === 'R1' ? base.evidence.release : base.evidence.release2; return io.files.has(file) ? io.files.get(file) : null; } };
}

test('AC-15: the writer derives the R1 manifest from the exact-ID inspect, records the name without its slash with the same ID, proves it against the live deployment, and creates it exclusively', async () => {
    const h = build(); const result = await h.writer.write(h.input);
    const bytes = h.written(); assert.ok(bytes); const manifest = parseManifestBytes(bytes);
    assert.equal(manifest.box.id, BOX_ID); assert.equal(manifest.box.name, BOX_NAME, 'the recorded name equals the inspect .Name without the leading slash'); assert.equal(manifest.box.imageRef, IMAGE_REF); assert.equal(manifest.box.imageId, h.base.box.imageId);
    assert.equal(manifest.box.startedAt, '2026-10-04T12:29:50.123Z'); assert.equal(manifest.box.imageCreatedAt, '2026-10-04T11:00:00.987Z'); assert.equal(manifest.box.activeGeneration, 'g-7'); assert.equal(manifest.epochs.functional.generation, 'g-7'); assert.equal(manifest.epochs.functional.boxId, BOX_ID);
    assert.equal(manifest.engine.gpuWiringIdentity, GRANT); assert.equal(manifest.runId, h.runId); assert.equal(manifest.evidence.root, h.root); assert.equal(manifest.activation, null); assert.deepEqual(manifest.publications[0], { protocol: 'tcp', hostIP: '127.0.0.1', hostPort: 8080, containerPort: 8080 });
    assert.deepEqual([manifest.workspace.dev, manifest.workspace.ino, manifest.workspace.uid], [7, 4321, uid]); assert.equal(manifest.negativeScopes.optional, `${h.base.workspace.path}/UpdateE2E-${h.runId}`); assert.deepEqual(manifest.grant, GRANT_WINDOW(h.base));
    assert.deepEqual(result, { role: 'R1', path: h.base.evidence.release, boxId: BOX_ID, boxName: BOX_NAME, imageRef: IMAGE_REF, generation: 'g-7', gpuGrantLabelPresent: true, elapsedMs: 0 });
    // The observer proved the complete manifest (name and ID together) before anything was written.
    const admitted = h.observerCalls.find(call => call[0] === 'admit')[1]; assert.equal(admitted.box.name, BOX_NAME); assert.equal(admitted.box.id, BOX_ID); assert.equal(admitted.box.activeGeneration, 'g-7'); assert.deepEqual(h.observerCalls.map(call => call[0]), ['observe', 'admit']);
    // Zero mutation-kind commands: only the four read lookups, each through the owned runner.
    assert.deepEqual(h.kinds, [['writer-engine-info', 'read'], ['writer-box-inspect', 'read'], ['writer-box-by-name', 'read'], ['writer-image-inspect', 'read']]); assert.equal(h.kinds.some(([, kind]) => kind === 'mutation'), false);
    assert.ok(h.host.log.every(row => ['info', 'container', 'image'].includes(row.args[0]) && !row.args.includes('start') && !row.args.includes('rm') && !row.args.includes('stop')), 'no command can change anything');
    assert.ok(h.host.custody.snapshot().every(row => row.settled));
});

test('AC-15: the unlabelled and the R2 variants record the absent wiring and the declared optional runtimes', async () => {
    const plain = build({ labelled: false }); await plain.writer.write(plain.input); const manifest = parseManifestBytes(plain.written()); assert.equal(manifest.engine.gpuWiringIdentity, gpuWiringIdentityOf({}));
    const second = build({ role: 'R2' }); const result = await second.writer.write(second.input); const r2 = parseManifestBytes(second.written()); assert.equal(result.path, second.base.evidence.release2); assert.deepEqual(r2.activation, OPTIONAL_GRAPH); assert.equal(r2.box.name, BOX_NAME);
});

test('AC-15: a second write is refused before any command runs, and an exclusive create loses a race rather than overwriting', async () => {
    const h = build(); await h.writer.write(h.input); const first = h.written().toString(), launched = h.host.log.length;
    await assert.rejects(h.writer.write(h.input), codeIs('release-manifest-exists')); assert.equal(h.host.log.length, launched, 'the refused second write ran no command'); assert.equal(h.written().toString(), first);
    const preexisting = build({ existing: true }); await assert.rejects(preexisting.writer.write(preexisting.input), codeIs('release-manifest-exists')); assert.equal(preexisting.host.log.length, 0); assert.equal(preexisting.written().toString(), '{}');
    // The lookup and the create are separate steps; the create itself is exclusive.
    const raced = build(); const original = raced.io.openSync; raced.io.openSync = (file, flags, mode) => { if (file === raced.base.evidence.release) raced.io.files.set(file, Buffer.from('{}')); return original(file, flags, mode); };
    await assert.rejects(raced.writer.write(raced.input), codeIs('release-manifest-exists')); assert.equal(raced.written().toString(), '{}');
});

test('AC-15: a name and an ID that belong to different containers, or an inspect of another ID, are refused and nothing is written', async () => {
    const cases = [
        ['the name resolves to another container ID', { nameLookupId: H('other-box') }],
        ['the name lookup returns another name', { nameLookupName: '/ploinky-box-testexplorerfresh-000000000000' }],
        ['the exact-ID inspect returns another ID', { id: H('other-box') }],
        ['the inspect answers for another container whose name lookup agrees', { id: H('other-box'), nameLookupId: H('other-box') }],
        ['the Box name is not a Ploinky Box name', { name: '/workspace-box' }],
        ['the Box name is the ID', { name: `/${BOX_ID}` }],
        ['the Box is not running', { running: false }],
        ['the image reference label is absent', { labels: { [BOX_LABEL_KEYS.agentLibFingerprint]: 'x' } }],
        ['the Box runs another image', { image: `sha256:${H('other-image')}` }],
        ['the image lookup returns another image', { imageId: H('other-image') }],
        ['the GPU-grant label is present but malformed', { labels: { [BOX_LABEL_KEYS.imageRef]: IMAGE_REF, [BOX_LABEL_KEYS.gpuGrant]: 'not-hex' } }],
        ['the engine is not the pinned one', { info: { ...info, version: '5.3.0' } }],
        ['the engine is not rootless', { info: { ...info, rootless: false } }],
    ];
    const codes = { 'the Box runs another image': 'release-candidate-mismatch', 'the GPU-grant label is present but malformed': 'live-box-contract', 'the engine is not the pinned one': 'writer-engine-binding', 'the engine is not rootless': 'writer-engine-binding', 'the image lookup returns another image': 'writer-image-binding' };
    for (const [label, overrides] of cases) {
        const h = build({ overrides }); await assert.rejects(h.writer.write(h.input), error => error.code === (codes[label] ?? 'writer-box-binding'), label); assert.equal(h.written(), null, label);
    }
    const noAgentLib = build({ overrides: { labels: { [BOX_LABEL_KEYS.imageRef]: IMAGE_REF } } }); await noAgentLib.writer.write(noAgentLib.input);
    const rejected = build(); rejected.state.admitFails = true; await assert.rejects(rejected.writer.write(rejected.input)); assert.equal(rejected.written(), null, 'a manifest the live observer does not admit is never written');
});

test('AC-15: bad input is refused before any command, and the writer stays inside its 90 second bound', async () => {
    for (const patch of [{ role: 'R3' }, { runId: 7 }, { boxId: BOX_NAME }, { boxId: 'abc' }, { evidenceRoot: 'relative' }, { grant: null }, { role: 'R1', activation: OPTIONAL_GRAPH }, { role: 'R2', activation: null }]) {
        const h = build(); await assert.rejects(h.writer.write({ ...h.input, ...patch }), codeIs('writer-input'), JSON.stringify(patch)); assert.equal(h.host.log.length, 0);
    }
    const invalid = build(); await assert.rejects(invalid.writer.write({ ...invalid.input, runId: 'not-a-run-id' }), codeIs('manifest-identity')); assert.equal(invalid.written(), null);
    const badGrant = build(); await assert.rejects(badGrant.writer.write({ ...badGrant.input, grant: { ...badGrant.input.grant, endsAtMs: badGrant.input.grant.startsAtMs } }), codeIs('resource-grant')); assert.equal(badGrant.written(), null);
    assert.equal(WRITER_BUDGET_MS, 90000);
    // The writer reads the clock once at the start and after each of its five checkpoints: 5 x 18,000 ms is exactly the bound.
    const exact = build({ clockStep: WRITER_BUDGET_MS / 5 }); await exact.writer.write(exact.input); assert.ok(exact.written());
    const slow = build({ clockStep: WRITER_BUDGET_MS / 5 + 1 }); await assert.rejects(slow.writer.write(slow.input), codeIs('writer-deadline')); assert.equal(slow.written(), null, 'an over-budget preparation writes nothing');
});

test('the name and image lookups use fixed read-only templates and refuse anything else', () => {
    assert.doesNotMatch(`${BOX_IDENTITY_FORMAT}${IMAGE_INSPECT_FORMAT}`, /Config|\.Env|Labels|Secret|Auth|\{\{json \.\}\}/);
    assert.deepEqual(boxIdentityArgs('/usr/bin/podman', BOX_NAME).slice(-3), ['--format', BOX_IDENTITY_FORMAT, BOX_NAME]); for (const bad of ['', 'a b', '-x', 'x;y']) assert.throws(() => boxIdentityArgs('/usr/bin/podman', bad), codeIs('engine-argument'));
    assert.deepEqual(imageInspectArgs('/usr/bin/podman', H('i')).slice(-3), ['--format', IMAGE_INSPECT_FORMAT, H('i')]); assert.throws(() => imageInspectArgs('/usr/bin/podman', 'latest'), codeIs('engine-argument'));
    assert.deepEqual(parseBoxIdentity(Buffer.from(lines([['id', H('b')], ['name', '/n1']]))), { id: H('b'), name: 'n1' }); assert.deepEqual(parseBoxIdentity(Buffer.from(lines([['id', H('b')], ['name', 'n1']]))), { id: H('b'), name: 'n1' });
    for (const bad of [lines([['id', 'x'], ['name', 'n']]), lines([['id', H('b')]]), lines([['id', H('b')], ['name', '']]), '']) assert.throws(() => parseBoxIdentity(Buffer.from(bad)), codeIs('box-identity-shape'));
    assert.deepEqual(parseImageInspect(Buffer.from(lines([['id', `sha256:${H('i')}`], ['created', '2026-10-04T11:00:00.5Z']]))), { id: H('i'), createdAt: '2026-10-04T11:00:00.500Z' });
    for (const bad of [lines([['id', 'x'], ['created', '2026-10-04T11:00:00Z']]), lines([['id', H('i')], ['created', 'yesterday']])]) assert.throws(() => parseImageInspect(Buffer.from(bad)), codeIs('image-inspect-shape'));
});
