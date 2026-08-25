// Establish the achillesAgentLib runtime contract for the test runner.
//
// The direct-mount design removes every install-tree fallback: framework code
// resolves achillesAgentLib only from `PLOINKY_AGENTLIB_DIR`. Tests therefore
// have to name a source explicitly, exactly like a real deployment does, rather
// than relying on whichever copy happened to be resolvable.
//
// Load it with `node --import ./tests/helpers/agentlibTestContract.mjs`, which
// the repository test runners do. Tests that need a *different* source build
// their own fixture and pass it explicitly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENTLIB_ENV, AGENTLIB_PACKAGE_NAME } from '../../agentlib/contract.mjs';
import { fingerprintSource, sourceIdHash } from '../../agentlib/fingerprint.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const TEST_AGENTLIB_ENV_OVERRIDE = 'PLOINKY_TEST_AGENTLIB_DIR';

function isAgentLibCheckout(candidate) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'));
        return pkg?.name === AGENTLIB_PACKAGE_NAME;
    } catch (_) {
        return false;
    }
}

/**
 * The achillesAgentLib source the test suite runs against.
 *
 * `PLOINKY_TEST_AGENTLIB_DIR` selects one explicitly; otherwise a checkout
 * beside the repository is used. There is deliberately no search: an
 * unresolvable source is an actionable error, not a silent different source.
 */
export function resolveTestAgentLibSource(env = process.env) {
    const explicit = String(env[TEST_AGENTLIB_ENV_OVERRIDE] || '').trim();
    const candidates = explicit
        ? [path.resolve(explicit)]
        : [
            path.join(repoRoot, 'achillesAgentLib'),
            path.join(repoRoot, 'node_modules', 'achillesAgentLib'),
        ];
    for (const candidate of candidates) {
        if (isAgentLibCheckout(candidate)) return fs.realpathSync(candidate);
    }
    throw new Error(
        'The test suite needs one achillesAgentLib source. Set '
        + `${TEST_AGENTLIB_ENV_OVERRIDE} to a checkout, or place one at `
        + `${path.join(repoRoot, 'achillesAgentLib')}. Checked: ${candidates.join(', ')}`,
    );
}

/** Export the reserved runtime environment for this process and its children. */
export function applyTestAgentLibContract(env = process.env) {
    const declared = String(env[AGENTLIB_ENV.dir] || '').trim();
    const sourceDir = declared ? fs.realpathSync(declared) : resolveTestAgentLibSource(env);
    const observed = fingerprintSource(sourceDir);
    env[AGENTLIB_ENV.dir] = sourceDir;
    env[AGENTLIB_ENV.mode] ||= 'local';
    env[AGENTLIB_ENV.fingerprint] = observed.fingerprint;
    env[AGENTLIB_ENV.commit] ||= '';
    env[AGENTLIB_ENV.sourceId] = sourceIdHash(observed.sourceId);
    return sourceDir;
}

applyTestAgentLibContract();
