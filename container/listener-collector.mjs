import {
    buildContainerRecord,
    parsePidNamespaceInventory,
    parsePodmanPsJson,
} from './listener-inventory.mjs';
import {
    buildManagedNetworkRecord,
    managedNetworkWorkspaceHash,
    parseManagedNetworkInspection,
    parseManagedNetworkList,
    sameManagedNetworkGeneration,
} from './listener-network-inventory.mjs';
import { mergeOuterListenerOwners, parseOwnerAwareSsOutput } from './listener-owner-merge.mjs';
import { collectCoherentSocketOwners, parseSocketOwnerProofBatch } from './listener-owner-proof.mjs';

const SS_ARGS = Object.freeze(['ss', '-H', '-O', '-lntupe']);
const OUTER_SS_ARGS = Object.freeze(['ss', '-H', '-O', '-lntupe']);
const COLLECTOR_TOOLS = Object.freeze([
    Object.freeze({ binary: 'node', packageName: 'the pinned Node runtime' }),
    Object.freeze({ binary: 'ss', packageName: 'iproute' }),
    Object.freeze({ binary: 'nsenter', packageName: 'util-linux-core' }),
]);
const PID_NAMESPACE_SCRIPT = String.raw`
const fs = require('node:fs');
const initPid = Number(process.argv[1]);
if (!Number.isSafeInteger(initPid) || initPid < 1) process.exit(64);
const pidNamespace = fs.readlinkSync('/proc/' + initPid + '/ns/pid');
const pids = [];
for (const entry of fs.readdirSync('/proc')) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    try {
        if (fs.readlinkSync('/proc/' + entry + '/ns/pid') === pidNamespace) pids.push(Number(entry));
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}
pids.sort((left, right) => left - right);
process.stdout.write(JSON.stringify({ initPid, pidNamespace, pids }));
`;
const OWNER_PROOF_SCRIPT = String.raw`
import { readSocketOwnerProofBatch } from '/opt/ploinky/container/listener-owner-proof.mjs';
process.stdout.write(JSON.stringify(readSocketOwnerProofBatch(JSON.parse(process.argv[1]))));
`;

function resultDiagnostic(result) {
    return String(result?.stderr || result?.stdout || result?.error?.message || '').trim();
}

function requireCommand(result, label, remediation) {
    if (result?.status === 0 && !result?.error) return result;
    const detail = resultDiagnostic(result) || `exit ${result?.status ?? 'unknown'}`;
    throw new Error(`${label} failed: ${detail}. ${remediation}`);
}

function parseInspection(stdout, containerName) {
    try {
        const value = JSON.parse(String(stdout || ''));
        if (!Array.isArray(value) || value.length !== 1) {
            throw new Error(`expected one record, found ${Array.isArray(value) ? value.length : 'non-array'}`);
        }
        return value[0];
    } catch (error) {
        throw new Error(`cannot parse nested container '${containerName}' inspection: ${error.message}`);
    }
}

function collectPidNamespace({ run, outerContainer, containerName, initPid }) {
    if (!Number.isSafeInteger(initPid) || initPid < 1) {
        throw new Error(`nested container '${containerName}' has no valid inspected State.Pid`);
    }
    const result = requireCommand(
        run([
            'exec', '--user', 'podman', outerContainer,
            'node', '-e', PID_NAMESPACE_SCRIPT, String(initPid),
        ]),
        `nested container '${containerName}' PID-namespace inventory`,
        'The Ploinky box runtime user must retain read access to managed descendant /proc PID-namespace links for exact socket-owner attribution',
    );
    return parsePidNamespaceInventory(result.stdout, containerName);
}

export function assertBoxListenerCollectorContract({ run, outerContainer } = {}) {
    const name = String(outerContainer || '').trim();
    if (!name) throw new Error('outerContainer is required for listener collector contract check');
    if (typeof run !== 'function') throw new Error('listener collector contract run(args) function is required');
    for (const tool of COLLECTOR_TOOLS) {
        requireCommand(
            run(['exec', '--user', 'podman', name, tool.binary, '--version']),
            `Ploinky box listener collector dependency '${tool.binary}'`,
            `The Ploinky box image must install ${tool.packageName} and its entrypoint must reject an image without '${tool.binary}'`,
        );
    }
    requireCommand(
        run(['exec', '--user', 'podman', name, 'podman', 'unshare', 'ss', '--version']),
        'Ploinky box listener collector rootless owner context',
        'The Ploinky box runtime user must be able to inspect sockets in its existing nested Podman user namespace',
    );
}

function inspectSs({ run, outerContainer, namespace, container = null }) {
    const prefix = ['exec', '--user', 'podman', outerContainer];
    if (!container) {
        const capture = (unshare, label) => requireCommand(
            run([...prefix, ...(unshare ? ['podman', 'unshare'] : []), ...OUTER_SS_ARGS]),
            `${namespace} ${label} owner-aware listener inventory`,
            'The Ploinky box runtime user and its nested Podman user namespace must provide complementary procfs socket-owner visibility',
        ).stdout;
        const ownerBefore = capture(false, 'owner-before');
        const ownerUnshare = capture(true, 'owner-unshare');
        const ownerAfter = capture(false, 'owner-after');
        return mergeOuterListenerOwners({ ownerBefore, ownerUnshare, ownerAfter });
    }
    const result = requireCommand(
        run([...prefix, 'podman', 'unshare', 'nsenter', '-t', String(container.initPid), '-n', ...SS_ARGS]),
        `${namespace} owner-aware listener inventory`,
        `The Ploinky box runtime user must use its nested Podman user namespace to permit entry into managed nested container '${container.name}' network namespace and retain the outer PID namespace for owner correlation`,
    );
    return parseOwnerAwareSsOutput(result.stdout, { namespace, containerName: container.name });
}

function collectNamespaceOwners({ run, outerContainer, namespace, containers, container = null }) {
    return collectCoherentSocketOwners({
        containers,
        containerName: container?.name || null,
        capture: () => inspectSs({ run, outerContainer, namespace, container }),
        observe(context, request) {
            const result = requireCommand(
                run(['exec', '--user', 'podman', outerContainer,
                    ...(context === 'unshare' ? ['podman', 'unshare'] : []),
                    'node', '--input-type=module', '--eval', OWNER_PROOF_SCRIPT, JSON.stringify(request)]),
                `${namespace} ${context} exact socket-owner process proof`,
                'The existing box runtime owner context must read the reported process identity, PID namespace, and socket descriptors without additional privileges',
            );
            return parseSocketOwnerProofBatch(result.stdout, request);
        },
    });
}

function nestedContainers({ run, outerContainer }) {
    const listedResult = requireCommand(
        run(['exec', outerContainer, 'podman', 'ps', '--format', 'json']),
        'nested Podman running-container inventory',
        'Verify the outer box nested Podman store is healthy and readable by the box runtime user',
    );
    const listed = parsePodmanPsJson(listedResult.stdout);
    return listed.map((summary) => {
        const inspectResult = requireCommand(
            run(['exec', outerContainer, 'podman', 'container', 'inspect', summary.name]),
            `nested container '${summary.name}' inspection`,
            'Verify the running container still exists and nested Podman can inspect it',
        );
        const inspection = parseInspection(inspectResult.stdout, summary.name);
        const pidInventory = collectPidNamespace({
            run,
            outerContainer,
            containerName: summary.name,
            initPid: Number(inspection?.State?.Pid),
        });
        return buildContainerRecord({
            listed: summary,
            inspection,
            pidInventory,
        });
    });
}

export function collectManagedNetworkInventory({
    run,
    outerContainer,
    workspaceRoot = '/workspace',
} = {}) {
    const boxName = String(outerContainer || '').trim();
    if (!boxName) throw new Error('outerContainer is required for managed-network collection');
    if (typeof run !== 'function') {
        throw new Error('managed-network collection run(args) function is required');
    }
    const workspaceHash = managedNetworkWorkspaceHash(workspaceRoot);
    const listedResult = requireCommand(
        run(['exec', boxName, 'podman', 'network', 'ls', '--format', 'json']),
        'nested Podman managed-network inventory',
        'Verify the outer box nested Podman network store is healthy and readable by the box runtime user',
    );
    const names = parseManagedNetworkList(listedResult.stdout, { workspaceHash });
    const records = names.map((name) => {
        const inspectedResult = requireCommand(
            run(['exec', boxName, 'podman', 'network', 'inspect', name]),
            `managed network '${name}' inspection`,
            'Retry after the coordinated graph generation is stable; every private Router bind must come from exact current managed bridge state',
        );
        return buildManagedNetworkRecord({
            inspection: parseManagedNetworkInspection(inspectedResult.stdout, name),
            listedName: name,
            workspaceHash,
        });
    });
    const gateways = new Set();
    for (const record of records) {
        if (gateways.has(record.gateway)) {
            throw new Error(`managed networks reuse gateway '${record.gateway}'`);
        }
        gateways.add(record.gateway);
    }
    return Object.freeze(records);
}

export function assertManagedNetworkInventoryCurrent({
    run,
    outerContainer,
    expected,
    workspaceRoot = '/workspace',
} = {}) {
    const current = collectManagedNetworkInventory({ run, outerContainer, workspaceRoot });
    if (!sameManagedNetworkGeneration(expected, current)) {
        throw new Error('managed-network generation changed while its listener generation was collected');
    }
    return current;
}

function assertContainersStillCurrent({ run, outerContainer, containers }) {
    for (const container of containers) {
        const result = requireCommand(
            run(['exec', outerContainer, 'podman', 'container', 'inspect', container.name]),
            `nested container '${container.name}' final inspection`,
            'Retry after the coordinated graph generation is stable; listener evidence cannot span a container replacement',
        );
        const current = parseInspection(result.stdout, container.name);
        if (current?.State?.Running !== true
            || String(current?.Id || '') !== container.id
            || String(current?.Name || '').replace(/^\//, '') !== container.name
            || Number(current?.State?.Pid) !== container.initPid
            || String(current?.State?.StartedAt || '').trim() !== container.startedAt) {
            throw new Error(
                `nested container '${container.name}' changed while its listener generation was collected`,
            );
        }
    }
    const listedResult = requireCommand(
        run(['exec', outerContainer, 'podman', 'ps', '--format', 'json']),
        'nested Podman final running-container inventory',
        'Retry after the coordinated graph generation is stable; listener evidence cannot span a graph membership change',
    );
    const finalContainers = parsePodmanPsJson(listedResult.stdout);
    const expected = new Map(containers.map(container => [container.name, container.id]));
    const finalSetMatches = finalContainers.length === expected.size
        && finalContainers.every((container) => {
            const exactId = expected.get(container.name);
            return exactId && exactId.startsWith(container.id);
        });
    if (!finalSetMatches) {
        throw new Error('nested running-container set changed while its listener generation was collected');
    }
}

export function collectBoxListenerInventory({
    outerContainer,
    run,
    verifyTools = true,
    workspaceRoot = '/workspace',
} = {}) {
    const name = String(outerContainer || '').trim();
    if (!name) throw new Error('outerContainer is required for listener collection');
    if (typeof run !== 'function') throw new Error('listener collection run(args) function is required');
    if (verifyTools) assertBoxListenerCollectorContract({ run, outerContainer: name });

    const managedNetworks = collectManagedNetworkInventory({
        run,
        outerContainer: name,
        workspaceRoot,
    });
    const containers = nestedContainers({ run, outerContainer: name });
    const outer = collectNamespaceOwners({
        run,
        outerContainer: name,
        namespace: 'outer',
        containers,
    });
    const listeners = [...outer.listeners];
    const memberships = new Map(outer.memberships);
    const inspectedNamespaces = new Set(['outer']);
    for (const container of containers) {
        if (inspectedNamespaces.has(container.namespace)) continue;
        inspectedNamespaces.add(container.namespace);
        const observed = collectNamespaceOwners({
            run,
            outerContainer: name,
            namespace: container.namespace,
            containers,
            container,
        });
        listeners.push(...observed.listeners);
        for (const [id, pids] of observed.memberships) memberships.set(id, pids);
    }
    assertContainersStillCurrent({ run, outerContainer: name, containers });
    assertManagedNetworkInventoryCurrent({
        run,
        outerContainer: name,
        expected: managedNetworks,
        workspaceRoot,
    });
    return Object.freeze({
        listeners: Object.freeze(listeners),
        containers: Object.freeze(containers.map(container => Object.freeze({
            ...container,
            pids: Object.freeze([...memberships.get(container.id)].sort((left, right) => left - right)),
            pidMembership: 'verified-listener-owners-and-init',
        }))),
        managedNetworks,
    });
}
