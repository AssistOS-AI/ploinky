import {
    BOX_MARKER_CONTENT,
    BOX_RUNTIME_GID,
    BOX_RUNTIME_UID,
} from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import {
    WEBTTY_NATIVE_PROBE_PATH,
    parseAndValidateNativeProbeOutput,
} from '../../core-services/webtty/native-runtime.mjs';

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
        PLOINKY_DISABLE_HOST_SANDBOX: '1',
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
        '/usr/local/bin/ploinky-box-entrypoint',
    ]),
    networkHelpers: Object.freeze(['pasta', 'slirp4netns']),
});
export const IMAGE_PROBE_TIMEOUT_MS = 60_000;
export const WEBTTY_NATIVE_PROBE_TIMEOUT_MS = 60_000;
const WEBTTY_NATIVE_PROBE_FAILURE = /(?:^|\n)WebTTY native probe failed: ([a-z0-9-]{1,64})(?:\n|$)/;

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
        os: String(record.Os ?? record.OS ?? '').trim().toLowerCase(),
        architecture: String(record.Architecture ?? '').trim().toLowerCase(),
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

export function validateImageContract(image, imageRef, {
    availableBinaries,
} = {}) {
    if (!image || typeof image !== 'object') {
        throw contractError(imageRef, 'inspection', 'one complete record', image);
    }
    if (!image.id) {
        throw contractError(imageRef, 'image ID', 'a nonempty immutable ID', image.id);
    }
    if (!isRecord(image.labels) || !sameRecord(image.labels, {})) {
        throw contractError(
            imageRef,
            'Config.Labels',
            'absent or empty',
            image.labels,
            'PLOINKY_BOX_IMAGE_CONTRACT_HARD_CUT',
            '; destroy and recreate the Box with the current runtime image',
        );
    }
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
    return Object.freeze({ ...image, immutableId: image.id });
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

export function probeImageBinaries(engine, imageId, runner) {
    const result = runner.query(engine, [
        'run',
        '--rm',
        '--network=none',
        '--entrypoint=/bin/bash',
        imageId,
        '-c',
        [
            'set -eu',
            `test "$(id -u)" -eq ${BOX_RUNTIME_UID}`,
            `test "$(id -g)" -eq ${BOX_RUNTIME_GID}`,
            "for name in node podman bash ip fuse-overlayfs cloudflared; do command -v \"$name\"; done",
            'test -x /usr/local/bin/ploinky-box-entrypoint',
            "printf '%s\\n' /usr/local/bin/ploinky-box-entrypoint",
            `test "$(wc -c < /etc/ploinky-box)" -eq ${Buffer.byteLength(BOX_MARKER_CONTENT)}`,
            `test "$(cat /etc/ploinky-box)" = '${BOX_MARKER_CONTENT.trim()}'`,
            "if command -v pasta >/dev/null 2>&1; then command -v pasta; elif command -v slirp4netns >/dev/null 2>&1; then command -v slirp4netns; else exit 17; fi",
        ].join('; '),
    ], { timeoutMs: IMAGE_PROBE_TIMEOUT_MS });
    if (!result.ok) {
        throw contractError(
            imageId,
            'runtime capabilities and marker',
            'all required tools and exact marker content',
            'probe failed',
        );
    }
    const observedPaths = String(result.stdout || '').split(/\r?\n/).filter(Boolean);
    const available = observedPaths.map((value) => (
        value === IMAGE_CONTRACT.entrypoint ? value : value.split('/').pop()
    ));
    return validateImageBinaries(available, imageId);
}

export function probeWebttyNativeRuntime(engine, imageId, image, runner) {
    const result = runner.query(engine, [
        'run',
        '--rm',
        '--network=none',
        '--pull=never',
        '--entrypoint=/usr/local/bin/node',
        imageId,
        WEBTTY_NATIVE_PROBE_PATH,
        '--verify',
    ], { timeoutMs: WEBTTY_NATIVE_PROBE_TIMEOUT_MS });
    if (!result.ok) {
        const failureCategory = result?.error?.code === 'ETIMEDOUT'
            ? 'timeout'
            : String(result.stderr || '').slice(0, 16 * 1024).match(WEBTTY_NATIVE_PROBE_FAILURE)?.[1]
                || 'probe-failed';
        throw contractError(
            imageId,
            'WebTTY native runtime probe',
            'a successful immutable node-pty import and PTY lifecycle',
            `failure category: ${failureCategory}`,
            'PLOINKY_BOX_WEBTTY_NATIVE_CONTRACT_INVALID',
            '; build or pull a compatible runtime image and recreate the Box',
        );
    }
    try {
        return parseAndValidateNativeProbeOutput(result.stdout, {
            platform: image.os,
            architecture: image.architecture,
            uid: BOX_RUNTIME_UID,
            gid: BOX_RUNTIME_GID,
        });
    } catch (error) {
        const categories = Array.isArray(error?.categories)
            ? error.categories.join(', ')
            : 'invalid-result';
        throw contractError(
            imageId,
            'WebTTY native runtime contract',
            'the exact supported schema, Node ABI, architecture, lock, artifact, user, and PTY lifecycle',
            `mismatch categories: ${categories}`,
            'PLOINKY_BOX_WEBTTY_NATIVE_CONTRACT_INVALID',
            '; build or pull a compatible runtime image and recreate the Box',
        );
    }
}

function inspectImmutableImage(engine, imageId, imageRef, runner, errorCode) {
    const result = runner.query(engine, ['image', 'inspect', imageId]);
    if (!result.ok) {
        throw new PloinkyBoxError(
            `Unable to verify the owned Box image '${imageId}'; destroy and recreate the Box`,
            { code: errorCode },
        );
    }
    const image = validateImageContract(normalizeImageInspect(result.stdout), imageRef);
    if (image.immutableId !== imageId) {
        throw contractError(
            imageRef,
            'image ID',
            JSON.stringify(imageId),
            image.immutableId,
        );
    }
    return image;
}

function probeAndReinspectImage(engine, image, imageRef, runner) {
    const availableBinaries = probeImageBinaries(engine, image.immutableId, runner);
    validateImageContract(image, imageRef, { availableBinaries });
    probeWebttyNativeRuntime(engine, image.immutableId, image, runner);
    return inspectImmutableImage(
        engine,
        image.immutableId,
        imageRef,
        runner,
        'PLOINKY_BOX_IMAGE_REINSPECT_FAILED',
    );
}

export function inspectAndValidateImage(engine, imageRef, runner) {
    const result = runner.query(engine, ['image', 'inspect', imageRef]);
    if (!result.ok) {
        throw new PloinkyBoxError(`Unable to inspect runtime image '${imageRef}'`, {
            code: 'PLOINKY_BOX_IMAGE_INSPECT_FAILED',
        });
    }
    const image = validateImageContract(normalizeImageInspect(result.stdout), imageRef);
    return probeAndReinspectImage(engine, image, imageRef, runner);
}

export function inspectAndValidateExistingImage(engine, imageId, imageRef, runner) {
    const image = inspectImmutableImage(
        engine,
        imageId,
        imageRef,
        runner,
        'PLOINKY_BOX_EXISTING_IMAGE_INSPECT_FAILED',
    );
    return probeAndReinspectImage(engine, image, imageRef, runner);
}
