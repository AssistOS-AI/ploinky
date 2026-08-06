import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

import {
    BOX_LABELS,
    BOX_ROLES,
} from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { sha256 } from '../boundary/fingerprint.mjs';
import { createProcessRunner } from '../process.mjs';
import {
    normalizeContainerRuntime,
    requireFullContainerId,
    runtimeFromOuterJournal,
} from '../contract/container.mjs';
import { createOuterJournalStore } from '../lifecycle/outerJournal.mjs';
import { createPodmanHostClient } from './libpodClient.mjs';
import {
    parseReleaseDescriptor,
    serializeReleaseDescriptor,
} from '../contract/release.mjs';

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
    const name = String(selected.Name ?? selected.name ?? '').trim();
    const uri = String(selected.URI ?? selected.Uri ?? selected.uri ?? '').trim();
    let socketPath = null;
    try {
        const parsed = new URL(uri);
        if (parsed.search || parsed.hash || parsed.protocol !== 'ssh:') {
            throw new Error('not one supported local machine connection');
        }
        const remoteSocketPath = decodeURIComponent(parsed.pathname);
        if (!['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname)
            || !parsed.username
            || parsed.password
            || !/^\/run\/user\/[1-9][0-9]*\/podman\/podman\.sock$/.test(remoteSocketPath)
            || !pathIsCanonicalAbsolute(remoteSocketPath)) {
            throw new Error('machine SSH connection is not loopback-local');
        }
    } catch {
        return {
            state: 'unsupported',
            message: 'Ploinky Box requires one canonical local Podman Machine connection',
        };
    }
    if (!name) {
        return {
            state: 'unsupported',
            message: 'Ploinky Box requires a named Podman Machine connection',
        };
    }
    return {
        state: 'supported',
        connection: Object.freeze({ name, uri, socketPath }),
    };
}

function podmanMachineEngineIdentity(connection) {
    return sha256(Buffer.from(JSON.stringify([
        'podman-machine',
        'v6.0.1',
        connection.name,
        connection.uri,
    ])));
}

function forwardedMachineSocket(connection, env) {
    if (connection.socketPath) return connection.socketPath;
    const temporaryRoot = String(env.TMPDIR || '').replace(/\/+$/u, '');
    if (!pathIsCanonicalAbsolute(temporaryRoot)
        || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(connection.name)) {
        throw discoveryError(
            'Podman Machine forwarded Unix socket cannot be derived from the selected connection',
        );
    }
    const selected = path.join(temporaryRoot, 'podman', `${connection.name}-api.sock`);
    if (!pathIsCanonicalAbsolute(selected)) {
        throw discoveryError('Podman Machine forwarded Unix socket path is not canonical');
    }
    return selected;
}

function pathIsCanonicalAbsolute(value) {
    return typeof value === 'string'
        && value.startsWith('/')
        && value === value.replace(/\/+/g, '/')
        && !value.split('/').includes('..')
        && !value.split('/').includes('.');
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

function inspectExactVolume(engine, name, runner) {
    const result = query(runner, engine.name, ['volume', 'inspect', name]);
    if (!result.ok) {
        if (ABSENT_PATTERN.test(`${result.stderr}\n${result.stdout}`)) {
            return { state: 'absent' };
        }
        return {
            state: 'unknown',
            message: `${engine.name} could not determine whether volume ${name} exists`,
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
            message: `${engine.name} returned malformed volume inspection for ${name}`,
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
    const mediaHostPort = String(labels?.[BOX_LABELS.mediaHostPort] || '');
    const imageRef = String(labels?.[BOX_LABELS.imageRef] || '');
    const serializedRelease = String(labels?.[BOX_LABELS.releaseDescriptor] || '');
    const releaseGeneration = String(labels?.[BOX_LABELS.releaseGeneration] || '');
    let releaseLabels = {};
    if (serializedRelease || releaseGeneration) {
        try {
            const descriptor = parseReleaseDescriptor(serializedRelease);
            if (releaseGeneration !== descriptor.releaseGeneration
                || serializeReleaseDescriptor(descriptor) !== serializedRelease) return false;
            releaseLabels = {
                [BOX_LABELS.releaseDescriptor]: serializedRelease,
                [BOX_LABELS.releaseGeneration]: releaseGeneration,
            };
        } catch {
            return false;
        }
    }
    return /^[1-9][0-9]{0,4}$/.test(hostPort)
        && Number(hostPort) <= 65535
        && /^[1-9][0-9]{0,4}$/.test(mediaHostPort)
        && Number(mediaHostPort) <= 65535
        && imageRef.length > 0
        && hasExactLabels(labels, {
            ...expectedImmutableLabels(pathHash, role),
            [BOX_LABELS.imageRef]: imageRef,
            [BOX_LABELS.routerHostPort]: hostPort,
            [BOX_LABELS.mediaHostPort]: mediaHostPort,
            ...releaseLabels,
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

function exactContainerNames(record) {
    const source = record?.Names ?? record?.names ?? record?.Name ?? record?.name;
    const values = Array.isArray(source) ? source : [source];
    return values.map((value) => String(value || '').replace(/^\//, '')).filter(Boolean);
}

function directClientIdentity(hostClient, machineConnection, expectedEngineIdentity) {
    const identity = hostClient?.identity || {};
    const legacyConnection = hostClient?.connection || {};
    const engineIdentityValue = String(
        identity.engineIdentity ?? hostClient?.engineIdentity ?? '',
    );
    const connectionIdentity = String(
        identity.connectionIdentity
            ?? hostClient?.connectionIdentity
            ?? legacyConnection.identity
            ?? '',
    );
    const socketPath = String(
        identity.socketPath ?? hostClient?.socketPath ?? legacyConnection.socketPath ?? '',
    );
    const apiVersion = String(identity.apiVersion ?? hostClient?.apiVersion ?? '');
    const connectionUri = String(
        identity.connectionUri ?? hostClient?.connectionUri ?? legacyConnection.uri ?? '',
    );
    if (!/^[a-f0-9]{64}$/.test(engineIdentityValue)
        || engineIdentityValue !== expectedEngineIdentity
        || apiVersion !== 'v6.0.1'
        || connectionIdentity !== machineConnection.name
        || connectionUri !== machineConnection.uri
        || !pathIsCanonicalAbsolute(socketPath)
        || (machineConnection.socketPath !== null
            && socketPath !== machineConnection.socketPath)) {
        throw discoveryError('Podman host client identity does not match the selected machine socket');
    }
    return Object.freeze({
        name: machineConnection.name,
        identity: connectionIdentity,
        uri: machineConnection.uri,
        socketPath,
    });
}

function journalVolumeHandle(engine, identity, journal, key, role) {
    const name = identity.volumes[key];
    if (!journal.container.creation.volumes.includes(name)) {
        throw discoveryError(`Outer Box journal does not contain exact ${key} volume identity`);
    }
    return Object.freeze({
        kind: 'volume',
        engine: engine.name,
        engineIdentity: engine.identity,
        name,
        role,
        labels: Object.freeze(expectedImmutableLabels(identity.pathHash, role)),
        fingerprint: Object.freeze({
            journalGeneration: journal.transaction.generation,
            transactionId: journal.transaction.id,
        }),
        pathHash: identity.pathHash,
    });
}

function journalVolumeHandles(engine, identity, journal) {
    return Object.freeze({
        workspace: journalVolumeHandle(engine, identity, journal, 'workspace', BOX_ROLES.workspace),
        containers: journalVolumeHandle(engine, identity, journal, 'containers', BOX_ROLES.containers),
        dependencies: journalVolumeHandle(
            engine,
            identity,
            journal,
            'dependencies',
            BOX_ROLES.dependencies,
        ),
    });
}

function directContainerHandle(engine, identity, journal, record) {
    const id = requireFullContainerId(record?.Id ?? record?.ID);
    return Object.freeze({
        kind: 'container',
        engine: engine.name,
        engineIdentity: engine.identity,
        connectionIdentity: engine.connection.identity,
        id,
        name: journal.container.name,
        labels: Object.freeze(labelsFrom(record)),
        runtime: runtimeFromOuterJournal(record, journal),
        pathHash: identity.pathHash,
        journal: Object.freeze({
            generation: journal.transaction.generation,
            revision: journal.revision,
            phase: journal.phase,
        }),
    });
}

async function inspectPodmanMachineResources({
    podman,
    identity,
    hostClient,
    machineConnection,
    outerJournal,
}) {
    if (!hostClient || typeof hostClient.listContainers !== 'function') {
        return {
            state: 'unsupported',
            message: 'Ploinky Box on macOS requires the structured Podman host client',
        };
    }
    let connection;
    try {
        connection = directClientIdentity(hostClient, machineConnection, podman.identity);
    } catch (error) {
        return { state: 'incompatible', message: error.message };
    }
    const engine = Object.freeze({
        name: 'podman',
        identity: String(hostClient.identity?.engineIdentity ?? hostClient.engineIdentity),
        apiVersion: String(hostClient.identity?.apiVersion ?? hostClient.apiVersion),
        hostKind: 'podman-machine',
        connection,
    });
    const journalStore = outerJournal || createOuterJournalStore({
        workspaceRoot: identity.workspaceRoot,
    });
    let journal;
    try {
        journal = journalStore.read({ allowMissing: true });
    } catch (error) {
        return {
            state: 'incompatible',
            message: `Outer Box ownership journal is invalid: ${error.message}`,
            engine,
        };
    }
    if (journal && (journal.engine.identity !== engine.identity
        || journal.engine.apiVersion !== engine.apiVersion
        || !isDeepStrictEqual(journal.engine.connection, connection)
        || journal.workspace.root !== identity.workspaceRoot
        || journal.workspace.pathHash !== identity.pathHash
        || journal.workspace.owner !== identity.instance)) {
        return {
            state: 'incompatible',
            message: 'Outer Box ownership journal identity mismatch',
            engine,
        };
    }
    if (journal && (journal.container.creation.dependencies.length !== 0
        || journal.container.creation.autoRemove !== false)) {
        return {
            state: 'incompatible',
            message: 'Outer Box ownership journal has dependencies or auto-remove enabled',
            engine,
        };
    }
    let records;
    try {
        records = await hostClient.listContainers({
            all: true,
            sync: false,
            size: false,
            namespace: false,
        });
        if (!Array.isArray(records)) throw new Error('container list is not an array');
    } catch (error) {
        return {
            state: 'unknown',
            message: `Podman direct sync=false container discovery failed: ${error.message}`,
            engine,
        };
    }
    const stableNamed = records.filter((record) => exactContainerNames(record).includes(identity.instance));
    const workspaceLabeled = records.filter((record) => {
        const labels = labelsFrom(record);
        return labels[BOX_LABELS.pathHash] === identity.pathHash
            && labels[BOX_LABELS.role] === BOX_ROLES.container;
    });
    if (!journal) {
        return stableNamed.length === 0 && workspaceLabeled.length === 0
            ? { state: 'absent', handles: null, engine }
            : {
                state: 'incompatible',
                message: 'Exact-name or ownership-labeled outer Box exists without its journal',
                engine,
            };
    }
    const named = records.filter((record) => (
        exactContainerNames(record).includes(journal.container.name)
    ));
    const deletedGeneration = journal.container.id !== null
        && !journal.createdResources.container
        && ['container-deleted', 'retaining-resources'].includes(journal.phase);
    if (deletedGeneration) {
        const historicalIdPresent = records.some((record) => (
            String(record?.Id ?? record?.ID ?? '') === journal.container.id
        ));
        if (named.length !== 0 || historicalIdPresent || workspaceLabeled.length !== 0) {
            return {
                state: 'incompatible',
                message: 'Deleted-generation journal conflicts with a present outer Box container',
                engine,
            };
        }
        return {
            state: 'owned',
            handles: Object.freeze({
                container: null,
                volumes: journalVolumeHandles(engine, identity, journal),
            }),
            engine,
            journal,
        };
    }
    if (journal.container.id === null) {
        return named.length === 0
            ? {
                state: 'owned',
                handles: {
                    container: null,
                    volumes: journalVolumeHandles(engine, identity, journal),
                },
                engine,
                journal,
            }
            : {
                state: 'incompatible',
                message: 'An unpublished outer Box intent cannot adopt an exact-name container',
                engine,
            };
    }
    try {
        for (const record of named) requireFullContainerId(record?.Id ?? record?.ID);
    } catch (error) {
        return { state: 'incompatible', message: error.message, engine };
    }
    const byId = records.filter((record) => String(record?.Id ?? record?.ID ?? '') === journal.container.id);
    if (byId.length !== 1 || named.length !== 1 || named[0] !== byId[0]) {
        return {
            state: 'incompatible',
            message: 'Outer Box container discovery is missing, duplicate, stale, or ambiguous',
            engine,
        };
    }
    const record = byId[0];
    if (!isDeepStrictEqual(labelsFrom(record), journal.container.labels)) {
        return {
            state: 'incompatible',
            message: 'Outer Box list labels do not match the ownership journal labels',
            engine,
        };
    }
    try {
        return {
            state: 'owned',
            handles: Object.freeze({
                container: directContainerHandle(engine, identity, journal, record),
                volumes: journalVolumeHandles(engine, identity, journal),
            }),
            engine,
            journal,
        };
    } catch (error) {
        return {
            state: 'incompatible',
            message: error.message,
            engine,
        };
    }
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
            workspace: {
                name: identity.volumes.workspace,
                role: BOX_ROLES.workspace,
            },
            containers: {
                name: identity.volumes.containers,
                role: BOX_ROLES.containers,
            },
            dependencies: {
                name: identity.volumes.dependencies,
                role: BOX_ROLES.dependencies,
            },
        },
    };
}

export function inspectOwnedVolumeHandle(engine, identity, key, runner = createProcessRunner()) {
    const resource = expectedResources(identity).volumes[key];
    if (!resource) {
        throw discoveryError(`Unknown Box volume role ${key}`);
    }
    const inspection = inspectExactVolume(engine, resource.name, runner);
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

function inspectNativePodmanResources(engine, identity, runner) {
    const expected = expectedResources(identity);
    const list = query(runner, engine.name, [
        'container', 'ls', '--all', '--sync=false', '--no-trunc', '--format', 'json',
    ]);
    if (!list.ok) {
        return {
            state: 'unknown',
            message: `${engine.name} direct sync=false container list failed`,
        };
    }
    let listed;
    try {
        listed = parseJsonRecords(list.stdout);
        if (!Array.isArray(listed)) throw new Error('list is not an array');
    } catch {
        return {
            state: 'unknown',
            message: `${engine.name} returned malformed direct sync=false container list`,
        };
    }
    const exactContainers = listed.filter((record) => (
        exactContainerNames(record).includes(expected.container.name)
    ));
    if (exactContainers.length > 1) {
        return {
            state: 'incompatible',
            message: `${engine.name} returned duplicate exact-name Box containers`,
        };
    }
    const containerInspection = exactContainers.length === 0
        ? { state: 'absent' }
        : { state: 'present', record: exactContainers[0] };

    const volumeInspections = {};
    for (const [key, volume] of Object.entries(expected.volumes)) {
        volumeInspections[key] = inspectExactVolume(engine, volume.name, runner);
        if (volumeInspections[key].state === 'unknown') {
            return volumeInspections[key];
        }
    }

    const entries = [
        ['container', expected.container, containerInspection],
        ...Object.entries(expected.volumes).map(([key, volume]) => (
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
        const retainedVolumeSet = containerInspection.state === 'absent'
            && Object.values(volumeInspections).every((inspection) => inspection.state === 'present');
        if (presentCount !== entries.length && !retainedVolumeSet) {
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
    hostClient = null,
    hostClientFactory = createPodmanHostClient,
    outerJournal = null,
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

    // Podman v6.0.2 `podman info` is not a state-free discovery probe: the
    // server's Runtime.info -> storeInfo -> getContainerStoreInfo path calls
    // GetAllContainers and State for every container.  On Darwin, select the
    // configured local Machine connection without contacting the service, then
    // use only the structured sync=false client below.
    if (platform === 'darwin') {
        const machine = podmanMachineConnection(runner);
        if (machine.state !== 'supported') {
            return {
                state: machine.state,
                message: machine.message,
                engines: { podman: { name: 'podman', state: machine.state } },
            };
        }
        let machineConnection;
        try {
            machineConnection = Object.freeze({
                ...machine.connection,
                socketPath: forwardedMachineSocket(machine.connection, env),
            });
        } catch (error) {
            return {
                state: 'unsupported',
                message: `Structured Podman Machine socket transport is unavailable: ${error.message}`,
                engines: { podman: { name: 'podman', state: 'unsupported' } },
            };
        }
        const podman = Object.freeze({
            name: 'podman',
            state: 'reachable',
            identity: podmanMachineEngineIdentity(machineConnection),
        });
        let selectedClient = hostClient;
        if (!selectedClient) {
            try {
                selectedClient = hostClientFactory({
                    engine: {
                        name: 'podman',
                        identity: podman.identity,
                        apiVersion: 'v6.0.1',
                        hostKind: 'podman-machine',
                        connection: {
                            name: machineConnection.name,
                            identity: machineConnection.name,
                            uri: machineConnection.uri,
                            socketPath: machineConnection.socketPath,
                        },
                    },
                    execEvidenceStore: outerJournal?.execSessions ?? null,
                });
            } catch (error) {
                return {
                    state: 'unsupported',
                    message: `Structured Podman Machine socket transport is unavailable: ${error.message}`,
                    engines: { podman },
                };
            }
        }
        return inspectPodmanMachineResources({
            podman,
            identity,
            hostClient: selectedClient,
            machineConnection,
            outerJournal,
        }).then((result) => ({
            ...result,
            hostClient: selectedClient,
            engines: { podman },
            inventories: { podman: result },
        }));
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
    const hostKind = 'native-linux';
    if (podmanServiceIsRemote(podman.info)) {
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

    const podmanInventory = inspectNativePodmanResources(podman, identity, runner);
    if (podmanInventory.state === 'unknown') {
        return {
            state: 'unknown',
            message: podmanInventory.message,
            engines: { podman, docker },
        };
    }

    const dockerInventory = { state: 'not-selected', handles: null };

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
