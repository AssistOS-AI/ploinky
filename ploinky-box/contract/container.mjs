import {
    BOX_AGENTLIB_LABELS,
    BOX_DATA_FINGERPRINT_LABELS,
    BOX_DATA_KEYS,
    BOX_DATA_MOUNTS,
    BOX_LABELS,
    BOX_MEDIA_PORT,
    BOX_ROUTER_CONTAINER_PORT,
    BOX_ROUTER_HEALTH_SOCKET,
    BOX_TMPFS,
    BOX_USERNS,
} from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { nestedPodmanSeccompProfileContract } from '../seccomp.mjs';
import {
    agentLibBoxEnv,
    expectedAgentLibMounts,
    normalizeBoxAgentLib,
} from './agentlib.mjs';
import { IMAGE_CONTRACT } from './image.mjs';

const BOX_OWNERSHIP_LABEL_PREFIX = 'io.assistos.ploinky-box.';
const INCOMPATIBLE_BOX_GUIDANCE = "; back up any Box-only data, then run 'ploinky stop'"
    + " and 'ploinky destroy' before retrying";

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

function normalizePortBindings(bindings) {
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
        return null;
    }
    const result = [];
    for (const [target, values] of Object.entries(bindings)) {
        const [containerPort, protocol = 'tcp'] = target.split('/');
        if (!Array.isArray(values)) {
            return null;
        }
        for (const value of values) {
            const inspectedHostIp = String(value?.HostIp ?? '');
            result.push({
                containerPort: String(containerPort),
                protocol: String(protocol),
                hostIp: inspectedHostIp === '' ? '0.0.0.0' : inspectedHostIp,
                hostPort: String(value?.HostPort ?? ''),
            });
        }
    }
    return result.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function repeatedOptionValues(argv, option) {
    if (!Array.isArray(argv)) return null;
    const result = [];
    for (let index = 0; index < argv.length; index += 1) {
        const argument = String(argv[index]);
        if (argument === option) {
            if (index + 1 >= argv.length) return null;
            result.push(String(argv[index + 1]));
            index += 1;
        } else if (argument.startsWith(`${option}=`)) {
            result.push(argument.slice(option.length + 1));
        }
    }
    return result;
}

function normalizeOptionSet(value) {
    if (typeof value !== 'string' || value === '') return null;
    const options = value.split(',');
    if (options.some((option) => option === '') || new Set(options).size !== options.length) {
        return null;
    }
    return options.sort();
}

function normalizeTmpfsValue(value) {
    const separator = String(value).indexOf(':');
    if (separator <= 0) return null;
    const destination = String(value).slice(0, separator);
    const options = normalizeOptionSet(String(value).slice(separator + 1));
    return options ? { destination, options } : null;
}

export function normalizeContainerTmpfs(value) {
    if (value === undefined || value === null) return [];
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    const result = [];
    for (const [destination, optionText] of Object.entries(value)) {
        const options = normalizeOptionSet(optionText);
        if (!destination.startsWith('/') || !options) return null;
        result.push({ destination, options });
    }
    return result.sort((left, right) => left.destination.localeCompare(right.destination));
}

export function normalizeContainerRuntime(record) {
    const config = record?.Config;
    const hostConfig = record?.HostConfig;
    const state = record?.State;
    return Object.freeze({
        complete: Boolean(
            config && typeof config === 'object'
            && hostConfig && typeof hostConfig === 'object'
            && state && typeof state === 'object'
        ),
        imageId: String(record?.Image ?? record?.ImageID ?? '').trim(),
        configuredImage: String(config?.Image ?? '').trim(),
        user: String(config?.User ?? ''),
        environment: envMap(config?.Env),
        createCommand: Array.isArray(config?.CreateCommand)
            ? config.CreateCommand.map(String)
            : null,
        publications: normalizePortBindings(hostConfig?.PortBindings),
        running: state?.Running === true || String(state?.Status || '') === 'running',
        status: String(state?.Status ?? ''),
        init: hostConfig?.Init === true,
        usernsMode: String(hostConfig?.UsernsMode ?? ''),
        privileged: hostConfig?.Privileged === true,
        securityOptions: Array.isArray(hostConfig?.SecurityOpt)
            ? hostConfig.SecurityOpt.map(String).sort()
            : null,
        devices: Array.isArray(hostConfig?.Devices)
            ? hostConfig.Devices.map((device) => ({
                hostPath: String(device?.PathOnHost ?? ''),
                containerPath: String(device?.PathInContainer ?? ''),
                permissions: String(device?.CgroupPermissions ?? ''),
            })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
            : null,
        tmpfs: normalizeContainerTmpfs(hostConfig?.Tmpfs),
        mounts: Array.isArray(record?.Mounts)
            ? record.Mounts.map((mount) => ({
                type: String(mount?.Type ?? '').toLowerCase(),
                source: String(mount?.Source ?? ''),
                name: String(mount?.Name ?? ''),
                destination: String(mount?.Destination ?? ''),
                rw: mount?.RW === true,
            })).sort((left, right) => left.destination.localeCompare(right.destination))
            : null,
    });
}

function publicationError(message) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_PUBLICATION_INCOMPATIBLE',
    });
}

export function validateContainerPublications(
    containerHandle,
    expectedHostPort,
    expectedMediaHostPort = BOX_MEDIA_PORT,
) {
    const runtime = containerHandle?.runtime;
    const port = String(expectedHostPort);
    const mediaPort = String(expectedMediaHostPort);
    if (!runtime?.complete || !Array.isArray(runtime.publications) || !runtime.environment) {
        throw publicationError('Owned Box has incomplete runtime publication state');
    }
    const expected = [
        {
            containerPort: String(BOX_ROUTER_CONTAINER_PORT),
            protocol: 'tcp',
            hostIp: '127.0.0.1',
            hostPort: port,
        },
        {
            containerPort: String(BOX_MEDIA_PORT),
            protocol: 'udp',
            hostIp: '0.0.0.0',
            hostPort: mediaPort,
        },
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    if (JSON.stringify(runtime.publications) !== JSON.stringify(expected)) {
        throw publicationError(
            'Owned Box publications do not match the fixed TCP/UDP contract: '
            + `observed=${JSON.stringify(runtime.publications)} `
            + `expected=${JSON.stringify(expected)}`,
        );
    }
    if (containerHandle.labels?.[BOX_LABELS.routerHostPort] !== port) {
        throw publicationError('Owned Box host-port label does not match its publication');
    }
    if (containerHandle.labels?.[BOX_LABELS.mediaHostPort] !== mediaPort) {
        throw publicationError('Owned Box media host-port label does not match its publication');
    }
    if (runtime.environment.PLOINKY_PUBLIC_AUTHORITY !== `127.0.0.1:${port}`) {
        throw publicationError('Owned Box public authority does not match its publication');
    }
    return Object.freeze({
        hostPort: Number(port),
        mediaHostPort: Number(mediaPort),
        tcp: expected.find((item) => item.protocol === 'tcp'),
        udp: expected.find((item) => item.protocol === 'udp'),
        running: runtime.running,
    });
}

export function validateContainerConfiguration(containerHandle, {
    identity,
    dataFingerprints,
    agentLib,
    hostPort,
    mediaHostPort = BOX_MEDIA_PORT,
    imageId,
    imageRef,
    repositoryRoot,
    hostKind = 'native-linux',
}) {
    const publication = validateContainerPublications(containerHandle, hostPort, mediaHostPort);
    const runtime = containerHandle.runtime;
    const seccompProfile = nestedPodmanSeccompProfileContract(repositoryRoot);
    if (containerHandle.id === '' || runtime.imageId !== imageId) {
        throw publicationError('Owned Box image ID does not match the validated immutable image');
    }
    if (runtime.user !== 'podman' || runtime.privileged || runtime.init !== true) {
        throw publicationError('Owned Box user, privilege, or init state is incompatible');
    }
    const recordedUserNamespaces = repeatedOptionValues(runtime.createCommand, '--userns');
    if (runtime.usernsMode !== 'private'
        || JSON.stringify(recordedUserNamespaces) !== JSON.stringify([BOX_USERNS])) {
        throw publicationError(
            `Owned Box user namespace is incompatible${INCOMPATIBLE_BOX_GUIDANCE}`,
        );
    }
    const expectedLabels = {
        [BOX_LABELS.pathHash]: identity.pathHash,
        [BOX_LABELS.role]: 'box',
        [BOX_LABELS.imageRef]: imageRef,
        [BOX_LABELS.routerHostPort]: String(hostPort),
        [BOX_LABELS.mediaHostPort]: String(mediaHostPort),
        [BOX_LABELS.seccompFingerprint]: seccompProfile.fingerprint,
    };
    const selectedFingerprints = dataFingerprints || Object.fromEntries(BOX_DATA_KEYS.map((key) => [
        key,
        String(containerHandle.labels?.[BOX_DATA_FINGERPRINT_LABELS[key]] || ''),
    ]));
    const fingerprintValues = BOX_DATA_KEYS.map((key) => String(selectedFingerprints?.[key] || ''));
    const hasFingerprints = fingerprintValues.some(Boolean);
    if (hasFingerprints && !fingerprintValues.every((value) => /^[a-f0-9]{64}$/.test(value))) {
        throw publicationError('Owned Box directory fingerprint set is incompatible');
    }
    if (hasFingerprints) {
        for (const key of BOX_DATA_KEYS) {
            expectedLabels[BOX_DATA_FINGERPRINT_LABELS[key]] = String(selectedFingerprints[key]);
        }
    }
    if (!agentLib) {
        throw publicationError(
            `Owned Box has no selected achillesAgentLib source${INCOMPATIBLE_BOX_GUIDANCE}`,
        );
    }
    const agentLibContract = normalizeBoxAgentLib(agentLib);
    expectedLabels[BOX_AGENTLIB_LABELS.mode] = agentLibContract.mode;
    expectedLabels[BOX_AGENTLIB_LABELS.sourceIdHash] = agentLibContract.sourceIdHash;
    expectedLabels[BOX_AGENTLIB_LABELS.fingerprint] = agentLibContract.fingerprint;
    expectedLabels[BOX_AGENTLIB_LABELS.sourceRelativePath] = agentLibContract.sourceRelativePath;
    expectedLabels[BOX_AGENTLIB_LABELS.commit] = agentLibContract.commit;
    const ownershipLabels = Object.fromEntries(Object.entries(containerHandle.labels)
        .filter(([key]) => key.startsWith(BOX_OWNERSHIP_LABEL_PREFIX))
        .sort());
    if (JSON.stringify(ownershipLabels)
        !== JSON.stringify(Object.fromEntries(Object.entries(expectedLabels).sort()))) {
        throw publicationError('Owned Box label set is incompatible');
    }
    const expectedEnvironment = {
        ...IMAGE_CONTRACT.environment,
        ...agentLibBoxEnv(agentLibContract),
        PLOINKY_PUBLIC_BIND: '0.0.0.0',
        PLOINKY_PUBLIC_AUTHORITY: `127.0.0.1:${hostPort}`,
        PLOINKY_PRIVATE_BIND: '0.0.0.0',
        PLOINKY_ROUTER_HEALTH_SOCKET: BOX_ROUTER_HEALTH_SOCKET,
    };
    const observedEnvironment = { ...runtime.environment };
    const runtimeHostname = observedEnvironment.HOSTNAME;
    delete observedEnvironment.HOSTNAME;
    if (runtimeHostname !== containerHandle.id.slice(0, 12)
        || JSON.stringify(Object.fromEntries(Object.entries(observedEnvironment).sort()))
        !== JSON.stringify(Object.fromEntries(Object.entries(expectedEnvironment).sort()))) {
        throw publicationError('Owned Box environment allowlist is incompatible');
    }
    const expectedSecurityOptions = [
        'unmask=all',
        'label=disable',
        `seccomp=${seccompProfile.path}`,
    ].sort();
    const observedSecurityOptions = Array.isArray(runtime.securityOptions)
        ? runtime.securityOptions.map((value) => {
            const option = String(value);
            const separator = option.indexOf('=');
            const key = (separator === -1 ? option : option.slice(0, separator)).toLowerCase();
            const optionValue = separator === -1 ? '' : option.slice(separator + 1);
            return key === 'seccomp'
                ? `${key}=${optionValue}`
                : option.toLowerCase();
        }).sort()
        : null;
    if (!Array.isArray(runtime.securityOptions)
        || JSON.stringify(observedSecurityOptions) !== JSON.stringify(expectedSecurityOptions)) {
        throw publicationError('Owned Box security options are incompatible');
    }
    const expectedDevices = ['/dev/fuse', '/dev/net/tun'];
    const recordedDevices = repeatedOptionValues(runtime.createCommand, '--device');
    const omittedDeviceInspectionIsProven = Array.isArray(runtime.devices)
        && runtime.devices.length === 0
        && JSON.stringify(recordedDevices) === JSON.stringify(expectedDevices);
    if (!omittedDeviceInspectionIsProven && (
        !Array.isArray(runtime.devices)
        || runtime.devices.length !== 2
        || runtime.devices.some((device, index) => (
            device.hostPath !== expectedDevices[index]
            || device.containerPath !== expectedDevices[index]
            || device.permissions !== 'rwm'
        ))
    )) {
        throw publicationError(
            'Owned Box device set is incompatible: '
            + `observed=${JSON.stringify(runtime.devices)} `
            + `recorded=${JSON.stringify(recordedDevices)} `
            + `expected=${JSON.stringify(expectedDevices)} hostKind=${hostKind}`,
        );
    }
    const expectedTmpfs = [{
        destination: BOX_TMPFS.destination,
        // Podman records notmpcopyup only in Config.CreateCommand and exposes
        // the resulting private propagation in HostConfig.Tmpfs.
        options: [...BOX_TMPFS.options.filter((option) => option !== 'notmpcopyup'), 'rprivate']
            .sort(),
    }];
    const recordedTmpfsValues = repeatedOptionValues(runtime.createCommand, '--tmpfs');
    const recordedTmpfs = Array.isArray(recordedTmpfsValues)
        ? recordedTmpfsValues.map(normalizeTmpfsValue)
        : null;
    const wantedRecordedTmpfs = [{
        destination: BOX_TMPFS.destination,
        options: [...BOX_TMPFS.options].sort(),
    }];
    if (JSON.stringify(runtime.tmpfs) !== JSON.stringify(expectedTmpfs)
        || JSON.stringify(recordedTmpfs) !== JSON.stringify(wantedRecordedTmpfs)) {
        throw publicationError(
            `Owned Box tmpfs set is incompatible${INCOMPATIBLE_BOX_GUIDANCE}`,
        );
    }
    // Durable state is exactly six host binds: the four workspace binds plus the
    // stable read-only achillesAgentLib source and the read-only shadow over its
    // writable /workspace alias. Podman currently reports the /tmp tmpfs through
    // HostConfig.Tmpfs and may additionally expose the same mount in Mounts; no
    // named, anonymous, or unrelated mount is accepted.
    const expectedMounts = {
        '/opt/ploinky': { source: repositoryRoot, rw: false },
        '/workspace': { source: identity.workspaceRoot, rw: true },
        [BOX_DATA_MOUNTS.dependencies]: { source: identity.dataPaths.dependencies, rw: true },
        [BOX_DATA_MOUNTS.images]: { source: identity.dataPaths.images, rw: true },
        ...expectedAgentLibMounts(agentLibContract),
    };
    if (!Array.isArray(runtime.mounts)) {
        throw publicationError('Owned Box mount set is incompatible');
    }
    const transientMounts = runtime.mounts.filter((mount) => mount.destination === BOX_TMPFS.destination);
    if (transientMounts.length > 1
        || (transientMounts.length === 1 && (
            transientMounts[0].type !== 'tmpfs'
            || transientMounts[0].source !== ''
            || transientMounts[0].name !== ''
            || transientMounts[0].rw !== true
        ))
        || runtime.mounts.length !== Object.keys(expectedMounts).length + transientMounts.length) {
        throw publicationError('Owned Box mount set is incompatible');
    }
    for (const [destination, expected] of Object.entries(expectedMounts)) {
        const observed = runtime.mounts.find((mount) => mount.destination === destination);
        if (!observed
            || observed.type !== 'bind'
            || observed.rw !== expected.rw
            || observed.source !== expected.source) {
            throw publicationError(
                `Owned Box mount ${destination} is incompatible${INCOMPATIBLE_BOX_GUIDANCE}`,
            );
        }
    }
    return Object.freeze({ ...publication, imageId, imageRef });
}
