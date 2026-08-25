// Shared achillesAgentLib fixtures for Box unit tests.
//
// The direct-mount contract makes the selected source part of the Box's
// immutable identity, so every Box fixture now needs a selection, its two exact
// read-only binds, its labels, and its reserved environment. Building them in
// one place keeps the fixtures honest: a test that forgets a bind fails for the
// real reason instead of drifting into a private copy of the contract.

import fs from 'node:fs';
import path from 'node:path';

import { AGENTLIB_LOCAL_DIR_NAME, AGENTLIB_PACKAGE_NAME } from '../../agentlib/contract.mjs';
import { sourceIdHash } from '../../agentlib/fingerprint.mjs';
import { BOX_AGENTLIB_LABELS } from '../../ploinky-box/constants.mjs';
import {
    agentLibBoxEnv,
    agentLibLabels,
    expectedAgentLibMounts,
    normalizeBoxAgentLib,
} from '../../ploinky-box/contract/agentlib.mjs';

export const AGENTLIB_FIXTURE_FINGERPRINT = 'a1'.repeat(32);

/** Write a minimal but structurally valid achillesAgentLib checkout. */
export function writeAgentLibCheckout(dir) {
    fs.mkdirSync(path.join(dir, 'LLMAgents'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'utils'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'jwt'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: AGENTLIB_PACKAGE_NAME,
        version: '0.0.0',
        type: 'module',
        exports: { '.': './index.mjs', './LLMAgents': './LLMAgents/index.mjs' },
    }));
    fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const marker = "fixture";\n');
    fs.writeFileSync(path.join(dir, 'LLMAgents/index.mjs'), 'export const marker = "fixture";\n');
    fs.writeFileSync(path.join(dir, 'utils/LLMClient.mjs'), 'export function getPrioritizedModels() { return []; }\n');
    fs.writeFileSync(path.join(dir, 'jwt/jwtSign.mjs'), 'export function signHmacJwt() { return ""; }\n');
    fs.writeFileSync(path.join(dir, 'jwt/jwtVerify.mjs'), 'export function verifyJws() { return null; }\n');
    return dir;
}

/**
 * A selection for a local checkout inside `workspaceRoot`, materialized on disk
 * so the source directory a bind would name really exists.
 *
 * @param {string} workspaceRoot
 * @param {object} [opts]
 * @returns {Readonly<object>} the normalized Box AgentLib contract
 */
export function agentLibFixture(workspaceRoot, {
    fingerprint = AGENTLIB_FIXTURE_FINGERPRINT,
    mode = 'local',
    sourceRelativePath = AGENTLIB_LOCAL_DIR_NAME,
    commit = '',
    create = true,
} = {}) {
    const sourceDir = path.join(workspaceRoot, ...sourceRelativePath.split('/'));
    if (create) {
        fs.mkdirSync(sourceDir, { recursive: true });
        writeAgentLibCheckout(sourceDir);
    }
    return normalizeBoxAgentLib({
        sourceDir,
        sourceRelativePath,
        mode,
        contentFingerprint: fingerprint,
        resolvedCommit: commit,
        sourceId: { device: '1', inode: '2' },
    });
}

/** The labels an existing Box must carry for `contract`. */
export function agentLibFixtureLabels(contract) {
    return agentLibLabels(contract);
}

/** The environment an existing Box must expose for `contract`. */
export function agentLibFixtureEnv(contract) {
    return agentLibBoxEnv(contract);
}

/** The two observed bind mounts an existing Box must report for `contract`. */
export function agentLibFixtureMounts(contract) {
    return Object.entries(expectedAgentLibMounts(contract)).map(([destination, expected]) => ({
        type: 'bind',
        name: '',
        source: expected.source,
        destination,
        rw: expected.rw,
    }));
}

export { BOX_AGENTLIB_LABELS, sourceIdHash };
