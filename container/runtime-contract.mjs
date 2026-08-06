export const REQUIRED_RUNTIME_IMAGE =
    'docker.io/assistos/ploinky-box:runtime';
export const REQUESTED_IMAGE_LABEL =
    'io.assistos.ploinky.requested-image';
export const PATH_HASH_LABEL =
    'io.assistos.ploinky.path-hash';
export const VOLUME_ROLE_LABEL =
    'io.assistos.ploinky.volume-role';
export const PLOINKY_SOURCE_SHA_LABEL =
    'io.assistos.ploinky.source-sha';
export const PLOINKY_AGENTLIB_SHA_LABEL =
    'io.assistos.ploinky.agentlib-sha';
export const BOX_ROUTER_PORT = 8080;
export const BOX_MEDIA_PORT = 7882;

export const REQUIRED_IMAGE_USER = 'podman';
export const REQUIRED_IMAGE_WORKDIR = '/workspace';
export const REQUIRED_IMAGE_ENTRYPOINT =
    '/usr/local/bin/ploinky-box-entrypoint';
export const REQUIRED_IMAGE_ENV = Object.freeze({
    USER: 'podman',
    HOME: '/home/podman',
    PLOINKY_WORKSPACE_ROOT: '/workspace',
    container: 'oci',
    _CONTAINERS_USERNS_CONFIGURED: '',
    BUILDAH_ISOLATION: 'chroot',
    PATH: '/opt/ploinky/bin:/usr/local/bin:/usr/bin',
});

export const VOLUME_ROLES = Object.freeze({
    workspace: 'workspace',
    containers: 'containers',
    deps: 'ploinky-deps',
});

export function parseSelectedHostPort(value, { source = 'outer runtime host port' } = {}) {
    const validNumber = typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 1
        && value <= 65535;
    const validString = typeof value === 'string'
        && /^[0-9]+$/.test(value)
        && Number(value) >= 1
        && Number(value) <= 65535;
    if (!validNumber && !validString) {
        const rendered = typeof value === 'string' ? JSON.stringify(value) : String(value);
        const error = new Error(`${source} must be an integer number or exact unsigned decimal string in the range 1..65535; received ${rendered}`);
        error.code = 'PLOINKY_HOST_PORT_INVALID';
        throw error;
    }
    return Number(value);
}

function selectedHostPort(invocation, source) {
    return String(parseSelectedHostPort(invocation?.port, { source }));
}

function inspectRecord(raw) {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed[0] : parsed;
}

function isObjectRecord(value) {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value);
}

function envMap(entries = []) {
    if (isObjectRecord(entries)) return { ...entries };
    if (!Array.isArray(entries)) return {};
    return Object.fromEntries(entries.map(entry => {
        const text = String(entry);
        const index = text.indexOf('=');
        return index < 0
            ? [text, '']
            : [text.slice(0, index), text.slice(index + 1)];
    }));
}

function normalizeEntrypoint(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value.map(String) : [String(value)];
}

function normalizeCommand(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value.map(String) : [String(value)];
}

function normalizeImageVolumes(value) {
    if (!isObjectRecord(value)) return {};
    return { ...value };
}

function normalizedPublishes(bindings = {}) {
    const result = [];
    for (const [target, values] of Object.entries(bindings || {})) {
        const [containerPort, protocol = 'tcp'] = target.split('/');
        for (const value of values || []) {
            result.push({
                hostIp: value.HostIp || '0.0.0.0',
                hostPort: String(value.HostPort),
                containerPort,
                protocol,
            });
        }
    }
    return result.sort((a, b) =>
        (a.containerPort + '/' + a.protocol + '/' + a.hostPort)
            .localeCompare(b.containerPort + '/' + b.protocol + '/' + b.hostPort)
    );
}

export function normalizeImageInspect(raw) {
    const value = inspectRecord(raw);
    if (!isObjectRecord(value)) {
        throw new Error('invalid image inspect: missing image record');
    }
    const config = isObjectRecord(value.Config) ? value.Config : {};
    const rawLabels = config.Labels ?? value.Labels;
    const labels = rawLabels === null || rawLabels === undefined
        ? {}
        : isObjectRecord(rawLabels) ? { ...rawLabels } : null;
    const rawEntrypoint = config.Entrypoint ?? value.Entrypoint;
    return {
        id: String(value.Id || value.ID || ''),
        labels,
        user: String(config.User ?? value.User ?? ''),
        env: envMap(config.Env ?? value.Env ?? []),
        workingDir: String(config.WorkingDir ?? value.WorkingDir ?? ''),
        entrypoint: normalizeEntrypoint(rawEntrypoint),
        entrypointShapeValid: Array.isArray(rawEntrypoint),
        command: normalizeCommand(config.Cmd ?? value.Cmd),
        volumes: normalizeImageVolumes(config.Volumes ?? value.Volumes),
    };
}

function contractFailure(imageRef, field, expected, observed) {
    const shown = observed === '' || observed === undefined || observed === null
        ? '<missing>'
        : JSON.stringify(observed);
    throw new Error(
        `Runtime image '${imageRef}' has invalid ${field}; expected ${expected}, observed ${shown}`,
    );
}

export function validateImageContract(image, imageRef) {
    if (!image || typeof image !== 'object') {
        contractFailure(imageRef, 'inspection', 'a complete image record', image);
    }
    if (!String(image.id || '').trim()) {
        contractFailure(imageRef, 'image ID', 'a non-empty local image ID', image.id);
    }
    const labelKeys = isObjectRecord(image.labels) ? Object.keys(image.labels) : [];
    const allowedLabels = new Set([PLOINKY_SOURCE_SHA_LABEL, PLOINKY_AGENTLIB_SHA_LABEL]);
    const sourceSha = String(image.labels?.[PLOINKY_SOURCE_SHA_LABEL] ?? '');
    const rawAgentlibSha = image.labels?.[PLOINKY_AGENTLIB_SHA_LABEL];
    const agentlibSha = String(rawAgentlibSha ?? '');
    const exactLabels = labelKeys.length >= 1
        && labelKeys.every((key) => allowedLabels.has(key));
    const validAgentlibSha = rawAgentlibSha === undefined
        || /^[0-9a-f]{40}$/.test(agentlibSha);
    if (!exactLabels || !/^[0-9a-f]{40}$/.test(sourceSha) || !validAgentlibSha) {
        contractFailure(
            imageRef,
            'Config.Labels',
            `${PLOINKY_SOURCE_SHA_LABEL}=<40 lowercase hexadecimal Ploinky commit>`
                + ` and optional ${PLOINKY_AGENTLIB_SHA_LABEL}=<40 lowercase hexadecimal AgentLib commit>`,
            image.labels,
        );
    }
    image.sourceSha = sourceSha;
    image.agentlibSha = agentlibSha;
    if (image.user !== REQUIRED_IMAGE_USER) {
        contractFailure(imageRef, 'Config.User', JSON.stringify(REQUIRED_IMAGE_USER), image.user);
    }
    for (const [key, expected] of Object.entries(REQUIRED_IMAGE_ENV)) {
        if (!Object.hasOwn(image.env || {}, key) || image.env[key] !== expected) {
            contractFailure(
                imageRef,
                `Config.Env ${key}`,
                JSON.stringify(`${key}=${expected}`),
                Object.hasOwn(image.env || {}, key) ? `${key}=${image.env[key]}` : '',
            );
        }
    }
    const unexpectedEnv = Object.keys(image.env || {})
        .filter(key => !Object.hasOwn(REQUIRED_IMAGE_ENV, key));
    if (unexpectedEnv.length > 0) {
        contractFailure(
            imageRef,
            'Config.Env',
            `exactly ${JSON.stringify(Object.entries(REQUIRED_IMAGE_ENV).map(([key, value]) => `${key}=${value}`))}`,
            Object.entries(image.env).map(([key, value]) => `${key}=${value}`),
        );
    }
    if (image.workingDir !== REQUIRED_IMAGE_WORKDIR) {
        contractFailure(
            imageRef,
            'Config.WorkingDir',
            JSON.stringify(REQUIRED_IMAGE_WORKDIR),
            image.workingDir,
        );
    }
    if (
        image.entrypointShapeValid !== true
        || image.entrypoint.length !== 1
        || image.entrypoint[0] !== REQUIRED_IMAGE_ENTRYPOINT
    ) {
        contractFailure(
            imageRef,
            'Config.Entrypoint',
            JSON.stringify([REQUIRED_IMAGE_ENTRYPOINT]),
            image.entrypoint,
        );
    }
    if (image.command.length !== 0) {
        contractFailure(imageRef, 'Config.Cmd', 'absent or empty', image.command);
    }
    if (Object.keys(image.volumes || {}).length !== 0) {
        contractFailure(imageRef, 'Config.Volumes', 'absent or empty', image.volumes);
    }
    return image;
}

export function normalizeContainerInspect(engine, raw) {
    const value = inspectRecord(raw);
    const hasIdentity = isObjectRecord(value)
        && [value.Id, value.ID, value.Name].some(entry =>
            typeof entry === 'string' && entry.trim() !== ''
        );
    if (!hasIdentity) {
        throw new Error('invalid container inspect: missing identifying record');
    }
    const hasCompleteShape = isObjectRecord(value.Config)
        && isObjectRecord(value.State)
        && typeof value.State.Status === 'string'
        && value.State.Status.trim() !== ''
        && isObjectRecord(value.HostConfig)
        && Array.isArray(value.Mounts);
    if (!hasCompleteShape) {
        throw new Error('invalid container inspect: malformed full record');
    }

    const mounts = value.Mounts;
    const publishes = normalizedPublishes(value.HostConfig.PortBindings);
    const namedDestinations = new Set([
        '/workspace',
        '/home/podman/.local/share/containers',
        '/opt/ploinky/node_modules',
    ]);
    const byDestination = destination =>
        mounts.find(mount => mount.Destination === destination);
    const routerPublishes = publishes.filter(item =>
        item.containerPort === '8080' && item.protocol === 'tcp'
    );
    const udpReservations = publishes.filter(item =>
        item.containerPort === String(BOX_MEDIA_PORT) && item.protocol === 'udp'
    );
    const routerPublish = routerPublishes.length === 1 ? routerPublishes[0] : null;
    const udpReservation = udpReservations.length === 1 ? udpReservations[0] : null;
    const rawLabels = value.Config.Labels || {};
    const requestedImage = String(rawLabels[REQUESTED_IMAGE_LABEL] || '');
    const createCommand = Array.isArray(value.Config.CreateCommand)
        ? value.Config.CreateCommand.map(String)
        : [];
    const requestedDevices = [];
    for (let index = 0; index < createCommand.length; index += 1) {
        let spec = '';
        if (createCommand[index] === '--device') spec = createCommand[index + 1] || '';
        else if (createCommand[index].startsWith('--device=')) spec = createCommand[index].slice(9);
        if (!spec) continue;
        const [hostPath, containerPath = hostPath, permissions = 'rwm'] = spec.split(':');
        requestedDevices.push({ hostPath, containerPath, permissions });
    }
    const normalizeDevices = devices => devices.map(device => ({
        hostPath: device.hostPath ?? device.PathOnHost,
        containerPath: device.containerPath ?? device.PathInContainer,
        permissions: device.permissions ?? device.CgroupPermissions ?? 'rwm',
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const observedDevices = (value.HostConfig.Devices || []).map(device => ({
        hostPath: device.PathOnHost,
        containerPath: device.PathInContainer,
        permissions: device.CgroupPermissions || 'rwm',
    }));
    const normalizeSecurityOpts = values => values.map(option => (
        String(option).toLowerCase() === 'unmask=all' ? 'unmask=ALL' : String(option)
    )).sort();
    return {
        instance: String(value.Name || '').replace(/^\//, ''),
        image: requestedImage,
        requestedImage,
        configuredImage: String(value.Config.Image || value.ImageName || ''),
        imageId: String(value.Image || value.ImageID || ''),
        state: value.State.Status.trim(),
        running: value.State.Status.trim() === 'running'
            || value.State.Running === true,
        user: String(value.Config.User || ''),
        privileged: Boolean(value.HostConfig.Privileged),
        sourceDir: byDestination('/opt/ploinky')?.Source || '',
        mountDir: byDestination('/workspace/mounted')?.Source || '',
        binds: (value.HostConfig.Binds || [])
            .filter(bind => !namedDestinations.has(String(bind).split(':')[1])),
        volumes: {
            workspace: byDestination('/workspace')?.Name || '',
            containers: byDestination('/home/podman/.local/share/containers')?.Name || '',
            deps: byDestination('/opt/ploinky/node_modules')?.Name || '',
        },
        routerPublish,
        udpReservation,
        observedPublishes: publishes,
        devices: normalizeDevices(observedDevices.length > 0 ? observedDevices : requestedDevices),
        capAdds: [...(value.HostConfig.CapAdd || [])],
        securityOpts: normalizeSecurityOpts(value.HostConfig.SecurityOpt || []),
        env: envMap(value.Config.Env || []),
        // Preserve the complete inspected label set so reconciliation can
        // identify drift without reconstructing an existing container.
        labels: { ...rawLabels },
        allLabels: { ...rawLabels },
    };
}

export function runtimeInstanceName(invocation) {
    return invocation.instance || `ploinky-box-${invocation.name || ''}`;
}

export function runtimeVolumeNames(instance) {
    return {
        workspace: `${instance}-workspace`,
        containers: `${instance}-containers`,
        deps: `${instance}-ploinky-deps`,
    };
}

export function expectedVolumeLabels(invocation, roleKey) {
    const role = VOLUME_ROLES[roleKey];
    if (!role) throw new Error(`unknown Ploinky volume role '${roleKey}'`);
    return {
        [PATH_HASH_LABEL]: String(invocation.pathHash || ''),
        [VOLUME_ROLE_LABEL]: role,
    };
}

export function buildVolumeCreateArgs(invocation, roleKey, name) {
    const labels = expectedVolumeLabels(invocation, roleKey);
    const args = ['volume', 'create'];
    for (const [key, value] of Object.entries(labels)) {
        args.push('--label', `${key}=${value}`);
    }
    args.push(name);
    return args;
}

export function normalizeVolumeInspect(raw) {
    const value = inspectRecord(raw);
    if (!isObjectRecord(value) || !String(value.Name || value.name || '').trim()) {
        throw new Error('invalid volume inspect: missing identifying record');
    }
    return {
        name: String(value.Name || value.name),
        labels: { ...(value.Labels || value.labels || {}) },
    };
}

export function validateVolumeOwnership(volume, invocation, roleKey, expectedName) {
    if (volume.name !== expectedName) {
        throw new Error(
            `volume '${expectedName}' inspection returned unexpected name '${volume.name}'`,
        );
    }
    const expected = expectedVolumeLabels(invocation, roleKey);
    const observed = Object.fromEntries(Object.entries(volume.labels || {}).sort());
    const wanted = Object.fromEntries(Object.entries(expected).sort());
    if (JSON.stringify(observed) !== JSON.stringify(wanted)) {
        throw new Error(
            `volume '${expectedName}' is foreign/unsupported: labels expected `
            + `${JSON.stringify(wanted)}, observed ${JSON.stringify(observed)}`,
        );
    }
    return volume;
}

function publishSpec(record) {
    const protocol = '/' + record.protocol;
    const host = record.hostIp ? record.hostIp + ':' : '';
    return host + record.hostPort + ':' + record.containerPort + protocol;
}

function replaceDestinationBind(binds, destination, replacement) {
    return [
        ...binds.filter(bind => String(bind).split(':')[1] !== destination),
        replacement,
    ];
}

export function createDefaultRuntimeConfig(invocation) {
    const instance = runtimeInstanceName(invocation);
    const volumes = runtimeVolumeNames(instance);
    const sourceDir = invocation.sourceDirResolved;
    const mountDir = invocation.mountDirResolved || '';
    const requestedImage = invocation.image || REQUIRED_RUNTIME_IMAGE;
    const hostPort = selectedHostPort(invocation, 'outer runtime host port');
    const labels = {
        [REQUESTED_IMAGE_LABEL]: requestedImage,
        [PATH_HASH_LABEL]: String(invocation.pathHash || ''),
    };
    const config = {
        instance,
        image: requestedImage,
        requestedImage,
        imageId: '',
        state: '',
        running: false,
        user: 'podman',
        privileged: false,
        sourceDir,
        mountDir,
        binds: [
            sourceDir + ':/opt/ploinky:ro',
            ...(mountDir ? [mountDir + ':/workspace/mounted'] : []),
        ],
        volumes,
        routerPublish: {
            hostIp: '127.0.0.1',
            hostPort,
            containerPort: String(BOX_ROUTER_PORT),
            protocol: 'tcp',
        },
        udpReservation: {
            hostIp: '0.0.0.0',
            hostPort: String(BOX_MEDIA_PORT),
            containerPort: String(BOX_MEDIA_PORT),
            protocol: 'udp',
        },
        devices: [
            {
                hostPath: '/dev/fuse',
                containerPath: '/dev/fuse',
                permissions: 'rwm',
            },
            {
                hostPath: '/dev/net/tun',
                containerPath: '/dev/net/tun',
                permissions: 'rwm',
            },
        ],
        capAdds: [],
        securityOpts: ['unmask=ALL'],
        env: {
            PLOINKY_RUNTIME_NAME: instance,
        },
        labels,
    };
    return config;
}

export function mergeDesiredRuntimeConfig(invocation, existing) {
    const desired = structuredClone(existing || createDefaultRuntimeConfig(invocation));
    const explicit = invocation.explicit || new Set();
    const hostPort = selectedHostPort(invocation, 'selected outer runtime host port');

    const selectedImage = explicit.has('--image')
        ? invocation.image
        : existing?.requestedImage || existing?.image || REQUIRED_RUNTIME_IMAGE;
    desired.image = selectedImage;
    desired.requestedImage = selectedImage;
    // The managed Box is a clean security boundary. Never treat privileged or broad
    // seccomp settings from an inspected container as desired configuration.
    desired.user = REQUIRED_IMAGE_USER;
    desired.privileged = false;
    desired.devices = [
        { hostPath: '/dev/fuse', containerPath: '/dev/fuse', permissions: 'rwm' },
        { hostPath: '/dev/net/tun', containerPath: '/dev/net/tun', permissions: 'rwm' },
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    desired.capAdds = [];
    desired.securityOpts = [
        'unmask=ALL',
        ...(invocation._selinuxEnabled ? ['label=disable'] : []),
    ].sort();
    desired.labels = {
        [REQUESTED_IMAGE_LABEL]: selectedImage,
        [PATH_HASH_LABEL]: String(invocation.pathHash || ''),
    };
    desired.routerPublish = {
        hostIp: '127.0.0.1',
        hostPort: explicit.has('--port')
            ? hostPort
            : String(existing?.routerPublish?.hostPort || hostPort),
        containerPort: String(BOX_ROUTER_PORT),
        protocol: 'tcp',
    };
    desired.udpReservation = {
        hostIp: '0.0.0.0',
        hostPort: String(BOX_MEDIA_PORT),
        containerPort: String(BOX_MEDIA_PORT),
        protocol: 'udp',
    };
    if (explicit.has('--mount')) {
        const mountDir = invocation.mountDirResolved || invocation.mountDir;
        desired.mountDir = mountDir;
        desired.binds = replaceDestinationBind(
            desired.binds,
            '/workspace/mounted',
            mountDir + ':/workspace/mounted',
        );
    }
    // Engine inspection evidence is validation-only. It must not become part
    // of desired configuration when checking whether explicit options drift.
    delete desired.observedPublishes;
    desired.env ||= {};
    desired.env.PLOINKY_RUNTIME_NAME = desired.instance;
    return desired;
}

export function diffRuntimeConfig(actual, desired) {
    const fields = [
        'instance', 'image', 'user', 'privileged', 'sourceDir', 'mountDir',
        'binds', 'volumes', 'routerPublish', 'udpReservation', 'devices',
        'capAdds', 'securityOpts', 'env', 'labels',
    ];
    return fields.filter(field =>
        JSON.stringify(actual[field]) !== JSON.stringify(desired[field])
    );
}

export function planReconciliation({ existing, desired }) {
    if (!existing) return { action: 'create', reasons: ['missing'] };
    const reasons = diffRuntimeConfig(existing, desired);
    if (reasons.length > 0) return { action: 'recreate-required', reasons };
    if (!existing.running) return { action: 'start', reasons: [] };
    return { action: 'reuse', reasons: [] };
}

export function buildRuntimeRunArgs(config, engineOptions = {}) {
    if (config.privileged) {
        throw new Error('managed Box configuration forbids privileged outer containers');
    }
    if ((config.capAdds || []).length > 0) {
        throw new Error('managed Box configuration forbids added outer-container capabilities');
    }
    assertFixedRuntimePublications(config);
    const args = ['run', '-d', '--init', '--name', config.instance];
    if (config.user) args.push('--user', config.user);
    for (const [key, value] of Object.entries(config.labels || {})) {
        args.push('--label', `${key}=${value}`);
    }
    for (const device of config.devices) {
        args.push(
            '--device',
            `${device.hostPath}:${device.containerPath}:${device.permissions}`,
        );
    }
    for (const option of config.securityOpts) args.push('--security-opt', option);
    if (engineOptions.selinux && !config.securityOpts.includes('label=disable')) {
        args.push('--security-opt', 'label=disable');
    }
    for (const publish of [config.routerPublish, config.udpReservation]) {
        args.push('-p', publishSpec(publish));
    }
    args.push(
        '-v', `${config.volumes.workspace}:/workspace`,
        '-v', `${config.volumes.containers}:/home/podman/.local/share/containers`,
        '-v', `${config.volumes.deps}:/opt/ploinky/node_modules`
            + (engineOptions.engine === 'podman' ? ':U' : ''),
    );
    const binds = config.binds.length > 0
        ? config.binds
        : [
            `${config.sourceDir}:/opt/ploinky:ro`,
            ...(config.mountDir
                ? [`${config.mountDir}:/workspace/mounted`]
                : []),
        ];
    for (const bind of binds) args.push('-v', bind);
    for (const [key, value] of Object.entries(config.env || {})) {
        args.push('-e', `${key}=${value}`);
    }
    args.push(config.imageId || config.image);
    return args;
}

export function assertFixedRuntimePublications(config) {
    const router = config?.routerPublish;
    const media = config?.udpReservation;
    const routerPort = String(parseSelectedHostPort(router?.hostPort, {
        source: 'managed Box router host port',
    }));
    const expectedRouter = {
        hostIp: '127.0.0.1',
        hostPort: routerPort,
        containerPort: String(BOX_ROUTER_PORT),
        protocol: 'tcp',
    };
    const expectedMedia = {
        hostIp: '0.0.0.0',
        hostPort: String(BOX_MEDIA_PORT),
        containerPort: String(BOX_MEDIA_PORT),
        protocol: 'udp',
    };
    if (JSON.stringify(router) !== JSON.stringify(expectedRouter)) {
        throw new Error(
            `managed Box configuration requires ${publishSpec(expectedRouter)} as its only TCP publication`,
        );
    }
    if (JSON.stringify(media) !== JSON.stringify(expectedMedia)) {
        throw new Error(
            `managed Box configuration requires ${publishSpec(expectedMedia)} as its fixed UDP reservation`,
        );
    }
    if (Object.hasOwn(config || {}, 'observedPublishes')) {
        const expectedObserved = normalizedPublishes({
            [`${BOX_ROUTER_PORT}/tcp`]: [{
                HostIp: expectedRouter.hostIp,
                HostPort: expectedRouter.hostPort,
            }],
            [`${BOX_MEDIA_PORT}/udp`]: [{
                HostIp: expectedMedia.hostIp,
                HostPort: expectedMedia.hostPort,
            }],
        });
        if (JSON.stringify(config.observedPublishes) !== JSON.stringify(expectedObserved)) {
            throw new Error(
                'managed Box configuration requires exactly two outer publications; observed '
                + JSON.stringify(config.observedPublishes),
            );
        }
    }
    return [expectedRouter, expectedMedia];
}
