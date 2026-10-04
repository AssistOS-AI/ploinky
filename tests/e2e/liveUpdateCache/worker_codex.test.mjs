import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { manifestFixture, expectationFixture, installPureGuards, H } from './test_support_codex.mjs';
import { buildUpdateResult } from '../../../cli/commands/updateOutcome.js';
import { workerMain, validateCatalogBinding, readBoundedRegularFile, hashRuntimeBinary, installVerifiedImportBinding } from './worker_codex.mjs';
import { validatePublicWorkerProof, superviseOwnedUpdate, createOwnedCustody, createStopLatch } from './execution_codex.mjs';
import { parseStatusProof } from './live_admission_codex.mjs';
import { parseStrictJson } from './manifest_codex.mjs';
installPureGuards();

const here = path.dirname(fileURLToPath(import.meta.url));
const entryParentURL = pathToFileURL(path.join(here, 'product_import_codex.mjs')).href;
const sha = bytes => H(bytes);

function memoryIo(files) {
    const open = new Map(); let next = 100; const writes = [];
    const stat = bytes => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: bytes.length, mode: 0o100600, dev: 1, ino: 7, uid: 1000, mtimeMs: 1, ctimeMs: 1 });
    const missing = () => { const error = new Error('gone'); error.code = 'ENOENT'; return error; };
    return { files, writes,
        openSync: file => { if (!files.has(file)) throw missing(); const fd = next++; open.set(fd, { file, offset: 0 }); return fd; },
        fstatSync: fd => stat(files.get(open.get(fd).file)), lstatSync: file => { if (!files.has(file)) throw missing(); return stat(files.get(file)); }, realpathSync: file => file,
        readSync: (fd, buffer, start, length) => { const state = open.get(fd), bytes = files.get(state.file), count = Math.min(length, bytes.length - state.offset);
            bytes.copy(buffer, start, state.offset, state.offset + count); state.offset += count; return count; },
        closeSync: fd => { open.delete(fd); }, writeSync: (fd, bytes, offset, length) => { writes.push({ fd, text: Buffer.from(bytes.subarray(offset, offset + length)).toString() }); return length; } };
}

function scenario({ operation = 'normal-update', kind = '--owned-update', mutateManifest = () => {}, mutateCatalog = () => {}, runOuterCli } = {}) {
    const { value: manifest } = manifestFixture(), { expected, records } = expectationFixture(manifest, operation);
    const apiBytes = Buffer.from('export const runOuterCli = () => {};\n'), supervisorBytes = Buffer.from('export const createBoxSupervisor = () => {};\n');
    manifest.candidate.apiSha256 = sha(apiBytes); mutateManifest(manifest);
    const apiURL = pathToFileURL(manifest.candidate.apiPath).href, supervisorURL = pathToFileURL(path.join(manifest.candidate.root, 'ploinky-box/supervisor.mjs')).href;
    const catalog = { schemaVersion: 1, candidateCommit: manifest.candidate.commit, apiURL, entryParentURL, builtins: [],
        modules: [{ url: apiURL, format: 'module', bytes: apiBytes.length, sha256: sha(apiBytes) }, { url: supervisorURL, format: 'module', bytes: supervisorBytes.length, sha256: sha(supervisorBytes) }],
        edges: [apiURL, supervisorURL].map(url => ({ specifier: url, parentURL: entryParentURL, conditions: ['node', 'import'], attributes: {}, url, format: 'module' })), initialModules: [apiURL] };
    mutateCatalog(catalog);
    const inputName = kind === '--owned-update' ? `${operation}_input_codex.json` : 'status_input_codex.json', inputPath = path.join(manifest.evidence.root, inputName);
    const input = { schemaVersion: 1, kind: kind === '--owned-update' ? 'update' : 'status', runId: manifest.runId, operation: kind === '--owned-update' ? operation : 'status', manifest, ...(kind === '--owned-update' ? { expected } : {}) };
    const files = new Map([[inputPath, Buffer.from(JSON.stringify(input))], [manifest.evidence.sourceManifest, Buffer.from(JSON.stringify(catalog))],
        [manifest.candidate.apiPath, apiBytes], [path.join(manifest.candidate.root, 'ploinky-box/supervisor.mjs'), supervisorBytes]]);
    const io = memoryIo(files), registered = [], frames = [];
    const registerHooks = hooks => { registered.push(hooks); };
    const context = { parentURL: entryParentURL, conditions: ['node', 'import'], importAttributes: {} };
    const importer = async url => {
        const hooks = registered.at(-1); hooks.resolve(url, context, () => ({ url, format: 'module' })); hooks.load(url, { format: 'module', importAttributes: {} }, () => { throw new Error('normal loader must not run'); });
        if (url === apiURL) return { runOuterCli: runOuterCli ?? (async (_args, options) => {
            const result = buildUpdateResult({ command: ['update'], records, context: { schema: 'ploinky-update-context', version: 1, workspace: { instance: manifest.workspace.instance, workspaceRoot: manifest.workspace.path },
                request: { kind: 'all', folder: null, folderPath: null }, scope: null, box: { containerId: manifest.box.id, engine: manifest.engine.identity, imageId: manifest.box.imageId } } });
            result.activation = { outcome: 'restarted', activationAllowed: true }; options.onUpdateResult({ result, failed: false, activation: result.activation }); return 0; }) };
        return { createBoxSupervisor: () => ({ inspectBoxStatus: () => ({ identity: { instance: 'x' }, state: 'running-initialized', ownership: { state: 'owned' }, inbox: { initialized: true, routingConfigured: true, trackedAgents: 3, runningAgents: 3 } }),
            inspectUpdateState: () => ({ pendingActivation: null, recoveryBarrier: null, errors: [] }) }) };
    };
    const nodeFacts = { version: manifest.host.node.version, execPath: manifest.host.node.path, platform: 'linux', uid: manifest.host.uid, execArgv: [], nodeOptions: '' };
    let clock = 0;
    const options = { io, registerHooks, importer, nodeFacts, hashNode: () => manifest.host.node.sha256, now: () => clock++, write: frame => frames.push(frame) };
    const argv = kind === '--owned-update' ? [kind, inputPath, operation] : [kind, inputPath];
    return { manifest, expected, argv, options, frames, registered, io, catalog, inputPath, run: () => workerMain(argv, options) };
}
const failureOf = frames => frames.find(frame => frame.type === 'WORKER_FAILURE')?.reason;

test('update worker proves its runtime, registers hooks before the product import and reports one public frame', async () => {
    const s = scenario(); const code = await s.run();
    assert.equal(code, 0); assert.equal(s.registered.length, 1); assert.deepEqual(Object.keys(s.registered[0]).sort(), ['load', 'resolve']); assert.equal(s.frames.length, 1);
    const [frame] = s.frames; assert.deepEqual(Object.keys(frame), ['type', 'runId', 'operation', 'proof']); assert.equal(frame.type, 'UPDATE_RESULT');
    assert.equal(validatePublicWorkerProof(frame.proof, { operation: 'normal-update', returnedCode: 0, expected: s.expected }), frame.proof);
    assert.equal(frame.proof.callbackCount, 1); assert.equal(frame.proof.executionInterface, 'outer-cli-api'); assert.doesNotMatch(JSON.stringify(frame), /PRIVATE|nonce|token/);
});

test('expected negative update outcomes keep their exact exit code and activation', async () => {
    for (const [operation, expectedActivation] of [['optional-negative', 'restarted'], ['required-negative', 'deferred']]) {
        const s = scenario({ operation, runOuterCli: async (_args, options) => {
            const { manifest, expected } = s; void manifest;
            const { records } = expectationFixture(s.manifest, operation);
            const result = buildUpdateResult({ command: ['update', 'all', s.manifest.negativeScopes.optional], records, context: { schema: 'ploinky-update-context', version: 1, workspace: { instance: s.manifest.workspace.instance, workspaceRoot: s.manifest.workspace.path },
                request: { kind: 'all', folder: s.manifest.negativeScopes.optional, folderPath: s.manifest.negativeScopes.optional }, scope: { relative: s.manifest.negativeScopes.optional.slice(s.manifest.workspace.path.length + 1), boxPath: s.manifest.negativeScopes.optional },
                box: { containerId: s.manifest.box.id, engine: s.manifest.engine.identity, imageId: s.manifest.box.imageId } } });
            result.activation = { outcome: expectedActivation, activationAllowed: operation !== 'required-negative' };
            options.onUpdateResult({ result, failed: true, activation: result.activation }); void expected; return 1; } });
        assert.equal(await s.run(), 1, operation); assert.equal(s.frames[0].type, 'UPDATE_RESULT'); assert.equal(s.frames[0].proof.returnedCode, 1);
    }
});

test('the worker refuses wrong runtime, preload configuration, mismatched catalog and unavailable hooks with fixed reasons and never imports', async () => {
    const cases = [
        ['node version', s => { s.options.nodeFacts.version = 'v22.0.0'; }, 'node-unqualified'], ['node path', s => { s.options.nodeFacts.execPath = '/opt/other/node'; }, 'node-unqualified'],
        ['node digest', s => { s.options.hashNode = () => H('other-node'); }, 'node-unqualified'], ['platform', s => { s.options.nodeFacts.platform = 'darwin'; }, 'node-unqualified'],
        ['uid', s => { s.options.nodeFacts.uid = 0; }, 'node-unqualified'],
        ['execArgv', s => { s.options.nodeFacts.execArgv = ['--import=./hook.mjs']; }, 'preload-configuration'], ['NODE_OPTIONS', s => { s.options.nodeFacts.nodeOptions = '--require x'; }, 'preload-configuration'],
        ['hooks unavailable', s => { s.options.registerHooks = null; }, 'hooks-unavailable'],
        ['catalog commit', s => { s.io.files.set(s.manifest.evidence.sourceManifest, Buffer.from(JSON.stringify({ ...s.catalog, candidateCommit: 'b'.repeat(40) }))); }, 'catalog-binding'],
        ['catalog api hash', s => { s.io.files.set(s.manifest.evidence.sourceManifest, Buffer.from(JSON.stringify({ ...s.catalog, modules: s.catalog.modules.map((row, index) => index === 0 ? { ...row, sha256: H('x') } : row) }))); }, 'catalog-binding'],
        ['catalog parent', s => { s.io.files.set(s.manifest.evidence.sourceManifest, Buffer.from(JSON.stringify({ ...s.catalog, entryParentURL: 'file:///elsewhere/product_import_codex.mjs' }))); }, 'catalog-binding'],
        ['input path', s => { s.argv[1] = path.join(s.manifest.evidence.root, 'other_input_codex.json'); s.io.files.set(s.argv[1], s.io.files.get(s.inputPath)); }, 'input-path'],
        ['unknown input field', s => { const input = JSON.parse(s.io.files.get(s.inputPath)); input.extra = 1; s.io.files.set(s.inputPath, Buffer.from(JSON.stringify(input))); }, undefined],
        ['run id', s => { const input = JSON.parse(s.io.files.get(s.inputPath)); input.runId = 'other'; s.io.files.set(s.inputPath, Buffer.from(JSON.stringify(input))); }, undefined],
        ['missing input', s => { s.argv[1] = '/home/skutner/work/evidence/missing_codex.json'; }, undefined],
    ];
    for (const [label, mutate, reason] of cases) {
        const s = scenario(); let imports = 0; const importer = s.options.importer; s.options.importer = async url => { imports++; return importer(url); };
        mutate(s); const code = await workerMain(s.argv, s.options);
        assert.equal(code, 2, label); assert.equal(imports, 0, label); assert.ok(!s.frames.some(frame => frame.type === 'UPDATE_RESULT'), label);
        assert.equal(failureOf(s.frames), reason, label);
    }
    const bad = scenario(); assert.equal(await workerMain(['--unknown', '/x'], bad.options), 2); assert.equal(await workerMain([], bad.options), 2); assert.equal(await workerMain(['--owned-update', bad.inputPath], bad.options), 2);
    assert.equal(bad.frames.length, 0, 'no run identity is known before the input is read');
});

test('an unloaded initial module, an unqualified edge or a throwing API fail without a result frame', async () => {
    const s1 = scenario({ mutateCatalog: catalog => { catalog.initialModules.push(catalog.modules[1].url); } }); assert.equal(await s1.run(), 2);
    assert.equal(failureOf(s1.frames), 'import-initial-closure-unproven');
    const s2 = scenario(); const importer = s2.options.importer; s2.options.importer = async url => { s2.registered.at(-1).resolve('./unknown.mjs', { parentURL: entryParentURL, conditions: ['node', 'import'], importAttributes: {} }, () => ({ url: 'file:///x.mjs', format: 'module' })); return importer(url); };
    assert.equal(await s2.run(), 2); assert.equal(failureOf(s2.frames), 'import-edge-unqualified');
    const s3 = scenario({ runOuterCli: async () => { throw new Error('PRIVATE-API-DETAIL'); } }); assert.equal(await s3.run(), 2);
    assert.equal(failureOf(s3.frames), 'update-api-exception'); assert.doesNotMatch(JSON.stringify(s3.frames), /PRIVATE/);
    const s4 = scenario({ runOuterCli: async () => 0 }); assert.equal(await s4.run(), 2); assert.equal(failureOf(s4.frames), 'update-callback-missing');
    let tick = 0; const s5 = scenario(); s5.options.now = () => (tick += 700000); assert.equal(await s5.run(), 2); assert.equal(failureOf(s5.frames), 'import-binding-unknown', 'the clock check inside the verification hooks latches without a private code');
});

test('status worker reads the supported status API and reports only public booleans and counts', async () => {
    const s = scenario({ kind: '--owned-status' }); assert.equal(await s.run(), 0);
    const [frame] = s.frames; assert.deepEqual(Object.keys(frame), ['type', 'runId', 'proof']); assert.equal(frame.type, 'STATUS_RESULT');
    assert.deepEqual(frame.proof, { state: 'running-initialized', owned: true, initialized: true, routingConfigured: true, trackedAgents: 3, runningAgents: 3, pendingActivation: false, recoveryBarrier: false, stateReadErrors: 0 });
    assert.equal(parseStatusProof(frame.proof), frame.proof);
    const pending = scenario({ kind: '--owned-status' }); const importer = pending.options.importer;
    pending.options.importer = async url => { const mod = await importer(url); if (!mod.createBoxSupervisor) return mod; return { createBoxSupervisor: () => ({ ...mod.createBoxSupervisor(), inspectUpdateState: () => ({ pendingActivation: { reason: 'PRIVATE' }, recoveryBarrier: { barrier: 'PRIVATE' }, errors: ['PRIVATE'] }) }) }; };
    await pending.run(); assert.deepEqual([frame.proof.pendingActivation, frame.proof.recoveryBarrier].every(value => value === false), true);
    assert.deepEqual([pending.frames[0].proof.pendingActivation, pending.frames[0].proof.recoveryBarrier, pending.frames[0].proof.stateReadErrors], [true, true, 1]); assert.doesNotMatch(JSON.stringify(pending.frames), /PRIVATE/);
});

test('file readers are bounded, no-follow and stable, and the binary hash is a bounded streaming read', () => {
    const bytes = Buffer.from('abc'), files = new Map([['/f', bytes]]); const io = memoryIo(files);
    assert.deepEqual(readBoundedRegularFile('/f', 16, io), bytes);
    assert.throws(() => readBoundedRegularFile('/f', 2, io), error => error.code === 'worker-file-shape' || error.code === 'read-byte-limit');
    assert.throws(() => readBoundedRegularFile('relative', 16, io), error => error.code === 'worker-file-arguments');
    const unsafe = { ...io, fstatSync: fd => ({ ...io.fstatSync(fd), mode: 0o100666 }) }; assert.throws(() => readBoundedRegularFile('/f', 16, unsafe), error => error.code === 'worker-file-shape');
    const linked = { ...io, fstatSync: fd => ({ ...io.fstatSync(fd), nlink: 2 }) }; assert.throws(() => readBoundedRegularFile('/f', 16, linked), error => error.code === 'worker-file-shape');
    assert.equal(hashRuntimeBinary('/f', io), sha(bytes));
    const grows = { ...io, fstatSync: fd => ({ ...io.fstatSync(fd), size: 2 }) }; assert.throws(() => hashRuntimeBinary('/f', grows), error => error.code === 'worker-node-changed');
});

test('catalog binding requires the pinned commit, API URL, parent and API source hash', () => {
    const s = scenario(); assert.equal(validateCatalogBinding(s.catalog, s.manifest), s.catalog);
    assert.throws(() => validateCatalogBinding({ ...s.catalog, extra: 1 }, s.manifest));
    assert.throws(() => validateCatalogBinding({ ...s.catalog, apiURL: 'file:///other.mjs' }, s.manifest), error => error.code === 'worker-catalog-binding');
    assert.throws(() => installVerifiedImportBinding({ catalog: s.catalog, roots: [s.manifest.candidate.root], check() {}, registerHooks: 5, io: s.io }), error => error.code === 'worker-hooks-unavailable');
});

test('the parent classifies a worker failure frame as a handoff and never as a pass', async () => {
    async function supervise({ frame, code }) {
        const { value: manifest } = manifestFixture(), { expected } = expectationFixture(manifest);
        const child = new EventEmitter(); child.pid = 10001; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdio = [null, child.stdout, child.stderr, new EventEmitter()];
        const latch = createStopLatch(), custody = createOwnedCustody(); let clock = 0, sent = false;
        const receipt = await superviseOwnedUpdate({ manifest, operation: 'normal-update', expected, workerPath: path.join(manifest.candidate.root, 'tests/e2e/liveUpdateCache/execution_codex.mjs'),
            workerInputPath: path.join(manifest.evidence.root, 'normal-update_input_codex.json') }, { latch, custody, now: () => clock, launch: () => child, register: () => ({ pid: 10001 }), current: () => null,
            delay: async ms => { clock += ms; if (!sent) { sent = true; child.stdio[3].emit('data', Buffer.from(JSON.stringify(frame(manifest)))); for (const stream of [child.stdout, child.stderr, child.stdio[3]]) { stream.emit('end'); stream.emit('close'); } child.emit('close', code, null); } } });
        return { receipt, custody, latch };
    }
    const failure = (manifest, patch = {}) => ({ type: 'WORKER_FAILURE', runId: manifest.runId, operation: 'normal-update', reason: 'node-unqualified', ...patch });
    const reported = await supervise({ frame: manifest => failure(manifest), code: 2 });
    assert.equal(reported.receipt.passed, false); assert.equal(reported.receipt.reason, 'worker-node-unqualified'); assert.equal(reported.receipt.resourceDisposition, 'HANDOFF_REQUIRED'); assert.equal(reported.latch.snapshot().uncertain, true);
    assert.equal(reported.custody.snapshot()[0].settled, false);
    for (const [frame, code] of [[manifest => failure(manifest, { runId: 'other' }), 2], [manifest => failure(manifest), 1], [manifest => failure(manifest, { reason: 'Bad Reason' }), 2], [manifest => failure(manifest, { extra: 1 }), 2]]) {
        assert.equal((await supervise({ frame, code })).receipt.reason, 'worker-result-binding');
    }
    const forged = await supervise({ frame: manifest => ({ type: 'UPDATE_RESULT', runId: manifest.runId, operation: 'normal-update', proof: {} }), code: 2 });
    assert.equal(forged.receipt.reason, 'worker-incarnation-unsettled');
    assert.deepEqual(parseStrictJson(Buffer.from('{"a":1}')), { a: 1 });
});
