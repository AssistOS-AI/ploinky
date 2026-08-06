import { isDeepStrictEqual } from 'node:util';

import {
    BOX_LABELS,
    BOX_ROLES,
} from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { sha256 } from '../boundary/fingerprint.mjs';
import { createProcessRunner } from '../process.mjs';
import { normalizeContainerRuntime } from '../contract/container.mjs';

const ABSENT_PATTERN = /(?:no such|not found|does not exist|no volume with name)/i;

function discoveryError(message, code = 'PLOINKY_BOX_DISCOVERY_FAILED') {
    return new PloinkyBoxError(message, { code });
}

function query(runner, engine, args) {
    return runner.query(engine, args);
}

function parseJsonRecords(text) {
    const source = String(text || '').trim();
    if (!source) {
        return [];
    }
    try {
        const parsed = JSON.parse(source);
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        return source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    }
}

function nestedValue(value, paths) {
    for (const parts of paths) {
        let current = value;
        for (const part of parts) {
            if (current === null || typeof current !== 'object') {
                current = undefined;
                break;
            }
            current = current[part];
        }
        if (current !== undefined) {
            return current;
        }
    }
    return undefined;
}

function engineIdentity(name, info) {
    const stableFields = name === 'podman'
        ? [
            nestedValue(info, [['host', 'id'], ['Host', 'ID']]),
            nestedValue(info, [['store', 'graphRoot'], ['Store', 'GraphRoot']]),
            nestedValue(info, [['store', 'runRoot'], ['Store', 'RunRoot']]),
            nestedValue(info, [['version', 'APIVersion'], ['Version', 'APIVersion']]),
        ]
        : [info.ID, info.DockerRootDir, info.ServerVersion, info.OSType];
    return sha256(Buffer.from(JSON.stringify([name, ...stableFields])));
}

function probeEngine(name, runner) {
    const result = query(runner, name, ['info', '--format', 'json']);
    if (!result.ok) {
        if (result.error?.code === 'ENOENT') {
            return { name, state: 'absent' };
        }
        return {
            name,
            state: 'unknown',
            message: `${name} is installed or selected but its engine is unreachable`,
        };
    }
    let info;
    try {
        const records = parseJsonRecords(result.stdout);
        info = records[0];
        if (!info || typeof info !== 'object') {
            throw new Error('missing info record');
        }
    } catch {
        return {
            name,
            state: 'unknown',
            message: `${name} returned malformed engine information`,
        };
    }
    return {
        name,
        state: 'reachable',
        identity: engineIdentity(name, info),
        info,
    };
}

function podmanRootless(info) {
    return nestedValue(info, [
        ['host', 'security', 'rootless'],
        ['Host', 'Security', 'Rootless'],
        ['host', 'rootless'],
        ['Host', 'Rootless'],
    ]) === true;
}

function podmanHostOs(info) {
    return String(nestedValue(info, [
        ['host', 'os'],
        ['Host', 'OS'],
        ['version', 'Os'],
        ['Version', 'Os'],
    ]) || '').toLowerCase();
}

function podmanServiceIsRemote(info) {
    return nestedValue(info, [
        ['host', 'serviceIsRemote'],
        ['Host', 'ServiceIsRemote'],
    ]) === true;
}

function podmanMachineConnection(runner) {
    const result = query(runner, 'podman', [
        'system', 'connection', 'list', '--format', 'json',
    ]);
    if (!result.ok) {
        return {
            state: 'unknown',
            message: 'Podman could not inspect its configured machine connection',
        };
    }
    let connections;
    try {
        connections = parseJsonRecords(result.stdout);
    } catch {
        return {
            state: 'unknown',
            message: 'Podman returned malformed machine connection information',
        };
    }
    const defaults = connections.filter((connection) => (
        (connection.Default ?? connection.default) === true
    ));
    if (defaults.length !== 1) {
        return {
            state: 'unsupported',
            message: 'Ploinky Box requires exactly one default Podman Machine connection on macOS',
        };
    }
    const selected = defaults[0];
    if ((selected.IsMachine ?? selected.isMachine) !== true) {
        return {
            state: 'unsupported',
            message: 'Ploinky Box supports Podman Machine on macOS, not an arbitrary remote Podman engine',
        };
    }
    return { state: 'supported' };
}

function labelsFrom(value) {
    const labels = value?.Labels ?? value?.labels ?? value?.Config?.Labels ?? {};
    if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
        return { ...labels };
    }
    if (typeof labels !== 'string' || !labels.trim()) {
        return {};
    }
    return Object.fromEntries(labels.split(',').map((entry) => {
        const index = entry.indexOf('=');
        return index < 0
            ? [entry.trim(), '']
            : [entry.slice(0, index).trim(), entry.slice(index + 1)];
    }));
}

function recordName(value) {
    const raw = value?.Name ?? value?.Names ?? value?.name ?? '';
    return String(Array.isArray(raw) ? raw[0] : raw).replace(/^\//, '');
}

function inspectExact(engine, kind, name, runner) {
    const result = query(runner, engine.name, [kind, 'inspect', name]);
    if (!result.ok) {
        if (ABSENT_PATTERN.test(`${result.stderr}\n${result.stdout}`)) {
            return { state: 'absent' };
        }
        return {
            state: 'unknown',
            message: `${engine.name} could not determine whether ${kind} ${name} exists`,
        };
    }
    try {
        const records = parseJsonRecords(result.stdout);
        if (records.length !== 1 || !records[0] || typeof records[0] !== 'object') {
            throw new Error('inspect result is not singular');
        }
        return { state: 'present', record: records[0] };
    } catch {
        return {
            state: 'unknown',
            message: `${engine.name} returned malformed ${kind} inspection for ${name}`,
        };
    }
}

function inventory(engine, kind, pathHash, runner) {
    const result = query(runner, engine.name, [
        kind,
        'ls',
        ...(kind === 'container' ? ['-a'] : []),
        '--filter',
        `label=${BOX_LABELS.pathHash}=${pathHash}`,
        '--format',
        '{{json .}}',
    ]);
    if (!result.ok) {
        return {
            state: 'unknown',
            message: `${engine.name} could not inventory Box ${kind} ownership`,
        };
    }
    try {
        return { state: 'known', records: parseJsonRecords(result.stdout) };
    } catch {
        return {
            state: 'unknown',
            message: `${engine.name} returned malformed Box ${kind} inventory`,
        };
    }
}

function expectedImmutableLabels(pathHash, role) {
    return {
        [BOX_LABELS.pathHash]: pathHash,
        [BOX_LABELS.role]: role,
    };
}

function hasExactLabels(labels, expected) {
    const observed = Object.fromEntries(Object.entries(labels || {})
        .filter(([key]) => key.startsWith('io.assistos.ploinky-box.'))
        .sort());
    const wanted = Object.fromEntries(Object.entries(expected).sort());
    return isDeepStrictEqual(observed, wanted);
}

function hasExactResourceLabels(labels, pathHash, role) {
    if (role !== BOX_ROLES.container) {
        return hasExactLabels(labels, expectedImmutableLabels(pathHash, role));
    }
    const hostPort = String(labels?.[BOX_LABELS.routerHostPort] || '');
    const imageRef = String(labels?.[BOX_LABELS.imageRef] || '');
    return /^[1-9][0-9]{0,4}$/.test(hostPort)
        && Number(hostPort) <= 65535
        && imageRef.length > 0
        && hasExactLabels(labels, {
            ...expectedImmutableLabels(pathHash, role),
            [BOX_LABELS.imageRef]: imageRef,
            [BOX_LABELS.routerHostPort]: hostPort,
        });
}

function containerHandle(engine, identity, name, record) {
    const id = String(record.Id ?? record.ID ?? '').trim();
    if (!id) {
        throw discoveryError(`${engine.name} container ${name} has no immutable ID`);
    }
    return Object.freeze({
        kind: 'container',
        engine: engine.name,
        engineIdentity: engine.identity,
        id,
        name,
        labels: Object.freeze(labelsFrom(record)),
        runtime: normalizeContainerRuntime(record),
        pathHash: identity.pathHash,
    });
}

function canonicalOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return null;
    }
    return Object.fromEntries(Object.entries(options).sort(([left], [right]) => (
        left.localeCompare(right)
    )));
}

export function normalizeVolumeFingerprint(record) {
    const name = String(record.Name ?? record.name ?? '').trim();
    const driver = String(record.Driver ?? record.driver ?? '').trim();
    const scope = String(record.Scope ?? record.scope ?? '').trim();
    const createdAt = String(record.CreatedAt ?? record.createdAt ?? '').trim();
    const mountpoint = String(record.Mountpoint ?? record.mountpoint ?? '').trim();
    const options = canonicalOptions(record.Options ?? record.options);
    if (!name || !driver || !scope || !createdAt || !mountpoint || options === null) {
        throw discoveryError(`Named volume ${name || '<unknown>'} has an incomplete ownership fingerprint`);
    }
    return Object.freeze({
        name,
        driver,
        scope,
        options: Object.freeze(options),
        createdAt,
        mountpointHash: sha256(Buffer.from(mountpoint)),
    });
}

function volumeHandle(engine, identity, role, name, record) {
    return Object.freeze({
        kind: 'volume',
        engine: engine.name,
        engineIdentity: engine.identity,
        name,
        role,
        labels: Object.freeze(labelsFrom(record)),
        fingerprint: normalizeVolumeFingerprint(record),
        pathHash: identity.pathHash,
    });
}

function expectedResources(identity) {
    return {
        container: {
            name: identity.instance,
            role: BOX_ROLES.container,
        },
        volumes: {
            containers: {
                name: identity.volumes.containers,
                role: BOX_ROLES.containers,
            },
            dependencies: {
                name: identity.volumes.dependencies,
                role: BOX_ROLES.dependencies,
            },
        },
        legacyVolumes: {
            workspace: {
                name: identity.legacyVolumes.workspace,
                role: BOX_ROLES.workspace,
            },
        },
    };
}

export function inspectOwnedVolumeHandle(engine, identity, key, runner = createProcessRunner()) {
    const expected = expectedResources(identity);
    const resource = expected.volumes[key] || expected.legacyVolumes[key];
    if (!resource) {
        throw discoveryError(`Unknown Box volume role ${key}`);
    }
    const inspection = inspectExact(engine, 'volume', resource.name, runner);
    if (inspection.state !== 'present') {
        return inspection;
    }
    const labels = labelsFrom(inspection.record);
    if (!hasExactResourceLabels(labels, identity.pathHash, resource.role)) {
        return {
            state: 'foreign',
            message: `${engine.name} exact-name resource ${resource.name} is not owned by this Box`,
        };
    }
    try {
        return {
            state: 'owned',
            handle: volumeHandle(
                engine,
                identity,
                resource.role,
                resource.name,
                inspection.record,
            ),
        };
    } catch (error) {
        return { state: 'foreign', message: error.message };
    }
}

function inspectEngineResources(engine, identity, runner) {
    const expected = expectedResources(identity);
    const expectedVolumes = {
        ...expected.volumes,
        ...expected.legacyVolumes,
    };
    const containerInventory = inventory(engine, 'container', identity.pathHash, runner);
    const volumeInventory = inventory(engine, 'volume', identity.pathHash, runner);
    if (containerInventory.state === 'unknown' || volumeInventory.state === 'unknown') {
        return {
            state: 'unknown',
            message: containerInventory.message || volumeInventory.message,
        };
    }

    const expectedNames = new Map([
        [expected.container.name, expected.container.role],
        ...Object.values(expectedVolumes).map((volume) => [volume.name, volume.role]),
    ]);
    for (const record of [...containerInventory.records, ...volumeInventory.records]) {
        const name = recordName(record);
        const role = labelsFrom(record)[BOX_LABELS.role];
        if (!expectedNames.has(name) || expectedNames.get(name) !== role) {
            return {
                state: 'foreign',
                message: `${engine.name} has an unexpected resource claiming this Box identity`,
            };
        }
    }

    const containerInspection = inspectExact(
        engine,
        'container',
        expected.container.name,
        runner,
    );
    if (containerInspection.state === 'unknown') {
        return containerInspection;
    }

    const volumeInspections = {};
    for (const [key, volume] of Object.entries(expectedVolumes)) {
        volumeInspections[key] = inspectExact(engine, 'volume', volume.name, runner);
        if (volumeInspections[key].state === 'unknown') {
            return volumeInspections[key];
        }
    }

    const entries = [
        ['container', expected.container, containerInspection],
        ...Object.entries(expectedVolumes).map(([key, volume]) => (
            [key, volume, volumeInspections[key]]
        )),
    ];
    for (const [, resource, inspection] of entries) {
        if (inspection.state !== 'present') {
            continue;
        }
        const labels = labelsFrom(inspection.record);
        if (!hasExactResourceLabels(labels, identity.pathHash, resource.role)) {
            return {
                state: 'foreign',
                message: `${engine.name} exact-name resource ${resource.name} is not owned by this Box`,
            };
        }
    }

    const presentCount = entries.filter(([, , inspection]) => (
        inspection.state === 'present'
    )).length;
    if (presentCount === 0) {
        return { state: 'absent', handles: null };
    }

    try {
        const handles = {
            container: containerInspection.state === 'present'
                ? containerHandle(engine, identity, expected.container.name, containerInspection.record)
                : null,
            volumes: {},
            legacyVolumes: {},
        };
        for (const [key, volume] of Object.entries(expected.volumes)) {
            handles.volumes[key] = volumeInspections[key].state === 'present'
                ? volumeHandle(
                    engine,
                    identity,
                    volume.role,
                    volume.name,
                    volumeInspections[key].record,
                )
                : null;
        }
        for (const [key, volume] of Object.entries(expected.legacyVolumes)) {
            handles.legacyVolumes[key] = volumeInspections[key].state === 'present'
                ? volumeHandle(
                    engine,
                    identity,
                    volume.role,
                    volume.name,
                    volumeInspections[key].record,
                )
                : null;
        }
        const activeVolumeInspections = Object.keys(expected.volumes)
            .map((key) => volumeInspections[key]);
        const activePresentCount = activeVolumeInspections.filter((inspection) => (
            inspection.state === 'present'
        )).length;
        const activeVolumeSetComplete = activePresentCount === activeVolumeInspections.length;
        const containerPresent = containerInspection.state === 'present';
        if ((containerPresent && !activeVolumeSetComplete)
            || (!containerPresent && activePresentCount > 0 && !activeVolumeSetComplete)) {
            return {
                state: 'incompatible',
                message: `${engine.name} has only part of the expected Box resource set`,
                handles,
            };
        }
        return { state: 'owned', handles };
    } catch (error) {
        return {
            state: 'foreign',
            message: error.message,
        };
    }
}

export function discoverBoxOwnership(identity, {
    platform = process.platform,
    env = process.env,
    runner = createProcessRunner(),
} = {}) {
    if (!['darwin', 'linux'].includes(platform)) {
        return {
            state: 'unsupported',
            message: 'Ploinky Box requires rootless Podman on Linux or macOS Podman Machine',
            engines: {},
        };
    }

    if (String(env.CONTAINER_HOST || env.PODMAN_HOST || '').trim()) {
        return {
            state: 'unsupported',
            message: 'Ploinky Box does not support a remote Podman engine',
            engines: {},
        };
    }

    const podman = probeEngine('podman', runner);
    if (podman.state === 'absent') {
        return {
            state: 'unsupported',
            message: 'Ploinky Box requires rootless Podman; Podman was not found',
            engines: { podman },
        };
    }
    if (podman.state === 'unknown') {
        return { state: 'unknown', message: podman.message, engines: { podman } };
    }
    if (!podmanRootless(podman.info)) {
        return {
            state: 'unsupported',
            message: 'Ploinky Box requires rootless Podman; rootful Podman is unsupported',
            engines: { podman },
        };
    }
    const hostOs = podmanHostOs(podman.info);
    if (hostOs && hostOs !== 'linux') {
        return {
            state: 'unsupported',
            message: 'Ploinky Box requires a Linux Podman engine',
            engines: { podman },
        };
    }
    let hostKind = 'native-linux';
    if (platform === 'darwin') {
        if (!podmanServiceIsRemote(podman.info)) {
            return {
                state: 'unsupported',
                message: 'Ploinky Box on macOS requires Podman Machine',
                engines: { podman },
            };
        }
        const machine = podmanMachineConnection(runner);
        if (machine.state !== 'supported') {
            return {
                state: machine.state,
                message: machine.message,
                engines: { podman },
            };
        }
        hostKind = 'podman-machine';
    } else if (podmanServiceIsRemote(podman.info)) {
        return {
            state: 'unsupported',
            message: 'Ploinky Box on Linux requires a native Podman engine, not a remote engine',
            engines: { podman },
        };
    }

    const docker = probeEngine('docker', runner);
    if (docker.state === 'unknown') {
        return {
            state: 'unknown',
            message: docker.message,
            engines: { podman, docker },
        };
    }

    const podmanInventory = inspectEngineResources(podman, identity, runner);
    if (podmanInventory.state === 'unknown') {
        return {
            state: 'unknown',
            message: podmanInventory.message,
            engines: { podman, docker },
        };
    }

    let dockerInventory = { state: 'absent', handles: null };
    if (docker.state === 'reachable') {
        dockerInventory = inspectEngineResources(docker, identity, runner);
        if (dockerInventory.state === 'unknown') {
            return {
                state: 'unknown',
                message: dockerInventory.message,
                engines: { podman, docker },
            };
        }
        if (dockerInventory.state !== 'absent') {
            return {
                state: 'foreign',
                message: 'Docker has an exact-name or labeled resource conflicting with this Box',
                engines: { podman, docker },
                inventories: { podman: podmanInventory, docker: dockerInventory },
            };
        }
    }

    return {
        state: podmanInventory.state,
        message: podmanInventory.message || '',
        engine: Object.freeze({ name: 'podman', identity: podman.identity, hostKind }),
        handles: podmanInventory.handles || null,
        engines: { podman, docker },
        inventories: { podman: podmanInventory, docker: dockerInventory },
    };
}

export function volumeHandleMatches(left, right) {
    return left?.kind === 'volume'
        && right?.kind === 'volume'
        && left.engine === right.engine
        && left.engineIdentity === right.engineIdentity
        && left.name === right.name
        && left.role === right.role
        && left.pathHash === right.pathHash
        && isDeepStrictEqual(left.labels, right.labels)
        && isDeepStrictEqual(left.fingerprint, right.fingerprint);
}
