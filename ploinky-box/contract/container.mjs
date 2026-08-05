import {
    BOX_LABELS,
    BOX_MEDIA_PORT,
    BOX_ROUTER_CONTAINER_PORT,
} from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { IMAGE_CONTRACT } from './image.mjs';

const BOX_OWNERSHIP_LABEL_PREFIX = 'io.assistos.ploinky-box.';

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
}) {
    const publication = validateContainerPublications(containerHandle, hostPort, mediaHostPort);
    const runtime = containerHandle.runtime;
    if (containerHandle.id === '' || runtime.imageId !== imageId) {
        throw publicationError('Owned Box image ID does not match the validated immutable image');
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
