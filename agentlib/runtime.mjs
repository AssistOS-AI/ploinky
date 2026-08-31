// Runtime resolution of achillesAgentLib from the one selected source.
//
// ESM has no NODE_PATH, and a bare `import 'achillesAgentLib/...'` from
// framework code would reintroduce install-tree resolution. Every framework
// import therefore goes through this explicit, containment-checking resolver.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    AGENTLIB_ENV,
    AGENTLIB_ERROR_CODES,
    agentLibError,
    assertNoRemovedAgentLibSettings,
} from './contract.mjs';

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
 * Import a subpath of achillesAgentLib through the selected source.
 *
 * @param {string} subpath
 * @returns {Promise<object>} the module namespace
 */
export async function importAgentLib(subpath, { env = process.env, fsApi = fs, root = null } = {}) {
    const resolved = resolveAgentLibPath(subpath, { env, fsApi, root });
    return import(pathToFileURL(resolved).href);
}
