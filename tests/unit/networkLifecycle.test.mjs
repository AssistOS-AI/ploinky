import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
    NETWORK_LABELS,
    acquireNetworkLifecycleLock,
    createNetworkLifecycleAdapter,
    gatewayContainerName,
    physicalNetworkName,
    workspaceNetworkIdentity,
} from '../../cli/services/networkLifecycle.js';
import {
    canonicalizeNetwork,
    deriveNetworkAlias,
    logicalNetworkAttachments,
    networkContractHash,
} from '../../cli/services/networkContract.js';

function ok(stdout = '') {
    return { ok: true, status: 0, stdout, stderr: '', error: null };
}

function absent(kind) {
    return { ok: false, status: 1, stdout: '', stderr: `${kind} not found`, error: null };
}

test('managed physical names are deterministic and workspace-scoped', () => {
    const first = workspaceNetworkIdentity('/tmp/a');
    const second = workspaceNetworkIdentity('/tmp/b');
    assert.notEqual(first.hash, second.hash);
    assert.equal(physicalNetworkName(first.hash, 'shared'), physicalNetworkName(first.hash, 'shared'));
    assert.notEqual(physicalNetworkName(first.hash, 'shared'), physicalNetworkName(first.hash, 'other'));
});

test('router socket permission failure is fatal instead of being swallowed', () => {
    const sourcePath = new URL('../../cli/server/RoutingServer.js', import.meta.url);
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.match(source, /Router Unix listener permissions could not be set/);
    assert.doesNotMatch(source, /try \{ fs\.chmodSync\(ROUTER_SOCKET_PATH, 0o666\); \} catch \(_\) \{\}/);
});

test('network status returns the stable schema-2 topology object and surfaces foreign collisions', () => {
    const workspaceRoot = '/tmp/ploinky-network-status-workspace';
    const identity = workspaceNetworkIdentity(workspaceRoot);
    const ownedName = physicalNetworkName(identity.hash, 'shared');
    const foreignName = `${physicalNetworkName(identity.hash, 'foreign')}`;
    const containerId = '1234567890abcdef';
    const implicitAlias = containerId.slice(0, 12);
    const explicitAlias = deriveNetworkAlias('demo-agent');
    const ownedLabels = {
        [NETWORK_LABELS.managed]: '1',
        [NETWORK_LABELS.resource]: 'network',
        [NETWORK_LABELS.schema]: '2',
        [NETWORK_LABELS.workspace]: identity.hash,
        [NETWORK_LABELS.logical]: 'shared',
    };
    const records = {
        [ownedName]: {
            Name: ownedName,
            Driver: 'bridge',
            Labels: ownedLabels,
            Containers: {
                [containerId]: { Name: 'demo-container', Aliases: [explicitAlias, implicitAlias] },
            },
        },
        [foreignName]: { Name: foreignName, Driver: 'bridge', Labels: {}, Containers: {} },
    };
    const run = (_runtime, args) => {
        if (args[0] === 'network' && args[1] === 'ls') {
            return ok(JSON.stringify(Object.values(records)));
        }
        if (args[0] === 'network' && args[1] === 'inspect') {
            return records[args[2]] ? ok(JSON.stringify([records[args[2]]])) : absent('network');
        }
        if (args[0] === 'container' && args[1] === 'inspect' && args[2] === 'demo-container') {
            return ok(JSON.stringify([{
                Id: containerId,
                Config: { Labels: { [NETWORK_LABELS.workspace]: identity.hash } },
                NetworkSettings: { Networks: { [ownedName]: { Aliases: [explicitAlias, implicitAlias] } } },
            }]));
        }
        if (args[0] === 'container' && args[1] === 'inspect') return absent('container');
        return absent('resource');
    };
    const status = createNetworkLifecycleAdapter({ runtime: 'podman', run, workspaceRoot }).status();
    assert.deepEqual(Object.keys(status), ['schemaVersion', 'workspaceHash', 'networks', 'gateway']);
    assert.equal(status.schemaVersion, '2');
    assert.equal(status.workspaceHash, identity.hash);
    assert.deepEqual(status.networks.map((entry) => [entry.physicalName, entry.ownership]), [
        [foreignName, 'foreign'],
        [ownedName, 'owned'],
    ].sort((a, b) => a[0].localeCompare(b[0])));
    assert.deepEqual(status.networks.find((entry) => entry.physicalName === ownedName).attachments, [{
        containerName: 'demo-container',
        ownership: 'agent',
        aliases: [explicitAlias],
    }]);
    assert.equal(status.gateway, null);
});

test('network creation proves rootless Podman before mutation and verifies labels after create', () => {
    const workspaceRoot = '/tmp/ploinky-network-create-workspace';
    const identity = workspaceNetworkIdentity(workspaceRoot);
    const name = physicalNetworkName(identity.hash, 'shared');
    const calls = [];
    let created = false;
    const run = (_runtime, args) => {
        calls.push(args);
        if (args[0] === 'info') return ok('true\n');
        if (args[0] === 'network' && args[1] === 'inspect') {
            if (!created) return absent('network');
            return ok(JSON.stringify([{
                Name: name,
                Driver: 'bridge',
                Labels: {
                    [NETWORK_LABELS.managed]: '1',
                    [NETWORK_LABELS.resource]: 'network',
                    [NETWORK_LABELS.schema]: '2',
                    [NETWORK_LABELS.workspace]: identity.hash,
                    [NETWORK_LABELS.logical]: 'shared',
                },
                IPAM: { Driver: 'host-local', Config: [{ Subnet: '10.1.0.0/24', Gateway: '10.1.0.1' }] },
            }]));
        }
        if (args[0] === 'network' && args[1] === 'create') {
            created = true;
            return ok(`${name}\n`);
        }
        return absent('resource');
    };
    const result = createNetworkLifecycleAdapter({ runtime: 'podman', run, workspaceRoot }).ensureNetwork('shared');
    assert.equal(result.created, true);
    assert.deepEqual(calls[0], ['info', '--format', '{{json .Host.Security.Rootless}}']);
    assert.ok(calls.some((args) => args[0] === 'network' && args[1] === 'create'));

    const extraLabelRecord = {
        Name: name,
        Driver: 'bridge',
        Labels: {
            [NETWORK_LABELS.managed]: '1',
            [NETWORK_LABELS.resource]: 'network',
            [NETWORK_LABELS.schema]: '2',
            [NETWORK_LABELS.workspace]: identity.hash,
            [NETWORK_LABELS.logical]: 'shared',
            'unexpected.extra': 'rejected',
        },
        IPAM: { Driver: 'host-local', Config: [{ Subnet: '10.1.0.0/24', Gateway: '10.1.0.1' }] },
    };
    const extraLabelAdapter = createNetworkLifecycleAdapter({
        runtime: 'podman',
        workspaceRoot,
        run: (_runtime, args) => {
            if (args[0] === 'info') return ok('true\n');
            if (args[0] === 'network' && args[1] === 'inspect') return ok(JSON.stringify([extraLabelRecord]));
            return absent('resource');
        },
    });
    assert.throws(() => extraLabelAdapter.ensureNetwork('shared'), /exact label keys/);

    const rootful = createNetworkLifecycleAdapter({
        runtime: 'podman',
        workspaceRoot,
        run: () => ok('false\n'),
    });
    assert.throws(() => rootful.ensureNetwork('blocked'), /rootless Podman/);
});

test('network lock rejects a concurrent child and recovers stale malformed lock and reaper metadata after grace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-network-lock-'));
    const lockPath = path.join(dir, 'network.lock');
    const held = acquireNetworkLifecycleLock({ lockPath, staleGraceMs: 10 });
    const moduleUrl = new URL('../../cli/services/networkLifecycle.js', import.meta.url).href;
    const child = spawnSync(process.execPath, [
        '--input-type=module', '-e',
        `import { acquireNetworkLifecycleLock } from ${JSON.stringify(moduleUrl)}; try { acquireNetworkLifecycleLock({ lockPath: process.argv[1], staleGraceMs: 10 }); process.exit(0); } catch { process.exit(23); }`,
        lockPath,
    ]);
    assert.equal(child.status, 23);
    held.release();

    fs.writeFileSync(lockPath, '{malformed', { mode: 0o600 });
    fs.writeFileSync(`${lockPath}.reaper`, '{also-malformed', { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    fs.utimesSync(`${lockPath}.reaper`, old, old);
    const recovered = acquireNetworkLifecycleLock({ lockPath, staleGraceMs: 10 });
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, recovered.token);
    assert.equal(fs.existsSync(`${lockPath}.reaper`), false);
    recovered.release();
    fs.rmSync(dir, { recursive: true, force: true });
});

async function routerSocketFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-socket-'));
    const socketPath = path.join(dir, 'router.sock');
    const server = net.createServer((socket) => socket.end('HTTP/1.0 200 OK\r\n\r\nok'));
    await new Promise((resolve, reject) => server.listen(socketPath, (error) => error ? reject(error) : resolve()));
    fs.chmodSync(socketPath, 0o666);
    t.after(() => {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { dir, socketPath };
}

function gatewayRecord({ name, image, socketPath, networkName, labels }) {
    return {
        Name: name,
        Labels: labels,
        Config: { Labels: labels, Image: image, User: '65532:65532', Entrypoint: ['/ploinky-network-gateway'], Cmd: [] },
        State: { Running: true, Status: 'running', Pid: process.pid },
        HostConfig: {
            Privileged: false,
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            CapAdd: [],
            SecurityOpt: ['no-new-privileges'],
            Sysctls: { 'net.ipv4.ip_forward': '0' },
            PortBindings: {},
            Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,mode=1777' },
        },
        Mounts: [{ Type: 'bind', Source: socketPath, Destination: '/run/ploinky/router.sock', RW: false }],
        NetworkSettings: { Ports: {}, Networks: { [networkName]: { Aliases: ['ploinky-router'], IPAddress: '10.1.0.2' } } },
    };
}

test('managed replacement holds one lock through preflight, removal, resource creation, verification, and start', async (t) => {
    const { dir, socketPath } = await routerSocketFixture(t);
    const workspaceRoot = path.join(dir, 'workspace');
    const identity = workspaceNetworkIdentity(workspaceRoot);
    const gatewayName = gatewayContainerName(identity.hash);
    const image = 'example.invalid/gateway:1@sha256:abc';
    const lockPath = path.join(dir, 'network.lock');
    const networks = new Map();
    let gateway = null;
    let agent = { old: true };
    const backups = new Map();
    const mutationTokens = [];
    const labelsFrom = (args) => {
        const labels = {};
        args.forEach((value, index) => {
            if (value === '--label') {
                const [key, ...rest] = String(args[index + 1]).split('=');
                labels[key] = rest.join('=');
            }
        });
        return labels;
    };
    const noteMutation = () => {
        assert.equal(fs.existsSync(lockPath), true);
        mutationTokens.push(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token);
    };
    const run = (_runtime, args) => {
        if (args[0] === 'info') return ok(args[2].includes('Rootless') ? 'true\n' : 'false\n');
        if (args[0] === 'image' && args[1] === 'inspect') return ok('[]');
        if (args[0] === 'network' && args[1] === 'inspect') {
            const record = networks.get(args[2]);
            return record ? ok(JSON.stringify([record])) : absent('network');
        }
        if (args[0] === 'container' && args[1] === 'inspect') {
            if (args[2] === gatewayName) return gateway ? ok(JSON.stringify([gateway])) : absent('container');
            const selected = args[2] === 'demo-container' ? agent : backups.get(args[2]);
            return selected ? ok(JSON.stringify([selected])) : absent('container');
        }
        if (args[0] === 'network' && args[1] === 'create') {
            noteMutation();
            const name = args.at(-1);
            networks.set(name, {
                Name: name, Driver: 'bridge', Internal: false, IPv6Enabled: false, DNSEnabled: true,
                Options: {}, IPAM: { Driver: 'host-local', Config: [{ Subnet: '10.1.0.0/24', Gateway: '10.1.0.1' }] },
                Labels: labelsFrom(args), Containers: {},
            });
            return ok(name);
        }
        if (args[0] === 'run') {
            noteMutation();
            const networkName = args[args.indexOf('--network') + 1];
            gateway = gatewayRecord({ name: gatewayName, image, socketPath, networkName, labels: labelsFrom(args) });
            return ok(gatewayName);
        }
        if (args[0] === 'start') {
            noteMutation();
            agent.State = { Running: true, Status: 'running' };
            return ok();
        }
        if (args[0] === 'rename') {
            noteMutation();
            if (args[1] === 'demo-container' && agent) {
                backups.set(args[2], agent);
                agent = null;
                return ok();
            }
            if (backups.has(args[1]) && args[2] === 'demo-container') {
                agent = backups.get(args[1]);
                backups.delete(args[1]);
                return ok();
            }
            return absent('container');
        }
        if (args[0] === 'rm') {
            noteMutation();
            if (args.at(-1) === gatewayName) gateway = null;
            else if (backups.has(args.at(-1))) backups.delete(args.at(-1));
            else agent = null;
            return ok();
        }
        return absent('resource');
    };
    const adapter = createNetworkLifecycleAdapter({
        runtime: 'podman', run, workspaceRoot, lockPath, routerSocket: socketPath,
        minimalHosts: path.join(dir, 'hosts'), gatewayImage: image, probeGateway: () => ok(),
    });
    const network = canonicalizeNetwork({ mode: 'default' });
    adapter.runManagedContainerTransaction({
        network,
        canonicalAgentId: 'demo-agent',
        containerName: 'demo-container',
        createContainer: (plan) => {
            noteMutation();
            const primary = plan.attachments.find((entry) => entry.primary) || plan.attachments[0];
            const labels = {
                'io.assistos.ploinky.workspace': identity.hash,
                'io.assistos.ploinky.network-contract': networkContractHash(network),
            };
            agent = {
                Config: { Labels: labels },
                NetworkSettings: { Networks: { [primary.name]: { Aliases: [plan.alias] } } },
            };
        },
    });
    assert.ok(mutationTokens.length >= 4);
    assert.equal(new Set(mutationTokens).size, 1);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(agent.State.Running, true);
});

test('managed replacement failure restores and restarts the preserved old container under the same lock', async (t) => {
    const { dir, socketPath } = await routerSocketFixture(t);
    const workspaceRoot = path.join(dir, 'workspace');
    const identity = workspaceNetworkIdentity(workspaceRoot);
    const network = canonicalizeNetwork({ mode: 'default' });
    const logicalName = logicalNetworkAttachments(network, 'demo-agent')[0].name;
    const physicalName = physicalNetworkName(identity.hash, logicalName);
    const gatewayName = gatewayContainerName(identity.hash);
    const image = 'example.invalid/gateway:1@sha256:abc';
    const lockPath = path.join(dir, 'network.lock');
    const networkLabels = {
        [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'network',
        [NETWORK_LABELS.schema]: '2', [NETWORK_LABELS.workspace]: identity.hash,
        [NETWORK_LABELS.logical]: logicalName,
    };
    const networkRecord = {
        Name: physicalName, Driver: 'bridge', Internal: false, IPv6Enabled: false, DNSEnabled: true,
        Options: {}, IPAM: { Driver: 'host-local', Config: [{ Subnet: '10.2.0.0/24', Gateway: '10.2.0.1' }] },
        Labels: networkLabels, Containers: {},
    };
    const gatewayLabels = {
        [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'gateway',
        [NETWORK_LABELS.schema]: '2', [NETWORK_LABELS.workspace]: identity.hash,
    };
    const gateway = gatewayRecord({
        name: gatewayName, image, socketPath, networkName: physicalName, labels: gatewayLabels,
    });
    const old = { marker: 'old-preserved', State: { Running: true, Status: 'running' }, Config: { Labels: {} } };
    let agent = old;
    const backups = new Map();
    let candidateStartFailed = false;
    const run = (_runtime, args) => {
        assert.equal(fs.existsSync(lockPath), true);
        if (args[0] === 'info') return ok(args[2].includes('Rootless') ? 'true\n' : 'false\n');
        if (args[0] === 'image' && args[1] === 'inspect') return ok('[]');
        if (args[0] === 'network' && args[1] === 'inspect') return args[2] === physicalName
            ? ok(JSON.stringify([networkRecord])) : absent('network');
        if (args[0] === 'container' && args[1] === 'inspect') {
            if (args[2] === gatewayName) return ok(JSON.stringify([gateway]));
            const selected = args[2] === 'demo-container' ? agent : backups.get(args[2]);
            return selected ? ok(JSON.stringify([selected])) : absent('container');
        }
        if (args[0] === 'stop' && args[1] === 'demo-container') {
            agent.State = { Running: false, Status: 'exited' };
            return ok();
        }
        if (args[0] === 'rename' && args[1] === 'demo-container') {
            backups.set(args[2], agent); agent = null; return ok();
        }
        if (args[0] === 'rename' && backups.has(args[1])) {
            agent = backups.get(args[1]); backups.delete(args[1]); return ok();
        }
        if (args[0] === 'start' && agent?.marker === 'candidate' && !candidateStartFailed) {
            candidateStartFailed = true;
            return { ...absent('container'), stderr: 'injected start failure' };
        }
        if (args[0] === 'start') {
            agent.State = { Running: true, Status: 'running' };
            return ok();
        }
        if (args[0] === 'rm' && args.at(-1) === 'demo-container') {
            agent = null;
            return ok();
        }
        return absent('resource');
    };
    const adapter = createNetworkLifecycleAdapter({
        runtime: 'podman', run, workspaceRoot, lockPath, routerSocket: socketPath,
        minimalHosts: path.join(dir, 'hosts'), gatewayImage: image, probeGateway: () => ok(),
    });
    assert.throws(() => adapter.runManagedContainerTransaction({
        network, canonicalAgentId: 'demo-agent', containerName: 'demo-container',
        createContainer: (plan) => {
            agent = {
                marker: 'candidate',
                Config: { Labels: {
                    'io.assistos.ploinky.workspace': identity.hash,
                    'io.assistos.ploinky.network-contract': networkContractHash(network),
                } },
                NetworkSettings: { Networks: { [physicalName]: { Aliases: [plan.alias] } } },
            };
        },
    }), /injected start failure/);
    assert.equal(agent.marker, 'old-preserved');
    assert.equal(agent.State.Running, true);
    assert.equal(backups.size, 0);
    assert.equal(fs.existsSync(lockPath), false);
});

test('missing exact gateway image leaves the old managed container untouched', async (t) => {
    const { dir, socketPath } = await routerSocketFixture(t);
    const lockPath = path.join(dir, 'network.lock');
    let removals = 0;
    const run = (_runtime, args) => {
        if (args[0] === 'info') return ok(args[2].includes('Rootless') ? 'true\n' : 'false\n');
        if (args[0] === 'network' && args[1] === 'inspect') return absent('network');
        if (args[0] === 'container' && args[1] === 'inspect') return absent('container');
        if (args[0] === 'image' && args[1] === 'inspect') return absent('image');
        if (args[0] === 'pull') return { ...absent('image'), stderr: 'registry unavailable' };
        return absent('resource');
    };
    const adapter = createNetworkLifecycleAdapter({
        runtime: 'podman', run, workspaceRoot: path.join(dir, 'workspace'), lockPath,
        routerSocket: socketPath, minimalHosts: path.join(dir, 'hosts'), gatewayImage: 'example.invalid/gateway@sha256:deadbeef',
    });
    assert.throws(() => adapter.runManagedContainerTransaction({
        network: canonicalizeNetwork({ mode: 'default' }), canonicalAgentId: 'demo-agent', containerName: 'demo-container',
        removeExisting: () => { removals += 1; }, createContainer: () => assert.fail('must not create'),
    }), /exact pull failed/);
    assert.equal(removals, 0);
});

test('managed reuse rejects missing contract labels and exact attachment or alias drift', () => {
    const workspaceRoot = '/tmp/ploinky-network-reuse-workspace';
    const identity = workspaceNetworkIdentity(workspaceRoot);
    const network = canonicalizeNetwork({ mode: 'default' });
    const logicalName = logicalNetworkAttachments(network, 'demo-agent')[0].name;
    const expectedName = physicalNetworkName(identity.hash, logicalName);
    let record = { Config: { Labels: {} }, NetworkSettings: { Networks: {} } };
    const run = (_runtime, args) => args[0] === 'container'
        ? ok(JSON.stringify([record]))
        : absent('resource');
    const adapter = createNetworkLifecycleAdapter({ runtime: 'podman', run, workspaceRoot });
    const options = { contractHash: networkContractHash(network) };
    assert.equal(adapter.verifyContainerContract('demo', network, 'demo-agent', options), false);
    record = {
        Config: { Labels: {
            'io.assistos.ploinky.workspace': identity.hash,
            'io.assistos.ploinky.network-contract': networkContractHash(network),
        } },
        NetworkSettings: { Networks: { [expectedName]: { Aliases: ['wrong'] } } },
    };
    assert.equal(adapter.verifyContainerContract('demo', network, 'demo-agent', options), false);
    record.NetworkSettings.Networks[expectedName].Aliases = [deriveNetworkAlias('demo-agent')];
    record.NetworkSettings.Networks.extra = { Aliases: [deriveNetworkAlias('demo-agent')] };
    assert.equal(adapter.verifyContainerContract('demo', network, 'demo-agent', options), false);
});

test('gateway adoption proves exact permissions and readiness without mutating an exact existing gateway', async (t) => {
    const { dir, socketPath } = await routerSocketFixture(t);
    const workspaceRoot = path.join(dir, 'workspace');
    const identity = workspaceNetworkIdentity(workspaceRoot);
    const logicalName = 'shared';
    const physicalName = physicalNetworkName(identity.hash, logicalName);
    const gatewayName = gatewayContainerName(identity.hash);
    const image = 'example.invalid/gateway@sha256:exact';
    const networkLabels = {
        [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'network',
        [NETWORK_LABELS.schema]: '2', [NETWORK_LABELS.workspace]: identity.hash,
        [NETWORK_LABELS.logical]: logicalName,
    };
    const gatewayLabels = {
        [NETWORK_LABELS.managed]: '1', [NETWORK_LABELS.resource]: 'gateway',
        [NETWORK_LABELS.schema]: '2', [NETWORK_LABELS.workspace]: identity.hash,
    };
    const networkRecord = {
        Name: physicalName, Driver: 'bridge', Internal: false, IPv6Enabled: false, DNSEnabled: true,
        Options: {}, IPAM: { Driver: 'host-local', Config: [{ Subnet: '10.3.0.0/24', Gateway: '10.3.0.1' }] },
        Labels: networkLabels,
    };
    let gateway = gatewayRecord({ name: gatewayName, image, socketPath, networkName: physicalName, labels: gatewayLabels });
    gateway.Id = 'abcdef1234567890';
    gateway.NetworkSettings.Networks[physicalName].Aliases.push(gateway.Id.slice(0, 12));
    const mutations = [];
    const run = (_runtime, args) => {
        if (args[0] === 'info') return ok(args[2].includes('Rootless') ? 'true\n' : 'false\n');
        if (args[0] === 'image' && args[1] === 'inspect') return ok('[]');
        if (args[0] === 'network' && args[1] === 'ls') return ok(JSON.stringify([networkRecord]));
        if (args[0] === 'network' && args[1] === 'inspect') return ok(JSON.stringify([networkRecord]));
        if (args[0] === 'container' && args[1] === 'inspect') {
            return gateway ? ok(JSON.stringify([gateway])) : absent('container');
        }
        if (args[0] === 'rm' && args.at(-1) === gatewayName) {
            mutations.push(args);
            gateway = null;
            return ok();
        }
        if (args[0] === 'run') {
            mutations.push(args);
            const labels = {};
            args.forEach((value, index) => {
                if (value !== '--label') return;
                const [key, ...rest] = String(args[index + 1]).split('=');
                labels[key] = rest.join('=');
            });
            const networkName = args[args.indexOf('--network') + 1];
            gateway = gatewayRecord({ name: gatewayName, image, socketPath, networkName, labels });
            return ok(gatewayName);
        }
        mutations.push(args);
        return absent('resource');
    };
    let probes = 0;
    const adapter = createNetworkLifecycleAdapter({
        runtime: 'podman', run, workspaceRoot, routerSocket: socketPath, gatewayImage: image,
        probeGateway: () => { probes += 1; return ok(); },
    });
    const adopted = adapter.ensureGateway([{ name: physicalName, logicalName, primary: true }]);
    assert.equal(adopted.created, false);
    assert.equal(probes, 1);
    assert.deepEqual(mutations, []);
    assert.deepEqual(adapter.status().gateway.attachments, [{
        physicalName,
        aliases: ['ploinky-router'],
    }]);

    gatewayLabels['unexpected.extra'] = 'rejected';
    assert.throws(() => adapter.ensureGateway([{ name: physicalName, logicalName, primary: true }]), /exact label keys/);
    delete gatewayLabels['unexpected.extra'];

    const namespaceProbeCalls = [];
    const namespaceProbe = createNetworkLifecycleAdapter({
        runtime: 'podman', workspaceRoot, routerSocket: socketPath, gatewayImage: image,
        run: (runtime, args) => {
            if (args[0] === 'unshare') { namespaceProbeCalls.push(args); return ok(); }
            return run(runtime, args);
        },
    });
    namespaceProbe.ensureGateway([{ name: physicalName, logicalName, primary: true }]);
    assert.equal(namespaceProbeCalls.length, 1);
    assert.deepEqual(namespaceProbeCalls[0].slice(0, 5), ['unshare', 'nsenter', '--target', String(process.pid), '--net']);
    assert.equal(namespaceProbeCalls[0].at(-1), '127.0.0.1');

    mutations.length = 0;
    let staleProbeCount = 0;
    const staleSocket = createNetworkLifecycleAdapter({
        runtime: 'podman', run, workspaceRoot, routerSocket: socketPath, gatewayImage: image,
        probeGateway: () => {
            staleProbeCount += 1;
            return staleProbeCount === 1 ? { ok: false, status: 1, stderr: 'stale socket' } : ok();
        },
    });
    const replaced = staleSocket.ensureGateway([{ name: physicalName, logicalName, primary: true }]);
    assert.equal(replaced.created, true);
    assert.equal(replaced.replaced, true);
    assert.deepEqual(mutations.map((args) => args[0]), ['rm', 'run']);

    mutations.length = 0;
    const unreachable = createNetworkLifecycleAdapter({
        runtime: 'podman', run, workspaceRoot, routerSocket: socketPath, gatewayImage: image,
        probeGateway: () => ({ ok: false, status: 1, stderr: 'unreachable' }),
    });
    assert.throws(() => unreachable.ensureGateway([{ name: physicalName, logicalName, primary: true }]), /TCP 8080.*probe failed/);
    assert.deepEqual(mutations.map((args) => args[0]), ['rm', 'run', 'rm']);

    fs.chmodSync(socketPath, 0o600);
    assert.throws(() => adapter.ensureGateway([{ name: physicalName, logicalName, primary: true }]), /exactly chmod 0666/);
    assert.deepEqual(mutations.map((args) => args[0]), ['rm', 'run', 'rm']);
});

test('prune proves rootless ownership and cannot interleave with a held start transaction lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-network-prune-lock-'));
    const lockPath = path.join(dir, 'network.lock');
    let runtimeCalls = 0;
    const rootful = createNetworkLifecycleAdapter({
        runtime: 'podman', lockPath, workspaceRoot: path.join(dir, 'workspace'),
        run: () => { runtimeCalls += 1; return ok('false\n'); },
    });
    assert.throws(() => rootful.prune(), /rootless Podman/);
    assert.equal(runtimeCalls, 1);

    const held = acquireNetworkLifecycleLock({ lockPath });
    const prune = createNetworkLifecycleAdapter({
        runtime: 'podman', lockPath, workspaceRoot: path.join(dir, 'workspace'),
        run: () => assert.fail('prune must not reach the runtime while start owns the lock'),
    });
    assert.throws(() => prune.prune(), /already owned/);
    held.release();
    fs.rmSync(dir, { recursive: true, force: true });
});
