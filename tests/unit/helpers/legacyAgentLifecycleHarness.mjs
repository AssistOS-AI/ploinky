import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNetworkLifecycleAdapter } from '../../../cli/sandbox/networkLifecycle.js';
import { NETWORK_LABELS, workspaceNetworkIdentity } from '../../../cli/sandbox/networkIdentity.js';
import { NETWORK_SCHEMA_VERSION, networkContractHash } from '../../../cli/sandbox/networkContract.js';
import { inspectInterimAgentLifecycle, overrideLegacyConfinementCollector } from '../../../cli/sandbox/legacyAgentLifecycleGuard.mjs';
import { collectPodmanOciEvidence } from '../../../cli/sandbox/legacyAgentRuntimeEvidence.mjs';
import { glObservation, glCollectorDeps } from './legacyGlObservations.mjs';

export const CONTAINER_ID = 'a'.repeat(64);
export const WORKSPACE_HASH = 'legacy-lifecycle-fixture';

export function lifecycleRecord(overrides = {}) {
    return { type: 'agent', agentName: 'worker', repoName: 'demo', runtime: 'podman', runMode: 'global',
        containerId: CONTAINER_ID, instanceId: 'instance-one', enableGeneration: 'generation-one',
        config: { binds: [] }, ...overrides };
}

export function inspectedLifecycleRecord(name, registry = lifecycleRecord(), {
    workspaceHash = WORKSPACE_HASH, network = { mode: 'none' }, marked = false, running = true,
} = {}) {
    return {
        Id: registry.containerId, Name: `/${name}`,
        Config: { Labels: {
            [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'agent',
            [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION, [NETWORK_LABELS.workspace]: workspaceHash,
            [NETWORK_LABELS.contract]: networkContractHash(network),
            [NETWORK_LABELS.instanceId]: registry.instanceId,
            [NETWORK_LABELS.enableGeneration]: registry.enableGeneration,
            ...(marked ? { 'ploinky.procunmask': '' } : {}),
        }, Env: ['SECRET_SENTINEL=never-output-this'] },
        HostConfig: { Init: true, NetworkMode: network.mode },
        State: { Running: running, Status: running ? 'running' : 'exited' },
        NetworkSettings: { Networks: {} }, Mounts: [],
    };
}

// Synthetic trusted-evidence collector: lifecycle fixtures never reach an
// engine or a real OCI spec file. For any harness instance it serves a spec
// that keeps the reviewed baseline (the darwin G-L lists, engine-created
// mounts only) bound to that instance's own immutable ID. It is inert while
// FULL_MASK_COMPLETENESS_ACTIVE is false and is what lets the lifecycle fixtures
// stay green when the full predicate is switched on.
export function syntheticConfinementCollector({ runtime, record }) {
    const observed = glObservation('darwinArm64');
    const id = record.Id || record.ID;
    const userMounts = new Set(observed.inspect.Mounts.map((mount) => mount.Destination));
    observed.spec.mounts = observed.spec.mounts.filter((mount) => !userMounts.has(mount.destination));
    const inspect = { ...record, OCIRuntime: 'crun',
        OCIConfigPath: `/tmp/storage-run-1000/overlay-containers/${id}/userdata/config.json` };
    return collectPodmanOciEvidence({ runtime, record: inspect },
        glCollectorDeps({ inspect, spec: observed.spec, info: observed.info }));
}
overrideLegacyConfinementCollector(syntheticConfinementCollector);

export function lifecycleHarness(entries = [['agent', lifecycleRecord()]], { marked = [], workspaceRoot } = {}) {
    const registry = Object.fromEntries(entries);
    const workspaceHash = workspaceRoot ? workspaceNetworkIdentity(workspaceRoot).hash : WORKSPACE_HASH;
    const containers = new Map(entries.map(([name, record]) => [record.containerId,
        inspectedLifecycleRecord(name, record, { workspaceHash, marked: marked.includes(name) })]));
    const effects = [];
    const reads = [];
    const inspect = (runtime, identifier) => {
        assert.ok(['docker', 'podman'].includes(runtime)); reads.push(identifier);
        return structuredClone(containers.get(identifier)
            || [...containers.values()].find((record) => record.Name === `/${identifier}`) || null);
    };
    const dependencies = { inspect, workspaceIdentity: () => ({ hash: workspaceHash }),
        readPredecessor: () => null, readCandidate: () => null };
    const preflight = (input) => inspectInterimAgentLifecycle(input, dependencies);
    return { registry, containers, effects, reads, inspect, dependencies, preflight,
        snapshot: () => JSON.stringify({ registry, containers: [...containers], effects }) };
}

// Existing higher-level fixtures can inject this exact synthetic read instead
// of allowing a newly introduced preflight to reach an installed engine.
export function syntheticLifecyclePreflight(input) {
    const record = input.registryRecord;
    return inspectInterimAgentLifecycle({ ...input, runtime: typeof input.runtime === 'string' ? input.runtime : 'podman' }, {
        inspect: (_runtime, identifier) => record?.containerId && [record.containerId, input.containerName].includes(identifier)
            ? inspectedLifecycleRecord(input.containerName, record) : null,
        workspaceIdentity: () => ({ hash: WORKSPACE_HASH }), readPredecessor: () => null, readCandidate: () => null,
    });
}

export function lifecycleNetworkHarness(t, { runtime = 'podman', mode = 'default', marked = true } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-network-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const record = lifecycleRecord({ runtime });
    const network = { mode };
    const f = lifecycleHarness([['agent', record]], { workspaceRoot: root });
    const inspected = inspectedLifecycleRecord('agent', record, {
        workspaceHash: workspaceNetworkIdentity(root).hash, network, marked,
    });
    f.containers.set(record.containerId, inspected);
    const networks = new Map();
    const ok = (stdout = '') => ({ ok: true, status: 0, stdout, stderr: '' });
    const missing = () => ({ ok: false, status: 1, stdout: '', stderr: 'no such container or network' });
    const run = (_engine, args) => {
        if (args[0] === 'info') return ok(JSON.stringify({ rootless: true, networkBackend: 'netavark',
            pasta: { executable: '/usr/bin/pasta', version: '2025' }, serviceIsRemote: false }));
        if (args[0] === 'version') return ok('5.4.0');
        if (args[0] === 'unshare') return ok('pasta 2025');
        if (args[0] === 'container' && args[1] === 'inspect') {
            const value = f.inspect(runtime, args[2]); return value ? ok(JSON.stringify([value])) : missing();
        }
        if (args[0] === 'network' && args[1] === 'inspect') {
            const value = networks.get(args[2]); return value ? ok(JSON.stringify([value])) : missing();
        }
        if (args[0] === 'network' && args[1] === 'create') {
            f.effects.push('network-create');
            const labels = Object.fromEntries(args.flatMap((value, index) => value === '--label'
                ? [[args[index + 1].split('=')[0], args[index + 1].split('=').slice(1).join('=')]] : []));
            networks.set(args.at(-1), { Name: args.at(-1), Driver: 'bridge', Internal: false,
                IPv6Enabled: false, DNSEnabled: true, Options: { isolate: 'true' },
                IPAM: { Driver: 'host-local', Options: {} },
                Subnets: [{ Subnet: '10.89.0.0/24', Gateway: '10.89.0.1' }], Labels: labels, Containers: {} });
            return ok(args.at(-1));
        }
        f.effects.push(args[0]);
        assert.fail(`Unexpected synthetic engine command: ${args[0]}`);
    };
    const adapter = createNetworkLifecycleAdapter({ runtime, run, workspaceRoot: root,
        lockPath: path.join(root, 'network.lock'), env: {}, containersConfigPaths: [],
        inspectRunningHosts: () => '10.0.0.1 host.containers.internal\n' });
    const prepare = () => {
        const plan = adapter.prepare(network, 'worker');
        const name = plan.attachments[0].name;
        inspected.NetworkSettings.Networks = { [name]: { Aliases: [plan.alias, record.containerId.slice(0, 12)] } };
        inspected.HostConfig.ExtraHosts = ['host.containers.internal:host-gateway'];
        inspected.HostConfig.HostsFile = 'none';
        networks.get(name).Containers[record.containerId] = { Name: inspected.Name };
        f.effects.length = 0;
        return plan;
    };
    return { ...f, adapter, record, inspected, network, prepare };
}
