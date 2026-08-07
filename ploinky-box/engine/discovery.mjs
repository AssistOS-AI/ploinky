import { isDeepStrictEqual } from 'node:util';

import {
    BOX_DATA_FINGERPRINT_LABELS,
    BOX_DATA_KEYS,
    BOX_LABELS,
    BOX_ROLES,
} from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { sha256 } from '../boundary/fingerprint.mjs';
import { createProcessRunner } from '../process.mjs';
import { normalizeContainerRuntime } from '../contract/container.mjs';

const ABSENT_PATTERN = /(?:no such|not found|does not exist)/i;

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
    const hostPort = String(labels?.[BOX_LABELS.routerHostPort] || '');
    const mediaHostPort = String(labels?.[BOX_LABELS.mediaHostPort] || '');
    const imageRef = String(labels?.[BOX_LABELS.imageRef] || '');
    const dataFingerprints = Object.fromEntries(BOX_DATA_KEYS.map((key) => [
        key,
        String(labels?.[BOX_DATA_FINGERPRINT_LABELS[key]] || ''),
    ]));
    const fingerprintValues = Object.values(dataFingerprints);
    const hasNoFingerprints = fingerprintValues.every((value) => value === '');
    const hasCompleteFingerprints = fingerprintValues.every((value) => /^[a-f0-9]{64}$/.test(value));
    const expectedFingerprints = hasCompleteFingerprints
        ? Object.fromEntries(BOX_DATA_KEYS.map((key) => [
            BOX_DATA_FINGERPRINT_LABELS[key],
            dataFingerprints[key],
        ]))
        : {};
    return /^[1-9][0-9]{0,4}$/.test(hostPort)
        && Number(hostPort) <= 65535
        && /^[1-9][0-9]{0,4}$/.test(mediaHostPort)
        && Number(mediaHostPort) <= 65535
        && imageRef.length > 0
        && (hasNoFingerprints || hasCompleteFingerprints)
        && hasExactLabels(labels, {
            ...expectedImmutableLabels(pathHash, role),
            [BOX_LABELS.imageRef]: imageRef,
            [BOX_LABELS.routerHostPort]: hostPort,
            [BOX_LABELS.mediaHostPort]: mediaHostPort,
            ...expectedFingerprints,
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

function expectedContainer(identity) {
    return {
        name: identity.instance,
        role: BOX_ROLES.container,
    };
}

// Box persistence is workspace-backed, so the outer container is the only
// engine resource this Box owns. Labelled named volumes left behind by the
// retired design are inert: they neither establish ownership nor block a Box.
function inspectEngineResources(engine, identity, runner) {
    const expected = expectedContainer(identity);
    const containerInventory = inventory(engine, 'container', identity.pathHash, runner);
    if (containerInventory.state === 'unknown') {
        return {
            state: 'unknown',
            message: containerInventory.message,
        };
    }

    for (const record of containerInventory.records) {
        const name = recordName(record);
        const role = labelsFrom(record)[BOX_LABELS.role];
        if (name !== expected.name || role !== expected.role) {
            return {
                state: 'foreign',
                message: `${engine.name} has an unexpected resource claiming this Box identity`,
            };
        }
    }

    const containerInspection = inspectExact(engine, 'container', expected.name, runner);
    if (containerInspection.state === 'unknown') {
        return containerInspection;
    }
    if (containerInspection.state !== 'present') {
        return { state: 'absent', handles: null };
    }
    if (!hasExactResourceLabels(
        labelsFrom(containerInspection.record),
        identity.pathHash,
        expected.role,
    )) {
        return {
            state: 'foreign',
            message: `${engine.name} exact-name resource ${expected.name} is not owned by this Box`,
        };
    }

    try {
        return {
            state: 'owned',
            handles: {
                container: containerHandle(
                    engine,
                    identity,
                    expected.name,
                    containerInspection.record,
                ),
            },
        };
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
