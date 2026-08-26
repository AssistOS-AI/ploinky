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
import { AGENTLIB_ENV } from '../../agentlib/contract.mjs';
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

function successfulCommand(result, label) {
    if (result?.error) {
        throw attestationError(`${label} could not start: ${result.error.message}`, result.error);
    }
    if (result?.status !== 0) {
        const detail = resultText(result?.stderr).trim().split('\n').slice(-1)[0]
            || `status ${String(result?.status)}`;
        throw attestationError(`${label} failed: ${detail}`);
    }
    return resultText(result?.stdout).trim();
}

function grantEnvironment(grant) {
    return Object.freeze({
        [AGENTLIB_ENV.dir]: String(grant.runtimePath || ''),
        [AGENTLIB_ENV.mode]: String(grant.mode || ''),
        [AGENTLIB_ENV.fingerprint]: String(grant.fingerprint || ''),
        [AGENTLIB_ENV.commit]: String(grant.commit || ''),
        [AGENTLIB_ENV.sourceId]: String(grant.sourceIdHash || ''),
    });
}

function inspectContainerAgentLibEnvironment({ runtime, containerId, grant, spawn }) {
    const result = spawn(runtime, [
        'container', 'inspect', '--format', '{{json .Config.Env}}', containerId,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const raw = successfulCommand(result, `container ${containerId} environment inspection`);
    let entries;
    try {
        entries = JSON.parse(raw);
    } catch (error) {
        throw attestationError(`container ${containerId} environment inspection returned invalid JSON`, error);
    }
    if (!Array.isArray(entries)) {
        throw attestationError(`container ${containerId} environment inspection did not return an environment list`);
    }
    const expected = grantEnvironment(grant);
    for (const [name, value] of Object.entries(expected)) {
        const matches = entries.filter((entry) => String(entry).startsWith(`${name}=`));
        if (matches.length !== 1 || matches[0] !== `${name}=${value}`) {
            throw attestationError(
                `container ${containerId} does not carry the exact ${name} AgentLib contract`,
            );
        }
    }
    return expected;
}

function inspectHelperImageId({ runtime, helperImage, spawn }) {
    const result = spawn(runtime, [
        'image', 'inspect', '--format', '{{.Id}}', helperImage,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const imageId = successfulCommand(result, 'AgentLib attestation helper image inspection');
    if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(imageId)) {
        throw attestationError('AgentLib attestation helper image did not resolve to an immutable image ID');
    }
    return imageId;
}

function runContainerVolumeProbe({ runtime, containerId, grant, helperImage, spawn }) {
    if (!helperImage) {
        throw attestationError(
            `container ${containerId} has no fixed immutable AgentLib attestation helper image`,
        );
    }
    const environment = inspectContainerAgentLibEnvironment({ runtime, containerId, grant, spawn });
    const helperImageId = inspectHelperImageId({ runtime, helperImage, spawn });
    const envArgs = Object.entries(environment).flatMap(([name, value]) => [
        '--env', `${name}=${value}`,
    ]);
    return spawn(runtime, [
        'run', '--rm', '--pull=never',
        '--network', 'none',
        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--pids-limit', '32', '--memory', '128m', '--cpus', '0.25',
        '--volumes-from', `${containerId}:ro`,
        '--workdir', '/code',
        ...envArgs,
        '--entrypoint', 'node',
        helperImageId,
        AGENTLIB_AGENT_ATTEST_SCRIPT,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

/**
 * Probe a running OCI container without creating an exec session in it.
 *
 * Nested rootless Podman cannot reliably retire target containers that have
 * completed OCI exec sessions: its cleanup path requires open_by_handle_at,
 * which is deliberately unavailable inside Ploinky Box. The fixed helper
 * therefore resolves through the target's exact read-only volume topology for
 * every image, including images that happen to contain Node.js.
 */
export function attestContainerAgentLib({
    runtime,
    containerId,
    grant,
    helperImage = '',
    spawn,
}) {
    const result = runContainerVolumeProbe({
        runtime,
        containerId,
        grant,
        helperImage,
        spawn,
    });
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
