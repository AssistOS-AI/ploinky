// C5 replacement custody is rooted in the original fixture receipt. A name or
// path-hash label can reject a foreign container, but can never admit one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { normalizeContainerRuntime, validateContainerConfiguration } from '../../ploinky-box/contract/container.mjs';
import { digestOf, validateJournal } from '../../ploinky-box/hardwareLimitsTransition.mjs';
import { writePrivateJson } from './fixtures.mjs';
import { HASH, ID, RUN_ID, absolute, assertWorkspace, bounded, digest, jsonDigest, keys } from './liveCommon.mjs';

export const C5_INTENT_SCHEMA = 'ploinky.hwl-c5-invocation/v1';
export const C5_DRIVER_SCHEMA = 'ploinky.hwl-c5-driver/v1';
export const C5_BOX_SCHEMA = 'ploinky.hwl-c5-box/v1';
export const C5_DRIVER_NAME = 'c5-transition-driver';
const REF = /^sha256-[a-f0-9]{64}$/;
const PRODUCT_ENGINE = /^[a-f0-9]{64}$/;
const MAX_BYTES = 256 * 1024;
const BINDING_KEYS = ['runId', 'caseId', 'invocationId', 'sourceDigest', 'engineIdentityDigest', 'workspaceReceiptDigest',
    'rootBoxId', 'expectedFrom', 'expectedTo', 'driverReceiptName', 'argvDigest', 'priorTransitionIds'];
const problem = message => new Error(`C5 custody: ${message}`);

export function productEngineDigest(info) {
    const values = [info?.host?.id ?? info?.Host?.ID, info?.store?.graphRoot ?? info?.Store?.GraphRoot,
        info?.store?.runRoot ?? info?.Store?.RunRoot, info?.version?.APIVersion ?? info?.Version?.APIVersion];
    if (values.some(value => typeof value !== 'string' || !value || value.length > 1024)) throw problem('incomplete product engine identity');
    return crypto.createHash('sha256').update(JSON.stringify(['podman', ...values])).digest('hex');
}

export function c5IntentOf(run) {
    const intents = run.operations.filter(op => op.kind === 'c5-downgrade');
    if (intents.length > 1) throw problem('more than one downgrade invocation');
    return intents[0] || null;
}

export function createC5Intent({ run, profile, driverReceiptName, argvDigest, priorTransitionIds, invocationId = crypto.randomBytes(16).toString('hex') }) {
    if (c5IntentOf(run)) throw problem('automatic downgrade retry is forbidden');
    const intent = { schema: C5_INTENT_SCHEMA, id: invocationId, kind: 'c5-downgrade', state: 'intent',
        runId: run.runId, caseId: 'LIVE-C5', invocationId, sourceDigest: profile.source.digest,
        engineIdentityDigest: profile.engine.identityDigest, workspaceReceiptDigest: jsonDigest(profile.workspace),
        rootBoxId: profile.box.id, expectedFrom: 'on', expectedTo: 'off', driverReceiptName, argvDigest, priorTransitionIds,
        resourceIds: [profile.box.id] };
    validateC5Intent(intent, run, profile);
    return intent;
}

export function validateC5Intent(intent, run, profile) {
    keys(intent, ['schema', 'id', 'kind', 'state', ...BINDING_KEYS, 'resourceIds'], 'C5 invocation');
    if (intent.schema !== C5_INTENT_SCHEMA || intent.kind !== 'c5-downgrade' || !['intent', 'observed'].includes(intent.state)
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

function assertPrivateParents(target) {
    if (!absolute(target)) throw problem('unsafe private receipt path');
    let directory = path.dirname(target);
    while (directory !== path.dirname(directory)) {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem('private receipt has a symlinked parent');
        directory = path.dirname(directory);
    }
}

export function readPrivateC5File(target, { json = true, missing = false, maxBytes = MAX_BYTES, sync = false } = {}) {
    assertPrivateParents(target);
    let fd;
    try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes || (stat.mode & 0o077) !== 0
            || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw problem('receipt is not one bounded private regular file');
        const bytes = fs.readFileSync(fd);
        if (sync) {
            fs.fsyncSync(fd);
            const directory = fs.openSync(path.dirname(target), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
            try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        }
        return json ? JSON.parse(bytes.toString('utf8')) : bytes;
    } finally { fs.closeSync(fd); }
}

export function persistDriverReceipt(target, receipt, intent, profile) {
    validateDriverReceipt(receipt, intent, profile);
    return writePrivateJson(target, receipt);
}

export function productDirectory(profile) {
    return path.join(profile.host.home, '.ploinky-box', 'hardware-limits', profile.box.instance, 'transitions');
}

export function productTransitionIds(profile) {
    const directory = productDirectory(profile);
    try {
        assertPrivateParents(path.join(directory, 'probe'));
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
    if (value.identity?.workspaceRoot !== profile.workspace.path || value.identity?.instance !== profile.box.instance
        || value.identity?.pathHash !== profile.box.pathHash || value.repositoryRoot !== profile.source.root
        || value.imageId !== profile.box.image || value.hostKind !== 'native-linux') throw problem('configuration belongs to another fixture');
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

export function exactContainerHandle(raw, id, engineIdentity) {
    if (!raw || (raw.Id ?? raw.ID) !== id || !ID.test(id)) throw problem('inspect did not return the exact full ID');
    return { id, name: String(raw.Name ?? '').replace(/^\//, ''), labels: raw.Config?.Labels || {},
        engine: 'podman', engineIdentity, runtime: normalizeContainerRuntime(raw) };
}

export function generationReceipt({ intent, driver, journal, attempt, profile, raw, engineIdentity }) {
    validateBoundJournal(journal, intent, driver, profile, engineIdentity);
    if (!RUN_ID.test(attempt.attemptId) || !journal.attempts.includes(attempt)) throw problem('unrecorded create attempt');
    const ref = attempt.stage === 'candidate' ? journal.desired.configurationRef : journal.old.configurationRef;
    const configuration = readC5Snapshot(profile, ref);
    if (attempt.configurationRef !== ref || attempt.contractHash !== digestOf(configuration)
        || (attempt.stage === 'candidate' ? configuration.hardware !== null : !configuration.hardware)) throw problem('attempt configuration mismatch');
    const bytes = readPrivateC5File(path.join(productDirectory(profile), `${attempt.attemptId}.cid`), { json: false, maxBytes: 128, sync: true });
    const id = bytes.toString('utf8').trim();
    if (!ID.test(id) || (attempt.observedId !== null && attempt.observedId !== id)) throw problem('missing or conflicting immutable CID');
    const handle = exactContainerHandle(raw, id, engineIdentity);
    if (handle.name !== profile.box.instance || handle.labels[BOX_LABELS.pathHash] !== profile.box.pathHash
        || handle.labels[BOX_LABELS.role] !== 'box') throw problem('replacement identity disagrees with its operation');
    validateContainerConfiguration(handle, configuration);
    if (!bounded(raw.Created, 128)) throw problem('replacement creation identity missing');
    return { schema: C5_BOX_SCHEMA, id, created: raw.Created, image: handle.runtime.imageId,
        contractDigest: jsonDigest({ labels: handle.labels, mounts: raw.Mounts }), instance: profile.box.instance, pathHash: profile.box.pathHash,
        predecessorId: profile.box.id, invocationId: intent.invocationId, productOperationId: journal.operationId,
        attemptId: attempt.attemptId, stage: attempt.stage, configurationRef: ref, cidDigest: digest(bytes), provenance: 'product-attempt-cid-full-id-inspect' };
}

export function validateC5BoxReceipts(run, profile) {
    const extra = run.ownedBoxes.filter(box => box.id !== profile.box.id);
    const intent = c5IntentOf(run);
    if (!extra.length) return;
    if (!intent || extra.length > 2) throw problem('additional Box without one C5 invocation');
    validateC5Intent(intent, run, profile);
    const ids = new Set([profile.box.id]); const stages = new Set();
    for (const box of extra) {
        keys(box, ['schema', 'id', 'created', 'image', 'contractDigest', 'instance', 'pathHash', 'predecessorId', 'invocationId',
            'productOperationId', 'attemptId', 'stage', 'configurationRef', 'cidDigest', 'provenance'], 'linked C5 Box');
        if (box.schema !== C5_BOX_SCHEMA || !ID.test(box.id) || ids.has(box.id) || !bounded(box.created, 128)
            || box.image !== profile.box.image || !HASH.test(box.contractDigest) || !HASH.test(box.cidDigest)
            || box.instance !== profile.box.instance || box.pathHash !== profile.box.pathHash || box.predecessorId !== profile.box.id
            || box.invocationId !== intent.invocationId || !RUN_ID.test(box.productOperationId) || !RUN_ID.test(box.attemptId)
            || !['candidate', 'rollback'].includes(box.stage) || stages.has(box.stage) || !REF.test(box.configurationRef)
            || box.provenance !== 'product-attempt-cid-full-id-inspect') throw problem('invalid linked immutable generation');
        ids.add(box.id); stages.add(box.stage);
    }
}

// Resolve every eligible ID before cleanup mutates anything. The caller must
// separately prove the owned driver transport settled; saved PIDs are never used.
export async function reconcileC5Custody({ run, profile, driver, engineIdentity, ids, inspect, persist = () => {} }) {
    const intent = c5IntentOf(run);
    if (!intent) return { ids: [profile.box.id], current: ids.includes(profile.box.id) ? profile.box : null, journal: null };
    validateC5Intent(intent, run, profile);
    const newIds = productTransitionIds(profile).filter(id => !intent.priorTransitionIds.includes(id));
    if (!driver) {
        if (newIds.length || run.operations.some(op => op.kind === C5_DRIVER_NAME)) throw problem('driver settlement or binding missing; preserving resources');
        return { ids: [profile.box.id], current: ids.includes(profile.box.id) ? profile.box : null, journal: null };
    }
    validateDriverReceipt(driver, intent, profile);
    if (driver.phase !== 'settled') throw problem('driver is not proven settled; a late create is possible');
    if (!driver.productOperationId) {
        if (newIds.length) throw problem('unattributed product transition');
        return { ids: [profile.box.id], current: ids.includes(profile.box.id) ? profile.box : null, journal: null };
    }
    if (JSON.stringify(newIds) !== JSON.stringify([driver.productOperationId])) throw problem('unexpected product transitions');
    const journal = validateBoundJournal(readC5ProductJournal(profile, driver.productOperationId), intent, driver, profile, engineIdentity);
    const chain = [profile.box.id];
    for (const attempt of journal.attempts) {
        const bytes = readPrivateC5File(path.join(productDirectory(profile), `${attempt.attemptId}.cid`), { json: false, maxBytes: 128, missing: true });
        if (!bytes) {
            // A create intent without a durable receipt cannot establish whether
            // an engine-side create completed. Never discover its replacement.
            throw problem('create attempt has no durable CID; preserving resources');
        }
        const id = bytes.toString('utf8').trim();
        if (!ID.test(id) || (attempt.observedId !== null && attempt.observedId !== id) || chain.includes(id)) throw problem('conflicting attempt CID');
        chain.push(id);
        if (!ids.includes(id)) continue;
        const observed = generationReceipt({ intent, driver, journal, attempt, profile, raw: await inspect(id), engineIdentity });
        const recorded = run.ownedBoxes.find(box => box.id === id);
        if (recorded && jsonDigest(recorded) !== jsonDigest(observed)) throw problem('immutable generation receipt changed');
        if (!recorded) { run.ownedBoxes.push(observed); persist(); }
    }
    const live = chain.filter(id => ids.includes(id));
    if (live.length > 1) throw problem('multiple current generations');
    if (journal.commitIntent && !chain.includes(journal.commitIntent.finalContainerId)) throw problem('commit selects an unreceipted generation');
    validateC5BoxReceipts(run, profile);
    return { ids: chain, current: live.length ? (live[0] === profile.box.id ? profile.box : run.ownedBoxes.find(box => box.id === live[0])) : null, journal };
}
