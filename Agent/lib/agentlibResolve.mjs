// Self-contained achillesAgentLib resolution for the standalone `Agent/` tree.
//
// `Agent/` is mounted as its own runtime tree (at `/Agent` in containers), so
// it cannot reach the repository's shared `agentlib/` module group. This is a
// deliberate small duplicate of the containment rules rather than an import
// that would be missing at runtime.
//
// There is no install-tree fallback: a missing `PLOINKY_AGENTLIB_DIR` is a
// contract error. Agent-owned code keeps using bare `achillesAgentLib/...`
// imports, which resolve through the cache symlink into this same source.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const AGENTLIB_DIR_ENV = 'PLOINKY_AGENTLIB_DIR';
export const AGENTLIB_FINGERPRINT_ENV = 'PLOINKY_AGENTLIB_FINGERPRINT';
const AGENTLIB_PACKAGE_NAME = 'ploinky-agent-lib';

const loaded = new Map();

function contractError(message) {
    const error = new Error(message);
    error.code = 'PLOINKY_AGENTLIB_CONTRACT_MISSING';
    return error;
}

/** The validated achillesAgentLib root for this Agent process. */
export function agentLibRootFromEnv(env = process.env) {
    const raw = String(env?.[AGENTLIB_DIR_ENV] || '').trim();
    if (!raw) {
        throw contractError(
            `${AGENTLIB_DIR_ENV} is not set. Ploinky resolves achillesAgentLib only from the selected `
            + 'workspace source; this agent must be started by Ploinky.',
        );
    }
    if (!path.isAbsolute(raw)) {
        throw contractError(`${AGENTLIB_DIR_ENV} must be an absolute path (got ${raw}).`);
    }
    let root;
    try {
        root = fs.realpathSync(raw);
    } catch (error) {
        throw contractError(`${AGENTLIB_DIR_ENV}=${raw} does not exist.`);
    }
    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    } catch (error) {
        throw contractError(`achillesAgentLib at ${root} has no readable package.json.`);
    }
    if (pkg?.name !== AGENTLIB_PACKAGE_NAME) {
        throw contractError(`achillesAgentLib at ${root} declares package name '${String(pkg?.name)}'.`);
    }
    return root;
}

/**
 * Resolve a subpath to a real file beneath the selected source.
 *
 * @param {string} subpath - e.g. 'jwt/jwtSign.mjs'
 * @returns {string} canonical absolute file path
 */
export function resolveAgentLibFile(subpath, env = process.env) {
    const root = agentLibRootFromEnv(env);
    const requested = String(subpath || '').replace(/^\.\//, '').replace(/^\/+/, '');
    if (requested.split('/').includes('..')) {
        throw contractError(`Refusing to resolve achillesAgentLib subpath '${subpath}': it escapes the source.`);
    }
    for (const relative of [requested, `${requested}/index.mjs`, `${requested}.mjs`]) {
        const absolute = path.join(root, relative);
        let real;
        try {
            if (!fs.statSync(absolute).isFile()) continue;
            real = fs.realpathSync(absolute);
        } catch (_) {
            continue;
        }
        if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
            throw contractError(`achillesAgentLib subpath '${subpath}' resolves outside the selected source.`);
        }
        return real;
    }
    throw contractError(`achillesAgentLib subpath '${subpath}' was not found under ${root}.`);
}

/** Import a subpath through the selected source and record it for attestation. */
export async function importAgentLibFile(subpath, env = process.env) {
    const resolved = resolveAgentLibFile(subpath, env);
    const namespace = await import(pathToFileURL(resolved).href);
    loaded.set(String(subpath), resolved);
    return namespace;
}

/** Real paths this Agent process has loaded from the selected source. */
export function loadedAgentLibFiles() {
    return Object.fromEntries(loaded.entries());
}
