// Current-format store records that are malformed, truncated or not provably
// ours fail safely: they are refused, retained or reported, and are never
// silently accepted, adopted, overwritten or deleted.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createCacheStore } from '../../cli/utils/dependencies/store/objectStore.mjs';
import { buildAgentInstallPlan } from '../../cli/utils/dependencies/store/installContract.mjs';
import { collectDependencyObjects } from '../../cli/utils/dependencies/store/collector.mjs';
import { sha256Hex } from '../../cli/utils/dependencies/store/canonical.mjs';
import {
    defaultProveBuildQuiescent,
    defaultProveReaderQuiescent,
    readBootScope,
} from '../../cli/utils/dependencies/store/receipts.mjs';
import {
    attachAdmittedDependencies,
    issueDependencyRebuildRequest,
    prepareRuntimeDependencies,
} from '../../cli/utils/dependencies/store/runtimeDependencies.mjs';
import { fakeInstaller, fakeLease, hostProbe, hostProvider, makeAgentLib, tempRoot } from './dependencyStoreFixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const GLOBAL = Object.freeze({ name: 'g', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } });
const BWRAP_KEY = 'bwrap-darwin-arm64-node25';

function deadProcessIdentity() {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    return { pid: Number(child.stdout), processStart: 'gone', bootScope: readBootScope() };
}

function collectorWorld(t) {
    const root = tempRoot(t, 'depstore-corrupt-gc-');
    const agentLib = makeAgentLib(root);
    const provider = hostProvider({ agentLib });
    const { lease, assertLease } = fakeLease();
    const inspectContainer = () => 'absent';
    const depsDir = path.join(root, '.ploinky', 'deps');
    const store = createCacheStore({
        depsDir,
        workspaceRoot: root,
        assertLease,
        checkDiskSpace: () => ({ ok: true }),
        proveReaderQuiescent: (receipt) => defaultProveReaderQuiescent(receipt, { inspectContainer }),
        proveBuildQuiescent: (receipt) => defaultProveBuildQuiescent(receipt, { inspectContainer }),
    });
    store.ensureLayout();
    const installer = fakeInstaller();
    const build = (registration, consumer) => store.ensureGeneration(lease, buildAgentInstallPlan({
        provider, globalPackage: GLOBAL, registration, agentLibSelection: agentLib,
        agentPackage: { selection: 'code', relativePath: `${registration}/code/package.json`, sha256: 'f'.repeat(64), manifest: { name: registration, dependencies: { dep: '1.0.0' } } },
    }), { installer, consumer: { phase: 'created', ...consumer } });
    const collect = (overrides = {}) => collectDependencyObjects({
        lease,
        store,
        workspaceRoot: root,
        depsDir,
        assertLease,
        loadAgents: () => ({}),
        inspectMounts: () => ({ available: true, mounts: [] }),
        readEdgeState: () => ({ selector: 'active', preparationOutstanding: false }),
        ...overrides,
    });
    return { root, store, lease, build, collect };
}

// An otherwise-valid, provably quiescent build receipt of this workspace.
function ownedBuildReceipt(store, objectId) {
    const objectPath = path.join(store.paths.objects, objectId);
    return {
        schema: 1,
        kind: 'build',
        receiptId: objectId,
        token: crypto.randomUUID(),
        workspaceId: store.workspaceId,
        operation: 'dependency-build',
        inputKey: 'e'.repeat(64),
        objectPath,
        payloadPath: path.join(objectPath, 'payload'),
        writer: deadProcessIdentity(),
        installer: null,
        installerStarted: false,
        state: 'building',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

const OWNERSHIP_MISMATCHES = Object.freeze({
    kind: (receipt) => ({ ...receipt, kind: 'reader' }),
    workspaceId: (receipt) => ({ ...receipt, workspaceId: 'f'.repeat(64) }),
    receiptId: (receipt) => ({ ...receipt, receiptId: crypto.randomUUID() }),
    objectPath: (receipt) => ({ ...receipt, objectPath: path.join(path.dirname(receipt.objectPath), '..', 'elsewhere', receipt.receiptId) }),
});

function incompleteObject(store) {
    const objectId = crypto.randomUUID();
    const payload = path.join(store.paths.objects, objectId, 'payload');
    fs.mkdirSync(path.join(payload, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'package.json'), '{"name":"partial"}');
    return objectId;
}

// --- G4: build receipts authorize removal only with ownership proof --------

test('dependency store corrupt records: an owned quiescent build receipt still reclaims its incomplete object', (t) => {
    const w = collectorWorld(t);
    const objectId = incompleteObject(w.store);
    fs.writeFileSync(path.join(w.store.paths.buildReceipts, `${objectId}.json`), JSON.stringify(ownedBuildReceipt(w.store, objectId)));
    const item = w.store.describeObjects().find((entry) => entry.objectId === objectId);
    assert.equal(item.classification, 'unpublished-reclaimable');
    const report = w.collect();
    assert.equal(report.skipped, null, JSON.stringify(report));
    assert.deepEqual(report.removed, [objectId]);
    assert.equal(fs.existsSync(path.join(w.store.paths.objects, objectId)), false);
});

for (const [field, mutate] of Object.entries(OWNERSHIP_MISMATCHES)) {
    test(`dependency store corrupt records: an incomplete object whose build receipt has a foreign ${field} is retained and reported`, (t) => {
        const w = collectorWorld(t);
        const objectId = incompleteObject(w.store);
        const receiptFile = path.join(w.store.paths.buildReceipts, `${objectId}.json`);
        const bytes = JSON.stringify(mutate(ownedBuildReceipt(w.store, objectId)));
        fs.writeFileSync(receiptFile, bytes);
        const item = w.store.describeObjects().find((entry) => entry.objectId === objectId);
        assert.notEqual(item.classification, 'unpublished-reclaimable', JSON.stringify(item));
        assert.equal(item.retain, true);
        const report = w.collect();
        assert.equal(report.skipped, null, JSON.stringify(report));
        assert.deepEqual(report.removed, []);
        const retained = report.retained.find((entry) => entry.objectId === objectId);
        assert.ok(retained, 'the object is reported as retained');
        assert.ok(retained.reasons.includes('build-receipt-unowned'), JSON.stringify(retained));
        assert.ok(fs.existsSync(path.join(w.store.paths.objects, objectId, 'payload', 'package.json')), 'the incomplete object is kept');
        assert.equal(fs.readFileSync(receiptFile, 'utf8'), bytes, 'the receipt is kept byte-identical');
    });

    test(`dependency store corrupt records: a receipt-only build receipt with a foreign ${field} is retained, never deleted`, (t) => {
        const w = collectorWorld(t);
        const objectId = crypto.randomUUID();
        const receiptFile = path.join(w.store.paths.buildReceipts, `${objectId}.json`);
        const bytes = JSON.stringify(mutate(ownedBuildReceipt(w.store, objectId)));
        fs.writeFileSync(receiptFile, bytes);
        const item = w.store.describeObjects().find((entry) => entry.objectId === objectId);
        assert.equal(item.classification, 'receipt-only-retained', JSON.stringify(item));
        const report = w.collect();
        assert.equal(report.skipped, null, JSON.stringify(report));
        assert.ok(report.retained.some((entry) => entry.objectId === objectId), JSON.stringify(report));
        assert.equal(fs.readFileSync(receiptFile, 'utf8'), bytes, 'the receipt is kept byte-identical');
        const direct = w.store.removeStaleReceipt(w.lease, receiptFile);
        assert.equal(direct.removed, false, 'removeStaleReceipt refuses a build receipt that is not provably ours');
        assert.equal(fs.readFileSync(receiptFile, 'utf8'), bytes);
    });
}

test('dependency store corrupt records: a build receipt that turns foreign after the inventory still blocks deletion', (t) => {
    const w = collectorWorld(t);
    const objectId = incompleteObject(w.store);
    const receiptFile = path.join(w.store.paths.buildReceipts, `${objectId}.json`);
    fs.writeFileSync(receiptFile, JSON.stringify(ownedBuildReceipt(w.store, objectId)));
    const foreign = JSON.stringify({ ...ownedBuildReceipt(w.store, objectId), workspaceId: 'f'.repeat(64) });
    // The inventory proves the owned receipt; the receipt is replaced before removal.
    const store = {
        ...w.store,
        describeObjects() {
            const inventory = w.store.describeObjects();
            fs.writeFileSync(receiptFile, foreign);
            return inventory;
        },
    };
    assert.equal(w.store.describeObjects().find((entry) => entry.objectId === objectId).classification, 'unpublished-reclaimable');
    const report = w.collect({ store });
    assert.deepEqual(report.removed, []);
    assert.ok(fs.existsSync(path.join(w.store.paths.objects, objectId, 'payload', 'package.json')));
    assert.equal(fs.readFileSync(receiptFile, 'utf8'), foreign);
});

test('dependency store corrupt records: an owned receipt-only build receipt with a dead writer is still removed', (t) => {
    const w = collectorWorld(t);
    const objectId = crypto.randomUUID();
    const receiptFile = path.join(w.store.paths.buildReceipts, `${objectId}.json`);
    fs.writeFileSync(receiptFile, JSON.stringify(ownedBuildReceipt(w.store, objectId)));
    assert.equal(w.store.describeObjects().find((entry) => entry.objectId === objectId).classification, 'receipt-only-reclaimable');
    w.collect();
    assert.equal(fs.existsSync(receiptFile), false);
});

for (const [label, content] of [['truncated', '{"schema":1,"kind":"bu'], ['foreign-workspace', null]]) {
    test(`dependency store corrupt records: a complete orphan next to a ${label} build receipt is retained with the receipt`, (t) => {
        const w = collectorWorld(t);
        const orphan = w.build('reg-orphan', { kind: 'seatbelt-attachment', process: deadProcessIdentity() });
        const receiptFile = path.join(w.store.paths.buildReceipts, `${orphan.objectId}.json`);
        const bytes = content ?? JSON.stringify({ ...ownedBuildReceipt(w.store, orphan.objectId), workspaceId: 'f'.repeat(64) });
        fs.writeFileSync(receiptFile, bytes);
        const report = w.collect();
        assert.equal(report.skipped, null, JSON.stringify(report));
        assert.deepEqual(report.removed, []);
        assert.ok(report.retained.find((entry) => entry.objectId === orphan.objectId)?.reasons.includes('build-receipt-unowned'), JSON.stringify(report));
        assert.ok(fs.existsSync(orphan.payloadPath));
        assert.equal(fs.readFileSync(receiptFile, 'utf8'), bytes);
    });
}

// --- G2: attachments are bound to the object they validated ---------------

function runtimeWorld(t) {
    const root = tempRoot(t, 'depstore-corrupt-runtime-');
    const { lease, assertLease } = fakeLease();
    const store = createCacheStore({ depsDir: path.join(root, '.ploinky', 'deps'), workspaceRoot: root, assertLease, checkDiskSpace: () => ({ ok: true }) });
    const agentCodePath = path.join(root, 'repo', 'agent', 'code');
    fs.mkdirSync(agentCodePath, { recursive: true });
    fs.writeFileSync(path.join(agentCodePath, 'package.json'), JSON.stringify({ name: 'agent', dependencies: { chalk: '5.0.0' } }));
    const agentLib = makeAgentLib(root);
    const installer = fakeInstaller();
    const deps = {
        store,
        workspaceRoot: root,
        memo: null,
        probeHostToolchain: () => hostProbe(),
        npmConfigSources: () => ({ env: {}, files: [] }),
        readGlobalPackage: () => GLOBAL,
        agentLibSelection: () => agentLib,
        sdkBundle: () => null,
        hostRuntimeKey: () => BWRAP_KEY,
        createInstaller: () => installer,
        resolveLease: (given) => {
            if (given) assertLease(given);
            return { lease, release() {} };
        },
    };
    const input = { family: 'bwrap', runtimeKey: BWRAP_KEY, agentCodePath, registration: 'ploinky_repo_agent' };
    return { root, store, lease, deps, input };
}

const ATTACH_CONSUMER = Object.freeze({ kind: 'bwrap-attachment', process: { pid: process.pid } });

test('dependency store corrupt records: an attachment to an intact admitted record returns the validated path', (t) => {
    const w = runtimeWorld(t);
    const first = prepareRuntimeDependencies(w.input, { consumer: { kind: 'bwrap-service', process: { pid: process.pid } } }, w.deps);
    const attached = attachAdmittedDependencies({ runtime: 'bwrap', dependencies: first.record }, { consumer: ATTACH_CONSUMER }, w.deps);
    assert.equal(attached.nodeModulesPath, first.nodeModulesPath);
    attached.release();
});

for (const [field, tamper] of [
    ['generationId', (record) => ({ ...record, generationId: 'd'.repeat(64) })],
    ['nodeModulesPath', (record, w) => ({ ...record, nodeModulesPath: path.join(w.root, 'elsewhere', 'node_modules') })],
    ['payloadPath', (record, w) => ({ ...record, payloadPath: path.join(w.root, 'elsewhere') })],
]) {
    test(`dependency store corrupt records: an attachment whose admitted ${field} does not match the validated object is refused`, (t) => {
        const w = runtimeWorld(t);
        const first = prepareRuntimeDependencies(w.input, { consumer: { kind: 'bwrap-service', process: { pid: process.pid } } }, w.deps);
        fs.mkdirSync(path.join(w.root, 'elsewhere', 'node_modules'), { recursive: true });
        const receiptsBefore = fs.readdirSync(w.store.paths.readerReceipts).sort();
        assert.throws(
            () => attachAdmittedDependencies({ runtime: 'bwrap', dependencies: tamper(first.record, w) }, { consumer: ATTACH_CONSUMER }, w.deps),
            (error) => error?.code === 'PLOINKY_DEPS_GENERATION_INVALID' && /restart/.test(error.message),
        );
        assert.deepEqual(fs.readdirSync(w.store.paths.readerReceipts).sort(), receiptsBefore, 'a refused attachment leaves no receipt');
    });
}

// --- G5: rebuild state fails closed ----------------------------------------

function rebuildFile(store, registration) {
    return path.join(store.root, 'state', 'rebuild', `${sha256Hex(registration)}.json`);
}

function writerShapedState(registration, overrides = {}) {
    return {
        schema: 1, registration, revision: 1, admittedToken: null, desired: null, updatedAt: new Date().toISOString(), ...overrides,
    };
}

test('dependency store corrupt records: a missing rebuild state is the default and a writer-shaped one is read back', (t) => {
    const w = runtimeWorld(t);
    assert.deepEqual(w.store.readRebuildState('ploinky_repo_agent'),
        { schema: 1, registration: 'ploinky_repo_agent', revision: 0, admittedToken: null, desired: null });
    const issued = issueDependencyRebuildRequest('ploinky_repo_agent', {}, w.deps);
    const state = w.store.readRebuildState('ploinky_repo_agent');
    assert.equal(state.revision, 1);
    assert.equal(state.desired.token, issued.token);
    assert.equal(w.store.listRebuildStates().length, 1);
});

const CORRUPT_REBUILD_STATES = Object.freeze({
    'malformed JSON': () => '{"schema":1,"registr',
    'zero bytes': () => '',
    'JSON null': () => 'null',
    'a wrong schema': (registration) => JSON.stringify(writerShapedState(registration, { schema: 2 })),
    'no schema': (registration) => { const { schema, ...rest } = writerShapedState(registration); return JSON.stringify(rest); },
    'no revision': (registration) => { const { revision, ...rest } = writerShapedState(registration); return JSON.stringify(rest); },
    'a zero revision': (registration) => JSON.stringify(writerShapedState(registration, { revision: 0 })),
    'another registration': () => JSON.stringify(writerShapedState('someone_else')),
    'a non-string admitted token': (registration) => JSON.stringify(writerShapedState(registration, { admittedToken: 7 })),
    'a desired request without a token': (registration) => JSON.stringify(writerShapedState(registration, { desired: { status: 'pending' } })),
    'a desired request with an unknown status': (registration) => JSON.stringify(writerShapedState(registration, { desired: { token: 't', status: 'weird' } })),
});

for (const [label, content] of Object.entries(CORRUPT_REBUILD_STATES)) {
    test(`dependency store corrupt records: rebuild state with ${label} is refused and never overwritten`, (t) => {
        const w = runtimeWorld(t);
        const registration = 'ploinky_repo_agent';
        const file = rebuildFile(w.store, registration);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const bytes = content(registration);
        fs.writeFileSync(file, bytes);
        const refused = (error) => error?.code === 'PLOINKY_DEPS_REBUILD_STATE_CORRUPT' && error.message.includes(file);
        assert.throws(() => w.store.readRebuildState(registration), refused);
        assert.throws(() => w.store.listRebuildStates(), refused);
        assert.throws(() => issueDependencyRebuildRequest(registration, {}, w.deps), refused);
        assert.throws(() => prepareRuntimeDependencies(w.input, { consumer: { kind: 'bwrap-service', process: { pid: process.pid } } }, w.deps), refused);
        assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the corrupt record is kept byte-identical');
    });
}

test('dependency store corrupt records: collection skips without mutating anything while a rebuild state is corrupt', (t) => {
    const w = collectorWorld(t);
    const orphan = w.build('reg-orphan', { kind: 'seatbelt-attachment', process: deadProcessIdentity() });
    const receiptsBefore = fs.readdirSync(w.store.paths.readerReceipts).sort();
    assert.equal(receiptsBefore.length, 1);
    const file = rebuildFile(w.store, 'reg-pending');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"schema":1,"registration":"reg-pen');
    const report = w.collect();
    assert.match(String(report.skipped), /rebuild state/);
    assert.ok(report.skipped.includes(file), report.skipped);
    assert.deepEqual(report.removed, []);
    assert.ok(fs.existsSync(orphan.payloadPath), 'the object of a lost desired token is not collected');
    assert.deepEqual(fs.readdirSync(w.store.paths.readerReceipts).sort(), receiptsBefore, 'the skip removes no receipt');
    // Positive control: once the record is repaired, collection proceeds.
    fs.writeFileSync(file, JSON.stringify(writerShapedState('reg-pending')));
    assert.deepEqual(w.collect().removed, [orphan.objectId]);
});

test('dependency store corrupt records: a rebuild state stored under another registration name is refused by the listing', (t) => {
    const w = collectorWorld(t);
    const file = rebuildFile(w.store, 'reg-a');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(writerShapedState('reg-b', { desired: { token: 'tok', status: 'pending' } })));
    assert.throws(() => w.store.listRebuildStates(), { code: 'PLOINKY_DEPS_REBUILD_STATE_CORRUPT' });
    assert.match(String(w.collect().skipped), /rebuild state/);
});

// --- G6: the collector's default registry loader ---------------------------

const G6_CHILD = `
import fs from 'node:fs';
import path from 'node:path';
const [rootUrl, fixturesUrl, ws] = process.argv.slice(2);
const at = (relative) => new URL(relative, rootUrl).href;
const { AGENTS_FILE } = await import(at('cli/utils/config.js'));
if (!AGENTS_FILE.startsWith(ws + path.sep)) throw new Error('AGENTS_FILE escaped the temporary workspace: ' + AGENTS_FILE);
const { createCacheStore } = await import(at('cli/utils/dependencies/store/objectStore.mjs'));
const { buildAgentInstallPlan } = await import(at('cli/utils/dependencies/store/installContract.mjs'));
const { collectDependencyObjects } = await import(at('cli/utils/dependencies/store/collector.mjs'));
const { readBootScope } = await import(at('cli/utils/dependencies/store/receipts.mjs'));
const { fakeInstaller, fakeLease, hostProvider, makeAgentLib } = await import(fixturesUrl);
const depsDir = path.join(ws, '.ploinky', 'deps');
const { lease, assertLease } = fakeLease();
const store = createCacheStore({ depsDir, workspaceRoot: ws, assertLease, checkDiskSpace: () => ({ ok: true }),
    proveReaderQuiescent: () => ({ quiescent: true, reason: 'test' }) });
const agentLib = makeAgentLib(path.join(ws, '.agentlib-fixture'));
const plan = buildAgentInstallPlan({ provider: hostProvider({ agentLib }), globalPackage: { name: 'g', version: '1.0.0', dependencies: {} },
    agentPackage: { selection: 'code', relativePath: 'a/code/package.json', sha256: 'f'.repeat(64), manifest: { name: 'a', dependencies: { dep: '1.0.0' } } },
    registration: 'reg-orphan', agentLibSelection: agentLib });
const orphan = store.ensureGeneration(lease, plan, { installer: fakeInstaller(), consumer: { kind: 'bwrap-attachment', process: { pid: 1, bootScope: readBootScope() } } });
const report = collectDependencyObjects({ lease, store, workspaceRoot: ws, depsDir, assertLease,
    inspectMounts: () => ({ available: true, mounts: [] }),
    readEdgeState: () => ({ selector: 'active', preparationOutstanding: false }) });
process.stdout.write(JSON.stringify({ skipped: report.skipped, removed: report.removed, orphanKept: fs.existsSync(orphan.payloadPath) }));
`;

function runDefaultLoader(t, agentsContent) {
    const root = tempRoot(t, 'depstore-corrupt-agents-');
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.ploinky'), { recursive: true });
    if (agentsContent !== undefined) fs.writeFileSync(path.join(ws, '.ploinky', 'agents.json'), agentsContent);
    const script = path.join(root, 'loader-child.mjs');
    fs.writeFileSync(script, G6_CHILD);
    const env = { ...process.env, PLOINKY_WORKSPACE_ROOT: ws, PLOINKY_ROOT: ws, HOME: path.join(root, 'home') };
    const run = spawnSync(process.execPath, [script, pathToFileURL(`${ROOT}${path.sep}`).href, pathToFileURL(path.join(HERE, 'dependencyStoreFixtures.mjs')).href, ws],
        { cwd: ws, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 0, `child exited ${run.status}\n${run.stdout}\n${run.stderr}`);
    return JSON.parse(run.stdout);
}

test('dependency store corrupt records: the default registry loader treats a missing agents.json as a fresh workspace', (t) => {
    const result = runDefaultLoader(t, undefined);
    assert.equal(result.skipped, null, JSON.stringify(result));
    assert.equal(result.orphanKept, false, 'an unrooted object is collected in a fresh workspace');
});

for (const [label, content] of [['zero bytes', ''], ['JSON null', 'null'], ['a JSON array', '[]'], ['a JSON string', '"agents"'], ['a JSON number', '5']]) {
    test(`dependency store corrupt records: the default registry loader skips collection on an agents.json holding ${label}`, (t) => {
        const result = runDefaultLoader(t, content);
        assert.match(String(result.skipped), /registry/, JSON.stringify(result));
        assert.deepEqual(result.removed, []);
        assert.equal(result.orphanKept, true);
    });
}
