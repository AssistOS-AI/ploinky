// Stable immutable dependency objects under `.ploinky/deps/store/`.
//
// Layout (private format version FORMAT_VERSION; nothing else under
// `.ploinky/deps` belongs to the store):
//   format.json
//   objects/<buildUUID>/payload/        stable physical payload, never renamed
//   objects/<buildUUID>/manifest.json   immutable, written after verification
//   objects/<buildUUID>/complete.json   completion marker (binds manifest hash)
//   objects/<buildUUID>/work/           transient npm cache/config, removed
//   index/<inputKey>.json               mutable: full input key -> generation
//   receipts/build/<buildUUID>.json     owner-token build receipts
//   receipts/readers/<receiptId>.json   reader receipts
//   state/unusable/<buildUUID>.json     corruption marks for new consumers
//   state/pins.json                     identity-bound Git pins
//
// Every mutating entry point requires the caller's held workspace mutation
// lease and asserts it; nothing here acquires or waits for a lease.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { assertWorkspaceMutationLease } from '../../runtime/maintenanceLocks.js';
import { agentLibCacheLinkProblem, ensureAgentLibCacheLink, installWithAgentLib } from '../agentLibLink.js';
import { finalizeBoxMcpSdkCache, installWithBoxMcpSdk } from '../../../../ploinky-box/agent-dependencies/mcp-sdk.mjs';
import { isInsideBox } from '../../../../ploinky-box/lib/boxMarker.mjs';
import { dependencyStoreError, canonicalDigest, FULL_SHA256_PATTERN, assertFullSha256, sha256Hex } from './canonical.mjs';
import { commitPinState, fsyncDirectory, readPinState, writeFileAtomic } from './gitPins.mjs';
import { seedCopyEligibility } from './installContract.mjs';
import {
    currentWriterIdentity,
    defaultProveBuildQuiescent,
    defaultProveReaderQuiescent,
} from './receipts.mjs';
import { buildResolutionManifest, readHiddenLock, verifyDirectGitProvenance } from './resolution.mjs';
import { hashInstalledTree } from './treeHash.mjs';

export const DEPENDENCY_STORE_DIRNAME = 'store';
export const FORMAT_NAME = 'ploinky-deps-cache';
export const FORMAT_VERSION = 1;
export const OBJECT_OWNER = 'ploinky-deps-store';
const DEFAULT_MIN_FREE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_BUILD_ATTEMPTS = 2;
const BUILD_RECEIPT_TTL_MS = 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NON_RETRYABLE = new Set([
    'PLOINKY_DEPS_DISK_SPACE',
    'PLOINKY_DEPS_NPM_POLICY_UNREPRESENTABLE',
    'PLOINKY_DEPS_PROVENANCE_MISMATCH',
    'PLOINKY_DEPS_TREE_UNSAFE',
    'PLOINKY_WORKSPACE_MUTATION_CAPABILITY_REQUIRED',
    'PLOINKY_DEPS_STORE_FORMAT_UNKNOWN',
    'PLOINKY_DEPS_AGENTLIB_LINK_INVALID',
]);

export function defaultCheckDiskSpace({ directory, requiredBytes, fsApi = fs }) {
    if (typeof fsApi.statfsSync !== 'function') return { ok: true, availableBytes: null };
    const stats = fsApi.statfsSync(directory);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    return { ok: availableBytes >= requiredBytes, availableBytes };
}

function readJson(file, fsApi) {
    try { return { value: JSON.parse(fsApi.readFileSync(file, 'utf8')) }; }
    catch (error) {
        if (error?.code === 'ENOENT') return { missing: true };
        return { corrupt: error.message };
    }
}

function writeJsonAtomic(file, value, fsApi, mode = 0o644) {
    writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { fsApi, mode });
}

/**
 * Why a build receipt does not prove that this workspace's store owns the
 * object it names, or ''. Only an owned receipt may authorize reclaiming an
 * incomplete object or removing the receipt itself.
 */
export function buildReceiptOwnershipProblem(receipt, { objectId, workspaceId, objectsDir }) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return 'build receipt is unreadable';
    if (receipt.kind !== 'build') return `build receipt kind is ${JSON.stringify(receipt.kind ?? null)}`;
    if (receipt.workspaceId !== workspaceId) return 'build receipt belongs to another workspace';
    if (receipt.receiptId !== objectId) return 'build receipt id does not name this object';
    if (receipt.objectPath !== path.join(objectsDir, String(objectId))) return 'build receipt names another object path';
    return '';
}

const REBUILD_DESIRED_STATUSES = new Set(['pending', 'failed']);

/** Why a rebuild state record is not exactly what updateRebuildState writes, or ''. */
function rebuildStateProblem(value, registration) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not a JSON object';
    if (value.schema !== 1) return `schema ${JSON.stringify(value.schema ?? null)} is not 1`;
    if (value.registration !== registration) return 'registration does not match its file';
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) return 'revision is not a positive integer';
    if (value.admittedToken !== null && typeof value.admittedToken !== 'string') return 'admitted token is invalid';
    const desired = value.desired;
    if (desired !== null && (!desired || typeof desired !== 'object' || Array.isArray(desired)
        || typeof desired.token !== 'string' || !REBUILD_DESIRED_STATUSES.has(desired.status))) {
        return 'desired request is invalid';
    }
    return '';
}

function stageError(error, stage) {
    if (error && typeof error === 'object' && !error.stage) error.stage = stage;
    return error;
}

/**
 * Create a store bound to one workspace.
 *
 * @param {{ depsDir: string, workspaceRoot: string, assertLease?: Function, fsApi?: object,
 *   checkDiskSpace?: Function, minFreeBytes?: number, writerIdentity?: Function, now?: Function,
 *   uuid?: Function, hooks?: { at?: Function }, copySeed?: Function,
 *   proveBuildQuiescent?: Function, proveReaderQuiescent?: Function }} options
 */
export function createCacheStore({
    depsDir,
    workspaceRoot,
    assertLease = assertWorkspaceMutationLease,
    fsApi = fs,
    checkDiskSpace = defaultCheckDiskSpace,
    minFreeBytes = DEFAULT_MIN_FREE_BYTES,
    writerIdentity = currentWriterIdentity,
    now = () => new Date().toISOString(),
    uuid = () => crypto.randomUUID(),
    hooks = {},
    copySeed = defaultCopySeed,
    proveBuildQuiescent = defaultProveBuildQuiescent,
    proveReaderQuiescent = defaultProveReaderQuiescent,
} = {}) {
    if (!depsDir || !workspaceRoot) throw new Error('createCacheStore requires depsDir and workspaceRoot');
    const root = path.join(path.resolve(depsDir), DEPENDENCY_STORE_DIRNAME);
    const workspaceId = sha256Hex(fsApi.realpathSync(path.resolve(workspaceRoot)));
    const paths = {
        root,
        format: path.join(root, 'format.json'),
        objects: path.join(root, 'objects'),
        index: path.join(root, 'index'),
        buildReceipts: path.join(root, 'receipts', 'build'),
        readerReceipts: path.join(root, 'receipts', 'readers'),
        unusable: path.join(root, 'state', 'unusable'),
        pins: path.join(root, 'state', 'pins.json'),
    };
    const at = (stage, context) => { if (typeof hooks.at === 'function') hooks.at(stage, context); };

    function requireLease(lease) {
        return assertLease(lease);
    }

    function ensureLayout() {
        const existing = readJson(paths.format, fsApi);
        if (existing.corrupt || (existing.value && (existing.value.format !== FORMAT_NAME || existing.value.version !== FORMAT_VERSION))) {
            throw dependencyStoreError('PLOINKY_DEPS_STORE_FORMAT_UNKNOWN',
                `dependency cache format at ${paths.format} is not ${FORMAT_NAME} v${FORMAT_VERSION}; refusing to touch it`);
        }
        for (const directory of [paths.objects, paths.index, paths.buildReceipts, paths.readerReceipts, paths.unusable]) {
            fsApi.mkdirSync(directory, { recursive: true });
        }
        if (existing.missing) writeJsonAtomic(paths.format, { format: FORMAT_NAME, version: FORMAT_VERSION, workspaceId }, fsApi);
    }

    const objectDir = (objectId) => {
        if (!UUID_PATTERN.test(String(objectId || ''))) throw dependencyStoreError('PLOINKY_DEPS_OBJECT_ID_INVALID', `invalid object id ${objectId}`);
        return path.join(paths.objects, objectId);
    };
    const payloadPathOf = (objectId) => path.join(objectDir(objectId), 'payload');
    const indexPath = (inputKey) => path.join(paths.index, `${assertFullSha256(inputKey, 'inputKey')}.json`);

    function readIndex(inputKey) {
        const entry = readJson(indexPath(inputKey), fsApi);
        if (entry.missing) return null;
        if (entry.corrupt) return { corrupt: true, reason: `index entry unreadable: ${entry.corrupt}` };
        return entry.value;
    }

    function isUnusable(objectId) {
        return fsApi.existsSync(path.join(paths.unusable, `${objectId}.json`));
    }

    /**
     * Full validation of one object against an expected full input key:
     * owner/workspace/format, completion marker bound to the manifest bytes,
     * recomputed contract key, stable physical path, not marked unusable,
     * recomputed installed-tree hash, recomputed resolution hash and
     * generation ID.
     */
    function validateObject(objectId, { inputKey }) {
        let dir;
        try { dir = objectDir(objectId); } catch (error) { return { valid: false, reason: error.message }; }
        if (isUnusable(objectId)) return { valid: false, reason: 'object is marked unusable' };
        const complete = readJson(path.join(dir, 'complete.json'), fsApi);
        if (!complete.value) return { valid: false, reason: complete.missing ? 'completion marker missing' : 'completion marker corrupt' };
        let manifestBytes;
        try { manifestBytes = fsApi.readFileSync(path.join(dir, 'manifest.json')); }
        catch { return { valid: false, reason: 'manifest missing' }; }
        if (sha256Hex(manifestBytes) !== complete.value.manifestSha256) return { valid: false, reason: 'manifest does not match its completion marker' };
        let manifest;
        try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { return { valid: false, reason: 'manifest corrupt' }; }
        if (manifest.format !== FORMAT_NAME || manifest.version !== FORMAT_VERSION || manifest.owner !== OBJECT_OWNER) {
            return { valid: false, reason: 'object format/owner mismatch' };
        }
        if (manifest.workspaceId !== workspaceId) return { valid: false, reason: 'object belongs to another workspace' };
        if (manifest.objectId !== objectId) return { valid: false, reason: 'object id mismatch' };
        if (manifest.inputKey !== inputKey || canonicalDigest(manifest.contract) !== inputKey) {
            return { valid: false, reason: 'full input key mismatch' };
        }
        const payloadPath = payloadPathOf(objectId);
        if (manifest.payloadPath !== payloadPath) return { valid: false, reason: 'payload path moved' };
        let tree;
        try {
            tree = hashInstalledTree(payloadPath, { approvedExternalTargets: manifest.approvedExternalTargets || [], fsApi });
        } catch (error) {
            return { valid: false, reason: `installed tree invalid: ${error.message}` };
        }
        if (tree.hash !== manifest.tree?.hash) return { valid: false, reason: 'installed tree hash mismatch' };
        const resolution = buildResolutionManifest(readHiddenLock(payloadPath, { fsApi }), { installer: manifest.resolution?.installer || null });
        if (resolution.hash !== manifest.resolution?.hash) return { valid: false, reason: 'resolution evidence mismatch' };
        const generationId = generationIdFor(inputKey, resolution.hash, tree.hash);
        if (generationId !== manifest.generationId || generationId !== complete.value.generationId) {
            return { valid: false, reason: 'generation id mismatch' };
        }
        return { valid: true, reason: 'ok', manifest, payloadPath, generationId };
    }

    function markUnusable(lease, objectId, reason) {
        requireLease(lease);
        objectDir(objectId);
        const file = path.join(paths.unusable, `${objectId}.json`);
        if (fsApi.existsSync(file)) return false;
        writeJsonAtomic(file, { objectId, reason: String(reason || 'invalid'), markedAt: now() }, fsApi);
        return true;
    }

    const buildReceiptOwnership = (receipt, objectId) => buildReceiptOwnershipProblem(receipt, { objectId, workspaceId, objectsDir: paths.objects });

    /** A present build receipt file: its parsed value, whether it is ours, and its quiescence. */
    function inspectBuildReceipt(objectId) {
        const parsed = readJson(path.join(paths.buildReceipts, `${objectId}.json`), fsApi);
        if (parsed.missing) return null;
        const receipt = parsed.value ?? null;
        const ownership = buildReceiptOwnership(receipt, objectId);
        const quiescence = ownership
            ? { quiescent: false, reason: `ownership unproven: ${ownership}` }
            : proveBuildQuiescent(receipt);
        return {
            receipt,
            ownership,
            summary: { state: receipt?.state ?? null, installer: receipt?.installer ?? null, quiescence, owned: !ownership },
        };
    }

    function writeBuildReceipt(receipt) {
        writeJsonAtomic(path.join(paths.buildReceipts, `${receipt.receiptId}.json`), receipt, fsApi);
    }

    function updateBuildReceipt(receipt, patch) {
        const file = path.join(paths.buildReceipts, `${receipt.receiptId}.json`);
        const current = readJson(file, fsApi).value;
        if (!current || current.token !== receipt.token) return false;
        Object.assign(receipt, patch, { updatedAt: now() });
        writeBuildReceipt(receipt);
        return true;
    }

    function removeOwnBuildReceipt(receipt) {
        const file = path.join(paths.buildReceipts, `${receipt.receiptId}.json`);
        const current = readJson(file, fsApi).value;
        if (!current || current.token !== receipt.token) return false;
        fsApi.rmSync(file, { force: true });
        return true;
    }

    function writeReaderReceipt(generation, consumer) {
        if (!consumer?.kind) throw dependencyStoreError('PLOINKY_DEPS_RECEIPT_INVALID', 'reader receipts require a consumer kind');
        // A stable consumer key makes re-acquisition by the same consumer of
        // the same object idempotent (warm starts do not accumulate receipts).
        const receiptId = consumer.key
            ? `c-${sha256Hex(`${consumer.key}\n${generation.objectId}`)}`
            : uuid();
        const file = path.join(paths.readerReceipts, `${receiptId}.json`);
        const existing = consumer.key ? readJson(file, fsApi).value : null;
        const receipt = {
            schema: 1,
            kind: 'reader',
            receiptId,
            token: existing?.token || uuid(),
            workspaceId,
            objectId: generation.objectId,
            generationId: generation.generationId,
            inputKey: generation.inputKey,
            payloadPath: generation.payloadPath,
            consumer: { ...(existing?.consumer || {}), ...consumer, phase: consumer.phase || existing?.consumer?.phase || 'preparing' },
            writer: writerIdentity(),
            createdAt: existing?.createdAt || now(),
            updatedAt: now(),
        };
        writeJsonAtomic(file, receipt, fsApi);
        return { receiptId, token: receipt.token, path: file };
    }

    /**
     * Publish a reader receipt for a validated generation before its path is
     * handed to a consumer. Runtimes update `consumer` (container ID, pid,
     * phase) as they progress; attachments release their own receipt.
     */
    function acquireReaderReceipt(lease, generation, consumer) {
        requireLease(lease);
        return writeReaderReceipt(generation, consumer);
    }

    /** Validate and pin under the collector's lease before exposing the path. */
    function acquireAttachmentReceipt(lease, generation, consumer) {
        requireLease(lease);
        const handle = writeReaderReceipt(generation, { ...consumer, phase: consumer?.phase || 'attached' });
        const validation = validateObject(generation.objectId, { inputKey: generation.inputKey });
        // The caller's recorded paths and generation must be exactly the
        // validated object's; a record naming anything else is never exposed.
        let problem = validation.valid ? '' : validation.reason;
        if (!problem && validation.generationId !== generation.generationId) problem = 'generation id differs from the validated object';
        if (!problem && path.resolve(String(generation.payloadPath || '')) !== validation.payloadPath) problem = 'payload path differs from the validated object';
        if (!problem && path.resolve(String(generation.nodeModulesPath || '')) !== path.join(validation.payloadPath, 'node_modules')) {
            problem = 'node_modules path differs from the validated object';
        }
        if (problem) {
            releaseReaderReceipt(handle);
            throw dependencyStoreError('PLOINKY_DEPS_GENERATION_INVALID',
                `admitted dependency generation ${String(generation.generationId || '').slice(0, 12)} is not usable: ${problem}; restart the service first`);
        }
        return handle;
    }

    const rebuildFile = (registration) => path.join(root, 'state', 'rebuild', `${sha256Hex(String(registration || ''))}.json`);

    /**
     * Rebuild state of one logical registration:
     *   { schema: 1, registration, revision, admittedToken: string|null,
     *     desired: { token, status: 'pending'|'failed', requestedAt, updatedAt, error? } | null }
     * The ADMITTED token feeds ordinary lifecycle keys; the DESIRED request is
     * retryable and only a reinstall acts on it.
     */
    // A missing file is "no state"; anything present must be exactly what
    // updateRebuildState writes, or it is refused (never defaulted and then
    // overwritten, and never dropped from the collector's root set).
    function readRebuildStateFile(file, registration) {
        const parsed = readJson(file, fsApi);
        if (parsed.missing) return null;
        const problem = parsed.corrupt ? `unreadable: ${parsed.corrupt}` : rebuildStateProblem(parsed.value, registration);
        if (problem) {
            throw dependencyStoreError('PLOINKY_DEPS_REBUILD_STATE_CORRUPT',
                `dependency rebuild state ${file} is unusable (${problem}); refusing to use or overwrite it`);
        }
        const value = parsed.value;
        return { schema: 1, registration, revision: value.revision, admittedToken: value.admittedToken, desired: value.desired };
    }

    function readRebuildState(registration) {
        const name = String(registration || '');
        return readRebuildStateFile(rebuildFile(name), name)
            || { schema: 1, registration: name, revision: 0, admittedToken: null, desired: null };
    }

    /** The admitted rebuild token of one logical registration. */
    function readRebuildToken(registration) {
        return readRebuildState(registration).admittedToken;
    }

    /** Atomic compare-and-replace of one registration's rebuild state under the lease. */
    function updateRebuildState(lease, registration, mutate) {
        requireLease(lease);
        ensureLayout();
        const current = readRebuildState(registration);
        const next = mutate(structuredClone(current));
        const again = readRebuildState(registration);
        if (again.revision !== current.revision) {
            throw dependencyStoreError('PLOINKY_DEPS_REBUILD_CONFLICT', `rebuild state for ${registration} changed concurrently`);
        }
        const written = { ...next, schema: 1, registration: current.registration, revision: current.revision + 1, updatedAt: now() };
        writeJsonAtomic(rebuildFile(registration), written, fsApi);
        return written;
    }

    /** Every registration with a pending or failed desired rebuild request. */
    function listRebuildStates() {
        const directory = path.join(root, 'state', 'rebuild');
        return safeReaddir(directory)
            .map((name) => {
                const file = path.join(directory, name);
                const registration = readJson(file, fsApi).value?.registration;
                // The file name binds the record to its registration.
                const expected = typeof registration === 'string' && `${sha256Hex(registration)}.json` === name ? registration : null;
                return readRebuildStateFile(file, expected);
            })
            .filter(Boolean);
    }

    function updateReaderReceipt(lease, handle, consumerPatch) {
        requireLease(lease);
        const current = readJson(handle.path, fsApi).value;
        if (!current || current.token !== handle.token) {
            throw dependencyStoreError('PLOINKY_DEPS_RECEIPT_LOST', `reader receipt ${handle.receiptId} is no longer owned`);
        }
        const next = { ...current, consumer: { ...current.consumer, ...consumerPatch }, updatedAt: now() };
        writeJsonAtomic(handle.path, next, fsApi);
        return handle;
    }

    /** An owner releases its own receipt (for example in an attachment's finally). */
    function releaseReaderReceipt(handle) {
        if (!handle?.path) return false;
        const current = readJson(handle.path, fsApi).value;
        if (!current || current.token !== handle.token) return false;
        fsApi.rmSync(handle.path, { force: true });
        return true;
    }

    /**
     * Remove another owner's receipt only with positive quiescence proof.
     * The receipt content is rechecked immediately before removal.
     */
    function removeStaleReceipt(lease, receiptPath, { proof = null } = {}) {
        requireLease(lease);
        const resolved = path.resolve(receiptPath);
        const isBuild = path.dirname(resolved) === paths.buildReceipts;
        if (!isBuild && path.dirname(resolved) !== paths.readerReceipts) {
            throw dependencyStoreError('PLOINKY_DEPS_RECEIPT_INVALID', `${receiptPath} is not a cache receipt`);
        }
        const before = readJson(resolved, fsApi);
        if (before.missing) return { removed: false, reason: 'already absent' };
        if (!before.value) return { removed: false, reason: 'receipt unreadable; retained' };
        const ownership = isBuild ? buildReceiptOwnership(before.value, path.basename(resolved, '.json')) : '';
        if (ownership) return { removed: false, reason: `${ownership}; retained` };
        const verdict = (proof || (isBuild ? proveBuildQuiescent : proveReaderQuiescent))(before.value);
        if (!verdict?.quiescent) return { removed: false, reason: verdict?.reason || 'quiescence not proven' };
        const again = readJson(resolved, fsApi).value;
        if (!again || again.token !== before.value.token || again.updatedAt !== before.value.updatedAt
            || (isBuild && buildReceiptOwnership(again, path.basename(resolved, '.json')))) {
            return { removed: false, reason: 'receipt changed during proof' };
        }
        fsApi.rmSync(resolved, { force: true });
        return { removed: true, reason: verdict.reason };
    }

    function publishIndex(lease, inputKey, generation, observedEntry) {
        requireLease(lease);
        const current = readIndex(inputKey);
        if (current && !current.corrupt && current.objectId !== observedEntry?.objectId && current.objectId !== generation.objectId) {
            // Another writer published after our lookup: accept it only after
            // complete revalidation against the full key.
            const competing = validateObject(current.objectId, { inputKey });
            if (competing.valid) return { published: false, winner: generationFromValidation(current.objectId, inputKey, competing) };
            if (UUID_PATTERN.test(String(current.objectId || ''))) markUnusable(lease, current.objectId, competing.reason);
        }
        writeJsonAtomic(indexPath(inputKey), {
            format: FORMAT_NAME,
            version: FORMAT_VERSION,
            inputKey,
            generationId: generation.generationId,
            objectId: generation.objectId,
            payloadPath: generation.payloadPath,
            previousObjectId: current && !current.corrupt ? current.objectId : null,
            publishedAt: now(),
        }, fsApi);
        return { published: true, winner: null };
    }

    function generationFromValidation(objectId, inputKey, validation) {
        return {
            objectId,
            inputKey,
            generationId: validation.generationId,
            payloadPath: validation.payloadPath,
            nodeModulesPath: path.join(validation.payloadPath, 'node_modules'),
        };
    }

    function buildObject(lease, plan, { installer, operation, seedSource, installOptions, pinVerification }) {
        requireLease(lease);
        const space = checkDiskSpace({ directory: paths.objects, requiredBytes: minFreeBytes, fsApi });
        if (!space?.ok) {
            throw dependencyStoreError('PLOINKY_DEPS_DISK_SPACE',
                `insufficient free space for a dependency build (${space?.availableBytes ?? 'unknown'} < ${minFreeBytes} bytes)`);
        }
        const objectId = uuid();
        const dir = objectDir(objectId);
        const payloadPath = path.join(dir, 'payload');
        const workDir = path.join(dir, 'work');
        const receipt = {
            schema: 1,
            kind: 'build',
            receiptId: objectId,
            token: uuid(),
            workspaceId,
            operation: String(operation || 'dependency-build'),
            inputKey: plan.inputKey,
            objectPath: dir,
            payloadPath,
            writer: writerIdentity(),
            installer: seedSource ? null : (installer?.describe?.({ objectId }) || null),
            installerStarted: false,
            state: 'reserved',
            ttlMsDiagnostic: BUILD_RECEIPT_TTL_MS,
            createdAt: now(),
            updatedAt: now(),
        };
        writeBuildReceipt(receipt);
        at('receipt-published', { objectId, receipt });
        try {
            fsApi.mkdirSync(dir);
            fsApi.mkdirSync(payloadPath);
            fsApi.mkdirSync(path.join(payloadPath, 'node_modules'));
            fsApi.mkdirSync(workDir, { mode: 0o700 });
            updateBuildReceipt(receipt, { state: 'building' });
            at('object-allocated', { objectId, payloadPath });
            fsApi.writeFileSync(path.join(payloadPath, 'package.json'), JSON.stringify(plan.installManifest, null, 2));
            try {
                if (seedSource) {
                    copySeed(path.join(seedSource.payloadPath, 'node_modules'), path.join(payloadPath, 'node_modules'), { fsApi });
                } else if (plan.npmRequired) {
                    if (!installer) throw dependencyStoreError('PLOINKY_DEPS_INSTALLER_REQUIRED', 'an installer is required for this build');
                    updateBuildReceipt(receipt, { installerStarted: true });
                    runProviderInstall(payloadPath, plan, (installPath, options) => installer.install({
                        payloadDir: installPath, workDir, objectId, options, ...installOptions,
                    }));
                }
                finalizeProviders(payloadPath, plan);
            } finally {
                fsApi.rmSync(workDir, { recursive: true, force: true });
            }
            at('payload-installed', { objectId, payloadPath });

            const hiddenLock = readHiddenLock(payloadPath, { fsApi });
            const installerDescription = seedSource ? { kind: 'seed-copy', seedGenerationId: seedSource.generationId } : (receipt.installer || null);
            const resolution = buildResolutionManifest(hiddenLock, { installer: installerDescription });
            const provenance = verifyDirectGitProvenance(payloadPath, plan.expectedGit, { hiddenLock, pinVerification, fsApi });
            const approvedExternalTargets = approvedTargets(plan);
            const tree = hashInstalledTree(payloadPath, { approvedExternalTargets, fsApi });
            const generationId = generationIdFor(plan.inputKey, resolution.hash, tree.hash);
            at('verified', { objectId, generationId });

            const manifest = {
                format: FORMAT_NAME,
                version: FORMAT_VERSION,
                owner: OBJECT_OWNER,
                workspaceId,
                objectId,
                kind: plan.kind,
                inputKey: plan.inputKey,
                contract: plan.contract,
                payloadPath,
                approvedExternalTargets,
                resolution: { hash: resolution.hash, installer: installerDescription, evidence: resolution.manifest.evidence },
                provenance,
                tree,
                generationId,
                seededFrom: seedSource ? { objectId: seedSource.objectId, generationId: seedSource.generationId } : null,
                createdAt: now(),
            };
            const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
            writeFileAtomic(path.join(dir, 'manifest.json'), manifestText, { fsApi, mode: 0o444 });
            at('manifest-written', { objectId });
            writeJsonAtomic(path.join(dir, 'complete.json'), {
                format: FORMAT_NAME, version: FORMAT_VERSION, objectId, generationId, manifestSha256: sha256Hex(manifestText),
            }, fsApi, 0o444);
            fsyncDirectory(dir, fsApi);
            updateBuildReceipt(receipt, { state: 'complete' });
            at('completion-written', { objectId, generationId });
            return {
                receipt,
                generation: {
                    objectId, inputKey: plan.inputKey, generationId, payloadPath,
                    nodeModulesPath: path.join(payloadPath, 'node_modules'), provenance,
                },
            };
        } catch (error) {
            try { updateBuildReceipt(receipt, { state: 'failed', error: String(error?.code || 'error') }); } catch { /* keep receipt as is */ }
            throw error;
        }
    }

    function lookup(lease, inputKey) {
        const entry = readIndex(inputKey);
        if (!entry) return { hit: null, corruption: null, entry: null };
        if (entry.corrupt) return { hit: null, corruption: { objectId: null, reason: entry.reason }, entry };
        const validation = validateObject(entry.objectId, { inputKey });
        if (validation.valid) return { hit: generationFromValidation(entry.objectId, inputKey, validation), corruption: null, entry };
        if (UUID_PATTERN.test(String(entry.objectId || ''))) markUnusable(lease, entry.objectId, validation.reason);
        return { hit: null, corruption: { objectId: entry.objectId, reason: validation.reason }, entry };
    }

    function pinVerificationFor(plan) {
        const pins = plan.kind === 'agent' ? plan.contract.agent.pins : plan.contract.global.pins;
        return new Map((pins || []).map((pin) => [pin.name, 'remote-verified']));
    }

    function ensureInternal(lease, plan, {
        installer = null,
        consumer,
        operation,
        reinstall = false,
        seedSource = null,
        prelookup = null,
        maxAttempts = DEFAULT_MAX_BUILD_ATTEMPTS,
        installOptions = {},
    }) {
        requireLease(lease);
        ensureLayout();
        assertFullSha256(plan?.inputKey, 'inputKey');
        const startedAt = Date.now();
        // A reinstall carries a fresh rebuild token, so its exact key misses
        // naturally; a retried request with the same token must reuse the
        // object it already built instead of producing duplicates.
        const found = prelookup || lookup(lease, plan.inputKey);
        if (found.hit) {
            const readerReceipt = acquireReaderReceipt(lease, found.hit, consumer);
            return { status: 'hit', ...found.hit, readerReceipt, corruption: null, timings: { totalMs: Date.now() - startedAt } };
        }
        let built = null;
        let lastError = null;
        const attempts = Math.max(1, Math.min(5, Number(maxAttempts) || 1));
        for (let attempt = 1; attempt <= attempts && !built; attempt += 1) {
            try {
                built = buildObject(lease, plan, { installer, operation, seedSource, installOptions, pinVerification: pinVerificationFor(plan) });
            } catch (error) {
                lastError = stageError(error, 'build');
                if (NON_RETRYABLE.has(error?.code)) break;
            }
        }
        if (!built) {
            const failure = dependencyStoreError('PLOINKY_DEPS_BUILD_FAILED',
                `dependency build for ${plan.kind} ${plan.inputKey.slice(0, 12)} failed: ${lastError?.message || 'unknown error'}`,
                { cause: lastError?.code || null, corruption: found.corruption });
            failure.cause = lastError;
            throw failure;
        }
        const publication = publishIndex(lease, plan.inputKey, built.generation, found.entry);
        at('index-published', { objectId: built.generation.objectId, published: publication.published });
        const generation = publication.winner || built.generation;
        updateBuildReceipt(built.receipt, { state: publication.published ? 'published' : 'superseded' });
        const readerReceipt = acquireReaderReceipt(lease, generation, consumer);
        at('reader-published', { objectId: generation.objectId, readerReceipt });
        // The reader now owns the reference; a superseded unpublished object
        // keeps its receipt so only proven-quiescent collection may remove it.
        if (publication.published) removeOwnBuildReceipt(built.receipt);
        const status = publication.winner ? 'winner-accepted'
            : (reinstall ? 'reinstalled' : (found.corruption ? 'repaired' : 'built'));
        return {
            status,
            ...generation,
            readerReceipt,
            corruption: found.corruption,
            supersededObjectId: publication.winner ? built.generation.objectId : null,
            timings: { totalMs: Date.now() - startedAt },
        };
    }

    /**
     * Resolve or build the generation for one plan and return its stable path
     * with a published reader receipt.
     */
    function ensureGeneration(lease, plan, options = {}) {
        return ensureInternal(lease, plan, options);
    }

    /**
     * Agent generation: a valid agent object is returned without touching the
     * seed. Otherwise an exact-contract seed is copied (never hardlinked) when
     * no npm run follows; any npm run or a reinstall starts from an empty
     * payload. Seeds are validated and rebuilt automatically when corrupt.
     */
    function ensureAgentGeneration(lease, { agentPlan, seedPlan, installer, consumer, operation, reinstall = false, installOptions = {} }) {
        requireLease(lease);
        ensureLayout();
        const prelookup = lookup(lease, agentPlan.inputKey);
        if (prelookup.hit) return { ...ensureInternal(lease, agentPlan, { consumer, operation, prelookup }), seed: null, seedDecision: 'agent hit' };
        const eligibility = seedPlan ? seedCopyEligibility(agentPlan, seedPlan, { reinstall }) : { eligible: false, reason: 'no seed plan' };
        if (!eligibility.eligible) {
            return { ...ensureInternal(lease, agentPlan, { installer, consumer, operation, reinstall, prelookup, installOptions }), seed: null, seedDecision: eligibility.reason };
        }
        const seed = ensureInternal(lease, seedPlan, {
            installer,
            operation,
            installOptions,
            consumer: { kind: 'seed-copy', process: writerIdentity(), registration: agentPlan.registration || null, phase: 'copying' },
        });
        try {
            const result = ensureInternal(lease, agentPlan, { consumer, operation, prelookup, seedSource: seed });
            return { ...result, seed: { status: seed.status, generationId: seed.generationId, objectId: seed.objectId }, seedDecision: eligibility.reason };
        } finally {
            releaseReaderReceipt(seed.readerReceipt);
        }
    }

    function readPins() {
        return readPinState(paths.pins, { fsApi });
    }

    /** Atomic compare/merge of pin state under the held lease. */
    function updatePins(lease, mutate) {
        requireLease(lease);
        ensureLayout();
        const current = readPinState(paths.pins, { fsApi });
        const next = mutate({ ...current.pins });
        return commitPinState(paths.pins, { expectedRevision: current.revision, pins: next }, { fsApi });
    }

    /**
     * Read-only inventory for collection (P2e) and diagnostics. Nothing is
     * deleted here; `classification` states what a collector could prove.
     */
    function describeObjects() {
        const inventory = [];
        const indexed = new Map();
        for (const name of safeReaddir(paths.index)) {
            const entry = readJson(path.join(paths.index, name), fsApi).value;
            if (entry?.objectId) indexed.set(entry.objectId, [...(indexed.get(entry.objectId) || []), entry.inputKey]);
        }
        const readers = new Map();
        for (const name of safeReaddir(paths.readerReceipts)) {
            const receipt = readJson(path.join(paths.readerReceipts, name), fsApi).value;
            if (receipt?.objectId) readers.set(receipt.objectId, (readers.get(receipt.objectId) || 0) + 1);
        }
        const objectIds = new Set(safeReaddir(paths.objects));
        for (const name of safeReaddir(paths.buildReceipts)) {
            const objectId = name.replace(/\.json$/, '');
            if (objectIds.has(objectId)) continue;
            const inspected = inspectBuildReceipt(objectId);
            if (!inspected) continue; // Released by its owner meanwhile.
            const quiescence = inspected.summary.quiescence;
            inventory.push({
                objectId,
                path: null,
                complete: false,
                indexedBy: [],
                readerReceipts: 0,
                unusable: false,
                buildReceipt: inspected.summary,
                classification: quiescence.quiescent ? 'receipt-only-reclaimable' : 'receipt-only-retained',
                retain: !quiescence.quiescent,
                reasons: [quiescence.quiescent ? 'object never allocated'
                    : (inspected.ownership ? `build-receipt-unowned: ${inspected.ownership}` : `build-writer-unproven: ${quiescence.reason}`)],
            });
        }
        for (const objectId of objectIds) {
            if (!UUID_PATTERN.test(objectId)) {
                inventory.push({ objectId, classification: 'unknown-entry', retain: true, reasons: ['unrecognized name'] });
                continue;
            }
            const dir = path.join(paths.objects, objectId);
            const complete = fsApi.existsSync(path.join(dir, 'complete.json'));
            // Only a receipt proven to be this store's own build of exactly
            // this object may make an incomplete object reclaimable.
            const inspected = inspectBuildReceipt(objectId);
            const quiescence = inspected?.summary.quiescence || null;
            const reasons = [];
            if (indexed.has(objectId)) reasons.push('indexed');
            if (readers.get(objectId)) reasons.push('reader-receipts');
            if (inspected?.ownership) reasons.push(`build-receipt-unowned: ${inspected.ownership}`);
            else if (inspected && !quiescence.quiescent) reasons.push(`build-writer-unproven: ${quiescence.reason}`);
            if (!complete && !inspected) reasons.push('incomplete-without-receipt');
            let classification;
            if (indexed.has(objectId) || readers.get(objectId)) classification = 'rooted';
            else if (!complete && inspected && !inspected.ownership && quiescence.quiescent) classification = 'unpublished-reclaimable';
            else if (!complete) classification = 'unpublished-retained';
            else classification = 'complete-unindexed';
            inventory.push({
                objectId,
                path: dir,
                complete,
                indexedBy: indexed.get(objectId) || [],
                readerReceipts: readers.get(objectId) || 0,
                unusable: isUnusable(objectId),
                buildReceipt: inspected ? inspected.summary : null,
                classification,
                retain: classification !== 'unpublished-reclaimable',
                reasons,
            });
        }
        return inventory;
    }

    /** Read-only list of reader receipts (for live-consumer checks). */
    function listReaderReceipts() {
        return safeReaddir(paths.readerReceipts)
            .map((name) => {
                const parsed = readJson(path.join(paths.readerReceipts, name), fsApi);
                if (parsed.missing) return null; // An owner may release its receipt.
                if (!parsed.value || parsed.value.workspaceId !== workspaceId || !parsed.value.objectId) {
                    throw dependencyStoreError('PLOINKY_DEPS_RECEIPT_INVALID', `reader receipt ${name} is unreadable or belongs to another workspace`);
                }
                return parsed.value;
            })
            .filter(Boolean);
    }

    function safeReaddir(directory) {
        try { return fsApi.readdirSync(directory).filter((name) => !name.endsWith('.tmp') && !name.startsWith('.tombstone-')).sort(); }
        catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    }

    return Object.freeze({
        root,
        paths,
        workspaceId,
        ensureLayout,
        readIndex,
        validateObject,
        markUnusable,
        ensureGeneration,
        ensureAgentGeneration,
        acquireReaderReceipt,
        acquireAttachmentReceipt,
        readRebuildToken,
        readRebuildState,
        updateRebuildState,
        listRebuildStates,
        updateReaderReceipt,
        releaseReaderReceipt,
        removeStaleReceipt,
        readPins,
        updatePins,
        describeObjects,
        listReaderReceipts,
    });
}

export function generationIdFor(inputKey, resolutionHash, treeHash) {
    for (const [label, value] of [['inputKey', inputKey], ['resolutionHash', resolutionHash], ['treeHash', treeHash]]) {
        if (!FULL_SHA256_PATTERN.test(String(value || ''))) throw dependencyStoreError('PLOINKY_DEPS_KEY_INVALID', `${label} must be a full SHA-256`);
    }
    return sha256Hex(`${inputKey}\n${resolutionHash}\n${treeHash}`);
}

function approvedTargets(plan) {
    const agentLib = plan.providers?.agentLib;
    return [...new Set([agentLib?.linkTarget, agentLib?.installTarget].filter(Boolean))].sort();
}

/** npm must see the selected AgentLib (and in-Box SDK) before lifecycle scripts run. */
function runProviderInstall(payloadPath, plan, install) {
    const agentLib = plan.providers.agentLib;
    return installWithAgentLib(payloadPath, plan.installManifest,
        { sourceDir: agentLib.selection.sourceDir, installTarget: agentLib.installTarget },
        (directory, localPackage, agentLibOptions) => installWithBoxMcpSdk(directory, localPackage, plan.providers.sdkBundle,
            (installPath, sdkOptions = {}) => install(installPath, { ...agentLibOptions, ...sdkOptions })));
}

function finalizeProviders(payloadPath, plan) {
    finalizeBoxMcpSdkCache(payloadPath, plan.providers.sdkBundle);
    const target = plan.providers.agentLib.linkTarget;
    ensureAgentLibCacheLink(payloadPath, target);
    const problem = agentLibCacheLinkProblem(payloadPath, target);
    if (problem) throw dependencyStoreError('PLOINKY_DEPS_AGENTLIB_LINK_INVALID', problem);
}

/**
 * Copy (never hardlink) a validated seed tree, preserving symlink text exactly.
 * Inside a Box, GNU `cp -a` is used: fs.cpSync cannot create some directories
 * on macOS Podman Machine bind mounts.
 */
export function defaultCopySeed(source, destination, { fsApi = fs, insideBox = isInsideBox(), spawn = spawnSync } = {}) {
    fsApi.rmSync(destination, { recursive: true, force: true });
    if (insideBox) {
        const copied = spawn('cp', ['-a', source, destination], { stdio: 'ignore' });
        if (copied.error || copied.status !== 0) {
            throw dependencyStoreError('PLOINKY_DEPS_SEED_COPY_FAILED', `seed copy failed (${copied.status ?? copied.error?.code ?? 'unknown'})`);
        }
        return;
    }
    fsApi.cpSync(source, destination, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: false,
        dereference: false,
    });
}
