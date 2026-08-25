// Loaded-byte proof for one admitted agent runtime.
//
// The probe executes through the runtime boundary that will run the agent and
// resolves the bare achillesAgentLib package through that runtime's own
// node_modules chain. A mount record, environment value, or cache stamp alone
// is desired state; this document is the evidence that resolution reaches the
// selected direct source.

import fs from 'node:fs';
import path from 'node:path';

import {
    agentLibEntrypointHashes,
    compareAgentLibAttestation,
} from '../../agentlib/runtime.mjs';
import { hashFileBytes } from '../../agentlib/fingerprint.mjs';

export const AGENTLIB_AGENT_ATTEST_SCRIPT = '/Agent/lib/agentlibAttest.mjs';

function attestationError(message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = 'PLOINKY_AGENTLIB_ATTESTATION_MISMATCH';
    return error;
}

function resultText(value) {
    return Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
}

/** Parse the one JSON document emitted by the confined probe. */
export function parseAgentLibAttestationResult(result, label = 'agent runtime') {
    if (result?.error) {
        throw attestationError(`${label} AgentLib probe could not start: ${result.error.message}`, result.error);
    }
    if (result?.status !== 0) {
        const detail = resultText(result?.stderr).trim().split('\n').slice(-1)[0] || `status ${String(result?.status)}`;
        throw attestationError(`${label} AgentLib probe failed: ${detail}`);
    }
    const stdout = resultText(result?.stdout).trim();
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch (error) {
        throw attestationError(`${label} AgentLib probe did not return one JSON attestation.`, error);
    }
    return parsed;
}

/** Validate runtime evidence against the selected host source and runtime path. */
export function assertAgentLibRuntimeAttestation(attestation, grant, {
    fsApi = fs,
    label = 'agent runtime',
} = {}) {
    const expected = {
        fingerprint: grant.fingerprint,
        sourceIdHash: grant.sourceIdHash,
        sourceRoot: grant.runtimePath,
        packageJsonHash: hashFileBytes(path.join(grant.sourceDir, 'package.json'), fsApi),
        entrypoints: agentLibEntrypointHashes(grant.sourceDir, { fsApi }),
    };
    const compared = compareAgentLibAttestation(attestation, expected);
    if (!compared.ok) {
        throw attestationError(`${label} loaded the wrong achillesAgentLib: ${compared.problems.join(' ')}`);
    }
    return Object.freeze(structuredClone(attestation));
}

/** Probe a running OCI container through its immutable container ID. */
export function attestContainerAgentLib({
    runtime,
    containerId,
    grant,
    spawn,
}) {
    const result = spawn(runtime, [
        'exec',
        '--workdir', '/code',
        containerId,
        'node', AGENTLIB_AGENT_ATTEST_SCRIPT,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return assertAgentLibRuntimeAttestation(
        parseAgentLibAttestationResult(result, `container ${containerId}`),
        grant,
        { label: `container ${containerId}` },
    );
}

/** Probe a one-shot bwrap namespace built from the exact daemon arguments. */
export function attestBwrapAgentLib({ bwrapPath, baseArgs, grant, spawn }) {
    const result = spawn(bwrapPath, [
        ...baseArgs,
        '--', 'node', AGENTLIB_AGENT_ATTEST_SCRIPT,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return assertAgentLibRuntimeAttestation(
        parseAgentLibAttestationResult(result, 'bwrap runtime'),
        grant,
        { label: 'bwrap runtime' },
    );
}

/** Probe the exact seatbelt profile and environment used for the daemon. */
export function attestSeatbeltAgentLib({
    profilePath,
    agentRuntimePath,
    cwd,
    env,
    grant,
    spawn,
}) {
    const result = spawn('sandbox-exec', [
        '-f', profilePath,
        'node', path.join(agentRuntimePath, 'lib', 'agentlibAttest.mjs'),
    ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env,
    });
    return assertAgentLibRuntimeAttestation(
        parseAgentLibAttestationResult(result, 'seatbelt runtime'),
        grant,
        { label: 'seatbelt runtime' },
    );
}
