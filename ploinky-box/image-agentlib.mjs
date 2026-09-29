import {
    AGENTLIB_LIBRARY_NAME,
    AGENTLIB_PACKAGE_NAME,
    normalizeLibraryProvenance,
} from '../agentlib/contract.mjs';
import { sanitizeAuthorityDiagnostic } from '../cli/sandbox/authorityCommandDiagnostics.mjs';
import { PloinkyBoxError } from './errors.mjs';
import { normalizeImageInspect, validateImageContract } from './contract/image.mjs';
import { normalizeImageId } from './contract/image-id.mjs';

// The image owns its library checks. The probe lives outside the Ploinky bind
// mount so it runs the image's own copy, whatever Ploinky is mounted.
export const IMAGE_AGENTLIB_PROBE_PATH = '/usr/local/share/ploinky/smoke-libraries.mjs';
const PROBE_TIMEOUT_MS = 60_000;
const PROBE_REASON_LIMIT = 500;
// The probe prints `CODE: message`; Node and Podman print `Error: ...`.
const PROBE_REASON_LINE = /^(?:PLOINKY_[A-Z0-9_]+|[A-Za-z]*Error(?: \[[A-Z0-9_]+\])?):/;

function bundleError(message, cause, reason = '') {
    return new PloinkyBoxError(
        `${message}. Build or pull a compatible Ploinky Box image containing a usable AchillesAgentLib package`
        + (reason ? `. ${reason}` : ''),
        { code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE', cause },
    );
}

// The CLI prints only the message, so a failed inspection must carry its own
// cause: a timeout, a process failure, or the stderr line that explains the exit.
function probeFailureReason(result) {
    const errorCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(String(result?.error?.code ?? '')) ? result.error.code : null;
    if (errorCode === 'ETIMEDOUT') return `The inspection command timed out after ${PROBE_TIMEOUT_MS / 1000} s.`;
    if (errorCode) return `The inspection command failed with ${errorCode}.`;
    const signal = /^SIG[A-Z0-9]{1,16}$/.test(String(result?.signal ?? '')) ? result.signal : null;
    const outcome = signal
        ? `The inspection command was terminated by ${signal}`
        : `The inspection command exited with status ${result?.status ?? 'unknown'}`;
    const lines = String(result?.stderr ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const line = lines.find((candidate) => PROBE_REASON_LINE.test(candidate)) ?? lines[0] ?? '';
    const reason = sanitizeAuthorityDiagnostic(line, { limit: PROBE_REASON_LIMIT });
    return reason ? `${outcome}: ${reason}` : `${outcome} without output.`;
}

/**
 * Availability of the package plus optional build provenance. The package must
 * be the expected one; the provenance is informational and, when absent or
 * malformed, reads as unavailable rather than blocking a usable package.
 */
function readProbe(result) {
    if (!result?.ok) {
        throw bundleError('The Box AchillesAgentLib package is missing or failed inspection',
            result?.error, probeFailureReason(result));
    }
    let report;
    try {
        report = JSON.parse(result.stdout);
    } catch (error) {
        throw bundleError('The Box AchillesAgentLib inspection returned an unreadable report',
            error, sanitizeAuthorityDiagnostic(error, { limit: PROBE_REASON_LIMIT }));
    }
    if (report?.packageName !== AGENTLIB_PACKAGE_NAME) {
        throw bundleError(`The Box image does not supply the ${AGENTLIB_LIBRARY_NAME} package`, undefined,
            `It reported package ${sanitizeAuthorityDiagnostic(JSON.stringify(String(report?.packageName ?? null)), { limit: 80 })}.`);
    }
    const provenance = report.provenance && typeof report.provenance === 'object' ? report.provenance : {};
    return {
        packageName: report.packageName,
        packageVersion: typeof report.packageVersion === 'string' && report.packageVersion ? report.packageVersion : null,
        provenance: normalizeLibraryProvenance({ ...report, ...provenance }),
    };
}

function inspectArguments() {
    return [IMAGE_AGENTLIB_PROBE_PATH, 'inspect', AGENTLIB_LIBRARY_NAME];
}

/**
 * Probe only an immutable image, offline and without workspace mounts. The
 * image ID is the source identity; the package report only proves that a usable
 * package is there and carries optional provenance.
 */
export function probeImageAgentLib(engine, imageId, runner) {
    const result = runner.query(engine, [
        'run', '--rm', '--network=none', '--pull=never',
        '--entrypoint=/usr/local/bin/node', imageId,
        ...inspectArguments(),
    ], { timeoutMs: PROBE_TIMEOUT_MS });
    return Object.freeze({ ...readProbe(result), supplyingImageId: normalizeImageId(imageId) });
}

/**
 * Called lazily, only when the workspace has no local library. `refresh` pulls
 * even when the reference exists locally: creating a missing Box pulls it
 * anyway, so the supplied package must come from those bytes, not an older
 * local tag.
 */
export async function loadBoxAgentLibImage({
    engine, imageRef, runner, stdout, stderr, allowPull = true, refresh = false,
}) {
    if (refresh && !allowPull) {
        throw new PloinkyBoxError('A Box image refresh requires an operation that may pull images',
            { code: 'PLOINKY_BOX_AGENTLIB_REFRESH_INVALID' });
    }
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
        inspection = runner.query(engine.name, ['image', 'inspect', imageRef]);
    }
    if (!inspection.ok) throw bundleError('Unable to inspect the Box image for AchillesAgentLib selection', inspection.error);
    const image = validateImageContract(normalizeImageInspect(inspection.stdout), imageRef);
    return probeImageAgentLib(engine.name, image.immutableId, runner);
}

/** Check that the running Box still has a usable package before admitting or restarting a graph. */
export function revalidateContainerAgentLib(selection, { engine, containerId, runner }) {
    const result = runner.query(engine.name, [
        'exec', containerId, '/usr/local/bin/node', ...inspectArguments(),
    ], { timeoutMs: PROBE_TIMEOUT_MS });
    readProbe(result);
    return selection;
}
