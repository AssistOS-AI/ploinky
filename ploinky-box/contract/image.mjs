import {
    BOX_MARKER_CONTENT,
} from '../constants.mjs';
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

function validateSourceLabel(labels, imageRef) {
    const label = IMAGE_CONTRACT.sourceShaLabel;
    const keys = isRecord(labels) ? Object.keys(labels) : [];
    const sourceSha = keys.length === 1 && keys[0] === label
        ? String(labels[label] ?? '')
        : '';
    if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
        throw contractError(
            imageRef,
            'Config.Labels',
            `exactly ${label}=<40 lowercase hexadecimal Ploinky commit>`,
            labels,
            'PLOINKY_BOX_IMAGE_CONTRACT_HARD_CUT',
            '; destroy and recreate the Box with the current runtime image',
        );
    }
    return sourceSha;
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
    const sourceSha = validateSourceLabel(image.labels, imageRef);
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
    return Object.freeze({ ...image, immutableId: image.id, sourceSha });
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
} = {}) {
    if (!/^[0-9a-f]{40}$/.test(expectedSourceSha ?? '')) {
        throw contractError(
            imageId,
            'Ploinky source SHA',
            'a 40-character lowercase hexadecimal commit',
            expectedSourceSha,
        );
    }
    const sourceMatch =
        `test "$helper_version" = 'ploinky-bwrap-launch-v1 source-sha=${expectedSourceSha}'`;
    const result = runner.query(engine, [
        'run',
        '--rm',
        '--network=none',
        '--entrypoint=/bin/bash',
        imageId,
        '-c',
        [
            'set -eu',
            "for name in node podman bash ip fuse-overlayfs cloudflared bwrap git curl ffmpeg ssh python3 script unshare ps setsid timeout npm npx getcap rpm; do command -v \"$name\"; done",
            'test -x /usr/local/bin/ploinky-box-entrypoint',
            "printf '%s\\n' /usr/local/bin/ploinky-box-entrypoint",
            `test -x ${IMAGE_CONTRACT.bwrapHelper}`,
            `printf '%s\\n' ${IMAGE_CONTRACT.bwrapHelper}`,
            `test "$(wc -c < /etc/ploinky-box)" -eq ${Buffer.byteLength(BOX_MARKER_CONTENT)}`,
            `test "$(cat /etc/ploinky-box)" = '${BOX_MARKER_CONTENT.trim()}'`,
            "case \"$(uname -m)\" in x86_64) rpm_arch=x86_64 ;; aarch64) rpm_arch=aarch64 ;; *) exit 18 ;; esac",
            `test "$(rpm -q --qf '%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}' bubblewrap)" = '${IMAGE_CONTRACT.bubblewrapNevra}.'"$rpm_arch"`,
            "test \"$(stat -c '%a:%u:%g' /usr/bin/bwrap)\" = '755:0:0'",
            "bwrap_capabilities=\"$(getcap /usr/bin/bwrap)\"",
            "test -z \"$bwrap_capabilities\"",
            "bwrap_help=\"$(bwrap --help 2>&1)\"",
            "for option in '--bind-fd FD DEST' '--ro-bind-fd FD DEST' '--ro-bind-data FD DEST' '--perms OCTAL'; do printf '%s\\n' \"$bwrap_help\" | grep -F -- \"$option\" >/dev/null; done",
            `test "$(stat -c '%a:%u:%g' ${IMAGE_CONTRACT.bwrapHelper})" = '755:0:0'`,
            `helper_file_capabilities="$(getcap ${IMAGE_CONTRACT.bwrapHelper})"`,
            'test -z "$helper_file_capabilities"',
            `helper_version="$(${IMAGE_CONTRACT.bwrapHelper} --version)"`,
            sourceMatch,
            `helper_capabilities="$(${IMAGE_CONTRACT.bwrapHelper} --capabilities)"`,
            "printf '%s\\n' \"$helper_capabilities\" | grep -F -- 'protocol=1 descriptor-fd=3' >/dev/null",
            "printf '%s\\n' \"$helper_capabilities\" | grep -F -- 'path-resolution=openat2-beneath-no-magiclinks-no-symlinks' >/dev/null",
            "printf '%s\\n' \"$helper_capabilities\" | grep -F -- 'bwrap-fd-options=bind-fd,ro-bind-fd,ro-bind-data,perms' >/dev/null",
            "printf '%s\\n' \"$helper_capabilities\" | grep -F -- 'typed-fs=dir,tmpfs,proc,dev,system-symlink,ro-data-path-file' >/dev/null",
            "printf '%s\\n' \"$helper_capabilities\" | grep -F -- 'ro-data-path-hardening=sealed-memfd-ro-bind-data' >/dev/null",
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
        IMAGE_CONTRACT.requiredBinaries.includes(value) ? value : value.split('/').pop()
    ));
    return validateImageBinaries(available, imageId);
}

export function inspectAndValidateImage(engine, imageRef, runner) {
    const result = runner.query(engine, ['image', 'inspect', imageRef]);
    if (!result.ok) {
        throw new PloinkyBoxError(`Unable to inspect runtime image '${imageRef}'`, {
            code: 'PLOINKY_BOX_IMAGE_INSPECT_FAILED',
        });
    }
    const image = normalizeImageInspect(result.stdout);
    const validatedImage = validateImageContract(image, imageRef);
    const availableBinaries = probeImageBinaries(engine, image.id, runner, {
        expectedSourceSha: validatedImage.sourceSha,
    });
    return validateImageContract(image, imageRef, { availableBinaries });
}

export function inspectAndValidateExistingImage(engine, imageId, imageRef, runner) {
    const result = runner.query(engine, ['image', 'inspect', imageId]);
    if (!result.ok) {
        throw new PloinkyBoxError(
            `Unable to verify the owned Box image '${imageId}'; destroy and recreate the Box`,
            { code: 'PLOINKY_BOX_EXISTING_IMAGE_INSPECT_FAILED' },
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
