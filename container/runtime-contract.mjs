import {
    formatPortRange,
    intervalsOverlap,
    parseExplicitPublishSpec,
} from './publish-spec.mjs';

export const REQUIRED_RUNTIME_IMAGE =
    'docker.io/assistos/ploinky-box:runtime';
export const RUNTIME_CONTRACT_LABEL =
    'io.assistos.ploinky.runtime-contract';
export const REQUIRED_RUNTIME_CONTRACT = '3';
export const REQUESTED_IMAGE_LABEL =
    'io.assistos.ploinky.requested-image';
export const IDENTITY_SCHEMA_LABEL =
    'io.assistos.ploinky.identity-schema';
export const PATH_HASH_LABEL =
    'io.assistos.ploinky.path-hash';
export const VOLUME_ROLE_LABEL =
    'io.assistos.ploinky.volume-role';
export const PUBLISH_PLAN_VERSION_LABEL =
    'io.assistos.ploinky.publish-plan-version';
export const GENERATED_PUBLISHES_LABEL =
    'io.assistos.ploinky.generated-publishes';
export const EXPLICIT_PUBLISHES_LABEL =
    'io.assistos.ploinky.explicit-publishes';
export const IDENTITY_SCHEMA_VERSION = '1';
export const REQUIRED_PUBLISH_PLAN_VERSION = '2';

export const REQUIRED_IMAGE_USER = 'podman';
export const REQUIRED_IMAGE_WORKDIR = '/workspace';
export const REQUIRED_IMAGE_ENTRYPOINT =
    '/usr/local/bin/ploinky-box-entrypoint';
export const REQUIRED_IMAGE_ENV = Object.freeze({
    USER: 'podman',
    HOME: '/home/podman',
    PLOINKY_WORKSPACE_ROOT: '/workspace',
    PLOINKY_DISABLE_HOST_SANDBOX: '1',
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

const RAW_EXTRA_PUBLISH_SPECS = Symbol('rawExtraPublishSpecs');

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
    const labels = config.Labels || value.Labels || {};
    const rawEntrypoint = config.Entrypoint ?? value.Entrypoint;
    return {
        id: String(value.Id || value.ID || ''),
        labels: { ...(labels || {}) },
        contract: String(labels?.[RUNTIME_CONTRACT_LABEL] || ''),
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
    if (image.contract !== REQUIRED_RUNTIME_CONTRACT) {
        contractFailure(
            imageRef,
            RUNTIME_CONTRACT_LABEL,
            JSON.stringify(REQUIRED_RUNTIME_CONTRACT),
            image.contract,
        );
    }
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
    const routerPublish = publishes.find(item =>
        item.containerPort === '8080' && item.protocol === 'tcp'
    ) || null;
    const rawLabels = value.Config.Labels || {};
    const requestedImage = String(rawLabels[REQUESTED_IMAGE_LABEL] || '');
    return {
        instance: String(value.Name || '').replace(/^\//, ''),
        image: requestedImage,
        requestedImage,
        configuredImage: String(value.Config.Image || value.ImageName || ''),
        imageId: String(value.Image || value.ImageID || ''),
        contract: '',
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
        extraPublishes: publishes.filter(item => item !== routerPublish),
        devices: (value.HostConfig.Devices || []).map(device => ({
            hostPath: device.PathOnHost,
            containerPath: device.PathInContainer,
            permissions: device.CgroupPermissions || 'rwm',
        })),
        capAdds: [...(value.HostConfig.CapAdd || [])],
        securityOpts: [...(value.HostConfig.SecurityOpt || [])],
        env: envMap(value.Config.Env || []),
        // Preserve the complete inspected label set. Reconciliation changes
        // only supervisor-owned keys, while rollback must restore every prior
        // creation label byte-for-byte.
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
        [IDENTITY_SCHEMA_LABEL]: IDENTITY_SCHEMA_VERSION,
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
    for (const [key, value] of Object.entries(expected)) {
        if (String(volume.labels?.[key] ?? '') !== value) {
            const observed = Object.hasOwn(volume.labels || {}, key)
                ? JSON.stringify(String(volume.labels[key]))
                : '<missing>';
            throw new Error(
                `volume '${expectedName}' is foreign/unsupported: ${key} expected ${JSON.stringify(value)}, observed ${observed}`,
            );
        }
    }
    return volume;
}

function normalizePublishSpec(spec) {
    const parsed = parseExplicitPublishSpec(spec);
    return {
        hostIp: parsed.hostIp,
        hostPort: parsed.hostInterval
            ? formatPortRange(parsed.hostInterval)
            : '',
        containerPort: formatPortRange(parsed.containerTarget),
        protocol: parsed.protocol,
    };
}

function publishSpec(record) {
    const protocol = record.protocol === 'tcp' ? '' : '/' + record.protocol;
    if (!String(record.hostPort ?? '').trim()) {
        const host = record.hostIp ? record.hostIp + '::' : '';
        return host + record.containerPort + protocol;
    }
    const host = record.hostIp ? record.hostIp + ':' : '';
    return host + record.hostPort + ':' + record.containerPort + protocol;
}

function publishIdentity(record) {
    return [
        record.hostIp,
        record.hostPort,
        record.containerPort,
        record.protocol,
    ].join('\0');
}

function attachRawExtraPublishSpecs(config, specs = []) {
    const byIdentity = new Map();
    for (const spec of specs) {
        const identity = publishIdentity(normalizePublishSpec(spec));
        if (!byIdentity.has(identity)) byIdentity.set(identity, String(spec));
    }
    Object.defineProperty(config, RAW_EXTRA_PUBLISH_SPECS, {
        configurable: true,
        enumerable: false,
        value: byIdentity,
    });
    return config;
}

function isWildcardHost(hostIp) {
    const normalized = String(hostIp || '').trim().toLowerCase();
    return normalized === '' || normalized === '0.0.0.0' || normalized === '*';
}

function bindScopesConflict(left, right) {
    if (isWildcardHost(left.hostIp) || isWildcardHost(right.hostIp)) return true;
    return String(left.hostIp).trim().toLowerCase()
        === String(right.hostIp).trim().toLowerCase();
}

function describeBind(claim) {
    return isWildcardHost(claim.hostIp)
        ? `wildcard bind ${claim.hostIp || '(engine default)'}`
        : `specific bind ${claim.hostIp}`;
}

function formatInterval(start, end) {
    return start === end ? String(start) : `${start}-${end}`;
}

function isEphemeralHostClaim(parsed) {
    return !parsed.hostInterval
        || (parsed.hostInterval.start === 0 && parsed.hostInterval.end === 0);
}

function normalizedBindScope(hostIp) {
    const value = String(hostIp || '').trim().toLowerCase();
    return ['', '*', '0.0.0.0', '::'].includes(value) ? '*' : value;
}

function atomicPublishBindings(records) {
    const bindings = [];
    for (const record of records || []) {
        const parsed = parseExplicitPublishSpec(publishSpec(record));
        const ephemeral = isEphemeralHostClaim(parsed);
        for (
            let offset = 0;
            offset <= parsed.containerTarget.end - parsed.containerTarget.start;
            offset += 1
        ) {
            bindings.push({
                scope: normalizedBindScope(parsed.hostIp),
                hostPort: ephemeral ? null : parsed.hostInterval.start + offset,
                containerPort: parsed.containerTarget.start + offset,
                protocol: parsed.protocol,
                ephemeral,
            });
        }
    }
    return bindings;
}

function publishesSemanticallyEqual(actual, desired) {
    const remaining = atomicPublishBindings(actual);
    const requested = atomicPublishBindings(desired);
    if (remaining.length !== requested.length) return false;
    for (const expected of requested) {
        const index = remaining.findIndex(observed =>
            observed.scope === expected.scope
            && observed.containerPort === expected.containerPort
            && observed.protocol === expected.protocol
            && (expected.ephemeral || observed.hostPort === expected.hostPort)
        );
        if (index === -1) return false;
        remaining.splice(index, 1);
    }
    return remaining.length === 0;
}

function validateHostSocketClaims(records) {
    const claims = records.map(record => ({
        record,
        parsed: parseExplicitPublishSpec(publishSpec(record)),
    }));
    for (let index = 0; index < claims.length; index += 1) {
        const claim = claims[index];
        for (let prior = 0; prior < index; prior += 1) {
            const existing = claims[prior];
            if (
                isEphemeralHostClaim(existing.parsed)
                || isEphemeralHostClaim(claim.parsed)
                || existing.parsed.protocol !== claim.parsed.protocol
                || !intervalsOverlap(existing.parsed.hostInterval, claim.parsed.hostInterval)
                || !bindScopesConflict(existing.record, claim.record)
            ) continue;
            const overlapStart = Math.max(
                existing.parsed.hostInterval.start,
                claim.parsed.hostInterval.start,
            );
            const overlapEnd = Math.min(
                existing.parsed.hostInterval.end,
                claim.parsed.hostInterval.end,
            );
            throw new Error(
                'overlapping runtime publish host socket '
                + formatInterval(overlapStart, overlapEnd)
                + '/' + claim.parsed.protocol + ': '
                + describeBind(existing.record) + " '"
                + publishSpec(existing.record) + "' conflicts with "
                + describeBind(claim.record) + " '"
                + publishSpec(claim.record) + "'",
            );
        }
    }
}

export function mergeAndValidatePublishes(
    selectedPublishes = [],
    generatedPublishes = [],
) {
    const selected = [];
    const identities = new Set();
    for (const record of selectedPublishes) {
        const normalized = normalizePublishSpec(publishSpec(record));
        const identity = publishIdentity(normalized);
        if (identities.has(identity)) continue;
        identities.add(identity);
        selected.push(normalized);
    }

    const selectedClaims = selected.map(record =>
        parseExplicitPublishSpec(publishSpec(record))
    );
    const result = [...selected];
    for (const record of generatedPublishes) {
        const normalized = normalizePublishSpec(publishSpec(record));
        const generated = parseExplicitPublishSpec(publishSpec(normalized));
        const overlapsSelected = selectedClaims.some(explicit =>
            explicit.protocol === generated.protocol
            && intervalsOverlap(explicit.containerTarget, generated.containerTarget)
        );
        if (overlapsSelected) continue;
        const identity = publishIdentity(normalized);
        if (identities.has(identity)) continue;
        identities.add(identity);
        result.push(normalized);
    }
    validateHostSocketClaims(result);
    return result;
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
    const labels = {
        [REQUESTED_IMAGE_LABEL]: requestedImage,
        [IDENTITY_SCHEMA_LABEL]: IDENTITY_SCHEMA_VERSION,
        [PATH_HASH_LABEL]: String(invocation.pathHash || ''),
    };
    if (invocation._configurationLabels) {
        Object.assign(labels, invocation._configurationLabels);
    }
    const config = {
        instance,
        image: requestedImage,
        requestedImage,
        imageId: '',
        contract: REQUIRED_RUNTIME_CONTRACT,
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
            hostIp: invocation.listenLan ? '0.0.0.0' : '127.0.0.1',
            hostPort: String(invocation.port || '8080'),
            containerPort: '8080',
            protocol: 'tcp',
        },
        extraPublishes: (invocation.publish || []).map(normalizePublishSpec),
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
    return attachRawExtraPublishSpecs(config, invocation.publish || []);
}

export function mergeDesiredRuntimeConfig(
    invocation,
    existing,
    generatedPublishes = [],
) {
    const desired = structuredClone(existing || createDefaultRuntimeConfig(invocation));
    const explicit = invocation.explicit || new Set();

    const selectedImage = explicit.has('--image')
        ? invocation.image
        : existing?.requestedImage || existing?.image || REQUIRED_RUNTIME_IMAGE;
    desired.image = selectedImage;
    desired.requestedImage = selectedImage;
    // Contract 3 is a clean security boundary. Never inherit the privileged
    // or broad seccomp settings from a contract-2 container during replace.
    desired.contract = REQUIRED_RUNTIME_CONTRACT;
    desired.user = REQUIRED_IMAGE_USER;
    desired.privileged = false;
    desired.devices = [
        { hostPath: '/dev/fuse', containerPath: '/dev/fuse', permissions: 'rwm' },
        { hostPath: '/dev/net/tun', containerPath: '/dev/net/tun', permissions: 'rwm' },
    ];
    desired.capAdds = [];
    desired.securityOpts = [
        'unmask=ALL',
        ...(invocation._selinuxEnabled ? ['label=disable'] : []),
    ];
    desired.labels ||= {};
    desired.labels[REQUESTED_IMAGE_LABEL] = selectedImage;
    desired.labels[IDENTITY_SCHEMA_LABEL] = IDENTITY_SCHEMA_VERSION;
    desired.labels[PATH_HASH_LABEL] = String(invocation.pathHash || '');
    if (invocation._configurationLabels) {
        Object.assign(desired.labels, invocation._configurationLabels);
    }

    if (!desired.routerPublish && (explicit.has('--port') || explicit.has('--listen-lan'))) {
        desired.routerPublish = {
            hostIp: invocation.listenLan ? '0.0.0.0' : '127.0.0.1',
            hostPort: String(invocation.port || '8080'),
            containerPort: '8080',
            protocol: 'tcp',
        };
    }
    if (explicit.has('--port')) desired.routerPublish.hostPort = invocation.port;
    if (explicit.has('--listen-lan')) desired.routerPublish.hostIp = '0.0.0.0';
    if (explicit.has('--mount')) {
        const mountDir = invocation.mountDirResolved || invocation.mountDir;
        desired.mountDir = mountDir;
        desired.binds = replaceDestinationBind(
            desired.binds,
            '/workspace/mounted',
            mountDir + ':/workspace/mounted',
        );
    }
    const selectedExplicitPublishes = Array.isArray(invocation._selectedExplicitPublishes)
        ? invocation._selectedExplicitPublishes
        : null;
    if (selectedExplicitPublishes) {
        desired.extraPublishes = selectedExplicitPublishes.map(normalizePublishSpec);
    } else if (explicit.has('--publish') || explicit.has('--expose')) {
        desired.extraPublishes = invocation.publish.map(normalizePublishSpec);
    }
    desired.extraPublishes = mergeAndValidatePublishes(
        desired.extraPublishes,
        generatedPublishes.map(normalizePublishSpec),
    );
    const routerIdentity = desired.routerPublish
        ? publishIdentity(desired.routerPublish)
        : '';
    desired.extraPublishes = desired.extraPublishes.filter(publish =>
        !routerIdentity || publishIdentity(publish) !== routerIdentity
    );
    validateHostSocketClaims([
        desired.routerPublish,
        ...desired.extraPublishes,
    ].filter(Boolean));
    desired.env ||= {};
    desired.env.PLOINKY_RUNTIME_NAME = desired.instance;
    const rawExtraPublishes = selectedExplicitPublishes
        || (!existing || explicit.has('--publish') || explicit.has('--expose')
            ? invocation.publish || []
            : []);
    return attachRawExtraPublishSpecs(desired, rawExtraPublishes);
}

export function diffRuntimeConfig(actual, desired) {
    const fields = [
        'instance', 'image', 'user', 'privileged', 'sourceDir', 'mountDir',
        'binds', 'volumes', 'routerPublish', 'extraPublishes', 'devices',
        'capAdds', 'securityOpts', 'env', 'labels',
    ];
    return fields.filter(field => {
        if (field === 'extraPublishes') {
            return !publishesSemanticallyEqual(actual[field], desired[field]);
        }
        return JSON.stringify(actual[field]) !== JSON.stringify(desired[field]);
    });
}

export function planReconciliation({ existing, desired, contractMatches }) {
    if (!existing) return { action: 'create', reasons: ['missing'] };
    const reasons = diffRuntimeConfig(existing, desired);
    if (!contractMatches) reasons.unshift('runtime-contract');
    if (reasons.length > 0) return { action: 'replace', reasons };
    if (!existing.running) return { action: 'start', reasons: [] };
    return { action: 'reuse', reasons: [] };
}

export function buildRuntimeRunArgs(config, engineOptions = {}) {
    if (config.privileged) {
        throw new Error('runtime contract 3 forbids privileged outer containers');
    }
    if ((config.capAdds || []).length > 0) {
        throw new Error('runtime contract 3 forbids added outer-container capabilities');
    }
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
    const rawExtraPublishes = config[RAW_EXTRA_PUBLISH_SPECS] || new Map();
    const publishes = [
        ...(config.routerPublish
            ? [{ publish: config.routerPublish, rawSpec: '' }]
            : []),
        ...config.extraPublishes.map(publish => ({
            publish,
            rawSpec: rawExtraPublishes.get(publishIdentity(publish)),
        })),
    ];
    for (const { publish, rawSpec } of publishes) {
        args.push('-p', rawSpec || publishSpec(publish));
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
