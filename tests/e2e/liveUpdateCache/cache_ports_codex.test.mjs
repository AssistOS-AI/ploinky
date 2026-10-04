import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestFixture, installPureGuards, H } from './test_support_codex.mjs';
import { createFakeHost, byArgs } from './fake_host_support_codex.mjs';
import { createCachePorts, parseStoreProbeOutput, storeProbeBootstrap, STORE_BOOTSTRAP_PATH } from './cache_ports_codex.mjs';
import { STORE_PROBE_SCHEMA } from './store_probe_codex.mjs';
installPureGuards();

const object = '00000000-0000-4000-8000-000000000001';
const fullRow = (label, extra = {}) => ({ label, containerName: 'ploinky_probe', runtimeId: H('c0'), startedAt: '2026-10-04T12:00:00.5Z', instanceId: 'i', enableGeneration: 'e', running: true, labelsEqual: true, objectId: object, selectorId: H('g'), version: '1.0.0',
    sourceCommit: 'a'.repeat(40), provenanceCommit: 'a'.repeat(40), lockCommit: 'a'.repeat(40), markerSha256: H('m'), payloadSha256: H('t'), treeMatchesManifest: true, installerKind: 'container-npm', verification: 'remote-verified',
    readerReceipt: { runtimeId: H('c0'), instanceId: 'i', enableGeneration: 'e', objectId: object }, receiptCount: 1, mountSource: '/s', mountReadOnly: true, ...extra });
const idRow = (label, extra = {}) => ({ label, containerName: 'ploinky_x', runtimeId: H('c1'), instanceId: 'i', enableGeneration: 'e', running: true, labelsEqual: true, objectId: null, selectorId: null, payloadSha256: null, storeMode: 'none', ...extra });
const full = { label: 'primary', repoName: 'R', agentName: 'a', alias: null, packageName: 'pkg', markerFile: 'index.js' }, identity = { label: 'graph', repoName: 'R', agentName: 'g', alias: null, packageName: null, markerFile: null };
const wrap = (targets, objects = []) => Buffer.from(JSON.stringify({ schema: STORE_PROBE_SCHEMA, version: 1, targets, objects }));

function build(routes) { const { value: manifest } = manifestFixture(), fake = createFakeHost(routes); return { manifest, fake, ports: createCachePorts({ manifest, deps: fake.deps, env: { PATH: '/usr/bin' } }) }; }

test('store probe output is strict for both full and identity targets and refuses any extra, missing or mismatched field', () => {
    const input = { targets: [full, identity], objects: [object] };
    assert.equal(parseStoreProbeOutput(wrap([fullRow('primary'), idRow('graph')], [{ objectId: object, present: true, treeMatches: true, payloadSha256: H('t') }]), input).targets.length, 2);
    const bad = [[fullRow('primary', { extra: 1 }), idRow('graph')], [fullRow('other'), idRow('graph')], [fullRow('primary', { sourceCommit: 'short' }), idRow('graph')], [fullRow('primary', { treeMatchesManifest: false }), idRow('graph')],
        [fullRow('primary', { readerReceipt: { runtimeId: H('zz'), instanceId: 'i', enableGeneration: 'e', objectId: object } }), idRow('graph')], [fullRow('primary', { runtimeId: 'short' }), idRow('graph')],
        [fullRow('primary', { readerReceipt: { runtimeId: H('c0'), instanceId: 'i', enableGeneration: 'e', objectId: '00000000-0000-4000-8000-0000000000bb' } }), idRow('graph')],
        [fullRow('primary'), idRow('graph', { storeMode: 'store' })], [fullRow('primary'), { ...idRow('graph'), version: '1' }], [fullRow('primary')], [fullRow('primary', { mountSource: 'a\nb' }), idRow('graph')], [fullRow('primary', { startedAt: 'not-a-time' }), idRow('graph')], [fullRow('primary', { startedAt: '' }), idRow('graph')]];
    for (const targets of bad) assert.throws(() => parseStoreProbeOutput(wrap(targets, [{ objectId: object, present: true, treeMatches: true, payloadSha256: null }]), input), error => error.code === 'store-output');
    assert.throws(() => parseStoreProbeOutput(wrap([fullRow('primary'), idRow('graph')], [{ objectId: '00000000-0000-4000-8000-0000000000aa', present: true, treeMatches: true, payloadSha256: null }]), input), error => error.code === 'store-output');
    assert.throws(() => parseStoreProbeOutput(Buffer.from(JSON.stringify({ schema: STORE_PROBE_SCHEMA, version: 1, failure: 'store-probe-object' })), input), error => error.code === 'live-store-probe-object');
    assert.throws(() => parseStoreProbeOutput(Buffer.from(JSON.stringify({ schema: STORE_PROBE_SCHEMA, version: 1, failure: 'x', extra: 1 })), input), error => error.code === 'store-output');
    assert.throws(() => parseStoreProbeOutput(Buffer.alloc(0), input), error => error.code === 'store-output'); assert.throws(() => parseStoreProbeOutput(Buffer.from('\xff'), input), error => error.code === 'store-output');
});

test('the store probe runs through the exact Box with a fixed bootstrap and requires exit 0 for a document', async () => {
    const input = { targets: [full], objects: [] };
    const h = build([{ match: byArgs('-'), reply: () => ({ stdout: wrap([fullRow('primary')]).toString() + '\n' }) }]);
    const result = await h.ports.probeStore(input); assert.equal(result.targets[0].label, 'primary');
    const [launch] = h.fake.log; assert.deepEqual(launch.args.slice(0, 3), ['container', 'exec', '--interactive']); assert.ok(launch.args.includes(h.manifest.box.id)); assert.deepEqual(launch.args.slice(-3), ['/usr/local/bin/node', '--input-type=module', '-']);
    assert.ok(launch.child.writes[0].toString().includes(STORE_BOOTSTRAP_PATH)); assert.equal(storeProbeBootstrap(input).toString().includes('PRIVATE'), false);
    const exit1 = build([{ match: byArgs('-'), reply: () => ({ stdout: wrap([fullRow('primary')]).toString(), code: 1 }) }]); await assert.rejects(exit1.ports.probeStore(input), error => error.code === 'store-output');
    const refusal = build([{ match: byArgs('-'), reply: () => ({ stdout: JSON.stringify({ schema: STORE_PROBE_SCHEMA, version: 1, failure: 'store-probe-registry-changed' }), code: 1 }) }]);
    await assert.rejects(refusal.ports.probeStore(input), error => error.code === 'live-store-probe-registry-changed');
    await assert.rejects(h.ports.probeStore({ targets: [], objects: [] }), error => error.code === 'store-probe-input');
});

test('reader reads and logs are exact-ID, bounded and report only a hash or text from the one container', async () => {
    const hash = 'e'.repeat(64);
    const h = build([{ match: byArgs('logs'), reply: () => ({ stdout: 'UC_MARKER A\n', stderr: 'warn\n' }) }, { match: (_b, args) => args.includes('-e') && args.includes('exec') && args.includes('node'), reply: () => ({ stdout: `${hash}\n` }) }]);
    assert.equal(await h.ports.readerMarkerSha256(H('c0'), 'pkg', 'index.js'), hash);
    const [read] = h.fake.log; assert.deepEqual(read.args.slice(0, 7), ['exec', h.manifest.box.id, 'podman', 'exec', H('c0'), 'node', '-e']); assert.ok(read.args.at(-1).includes('/code/node_modules/pkg/index.js'));
    assert.equal((await h.ports.containerLogs(H('c0'))).includes('UC_MARKER A'), true); assert.deepEqual(h.fake.log[1].args, ['exec', h.manifest.box.id, 'podman', 'logs', '--tail', '200', H('c0')]);
    for (const [call, code] of [[() => h.ports.readerMarkerSha256('name', 'pkg', 'index.js'), 'reader-read-input'], [() => h.ports.readerMarkerSha256(H('c0'), '../x', 'index.js'), 'reader-read-input'],
        [() => h.ports.readerMarkerSha256(H('c0'), 'pkg', '../index.js'), 'reader-read-input'], [() => h.ports.containerLogs('name'), 'logs-input']]) await assert.rejects(call(), error => error.code === code);
    const unreadable = build([{ match: byArgs('-e'), reply: () => ({ code: 125 }) }]); assert.equal(await unreadable.ports.readerMarkerSha256(H('c0'), 'pkg', 'index.js'), null);
});

test('outer CLI commands are fixed argument arrays whose output is counted and dropped', async () => {
    const h = build([{ match: () => true, reply: () => ({ stdout: 'PRIVATE-SENTINEL\n', code: 0 }) }]);
    const result = await h.ports.cli('cache-enable', ['enable', 'agent', 'R/a', 'global']);
    assert.equal(result.code, 0); assert.equal(result.stdout.length, 0); assert.equal(result.stdoutBytes > 0, true);
    const [launch] = h.fake.log; assert.equal(launch.bin, h.manifest.candidate.cliPath); assert.deepEqual(launch.args, ['enable', 'agent', 'R/a', 'global']); assert.equal(launch.options.cwd, h.manifest.workspace.path);
    for (const bad of [[], [''], ['a\0b'], 'enable']) await assert.rejects(h.ports.cli('x-op', bad), error => error.code === 'cli-arguments');
    const failing = build([{ match: () => true, reply: () => ({ code: 1 }) }]); await assert.rejects(failing.ports.cli('cache-enable', ['enable']), error => error.code === 'command-exit-unexpected');
    assert.equal((await build([{ match: () => true, reply: () => ({ code: 1 }) }]).ports.cli('cache-enable', ['enable'], { allowedExitCodes: [0, 1] })).code, 1);
});

test('debug reinstall projects only the known GC summary and refuses skipped, duplicate, missing or stderr summaries', async () => {
    const line = '[DEBUG] [deps-gc] removed 0 object(s); retained bytes by reason {"admitted-record":5,"reader:container":5}\n';
    const ok = build([{ match: byArgs('reinstall'), reply: () => ({ stdout: `noise PRIVATE-SENTINEL\n${line}more\n` }) }]);
    const result = await ok.ports.reinstallWithGcSummary('uc-1234abcd-a');
    assert.deepEqual(result.summary, { outcome: 'collected', removedCount: 0, retainedBytesByReason: { 'admitted-record': 5, 'reader:container': 5 } }); assert.equal(result.discardedLines, 2); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    assert.deepEqual(ok.fake.log[0].args, ['--debug', 'reinstall', 'uc-1234abcd-a']);
    const skipped = build([{ match: byArgs('reinstall'), reply: () => ({ stdout: '[DEBUG] [deps-gc] skipped (container engine unavailable: PRIVATE)\n' }) }]); const skip = await skipped.ports.reinstallWithGcSummary('uc-a'); assert.deepEqual(skip.summary, { outcome: 'skipped' });
    for (const [reply, code] of [[{ stdout: 'nothing\n' }, 'gc-summary-missing'], [{ stdout: line + line }, 'command-output-rejected'], [{ stderr: line, stdout: '' }, 'command-output-rejected'], [{ stdout: '[DEBUG] [deps-gc] removed x\n' }, 'command-output-rejected'],
        [{ stdout: '[DEBUG] [deps-gc] removed 0 object(s); retained bytes by reason {"made-up":1}\n' }, 'command-output-rejected']]) {
        const bad = build([{ match: byArgs('reinstall'), reply: () => reply }]); await assert.rejects(bad.ports.reinstallWithGcSummary('uc-a'), error => error.code === code, JSON.stringify(reply).slice(0, 40));
    }
    await assert.rejects(ok.ports.reinstallWithGcSummary('bad alias'), error => error.code === 'cli-arguments');
});
