// LIVE-C5 replacement custody and cleanup, offline, over the PRODUCT's own durable records. A scenario of c5DriverWorld.mjs runs the real driver over the
// real supervisor, transition and store in a child process, optionally ending (SIGKILL) at a named point; this file reloads what the dead process left
// (its journal, snapshots, CID files and receipt on disk, its containers from the persisted engine table) and judges custody and cleanup in a fresh
// process. The cleanup under test is the actual `runOwnedCleanup`; the engine behind it is the stub engine of that world. Nothing starts a container.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { discoverBoxOwnership } from '../../ploinky-box/engine/discovery.mjs';
import { readBarrier } from '../../cli/sandbox/hardwareLimits/store.mjs';
import { REPOSITORY, engineRecordFromHandle, rawInspectFromHandle, reloadWorld, standalone } from '../hardware-limits/c5DriverWorld.mjs';
import { runDriver } from '../hardware-limits/liveStoreTransition.mjs';
import { evaluateTemplate, inspectModel, ok } from '../hardware-limits/fakeLiveEngine.mjs';
import { observeEngine } from '../hardware-limits/liveStoreTransition.mjs';
import { INSPECT, OWNER_MARKER, engineIdentityDigest, jsonDigest } from '../hardware-limits/liveCommon.mjs';
import {
    C5_BOX_PROVENANCE, C5_BOX_SCHEMA, C5_DRIVER_NAME, C5_DRIVER_SCHEMA, C5_INTENT_SCHEMA, c5ChainIds, c5IntentOf, createC5Intent, driverSettled, newDriverReceipt, productDirectory, productEngineDigest,
    productTransitionIds, readC5ProductJournal, readC5Snapshot, readDriverReceipt, reconcileC5Custody, sameImage, validateBoundJournal, validateC5BoxReceipts, validateC5Intent, validateDriverReceipt,
} from '../hardware-limits/liveBoxTransitionCustody.mjs';
import { recordHostRecords, runOwnedCleanup } from '../hardware-limits/liveCleanup.mjs';
import { scratch } from '../hardware-limits/executorWorld.mjs';
import { writePrivateJson } from '../hardware-limits/fixtures.mjs';

const WORLD = path.join(REPOSITORY, 'tests/hardware-limits/c5DriverWorld.mjs');
const CONTRACT = pathToFileURL(path.join(REPOSITORY, 'tests/helpers/agentlibTestContract.mjs')).href;
const BASE_REVISION = 'd5c9717ff4436acf5bd01690aa1d79db72c785d6';
const UNRELATED = Object.freeze({ id: '9'.repeat(64), created: '2026-01-01T00:00:00Z', image: 'b'.repeat(64), name: 'someone-elses-container', running: true, labels: {}, mounts: [{ Type: 'bind', Name: '', Source: '/elsewhere', Destination: '/data', RW: true }] });

// ---- a scenario in a child process; what it left is reloaded here ----
function spawnWorld(t, scenario, { world = {} } = {}) {
    const tmp = scratch(t, 'hwl-c5c-');
    const env = { ...process.env, C5_WORLD_TMP: tmp, TMPDIR: tmp };
    const child = spawnSync(process.execPath, ['--import', CONTRACT, WORLD, scenario, JSON.stringify({ world })], { cwd: REPOSITORY, env, encoding: 'utf8', timeout: 150000, maxBuffer: 8 * 1024 * 1024 });
    const roots = fs.readdirSync(tmp).filter(name => name.startsWith('c5w-')).map(name => path.join(tmp, name));
    assert.equal(roots.length, 1, child.stderr);
    const line = child.stdout.split('\n').filter(value => value.startsWith('{')).at(-1);
    return { child, root: roots[0], result: line ? JSON.parse(line) : null };
}

// The manifest and profile the harness would hold, and an engine provider over the reloaded world.
function harness(root, { driverOp = 'observed', withDriverOp = true, intentState = 'observed', unrelated = true, faults = {}, mutateRaw = null } = {}) {
    const { meta, world, profile: worldProfile } = reloadWorld(root);
    const intent = { ...meta.intent, state: intentState, ...(driverOp === 'observed' && intentState === 'observed' ? { driverResult: { status: null, signal: 'SIGKILL', timedOut: false, truncated: false, cancelled: false, errorCode: null, settlementForced: false } } : {}) };
    const instance = worldProfile.box.instance;
    const profile = {
        protocol: 'owned-fixture-v1', cases: ['LIVE-C5'], host: { hostname: 'h', platform: process.platform === 'darwin' ? 'darwin' : 'linux', home: meta.home },
        node: { path: process.execPath, digest: `sha256:${'1'.repeat(64)}` }, candidate: { path: path.join(world.box.root, 'ploinky-box/bin/ploinky-box.mjs'), digest: `sha256:${'2'.repeat(64)}` },
        engine: { path: path.join(root, 'engine'), digest: `sha256:${'3'.repeat(64)}`, identityDigest: world.engineIdentityDigest },
        source: worldProfile.source, workspace: meta.workspace, box: worldProfile.box, agents: [],
    };
    const driver = { id: 'live-1', kind: C5_DRIVER_NAME, state: driverOp, resourceIds: [profile.box.id], argvDigest: `sha256:${'4'.repeat(64)}`, resultArtifact: null,
        ...(driverOp === 'observed' ? { result: { status: null, signal: 'SIGKILL', timedOut: false, truncated: false, cancelled: false, errorCode: null } } : {}) };
    const unrelatedRecord = unrelated ? { ...UNRELATED } : null;
    const run = {
        runId: meta.runId, operations: [intent, ...(withDriverOp ? [driver] : [])],
        ownedBoxes: [{ id: profile.box.id, created: profile.box.created, contractDigest: profile.box.contractDigest, operation: 'fixture-start' }], ownedProcesses: [], ownedPaths: [{ path: meta.workspace.path, role: 'workspace' }],
        preInventory: { containers: unrelatedRecord ? [{ id: unrelatedRecord.id, created: unrelatedRecord.created, image: unrelatedRecord.image }] : [] },
        cleanup: { state: 'running', steps: [], failures: [] }, deadlines: {}, target: { execution: profile },
    };
    recordHostRecords(run, profile, instance);
    const calls = []; const destroys = []; const artifacts = new Map(); const state = { failed: false };
    const recordOf = id => (unrelatedRecord && id === unrelatedRecord.id ? unrelatedRecord : null);
    const provider = async (binary, args) => {
        calls.push({ binary, args });
        if (binary === process.execPath && /liveStoreTransition\.mjs$/.test(args[0] ?? '')) {
            const params = JSON.parse(args[1]);
            if (faults.destroyFailsOnce && params.mode === 'destroy' && !state.failed) { state.failed = true; return ok('', { status: 1, stderr: 'injected destroy failure' }); }
            const driven = await world.withHome(() => runDriver(params, { baseRunner: world.runner, supervisor: world.makeSupervisor, programRoot: REPOSITORY }));
            destroys.push({ expected: params.expectedContainerId, pendingAfter: world.transitionIds(), barrierAfter: readBarrier({ paths: world.paths }) });
            return ok(`${JSON.stringify(driven.summary)}\n`, { status: driven.exitCode });
        }
        if (binary !== profile.engine.path) throw new Error(`unexpected command ${binary} ${args.join(' ')}`);
        if (args[0] === 'info') return ok(JSON.stringify(world.info));
        if (args[0] === 'container' && args[1] === 'ps') return ok([...world.containers.keys(), ...(unrelatedRecord ? [unrelatedRecord.id] : [])].map(id => `${id}\n`).join(''));
        if (args[0] === 'container' && args[1] === 'inspect') {
            const id = args.at(-1);
            const entry = world.containers.get(id);
            if (args.includes('--format')) {
                const record = entry ? engineRecordFromHandle(entry.handle, { created: entry.created }) : recordOf(id);
                return record ? ok(evaluateTemplate(INSPECT, 'inspect', inspectModel(record))) : ok('', { status: 125, stderr: 'no such container' });
            }
            if (!entry) return ok('', { status: 125, stderr: 'no such container' });
            const raw = rawInspectFromHandle(entry.handle, { created: entry.created });
            return ok(JSON.stringify([mutateRaw ? mutateRaw(raw) : raw]));
        }
        throw new Error(`unexpected engine command ${args.join(' ')}`);
    };
    const artifactPath = name => path.join(root, `${name}_claude.json`);
    const execute = () => runOwnedCleanup({ run, profile, persist: () => {}, processProvider: provider, artifacts: (name, value) => artifacts.set(name, structuredClone(value)), artifactPath, proofAction: 'cleanup' });
    return { meta, world, profile, run, intent, calls, destroys, artifacts, execute, provider, artifactPath, unrelated: unrelatedRecord, instance };
}
const liveIds = h => [...h.world.containers.keys()];
const steps = h => Object.fromEntries(h.run.cleanup.steps.map(step => [step.id, step.state]));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Schema

test('X5.c5-custody-validates-the-intent-the-driver-receipt-and-the-linked-generations-and-refuses-every-altered-binding', t => {
    const context = standalone({}, t);
    const { run, profile } = context;
    const intent = createC5Intent({ run, profile, driverReceiptName: `${C5_DRIVER_NAME}-${'1'.repeat(32)}`, argvDigest: jsonDigest(['x']), priorTransitionIds: ['a'.repeat(32)], invocationId: '1'.repeat(32) });
    assert.equal(intent.schema, C5_INTENT_SCHEMA);
    assert.deepEqual([intent.expectedFrom, intent.expectedTo, intent.caseId, intent.rootBoxId], ['on', 'off', 'LIVE-C5', profile.box.id]);
    assert.doesNotThrow(() => validateC5Intent(intent, run, profile));
    // One real downgrade invocation: a second intent is a retry and is refused.
    run.operations.push(intent);
    assert.throws(() => createC5Intent({ run, profile, driverReceiptName: `${C5_DRIVER_NAME}-${'2'.repeat(32)}`, argvDigest: jsonDigest(['y']), priorTransitionIds: [], invocationId: '2'.repeat(32) }), /automatic downgrade retry is forbidden/);
    run.operations.push({ ...intent, id: '3'.repeat(32) });
    assert.throws(() => c5IntentOf(run), /more than one downgrade invocation/);
    run.operations.pop();
    for (const [label, change] of [
        ['another run', { runId: 'f'.repeat(32) }], ['another root Box', { rootBoxId: 'f'.repeat(64) }], ['another source', { sourceDigest: jsonDigest('other') }], ['another engine', { engineIdentityDigest: jsonDigest('engine') }],
        ['another workspace', { workspaceReceiptDigest: jsonDigest('ws') }], ['another direction', { expectedFrom: 'off' }], ['a receipt name of another invocation', { driverReceiptName: `${C5_DRIVER_NAME}-${'9'.repeat(32)}` }],
        ['a duplicated prior transition', { priorTransitionIds: ['a'.repeat(32), 'a'.repeat(32)] }], ['an unknown field', { extra: 1 }], ['another state', { state: 'done' }],
    ]) assert.throws(() => validateC5Intent({ ...intent, ...change }, run, profile), /does not match the frozen fixture|Invalid C5 invocation fields/, label);
    // The driver receipt: its binding is the intent's, the original receipt is the anchor, events are ordered, a bound receipt names its product records.
    const receipt = newDriverReceipt(intent, profile);
    assert.equal(receipt.schema, C5_DRIVER_SCHEMA);
    assert.doesNotThrow(() => validateDriverReceipt(receipt, intent, profile));
    const bound = { ...receipt, phase: 'bound', productOperationId: 'b'.repeat(32), productEngineIdentity: 'c'.repeat(64), oldConfigurationRef: `sha256-${'d'.repeat(64)}`, desiredConfigurationRef: `sha256-${'e'.repeat(64)}` };
    assert.doesNotThrow(() => validateDriverReceipt(bound, intent, profile));
    for (const [label, change, pattern] of [
        ['another binding', { binding: { ...receipt.binding, rootBoxId: 'f'.repeat(64) } }, /invalid driver receipt or binding/], ['another original receipt', { originalReceipt: { ...receipt.originalReceipt, created: 'x' } }, /invalid driver receipt or binding/],
        ['a bound phase without a product operation', { phase: 'bound' }, /unbound replacement/], ['a replacement without a binding', { finalContainerId: 'f'.repeat(64) }, /unbound replacement/],
        ['a prior transition adopted as the operation', { ...bound, productOperationId: 'a'.repeat(32) }, /invalid product operation binding/], ['a short engine identity', { ...bound, productEngineIdentity: 'abc' }, /invalid product operation binding/],
        ['events out of order', { events: [{ kind: 'b', sequence: 2, atMs: 1 }] }, /event order changed/], ['a settled receipt without an outcome', { phase: 'settled' }, /settlement outcome missing/],
        ['three attempts', { attempts: [1, 2, 3] }, /invalid driver receipt or binding/],
    ]) assert.throws(() => validateDriverReceipt({ ...receipt, ...change }, intent, profile), pattern, label);
    // Linked generations exist only for the declared invocation, link to the anchor and carry the product provenance.
    const linked = stage => ({ schema: C5_BOX_SCHEMA, id: stage === 'candidate' ? 'c'.repeat(64) : 'd'.repeat(64), created: 'z', image: profile.box.image, contractDigest: jsonDigest('c'), instance: profile.box.instance, pathHash: profile.box.pathHash,
        predecessorId: profile.box.id, invocationId: intent.invocationId, productOperationId: 'b'.repeat(32), attemptId: stage === 'candidate' ? '5'.repeat(32) : '6'.repeat(32), stage, configurationRef: `sha256-${'7'.repeat(64)}`, cidDigest: jsonDigest('cid'), provenance: C5_BOX_PROVENANCE });
    run.ownedBoxes.push({ id: profile.box.id, created: profile.box.created });
    run.ownedBoxes.push(linked('candidate'));
    assert.doesNotThrow(() => validateC5BoxReceipts(run, profile));
    assert.deepEqual(c5ChainIds(run, profile), [profile.box.id, 'c'.repeat(64)]);
    run.ownedBoxes.push(linked('rollback'));
    assert.doesNotThrow(() => validateC5BoxReceipts(run, profile));
    for (const [label, change] of [['another instance', { instance: 'ploinky-box-x-000000000000' }], ['another predecessor', { predecessorId: 'f'.repeat(64) }], ['name-only provenance', { provenance: 'name' }], ['another invocation', { invocationId: 'f'.repeat(32) }],
        ['a duplicate stage', { stage: 'candidate' }], ['another image', { image: 'f'.repeat(64) }], ['a name as ID', { id: 'ploinky-box' }]]) {
        const altered = structuredClone(run); altered.ownedBoxes[2] = { ...altered.ownedBoxes[2], ...change };
        assert.throws(() => validateC5BoxReceipts(altered, profile), /invalid linked immutable generation|linked C5 Box/, label);
    }
    const noIntent = structuredClone(run); noIntent.operations = [];
    assert.throws(() => validateC5BoxReceipts(noIntent, profile), /additional Box without one C5 invocation/);
    assert.equal(sameImage('sha256:abc', 'abc'), true);
    assert.equal(sameImage('abc', 'abd'), false);
    assert.equal(sameImage('', ''), false);
    const settled = result => ({ operations: [{ ...intent, state: 'observed', driverResult: result }, { kind: C5_DRIVER_NAME, state: 'observed' }] });
    assert.equal(driverSettled(settled({ settlementForced: false, errorCode: null })), true);
    for (const run of [settled({ settlementForced: true, errorCode: null }), settled({ settlementForced: false, errorCode: 'EPERM' }), settled(undefined),
        { operations: [{ ...intent, state: 'observed', driverResult: { settlementForced: false } }, { kind: C5_DRIVER_NAME, state: 'intent' }] },
        { operations: [{ ...intent, state: 'intent', driverResult: { settlementForced: false } }, { kind: C5_DRIVER_NAME, state: 'observed' }] },
        { operations: [{ kind: C5_DRIVER_NAME, state: 'observed' }] }]) {
        assert.equal(driverSettled(run), false);
    }
    assert.equal(driverSettled({ operations: [] }), false);
    assert.equal(productEngineDigest({ host: { id: 'a' }, store: { graphRoot: 'b', runRoot: 'c' }, version: { APIVersion: 'd' } }).length, 64);
    // An absent value is null in the product's identity, never a refusal.
    assert.equal(productEngineDigest({}), createHash('sha256').update(JSON.stringify(['podman', null, null, null, null])).digest('hex'));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The product's own records of a completed transition.

test('X5.c5-custody-admits-a-replacement-only-through-the-bound-product-journal-attempt-snapshot-and-cid-and-refuses-every-deviation', async t => {
    const { root } = spawnWorld(t, 'transition');
    const h = harness(root);
    const engineIdentity = productEngineDigest(h.world.info);
    const ids = liveIds(h);
    assert.equal(ids.length, 1);
    const driver = readDriverReceipt(h.artifactPath(h.intent.driverReceiptName), h.intent, h.profile);
    assert.equal(driver.phase, 'settled');
    const inspect = async id => JSON.parse((await h.provider(h.profile.engine.path, ['container', 'inspect', id])).stdout)[0];
    const reconcile = (overrides = {}) => reconcileC5Custody({ run: h.run, profile: h.profile, driver, driverSettled: true, engineIdentity, ids, unrelatedIds: [UNRELATED.id], inspect, ...overrides });
    // The anchor stays, one linked candidate generation is admitted and persisted, and a second look changes nothing.
    let persisted = 0;
    const first = await reconcile({ persist: () => { persisted += 1; } });
    assert.deepEqual(first.ids, [h.profile.box.id, ids[0]]);
    assert.equal(first.current.id, ids[0]);
    assert.equal(first.current.stage, 'candidate');
    assert.equal(persisted, 1);
    const receipt = h.run.ownedBoxes.find(box => box.id === ids[0]);
    assert.deepEqual([receipt.schema, receipt.predecessorId, receipt.productOperationId, receipt.provenance], [C5_BOX_SCHEMA, h.profile.box.id, driver.productOperationId, C5_BOX_PROVENANCE]);
    const again = await reconcile({ persist: () => { persisted += 1; } });
    assert.equal(persisted, 1, 'an observed generation that matches its receipt is not persisted twice');
    assert.equal(jsonDigest(again.current), jsonDigest(first.current));
    assert.doesNotThrow(() => validateC5BoxReceipts(h.run, h.profile));
    const journal = readC5ProductJournal(h.profile, driver.productOperationId);
    assert.equal(journal.phase, 'committed');
    assert.equal(journal.commitIntent.finalContainerId, ids[0]);
    assert.doesNotThrow(() => validateBoundJournal(journal, h.intent, driver, h.profile, engineIdentity));

    const refuses = async (label, pattern, overrides, undo = null) => {
        try { await assert.rejects(reconcile(overrides), pattern, label); } finally { undo?.(); }
    };
    const directory = productDirectory(h.profile);
    const attempt = journal.attempts[0];
    const cidFile = path.join(directory, `${attempt.attemptId}.cid`);
    const swap = (file, replacement) => { const saved = fs.readFileSync(file); fs.rmSync(file); replacement(file); return () => { fs.rmSync(file, { force: true }); fs.writeFileSync(file, saved, { mode: 0o600 }); }; };
    // No receipt, an unsettled driver, a wrong engine identity, an unrelated live container the chain does not explain.
    await refuses('no driver receipt', /unattributed product transition exists and the original Box is gone/, { driver: null });
    await refuses('a driver not proved settled', /not proven settled by the owned transport/, { driverSettled: false });
    await refuses('another product engine identity', /product journal does not match the bound invocation/, { engineIdentity: 'f'.repeat(64) });
    await refuses('a foreign live container', /a container outside the bound product operation is live/, { ids: [...ids, '8'.repeat(64)] });
    await refuses('two current generations', /multiple current generations/, { ids: [...ids, h.profile.box.id] });
    await refuses('a replacement of another image', /replacement creation or image identity missing|does not match its recorded configuration/, { inspect: async id => ({ ...(await inspect(id)), Image: 'f'.repeat(64) }) });
    await refuses('a replacement of another workspace mount', /does not match its recorded configuration/, { inspect: async id => { const raw = await inspect(id); return { ...raw, Mounts: raw.Mounts.map(mount => (mount.Destination === '/opt/ploinky' ? { ...mount, Source: '/other/source' } : mount)) }; } });
    await refuses('a replacement carrying the hardware label (not the recorded gate-off configuration)', /does not match its recorded configuration/, { inspect: async id => { const raw = await inspect(id); return { ...raw, Config: { ...raw.Config, Labels: { ...raw.Config.Labels, [BOX_LABELS.hardwareLimits]: 'f'.repeat(64) } } }; } });
    await refuses('another name than the instance', /replacement identity disagrees with its operation/, { inspect: async id => ({ ...(await inspect(id)), Name: '/someone-else' }) });
    await refuses('an inspect that answers another ID', /inspect did not return the exact full ID/, { inspect: async id => ({ ...(await inspect(id)), Id: 'f'.repeat(64) }) });
    // The CID file: a missing receipt is not adopted by name; a different ID conflicts; a symlink is never followed.
    await refuses('a missing CID with the replacement live', /a container outside the bound product operation is live/, {}, swap(cidFile, () => {}));
    await refuses('a conflicting CID', /conflicting attempt CID/, {}, swap(cidFile, file => fs.writeFileSync(file, `${'7'.repeat(64)}\n`, { mode: 0o600 })));
    await refuses('a symlinked CID', /ELOOP|symlink|not one bounded private regular file/, {}, swap(cidFile, file => fs.symlinkSync(path.join(root, 'world_state.json'), file)));
    const snapshot = path.join(directory, `${journal.desired.configurationRef}.json`);
    await refuses('a snapshot whose bytes changed', /configuration snapshot digest changed/, {}, swap(snapshot, file => fs.writeFileSync(file, `${JSON.stringify({ changed: true })}\n`, { mode: 0o600 })));
    const journalFile = path.join(directory, `${driver.productOperationId}.json`);
    await refuses('a symlinked journal', /ELOOP|symlink|not one bounded private regular file/, {}, swap(journalFile, file => fs.symlinkSync(path.join(root, 'world_meta.json'), file)));
    const receiptFile = h.artifactPath(h.intent.driverReceiptName);
    await assert.rejects(async () => { const restore = swap(receiptFile, file => fs.symlinkSync(path.join(root, 'world_meta.json'), file)); try { readDriverReceipt(receiptFile, h.intent, h.profile); } finally { restore(); } }, /ELOOP|symlink|not one bounded private regular file/);
    // Other workspace or fixture: the journal belongs to another identity; the workspace proof fails; the product directory must be private.
    await assert.rejects(reconcile({ profile: { ...h.profile, box: { ...h.profile.box, instance: 'ploinky-box-other-000000000000', pathHash: '000000000000' } } }), /./);
    assert.throws(() => readC5Snapshot({ ...h.profile, source: { ...h.profile.source, root: '/another/root' } }, journal.desired.configurationRef), /repositoryRoot/);
    fs.chmodSync(directory, 0o755);
    try { assert.throws(() => productDirectory(h.profile), /not private/); } finally { fs.chmodSync(directory, 0o700); }
    assert.deepEqual(productTransitionIds(h.profile), [driver.productOperationId]);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Cleanup: every crash row, in a fresh process, over the real cleanup helper.

const CRASH_ROWS = Object.freeze([
    // [name, killAt, expectation]
    ['journal-and-barrier-exist-but-the-binding-was-never-persisted', 'step:before-bind'],
    ['bound-before-the-old-graph-is-stopped', 'graph-stop:before'],
    ['old-box-stopped-and-removed-with-no-candidate', 'box-remove:after'],
    ['candidate-attempt-recorded-but-the-create-never-ran', 'box-create:before'],
    ['candidate-created-before-any-fixture-receipt', 'box-create:after'],
    ['candidate-started-but-the-commit-was-never-decided', 'box-start:after'],
]);

test('X5.c5-cleanup-intent-persisted-and-the-driver-never-began-destroys-the-original-through-the-exact-id-destroy', async t => {
    const { root } = spawnWorld(t, 'prepared');
    const h = harness(root, { withDriverOp: false, intentState: 'intent' });
    await h.execute();
    assert.equal(h.run.cleanup.steps.every(step => step.state === 'complete'), true, JSON.stringify(steps(h)));
    assert.deepEqual(h.destroys.map(entry => entry.expected), [h.profile.box.id], 'the original anchor governs: exactly its ID was destroyed');
    assert.deepEqual(h.run.ownedBoxes.map(box => box.id), [h.profile.box.id], 'no linked generation exists');
    assert.equal(h.artifacts.get('c5-cleanup-proof-cleanup').action, 'cleanup');
    assert.deepEqual(h.artifacts.get('c5-cleanup-proof-cleanup').chain, [h.profile.box.id]);
    assert.equal(fs.existsSync(h.meta.workspace.path), false, 'the owned workspace is gone');
    assert.deepEqual(liveIds(h), [], 'the world holds nothing');
});

for (const [name, killAt] of CRASH_ROWS) {
    test(`X5.c5-cleanup-crash-row-${name}-is-resolved-from-the-products-records-and-leaves-nothing`, async t => {
        const { child, root } = spawnWorld(t, 'transition', { world: { killAt } });
        assert.equal(child.signal, 'SIGKILL', `the scenario died at ${killAt}: ${child.stderr}`);
        const h = harness(root);
        const beforeIds = liveIds(h);
        await h.execute();
        assert.equal(h.run.cleanup.steps.every(step => step.state === 'complete'), true, JSON.stringify(steps(h)));
        assert.deepEqual(liveIds(h), [], 'every generation of the chain is gone');
        assert.equal(h.unrelated.id, UNRELATED.id, 'the unrelated container was never touched');
        // The product's own destroy closed the pending transition and removed its barrier.
        assert.equal(h.destroys.length, 1, 'exactly one exact-ID destroy ran');
        assert.deepEqual(h.destroys[0].pendingAfter, [], 'no product transition is left pending');
        assert.equal(h.destroys[0].barrierAfter, null, 'the barrier is gone');
        // What was destroyed is exactly what the product's records prove: the one live container, or nothing (the absence handling closes pending state).
        assert.equal(h.destroys[0].expected, beforeIds[0] ?? null);
        const proof = h.artifacts.get('c5-cleanup-proof-cleanup');
        assert.deepEqual([proof.action, proof.remaining], ['cleanup', []]);
        assert.equal(proof.chain[0], h.profile.box.id);
        assert.deepEqual(proof.absent, proof.chain);
        // A replacement created before any fixture receipt is admitted and receipted (linked to the anchor) before it is destroyed.
        if (killAt === 'box-create:after' || killAt === 'box-start:after') {
            const linked = h.run.ownedBoxes.filter(box => box.id !== h.profile.box.id);
            assert.deepEqual(linked.map(box => [box.stage, box.id]), [['candidate', beforeIds[0]]]);
            assert.equal(proof.chain.length, 2);
        } else assert.equal(h.run.ownedBoxes.length, 1);
        assert.equal(fs.existsSync(h.meta.workspace.path), false);
    });
}

test('X5.c5-cleanup-refuses-and-preserves-everything-for-an-unsettled-driver-a-foreign-container-a-changed-snapshot-or-another-workspace', async t => {
    const unsettled = harness(spawnWorld(t, 'transition', { world: { killAt: 'box-create:after' } }).root, { driverOp: 'intent', withDriverOp: true });
    await assert.rejects(unsettled.execute(), /not proven settled by the owned transport/);
    assert.equal(unsettled.destroys.length, 0, 'nothing was destroyed');
    assert.equal(liveIds(unsettled).length, 1, 'the possible replacement is preserved');
    assert.equal(fs.existsSync(unsettled.meta.workspace.path), true);
    // A live container with the workspace's path hash that the bound operation does not explain.
    const foreignRoot = spawnWorld(t, 'transition', { world: { killAt: 'box-create:after' } }).root;
    const foreign = harness(foreignRoot);
    const handle = [...foreign.world.containers.values()][0].handle;
    foreign.world.containers.set('7'.repeat(64), { handle: { ...handle, id: '7'.repeat(64) }, created: 'x', graphRunning: false, logs: '' });
    await assert.rejects(foreign.execute(), /a container outside the bound product operation is live/);
    assert.equal(foreign.destroys.length, 0);
    // A snapshot whose digest changed.
    const changedRoot = spawnWorld(t, 'transition', { world: { killAt: 'box-create:after' } }).root;
    const changed = harness(changedRoot);
    const directory = productDirectory(changed.profile);
    const pending = readC5ProductJournal(changed.profile, productTransitionIds(changed.profile)[0]);
    fs.writeFileSync(path.join(directory, `${pending.desired.configurationRef}.json`), `${JSON.stringify({ other: true })}\n`, { mode: 0o600 });
    await assert.rejects(changed.execute(), /snapshot|digest/);
    assert.equal(changed.destroys.length, 0);
    // The workspace marker is not the run's: the workspace is not proved, so nothing is removed.
    const markerRoot = spawnWorld(t, 'transition', { world: { killAt: 'box-create:after' } }).root;
    const marked = harness(markerRoot);
    fs.writeFileSync(path.join(marked.meta.workspace.path, OWNER_MARKER), 'f'.repeat(32), { mode: 0o600 });
    await assert.rejects(marked.execute(), /Workspace ownership marker changed|ownership/);
    assert.equal(marked.destroys.length, 0);
    assert.equal(liveIds(marked).length, 1);
    // Another engine: the identity changed, so no mutation runs.
    const engineRoot = spawnWorld(t, 'transition', { world: { killAt: 'box-create:after' } }).root;
    const other = harness(engineRoot);
    other.profile.engine.identityDigest = `sha256:${'0'.repeat(64)}`;
    await assert.rejects(other.execute(), /Engine service identity changed/);
    assert.equal(other.destroys.length, 0);
});

test('X5.c5-cleanup-resumes-an-interrupted-destroy-in-a-fresh-call-and-verifies-every-chain-id', async t => {
    const { root } = spawnWorld(t, 'transition');
    const h = harness(root, { faults: { destroyFailsOnce: true } });
    await assert.rejects(h.execute(), /Live command failed/);
    const interrupted = steps(h);
    assert.equal(interrupted['destroy-box'], 'intent', 'the destroy step stays at intent');
    assert.equal(interrupted['c5-custody'], 'complete');
    assert.equal(liveIds(h).length, 1, 'nothing was removed by the failed attempt');
    assert.equal(fs.existsSync(h.meta.workspace.path), true);
    // A fresh call resumes from the manifest alone: the linked receipt it persisted earlier names the generation.
    await h.execute();
    assert.equal(h.run.cleanup.steps.every(step => step.state === 'complete'), true, JSON.stringify(steps(h)));
    assert.deepEqual(liveIds(h), []);
    assert.deepEqual(h.artifacts.get('c5-cleanup-proof-cleanup').absent, h.artifacts.get('c5-cleanup-proof-cleanup').chain);
    // A third call after completion re-proves absence of the whole chain and changes nothing.
    await h.execute();
    assert.equal(h.destroys.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The meaningful base/candidate comparison: the same valid fixture, the actual cleanup helper, no profile validation in between.

test('X5.c5-cleanup-base-refuses-the-valid-live-replacement-as-foreign-and-the-candidate-reconciles-and-destroys-only-it', async t => {
    // Base: the cleanup helper as it was before this slice, loaded from its own revision into a private tree that borrows every other module.
    const scratchRoot = scratch(t, 'hwl-c5base-');
    fs.mkdirSync(path.join(scratchRoot, 'tests/hardware-limits'), { recursive: true });
    fs.symlinkSync(path.join(REPOSITORY, 'ploinky-box'), path.join(scratchRoot, 'ploinky-box'));
    for (const name of ['liveCommon.mjs', 'liveProcess.mjs']) fs.symlinkSync(path.join(REPOSITORY, 'tests/hardware-limits', name), path.join(scratchRoot, 'tests/hardware-limits', name));
    const shown = spawnSync('git', ['-C', REPOSITORY, 'show', `${BASE_REVISION}:tests/hardware-limits/liveCleanup.mjs`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(shown.status, 0, shown.stderr);
    fs.writeFileSync(path.join(scratchRoot, 'tests/hardware-limits/liveCleanup.mjs'), shown.stdout);
    const base = await import(pathToFileURL(path.join(scratchRoot, 'tests/hardware-limits/liveCleanup.mjs')).href);
    assert.notEqual(base.runOwnedCleanup, runOwnedCleanup);

    // The same valid fixture twice (a completed transition: the original receipt kept, the old ID absent, one live replacement, an unrelated container).
    const baseHarness = harness(spawnWorld(t, 'transition').root);
    const candidateHarness = harness(spawnWorld(t, 'transition').root);
    for (const h of [baseHarness, candidateHarness]) {
        assert.equal(liveIds(h).length, 1);
        assert.notEqual(liveIds(h)[0], h.profile.box.id, 'the old ID is absent and one replacement is live');
    }
    const replacement = liveIds(baseHarness)[0];
    // BASE reaches the named refusal inside the actual helper and preserves every resource.
    await assert.rejects(base.runOwnedCleanup({ run: baseHarness.run, profile: baseHarness.profile, persist: () => {}, processProvider: baseHarness.provider }), /Foreign replacement Box occupies workspace/);
    assert.deepEqual(liveIds(baseHarness), [replacement], 'the replacement is preserved');
    assert.equal(baseHarness.destroys.length, 0, 'the base destroyed nothing');
    assert.equal(fs.existsSync(baseHarness.meta.workspace.path), true, 'the base preserved the workspace');
    assert.equal(baseHarness.run.cleanup.steps.find(step => step.id === 'destroy-box').state, 'intent', 'the base stopped inside its destroy step, not before the helper');
    // CANDIDATE reconciles the replacement from the product's records, destroys only it, and proves every ID of the chain absent.
    const candidateReplacement = liveIds(candidateHarness)[0];
    await candidateHarness.execute();
    assert.deepEqual(candidateHarness.destroys.map(entry => entry.expected), [candidateReplacement]);
    assert.deepEqual(liveIds(candidateHarness), []);
    const proof = candidateHarness.artifacts.get('c5-cleanup-proof-cleanup');
    assert.deepEqual(proof.chain, [candidateHarness.profile.box.id, candidateReplacement]);
    assert.deepEqual(proof.absent, proof.chain);
    assert.equal(candidateHarness.unrelated.id, UNRELATED.id);
    assert.ok(candidateHarness.calls.some(call => call.args[0] === 'container' && call.args[1] === 'inspect' && call.args.at(-1) === UNRELATED.id), 'the unrelated container was only inspected, as part of the inventory comparison');
    assert.equal(fs.existsSync(candidateHarness.meta.workspace.path), false);
});

test('X5.c5-cleanup-proves-every-id-of-the-chain-absent-not-only-the-original-and-never-by-label-alone', async t => {
    // The exact-ID destroy reports success but the replacement is still listed: cleanup must notice by ID, even when the engine's record of it has
    // lost its labels and mounts (so neither the label rule nor the mount rule could).
    const { root } = spawnWorld(t, 'transition');
    const h = harness(root);
    const replacement = liveIds(h)[0];
    const real = h.provider;
    h.execute = () => runOwnedCleanup({ run: h.run, profile: h.profile, persist: () => {}, artifacts: () => {}, artifactPath: h.artifactPath, proofAction: 'cleanup',
        processProvider: async (binary, args, options) => {
            if (binary === process.execPath && /liveStoreTransition\.mjs$/.test(args[0] ?? '') && JSON.parse(args[1]).mode === 'destroy') {
                h.destroys.push({ expected: JSON.parse(args[1]).expectedContainerId });
                return ok(`${JSON.stringify({ schema: 1, outcome: { state: 'success' } })}\n`, { status: 0 });
            }
            if (binary === h.profile.engine.path && args[0] === 'container' && args[1] === 'inspect' && args.includes('--format') && args.at(-1) === replacement && h.destroys.length) {
                const stripped = engineRecordFromHandle([...h.world.containers.values()][0].handle, { created: [...h.world.containers.values()][0].created });
                return ok(evaluateTemplate(INSPECT, 'inspect', inspectModel({ ...stripped, labels: {}, mounts: [] })));
            }
            return real(binary, args, options);
        } });
    await assert.rejects(h.execute(), /Exact Box absence not proved/);
    assert.equal(fs.existsSync(h.meta.workspace.path), true, 'nothing else was removed');
    assert.deepEqual(liveIds(h), [replacement]);
});

test('X5.c5-private-json-writes-fsync-the-file-and-then-the-containing-directory-after-the-rename-so-custody-survives-a-crash', t => {
    // Every dependent custody mutation is preceded by a durable manifest or receipt: the file is fsynced before the rename and the directory after it.
    const directory = scratch(t, 'hwl-c5fs-');
    const target = path.join(directory, 'receipt_claude.json');
    const names = new Map(); const order = [];
    const open = fs.openSync; const fsync = fs.fsyncSync; const rename = fs.renameSync; const close = fs.closeSync;
    fs.openSync = (file, ...rest) => { const fd = open(file, ...rest); names.set(fd, String(file)); return fd; };
    fs.fsyncSync = fd => { order.push(['fsync', names.get(fd)]); return fsync(fd); };
    fs.renameSync = (from, to) => { order.push(['rename', String(to)]); return rename(from, to); };
    fs.closeSync = fd => { names.delete(fd); return close(fd); };
    try { writePrivateJson(target, { schema: 1 }); } finally { Object.assign(fs, { openSync: open, fsyncSync: fsync, renameSync: rename, closeSync: close }); }
    const kinds = order.map(([kind, name]) => `${kind}:${name === directory ? 'dir' : name === target ? 'target' : 'temporary'}`);
    assert.deepEqual(kinds, ['fsync:temporary', 'rename:target', 'fsync:dir'], kinds.join(' '));
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { schema: 1 });
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('X5.c5-private-json-directory-fsync-tolerates-exactly-the-products-unsupported-platform-codes-and-throws-on-anything-else', t => {
    const directory = scratch(t, 'hwl-c5fs2-');
    const target = path.join(directory, 'receipt_claude.json');
    const fsync = fs.fsyncSync;
    const failDirectoryWith = code => {
        fs.fsyncSync = fd => {
            const stat = fs.fstatSync(fd);
            if (stat.isDirectory()) throw Object.assign(new Error(code), { code });
            return fsync(fd);
        };
    };
    try {
        // The product's own list: the write succeeds, and the file is still there and complete.
        for (const code of ['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF']) {
            failDirectoryWith(code);
            fs.rmSync(target, { force: true });
            assert.equal(writePrivateJson(target, { code }), target, code);
            assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { code });
        }
        // Anything else is a custody write that may not be durable: it throws, and no directory descriptor is leaked.
        for (const code of ['EIO', 'EACCES', 'ENOSPC', 'EPERM']) {
            failDirectoryWith(code);
            const before = fs.readdirSync('/dev/fd').length;
            assert.throws(() => writePrivateJson(target, { code }), error => error.code === code, code);
            assert.equal(fs.readdirSync('/dev/fd').length <= before + 1, true, 'the directory descriptor was closed');
        }
        // A FILE fsync failure is never tolerated.
        fs.fsyncSync = fd => { if (fs.fstatSync(fd).isFile()) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); return fsync(fd); };
        assert.throws(() => writePrivateJson(target, {}), error => error.code === 'EINVAL');
    } finally { fs.fsyncSync = fsync; }
});

test('X5.c5-engine-identity-of-a-real-podman-5-7-capture-without-a-host-id-equals-the-products-own-and-is-never-a-refusal', async t => {
    // A redacted copy of a retained apparatus capture (podman 5.7.0): `host` has no `id`. The product accepts that engine and builds its identity with
    // null in that place; the harness must build the same identity, from the same document, and must not refuse the engine.
    const info = JSON.parse(fs.readFileSync(path.join(REPOSITORY, 'tests/hardware-limits/podmanInfoWithoutHostId.json'), 'utf8'));
    assert.equal(Object.hasOwn(info.host, 'id'), false);
    assert.equal(info.version.APIVersion, '5.7.0');
    const runner = { query: (_command, args) => (args[0] === 'info' ? { ok: true, status: 0, stdout: JSON.stringify(info), stderr: '' } : { ok: false, status: 1, stdout: '', stderr: 'no such container', error: null }) };
    const marker = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
    const discovered = discoverBoxOwnership({ instance: 'ploinky-box-x-000000000000', pathHash: '000000000000', workspaceRoot: '/x' }, { platform: 'linux', env: {}, runner, readMachineMarkerFile: marker });
    assert.equal(discovered.state, 'absent', discovered.message);
    assert.equal(discovered.engine.identity, 'fb20e894fbd16dbe440a307996c863f6df883fb2c0564b03543bc4030df3a061');
    assert.equal(productEngineDigest(info), discovered.engine.identity, 'the harness builds the product\'s identity: absent is null');
    // The driver's one fresh observation yields both digests from this document and does not refuse it.
    const profile = { engine: { identityDigest: engineIdentityDigest(info, null) } };
    const observed = observeEngine(runner, profile, { infoMs: 1000 });
    assert.equal(observed.product, discovered.engine.identity);
    assert.equal(observed.harness, profile.engine.identityDigest);
    // Cleanup computes the product's identity only where a bound journal needs it: an unbound invocation never asks.
    const context = standalone({}, t);
    const intent = createC5Intent({ run: context.run, profile: context.profile, driverReceiptName: `${C5_DRIVER_NAME}-${'1'.repeat(32)}`, argvDigest: jsonDigest(['x']), priorTransitionIds: [], invocationId: '1'.repeat(32) });
    context.run.operations.push(intent);
    const unbound = await reconcileC5Custody({ run: context.run, profile: context.profile, driver: null, driverSettled: true, engineIdentity: () => { throw new Error('asked'); }, ids: [context.profile.box.id], inspect: async () => { throw new Error('no'); } });
    assert.deepEqual(unbound.ids, [context.profile.box.id]);
});

// The product's engine identity is computed from one `podman info` document by its own discovery. The harness's productEngineDigest must equal it for every
// shape of that document the product accepts: each of the four fields is the first of its two spellings that is not undefined (null counts as a value),
// and a spelling under a non-object parent is skipped.
const REAL_INFO = () => JSON.parse(fs.readFileSync(path.join(REPOSITORY, 'tests/hardware-limits/podmanInfoWithoutHostId.json'), 'utf8'));
const IDENTITY_SHAPES = Object.freeze({
    'the-real-redacted-capture-which-has-no-host-id': (info) => info,
    'a-host-id-present': (info) => { info.host.id = 'host-id-lower'; return info; },
    'uppercase-only-spellings': (info) => {
        delete info.store.graphRoot; delete info.store.runRoot; delete info.version.APIVersion;
        info.Host = { ID: 'HOST-ID-UPPER' }; info.Store = { GraphRoot: '/upper/graph', RunRoot: '/upper/run' }; info.Version = { APIVersion: '9.9.9' };
        return info;
    },
    'both-spellings-with-different-values-the-lowercase-one-wins': (info) => {
        info.host.id = 'host-id-lower'; info.Host = { ID: 'HOST-ID-UPPER' };
        info.Store = { GraphRoot: '/upper/graph', RunRoot: '/upper/run' }; info.Version = { APIVersion: '9.9.9' };
        return info;
    },
    'null-precedence-a-null-lowercase-value-hides-the-uppercase-one': (info) => {
        info.host.id = null; info.Host = { ID: 'HOST-ID-UPPER' };
        info.store.runRoot = null; info.Store = { RunRoot: '/upper/run' };
        return info;
    },
    'a-non-object-lowercase-host': (info) => {
        const rootless = info.host.security.rootless;
        info.Host = { ID: 'HOST-ID-UPPER', Security: { Rootless: rootless } }; info.host = 'not-an-object';
        return info;
    },
    'a-null-lowercase-host': (info) => {
        const rootless = info.host.security.rootless;
        info.Host = { ID: 'HOST-ID-UPPER', Security: { Rootless: rootless } }; info.host = null;
        return info;
    },
});
for (const [shape, build] of Object.entries(IDENTITY_SHAPES)) {
    test(`X5.c5-product-engine-digest-equals-the-products-own-engine-identity-for-${shape}`, () => {
        const info = build(REAL_INFO());
        const runner = { query: (_command, args) => (args[0] === 'info' ? { ok: true, status: 0, stdout: JSON.stringify(info), stderr: '' } : { ok: false, status: 1, stdout: '', stderr: 'no such container', error: null }) };
        const marker = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
        const discovered = discoverBoxOwnership({ instance: 'ploinky-box-x-000000000000', pathHash: '000000000000', workspaceRoot: '/x' }, { platform: 'linux', env: {}, runner, readMachineMarkerFile: marker });
        assert.equal(discovered.state, 'absent', discovered.message);
        assert.match(discovered.engine.identity, /^[a-f0-9]{64}$/);
        assert.equal(productEngineDigest(info), discovered.engine.identity);
    });
}

test('X5.c5-product-engine-digest-shapes-give-distinct-identities-so-the-parametrized-equality-is-not-vacuous', () => {
    const digests = Object.values(IDENTITY_SHAPES).map((build) => productEngineDigest(build(REAL_INFO())));
    assert.equal(digests[0], 'fb20e894fbd16dbe440a307996c863f6df883fb2c0564b03543bc4030df3a061');
    assert.equal(new Set(digests).size >= 5, true, JSON.stringify(digests));
});
