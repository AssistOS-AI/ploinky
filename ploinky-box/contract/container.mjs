import path from 'node:path';

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
import {
    PUBLIC_ROUTER_HOSTS_ENV,
    parsePublicRouterHosts,
    serializePublicRouterHosts,
} from '../../cli/utils/publicRouterHosts.mjs';
import {
    ROUTER_BIND_LOOPBACK,
    ROUTER_BIND_WILDCARD,
    assertRouterBindingStateConfined,
    normalizeRouterBindAddress,
    normalizeRouterPublication,
    routerBindingPublicAuthority,
} from '../routerBinding.mjs';
import { nestedPodmanSeccompProfileContract } from '../seccomp.mjs';
import {
    agentLibBoxEnv,
    expectedAgentLibMounts,
    normalizeBoxAgentLib,
} from './agentlib.mjs';
import { IMAGE_CONTRACT } from './image.mjs';
import { normalizeImageId } from './image-id.mjs';
import { assertBoxNetworkMode } from './network.mjs';
import {
    assertBoxWorkspaceRoot,
    boxWorkspaceEnvironment,
    boxWorkspaceMount,
} from './workspace-root.mjs';

const BOX_OWNERSHIP_LABEL_PREFIX = 'io.assistos.ploinky-box.';
const INCOMPATIBLE_BOX_GUIDANCE = "; back up any Box-only data, then run 'ploinky stop'"
    + " and 'ploinky destroy' before retrying";
export const BOX_SOURCE_MISMATCH = 'PLOINKY_BOX_SOURCE_MISMATCH';

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
        networkMode: String(hostConfig?.NetworkMode ?? ''),
        user: String(config?.User ?? ''),
        workingDir: String(config?.WorkingDir ?? ''),
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

// A Box runs Ploinky from the checkout that created it: its seccomp profile
// path, labels and read-only source mount all derive from that checkout. A
// command from another checkout never adopts it; it names both checkouts
// before any other comparison so the mismatch is not reported as an opaque
// security-option or mount difference.
export function assertBoxPloinkySource(runtime, repositoryRoot) {
    const sources = Array.isArray(runtime?.mounts)
        ? runtime.mounts.filter((mount) => mount?.destination === '/opt/ploinky').map((mount) => mount.source)
        : [];
    if (sources.length !== 1 || sources[0] === repositoryRoot) return;
    throw new PloinkyBoxError(
        `This workspace's Box runs Ploinky from ${sources[0]}, but this command runs Ploinky from `
        + `${repositoryRoot}. Use ${path.join(sources[0], 'bin', 'ploinky')} for this workspace, or replace `
        + 'the Box from this checkout: back up any Box-only data, then run \'ploinky stop\' and '
        + '\'ploinky destroy\' here before retrying',
        { code: BOX_SOURCE_MISMATCH },
    );
}

/**
 * Reconstruct the public Router binding an owned Box records.
 *
 * A Box without the bind-address label is the loopback publication and
 * must carry no trusted outer-host list. A labelled Box must carry exactly one
 * canonical list, and a specific address must trust itself. Publications are
 * compared separately so labels alone never prove what the engine publishes.
 *
 * @returns {Readonly<{ address: string, hosts: readonly string[]|null }>}
 */
export function observeContainerRouterBinding(containerHandle) {
    const labels = containerHandle?.labels || {};
    const environment = containerHandle?.runtime?.environment || {};
    const hasAddressLabel = Object.hasOwn(labels, BOX_LABELS.routerBindAddress);
    const hasHosts = Object.hasOwn(environment, PUBLIC_ROUTER_HOSTS_ENV);
    if (!hasAddressLabel) {
        if (hasHosts) {
            throw publicationError('Owned Box trusts outer Router hosts without a Router bind address label');
        }
        return Object.freeze({ address: ROUTER_BIND_LOOPBACK, hosts: null });
    }
    let address;
    try {
        address = normalizeRouterBindAddress(labels[BOX_LABELS.routerBindAddress]);
    } catch (_) {
        throw publicationError('Owned Box Router bind address label is invalid');
    }
    if (address === ROUTER_BIND_LOOPBACK) {
        throw publicationError('Owned Box labels a loopback Router binding that must remain unlabelled');
    }
    if (!hasHosts) {
        throw publicationError('Owned Box Router bind address has no trusted outer host list');
    }
    let hosts;
    try {
        hosts = parsePublicRouterHosts(environment[PUBLIC_ROUTER_HOSTS_ENV]);
    } catch (error) {
        throw publicationError(`Owned Box trusted outer Router hosts are invalid: ${error.message}`);
    }
    if (address !== ROUTER_BIND_WILDCARD && !hosts.includes(address)) {
        throw publicationError('Owned Box trusted outer Router hosts do not include its bind address');
    }
    return Object.freeze({ address, hosts });
}

export function validateContainerPublications(
    containerHandle,
    expectedHostPort,
    expectedMediaHostPort = BOX_MEDIA_PORT,
    expectedBinding = null,
) {
    const runtime = containerHandle?.runtime;
    const port = String(expectedHostPort);
    const mediaPort = String(expectedMediaHostPort);
    if (!runtime?.complete || !Array.isArray(runtime.publications) || !runtime.environment) {
        throw publicationError('Owned Box has incomplete runtime publication state');
    }
    const observedBinding = observeContainerRouterBinding(containerHandle);
    let binding = observedBinding;
    if (expectedBinding) {
        try {
            binding = normalizeRouterPublication(expectedBinding);
        } catch (error) {
            throw publicationError(`Expected Router binding is invalid: ${error.message}`);
        }
        if (observedBinding.address !== binding.address
            || JSON.stringify(observedBinding.hosts) !== JSON.stringify(binding.hosts)) {
            throw publicationError(
                'Owned Box Router binding does not match the selected binding: '
                + `observed=${JSON.stringify(observedBinding)} expected=${JSON.stringify(binding)}`,
            );
        }
    }
    const expected = [
        {
            containerPort: String(BOX_ROUTER_CONTAINER_PORT),
            protocol: 'tcp',
            hostIp: binding.address,
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
    let authority = '';
    try {
        authority = routerBindingPublicAuthority({ address: binding.address, hostPort: Number(port) });
    } catch (_) {
        throw publicationError('Owned Box host-port label is not a valid TCP port');
    }
    if (runtime.environment.PLOINKY_PUBLIC_AUTHORITY !== authority) {
        throw publicationError('Owned Box public authority does not match its publication');
    }
    return Object.freeze({
        hostPort: Number(port),
        mediaHostPort: Number(mediaPort),
        address: binding.address,
        hosts: binding.hosts,
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
    routerBinding = null,
    imageId,
    imageRef,
    repositoryRoot,
    hostKind = 'native-linux',
    networkMode,
}) {
    assertRouterBindingStateConfined(identity);
    const workspaceRoot = assertBoxWorkspaceRoot(identity?.workspaceRoot);
    assertBoxPloinkySource(containerHandle?.runtime, repositoryRoot);
    const publication = validateContainerPublications(containerHandle, hostPort, mediaHostPort, routerBinding);
    const runtime = containerHandle.runtime;
    assertBoxNetworkMode(runtime, networkMode);
    const seccompProfile = nestedPodmanSeccompProfileContract(repositoryRoot);
    if (containerHandle.id === '' || runtime.imageId !== imageId) {
        throw publicationError('Owned Box image ID does not match the validated immutable image');
    }
    if (runtime.user !== 'podman' || runtime.privileged || runtime.init !== true) {
        throw publicationError(`Owned Box user, privilege, or init state is incompatible${INCOMPATIBLE_BOX_GUIDANCE}`);
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
    if (publication.address !== ROUTER_BIND_LOOPBACK) {
        expectedLabels[BOX_LABELS.routerBindAddress] = publication.address;
    }
    const selectedFingerprints = dataFingerprints || Object.fromEntries(BOX_DATA_KEYS.map((key) => [
        key,
        String(containerHandle.labels?.[BOX_DATA_FINGERPRINT_LABELS[key]] || ''),
    ]));
    const fingerprintValues = BOX_DATA_KEYS.map((key) => String(selectedFingerprints?.[key] || ''));
    const hasFingerprints = fingerprintValues.some(Boolean);
    if (hasFingerprints && !fingerprintValues.every((value) => /^[a-f0-9]{64}$/.test(value))) {
        throw publicationError(`Owned Box directory fingerprint set is incompatible${INCOMPATIBLE_BOX_GUIDANCE}`);
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
    if (agentLibContract.mode === 'image' && agentLibContract.imageId !== normalizeImageId(imageId)) {
        throw publicationError('Owned Box does not match the selected AgentLib bundle image');
    }
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
        throw publicationError(`Owned Box label set is incompatible${INCOMPATIBLE_BOX_GUIDANCE}`);
    }
    const expectedEnvironment = {
        ...IMAGE_CONTRACT.environment,
        ...boxWorkspaceEnvironment(workspaceRoot),
        ...agentLibBoxEnv(agentLibContract),
        PLOINKY_PUBLIC_BIND: '0.0.0.0',
        PLOINKY_PUBLIC_AUTHORITY: routerBindingPublicAuthority({
            address: publication.address,
            hostPort: publication.hostPort,
        }),
        PLOINKY_PRIVATE_BIND: '0.0.0.0',
        PLOINKY_ROUTER_HEALTH_SOCKET: BOX_ROUTER_HEALTH_SOCKET,
        ...(publication.hosts
            ? { [PUBLIC_ROUTER_HOSTS_ENV]: serializePublicRouterHosts(publication.hosts) }
            : {}),
    };
    const observedEnvironment = { ...runtime.environment };
    const runtimeHostname = observedEnvironment.HOSTNAME;
    delete observedEnvironment.HOSTNAME;
    if (runtimeHostname !== containerHandle.id.slice(0, 12)
        || JSON.stringify(Object.fromEntries(Object.entries(observedEnvironment).sort()))
        !== JSON.stringify(Object.fromEntries(Object.entries(expectedEnvironment).sort()))) {
        throw publicationError(`Owned Box environment allowlist is incompatible${INCOMPATIBLE_BOX_GUIDANCE}`);
    }
    if (runtime.workingDir !== workspaceRoot) {
        throw publicationError(
            `Owned Box working directory is not its workspace root${INCOMPATIBLE_BOX_GUIDANCE}`,
        );
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
        throw publicationError(`Owned Box security options are incompatible${INCOMPATIBLE_BOX_GUIDANCE}`);
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
    // Local AgentLib sources add two read-only binds to the four workspace
    // binds. Image bundles require neither source nor alias binds. The one
    // writable workspace bind is the selected root at its own absolute path.
    // Podman currently reports the /tmp tmpfs through
    // HostConfig.Tmpfs and may additionally expose the same mount in Mounts; no
    // named, anonymous, or unrelated mount is accepted.
    const workspaceMount = boxWorkspaceMount(workspaceRoot);
    const expectedMounts = {
        '/opt/ploinky': { source: repositoryRoot, rw: false },
        [workspaceMount.destination]: { source: workspaceMount.source, rw: workspaceMount.rw },
        [BOX_DATA_MOUNTS.dependencies]: { source: identity.dataPaths.dependencies, rw: true },
        [BOX_DATA_MOUNTS.images]: { source: identity.dataPaths.images, rw: true },
        ...expectedAgentLibMounts(agentLibContract, workspaceRoot),
    };
    if (!Array.isArray(runtime.mounts)) {
        throw publicationError(`Owned Box mount set is incompatible${INCOMPATIBLE_BOX_GUIDANCE}`);
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
        throw publicationError(`Owned Box mount set is incompatible${INCOMPATIBLE_BOX_GUIDANCE}`);
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
