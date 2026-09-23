import path from 'node:path';

import {
    PLOINKY_INSTALL_ROOT,
    canonicalAgentLibRemote,
    validateImageBundleMetadata,
} from '../agentlib/contract.mjs';
import { sanitizeAuthorityDiagnostic } from '../cli/sandbox/authorityCommandDiagnostics.mjs';
import {
    agentLibPinError,
    agentLibPinPolicy,
    assessAgentLibPin,
    formatAgentLibPinWarning,
    readCheckoutPinContext,
} from './agentlib-pin.mjs';
import { PloinkyBoxError } from './errors.mjs';
import { normalizeImageInspect, validateImageContract } from './contract/image.mjs';
import { normalizeImageId } from './contract/image-id.mjs';

export const IMAGE_AGENTLIB_PROBE_PATH = '/usr/local/share/ploinky/agentlib/image-bundle.mjs';
const RUNTIME_AGENTLIB_PROBE_PATH = '/opt/ploinky/agentlib/image-bundle.mjs';
const PROBE_TIMEOUT_MS = 60_000;
const PROBE_REASON_LIMIT = 500;
// The verifier prints `CODE: message`; Node and Podman print `Error: ...`.
const PROBE_REASON_LINE = /^(?:PLOINKY_[A-Z0-9_]+|[A-Za-z]*Error(?: \[[A-Z0-9_]+\])?):/;

function bundleError(message, cause, reason = '') {
    return new PloinkyBoxError(
        `${message}. Build or pull a compatible Ploinky Box image containing the pinned AchillesAgentLib copy`
        + (reason ? `. ${reason}` : ''),
        { code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE', cause },
    );
}

// The CLI prints only the message, so a failed verification must carry its own
// cause: a timeout, a process failure, or the stderr line that explains the exit.
function probeFailureReason(result) {
    const errorCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(String(result?.error?.code ?? '')) ? result.error.code : null;
    if (errorCode === 'ETIMEDOUT') return `The verification command timed out after ${PROBE_TIMEOUT_MS / 1000} s.`;
    if (errorCode) return `The verification command failed with ${errorCode}.`;
    const signal = /^SIG[A-Z0-9]{1,16}$/.test(String(result?.signal ?? '')) ? result.signal : null;
    const outcome = signal
        ? `The verification command was terminated by ${signal}`
        : `The verification command exited with status ${result?.status ?? 'unknown'}`;
    const lines = String(result?.stderr ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const line = lines.find((candidate) => PROBE_REASON_LINE.test(candidate)) ?? lines[0] ?? '';
    const reason = sanitizeAuthorityDiagnostic(line, { limit: PROBE_REASON_LIMIT });
    return reason ? `${outcome}: ${reason}` : `${outcome} without output.`;
}

function readProbe(result, expectedCommit) {
    if (!result?.ok) {
        throw bundleError('The Box AchillesAgentLib bundle is missing or failed verification',
            result?.error, probeFailureReason(result));
    }
    try {
        return validateImageBundleMetadata(JSON.parse(result.stdout), { expectedCommit });
    } catch (error) {
        throw bundleError('The Box AchillesAgentLib bundle does not match the required revision or fingerprint',
            error, sanitizeAuthorityDiagnostic(error, { limit: PROBE_REASON_LIMIT }));
    }
}

/**
 * Probe only an immutable image, offline and without workspace mounts. An
 * explicit `expectedCommit: null` verifies the bytes without a pin and returns
 * the image's own commit for the caller to compare.
 */
export function probeImageAgentLib(engine, imageId, runner, {
    expectedCommit = canonicalAgentLibRemote().commit,
} = {}) {
    const result = runner.query(engine, [
        'run', '--rm', '--network=none', '--pull=never',
        '--entrypoint=/usr/local/bin/node', imageId,
        IMAGE_AGENTLIB_PROBE_PATH, 'verify',
        ...(expectedCommit === null ? [] : ['--expected-commit', expectedCommit]),
    ], { timeoutMs: PROBE_TIMEOUT_MS });
    return Object.freeze({ ...readProbe(result, expectedCommit), imageId: normalizeImageId(imageId) });
}

/**
 * Called lazily, only when the workspace has no local library. `refresh` pulls
 * even when the reference exists locally: creating a missing Box pulls it
 * anyway, so the bundle must come from those bytes, not an older local tag.
 *
 * This is the one place where the bundled commit meets the lock of the
 * checkout at `repositoryRoot`. A difference is reported on stderr and the
 * image's own commit is selected, or it is fatal under the strict policy.
 */
export async function loadBoxAgentLibImage({
    engine, imageRef, runner, stdout, stderr, allowPull = true, refresh = false,
    pinPolicy, repositoryRoot = PLOINKY_INSTALL_ROOT, lockCommit, readPinContext = readCheckoutPinContext,
}) {
    if (refresh && !allowPull) {
        throw new PloinkyBoxError('A Box image refresh requires an operation that may pull images',
            { code: 'PLOINKY_BOX_AGENTLIB_REFRESH_INVALID' });
    }
    const policy = pinPolicy ?? agentLibPinPolicy();
    if (policy !== 'warn' && policy !== 'strict') {
        throw new PloinkyBoxError(
            `Unsupported AchillesAgentLib pin policy ${sanitizeAuthorityDiagnostic(JSON.stringify(String(policy)), { limit: 80 })}`,
            { code: 'PLOINKY_BOX_ARGUMENT_INVALID' },
        );
    }
    const pinned = lockCommit ?? canonicalAgentLibRemote({
        lockPath: path.join(repositoryRoot, 'ploinky-box', 'dependencies.lock.json'),
    }).commit;
    let refreshed = false;
    let inspection = refresh ? null : runner.query(engine.name, ['image', 'inspect', imageRef]);
    if (!inspection?.ok) {
        if (!allowPull) {
            throw bundleError('The Box image is not available locally and this operation cannot pull images', inspection?.error);
        }
        if (typeof runner.stream === 'function') {
            const pulled = await runner.stream(engine.name, ['pull', imageRef], {
                timeoutMs: 1_800_000, stdout, stderr,
            });
            if (!pulled.ok) throw bundleError('Unable to pull the Box image for AchillesAgentLib selection', pulled.error);
        } else {
            runner.run(engine.name, ['pull', imageRef]);
        }
        refreshed = true;
        inspection = runner.query(engine.name, ['image', 'inspect', imageRef]);
    }
    if (!inspection.ok) throw bundleError('Unable to inspect the Box image for AchillesAgentLib selection', inspection.error);
    const image = validateImageContract(normalizeImageInspect(inspection.stdout), imageRef);
    const bundle = probeImageAgentLib(engine.name, image.immutableId, runner, { expectedCommit: null });
    if (bundle.commit === pinned) return bundle;
    const assessment = assessAgentLibPin({
        lockCommit: pinned, bundle, imageRef, refreshed, engineName: engine.name,
        context: readPinContext(repositoryRoot, { imageCommit: bundle.commit }),
    });
    if (policy === 'strict') throw agentLibPinError(assessment);
    stderr?.write?.(formatAgentLibPinWarning(assessment));
    return bundle;
}

/** Check the actual running copy before admitting or restarting a graph. */
export function revalidateContainerAgentLib(selection, { engine, containerId, runner }) {
    const commit = selection.resolvedCommit ?? selection.commit;
    const fingerprint = selection.contentFingerprint ?? selection.fingerprint;
    const result = runner.query(engine.name, [
        'exec', containerId, '/usr/local/bin/node', RUNTIME_AGENTLIB_PROBE_PATH,
        'verify', '--expected-commit', commit,
    ], { timeoutMs: PROBE_TIMEOUT_MS });
    const bundle = readProbe(result, commit);
    if (bundle.fingerprint !== fingerprint) {
        throw bundleError('The running Box AchillesAgentLib fingerprint changed');
    }
    return selection;
}
