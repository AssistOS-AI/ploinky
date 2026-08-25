#!/usr/bin/env node
// Confined loaded-byte probe for one agent runtime.
//
// The point is to prove what the agent's *actual* module resolution reaches:
// it resolves `achillesAgentLib/package.json` through the runtime's own
// `node_modules` (the cache symlink), checks that the real path lies beneath
// the granted source, and hashes the entry points it finds there. A descriptor
// or container label is not evidence that these bytes were loaded.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { agentLibRootFromEnv, resolveAgentLibFile } from './agentlibResolve.mjs';

export const ATTESTATION_SCHEMA_VERSION = 1;
export const ATTESTED_ENTRYPOINTS = Object.freeze([
    'LLMAgents/index.mjs',
    'utils/LLMClient.mjs',
    'jwt/jwtSign.mjs',
    'jwt/jwtVerify.mjs',
]);

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * The package.json of achillesAgentLib as the agent's own resolution reaches it.
 *
 * A package need not export `./package.json`, so fall back to the resolved main
 * entry and walk up to its package root. Either way the path comes from the
 * runtime's real module resolution, not from a configured directory.
 */
function resolvePackageJsonThroughRuntime(require) {
    try {
        return fs.realpathSync(require.resolve('achillesAgentLib/package.json'));
    } catch (error) {
        if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    }
    let current = path.dirname(fs.realpathSync(require.resolve('achillesAgentLib')));
    while (true) {
        const candidate = path.join(current, 'package.json');
        if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error('achillesAgentLib resolved without a readable package.json');
        }
        current = parent;
    }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.resolveFrom] - a path whose node_modules chain is used
 * @returns {object} the attestation document
 */
export function buildAgentAttestation({ env = process.env, resolveFrom = process.cwd() } = {}) {
    const granted = agentLibRootFromEnv(env);
    // Resolve the way agent-owned code does: a bare specifier through the
    // runtime's own node_modules, which must traverse the cache symlink.
    const require = createRequire(path.join(path.resolve(resolveFrom), 'noop.mjs'));
    const packageJsonPath = resolvePackageJsonThroughRuntime(require);
    const resolvedRoot = path.dirname(packageJsonPath);
    const confined = resolvedRoot === granted || resolvedRoot.startsWith(`${granted}${path.sep}`);
    const entrypoints = {};
    for (const entry of ATTESTED_ENTRYPOINTS) {
        entrypoints[entry] = sha256File(resolveAgentLibFile(entry, env));
    }
    return {
        schemaVersion: ATTESTATION_SCHEMA_VERSION,
        deploymentFingerprint: String(env.PLOINKY_AGENTLIB_FINGERPRINT || ''),
        mode: String(env.PLOINKY_AGENTLIB_MODE || ''),
        commit: String(env.PLOINKY_AGENTLIB_COMMIT || ''),
        grantedRoot: granted,
        resolvedRoot,
        confined,
        packageJsonHash: sha256File(packageJsonPath),
        entrypoints,
    };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(new URL(import.meta.url).pathname)) {
    try {
        process.stdout.write(`${JSON.stringify(buildAgentAttestation())}\n`);
    } catch (error) {
        process.stderr.write(`agentlib attestation failed: ${error?.message || error}\n`);
        process.exitCode = 1;
    }
}
