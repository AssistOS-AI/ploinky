import {
    formatPortRange,
    intervalsOverlap,
    parseExplicitPublishSpec,
} from './publish-spec.mjs';

export const REQUIRED_RUNTIME_IMAGE =
    'docker.io/assistos/ploinky-box:podman-node24-runtime-v1';
export const RUNTIME_CONTRACT_LABEL =
    'io.assistos.ploinky.runtime-contract';
export const REQUIRED_RUNTIME_CONTRACT = '1';
export const LEGACY_RUNTIME_IMAGES = new Set([
    'docker.io/assistos/ploinky-box:podman-node24',
    'assistos/ploinky-box:podman-node24',
]);

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
    return Object.fromEntries(entries.map(entry => {
        const index = entry.indexOf('=');
        return index < 0
            ? [entry, '']
            : [entry.slice(0, index), entry.slice(index + 1)];
    }));
}

function normalizedPublishes(bindings = {}) {
    const result = [];
    for (const [target, values] of Object.entries(bindings)) {
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
    const labels = value?.Config?.Labels || value?.Labels || {};
    return {
        id: value?.Id || value?.ID || '',
        labels,
        contract: String(labels[RUNTIME_CONTRACT_LABEL] || ''),
    };
}

export function validateImageContract(image, imageRef) {
    if (image.contract === REQUIRED_RUNTIME_CONTRACT) return;
    const observed = image.contract || '<missing>';
    throw new Error(
        "Runtime image '" + imageRef + "' requires "
        + RUNTIME_CONTRACT_LABEL + '=' + REQUIRED_RUNTIME_CONTRACT
        + '; observed ' + observed,
    );
}

export function normalizeContainerInspect(engine, raw) {
    const value = inspectRecord(raw);
    const hasIdentity = isObjectRecord(value)
        && [value.Id, value.ID, value.Name].some(entry =>
            typeof entry === 'string' && entry.trim() !== ''
        );
    if (!hasIdentity) {
        throw new Error(
            'invalid container inspect: missing identifying record',
        );
    }
    const hasCompleteShape = isObjectRecord(value.Config)
        && isObjectRecord(value.State)
        && typeof value.State.Status === 'string'
        && value.State.Status.trim() !== ''
        && isObjectRecord(value.HostConfig)
        && Array.isArray(value.Mounts);
    if (!hasCompleteShape) {
        throw new Error(
            'invalid container inspect: malformed full record',
        );
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
    return {
        instance: String(value?.Name || '').replace(/^\//, ''),
        image: value?.Config?.Image || value?.ImageName || '',
        imageId: value?.Image || value?.ImageID || '',
        contract: '',
        state: value.State.Status.trim(),
        running: value.State.Status.trim() === 'running'
            || value.State.Running === true,
        user: value?.Config?.User || '',
        privileged: Boolean(value?.HostConfig?.Privileged),
        sourceDir: byDestination('/opt/ploinky')?.Source || '',
        mountDir: byDestination('/workspace/mounted')?.Source || '',
        binds: (value?.HostConfig?.Binds || [])
            .filter(bind => !namedDestinations.has(bind.split(':')[1])),
        volumes: {
            workspace: byDestination('/workspace')?.Name || '',
            containers: byDestination('/home/podman/.local/share/containers')?.Name || '',
            deps: byDestination('/opt/ploinky/node_modules')?.Name || '',
        },
        routerPublish,
        extraPublishes: publishes.filter(item => item !== routerPublish),
        devices: (value?.HostConfig?.Devices || []).map(device => ({
            hostPath: device.PathOnHost,
            containerPath: device.PathInContainer,
            permissions: device.CgroupPermissions || 'rwm',
        })),
        securityOpts: [...(value?.HostConfig?.SecurityOpt || [])],
        env: envMap(value?.Config?.Env || []),
    };
}

function runtimeInstanceName(invocation) {
    return `ploinky-box-${invocation.name}`;
}

function runtimeVolumeNames(instance) {
    return {
        workspace: `${instance}-workspace`,
        containers: `${instance}-containers`,
        deps: `${instance}-ploinky-deps`,
    };
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
        if (!byIdentity.has(identity)) {
            byIdentity.set(identity, String(spec));
        }
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
    return normalized === ''
        || normalized === '0.0.0.0'
        || normalized === '*';
}

function bindScopesConflict(left, right) {
    if (isWildcardHost(left.hostIp) || isWildcardHost(right.hostIp)) {
        return true;
    }
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
        || (
            parsed.hostInterval.start === 0
            && parsed.hostInterval.end === 0
        );
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
                || !intervalsOverlap(
                    existing.parsed.hostInterval,
                    claim.parsed.hostInterval,
                )
                || !bindScopesConflict(existing.record, claim.record)
            ) {
                continue;
            }
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
        ...binds.filter(bind => bind.split(':')[1] !== destination),
        replacement,
    ];
}

export function createDefaultRuntimeConfig(invocation) {
    const instance = runtimeInstanceName(invocation);
    const volumes = runtimeVolumeNames(instance);
    const sourceDir = invocation.sourceDirResolved;
    const mountDir = invocation.mountDirResolved || '';
    const config = {
        instance,
        image: invocation.image || REQUIRED_RUNTIME_IMAGE,
        imageId: '',
        contract: REQUIRED_RUNTIME_CONTRACT,
        state: '',
        running: false,
        user: 'podman',
        privileged: true,
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
        securityOpts: ['seccomp=unconfined'],
        env: {
            PLOINKY_WORKSPACE_ROOT: '/workspace',
            PLOINKY_RUNTIME_NAME: instance,
        },
    };
    return attachRawExtraPublishSpecs(config, invocation.publish || []);
}

export function mergeDesiredRuntimeConfig(
    invocation,
    existing,
    generatedPublishes = [],
) {
    const desired = structuredClone(
        existing || createDefaultRuntimeConfig(invocation),
    );
    const explicit = invocation.explicit || new Set();

    desired.image = explicit.has('--image')
        ? invocation.image
        : existing && !LEGACY_RUNTIME_IMAGES.has(existing.image)
            ? existing.image
            : REQUIRED_RUNTIME_IMAGE;

    if (
        !desired.routerPublish
        && (explicit.has('--port') || explicit.has('--listen-lan'))
    ) {
        desired.routerPublish = {
            hostIp: invocation.listenLan ? '0.0.0.0' : '127.0.0.1',
            hostPort: String(invocation.port || '8080'),
            containerPort: '8080',
            protocol: 'tcp',
        };
    }
    if (explicit.has('--port')) {
        desired.routerPublish.hostPort = invocation.port;
    }
    if (explicit.has('--listen-lan')) {
        desired.routerPublish.hostIp = '0.0.0.0';
    }
    if (explicit.has('--mount')) {
        const mountDir = invocation.mountDirResolved || invocation.mountDir;
        desired.mountDir = mountDir;
        desired.binds = replaceDestinationBind(
            desired.binds,
            '/workspace/mounted',
            mountDir + ':/workspace/mounted',
        );
    }
    if (explicit.has('--publish') || explicit.has('--expose')) {
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
    desired.env.PLOINKY_WORKSPACE_ROOT = '/workspace';
    desired.env.PLOINKY_RUNTIME_NAME = desired.instance;
    const rawExtraPublishes = !existing
        || explicit.has('--publish')
        || explicit.has('--expose')
        ? invocation.publish || []
        : [];
    return attachRawExtraPublishSpecs(desired, rawExtraPublishes);
}

export function diffRuntimeConfig(actual, desired) {
    const fields = [
        'instance', 'image', 'user', 'privileged', 'sourceDir', 'mountDir',
        'binds', 'volumes', 'routerPublish', 'extraPublishes', 'devices',
        'securityOpts', 'env',
    ];
    return fields.filter(field =>
        JSON.stringify(actual[field]) !== JSON.stringify(desired[field])
    );
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
    const args = ['run', '-d', '--init', '--name', config.instance];
    if (config.privileged) args.push('--privileged');
    if (config.user) args.push('--user', config.user);
    for (const device of config.devices) {
        args.push(
            '--device',
            device.hostPath + ':' + device.containerPath + ':'
                + device.permissions,
        );
    }
    for (const option of config.securityOpts) {
        args.push('--security-opt', option);
    }
    if (
        engineOptions.selinux
        && !config.securityOpts.includes('label=disable')
    ) {
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
        args.push(
            '-p',
            rawSpec || publishSpec(publish),
        );
    }
    args.push(
        '-v', config.volumes.workspace + ':/workspace',
        '-v', config.volumes.containers
            + ':/home/podman/.local/share/containers',
        '-v', config.volumes.deps + ':/opt/ploinky/node_modules'
            + (engineOptions.engine === 'podman' ? ':U' : ''),
    );
    const binds = config.binds.length > 0
        ? config.binds
        : [
            config.sourceDir + ':/opt/ploinky:ro',
            ...(config.mountDir
                ? [config.mountDir + ':/workspace/mounted']
                : []),
        ];
    for (const bind of binds) {
        args.push('-v', bind);
    }
    for (const [key, value] of Object.entries(config.env)) {
        args.push('-e', key + '=' + value);
    }
    args.push(config.image);
    return args;
}
