// C5 replacement custody. The original fixture Box receipt (`profile.box`) stays the immutable anchor; a gate-on to gate-off restart may replace
// that Box, and a replacement (or a rollback generation) is admitted only through the PRODUCT's own durable records: the bound product operation,
// its precreation attempt record, its digest-addressed configuration snapshot, the exact CID file the engine wrote and a fresh full-ID inspect.
// A name, a label or a path hash can reject a foreign container; it can never admit one. Test-only; nothing here starts a process.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { normalizeContainerRuntime, validateContainerConfiguration } from '../../ploinky-box/contract/container.mjs';
import { digestOf, validateJournal } from '../../ploinky-box/hardwareLimitsTransition.mjs';
import { fsyncDirectory, writePrivateJson } from './fixtures.mjs';
import { HASH, ID, RUN_ID, absolute, assertWorkspace, bounded, canonicalDigest, digest, jsonDigest, keys } from './liveCommon.mjs';

export const C5_INTENT_SCHEMA = 'ploinky.hwl-c5-invocation/v1';
export const C5_DRIVER_SCHEMA = 'ploinky.hwl-c5-driver/v1';
export const C5_BOX_SCHEMA = 'ploinky.hwl-c5-box/v1';
export const C5_DRIVER_NAME = 'c5-transition-driver';
export const C5_INTENT_KIND = 'c5-downgrade';
export const C5_BOX_PROVENANCE = 'product-attempt-cid-full-id-inspect';
const REF = /^sha256-[a-f0-9]{64}$/;
const PRODUCT_ENGINE = /^[a-f0-9]{64}$/;
const MAX_BYTES = 256 * 1024;
const BINDING_KEYS = ['runId', 'caseId', 'invocationId', 'sourceDigest', 'engineIdentityDigest', 'workspaceReceiptDigest',
    'rootBoxId', 'expectedFrom', 'expectedTo', 'driverReceiptName', 'argvDigest', 'priorTransitionIds'];
const problem = message => Object.assign(new Error(`C5 custody: ${message}`), { c5Custody: true });
const normalizeImage = value => String(value ?? '').replace(/^sha256:/, '');
export const sameImage = (left, right) => normalizeImage(left) !== '' && normalizeImage(left) === normalizeImage(right);

// The product's own engine identity, constructed exactly as engine/discovery.mjs engineIdentity does: sha256 over
// JSON.stringify(['podman', host.id, store.graphRoot, store.runRoot, version.APIVersion]) where each value is the first of its two spellings that is
// not undefined, and an absent one is serialized as null. A podman 5.7 `info` has no host.id, so absent MUST be null here, never a refusal: the
// product accepts that engine and writes the journal's identity from it. It is built differently from the harness's engine digest; both are
// computed from ONE fresh `info` document.
const firstDefined = (...values) => values.find(value => value !== undefined);
export function productEngineDigest(info) {
    const values = [firstDefined(info?.host?.id, info?.Host?.ID), firstDefined(info?.store?.graphRoot, info?.Store?.GraphRoot),
        firstDefined(info?.store?.runRoot, info?.Store?.RunRoot), firstDefined(info?.version?.APIVersion, info?.Version?.APIVersion)];
    return crypto.createHash('sha256').update(Buffer.from(JSON.stringify(['podman', ...values]))).digest('hex');
}

// Whether the owned transport proves the driver's whole process group ended: its manifest operation was observed (a command is observed only
// after its group is gone) and the parent recorded on the invocation intent that the settlement was not forced. A parent that died between the
// two leaves the settlement unproved. Saved PIDs are never used and nothing is signalled.
export function driverSettled(run) {
    const op = [...run.operations].reverse().find(entry => entry?.kind === C5_DRIVER_NAME);
    const intent = c5IntentOf(run);
    const result = intent?.driverResult;
    return Boolean(op && op.state === 'observed' && intent?.state === 'observed' && result && !result.settlementForced && !result.errorCode);
}

export function c5IntentOf(run) {
    const intents = run.operations.filter(op => op?.kind === C5_INTENT_KIND);
    if (intents.length > 1) throw problem('more than one downgrade invocation');
    return intents[0] || null;
}

export function createC5Intent({ run, profile, driverReceiptName, argvDigest, priorTransitionIds, invocationId = crypto.randomBytes(16).toString('hex') }) {
    if (c5IntentOf(run)) throw problem('automatic downgrade retry is forbidden');
    const intent = { schema: C5_INTENT_SCHEMA, id: invocationId, kind: C5_INTENT_KIND, state: 'intent',
        runId: run.runId, caseId: 'LIVE-C5', invocationId, sourceDigest: profile.source.digest,
        engineIdentityDigest: profile.engine.identityDigest, workspaceReceiptDigest: jsonDigest(profile.workspace),
        rootBoxId: profile.box.id, expectedFrom: 'on', expectedTo: 'off', driverReceiptName, argvDigest, priorTransitionIds,
        resourceIds: [profile.box.id] };
    validateC5Intent(intent, run, profile);
    return intent;
}

export function validateC5Intent(intent, run, profile) {
    keys(intent, ['schema', 'id', 'kind', 'state', ...BINDING_KEYS, 'resourceIds'], 'C5 invocation', ['driverResult']);
    if (intent.schema !== C5_INTENT_SCHEMA || intent.kind !== C5_INTENT_KIND || !['intent', 'observed'].includes(intent.state)
        || intent.id !== intent.invocationId || !RUN_ID.test(intent.invocationId) || intent.caseId !== 'LIVE-C5'
        || intent.runId !== run.runId || !profile.cases.includes('LIVE-C5') || intent.rootBoxId !== profile.box.id
        || intent.sourceDigest !== profile.source.digest || intent.engineIdentityDigest !== profile.engine.identityDigest
        || intent.workspaceReceiptDigest !== jsonDigest(profile.workspace) || intent.expectedFrom !== 'on' || intent.expectedTo !== 'off'
        || !HASH.test(intent.argvDigest) || !/^[a-z0-9][a-z0-9-]*$/.test(intent.driverReceiptName)
        || intent.driverReceiptName !== `${C5_DRIVER_NAME}-${intent.invocationId}`
        || JSON.stringify(intent.resourceIds) !== JSON.stringify([profile.box.id])
        || !Array.isArray(intent.priorTransitionIds) || intent.priorTransitionIds.length > 32
        || intent.priorTransitionIds.some(id => !RUN_ID.test(id)) || new Set(intent.priorTransitionIds).size !== intent.priorTransitionIds.length) {
        throw problem('invocation does not match the frozen fixture');
    }
    return intent;
}

export function driverBinding(intent) {
    return Object.fromEntries(BINDING_KEYS.map(key => [key, structuredClone(intent[key])]));
}

export function newDriverReceipt(intent, profile) {
    return { schema: C5_DRIVER_SCHEMA, binding: driverBinding(intent), originalReceipt: structuredClone(profile.box), phase: 'intent',
        productOperationId: null, productEngineIdentity: null, oldConfigurationRef: null, desiredConfigurationRef: null,
        events: [], outcome: null, primaryFailure: null, attempts: [], finalContainerId: null };
}

export function validateDriverReceipt(value, intent, profile) {
    keys(value, ['schema', 'binding', 'originalReceipt', 'phase', 'productOperationId', 'productEngineIdentity', 'oldConfigurationRef',
        'desiredConfigurationRef', 'events', 'outcome', 'primaryFailure', 'attempts', 'finalContainerId'], 'C5 driver receipt');
    keys(value.binding, BINDING_KEYS, 'C5 driver binding');
    if (value.schema !== C5_DRIVER_SCHEMA || jsonDigest(value.binding) !== jsonDigest(driverBinding(intent))
        || jsonDigest(value.originalReceipt) !== jsonDigest(profile.box) || !['intent', 'bound', 'settled'].includes(value.phase)
        || !Array.isArray(value.events) || value.events.length > 128 || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES
        || !Array.isArray(value.attempts) || value.attempts.length > 2
        || (value.finalContainerId !== null && !ID.test(value.finalContainerId))) throw problem('invalid driver receipt or binding');
    if (value.productOperationId !== null && (!RUN_ID.test(value.productOperationId) || intent.priorTransitionIds.includes(value.productOperationId)
        || !PRODUCT_ENGINE.test(value.productEngineIdentity) || !REF.test(value.oldConfigurationRef) || !REF.test(value.desiredConfigurationRef))) {
        throw problem('invalid product operation binding');
    }
    if (value.productOperationId === null && (value.phase === 'bound' || value.productEngineIdentity !== null
        || value.oldConfigurationRef !== null || value.desiredConfigurationRef !== null || value.attempts.length || value.finalContainerId)) throw problem('unbound replacement');
    for (const event of value.events) {
        if (!event || !bounded(event.kind, 80) || !Number.isInteger(event.sequence) || event.sequence < 1
            || event.sequence > 128 || !Number.isFinite(event.atMs) || event.atMs < 0) throw problem('invalid ordered driver event');
    }
    if (value.events.some((event, index) => event.sequence !== index + 1)) throw problem('driver event order changed');
    if (value.phase === 'settled' && (!value.outcome || !['success', 'failed'].includes(value.outcome.state))) throw problem('settlement outcome missing');
    return value;
}

function assertRealDirectories(target) {
    if (!absolute(target)) throw problem('unsafe private receipt path');
    let directory = path.dirname(target);
    // Every existing ancestor is a real directory; a missing one has nothing below it, so the read itself reports the absence.
    while (directory !== path.dirname(directory)) {
        let stat;
        try { stat = fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') { directory = path.dirname(directory); continue; } throw error; }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem('private receipt has a symlinked parent');
        directory = path.dirname(directory);
    }
}

// One bounded regular file, never followed, owned by this user. `fileMode: false` is for the engine's own CID file (the engine writes it with
// its umask); its confinement is the product's private 0700 transition directory, which `productDirectory` proves separately.
export function readPrivateC5File(target, { json = true, missing = false, maxBytes = MAX_BYTES, sync = false, fileMode = true } = {}) {
    assertRealDirectories(target);
    let fd;
    try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes || (fileMode && (stat.mode & 0o077) !== 0)
            || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw problem('receipt is not one bounded private regular file');
        const bytes = fs.readFileSync(fd);
        if (sync) {
            fs.fsyncSync(fd);
            fsyncDirectory(path.dirname(target));
        }
        return json ? JSON.parse(bytes.toString('utf8')) : bytes;
    } finally { fs.closeSync(fd); }
}

export function persistDriverReceipt(target, receipt, intent, profile) {
    validateDriverReceipt(receipt, intent, profile);
    return writePrivateJson(target, receipt);
}

export function readDriverReceipt(target, intent, profile) {
    const value = readPrivateC5File(target, { missing: true });
    return value === null ? null : validateDriverReceipt(value, intent, profile);
}

// The product's transition directory of this instance, proved a real private directory of this user before anything in it is read.
export function productDirectory(profile) {
    const directory = path.join(profile.host.home, '.ploinky-box', 'hardware-limits', profile.box.instance, 'transitions');
    assertRealDirectories(path.join(directory, 'probe'));
    let stat;
    try { stat = fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return directory; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw problem('the product transition directory is not private');
    return directory;
}

export function productTransitionIds(profile) {
    const directory = productDirectory(profile);
    try {
        const names = fs.readdirSync(directory).filter(name => /^[a-f0-9]{32}\.json$/.test(name)).sort();
        if (names.length > 32) throw problem('too many product transitions');
        return names.map(name => name.slice(0, 32));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function readC5ProductJournal(profile, operationId) {
    if (!RUN_ID.test(operationId)) throw problem('invalid operation ID');
    const value = readPrivateC5File(path.join(productDirectory(profile), `${operationId}.json`));
    return validateJournal(value, assertWorkspace(profile));
}

export function readC5Snapshot(profile, ref) {
    if (!REF.test(ref)) throw problem('invalid configuration reference');
    const value = readPrivateC5File(path.join(productDirectory(profile), `${ref}.json`), { maxBytes: 1024 * 1024 });
    if (digestOf(value) !== ref) throw problem('configuration snapshot digest changed');
    const wrong = Object.entries({
        workspaceRoot: value.identity?.workspaceRoot === profile.workspace.path, instance: value.identity?.instance === profile.box.instance,
        pathHash: value.identity?.pathHash === profile.box.pathHash, repositoryRoot: value.repositoryRoot === profile.source.root,
        imageId: sameImage(value.imageId, profile.box.image), hostKind: value.hostKind === 'native-linux',
    }).filter(([, ok]) => !ok).map(([name]) => name);
    if (wrong.length) throw problem(`configuration belongs to another fixture (${wrong.join(', ')})`);
    return value;
}

export function validateBoundJournal(journal, intent, receipt, profile, engineIdentity) {
    validateDriverReceipt(receipt, intent, profile);
    validateJournal(journal, assertWorkspace(profile));
    if (receipt.productOperationId !== journal.operationId || journal.operation !== 'restart' || journal.old.containerId !== intent.rootBoxId
        || journal.identity.engineIdentity !== engineIdentity || receipt.productEngineIdentity !== engineIdentity
        || journal.old.configurationRef !== receipt.oldConfigurationRef || journal.desired.configurationRef !== receipt.desiredConfigurationRef
        || journal.desired.reapplyConfigurationRef || journal.attempts.length > 2) throw problem('product journal does not match the bound invocation');
    const stages = journal.attempts.map(attempt => attempt.stage);
    if (stages.filter(stage => stage === 'candidate').length > 1 || stages.filter(stage => stage === 'rollback').length > 1
        || stages.some(stage => !['candidate', 'rollback'].includes(stage)) || (stages.includes('rollback') && stages.at(-1) !== 'rollback')) {
        throw problem('unexpected create attempts or GPU reapply');
    }
    return journal;
}

// The inspect document of one exact container as the product's own normalizer reads it. The full ID must be the one asked for.
export function exactContainerHandle(raw, id, engineIdentity) {
    if (!raw || (raw.Id ?? raw.ID) !== id || !ID.test(id)) throw problem('inspect did not return the exact full ID');
    return { kind: 'container', engine: 'podman', engineIdentity, id, name: String(raw.Name ?? '').replace(/^\//, ''),
        labels: raw.Config?.Labels || {}, runtime: normalizeContainerRuntime(raw), pathHash: raw.Config?.Labels?.[BOX_LABELS.pathHash] };
}

// The CID file of one create attempt: the engine's own record of the immutable ID it created. Null when absent.
export function readAttemptCid(profile, attempt) {
    const bytes = readPrivateC5File(path.join(productDirectory(profile), `${attempt.attemptId}.cid`), { json: false, maxBytes: 128, missing: true, fileMode: false });
    if (!bytes) return null;
    const id = bytes.toString('utf8').trim();
    if (!ID.test(id)) throw problem('the CID receipt is not one full container ID');
    return { id, bytes };
}

export function generationReceipt({ intent, driver, journal, attempt, profile, raw, engineIdentity }) {
    validateBoundJournal(journal, intent, driver, profile, engineIdentity);
    if (!RUN_ID.test(attempt.attemptId) || !journal.attempts.includes(attempt)) throw problem('unrecorded create attempt');
    const ref = attempt.stage === 'candidate' ? journal.desired.configurationRef : journal.old.configurationRef;
    const configuration = readC5Snapshot(profile, ref);
    if (attempt.configurationRef !== ref || attempt.contractHash !== digestOf(configuration)
        || (attempt.stage === 'candidate' ? configuration.hardware !== null : !configuration.hardware)) throw problem('attempt configuration mismatch');
    const cid = readAttemptCid(profile, attempt);
    if (!cid || (attempt.observedId !== null && attempt.observedId !== cid.id)) throw problem('missing or conflicting immutable CID');
    const handle = exactContainerHandle(raw, cid.id, engineIdentity);
    if (handle.name !== profile.box.instance || handle.labels[BOX_LABELS.pathHash] !== profile.box.pathHash
        || handle.labels[BOX_LABELS.role] !== 'box') throw problem('replacement identity disagrees with its operation');
    try { validateContainerConfiguration(handle, configuration); }
    catch (error) { throw problem(`replacement does not match its recorded configuration (${String(error?.message || error).slice(0, 160)})`); }
    if (!bounded(raw.Created, 128) || !sameImage(handle.runtime.imageId, profile.box.image)) throw problem('replacement creation or image identity missing');
    return { schema: C5_BOX_SCHEMA, id: cid.id, created: raw.Created, image: handle.runtime.imageId,
        contractDigest: canonicalDigest({ labels: handle.labels, mounts: raw.Mounts }), instance: profile.box.instance, pathHash: profile.box.pathHash,
        predecessorId: profile.box.id, invocationId: intent.invocationId, productOperationId: journal.operationId,
        attemptId: attempt.attemptId, stage: attempt.stage, configurationRef: ref, cidDigest: digest(cid.bytes), provenance: C5_BOX_PROVENANCE };
}

export function linkedBoxesOf(run, profile) {
    return run.ownedBoxes.filter(box => box.id !== profile.box.id);
}

export function validateC5BoxReceipts(run, profile) {
    const extra = linkedBoxesOf(run, profile);
    const intent = c5IntentOf(run);
    if (!extra.length) return;
    if (!intent || extra.length > 2) throw problem('additional Box without one C5 invocation');
    validateC5Intent(intent, run, profile);
    const ids = new Set([profile.box.id]); const stages = new Set();
    for (const box of extra) {
        keys(box, ['schema', 'id', 'created', 'image', 'contractDigest', 'instance', 'pathHash', 'predecessorId', 'invocationId',
            'productOperationId', 'attemptId', 'stage', 'configurationRef', 'cidDigest', 'provenance'], 'linked C5 Box');
        if (box.schema !== C5_BOX_SCHEMA || !ID.test(box.id) || ids.has(box.id) || !bounded(box.created, 128)
            || !sameImage(box.image, profile.box.image) || !HASH.test(box.contractDigest) || !HASH.test(box.cidDigest)
            || box.instance !== profile.box.instance || box.pathHash !== profile.box.pathHash || box.predecessorId !== profile.box.id
            || box.invocationId !== intent.invocationId || !RUN_ID.test(box.productOperationId) || !RUN_ID.test(box.attemptId)
            || !['candidate', 'rollback'].includes(box.stage) || stages.has(box.stage) || !REF.test(box.configurationRef)
            || box.provenance !== C5_BOX_PROVENANCE) throw problem('invalid linked immutable generation');
        ids.add(box.id); stages.add(box.stage);
    }
}

// Every ID cleanup must prove absent: the original anchor and every linked generation.
export function c5ChainIds(run, profile) {
    return [profile.box.id, ...linkedBoxesOf(run, profile).map(box => box.id)];
}

// Resolve every eligible ID BEFORE cleanup mutates anything.
//   run, profile   the manifest and its profile (the original receipt is `profile.box`)
//   driver         the validated driver receipt, or null when none exists
//   driverSettled  the owned transport's own proof that the driver's process group ended (the manifest operation is `observed`); saved PIDs are
//                  never used and nothing is signalled
//   engineIdentity the product's engine digest from the SAME fresh observation the harness digest was checked against, or a function that computes it
//                  (called only where a bound journal needs it)
//   ids            every container ID the engine lists now; unrelatedIds the pre-run inventory
//   inspect(id)    the full `container inspect` document of one exact ID
// Returns { ids: every chain ID, current: the receipt of the one live generation (or null), journal, unbound }.
export async function reconcileC5Custody({ run, profile, driver, driverSettled, engineIdentity, ids, unrelatedIds = [], inspect, persist = () => {} }) {
    const intent = c5IntentOf(run);
    const original = profile.box;
    const live = id => ids.includes(id);
    if (!intent) return { ids: [original.id], current: live(original.id) ? original : null, journal: null, unbound: [] };
    validateC5Intent(intent, run, profile);
    const driverStarted = run.operations.some(op => op?.kind === C5_DRIVER_NAME);
    if (driverStarted && !driverSettled) throw problem('the driver is not proven settled by the owned transport; a late create is possible, preserving resources');
    const newIds = productTransitionIds(profile).filter(id => !intent.priorTransitionIds.includes(id));
    const unexplained = known => ids.filter(id => !known.includes(id) && !unrelatedIds.includes(id));
    if (!driver || driver.productOperationId === null) {
        // No product operation was bound: no replacement is admitted. The original may be destroyed only when it is still the one live
        // container this run knows, so nothing unattributed can be in flight.
        if (newIds.length && !live(original.id)) throw problem('an unattributed product transition exists and the original Box is gone; preserving resources');
        if (unexplained([original.id]).length) throw problem('a container this run does not own is live; preserving resources');
        return { ids: [original.id], current: live(original.id) ? original : null, journal: null, unbound: newIds };
    }
    validateDriverReceipt(driver, intent, profile);
    if (JSON.stringify(newIds) !== JSON.stringify([driver.productOperationId])) throw problem('unexpected product transitions');
    engineIdentity = typeof engineIdentity === 'function' ? engineIdentity() : engineIdentity;
    const journal = validateBoundJournal(readC5ProductJournal(profile, driver.productOperationId), intent, driver, profile, engineIdentity);
    readC5Snapshot(profile, journal.old.configurationRef);
    readC5Snapshot(profile, journal.desired.configurationRef);
    const chain = [original.id];
    for (const attempt of journal.attempts) {
        const cid = readAttemptCid(profile, attempt);
        // A create intent without a durable CID: the engine may or may not have created. Nothing is adopted by name; the unexplained-container
        // check below preserves everything if any container appeared.
        if (!cid) continue;
        if ((attempt.observedId !== null && attempt.observedId !== cid.id) || chain.includes(cid.id)) throw problem('conflicting attempt CID');
        chain.push(cid.id);
        if (!live(cid.id)) continue;
        const observed = generationReceipt({ intent, driver, journal, attempt, profile, raw: await inspect(cid.id), engineIdentity });
        const recorded = run.ownedBoxes.find(box => box.id === cid.id);
        if (recorded && jsonDigest(recorded) !== jsonDigest(observed)) throw problem('immutable generation receipt changed');
        if (!recorded) { run.ownedBoxes.push(observed); persist(); }
    }
    if (unexplained(chain).length) throw problem('a container outside the bound product operation is live; preserving resources');
    const liveChain = chain.filter(live);
    if (liveChain.length > 1) throw problem('multiple current generations');
    if (journal.commitIntent && !chain.includes(journal.commitIntent.finalContainerId)) throw problem('commit selects an unreceipted generation');
    validateC5BoxReceipts(run, profile);
    const current = liveChain.length ? (liveChain[0] === original.id ? original : run.ownedBoxes.find(box => box.id === liveChain[0])) : null;
    return { ids: chain, current, journal, unbound: [] };
}
