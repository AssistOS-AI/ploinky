// Shared achillesAgentLib source contract.
//
// This module is deliberately dependency-free: it is imported by the outer
// `ploinky-box` supervisor, by core CLI code, and by the confined `Agent/`
// runtime tree. It must never pull in a lifecycle module, and importing it must
// never touch the network or mutate workspace state.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENTLIB_SELECTION_SCHEMA_VERSION = 1;

/** npm package name that a valid achillesAgentLib checkout must declare. */
export const AGENTLIB_PACKAGE_NAME = 'ploinky-agent-lib';

/** The one implicit local candidate directory name inside a workspace root. */
export const AGENTLIB_LOCAL_DIR_NAME = 'achillesAgentLib';

/** Managed-source state root, relative to the workspace root. */
export const AGENTLIB_MANAGED_RELATIVE_DIR = path.join('.ploinky', 'agentlib');

/** Stable path the selected source is bind-mounted at in every mount namespace. */
export const AGENTLIB_STABLE_MOUNT_PATH = '/opt/ploinky-agentlib';

/**
 * The package-resolution adapter inside a prepared dependency cache. This is a
 * deliberate symlink into the selected source, not a legacy install fallback.
 */
export const AGENTLIB_CACHE_LINK_NAME = 'achillesAgentLib';

/** The Box package path that must NOT exist any more. */
export const FORBIDDEN_BOX_AGENTLIB_PATH = '/opt/ploinky/node_modules/achillesAgentLib';

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
 * Entry points Ploinky actually loads. They are validated at selection time.
 */
export const AGENTLIB_REQUIRED_ENTRYPOINTS = Object.freeze([
    'package.json',
    'LLMAgents/index.mjs',
    'utils/LLMClient.mjs',
    'jwt/jwtSign.mjs',
    'jwt/jwtVerify.mjs',
]);

/** Directory names excluded from the deterministic content fingerprint. */
export const AGENTLIB_FINGERPRINT_EXCLUDED_DIRS = Object.freeze(['.git']);

export const AGENTLIB_MODES = Object.freeze(['local', 'managed']);

export const AGENTLIB_ERROR_CODES = Object.freeze({
    sourceInvalid: 'PLOINKY_AGENTLIB_SOURCE_INVALID',
    sourceMissing: 'PLOINKY_AGENTLIB_SOURCE_MISSING',
    sourceChanged: 'PLOINKY_AGENTLIB_SOURCE_CHANGED',
    descriptorInvalid: 'PLOINKY_AGENTLIB_DESCRIPTOR_INVALID',
    contractMissing: 'PLOINKY_AGENTLIB_CONTRACT_MISSING',
    pathEscape: 'PLOINKY_AGENTLIB_PATH_ESCAPE',
    materializeFailed: 'PLOINKY_AGENTLIB_MATERIALIZE_FAILED',
    branchMissing: 'PLOINKY_AGENTLIB_BRANCH_MISSING',
    lockFailed: 'PLOINKY_AGENTLIB_LOCK_FAILED',
    unsupportedSetting: 'PLOINKY_AGENTLIB_UNSUPPORTED_SETTING',
    reservedDependency: 'PLOINKY_AGENTLIB_RESERVED_DEPENDENCY',
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

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root that owns this module group. */
export const PLOINKY_INSTALL_ROOT = path.resolve(HERE, '..');

export const DEPENDENCIES_LOCK_PATH = path.join(PLOINKY_INSTALL_ROOT, 'ploinky-box', 'dependencies.lock.json');

/**
 * The one canonical achillesAgentLib remote and default immutable commit.
 *
 * `ploinky-box/dependencies.lock.json` is the single source of this policy.
 * `globalDeps/package.json` and the update service must not define a competing
 * URL any more.
 *
 * @param {object} [opts]
 * @param {string} [opts.lockPath]
 * @param {typeof fs} [opts.fsApi]
 * @returns {{ url: string, commit: string }}
 */
export function canonicalAgentLibRemote({ lockPath = DEPENDENCIES_LOCK_PATH, fsApi = fs } = {}) {
    let parsed;
    try {
        parsed = JSON.parse(fsApi.readFileSync(lockPath, 'utf8'));
    } catch (error) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `Unable to read the achillesAgentLib source policy from ${lockPath}: ${error.message}`,
            { cause: error },
        );
    }
    const entry = parsed?.repositories?.achillesAgentLib;
    const url = String(entry?.url || '').trim();
    const commit = String(entry?.commit || '').trim();
    if (!url || !/^[0-9a-f]{40}$/.test(commit)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `${lockPath} must define repositories.achillesAgentLib with a url and a 40-hex commit.`,
        );
    }
    return { url, commit };
}

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
 * Validate an `AgentLibSelection` / persisted `active.json` shape.
 *
 * The descriptor is state, never authorization: callers must still canonicalize
 * and revalidate the real source directory before using it for a mount.
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
    if (resolvedCommit !== null && resolvedCommit !== '' && !/^[0-9a-f]{40}$/.test(resolvedCommit)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.descriptorInvalid,
            'AgentLib resolvedCommit must be a 40-hex sha or null.',
        );
    }
    if (value.mode === 'managed' && !assertOptionalString(value.remoteUrl, 'remoteUrl')) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.descriptorInvalid,
            'A managed AgentLib selection requires remoteUrl.',
        );
    }
    return {
        schemaVersion: AGENTLIB_SELECTION_SCHEMA_VERSION,
        workspacePathHash: assertString(value.workspacePathHash, 'workspacePathHash'),
        mode: value.mode,
        sourceRelativePath,
        sourceId: { device: String(sourceId.device), inode: String(sourceId.inode) },
        remoteUrl: assertOptionalString(value.remoteUrl, 'remoteUrl'),
        requestedRef: assertOptionalString(value.requestedRef, 'requestedRef'),
        resolvedCommit: resolvedCommit || null,
        dirty: value.dirty === true,
        contentFingerprint: fingerprint,
        selectedAt: assertString(value.selectedAt, 'selectedAt'),
    };
}

/**
 * The reserved runtime environment for one selection.
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
        sourceId?.device !== undefined && sourceId?.inode !== undefined
            ? crypto.createHash('sha256')
                .update(`${String(sourceId.device)}:${String(sourceId.inode)}`)
                .digest('hex')
            : ''
    ));
    if (!/^[a-f0-9]{64}$/.test(sourceIdValue)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            'AgentLib runtime contract requires the selected physical source identity.',
        );
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
                + `<workspace>/${AGENTLIB_LOCAL_DIR_NAME} or a managed workspace generation; `
                + `unset ${name} and use --branch to select a managed branch.`,
            );
        }
    }
}
