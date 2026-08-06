import {
    BOX_LABELS,
    BOX_MEDIA_PORT,
    BOX_ROUTER_CONTAINER_PORT,
} from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { IMAGE_CONTRACT } from './image.mjs';
import {
    RELEASE_DESCRIPTOR_ENV,
    parseReleaseDescriptor,
    serializeReleaseDescriptor,
} from './release.mjs';

const BOX_OWNERSHIP_LABEL_PREFIX = 'io.assistos.ploinky-box.';
const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/;
const OUTER_CREATION_KEYS = Object.freeze([
    'autoRemove',
    'command',
    'dependencies',
    'devices',
    'env',
    'mounts',
    'network',
    'ports',
    'security',
    'tmpfs',
    'volumes',
]);

function exactObject(value) {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype
            || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys) {
    return exactObject(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function boundedString(value, label, { allowEmpty = false, maximum = 131_072 } = {}) {
    if (typeof value !== 'string'
        || (!allowEmpty && value.length === 0)
        || Buffer.byteLength(value, 'utf8') > maximum
        || /\u0000/u.test(value)) {
        throw publicationError(`Outer Box creation tuple has invalid ${label}`);
    }
    return value;
}

function uniqueStrings(value, label, { allowEmpty = false, nonEmpty = false } = {}) {
    if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
        throw publicationError(`Outer Box creation tuple has invalid ${label}`);
    }
    const normalized = value.map((entry, index) => boundedString(
        entry,
        `${label}[${index}]`,
        { allowEmpty },
    ));
    if (new Set(normalized).size !== normalized.length) {
        throw publicationError(`Outer Box creation tuple contains duplicate ${label}`);
    }
    return normalized;
}

function stringList(value, label, { allowEmpty = false, nonEmpty = false } = {}) {
    if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
        throw publicationError(`Outer Box creation tuple has invalid ${label}`);
    }
    return value.map((entry, index) => boundedString(
        entry,
        `${label}[${index}]`,
        { allowEmpty },
    ));
}

function canonicalJson(value, label, depth = 0) {
    if (depth > 12) {
        throw publicationError(`Outer Box creation tuple ${label} is too deeply nested`);
    }
    if (typeof value === 'string') return boundedString(value, label, { allowEmpty: true });
    if (typeof value === 'boolean' || value === null) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (Array.isArray(value)) {
        return value.map((entry, index) => canonicalJson(entry, `${label}[${index}]`, depth + 1));
    }
    if (!exactObject(value)) {
        throw publicationError(`Outer Box creation tuple has invalid ${label}`);
    }
    const keys = Object.keys(value).sort();
    if (new Set(keys).size !== keys.length) {
        throw publicationError(`Outer Box creation tuple contains duplicate ${label} keys`);
    }
    return Object.fromEntries(keys.map((key) => [
        boundedString(key, `${label} key`),
        canonicalJson(value[key], `${label}.${key}`, depth + 1),
    ]));
}

function uniqueStructured(value, label, normalize, { nonEmpty = false } = {}) {
    if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
        throw publicationError(`Outer Box creation tuple has invalid ${label}`);
    }
    const result = value.map(normalize);
    const serialized = result.map((entry) => JSON.stringify(entry));
    if (new Set(serialized).size !== serialized.length) {
        throw publicationError(`Outer Box creation tuple contains duplicate ${label}`);
    }
    return result;
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

export function requireFullContainerId(value, label = 'container ID') {
    const id = String(value || '');
    if (!FULL_CONTAINER_ID.test(id)) {
        throw publicationError(`Outer Box ${label} must be a full 64-hex immutable ID`);
    }
    return id;
}

export function normalizeOuterContainerCreationTuple(value) {
    if (!exactKeys(value, OUTER_CREATION_KEYS)) {
        throw publicationError('Outer Box creation tuple has an invalid or incomplete key set');
    }
    const ports = uniqueStructured(value.ports, 'ports', (entry, index) => {
        if (!exactKeys(entry, ['containerPort', 'hostIp', 'hostPort', 'protocol'])) {
            throw publicationError(`Outer Box creation tuple has invalid ports[${index}]`);
        }
        const protocol = boundedString(entry.protocol, `ports[${index}].protocol`).toLowerCase();
        if (!['tcp', 'udp'].includes(protocol)) {
            throw publicationError(`Outer Box creation tuple has invalid ports[${index}].protocol`);
        }
        return {
            containerPort: boundedString(entry.containerPort, `ports[${index}].containerPort`),
            protocol,
            hostIp: boundedString(entry.hostIp, `ports[${index}].hostIp`),
            hostPort: boundedString(entry.hostPort, `ports[${index}].hostPort`),
        };
    }, { nonEmpty: true }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const mounts = uniqueStructured(value.mounts, 'mounts', (entry, index) => {
        if (!exactKeys(entry, ['destination', 'name', 'rw', 'source', 'type'])
            || typeof entry.rw !== 'boolean') {
            throw publicationError(`Outer Box creation tuple has invalid mounts[${index}]`);
        }
        return {
            type: boundedString(entry.type, `mounts[${index}].type`).toLowerCase(),
            source: boundedString(entry.source, `mounts[${index}].source`, { allowEmpty: true }),
            name: boundedString(entry.name, `mounts[${index}].name`, { allowEmpty: true }),
            destination: boundedString(entry.destination, `mounts[${index}].destination`),
            rw: entry.rw,
        };
    }, { nonEmpty: true }).sort((left, right) => left.destination.localeCompare(right.destination));
    const devices = uniqueStructured(value.devices, 'devices', (entry, index) => {
        if (!exactKeys(entry, ['containerPath', 'hostPath', 'permissions'])) {
            throw publicationError(`Outer Box creation tuple has invalid devices[${index}]`);
        }
        return {
            hostPath: boundedString(entry.hostPath, `devices[${index}].hostPath`),
            containerPath: boundedString(entry.containerPath, `devices[${index}].containerPath`),
            permissions: boundedString(entry.permissions, `devices[${index}].permissions`),
        };
    }, { nonEmpty: true }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    if (!exactObject(value.tmpfs) || Object.keys(value.tmpfs).length === 0) {
        throw publicationError('Outer Box creation tuple has invalid tmpfs');
    }
    if (!exactObject(value.env) || Object.keys(value.env).length === 0) {
        throw publicationError('Outer Box creation tuple has invalid env');
    }
    if (!exactKeys(value.security, ['init', 'privileged', 'securityOptions', 'user'])
        || value.security.init !== true
        || value.security.privileged !== false) {
        throw publicationError('Outer Box creation tuple has invalid security');
    }
    if (!Array.isArray(value.dependencies) || value.dependencies.length !== 0) {
        throw publicationError('Outer Box creation tuple dependencies must be exactly []');
    }
    if (value.autoRemove !== false) {
        throw publicationError('Outer Box creation tuple auto-remove must be false');
    }
    const result = {
        ports,
        network: canonicalJson(value.network, 'network'),
        mounts,
        volumes: uniqueStrings(value.volumes, 'volumes', { nonEmpty: true }),
        devices,
        tmpfs: canonicalJson(value.tmpfs, 'tmpfs'),
        env: canonicalJson(value.env, 'env'),
        security: {
            user: boundedString(value.security.user, 'security.user'),
            init: true,
            privileged: false,
            securityOptions: uniqueStrings(value.security.securityOptions, 'security options'),
        },
        // An explicit empty command is a complete immutable choice: it selects
        // the admitted image's entrypoint/Cmd without a mutable host override.
        command: stringList(value.command, 'command'),
        dependencies: [],
        autoRemove: false,
    };
    if (!exactObject(result.network) || Object.keys(result.network).length === 0) {
        throw publicationError('Outer Box creation tuple has invalid network');
    }
    return deepFreeze(result);
}

export function runtimeFromOuterJournal(listRecord, journalRecord) {
    const id = requireFullContainerId(listRecord?.Id ?? listRecord?.ID);
    if (id !== journalRecord?.container?.id) {
        throw publicationError('Outer Box list record ID does not match its journal');
    }
    const creation = normalizeOuterContainerCreationTuple(journalRecord.container.creation);
    const rawImageId = requireFullContainerId(
        journalRecord?.container?.image?.rawId,
        'raw image ID',
    );
    const observedImageId = String(listRecord?.ImageID ?? listRecord?.ImageId ?? '').replace(/^sha256:/, '');
    if (observedImageId !== rawImageId) {
        throw publicationError('Outer Box list record image does not match its journal');
    }
    const state = String(listRecord?.State ?? listRecord?.state ?? '').toLowerCase();
    if (!['configured', 'created', 'exited', 'paused', 'running', 'stopped'].includes(state)) {
        throw publicationError('Outer Box list record has an invalid state');
    }
    return deepFreeze({
        complete: true,
        imageId: rawImageId,
        configuredImage: journalRecord.container.image.reference,
        user: creation.security.user,
        environment: { ...creation.env, HOSTNAME: id.slice(0, 12) },
        createCommand: [...creation.command],
        publications: creation.ports.map((entry) => ({ ...entry })),
        running: state === 'running',
        status: state,
        init: creation.security.init,
        privileged: creation.security.privileged,
        securityOptions: [...creation.security.securityOptions].sort(),
        devices: creation.devices.map((entry) => ({ ...entry })),
        tmpfs: { ...creation.tmpfs },
        mounts: creation.mounts.map((entry) => ({ ...entry })),
        network: creation.network,
        volumes: [...creation.volumes],
        dependencies: [],
        autoRemove: false,
        pid: Number(listRecord?.Pid ?? listRecord?.PID ?? 0),
    });
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
        tmpfs: hostConfig?.Tmpfs
            && typeof hostConfig.Tmpfs === 'object'
            && !Array.isArray(hostConfig.Tmpfs)
            ? Object.fromEntries(Object.entries(hostConfig.Tmpfs)
                .map(([target, options]) => [String(target), String(options)])
                .sort(([left], [right]) => left.localeCompare(right)))
            : null,
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
    expectedMediaHostPort,
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
    hostPort,
    mediaHostPort = BOX_MEDIA_PORT,
    imageId,
    imageRef,
    repositoryRoot,
    hostKind = 'native-linux',
    releaseDescriptor = null,
}) {
    const publication = validateContainerPublications(containerHandle, hostPort, mediaHostPort);
    const runtime = containerHandle.runtime;
    if (containerHandle.id === '' || runtime.imageId !== imageId) {
        throw publicationError('Owned Box image ID does not match the validated immutable image');
    }
    let serializedRelease = null;
    if (releaseDescriptor) {
        serializedRelease = serializeReleaseDescriptor(releaseDescriptor);
        if (imageId !== releaseDescriptor.boxImageId
            || hostPort !== releaseDescriptor.routerHostPort
            || mediaHostPort !== releaseDescriptor.mediaHostPort) {
            throw publicationError('Owned Box release descriptor does not match image or publications');
        }
        let observedRelease;
        try {
            observedRelease = parseReleaseDescriptor(
                containerHandle.labels?.[BOX_LABELS.releaseDescriptor],
                { expectedControllerSourceSha: releaseDescriptor.controllerSourceSha },
            );
        } catch (error) {
            throw publicationError(`Owned Box release descriptor label is incompatible: ${error.message}`);
        }
        if (serializeReleaseDescriptor(observedRelease) !== serializedRelease
            || containerHandle.labels?.[BOX_LABELS.releaseGeneration]
                !== releaseDescriptor.releaseGeneration) {
            throw publicationError('Owned Box release generation label is incompatible');
        }
    }
    if (runtime.user !== 'podman' || runtime.privileged || runtime.init !== true) {
        throw publicationError('Owned Box user, privilege, or init state is incompatible');
    }
    const expectedLabels = {
        [BOX_LABELS.pathHash]: identity.pathHash,
        [BOX_LABELS.role]: 'box',
        [BOX_LABELS.imageRef]: imageRef,
        [BOX_LABELS.routerHostPort]: String(hostPort),
        [BOX_LABELS.mediaHostPort]: String(mediaHostPort),
        ...(releaseDescriptor ? {
            [BOX_LABELS.releaseDescriptor]: serializedRelease,
            [BOX_LABELS.releaseGeneration]: releaseDescriptor.releaseGeneration,
        } : {}),
    };
    const ownershipLabels = Object.fromEntries(Object.entries(containerHandle.labels)
        .filter(([key]) => key.startsWith(BOX_OWNERSHIP_LABEL_PREFIX))
        .sort());
    if (JSON.stringify(ownershipLabels)
        !== JSON.stringify(Object.fromEntries(Object.entries(expectedLabels).sort()))) {
        throw publicationError('Owned Box label set is incompatible');
    }
    const expectedEnvironment = {
        ...IMAGE_CONTRACT.environment,
        PLOINKY_PUBLIC_BIND: '0.0.0.0',
        PLOINKY_PUBLIC_AUTHORITY: `127.0.0.1:${hostPort}`,
        PLOINKY_PRIVATE_BIND: '0.0.0.0',
        ...(releaseDescriptor ? {
            [RELEASE_DESCRIPTOR_ENV]: serializedRelease,
        } : {}),
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
        ...(hostKind === 'podman-machine' ? ['label=disable'] : []),
    ].sort();
    if (!Array.isArray(runtime.securityOptions)
        || JSON.stringify(runtime.securityOptions.map((value) => value.toLowerCase()).sort())
            !== JSON.stringify(expectedSecurityOptions)) {
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
    const expectedTmpfs = {
        '/tmp': 'rw,nosuid,nodev,mode=1777,rprivate,tmpcopyup',
    };
    if (JSON.stringify(runtime.tmpfs) !== JSON.stringify(expectedTmpfs)) {
        throw publicationError('Owned Box tmpfs contract is incompatible');
    }
    const expectedMounts = {
        '/opt/ploinky': { type: 'bind', source: repositoryRoot, rw: false },
        '/workspace': { type: 'volume', name: identity.volumes.workspace, rw: true },
        '/home/podman/.local/share/containers': {
            type: 'volume', name: identity.volumes.containers, rw: true,
        },
        '/opt/ploinky/node_modules': {
            type: 'volume', name: identity.volumes.dependencies, rw: true,
        },
    };
    if (!Array.isArray(runtime.mounts) || runtime.mounts.length !== 4) {
        throw publicationError('Owned Box mount set is incompatible');
    }
    for (const [destination, expected] of Object.entries(expectedMounts)) {
        const observed = runtime.mounts.find((mount) => mount.destination === destination);
        if (!observed
            || observed.type !== expected.type
            || observed.rw !== expected.rw
            || (expected.source && observed.source !== expected.source)
            || (expected.name && observed.name !== expected.name)) {
            throw publicationError(`Owned Box mount ${destination} is incompatible`);
        }
    }
    return Object.freeze({ ...publication, imageId, imageRef });
}
