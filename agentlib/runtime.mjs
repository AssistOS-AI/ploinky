// Runtime resolution of achillesAgentLib from the one selected source.
//
// ESM has no NODE_PATH, and a bare `import 'achillesAgentLib/...'` from
// framework code would reintroduce install-tree resolution. Every framework
// import therefore goes through this explicit, containment-checking resolver,
// which also records the real path and hash of each loaded entry point so
// readiness can prove which bytes were actually loaded.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    AGENTLIB_ATTESTATION_SCHEMA_VERSION,
    AGENTLIB_ATTESTED_ENTRYPOINTS,
    AGENTLIB_ENV,
    AGENTLIB_ERROR_CODES,
    AGENTLIB_PACKAGE_NAME,
    agentLibError,
    assertNoRemovedAgentLibSettings,
} from './contract.mjs';
import { hashFileBytes, sha256Hex } from './fingerprint.mjs';

/** Loaded-byte evidence, keyed by the subpath the caller requested. */
const loadedEntrypoints = new Map();

/**
 * The validated AgentLib root for this process.
 *
 * A missing `PLOINKY_AGENTLIB_DIR` is a contract error, never permission to
 * fall back to install-tree resolution.
 *
 * @param {object} [opts]
 * @returns {string} canonical absolute root
 */
export function agentLibRoot({ env = process.env, fsApi = fs } = {}) {
    assertNoRemovedAgentLibSettings(env);
    const raw = String(env?.[AGENTLIB_ENV.dir] || '').trim();
    if (!raw) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `${AGENTLIB_ENV.dir} is not set. Ploinky resolves achillesAgentLib only from the selected `
            + 'workspace source; start this process through `ploinky` or `ploinky-local`.',
        );
    }
    if (!path.isAbsolute(raw)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `${AGENTLIB_ENV.dir} must be an absolute path (got ${raw}).`,
        );
    }
    let root;
    try {
        root = fsApi.realpathSync(raw);
    } catch (error) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `${AGENTLIB_ENV.dir}=${raw} does not exist.`,
            { cause: error },
        );
    }
    return root;
}

function readPackageJson(root, fsApi) {
    try {
        return JSON.parse(fsApi.readFileSync(path.join(root, 'package.json'), 'utf8'));
    } catch (error) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `achillesAgentLib at ${root} has no readable package.json.`,
            { cause: error },
        );
    }
}

function exportsCandidate(pkg, subpath) {
    const map = pkg?.exports;
    if (!map || typeof map !== 'object') return null;
    const key = subpath === '' ? '.' : `./${subpath}`;
    const direct = map[key];
    if (typeof direct === 'string') return direct;
    // Wildcard patterns such as "./jwt/*": "./jwt/*".
    for (const [pattern, target] of Object.entries(map)) {
        if (typeof target !== 'string' || !pattern.includes('*')) continue;
        const [prefix, suffix = ''] = pattern.split('*');
        if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
        const middle = key.slice(prefix.length, key.length - (suffix.length || 0));
        return target.replace('*', middle);
    }
    return null;
}

/**
 * Resolve a subpath of achillesAgentLib to a real file beneath the selected root.
 *
 * Package-export entries are honored deterministically, and the result is always
 * containment-checked so `..` or a symlink cannot escape the selected source.
 *
 * @param {string} subpath - e.g. 'utils/LLMClient.mjs' or 'LLMAgents'
 * @param {object} [opts]
 * @returns {string} canonical absolute file path
 */
export function resolveAgentLibPath(subpath, { env = process.env, fsApi = fs, root = null } = {}) {
    const base = root || agentLibRoot({ env, fsApi });
    const requested = String(subpath || '').replace(/^\.\//, '').replace(/^\/+/, '');
    if (requested.split('/').includes('..')) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.pathEscape,
            `Refusing to resolve achillesAgentLib subpath '${subpath}': it escapes the selected source.`,
        );
    }
    const pkg = readPackageJson(base, fsApi);
    const mapped = exportsCandidate(pkg, requested);
    const candidates = [];
    if (mapped) candidates.push(mapped.replace(/^\.\//, ''));
    if (requested === '') {
        candidates.push(String(pkg?.main || 'index.mjs').replace(/^\.\//, ''));
    } else {
        candidates.push(requested, `${requested}/index.mjs`, `${requested}.mjs`);
    }
    for (const relative of candidates) {
        const absolute = path.join(base, relative);
        let real;
        try {
            if (!fsApi.statSync(absolute).isFile()) continue;
            real = fsApi.realpathSync(absolute);
        } catch (_) {
            continue;
        }
        if (real !== base && !real.startsWith(`${base}${path.sep}`)) {
            throw agentLibError(
                AGENTLIB_ERROR_CODES.pathEscape,
                `achillesAgentLib subpath '${subpath}' resolves outside the selected source (${real}).`,
            );
        }
        return real;
    }
    throw agentLibError(
        AGENTLIB_ERROR_CODES.contractMissing,
        `achillesAgentLib subpath '${subpath}' was not found under the selected source ${base}.`,
    );
}

/**
 * Import a subpath of achillesAgentLib through the selected source and record
 * the loaded bytes for attestation.
 *
 * @param {string} subpath
 * @returns {Promise<object>} the module namespace
 */
export async function importAgentLib(subpath, { env = process.env, fsApi = fs, root = null } = {}) {
    const resolved = resolveAgentLibPath(subpath, { env, fsApi, root });
    const namespace = await import(pathToFileURL(resolved).href);
    loadedEntrypoints.set(String(subpath || '.'), {
        realPath: resolved,
        sha256: hashFileBytes(resolved, fsApi),
    });
    return namespace;
}

/** Everything this process has loaded from the selected source so far. */
export function loadedAgentLibEntrypoints() {
    return Object.fromEntries(
        Array.from(loadedEntrypoints.entries()).map(([key, value]) => [key, { ...value }]),
    );
}

/**
 * Build one deployment attestation for the selected source as this process
 * actually resolved it.
 *
 * Hashing the declared entry points (rather than only reporting a descriptor)
 * is what makes this proof rather than a claim.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.entrypoints]
 * @returns {object} attestation
 */
export function buildAgentLibAttestation({
    env = process.env,
    fsApi = fs,
    root = null,
    entrypoints = AGENTLIB_ATTESTED_ENTRYPOINTS,
} = {}) {
    const base = root || agentLibRoot({ env, fsApi });
    const pkg = readPackageJson(base, fsApi);
    if (pkg?.name !== AGENTLIB_PACKAGE_NAME) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.attestationMismatch,
            `achillesAgentLib at ${base} declares package name '${String(pkg?.name)}'.`,
        );
    }
    const attested = {};
    for (const entry of entrypoints) {
        attested[entry] = hashFileBytes(resolveAgentLibPath(entry, { env, fsApi, root: base }), fsApi);
    }
    return {
        schemaVersion: AGENTLIB_ATTESTATION_SCHEMA_VERSION,
        deploymentFingerprint: String(env?.[AGENTLIB_ENV.fingerprint] || ''),
        mode: String(env?.[AGENTLIB_ENV.mode] || ''),
        commit: String(env?.[AGENTLIB_ENV.commit] || ''),
        sourceIdHash: String(env?.[AGENTLIB_ENV.sourceId] || ''),
        sourceRootRealpath: base,
        packageJsonHash: hashFileBytes(path.join(base, 'package.json'), fsApi),
        entrypoints: attested,
        loaded: loadedAgentLibEntrypoints(),
    };
}

/**
 * Compare an attestation against the desired selection.
 *
 * Any missing, divergent, or unconfined path is a readiness failure — a label
 * or descriptor match alone is never accepted as proof.
 *
 * @param {object} attestation
 * @param {object} expected - { fingerprint, sourceRoot, entrypoints }
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function compareAgentLibAttestation(attestation, expected) {
    const problems = [];
    if (!attestation || typeof attestation !== 'object') {
        return { ok: false, problems: ['AgentLib attestation is missing.'] };
    }
    if (attestation.schemaVersion !== AGENTLIB_ATTESTATION_SCHEMA_VERSION) {
        problems.push(`Unexpected attestation schemaVersion ${String(attestation.schemaVersion)}.`);
    }
    if (expected?.fingerprint && attestation.deploymentFingerprint !== expected.fingerprint) {
        problems.push(
            `AgentLib fingerprint mismatch: expected ${expected.fingerprint}, attested ${String(attestation.deploymentFingerprint)}.`,
        );
    }
    if (expected?.sourceIdHash && attestation.sourceIdHash !== expected.sourceIdHash) {
        problems.push(
            `AgentLib source identity mismatch: expected ${expected.sourceIdHash}, attested ${String(attestation.sourceIdHash)}.`,
        );
    }
    if (expected?.sourceRoot && attestation.sourceRootRealpath !== expected.sourceRoot) {
        problems.push(
            `AgentLib source root mismatch: expected ${expected.sourceRoot}, attested ${String(attestation.sourceRootRealpath)}.`,
        );
    }
    if (expected?.packageJsonHash && attestation.packageJsonHash !== expected.packageJsonHash) {
        problems.push('AgentLib package.json hash mismatch.');
    }
    for (const [entry, hash] of Object.entries(expected?.entrypoints || {})) {
        const actual = attestation.entrypoints?.[entry];
        if (!actual) problems.push(`AgentLib attestation is missing entry point ${entry}.`);
        else if (actual !== hash) problems.push(`AgentLib entry point ${entry} hash mismatch.`);
    }
    for (const [entry, record] of Object.entries(attestation.loaded || {})) {
        const real = String(record?.realPath || '');
        const base = String(attestation.sourceRootRealpath || '');
        if (!base || (real !== base && !real.startsWith(`${base}${path.sep}`))) {
            problems.push(`AgentLib loaded '${entry}' from outside the selected source (${real}).`);
        }
    }
    return { ok: problems.length === 0, problems };
}

/** Selected entry-point hashes for a source directory, for desired-state comparison. */
export function agentLibEntrypointHashes(sourceDir, { fsApi = fs, entrypoints = AGENTLIB_ATTESTED_ENTRYPOINTS } = {}) {
    const hashes = {};
    for (const entry of entrypoints) {
        hashes[entry] = hashFileBytes(resolveAgentLibPath(entry, { fsApi, root: sourceDir }), fsApi);
    }
    return hashes;
}

export { sha256Hex };
