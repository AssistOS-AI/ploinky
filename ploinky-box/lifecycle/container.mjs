import path from 'node:path';

import {
    BOX_LABELS,
    BOX_MEDIA_PORT,
    BOX_ROUTER_CONTAINER_PORT,
    BOX_ROLES,
    BOX_VOLUME_KEYS,
} from '../constants.mjs';
import {
    normalizeOuterContainerCreationTuple,
    requireFullContainerId,
    validateContainerConfiguration,
} from '../contract/container.mjs';
import { IMAGE_CONTRACT } from '../contract/image.mjs';
import {
    RELEASE_DESCRIPTOR_ENV,
    serializeReleaseDescriptor,
} from '../contract/release.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { BOX_VOLUME_MOUNTS } from '../volumes.mjs';

const READY_MARKER = '/workspace/.ploinky/outer-box-ready';

function lifecycleError(message, code = 'PLOINKY_BOX_LIFECYCLE_FAILED', cause) {
    return new PloinkyBoxError(message, { code, cause });
}

function releaseIdentity(releaseDescriptor) {
    if (!releaseDescriptor) {
        throw lifecycleError(
            'Direct outer Box creation requires one exact local release descriptor; mutable image pull is not source-closed',
            'PLOINKY_BOX_RELEASE_REQUIRED',
        );
    }
    return {
        generation: releaseDescriptor.releaseGeneration,
        descriptor: serializeReleaseDescriptor(releaseDescriptor),
    };
}

export function buildOuterContainerDefinition({
    identity,
    imageId,
    imageRef,
    hostPort,
    mediaHostPort = BOX_MEDIA_PORT,
    repositoryRoot,
    hostKind = 'podman-machine',
    releaseDescriptor,
    containerName = `${identity.instance}-${releaseDescriptor?.releaseGeneration?.slice(0, 12) || 'unreleased'}`,
}) {
    requireFullContainerId(imageId, 'raw image ID');
    const source = path.resolve(repositoryRoot);
    const release = releaseIdentity(releaseDescriptor);
    const labels = {
        [BOX_LABELS.pathHash]: identity.pathHash,
        [BOX_LABELS.role]: BOX_ROLES.container,
        [BOX_LABELS.imageRef]: imageRef,
        [BOX_LABELS.routerHostPort]: String(hostPort),
        [BOX_LABELS.mediaHostPort]: String(mediaHostPort),
        [BOX_LABELS.releaseDescriptor]: release.descriptor,
        [BOX_LABELS.releaseGeneration]: release.generation,
    };
    const mounts = [
        {
            type: 'bind', source, name: '', destination: '/opt/ploinky', rw: false,
        },
        ...BOX_VOLUME_KEYS.map((key) => ({
            type: 'volume',
            source: '',
            name: identity.volumes[key],
            destination: BOX_VOLUME_MOUNTS[key],
            rw: true,
        })),
    ];
    const creation = normalizeOuterContainerCreationTuple({
        ports: [
            {
                containerPort: String(BOX_ROUTER_CONTAINER_PORT),
                protocol: 'tcp',
                hostIp: '127.0.0.1',
                hostPort: String(hostPort),
            },
            {
                containerPort: String(BOX_MEDIA_PORT),
                protocol: 'udp',
                hostIp: '0.0.0.0',
                hostPort: String(mediaHostPort),
            },
        ],
        network: { mode: 'podman', networks: ['podman'] },
        mounts,
        volumes: BOX_VOLUME_KEYS.map((key) => identity.volumes[key]),
        devices: [
            { hostPath: '/dev/fuse', containerPath: '/dev/fuse', permissions: 'rwm' },
            { hostPath: '/dev/net/tun', containerPath: '/dev/net/tun', permissions: 'rwm' },
        ],
        tmpfs: { '/tmp': 'rw,nosuid,nodev,mode=1777,rprivate,tmpcopyup' },
        env: {
            ...IMAGE_CONTRACT.environment,
            PLOINKY_PUBLIC_BIND: '0.0.0.0',
            PLOINKY_PUBLIC_AUTHORITY: `127.0.0.1:${hostPort}`,
            PLOINKY_PRIVATE_BIND: '0.0.0.0',
            [RELEASE_DESCRIPTOR_ENV]: release.descriptor,
        },
        security: {
            user: 'podman',
            init: true,
            privileged: false,
            securityOptions: [
                'unmask=all',
                ...(hostKind === 'podman-machine' ? ['label=disable'] : []),
            ],
        },
        command: [IMAGE_CONTRACT.entrypoint],
        dependencies: [],
        autoRemove: false,
    });
    return Object.freeze({
        name: containerName,
        labels: Object.freeze(labels),
        image: Object.freeze({
            rawId: imageId,
            reference: imageRef,
            releaseIdentity: Object.freeze(release),
        }),
        creation,
    });
}

export function directContainerCreateSpec(definition) {
    const { creation } = definition;
    const bindMounts = creation.mounts.filter((entry) => entry.type === 'bind');
    const namedVolumes = creation.mounts.filter((entry) => entry.type === 'volume');
    return Object.freeze({
        name: definition.name,
        image: definition.image.rawId,
        raw_image_name: definition.image.rawId,
        command: [...creation.command],
        env: { ...creation.env },
        labels: { ...definition.labels },
        user: creation.security.user,
        work_dir: IMAGE_CONTRACT.workdir,
        init: creation.security.init,
        mounts: [
            ...bindMounts.map((entry) => ({
                destination: entry.destination,
                type: 'bind',
                source: entry.source,
                options: entry.rw ? ['rw', 'rbind'] : ['ro', 'rbind'],
            })),
            {
                destination: '/tmp',
                type: 'tmpfs',
                source: 'tmpfs',
                options: creation.tmpfs['/tmp'].split(','),
            },
        ],
        volumes: namedVolumes.map((entry) => ({
            Name: entry.name,
            Dest: entry.destination,
            Options: entry.rw ? ['rw', 'U'] : ['ro'],
            IsAnonymous: false,
            SubPath: '',
        })),
        // SpecGenerator intentionally treats LinuxDevice.Path as the same
        // host:container:permissions string accepted by --device and resolves
        // only that path inside the Podman Machine (v6.0.2
        // generate/config_linux.go DevicesFromPath).  Encoding the complete
        // tuple here avoids silently falling back to default destination or
        // permissions.
        devices: creation.devices.map((entry) => ({
            path: `${entry.hostPath}:${entry.containerPath}:${entry.permissions}`,
        })),
        privileged: false,
        remove: false,
        removeImage: false,
        dependencyContainers: [],
        pod: '',
        image_volume_mode: 'ignore',
        portmappings: creation.ports.map((entry) => ({
            host_ip: entry.hostIp,
            host_port: Number(entry.hostPort),
            container_port: Number(entry.containerPort),
            range: 1,
            protocol: entry.protocol,
        })),
        netns: { nsmode: 'bridge' },
        // SpecGenerator's Networks field has no JSON tag in v6.0.2, so its
        // canonical wire key is capitalized.  Naming the sole default network
        // explicitly prevents containers.conf drift from changing the
        // journaled immutable network tuple.
        Networks: Object.fromEntries(creation.network.networks.map((name) => [name, {}])),
        networkOrder: [...creation.network.networks],
        unmask: ['ALL'],
        selinux_opts: creation.security.securityOptions.includes('label=disable')
            ? ['disable']
            : [],
    });
}

export async function stopPloinkyLocalByContainerId(hostClient, containerId, journal) {
    const id = requireFullContainerId(containerId);
    const result = await hostClient.execContainer({
        id,
        argv: ['/opt/ploinky/bin/ploinky-local', 'stop'],
        user: 'podman',
        workdir: '/workspace',
        env: {},
        journal,
    });
    if (result.exitCode !== 0) {
        throw lifecycleError(`In-box ploinky-local stop failed with status ${result.exitCode}`);
    }
    return result;
}

export async function removeContainerById(hostClient, containerId, journal, { timeout = 30 } = {}) {
    return hostClient.deleteContainer({
        id: requireFullContainerId(containerId),
        timeout,
        journal,
    });
}

function exactRecord(records, id) {
    const matches = records.filter((record) => String(record?.Id ?? record?.ID ?? '') === id);
    if (matches.length > 1) {
        throw lifecycleError('Direct readiness list returned a duplicate exact container ID');
    }
    return matches[0] || null;
}

export async function waitForReadySignal(hostClient, containerId, journal, {
    timeoutMs = 60_000,
    intervalMs = 100,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
    const id = requireFullContainerId(containerId);
    const deadline = Date.now() + timeoutMs;
    let lastDiagnostic = 'the Box-owned ready signal was not yet published';
    while (Date.now() <= deadline) {
        const record = exactRecord(await hostClient.listContainers(), id);
        if (!record) {
            throw lifecycleError('Box disappeared while waiting for its ready signal');
        }
        const state = String(record.State ?? record.state ?? '').toLowerCase();
        if (state !== 'running') {
            if (!['configured', 'created'].includes(state)) {
                throw lifecycleError(`Box exited before readiness (state ${state || 'unknown'})`);
            }
        } else {
            try {
                const result = await hostClient.execContainer({
                    id,
                    argv: [
                        '/bin/bash', '-ceu',
                        `read -r marker_boot < ${READY_MARKER}; read -r marker_pid_start < <(sed -n '2p' ${READY_MARKER}); test "$marker_boot" = "$(cat /proc/sys/kernel/random/boot_id)"; test "$marker_pid_start" = "$(awk '{print $22}' /proc/1/stat)"`,
                    ],
                    user: 'podman',
                    workdir: '/workspace',
                    env: {},
                    timeoutMs: Math.min(5_000, Math.max(1, deadline - Date.now())),
                    maxOutputBytes: 16 * 1024,
                    journal,
                });
                if (result.exitCode === 0) return;
                lastDiagnostic = `ready-signal check exited ${result.exitCode}`;
            } catch (error) {
                lastDiagnostic = error.message;
            }
        }
        if (Date.now() >= deadline) break;
        await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
    throw lifecycleError(
        `Timed out waiting for the Box-owned ready signal: ${lastDiagnostic}`,
        'PLOINKY_BOX_READY_TIMEOUT',
    );
}

export function validateCreatedContainer(ownership, desired) {
    if (ownership?.state !== 'owned' || !ownership.handles?.container) {
        throw lifecycleError('Created Box could not be rediscovered as owned');
    }
    validateContainerConfiguration(ownership.handles.container, desired);
    return ownership.handles.container;
}
