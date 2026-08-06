import { PloinkyBoxError } from '../errors.mjs';

export const IMAGE_CONTRACT = Object.freeze({
    user: 'podman',
    home: '/home/podman',
    workdir: '/workspace',
    path: '/opt/ploinky/bin:/usr/local/bin:/usr/bin',
    entrypoint: '/usr/local/bin/ploinky-box-entrypoint',
    command: Object.freeze([]),
    volumes: Object.freeze({}),
    environment: Object.freeze({
        PATH: '/opt/ploinky/bin:/usr/local/bin:/usr/bin',
        USER: 'podman',
        HOME: '/home/podman',
        PLOINKY_WORKSPACE_ROOT: '/workspace',
        container: 'oci',
        _CONTAINERS_USERNS_CONFIGURED: '',
        BUILDAH_ISOLATION: 'chroot',
    }),
    requiredBinaries: Object.freeze([
        'node',
        'podman',
        'bash',
        'ip',
        'fuse-overlayfs',
        'cloudflared',
        'bwrap',
        'git',
        'curl',
        'ffmpeg',
        'ssh',
        'python3',
        'script',
        'unshare',
        'ps',
        'setsid',
        'timeout',
        'npm',
        'npx',
        'getcap',
        'rpm',
        '/usr/local/bin/ploinky-box-entrypoint',
        '/usr/local/libexec/ploinky-bwrap-launch',
    ]),
    networkHelpers: Object.freeze(['pasta', 'slirp4netns']),
    sourceShaLabel: 'io.assistos.ploinky.source-sha',
    agentlibShaLabel: 'io.assistos.ploinky.agentlib-sha',
    buildahVersionLabel: 'io.buildah.version',
    bubblewrapNevra: 'bubblewrap-0:0.11.0-4.fc44',
    bwrapHelper: '/usr/local/libexec/ploinky-bwrap-launch',
});
export const IMAGE_PROBE_TIMEOUT_MS = 60_000;

function contractError(
    imageRef,
    field,
    expected,
    observed,
    code = 'PLOINKY_BOX_IMAGE_CONTRACT_INVALID',
    guidance = '',
) {
    const shown = observed === undefined || observed === null || observed === ''
        ? '<missing>'
        : JSON.stringify(observed);
    return new PloinkyBoxError(
        `Runtime image '${imageRef}' has invalid ${field}; expected ${expected}, observed ${shown}${guidance}`,
        { code },
    );
}

function singularRecord(raw) {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
        if (parsed.length !== 1) {
            throw new Error('image inspection must contain exactly one record');
        }
        return parsed[0];
    }
    return parsed;
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function envMap(entries) {
    if (!Array.isArray(entries)) {
        return null;
    }
    const result = {};
    for (const entry of entries) {
        const text = String(entry);
        const separator = text.indexOf('=');
        const key = separator < 0 ? text : text.slice(0, separator);
        if (!key || Object.hasOwn(result, key)) {
            return null;
        }
        result[key] = separator < 0 ? '' : text.slice(separator + 1);
    }
    return result;
}

export function normalizeImageInspect(raw) {
    let record;
    try {
        record = singularRecord(raw);
    } catch (error) {
        throw contractError('<unknown>', 'inspection', 'one complete record', error.message);
    }
    if (!isRecord(record) || !isRecord(record.Config)) {
        throw contractError('<unknown>', 'inspection', 'one complete record', record);
    }
    const config = record.Config;
    return Object.freeze({
        id: String(record.Id ?? record.ID ?? '').trim(),
        user: String(config.User ?? ''),
        workdir: String(config.WorkingDir ?? ''),
        environment: envMap(config.Env),
        entrypoint: Array.isArray(config.Entrypoint)
            ? config.Entrypoint.map(String)
            : null,
        command: config.Cmd === null || config.Cmd === undefined
            ? []
            : Array.isArray(config.Cmd) ? config.Cmd.map(String) : null,
        volumes: config.Volumes === null || config.Volumes === undefined
            ? {}
            : isRecord(config.Volumes) ? { ...config.Volumes } : null,
        labels: config.Labels === null || config.Labels === undefined
            ? {}
            : isRecord(config.Labels) ? { ...config.Labels } : null,
    });
}

function sameRecord(left, right) {
    const leftKeys = Object.keys(left || {}).sort();
    const rightKeys = Object.keys(right || {}).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => (
            key === rightKeys[index] && left[key] === right[key]
        ));
}

function validateProvenanceLabels(labels, imageRef) {
    const label = IMAGE_CONTRACT.sourceShaLabel;
    const agentlibLabel = IMAGE_CONTRACT.agentlibShaLabel;
    const buildahLabel = IMAGE_CONTRACT.buildahVersionLabel;
    const keys = isRecord(labels) ? Object.keys(labels).sort() : [];
    const allowedKeys = new Set([label, agentlibLabel, buildahLabel]);
    const sourceSha = String(labels?.[label] ?? '');
    const rawAgentlibSha = labels?.[agentlibLabel];
    const agentlibSha = String(rawAgentlibSha ?? '');
    const buildahVersion = labels?.[buildahLabel];
    const hasOnlyAllowedLabels = keys.length >= 1
        && keys.every((key) => allowedKeys.has(key));
    const hasValidBuildahVersion = buildahVersion === undefined
        || /^[0-9]+(?:\.[0-9]+){1,3}$/.test(String(buildahVersion));
    const hasValidAgentlibSha = rawAgentlibSha === undefined
        || /^[0-9a-f]{40}$/.test(agentlibSha);
    if (!hasOnlyAllowedLabels
        || !/^[0-9a-f]{40}$/.test(sourceSha)
        || !hasValidAgentlibSha
        || !hasValidBuildahVersion) {
        throw contractError(
            imageRef,
            'Config.Labels',
            `only ${label}=<40 lowercase hexadecimal Ploinky commit>`
                + `, optional ${agentlibLabel}=<40 lowercase hexadecimal AgentLib commit>,`
                + ` and optional ${buildahLabel}=<numeric dotted version>`,
            labels,
            'PLOINKY_BOX_IMAGE_CONTRACT_HARD_CUT',
            '; destroy and recreate the Box with the current runtime image',
        );
    }
    return Object.freeze({ sourceSha, agentlibSha });
}

export function validateImageContract(image, imageRef, {
    availableBinaries,
} = {}) {
    if (!image || typeof image !== 'object') {
        throw contractError(imageRef, 'inspection', 'one complete record', image);
    }
    if (!image.id) {
        throw contractError(imageRef, 'image ID', 'a nonempty immutable ID', image.id);
    }
    const { sourceSha, agentlibSha } = validateProvenanceLabels(image.labels, imageRef);
    if (image.user !== IMAGE_CONTRACT.user) {
        throw contractError(imageRef, 'Config.User', JSON.stringify(IMAGE_CONTRACT.user), image.user);
    }
    if (image.workdir !== IMAGE_CONTRACT.workdir) {
        throw contractError(imageRef, 'Config.WorkingDir', JSON.stringify(IMAGE_CONTRACT.workdir), image.workdir);
    }
    if (!sameRecord(image.environment, IMAGE_CONTRACT.environment)) {
        throw contractError(
            imageRef,
            'Config.Env',
            `exactly ${JSON.stringify(IMAGE_CONTRACT.environment)}`,
            image.environment,
        );
    }
    if (!Array.isArray(image.entrypoint)
        || image.entrypoint.length !== 1
        || image.entrypoint[0] !== IMAGE_CONTRACT.entrypoint) {
        throw contractError(
            imageRef,
            'Config.Entrypoint',
            JSON.stringify([IMAGE_CONTRACT.entrypoint]),
            image.entrypoint,
        );
    }
    if (!Array.isArray(image.command) || image.command.length !== 0) {
        throw contractError(imageRef, 'Config.Cmd', 'absent or empty', image.command);
    }
    if (!isRecord(image.volumes) || Object.keys(image.volumes).length !== 0) {
        throw contractError(imageRef, 'Config.Volumes', 'absent or empty', image.volumes);
    }
    if (availableBinaries !== undefined) {
        validateImageBinaries(availableBinaries, imageRef);
    }
    return Object.freeze({ ...image, immutableId: image.id, sourceSha, agentlibSha });
}

export function validateImageBinaries(availableBinaries, imageRef) {
    const available = new Set(Array.isArray(availableBinaries) ? availableBinaries : []);
    for (const binary of IMAGE_CONTRACT.requiredBinaries) {
        if (!available.has(binary)) {
            throw contractError(imageRef, `required binary ${binary}`, 'present and executable', 'missing');
        }
    }
    if (!IMAGE_CONTRACT.networkHelpers.some((binary) => available.has(binary))) {
        throw contractError(
            imageRef,
            'rootless network helper',
            'pasta or slirp4netns',
            'missing',
        );
    }
    return Object.freeze([...available]);
}

export function probeImageBinaries(engine, imageId, runner, {
    expectedSourceSha,
    identity,
    releaseDescriptor,
} = {}) {
    void engine;
    void runner;
    void expectedSourceSha;
    void identity;
    void releaseDescriptor;
    throw new PloinkyBoxError(
        `Runtime capability probing for image '${imageId}' is unsupported on the outer host; implicit temporary-container lifecycle is forbidden`,
        { code: 'PLOINKY_BOX_IMAGE_PROBE_UNSUPPORTED' },
    );
}

export async function inspectAndValidateDirectImage(hostClient, imageId, imageRef = imageId) {
    if (!hostClient || typeof hostClient.inspectImage !== 'function') {
        throw new PloinkyBoxError('Structured image inspection is unavailable', {
            code: 'PLOINKY_BOX_IMAGE_INSPECT_FAILED',
        });
    }
    const inspection = await hostClient.inspectImage(imageId);
    const image = validateImageContract(normalizeImageInspect(inspection), imageRef);
    if (image.immutableId !== imageId) {
        throw contractError(imageRef, 'image ID', JSON.stringify(imageId), image.immutableId);
    }
    return image;
}

export function inspectAndValidateImage(engine, imageRef, runner, {
    identity,
    releaseDescriptor,
} = {}) {
    void engine; void runner; void identity; void releaseDescriptor;
    throw new PloinkyBoxError(
        `Ordinary host image inspection for '${imageRef}' is retired; use the structured exact-image client`,
        { code: 'PLOINKY_BOX_IMAGE_INSPECT_UNSUPPORTED' },
    );
}

export function inspectAndValidateExistingImage(engine, imageId, imageRef, runner) {
    void engine; void imageRef; void runner;
    throw new PloinkyBoxError(
        `Ordinary host image inspection for '${imageId}' is retired; use the structured exact-image client`,
        { code: 'PLOINKY_BOX_EXISTING_IMAGE_INSPECT_UNSUPPORTED' },
    );
}
