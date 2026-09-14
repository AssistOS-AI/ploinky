import {
    canonicalAgentLibRemote,
    validateImageBundleMetadata,
} from '../agentlib/contract.mjs';
import { PloinkyBoxError } from './errors.mjs';
import { normalizeImageInspect, validateImageContract } from './contract/image.mjs';
import { normalizeImageId } from './contract/image-id.mjs';

export const IMAGE_AGENTLIB_PROBE_PATH = '/usr/local/share/ploinky/agentlib/image-bundle.mjs';
const RUNTIME_AGENTLIB_PROBE_PATH = '/opt/ploinky/agentlib/image-bundle.mjs';

function bundleError(message, cause) {
    return new PloinkyBoxError(
        `${message}. Build or pull a compatible Ploinky Box image containing the pinned AchillesAgentLib copy`,
        { code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE', cause },
    );
}

function readProbe(result, expectedCommit) {
    if (!result?.ok) {
        throw bundleError('The Box AchillesAgentLib bundle is missing or failed verification', result?.error);
    }
    try {
        return validateImageBundleMetadata(JSON.parse(result.stdout), { expectedCommit });
    } catch (error) {
        throw bundleError('The Box AchillesAgentLib bundle does not match the required revision or fingerprint', error);
    }
}

/** Probe only an immutable image, offline and without workspace mounts. */
export function probeImageAgentLib(engine, imageId, runner, {
    expectedCommit = canonicalAgentLibRemote().commit,
} = {}) {
    const result = runner.query(engine, [
        'run', '--rm', '--network=none', '--pull=never',
        '--entrypoint=/usr/local/bin/node', imageId,
        IMAGE_AGENTLIB_PROBE_PATH, 'verify', '--expected-commit', expectedCommit,
    ], { timeoutMs: 60_000 });
    return Object.freeze({ ...readProbe(result, expectedCommit), imageId: normalizeImageId(imageId) });
}

/** Called lazily, only when the workspace has no local library. */
export async function loadBoxAgentLibImage({ engine, imageRef, runner, stdout, stderr }) {
    let inspection = runner.query(engine.name, ['image', 'inspect', imageRef]);
    if (!inspection.ok) {
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

/** Check the actual running copy before admitting or restarting a graph. */
export function revalidateContainerAgentLib(selection, { engine, containerId, runner }) {
    const commit = selection.resolvedCommit ?? selection.commit;
    const fingerprint = selection.contentFingerprint ?? selection.fingerprint;
    const result = runner.query(engine.name, [
        'exec', containerId, '/usr/local/bin/node', RUNTIME_AGENTLIB_PROBE_PATH,
        'verify', '--expected-commit', commit,
    ], { timeoutMs: 60_000 });
    const bundle = readProbe(result, commit);
    if (bundle.fingerprint !== fingerprint) {
        throw bundleError('The running Box AchillesAgentLib fingerprint changed');
    }
    return selection;
}
