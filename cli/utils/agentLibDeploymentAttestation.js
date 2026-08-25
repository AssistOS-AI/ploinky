// One deployment-level AgentLib proof for Ploinky core and every admitted
// managed agent. This module is intentionally read-only: it never repairs a
// cache, starts a runtime, selects a source, or rewrites the registry.

import fs from 'node:fs';
import path from 'node:path';

import { AGENTLIB_ENV, AGENTLIB_ERROR_CODES, agentLibError } from '../../agentlib/contract.mjs';
import { hashFileBytes } from '../../agentlib/fingerprint.mjs';
import {
    agentLibEntrypointHashes,
    agentLibRoot,
    buildAgentLibAttestation,
    compareAgentLibAttestation,
} from '../../agentlib/runtime.mjs';
import { readAgentRegistrySnapshot } from './agentRegistrySnapshot.js';

function assertAttestation(attestation, expected, label) {
    const compared = compareAgentLibAttestation(attestation, expected);
    if (!compared.ok) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.attestationMismatch,
            `${label} achillesAgentLib attestation failed: ${compared.problems.join(' ')}`,
        );
    }
    return attestation;
}

function expectedHashes(root, fsApi) {
    return {
        packageJsonHash: hashFileBytes(path.join(root, 'package.json'), fsApi),
        entrypoints: agentLibEntrypointHashes(root, { fsApi }),
    };
}

/**
 * Build and validate the graph proof visible to this core process.
 *
 * Agent attestations are produced during exact runtime admission and stored in
 * the same atomic registry record as the runtime identity. Their grant must
 * still match this core's selection, and every hash is compared again here.
 */
export function attestAgentLibDeployment({
    env = process.env,
    fsApi = fs,
    workspaceRoot = env.PLOINKY_WORKSPACE_ROOT || process.cwd(),
    registry = null,
} = {}) {
    const root = agentLibRoot({ env, fsApi });
    const fingerprint = String(env[AGENTLIB_ENV.fingerprint] || '');
    const sourceIdHash = String(env[AGENTLIB_ENV.sourceId] || '');
    if (!/^[a-f0-9]{64}$/.test(fingerprint) || !/^[a-f0-9]{64}$/.test(sourceIdHash)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            'Deployment attestation requires the complete AgentLib fingerprint and physical source identity.',
        );
    }
    const hashes = expectedHashes(root, fsApi);
    const core = buildAgentLibAttestation({ env, fsApi, root });
    assertAttestation(core, {
        fingerprint,
        sourceIdHash,
        sourceRoot: root,
        ...hashes,
    }, 'Ploinky core');

    const snapshot = registry || readAgentRegistrySnapshot({ workspaceRoot, fsApi });
    const agents = [];
    for (const [runtimeName, record] of Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b))) {
        if (!record || record.type !== 'agent') continue;
        const grant = record.agentLib;
        if (!grant || String(grant.sourceDir || '') !== root
            || String(grant.fingerprint || '') !== fingerprint
            || String(grant.sourceIdHash || '') !== sourceIdHash
            || !String(grant.runtimePath || '').startsWith('/')) {
            throw agentLibError(
                AGENTLIB_ERROR_CODES.attestationMismatch,
                `Agent ${runtimeName} does not carry the core AgentLib source identity and fingerprint.`,
            );
        }
        const attestation = assertAttestation(record.agentLibAttestation, {
            fingerprint,
            sourceIdHash,
            sourceRoot: String(grant.runtimePath),
            ...hashes,
        }, `Agent ${runtimeName}`);
        agents.push(Object.freeze({
            runtimeName,
            runtime: String(record.runtime || 'container'),
            instanceId: String(record.instanceId || ''),
            enableGeneration: String(record.enableGeneration || ''),
            attestation: structuredClone(attestation),
        }));
    }
    return Object.freeze({
        schemaVersion: 1,
        deploymentFingerprint: fingerprint,
        sourceIdHash,
        sourceRootRealpath: root,
        core: structuredClone(core),
        agents: Object.freeze(agents),
    });
}
