import {
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

function podmanBackendFields(info) {
    return [
        nestedValue(info, [['host', 'id'], ['Host', 'ID']]),
        nestedValue(info, [['store', 'graphRoot'], ['Store', 'GraphRoot']]),
        nestedValue(info, [['store', 'runRoot'], ['Store', 'RunRoot']]),
        nestedValue(info, [['version', 'APIVersion'], ['Version', 'APIVersion']]),
    ];
}

function engineIdentity(info) {
    return sha256(Buffer.from(JSON.stringify(['podman', ...podmanBackendFields(info)])));
}

function probePodman(runner) {
    const name = 'podman';
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
        identity: engineIdentity(info),
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

function inspectExactContainer(engine, name, runner) {
    const result = query(runner, engine.name, ['container', 'inspect', name]);
    if (!result.ok) {
        if (ABSENT_PATTERN.test(`${result.stderr}\n${result.stdout}`)) {
            return { state: 'absent' };
        }
        return {
            state: 'unknown',
            message: `${engine.name} could not determine whether container ${name} exists`,
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
            message: `${engine.name} returned malformed container inspection for ${name}`,
        };
    }
}

function hasWorkspaceOwnership(labels, pathHash, role) {
    return String(labels?.[BOX_LABELS.pathHash] || '') === pathHash
        && String(labels?.[BOX_LABELS.role] || '') === role;
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

// Ownership discovery is intentionally narrow: Podman is authoritative, and
// only the exact workspace-derived name plus the workspace/role labels establish
// provenance. Detailed image, mount, port, confinement, and AgentLib validation
// belongs to reconciliation and status admission, not engine discovery.
function inspectOwnedContainer(engine, identity, runner) {
    const expected = expectedContainer(identity);
    const containerInspection = inspectExactContainer(engine, expected.name, runner);
    if (containerInspection.state === 'unknown') {
        return containerInspection;
    }
    if (containerInspection.state !== 'present') {
        return { state: 'absent', handles: null };
    }
    if (!hasWorkspaceOwnership(
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

    const podman = probePodman(runner);
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

    const ownership = inspectOwnedContainer(podman, identity, runner);
    if (ownership.state === 'unknown') {
        return {
            state: 'unknown',
            message: ownership.message,
            engines: { podman },
        };
    }

    return {
        state: ownership.state,
        message: ownership.message || '',
        engine: Object.freeze({ name: 'podman', identity: podman.identity, hostKind }),
        handles: ownership.handles || null,
        engines: { podman },
    };
}
