// The AgentLib package adapters inside a prepared dependency cache.
//
// Agent-owned code keeps writing bare `import 'achillesAgentLib/...'`. Instead
// of retaining a copy per cache, both package names and every nested npm copy
// link into the selected source, so all consumers resolve the core's bytes.
//
// This is deliberately not an install-tree fallback: the link is created after
// every npm operation (npm prunes entries it does not know about) and verified
// before the cache is stamped.

import fs from 'fs';
import path from 'path';

import {
    AGENTLIB_CACHE_LINK_NAME,
    AGENTLIB_PACKAGE_NAME,
    AGENTLIB_ENV,
    AGENTLIB_ERROR_CODES,
    AGENTLIB_STABLE_MOUNT_PATH,
    agentLibError,
    canonicalAgentLibRemote,
} from '../../../agentlib/contract.mjs';
import { parseRuntimeKey, SUPPORTED_FAMILIES } from './dependencyRuntimeKey.js';
import { AGENTLIB_ADAPTER_SCHEMA, agentLibPackagePaths } from './agentLibPackages.mjs';

/** Runtime families that get their own mount namespace. */
const MOUNT_NAMESPACE_FAMILIES = new Set(['container', 'bwrap']);
export const AGENTLIB_CACHE_LINK_NAMES = Object.freeze([AGENTLIB_CACHE_LINK_NAME, AGENTLIB_PACKAGE_NAME]);

/**
 * The AgentLib selection this process is running under.
 *
 * Read from the validated runtime contract the launcher bootstrap established,
 * never rediscovered from the ambient working directory: cache preparation must
 * not be able to pick a different source than the core loaded.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ sourceDir: string, mode: string, fingerprint: string, commit: string, sourceIdHash: string }}
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
        sourceIdHash: String(env[AGENTLIB_ENV.sourceId] || ''),
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

export function agentLibLinkPath(cachePath, name = AGENTLIB_CACHE_LINK_NAME) {
    return path.join(cachePath, 'node_modules', name);
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
    fsApi.mkdirSync(path.join(cachePath, 'node_modules'), { recursive: true });
    const aliases = agentLibPackagePaths(cachePath, target, { fsApi });
    let created = false;
    for (const linkPath of aliases) {
        created = ensureCacheLink(linkPath, target, fsApi) || created;
    }
    return { created, target };
}

function ensureCacheLink(linkPath, target, fsApi) {
    fsApi.mkdirSync(path.dirname(linkPath), { recursive: true });
    let current = null;
    try {
        const stat = fsApi.lstatSync(linkPath);
        current = stat.isSymbolicLink() ? fsApi.readlinkSync(linkPath) : null;
        if (current === target) return false;
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
    return true;
}

/**
 * Why the cache link is unusable, or an empty string when it is correct.
 *
 * @returns {string}
 */
export function agentLibCacheLinkProblem(cachePath, target, { fsApi = fs } = {}) {
    let aliases;
    try { aliases = agentLibPackagePaths(cachePath, target, { fsApi }); }
    catch (error) { return `AgentLib package tree is unreadable at ${cachePath}: ${error.message}`; }
    for (const linkPath of aliases) {
        const problem = cacheLinkProblem(linkPath, target, fsApi);
        if (problem) return problem;
    }
    return '';
}

function cacheLinkProblem(linkPath, target, fsApi) {
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
 * Reject an agent that declares either AgentLib name or a competing alias.
 *
 * The framework source is not an agent-overridable dependency: an agent that
 * shadowed it would resolve different bytes than the core and the other agents.
 *
 * @param {object} pkg - an agent package.json
 * @param {string} source - path reported in the error
 */
export function assertNoReservedAgentLibDependency(pkg, source = 'agent package.json') {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [name, spec] of Object.entries(pkg?.[field] || {})) {
            if (!AGENTLIB_CACHE_LINK_NAMES.includes(name) && !isAgentLibReference(spec)) continue;
            throw agentLibError(
                AGENTLIB_ERROR_CODES.reservedDependency,
                `${source} declares '${name}' in ${field}. achillesAgentLib is `
                + 'provided by Ploinky from the one selected workspace source and cannot be overridden; '
                + 'remove the entry.',
            );
        }
    }
    assertNoAgentLibOverrides(pkg?.overrides, source);
    for (const field of ['bundledDependencies', 'bundleDependencies']) {
        if (pkg?.[field] === true || (Array.isArray(pkg?.[field])
            && pkg[field].some(name => AGENTLIB_CACHE_LINK_NAMES.includes(name)))) {
            throw agentLibError(AGENTLIB_ERROR_CODES.reservedDependency,
                `${source} must not bundle the Ploinky-provided AgentLib`);
        }
    }
    return pkg;
}

function githubRepository(spec) {
    let value = String(spec || '').replace(/^git\+/, '').replace(/^github:/, 'https://github.com/');
    value = value.replace(/^(?:ssh:\/\/git@github\.com\/|git@github\.com:)/, 'https://github.com/');
    if (/^[\w.-]+\/[\w.-]+(?:#|$)/.test(value)) value = `https://github.com/${value}`;
    try {
        const url = new URL(value);
        return url.hostname === 'github.com' ? url.pathname.replace(/\.git$/, '').toLowerCase() : null;
    } catch { return null; }
}

function isAgentLibReference(spec) {
    if (/^npm:(?:achillesAgentLib|ploinky-agent-lib)(?:@|$)/.test(String(spec))) return true;
    const repository = githubRepository(spec);
    return repository !== null && repository === githubRepository(canonicalAgentLibRemote().url);
}

function assertNoAgentLibOverrides(overrides, source) {
    if (!overrides || typeof overrides !== 'object') return;
    for (const [name, value] of Object.entries(overrides)) {
        if (AGENTLIB_CACHE_LINK_NAMES.some(alias => name === alias || name.startsWith(`${alias}@`) || value === `$${alias}`)
            || isAgentLibReference(value)) {
            throw agentLibError(AGENTLIB_ERROR_CODES.reservedDependency,
                `${source} overrides the Ploinky-provided AgentLib; remove the override`);
        }
        assertNoAgentLibOverrides(value, source);
    }
}

/** npm must resolve the selected source before any dependency lifecycle runs. */
export function installWithAgentLib(cachePath, pkg, { sourceDir, installTarget }, install) {
    assertNoReservedAgentLibDependency(pkg);
    const packagePath = path.join(cachePath, 'package.json');
    const localPackage = {
        ...pkg,
        dependencies: { ...pkg.dependencies },
        overrides: { ...pkg.overrides },
    };
    for (const name of AGENTLIB_CACHE_LINK_NAMES) {
        localPackage.dependencies[name] = `file:${installTarget}`;
        localPackage.overrides[name] = `$${name}`;
    }
    try {
        fs.writeFileSync(packagePath, JSON.stringify(localPackage, null, 2));
        return install(cachePath, localPackage, { linkAgentLib: true, agentLibSourceDir: sourceDir });
    } finally {
        fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
    }
}

/** The AgentLib section recorded in a cache stamp. */
export function agentLibStampSection(runtimeKey, selection) {
    return {
        adapterSchema: AGENTLIB_ADAPTER_SCHEMA,
        mode: selection.mode,
        fingerprint: selection.fingerprint,
        commit: selection.commit || '',
        sourceIdHash: selection.sourceIdHash,
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
    if (actual.adapterSchema !== expected.adapterSchema) {
        return `agentLib adapterSchema changed (${actual.adapterSchema ?? 'null'} != ${expected.adapterSchema})`;
    }
    for (const key of ['mode', 'fingerprint', 'sourceIdHash', 'linkTarget']) {
        if (String(actual[key] ?? '') !== String(expected[key] ?? '')) {
            return `agentLib ${key} changed (${actual[key] ?? 'null'} != ${expected[key] ?? 'null'})`;
        }
    }
    return '';
}

export { AGENTLIB_CACHE_LINK_NAME, AGENTLIB_STABLE_MOUNT_PATH };
