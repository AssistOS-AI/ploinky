// The achillesAgentLib adapter inside a prepared dependency cache.
//
// Agent-owned code keeps writing bare `import 'achillesAgentLib/...'`. Instead
// of installing a copy per cache, each cache carries one symlink into the
// selected source, so every agent resolves the same bytes the core does.
//
// This is deliberately not an install-tree fallback: the link is created after
// every npm operation (npm prunes entries it does not know about) and verified
// before the cache is stamped.

import fs from 'fs';
import path from 'path';

import {
    AGENTLIB_CACHE_LINK_NAME,
    AGENTLIB_ENV,
    AGENTLIB_ERROR_CODES,
    AGENTLIB_STABLE_MOUNT_PATH,
    agentLibError,
} from '../../../agentlib/contract.mjs';
import { sha256Hex } from '../../../agentlib/fingerprint.mjs';
import { parseRuntimeKey, SUPPORTED_FAMILIES } from './dependencyRuntimeKey.js';

/** Runtime families that get their own mount namespace. */
const MOUNT_NAMESPACE_FAMILIES = new Set(['container', 'bwrap']);

/**
 * The AgentLib selection this process is running under.
 *
 * Read from the validated runtime contract the launcher bootstrap established,
 * never rediscovered from the ambient working directory: cache preparation must
 * not be able to pick a different source than the core loaded.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ sourceDir: string, mode: string, fingerprint: string, commit: string }}
 */
export function activeAgentLibSelection(env = process.env) {
    const sourceDir = String(env?.[AGENTLIB_ENV.dir] || '').trim();
    if (!sourceDir) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `${AGENTLIB_ENV.dir} is not set, so dependency preparation cannot know which `
            + 'achillesAgentLib source to link. Start this workspace through `ploinky` or `ploinky-local`.',
        );
    }
    return {
        sourceDir,
        mode: String(env[AGENTLIB_ENV.mode] || ''),
        fingerprint: String(env[AGENTLIB_ENV.fingerprint] || ''),
        commit: String(env[AGENTLIB_ENV.commit] || ''),
    };
}

/**
 * The runtime family a key or bare family name denotes.
 *
 * Callers that only need the link target should pass the family: deriving it
 * from a full runtime key would otherwise force a container probe on paths that
 * do not need one.
 */
export function agentLibRuntimeFamily(runtimeKeyOrFamily) {
    const value = String(runtimeKeyOrFamily || '');
    if (SUPPORTED_FAMILIES.has(value)) return value;
    const parsed = parseRuntimeKey(value);
    if (!parsed) throw new Error(`Invalid runtime key: ${runtimeKeyOrFamily}`);
    return parsed.family;
}

/**
 * Where the cache symlink must point for a runtime key or family.
 *
 * Container and bwrap runtimes see the source at the stable path inside their
 * mount namespace. Seatbelt creates no mount namespace, so its link targets the
 * canonical host path instead.
 *
 * @param {string} runtimeKeyOrFamily
 * @param {{sourceDir: string}} selection
 * @returns {string}
 */
export function agentLibLinkTarget(runtimeKeyOrFamily, selection) {
    return MOUNT_NAMESPACE_FAMILIES.has(agentLibRuntimeFamily(runtimeKeyOrFamily))
        ? AGENTLIB_STABLE_MOUNT_PATH
        : path.resolve(selection.sourceDir);
}

export function agentLibLinkPath(cachePath) {
    return path.join(cachePath, 'node_modules', AGENTLIB_CACHE_LINK_NAME);
}

/**
 * Create or repair the cache link atomically.
 *
 * Always call this as the last cache step after any npm operation: npm treats
 * an unlisted `node_modules` entry as extraneous and prunes it.
 *
 * @returns {{ created: boolean, target: string }}
 */
export function ensureAgentLibCacheLink(cachePath, target, { fsApi = fs } = {}) {
    const linkPath = agentLibLinkPath(cachePath);
    fsApi.mkdirSync(path.dirname(linkPath), { recursive: true });
    let current = null;
    try {
        const stat = fsApi.lstatSync(linkPath);
        current = stat.isSymbolicLink() ? fsApi.readlinkSync(linkPath) : null;
        if (current === target) return { created: false, target };
        fsApi.rmSync(linkPath, { recursive: true, force: true });
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    // Symlink into place through a private name so a concurrent reader never
    // observes a half-created entry.
    const staging = `${linkPath}.${process.pid}.tmp`;
    try { fsApi.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* nothing staged */ }
    fsApi.symlinkSync(target, staging);
    fsApi.renameSync(staging, linkPath);
    return { created: true, target };
}

/**
 * Why the cache link is unusable, or an empty string when it is correct.
 *
 * @returns {string}
 */
export function agentLibCacheLinkProblem(cachePath, target, { fsApi = fs } = {}) {
    const linkPath = agentLibLinkPath(cachePath);
    let stat;
    try {
        stat = fsApi.lstatSync(linkPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return `achillesAgentLib cache link missing at ${linkPath}`;
        return `achillesAgentLib cache link is unreadable at ${linkPath}: ${error.message}`;
    }
    if (!stat.isSymbolicLink()) {
        return `achillesAgentLib cache entry at ${linkPath} is not a symlink; a copied package is not accepted`;
    }
    const actual = fsApi.readlinkSync(linkPath);
    if (actual !== target) {
        return `achillesAgentLib cache link points at ${actual}, expected ${target}`;
    }
    return '';
}

/**
 * Reject an agent that declares achillesAgentLib itself.
 *
 * The framework source is not an agent-overridable dependency: an agent that
 * shadowed it would resolve different bytes than the core and the other agents.
 *
 * @param {object} pkg - an agent package.json
 * @param {string} source - path reported in the error
 */
export function assertNoReservedAgentLibDependency(pkg, source = 'agent package.json') {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        if (pkg?.[field] && Object.hasOwn(pkg[field], AGENTLIB_CACHE_LINK_NAME)) {
            throw agentLibError(
                AGENTLIB_ERROR_CODES.reservedDependency,
                `${source} declares '${AGENTLIB_CACHE_LINK_NAME}' in ${field}. achillesAgentLib is `
                + 'provided by Ploinky from the one selected workspace source and cannot be overridden; '
                + 'remove the entry.',
            );
        }
    }
    return pkg;
}

/** The AgentLib section recorded in a cache stamp. */
export function agentLibStampSection(runtimeKey, selection) {
    return {
        mode: selection.mode,
        fingerprint: selection.fingerprint,
        commit: selection.commit || '',
        sourceIdHash: sha256Hex(path.resolve(selection.sourceDir)),
        linkTarget: agentLibLinkTarget(runtimeKey, selection),
    };
}

/**
 * Why a stamped AgentLib section no longer matches, or an empty string.
 *
 * Reported separately from npm validity so a changed local fingerprint refreshes
 * the link and stamp without reinstalling unrelated npm packages.
 */
export function agentLibStampProblem(stamp, expected) {
    const actual = stamp?.agentLib;
    if (!actual) return 'agentLib stamp section missing';
    for (const key of ['mode', 'fingerprint', 'sourceIdHash', 'linkTarget']) {
        if (String(actual[key] ?? '') !== String(expected[key] ?? '')) {
            return `agentLib ${key} changed (${actual[key] ?? 'null'} != ${expected[key] ?? 'null'})`;
        }
    }
    return '';
}

export { AGENTLIB_CACHE_LINK_NAME, AGENTLIB_STABLE_MOUNT_PATH };
