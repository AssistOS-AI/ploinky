// Shared achillesAgentLib source contract.
//
// This module is deliberately dependency-free: it is imported by the outer
// `ploinky-box` supervisor, by core CLI code, and by the confined `Agent/`
// runtime tree. It must never pull in a lifecycle module, and importing it must
// never touch the network or mutate workspace state.

import crypto from 'node:crypto';
import path from 'node:path';

export const AGENTLIB_SELECTION_SCHEMA_VERSION = 1;

/** npm package name that a valid achillesAgentLib checkout must declare. */
export const AGENTLIB_PACKAGE_NAME = 'ploinky-agent-lib';

/** The library name that identifies the image-supplied Achilles source. */
export const AGENTLIB_LIBRARY_NAME = 'achillesAgentLib';

/** The one implicit local candidate directory name inside a workspace root. */
export const AGENTLIB_LOCAL_DIR_NAME = 'achillesAgentLib';

/**
 * Repository identity of the library. It recognizes a dependency that would
 * shadow the provided source; it never selects a commit.
 */
export const AGENTLIB_REPOSITORY_URL = 'https://github.com/AssistOS-AI/AchillesAgentLib.git';

/** Selection state root (`active.json`, `transaction.json`, source lock), relative to the workspace root. */
export const AGENTLIB_MANAGED_RELATIVE_DIR = path.join('.ploinky', 'agentlib');

/** Stable path for the selected local mount or image-bundled source. */
export const AGENTLIB_STABLE_MOUNT_PATH = '/opt/ploinky-agentlib';

/** Build-generated library provenance outside both the source tree and the Ploinky bind mount. */
export const AGENTLIB_IMAGE_METADATA_PATH = '/usr/local/share/ploinky/agentlib/runtime-contract.json';

/**
 * The package-resolution adapter inside a prepared dependency cache. This is a
 * deliberate symlink into the selected source, not a legacy install fallback.
 */
export const AGENTLIB_CACHE_LINK_NAME = 'achillesAgentLib';

/** The Box package path that must NOT exist any more. */
export const FORBIDDEN_BOX_AGENTLIB_PATH = '/opt/ploinky/node_modules/achillesAgentLib';

/**
 * The engine-observed immutable outer Box image ID. The host sets it once when
 * it creates the outer Box, and every process in the Box inherits it. It is the
 * identity of the image that supplies the libraries; it is never a mutable
 * image reference, a nested agent image ID or a container ID.
 */
export const BOX_IMAGE_ID_ENV = 'PLOINKY_BOX_IMAGE_ID';

export const AGENTLIB_ENV = Object.freeze({
    dir: 'PLOINKY_AGENTLIB_DIR',
    mode: 'PLOINKY_AGENTLIB_MODE',
    fingerprint: 'PLOINKY_AGENTLIB_FINGERPRINT',
    commit: 'PLOINKY_AGENTLIB_COMMIT',
    sourceId: 'PLOINKY_AGENTLIB_SOURCE_ID',
});

/** Reserved environment names an agent manifest or user env layer must not set. */
export const AGENTLIB_RESERVED_ENV_NAMES = Object.freeze(Object.values(AGENTLIB_ENV));

/** Removed setting. Presence is a hard error rather than a silent no-op. */
export const AGENTLIB_REMOVED_ENV_NAMES = Object.freeze(['PLOINKY_AGENTLIB_REF']);

/**
 * Entry points Ploinky actually loads. They are validated at selection time and
 * exercised by the image smoke; `tests/unit/agentlibConsumerSurface.test.mjs`
 * keeps this list in step with the call sites.
 */
export const AGENTLIB_REQUIRED_ENTRYPOINTS = Object.freeze([
    'package.json',
    'LLMAgents/index.mjs',
    'LLMAgents/openAiAgenticResponder.mjs',
    'utils/LLMClient.mjs',
    'jwt/jwtSign.mjs',
    'jwt/jwtVerify.mjs',
]);

/** Directory names excluded from the deterministic content fingerprint. */
export const AGENTLIB_FINGERPRINT_EXCLUDED_DIRS = Object.freeze(['.git']);

export const AGENTLIB_MODES = Object.freeze(['local', 'image']);

export const AGENTLIB_ERROR_CODES = Object.freeze({
    sourceInvalid: 'PLOINKY_AGENTLIB_SOURCE_INVALID',
    sourceMissing: 'PLOINKY_AGENTLIB_SOURCE_MISSING',
    sourceChanged: 'PLOINKY_AGENTLIB_SOURCE_CHANGED',
    descriptorInvalid: 'PLOINKY_AGENTLIB_DESCRIPTOR_INVALID',
    contractMissing: 'PLOINKY_AGENTLIB_CONTRACT_MISSING',
    pathEscape: 'PLOINKY_AGENTLIB_PATH_ESCAPE',
    branchMissing: 'PLOINKY_AGENTLIB_BRANCH_MISSING',
    lockFailed: 'PLOINKY_AGENTLIB_LOCK_FAILED',
    unsupportedSetting: 'PLOINKY_AGENTLIB_UNSUPPORTED_SETTING',
    reservedDependency: 'PLOINKY_AGENTLIB_RESERVED_DEPENDENCY',
    imageRequired: 'PLOINKY_AGENTLIB_IMAGE_REQUIRED',
    imageInvalid: 'PLOINKY_AGENTLIB_IMAGE_INVALID',
});

export class AgentLibError extends Error {
    constructor(message, { code = AGENTLIB_ERROR_CODES.sourceInvalid, cause, details } = {}) {
        super(message, { cause });
        this.name = 'AgentLibError';
        this.code = code;
        if (details) this.details = details;
    }
}

export function agentLibError(code, message, options = {}) {
    return new AgentLibError(message, { ...options, code });
}

const SUPPLYING_IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function assertString(value, field) {
    if (typeof value !== 'string' || value === '') {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.descriptorInvalid,
            `AgentLib selection field '${field}' must be a non-empty string.`,
        );
    }
    return value;
}

function assertOptionalString(value, field) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.descriptorInvalid,
            `AgentLib selection field '${field}' must be a string or null.`,
        );
    }
    return value;
}

/**
 * The immutable outer Box image ID that supplies the libraries.
 *
 * Only the canonical `sha256:<64 hex>` spelling is accepted: a mutable tag, a
 * bare hex string or a missing value is never a supplier identity.
 *
 * @param {unknown} value
 * @param {string} [source] - where the value came from, for the error message
 * @returns {string}
 */
export function assertSupplyingImageId(value, source = 'supplying image ID') {
    const imageId = String(value ?? '');
    if (!SUPPLYING_IMAGE_ID_PATTERN.test(imageId)) {
        throw agentLibError(AGENTLIB_ERROR_CODES.imageInvalid,
            `The ${source} must be an immutable sha256:<64 hex> image ID (got ${imageId ? `'${imageId.slice(0, 80)}'` : 'nothing'}).`);
    }
    return imageId;
}

/** The explicit source identity of image-supplied Achilles: library plus outer image ID. */
export function imageSourceIdentity(supplyingImageId) {
    return Object.freeze({
        library: AGENTLIB_LIBRARY_NAME,
        supplyingImageId: assertSupplyingImageId(supplyingImageId),
    });
}

/**
 * Compact identity value for labels and environment. It hashes the small,
 * mode-tagged identity record - never any library content - so image and local
 * identities cannot collide.
 */
export function imageSourceIdHash(sourceId) {
    const identity = imageSourceIdentity(sourceId?.supplyingImageId);
    if (sourceId?.library !== identity.library) {
        throw agentLibError(AGENTLIB_ERROR_CODES.imageInvalid,
            `An image AgentLib source identity must name the ${AGENTLIB_LIBRARY_NAME} library.`);
    }
    return crypto.createHash('sha256')
        .update(JSON.stringify({ kind: 'image', library: identity.library, supplyingImageId: identity.supplyingImageId }))
        .digest('hex');
}

/** Physical identity hash of a local source directory (`{device, inode}`). */
export function localSourceIdHash(sourceId) {
    return crypto.createHash('sha256')
        .update(`${String(sourceId?.device)}:${String(sourceId?.inode)}`)
        .digest('hex');
}

/** The compact source identity of a selection, whichever variant it is. */
export function agentLibSourceIdHash(selection) {
    if (selection?.mode === 'image') return imageSourceIdHash(selection.sourceId);
    return localSourceIdHash(selection?.sourceId);
}

/**
 * Normalize optional build provenance. It is informational: it never selects a
 * source, never becomes a revision requirement and never affects identity.
 * Anything malformed reads as unavailable.
 *
 * @param {unknown} value - `{repository, branch, commit, packageVersion}` in any subset
 * @returns {{repository: string|null, branch: string|null, commit: string|null, packageVersion: string|null}}
 */
export function normalizeLibraryProvenance(value) {
    const text = (candidate) => (typeof candidate === 'string' && candidate.trim() !== '' && candidate.length <= 512
        ? candidate.trim()
        : null);
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const commit = text(source.commit);
    return {
        repository: text(source.repository),
        branch: text(source.branch),
        commit: commit && COMMIT_PATTERN.test(commit) ? commit : null,
        packageVersion: text(source.packageVersion),
    };
}

function validateProvenanceField(value) {
    if (value === undefined || value === null) return normalizeLibraryProvenance(null);
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw agentLibError(AGENTLIB_ERROR_CODES.descriptorInvalid,
            'AgentLib selection field \'provenance\' must be an object or null.');
    }
    const commit = value.commit;
    if (commit !== undefined && commit !== null && !COMMIT_PATTERN.test(String(commit))) {
        throw agentLibError(AGENTLIB_ERROR_CODES.descriptorInvalid,
            'AgentLib provenance commit must be a 40-hex sha or null.');
    }
    for (const field of ['repository', 'branch', 'packageVersion']) {
        assertOptionalString(value[field], `provenance.${field}`);
    }
    return normalizeLibraryProvenance(value);
}

function validateImageDescriptor(value, common) {
    const sourceId = value.sourceId;
    const supplyingImageId = String(value.supplyingImageId ?? '');
    if (common.sourceRelativePath !== 'image'
        || !sourceId || typeof sourceId !== 'object' || Array.isArray(sourceId)
        || JSON.stringify(Object.keys(sourceId).sort()) !== JSON.stringify(['library', 'supplyingImageId'])
        || sourceId.library !== AGENTLIB_LIBRARY_NAME
        || !SUPPLYING_IMAGE_ID_PATTERN.test(supplyingImageId)
        || sourceId.supplyingImageId !== supplyingImageId) {
        throw agentLibError(AGENTLIB_ERROR_CODES.descriptorInvalid,
            'An image AgentLib selection must identify the library and one immutable supplying image ID '
            + '(sourceId {library, supplyingImageId} equal to supplyingImageId).');
    }
    for (const field of ['contentFingerprint', 'imageId', 'resolvedCommit', 'remoteUrl', 'requestedRef']) {
        if (value[field] !== undefined) {
            throw agentLibError(AGENTLIB_ERROR_CODES.descriptorInvalid,
                `An image AgentLib selection must not carry '${field}'.`);
        }
    }
    if (value.dirty === true) {
        throw agentLibError(AGENTLIB_ERROR_CODES.descriptorInvalid,
            'An image AgentLib selection cannot be dirty.');
    }
    return {
        schemaVersion: AGENTLIB_SELECTION_SCHEMA_VERSION,
        workspacePathHash: common.workspacePathHash,
        mode: 'image',
        sourceRelativePath: 'image',
        sourceId: { library: AGENTLIB_LIBRARY_NAME, supplyingImageId },
        supplyingImageId,
        provenance: validateProvenanceField(value.provenance),
        selectedAt: common.selectedAt,
    };
}

function validateLocalDescriptor(value, common) {
    const sourceId = value.sourceId;
    if (!sourceId || typeof sourceId !== 'object') {
        throw agentLibError(AGENTLIB_ERROR_CODES.descriptorInvalid, 'AgentLib selection requires a sourceId object.');
    }
    assertString(String(sourceId.device ?? ''), 'sourceId.device');
    assertString(String(sourceId.inode ?? ''), 'sourceId.inode');
    const fingerprint = assertString(value.contentFingerprint, 'contentFingerprint');
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.descriptorInvalid,
            'AgentLib contentFingerprint must be a 64-hex sha256 digest.',
        );
    }
    const resolvedCommit = assertOptionalString(value.resolvedCommit, 'resolvedCommit');
    if (resolvedCommit !== null && resolvedCommit !== '' && !COMMIT_PATTERN.test(resolvedCommit)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.descriptorInvalid,
            'AgentLib resolvedCommit must be a 40-hex sha or null.',
        );
    }
    return {
        schemaVersion: AGENTLIB_SELECTION_SCHEMA_VERSION,
        workspacePathHash: common.workspacePathHash,
        mode: 'local',
        sourceRelativePath: common.sourceRelativePath,
        sourceId: { device: String(sourceId.device), inode: String(sourceId.inode) },
        remoteUrl: assertOptionalString(value.remoteUrl, 'remoteUrl'),
        requestedRef: assertOptionalString(value.requestedRef, 'requestedRef'),
        resolvedCommit: resolvedCommit || null,
        dirty: value.dirty === true,
        contentFingerprint: fingerprint,
        selectedAt: common.selectedAt,
    };
}

/**
 * Validate an `AgentLibSelection` / persisted `active.json` shape.
 *
 * The descriptor is state, never authorization: callers must still canonicalize
 * and revalidate the real source directory before using it for a mount. The two
 * modes have distinct shapes: a local selection is identified by the physical
 * directory and its content fingerprint, an image selection by the outer Box
 * image that supplies it and never by content.
 *
 * @param {unknown} value
 * @returns {object} the normalized descriptor
 */
export function validateSelectionDescriptor(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw agentLibError(AGENTLIB_ERROR_CODES.descriptorInvalid, 'AgentLib selection must be an object.');
    }
    if (value.schemaVersion !== AGENTLIB_SELECTION_SCHEMA_VERSION) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.descriptorInvalid,
            `Unsupported AgentLib selection schemaVersion ${String(value.schemaVersion)}; expected ${AGENTLIB_SELECTION_SCHEMA_VERSION}.`,
        );
    }
    if (!AGENTLIB_MODES.includes(value.mode)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.descriptorInvalid,
            `AgentLib selection mode must be one of ${AGENTLIB_MODES.join('|')} (got ${String(value.mode)}).`,
        );
    }
    const sourceRelativePath = assertString(value.sourceRelativePath, 'sourceRelativePath');
    if (path.isAbsolute(sourceRelativePath) || sourceRelativePath.split(/[\\/]/).includes('..')) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.descriptorInvalid,
            `AgentLib sourceRelativePath must be a workspace-relative path without '..' (got ${sourceRelativePath}).`,
        );
    }
    const common = {
        sourceRelativePath,
        workspacePathHash: assertString(value.workspacePathHash, 'workspacePathHash'),
        selectedAt: assertString(value.selectedAt, 'selectedAt'),
    };
    return value.mode === 'image' ? validateImageDescriptor(value, common) : validateLocalDescriptor(value, common);
}

/**
 * The mode-aware identity of a selection, as shown in status output and the
 * public update result. A local selection reports its content fingerprint; an
 * image selection reports the outer image ID that supplies it plus optional,
 * informational provenance.
 *
 * @param {object|null} selection - a selection descriptor or a Box AgentLib contract
 * @param {{provenance?: boolean}} [options] - `provenance: false` leaves the informational fields out
 * @returns {object|null}
 */
export function agentLibIdentity(selection, { provenance = true } = {}) {
    if (!selection) return null;
    if (selection.mode === 'image') {
        return {
            mode: 'image',
            supplyingImageId: selection.supplyingImageId ?? selection.sourceId?.supplyingImageId ?? null,
            sourceIdHash: selection.sourceIdHash ?? agentLibSourceIdHash(selection),
            ...(provenance ? { provenance: normalizeLibraryProvenance(selection.provenance) } : {}),
        };
    }
    return {
        mode: selection.mode || null,
        fingerprint: selection.contentFingerprint ?? selection.fingerprint ?? null,
        sourceIdHash: selection.sourceIdHash ?? (selection.sourceId ? agentLibSourceIdHash(selection) : null),
    };
}

/** Whether two selections denote the same source: mode, source identity and (local) content. */
export function agentLibIdentityEquals(a, b) {
    if (!a || !b) return false;
    const left = agentLibIdentity(a);
    const right = agentLibIdentity(b);
    if (left.mode !== right.mode || left.sourceIdHash !== right.sourceIdHash) return false;
    return left.mode === 'image'
        ? left.supplyingImageId === right.supplyingImageId
        : left.fingerprint === right.fingerprint;
}

/**
 * The reserved runtime environment for one selection.
 *
 * A local selection carries its content fingerprint and Git commit. An image
 * selection carries neither: its identity is the source identity hash, and the
 * supplying image ID reaches Box processes separately through
 * `PLOINKY_BOX_IMAGE_ID`.
 *
 * @param {object} selection - validated selection descriptor
 * @param {string} runtimeDir - the AgentLib root as the consumer will see it
 * @returns {Record<string,string>}
 */
export function agentLibRuntimeEnv(selection, runtimeDir) {
    if (!runtimeDir || !path.isAbsolute(runtimeDir)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `AgentLib runtime directory must be an absolute path (got ${String(runtimeDir)}).`,
        );
    }
    const sourceId = selection?.sourceId;
    const sourceIdValue = String(selection?.sourceIdHash || (
        selection?.mode === 'image'
            ? (sourceId?.supplyingImageId ? imageSourceIdHash(sourceId) : '')
            : (sourceId?.device !== undefined && sourceId?.inode !== undefined ? localSourceIdHash(sourceId) : '')
    ));
    if (!/^[a-f0-9]{64}$/.test(sourceIdValue)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            'AgentLib runtime contract requires the selected source identity.',
        );
    }
    if (selection.mode === 'image') {
        return {
            [AGENTLIB_ENV.dir]: runtimeDir,
            [AGENTLIB_ENV.mode]: 'image',
            [AGENTLIB_ENV.sourceId]: sourceIdValue,
        };
    }
    return {
        [AGENTLIB_ENV.dir]: runtimeDir,
        [AGENTLIB_ENV.mode]: selection.mode,
        [AGENTLIB_ENV.fingerprint]: selection.contentFingerprint,
        [AGENTLIB_ENV.commit]: selection.resolvedCommit || '',
        [AGENTLIB_ENV.sourceId]: sourceIdValue,
    };
}

/**
 * Fail closed on the removed `PLOINKY_AGENTLIB_REF` setting instead of ignoring
 * it. There is deliberately no alias or deprecation window.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function assertNoRemovedAgentLibSettings(env = process.env) {
    for (const name of AGENTLIB_REMOVED_ENV_NAMES) {
        if (String(env?.[name] || '').trim() !== '') {
            throw agentLibError(
                AGENTLIB_ERROR_CODES.unsupportedSetting,
                `${name} is no longer supported. achillesAgentLib is selected from `
                + `<workspace>/${AGENTLIB_LOCAL_DIR_NAME} or the Box image; `
                + `unset ${name} and use a local checkout for a different AgentLib revision.`,
            );
        }
    }
}
