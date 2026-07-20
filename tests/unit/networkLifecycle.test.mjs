import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    NETWORK_LABELS,
    NETWORK_STATUS_SCHEMA_VERSION,
    createNetworkLifecycleAdapter,
    physicalNetworkName,
    workspaceNetworkIdentity,
} from '../../cli/sandbox/networkLifecycle.js';
import {
    canonicalizeNetwork,
    deriveNetworkAlias,
    networkContractHash,
} from '../../cli/sandbox/networkContract.js';

function ok(stdout = '') {
    return { ok: true, status: 0, stdout, stderr: '' };
}

function absent(resource = 'resource') {
    return { ok: false, status: 125, stdout: '', stderr: `no such ${resource}` };
}

function platformResult(args, overrides = {}) {
    if (args[0] === 'version') return ok(`${overrides.version || '5.4.0'}\n`);
    if (args[0] === 'info' && args[2]?.includes('Rootless')) {
        return ok(`${overrides.rootless ?? 'true'}\n`);
    }
    if (args[0] === 'info' && args[2]?.includes('NetworkBackend')) {
        return ok(JSON.stringify(overrides.backend || 'netavark'));
    }
    if (args[0] === 'info' && args[2]?.includes('Pasta')) {
        return overrides.pastaMetadata === false
            ? ok('null')
            : ok(JSON.stringify({ executable: '/usr/bin/pasta', version: '0^20250620' }));
    }
    if (args[0] === 'info' && args[2]?.includes('ServiceIsRemote')) {
        if (overrides.serviceIsRemoteProbe === false) return absent('remote service metadata');
        return ok(JSON.stringify(overrides.serviceIsRemote === true));
    }
    if (args[0] === 'unshare' && args[1] === '/usr/bin/pasta' && args[2] === '--version') {
        if (overrides.serviceIsRemote === true) {
            return { ...absent('pasta'), stderr: 'cannot use command "podman unshare" with the remote podman client' };
        }
        return overrides.pastaOperational === false
            ? { ...absent('pasta'), stderr: 'pasta executable probe failed' }
            : ok('pasta 0^20250620\n');
    }
    return null;
}

function labelsFromArgs(args) {
    return Object.fromEntries(args.flatMap((value, index) => {
        if (value !== '--label') return [];
        const [key, ...rest] = String(args[index + 1]).split('=');
        return [[key, rest.join('=')]];
    }));
}

function managedNetworkRecord(identity, logicalName, name, containers = {}) {
    return {
        Name: name,
        Driver: 'bridge',
        Internal: false,
        IPv6Enabled: false,
        DNSEnabled: true,
        Options: { isolate: 'true' },
        IPAM: { Driver: 'host-local', Options: {} },
        Subnets: [{ Subnet: '10.89.0.0/24', Gateway: '10.89.0.1' }],
        Labels: {
            [NETWORK_LABELS.managed]: '1',
            [NETWORK_LABELS.resource]: 'network',
            [NETWORK_LABELS.schema]: '2',
            [NETWORK_LABELS.workspace]: identity.hash,
            [NETWORK_LABELS.logical]: logicalName,
        },
        Containers: containers,
    };
}

const TEST_RUNTIME_IDENTITY = Object.freeze({
    instanceId: 'instance-current',
    enableGeneration: 'enable-current',
});

function managedAgentLabels(
    identity,
    network,
    contractHash = networkContractHash(network),
    extra = {},
    runtimeIdentity = TEST_RUNTIME_IDENTITY,
) {
    return {
        [NETWORK_LABELS.managed]: '1',
        [NETWORK_LABELS.resource]: 'agent',
        [NETWORK_LABELS.schema]: '2',
        [NETWORK_LABELS.workspace]: identity.hash,
        [NETWORK_LABELS.contract]: contractHash,
        ...(runtimeIdentity ? {
            [NETWORK_LABELS.instanceId]: runtimeIdentity.instanceId,
            [NETWORK_LABELS.enableGeneration]: runtimeIdentity.enableGeneration,
        } : {}),
        ...extra,
    };
}

function managedAgentRecord({ id, name, labels, networks, running = false, hostsFile = 'none', extraHosts, networkMode } = {}) {
    return {
        Id: id,
        Name: name,
        Config: { Labels: labels, CreateCommand: ['podman', 'create', '--arbitrary-history'] },
        HostConfig: {
            HostsFile: hostsFile,
            ExtraHosts: extraHosts || ['host.containers.internal:host-gateway'],
            ...(networkMode ? { NetworkMode: networkMode } : {}),
        },
        NetworkSettings: { Networks: networks || {} },
        State: { Running: running, Status: running ? 'running' : 'configured' },
    };
}

function networkHarness(t, { platform = {}, containersConfigPaths } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-network-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const workspaceRoot = path.join(dir, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const identity = workspaceNetworkIdentity(workspaceRoot);
    const networks = new Map();
    const containers = new Map();
    const calls = [];
    const findContainer = (selector) => [...containers.values()].find((record) => (
        record.Name === selector || record.Id === selector
    )) || null;
    const run = (_runtime, args) => {
        calls.push([...args]);
        const platformResponse = platformResult(args, platform);
        if (platformResponse) return platformResponse;
        if (args[0] === 'network' && args[1] === 'inspect') {
            const record = networks.get(args[2]);
            return record ? ok(JSON.stringify([record])) : absent('network');
        }
        if (args[0] === 'network' && args[1] === 'create') {
            const name = args.at(-1);
            const labels = labelsFromArgs(args);
            const logicalName = labels[NETWORK_LABELS.logical];
            networks.set(name, managedNetworkRecord(identity, logicalName, name));
            return ok(`${name}\n`);
        }
        if (args[0] === 'network' && args[1] === 'connect') {
            const alias = args[args.indexOf('--alias') + 1];
            const name = args.at(-2);
            const selector = args.at(-1);
            const container = findContainer(selector);
            if (!container) return absent('container');
            container.NetworkSettings.Networks[name] = { Aliases: [alias, container.Id.slice(0, 12)] };
            networks.get(name).Containers[container.Id] = { Name: container.Name };
            return ok();
        }
        if (args[0] === 'network' && args[1] === 'rm') {
            const record = networks.get(args[2]);
            if (!record) return absent('network');
            if (Object.keys(record.Containers || {}).length) return { ...absent('network'), stderr: 'network in use' };
            networks.delete(args[2]);
            return ok();
        }
        if (args[0] === 'network' && args[1] === 'ls') {
            return ok(JSON.stringify([...networks.values()].map(({ Name, Labels }) => ({ Name, Labels }))));
        }
        if (args[0] === 'container' && args[1] === 'inspect') {
            const record = findContainer(args[2]);
            return record ? ok(JSON.stringify([record])) : absent('container');
        }
        if (args[0] === 'exec') return ok('127.0.0.1 localhost\n10.89.0.1 host.containers.internal\n');
        if (args[0] === 'start') {
            const record = findContainer(args[1]);
            if (!record) return absent('container');
            record.State = { Running: true, Status: 'running' };
            return ok();
        }
        if (args[0] === 'stop') {
            const record = findContainer(args[1]);
            if (!record) return absent('container');
            record.State = { Running: false, Status: 'exited' };
            return ok();
        }
        if (args[0] === 'rename') {
            const record = findContainer(args[1]);
            if (!record) return absent('container');
            record.Name = args[2];
            return ok();
        }
        if (args[0] === 'rm') {
            const record = findContainer(args.at(-1));
            if (!record) return absent('container');
            containers.delete(record.Id);
            for (const network of networks.values()) delete network.Containers[record.Id];
            return ok();
        }
        return absent('resource');
    };
    const adapter = createNetworkLifecycleAdapter({
        runtime: 'podman',
        run,
        workspaceRoot,
        lockPath: path.join(dir, 'network.lock'),
        containersConfigPaths,
    });
    return { adapter, calls, containers, dir, identity, networks, run };
}

test('all modes produce one transport path and exact managed hosts arguments', (t) => {
    const harness = networkHarness(t);
    const none = harness.adapter.prepare({ mode: 'none' }, 'demo');
    const host = harness.adapter.prepare({ mode: 'host' }, 'demo');
    assert.deepEqual(none.args, ['--network', 'none']);
    assert.deepEqual(host.args, ['--network', 'host']);
    assert.equal(harness.calls.some((args) => args[0] === 'info'), false);

    const defaultPlan = harness.adapter.prepare({ mode: 'default' }, 'demo');
    assert.deepEqual(defaultPlan.args.slice(-3), [
        '--hosts-file=none',
        '--add-host',
        'host.containers.internal:host-gateway',
    ]);
    assert.equal(defaultPlan.args.filter((value) => value === '--hosts-file=none').length, 1);
    assert.equal(defaultPlan.args.filter((value) => value === '--add-host').length, 1);
    assert.equal(defaultPlan.args.some((value) => value === '--no-hosts' || value === '--volume'), false);
    assert.equal(harness.calls.some((args) => (
        args[0] === 'unshare' && args[1] === '/usr/bin/pasta' && args[2] === '--version'
    )), true);

    const bridge = canonicalizeNetwork({
        mode: 'bridge',
        attachments: [{ name: 'front', primary: true }, { name: 'data' }],
    });
    const bridgePlan = harness.adapter.prepare(bridge, 'demo');
    assert.equal(bridgePlan.attachments.length, 2);
    assert.equal(bridgePlan.args.includes('--hosts-file=none'), true);
    assert.equal(bridgePlan.args.includes('host.containers.internal:host-gateway'), true);
});

test('managed preflight requires Podman 5.4+, rootless Netavark, operational pasta, and compatible config', (t) => {
    for (const [overrides, pattern] of [
        [{ version: '5.3.9' }, /5\.4 or newer/],
        [{ rootless: 'false' }, /rootless Podman/],
        [{ backend: 'cni' }, /Netavark/],
        [{ pastaMetadata: false }, /pasta backend metadata/],
        [{ serviceIsRemoteProbe: false }, /cannot determine whether Podman is local or remote/],
        [{ pastaOperational: false }, /operational pasta/],
    ]) {
        const harness = networkHarness(t, { platform: overrides });
        assert.throws(() => harness.adapter.preflight({ mode: 'default' }, 'demo'), pattern);
        assert.equal(harness.calls.some((args) => args[0] === 'network' && args[1] === 'create'), false);
    }

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-containers-conf-'));
    t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
    const configPath = path.join(configDir, 'containers.conf');
    fs.writeFileSync(configPath, '[containers] # effective container defaults\nno_hosts=true# valid TOML comment\n');
    const noHosts = networkHarness(t, { containersConfigPaths: [configPath] });
    assert.throws(
        () => noHosts.adapter.preflight({ mode: 'default' }, 'demo'),
        /no_hosts=true/,
    );
    assert.equal(noHosts.calls.some((args) => args[0] === 'network' && args[1] === 'create'), false);

    const gatewayDisabledPath = path.join(configDir, '20-gateway-disabled.conf');
    fs.writeFileSync(gatewayDisabledPath, '[containers]\nhost_containers_internal_ip="none"\n');
    const gatewayDisabled = networkHarness(t, { containersConfigPaths: [gatewayDisabledPath] });
    assert.throws(
        () => gatewayDisabled.adapter.preflight({ mode: 'default' }, 'demo'),
        /host_containers_internal_ip='none'/,
    );
    assert.equal(gatewayDisabled.calls.some((args) => args[0] === 'network' && args[1] === 'create'), false);

    const gatewayEnabledPath = path.join(configDir, '30-gateway-enabled.conf');
    fs.writeFileSync(gatewayEnabledPath, '[containers]\nhost_containers_internal_ip=""\n');
    const overriddenGateway = networkHarness(t, {
        containersConfigPaths: [gatewayDisabledPath, gatewayEnabledPath],
    });
    assert.doesNotThrow(() => overriddenGateway.adapter.preflight({ mode: 'default' }, 'demo'));
});

test('remote managed preflight uses server pasta metadata without invoking client-side unshare', (t) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-remote-client-conf-'));
    t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
    const clientConfigPath = path.join(configDir, 'containers.conf');
    fs.writeFileSync(clientConfigPath, '[containers]\nno_hosts=true\nhost_containers_internal_ip="none"\n');
    const remote = networkHarness(t, {
        platform: { serviceIsRemote: true },
        containersConfigPaths: [clientConfigPath],
    });
    assert.doesNotThrow(() => remote.adapter.preflight({ mode: 'default' }, 'demo'));
    assert.equal(remote.calls.some((args) => args[0] === 'unshare'), false);

    const missingMetadata = networkHarness(t, {
        platform: { serviceIsRemote: true, pastaMetadata: false },
    });
    assert.throws(
        () => missingMetadata.adapter.preflight({ mode: 'default' }, 'demo'),
        /operational pasta backend metadata/,
    );
    assert.equal(missingMetadata.calls.some((args) => args[0] === 'unshare'), false);
});

test('post-create verification failure removes a just-created managed network', (t) => {
    for (const failureMode of ['missing', 'invalid']) {
        const harness = networkHarness(t);
        let createdName = '';
        let failedPostCreateInspection = false;
        const run = (runtime, args) => {
            if (args[0] === 'network' && args[1] === 'create') {
                const result = harness.run(runtime, args);
                if (result.ok) createdName = args.at(-1);
                return result;
            }
            if (args[0] === 'network'
                && args[1] === 'inspect'
                && args[2] === createdName
                && !failedPostCreateInspection) {
                failedPostCreateInspection = true;
                harness.calls.push([...args]);
                if (failureMode === 'missing') return absent('network');
                const invalid = JSON.parse(JSON.stringify(harness.networks.get(createdName)));
                invalid.Options.isolate = 'false';
                return ok(JSON.stringify([invalid]));
            }
            return harness.run(runtime, args);
        };
        const adapter = createNetworkLifecycleAdapter({
            runtime: 'podman',
            run,
            workspaceRoot: harness.identity.canonical,
            lockPath: path.join(harness.dir, `${failureMode}.lock`),
        });

        assert.throws(
            () => adapter.prepare({ mode: 'default' }, 'demo'),
            failureMode === 'missing' ? /disappeared after creation/ : /isolate=true/,
        );
        assert.equal(harness.networks.size, 0);
        assert.equal(harness.calls.some((args) => (
            args[0] === 'network' && args[1] === 'rm' && args[2] === createdName
        )), true);
    }
});

test('post-create cleanup preserves a network whose ownership labels cannot be verified', (t) => {
    const harness = networkHarness(t);
    let createdName = '';
    let changedOwnership = false;
    const run = (runtime, args) => {
        if (args[0] === 'network' && args[1] === 'create') {
            const result = harness.run(runtime, args);
            if (result.ok) createdName = args.at(-1);
            return result;
        }
        if (args[0] === 'network'
            && args[1] === 'inspect'
            && args[2] === createdName
            && !changedOwnership) {
            changedOwnership = true;
            harness.networks.get(createdName).Labels.foreign = 'replacement';
        }
        return harness.run(runtime, args);
    };
    const adapter = createNetworkLifecycleAdapter({
        runtime: 'podman',
        run,
        workspaceRoot: harness.identity.canonical,
        lockPath: path.join(harness.dir, 'foreign-replacement.lock'),
    });

    assert.throws(
        () => adapter.prepare({ mode: 'default' }, 'demo'),
        /cleanup preserved.*exact ownership labels could not be verified/,
    );
    assert.equal(harness.networks.has(createdName), true);
    assert.equal(harness.calls.some((args) => (
        args[0] === 'network' && args[1] === 'rm' && args[2] === createdName
    )), false);
});

test('host and none contract inspection does not require managed bridge host fields', (t) => {
    const harness = networkHarness(t);
    for (const mode of ['host', 'none']) {
        const network = canonicalizeNetwork({ mode });
        const id = `${mode}123456789012`;
        const record = managedAgentRecord({
            id,
            name: `${mode}-container`,
            labels: managedAgentLabels(harness.identity, network),
            networks: {},
            networkMode: mode,
        });
        delete record.HostConfig.HostsFile;
        record.HostConfig.ExtraHosts = [];
        harness.containers.set(id, record);
        assert.equal(harness.adapter.inspectContainerContract(
            `${mode}-container`,
            network,
            mode,
            { contractHash: networkContractHash(network) },
        ).state, 'exact');
        record.HostConfig.NetworkMode = mode === 'host' ? 'none' : 'host';
        assert.equal(harness.adapter.inspectContainerContract(
            `${mode}-container`,
            network,
            mode,
            { contractHash: networkContractHash(network) },
        ).state, 'owned-drift');
    }
});

test('runtime identity labels bind inspection and label construction to the exact registry tuple', (t) => {
    const harness = networkHarness(t);
    const network = canonicalizeNetwork({ mode: 'host' });
    const id = 'identity123456789';
    const record = managedAgentRecord({
        id,
        name: 'demo-container',
        labels: managedAgentLabels(harness.identity, network),
        networks: {},
        networkMode: 'host',
        running: true,
    });
    harness.containers.set(id, record);

    const exactOptions = {
        contractHash: networkContractHash(network),
        ...TEST_RUNTIME_IDENTITY,
        requireRuntimeIdentity: true,
    };
    assert.deepEqual(
        harness.adapter.inspectContainerContract('demo-container', network, 'demo', exactOptions),
        { state: 'exact', id },
    );
    assert.deepEqual(
        harness.adapter.inspectContainerContract('demo-container', network, 'demo', {
            ...exactOptions,
            enableGeneration: 'enable-stale',
        }),
        { state: 'owned-drift', id, reason: 'runtime-identity' },
    );

    delete record.Config.Labels[NETWORK_LABELS.instanceId];
    assert.deepEqual(
        harness.adapter.inspectContainerContract('demo-container', network, 'demo', exactOptions),
        { state: 'owned-drift', id, reason: 'runtime-identity' },
    );
    record.Config.Labels[NETWORK_LABELS.instanceId] = TEST_RUNTIME_IDENTITY.instanceId;

    const labels = labelsFromArgs(harness.adapter.agentIdentityLabelArgs(network, TEST_RUNTIME_IDENTITY));
    assert.equal(labels[NETWORK_LABELS.instanceId], TEST_RUNTIME_IDENTITY.instanceId);
    assert.equal(labels[NETWORK_LABELS.enableGeneration], TEST_RUNTIME_IDENTITY.enableGeneration);
    assert.throws(
        () => harness.adapter.agentIdentityLabelArgs(network, { instanceId: TEST_RUNTIME_IDENTITY.instanceId }),
        /exact instanceId and enableGeneration/,
    );
    assert.throws(
        () => harness.adapter.finalizeContainer('demo-container', { mode: 'host', attachments: [] }),
        /requires exact ownership and runtime-identity labels/,
    );
});

test('exact cleanup preserves swapped or stale tuples and removes only the immutable candidate ID', (t) => {
    const harness = networkHarness(t);
    const network = canonicalizeNetwork({ mode: 'host' });
    const id = 'candidate123456789';
    harness.containers.set(id, managedAgentRecord({
        id,
        name: 'livekit-container',
        labels: managedAgentLabels(harness.identity, network),
        networks: {},
        networkMode: 'host',
        running: true,
    }));
    const cleanupOptions = {
        expectedContainerId: id,
        contractHash: networkContractHash(network),
        ...TEST_RUNTIME_IDENTITY,
    };

    assert.deepEqual(harness.adapter.removeExactContainer(
        'livekit-container',
        network,
        'livekit',
        { ...cleanupOptions, enableGeneration: 'enable-stale' },
    ), {
        removed: false,
        state: 'owned-drift',
        id,
        reason: 'runtime-identity',
    });
    assert.equal(harness.containers.has(id), true);

    assert.deepEqual(harness.adapter.removeExactContainer(
        'livekit-container',
        network,
        'livekit',
        { ...cleanupOptions, expectedContainerId: 'replaced123456789' },
    ), {
        removed: false,
        state: 'absent',
        id: 'replaced123456789',
    });
    assert.equal(harness.containers.has(id), true);

    assert.deepEqual(harness.adapter.removeExactContainer(
        'livekit-container',
        network,
        'livekit',
        cleanupOptions,
    ), { removed: true, state: 'removed', id });
    assert.equal(harness.containers.has(id), false);
    assert.equal(harness.calls.some((args) => args[0] === 'rm' && args.at(-1) === id), true);
});

test('reuse validates HostConfig fields, every bridge, and current contract hash without CreateCommand', (t) => {
    const harness = networkHarness(t);
    const network = canonicalizeNetwork({
        mode: 'bridge',
        attachments: [{ name: 'front', primary: true }, { name: 'data' }],
    });
    const names = network.attachments.map(({ name }) => physicalNetworkName(harness.identity.hash, name));
    network.attachments.forEach(({ name }, index) => {
        harness.networks.set(names[index], managedNetworkRecord(harness.identity, name, names[index]));
    });
    const id = '0123456789abcdef';
    const alias = deriveNetworkAlias('demo');
    const record = managedAgentRecord({
        id,
        name: 'demo-container',
        labels: managedAgentLabels(harness.identity, network, undefined, { 'org.opencontainers.image.title': 'extra-ok' }),
        networks: Object.fromEntries(names.map((name) => [name, { Aliases: [alias, id.slice(0, 12)] }])),
        running: true,
    });
    harness.containers.set(id, record);
    const options = { contractHash: networkContractHash(network) };
    assert.equal(harness.adapter.inspectContainerContract('demo-container', network, 'demo', options).state, 'exact');
    assert.equal(harness.calls.some((args) => args[0] === 'version'), true);
    assert.equal(harness.calls.some((args) => args[0] === 'info' && args[2]?.includes('NetworkBackend')), true);

    record.Config.CreateCommand = ['podman', 'create', '--no-hosts', '--hosts-file=bad', '--add-host=wrong'];
    assert.equal(harness.adapter.inspectContainerContract('demo-container', network, 'demo', options).state, 'exact');
    record.HostConfig.HostsFile = '/etc/hosts';
    assert.equal(harness.adapter.inspectContainerContract('demo-container', network, 'demo', options).state, 'owned-drift');
    record.HostConfig.HostsFile = 'none';
    record.HostConfig.ExtraHosts.push('host.docker.internal:host-gateway');
    assert.equal(harness.adapter.inspectContainerContract('demo-container', network, 'demo', options).state, 'owned-drift');
    record.HostConfig.ExtraHosts = ['host.containers.internal:host-gateway'];

    record.Config.Labels[NETWORK_LABELS.contract] = '0'.repeat(64);
    assert.equal(harness.adapter.inspectContainerContract('demo-container', network, 'demo', options).state, 'foreign');
    record.Config.Labels[NETWORK_LABELS.contract] = networkContractHash(network);
    harness.networks.get(names[1]).Options.isolate = 'false';
    assert.throws(
        () => harness.adapter.inspectContainerContract('demo-container', network, 'demo', options),
        /isolate=true/,
    );
});

test('running hosts validation tolerates unrelated entries but rejects duplicate managed names', (t) => {
    const harness = networkHarness(t);
    const network = canonicalizeNetwork({ mode: 'default' });
    const plan = harness.adapter.prepare(network, 'demo');
    const id = 'abcdef0123456789';
    harness.containers.set(id, managedAgentRecord({
        id,
        name: 'demo-container',
        labels: managedAgentLabels(harness.identity, network),
        networks: { [plan.attachments[0].name]: { Aliases: ['demo', id.slice(0, 12)] } },
        running: true,
    }));
    const options = { contractHash: networkContractHash(network) };
    assert.equal(harness.adapter.inspectContainerContract('demo-container', network, 'demo', options).state, 'exact');

    const duplicateAdapter = createNetworkLifecycleAdapter({
        runtime: 'podman',
        run: harness.run,
        workspaceRoot: harness.identity.canonical,
        inspectRunningHosts: () => '10.0.0.1 host.containers.internal\n10.0.0.2 host.containers.internal host.docker.internal\n',
    });
    assert.equal(duplicateAdapter.inspectContainerContract('demo-container', network, 'demo', options).state, 'owned-drift');
});

test('status schema 3 requires complete agent labels and allows unrelated extra labels', (t) => {
    const harness = networkHarness(t);
    const physicalName = physicalNetworkName(harness.identity.hash, 'shared');
    const ownedHash = 'a'.repeat(64);
    const records = [
        ['owned-agent', managedAgentLabels(harness.identity, { mode: 'default' }, ownedHash, { extra: 'allowed' })],
        ['partial-agent', { [NETWORK_LABELS.workspace]: harness.identity.hash }],
        ['uppercase-hash', managedAgentLabels(harness.identity, { mode: 'default' }, 'A'.repeat(64))],
        ['wrong-resource', { ...managedAgentLabels(harness.identity, { mode: 'default' }, 'b'.repeat(64)), [NETWORK_LABELS.resource]: 'gateway' }],
    ];
    const attached = {};
    for (const [index, [name, labels]] of records.entries()) {
        const id = `${index}`.repeat(16);
        attached[id] = { Name: name, Aliases: [name] };
        harness.containers.set(id, managedAgentRecord({
            id,
            name,
            labels,
            networks: { [physicalName]: { Aliases: [name, id.slice(0, 12)] } },
        }));
    }
    harness.networks.set(physicalName, managedNetworkRecord(harness.identity, 'shared', physicalName, attached));
    const status = harness.adapter.status();
    assert.equal(status.schemaVersion, NETWORK_STATUS_SCHEMA_VERSION);
    assert.deepEqual(Object.keys(status), ['schemaVersion', 'workspaceHash', 'networks']);
    assert.deepEqual(status.networks[0].attachments.map(({ containerName, ownership }) => [containerName, ownership]), [
        ['owned-agent', 'agent'],
        ['partial-agent', 'unknown'],
        ['uppercase-hash', 'unknown'],
        ['wrong-resource', 'unknown'],
    ]);
});

test('prune re-inspects and removes only exact-owned empty networks without disconnecting attachments', (t) => {
    const harness = networkHarness(t);
    const emptyName = physicalNetworkName(harness.identity.hash, 'empty');
    const usedName = physicalNetworkName(harness.identity.hash, 'used');
    const foreignName = physicalNetworkName(harness.identity.hash, 'foreign');
    harness.networks.set(emptyName, managedNetworkRecord(harness.identity, 'empty', emptyName));
    harness.networks.set(usedName, managedNetworkRecord(harness.identity, 'used', usedName, {
        unknown: { Name: 'manual-container' },
    }));
    const foreign = managedNetworkRecord(harness.identity, 'foreign', foreignName);
    foreign.Labels.extra = 'spoof';
    harness.networks.set(foreignName, foreign);
    const report = harness.adapter.prune();
    assert.deepEqual(report.removed, [emptyName]);
    assert.equal(report.preserved.some((entry) => entry.name === usedName && entry.reason === 'in-use'), true);
    assert.equal(report.preserved.some((entry) => entry.name === foreignName && entry.reason === 'foreign'), true);
    assert.equal(harness.calls.some((args) => args[0] === 'network' && args[1] === 'disconnect'), false);
    assert.equal(harness.calls.filter((args) => args[0] === 'network' && args[1] === 'inspect' && args[2] === emptyName).length >= 2, true);
});

test('managed transaction creates multiple attachments, verifies start, and commits exact policy', (t) => {
    const harness = networkHarness(t);
    const network = canonicalizeNetwork({
        mode: 'bridge',
        attachments: [{ name: 'front', primary: true }, { name: 'data' }],
    });
    let observedPlan;
    const result = harness.adapter.runManagedContainerTransaction({
        network,
        canonicalAgentId: 'demo',
        containerName: 'demo-container',
        runtimeIdentity: TEST_RUNTIME_IDENTITY,
        createContainer(plan) {
            observedPlan = plan;
            const id = 'candidate1234567890';
            const primary = plan.attachments.find((entry) => entry.primary);
            const record = managedAgentRecord({
                id,
                name: 'demo-container',
                labels: managedAgentLabels(harness.identity, network),
                networks: { [primary.name]: { Aliases: [plan.alias, id.slice(0, 12)] } },
            });
            harness.containers.set(id, record);
            harness.networks.get(primary.name).Containers[id] = { Name: record.Name };
        },
    });
    assert.equal(result.attachments.length, 2);
    assert.deepEqual(observedPlan.args.slice(-3), [
        '--hosts-file=none', '--add-host', 'host.containers.internal:host-gateway',
    ]);
    const candidate = [...harness.containers.values()][0];
    assert.equal(candidate.State.Running, true);
    assert.equal(Object.keys(candidate.NetworkSettings.Networks).length, 2);
});

test('host-gateway start failure removes the candidate and never restores the predecessor runtime', (t) => {
    const harness = networkHarness(t);
    const network = canonicalizeNetwork({ mode: 'default' });
    const previousId = 'previous123456789';
    const previous = managedAgentRecord({
        id: previousId,
        name: 'demo-container',
        labels: managedAgentLabels(harness.identity, network),
        running: true,
    });
    harness.containers.set(previousId, previous);
    const candidateId = 'candidate123456789';
    const baseRun = harness.run;
    const run = (runtime, args) => {
        if (args[0] === 'start' && args[1] === candidateId) {
            harness.calls.push([...args]);
            return { ...absent('host-gateway'), stderr: 'unable to replace host-gateway' };
        }
        return baseRun(runtime, args);
    };
    const adapter = createNetworkLifecycleAdapter({
        runtime: 'podman',
        run,
        workspaceRoot: harness.identity.canonical,
        lockPath: path.join(harness.dir, 'failure.lock'),
    });
    assert.throws(() => adapter.runManagedContainerTransaction({
        network,
        canonicalAgentId: 'demo',
        containerName: 'demo-container',
        runtimeIdentity: TEST_RUNTIME_IDENTITY,
        createContainer(plan) {
            const primary = plan.attachments[0];
            const candidate = managedAgentRecord({
                id: candidateId,
                name: 'demo-container',
                labels: managedAgentLabels(harness.identity, network),
                networks: { [primary.name]: { Aliases: [plan.alias, candidateId.slice(0, 12)] } },
            });
            harness.containers.set(candidateId, candidate);
            harness.networks.get(primary.name).Containers[candidateId] = { Name: candidate.Name };
        },
    }), /host-gateway/);
    assert.equal([...harness.containers.values()].length, 0);
    assert.equal(previous.State.Running, false);
    assert.equal(harness.networks.size, 0);
    assert.equal(harness.calls.some((args) => args[0] === 'rm' && args.at(-1) === candidateId), true);
    assert.equal(harness.calls.some((args) => args[0] === 'rm' && args.at(-1) === previousId), true);
    assert.equal(harness.calls.some((args) => args[0] === 'rename'), false);
    assert.equal(harness.calls.some((args) => args[0] === 'start' && args[1] === previousId), false);
});

test('old contract hashes remain foreign and block replacement before mutation', (t) => {
    const harness = networkHarness(t);
    const network = canonicalizeNetwork({ mode: 'default' });
    const id = 'legacy1234567890';
    harness.containers.set(id, managedAgentRecord({
        id,
        name: 'demo-container',
        labels: managedAgentLabels(harness.identity, network, '0'.repeat(64)),
        running: true,
    }));
    assert.throws(() => harness.adapter.runManagedContainerTransaction({
        network,
        canonicalAgentId: 'demo',
        containerName: 'demo-container',
        runtimeIdentity: TEST_RUNTIME_IDENTITY,
        createContainer: () => assert.fail('foreign agent must block candidate creation'),
    }), /network-contract/);
    assert.equal(harness.calls.some((args) => ['stop', 'rename'].includes(args[0])
        || (args[0] === 'network' && args[1] === 'create')), false);
});

test('network lifecycle source contains no removed gateway, socket, managed-hosts, or namespace machinery', () => {
    const source = fs.readFileSync(new URL('../../cli/sandbox/networkLifecycle.js', import.meta.url), 'utf8');
    for (const forbidden of [
        'ploinky-network-gateway',
        'router.sock',
        'managed-hosts',
        'gatewayContainerName',
        'ensureGateway',
        'remoteShellCommand',
        'executeInRootlessNamespace',
        'reconcileManagedControlPlane',
    ]) {
        assert.equal(source.includes(forbidden), false, `unexpected removed transport residue: ${forbidden}`);
    }
});
